// Pocket NBA router — mounted once from server.js, before the static deny
// block and the '*' catch-all:
//   app.use('/', require('./nba/router')({ auth, getAuth, db, apiCached }));
//
// Serves /nfl (alias of the NFL home), /nba pages, Yahoo OAuth under
// /nba/auth/*, and the JSON API under /api/nba/*. See docs/nba-contracts.md.
const express = require('express');
const fs = require('fs');
const path = require('path');

const oauth = require('./yahoo/oauth');
const { signState, verifyState, createNonceRegistry } = require('./yahoo/crypto');
const { createTokenStore } = require('./yahoo/store');
const { createClient, YahooError } = require('./yahoo/client');

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

// Never-500 placeholder for pages stream C hasn't shipped yet.
function comingSoonHtml(title) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Pocket NBA</title>
<link rel="stylesheet" href="/shared/styles.css">
<script defer src="/shared/nav.js"></script>
</head><body>
<nav id="rr-nav">
  <a href="/nba" class="rr-logo">Pocket</a>
  <div class="rr-links">
    <a href="/nba/draft" class="rr-link">Draft</a>
    <a href="/nba/lineup" class="rr-link">Lineup</a>
  </div>
  <button class="nav-hamburger" type="button" aria-label="Open menu" aria-controls="rr-nav" aria-expanded="false">&#9776;</button>
</nav>
<main style="max-width:640px;margin:4rem auto;padding:0 1.25rem;text-align:center">
  <h1>Pocket NBA ${title}</h1>
  <p>Coming soon: Yahoo High Score draft and lineup tools.</p>
</main>
</body></html>`;
}

function createNbaRouter({
  auth, getAuth, db = null, apiCached,
  env = process.env,
  loadModel = defaultLoadModel,
  store = createTokenStore({ db, env }),
  makeClient = opts => createClient(opts),
  exchangeCode = (args) => oauth.exchangeCode(args, { env }),
  log = console,
} = {}) {
  if (typeof auth !== 'function' || typeof getAuth !== 'function') throw new Error('nba router: auth and getAuth required');
  if (typeof apiCached !== 'function') throw new Error('nba router: apiCached required');

  const router = express.Router();
  const nonces = createNonceRegistry();
  const playerMeta = new Map(); // yahoo player_key -> normalized player (league-independent)
  let lastModelAsOf = null;

  const userId = req => (getAuth(req) || {}).userId || null;

  function originFor(req) {
    if (env.NBA_PUBLIC_ORIGIN) return env.NBA_PUBLIC_ORIGIN.replace(/\/$/, '');
    const host = String(req.get('host') || '');
    // Only trust the Host header for local dev; anything else is prod.
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `${req.protocol}://${host}`;
    return PROD_ORIGIN;
  }
  const redirectUriFor = req => `${originFor(req)}/nba/auth/callback`;

  function clientFor(uid) {
    return makeClient({
      getTokens: () => store.get(uid),
      saveTokens: t => store.save(uid, t),
    });
  }

  async function modelPlayers(week) {
    const model = loadModel();
    const key = `nba:players:${week || 'default'}`;
    const data = await apiCached(key, 10 * 60 * 1000, () => model.getPlayers({ week: week || undefined }));
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

  function sendYahooError(res, err, uid) {
    if (err instanceof YahooError && err.code === 'not_connected') {
      return res.status(409).json({ error: 'Yahoo not connected', code: 'yahoo_not_connected' });
    }
    // Refresh token rejected (revoked / password change) → drop it, ask to reconnect.
    if (err && (err.code === 'invalid_grant' || err.code === 'invalid_client')) {
      store.remove(uid).catch(() => {});
      return res.status(409).json({ error: 'Yahoo authorization expired — reconnect', code: 'yahoo_reauth' });
    }
    const status = err && err.status === 429 ? 429 : err && err.status === 404 ? 404 : 502;
    log.error('[nba] yahoo error:', err && err.message);
    return res.status(status).json({ error: status === 429 ? 'Yahoo rate limit — retry shortly' : 'Yahoo request failed' });
  }

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
  router.get('/nba/auth/login', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!oauth.isConfigured(env)) return res.status(503).send('Yahoo is not configured');
    const uid = userId(req);
    if (!uid) return res.redirect(302, '/nba?yahoo=signin');
    const state = signState({ userId: uid, nonce: nonces.issue(uid) }, env);
    res.redirect(302, oauth.authorizeUrl({ redirectUri: redirectUriFor(req), state }, env));
  });

  router.get('/nba/auth/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const uid = userId(req);
    if (!uid) return res.redirect(302, '/nba?yahoo=signin');
    if (req.query.error) return res.redirect(302, '/nba?yahoo=denied');
    const v = verifyState(String(req.query.state || ''), { userId: uid }, env);
    if (!v.ok || !nonces.consume(v.nonce, uid)) {
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
      log.error('[nba] yahoo token exchange failed:', err.message);
      res.redirect(302, '/nba?yahoo=error');
    }
  });

  const logout = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const uid = userId(req);
    if (uid) { try { await store.remove(uid); } catch (err) { log.error('[nba] logout failed:', err.message); } }
    if (req.method === 'POST') return res.json({ ok: true });
    res.redirect(302, '/nba?yahoo=disconnected');
  };
  router.get('/nba/auth/logout', logout);
  router.post('/nba/auth/logout', logout);

  // ---- JSON API -------------------------------------------------------------
  router.get('/api/nba/health', (req, res) => {
    let modelAsOf = lastModelAsOf;
    try {
      const m = loadModel();
      if (!modelAsOf && m && !m.stub) modelAsOf = typeof m.asOf === 'function' ? m.asOf() : (m.asOf || null);
    } catch { /* model load error → null */ }
    res.json({ ok: true, yahooConfigured: oauth.isConfigured(env), modelAsOf: modelAsOf || null });
  });

  router.get('/api/nba/players', async (req, res) => {
    const week = req.query.week != null && req.query.week !== '' ? Number(req.query.week) : null;
    if (week !== null && !(Number.isInteger(week) && week >= 1 && week <= 30)) return res.status(400).json({ error: 'Invalid week' });
    try {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(await modelPlayers(week));
    } catch (err) {
      if (err.status !== 503) log.error('[nba] /api/nba/players:', err.message);
      res.status(503).json({ error: 'NBA player data unavailable' });
    }
  });

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
      if (err && (err.code === 'invalid_grant' || err.code === 'not_connected')) {
        if (err.code === 'invalid_grant') store.remove(uid).catch(() => {});
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
        let status = DRAFT_STATUS[d.draft_status] || 'predraft';
        if (status === 'predraft' && picks.length) status = 'drafting';
        return {
          status, picks,
          unmatched: picks.filter(p => !p.sleeperId).map(p => ({ pick: p.pick, player_key: p.player_key, name: p.name })),
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

  return router;
}

module.exports = createNbaRouter;
module.exports.MODEL_STUB = MODEL_STUB;
module.exports.defaultLoadModel = defaultLoadModel;
module.exports.comingSoonHtml = comingSoonHtml;
