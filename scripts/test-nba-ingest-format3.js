#!/usr/bin/env node
/* Format-3 game logs (fga/fta/tpm/ff): compaction, merge/loader format guards,
   committed-snapshot invariants and the usage helper. Offline.
   Run: node scripts/test-nba-ingest-format3.js   (exit 0 = all pass) */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../nba/model/sleeper');
const { usageStats } = require('../nba/model/usage');
const eq = assert.deepStrictEqual;

const tests = [];
const t = (n, f) => tests.push([n, f]);

const row = (pid, gid, date, st, team = 'DEN', opp = 'LAL') => ({ player_id: pid, game_id: gid, date, team, opponent: opp, stats: st });
const LINE = { sp: 1800, pts: 20, reb: 5, ast: 4, stl: 1, blk: 0, to: 3, pf: 2, tf: 0, fga: 15, fta: 6, tpm: 3, ff: 1 };

t('compactLogs emits 16-column rows with fga/fta/tpm/ff after tf', () => {
  const f = S.compactLogs(2025, { 3: [row('1', 'g1', '2025-11-01', LINE)] });
  eq(f.format, 3);
  eq(S.LOG_FORMAT, 3);
  eq(f.players['1'].g[0].slice(3), [30, 20, 5, 4, 1, 0, 3, 2, 0, 15, 6, 3, 1]);
  eq(f.players['1'].g[0].length, 16);
});
t('missing extension stats default to 0; hs column unchanged', () => {
  const f = S.compactLogs(2025, { 3: [row('1', 'g1', '2025-11-01', { sp: 600, pts: 4 })] });
  const g = f.players['1'].g[0];
  eq(g.slice(12), [0, 0, 0, 0]);
  eq(g[2], S.hsScore({ pts: 4 }));
});
t('DNP rows still dropped, rostered-game counts unchanged', () => {
  const f = S.compactLogs(2025, { 3: [row('1', 'g1', '2025-11-01', {}), row('1', 'g2', '2025-11-02', LINE)] });
  eq(f.players['1'].g.length, 1);
  eq(f.players['1'].rw, { 3: 2 });
});
t('mergeLogs: same format splices, different format takes fresh only', () => {
  const old3 = S.compactLogs(2026, { 1: [row('1', 'a', '2026-10-25', LINE)], 2: [row('1', 'b', '2026-11-01', LINE)] });
  const fresh = S.compactLogs(2026, { 2: [row('1', 'b', '2026-11-01', { ...LINE, pts: 30 })] });
  const m = S.mergeLogs(old3, fresh);
  eq(m.players['1'].g.map(g => g[4]), [20, 30]);
  const old2 = { ...old3, format: 2, players: { 1: { t: 'DEN', rw: { 1: 1 }, g: [[1, 1, 5, 30, 20, 5, 4, 1, 0, 3, 2, 0]] } } };
  const m2 = S.mergeLogs(old2, fresh);
  eq(m2, fresh);
  eq(m2.players['1'].g.every(g => g.length === 16), true);
});
t('committed logs-2025.json is format 3 with consistent row shape', () => {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nba', 'logs-2025.json'), 'utf8'));
  eq(f.format, 3);
  let n = 0, ff = 0, fga = 0;
  for (const p of Object.values(f.players)) for (const g of p.g) {
    assert.strictEqual(g.length, 16);
    assert(g.every(Number.isFinite));
    assert(g[13] >= 0 && g[12] >= 0 && g[14] <= g[12]);
    n++; ff += g[15] > 0 ? 1 : 0; fga += g[12];
  }
  assert(n > 25000 && ff > 100 && fga > 300000, `n=${n} ff=${ff} fga=${fga}`);
});
t('loader: data.js ignores an older-format runtime cache and snapshot-only still loads', () => {
  const D = require('../nba/model/data');
  D._reset();
  const d = D.load();
  const l = d.logs.find(x => x.season === '2025');
  eq(l.format, 3);
});
t('loader: format-2 cache beside a format-3 snapshot is ignored (and vice versa)', () => {
  const dataPath = require.resolve('../nba/model/data');
  const cacheDir = path.join(__dirname, '..', 'data', 'nba', 'cache');
  const had = fs.existsSync(cacheDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, 'logs-2025.json');
  const prior = fs.existsSync(file) ? fs.readFileSync(file) : null;
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nba', 'logs-2025.json'), 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...snap, format: 2, generatedAt: '2099-01-01T00:00:00.000Z', players: {} }));
    delete require.cache[dataPath];
    const D = require('../nba/model/data');
    D._reset();
    eq(D.load().logs.find(x => x.season === '2025').format, 3);
    // a same-format newer cache is still preferred
    fs.writeFileSync(file, JSON.stringify({ ...snap, generatedAt: '2099-01-01T00:00:00.000Z', players: {} }));
    D._reset();
    eq(Object.keys(D.load().logs.find(x => x.season === '2025').players).length, 0);
  } finally {
    if (prior) fs.writeFileSync(file, prior); else fs.rmSync(file, { force: true });
    if (!had) fs.rmSync(cacheDir, { recursive: true, force: true });
    delete require.cache[dataPath];
  }
});
t('usageStats: formula, minute weighting, trend at ±0.03', () => {
  const g = (min, to, fga, fta) => [1, 1, 0, min, 0, 0, 0, 0, 0, to, 0, 0, fga, fta, 0, 0];
  // 10 games at (10+0.44*5+2)/30 = .4733 then 5 hot games at (20+0+4)/30 = .8
  const rows = [...Array.from({ length: 10 }, () => g(30, 2, 10, 5)), ...Array.from({ length: 5 }, () => g(30, 4, 20, 0))];
  const u = usageStats(rows);
  assert(Math.abs(u.last5 - 0.8) < 1e-9);
  assert(Math.abs(u.usageRate - (10 * 14.2 + 5 * 24) / 450) < 1e-3);
  eq(u.trend, 'up');
  eq(u.games, 15);
  const flat = usageStats(Array.from({ length: 8 }, () => g(30, 2, 10, 5)));
  eq(flat.trend, 'flat');
  const down = usageStats([...Array.from({ length: 10 }, () => g(30, 4, 20, 0)), ...Array.from({ length: 5 }, () => g(30, 2, 10, 5))]);
  eq(down.trend, 'down');
});
t('usageStats: format-2 rows / empty / tiny samples give nulls, never NaN', () => {
  const old = [[1, 1, 5, 30, 20, 5, 4, 1, 0, 3, 2, 0]];
  eq(usageStats(old), { fga: null, fta: null, usageRate: null, last5: null, trend: null, games: 0 });
  eq(usageStats(null).usageRate, null);
  const tiny = usageStats([[1, 1, 0, 5, 0, 0, 0, 0, 0, 1, 0, 0, 3, 1, 0, 0]]);
  eq(tiny.usageRate, null);
  eq(tiny.fga, 3);
  for (const v of Object.values(tiny)) assert(v === null || typeof v === 'string' || Number.isFinite(v));
});
t('usage on real data: stars out-use role players; rates plausible', () => {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nba', 'logs-2025.json'), 'utf8'));
  const rates = [];
  for (const [id, p] of Object.entries(f.players)) {
    if (!/^\d+$/.test(id) || p.g.length < 30) continue;
    const u = usageStats(p.g);
    assert(u.usageRate > 0.1 && u.usageRate < 1.2, `${id} ${u.usageRate}`);
    rates.push(u.usageRate);
  }
  assert(rates.length > 150);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  assert(mean > 0.4 && mean < 0.7, `mean usage ${mean}`);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); pass++; console.log('ok  ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n  ' + e.message); }
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
