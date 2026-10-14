// Pocket NBA trade calculator routes (stream E). Mounted with one line in
// nba/router.js; deps are the router's own closures so Yahoo/model handling
// stays identical to the rest of /api/nba/*.
//
//   GET  /nba/trade                                    page
//   POST /api/nba/trade/evaluate                       manual mode, public, rate + size limited
//        body { give[], get[], myRoster[], partnerRoster?[], leagueRostered?[], settings?, league_key?, league_id? }
//        ids are Sleeper ids or Yahoo player_keys (keys need a signed-in, Yahoo-connected user + league_key)
//   GET  /api/nba/trade/context?league_key=&team_key=  Yahoo-first rosters (auth)
// League profile (L1): league_key / league_id (default 242808) picks the profile;
// the board is valued under its scoring and the evaluator uses its slots, roster
// size, IL, playoff weeks and trade rules. Yahoo roster_positions override slots.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { evaluateTrade } = require('../model/trade');
const LC = require('./league-context');

const LEAGUE_KEY_RE = /^\d+\.l\.\d+$/;
const TEAM_KEY_RE = /^\d+\.l\.\d+\.t\.\d+$/;
const PLAYER_KEY_RE = /^\d+\.p\.\d+$/;
const SLEEPER_ID_RE = /^[A-Za-z0-9_]{1,16}$/;
const MAX_BODY = 16 * 1024;
const LIMITS = { give: 6, get: 6, myRoster: 25, partnerRoster: 25, leagueRostered: 400 };

// Fixed-window per-IP limiter (in memory; single instance like the rest of /api/nba).
function createRateLimit({ windowMs = 60 * 1000, max = 40, now = () => Date.now() } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'anon';
    let h = hits.get(key);
    if (!h || t - h.start >= windowMs) { h = { start: t, n: 0 }; hits.set(key, h); }
    if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    if (++h.n > max) {
      res.setHeader('Retry-After', String(Math.ceil((h.start + windowMs - t) / 1000)));
      return res.status(429).json({ error: 'Too many trade evaluations, slow down' });
    }
    next();
  };
}

// Yahoo roster_positions → { slots: {PG,SG,G,SF,PF,F,C,FC,UTIL,BN,IL}, rosterSize (active spots) }.
// Yahoo names its slots like the profile does (PG…C, Util, BN, IL, IL+). A
// High Score league's frontcourt slot shows as F with no SF/PF/C slots: FC.
function rosterShape(positions) {
  const slots = { PG: 0, SG: 0, G: 0, SF: 0, PF: 0, F: 0, C: 0, FC: 0, UTIL: 0, BN: 0, IL: 0 };
  let seen = false;
  for (const rp of positions || []) {
    const pos = String(rp.position || '').toUpperCase();
    const n = Number(rp.count) || 0;
    seen = true;
    if (/^IL|^IR/.test(pos)) slots.IL += n;
    else if (pos === 'BN') slots.BN += n;
    else if (pos === 'UTIL' || pos === 'UT') slots.UTIL += n;
    else if (pos in slots) slots[pos] += n;
    else slots.UTIL += n;
  }
  if (!seen) return null;
  if (slots.F && !slots.SF && !slots.PF && !slots.C) { slots.FC = slots.F; slots.F = 0; }
  const starters = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'FC', 'UTIL'].reduce((a, k) => a + slots[k], 0);
  return { slots, rosterSize: starters + slots.BN };
}

