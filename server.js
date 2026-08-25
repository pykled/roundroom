const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 7890;

// Cache for Sleeper player data (large payload, changes rarely)
let playerCache = null;
let playerCacheTime = 0;
const PLAYER_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

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

// SSE must be excluded — compression buffers the stream and breaks real-time delivery
app.use(compression({
  filter: (req, res) =>
    req.path === '/api/draft-stream' ? false : compression.filter(req, res),
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
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

// Periodically drop expired rate-limit entries so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of chatRateLimits) {
    if (now - entry.windowStart >= CHAT_RATE_WINDOW) chatRateLimits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

app.post('/api/chat', express.json({ limit: '100kb' }), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI assistant is not configured' });
  }
  if (chatRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many requests — slow down a bit' });
  }

  const { messages, system } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: typeof system === 'string' ? system : undefined,
      messages: messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content || ''),
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

// Serve the app
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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
