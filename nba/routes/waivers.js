// Pocket NBA waivers / streaming API (stream F). Mounted with one line in nba/router.js:
//   router.use(require('./routes/waivers')({ auth, getAuth, apiCached, loadModel, clientFor, sendYahooError, modelPlayers, log }));
//
//   GET  /api/nba/waivers?league_key=&team_key=&weeks=1|2|4[&week=]   (Clerk auth; Yahoo-first)
//   POST /api/nba/waivers/manual { roster:[ids], pool?:[ids], exclude?:[ids], weeks?, week?, rosterSize? }
//        (public, rate limited, 16 KB body cap; no pool → every model player not on the roster)
// Method: docs/nba-waivers.md. Engine: nba/model/waivers.js.
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const W = require('../model/waivers');

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

function weekDates(data, league) {
  const out = {};
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

module.exports = function waiversRoutes({
  auth, getAuth, apiCached, loadModel, clientFor, sendYahooError, modelPlayers,
  loadData = defaultLoadData, log = console, rate = RATE, now, env = process.env,
} = {}) {
  const router = express.Router();
  // Express 4 doesn't catch async handler rejections; route them to the JSON error handler.
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.get('/nba/waivers', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let html;
    try { html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'waivers.html'), 'utf8'); } catch { return res.status(404).send('Not found'); }
    res.send(html.replace(/PUBLISHABLE_KEY_PLACEHOLDER/g, env.CLERK_PUBLISHABLE_KEY || ''));
  });
  const limited = createRateLimiter(rate, now);
  const userId = req => (getAuth(req) || {}).userId || null;

  async function board() {
    const model = loadModel();
    if (!model || model.stub) { const e = new Error('NBA model not available'); e.status = 503; throw e; }
    const b = modelPlayers ? await modelPlayers(null) : await apiCached('nba:players:default', 10 * 60 * 1000, () => model.getPlayers({}));
    return { model, b };
  }

  function analyze({ roster, pool, b, horizon, week, rosterSize, data, ilIds }) {
    const ids = [...roster, ...pool].map(p => String(p.id));
    const roles = W.roleSignalsFromData(data, ids);
    const startWeek = week || b.currentWeek || b.week || undefined;
    const midWeek = midWeekFrom(data, now ? new Date(now()) : new Date());
    const out = W.analyzeWaivers({ roster, pool, horizon, startWeek, roles, rosterSize, ilIds, midWeek });
    if (out.midWeek && midWeek) out.midWeek.source = midWeek.source;
    return out;
  }

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

    let model, b;
    try { ({ model, b } = await board()); } catch (err) {
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
        return { roster: roster.players || [], fas, league };
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
    const rosterSize = rosterSizeFrom(y.league) || Math.max(10, roster.length - ilIds.length);
    const out = analyze({ roster, pool, b, horizon, week, rosterSize, data, ilIds });
    const onWaivers = new Set(waiverIds);
    for (const t of out.targets) t.onWaivers = onWaivers.has(t.id);
    res.json({
      mode: 'yahoo', league_key: lk, team_key: tk, asOf: b.asOf || null,
      rules: waiverRules(y.league), weekDates: weekDates(data, y.league),
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

    let b;
    try { ({ b } = await board()); } catch (err) {
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
    const out = analyze({ roster, pool, b, horizon, week, rosterSize: rs || Math.max(10, roster.length), data });
    res.json({ mode: 'manual', asOf: b.asOf || null, weekDates: weekDates(data, null), freeAgentCount: pool.length, unknown, ...out });
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
