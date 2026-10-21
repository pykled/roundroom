// Pocket NBA team page routes (Stream C). Mounted with one line in nba/router.js:
//   router.use(require('./routes/team')({ apiCached, loadModel, log, sleeper, env }))
// Public like every Sleeper-first NBA page (Sleeper data needs no auth).
//
//   GET  /nba/team                                                          page
//   GET  /api/nba/team?league_id=[&user_id=][&roster_id=][&horizon=ros|next4|playoffs]
//        → { league, analysis, myRosterId, viewAs, unmatched, asOf }   (cached 60 s per league/horizon/team and board; targets 5 min)
//   GET  /api/nba/team/detail?league_id=&roster_id=[&horizon=]
//        → { league, team, roster: [{ player, signals, slot, group, tier, value, gamesThisWeek }], weeks, unmatched }
//   POST /api/nba/team/manual { roster: [ids], league_id?, horizon? }
//        → same shape as /api/nba/team with estimated: true (my team vs a typical league)
// Errors: 400 bad ids / horizon, 400 league_not_points (categories), 404 sleeper_not_found / team_not_found,
// 429 (+Retry-After), 503 board unavailable, Sleeper outages → errorResponse codes (429/502/504).
'use strict';
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { versionAssets } = require('../asset-version');
const LS = require('../model/league-sync');
const TA = require('../model/team-analysis');
const LC = require('./league-context');
const Boards = require('./boards');
const M = require('../sleeper/map');
const { errorResponse } = require('../sleeper/client');

const ID_RE = /^\d{1,24}$/;
const ROSTER_RE = /^\d{1,3}$/;
const PLAYER_RE = /^[A-Za-z0-9_]{1,16}$/;
const MAX_BODY = 8 * 1024;
const MAX_ROSTER = 25;
const ANALYSIS_TTL = 60 * 1000, TARGETS_TTL = 5 * 60 * 1000;

// The "typical league" for manual mode without a Sleeper league: Dillon's league
// shape (10 starters: PG SG G SF PF F C UTIL×3, 4 BN, 2 IL; 12 teams; Mon-Sun weeks,
// playoffs 21-23, deadline week 17) and its scoring.
const TYPICAL_LEAGUE = {
  league_id: '0', name: 'Typical League', season: '2026', total_rosters: 12,
  roster_positions: ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'UTIL', 'UTIL', 'BN', 'BN', 'BN', 'BN'],
  scoring_settings: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, pf: -1, tf: -1, ff: -1, dd: 5, td: 3 },
  settings: { reserve_slots: 2, playoff_week_start: 21, playoff_teams: 6, playoff_round_type: 0, trade_deadline: 17, type: 0, max_keepers: 0, waiver_type: 0, waiver_clear_days: 2 },
};

// Fixed-window per-IP limiter (memory; politeness, not security), 240/min like /api/nba/sleeper.
function createRateLimit({ windowMs = 60 * 1000, max = 240, now = () => Date.now() } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'anon';
    let h = hits.get(key);
    if (!h || t - h.start >= windowMs) { h = { start: t, n: 0 }; hits.set(key, h); }
    if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    if (++h.n > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((h.start + windowMs - t) / 1000))));
      return res.status(429).json({ error: 'Too many requests, slow down', code: 'rate_limited' });
    }
    next();
  };
}

// Analysis / targets cache: one entry per key, missed when the board changed (so a
// refreshed board replaces the entry instead of piling up beside it), bounded.
function createBoardCache({ max = 500, now = () => Date.now() } = {}) {
  const m = new Map();
  return async (key, version, ttlMs, fn) => {
    const h = m.get(key);
    if (h && h.version === version && now() - h.at < ttlMs) return h.value;
    const value = await fn();
    m.delete(key);
    m.set(key, { value, version, at: now() });
    while (m.size > max) m.delete(m.keys().next().value);
    return value;
  };
}

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; this.http = true; }
}

