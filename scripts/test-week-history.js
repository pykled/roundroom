#!/usr/bin/env node
// Checks for the week-history persistence layer:
//   shared/fpa-calibration.js   (offline, synthetic history)
//   weekly-score matchup hook   (offline)
//   scripts/log-week.js         pure derivations + file round-trip (offline),
//                               then a live build of Week 1 against Sleeper
//                               to confirm the logged shape (skip: --offline).
// Run: node scripts/test-week-history.js [--offline]
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Cal = require('../shared/fpa-calibration.js');
const W = require('../shared/weekly-score.js');
const LW = require('../scripts/log-week.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const offline = process.argv.includes('--offline');
const FIT_EPS = 2e-3;   // synthetic actuals are rounded to 2 dp, so fits land within ~0.1%

// ---------------------------------------------------------------------------
// Synthetic history: `weeks` records, 40 players per position, ranks spread
// 1..32, ratio = intercept + slope × frac (+ optional noise).
// ---------------------------------------------------------------------------
function synth(weeks, slope, intercept, noise) {
  const out = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; };
  for (let w = 1; w <= weeks; w++) {
    const fpa = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      for (let i = 0; i < 40; i++) {
        const rank = 1 + (i % 32);
        const frac = (rank - 1) / 31;
        const proj = 8 + (i % 7) * 2;
        const ratio = intercept + slope * frac + (noise ? rnd() * noise : 0);
        fpa[`${pos} ${i} w${w}`] = { id: String(i), pos, team: 'X', opp: 'Y', fpaRating: 20 - frac * 10, fpaRank: rank, fpaTeams: 32, proj, actualPoints: +(proj * ratio).toFixed(2) };
      }
    }
    out.push({ season: '2026', week: w, fpa, usage: {}, backtest: {} });
  }
  return out;
}

// --- calibration: too few weeks → inactive, every scale 1
let c = Cal.build(synth(2, -0.4, 1.2));
assert.strictEqual(c.active, false);
assert.strictEqual(Cal.scaleFor(c, 'WR'), 1);
near(c.byPos.WR.scale, 1);
assert.deepStrictEqual(c.weeks, [1, 2]);

// --- perfectly modelled data (slope −0.4) → scale ≈ 1 at any confidence
c = Cal.build(synth(6, -0.4, 1.2));
assert.strictEqual(c.active, true);
near(c.byPos.WR.rawScale, 1, FIT_EPS);
near(Cal.scaleFor(c, 'WR'), 1, FIT_EPS);
near(c.overall.rawScale, 1, FIT_EPS);

// --- half the modelled effect (slope −0.2) → rawScale 0.5; full confidence at 6 weeks
c = Cal.build(synth(6, -0.2, 1.1));
near(c.byPos.RB.rawScale, 0.5, FIT_EPS);
near(c.byPos.RB.confidence, 1);
near(Cal.scaleFor(c, 'RB'), 0.5, FIT_EPS);

// --- same data with only 3 weeks → confidence 0.25 → scale shrunk toward 1
c = Cal.build(synth(3, -0.2, 1.1));
near(c.byPos.RB.confidence, 0.25);
near(Cal.scaleFor(c, 'RB'), 1 + (0.5 - 1) * 0.25, FIT_EPS);

// --- no relationship → scale 0 (matchup factor switched off)
c = Cal.build(synth(6, 0, 1.0));
near(c.byPos.TE.rawScale, 0, FIT_EPS);
near(Cal.scaleFor(c, 'TE'), 0, FIT_EPS);

// --- backwards relationship clamps to 0, not negative
c = Cal.build(synth(6, 0.3, 0.9));
near(Cal.scaleFor(c, 'QB'), 0, FIT_EPS);

// --- 1.5× the modelled effect caps at 1.5
c = Cal.build(synth(6, -0.8, 1.4));
near(Cal.scaleFor(c, 'WR'), 1.5, FIT_EPS);

