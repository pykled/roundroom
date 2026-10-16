// Pocket NBA router — mounted once from server.js, before the static deny
// block and the '*' catch-all:
//   app.use('/', require('./nba/router')({ auth, getAuth, db, apiCached }));
//
// Serves /nfl (alias of the NFL home), /nba pages, the Sleeper league sync
// under /api/nba/sleeper/* (nba/routes/sleeper.js) and the JSON API under
// /api/nba/*. See docs/nba-sleeper.md and docs/nba-contracts.md.
//
// Yahoo (OAuth under /nba/auth/*, /api/nba/yahoo/*) is OFF unless
// NBA_YAHOO_ENABLED=1: Yahoo blocked the app's Fantasy API access and the NBA
// side is Sleeper-first now. The code stays (nba/yahoo/*) so it can be turned
// back on; stored tokens and Railway vars are untouched. docs/nba-sleeper.md
// "Re-enabling Yahoo" has the steps.
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

const oauth = require('./yahoo/oauth');
const { createTokenStore } = require('./yahoo/store');
const { createNonceStore } = require('./yahoo/nonces');
const { createClient } = require('./yahoo/client');
const createYahooRoutes = require('./yahoo/routes');
const leagueProfile = require('./league-profile');
const LC = require('./routes/league-context');
const { errorResponse: sleeperError } = require('./sleeper/client');
const { versionAssets } = require('./asset-version');

const PAGES_DIR = path.join(__dirname, 'pages');
const PROD_ORIGIN = 'https://pocketff.com';
// Stream B's model; until nba/model exists this stub keeps the API answering.
const MODEL_STUB = {
  stub: true,
  async getPlayers() { const e = new Error('NBA model not available yet'); e.status = 503; throw e; },
  matchYahooPlayer() { return null; },
};

function defaultLoadModel() {
  try {
    return require('./model');
  } catch (e) {
    // Only the model module itself missing → stub; a missing dependency
    // *inside* B's model is a real bug and should surface.
    if (e.code === 'MODULE_NOT_FOUND' && /'\.\/model'/.test(e.message)) return MODEL_STUB;
    throw e;
  }
}

