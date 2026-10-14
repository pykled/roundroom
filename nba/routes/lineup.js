// Weekly lineup picker API (stream D). Mounted from nba/router.js with one line:
//   router.use(require('./routes/lineup')({ auth, getAuth, apiCached, loadModel, modelPlayers, clientFor, sendYahooError, log }));
//
//   GET  /api/nba/lineup?league_key=&team_key=&week=[&day=][&banked=id:score,…][&locked=id,…][&opp=0]
//        Yahoo-first, signed-in only: loads the roster (and this week's opponent)
//        from Yahoo, maps players to the model with matchYahooPlayer.
//   POST /api/nba/lineup/manual  { roster:[{id,slot?,banked?,locked?,gamesLeft?}] | ids:[…], week, day?, opponent?:[ids] }
//        No auth; rate-limited per IP and size-limited.
// Response = nba/model/lineup.recommend() output + { source, roster, unmatched }.
'use strict';
const express = require('express');
const { recommend } = require('../model/lineup');

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

// Yahoo selected_position → our slot.
function yahooSlot(pos) {
  const u = String(pos || '').toUpperCase();
  if (u === 'G' || u === 'PG' || u === 'SG') return 'G';
  if (u === 'F' || u === 'SF' || u === 'PF' || u === 'C') return 'F';
  if (u === 'UTIL') return 'UTIL';
  if (u.startsWith('IL')) return 'IL';
  return 'BN';
}

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

function replacementFrom(players) {
  // Free-agent proxy: median per-game mean/sd of the players ranked 121-160 by value.
  const pool = players.filter(p => p.rank > 120 && p.rank <= 160 && p.mean > 0);
  if (pool.length < 10) return undefined;
  const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
  return { mean: med(pool.map(p => p.mean)), sd: med(pool.map(p => p.sd)), a: 0.9 };
}

function createLineupRoutes({
  auth, getAuth, apiCached, loadModel, modelPlayers, clientFor, sendYahooError,
  log = console, weekDates = defaultWeekDates, now = () => new Date(), rate = RATE,
} = {}) {
  if (typeof auth !== 'function' || typeof modelPlayers !== 'function') throw new Error('lineup routes: deps missing');
  const router = express.Router();

  async function board(week) {
    const data = await modelPlayers(week);
    return { players: data.players, currentWeek: data.currentWeek ?? week };
  }
  function clock(week, q) {
    const range = (weekDates() || {})[week] || null;
    const c = weekClock(range, now());
    const day = parseIntIn(q.day, 0, 14);
    const weekLength = parseIntIn(q.weekLength, 1, 14);
    return { weekLength: Number.isInteger(weekLength) ? weekLength : c.weekLength, day: Number.isInteger(day) ? day : c.day, dates: range };
  }

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

    let model, b;
    try {
      model = loadModel();
      if (week == null) week = Math.max(1, Number((await modelPlayers(null)).currentWeek) || 1);
      b = await board(week);
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
        slot: yahooSlot(p.selected_position), matchConfidence: m ? m.confidence : 0, matched: !!m,
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
      const c = clock(week, req.query);
      const out = recommend({
        roster: roster.map(r => (r.matched ? r : { id: r.id, name: r.name, slot: r.slot })),
        players: b.players, week, currentWeek: b.currentWeek, ...c, opponent,
        options: { replacement: replacementFrom(b.players) },
      });
      res.json({
        source: 'yahoo', league_key: lk, team_key: tk, dates: c.dates, currentWeek: b.currentWeek, ...out,
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
    const week = parseIntIn(body.week, 1, 30);
    if (week == null || Number.isNaN(week)) return res.status(400).json({ error: 'Invalid week' });
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
      if (gl !== undefined && !(Number.isInteger(gl) && gl >= 0 && gl <= 7)) return res.status(400).json({ error: 'Invalid gamesLeft' });
      roster.push({ id, slot: yahooSlot(e.slot), banked, locked: e.locked === true, gamesLeft: gl });
    }
    const oppRaw = Array.isArray(body.opponent) ? body.opponent : [];
    if (oppRaw.length > MAX_ROSTER) return res.status(400).json({ error: `At most ${MAX_ROSTER} opponent players` });
    const opp = oppRaw.map(String).filter(id => ID_RE.test(id));
    const day = parseIntIn(body.day, 0, 14);
    if (Number.isNaN(day)) return res.status(400).json({ error: 'Invalid day' });
    let b;
    try { b = await board(week); }
    catch (err) { log.error('[nba] lineup model:', err.message); return res.status(503).json({ error: 'NBA player data unavailable' }); }
    const c = clock(week, { day: body.day, weekLength: body.weekLength });
    const known = new Set(b.players.map(p => String(p.id)));
    let out;
    try {
      out = recommend({
        roster, players: b.players, week, currentWeek: b.currentWeek, ...c,
        opponent: opp.length ? { roster: opp.map(id => ({ id })) } : null,
        options: { replacement: replacementFrom(b.players) },
      });
    } catch (err) { log.error('[nba] lineup manual:', err.message); return res.status(500).json({ error: 'Could not build the lineup' }); }
    res.json({ source: 'manual', dates: c.dates, currentWeek: b.currentWeek, ...out, unmatched: roster.filter(r => !known.has(r.id)).map(r => ({ id: r.id })) });
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