function createTeamRoutes({
  apiCached, loadModel, sleeper = null, log = console, env = process.env,
  rateLimit = createRateLimit(), loadData = () => require('../model/data').load(),
  loadMarket = () => require('./market').load(), today = () => LC.todayEt(),
} = {}) {
  if (typeof apiCached !== 'function') throw new Error('team routes: apiCached required');
  if (typeof loadModel !== 'function') throw new Error('team routes: loadModel required');
  const router = express.Router();
  const cached = createBoardCache();

  router.get('/nba/team', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let html;
    try { html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'team.html'), 'utf8'); } catch { return res.status(404).send('Not found'); }
    res.setHeader('Cache-Control', 'no-cache');
    res.send(versionAssets(html.replace(/PUBLISHABLE_KEY_PLACEHOLDER/g, env.CLERK_PUBLISHABLE_KEY || '')));
  });

  /* ---------------------------------------------------------------- data */
  const profileKey = p => crypto.createHash('sha1').update(JSON.stringify([p.leagueId, p.scoring, p.slots, p.teams, p.weeks])).digest('base64url').slice(0, 16);

  // Board under a league profile, with the market fields (preseason consensus) joined on.
  // The shared board (routes/boards.js) is the one the trade calculator values, so a
  // trade target and Open in Trade always agree; `version` keys the caches below.
  const views = new WeakMap();
  async function boardFor(profile) {
    const model = loadModel();
    if (!model || model.stub) throw new HttpError(503, 'NBA player data unavailable');
    let d;
    try { d = await Boards.boardFor(model, { profile }); } catch (err) {
      if (err && err.status !== 503) log.error('[nba] team board:', err.message);
      throw new HttpError(503, 'NBA player data unavailable');
    }
    let v = views.get(d);
    if (!v) {
      const players = d.players.filter(p => p.source !== 'yahoo-only').map(p => (p.modelRank != null ? { ...p, rank: p.modelRank } : p));
      v = { players, currentWeek: d.currentWeek, asOf: d.asOf || null, version: Boards.boardVersion(d) };
      views.set(d, v);
    }
    return v;
  }

  function state() {
    if (!sleeper || !sleeper.client || typeof sleeper.client.state !== 'function') return Promise.resolve(null);
    return apiCached('nba:team:state', 60 * 60 * 1000, () => sleeper.client.state()).catch(() => null);
  }

  // League payloads + profile; throws HttpError / SleeperError.
  async function league(lid, uid) {
    if (!sleeper) throw new HttpError(503, 'Sleeper sync unavailable');
    const [raw, st] = await Promise.all([sleeper.leagueContext(lid, uid), state()]);
    const cls = M.classifyLeague(raw.league, raw.draft);
    if (cls.scoring_type === 'categories') throw new HttpError(400, 'This is a categories league. The team page ranks points (High Score) leagues only.', 'league_not_points');
    const profile = LS.profileFromSleeper({ league: raw.league, draft: raw.draft, state: st });
    if (profile.aggregation === 'categories') throw new HttpError(400, 'This is a categories league. The team page ranks points (High Score) leagues only.', 'league_not_points');
    return { raw, profile };
  }

  async function matchups(lid, week) {
    if (!sleeper || !sleeper.client || typeof sleeper.client.leagueMatchups !== 'function') return null;
    try { return await apiCached(`nba:team:mu:${lid}:${week}`, 5 * 60 * 1000, () => sleeper.client.leagueMatchups(lid, week)); } catch { return null; }
  }

  // Compact player map for the page (names for strengths/weaknesses, avatars, badges).
  function briefs(board, ids) {
    const index = new Map(board.players.map(p => [String(p.id), p]));
    const out = {};
    for (const id of ids) {
      const p = index.get(String(id));
      if (p) out[p.id] = { id: String(p.id), name: p.name, team: p.team || null, pos: (p.pos || []).slice(0, 3), injury: p.injury || null, outForSeason: !!p.outForSeason, hsValue: p.hsValue, rank: p.rank };
    }
    return out;
  }

  function leagueMeta(profile, raw, board) {
    const lg = (raw && raw.league) || {};
    return {
      leagueId: profile.sleeperLeagueId || null, name: profile.name, season: profile.season || null, teams: profile.teams, avatar: lg.avatar || null,
      currentWeek: board.currentWeek, weeks: profile.weeks.length, playoffStartWeek: (profile.weeks.find(w => w.playoffs) || {}).week || null,
      playoffTeams: profile.playoffTeams || 0, tradeDeadlineWeek: profile.tradeDeadlineWeek ?? null, tradeEnd: profile.tradeEnd ?? null,
      slots: profile.slots, starters: profile.starters, slotList: require('../model/roster-slots').slotList(profile), scoring: profile.scoring,
      weekDates: profile.weeks.map(w => ({ week: w.week, start: w.start, end: w.end, playoffs: !!w.playoffs })),
    };
  }

  // League analysis (no targets), cached 60 s per league / horizon / my team.
  async function leagueAnalysis(lid, uid, horizon, rosterId) {
    const { raw, profile } = await league(lid, uid);
    const board = await boardFor(profile);
    const src = {};
    const ctxArgs = { league: raw.league, users: raw.users, rosters: raw.rosters, draft: raw.draft, board: board.players, profile, userId: uid, currentWeek: board.currentWeek };
    const mu = await matchups(lid, board.currentWeek);
    // Shared leagueContext carries a profile summary (weeks = count); the analysis needs the full profile.
    const ctx = { ...TA.viaShared(src, 'leagueContext', () => LS.leagueContext({ ...ctxArgs, matchups: mu }), () => TA.leagueContextLocal({ ...ctxArgs, matchups: mu })), profile };
    if (rosterId && !ctx.teams.some(t => t.rosterId === rosterId)) throw new HttpError(404, 'Team not in league', 'team_not_found');
    const mine = ctx.myRosterId;
    const ctxView = rosterId ? { ...ctx, myRosterId: rosterId } : ctx;
    const key = `a:${lid}:${horizon}:${ctxView.myRosterId || '-'}:${profileKey(profile)}`;
    const analysis = await cached(key, board.version, ANALYSIS_TTL, async () => TA.analyzeLeague({
      ctx: ctxView, board: board.players,
      options: { horizon, currentWeek: board.currentWeek, today: today(), targets: false, asOf: board.asOf, source: src },
    }));
    return { raw, profile, board, ctx: ctxView, analysis, mine };
  }

  async function withTargets(lid, L) {
    if (!L.analysis.myRosterId) return { ...L.analysis, targets: [], targetsNote: null };
    const fp = crypto.createHash('sha1').update(JSON.stringify(L.ctx.teams.map(t => [t.rosterId, t.players.map(p => p.id)]))).digest('base64url').slice(0, 12);
    const tg = await cached(`t:${lid}:${L.analysis.myRosterId}:${fp}`, L.board.version, TARGETS_TTL, async () => TA.targetsFor(L.analysis, { ctx: L.ctx, board: L.board.players, today: today() }));
    return { ...L.analysis, targets: tg.targets, targetsNote: tg.note, targetsEvaluated: tg.evaluated };
  }

  /* ---------------------------------------------------------------- params */
  function params(q, { needRoster = false } = {}) {
    const lid = String(q.league_id || '').trim();
    if (!ID_RE.test(lid)) throw new HttpError(400, 'Invalid league_id', 'bad_request');
    const uid = q.user_id != null && String(q.user_id).trim() !== '' ? String(q.user_id).trim() : null;
    if (uid && !ID_RE.test(uid)) throw new HttpError(400, 'Invalid user_id', 'bad_request');
    const rid = q.roster_id != null && String(q.roster_id).trim() !== '' ? String(q.roster_id).trim() : null;
    if (rid && !ROSTER_RE.test(rid)) throw new HttpError(400, 'Invalid roster_id', 'bad_request');
    if (needRoster && !rid) throw new HttpError(400, 'roster_id required', 'bad_request');
    const horizon = q.horizon == null || q.horizon === '' ? 'ros' : String(q.horizon);
    if (!TA.HORIZONS.includes(horizon)) throw new HttpError(400, 'horizon must be ros, next4 or playoffs', 'bad_request');
    return { lid, uid, rid, horizon };
  }

  function sendError(res, err) {
    if (err && err.http) {
      if (err.status >= 500) log.error('[nba] team:', err.message);
      return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    if (err && err.name === 'SleeperError') {
      const { status, body } = errorResponse(err);
      if (status >= 500 || status === 429) log.error('[nba] team sleeper:', err.message);
      if (status === 429 && body.retryAfterS) res.setHeader('Retry-After', String(body.retryAfterS));
      return res.status(status).json(body);
    }
    log.error('[nba] team:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Team analysis failed' });
  }

  router.use('/api/nba/team', rateLimit);

  router.get('/api/nba/team', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const { lid, uid, rid, horizon } = params(req.query);
      const L = await leagueAnalysis(lid, uid, horizon, rid);
      const analysis = await withTargets(lid, L);
      const unmatched = L.ctx.teams.flatMap(t => (t.unmatched || []).map(u => ({ rosterId: t.rosterId, ...u })));
      const players = briefs(L.board, L.ctx.teams.flatMap(t => t.players.map(p => p.id)));
      res.json({ league: leagueMeta(L.profile, L.raw, L.board), analysis, players, myRosterId: analysis.myRosterId, ownRosterId: L.mine || null, viewAs: !!(rid && rid !== L.mine), unmatched, asOf: L.board.asOf });
    } catch (err) { sendError(res, err); }
  });

  router.get('/api/nba/team/detail', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const { lid, uid, rid, horizon } = params(req.query, { needRoster: true });
      const L = await leagueAnalysis(lid, uid, horizon, null);
      const team = L.ctx.teams.find(t => t.rosterId === rid);
      if (!team) throw new HttpError(404, 'Team not in league', 'team_not_found');
      const index = new Map(L.board.players.map(p => [String(p.id), p]));
      const players = team.players.filter(p => p.onBoard && index.has(p.id)).map(p => index.get(p.id));
      let data = null, market = null;
      try { data = loadData(); } catch { data = null; }
      try { market = loadMarket(); } catch { market = null; }
      const signals = TA.signalsFor(players, { profile: L.profile, currentWeek: L.analysis.currentWeek, weeks: L.analysis.weeks, logs: data ? data.logs : [], proj: data ? data.proj : null, market, today: today() });
      const detail = TA.teamDetail(L.analysis, { ctx: L.ctx, board: L.board.players, signals }, rid);
      res.json({ league: leagueMeta(L.profile, L.raw, L.board), ...detail, currentWeek: L.analysis.currentWeek, horizon, asOf: L.board.asOf });
    } catch (err) { sendError(res, err); }
  });

  router.post('/api/nba/team/manual', (req, res, next) => {
    const len = Number(req.get('content-length'));
    if (Number.isFinite(len) && len > MAX_BODY) return res.status(413).json({ error: 'Request too large' });
    next();
  }, express.json({ limit: MAX_BODY }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
      if (!b) throw new HttpError(400, 'JSON body required', 'bad_request');
      if (!Array.isArray(b.roster) || !b.roster.length) throw new HttpError(400, 'roster: add at least one player', 'bad_request');
      if (b.roster.length > MAX_ROSTER) throw new HttpError(400, `roster: at most ${MAX_ROSTER} players`, 'bad_request');
      const ids = [...new Set(b.roster.map(String))];
      if (ids.some(id => !PLAYER_RE.test(id))) throw new HttpError(400, 'roster: invalid player id', 'bad_request');
      const horizon = b.horizon == null || b.horizon === '' ? 'ros' : String(b.horizon);
      if (!TA.HORIZONS.includes(horizon)) throw new HttpError(400, 'horizon must be ros, next4 or playoffs', 'bad_request');
      const lid = b.league_id != null && b.league_id !== '' ? String(b.league_id) : null;
      if (lid && !ID_RE.test(lid)) throw new HttpError(400, 'Invalid league_id', 'bad_request');
      let profile, raw = null;
      const warnings = [];
      if (lid) {
        try { ({ raw, profile } = await league(lid, null)); } catch (err) {
          if (err && (err.code === 'league_not_points' || err.code === 'not_an_nba_league')) throw err;
          warnings.push('Sleeper league unavailable; used a typical league');
        }
      }
      if (!profile) profile = LS.profileFromSleeper({ league: TYPICAL_LEAGUE, state: await state() });
      const board = await boardFor(profile);
      const known = new Set(board.players.map(p => String(p.id)));
      const unknown = ids.filter(id => !known.has(id));
      const mine = ids.filter(id => known.has(id));
      if (!mine.length) throw new HttpError(400, 'None of these players are in the model', 'bad_request');
      const key = `m:${profileKey(profile)}:${horizon}:${crypto.createHash('sha1').update(mine.slice().sort().join(',')).digest('base64url').slice(0, 16)}`;
      const analysis = await cached(key, board.version, ANALYSIS_TTL, async () => {
        const ctx = TA.typicalLeague({ board: board.players, myIds: mine, profile, currentWeek: board.currentWeek });
        return TA.analyzeLeague({ ctx, board: board.players, options: { horizon, currentWeek: board.currentWeek, today: today(), targets: false, estimated: true, asOf: board.asOf } });
      });
      if (unknown.length) warnings.push(`${unknown.length} player${unknown.length > 1 ? 's' : ''} not found in the model; ignored`);
      res.json({ league: leagueMeta(profile, raw, board), analysis: { ...analysis, partners: [], targets: [] }, players: briefs(board, mine), myRosterId: analysis.myRosterId, estimated: true, unknown, warnings, asOf: board.asOf });
    } catch (err) { sendError(res, err); }
  });

  router.use('/api/nba/team', (err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ error: 'Request too large' });
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) return res.status(400).json({ error: 'Invalid JSON' });
    next(err);
  });

  return router;
}

module.exports = createTeamRoutes;
module.exports.createRateLimit = createRateLimit;
module.exports.createBoardCache = createBoardCache;
module.exports.TYPICAL_LEAGUE = TYPICAL_LEAGUE;
