#!/usr/bin/env node
/* Dev-only mock server for the NBA draft board (stream C). Serves nba/pages/*
   and /shared/* plus contract-shaped fake APIs, so the UI runs with no Yahoo,
   no model and no stream A/B code present.

   Usage
     node scripts/nba-ui-mock.js [--port=0] [--yahoo=off|on|live|degraded] [--interval=3] [--profile=on|off] [--lean=1]
       --port      0 = ephemeral (printed on start)
       --profile   off  → GET /api/nba/league-profile 404s (page falls back to the built-in 242808 shape)
       --lean      1    → players carry no Yahoo fields (yahooElig/eligConfidence/yahooPid/yahooPreRank/
                          yahooPctRos/vorp/vorpBySlot): pre-H1 model, keyed by Sleeper id
       --yahoo     off      status.connected = false (manual mode)
                   on       connected, draft predraft (no picks yet)
                   live     connected, a pick lands every --interval seconds
                   degraded connected, but /api/nba/yahoo/draft returns 503
   Runtime switch (handy for screenshots):
     POST /__mock/mode?yahoo=live&interval=2&reset=1&profile=off&lean=1   → { mode, picks }
     POST /__mock/advance?n=5                          → force n picks now
   /nba/auth/login simulates a successful Yahoo connect (mode → on) and redirects to /nba. */
'use strict';
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };

let mode = arg('yahoo', 'off');
let intervalSec = Number(arg('interval', 3)) || 3;
let profileOn = arg('profile', 'on') !== 'off';
let lean = arg('lean', '0') === '1';

/* ------------------------------------------------------------- fixture */
// Real names/positions/ranks from Dillon's league (Yahoo player-list snapshot,
// data/nba/yahoo-snapshot-242808.json, copied from branch nba). Model numbers
// (mean, sd, games…) are synthesized from last season's Yahoo fantasy points.
const SNAP = require(path.join(ROOT, 'data/nba/yahoo-snapshot-242808.json')).players
  .filter(p => p.preRank != null).sort((a, b) => a.preRank - b.preRank);
const BOARD_N = 200;
const SNAP_BOARD = SNAP.slice(0, BOARD_N);
const SNAP_DEEP = SNAP.slice(BOARD_N); // drafted-but-not-on-board names for the unmatched path
const INJ = { 'Tyrese Haliburton': 'Out', 'Jayson Tatum': 'Out', 'Anthony Davis': 'Questionable', 'LeBron James': 'Day-To-Day',
  'Joel Embiid': 'Questionable', 'Zion Williamson': 'Questionable', 'Fred VanVleet': 'Out', 'Dejounte Murray': 'Out',
  'Kyrie Irving': 'Out', 'Tyler Herro': 'Out', 'Scoot Henderson': 'Out', 'Jaden Ivey': 'Questionable', 'Damian Lillard': 'Out' };

// Deterministic PRNG so the fixture (and screenshots) are stable run to run.
let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

function eligOf(pos) {
  const e = new Set();
  pos.forEach(p => { if (p === 'PG' || p === 'SG') e.add('G'); else e.add('F'); }); // C counts as F
  e.add('UTIL');
  return ['G', 'F', 'UTIL'].filter(x => e.has(x));
}

