// Weekly lineup picker API (stream D). Mounted from nba/router.js with one line:
//   router.use(require('./routes/lineup')({ auth, getAuth, apiCached, loadModel, modelPlayers, clientFor, sendYahooError, log, sleeper, yahooEnabled }));
//
//   GET  /api/nba/lineup?league_id=&roster_id=&week=[&day=][&banked=id:score,…][&locked=id,…][&opp=0][&user_id=]
//        Sleeper-first (public data, rate-limited): the roster comes from the
//        league's rosters (player ids are the model's ids; `reserve` = IL), the
//        opponent from /league/{id}/matchups/{week}. Sleeper has no daily
//        lineup slots for NBA, so every active player enters as BN and the
//        optimizer assigns slots; `locked` pins a player.
//   GET  /api/nba/lineup?league_key=&team_key=&week=   (Yahoo; only when yahooEnabled, else 410)
//   POST /api/nba/lineup/manual  { roster:[{id,slot?,banked?,locked?,gamesLeft?}] | ids:[…], week?, day?, opponent?:[ids], league_id? }
//        No auth; rate-limited per IP and size-limited.
// League profile (L1): the league id in league_key (or league_id, default 242808)
// picks the profile; slots, matchup-week windows (incl. 14-day weeks) and the
// board's scoring all come from it. Each player's games left are his team's
// real game dates inside the window (proj.teamDates), from `day` on.
// Response = nba/model/lineup.recommend() output + { source, roster, unmatched }.
'use strict';
const express = require('express');
const { recommend } = require('../model/lineup');
const LC = require('./league-context');
const R = require('../model/roster-slots');

const LEAGUE_KEY_RE = /^\d+\.l\.\d+$/;
const TEAM_KEY_RE = /^\d+\.l\.\d+\.t\.\d+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const MAX_ROSTER = 20;
const RATE = { windowMs: 60 * 1000, max: 30 };

// Sleeper week date windows from the model's projection file (B's data layer).
function defaultWeekDates() {
  try { return require('../model/data').load().proj.weeks || {}; } catch { return {}; }
}
const dayNum = s => Math.floor(Date.parse(s + 'T00:00:00Z') / 86400000);
// "Today" in US/Eastern — NBA game days (and Yahoo's daily lineup) run on ET dates.
function todayEt(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
// { weekLength, day } for a [start, end] window; day = first unplayed day index.
function weekClock(range, now) {
  if (!range || !range[0] || !range[1]) return { weekLength: 7, day: 0 };
  const start = dayNum(range[0]), end = dayNum(range[1]);
  const weekLength = Math.max(1, end - start + 1);
  return { weekLength, day: Math.max(0, Math.min(weekLength, dayNum(todayEt(now)) - start)) };
}

function parseIntIn(v, lo, hi) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : NaN;
}
// "id:score,id:score" → Map
function parseBanked(s) {
  const out = new Map();
  for (const part of String(s || '').split(',').slice(0, MAX_ROSTER)) {
    const [id, v] = part.split(':');
    const x = Number(v);
    if (id && ID_RE.test(id) && Number.isFinite(x) && x >= 0 && x <= 300) out.set(id, x);
  }
  return out;
}
const parseIds = s => new Set(String(s || '').split(',').filter(id => ID_RE.test(id)).slice(0, MAX_ROSTER));

// Yahoo selected_position → the profile's slot (PG…UTIL, BN, IL).
const yahooSlot = (pos, profile) => R.slotOf(pos, profile);

// Thin local adapter (A's client has no matchups call): opponent team_key for a week.
// team/{key}/matchups;weeks=N — we scan the response for the other team_key in the
// same league rather than depend on the exact nesting (unverified against a real league).
async function getOpponentKey(client, teamKey, week) {
  const json = await client.request(`team/${encodeURIComponent(teamKey)}/matchups;weeks=${encodeURIComponent(week)}`);
  const league = teamKey.split('.t.')[0];
  const keys = new Set();
  (function walk(x) {
    if (!x || typeof x !== 'object') return;
    if (typeof x.team_key === 'string') keys.add(x.team_key);
    for (const v of Object.values(x)) walk(v);
  })(json);
  keys.delete(teamKey);
  return [...keys].find(k => k.startsWith(league + '.t.')) || null;
}