function createTradeRoutes({
  auth, getAuth, apiCached, modelPlayers, matcher, clientFor, sendYahooError,
  env = process.env, log = console, rateLimit = createRateLimit(),
} = {}) {
  const router = express.Router();
  const userId = req => ((getAuth && getAuth(req)) || {}).userId || null;

  router.get('/nba/trade', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let html;
    try { html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'trade.html'), 'utf8'); } catch { return res.status(404).send('Not found'); }
    res.send(html.replace(/PUBLISHABLE_KEY_PLACEHOLDER/g, env.CLERK_PUBLISHABLE_KEY || ''));
  });

  // League + every team's roster, matched to Sleeper ids. Cached 60 s per user.
  async function loadContext(uid, lk) {
    return apiCached(`nba:y:${uid}:trade:${lk}`, 60 * 1000, async () => {
      const c = clientFor(uid);
      const [league, teams] = await Promise.all([c.getLeague(lk), c.getTeams(lk)]);
      const match = await matcher();
      const outTeams = [];
      const unmatched = [];
      for (const t of teams) {
        const r = await c.getRoster(t.team_key);
        const players = r.players.map(p => {
          const sleeperId = match(p).sleeperId;
          const row = { player_key: p.player_key, sleeperId, name: p.name.full, selected_position: p.selected_position || null, status: p.status || null };
          if (!sleeperId) unmatched.push({ team_key: t.team_key, player_key: p.player_key, name: p.name.full });
          return row;
        });
        outTeams.push({ team_key: t.team_key, name: t.name, mine: !!t.is_owned_by_current_login, players });
      }
      const shape = rosterShape(league.roster_positions);
      const s = league.settings || {};
      return {
        league: {
          league_key: league.league_key || lk, name: league.name || null, num_teams: league.num_teams || teams.length,
          current_week: league.current_week ?? null, start_week: league.start_week ?? null, end_week: league.end_week ?? null,
          playoff_start_week: s.uses_playoff === false ? null : (s.playoff_start_week ?? null),
          scoring_type: league.scoring_type || null,
          settings: { teams: league.num_teams || teams.length, ...(shape || {}) },
        },
        myTeamKey: (outTeams.find(t => t.mine) || {}).team_key || null,
        teams: outTeams,
        unmatched,
      };
    });
  }

  router.get('/api/nba/trade/context', auth, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const uid = userId(req);
    const lk = String(req.query.league_key || '');
    const tk = req.query.team_key != null && req.query.team_key !== '' ? String(req.query.team_key) : null;
    if (!LEAGUE_KEY_RE.test(lk)) return res.status(400).json({ error: 'Invalid league_key' });
    if (tk && (!TEAM_KEY_RE.test(tk) || !tk.startsWith(lk + '.t.'))) return res.status(400).json({ error: 'Invalid team_key' });
    try {
      const ctx = await loadContext(uid, lk);
      const myTeamKey = tk || ctx.myTeamKey;
      if (tk && !ctx.teams.some(t => t.team_key === tk)) return res.status(404).json({ error: 'Team not in league' });
      res.json({ ...ctx, myTeamKey });
    } catch (err) { sendYahooError(res, err, uid); }
  });

  function badBody(res, msg) { return res.status(400).json({ error: msg }); }

  router.post('/api/nba/trade/evaluate', rateLimit, (req, res, next) => {
    const len = Number(req.get('content-length'));
    if (Number.isFinite(len) && len > MAX_BODY) return res.status(413).json({ error: 'Request too large' });
    next();
  }, express.json({ limit: MAX_BODY }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!b) return badBody(res, 'JSON body required');
    const lists = {};
    for (const [k, max] of Object.entries(LIMITS)) {
      const v = b[k];
      if (v == null) { lists[k] = k === 'partnerRoster' || k === 'leagueRostered' ? null : []; continue; }
      if (!Array.isArray(v)) return badBody(res, `${k} must be an array`);
      if (v.length > max) return badBody(res, `${k}: at most ${max} players`);
      const ids = v.map(x => String(x));
      if (ids.some(id => !SLEEPER_ID_RE.test(id) && !PLAYER_KEY_RE.test(id))) return badBody(res, `${k}: invalid player id`);
      lists[k] = ids;
    }
    if (!lists.give.length && !lists.get.length) return badBody(res, 'Add players to give or get');
    const lk = b.league_key != null && b.league_key !== '' ? String(b.league_key) : null;
    if (lk && !LEAGUE_KEY_RE.test(lk)) return badBody(res, 'Invalid league_key');
    const settings = b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings) ? { ...b.settings } : {};
    const warnings = [];
    const lid = b.league_id != null && b.league_id !== '' ? String(b.league_id) : null;
    if (lid && !/^(\d{1,10}|hs)$/.test(lid)) return badBody(res, 'Invalid league_id');
    const lc = LC.profileFor({ leagueKey: lk, leagueId: lid });

    let board;
    try { board = await modelPlayers(undefined, lc.profileId || undefined); } catch (err) {
      if (err.status !== 503) log.error('[nba] trade model:', err.message);
      return res.status(503).json({ error: 'NBA player data unavailable' });
    }

    // Yahoo enrichment: league settings, every roster (replacement level) and player_key resolution.
    const all = Object.values(lists).filter(Boolean).flat();
    const keys = all.filter(id => PLAYER_KEY_RE.test(id));
    let ctx = null;
    const uid = userId(req);
    if (lk && uid) {
      try { ctx = await loadContext(uid, lk); } catch (err) {
        if (keys.length) return sendYahooError(res, err, uid);
        warnings.push('Yahoo league unavailable; used defaults');
      }
    }
    if (keys.length && !ctx) return res.status(400).json({ error: 'Yahoo player keys need a connected Yahoo league (send league_key while signed in), or use Sleeper ids', code: 'player_keys_need_yahoo' });
    if (ctx) {
      const keyMap = new Map();
      for (const t of ctx.teams) for (const p of t.players) if (p.sleeperId) keyMap.set(p.player_key, p.sleeperId);
      const missing = keys.filter(k => !keyMap.has(k));
      if (missing.length) {
        try {
          const c = clientFor(uid);
          const match = await matcher();
          for (const p of await c.getPlayersByKeys(lk, missing)) { const m = match(p); if (m.sleeperId) keyMap.set(p.player_key, m.sleeperId); }
        } catch (err) { warnings.push('Could not resolve some Yahoo players'); }
      }
      for (const k of Object.keys(lists)) if (lists[k]) lists[k] = lists[k].map(id => keyMap.get(id) || id);
      const L = ctx.league;
      if (settings.teams == null) settings.teams = L.settings.teams;
      if (settings.rosterSize == null && L.settings.rosterSize) settings.rosterSize = L.settings.rosterSize;
      if (settings.slots == null && L.settings.slots) settings.slots = L.settings.slots;
      if (settings.playoffStartWeek == null && L.playoff_start_week != null) settings.playoffStartWeek = L.playoff_start_week;
      if (settings.endWeek == null && L.end_week != null) settings.endWeek = L.end_week;
      if (!lists.leagueRostered) lists.leagueRostered = ctx.teams.flatMap(t => t.players.map(p => p.sleeperId).filter(Boolean));
    }

    try {
      const out = evaluateTrade({
        players: board.players, currentWeek: board.currentWeek,
        myRoster: lists.myRoster, partnerRoster: lists.partnerRoster, give: lists.give, get: lists.get,
        leagueRostered: lists.leagueRostered, settings, profile: lc.profile, today: LC.todayEt(),
      });
      out.profile = LC.profileSummary(lc.profile, lc.profileId);
      if (!out.meta.rules.open) warnings.push(out.meta.rules.notes[0]);
      if (out.meta.unknown.length) warnings.push(`${out.meta.unknown.length} player${out.meta.unknown.length > 1 ? 's' : ''} not found in the model; ignored`);
      if (out.meta.pastEnd) warnings.push(`The season is past its last week; only week ${out.meta.lastWeek} is scored`);
      warnings.push(...out.meta.notes);
      res.json({ ...out, warnings, asOf: board.asOf || null });
    } catch (err) {
      log.error('[nba] trade evaluate:', err.message);
      res.status(500).json({ error: 'Trade evaluation failed' });
    }
  });

  // JSON parse / size errors from express.json → 400 / 413, never a stack.
  router.use('/api/nba/trade', (err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ error: 'Request too large' });
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) return res.status(400).json({ error: 'Invalid JSON' });
    next(err);
  });

  return router;
}

module.exports = createTradeRoutes;
module.exports.createRateLimit = createRateLimit;
module.exports.rosterShape = rosterShape;