const PLAYERS = SNAP_BOARD.map((y, i) => {
  const name = y.name, team = y.team, pos = y.pos.split(',');
  const rookie = !y.gp;
  // Last season's Yahoo fantasy points per game; rookies get a rank-based guess.
  const mean = +(rookie ? Math.max(18, 44 - y.preRank * 0.12) : y.fanPts / y.gp).toFixed(1);
  const sd = +(mean * (0.18 + rnd() * 0.08)).toFixed(1);
  const games = rnd() < 0.55 ? 4 : (rnd() < 0.85 ? 3 : 2);
  // E[max of n normals] ≈ mean + sd·c(n); c(2)=.564, c(3)=.846, c(4)=1.029. Pre-draft hsValue uses the 3.5-game typical week.
  const hsValue = +(mean + sd * 0.94).toFixed(1);
  const cn = { 2: 0.564, 3: 0.846, 4: 1.029 }[games];
  return {
    id: String(1000 + i * 7), name, team, pos, elig: eligOf(pos), injury: INJ[name] || null,
    mean, sd, games, gamesByWeek: { 1: games }, hsValue, hsByWeek: { 1: +(mean + sd * cn).toFixed(1) },
    ceiling: +(mean + 1.2816 * sd).toFixed(1), floor: +(mean - 1.2816 * sd).toFixed(1),
    rank: 0, tier: 0, posRank: 0, sampleGames: rookie ? 0 : Math.min(82, y.gp),
    source: rookie ? 'rookie' : 'logs',
    yahooPid: y.pid, yahooPreRank: y.preRank, yahooPctRos: y.pctRos, _yahooPos: y.pos
  };
}).sort((a, b) => b.hsValue - a.hsValue);
// rank + tiers (break where the gap to the next player is large)
let tier = 1, inTier = 0;
PLAYERS.forEach((p, i) => {
  p.rank = i + 1;
  // new tier on a real value cliff (>= 2.5) once the tier has 4+ players, or every 14
  if (i > 0 && ((PLAYERS[i - 1].hsValue - p.hsValue >= 2.5 && inTier >= 4) || inTier >= 14)) { tier++; inTier = 0; }
  inTier++;
  p.tier = tier;
});
['G', 'F'].forEach(pos => { let n = 0; PLAYERS.forEach(p => { if (p.elig[0] === pos) p.posRank = ++n; }); });

/* --------------------------------------------- league 242808 profile (H1 shape) */
const PROFILE = {
  leagueId: '242808', name: 'HALIMSANITY 26-27', teams: 12, draft: { type: 'snake', pickSeconds: 90 },
  scoring: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, pf: -1, tech: -1, dd: 5, td: 3 }, flags: { tdAlsoCountsDD: true },
  slots: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2, BN: 5, IL: 2 }, starters: 9, rosterSize: 16,
  weeks: [{ week: 1, start: '2026-10-20', end: '2026-10-25', days: 6 }, { week: 2, start: '2026-10-26', end: '2026-11-01', days: 7 }],
  maxAddsPerWeek: 10, tradeEnd: '2027-03-04'
};
// Yahoo eligibility straight from the snapshot's position string (contract
// legend: PG/SG → G, SF/PF → F, C only C). A few rows are marked as a
// non-Yahoo guess so the "not confirmed by Yahoo" badge shows up.
const TOK = { PG: ['PG', 'G'], SG: ['SG', 'G'], SF: ['SF', 'F'], PF: ['PF', 'F'], C: ['C'] };
const SLOT_ORDER = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'];
PLAYERS.forEach((p, i) => {
  const set = new Set(['UTIL']);
  p._yahooPos.split(',').forEach(t => (TOK[t] || []).forEach(x => set.add(x)));
  p.yahooElig = SLOT_ORDER.filter(x => set.has(x));
  p.eligConfidence = i % 17 === 5 ? 'sleeper' : 'yahoo';
  delete p._yahooPos;
});
// VORP by slot: replacement = value of the (teams × slots + 6)-th eligible player.
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
const YAHOO_FIELDS = ['yahooElig', 'eligConfidence', 'vorp', 'vorpBySlot', 'yahooPid', 'yahooPreRank', 'yahooPctRos'];
const leanPlayers = () => PLAYERS.map(p => { const q = Object.assign({}, p); YAHOO_FIELDS.forEach(k => delete q[k]); return q; });