// --- noisy data still recovers the slope roughly; per-position falls back to pooled when thin
c = Cal.build(synth(6, -0.4, 1.2, 0.3));
assert.ok(Math.abs(c.byPos.WR.rawScale - 1) < 0.35, `noisy rawScale ${c.byPos.WR.rawScale}`);
const thin = synth(6, -0.2, 1.1).map(h => { const f = {}; let k = 0; for (const n in h.fpa) if (h.fpa[n].pos !== 'K' && (h.fpa[n].pos !== 'TE' || k++ < 5)) f[n] = h.fpa[n]; return Object.assign({}, h, { fpa: f }); });
c = Cal.build(thin);
assert.strictEqual(c.byPos.TE.enough, false);
near(Cal.scaleFor(c, 'TE'), Cal.scaleFor(c, 'K') /* pooled */, 1e-9);
near(c.overall.rawScale, 0.5, FIT_EPS);

// --- samples ignore sub-MIN_PROJ projections, missing ranks and missing actuals
const s = Cal.samples([{ week: 1, fpa: {
  a: { pos: 'WR', fpaRank: 1, fpaTeams: 32, proj: 4, actualPoints: 10 },
  b: { pos: 'WR', fpaRank: null, fpaTeams: null, proj: 12, actualPoints: 10 },
  c: { pos: 'WR', fpaRank: 5, fpaTeams: 32, proj: 12, actualPoints: null },
  d: { pos: 'WR', fpaRank: 5, fpaTeams: 32, proj: 12, actualPoints: 60 },
} }]);
assert.strictEqual(s.length, 1);
near(s[0].ratio, 3);   // capped

// --- weekly-score hook: calibration rescales the swing before season damping
const fpa = { positions: { WR: 13 }, historical: { WR: { A: 20, B: 16, C: 12, D: 8 } }, current: { WR: { A: 20, B: 16, C: 12, D: 8 } } };
let m = W.matchupMultiplier('WR', 'A', fpa, 8);
near(m.mult, 1.2); assert.strictEqual(m.n, 4); near(m.scale, 1);
fpa.calibration = { active: true, weeks: [1, 2, 3], byPos: { WR: { enough: true, scale: 0.5 } }, overall: { enough: true, scale: 0.8 } };
m = W.matchupMultiplier('WR', 'A', fpa, 8);
near(m.mult, 1.1); near(m.scale, 0.5);
assert.ok(/swing ×0.50 from 3-wk calibration/.test(m.detail), m.detail);
m = W.matchupMultiplier('WR', 'D', fpa, 8);
near(m.mult, 0.9);
m = W.matchupMultiplier('WR', 'A', fpa, 4);          // half season weight on top: 1 + 0.1 × 0.5
near(m.mult, 1.05);
m = W.matchupMultiplier('RB', 'A', Object.assign({}, fpa, { historical: { RB: { A: 20, B: 8 } }, current: { RB: {} } }), 8);
near(m.scale, 0.8);                                   // no RB fit → pooled
fpa.calibration.active = false;
m = W.matchupMultiplier('WR', 'A', fpa, 8);
near(m.mult, 1.2); near(m.scale, 1);
near(W.calibrationScale(null, 'WR'), 1);
near(W.calibrationScale({ calibration: { active: true, byPos: {}, overall: { enough: false } } }, 'WR'), 1);

