#!/usr/bin/env node
/* Dev-only mock server for the NBA draft board (stream C). Serves nba/pages/*
   and /shared/* plus contract-shaped fake APIs, so the UI runs with no Yahoo,
   no model and no stream A/B code present.

   Usage
     node scripts/nba-ui-mock.js [--port=0] [--yahoo=off|on|live|degraded] [--interval=3] [--profile=on|off] [--lean=1]
       --port      0 = ephemeral (printed on start)
       --profile   off  → GET /api/nba/league-profile 404s (page falls back to the built-in 242808 shape)
       --lean      1    → players carry no yahooElig/eligConfidence/vorp/vorpBySlot (pre-H1 model)
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

// Depth to reach ~200 (realistic role players; mean HS/game is rough).
const DEPTH = [
  ['Jalen Suggs', 'ORL', 'PG,SG', 33.0], ['Wendell Carter Jr.', 'ORL', 'PF,C', 31.4], ['Goga Bitadze', 'ORL', 'C', 27.5], ['Cole Anthony', 'MEM', 'PG', 26.8],
  ['Santi Aldama', 'MEM', 'PF,C', 30.2], ['Zach Edey', 'MEM', 'C', 33.6], ['Jaylen Wells', 'MEM', 'SG,SF', 27.0], ['Brandon Clarke', 'MEM', 'PF', 25.9],
  ['Bennedict Mathurin', 'IND', 'SG,SF', 30.6], ['Andrew Nembhard', 'IND', 'PG,SG', 29.4], ['Obi Toppin', 'IND', 'PF', 26.1], ['Aaron Nesmith', 'IND', 'SF', 27.3],
  ['T.J. McConnell', 'IND', 'PG', 26.4], ['Isaiah Hartenstein', 'OKC', 'C', 34.8], ['Lu Dort', 'OKC', 'SG,SF', 25.6], ['Cason Wallace', 'OKC', 'PG,SG', 27.2],
  ['Aaron Wiggins', 'OKC', 'SG,SF', 24.9], ['Kelly Oubre Jr.', 'PHI', 'SG,SF', 30.0], ['Quentin Grimes', 'PHI', 'SG', 29.1], ['Andre Drummond', 'PHI', 'C', 31.0],
  ['VJ Edgecombe', 'PHI', 'SG', 28.5], ['Kyle Kuzma', 'MIL', 'SF,PF', 29.8], ['Bobby Portis', 'MIL', 'PF,C', 30.4], ['Kevin Porter Jr.', 'MIL', 'PG,SG', 30.9],
  ['Gary Trent Jr.', 'MIL', 'SG', 24.0], ['Brook Lopez', 'LAC', 'C', 28.3], ['John Collins', 'LAC', 'PF,C', 31.9], ['Kris Dunn', 'LAC', 'PG,SG', 26.5],
  ['Derrick Jones Jr.', 'LAC', 'SF,PF', 24.4], ['Nickeil Alexander-Walker', 'ATL', 'SG,SF', 27.9], ['Luke Kennard', 'ATL', 'SG', 22.8], ['Mouhamed Gueye', 'ATL', 'PF', 21.5],
  ['Rui Hachimura', 'LAL', 'SF,PF', 28.2], ['Deandre Ayton', 'LAL', 'C', 33.3], ['Jaxson Hayes', 'LAL', 'C', 23.6], ['Marcus Smart', 'LAL', 'PG,SG', 24.7],
  ['Jonathan Kuminga', 'GSW', 'SF,PF', 31.6], ['Brandin Podziemski', 'GSW', 'SG', 28.0], ['Moses Moody', 'GSW', 'SG,SF', 23.9], ['Buddy Hield', 'GSW', 'SG,SF', 23.3],
  ['Trayce Jackson-Davis', 'GSW', 'PF,C', 23.0], ['Keon Ellis', 'SAC', 'SG', 24.6], ['Malik Monk', 'SAC', 'PG,SG', 29.0], ['Dennis Schröder', 'SAC', 'PG', 28.6],
  ['Jeremy Sochan', 'SAS', 'PF', 26.9], ['Harrison Barnes', 'SAS', 'SF,PF', 23.8], ['Luke Kornet', 'SAS', 'C', 22.1], ['Keldon Johnson', 'SAS', 'SF,PF', 27.7],
  ['Jordan Clarkson', 'NYK', 'PG,SG', 26.2], ['Mitchell Robinson', 'NYK', 'C', 27.8], ['Miles McBride', 'NYK', 'PG,SG', 24.2], ['Isaiah Collier', 'UTA', 'PG', 27.6],
  ['Keyonte George', 'UTA', 'PG,SG', 30.7], ['Kyle Filipowski', 'UTA', 'PF,C', 27.4], ['Taylor Hendricks', 'UTA', 'PF', 23.1], ['Svi Mykhailiuk', 'UTA', 'SG,SF', 20.7],
  ['Tre Jones', 'CHI', 'PG', 26.7], ['Patrick Williams', 'CHI', 'SF,PF', 24.5], ['Jalen Smith', 'CHI', 'PF,C', 28.9], ['Ayo Dosunmu', 'CHI', 'PG,SG', 26.0],
  ['Bub Carrington', 'WAS', 'PG,SG', 25.2], ['Khris Middleton', 'WAS', 'SF', 26.6], ['Tristan Vukcevic', 'WAS', 'C', 24.3], ['Kyshawn George', 'WAS', 'SG,SF', 25.7],
  ['Marcus Sasser', 'DET', 'PG', 22.5], ['Isaiah Stewart', 'DET', 'PF,C', 26.3], ['Ron Holland II', 'DET', 'SF', 24.8], ['Duncan Robinson', 'DET', 'SF', 22.0],
  ['Max Strus', 'CLE', 'SG,SF', 25.1], ['De\'Andre Hunter', 'CLE', 'SF,PF', 26.4], ['Sam Merrill', 'CLE', 'SG', 21.2], ['Dean Wade', 'CLE', 'PF', 21.0],
  ['Pelle Larsson', 'MIA', 'SG', 22.3], ['Nikola Jović', 'MIA', 'PF', 27.1], ['Davion Mitchell', 'MIA', 'PG', 25.3], ['Simone Fontecchio', 'MIA', 'SF', 21.9],
  ['Grant Williams', 'CHA', 'PF', 22.6], ['Moussa Diabaté', 'CHA', 'C', 25.5], ['Kon Knueppel', 'CHA', 'SG,SF', 29.3], ['Tidjane Salaün', 'CHA', 'PF', 22.4],
  ['Royce O\'Neale', 'PHX', 'SF,PF', 23.4], ['Ryan Dunn', 'PHX', 'SF', 21.7], ['Collin Gillespie', 'PHX', 'PG', 23.0], ['Jusuf Nurkić Jr.', 'PHX', 'C', 20.0],
  ['Neemias Queta', 'BOS', 'C', 25.9], ['Payton Pritchard', 'BOS', 'PG', 29.2], ['Sam Hauser', 'BOS', 'SF', 21.4], ['Xavier Tillman', 'BOS', 'PF,C', 20.5]
].filter(r => r[0] !== 'Jusuf Nurkić Jr.');

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
const PLAYERS = RAW.concat(DEPTH).map((r, i) => {
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

/* --------------------------------------------- league 242808 profile (H1 shape) */
const PROFILE = {
  leagueId: '242808', name: 'HALIMSANITY 26-27', teams: 12, draft: { type: 'snake', pickSeconds: 90 },
  scoring: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, pf: -1, tech: -1, dd: 5, td: 3 }, flags: { tdAlsoCountsDD: true },
  slots: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2, BN: 5, IL: 2 }, starters: 9, rosterSize: 16,
  weeks: [{ week: 1, start: '2026-10-20', end: '2026-10-25', days: 6 }, { week: 2, start: '2026-10-26', end: '2026-11-01', days: 7 }],
  maxAddsPerWeek: 10, tradeEnd: '2027-03-04'
};
// Yahoo eligibility per the contract legend (a few "Yahoo says F/C" upgrades so
// yahooElig differs from the Sleeper-derived one, like the real feed will).
const TOK = { PG: ['PG', 'G'], SG: ['SG', 'G'], SF: ['SF', 'F'], PF: ['PF', 'F'], C: ['C'] };
const YAHOO_EXTRA = { 'Giannis Antetokounmpo': ['C'], 'Paolo Banchero': ['PF'], 'Scottie Barnes': ['PG', 'G'] };
const SLOT_ORDER = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'];
PLAYERS.forEach((p, i) => {
  const set = new Set(['UTIL']);
  p.pos.forEach(t => TOK[t].forEach(x => set.add(x)));
  (YAHOO_EXTRA[p.name] || []).forEach(x => set.add(x));
  p.yahooElig = SLOT_ORDER.filter(x => set.has(x));
  p.eligConfidence = i % 17 === 5 ? 0.55 : 0.97; // a few low-confidence matches
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
const leanPlayers = () => PLAYERS.map(p => { const q = Object.assign({}, p); delete q.yahooElig; delete q.eligConfidence; delete q.vorp; delete q.vorpBySlot; return q; });

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
  // ADP-ish: take one of the top 3 remaining by hsValue, with injury fade.
  const avail = PLAYERS.filter(p => !taken.has('466.p.' + p.id));
  const pool = avail.slice(0, 3);
  const pl = pool[Math.floor(rnd() * pool.length)] || avail[0];
  if (!pl) return null;
  const slot = slotForPick(pickNo, n);
  const unmatched = pickNo % 9 === 0; // every 9th pick simulates a name the matcher couldn't resolve
  const row = {
    pick: pickNo, round: Math.ceil(pickNo / n), team_key: LK + '.t.' + slot,
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
