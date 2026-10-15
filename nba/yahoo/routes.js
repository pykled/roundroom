// Legacy Yahoo routes for Pocket NBA: OAuth (/nba/auth/*) and the JSON API
// under /api/nba/yahoo/* (status, league, draft, roster, diagnose). Extracted
// from nba/router.js on 2026-10-15 when the NBA side went Sleeper-first; the
// router mounts this only when NBA_YAHOO_ENABLED=1 (docs/nba-sleeper.md
// "Re-enabling Yahoo"). sendYahooError is always built so the legacy tool
// routes (lineup/trade/waivers Yahoo paths) keep their error mapping.
'use strict';
const express = require('express');
const oauth = require('./oauth');
const { signState, verifyState } = require('./crypto');
const { runDiagnose, formatReport } = require('./diagnose');

const LEAGUE_KEY_RE = /^\d+\.l\.\d+$/;
const TEAM_KEY_RE = /^\d+\.l\.\d+\.t\.\d+$/;

function createYahooRoutes({
  auth, env, log, store, nonces, apiCached, clientFor, matcher, playerMeta, userId, originFor, redirectUriFor, sameOrigin,
  exchangeCode, diagnoseCooldownMs = 20 * 1000, enabled = false,
} = {}) {
  const router = express.Router();
  const lastDiagnose = new Map(); // clerk user id -> ms

  // Our app credentials were rejected. Never touches user tokens: a bad
  // YAHOO_CLIENT_SECRET on the server must not disconnect every user.
  let lastMisconfigLog = 0;
  function logMisconfigured(err) {
    if (Date.now() - lastMisconfigLog < 60 * 1000) return;
    lastMisconfigLog = Date.now();
    log.error(`[nba] Yahoo rejected the app credentials (${(err && err.code) || 'unknown'}); check YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET. User tokens kept.`);
  }
  const MISCONFIGURED = { error: 'Yahoo app misconfigured — try again later', code: 'yahoo_misconfigured' };

  // Yahoo refuses our app on every Fantasy endpoint (see oauth.classifyError).
  // Not the user's fault and not fixed by reconnecting: tokens kept, one log a minute.
  let lastBlockedLog = 0;
  const APP_BLOCKED = { error: 'Yahoo hasn’t approved Pocket’s Fantasy API access yet — manual mode works meanwhile', code: 'yahoo_app_blocked' };

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
      case 'app_blocked':
        if (Date.now() - lastBlockedLog > 60 * 1000) {
          lastBlockedLog = Date.now();
          log.error('[nba] Yahoo Fantasy API refused the app (403 not authorized); needs approval at sports.yahoo.com/developer/access. User tokens kept.');
        }
        return res.status(503).json(APP_BLOCKED);
      default: {
        const s = err && err.status;
        log.error('[nba] yahoo error:', err && err.message);
        if (s === 429) return res.status(429).json({ error: 'Yahoo rate limit — retry shortly', code: 'yahoo_rate_limited' });
        if (s === 404) return res.status(404).json({ error: 'Not found on Yahoo', code: 'yahoo_not_found' });
        if (s === 401 || s === 403) return res.status(409).json({ error: 'Yahoo refused this request — reconnect Yahoo', code: 'yahoo_reauth' });
        return res.status(502).json({ error: 'Yahoo is having trouble — try again in a minute', code: 'yahoo_upstream' });
      }
    }
  }


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


  // Signed-out callers (every page polls this on load) get a plain "not connected"
  // instead of a 401 that shows up as a console error.
  router.get('/api/nba/yahoo/status', (req, res, next) => {
    if (userId(req)) return next();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ connected: false, signedIn: false });
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
        // Current-season NBA leagues only (getUserLeagues resolves this season's game key).
        // scoring_type lets the page flag category/roto leagues before loading settings.
        leagues: leagues.map(l => ({ league_key: l.league_key, name: l.name, num_teams: l.num_teams, draft_status: l.draft_status, scoring_type: l.scoring_type || null })),
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
    if (kinds.includes('app_blocked')) report.appBlocked = true; // Yahoo refuses the app itself; see oauth.classifyError
    if (kinds.includes('misconfigured')) { logMisconfigured({ code: (report.steps.find(s => !s.ok && oauth.classifyError(s.error) === 'misconfigured') || {}).error.code }); report.appMisconfigured = true; }
    if (req.query.format === 'text') {
      let text;
      try { text = formatReport(report); } catch (err) { log.error('[nba] diagnose format failed:', err && err.message); return res.status(500).json({ error: 'Diagnose failed' }); }
      return res.type('text/plain; charset=utf-8').send(text + '\n');
    }
    res.type('application/json').send(JSON.stringify(report, null, 2));
  });


  return { router, sendYahooError, enabled };
}

module.exports = createYahooRoutes;