/* ---------------------------------------------------------- yahoo mock */
const LEAGUES = [
  { league_key: '466.l.242808', name: 'HALIMSANITY 26-27', num_teams: 12, draft_status: 'predraft' },
  { league_key: '466.l.67890', name: 'Office Hoops', num_teams: 12, draft_status: 'postdraft' }
];
const TEAM_NAMES = ['Splash Bros', 'Glass Cleaners', 'Paint Protectors', 'Euro Steps', 'Your Team', 'Fast Breakers', 'Bench Mob', 'Lob City', 'Triple Doubles', 'Corner Threes', 'Iso Joes', 'Pick & Pop'];
const NTEAMS = 12, ROUNDS = 16, MY_DP = 5;
const LK = '466.l.242808';
const MY_TEAM_KEY = LK + '.t.' + MY_DP;
const teams = TEAM_NAMES.map((name, i) => ({ team_key: LK + '.t.' + (i + 1), name, draft_position: i + 1, is_owned_by_current_login: i + 1 === MY_DP ? 1 : 0 }));
const league = {
  league_key: LK, name: 'HALIMSANITY 26-27', num_teams: NTEAMS, scoring_type: 'headone', draft_type: 'live', is_auction_draft: 0, draft_pick_time: 90,
  roster_positions: ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C'].map(p => ({ position: p, count: 1 })).concat([{ position: 'Util', count: 2 }, { position: 'BN', count: 5 }, { position: 'IL', count: 2 }]),
  stat_modifiers: { PTS: 1, REB: 1.2, AST: 1.5, ST: 3, BLK: 3, TO: -1 }, start_week: 1, end_week: 22,
  weeks: [{ week: 1, start: '2026-10-20', end: '2026-10-25' }, { week: 2, start: '2026-10-26', end: '2026-11-01' }],
  draft_status: 'predraft'
};

const picks = [];
const slotForPick = (p, n) => { const r = Math.ceil(p / n), i = (p - 1) % n; return r % 2 ? i + 1 : n - i; };
function makePick() {
  const n = NTEAMS, pickNo = picks.length + 1;
  if (pickNo > n * ROUNDS) return null;
  const taken = new Set(picks.map(p => p.player_key));
  const slot = slotForPick(pickNo, n);
  // Every 9th pick: someone takes a deep player who isn't on the 200-player
  // board (no Sleeper match → the "Unmatched" review path).
  if (pickNo % 9 === 0) {
    const deep = SNAP_DEEP.find(y => !taken.has('466.p.' + y.pid));
    if (deep) {
      const row = { pick: pickNo, round: Math.ceil(pickNo / n), team_key: LK + '.t.' + slot, player_key: '466.p.' + deep.pid, sleeperId: null, name: deep.name, matchConfidence: 0.3 };
      picks.push(row);
      return row;
    }
  }
  // ADP-ish: take one of the top 3 remaining by hsValue.
  const avail = PLAYERS.filter(p => !taken.has('466.p.' + p.yahooPid));
  const pool = avail.slice(0, 3);
  const pl = pool[Math.floor(rnd() * pool.length)] || avail[0];
  if (!pl) return null;
  // Yahoo's player_key carries the Yahoo id; sleeperId is the server's match
  // (dropped now and then: the board must still resolve by Yahoo id).
  const row = {
    pick: pickNo, round: Math.ceil(pickNo / n), team_key: LK + '.t.' + slot,
    player_key: '466.p.' + pl.yahooPid, sleeperId: pickNo % 7 === 0 ? null : pl.id, name: pl.name,
    matchConfidence: pickNo % 7 === 0 ? 0.5 : 0.99
  };
  picks.push(row);
  return row;
}
let timer = null;
function schedule() {
  clearInterval(timer); timer = null;
  if (mode === 'live') timer = setInterval(makePick, intervalSec * 1000);
}
schedule();

