// Pocket NBA trade calculator routes (stream E). Mounted with one line in
// nba/router.js; deps are the router's own closures so Yahoo/model handling
// stays identical to the rest of /api/nba/*.
//
//   GET  /nba/trade                                    page
//   POST /api/nba/trade/evaluate                       manual mode, public, rate + size limited
//        body { give[], get[], myRoster[], partnerRoster?[], leagueRostered?[], settings?, sleeper_league_id?, league_key?, league_id? }
//        ids are Sleeper ids. sleeper_league_id loads the Sleeper league's roster shape + every
//        roster (replacement level). Yahoo player_keys only work when yahooEnabled.
//   GET  /api/nba/trade/context?league_id=[&user_id=]  Sleeper rosters (public data; team_key = roster_id)
//   GET  /api/nba/trade/context?league_key=&team_key=  Yahoo rosters (auth; only when yahooEnabled, else 410)
// League profile (L1): league_id (default 242808) picks the profile; the board
// is valued under its scoring and the evaluator uses its slots, roster size, IL,
// playoff weeks and trade rules. The league's roster_positions override slots.
// v2 (NBA trade spec §4): sleeper_league_id builds the league's own profile from
// Sleeper (profileFromSleeper: 3 UTIL, 23 Mon-Sun weeks, playoffs 21-23, deadline
// week 17) and values the board under it; body.options { horizon, lean } picks the
// weeks and the playoff weight; categories leagues get 400 league_not_points.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { versionAssets } = require('../asset-version');
const { evaluateTrade, HORIZONS, LEANS, PLAYOFFS_HORIZON_FROM_WEEK } = require('../model/trade');
const { profileFromSleeper } = require('../model/league-sync');
const ETA = require('../model/injury-eta');
const M = require('../sleeper/map');
const LC = require('./league-context');
const Boards = require('./boards');

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

