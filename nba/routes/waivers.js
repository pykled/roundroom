// Pocket NBA waivers / streaming API (stream F). Mounted with one line in nba/router.js:
//   router.use(require('./routes/waivers')({ auth, getAuth, apiCached, loadModel, clientFor, sendYahooError, modelPlayers, log }));
//
//   GET  /api/nba/waivers?league_id=&roster_id=&weeks=1|2|4[&week=][&priority=][&adds_used=][&user_id=]   (Sleeper; public data, rate limited)
//        roster = the Sleeper roster's players (model ids), IL = its `reserve`, pool = every model player on no
//        roster in the league, priority = roster.settings.waiver_position (rolling / reverse-standings leagues),
//        FAAB = league.settings.waiver_type 2. Sleeper does not expose weekly adds used → from the query or unknown.
//   GET  /api/nba/waivers?league_key=&team_key=&weeks=…   (Yahoo; only when yahooEnabled, else 410)
//   POST /api/nba/waivers/manual { roster:[ids], pool?:[ids], exclude?:[ids], waivers?:[ids], weeks?, week?,
//        rosterSize?, priority?, addsUsed?, league_id? }
//        (public, rate limited, 16 KB body cap; no pool → every model player not on the roster)
// League profile (L1): league_key / league_id (default 242808) picks the profile:
// board scoring, matchup weeks, slots, IL, max adds per week, waiver rules.
// Method: docs/nba-waivers.md. Engine: nba/model/waivers.js.
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { versionAssets } = require('../asset-version');
const W = require('../model/waivers');
const LC = require('./league-context');
const R = require('../model/roster-slots');

const LEAGUE_KEY_RE = /^\d+\.l\.\d+$/;
const TEAM_KEY_RE = /^\d+\.l\.\d+\.t\.\d+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const MAX_ROSTER = 20;
const MAX_POOL = 400;
const FA_PAGES = 4;     // status=FA: up to 100 players (Yahoo pages are 25)
const W_PAGES = 1;      // status=W: up to 25 players on waivers
const RATE = { windowMs: 60 * 1000, max: 30 };

function defaultLoadData() {
  try { return require('../model/data').load(); } catch { return null; }
}

// Fixed-window per-key limiter (in memory; single instance like the rest of /api/nba).
function createRateLimiter({ windowMs, max }, now = () => Date.now()) {
  const hits = new Map();
  return function limited(key) {
    const t = now();
    let h = hits.get(key);
    if (!h || t - h.start >= windowMs) { h = { start: t, n: 0 }; hits.set(key, h); }
    h.n++;
    if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    return h.n > max ? Math.ceil((h.start + windowMs - t) / 1000) : 0;
  };
}

function parseHorizon(v) {
  if (v == null || v === '') return 1;
  const n = Number(v);
  return W.HORIZONS.includes(n) ? n : null;
}
function parseWeek(v) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : null;
}

// Starter + bench spots from Yahoo roster_positions (IL slots don't count).
function rosterSizeFrom(league) {
  const rp = league && league.roster_positions;
  if (!rp) return null;
  const list = Array.isArray(rp) ? rp : Object.entries(rp).map(([position, count]) => ({ position, count }));
  let n = 0;
  for (const r of list) {
    const pos = typeof r === 'string' ? r : r && (r.position || r.roster_position && r.roster_position.position);
    const c = typeof r === 'string' ? 1 : Number((r && (r.count != null ? r.count : r.roster_position && r.roster_position.count)) || 1);
    if (!pos || /^IL/i.test(pos)) continue;
    n += Number.isFinite(c) ? c : 1;
  }
  return n || null;
}

function waiverRules(league) {
  const s = (league && league.settings) || {};
  const pick = k => (s[k] != null ? s[k] : league && league[k] != null ? league[k] : null);
  return {
    waiver_type: pick('waiver_type'), waiver_rule: pick('waiver_rule'), waiver_time: pick('waiver_time'),
    uses_faab: pick('uses_faab') == null ? null : String(pick('uses_faab')) === '1',
    max_weekly_adds: pick('max_weekly_adds'), max_adds: pick('max_adds'),
  };
}

