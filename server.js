const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const { clerkMiddleware, getAuth } = require("@clerk/express");
const { Pool } = require('pg');
const { pool: db, migrate } = require('./db/migrate');

const app = express();
// Trust Railway's proxy so req.ip is the real client IP (not 127.0.0.1),
// which makes per-user rate limiting and logging accurate.
app.set('trust proxy', 1);
app.use(clerkMiddleware());
const PORT = process.env.PORT || 7890;

// Cache for Sleeper player data (large payload, changes rarely)
let playerCache = null;
let playerCacheTime = 0;
const PLAYER_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// In-memory live injury cache — refreshed every 4 hours from Sleeper.
// Falls back to data/injuries.json when Sleeper is unreachable.
let liveInjuryCache = { data: null, lastFetch: 0 };
const INJURY_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// Data files only change on deploy (GHA commits → Railway redeploys), so a
// 1-hour TTL is just a safety net against long-lived containers going stale.
const FILE_CACHE_TTL = 60 * 60 * 1000;
const fileCache = new Map(); // key → { value, time }

function cached(key, compute) {
  const entry = fileCache.get(key);
  if (entry && Date.now() - entry.time < FILE_CACHE_TTL) return entry.value;
  const value = compute();
  fileCache.set(key, { value, time: Date.now() });
  return value;
}

function readDataFile(name) {
  return cached(name, () =>
    JSON.parse(fs.readFileSync(path.join(__dirname, 'data', name), 'utf8'))
  );
}

// Async TTL cache for proxied Sleeper API calls with in-flight dedup
const apiCacheMap = new Map();
const apiInFlight = new Map();

async function apiCached(key, ttlMs, fetcher) {
  const entry = apiCacheMap.get(key);
  if (entry && Date.now() < entry.expires) return entry.value;
  if (apiInFlight.has(key)) return apiInFlight.get(key);
  const promise = fetcher()
    .then(value => {
      apiCacheMap.set(key, { value, expires: Date.now() + ttlMs });
      apiInFlight.delete(key);
      return value;
    })
    .catch(err => {
      apiInFlight.delete(key);
      const stale = apiCacheMap.get(key);
      if (stale) return stale.value;
      throw err;
    });
  apiInFlight.set(key, promise);
  return promise;
}

// SSE must be excluded — compression buffers the stream and breaks real-time delivery
app.use(compression({
  filter: (req, res) =>
    req.path === '/api/draft-stream' ? false : compression.filter(req, res),
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Tight CSP: no inline eval, scripts only from self + CDN used for fonts/icons
  const clerkFapi = process.env.CLERK_FRONTEND_API || '*.clerk.accounts.dev';
  // Clerk origins: env-configured FAPI, dev-instance wildcard, explicit dev instance, prod custom domain
  const clerkOrigins = 'https://' + clerkFapi +
    ' https://*.clerk.accounts.dev https://clerk.ready-kingfish-8657.accounts.dev https://ready-kingfish-8657.clerk.accounts.dev https://clerk.pykled.com';
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://umami-production-e09b.up.railway.app https://cdn.jsdelivr.net " + clerkOrigins + " https://challenges.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https://sleepercdn.com https://img.clerk.com; " +
    "connect-src 'self' https://api.sleeper.app https://umami-production-e09b.up.railway.app " + clerkOrigins + "; " +
    "worker-src 'self' blob:; " +
    "frame-src 'self' https://challenges.cloudflare.com " + clerkOrigins + "; " +
    "frame-ancestors 'none';"
  );
  next();
});

// Proxy + cache Sleeper's large player endpoint
app.get('/api/players', async (req, res) => {
  const now = Date.now();
  if (playerCache && now - playerCacheTime < PLAYER_CACHE_TTL) {
    return res.json(playerCache);
  }
  try {
    const r = await fetch('https://api.sleeper.app/v1/players/nfl');
    if (!r.ok) throw new Error(`Sleeper returned ${r.status}`);
    playerCache = await r.json();
    playerCacheTime = now;
    res.json(playerCache);
  } catch (err) {
    console.error('Player fetch error:', err.message);
    if (playerCache) return res.json(playerCache); // stale cache on error
    res.status(502).json({ error: 'Failed to fetch player data' });
  }
});

// Slim name→player_id map built from the Sleeper players dict.
// Returns { "ja'marr chase": "6794", ... } for skill-position players only.
let playerIdMapCache = null;
let playerIdMapTime = 0;
app.get('/api/player-ids', async (req, res) => {
  const now = Date.now();
  if (playerIdMapCache && now - playerIdMapTime < PLAYER_CACHE_TTL) {
    return res.json(playerIdMapCache);
  }
  try {
    const base = playerCache && now - playerCacheTime < PLAYER_CACHE_TTL
      ? playerCache
      : await fetch('https://api.sleeper.app/v1/players/nfl').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    if (!playerCache) { playerCache = base; playerCacheTime = now; }
    const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'K']);
    const map = {};
    for (const [id, p] of Object.entries(base)) {
      if (!p || !p.full_name || !SKILL.has(p.position)) continue;
      map[p.full_name.toLowerCase()] = id;
    }
    playerIdMapCache = map;
    playerIdMapTime = now;
    res.json(map);
  } catch (err) {
    if (playerIdMapCache) return res.json(playerIdMapCache);
    res.status(502).json({ error: 'Failed to build player ID map' });
  }
});

