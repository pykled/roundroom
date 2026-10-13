#!/usr/bin/env node
/* Dev-only mock server for the NBA draft board (stream C). Serves nba/pages/*
   and /shared/* plus contract-shaped fake APIs, so the UI runs with no Yahoo,
   no model and no stream A/B code present.

   Usage
     node scripts/nba-ui-mock.js [--port=0] [--yahoo=off|on|live|degraded] [--interval=3]
       --port      0 = ephemeral (printed on start)
       --yahoo     off      status.connected = false (manual mode)
                   on       connected, draft predraft (no picks yet)
                   live     connected, a pick lands every --interval seconds
                   degraded connected, but /api/nba/yahoo/draft returns 503
   Runtime switch (handy for screenshots):
     POST /__mock/mode?yahoo=live&interval=2&reset=1   → { mode, picks }
     POST /__mock/advance?n=5                          → force n picks now
   /nba/auth/login simulates a successful Yahoo connect (mode → on) and redirects to /nba. */
'use strict';
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };

let mode = arg('yahoo', 'off');
let intervalSec = Number(arg('interval', 3)) || 3;

/* ------------------------------------------------------------- fixture */
// [name, team, positions, mean HS/game, injury]
const RAW = [
  ['Nikola Jokić', 'DEN', 'C', 68.4], ['Victor Wembanyama', 'SAS', 'C', 61.2], ['Giannis Antetokounmpo', 'MIL', 'PF', 60.1],
  ['Luka Dončić', 'LAL', 'PG,SG', 63.3], ['Shai Gilgeous-Alexander', 'OKC', 'PG,SG', 58.7], ['Anthony Davis', 'DAL', 'PF,C', 55.9, 'Questionable'],
  ['Domantas Sabonis', 'SAC', 'PF,C', 54.8], ['Tyrese Haliburton', 'IND', 'PG', 47.2, 'Out'], ['Jayson Tatum', 'BOS', 'SF,PF', 50.4, 'Out'],
  ['Karl-Anthony Towns', 'NYK', 'PF,C', 53.1], ['Cade Cunningham', 'DET', 'PG,SG', 54.0], ['Trae Young', 'ATL', 'PG', 52.6],
  ['LeBron James', 'LAL', 'SF,PF', 51.9, 'Day-To-Day'], ['Anthony Edwards', 'MIN', 'SG,SF', 49.3], ['Alperen Şengün', 'HOU', 'C', 51.2],
  ['Joel Embiid', 'PHI', 'C', 55.0, 'Questionable'], ['Kevin Durant', 'HOU', 'SF,PF', 47.6], ['Bam Adebayo', 'MIA', 'C', 46.5],
  ['Jalen Johnson', 'ATL', 'SF,PF', 49.8], ['LaMelo Ball', 'CHA', 'PG', 50.2], ['Paolo Banchero', 'ORL', 'SF,PF', 48.1],
  ['Devin Booker', 'PHX', 'PG,SG', 46.9], ['Jalen Brunson', 'NYK', 'PG', 45.8], ['Ja Morant', 'MEM', 'PG', 47.0],
  ['Evan Mobley', 'CLE', 'PF,C', 47.9], ['Chet Holmgren', 'OKC', 'PF,C', 46.8], ['Josh Giddey', 'CHI', 'PG,SG', 47.4],
  ['Scottie Barnes', 'TOR', 'SF,PF', 48.6], ['Donovan Mitchell', 'CLE', 'SG', 46.2], ['De\'Aaron Fox', 'SAS', 'PG', 44.9],
  ['Zion Williamson', 'NOP', 'PF', 46.0, 'Questionable'], ['Stephen Curry', 'GSW', 'PG', 44.7], ['Jimmy Butler', 'GSW', 'SF,PF', 42.1],
  ['Kawhi Leonard', 'LAC', 'SF', 43.9], ['Ivica Zubac', 'LAC', 'C', 43.2], ['Rudy Gobert', 'MIN', 'C', 41.0],
  ['Jaren Jackson Jr.', 'MEM', 'PF,C', 42.8], ['Franz Wagner', 'ORL', 'SF,PF', 43.5], ['Pascal Siakam', 'IND', 'PF', 43.0],
  ['Jamal Murray', 'DEN', 'PG,SG', 42.4], ['Tyrese Maxey', 'PHI', 'PG,SG', 45.5], ['Dyson Daniels', 'ATL', 'SG,SF', 42.9],
  ['Amen Thompson', 'HOU', 'SG,SF', 44.6], ['Jalen Williams', 'OKC', 'SG,SF', 43.1], ['Darius Garland', 'CLE', 'PG', 39.8],
  ['Desmond Bane', 'ORL', 'SG,SF', 40.6], ['Mikal Bridges', 'NYK', 'SF', 37.9], ['OG Anunoby', 'NYK', 'SF,PF', 38.3],
  ['Derrick White', 'BOS', 'PG,SG', 40.1], ['Jaylen Brown', 'BOS', 'SG,SF', 42.0], ['Myles Turner', 'MIL', 'C', 38.8],
  ['Walker Kessler', 'UTA', 'C', 41.7], ['Nikola Vučević', 'CHI', 'C', 43.6], ['Lauri Markkanen', 'UTA', 'SF,PF', 40.9],
  ['Kristaps Porziņģis', 'ATL', 'C', 39.4], ['Deni Avdija', 'POR', 'SF,PF', 42.2], ['Toumani Camara', 'POR', 'SF,PF', 36.5],
  ['Josh Hart', 'NYK', 'SG,SF', 40.4], ['Fred VanVleet', 'HOU', 'PG', 36.8, 'Out'], ['Dejounte Murray', 'NOP', 'PG,SG', 41.3, 'Out'],
  ['Zach LaVine', 'SAC', 'SG,SF', 38.6], ['DeMar DeRozan', 'SAC', 'SG,SF', 37.4], ['Brandon Miller', 'CHA', 'SG,SF', 39.0],
  ['Coby White', 'CHI', 'PG,SG', 38.1], ['Austin Reaves', 'LAL', 'PG,SG', 41.5], ['Jarrett Allen', 'CLE', 'C', 39.9],
  ['Onyeka Okongwu', 'ATL', 'PF,C', 38.0], ['Jalen Duren', 'DET', 'C', 40.3], ['Mark Williams', 'PHX', 'C', 37.6],
  ['Daniel Gafford', 'DAL', 'C', 34.8], ['Jusuf Nurkić', 'UTA', 'C', 35.9], ['Kel\'el Ware', 'MIA', 'C', 37.2],
  ['Cooper Flagg', 'DAL', 'SF,PF', 41.0], ['Dylan Harper', 'SAS', 'PG,SG', 33.4], ['Ace Bailey', 'UTA', 'SF', 31.8],
  ['Stephon Castle', 'SAS', 'PG,SG', 37.0], ['Zaccharie Risacher', 'ATL', 'SF', 30.9], ['Alex Sarr', 'WAS', 'C', 37.8],
  ['Bilal Coulibaly', 'WAS', 'SG,SF', 33.0], ['Keegan Murray', 'SAC', 'SF,PF', 34.9], ['Jabari Smith Jr.', 'HOU', 'PF', 35.6],
  ['Trey Murphy III', 'NOP', 'SF,PF', 38.4], ['Herbert Jones', 'NOP', 'SF', 33.9], ['Immanuel Quickley', 'TOR', 'PG,SG', 37.1],
  ['RJ Barrett', 'TOR', 'SG,SF', 37.5], ['Jakob Poeltl', 'TOR', 'C', 39.2], ['Norman Powell', 'MIA', 'SG,SF', 34.0],
  ['Tyler Herro', 'MIA', 'PG,SG', 39.6, 'Out'], ['Andrew Wiggins', 'MIA', 'SF', 32.8], ['Michael Porter Jr.', 'BKN', 'SF,PF', 37.9],
  ['Cam Thomas', 'BKN', 'SG', 34.6], ['Nic Claxton', 'BKN', 'C', 34.1], ['Anfernee Simons', 'BOS', 'PG,SG', 34.3],
  ['Shaedon Sharpe', 'POR', 'SG,SF', 33.7], ['Scoot Henderson', 'POR', 'PG', 32.5, 'Out'], ['Jrue Holiday', 'POR', 'PG,SG', 33.1],
  ['Kyrie Irving', 'DAL', 'PG,SG', 41.9, 'Out'], ['Klay Thompson', 'DAL', 'SG,SF', 29.8], ['Draymond Green', 'GSW', 'PF,C', 36.2],
  ['Brandon Ingram', 'TOR', 'SF,PF', 38.9], ['CJ McCollum', 'WAS', 'PG,SG', 35.2], ['Jordan Poole', 'NOP', 'PG,SG', 34.5],
  ['Bradley Beal', 'LAC', 'SG', 32.0], ['James Harden', 'LAC', 'PG,SG', 45.1], ['Norman Powell Jr.', 'UTA', 'SG', 28.2],
  ['Jonas Valančiūnas', 'DEN', 'C', 32.9], ['Aaron Gordon', 'DEN', 'PF', 34.4], ['Christian Braun', 'DEN', 'SG,SF', 33.8],
  ['Julius Randle', 'MIN', 'PF', 39.3], ['Naz Reid', 'MIN', 'PF,C', 34.7], ['Mike Conley', 'MIN', 'PG', 27.9],
  ['Kevin Huerter', 'CHI', 'SG,SF', 28.6], ['Matas Buzelis', 'CHI', 'SF,PF', 33.5], ['Ausar Thompson', 'DET', 'SG,SF', 36.0],
  ['Tobias Harris', 'DET', 'PF', 33.2], ['Jaden Ivey', 'DET', 'PG,SG', 32.3, 'Questionable'], ['Collin Sexton', 'CHA', 'PG,SG', 31.7],
  ['Miles Bridges', 'CHA', 'SF,PF', 36.6], ['Grayson Allen', 'PHX', 'SG,SF', 28.4], ['Paul George', 'PHI', 'SF,PF', 35.8]
].filter(r => r[0] !== 'Norman Powell Jr.');

