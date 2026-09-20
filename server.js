const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const { clerkMiddleware, getAuth } = require("@clerk/express");
const { Pool } = require('pg');
const { pool: db, migrate } = require('./db/migrate');
const WeekHistory = require('./scripts/log-week');
const FPACalibration = require('./shared/fpa-calibration');

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

// In-memory live injury cache — refreshed every 30 minutes from Sleeper.
// Injury designations can flip fast on game day; 30 min keeps data actionable.
// Falls back to data/injuries.json when Sleeper is unreachable.
let liveInjuryCache = { data: null, lastFetch: 0 };
const INJURY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

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
    "connect-src 'self' https://api.sleeper.app https://api.the-odds-api.com https://api.open-meteo.com https://umami-production-e09b.up.railway.app " + clerkOrigins + "; " +
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
      headers: { 'User-Agent': 'Pocket/1.0 (fantasy draft assistant)' },
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
    // 2022-2025 = completed seasons; 2026 = current season (weeks not yet played
    // return no rows, so buildSeasonStats yields null until gp > 0 and is filtered).
    const seasons = await Promise.all([2022, 2023, 2024, 2025, 2026].map(y => buildSeasonStats(id, y)));
    const data = { seasons: seasons.filter(Boolean), nflSeasonLength: NFL_SEASON_LENGTH };
    evictOldest(statsCache, STATS_CACHE_MAX);
    statsCache.set(id, { data, time: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('Stats fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch stats' });
  }
});

// Generic in-memory rate limiter for write endpoints (e.g. trade saves).
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

// Periodically drop expired rate-limit entries so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.reset) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000).unref();

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