function weekDates(data, league, profile, profileId) {
  const out = {};
  if (profileId && profile) {
    for (const w of profile.weeks || []) out[w.week] = { start: w.start, end: w.end, days: w.days };
    return out;
  }
  if (data && data.proj && data.proj.weeks) for (const [w, d] of Object.entries(data.proj.weeks)) if (Array.isArray(d)) out[w] = { start: d[0], end: d[1] };
  if (league && Array.isArray(league.weeks)) for (const w of league.weeks) if (w && w.week != null) out[w.week] = { start: w.start, end: w.end };
  return out;
}

const dayOf = iso => Math.floor(Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') / 86400000);

// Games each team has already played in the model week that contains `today`
// (Sleeper week numbering, same as hsByWeek). From this season's game logs when
// they run through yesterday; otherwise each team's week games × share of the
// week's days already gone (logs, if any, as a floor). Today's games still count
// as addable. null when today isn't strictly inside a week.
function midWeekFrom(data, nowDate = new Date()) {
  const proj = data && data.proj;
  if (!proj || !proj.weeks) return null;
  const today = Math.floor(nowDate.getTime() / 86400000);
  let week = null, s = 0, e = 0;
  for (const [w, d] of Object.entries(proj.weeks)) {
    if (!Array.isArray(d)) continue;
    const a = dayOf(d[0]), b = dayOf(d[1]);
    if (today > a && today <= b) { week = Number(w); s = a; e = b; break; }
  }
  if (week == null) return null;
  const fromLogs = {};
  let lastDay = -Infinity;
  const cur = (data.logs || []).find(f => f && String(f.season) === String(proj.season));
  if (cur && cur.players) {
    const days = {};
    for (const p of Object.values(cur.players)) {
      if (!p || !p.t || !Array.isArray(p.g)) continue;
      for (const g of p.g) if (g[0] >= s && g[0] < today) { (days[p.t] ||= new Set()).add(g[0]); if (g[0] > lastDay) lastDay = g[0]; }
    }
    for (const [t, set] of Object.entries(days)) fromLogs[t] = set.size;
  }
  const fresh = lastDay >= today - 1;
  const played = {};
  for (const [t, byW] of Object.entries(proj.teamGames || {})) {
    const n = Number(byW && byW[week]) || 0;
    const est = Math.round(n * (today - s) / (e - s + 1));
    played[t] = Math.min(n, fresh ? (fromLogs[t] || 0) : Math.max(fromLogs[t] || 0, est));
  }
  return { week, played, source: fresh ? 'logs' : 'estimate' };
}

// Profile matchup week containing today (ET) and each team's games already played
// in it, from the real schedule (imputed NBA Cup games included). `played`
// counts days before today (an FA added now still gets today's game);
// `playedToday` counts through today (a waiver claim clears tomorrow).
function midWeekProfile(profile, teamDates, nowDate = new Date()) {
  if (!teamDates) return null;
  const today = R.dayNum(LC.todayEt(nowDate));
  const w = (profile.weeks || []).find(x => today > R.dayNum(x.start) && today <= R.dayNum(x.end));
  if (!w) return null;
  const s = R.dayNum(w.start);
  const played = {}, playedToday = {};
  for (const [t, days] of Object.entries(teamDates)) {
    played[t] = days.filter(d => d >= s && d < today).length;
    playedToday[t] = days.filter(d => d >= s && d <= today).length;
  }
  return { week: w.week, played, playedToday, source: 'schedule' };
}

// Thin local adapter (A's parser drops these team fields): waiver priority and
// this week's adds from the raw team resource. Scans rather than depends on the
// exact nesting. { priority: number|null, addsUsed: number|null }
async function teamWaiverState(client, teamKey) {
  if (!client || typeof client.request !== 'function') return { priority: null, addsUsed: null };
  const json = await client.request(`team/${encodeURIComponent(teamKey)}`);
  let priority = null, addsUsed = null;
  (function walk(x) {
    if (!x || typeof x !== 'object') return;
    if (x.waiver_priority != null && priority == null && Number.isFinite(Number(x.waiver_priority))) priority = Number(x.waiver_priority);
    const ra = x.roster_adds;
    if (ra && typeof ra === 'object' && String(ra.coverage_type) === 'week' && addsUsed == null && Number.isFinite(Number(ra.value))) addsUsed = Number(ra.value);
    for (const v of Object.values(x)) walk(v);
  })(json);
  return { priority, addsUsed };
}

module.exports = function waiversRoutes({
  auth, getAuth, apiCached, loadModel, clientFor, sendYahooError, modelPlayers,
  loadData = defaultLoadData, log = console, rate = RATE, now, env = process.env,
  sleeper = null, yahooEnabled = false,
} = {}) {
  const router = express.Router();
  // Express 4 doesn't catch async handler rejections; route them to the JSON error handler.
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const { errorResponse: sleeperErr } = require('../sleeper/client');
  // Sleeper waiver_type: 0 rolling priority, 1 reverse standings, 2 FAAB (docs.sleeper.com).
  const sleeperRules = lg => {
    const st = (lg && lg.settings) || {};
    const wt = st.waiver_type != null ? Number(st.waiver_type) : null;
    return { waiver_type: wt, waiver_rule: wt === 2 ? 'faab' : wt === 1 ? 'reverse-standings' : wt === 0 ? 'rolling' : null, waiver_time: st.waiver_clear_days ?? null,
      uses_faab: wt == null ? null : wt === 2, waiver_budget: st.waiver_budget ?? null, daily_waivers: st.daily_waivers != null ? !!Number(st.daily_waivers) : null,
      max_weekly_adds: null, max_adds: null };
  };

  router.get('/nba/waivers', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let html;
    try { html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'waivers.html'), 'utf8'); } catch { return res.status(404).send('Not found'); }
    res.setHeader('Cache-Control', 'no-cache');
    res.send(versionAssets(html.replace(/PUBLISHABLE_KEY_PLACEHOLDER/g, env.CLERK_PUBLISHABLE_KEY || '')));
  });
  const limited = createRateLimiter(rate, now);
  const userId = req => (getAuth(req) || {}).userId || null;

  async function board(lc) {
    const model = loadModel();
    if (!model || model.stub) { const e = new Error('NBA model not available'); e.status = 503; throw e; }
    const b = modelPlayers ? await modelPlayers(null, lc.profileId || undefined) : await apiCached('nba:players:default', 10 * 60 * 1000, () => model.getPlayers({}));
    return { model, b };
  }

  function analyze({ roster, pool, b, horizon, week, rosterSize, data, ilIds, lc, waiverIds, priority, addsUsed }) {
    const ids = [...roster, ...pool].map(p => String(p.id));
    const roles = W.roleSignalsFromData(data, ids);
    const startWeek = week || b.currentWeek || b.week || undefined;
    const nowD = now ? new Date(now()) : new Date();
    const midWeek = lc.profileId ? midWeekProfile(lc.profile, LC.teamDates(() => data), nowD) : midWeekFrom(data, nowD);
    const out = W.analyzeWaivers({ roster, pool, horizon, startWeek, roles, rosterSize, ilIds, midWeek, profile: lc.profile, waiverIds, priority, addsUsed });
    if (out.midWeek && midWeek) out.midWeek.source = midWeek.source;
    out.profile = LC.profileSummary(lc.profile, lc.profileId);
    return out;
  }
  const intIn = (v, lo, hi) => { if (v == null || v === '') return undefined; const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };

  // ---- Sleeper (public league data) -----------------------------------------
  router.get('/api/nba/waivers', (req, res, next) => {
    if (req.query.league_id == null) return next();
    res.setHeader('Cache-Control', 'private, no-store');
    const wait = limited(String(req.ip || (req.socket && req.socket.remoteAddress) || 'anon'));
    if (wait) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ error: 'Too many requests — retry shortly' }); }
    wrap(async () => {
      const lid = String(req.query.league_id || '');
      const rid = String(req.query.roster_id || '');
      if (!/^\d{1,24}$/.test(lid)) return res.status(400).json({ error: 'Invalid league_id' });
      if (!/^\d{1,3}$/.test(rid)) return res.status(400).json({ error: 'Invalid roster_id' });
      if (!sleeper) return res.status(503).json({ error: 'Sleeper sync unavailable' });
      const horizon = parseHorizon(req.query.weeks);
      if (horizon == null) return res.status(400).json({ error: 'weeks must be 1, 2 or 4' });
      const week = parseWeek(req.query.week);
      if (week === null) return res.status(400).json({ error: 'Invalid week' });
      const qPriority = intIn(req.query.priority, 1, 20);
      const qAdds = intIn(req.query.adds_used, 0, 99);
      if (qPriority === null || qAdds === null) return res.status(400).json({ error: 'Invalid priority or adds_used' });
      const uid = req.query.user_id != null && /^\d{1,24}$/.test(String(req.query.user_id)) ? String(req.query.user_id) : null;
      // The league's own Sleeper profile (slots, Mon-Sun weeks, scoring); ?profile= overrides.
      const lc = await LC.sleeperRouteProfile({ sleeper, leagueId: lid, profileParam: req.query.profile != null && /^(\d{1,12}|hs)$/.test(String(req.query.profile)) ? String(req.query.profile) : undefined });
      if (lc.profile.aggregation === 'categories') return res.status(400).json(LC.NOT_POINTS);
      let b;
      try { ({ b } = await board(lc)); } catch (err) {
        if (err.status !== 503) log.error('[nba] waivers model:', err.message);
        return res.status(503).json({ error: 'NBA player data unavailable' });
      }
      let ctx;
      try { ctx = await sleeper.leagueContext(lid, uid); } catch (err) { const e = sleeperErr(err); return res.status(e.status).json(e.body); }
      const team = ctx.teams.find(t => t.team_key === rid);
      if (!team) return res.status(404).json({ error: 'Roster not in league', code: 'sleeper_not_found' });
      const byId = new Map(b.players.map(p => [String(p.id), p]));
      const unmatched = { roster: [], freeAgents: [] };
      const roster = [], ilIds = [];
      for (const id of team.players) {
        const p = byId.get(id);
        if (!p) { unmatched.roster.push({ player_key: id, name: `Player ${id}` }); continue; }
        roster.push(p);
        if (team.reserve.includes(id)) ilIds.push(String(p.id));
      }
      const owned = new Set(ctx.teams.flatMap(t => t.players));
      const pool = b.players.filter(p => !owned.has(String(p.id)));
      const data = loadData();
      const rosterSize = rosterSizeFrom({ roster_positions: ctx.league.roster_positions }) || Math.max(R.activeSpots(lc.profile), roster.length - ilIds.length);
      const priority = qPriority ?? (team.settings && Number.isFinite(Number(team.settings.waiver_position)) ? Number(team.settings.waiver_position) : undefined);
      const addsUsed = qAdds ?? undefined;
      const out = analyze({ roster, pool, b, horizon, week, rosterSize, data, ilIds, lc, waiverIds: [], priority, addsUsed });
      out.priority.source = qPriority != null ? 'input' : priority != null ? 'sleeper' : null;
      out.adds.source = qAdds != null ? 'input' : null;
      res.json({
        mode: 'sleeper', league_id: lid, roster_id: rid, team_name: team.name, league_name: ctx.league.name || null, asOf: b.asOf || null,
        rules: sleeperRules(ctx.league), weekDates: weekDates(data, null, lc.profile, lc.profileId),
        freeAgentCount: pool.length, unmatched, ...out,
      });
    })(req, res, next);
  });

  // ---- Yahoo (legacy; off unless NBA_YAHOO_ENABLED=1) ------------------------
  router.get('/api/nba/waivers', (req, res, next) => {
    if (yahooEnabled) return next();
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(410).json({ error: 'Yahoo sync is no longer offered; use league_id + roster_id (Sleeper) or the manual roster', code: 'yahoo_disabled' });
  });
  router.get('/api/nba/waivers', auth, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const uid = userId(req);
    const lk = String(req.query.league_key || '');
    const tk = String(req.query.team_key || '');
    if (!LEAGUE_KEY_RE.test(lk)) return res.status(400).json({ error: 'Invalid league_key' });
    if (!TEAM_KEY_RE.test(tk) || !tk.startsWith(lk + '.t.')) return res.status(400).json({ error: 'Invalid team_key' });
    const horizon = parseHorizon(req.query.weeks);
    if (horizon == null) return res.status(400).json({ error: 'weeks must be 1, 2 or 4' });
    const week = parseWeek(req.query.week);
    if (week === null) return res.status(400).json({ error: 'Invalid week' });
    const qPriority = intIn(req.query.priority, 1, 20);
    const qAdds = intIn(req.query.adds_used, 0, 99);
    if (qPriority === null || qAdds === null) return res.status(400).json({ error: 'Invalid priority or adds_used' });
    const lc = LC.profileFor({ leagueKey: lk });

    let model, b;
    try { ({ model, b } = await board(lc)); } catch (err) {
      if (err.status !== 503) log.error('[nba] waivers model:', err.message);
      return res.status(503).json({ error: 'NBA player data unavailable' });
    }
    let y;
    try {
      y = await apiCached(`nba:y:${uid}:waivers:${lk}:${tk}`, 60 * 1000, async () => {
        const c = clientFor(uid);
        const roster = await c.getRoster(tk);
        const fas = [];
        for (const [status, pages] of [['FA', FA_PAGES], ['W', W_PAGES]]) {
          for (let i = 0; i < pages; i++) {
            const page = await c.getPlayers(lk, { start: i * 25, count: 25, status });
            for (const p of page) fas.push({ ...p, waiver: status === 'W' });
            if (page.length < 25) break;
          }
        }
        let league = null;
        try { league = await c.getLeague(lk); } catch (e) { if (e && e.code === 'not_connected') throw e; }
        let state = { priority: null, addsUsed: null };
        try { state = await teamWaiverState(c, tk); } catch (e) { if (e && e.code === 'not_connected') throw e; }
        return { roster: roster.players || [], fas, league, state };
      });
    } catch (err) { return sendYahooError(res, err, uid); }

    const match = yp => {
      try { const m = model.matchYahooPlayer(yp, b.players); return m && m.player ? m : null; } catch { return null; }
    };
    const unmatched = { roster: [], freeAgents: [] };
    const roster = [];
    const ilIds = [];
    const seen = new Set();
    for (const yp of y.roster) {
      const m = match(yp);
      if (!m) { unmatched.roster.push({ player_key: yp.player_key, name: yp.name && yp.name.full }); continue; }
      if (seen.has(m.player.id)) continue;
      seen.add(m.player.id);
      roster.push(m.player);
      if (/^IL/i.test(String(yp.selected_position || ''))) ilIds.push(String(m.player.id));
    }
    const pool = [];
    const waiverIds = [];
    for (const yp of y.fas) {
      const m = match(yp);
      if (!m) { unmatched.freeAgents.push({ player_key: yp.player_key, name: yp.name && yp.name.full }); continue; }
      if (seen.has(m.player.id)) continue;
      seen.add(m.player.id);
      pool.push(m.player);
      if (yp.waiver) waiverIds.push(String(m.player.id));
    }
    const data = loadData();
    const rosterSize = rosterSizeFrom(y.league) || Math.max(R.activeSpots(lc.profile), roster.length - ilIds.length);
    // Yahoo league settings win over the stored profile for the add limit.
    const yr = waiverRules(y.league);
    if (yr.max_weekly_adds != null && Number.isFinite(Number(yr.max_weekly_adds)) && Number(yr.max_weekly_adds) > 0) lc.profile.maxAddsPerWeek = Number(yr.max_weekly_adds);
    const st = y.state || {};
    const priority = qPriority ?? st.priority ?? undefined;
    const addsUsed = qAdds ?? st.addsUsed ?? undefined;
    const out = analyze({ roster, pool, b, horizon, week, rosterSize, data, ilIds, lc, waiverIds, priority, addsUsed });
    out.priority.source = qPriority != null ? 'input' : st.priority != null ? 'yahoo' : null;
    out.adds.source = qAdds != null ? 'input' : st.addsUsed != null ? 'yahoo' : null;
    res.json({
      mode: 'yahoo', league_key: lk, team_key: tk, asOf: b.asOf || null,
      rules: yr, weekDates: weekDates(data, y.league, lc.profile, lc.profileId),
      freeAgentCount: pool.length, unmatched, ...out,
    });
  }));

  router.post('/api/nba/waivers/manual', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const wait = limited(String(req.ip || (req.socket && req.socket.remoteAddress) || 'anon'));
    if (wait) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ error: 'Too many requests — retry shortly' }); }
    next();
  }, express.json({ limit: '16kb' }), wrap(async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const ids = (v, max, name) => {
      if (v == null) return [];
      if (!Array.isArray(v) || v.length > max) throw Object.assign(new Error(`${name} must be an array of at most ${max} ids`), { status: 400 });
      const out = [];
      for (const x of v) {
        const s = String(x);
        if ((typeof x !== 'string' && typeof x !== 'number') || !ID_RE.test(s)) throw Object.assign(new Error(`Invalid id in ${name}`), { status: 400 });
        if (!out.includes(s)) out.push(s);
      }
      return out;
    };
    let rosterIds, poolIds, excludeIds;
    try {
      rosterIds = ids(body.roster, MAX_ROSTER, 'roster');
      poolIds = body.pool == null ? null : ids(body.pool, MAX_POOL, 'pool');
      excludeIds = ids(body.exclude, MAX_POOL, 'exclude');
    } catch (err) { return res.status(400).json({ error: err.message }); }
    if (!rosterIds.length) return res.status(400).json({ error: 'roster must list at least one player id' });
    const horizon = parseHorizon(body.weeks);
    if (horizon == null) return res.status(400).json({ error: 'weeks must be 1, 2 or 4' });
    const week = parseWeek(body.week);
    if (week === null) return res.status(400).json({ error: 'Invalid week' });
    const rs = body.rosterSize == null ? null : Number(body.rosterSize);
    if (rs != null && !(Number.isInteger(rs) && rs >= 6 && rs <= 20)) return res.status(400).json({ error: 'rosterSize must be 6-20' });
    const lid = body.league_id == null || body.league_id === '' ? null : String(body.league_id);
    if (lid != null && !/^(\d{1,10}|hs)$/.test(lid)) return res.status(400).json({ error: 'Invalid league_id' });
    const lc = LC.profileFor({ leagueId: lid });
    const priority = intIn(body.priority, 1, 20);
    const addsUsed = intIn(body.addsUsed, 0, 99);
    if (priority === null || addsUsed === null) return res.status(400).json({ error: 'Invalid priority or addsUsed' });
    let waiverIds;
    try { waiverIds = ids(body.waivers, MAX_POOL, 'waivers'); } catch (err) { return res.status(400).json({ error: err.message }); }

    let b;
    try { ({ b } = await board(lc)); } catch (err) {
      if (err.status !== 503) log.error('[nba] waivers model:', err.message);
      return res.status(503).json({ error: 'NBA player data unavailable' });
    }
    const byId = new Map(b.players.map(p => [String(p.id), p]));
    const unknown = [];
    const roster = rosterIds.map(id => byId.get(id) || (unknown.push(id), null)).filter(Boolean);
    const inRoster = new Set(roster.map(p => String(p.id)));
    const excl = new Set(excludeIds);
    const pool = poolIds
      ? poolIds.map(id => byId.get(id) || (unknown.push(id), null)).filter(p => p && !inRoster.has(String(p.id)))
      : b.players.filter(p => !inRoster.has(String(p.id)) && !excl.has(String(p.id)));
    const data = loadData();
    const out = analyze({ roster, pool, b, horizon, week, rosterSize: rs || R.activeSpots(lc.profile), data, lc, waiverIds, priority, addsUsed });
    res.json({ mode: 'manual', asOf: b.asOf || null, weekDates: weekDates(data, null, lc.profile, lc.profileId), freeAgentCount: pool.length, unknown, ...out });
  }));

  // Body-parser failures on the manual route → JSON, not the site's HTML error page.
  router.use('/api/nba/waivers', (err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) return res.status(400).json({ error: 'Invalid JSON body' });
    log.error('[nba] waivers:', err && err.message);
    res.status(500).json({ error: 'Waivers failed' });
  });

  return router;
};
module.exports.createRateLimiter = createRateLimiter;
module.exports.rosterSizeFrom = rosterSizeFrom;
module.exports.waiverRules = waiverRules;
module.exports.midWeekFrom = midWeekFrom;
module.exports.midWeekProfile = midWeekProfile;
module.exports.teamWaiverState = teamWaiverState;