// Serve live ADP data (updated nightly by GitHub Actions)
app.get('/api/adp', (req, res) => {
  try {
    res.json(readDataFile('adp.json'));
  } catch (e) {
    res.status(503).json({ error: 'ADP data not yet generated' });
  }
});

app.get('/api/vorp', (req, res) => {
  try {
    res.json(readDataFile('vorp.json'));
  } catch (e) {
    res.status(503).json({ error: 'VORP data not yet generated' });
  }
});

// Composite ADP blended across Sleeper + FantasyPros + Underdog.
// Enriched with per-player draft-behavior stats from adp.json (stdev, high/low
// range, weighted ADP, sample size) — composite_adp.json only carries the
// blended values, but the research UI needs both.
app.get('/api/composite-adp', (req, res) => {
  try {
    const data = cached('composite-adp:merged', () => {
      const composite = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/composite_adp.json'), 'utf8'));
      try {
        const adp = readDataFile('adp.json');
        const byName = {};
        (adp.players || []).forEach(p => { if (p && p.name) byName[p.name.toLowerCase()] = p; });
        (composite.players || []).forEach(p => {
          const src = byName[(p.name || '').toLowerCase()];
          if (!src) return;
          ['weighted_adp', 'stdev', 'weighted_stdev', 'high', 'low', 'times_drafted', 'outliers_removed'].forEach(k => {
            if (p[k] == null && src[k] != null) p[k] = src[k];
          });
        });
      } catch (e) {} // enrichment is best-effort — raw composite data still ships
      return composite;
    });
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: 'Composite ADP data not yet generated' });
  }
});

// Data freshness — lets the frontend warn users when ADP data is stale.
app.get('/api/data-freshness', (req, res) => {
  try {
    const quality = readDataFile('data_quality.json');
    let crawlMeta = {};
    try {
      crawlMeta = readDataFile('crawl_meta.json');
    } catch (e) {}
    const generatedAt = quality.generated_at || crawlMeta.crawled_at || null;
    const ageHours = generatedAt
      ? Math.round(((Date.now() - new Date(generatedAt).getTime()) / 3600000) * 10) / 10
      : null;
    res.json({
      adp_age_hours: ageHours,
      drafts_used: quality.drafts_after_quality_filter || 0,
      generated_at: generatedAt,
      crawled_at: crawlMeta.crawled_at || null,
    });
  } catch (e) {
    res.status(503).json({ error: 'Data quality info not yet generated' });
  }
});

// Fetch live injury data from Sleeper. Reuses playerCache when still fresh to
// avoid a duplicate fetch of the large payload. Returns null on failure.
const SKILL_POS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);
async function fetchLiveInjuries() {
  const now = Date.now();
  try {
    let base = playerCache && now - playerCacheTime < PLAYER_CACHE_TTL ? playerCache : null;
    if (!base) {
      const r = await fetch('https://api.sleeper.app/v1/players/nfl', {
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`Sleeper ${r.status}`);
      base = await r.json();
      playerCache = base;
      playerCacheTime = now;
    }
    const byName = {};
    // Non-medical injury_status values indicate availability issues, not physical injuries.
    const AVAIL_ISSUE_STATUSES = new Set(['na', 'suspended', 'nfi-r', 'pup-r', 'pup-p']);
    for (const p of Object.values(base)) {
      if (!p || !p.full_name || p.active === false) continue;
      if (!SKILL_POS.has(p.position)) continue;
      const injStr = (p.injury_status || '').toLowerCase();
      // Treat "NA" and non-medical injury_status values as availability issues, not injuries.
      const injIsAvailIssue = injStr && AVAIL_ISSUE_STATUSES.has(injStr);
      const hasInjury = p.injury_status != null && !injIsAvailIssue;
      // p.status is the player-level field: "Active", "Inactive", "Suspended", "NA", etc.
      const playerStatus = p.status || '';
      const statusIsAvailIssue = playerStatus && !['Active', ''].includes(playerStatus);
      const hasAvailabilityIssue = injIsAvailIssue || statusIsAvailIssue;
      if (!hasInjury && !hasAvailabilityIssue) continue;
      // Prefer injury_notes field; fall back to first news item analysis/content
      let note = p.injury_notes || null;
      if (!note && Array.isArray(p.news) && p.news.length > 0) {
        const first = p.news[0] || {};
        const text = first.analysis || first.content;
        if (text) note = String(text).slice(0, 200);
      }
      // Canonical availability status: prefer the player-level status field; fall back to injury_status if it's an availability value.
      const canonAvail = statusIsAvailIssue ? playerStatus : (injIsAvailIssue ? p.injury_status : null);
      byName[p.full_name.toLowerCase()] = {
        name: p.full_name,
        status: hasInjury ? p.injury_status : null,
        body_part: p.injury_body_part || null,
        note,
        start_date: p.injury_start_date || null,
        availabilityStatus: canonAvail,
      };
    }
    liveInjuryCache = { data: byName, lastFetch: now };
    console.log(`Injury cache refreshed: ${Object.keys(byName).length} injured players`);
    return byName;
  } catch (err) {
    console.error('fetchLiveInjuries error:', err.message);
    return null;
  }
}

// Injury data — served from the live Sleeper cache (4h TTL).
// Falls back to data/injuries.json (updated every 2h by GH Actions) when Sleeper is unreachable.
// Response is keyed by lowercase player name for O(1) client-side lookup.
app.get('/api/injuries', async (req, res) => {
  const now = Date.now();
  if (liveInjuryCache.data && now - liveInjuryCache.lastFetch < INJURY_CACHE_TTL) {
    return res.json({ fetched_at: new Date(liveInjuryCache.lastFetch).toISOString(), players: liveInjuryCache.data });
  }
  const live = await fetchLiveInjuries();
  if (live) {
    return res.json({ fetched_at: new Date(liveInjuryCache.lastFetch).toISOString(), players: live });
  }
  // Static file fallback
  try {
    const raw = readDataFile('injuries.json');
    const byName = {};
    for (const p of (raw.players || [])) {
      if (p.name) byName[p.name.toLowerCase()] = p;
    }
    res.json({ fetched_at: raw.fetched_at, players: byName });
  } catch (e) {
    res.status(503).json({ error: 'Injury data not yet available' });
  }
});

// Player news — proxies FantasyPros RSS and parses items into a clean array.
// Cached globally for 10 minutes so the RSS is only fetched once per refresh cycle.
let newsCache = null;
let newsCacheTime = 0;
const NEWS_CACHE_TTL = 10 * 60 * 1000;
const NEWS_RSS_URL = 'https://www.fantasypros.com/nfl/rss/news.php';

async function fetchNews() {
  if (newsCache && Date.now() - newsCacheTime < NEWS_CACHE_TTL) return newsCache;
  try {
    const r = await fetch(NEWS_RSS_URL, {
      headers: { 'User-Agent': 'RoundRoom/1.0 (fantasy draft assistant)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return newsCache || [];
    const xml = await r.text();
    // Parse <item> blocks without a library — RSS is regular enough for this
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = itemRe.exec(xml)) !== null) {
      const block = m[1];
      const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block) || [])[1]?.trim() || '';
      const desc  = (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(block) || /<description>(.*?)<\/description>/.exec(block) || [])[1]?.trim() || '';
      const pub   = (/<pubDate>(.*?)<\/pubDate>/.exec(block) || [])[1]?.trim() || '';
      if (!title) continue;
      // Strip HTML tags from description
      const clean = desc.replace(/<[^>]*>/g, '').trim();
      items.push({ title, blurb: clean.slice(0, 300), pubDate: pub });
      if (items.length >= 100) break; // don't over-fetch
    }
    newsCache = items;
    newsCacheTime = Date.now();
    return items;
  } catch (e) {
    return newsCache || [];
  }
}