// Deterministic PRNG so the fixture (and screenshots) are stable run to run.
let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

function eligOf(pos) {
  const e = new Set();
  pos.forEach(p => { if (p === 'PG' || p === 'SG') e.add('G'); else e.add('F'); }); // C counts as F
  e.add('UTIL');
  return ['G', 'F', 'UTIL'].filter(x => e.has(x));
}

const ROOKIES = new Set(['Cooper Flagg', 'Dylan Harper', 'Ace Bailey']);
const PLAYERS = RAW.map((r, i) => {
  const [name, team, posStr, mean, injury] = r;
  const pos = posStr.split(',');
  const sd = +(mean * (0.18 + rnd() * 0.08)).toFixed(1);
  const games = rnd() < 0.55 ? 4 : (rnd() < 0.85 ? 3 : 2);
  // E[max of n normals] ≈ mean + sd·c(n); c(2)=.564, c(3)=.846, c(4)=1.029. Pre-draft hsValue uses the 3.5-game typical week.
  const hsValue = +(mean + sd * 0.94).toFixed(1);
  const cn = { 2: 0.564, 3: 0.846, 4: 1.029 }[games];
  return {
    id: String(1000 + i * 7), name, team, pos, elig: eligOf(pos), injury: injury || null,
    mean, sd, games, gamesByWeek: { 1: games }, hsValue, hsByWeek: { 1: +(mean + sd * cn).toFixed(1) },
    ceiling: +(mean + 1.2816 * sd).toFixed(1), floor: +(mean - 1.2816 * sd).toFixed(1),
    rank: 0, tier: 0, posRank: 0, sampleGames: ROOKIES.has(name) ? 0 : 40 + Math.floor(rnd() * 40),
    source: ROOKIES.has(name) ? 'rookie' : 'logs'
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

/* ---------------------------------------------------------- yahoo mock */
const LEAGUES = [
  { league_key: '466.l.12345', name: 'Hardwood High Score', num_teams: 10, draft_status: 'predraft' },
  { league_key: '466.l.67890', name: 'Office Hoops', num_teams: 12, draft_status: 'postdraft' }
];
const TEAM_NAMES = ['Splash Bros', 'Glass Cleaners', 'Paint Protectors', 'Your Team', 'Euro Steps', 'Fast Breakers', 'Bench Mob', 'Lob City', 'Triple Doubles', 'Corner Threes'];
const MY_TEAM_KEY = '466.l.12345.t.4';
const teams = TEAM_NAMES.map((name, i) => ({ team_key: '466.l.12345.t.' + (i + 1), name, draft_position: i + 1, is_owned_by_current_login: i === 3 ? 1 : 0 }));
const league = {
  league_key: '466.l.12345', name: 'Hardwood High Score', num_teams: 10, scoring_type: 'headone',
  roster_positions: [{ position: 'G', count: 2 }, { position: 'F', count: 3 }, { position: 'Util', count: 1 }, { position: 'BN', count: 4 }, { position: 'IL', count: 1 }],
  stat_modifiers: { PTS: 1, REB: 1, AST: 2, ST: 3, BLK: 3 }, start_week: 1, end_week: 20,
  weeks: [{ week: 1, start: '2026-10-20', end: '2026-10-25' }, { week: 2, start: '2026-10-26', end: '2026-11-01' }],
  draft_status: 'predraft'
};

const picks = [];
const slotForPick = (p, n) => { const r = Math.ceil(p / n), i = (p - 1) % n; return r % 2 ? i + 1 : n - i; };
function makePick() {
  const n = 10, pickNo = picks.length + 1;
  if (pickNo > n * 10) return null;
  const taken = new Set(picks.map(p => p.player_key));
  // ADP-ish: take one of the top 3 remaining by hsValue, with injury fade.
  const avail = PLAYERS.filter(p => !taken.has('466.p.' + p.id));
  const pool = avail.slice(0, 3);
  const pl = pool[Math.floor(rnd() * pool.length)] || avail[0];
  if (!pl) return null;
  const slot = slotForPick(pickNo, n);
  const unmatched = pickNo % 9 === 0; // every 9th pick simulates a name the matcher couldn't resolve
  const row = {
    pick: pickNo, round: Math.ceil(pickNo / n), team_key: '466.l.12345.t.' + slot,
    player_key: '466.p.' + pl.id, sleeperId: unmatched ? null : pl.id,
    name: unmatched ? pl.name.replace(/[ćčšžņğş]/g, c => ({ ć: 'c', č: 'c', š: 's', ž: 'z', ņ: 'n', ğ: 'g', ş: 's' })[c]) + (pickNo % 18 === 0 ? ' Sr.' : '') : pl.name,
    matchConfidence: unmatched ? 0.42 : 0.99
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

app.get('/api/nba/players', (req, res) => res.json({ season: '2026', week: Number(req.query.week) || 1, asOf: new Date().toISOString(), players: PLAYERS }));
app.get('/api/nba/health', (req, res) => res.json({ ok: true, yahooConfigured: true, modelAsOf: new Date().toISOString() }));
app.get('/api/nba/yahoo/status', (req, res) => {
  if (mode === 'off') return res.json({ connected: false });
  res.json({ connected: true, yahooGuid: 'MOCKGUID', leagues: LEAGUES.map(l => Object.assign({}, l, l.league_key === league.league_key ? { draft_status: draftStatus() } : {})) });
});
function draftStatus() { return picks.length === 0 ? 'predraft' : picks.length >= 100 ? 'postdraft' : 'drafting'; }
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
  res.json({ status: draftStatus(), picks, unmatched, polledAt: new Date().toISOString() });
});
app.get('/api/nba/yahoo/roster', (req, res) => res.json({ players: [] }));

app.post('/__mock/mode', (req, res) => {
  if (req.query.yahoo) mode = req.query.yahoo;
  if (req.query.interval) intervalSec = Number(req.query.interval) || intervalSec;
  if (req.query.reset) picks.length = 0;
  schedule();
  res.json({ mode, interval: intervalSec, picks: picks.length });
});
app.post('/__mock/advance', (req, res) => {
  const n = Math.max(1, Math.min(100, Number(req.query.n) || 1));
  for (let i = 0; i < n; i++) makePick();
  res.json({ mode, picks: picks.length });
});

const server = app.listen(Number(arg('port', 0)), '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`nba-ui-mock listening on http://127.0.0.1:${port}/nba  (yahoo=${mode}, ${PLAYERS.length} players)`);
});
