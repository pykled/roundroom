// Offline test for nba/model/market.js + scripts/nba-market-build.js CSV import. Plain node, exit 0 on pass.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../nba/model/market');
const { parseFantasyProsCsv } = require('./nba-market-build');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// --- weighted median math
eq(M.weightedMedian([{ v: 1, w: 1 }, { v: 2, w: 1 }, { v: 3, w: 1 }]), 2, 'median of 3 equal');
eq(M.weightedMedian([{ v: 10, w: 0.6 }, { v: 50, w: 0.2 }, { v: 90, w: 0.2 }]), 10, 'heavy weight dominates');
eq(M.weightedMedian([{ v: 10, w: 1 }, { v: 20, w: 1 }]), 15, 'exact half → midpoint');
eq(M.weightedMedian([{ v: 10, w: 0.4 }, { v: 20, w: 0.2 }]), 10, '2/3 weight on lower → lower');
eq(M.weightedMedian([]), null, 'empty');
eq(M.weightedMedian([{ v: NaN, w: 1 }, { v: 7, w: 1 }]), 7, 'NaN ignored');

// --- renormalization: missing sources must not drag rank
const full = M.consensus({ yahoo_pre: 10, fantasypros_yahoo: 12, espn: 11, sleeper: 13 });
ok(full.raw >= 10 && full.raw <= 13 && full.weightCovered > 0.999, 'full consensus in range');
const only = M.consensus({ espn: 30 });
eq(only.raw, 30, 'single source = its value'); eq(only.used, ['espn'], 'used'); ok(Math.abs(only.weightCovered - 0.2) < 1e-9, 'coverage 0.2');
const yOnly = M.consensus({ yahoo_pre: 5 });
ok(yOnly.raw === 5 && M.confidenceFor(yOnly) <= 0.5, 'thin capped at 0.5');
ok(M.confidenceFor(full) > M.confidenceFor(yOnly), 'more sources → more confidence');
eq(M.consensus({}), null, 'no sources → null'); eq(M.confidenceFor(null), 0, 'no conf');
eq(M.consensus({ yahoo_pre: 10, espn: 90 }).raw, 10, 'yahoo outweighs espn 2:1 (renormalized)');

// --- contested flag
ok(!M.consensus({ yahoo_pre: 10, espn: 25 }).contested, 'spread 15 ≤ 20 → not contested');
ok(M.consensus({ yahoo_pre: 10, espn: 40 }).contested, 'spread 30 > 20 → contested');
ok(!M.consensus({ yahoo_pre: 100, espn: 120, sleeper: 110 }).contested, 'late: spread 20 ≤ 25');
ok(M.consensus({ yahoo_pre: 100, espn: 140 }).contested, 'late: spread 40 > 25');
ok(!M.consensus({ yahoo_pre: 5 }).contested, 'single source never contested');

// --- label thresholds (band = max(3, 0.15·modelRank), ×1.5 contested)
eq(M.labelFor(2, 10, false, 12).label, 'fair', 'delta 2 within band 3');
eq(M.labelFor(3, 10, false, 13).label, 'value', 'delta = band → value');
eq(M.labelFor(6, 10, false, 16).strong, true, '2×band strong');
eq(M.labelFor(-4, 10, false, 6).label, 'reach', 'negative → reach');
eq(M.labelFor(10, 100, false, 110).label, 'fair', 'late band 15 → delta 10 fair');
eq(M.labelFor(15, 100, false, 115).label, 'value', 'late band 15 → delta 15 value');
eq(M.labelFor(15, 100, true, 115).label, 'fair', 'contested widens band to 22.5');
eq(M.labelFor(null, 10, false, null).label, null, 'null delta → no label');
eq(M.labelFor(300, 400, false, 700).label, null, 'beyond label depth → no label');

