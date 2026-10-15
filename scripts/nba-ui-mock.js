#!/usr/bin/env node
/* Dev-only mock server for the NBA pages (Sleeper-first). Serves nba/pages/* and
   /shared/* plus contract-shaped fake APIs, so the UI runs with no network, no
   model and a scripted Sleeper league. scripts/nba-sleeper-screens.py drives it.

   Usage
     node scripts/nba-ui-mock.js [--port=0] [--draft=predraft|noslot|live|paused|complete] [--interval=3] [--leagues=one|multi|zero] [--rr=3|0] [--api=ok|down|timeout|ratelimit|slow]
       --port      0 = ephemeral (printed on start)
       --profile   off  → GET /api/nba/league-profile 404s (page falls back to the built-in 242808 shape)
       --lean      1    → players carry no Yahoo-era fields (yahooElig/eligConfidence/yahooPid/…/vorp): keyed by Sleeper id
       --draft     predraft  draft_order set, no picks yet (scheduled start time in the future)
                   noslot    pre-draft, draft_order / slot_to_roster_id NOT set yet (slot picker must show)
                   live      drafting; a pick lands every --interval seconds (POST /__mock/advance forces picks)
                   paused    drafting but Sleeper says paused
                   complete  all picks made
       --leagues   one (default: 12-team 3RR points league) | multi (+ 10-team points league with a scheduled
                   draft, + 12-team categories league, + auction league) | zero
       --rr        3 (third-round reversal, default) | 0 (plain snake) for the main league
       --api       ok | down (every Sleeper endpoint 502) | timeout (504 sleeper_timeout) | ratelimit (429 + Retry-After)
                   | slow (3 s latency) | user404 (every username unknown)
   Runtime switch (handy for screenshots):
     POST /__mock/mode?draft=live&interval=2&reset=1&leagues=multi&rr=0&api=ok   → { mode }
     POST /__mock/advance?n=5                                                    → force n picks now
   Usernames: anything resolves to user 1044077615075872768 ("pykle") except "nobody"
   (404 sleeper_user_not_found) and "stranger" (a user with no team in the league). */
'use strict';
const path = require('path');
const express = require('express');
const M = require(path.join(__dirname, '..', 'nba', 'sleeper', 'map'));

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };

const mode = {
  draft: arg('draft', 'predraft'),
  interval: Number(arg('interval', 3)) || 3,
  profile: arg('profile', 'on') !== 'off',
  lean: arg('lean', '0') === '1',
  leagues: arg('leagues', 'one'),
  rr: Number(arg('rr', 3)) || 0,
  api: arg('api', 'ok'),
};

/* ------------------------------------------------------------- fixture */
// Real names/positions/ranks from Dillon's league (Yahoo player-list snapshot,
// data/nba/yahoo-snapshot-242808.json). Model numbers (mean, sd, games…) are
// synthesized from last season's fantasy points. Board ids are fake Sleeper ids.
const SNAP = require(path.join(ROOT, 'data/nba/yahoo-snapshot-242808.json')).players
  .filter(p => p.preRank != null).sort((a, b) => a.preRank - b.preRank);
const BOARD_N = 200;
const SNAP_BOARD = SNAP.slice(0, BOARD_N);
const SNAP_DEEP = SNAP.slice(BOARD_N); // drafted-but-not-on-board names for the unmatched path
const INJ = { 'Tyrese Haliburton': 'Out', 'Jayson Tatum': 'Out', 'Anthony Davis': 'Questionable', 'LeBron James': 'Day-To-Day',
  'Joel Embiid': 'Questionable', 'Zion Williamson': 'Questionable', 'Fred VanVleet': 'Out', 'Dejounte Murray': 'Out',
  'Kyrie Irving': 'Out', 'Tyler Herro': 'Out', 'Scoot Henderson': 'Out', 'Jaden Ivey': 'Questionable', 'Damian Lillard': 'Out' };

let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

function eligOf(pos) {
  const e = new Set();
  pos.forEach(p => { if (p === 'PG' || p === 'SG') e.add('G'); else e.add('F'); });
  e.add('UTIL');
  return ['G', 'F', 'UTIL'].filter(x => e.has(x));
}

