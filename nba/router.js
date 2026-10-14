// Pocket NBA router — mounted once from server.js, before the static deny
// block and the '*' catch-all:
//   app.use('/', require('./nba/router')({ auth, getAuth, db, apiCached }));
//
// Serves /nfl (alias of the NFL home), /nba pages, Yahoo OAuth under
// /nba/auth/*, and the JSON API under /api/nba/*. See docs/nba-contracts.md.
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

const oauth = require('./yahoo/oauth');
const { signState, verifyState } = require('./yahoo/crypto');
const { createTokenStore } = require('./yahoo/store');
const { createNonceStore } = require('./yahoo/nonces');
const { createClient, YahooError } = require('./yahoo/client');
const { runDiagnose, formatReport } = require('./yahoo/diagnose');
const leagueProfile = require('./league-profile');

const PAGES_DIR = path.join(__dirname, 'pages');
const PROD_ORIGIN = 'https://pocketff.com';
const LEAGUE_KEY_RE = /^\d+\.l\.\d+$/;
const TEAM_KEY_RE = /^\d+\.l\.\d+\.t\.\d+$/;

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
<meta name="description" content="Pocket NBA: Yahoo High Score fantasy basketball tools.">
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
  rateLimits = { api: 120, auth: 30 },
  diagnoseCooldownMs = 20 * 1000,
} = {}) {
  if (typeof auth !== 'function' || typeof getAuth !== 'function') throw new Error('nba router: auth and getAuth required');
  if (typeof apiCached !== 'function') throw new Error('nba router: apiCached required');

  const router = express.Router();
  const playerMeta = boundedMap(5000); // yahoo player_key -> normalized player (league-independent)
  let lastModelAsOf = null;
  const limitApi = createRateLimiter({ max: rateLimits.api });
  const limitAuth = createRateLimiter({ max: rateLimits.auth });
  const lastDiagnose = new Map(); // clerk user id -> ms

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

  async function modelPlayers(week, profile) {
    const model = loadModel();
    const key = `nba:players:${week || 'default'}${profile ? ':p' + profile : ''}`;
    const data = await apiCached(key, 10 * 60 * 1000, async () => {
      const d = await model.getPlayers({ week: week || undefined, profile: profile || undefined });
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

  // Our app credentials were rejected. Never touches user tokens: a bad
  // YAHOO_CLIENT_SECRET on the server must not disconnect every user.
  let lastMisconfigLog = 0;
  function logMisconfigured(err) {
    if (Date.now() - lastMisconfigLog < 60 * 1000) return;
    lastMisconfigLog = Date.now();
    log.error(`[nba] Yahoo rejected the app credentials (${(err && err.code) || 'unknown'}); check YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET. User tokens kept.`);
  }
  const MISCONFIGURED = { error: 'Yahoo app misconfigured — try again later', code: 'yahoo_misconfigured' };

  function sendYahooError(res, err, uid) {
    switch (oauth.classifyError(err)) {
      case 'not_connected':
        return res.status(409).json({ error: 'Yahoo not connected', code: 'yahoo_not_connected' });
      case 'revoked':
        // This user's refresh token is dead (revoked / password change) → drop it, ask to reconnect.
        store.remove(uid).catch(() => {});
        return res.status(409).json({ error: 'Yahoo authorization expired — reconnect', code: 'yahoo_reauth' });
      case 'misconfigured':
        logMisconfigured(err);
        return res.status(503).json(MISCONFIGURED);
      default: {
        const status = err && err.status === 429 ? 429 : err && err.status === 404 ? 404 : 502;
        log.error('[nba] yahoo error:', err && err.message);
        return res.status(status).json({ error: status === 429 ? 'Yahoo rate limit — retry shortly' : 'Yahoo request failed' });
      }
    }
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
  router.use('/nba/auth', rateLimit(limitAuth));

  // ---- static deny: only nba/pages/* may be served from the nba/ tree ------
  router.use((req, res, next) => {
    const p = req.path;
    if (/^\/nba\/(yahoo|model)(\/|$)/i.test(p) || /^\/nba\/[^/]+\.[a-z0-9]+$/i.test(p) ||
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
      res.send(html.replace(/PUBLISHABLE_KEY_PLACEHOLDER/g, env.CLERK_PUBLISHABLE_KEY || ''));
    };
  }
  router.get(['/nba', '/nba/draft'], page('draft.html', 'Draft'));
  router.get('/nba/lineup', page('lineup.html', 'Lineup'));

  // ---- Yahoo OAuth -----------------------------------------------------------
  router.get('/nba/auth/login', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!oauth.isConfigured(env)) return res.status(503).send('Yahoo is not configured');
    const uid = userId(req);
    if (!uid) return res.redirect(302, '/nba?yahoo=signin');
    let nonce;
    try { nonce = await nonces.issue(uid); } catch (err) {
      log.error('[nba] nonce store:', err.message);
      return res.status(503).send('Yahoo login is temporarily unavailable. Try again in a minute.');
    }
    const state = signState({ userId: uid, nonce }, env);
    res.redirect(302, oauth.authorizeUrl({ redirectUri: redirectUriFor(req), state }, env));
  });

  router.get('/nba/auth/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // Without YAHOO_CLIENT_SECRET (and no NBA_TOKEN_KEY) verifyState throws inside
    // this async handler; Express 4 doesn't catch that and Node exits on the
    // unhandled rejection, taking the NFL site down with it.
    if (!oauth.isConfigured(env)) return res.status(503).send('Yahoo is not configured');
    const uid = userId(req);
    if (!uid) return res.redirect(302, '/nba?yahoo=signin');
    if (req.query.error) return res.redirect(302, '/nba?yahoo=denied');
    const v = verifyState(String(req.query.state || ''), { userId: uid }, env);
    let fresh = false;
    if (v.ok) {
      try { fresh = await nonces.consume(v.nonce, uid); } catch (err) {
        log.error('[nba] nonce store:', err.message);
        return res.status(503).send('Yahoo login is temporarily unavailable. Try again in a minute.');
      }
    }
    if (!v.ok || !fresh) {
      log.warn('[nba] oauth callback rejected state:', v.ok ? 'replayed' : v.reason);
      return res.status(400).send('Invalid or expired login link. Go back to /nba and connect Yahoo again.');
    }
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Missing authorization code');
    try {
      const tokens = await exchangeCode({ code, redirectUri: redirectUriFor(req) });
      await store.save(uid, tokens);
      res.redirect(302, '/nba?yahoo=connected');
    } catch (err) {
      // err.message is "Yahoo token endpoint <status> (<code>)" — never the body.
      log.error('[nba] yahoo token exchange failed:', err.message);
      if (oauth.classifyError(err) === 'misconfigured') { logMisconfigured(err); return res.redirect(302, '/nba?yahoo=misconfigured'); }
      res.redirect(302, '/nba?yahoo=error');
    }
  });

  // Disconnect: POST only, from our own pages (GET would be CSRF-able via an
  // <img src>). The UI calls it with fetch(); see nba/pages/yahoo-chip.js.
  router.post('/nba/auth/logout', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request refused' });
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Sign in required' });
    try { await store.remove(uid); } catch (err) {
      log.error('[nba] logout failed:', err.message);
      return res.status(503).json({ error: 'Could not disconnect right now' });
    }
    res.json({ ok: true });
  });
  router.all('/nba/auth/logout', (req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).type('text/plain').send('Disconnect Yahoo from the Yahoo menu on /nba.');
  });

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
    res.json({ ok: true, yahooConfigured: oauth.isConfigured(env), modelAsOf: modelAsOf || null });
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

  router.get('/api/nba/players', async (req, res) => {
    const week = req.query.week != null && req.query.week !== '' ? Number(req.query.week) : null;
    if (week !== null && !(Number.isInteger(week) && week >= 1 && week <= 30)) return res.status(400).json({ error: 'Invalid week' });
    const profile = req.query.profile == null || req.query.profile === '' ? leagueProfile.DEFAULT_LEAGUE_ID : String(req.query.profile).trim();
    if (!/^\d{1,12}$/.test(profile)) return res.status(400).json({ error: 'Invalid profile' });
    if (!leagueProfile.getProfile(profile)) return res.status(404).json({ error: 'Unknown league profile' });
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

  router.use(require('./routes/profile')());
  router.use('/api/nba/market', rateLimit(limitApi), require('./routes/market'));
  router.use(['/api/nba/me', '/api/nba/yahoo'], auth, (req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });

  router.get('/api/nba/yahoo/status', async (req, res) => {
    const uid = userId(req);
    let tokens;
    try { tokens = await store.get(uid); } catch (err) { log.error('[nba] token store:', err.message); return res.status(503).json({ error: 'Token store unavailable' }); }
    if (!tokens) return res.json({ connected: false });
    try {
      const leagues = await apiCached(`nba:y:${uid}:leagues`, 60 * 1000, () => clientFor(uid).getUserLeagues());
      res.json({
        connected: true,
        yahooGuid: tokens.xoauth_yahoo_guid || undefined,
        leagues: leagues.map(l => ({ league_key: l.league_key, name: l.name, num_teams: l.num_teams, draft_status: l.draft_status })),
      });
    } catch (err) {
      const kind = oauth.classifyError(err);
      if (kind === 'revoked' || kind === 'not_connected') {
        if (kind === 'revoked') store.remove(uid).catch(() => {});
        return res.json({ connected: false, reauth: true });
      }
      sendYahooError(res, err, uid);
    }
  });

  router.get('/api/nba/yahoo/league', async (req, res) => {
    const uid = userId(req);
    const lk = String(req.query.league_key || '');
    if (!LEAGUE_KEY_RE.test(lk)) return res.status(400).json({ error: 'Invalid league_key' });
    try {
      const out = await apiCached(`nba:y:${uid}:league:${lk}`, 60 * 1000, async () => {
        const c = clientFor(uid);
        const [league, teams] = await Promise.all([c.getLeague(lk), c.getTeams(lk)]);
        const mine = teams.find(t => t.is_owned_by_current_login);
        return { league, teams, myTeamKey: mine ? mine.team_key : null };
      });
      res.json(out);
    } catch (err) { sendYahooError(res, err, uid); }
  });

  const DRAFT_STATUS = { predraft: 'predraft', draft: 'drafting', drafting: 'drafting', postdraft: 'postdraft' };

  router.get('/api/nba/yahoo/draft', async (req, res) => {
    const uid = userId(req);
    const lk = String(req.query.league_key || '');
    if (!LEAGUE_KEY_RE.test(lk)) return res.status(400).json({ error: 'Invalid league_key' });
    try {
      const out = await apiCached(`nba:y:${uid}:draft:${lk}`, 3000, async () => {
        const c = clientFor(uid);
        const d = await c.getDraftResults(lk);
        const made = d.picks.filter(p => p.player_key);
        const missing = made.map(p => p.player_key).filter(k => !playerMeta.has(k));
        if (missing.length) for (const p of await c.getPlayersByKeys(lk, missing)) playerMeta.set(p.player_key, p);
        const match = await matcher();
        const picks = made.map(p => {
          const yp = playerMeta.get(p.player_key) || { player_key: p.player_key, name: { full: null } };
          const m = match(yp);
          return { pick: p.pick, round: p.round, team_key: p.team_key, player_key: p.player_key, sleeperId: m.sleeperId, name: yp.name.full, matchConfidence: m.matchConfidence };
        });
        // Picks with an unknown/missing status mean the draft is running. An
        // explicit "predraft" is kept: those picks are keepers, and the board
        // must not show "live" or start the pick clock hours early.
        let status = DRAFT_STATUS[d.draft_status] || 'predraft';
        if (status === 'predraft' && picks.length && d.draft_status !== 'predraft') status = 'drafting';
        made.forEach((p, i) => { if (p.cost != null) picks[i].cost = p.cost; });
        // Remaining slots in Yahoo's own order (team_key per pick), so the
        // board can show who is really on the clock with keepers / traded
        // picks instead of assuming a snake.
        const order = d.picks.filter(p => !p.player_key && p.pick != null)
          .map(p => ({ pick: p.pick, round: p.round, team_key: p.team_key }))
          .sort((a, b) => a.pick - b.pick);
        return {
          status, picks,
          unmatched: picks.filter(p => !p.sleeperId).map(p => ({ pick: p.pick, player_key: p.player_key, name: p.name })),
          order,
          onClock: status === 'drafting' && order[0] && order[0].team_key ? order[0] : null,
          auction: d.picks.some(p => p.cost != null),
          polledAt: new Date().toISOString(),
        };
      });
      res.json(out);
    } catch (err) { sendYahooError(res, err, uid); }
  });

  router.get('/api/nba/yahoo/roster', async (req, res) => {
    const uid = userId(req);
    const tk = String(req.query.team_key || '');
    if (!TEAM_KEY_RE.test(tk)) return res.status(400).json({ error: 'Invalid team_key' });
    const week = req.query.week != null && req.query.week !== '' ? Number(req.query.week) : null;
    if (week !== null && !(Number.isInteger(week) && week >= 1 && week <= 30)) return res.status(400).json({ error: 'Invalid week' });
    try {
      const out = await apiCached(`nba:y:${uid}:roster:${tk}:${week || ''}`, 30 * 1000, async () => {
        const r = await clientFor(uid).getRoster(tk, week);
        const match = await matcher();
        return {
          players: r.players.map(p => ({ player_key: p.player_key, sleeperId: match(p).sleeperId, name: p.name.full, selected_position: p.selected_position || null })),
        };
      });
      res.json(out);
    } catch (err) { sendYahooError(res, err, uid); }
  });

  // Runs the whole read path against the signed-in user's Yahoo account and
  // returns a sanitized report (no tokens / GUIDs). ?format=text for humans.
  router.get('/api/nba/yahoo/diagnose', async (req, res) => {
    const uid = userId(req);
    let tokens;
    try { tokens = await store.get(uid); } catch (err) { log.error('[nba] token store:', err.message); return res.status(503).json({ error: 'Token store unavailable' }); }
    if (!tokens) return res.status(409).json({ error: 'Yahoo not connected', code: 'yahoo_not_connected' });
    const last = lastDiagnose.get(uid) || 0;
    if (Date.now() - last < diagnoseCooldownMs) {
      res.setHeader('Retry-After', String(Math.ceil((diagnoseCooldownMs - (Date.now() - last)) / 1000)));
      return res.status(429).json({ error: 'Diagnose runs at most every ' + Math.round(diagnoseCooldownMs / 1000) + 's' });
    }
    lastDiagnose.set(uid, Date.now());
    const warnings = [];
    // Express 4 doesn't catch a rejected async handler, and server.js has no
    // unhandledRejection handler: an unexpected throw here would exit Node.
    let report;
    try { report = await runDiagnose({ client: clientFor(uid, { onWarning: w => warnings.push(w) }), warnings }); } catch (err) {
      log.error('[nba] diagnose failed:', err && err.message);
      return res.status(500).json({ error: 'Diagnose failed' });
    }
    // Same token handling as every other endpoint: a dead refresh token is
    // dropped; an app-credential failure only logs.
    const kinds = report.steps.filter(s => !s.ok).map(s => oauth.classifyError(s.error));
    if (kinds.includes('revoked')) { store.remove(uid).catch(() => {}); report.reauth = true; }
    if (kinds.includes('misconfigured')) { logMisconfigured({ code: (report.steps.find(s => !s.ok && oauth.classifyError(s.error) === 'misconfigured') || {}).error.code }); report.appMisconfigured = true; }
    if (req.query.format === 'text') {
      let text;
      try { text = formatReport(report); } catch (err) { log.error('[nba] diagnose format failed:', err && err.message); return res.status(500).json({ error: 'Diagnose failed' }); }
      return res.type('text/plain; charset=utf-8').send(text + '\n');
    }
    res.type('application/json').send(JSON.stringify(report, null, 2));
  });

  router.use(require('./routes/lineup')({ auth, getAuth, apiCached, loadModel, modelPlayers, clientFor, sendYahooError, log }));
  router.use(require('./routes/trade')({ auth, getAuth, apiCached, modelPlayers, matcher, clientFor, sendYahooError, env, log }));
  router.use(require('./routes/waivers')({ auth, getAuth, apiCached, loadModel, clientFor, sendYahooError, modelPlayers, log, env }));
  router.use(require('./routes/research')({ modelPlayers, log }));
  return router;
}

module.exports = createNbaRouter;
module.exports.createRateLimiter = createRateLimiter;
module.exports.MODEL_STUB = MODEL_STUB;
module.exports.defaultLoadModel = defaultLoadModel;
module.exports.comingSoonHtml = comingSoonHtml;