/* ------------------------------------------------------------- server */
const app = express();
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get(['/nba', '/nba/draft'], (req, res) => res.sendFile(path.join(ROOT, 'nba/pages/draft.html')));
app.get('/nba/lineup', (req, res) => res.sendFile(path.join(ROOT, 'nba/pages/lineup.html')));
app.use('/nba/pages', express.static(path.join(ROOT, 'nba/pages')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.get('/favicon.png', (req, res) => res.sendFile(path.join(ROOT, 'favicon.png')));

app.get('/nba/auth/login', (req, res) => { if (mode === 'off') mode = 'on'; schedule(); res.redirect('/nba'); });

app.get('/api/nba/players', (req, res) => res.json({ season: '2026', week: Number(req.query.week) || 1, profile: req.query.profile || null, asOf: new Date().toISOString(), players: lean ? leanPlayers() : PLAYERS }));
app.get('/api/nba/league-profile', (req, res) => {
  if (!profileOn) return res.status(404).json({ error: 'not_found' });
  if (req.query.league_id && req.query.league_id !== '242808') return res.status(404).json({ error: 'unknown_league' });
  res.json(PROFILE);
});
app.get('/api/nba/health', (req, res) => res.json({ ok: true, yahooConfigured: true, modelAsOf: new Date().toISOString() }));
app.get('/api/nba/yahoo/status', (req, res) => {
  if (mode === 'off') return res.json({ connected: false });
  res.json({ connected: true, yahooGuid: 'MOCKGUID', leagues: LEAGUES.map(l => Object.assign({}, l, l.league_key === league.league_key ? { draft_status: draftStatus() } : {})) });
});
function draftStatus() { return picks.length === 0 ? 'predraft' : picks.length >= NTEAMS * ROUNDS ? 'postdraft' : 'drafting'; }
// Remaining slots (G's /draft `order`): the snake from the next pick on.
function remainingOrder() {
  const out = [];
  for (let p = picks.length + 1; p <= NTEAMS * ROUNDS; p++) out.push({ pick: p, round: Math.ceil(p / NTEAMS), team_key: LK + '.t.' + slotForPick(p, NTEAMS) });
  return out;
}
app.get('/api/nba/yahoo/league', (req, res) => {
  if (mode === 'off') return res.status(401).json({ error: 'yahoo_not_connected' });
  if (req.query.league_key !== league.league_key) return res.json({ league: Object.assign({}, league, LEAGUES[1], { roster_positions: league.roster_positions }), teams: [], myTeamKey: null });
  res.json({ league: Object.assign({}, league, { draft_status: draftStatus() }), teams, myTeamKey: MY_TEAM_KEY });
});
app.get('/api/nba/yahoo/draft', (req, res) => {
  if (mode === 'off') return res.status(401).json({ error: 'yahoo_not_connected' });
  if (mode === 'degraded') return res.status(503).json({ error: 'yahoo_unavailable' });
  if (req.query.league_key !== league.league_key) return res.json({ status: 'postdraft', picks: [], unmatched: [], polledAt: new Date().toISOString() });
  const unmatched = picks.filter(p => !p.sleeperId).map(p => ({ player_key: p.player_key, name: { full: p.name }, editorial_team_abbr: '', display_position: '' }));
  res.json({ status: draftStatus(), picks, unmatched, order: remainingOrder(), onClock: remainingOrder()[0] || null, polledAt: new Date().toISOString() });
});
app.get('/api/nba/yahoo/roster', (req, res) => res.json({ players: [] }));

app.post('/__mock/mode', (req, res) => {
  if (req.query.yahoo) mode = req.query.yahoo;
  if (req.query.interval) intervalSec = Number(req.query.interval) || intervalSec;
  if (req.query.reset) picks.length = 0;
  if (req.query.profile) profileOn = req.query.profile !== 'off';
  if (req.query.lean != null) lean = req.query.lean === '1';
  schedule();
  res.json({ mode, interval: intervalSec, picks: picks.length });
});
app.post('/__mock/advance', (req, res) => {
  const n = Math.max(1, Math.min(NTEAMS * ROUNDS, Number(req.query.n) || 1));
  for (let i = 0; i < n; i++) makePick();
  res.json({ mode, picks: picks.length });
});

const server = app.listen(Number(arg('port', 0)), '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`nba-ui-mock listening on http://127.0.0.1:${port}/nba  (yahoo=${mode}, ${PLAYERS.length} players)`);
});