const PLAYERS = SNAP_BOARD.map((y, i) => {
  const name = y.name, team = y.team, pos = y.pos.split(',');
  const rookie = !y.gp;
  const mean = +(rookie ? Math.max(18, 44 - y.preRank * 0.12) : y.fanPts / y.gp).toFixed(1);
  const sd = +(mean * (0.18 + rnd() * 0.08)).toFixed(1);
  const games = rnd() < 0.55 ? 4 : (rnd() < 0.85 ? 3 : 2);
  const hsValue = +(mean + sd * 0.94).toFixed(1);
  const cn = { 2: 0.564, 3: 0.846, 4: 1.029 }[games];
  return {
    id: String(1000 + i * 7), name, team, pos, elig: eligOf(pos), injury: INJ[name] || null,
    mean, sd, games, gamesByWeek: { 1: games }, hsValue, hsByWeek: { 1: +(mean + sd * cn).toFixed(1) },
    ceiling: +(mean + 1.2816 * sd).toFixed(1), floor: +(mean - 1.2816 * sd).toFixed(1),
    rank: 0, tier: 0, posRank: 0, sampleGames: rookie ? 0 : Math.min(82, y.gp),
    source: rookie ? 'rookie' : 'logs',
    yahooPid: y.pid, yahooPreRank: y.preRank, yahooPctRos: y.pctRos, _pos: y.pos
  };
}).sort((a, b) => b.hsValue - a.hsValue);
let tier = 1, inTier = 0;
PLAYERS.forEach((p, i) => {
  p.rank = i + 1;
  if (i > 0 && ((PLAYERS[i - 1].hsValue - p.hsValue >= 2.5 && inTier >= 4) || inTier >= 14)) { tier++; inTier = 0; }
  inTier++;
  p.tier = tier;
});
['G', 'F'].forEach(pos => { let n = 0; PLAYERS.forEach(p => { if (p.elig[0] === pos) p.posRank = ++n; }); });

const PROFILE = {
  leagueId: '242808', name: 'HALIMSANITY 26-27', teams: 12, draft: { type: 'snake', pickSeconds: 90 }, positionSource: 'sleeper',
  scoring: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, pf: -1, tech: -1, dd: 5, td: 3 }, flags: { tdAlsoCountsDD: true },
  slots: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2, BN: 5, IL: 2 }, starters: 9, rosterSize: 16,
  weeks: [{ week: 1, start: '2026-10-20', end: '2026-10-25', days: 6 }, { week: 2, start: '2026-10-26', end: '2026-11-01', days: 7 }],
  maxAddsPerWeek: 10, tradeEnd: '2027-03-04'
};
// Slot eligibility from the position string (Sleeper-first: eligConfidence 'sleeper').
const TOK = { PG: ['PG', 'G'], SG: ['SG', 'G'], SF: ['SF', 'F'], PF: ['PF', 'F'], C: ['C'] };
const SLOT_ORDER = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'];
PLAYERS.forEach((p, i) => {
  const set = new Set(['UTIL']);
  p._pos.split(',').forEach(t => (TOK[t] || []).forEach(x => set.add(x)));
  p.yahooElig = SLOT_ORDER.filter(x => set.has(x));
  p.eligConfidence = i % 17 === 5 ? 'sleeper-mapped' : 'sleeper';
  delete p._pos;
});
const repl = {};
SLOT_ORDER.forEach(sl => {
  const el = PLAYERS.filter(p => p.yahooElig.includes(sl));
  const n = sl === 'UTIL' ? 12 * 9 + 12 : 12 * PROFILE.slots[sl] + 6;
  repl[sl] = (el[Math.min(el.length - 1, n - 1)] || {}).hsValue || 0;
});
PLAYERS.forEach(p => {
  p.vorpBySlot = {};
  p.yahooElig.forEach(sl => { p.vorpBySlot[sl] = +(p.hsValue - repl[sl]).toFixed(1); });
  const pos = Object.keys(p.vorpBySlot).filter(k => k !== 'UTIL');
  p.vorp = Math.max.apply(null, (pos.length ? pos : ['UTIL']).map(k => p.vorpBySlot[k]));
});
const LEAN_FIELDS = ['yahooElig', 'eligConfidence', 'vorp', 'vorpBySlot', 'yahooPid', 'yahooPreRank', 'yahooPctRos'];
const leanPlayers = () => PLAYERS.map(p => { const q = Object.assign({}, p); LEAN_FIELDS.forEach(k => delete q[k]); return q; });