// ---------------------------------------------------------------------------
// log-week pure derivations
// ---------------------------------------------------------------------------
const row = (id, first, last, pos, team, opp, st) => ({ player_id: id, team, opponent: opp, player: { first_name: first, last_name: last, position: pos }, stats: st });
const rows = [
  row('1', 'A', 'Back', 'RB', 'KC', 'LV', { gp: 1, rush_att: 15, rec_tgt: 3, off_snp: 40, tm_off_snp: 60, pts_half_ppr: 12 }),
  row('2', 'B', 'Back', 'RB', 'KC', 'LV', { gp: 1, rush_att: 5, rec_tgt: 1, off_snp: 20, tm_off_snp: 60, pts_half_ppr: 4 }),
  row('3', 'C', 'Wide', 'WR', 'KC', 'LV', { gp: 1, rec_tgt: 8, off_snp: 55, tm_off_snp: 60, pts_half_ppr: 15 }),
  row('4', 'D', 'Pass', 'QB', 'KC', 'LV', { gp: 1, rush_att: 4, pass_att: 30, off_snp: 60, tm_off_snp: 60, pts_half_ppr: 20 }),
  row('5', 'E', 'Cut', 'WR', 'KC', 'LV', { gp: 0, rec_tgt: 0, off_snp: 0, tm_off_snp: 60 }),   // no snap → no usage row
  row('KC', 'Kansas City', 'Chiefs', 'DEF', 'KC', 'LV', { pts_half_ppr: 6 }),
  row('LV_TEAM', '', '', 'TEAM', 'LV', 'KC', { rush_att: 99, rec_tgt: 99 }),                     // aggregate row → ignored
  row('6', 'F', 'Raider', 'RB', 'LV', 'KC', { gp: 1, rush_att: 10, rec_tgt: 2, off_snp: 30, tm_off_snp: 50, pts_half_ppr: 9 }),
];
const u = LW.usageFrom(rows);
assert.deepStrictEqual(Object.keys(u).sort(), ['1', '2', '3', '6']);
near(u['1'].carryShare, 15 / 24);   // KC rush = 15 + 5 + 4 (QB counts) — TEAM row excluded
near(u['3'].tgtShare, 8 / 12);
near(u['3'].snapPct, 55 / 60);
assert.strictEqual(u['6'].name, 'F Raider');

const f = LW.fpaCurrentFrom([rows]);
near(f.current.RB.LV, 16);          // 12 + 4 allowed by LV to RBs ÷ 1 game
near(f.current.WR.LV, 15);
near(f.current.QB.LV, 20);
near(f.current.RB.KC, 9);
assert.strictEqual(f.games.LV, 1);
assert.strictEqual(LW.isComplete(rows), false);   // only 2 defences

// --- backtest entry validation
assert.strictEqual(LW.cleanBacktest(null), null);
assert.strictEqual(LW.cleanBacktest({ algoScore: 'x' }), null);
const cb = LW.cleanBacktest({ username: 'pykle', league: 'L', algoScore: 100, optimalScore: 125, yourScore: 110 });
near(cb.accuracy, 0.8); near(cb.yourAccuracy, 0.88);

// --- file round-trip: write, merge backtest on rewrite, loadHistory ordering
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-history-'));
const rec = w => ({ season: '2026', week: w, generatedAt: new Date().toISOString(), fpa: {}, usage: {}, backtest: {}, meta: {} });
LW.writeWeekRecord(Object.assign(rec(2), { backtest: { '111': { algoScore: 1, optimalScore: 2 } } }), { dir });
LW.writeWeekRecord(rec(1), { dir });
LW.writeWeekRecord(Object.assign(rec(2), { backtest: { '222': { algoScore: 3, optimalScore: 4 } } }), { dir });
fs.writeFileSync(path.join(dir, '2026-week-9.json'), '{not json');
fs.writeFileSync(path.join(dir, '2025-week-3.json'), JSON.stringify(rec(3)));
const hist = LW.loadHistory({ dir });
assert.deepStrictEqual(hist.map(h => h.week), [1, 2]);
assert.deepStrictEqual(Object.keys(hist[1].backtest).sort(), ['111', '222']);   // merged, not replaced
assert.strictEqual(LW.readWeekRecord(3, { dir }), null);
assert.strictEqual(LW.historyPath(4, '2026', dir), path.join(dir, '2026-week-4.json'));
fs.rmSync(dir, { recursive: true, force: true });

console.log('week-history: offline checks passed');