function createRateLimiter({ windowMs, max }, now = () => Date.now()) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'x';
    const t = now();
    let h = hits.get(ip);
    if (!h || t - h.start >= windowMs) { h = { start: t, n: 0 }; hits.set(ip, h); }
    if (++h.n > max) {
      res.setHeader('Retry-After', String(Math.ceil((h.start + windowMs - t) / 1000)));
      return res.status(429).json({ error: 'Too many lineup requests, slow down' });
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    next();
  };
}

function replacementFrom(players, profile) {
  // Free-agent proxy: median per-game mean/sd of the 40 players ranked just past
  // the league's drafted pool (teams × active spots; 242808: 169-208).
  const drafted = (profile.teams || 10) * R.activeSpots(profile);
  const pool = players.filter(p => p.rank > drafted && p.rank <= drafted + 40 && p.mean > 0);
  if (pool.length < 10) return undefined;
  const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
  return { mean: med(pool.map(p => p.mean)), sd: med(pool.map(p => p.sd)), a: 0.9 };
}

function createLineupRoutes({
  auth, getAuth, apiCached, loadModel, modelPlayers, clientFor, sendYahooError,
  log = console, weekDates = defaultWeekDates, now = () => new Date(), rate = RATE,
  sleeper = null, yahooEnabled = false,
} = {}) {
  if (typeof auth !== 'function' || typeof modelPlayers !== 'function') throw new Error('lineup routes: deps missing');
  const router = express.Router();
  const sleeperLimiter = createRateLimiter(rate);
  const { errorResponse: sleeperErr } = require('../sleeper/client');

  async function board(week, profileId) {
    const data = await modelPlayers(week, profileId || undefined);
    return { players: data.players, currentWeek: data.currentWeek ?? week };
  }
  function clock(week, q, lc) {
    const win = LC.windowFor(lc.profile, lc.profileId, week, weekDates());
    const range = win ? [win.start, win.end] : null;
    const c = weekClock(range, now());
    const day = parseIntIn(q.day, 0, 14);
    const weekLength = parseIntIn(q.weekLength, 1, 14);
    return { weekLength: Number.isInteger(weekLength) ? weekLength : c.weekLength, day: Number.isInteger(day) ? day : c.day, dates: range, window: win };
  }
  // Remaining game days per roster entry from the team schedule (unless the
  // caller gave gamesLeft): exact games left and back-to-backs in long weeks.
  function withGameDays(roster, players, win) {
    const td = win ? LC.teamDates() : null;
    if (!td) return roster;
    const byId = new Map(players.map(p => [String(p.id), p]));
    return roster.map(r => {
      const p = byId.get(String(r.id));
      if (!p || r.gamesLeft != null || !td[p.team]) return r;
      return { ...r, gameDays: R.gameDaysIn(td[p.team], win) };
    });
  }
  const meta = (lc, c) => ({ profile: LC.profileSummary(lc.profile, lc.profileId), window: c.window ? { week: c.window.week, start: c.window.start, end: c.window.end, days: c.window.days, playoffs: !!c.window.playoffs } : null });
  // Default week: the matchup week containing today (ET).
  async function defaultWeek(lc) {
    if (lc.profileId) return R.weekForDate(lc.profile, LC.todayEt(now())) || 1;
    return Math.max(1, Number((await modelPlayers(null)).currentWeek) || 1);
  }

  // ---- Sleeper (public league data) ----------------------------------------
  router.get('/api/nba/lineup', (req, res, next) => {
    if (req.query.league_id == null) return next();
    sleeperLimiter(req, res, async () => {
      res.setHeader('Cache-Control', 'private, no-store');
      const lid = String(req.query.league_id || '');
      const rid = String(req.query.roster_id || '');
      if (!/^\d{1,24}$/.test(lid)) return res.status(400).json({ error: 'Invalid league_id' });
      if (!/^\d{1,3}$/.test(rid)) return res.status(400).json({ error: 'Invalid roster_id' });
      if (!sleeper) return res.status(503).json({ error: 'Sleeper sync unavailable' });
      let week = parseIntIn(req.query.week, 1, 30);
      if (Number.isNaN(week)) return res.status(400).json({ error: 'Invalid week' });
      const day = parseIntIn(req.query.day, 0, 14);
      if (Number.isNaN(day)) return res.status(400).json({ error: 'Invalid day' });
      const uid = req.query.user_id != null && /^\d{1,24}$/.test(String(req.query.user_id)) ? String(req.query.user_id) : null;
      // Profile: the stored one for Dillon's league id (Yahoo-era id kept for 242808's
      // custom scoring/weeks), else High Score defaults; `league_id` may name a profile too.
      const lc = LC.profileFor({ leagueId: req.query.profile != null && /^(\d{1,12}|hs)$/.test(String(req.query.profile)) ? String(req.query.profile) : undefined });
      let model, b;
      try {
        model = loadModel();
        if (week == null) week = await defaultWeek(lc);
        b = await board(week, lc.profileId);
      } catch (err) { log.error('[nba] lineup model:', err.message); return res.status(503).json({ error: 'NBA player data unavailable' }); }
      let ctx;
      try { ctx = await sleeper.leagueContext(lid, uid); } catch (err) { const e = sleeperErr(err); return res.status(e.status).json(e.body); }
      const team = ctx.teams.find(t => t.team_key === rid);
      if (!team) return res.status(404).json({ error: 'Roster not in league', code: 'sleeper_not_found' });
      // The Sleeper league's roster shape wins over the stored profile's slots
      // (scoring and matchup weeks stay with the profile): UTIL×3 / BN×4 / IR×2 in Dillon's league.
      const counts = require('../sleeper/map').rosterPositionCounts(ctx.league.roster_positions);
      if (Object.keys(counts).some(k => k !== 'BN' && k !== 'IL')) {
        const slots = { PG: 0, SG: 0, G: 0, SF: 0, PF: 0, F: 0, C: 0, UTIL: 0, BN: 0, IL: 0 };
        for (const [k, n] of Object.entries(counts)) { if (k in slots) slots[k] += n; else if (k === 'FC' || k === 'F/C') slots.FC = (slots.FC || 0) + n; else slots.UTIL += n; }
        if (!slots.IL && Number((ctx.league.settings || {}).reserve_slots) > 0) slots.IL = Number(ctx.league.settings.reserve_slots);
        lc.profile = { ...lc.profile, slots, name: ctx.league.name || lc.profile.name, teams: Number(ctx.league.total_rosters) || lc.profile.teams };
        lc.profile.starters = R.starterCount(lc.profile); lc.profile.rosterSize = R.activeSpots(lc.profile) + R.ilSlots(lc.profile);
      }
      const byId = new Map(b.players.map(p => [String(p.id), p]));
      const banked = parseBanked(req.query.banked);
      const locked = parseIds(req.query.locked);
      const toRoster = (t, extras) => t.players.map(id => {
        const p = byId.get(id);
        const il = t.reserve.includes(id);
        return { id: p ? String(p.id) : `s:${id}`, player_key: id, name: p ? p.name : `Player ${id}`, slot: il ? 'IL' : 'BN', matched: !!p, matchConfidence: p ? 1 : 0, ...(extras && p ? extras(String(p.id)) : {}) };
      });
      const roster = toRoster(team, id => ({ banked: banked.get(id), locked: locked.has(id) }));
      let opponent = null, matchupError = null;
      if (req.query.opp !== '0') {
        try {
          const ms = await apiCached(`nba:sl:matchups:${lid}:${week}`, 5 * 60 * 1000, () => sleeper.client.leagueMatchups(lid, week));
          const mine = ms.find(m => m && String(m.roster_id) === rid);
          const opp = mine && mine.matchup_id != null ? ms.find(m => m && m.matchup_id === mine.matchup_id && String(m.roster_id) !== rid) : null;
          const ot = opp ? ctx.teams.find(t => t.team_key === String(opp.roster_id)) : null;
          if (ot) opponent = { name: ot.name, team_key: ot.team_key, roster: toRoster(ot).filter(r => r.matched) };
        } catch (err) { matchupError = 'Opponent roster unavailable'; }
      }
      const c = clock(week, req.query, lc);
      let out;
      try {
        out = recommend({
          roster: withGameDays(roster.map(r => (r.matched ? r : { id: r.id, name: r.name, slot: r.slot })), b.players, c.window),
          players: b.players, week, currentWeek: b.currentWeek, weekLength: c.weekLength, day: c.day, profile: lc.profile,
          opponent: opponent ? { ...opponent, roster: withGameDays(opponent.roster, b.players, c.window) } : null,
          options: { replacement: replacementFrom(b.players, lc.profile) },
        });
      } catch (err) { log.error('[nba] lineup sleeper:', err.message); return res.status(500).json({ error: 'Could not build the lineup' }); }
      res.json({
        source: 'sleeper', league_id: lid, roster_id: rid, team_name: team.name, league_name: ctx.league.name || null, dates: c.dates, currentWeek: b.currentWeek, ...meta(lc, c), ...out,
        roster: roster.map(r => ({ id: r.matched ? r.id : null, player_key: r.player_key, name: r.name, slot: r.slot, matchConfidence: r.matchConfidence })),
        unmatched: roster.filter(r => !r.matched).map(r => ({ player_key: r.player_key, name: r.name, slot: r.slot })),
        ...(matchupError ? { matchupError } : {}),
      });
    });
  });

  // ---- Yahoo (legacy; off unless NBA_YAHOO_ENABLED=1) ----------------------
  router.get('/api/nba/lineup', (req, res, next) => {
    if (yahooEnabled) return next();
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(410).json({ error: 'Yahoo sync is no longer offered; use league_id + roster_id (Sleeper) or the manual lineup', code: 'yahoo_disabled' });
  });
  router.get('/api/nba/lineup', auth, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const uid = (getAuth(req) || {}).userId;
    const lk = String(req.query.league_key || '');
    const tk = String(req.query.team_key || '');
    if (!LEAGUE_KEY_RE.test(lk)) return res.status(400).json({ error: 'Invalid league_key' });
    if (!TEAM_KEY_RE.test(tk) || !tk.startsWith(lk + '.t.')) return res.status(400).json({ error: 'Invalid team_key' });
    let week = parseIntIn(req.query.week, 1, 30);
    if (Number.isNaN(week)) return res.status(400).json({ error: 'Invalid week' });
    const day = parseIntIn(req.query.day, 0, 14);
    if (Number.isNaN(day)) return res.status(400).json({ error: 'Invalid day' });

    const lc = LC.profileFor({ leagueKey: lk });
    let model, b;
    try {
      model = loadModel();
      if (week == null) week = await defaultWeek(lc);
      b = await board(week, lc.profileId);
    }
    catch (err) { log.error('[nba] lineup model:', err.message); return res.status(503).json({ error: 'NBA player data unavailable' }); }

    const match = yp => {
      try { const m = model.matchYahooPlayer(yp, b.players); return m && m.player ? { id: String(m.player.id), confidence: m.confidence } : null; }
      catch { return null; }
    };
    const toRoster = (players, extras) => players.map(p => {
      const m = match(p);
      return {
        id: m ? m.id : `y:${p.player_key}`, player_key: p.player_key, name: (p.name && p.name.full) || p.player_key,
        slot: yahooSlot(p.selected_position, lc.profile), matchConfidence: m ? m.confidence : 0, matched: !!m,
        ...(extras && m ? extras(m.id) : {}),
      };
    });

    try {
      const client = clientFor(uid);
      const yr = await apiCached(`nba:y:${uid}:lineup-roster:${tk}:${week}`, 30 * 1000, () => client.getRoster(tk, week));
      const banked = parseBanked(req.query.banked);
      const locked = parseIds(req.query.locked);
      const roster = toRoster(yr.players || [], id => ({ banked: banked.get(id), locked: locked.has(id) }));
      let opponent = null, matchupError = null;
      if (req.query.opp !== '0') {
        try {
          const ok = await apiCached(`nba:y:${uid}:opp:${tk}:${week}`, 5 * 60 * 1000, () => getOpponentKey(client, tk, week));
          if (ok) {
            const or = await apiCached(`nba:y:${uid}:lineup-roster:${ok}:${week}`, 30 * 1000, () => client.getRoster(ok, week));
            opponent = { name: (or.team && or.team.name) || null, team_key: ok, roster: toRoster(or.players || []).filter(r => r.matched) };
          }
        } catch (err) {
          if (err && (err.code === 'not_connected' || err.code === 'invalid_grant')) throw err;
          matchupError = 'Opponent roster unavailable';
        }
      }
      const c = clock(week, req.query, lc);
      const out = recommend({
        roster: withGameDays(roster.map(r => (r.matched ? r : { id: r.id, name: r.name, slot: r.slot })), b.players, c.window),
        players: b.players, week, currentWeek: b.currentWeek, weekLength: c.weekLength, day: c.day, profile: lc.profile,
        opponent: opponent ? { ...opponent, roster: withGameDays(opponent.roster, b.players, c.window) } : null,
        options: { replacement: replacementFrom(b.players, lc.profile) },
      });
      res.json({
        source: 'yahoo', league_key: lk, team_key: tk, dates: c.dates, currentWeek: b.currentWeek, ...meta(lc, c), ...out,
        roster: roster.map(r => ({ id: r.matched ? r.id : null, player_key: r.player_key, name: r.name, slot: r.slot, matchConfidence: r.matchConfidence })),
        unmatched: roster.filter(r => !r.matched).map(r => ({ player_key: r.player_key, name: r.name, slot: r.slot })),
        ...(matchupError ? { matchupError } : {}),
      });
    } catch (err) { sendYahooError(res, err, uid); }
  });

  const limiter = createRateLimiter(rate);
  router.post('/api/nba/lineup/manual', limiter, express.json({ limit: '8kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let week = parseIntIn(body.week, 1, 30);
    if (Number.isNaN(week)) return res.status(400).json({ error: 'Invalid week' });
    const lid = body.league_id == null || body.league_id === '' ? null : String(body.league_id);
    if (lid != null && !/^(\d{1,10}|hs)$/.test(lid)) return res.status(400).json({ error: 'Invalid league_id' });
    const lc = LC.profileFor({ leagueId: lid });
    const raw = Array.isArray(body.roster) ? body.roster : Array.isArray(body.ids) ? body.ids.map(id => ({ id })) : null;
    if (!raw || !raw.length) return res.status(400).json({ error: 'roster required' });
    if (raw.length > MAX_ROSTER) return res.status(400).json({ error: `At most ${MAX_ROSTER} players` });
    const roster = [];
    for (const r of raw) {
      const e = typeof r === 'object' && r ? r : { id: r };
      const id = String(e.id ?? '');
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid player id' });
      const banked = e.banked == null || e.banked === '' ? undefined : Number(e.banked);
      if (banked !== undefined && !(Number.isFinite(banked) && banked >= 0 && banked <= 300)) return res.status(400).json({ error: 'Invalid banked score' });
      const gl = e.gamesLeft == null || e.gamesLeft === '' ? undefined : Number(e.gamesLeft);
      if (gl !== undefined && !(Number.isInteger(gl) && gl >= 0 && gl <= 14)) return res.status(400).json({ error: 'Invalid gamesLeft' });
      roster.push({ id, slot: yahooSlot(e.slot, lc.profile), banked, locked: e.locked === true, gamesLeft: gl });
    }
    const oppRaw = Array.isArray(body.opponent) ? body.opponent : [];
    if (oppRaw.length > MAX_ROSTER) return res.status(400).json({ error: `At most ${MAX_ROSTER} opponent players` });
    const opp = oppRaw.map(String).filter(id => ID_RE.test(id));
    const day = parseIntIn(body.day, 0, 14);
    if (Number.isNaN(day)) return res.status(400).json({ error: 'Invalid day' });
    let b;
    try {
      if (week == null) week = await defaultWeek(lc);
      b = await board(week, lc.profileId);
    }
    catch (err) { log.error('[nba] lineup model:', err.message); return res.status(503).json({ error: 'NBA player data unavailable' }); }
    const c = clock(week, { day: body.day, weekLength: body.weekLength }, lc);
    const known = new Set(b.players.map(p => String(p.id)));
    let out;
    try {
      out = recommend({
        roster: withGameDays(roster, b.players, c.window), players: b.players, week, currentWeek: b.currentWeek,
        weekLength: c.weekLength, day: c.day, profile: lc.profile,
        opponent: opp.length ? { roster: withGameDays(opp.map(id => ({ id })), b.players, c.window) } : null,
        options: { replacement: replacementFrom(b.players, lc.profile) },
      });
    } catch (err) { log.error('[nba] lineup manual:', err.message); return res.status(500).json({ error: 'Could not build the lineup' }); }
    res.json({ source: 'manual', dates: c.dates, currentWeek: b.currentWeek, ...meta(lc, c), ...out, unmatched: roster.filter(r => !known.has(r.id)).map(r => ({ id: r.id })) });
  });

  // Malformed / oversize JSON on the manual endpoint → JSON 400/413, not an HTML stack.
  router.use('/api/nba/lineup', (err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ error: 'Request too large' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    next(err);
  });

  return router;
}

module.exports = createLineupRoutes;
module.exports.getOpponentKey = getOpponentKey;
module.exports.weekClock = weekClock;
module.exports.yahooSlot = yahooSlot;
module.exports.parseBanked = parseBanked;
module.exports.createRateLimiter = createRateLimiter;