// Fixed-window per-key counter (per IP for public endpoints). Memory only: it
// is a politeness limit, not a security boundary, so per-instance is fine.
function createRateLimiter({ windowMs = 60 * 1000, max = 120, maxKeys = 10000 } = {}) {
  const hits = new Map(); // key -> { n, reset }
  return function hit(key, now = Date.now()) {
    let e = hits.get(key);
    if (!e || e.reset <= now) {
      if (hits.size >= maxKeys) for (const [k, v] of hits) { if (v.reset <= now || hits.size >= maxKeys) hits.delete(k); if (hits.size < maxKeys / 2) break; }
      e = { n: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    e.n++;
    return { ok: e.n <= max, retryAfterS: Math.max(1, Math.ceil((e.reset - now) / 1000)) };
  };
}

// Bounded Map with least-recently-set eviction (player meta cache).
function boundedMap(max) {
  const m = new Map();
  return {
    has: k => m.has(k),
    get: k => m.get(k),
    set(k, v) { m.delete(k); m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); },
    get size() { return m.size; },
  };
}

// Never-500 placeholder for pages stream C hasn't shipped yet.
function comingSoonHtml(title) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NBA ${title} | Pocket fantasy basketball</title>
<meta name="description" content="Pocket NBA: High Score fantasy basketball tools with live Sleeper draft sync.">
<meta name="theme-color" content="#1a110b">
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/shared/styles.css">
<script defer src="/shared/nav.js"></script>
</head><body class="sport-nba">
<nav id="rr-nav">
  <a href="/nba" class="rr-logo">Pocket</a>
  <div class="rr-links">
    <a href="/nba" class="rr-link">Draft board</a>
    <a href="/nba/lineup" class="rr-link">Lineup</a>
    <a href="/nba/trade" class="rr-link">Trade</a>
    <a href="/nba/waivers" class="rr-link">Waivers</a>
  </div>
  <button class="nav-hamburger" type="button" aria-label="Open menu" aria-controls="rr-nav" aria-expanded="false">&#9776;</button>
</nav>
<main class="nba-court" style="max-width:640px;width:calc(100% - 2rem);margin:3rem auto;box-sizing:border-box;padding:2.5rem 1.25rem;text-align:center;border:1px solid var(--nba-border);border-radius:var(--radius-lg);background:var(--nba-surface)">
  <p style="font-size:2rem;margin-bottom:.75rem"><span class="nba-ball" aria-hidden="true"></span></p>
  <h1 style="font-size:1.5rem;font-weight:800;letter-spacing:-.02em">NBA ${title}</h1>
  <p style="color:var(--text-secondary);margin:.5rem 0 1.25rem">This page is still warming up. The draft board is ready for tip-off.</p>
  <a class="btn-primary" href="/nba" style="display:inline-flex;align-items:center;min-height:44px;text-decoration:none">Open the NBA Draft Board</a>
</main>
</body></html>`;
}

function createNbaRouter({
  auth, getAuth, db = null, apiCached,
  env = process.env,
  loadModel = defaultLoadModel,
  log = console,
  store = createTokenStore({ db, env, log }),
  nonces = createNonceStore({ db }),
  makeClient = opts => createClient(opts),
  exchangeCode = (args) => oauth.exchangeCode(args, { env }),
  // Per-IP limits for the unauthenticated endpoints (requests per minute).
  rateLimits = { api: 120, auth: 30, sleeper: 240 },
  diagnoseCooldownMs = 20 * 1000,
  sleeperClient = undefined,
  yahooEnabled = String(env.NBA_YAHOO_ENABLED || '') === '1',
} = {}) {
  if (typeof auth !== 'function' || typeof getAuth !== 'function') throw new Error('nba router: auth and getAuth required');
  if (typeof apiCached !== 'function') throw new Error('nba router: apiCached required');

  const router = express.Router();
  const playerMeta = boundedMap(5000); // yahoo player_key -> normalized player (league-independent)
  let lastModelAsOf = null;
  const limitApi = createRateLimiter({ max: rateLimits.api });
  const limitAuth = createRateLimiter({ max: rateLimits.auth });
  const limitSleeper = createRateLimiter({ max: rateLimits.sleeper || 240 });

  const userId = req => (getAuth(req) || {}).userId || null;

  function originFor(req) {
    if (env.NBA_PUBLIC_ORIGIN) return env.NBA_PUBLIC_ORIGIN.replace(/\/$/, '');
    const host = String(req.get('host') || '');
    // Only trust the Host header for local dev; anything else is prod.
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `${req.protocol}://${host}`;
    return PROD_ORIGIN;
  }
  const redirectUriFor = req => `${originFor(req)}/nba/auth/callback`;

  function clientFor(uid, extra) {
    return makeClient({
      getTokens: () => store.get(uid),
      saveTokens: t => store.save(uid, t),
      ...extra,
    });
  }

  // CSRF guard for state-changing requests: the browser must say the request
  // came from our own pages. Sec-Fetch-Site wins when present (all current
  // browsers send it); otherwise Origin must match this host or the public
  // origin. No header at all → reject (a real browser POST always has one).
  function sameOrigin(req) {
    const sfs = req.get('sec-fetch-site');
    if (sfs) return sfs === 'same-origin';
    const origin = req.get('origin');
    if (!origin || origin === 'null') return false;
    let u;
    try { u = new URL(origin); } catch { return false; }
    return u.host === String(req.get('host') || '') || u.origin === originFor(req);
  }

  // profile: a stored profile id ('242808'), a Sleeper league id whose profile
  // routes/sleeper.js has built (LC registry), or a profile object.
  async function modelPlayers(week, profile) {
    const model = loadModel();
    let prof = profile;
    if (typeof prof === 'string' && prof && !leagueProfile.getProfile(prof)) prof = LC.sleeperProfile(prof, { maxAgeMs: Infinity }) || prof;
    const pkey = prof && typeof prof === 'object'
      ? `${prof.leagueId}:${crypto.createHash('sha1').update(JSON.stringify(prof)).digest('base64url').slice(0, 16)}`
      : prof;
    const key = `nba:players:${week || 'default'}${pkey ? ':p' + pkey : ''}`;
    const data = await apiCached(key, 10 * 60 * 1000, async () => {
      const d = await model.getPlayers({ week: week || undefined, profile: prof || undefined });
      // Profile responses also carry the market layer + Yahoo-only rows (nba/model/enrich.js).
      return profile && !model.stub && d && d.profile ? require('./model/enrich').enrichPlayers(d) : d;
    });
    if (data && data.asOf) lastModelAsOf = data.asOf;
    return data;
  }

  // Match Yahoo players to Sleeper ids via B's matcher; tolerant of the model
  // being absent or failing (sleeperId null, confidence 0).
  async function matcher() {
    const model = loadModel();
    let players = null;
    try { players = (await modelPlayers()).players; } catch { players = null; }
    return yp => {
      if (!players || typeof model.matchYahooPlayer !== 'function') return { sleeperId: null, matchConfidence: 0 };
      try {
        const m = model.matchYahooPlayer(yp, players);
        return m && m.player ? { sleeperId: String(m.player.id), matchConfidence: m.confidence ?? null } : { sleeperId: null, matchConfidence: 0 };
      } catch { return { sleeperId: null, matchConfidence: 0 }; }
    };
  }

  // ---- request limits: body/URL size on NBA endpoints, per-IP rate limits ----
  router.use(['/api/nba', '/nba/auth'], (req, res, next) => {
    if (req.originalUrl.length > 2048) return res.status(414).json({ error: 'URL too long' });
    const len = Number(req.get('content-length') || 0);
    if (len > 8 * 1024) return res.status(413).json({ error: 'Request too large' });
    next();
  });
  function rateLimit(limiter) {
    return (req, res, next) => {
      const r = limiter(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
      if (r.ok) return next();
      res.setHeader('Retry-After', String(r.retryAfterS));
      res.status(429).json({ error: 'Too many requests — slow down' });
    };
  }
  router.use(['/api/nba/players', '/api/nba/health'], rateLimit(limitApi));
  router.use('/api/nba/sleeper', rateLimit(limitSleeper));
  router.use('/nba/auth', rateLimit(limitAuth));

  // ---- Yahoo off (default): every Yahoo path answers a clear "disabled" ----
  // 410 JSON for the API (pages treat any non-connected status as manual mode);
  // the old OAuth links land on the board with a notice instead of a 404.
  if (!yahooEnabled) {
    router.get(['/nba/auth/login', '/nba/auth/callback'], (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.redirect(302, '/nba?connect=sleeper'); });
    const GONE = { error: 'This sync is no longer offered on Pocket NBA; connect with your Sleeper username instead.', code: 'yahoo_disabled' };
    router.all('/nba/auth/logout', (req, res) => res.status(410).json(GONE));
    router.all(['/api/nba/yahoo', '/api/nba/yahoo/*'], (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      if (req.path === '/api/nba/yahoo/status') return res.json({ connected: false, disabled: true, code: 'yahoo_disabled' });
      res.status(410).json(GONE);
    });
  }

  // ---- static deny: only nba/pages/* may be served from the nba/ tree ------
  router.use((req, res, next) => {
    const p = req.path;
    if (/^\/nba\/(yahoo|model|sleeper|routes)(\/|$)/i.test(p) || /^\/nba\/[^/]+\.[a-z0-9]+$/i.test(p) ||
        (/^\/nba\/.+\.[a-z0-9]+$/i.test(p) && !/^\/nba\/pages\/[^/]+$/i.test(p))) {
      return res.status(404).end();
    }
    next();
  });

  // ---- /nfl: identical to '/', incl. "any query param -> index.html" -------
  // Rewrite in place and fall through to server.js's '/' handler (no redirect).
  router.get('/nfl', (req, res, next) => {
    const qi = req.url.indexOf('?');
    req.url = '/' + (qi >= 0 ? req.url.slice(qi) : '');
    next();
  });

  // ---- pages ---------------------------------------------------------------
  function page(file, title) {
    return (req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      let html;
      try { html = fs.readFileSync(path.join(PAGES_DIR, file), 'utf8'); } catch { return res.send(comingSoonHtml(title)); }
      res.setHeader('Cache-Control', 'no-cache');
      res.send(versionAssets(html.replace(/PUBLISHABLE_KEY_PLACEHOLDER/g, env.CLERK_PUBLISHABLE_KEY || '')));
    };
  }
  router.get(['/nba', '/nba/draft'], page('draft.html', 'Draft'));
  router.get('/nba/lineup', page('lineup.html', 'Lineup'));
  router.get('/nba/research', page('research.html', 'Research'));

  // ---- JSON API -------------------------------------------------------------
  router.get('/api/nba/health', (req, res) => {
    let modelAsOf = lastModelAsOf;
    try {
      const m = loadModel();
      if (!modelAsOf && m && !m.stub) {
        // B exports status() → { asOf, … }; older shapes exposed asOf directly.
        if (typeof m.status === 'function') modelAsOf = (m.status() || {}).asOf || null;
        if (!modelAsOf) modelAsOf = typeof m.asOf === 'function' ? m.asOf() : (m.asOf || null);
      }
    } catch { /* model load error → null */ }
    res.json({ ok: true, sleeper: true, yahooEnabled, yahooConfigured: yahooEnabled && oauth.isConfigured(env), modelAsOf: modelAsOf || null });
  });

  // JSON + ETag memoized per data object (apiCached hands back the same object
  // for 10 min), so a 650-player payload is stringified and hashed once.
  const encoded = new WeakMap();
  function encodePlayers(data) {
    let e = encoded.get(data);
    if (!e) {
      const body = JSON.stringify(data);
      e = { body, etag: `W/"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 27)}"` };
      if (data && typeof data === 'object') encoded.set(data, e);
    }
    return e;
  }

  // Sleeper league sync (mounted below, after the players route); its profileFor
  // builds Sleeper league profiles for /api/nba/players?league_id= too.
  const sleeper = require('./routes/sleeper')({ apiCached, modelPlayers, log, client: sleeperClient });

  // ?league_id=<Sleeper league id> builds the board under that league's own
  // Sleeper profile (slots, Mon-Sun weeks, playoffs, scoring; cached 10 min);
  // otherwise ?profile= names a stored profile (default 242808).
  router.get('/api/nba/players', async (req, res) => {
    const week = req.query.week != null && req.query.week !== '' ? Number(req.query.week) : null;
    if (week !== null && !(Number.isInteger(week) && week >= 1 && week <= 30)) return res.status(400).json({ error: 'Invalid week' });
    let profile;
    if (req.query.league_id != null && req.query.league_id !== '') {
      const lid = String(req.query.league_id).trim();
      if (!/^\d{1,24}$/.test(lid)) return res.status(400).json({ error: 'Invalid league_id' });
      try { profile = await sleeper.profileFor(lid); } catch (err) {
        const { status, body } = sleeperError(err);
        if (status === 429 && body.retryAfterS) res.setHeader('Retry-After', String(body.retryAfterS));
        return res.status(status).json(body);
      }
      if (profile.aggregation !== 'high-score') return res.status(400).json({ error: 'This is a category league; Pocket NBA values points leagues only.', code: 'league_not_points' });
    } else {
      profile = req.query.profile == null || req.query.profile === '' ? leagueProfile.DEFAULT_LEAGUE_ID : String(req.query.profile).trim();
      if (!/^\d{1,12}$/.test(profile)) return res.status(400).json({ error: 'Invalid profile' });
      if (!leagueProfile.getProfile(profile)) return res.status(404).json({ error: 'Unknown league profile' });
    }
    try {
      const data = await modelPlayers(week, profile);
      const { body, etag } = encodePlayers(data);
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
      res.setHeader('ETag', etag);
      res.setHeader('Vary', 'Accept-Encoding');
      const inm = String(req.get('if-none-match') || '');
      if (inm && inm.split(/\s*,\s*/).some(t => t === etag || t === '*' || t.replace(/^W\//, '') === etag.replace(/^W\//, ''))) return res.status(304).end();
      res.type('application/json').send(body);
    } catch (err) {
      if (err.status !== 503) log.error('[nba] /api/nba/players:', err.message);
      res.status(503).json({ error: 'NBA player data unavailable' });
    }
  });

  router.use(sleeper);
  router.use(require('./routes/profile')());
  router.use('/api/nba/market', rateLimit(limitApi), require('./routes/market'));
  // Yahoo (legacy): OAuth + /api/nba/yahoo/* live in nba/yahoo/routes.js and
  // mount only when enabled; sendYahooError keeps the legacy tool routes honest.
  const yahoo = createYahooRoutes({
    auth, env, log, store, nonces, apiCached, clientFor, matcher, playerMeta, userId, originFor, redirectUriFor, sameOrigin,
    exchangeCode, diagnoseCooldownMs, enabled: yahooEnabled,
  });
  const sendYahooError = yahoo.sendYahooError;
  if (yahooEnabled) router.use(yahoo.router);

  router.use(require('./routes/lineup')({ auth, getAuth, apiCached, loadModel, modelPlayers, clientFor, sendYahooError, log, sleeper, yahooEnabled }));
  router.use(require('./routes/trade')({ auth, getAuth, apiCached, modelPlayers, matcher, clientFor, sendYahooError, env, log, sleeper, yahooEnabled }));
  router.use(require('./routes/waivers')({ auth, getAuth, apiCached, loadModel, clientFor, sendYahooError, modelPlayers, log, env, sleeper, yahooEnabled }));
  router.use(require('./routes/research')({ modelPlayers, log }));
  router.use(require('./routes/team')({ apiCached, loadModel, log, sleeper, env }));
  return router;
}

module.exports = createNbaRouter;
module.exports.createRateLimiter = createRateLimiter;
module.exports.MODEL_STUB = MODEL_STUB;
module.exports.defaultLoadModel = defaultLoadModel;
module.exports.comingSoonHtml = comingSoonHtml;