// ---------------------------------------------------------------------------
// Live: build Week 1 from Sleeper and check the logged shape
// ---------------------------------------------------------------------------
if (offline) { console.log('week-history: live check skipped (--offline)'); process.exit(0); }
(async () => {
  const r = await LW.buildWeekRecord({ week: 1, season: '2026', history: [], log: () => {} });
  assert.strictEqual(r.season, '2026');
  assert.strictEqual(r.week, 1);
  assert.strictEqual(r.scoring, 'half_ppr');
  assert.strictEqual(r.weeksPlayed, 0);
  assert.ok(Date.parse(r.generatedAt) > 0);
  assert.deepStrictEqual(Object.keys(r).sort(), ['backtest', 'fpa', 'generatedAt', 'meta', 'scoring', 'season', 'usage', 'week', 'weeksPlayed']);
  assert.ok(r.meta.completeWeeks.includes(1));

  const fpaNames = Object.keys(r.fpa);
  assert.ok(fpaNames.length > 250, `fpa samples ${fpaNames.length}`);
  for (const n of fpaNames) {
    const e = r.fpa[n];
    assert.deepStrictEqual(Object.keys(e), ['id', 'pos', 'team', 'opp', 'fpaRating', 'fpaRank', 'fpaTeams', 'proj', 'actualPoints'], n);
    assert.ok(/^\d+$/.test(e.id) && ['QB', 'RB', 'WR', 'TE', 'K'].includes(e.pos), n);
    assert.ok(typeof e.proj === 'number' && typeof e.actualPoints === 'number', n);
    assert.strictEqual(e.fpaRank, null, 'week 1 has no prior FPA → rank null');
  }
  assert.strictEqual(r.meta.fpaRanked, 0);
  const chase = r.fpa["Ja'Marr Chase"];
  assert.ok(chase && chase.id === '7564' && chase.team === 'CIN' && chase.opp === 'TB' && chase.proj > 10, JSON.stringify(chase));

  const ids = Object.keys(r.usage);
  assert.ok(ids.length > 250, `usage players ${ids.length}`);
  for (const id of ids) {
    const e = r.usage[id];
    assert.deepStrictEqual(Object.keys(e), ['name', 'pos', 'team', 'targetShareAvg', 'carryShareAvg', 'snapPctAvg', 'weeks', 'last'], id);
    assert.ok(['RB', 'WR', 'TE'].includes(e.pos), id);
    assert.strictEqual(e.weeks, 1);
    assert.ok(e.last && e.last.snapPct > 0 && e.last.snapPct <= 1, id);
    assert.strictEqual(e.last.targetShare, e.targetShareAvg);   // 1 week → avg == last
    for (const k of ['targetShareAvg', 'carryShareAvg', 'snapPctAvg']) assert.ok(e[k] == null || (e[k] >= 0 && e[k] <= 1), `${id} ${k}`);
  }
  // team shares sum to ~1 across a team's usage rows + non-logged players, so never exceed 1
  const byTeam = {};
  for (const id of ids) { const e = r.usage[id]; byTeam[e.team] = (byTeam[e.team] || 0) + (e.last.targetShare || 0); }
  for (const t in byTeam) assert.ok(byTeam[t] <= 1.005, `${t} target share sum ${byTeam[t]}`);   // 4-dp rounding per player
  assert.ok(r.usage['7564'] && r.usage['7564'].name === "Ja'Marr Chase" && r.usage['7564'].last.targetShare > 0);

  assert.deepStrictEqual(r.backtest, {});
  const bytes = Buffer.byteLength(JSON.stringify(r));
  assert.ok(bytes < 300 * 1024, `record is ${bytes} bytes`);
  console.log(`week-history: live Week 1 build OK — ${fpaNames.length} fpa samples, ${ids.length} usage players, ${Math.round(bytes / 1024)} KB`);
})().catch(err => { console.error('week-history live check failed:', err.stack || err.message); process.exit(1); });