// FantasyCalc market values — community trade consensus, blended with VORP on
// the client (shared/scoring.js blendWithMarket). Returns a slim
// { sleeperId: value } dict; each ppr/sf/dynasty combination is cached separately.
// sf=1 → FC's 2-QB list (numQbs=2), where QB1 ≈ RB1 instead of ≈ ½ RB1.
// dynasty=1 → FC's dynasty list (`value`, which prices age and picks in);
// otherwise the redraft list (`redraftValue`).
app.get('/api/market-values', async (req, res) => {
  const ppr = req.query.ppr === '0' ? 0 : 1;
  const sf = req.query.sf === '1' ? 1 : 0;
  const dynasty = req.query.dynasty === '1' ? 1 : 0;
  const cacheKey = `fc:${ppr}:${sf}:${dynasty}`;
  try {
    const data = await apiCached(cacheKey, 60 * 60 * 1000, async () => {
      const url = `https://api.fantasycalc.com/values/current?isDynasty=${dynasty ? 'true' : 'false'}&numQbs=${sf ? 2 : 1}&ppr=${ppr}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`FC ${r.status}`);
      const arr = await r.json();
      const slim = {};
      for (const item of (Array.isArray(arr) ? arr : [])) {
        const sid = item?.player?.sleeperId;
        const v = dynasty ? item?.value : item?.redraftValue;
        if (sid && v != null) slim[sid] = v;
      }
      return slim;
    });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch market values' });
  }
});

// Weekly projections + weekly actuals. The legacy api.sleeper.app/v1 weekly
// projections route returns empty objects for 2026, so both use the
// api.sleeper.com host (array of { player_id, team, opponent, stats }). Both
// respond as { player_id: stats } so shared/scoring.js can score them under
// any league's scoring_settings. Opponents come from /api/schedule/:week.
const SLEEPER_WEEK_POS = 'position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF';
async function fetchSleeperWeek(kind, week) {
  const url = `https://api.sleeper.com/${kind}/nfl/2026/${week}?season_type=regular&${SLEEPER_WEEK_POS}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Sleeper ${kind} ${r.status}`);
  const raw = await r.json();
  const slim = {};
  for (const item of (Array.isArray(raw) ? raw : [])) {
    if (item && item.player_id && item.stats && Object.keys(item.stats).length) slim[item.player_id] = item.stats;
  }
  return slim;
}

app.get('/api/projections/:week', async (req, res) => {
  const week = parseInt(req.params.week, 10);
  if (!week || week < 1 || week > 18) return res.status(400).json({ error: 'Invalid week' });
  try {
    const data = await apiCached(`proj:2026:${week}`, 60 * 60 * 1000, () => fetchSleeperWeek('projections', week));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch projections' });
  }
});

// Actual weekly stats (what the player really scored) — feeds the lineup
// optimizer's form factor. Empty object until the week's games are played.
app.get('/api/stats/:week', async (req, res) => {
  const week = parseInt(req.params.week, 10);
  if (!week || week < 1 || week > 18) return res.status(400).json({ error: 'Invalid week' });
  try {
    const data = await apiCached(`stats:2026:${week}`, 60 * 60 * 1000, () => fetchSleeperWeek('stats', week));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch stats' });
  }
});

// Per-player usage for one completed week: targets, carries and offensive snaps
// as a share of the player's team that week. Sleeper's feed includes a "TEAM"
// aggregate row per club (and DEF rows) — excluded from the team sums so
// targets aren't double counted. Only RB/WR/TE are kept (the lineup usage
// factor has no rule for other positions). Completed weeks never change, so
// they cache for 24h; the most recent week (still filling in) for 1h.
const USAGE_POS = { RB: 1, WR: 1, TE: 1 };
async function fetchUsageWeek(week, ttlMs) {
  return apiCached(`usage:2026:${week}`, ttlMs, async () => {
    const r = await fetch(`https://api.sleeper.com/stats/nfl/2026/${week}?season_type=regular`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Sleeper stats ${r.status}`);
    const raw = await r.json();
    const team = {};   // TEAM → { tgt, rush }
    const rows = [];
    for (const item of (Array.isArray(raw) ? raw : [])) {
      const st = item && item.stats, pos = item && item.player && item.player.position;
      if (!st || !item.team || !pos || pos === 'TEAM' || pos === 'DEF') continue;
      const t = team[item.team] || (team[item.team] = { tgt: 0, rush: 0 });
      t.tgt += Number(st.rec_tgt) || 0;
      t.rush += Number(st.rush_att) || 0;
      if (USAGE_POS[pos] && Number(st.off_snp) > 0) rows.push({ id: String(item.player_id), pos, team: item.team, st });
    }
    const players = {};
    for (const row of rows) {
      const t = team[row.team];
      players[row.id] = {
        pos: row.pos, team: row.team,
        tgtShare: t.tgt > 0 ? (Number(row.st.rec_tgt) || 0) / t.tgt : null,
        carryShare: t.rush > 0 ? (Number(row.st.rush_att) || 0) / t.rush : null,
        snapPct: Number(row.st.tm_off_snp) > 0 ? Number(row.st.off_snp) / Number(row.st.tm_off_snp) : null,
      };
    }
    return { week, players, teams: Object.keys(team).length };
  });
}

function averageUsage(weeks, id) {
  const acc = { tgtShare: [0, 0], carryShare: [0, 0], snapPct: [0, 0] };
  let games = 0;
  for (const w of weeks) {
    const p = w.players[id];
    if (!p) continue;
    games++;
    for (const k in acc) if (p[k] != null) { acc[k][0] += p[k]; acc[k][1]++; }
  }
  const out = { games };
  for (const k in acc) out[k] = acc[k][1] ? +(acc[k][0] / acc[k][1]).toFixed(4) : null;
  return out;
}

// GET /api/recent-stats?week=N (N = the week being set; defaults to Sleeper's
// current week) → { week, recentWeeks, seasonWeeks, players: { id: { pos, team,
// recent: { tgtShare, carryShare, snapPct, games }, season: { … } } } }.
// `recent` averages the last two completed weeks, `season` every completed week
// (games = weeks the player logged an offensive snap). Feeds usageMultiplier in
// shared/weekly-score.js. A week only counts as complete once 24+ teams have
// stat lines, so a half-played week never pollutes the averages.
app.get('/api/recent-stats', async (req, res) => {
  let week = parseInt(req.query.week, 10);
  try {
    if (!week) {
      const state = await apiCached('nfl:state', 5 * 60 * 1000, () =>
        fetch('https://api.sleeper.app/v1/state/nfl').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      );
      week = state.week || 1;
    }
    if (week < 1 || week > 18) return res.status(400).json({ error: 'Invalid week' });
    const candidates = [];
    for (let w = 1; w < week; w++) candidates.push(w);
    const fetched = await Promise.all(candidates.map(w => fetchUsageWeek(w, w < week - 1 ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000).catch(() => null)));
    const weeks = fetched.filter(w => w && w.teams >= 24);
    const recent = weeks.slice(-2);
    const ids = new Set();
    for (const w of weeks) for (const id in w.players) ids.add(id);
    const players = {};
    for (const id of ids) {
      const last = [...weeks].reverse().find(w => w.players[id]).players[id];
      players[id] = { pos: last.pos, team: last.team, recent: averageUsage(recent, id), season: averageUsage(weeks, id) };
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({ week, recentWeeks: recent.map(w => w.week), seasonWeeks: weeks.map(w => w.week), players });
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch recent stats' });
  }
});

// Full regular-season schedule from Sleeper, cached 6h. Shared by /api/schedule
// and /api/weather. Each game: { week, date: 'YYYY-MM-DD', home, away, status }.
function fetchSeasonSchedule() {
  return apiCached('schedule:2026', 6 * 60 * 60 * 1000, async () => {
    const r = await fetch('https://api.sleeper.app/schedule/nfl/regular/2026', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Sleeper schedule ${r.status}`);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) throw new Error('empty schedule');
    return arr;
  });
}

// Kickoff times + live game state for one week from Sleeper's scores feed
// (the schedule feed above only carries a date). Keyed by home team:
//   { KC: { kickoff: '2026-09-21T00:20:00+00:00', status: 'pre_game'|'in_game'|'complete', started: bool } }
// `started` is Sleeper's own flag (metadata.has_started / is_in_progress /
// is_over) so a slot locks even if the client clock is off. Cached 5 min so a
// Sunday-afternoon page load sees the 1pm games flip to in-progress.
function fetchWeekGameState(week) {
  return apiCached(`gamestate:2026:${week}`, 5 * 60 * 1000, async () => {
    const r = await fetch(`https://api.sleeper.app/scores/nfl/regular/2026/${week}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Sleeper scores ${r.status}`);
    const arr = await r.json();
    const byHome = {};
    for (const g of (Array.isArray(arr) ? arr : [])) {
      const m = (g && g.metadata) || {};
      const home = m.home_team;
      if (!home) continue;
      const kickoff = m.date_time || (g.start_time ? new Date(Number(g.start_time)).toISOString() : null);
      const status = g.status || m.status || null;
      byHome[home] = {
        kickoff: kickoff || null,
        status,
        started: !!(m.has_started || m.is_in_progress || m.is_over || status === 'in_game' || status === 'complete'),
      };
    }
    return byHome;
  });
}

// Who plays whom this week:
//   { week, teams: { KC: { opp: 'IND', home: true, status, date, kickoff, started } } }
// Teams missing from `teams` are on bye. Same schedule feed scripts/fetch-injuries.js uses.
// `kickoff` (ISO) and `started` come from the scores feed when it responds; the
// lineup page locks a player once his game has started (kickoff passed OR
// Sleeper says started) so it never suggests swapping someone already playing.
app.get('/api/schedule/:week', async (req, res) => {
  const week = parseInt(req.params.week, 10);
  if (!week || week < 1 || week > 18) return res.status(400).json({ error: 'Invalid week' });
  try {
    const [games, state] = await Promise.all([
      fetchSeasonSchedule(),
      fetchWeekGameState(week).catch(() => ({})),
    ]);
    const teams = {};
    for (const g of games) {
      if (Number(g.week) !== week || !g.home || !g.away) continue;
      const live = state[g.home] || null;
      const status = (live && live.status) || g.status || null;
      const kickoff = live ? live.kickoff : null;
      const started = live ? live.started : (status === 'in_game' || status === 'complete');
      teams[g.home] = { opp: g.away, home: true, status, date: g.date || null, kickoff, started };
      teams[g.away] = { opp: g.home, home: false, status, date: g.date || null, kickoff, started };
    }
    // Short browser cache: game state changes every few minutes on Sundays.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ week, teams, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch schedule' });
  }
});

// Slim per-week fantasy points for the trade calculator's form signal
// (shared/trade-fit.js formMap): the last N completed weeks, each as
// { player_id: { gp, pts_ppr, pts_half_ppr, pts_std } } for QB/RB/WR/TE. Only
// Sleeper's own point columns are kept (a full stat line is ~1 KB per player),
// so the client reads actual vs projected on the same scale by picking the
// column that matches the league's PPR setting. Completed weeks never change
// and cache 24h; the most recent one (stat corrections) 1h.
// GET /api/recent-points?n=3 (1–4, default 3) →
//   { season, week, weeks: [most recent first], stats: { week: { id: {…} } } }
// A week counts as complete when it is before Sleeper's current week AND has
// 100+ stat lines, so a week that hasn't been played yet is never returned.
const POINTS_KEYS = ['gp', 'pts_ppr', 'pts_half_ppr', 'pts_std'];
const POINTS_POS = 'position[]=QB&position[]=RB&position[]=WR&position[]=TE';
function fetchPointsWeek(week, ttlMs) {
  return apiCached(`points:2026:${week}`, ttlMs, async () => {
    const r = await fetch(`https://api.sleeper.com/stats/nfl/2026/${week}?season_type=regular&${POINTS_POS}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Sleeper stats ${r.status}`);
    const raw = await r.json();
    const players = {};
    let rows = 0;
    for (const item of (Array.isArray(raw) ? raw : [])) {
      const st = item && item.stats;
      if (!st || !item.player_id) continue;
      const slim = {};
      for (const k of POINTS_KEYS) if (st[k] != null) slim[k] = st[k];
      if (!Object.keys(slim).length) continue;
      players[String(item.player_id)] = slim;
      rows++;
    }
    return { week, players, rows };
  });
}

app.get('/api/recent-points', async (req, res) => {
  let n = parseInt(req.query.n, 10);
  if (!n || n < 1) n = 3;
  if (n > 4) n = 4;
  try {
    const state = await apiCached('nfl:state', 5 * 60 * 1000, () =>
      fetch('https://api.sleeper.app/v1/state/nfl').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    );
    const week = Number(state.week) || 1;
    const candidates = [];
    for (let w = week - 1; w >= 1 && candidates.length < n + 1; w--) candidates.push(w);
    const fetched = await Promise.all(candidates.map(w =>
      fetchPointsWeek(w, w < week - 1 ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000).catch(() => null)
    ));
    const weeks = fetched.filter(w => w && w.rows >= 100).slice(0, n);
    const stats = {};
    for (const w of weeks) stats[w.week] = w.players;
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({ season: String(state.season || 2026), week, weeks: weeks.map(w => w.week), stats });
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch recent points' });
  }
});

// Game-day weather for the lineup optimizer's weather factor.
// GET /api/weather?week=N (defaults to Sleeper's current week) →
//   { week, teams: { KC: { windspeed: 8, precip: 0, indoor: false, date, forecast: true }, … }, fetchedAt }
// Both teams in a game get the HOME stadium's forecast (windspeed in mph,
// precip = % chance of precipitation). Indoor / retractable-roof stadiums skip
// the forecast entirely. Teams on bye are absent. Source: Open-Meteo, free, no
// key, fetched server-side once per week per 6 hours.
// Kickoff times aren't in the Sleeper schedule, so Sunday games average the
// 1pm and 4pm ET hours (the two main windows); Thu/Sat/Mon games use 8pm ET.
// Caveat: international games use the listed home team's stadium, not the
// neutral site.
const STADIUMS = {
  ARI: { lat: 33.5277, lon: -112.2626, indoor: true },   // State Farm Stadium (retractable)
  ATL: { lat: 33.7553, lon: -84.4006, indoor: true },    // Mercedes-Benz Stadium (retractable)
  BAL: { lat: 39.2780, lon: -76.6227, indoor: false },   // M&T Bank Stadium
  BUF: { lat: 42.7738, lon: -78.7870, indoor: false },   // Highmark Stadium
  CAR: { lat: 35.2258, lon: -80.8528, indoor: false },   // Bank of America Stadium
  CHI: { lat: 41.8623, lon: -87.6167, indoor: false },   // Soldier Field
  CIN: { lat: 39.0954, lon: -84.5160, indoor: false },   // Paycor Stadium
  CLE: { lat: 41.5061, lon: -81.6995, indoor: false },   // Huntington Bank Field
  DAL: { lat: 32.7473, lon: -97.0945, indoor: true },    // AT&T Stadium (retractable)
  DEN: { lat: 39.7439, lon: -105.0201, indoor: false },  // Empower Field at Mile High
  DET: { lat: 42.3400, lon: -83.0456, indoor: true },    // Ford Field (dome)
  GB:  { lat: 44.5013, lon: -88.0622, indoor: false },   // Lambeau Field
  HOU: { lat: 29.6847, lon: -95.4107, indoor: true },    // NRG Stadium (retractable)
  IND: { lat: 39.7601, lon: -86.1639, indoor: true },    // Lucas Oil Stadium (retractable)
  JAX: { lat: 30.3239, lon: -81.6373, indoor: false },   // EverBank Stadium
  KC:  { lat: 39.0489, lon: -94.4839, indoor: false },   // GEHA Field at Arrowhead — open-air
  LAC: { lat: 33.9534, lon: -118.3390, indoor: true },   // SoFi Stadium (roofed)
  LAR: { lat: 33.9534, lon: -118.3390, indoor: true },   // SoFi Stadium (roofed)
  LV:  { lat: 36.0908, lon: -115.1833, indoor: true },   // Allegiant Stadium (dome)
  MIA: { lat: 25.9580, lon: -80.2389, indoor: false },   // Hard Rock Stadium
  MIN: { lat: 44.9736, lon: -93.2575, indoor: true },    // U.S. Bank Stadium (dome)
  NE:  { lat: 42.0909, lon: -71.2643, indoor: false },   // Gillette Stadium
  NO:  { lat: 29.9511, lon: -90.0812, indoor: true },    // Caesars Superdome
  NYG: { lat: 40.8135, lon: -74.0745, indoor: false },   // MetLife Stadium
  NYJ: { lat: 40.8135, lon: -74.0745, indoor: false },   // MetLife Stadium
  PHI: { lat: 39.9008, lon: -75.1675, indoor: false },   // Lincoln Financial Field
  PIT: { lat: 40.4468, lon: -80.0158, indoor: false },   // Acrisure Stadium
  SEA: { lat: 47.5952, lon: -122.3316, indoor: false },  // Lumen Field
  SF:  { lat: 37.4033, lon: -121.9694, indoor: false },  // Levi's Stadium
  TB:  { lat: 27.9759, lon: -82.5033, indoor: false },   // Raymond James Stadium
  TEN: { lat: 36.1665, lon: -86.7713, indoor: false },   // Nissan Stadium
  WAS: { lat: 38.9076, lon: -76.8645, indoor: false },   // Northwest Stadium
};
const WEATHER_TTL = 6 * 60 * 60 * 1000;

// Hours (ET) to sample for a game on the given date; averaged. Sunday = the
// two main windows; Friday/Saturday slates (Black Friday, Christmas, week 15)
// spread across the day; everything else is a night game.
function kickoffHoursET(dateStr) {
  const day = new Date(dateStr + 'T12:00:00Z').getUTCDay(); // date-only → weekday, safe from TZ shifts
  if (day === 0) return [13, 16];
  if (day === 5 || day === 6) return [13, 16, 20];
  return [20];
}

// One Open-Meteo call for every outdoor stadium at once (comma-separated
// coordinates → array of forecasts in the same order). Separate per-stadium
// requests trip Open-Meteo's burst limit (429) when 16 fire together.
async function fetchOpenMeteoHourly(points) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + points.map(p => p.lat).join(',') +
    '&longitude=' + points.map(p => p.lon).join(',') +
    '&hourly=windspeed_10m,precipitation_probability&windspeed_unit=mph&timezone=America%2FNew_York&forecast_days=10';
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Open-Meteo ' + r.status);
  const data = await r.json();
  if (data && data.error) throw new Error('Open-Meteo: ' + (data.reason || 'error'));
  const list = Array.isArray(data) ? data : [data];
  if (list.length !== points.length) throw new Error('Open-Meteo returned ' + list.length + ' forecasts for ' + points.length + ' stadiums');
  return list.map(d => d && d.hourly ? d.hourly : null);
}

// Kickoff-window averages from one stadium's hourly series → { windspeed (mph), precip (%) },
// or null when the date is outside the forecast window.
function sampleKickoff(hourly, dateStr) {
  if (!hourly || !hourly.time) return null;
  const winds = [], precips = [];
  for (const hour of kickoffHoursET(dateStr)) {
    const i = hourly.time.indexOf(dateStr + 'T' + String(hour).padStart(2, '0') + ':00');
    if (i < 0) continue;
    if (hourly.windspeed_10m && hourly.windspeed_10m[i] != null) winds.push(hourly.windspeed_10m[i]);
    if (hourly.precipitation_probability && hourly.precipitation_probability[i] != null) precips.push(hourly.precipitation_probability[i]);
  }
  if (!winds.length) return null;
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return { windspeed: Math.round(avg(winds) * 10) / 10, precip: precips.length ? Math.round(avg(precips)) : 0 };
}

app.get('/api/weather', async (req, res) => {
  try {
    let week = parseInt(req.query.week, 10);
    if (req.query.week != null && (!week || week < 1 || week > 18)) return res.status(400).json({ error: 'Invalid week' });
    if (!week) {
      const state = await apiCached('nfl:state', 5 * 60 * 1000, () =>
        fetch('https://api.sleeper.app/v1/state/nfl').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      );
      week = Number(state.week) || 1;
    }
    const data = await apiCached('weather:' + week, WEATHER_TTL, async () => {
      const games = (await fetchSeasonSchedule()).filter(g => Number(g.week) === week && g.home && g.away);
      // Unique outdoor stadiums hosting this week (NYG/NYJ share coordinates)
      const outdoor = new Map();
      for (const g of games) {
        const s = STADIUMS[g.home];
        if (s && !s.indoor && g.date) outdoor.set(s.lat + ',' + s.lon, s);
      }
      const points = [...outdoor.values()];
      const hourlyByKey = new Map();
      if (points.length) {
        // A failed fetch throws so apiCached serves the previous result (or 503) rather than caching 6h of "no forecast".
        const series = await fetchOpenMeteoHourly(points);
        points.forEach((p, i) => hourlyByKey.set(p.lat + ',' + p.lon, series[i]));
      }
      const teams = {};
      for (const g of games) {
        const stadium = STADIUMS[g.home];
        const base = { indoor: !!(stadium && stadium.indoor), date: g.date || null, forecast: false };
        const wx = stadium && !stadium.indoor && g.date ? sampleKickoff(hourlyByKey.get(stadium.lat + ',' + stadium.lon), g.date) : null;
        const entry = wx
          ? { ...base, windspeed: wx.windspeed, precip: wx.precip, forecast: true }
          : { ...base, windspeed: 0, precip: 0 };
        teams[g.home] = entry;
        teams[g.away] = { ...entry };
      }
      return { week, teams, fetchedAt: new Date().toISOString() };
    });
    res.setHeader('Cache-Control', 'public, max-age=21600');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch weather' });
  }
});

// Injured defenders by team, for the lineup optimizer's opponent-injury boost:
// { KC: [{ name, pos, slot, order, status }] }. Only depth-chart 1–2 defensive
// backs / linebackers with a Sleeper injury_status; `slot` is Sleeper's
// depth_chart_position (LCB, RCB, NB, FS, SS, MLB, ROLB …).
app.get('/api/def-injuries', async (req, res) => {
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
  const DEF_POS = new Set(['CB', 'DB', 'S', 'SS', 'FS', 'LB', 'OLB', 'ILB', 'MLB']);
  const STATUSES = new Set(['Out', 'IR', 'Doubtful', 'PUP', 'Questionable']);
  const byTeam = {};
  for (const p of Object.values(dict)) {
    if (!p || !p.team || !DEF_POS.has(p.position) || !STATUSES.has(p.injury_status)) continue;
    const order = Number(p.depth_chart_order);
    if (!order || order > 2) continue;
    (byTeam[p.team] = byTeam[p.team] || []).push({
      name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' '),
      pos: p.position,
      slot: p.depth_chart_position || null,
      order,
      status: p.injury_status,
    });
  }
  res.setHeader('Cache-Control', 'public, max-age=1800');
  res.json(byTeam);
});

// Vegas implied team totals from The Odds API.
// Returns { week: N, teams: { KC: 27.5, BUF: 23.0, … } }.
// Cached for 12 hours — odds are fetched once and served to all users.
// Requires ODDS_API_KEY env var (the-odds-api.com, free tier = 500 req/mo).
const NFL_ABBR = {
  'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL',
  'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR', 'Chicago Bears': 'CHI',
  'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL',
  'Denver Broncos': 'DEN', 'Detroit Lions': 'DET', 'Green Bay Packers': 'GB',
  'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX',
  'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC',
  'Los Angeles Rams': 'LAR', 'Miami Dolphins': 'MIA', 'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG',
  'New York Jets': 'NYJ', 'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT',
  'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA', 'Tampa Bay Buccaneers': 'TB',
  'Tennessee Titans': 'TEN', 'Washington Commanders': 'WAS',
};

app.get('/api/vegas', async (req, res) => {
  const key = process.env.ODDS_API_KEY;
  if (!key) return res.status(503).json({ error: 'ODDS_API_KEY not configured' });
  try {
    const data = await apiCached('vegas:nfl', 12 * 60 * 60 * 1000, async () => {
      const url = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/' +
        '?apiKey=' + key + '&regions=us&markets=spreads,totals&oddsFormat=decimal';
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('Odds API ' + r.status);
      return r.json();
    });

    const teams = {};
    for (const game of data) {
      const homeAbbr = NFL_ABBR[game.home_team];
      const awayAbbr = NFL_ABBR[game.away_team];
      if (!homeAbbr || !awayAbbr) continue;

      // Collect spread + total consensus across bookmakers
      const spreads = [], totals = [];
      for (const bk of (game.bookmakers || [])) {
        for (const mkt of (bk.markets || [])) {
          if (mkt.key === 'totals') {
            const over = mkt.outcomes.find(o => o.name === 'Over');
            if (over && over.point) totals.push(over.point);
          } else if (mkt.key === 'spreads') {
            const home = mkt.outcomes.find(o => o.name === game.home_team);
            if (home && home.point != null) spreads.push(home.point);
          }
        }
      }
      if (!totals.length || !spreads.length) continue;
      const total = totals.reduce((a, b) => a + b, 0) / totals.length;
      const homeSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
      // home_implied = total/2 - homeSpread/2 (homeSpread negative when home favoured)
      teams[homeAbbr] = parseFloat((total / 2 - homeSpread / 2).toFixed(2));
      teams[awayAbbr] = parseFloat((total / 2 + homeSpread / 2).toFixed(2));
    }

    // Real mean implied team total for the slate — the scoring engine uses this
    // as the Vegas baseline so the multiplier is relative (half the teams above
    // the mean, half below) instead of everyone clearing a stale hardcoded 22.
    const impliedVals = Object.values(teams).filter(v => isFinite(v));
    const avgImplied = impliedVals.length
      ? parseFloat((impliedVals.reduce((a, b) => a + b, 0) / impliedVals.length).toFixed(2))
      : null;

    res.setHeader('Cache-Control', 'public, max-age=43200');
    res.json({ teams, avgImplied, gameCount: Object.keys(teams).length / 2 | 0, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ error: 'Failed to fetch Vegas odds' });
  }
});

// Slim players dict for trade/lineup UI — [name, pos, team, injury_status, age]
// for skill positions. injury_status is Sleeper's raw value (Out, IR, Doubtful,
// Questionable, …) or null, so pages can flag injuries without a name join.
// age (integer years or null) feeds the dynasty age curve in shared/trade-fit.js.
// ?def=1 also includes team defenses (keyed by team abbreviation, e.g. "SF"),
// which rosters reference but the trade search doesn't want.
app.get('/api/players/slim', async (req, res) => {
  const includeDef = req.query.def === '1';
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
    if (!p) continue;
    if (includeDef && p.position === 'DEF') {
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || id;
      slim[id] = [name, 'DEF', p.team || id, null];
      continue;
    }
    if (!p.full_name || !POSITIONS.has(p.position) || p.active === false) continue;
    slim[id] = [p.full_name, p.position, p.team || 'FA', p.injury_status || null, typeof p.age === 'number' ? p.age : null];
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
// Target / avoid lists — account-persisted (research page)
// ---------------------------------------------------------------------------
const LIST_MAX_ENTRIES = 500;
const LIST_NAME_MAX = 80;

// Normalize a client-supplied list into unique, trimmed, bounded player names.
// Returns null if the payload isn't an array of strings.
function cleanNameList(arr) {
  if (!Array.isArray(arr)) return null;
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    if (typeof raw !== 'string') return null;
    const name = raw.trim();
    if (!name || name.length > LIST_NAME_MAX) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length > LIST_MAX_ENTRIES) return null;
  }
  return out;
}

app.get('/api/me/lists', auth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  const { userId } = getAuth(req);
  try {
    const { rows } = await db.query(
      `SELECT l.list_type, l.player_name
         FROM user_lists l JOIN users u ON u.id = l.user_id
        WHERE u.clerk_user_id = $1
        ORDER BY l.created_at, l.id`,
      [userId]
    );
    const targets = [], avoids = [];
    for (const r of rows) (r.list_type === 'target' ? targets : avoids).push(r.player_name);
    res.json({ targets, avoids });
  } catch (err) {
    console.error('/api/me/lists GET error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Full replacement: the body's lists become the user's lists. A name present in
// both is kept as a target (mirrors the client rule that a player can't be both).
app.put('/api/me/lists', auth, express.json({ limit: '100kb' }), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  const { userId } = getAuth(req);
  const targets = cleanNameList((req.body || {}).targets);
  const avoids = cleanNameList((req.body || {}).avoids);
  if (!targets || !avoids) {
    return res.status(400).json({ error: `targets and avoids must be arrays of up to ${LIST_MAX_ENTRIES} player names` });
  }
  const targetKeys = new Set(targets.map(n => n.toLowerCase()));
  const avoidsOnly = avoids.filter(n => !targetKeys.has(n.toLowerCase()));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Ensure a users row exists — lists can be saved before Sleeper is linked.
    const { rows } = await client.query(
      `INSERT INTO users (clerk_user_id) VALUES ($1)
       ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
       RETURNING id`,
      [userId]
    );
    const uid = rows[0].id;
    await client.query('DELETE FROM user_lists WHERE user_id = $1', [uid]);
    if (targets.length) {
      await client.query(
        `INSERT INTO user_lists (user_id, list_type, player_name)
         SELECT $1, 'target', unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [uid, targets]
      );
    }
    if (avoidsOnly.length) {
      await client.query(
        `INSERT INTO user_lists (user_id, list_type, player_name)
         SELECT $1, 'avoid', unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [uid, avoidsOnly]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('/api/me/lists PUT error:', err.message);
    res.status(500).json({ error: 'Failed to save lists' });
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
// Week history — the season's persisted learning (data/history/ + Postgres)
// ---------------------------------------------------------------------------
// One record per completed week (see scripts/log-week.js for the schema and
// the reasoning). Two stores, merged on read with the newer generatedAt winning:
//   data/history/<season>-week-<N>.json  committed by .github/workflows/log-week.yml
//                                        (durable: ships with every deploy)
//   week_history table                   written by POST /api/log-week so an
//                                        on-demand log survives the next redeploy
// The lineup page reads /api/history for the FPA calibration; the backtest
// script reads the files directly.
const HISTORY_SEASON = WeekHistory.SEASON;
const HISTORY_TTL = 10 * 60 * 1000;
let historyCache = { value: null, time: 0 };
let logWeekInFlight = null;

async function loadWeekHistory() {
  if (historyCache.value && Date.now() - historyCache.time < HISTORY_TTL) return historyCache.value;
  const byWeek = new Map();
  for (const rec of WeekHistory.loadHistory({ season: HISTORY_SEASON })) byWeek.set(Number(rec.week), rec);
  if (db) {
    try {
      const { rows } = await db.query('SELECT week, payload_json FROM week_history WHERE season = $1', [HISTORY_SEASON]);
      for (const r of rows) {
        const rec = r.payload_json;
        if (!rec || typeof rec !== 'object') continue;
        const cur = byWeek.get(Number(r.week));
        if (!cur || String(rec.generatedAt || '') > String(cur.generatedAt || '')) byWeek.set(Number(r.week), rec);
      }
    } catch (err) {
      console.error('week_history read error:', err.message);   // disk records still serve
    }
  }
  const list = [...byWeek.values()].sort((a, b) => a.week - b.week);
  historyCache = { value: list, time: Date.now() };
  return list;
}

// GET /api/history?before=N → { season, weeks: [summary], calibration }.
// `before` keeps the calibration hindsight-free when a past week is being viewed.
app.get('/api/history', async (req, res) => {
  try {
    const before = parseInt(req.query.before, 10);
    let history = await loadWeekHistory();
    if (before >= 1) history = history.filter(h => Number(h.week) < before);
    const weeks = history.map(h => ({
      week: h.week, generatedAt: h.generatedAt || null, weeksPlayed: h.weeksPlayed,
      fpaSamples: h.meta ? h.meta.fpaSamples : Object.keys(h.fpa || {}).length,
      fpaRanked: h.meta ? h.meta.fpaRanked : null,
      usagePlayers: h.meta ? h.meta.usagePlayers : Object.keys(h.usage || {}).length,
      backtest: h.backtest || {},
    }));
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json({ season: HISTORY_SEASON, weeks, calibration: FPACalibration.build(history) });
  } catch (err) {
    console.error('/api/history error:', err.message);
    res.status(500).json({ error: 'Failed to load week history' });
  }
});

app.get('/api/history/:week', async (req, res) => {
  const week = parseInt(req.params.week, 10);
  if (!week || week < 1 || week > 18) return res.status(400).json({ error: 'Invalid week' });
  try {
    const rec = (await loadWeekHistory()).find(h => Number(h.week) === week);
    if (!rec) return res.status(404).json({ error: `Week ${week} not logged yet` });
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json(rec);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load week history' });
  }
});

// POST /api/log-week  { week?, backtest?: { leagueId: {...} }, backtestUsers?: [username] }
// Builds the record for `week` (default: latest complete week on Sleeper),
// writes data/history/ and upserts week_history. Guarded by LOG_WEEK_SECRET
// (falls back to ANNOUNCE_SECRET) via the x-log-secret header; open only when
// neither is configured (local dev). The backtest cron calls this after it
// runs, passing its results in `backtest`; `backtestUsers` runs them here.
const LOG_WEEK_SECRET = process.env.LOG_WEEK_SECRET || process.env.ANNOUNCE_SECRET;
app.post('/api/log-week', express.json({ limit: '200kb' }), async (req, res) => {
  if (LOG_WEEK_SECRET && req.headers['x-log-secret'] !== LOG_WEEK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (rateLimit(`log-week:${req.ip}`, 10, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many log-week calls — try again in an hour' });
  }
  if (logWeekInFlight) return res.status(409).json({ error: 'A log-week run is already in progress' });
  const body = req.body || {};
  let week = parseInt(body.week, 10);
  if (body.week != null && (!week || week < 1 || week > 18)) return res.status(400).json({ error: 'Invalid week' });
  const backtestUsers = Array.isArray(body.backtestUsers) ? body.backtestUsers.slice(0, 5) : [];
  logWeekInFlight = (async () => {
    if (!week) week = await WeekHistory.latestCompleteWeek(HISTORY_SEASON);
    if (!week) return { status: 200, body: { ok: false, logged: false, reason: 'No completed week on Sleeper yet' } };
    const history = await loadWeekHistory();
    const record = await WeekHistory.buildWeekRecord({
      week, season: HISTORY_SEASON, backtest: body.backtest, backtestUsers, history,
      log: m => console.log(`log-week: ${m}`),
    });
    // Keep backtest entries this run didn't produce (same merge writeWeekRecord does for disk).
    const prior = history.find(h => Number(h.week) === week);
    if (prior && prior.backtest) record.backtest = Object.assign({}, prior.backtest, record.backtest);
    let file = null;
    try { file = path.relative(__dirname, WeekHistory.writeWeekRecord(record)); }
    catch (err) { console.error('log-week disk write failed:', err.message); }
    let persisted = false;
    if (db) {
      try {
        await db.query(
          `INSERT INTO week_history (season, week, payload_json, generated_at) VALUES ($1, $2, $3, NOW())
           ON CONFLICT (season, week) DO UPDATE SET payload_json = EXCLUDED.payload_json, generated_at = NOW()`,
          [HISTORY_SEASON, week, JSON.stringify(record)]
        );
        persisted = true;
      } catch (err) {
        console.error('week_history upsert failed:', err.message);
      }
    }
    historyCache = { value: null, time: 0 };
    return {
      status: 200,
      body: {
        ok: true, logged: true, season: HISTORY_SEASON, week, file, persisted,
        fpaSamples: record.meta.fpaSamples, fpaRanked: record.meta.fpaRanked,
        usagePlayers: record.meta.usagePlayers, backtestLeagues: Object.keys(record.backtest).length,
        notes: record.meta.notes,
      },
    };
  })();
  try {
    const out = await logWeekInFlight;
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error('/api/log-week error:', err.message);
    res.status(/not complete/.test(err.message) ? 409 : 502).json({ error: err.message });
  } finally {
    logWeekInFlight = null;
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
    /^\/research\.html$/i.test(p) ||
    /^\/lineup\.html$/i.test(p) ||
    /^\/team\.html$/i.test(p) ||
    /^\/home\.html$/i.test(p)
  ) return res.status(404).end();
  next();
});

// /lineup — weekly lineup optimizer (server-injected Clerk publishable key)
app.get('/lineup', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'lineup.html'), 'utf8');
    html = html.replace('PUBLISHABLE_KEY_PLACEHOLDER', process.env.CLERK_PUBLISHABLE_KEY || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).send('Failed to load lineup page');
  }
});

// /team — league comparison table + your-team summary (server-injected Clerk publishable key)
app.get('/team', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'team.html'), 'utf8');
    html = html.replace('PUBLISHABLE_KEY_PLACEHOLDER', process.env.CLERK_PUBLISHABLE_KEY || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).send('Failed to load team page');
  }
});

// /research — standalone player research page (server-injected Clerk publishable key)
app.get('/research', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'research.html'), 'utf8');
    html = html.replace('PUBLISHABLE_KEY_PLACEHOLDER', process.env.CLERK_PUBLISHABLE_KEY || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).send('Failed to load research page');
  }
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
// Feature update announcements → Discord
const ANNOUNCE_SECRET = process.env.ANNOUNCE_SECRET;
const { announce: postAnnouncement } = require('./pocket-announce');

app.post('/api/announce', express.json({ limit: '10kb' }), async (req, res) => {
  if (ANNOUNCE_SECRET && req.headers['x-announce-secret'] !== ANNOUNCE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { title, description, features, version } = req.body || {};
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title required' });
  }
  try {
    await postAnnouncement({ title, description, features: features || [], version });
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/announce error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