app.get('/api/player-news/:name', async (req, res) => {
  const name = req.params.name.toLowerCase().trim();
  if (!name || name.length > 80) return res.status(400).json({ error: 'Invalid name' });
  const all = await fetchNews();
  // Match items whose title starts with the player name (FP format: "Name: note")
  const nameParts = name.split(' ').filter(Boolean);
  const matches = all.filter(item => {
    const t = item.title.toLowerCase();
    return nameParts.every(part => t.includes(part));
  }).slice(0, 5);
  res.json({ items: matches });
});

// Historical season stats via Sleeper weekly stats API.
// Week-level responses are cached globally (all players) so repeated lookups
// are free after the first player opens. Per-player season totals are also
// cached 24h after first computation.
// Max entries to prevent unbounded memory growth under heavy load.
// 3 seasons × 18 weeks = 54 week entries max; stats cap covers ~300 unique players.
const WEEK_CACHE_MAX = 60;
const STATS_CACHE_MAX = 400;
const weekCache = new Map();    // `${year}-${week}` → { data, time }
const statsCache = new Map();   // player_id → { data, time }
const weekInFlight = new Map(); // `${year}-${week}` → Promise — deduplicates concurrent fetches
const NFL_WEEKS = 18;

function evictOldest(map, max) {
  if (map.size <= max) return;
  const oldest = map.keys().next().value; // Map preserves insertion order
  map.delete(oldest);
}

async function fetchWeek(year, week) {
  const key = `${year}-${week}`;
  const entry = weekCache.get(key);
  if (entry && Date.now() - entry.time < PLAYER_CACHE_TTL) return entry.data;
  // Coalesce concurrent requests for the same week (e.g. 50 users open same player simultaneously)
  if (weekInFlight.has(key)) return weekInFlight.get(key);
  const promise = (async () => {
    try {
      const url = `https://api.sleeper.app/v1/stats/nfl/regular/${year}/${week}`;
      const r = await fetch(url);
      if (!r.ok) return null;
      const data = await r.json();
      evictOldest(weekCache, WEEK_CACHE_MAX);
      weekCache.set(key, { data, time: Date.now() });
      return data;
    } finally {
      weekInFlight.delete(key);
    }
  })();
  weekInFlight.set(key, promise);
  return promise;
}

// SUM fields: counting stats that add across weeks
const SUM_FIELDS = [
  'gp', 'pts_ppr', 'pts_std', 'pts_half_ppr',
  'rec', 'rec_tgt', 'rec_yd', 'rec_td', 'rec_air_yd',
  'rush_att', 'rush_yd', 'rush_td',
  'pass_att', 'pass_cmp', 'pass_yd', 'pass_td', 'pass_int',
  'off_snp', 'tm_off_snp',
];