/* ---------------------------------------------------------- sleeper mock */
const USER = { user_id: '1044077615075872768', username: 'pykle', display_name: 'pykle', avatar: null };
const STRANGER = { user_id: '999000111222333444', username: 'stranger', display_name: 'stranger', avatar: null };
const NTEAMS = 12, ROUNDS = 13, MY_SLOT = 5, MY_ROSTER = 5;
const TEAM_NAMES = ['Splash Bros', 'Glass Cleaners', 'Paint Protectors', 'Euro Steps', 'Your Team', 'Fast Breakers', 'Bench Mob', 'Lob City', 'Triple Doubles', 'Corner Threes', 'Iso Joes', 'Pick & Pop'];
const LID = '1411447094215991296', DID = '1411447094215991297';
const SEASON = '2026';
const START = Date.now() + 36 * 3600 * 1000; // scheduled draft: tomorrow-ish
// Slot i (1..12) → roster i (identity map keeps the mock readable); my roster 5 = slot 5.
const slot2roster = () => Object.fromEntries(Array.from({ length: NTEAMS }, (_, i) => [String(i + 1), i + 1]));
const userIdOf = r => r === MY_ROSTER ? USER.user_id : String(700000000000000000 + r);
const draftOrder = () => Object.fromEntries(Array.from({ length: NTEAMS }, (_, i) => [userIdOf(i + 1), i + 1]));

const LEAGUES = {
  [LID]: { league_id: LID, name: 'HALIMSANITY 26-27', season: SEASON, status: 'in_season', total_rosters: NTEAMS, draft_id: DID,
    roster_positions: ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'UTIL', 'BN', 'BN', 'BN', 'BN', 'BN'],
    settings: { num_teams: NTEAMS, reserve_slots: 2, playoff_week_start: 20, playoff_teams: 6, waiver_type: 0, waiver_budget: 100, type: 0, trade_deadline: 17, start_week: 1, leg: 1 },
    scoring_settings: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, pf: -1, tf: -1, dd: 5, td: 3 } },
  '1500000000000000001': { league_id: '1500000000000000001', name: 'Ten Team Points', season: SEASON, status: 'pre_draft', total_rosters: 10, draft_id: '1500000000000000002',
    roster_positions: ['G', 'G', 'F', 'F', 'F', 'UTIL', 'BN', 'BN', 'BN', 'BN'], settings: { num_teams: 10, reserve_slots: 0, type: 0 }, scoring_settings: { pts: 1, reb: 1, ast: 2, stl: 3, blk: 3 } },
  '1500000000000000003': { league_id: '1500000000000000003', name: 'Office Cats', season: SEASON, status: 'pre_draft', total_rosters: 12, draft_id: '1500000000000000004',
    roster_positions: ['PG', 'SG', 'SF', 'PF', 'C', 'UTIL', 'UTIL', 'BN', 'BN', 'BN'], settings: { num_teams: 12, reserve_slots: 1, type: 0, scoring_type: 'categories' }, scoring_settings: null },
  '1500000000000000005': { league_id: '1500000000000000005', name: 'Auction Night', season: SEASON, status: 'pre_draft', total_rosters: 12, draft_id: '1500000000000000006',
    roster_positions: ['G', 'G', 'F', 'F', 'C', 'UTIL', 'BN', 'BN'], settings: { num_teams: 12, reserve_slots: 0, type: 0 }, scoring_settings: { pts: 1 } },
};
const OTHER_DRAFT = {
  '1500000000000000002': { league_id: '1500000000000000001', type: 'snake', status: 'pre_draft', start_time: START, teams: 10, rounds: 10, rr: 0, pick_timer: 60, mySlot: 4, myRoster: 4 },
  '1500000000000000004': { league_id: '1500000000000000003', type: 'snake', status: 'pre_draft', start_time: START + 86400000, teams: 12, rounds: 10, rr: 0, pick_timer: 90, mySlot: 2, myRoster: 2, scoring_type: 'categories' },
  '1500000000000000006': { league_id: '1500000000000000005', type: 'auction', status: 'pre_draft', start_time: null, teams: 12, rounds: 8, rr: 0, pick_timer: 60, mySlot: 1, myRoster: 1 },
};
const leagueIds = () => mode.leagues === 'zero' ? [] : mode.leagues === 'multi' ? Object.keys(LEAGUES) : [LID];

