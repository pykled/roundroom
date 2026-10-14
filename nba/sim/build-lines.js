#!/usr/bin/env node
// Build nba/sim/data/lines-2025.json: per-player 2025 game stat lines, so the
// simulator can score every game under ANY league profile (custom weights,
// TO/PF/TECH, DD/TD bonuses). Same compact row layout as stream H1's
// "format 2" logs so either source can be used interchangeably:
//   [epochDay, week, hsScore, minutes, pts, reb, ast, stl, blk, to, pf, tf]
// Applies the model's dedupe rule (nba/model/sleeper.js): sp > 0, both teams
// are franchises, dedupe on (player_id, game_id).
//
// Usage: node nba/sim/build-lines.js [rawDir]
//   rawDir default: $NBA_RAW_DIR, else data/nba/raw, else ../b-model/data/nba/raw
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'data', 'lines-2025.json');
const FRANCHISES = new Set([
  'ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW',
  'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK',
  'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS',
]);
const epochDay = d => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000);

function findRaw(arg) {
  const cands = [arg, process.env.NBA_RAW_DIR, path.join(ROOT, 'data', 'nba', 'raw'), path.join(ROOT, '..', 'b-model', 'data', 'nba', 'raw')];
  for (const c of cands) if (c && fs.existsSync(path.join(c, 'stats-2025-1.json'))) return c;
  throw new Error('build-lines: no raw stats-2025-*.json found (set NBA_RAW_DIR)');
}

function build(rawDir) {
  const keep = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'nba', 'players.json'), 'utf8')).players));
  const players = {};
  const seen = new Set();
  for (let w = 1; w <= 30; w++) {
    const f = path.join(rawDir, `stats-2025-${w}.json`);
    if (!fs.existsSync(f)) continue;
    for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const st = r.stats;
      if (!st || !(st.sp > 0) || !keep.has(r.player_id)) continue;
      if (!FRANCHISES.has(r.team) || !FRANCHISES.has(r.opponent)) continue;
      const key = r.player_id + '|' + r.game_id;
      if (seen.has(key)) continue;
      seen.add(key);
      const v = k => st[k] || 0;
      const hs = v('pts') + v('reb') + 2 * v('ast') + 3 * v('stl') + 3 * v('blk');
      (players[r.player_id] ||= []).push([epochDay(r.date), r.week, hs, Math.round(st.sp / 6) / 10,
        v('pts'), v('reb'), v('ast'), v('stl'), v('blk'), v('to'), v('pf'), v('tf')]);
    }
  }
  for (const g of Object.values(players)) g.sort((a, b) => a[0] - b[0]);
  return { season: '2025', generatedAt: new Date().toISOString(), source: 'api.sleeper.com/stats/nba/2025 (dedupe per nba/model/sleeper.js)', players };
}

if (require.main === module) {
  const out = build(findRaw(process.argv[2]));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  const n = Object.values(out.players).reduce((s, g) => s + g.length, 0);
  console.log(`wrote ${OUT}: ${Object.keys(out.players).length} players, ${n} games, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
}
module.exports = { build, findRaw };