const NFL_SEASON_LENGTH = 17; // regular-season games (used for health bar, not week count)

async function buildSeasonStats(playerId, year) {
  const weeks = Array.from({ length: NFL_WEEKS }, (_, i) => i + 1);
  const weekData = await Promise.all(weeks.map(w => fetchWeek(year, w)));
  const raw = { season: year };
  for (const wd of weekData) {
    if (!wd) continue;
    const p = wd[playerId];
    if (!p) continue;
    for (const f of SUM_FIELDS) {
      if (p[f] != null) raw[f] = (raw[f] || 0) + p[f];
    }
  }
  if (!raw.gp) return null;

  const gp = raw.gp;
  const s = { season: year, gp };

  // Snap %
  if (raw.off_snp && raw.tm_off_snp) s.snap_pct = raw.off_snp / raw.tm_off_snp;

  // Per-game rates — what actually matters for fantasy evaluation
  const pg = (v) => v != null ? +(v / gp).toFixed(2) : null;
  s.rec_yd_pg   = pg(raw.rec_yd);
  s.tgt_pg      = raw.rec_tgt != null ? pg(raw.rec_tgt) : null;
  s.rec_pg      = pg(raw.rec);
  s.rec_td_pg   = pg(raw.rec_td);
  s.rush_yd_pg  = pg(raw.rush_yd);
  s.rush_att_pg = pg(raw.rush_att);
  s.rush_td_pg  = pg(raw.rush_td);
  s.pass_yd_pg  = pg(raw.pass_yd);
  s.pass_td_pg  = pg(raw.pass_td);
  s.pts_ppr_pg  = pg(raw.pts_ppr);

  // Efficiency rates (not per-game, but per-opportunity)
  if (raw.rec_tgt) s.catch_pct = +(raw.rec / raw.rec_tgt).toFixed(3);
  if (raw.rec_tgt) s.rec_yd_per_tgt = +(raw.rec_yd / raw.rec_tgt).toFixed(2);
  if (raw.rush_att) s.rush_yd_per_carry = +(raw.rush_yd / raw.rush_att).toFixed(2);
  if (raw.pass_att) {
    s.cmp_pct = +(raw.pass_cmp / raw.pass_att).toFixed(3);
    s.pass_yd_per_att = +(raw.pass_yd / raw.pass_att).toFixed(2);
  }
  if (raw.pass_td != null && raw.pass_int != null) {
    s.pass_td = raw.pass_td;
    s.pass_int = raw.pass_int;
  }

  return s;
}

app.get('/api/player-stats/:playerId', async (req, res) => {
  const id = req.params.playerId;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid player ID' });
  const hit = statsCache.get(id);
  if (hit && Date.now() - hit.time < PLAYER_CACHE_TTL) return res.json(hit.data);
  try {
    const [s2022, s2023, s2024] = await Promise.all([
      buildSeasonStats(id, 2022),
      buildSeasonStats(id, 2023),
      buildSeasonStats(id, 2024),
    ]);
    const data = { seasons: [s2022, s2023, s2024].filter(Boolean), nflSeasonLength: NFL_SEASON_LENGTH };
    evictOldest(statsCache, STATS_CACHE_MAX);
    statsCache.set(id, { data, time: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('Stats fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch stats' });
  }
});

// ---------------------------------------------------------------------------
// AI Assistant proxy — keeps the Anthropic API key server-side.
// Simple in-memory rate limit: max 20 requests per IP per minute.
// ---------------------------------------------------------------------------
const chatRateLimits = new Map(); // ip → { count, windowStart }
const CHAT_RATE_LIMIT = 20;
const CHAT_RATE_WINDOW = 60 * 1000;

function chatRateLimited(ip) {
  const now = Date.now();
  const entry = chatRateLimits.get(ip);
  if (!entry || now - entry.windowStart >= CHAT_RATE_WINDOW) {
    chatRateLimits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > CHAT_RATE_LIMIT;
}

// Generic in-memory rate limiter for other write endpoints (e.g. trade saves).
// key → { count, reset }. Returns true when the caller is over the limit.
const rateLimitMap = new Map();
function rateLimit(key, maxReq, windowMs) {
  const now = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
  entry.count++;
  rateLimitMap.set(key, entry);
  return entry.count > maxReq;
}

// Periodically drop expired rate-limit entries so the maps don't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of chatRateLimits) {
    if (now - entry.windowStart >= CHAT_RATE_WINDOW) chatRateLimits.delete(ip);
  }
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.reset) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000).unref();

// Hardcoded system prompt — client cannot override this. Prevents using the
// Anthropic key as a general-purpose endpoint.
const CHAT_SYSTEM_PROMPT =
  'You are a concise fantasy football draft assistant built into RoundRoom. ' +
  'Answer questions about NFL players, fantasy strategy, matchups, and draft decisions. ' +
  'Keep responses brief and actionable. Do not discuss topics unrelated to fantasy football.';

app.post('/api/chat', express.json({ limit: '100kb' }), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI assistant is not configured' });
  }
  if (chatRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many requests — slow down a bit' });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }
  // Cap history depth and individual message length
  if (messages.length > 20) {
    return res.status(400).json({ error: 'Too many messages' });
  }
  for (const m of messages) {
    if (typeof m.content === 'string' && m.content.length > 4000) {
      return res.status(400).json({ error: 'Message too long' });
    }
  }

  try {
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: CHAT_SYSTEM_PROMPT,
      messages: messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content || '').slice(0, 4000),
      })),
    });
    const reply = response.content?.find(b => b.type === 'text')?.text || '';
    res.json({ reply });
  } catch (err) {
    console.error('AI chat error:', err.message);
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    res.status(status).json({ error: 'AI request failed' });
  }
});