const picks = []; // raw Sleeper pick rows for the main draft
let lastPicked = 0;
function status() { return mode.draft === 'complete' || picks.length >= NTEAMS * ROUNDS ? 'complete' : mode.draft === 'live' ? 'drafting' : mode.draft === 'paused' ? 'paused' : 'pre_draft'; }
const full = () => picks.length >= NTEAMS * ROUNDS;
function mainDraft() {
  const noslot = mode.draft === 'noslot';
  return {
    draft_id: DID, league_id: LID, sport: 'nba', type: 'snake', season: SEASON, status: status(),
    start_time: status() === 'pre_draft' ? START : Date.now() - 600000, last_picked: lastPicked || null,
    settings: { teams: NTEAMS, rounds: ROUNDS, pick_timer: 30, reversal_round: mode.rr, slots_pg: 1, slots_sg: 1, slots_g: 1, slots_sf: 1, slots_pf: 1, slots_f: 1, slots_c: 1, slots_util: 2, slots_bn: 5, cpu_autopick: 1 },
    metadata: { scoring_type: 'std', name: 'HALIMSANITY 26-27', is_autopaused: String(mode.draft === 'paused') },
    draft_order: noslot ? null : draftOrder(), slot_to_roster_id: noslot ? null : slot2roster(),
  };
}
function otherDraft(id) {
  const d = OTHER_DRAFT[id];
  if (!d) return null;
  const s2r = Object.fromEntries(Array.from({ length: d.teams }, (_, i) => [String(i + 1), i + 1]));
  const order = Object.fromEntries(Array.from({ length: d.teams }, (_, i) => [i + 1 === d.myRoster ? USER.user_id : String(800000000000000000 + i), i + 1]));
  return { draft_id: id, league_id: d.league_id, sport: 'nba', type: d.type, season: SEASON, status: d.status, start_time: d.start_time, last_picked: null,
    settings: { teams: d.teams, rounds: d.rounds, pick_timer: d.pick_timer, reversal_round: d.rr }, metadata: { scoring_type: d.scoring_type || 'std' },
    draft_order: order, slot_to_roster_id: s2r };
}
function draftById(id) { return id === DID ? mainDraft() : otherDraft(id); }

function fullOrder(d) { return M.pickOrder(d, []); }
function makePick() {
  const d = mainDraft();
  if (full()) return null;
  const order = fullOrder(d);
  const pickNo = picks.length + 1;
  const o = order[pickNo - 1];
  if (!o) return null;
  const taken = new Set(picks.map(p => p.player_id));
  let row;
  // Every 9th pick: a deep player not on the 200-player board (unmatched → review path).
  if (pickNo % 9 === 0) {
    const deep = SNAP_DEEP.find(y => !taken.has('99' + y.pid));
    if (deep) row = { pick_no: pickNo, round: o.round, draft_slot: o.slot, roster_id: Number(o.team_key), picked_by: userIdOf(Number(o.team_key)), player_id: '99' + deep.pid, is_keeper: null,
      metadata: { first_name: deep.name.split(' ')[0], last_name: deep.name.split(' ').slice(1).join(' '), team: deep.team, position: deep.pos.split(',')[0] } };
  }
  if (!row) {
    const avail = PLAYERS.filter(p => !taken.has(p.id));
    const pool = avail.slice(0, 3);
    const pl = pool[Math.floor(rnd() * pool.length)] || avail[0];
    if (!pl) return null;
    row = { pick_no: pickNo, round: o.round, draft_slot: o.slot, roster_id: Number(o.team_key), picked_by: userIdOf(Number(o.team_key)), player_id: pl.id, is_keeper: null,
      metadata: { first_name: pl.name.split(' ')[0], last_name: pl.name.split(' ').slice(1).join(' '), team: pl.team, position: pl.pos[0] } };
  }
  picks.push(row);
  lastPicked = Date.now();
  return row;
}
let timer = null;
function schedule() {
  clearInterval(timer); timer = null;
  if (mode.draft === 'live') timer = setInterval(makePick, mode.interval * 1000);
}
function fill() { while (makePick()) { /* complete */ } }
schedule();
if (mode.draft === 'complete') fill();