// --- spearman
ok(Math.abs(M.spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-12, 'rho +1');
ok(Math.abs(M.spearman([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-12, 'rho -1');
eq(M.spearman([1, 2], [1, 2]), null, 'rho needs ≥3');

// --- end-to-end on a fixture with tricky names
const mk = (id, name, team, rank, pos = ['C']) => ({ id, name, team, pos, rank });
const players = [
  mk('1', 'Nikola Jokić', 'DEN', 1), mk('2', 'Alperen Şengün', 'HOU', 2), mk('3', 'Kristaps Porziņģis', 'ATL', 3),
  mk('4', 'Jaime Jaquez Jr.', 'MIA', 4, ['SG']), mk('5', 'Gary Trent Jr.', 'MIL', 5, ['SG']), mk('6', 'Wendell Carter Jr.', 'ORL', 6),
  mk('7', 'Jaren Jackson Jr.', 'MEM', 7, ['PF']), mk('8', 'Michael Porter Jr.', 'BKN', 8, ['SF']), mk('9', 'Nobody Special', 'UTA', 9),
  mk('10', 'Value Guy', 'POR', 40, ['PG']),
];
const snap = { fetchedAt: '2026-10-13T00:00:00Z', players: [
  { pid: 'y1', name: 'Nikola Jokic', team: 'DEN', pos: 'C', preRank: 1, curRank: 1, pctRos: 100, fanPts: 4000 },
  { pid: 'y2', name: 'Alperen Sengun', team: 'HOU', pos: 'C', preRank: 2, curRank: 3, pctRos: 100, fanPts: 3000 },
  { pid: 'y3', name: 'Kristaps Porzingis', team: 'ATL', pos: 'C', preRank: 3, curRank: 2, pctRos: 99, fanPts: 2000 },
  { pid: 'y4', name: 'Jaime Jaquez Jr.', team: 'MIA', pos: 'SG,SF', preRank: 4, curRank: 4, pctRos: 98, fanPts: 1800 },
  { pid: 'y5', name: 'Gary Trent Jr.', team: 'Mil', pos: 'SG', preRank: 5, curRank: 5, pctRos: 90, fanPts: 1500 },
  { pid: 'y6', name: 'Wendell Carter Jr.', team: 'ORL', pos: 'C', preRank: 6, curRank: 6, pctRos: 80, fanPts: 1400 },
  { pid: 'y7', name: 'Jaren Jackson Jr.', team: 'MEM', pos: 'PF,C', preRank: 7, curRank: 7, pctRos: 80, fanPts: 1300 },
  { pid: 'y8', name: 'Michael Porter Jr.', team: 'BKN', pos: 'SF,PF', preRank: 8, curRank: 8, pctRos: 80, fanPts: 1200 },
  { pid: 'y9', name: 'Someone Else', team: 'LAL', pos: 'PG', preRank: 9, curRank: 9, pctRos: 10, fanPts: 500 },
  { pid: 'y10', name: 'Value Guy', team: 'POR', pos: 'PG', preRank: 90, curRank: 80, pctRos: 40, fanPts: 900 },
] };
const adp = [
  { name: 'Nikola Jokic', team: 'DEN', adp: 1.4, source: 'espn' }, { name: 'Alperen Sengun', team: 'HOU', adp: 2.9, source: 'espn' },
  { name: 'Kristaps Porziņģis', team: 'ATL', adp: 5, source: 'espn' }, { name: 'Jaime Jaquez', team: 'MIA', adp: 9, source: 'espn' },
  { name: 'Value Guy', team: 'POR', adp: 95, source: 'espn' }, { name: 'Ghost Player', team: 'LAL', adp: 50, source: 'espn' },
  { name: 'Nikola Jokić', team: 'DEN', adp: 1.1, source: 'sleeper' }, { name: 'Gary Trent', team: 'MIL', adp: 20, source: 'sleeper' },
  { name: 'Jaren Jackson', team: 'MEM', adp: 30, source: 'sleeper' },
  { name: 'Nikola Jokic', team: 'DEN', adp: 1, source: 'fantasypros-yahoo' }, { name: 'Wendell Carter', team: 'ORL', adp: 8, source: 'fantasypros-yahoo' },
  { name: 'Junk', team: 'X', adp: NaN, source: 'espn' }, { name: 'Bogus', team: 'X', adp: 3, source: 'unknown-source' },
];
const mkt = M.buildMarket({ players, yahooSnapshot: snap, adpSources: adp });
eq(mkt.stats.sources.yahoo_pre.matched, 9, 'yahoo matched (Someone Else unmatched)'); eq(mkt.unmatched.yahoo_pre.length, 1, 'yahoo unmatched report');
eq(mkt.stats.sources.espn.matched, 5, 'espn matched 5 of 6 (Ghost unmatched, NaN dropped)');
eq(mkt.stats.sources.espn.total, 6, 'espn total counts valid rows only'); ok(/Ghost/.test(mkt.unmatched.espn[0]), 'ghost reported');
eq(mkt.stats.sources.sleeper.matched, 3, 'sleeper suffix-less Gary Trent / Jaren Jackson match Jr.');
eq(mkt.stats.sources.fantasypros_yahoo.matched, 2, 'fp matched'); ok(!mkt.stats.sources.unknown, 'unknown source ignored');
eq(mkt.byId['1'].yahooPid, 'y1', 'Jokić ↔ Jokic'); eq(mkt.byId['2'].yahooPid, 'y2', 'Şengün'); eq(mkt.byId['3'].yahooPid, 'y3', 'Porziņģis');
eq(mkt.byId['5'].yahooPid, 'y5', 'team case "Mil" normalizes'); eq(mkt.byId['4'].adp.espn, 9, 'Jaquez Jr. ↔ Jaquez adp');
eq(mkt.byId['1'].marketRank, 1, 'Jokić market #1'); eq(mkt.byId['1'].adpDelta, 0, 'no delta'); eq(mkt.byId['1'].label, 'fair', 'fair');
eq(mkt.byId['9'].marketRank, null, 'no source → null marketRank'); eq(mkt.byId['9'].label, null, 'no label'); eq(mkt.byId['9'].confidence, 0, 'no conf');
const v = mkt.byId['10'];
eq([v.marketRank, v.modelRank, v.adpDelta, v.label], [9, 40, -31, 'reach'], 'dense market rank among 9 with data; model 40 ⇒ reach');
ok(mkt.byId['7'].thin === false && mkt.byId['7'].sources.length === 2, 'two-source player not thin');
ok(mkt.byId['8'].thin === true, 'yahoo-only player is thin');
// market ranks are a unique 1..k ordinal
const mr = mkt.rows.filter(r => r.marketRank != null).map(r => r.marketRank).sort((a, b) => a - b);
eq(mr, mr.map((_, i) => i + 1), 'marketRank is a dense unique ordinal');
// no NaN anywhere
const bad = JSON.stringify(mkt.rows, (k, x) => (typeof x === 'number' && !Number.isFinite(x) ? '__BAD__' : x));
ok(!bad.includes('__BAD__'), 'no NaN/Infinity in rows');
// yahooPid supplied by H1 wins over name match
const pid = M.buildMarket({ players: [{ id: 'a', name: 'Totally Different Name', team: 'ZZZ', pos: ['PG'], rank: 5, yahooPid: 'y1' }], yahooSnapshot: snap, adpSources: [] });
eq(pid.byId.a.yahooPreRank, 1, 'yahooPid join');
// robustness
const empty = M.buildMarket({});
eq(empty.rows.length, 0, 'empty input ok'); ok(M.buildMarket({ players, yahooSnapshot: null, adpSources: null }).rows.length === players.length, 'no sources ok');

// --- CSV import
const csv = 'Rank,Player,Team,Pos,Yahoo,ESPN,AVG\n1,"Jokić, Nikola",DEN,C,1,1,1.0\n2,Victor Wembanyama (SAS - C),,C,2,3,2.5\n3,Blank Guy,LAL,PG,,5,5\n4,Tab Guy DEN-C,,,7,,7\n';
const rows = parseFantasyProsCsv(csv, 'x');
eq(rows.length, 3, 'csv: blank Yahoo dropped');
eq(rows[1].name, 'Victor Wembanyama', 'csv: suffix peeled'); eq(rows[1].team, 'SAS', 'csv: team from suffix'); eq(rows[2].team, 'DEN', 'csv: DEN-C');
eq(rows[0].source, 'fantasypros-yahoo', 'csv source'); eq(parseFantasyProsCsv('nonsense'), [], 'csv garbage');
eq(parseFantasyProsCsv('Player,ADP\nA B,5\n')[0].adp, 5, 'csv ADP col fallback');

// --- real-data validation (skipped when generated file/snapshot absent)
const snapFile = path.join(__dirname, '..', 'data', 'nba', 'yahoo-snapshot-242808.json');
if (fs.existsSync(snapFile)) {
  const real = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const r = M.buildMarket({ players: [], yahooSnapshot: real, adpSources: [] }).validation.yahooPreRank_vs_fanPts;
  ok(r.n > 300 && r.spearman > 0.7, `Yahoo preRank vs last-season fanPts rank: n=${r.n} rho=${r.spearman}`);
  console.log(`yahoo preRank vs fanPts rank: n=${r.n} spearman=${r.spearman.toFixed(3)}`);
}
console.log(`nba-market: ${n} checks passed`);