// ---------------------------------------------------------------------------
// Server-Side SSE Relay
// One Sleeper connection per active draft, fanned out to all connected clients.
// A Sleeper WebSocket (Phoenix Channel) provides the event-driven fast path:
// the moment a pick event arrives we fetch immediately instead of waiting for
// the next poll. The polling loop stays as a safety net (5s when WS is live,
// 800ms when it isn't).
// Map of draftId → { picks, pickCount, clients: Set<res>, timer, ws, wsConnected, hbTimer }
// ---------------------------------------------------------------------------
const draftRelays = new Map();

// Bind an event handler across both the `ws` package (.on) and the Node
// built-in WebSocket (.addEventListener). For 'message', the handler is always
// called with the raw payload (string/Buffer) regardless of source API.
function bindWS(ws, event, handler) {
  if (typeof ws.on === 'function') {
    if (event === 'message') ws.on('message', (raw) => handler(raw));
    else ws.on(event, handler);
  } else {
    if (event === 'message') ws.addEventListener('message', (ev) => handler(ev.data));
    else ws.addEventListener(event, () => handler());
  }
}

// Start a server-side relay (WebSocket + polling fallback) for a draft.
function ensureDraftRelay(draftId) {
  if (draftRelays.has(draftId)) return;
  const relay = { picks: null, pickCount: -1, clients: new Set(), timer: null, ws: null, wsConnected: false, hbTimer: null };
  draftRelays.set(draftId, relay);

  // ── Shared fetch+push ─────────────────────────────────────────────────────
  let fetchInFlight = false;
  async function fetchAndPush() {
    if (fetchInFlight) return; // coalesce concurrent triggers (WS + poll)
    fetchInFlight = true;
    try {
      const r = await fetch(`https://api.sleeper.app/v1/draft/${draftId}/picks`);
      if (r.ok) {
        const picks = await r.json();
        const count = Array.isArray(picks) ? picks.length : 0;
        if (count !== relay.pickCount) {
          relay.picks = picks;
          relay.pickCount = count;
          const data = JSON.stringify({ picks, pickCount: count });
          for (const client of relay.clients) {
            try { client.write(`data: ${data}\n\n`); } catch (e) { relay.clients.delete(client); }
          }
        }
      }
    } catch (e) {}
    fetchInFlight = false;
  }

  // ── WebSocket: event-driven fast path ─────────────────────────────────────
  function connectWS() {
    if (relay.clients.size === 0) return;
    const endpoints = [
      'wss://broadcast.sleeper.app/',              // public broadcast — no auth required (used by Flock, etc.)
      'wss://sleeper.app/socket/websocket?vsn=2.0.0',
      'wss://sleeper.app/ws/websocket?vsn=2.0.0'
    ];
    let epIdx = 0;

    function tryConnect() {
      if (relay.clients.size === 0 || epIdx >= endpoints.length) return;
      const WS = global.WebSocket || require('ws'); // Node 22+ built-in or ws package
      let ws;
      try {
        ws = new WS(endpoints[epIdx]);
      } catch (e) {
        epIdx++;
        tryConnect();
        return;
      }
      relay.ws = ws;
      let msgRef = 0;

      const connectTimeout = setTimeout(() => {
        try { ws.close(); } catch (e) {}
        epIdx++;
        tryConnect();
      }, 5000);

      bindWS(ws, 'open', () => {
        clearTimeout(connectTimeout);
        msgRef++;
        try { ws.send(JSON.stringify([String(msgRef), String(msgRef), `draft:${draftId}`, 'phx_join', {}])); } catch (e) {}
        // Heartbeat every 25s to keep the Phoenix channel alive
        relay.hbTimer = setInterval(() => {
          if (ws.readyState === (ws.OPEN ?? 1)) {
            msgRef++;
            try { ws.send(JSON.stringify([null, String(msgRef), 'phoenix', 'heartbeat', {}])); } catch (e) {}
          }
        }, 25000);
      });

      bindWS(ws, 'message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        if (!Array.isArray(msg)) return;
        const topic = msg[2], event = msg[3], payload = msg[4];

        if (event === 'phx_reply' && payload && payload.status === 'ok') {
          relay.wsConnected = true;
          fetchAndPush(); // fetch current picks on successful join
          return;
        }
        if (event === 'phx_reply' && payload && payload.status === 'error') {
          // This endpoint rejected our join — try the next one
          try { ws.close(); } catch (e) {}
          epIdx++;
          tryConnect();
          return;
        }
        if (topic === `draft:${draftId}` && event !== 'phx_error' && event !== 'phx_close') {
          // A draft event (pick, pause, resume, etc.) — fetch immediately
          fetchAndPush();
        }
      });

      bindWS(ws, 'close', () => {
        clearTimeout(connectTimeout);
        relay.wsConnected = false;
        if (relay.hbTimer) { clearInterval(relay.hbTimer); relay.hbTimer = null; }
        // If clients still connected, reconnect after 3s
        if (relay.clients.size > 0) {
          setTimeout(connectWS, 3000);
        }
      });

      bindWS(ws, 'error', () => {
        // 'close' fires after this — cleanup/reconnect handled there
      });
    }

    tryConnect();
  }

  // ── Polling fallback (always runs; slower when WS active) ─────────────────
  async function poll() {
    if (relay.clients.size === 0) {
      // No clients — tear everything down
      if (relay.timer) { clearTimeout(relay.timer); relay.timer = null; }
      if (relay.ws) { try { relay.ws.close(); } catch (e) {} relay.ws = null; }
      if (relay.hbTimer) { clearInterval(relay.hbTimer); relay.hbTimer = null; }
      draftRelays.delete(draftId);
      return;
    }
    await fetchAndPush();
    // Slow poll when WS is handling real-time events — just a safety net
    relay.timer = setTimeout(poll, relay.wsConnected ? 5000 : 200);
  }

  connectWS();
  poll(); // start immediately
}