const byId = new Map(PLAYERS.map(p => [p.id, p]));
function resolve(pid, md) {
  if (byId.has(pid)) return { id: pid, confidence: 1 };
  const name = md && [md.first_name, md.last_name].filter(Boolean).join(' ');
  const hit = name && PLAYERS.find(p => p.name === name);
  return hit ? { id: hit.id, confidence: 0.95 } : { id: null, confidence: 0 };
}

function teamsFor(lid, d) {
  const n = LEAGUES[lid].total_rosters;
  const dd = d || draftById(LEAGUES[lid].draft_id);
  const myR = lid === LID ? MY_ROSTER : (OTHER_DRAFT[LEAGUES[lid].draft_id] || {}).myRoster;
  return Array.from({ length: n }, (_, i) => {
    const r = i + 1;
    const dp = dd && dd.slot_to_roster_id ? Number(Object.keys(dd.slot_to_roster_id).find(s => dd.slot_to_roster_id[s] === r)) : null;
    return { team_key: String(r), roster_id: r, user_id: r === myR ? USER.user_id : String(700000000000000000 + r), name: lid === LID ? TEAM_NAMES[i] : 'Team ' + r, display_name: r === myR ? 'pykle' : 'user' + r, avatar: null, draft_position: dp || null, co_owners: [] };
  });
}