// roster_positions → { slots: {PG,SG,G,SF,PF,F,C,FC,UTIL,BN,IL}, rosterSize (active spots) }.
// Accepts Yahoo's [{position,count}] and Sleeper's ['PG','SG',…,'BN','IR'].
// A High Score league's frontcourt slot shows as F with no SF/PF/C slots: FC.
function rosterShape(positions) {
  const slots = { PG: 0, SG: 0, G: 0, SF: 0, PF: 0, F: 0, C: 0, FC: 0, UTIL: 0, BN: 0, IL: 0 };
  let seen = false;
  for (const rp of positions || []) {
    const pos = String(typeof rp === 'string' ? rp : rp.position || '').toUpperCase();
    const n = typeof rp === 'string' ? 1 : Number(rp.count) || 0;
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
  sleeper = null, yahooEnabled = false,
  // v2 inputs (injectable for tests): the model (Sleeper-profile boards), the committed
  // logs/projections, the preseason market file and Stream A's ESPN return dates.
  loadModel = () => require('../model'),
  loadData = () => require('../model/data').load(),
  loadMarket = () => require('./market').load(),
  loadEta = () => ETA.loadInjuryEta(),
} = {}) {
  const router = express.Router();
  const userId = req => ((getAuth && getAuth(req)) || {}).userId || null;
  const { errorResponse: sleeperErr } = require('../sleeper/client');
  const SL_ID_RE = /^\d{1,24}$/;

  // Sleeper league → the same context shape the page / evaluator already use.
  // The raw league/draft ride along non-enumerable (profile + classification), never in JSON.
  async function sleeperContext(lid, uid) {
    const ctx = await sleeper.leagueContext(lid, uid);
    const board = await modelPlayers(undefined, undefined).catch(() => ({ players: [] }));
    const byId = new Map((board.players || []).map(p => [String(p.id), p]));
    const unmatched = [];
    const teams = ctx.teams.map(t => {
      const s = t.settings || {};
      return {
        team_key: t.team_key, name: t.name, mine: t.team_key === ctx.myTeamKey,
        record: { wins: Number(s.wins) || 0, losses: Number(s.losses) || 0, ties: Number(s.ties) || 0, fpts: (Number(s.fpts) || 0) + (Number(s.fpts_decimal) || 0) / 100 },
        players: t.players.map(id => {
          const p = byId.get(id);
          if (!p) unmatched.push({ team_key: t.team_key, player_key: id, name: `Player ${id}` });
          return { player_key: id, sleeperId: p ? String(p.id) : null, name: p ? p.name : `Player ${id}`, selected_position: t.reserve.includes(id) ? 'IL' : 'BN', status: p ? p.injury || null : null };
        }),
      };
    });
    const lg = ctx.league, st = lg.settings || {};
    const shape = rosterShape(lg.roster_positions);
    // Sleeper keeps IR spots in settings.reserve_slots, not roster_positions.
    if (shape && !shape.slots.IL && Number(st.reserve_slots) > 0) shape.slots.IL = Number(st.reserve_slots);
    const out = {
      source: 'sleeper',
      league: {
        league_id: String(lg.league_id), league_key: String(lg.league_id), name: lg.name || null, num_teams: Number(lg.total_rosters) || teams.length,
        current_week: st.leg || null, start_week: st.start_week || 1, end_week: null,
        playoff_start_week: st.playoff_week_start || null, playoff_teams: Number(st.playoff_teams) || null, trade_deadline: st.trade_deadline ?? null,
        scoring_type: M.classifyLeague(lg, ctx.draft || null).scoring_type || (lg.scoring_settings ? 'points' : null),
        settings: { teams: Number(lg.total_rosters) || teams.length, ...(shape || {}) },
      },
      myTeamKey: ctx.myTeamKey, teams, unmatched,
    };
    Object.defineProperty(out, 'raw', { value: { league: lg, draft: ctx.draft || null }, enumerable: false });
    return out;
  }

  // The league's own profile: Stream A's LC.profileFor({ sleeperLeagueId }) once it
  // returns one, else built here from the league payload (+ Sleeper state for the start date).
  async function sleeperProfile(ctx) {
    const lid = String(ctx.raw.league.league_id);
    try {
      const a = LC.profileFor({ sleeperLeagueId: lid });
      if (a && a.profile && a.profile.source === 'sleeper' && String(a.profile.sleeperLeagueId) === lid) return a;
    } catch { /* not wired yet */ }
    let state = null;
    if (sleeper && sleeper.client && typeof sleeper.client.state === 'function') {
      try { state = await apiCached('nba:trade:sl-state', 60 * 60 * 1000, () => sleeper.client.state()); } catch { state = null; }
    }
    return { profile: profileFromSleeper({ league: ctx.raw.league, draft: ctx.raw.draft, state }), profileId: null };
  }

  // Board under a profile: stored profiles via the router's modelPlayers, a Sleeper-built
  // profile straight from the shared board (the same object the team page values).
  async function boardFor(lc) {
    if (lc.profile && lc.profile.source === 'sleeper' && !lc.profileId) return Boards.boardFor(loadModel(), { profile: lc.profile });
    return modelPlayers(undefined, lc.profileId || undefined);
  }

  // Signal inputs (logs, projections, market, ESPN return dates). Each one is optional.
  let marketCache = { at: 0, doc: null };
  function signalContext(board) {
    let data = null, market = null, eta = null;
    try { data = loadData(); } catch { data = null; }
    if (Date.now() - marketCache.at > 60 * 1000) { try { marketCache = { at: Date.now(), doc: loadMarket() }; } catch { marketCache = { at: Date.now(), doc: null }; } }
    market = marketCache.doc;
    try { eta = loadEta(); } catch { eta = null; } // NOT_IMPLEMENTED until Stream A lands
    return {
      logs: data ? data.logs : null, proj: data ? data.proj : null, market, eta, bio: null,
      asOf: { board: board.asOf || null, market: market ? market.builtAt || market.asOf || null : null, injuryEta: eta && eta.fetchedAt ? eta.fetchedAt : null },
    };
  }

  // Default lean (spec §4.1): after week 4, contend when the record is ≥ .550 or the team
  // sits inside the playoff line; balanced otherwise. Before that (and in manual mode) contend.
  function defaultLean(ctx, myIds, currentWeek) {
    if (!ctx || !(Number(currentWeek) > 4)) return { lean: 'contend', leanSource: 'default' };
    const mine = new Set(myIds);
    let me = null, best = 0;
    for (const t of ctx.teams) { const n = t.players.filter(p => p.sleeperId && mine.has(p.sleeperId)).length; if (n > best) { best = n; me = t; } }
    const pct = t => { const r = t.record || {}; const g = r.wins + r.losses + r.ties; return g ? (r.wins + 0.5 * r.ties) / g : null; };
    if (!me || pct(me) == null) return { lean: 'contend', leanSource: 'default' };
    const order = ctx.teams.slice().sort((a, b) => (pct(b) || 0) - (pct(a) || 0) || (b.record.fpts || 0) - (a.record.fpts || 0));
    const rank = order.indexOf(me) + 1;
    const line = Number(ctx.league.playoff_teams) || Math.ceil(ctx.teams.length / 2);
    return { lean: pct(me) >= 0.55 || rank <= line ? 'contend' : 'balanced', leanSource: 'record' };
  }

  router.get('/nba/trade', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let html;
    try { html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'trade.html'), 'utf8'); } catch { return res.status(404).send('Not found'); }
    res.setHeader('Cache-Control', 'no-cache');
    res.send(versionAssets(html.replace(/PUBLISHABLE_KEY_PLACEHOLDER/g, env.CLERK_PUBLISHABLE_KEY || '')));
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

  router.get('/api/nba/trade/context', (req, res, next) => {
    if (req.query.league_id == null) return next();
    rateLimit(req, res, async () => {
      res.setHeader('Cache-Control', 'private, no-store');
      const lid = String(req.query.league_id || '');
      if (!SL_ID_RE.test(lid)) return res.status(400).json({ error: 'Invalid league_id' });
      const uid = req.query.user_id != null && SL_ID_RE.test(String(req.query.user_id)) ? String(req.query.user_id) : null;
      const tk = req.query.team_key != null && req.query.team_key !== '' ? String(req.query.team_key) : null;
      if (tk && !/^\d{1,3}$/.test(tk)) return res.status(400).json({ error: 'Invalid team_key' });
      if (!sleeper) return res.status(503).json({ error: 'Sleeper sync unavailable' });
      try {
        const ctx = await sleeperContext(lid, uid);
        if (tk && !ctx.teams.some(t => t.team_key === tk)) return res.status(404).json({ error: 'Team not in league' });
        res.json({ ...ctx, myTeamKey: tk || ctx.myTeamKey });
      } catch (err) { const e = sleeperErr(err); if (e.status >= 500) log.error('[nba] trade sleeper:', err && err.message); res.status(e.status).json(e.body); }
    });
  });
  router.get('/api/nba/trade/context', (req, res, next) => {
    if (yahooEnabled) return next();
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(410).json({ error: 'Yahoo sync is no longer offered; use league_id (Sleeper)', code: 'yahoo_disabled' });
  });
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
    const slid = b.sleeper_league_id != null && b.sleeper_league_id !== '' ? String(b.sleeper_league_id) : null;
    if (slid && !SL_ID_RE.test(slid)) return badBody(res, 'Invalid sleeper_league_id');
    const settings = b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings) ? { ...b.settings } : {};
    // v2 options: absent → defaults (v1 clients); present → validated.
    let options = {};
    if (b.options != null) {
      if (typeof b.options !== 'object' || Array.isArray(b.options)) return badBody(res, 'options must be an object');
      const { horizon, lean } = b.options;
      if (horizon != null && !HORIZONS.includes(horizon)) return badBody(res, `options.horizon must be one of ${HORIZONS.join(', ')}`);
      if (lean != null && !LEANS.includes(lean)) return badBody(res, `options.lean must be one of ${LEANS.join(', ')}`);
      options = { horizon: horizon || undefined, lean: lean || undefined };
    }
    const warnings = [];
    const lid = b.league_id != null && b.league_id !== '' ? String(b.league_id) : null;
    if (lid && !/^(\d{1,10}|hs)$/.test(lid)) return badBody(res, 'Invalid league_id');
    let lc = LC.profileFor({ leagueKey: lk, leagueId: lid });

    // League enrichment: settings, every roster (replacement level) and (Yahoo) player_key resolution.
    const all = Object.values(lists).filter(Boolean).flat();
    const keys = all.filter(id => PLAYER_KEY_RE.test(id));
    let ctx = null;
    const uid = userId(req);
    if (slid && sleeper) {
      try { ctx = await sleeperContext(slid, null); } catch (err) {
        const e = sleeperErr(err);
        if (e.status === 404 || e.body.code === 'not_an_nba_league') return res.status(e.status).json(e.body);
        warnings.push('Sleeper league unavailable; used defaults');
      }
      if (ctx) {
        if (ctx.league.scoring_type === 'categories') return res.status(400).json({ error: 'This is a categories league. The trade calculator values points leagues only.', code: 'league_not_points' });
        try {
          lc = await sleeperProfile(ctx);
          if (lc.profile.aggregation === 'categories') return res.status(400).json({ error: 'This is a categories league. The trade calculator values points leagues only.', code: 'league_not_points' });
        } catch (err) { log.error('[nba] trade sleeper profile:', err && err.message); warnings.push('Could not read this league\'s settings; used defaults'); }
      }
    } else if (lk && uid && yahooEnabled) {
      try { ctx = await loadContext(uid, lk); } catch (err) {
        if (keys.length) return sendYahooError(res, err, uid);
        warnings.push('Yahoo league unavailable; used defaults');
      }
    }
    if (keys.length && !yahooEnabled) return res.status(400).json({ error: 'Yahoo player keys are no longer supported; use Sleeper ids', code: 'yahoo_disabled' });
    if (keys.length && !ctx) return res.status(400).json({ error: 'Yahoo player keys need a connected Yahoo league (send league_key while signed in), or use Sleeper ids', code: 'player_keys_need_yahoo' });
    if (ctx) {
      const keyMap = new Map();
      for (const t of ctx.teams) for (const p of t.players) if (p.sleeperId) keyMap.set(p.player_key, p.sleeperId);
      const missing = keys.filter(k => !keyMap.has(k));
      if (missing.length && ctx.source !== 'sleeper') {
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

    let board;
    try { board = await boardFor(lc); } catch (err) {
      if (err.status !== 503) log.error('[nba] trade model:', err.message);
      return res.status(503).json({ error: 'NBA player data unavailable' });
    }
    if (options.horizon === 'playoffs' && Number(board.currentWeek) < PLAYOFFS_HORIZON_FROM_WEEK) {
      return res.status(400).json({ error: `The Playoffs view opens in week ${PLAYOFFS_HORIZON_FROM_WEEK}`, code: 'horizon_unavailable' });
    }
    const leanDefault = defaultLean(ctx && ctx.source === 'sleeper' ? ctx : null, lists.myRoster.concat(lists.give), board.currentWeek);
    const opts = { horizon: options.horizon || 'ros', lean: options.lean || leanDefault.lean, leanSource: options.lean ? 'user' : leanDefault.leanSource };
    // League-relative fit tiers need every roster (IL excluded, like the team page).
    const leagueRosters = ctx && ctx.source === 'sleeper'
      ? ctx.teams.map(t => t.players.filter(p => p.sleeperId && p.selected_position !== 'IL').map(p => p.sleeperId))
      : null;

    try {
      const out = evaluateTrade({
        players: board.players, currentWeek: board.currentWeek,
        myRoster: lists.myRoster, partnerRoster: lists.partnerRoster, give: lists.give, get: lists.get,
        leagueRostered: lists.leagueRostered, settings, profile: lc.profile, today: LC.todayEt(),
        options: opts, context: signalContext(board), leagueRosters,
      });
      out.profile = LC.profileSummary(lc.profile, lc.profileId);
      if (lc.profile && lc.profile.source === 'sleeper') out.profile.source = 'sleeper';
      if (out.meta.v2Error) log.error('[nba] trade v2 layer:', out.meta.v2Error);
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