// SSE endpoint — clients connect here instead of polling Sleeper directly
app.get('/api/draft-stream', (req, res) => {
  const draftId = req.query.draft_id;
  if (!draftId || !/^\d{15,}$/.test(draftId)) {
    return res.status(400).json({ error: 'Invalid draft_id' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  if (req.socket) { try { req.socket.setNoDelay(true); } catch(_) {} }
  res.flushHeaders();
  // Write immediately so Railway's hikari proxy starts streaming (doesn't buffer idle connections)
  res.write(': connected\n\n');

  // Heartbeat every 5s — keeps proxy from closing "idle" SSE connections
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (e) {} }, 5000);

  ensureDraftRelay(draftId);
  const relay = draftRelays.get(draftId);
  relay.clients.add(res);

  // Send current picks immediately if we have them
  if (relay.picks !== null) {
    try { res.write(`data: ${JSON.stringify({ picks: relay.picks, pickCount: relay.pickCount })}\n\n`); } catch (e) {}
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    relay.clients.delete(res);
    // Relay cleans itself up on next poll if clients is empty
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({ clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || '', season: 2026 });
});

// ---------------------------------------------------------------------------
// Sleeper proxy endpoints — gated through apiCached
// ---------------------------------------------------------------------------
app.get('/api/nfl-state', async (req, res) => {
  try {
    const data = await apiCached('nfl:state', 5 * 60 * 1000, () =>
      fetch('https://api.sleeper.app/v1/state/nfl').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    );
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch NFL state' });
  }
});

app.get('/api/league/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid league ID' });
  try {
    const data = await apiCached(`league:${id}`, 60 * 1000, async () => {
      const [lr, rr, ur] = await Promise.all([
        fetch(`https://api.sleeper.app/v1/league/${id}`),
        fetch(`https://api.sleeper.app/v1/league/${id}/rosters`),
        fetch(`https://api.sleeper.app/v1/league/${id}/users`),
      ]);
      if (!lr.ok) throw new Error(`Sleeper league ${lr.status}`);
      const [league, rosters, users] = await Promise.all([
        lr.json(),
        rr.ok ? rr.json() : [],
        ur.ok ? ur.json() : [],
      ]);
      return { ...league, rosters, users, fetched_at: new Date().toISOString() };
    });
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch league data' });
  }
});

// Season-long projections (used by the trade calculator). Sleeper's weekly
// endpoint returns empty stat objects until the week is published, but the
// season endpoint has full-season stats for every player. Response is a dict
// keyed by player_id whose values are flat stat objects (rec, rec_yd, ...),
// which is exactly what shared/scoring.js expects.
app.get('/api/projections/season', async (req, res) => {
  try {
    const data = await apiCached('proj:2026:season', 6 * 60 * 60 * 1000, async () => {
      const r = await fetch('https://api.sleeper.app/v1/projections/nfl/regular/2026');
      if (!r.ok) throw new Error(`Sleeper season projections ${r.status}`);
      const raw = await r.json();
      const slim = {};
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [playerId, item] of Object.entries(raw)) {
          if (item && typeof item === 'object') slim[playerId] = item;
        }
      }
      return slim;
    });
    res.setHeader('Cache-Control', 'public, max-age=21600');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch season projections' });
  }
});

app.get('/api/projections/:week', async (req, res) => {
  const week = parseInt(req.params.week, 10);
  if (!week || week < 1 || week > 18) return res.status(400).json({ error: 'Invalid week' });
  try {
    const data = await apiCached(`proj:2026:${week}`, 60 * 60 * 1000, async () => {
      const url = `https://api.sleeper.app/v1/projections/nfl/2026/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Sleeper projections ${r.status}`);
      const raw = await r.json();
      const slim = {};
      for (const item of (Array.isArray(raw) ? raw : [])) {
        if (item && item.player_id) slim[item.player_id] = item.stats || {};
      }
      return slim;
    });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch projections' });
  }
});