/* ------------------------------------------------------------- server */
const app = express();
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get(['/nba', '/nba/draft'], (req, res) => res.sendFile(path.join(ROOT, 'nba/pages/draft.html')));
app.get('/nba/lineup', (req, res) => res.sendFile(path.join(ROOT, 'nba/pages/lineup.html')));
app.get('/nba/trade', (req, res) => res.sendFile(path.join(ROOT, 'nba/pages/trade.html')));
app.get('/nba/waivers', (req, res) => res.sendFile(path.join(ROOT, 'nba/pages/waivers.html')));
app.use('/nba/pages', express.static(path.join(ROOT, 'nba/pages')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.get('/favicon.png', (req, res) => res.sendFile(path.join(ROOT, 'favicon.png')));

app.get('/api/nba/players', (req, res) => res.json({ season: SEASON, week: Number(req.query.week) || 1, profile: req.query.profile || null, asOf: new Date().toISOString(), players: mode.lean ? leanPlayers() : PLAYERS }));
app.get('/api/nba/league-profile', (req, res) => {
  if (!mode.profile) return res.status(404).json({ error: 'not_found' });
  if (req.query.league_id && req.query.league_id !== '242808') return res.status(404).json({ error: 'unknown_league' });
  res.json(PROFILE);
});
app.get('/api/nba/health', (req, res) => res.json({ ok: true, sleeper: true, yahooEnabled: false, yahooConfigured: false, modelAsOf: new Date().toISOString() }));
app.all(['/api/nba/yahoo', '/api/nba/yahoo/*'], (req, res) => res.status(410).json({ error: 'gone', code: 'yahoo_disabled' }));
app.get('/nba/auth/login', (req, res) => res.redirect('/nba?connect=sleeper'));

// Outage simulation applies to every Sleeper-backed endpoint.
function outage(req, res, next) {
  if (mode.api === 'down') return res.status(502).json({ error: 'Sleeper is having trouble — try again in a minute', code: 'sleeper_upstream' });
  if (mode.api === 'timeout') return res.status(504).json({ error: 'Sleeper timed out — try again in a moment', code: 'sleeper_timeout' });
  if (mode.api === 'ratelimit') { res.set('Retry-After', '5'); return res.status(429).json({ error: 'Sleeper is rate-limiting us — retry in a few seconds', code: 'sleeper_rate_limited', retryAfterS: 5 }); }
  if (mode.api === 'slow') return setTimeout(next, 3000);
  next();
}
app.use('/api/nba/sleeper', outage);

app.get('/api/nba/sleeper/user', (req, res) => {
  const u = String(req.query.username || '').replace(/^@/, '');
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(u)) return res.status(400).json({ error: 'Enter a Sleeper username (letters, numbers, _ . -)', code: 'sleeper_bad_request' });
  if (u.toLowerCase() === 'nobody' || mode.api === 'user404') return res.status(404).json({ error: `No Sleeper user named “${u}” — check the spelling`, code: 'sleeper_user_not_found' });
  if (u.toLowerCase() === 'stranger') return res.json(STRANGER);
  res.json({ ...USER, username: u, display_name: u });
});
app.get('/api/nba/sleeper/leagues', (req, res) => {
  const uid = String(req.query.user_id || '');
  if (!/^\d{1,24}$/.test(uid)) return res.status(400).json({ error: 'Invalid user_id', code: 'sleeper_bad_request' });
  const leagues = leagueIds().map(id => M.leagueSummary(LEAGUES[id], draftById(LEAGUES[id].draft_id)));
  res.json({ season: SEASON, user_id: uid, user: uid === STRANGER.user_id ? STRANGER : USER, leagues });
});
app.get('/api/nba/sleeper/league', (req, res) => {
  const lid = String(req.query.league_id || '');
  if (!LEAGUES[lid]) return res.status(404).json({ error: 'League not found on Sleeper', code: 'sleeper_not_found' });
  const d = draftById(LEAGUES[lid].draft_id);
  const teams = teamsFor(lid, d);
  const uid = String(req.query.user_id || '');
  const mine = teams.find(t => t.user_id === uid) || null;
  res.json({ league: M.leagueMeta(LEAGUES[lid]), draft: M.draftMeta(d), support: M.classifyLeague(LEAGUES[lid], d), teams, myTeamKey: mine ? mine.team_key : null, mySlot: mine ? mine.draft_position : null });
});
app.get('/api/nba/sleeper/draft', (req, res) => {
  const did = String(req.query.draft_id || '');
  const d = draftById(did);
  if (!d) return res.status(404).json({ error: 'Draft not found on Sleeper', code: 'sleeper_not_found' });
  const meta = M.draftMeta(d);
  const raw = did === DID ? picks : [];
  const { picks: ps, unmatched } = M.normalizePicks(raw, resolve);
  const made = new Set(ps.map(p => p.pick));
  const order = M.pickOrder(d, []).filter(o => !made.has(o.pick));
  res.json({ status: meta.status, paused: meta.raw_status === 'paused', picks: ps, unmatched, order, onClock: meta.status === 'drafting' && order[0] ? order[0] : null, auction: meta.type === 'auction', draft: meta, polledAt: new Date().toISOString() });
});
app.get('/api/nba/sleeper/rosters', (req, res) => {
  const lid = String(req.query.league_id || '');
  if (!LEAGUES[lid]) return res.status(404).json({ error: 'League not found on Sleeper', code: 'sleeper_not_found' });
  const teams = teamsFor(lid).map(t => ({ ...t, mine: t.user_id === String(req.query.user_id || ''), players: [] }));
  res.json({ league: M.leagueMeta(LEAGUES[lid]), draft: M.draftMeta(draftById(LEAGUES[lid].draft_id)), teams, myTeamKey: (teams.find(t => t.mine) || {}).team_key || null, unmatched: [] });
});

app.post('/__mock/mode', (req, res) => {
  if (req.query.draft) mode.draft = req.query.draft;
  if (req.query.interval) mode.interval = Number(req.query.interval) || mode.interval;
  if (req.query.reset) { picks.length = 0; lastPicked = 0; }
  if (req.query.profile) mode.profile = req.query.profile !== 'off';
  if (req.query.lean != null) mode.lean = req.query.lean === '1';
  if (req.query.leagues) mode.leagues = req.query.leagues;
  if (req.query.rr != null) mode.rr = Number(req.query.rr) || 0;
  if (req.query.api) mode.api = req.query.api;
  if (mode.draft === 'complete') fill();
  schedule();
  res.json({ mode, picks: picks.length });
});
app.post('/__mock/advance', (req, res) => {
  const n = Math.max(1, Math.min(NTEAMS * ROUNDS, Number(req.query.n) || 1));
  if (mode.draft === 'predraft' || mode.draft === 'noslot') mode.draft = 'live';
  for (let i = 0; i < n; i++) makePick();
  res.json({ mode, picks: picks.length });
});

const server = app.listen(Number(arg('port', 0)), '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`nba-ui-mock listening on http://127.0.0.1:${port}/nba  (draft=${mode.draft}, leagues=${mode.leagues}, rr=${mode.rr}, api=${mode.api}, ${PLAYERS.length} players)`);
});