// Slim players dict for trade UI — only name/pos/team for skill positions
app.get('/api/players/slim', async (req, res) => {
  const now = Date.now();
  let dict = playerCache && now - playerCacheTime < PLAYER_CACHE_TTL ? playerCache : null;
  if (!dict) {
    try {
      const r = await fetch('https://api.sleeper.app/v1/players/nfl', { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(r.status);
      dict = await r.json();
      playerCache = dict; playerCacheTime = now;
    } catch (err) {
      if (playerCache) dict = playerCache;
      else return res.status(502).json({ error: 'Failed to fetch players' });
    }
  }
  const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);
  const slim = {};
  for (const [id, p] of Object.entries(dict)) {
    if (!p || !p.full_name || !POSITIONS.has(p.position) || p.active === false) continue;
    slim[id] = [p.full_name, p.position, p.team || 'FA'];
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(slim);
});

// ---------------------------------------------------------------------------
// Account routes (Clerk auth required)
// ---------------------------------------------------------------------------
// JSON 401 instead of requireAuth()'s redirect-to-sign-in: these are fetch()
// endpoints, and a redirect would turn an expired-session POST into a 200 HTML
// response that the client could mistake for success.
const auth = (req, res, next) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  next();
};

app.get('/api/me', auth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  const { userId } = getAuth(req);
  try {
    const { rows } = await db.query(
      'SELECT clerk_user_id, sleeper_username, sleeper_user_id, primary_league_id FROM users WHERE clerk_user_id = $1',
      [userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    res.json({ clerkUserId: u.clerk_user_id, sleeperUsername: u.sleeper_username, sleeperUserId: u.sleeper_user_id, primaryLeagueId: u.primary_league_id });
  } catch (err) {
    console.error('/api/me error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/me/sleeper', auth, express.json({ limit: '10kb' }), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  const { userId } = getAuth(req);
  const { sleeperUsername } = req.body || {};
  if (!sleeperUsername || typeof sleeperUsername !== 'string' || sleeperUsername.length > 60) {
    return res.status(400).json({ error: 'sleeperUsername required' });
  }
  try {
    const r = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(sleeperUsername.trim())}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(404).json({ error: 'Sleeper user not found' });
    const su = await r.json();
    if (!su || !su.user_id) return res.status(404).json({ error: 'Sleeper user not found' });
    const { rows } = await db.query(
      `INSERT INTO users (clerk_user_id, sleeper_username, sleeper_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (clerk_user_id) DO UPDATE SET sleeper_username = EXCLUDED.sleeper_username, sleeper_user_id = EXCLUDED.sleeper_user_id
       RETURNING clerk_user_id, sleeper_username, sleeper_user_id, primary_league_id`,
      [userId, su.username || sleeperUsername.trim(), su.user_id]
    );
    const u = rows[0];
    res.json({ clerkUserId: u.clerk_user_id, sleeperUsername: u.sleeper_username, sleeperUserId: u.sleeper_user_id, primaryLeagueId: u.primary_league_id });
  } catch (err) {
    if (err.message === '404') return res.status(404).json({ error: 'Sleeper user not found' });
    console.error('/api/me/sleeper error:', err.message);
    res.status(500).json({ error: 'Failed to link Sleeper account' });
  }
});

// Fetch a Sleeper user's 2026 NFL leagues (slimmed to what the client needs).
// Throws on network/upstream failure so callers can map it to a 502.
async function fetchSleeperLeagues(sleeperUserId) {
  const r = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(sleeperUserId)}/leagues/nfl/2026`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Sleeper leagues ${r.status}`);
  const leagues = await r.json();
  return (Array.isArray(leagues) ? leagues : []).map(l => ({
    league_id: l.league_id, name: l.name, roster_positions: l.roster_positions,
    scoring_settings: l.scoring_settings, total_rosters: l.total_rosters,
  }));
}

app.get('/api/me/leagues', auth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  const { userId } = getAuth(req);
  try {
    const { rows } = await db.query('SELECT sleeper_user_id FROM users WHERE clerk_user_id = $1', [userId]);
    if (!rows.length || !rows[0].sleeper_user_id) return res.status(404).json({ error: 'Sleeper account not linked' });
    let leagues;
    try {
      leagues = await fetchSleeperLeagues(rows[0].sleeper_user_id);
    } catch (err) {
      return res.status(502).json({ error: 'Failed to fetch leagues from Sleeper' });
    }
    res.json(leagues);
  } catch (err) {
    console.error('/api/me/leagues error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leagues' });
  }
});

app.post('/api/me/leagues/:leagueId/primary', auth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  const { userId } = getAuth(req);
  const { leagueId } = req.params;
  if (!/^\d{1,32}$/.test(leagueId)) return res.status(400).json({ error: 'Invalid league ID' });
  let uid, leagueName = null;
  try {
    const { rows: uRows } = await db.query('SELECT id, sleeper_user_id FROM users WHERE clerk_user_id = $1', [userId]);
    if (!uRows.length) return res.status(404).json({ error: 'User not found' });
    if (!uRows[0].sleeper_user_id) return res.status(404).json({ error: 'Sleeper account not linked' });
    uid = uRows[0].id;
    // Ownership check: the league must be one the linked Sleeper user actually belongs to.
    let leagues;
    try {
      leagues = await fetchSleeperLeagues(uRows[0].sleeper_user_id);
    } catch (err) {
      return res.status(502).json({ error: 'Failed to verify league with Sleeper' });
    }
    const owned = leagues.find(l => String(l.league_id) === leagueId);
    if (!owned) return res.status(403).json({ error: 'League is not one of your Sleeper leagues' });
    leagueName = owned.name || null;
  } catch (err) {
    console.error('/api/me/leagues/:id/primary lookup error:', err.message);
    return res.status(500).json({ error: 'Failed to set primary league' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE user_leagues SET is_primary = false WHERE user_id = $1', [uid]);
    await client.query(
      `INSERT INTO user_leagues (user_id, league_id, league_name, is_primary) VALUES ($1, $2, $3, true)
       ON CONFLICT (user_id, league_id) DO UPDATE SET is_primary = true, league_name = COALESCE(EXCLUDED.league_name, user_leagues.league_name)`,
      [uid, leagueId, leagueName]
    );
    await client.query('UPDATE users SET primary_league_id = $1 WHERE id = $2', [leagueId, uid]);
    await client.query('COMMIT');
    res.json({ ok: true, primaryLeagueId: leagueId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('/api/me/leagues/:id/primary error:', err.message);
    res.status(500).json({ error: 'Failed to set primary league' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Trades — save + retrieve
// ---------------------------------------------------------------------------
// Anonymous saves are allowed (share links work without an account), so the
// only guard against DB bloat is a per-IP cap: 20 saves per hour.
const TRADE_SAVE_LIMIT = 20;
const TRADE_SAVE_WINDOW = 60 * 60 * 1000;
const isIdList = a => Array.isArray(a) && a.length <= 25 && a.every(x => typeof x === 'string' && x.length <= 20);

app.post('/api/trades', express.json({ limit: '50kb' }), async (req, res) => {
  if (rateLimit(`trade:${req.ip}`, TRADE_SAVE_LIMIT, TRADE_SAVE_WINDOW)) {
    return res.status(429).json({ error: 'Too many saved trades — try again in an hour' });
  }
  const { give, recv, result, preset, leagueId } = req.body || {};
  if (!isIdList(give) || !isIdList(recv)) return res.status(400).json({ error: 'give and recv must be arrays of player IDs' });
  if (!give.length && !recv.length) return res.status(400).json({ error: 'Trade is empty' });
  if (leagueId != null && !/^\d{1,32}$/.test(String(leagueId))) return res.status(400).json({ error: 'Invalid league ID' });
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const shareToken = token.slice(0, 12);
  try {
    await db.query('INSERT INTO trades (share_token, payload_json) VALUES ($1, $2)', [shareToken, JSON.stringify({ give, recv, result, preset, leagueId })]);
    res.json({ shareToken });
  } catch (err) {
    console.error('/api/trades POST error:', err.message);
    res.status(500).json({ error: 'Failed to save trade' });
  }
});

app.get('/api/trades/:token', async (req, res) => {
  if (!/^[a-z0-9]{12}$/.test(req.params.token)) return res.status(404).json({ error: 'Trade not found' });
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { rows } = await db.query('SELECT payload_json, created_at FROM trades WHERE share_token = $1', [req.params.token]);
    if (!rows.length) return res.status(404).json({ error: 'Trade not found' });
    res.json({ ...rows[0].payload_json, createdAt: rows[0].created_at });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ---------------------------------------------------------------------------
// Static serving — deny sensitive server-side files first
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const p = req.path;
  if (
    /^\/server\.js$/i.test(p) ||
    /^\/package(-lock)?\.json$/i.test(p) ||
    /^\/\.env/i.test(p) ||
    /^\/node_modules\//i.test(p) ||
    /^\/db\//i.test(p) ||
    /^\/routes\//i.test(p) ||
    /^\/scripts\//i.test(p) ||
    /^\/trade\.html$/i.test(p) ||
    /^\/home\.html$/i.test(p)
  ) return res.status(404).end();
  next();
});

// /trade served with server-injected Clerk publishable key
app.get('/trade', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'trade.html'), 'utf8');
    html = html.replace('PUBLISHABLE_KEY_PLACEHOLDER', process.env.CLERK_PUBLISHABLE_KEY || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).send('Failed to load trade page');
  }
});

// Home page: bare / only — any query param (?companion=1, ?league_id=…) hits the draft tool
app.get('/', (req, res) => {
  const hasDraftParam = Object.keys(req.query).length > 0;
  if (hasDraftParam) return res.sendFile(path.join(__dirname, 'index.html'));
  try {
    const html = fs.readFileSync(path.join(__dirname, 'home.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// Clean URL alias for the draft tool
app.get('/draft', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve the app
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Warm injury cache on startup so the first request is fast, then refresh every 4h
fetchLiveInjuries().catch(err => console.error('Startup injury fetch failed:', err.message));
setInterval(
  () => fetchLiveInjuries().catch(err => console.error('Injury refresh failed:', err.message)),
  INJURY_CACHE_TTL
).unref();

// Run DB migrations before accepting traffic
migrate().catch(err => console.error('Migration failed:', err.message));

const server = app.listen(PORT, () => {
  console.log(`Fantasy Draft Assistant running on port ${PORT}`);
});

// Graceful shutdown — notify SSE clients before Railway kills the container
// so the frontend can reconnect proactively instead of waiting for a dead connection.
process.on('SIGTERM', () => {
  console.log('SIGTERM received — notifying SSE clients and shutting down');
  for (const [, relay] of draftRelays) {
    for (const client of relay.clients) {
      try { client.write('event: restart\ndata: {}\n\n'); } catch (e) {}
    }
  }
  // Give clients a moment to receive the event, then close
  setTimeout(() => {
    server.close(() => process.exit(0));
  }, 1000);
});
