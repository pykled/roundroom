#!/usr/bin/env node
// Tests for the NBA draft simulator (nba/sim/*). Plain node, offline, exits 0 on pass.
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const assert = require('assert');
const V = require('../nba/sim/valuation');
const L = require('../nba/sim/lineup');
const E = require('../nba/sim/engine');
const R = require('../nba/sim/run');
const P = require('../nba/sim/policies');

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('ok  ', name); } catch (e) { fail++; console.log('FAIL', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
}

(async () => {
  const pool = await V.loadPool();
  const lay = pool.layout;
  const players = pool.players;

  await t('layout: 7 positional + 2 UTIL = 9 starters', () => {
    assert.deepStrictEqual(lay.positional, ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C']);
    assert.strictEqual(lay.util, 2);
    assert.strictEqual(lay.starters, 9);
    assert.strictEqual(pool.profile.rosterSize, 16);
  });

  await t('snake order: 12 teams, round 2 reverses, 16 picks each over 192', () => {
    const r1 = Array.from({ length: 12 }, (_, i) => E.pickTeam(12, i));
    const r2 = Array.from({ length: 12 }, (_, i) => E.pickTeam(12, 12 + i));
    assert.deepStrictEqual(r1, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepStrictEqual(r2, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    assert.strictEqual(E.pickTeam(12, 24), 0);
    assert.strictEqual(E.pickTeam(12, 191), 0); // round 16 is even-indexed reversal → team 0 picks last
    const cnt = new Array(12).fill(0);
    for (let p = 0; p < 192; p++) cnt[E.pickTeam(12, p)]++;
    assert.ok(cnt.every(c => c === 16));
    // slot 12 (idx 11) picks 12 and 13 back to back
    assert.strictEqual(E.pickTeam(12, 11), 11); assert.strictEqual(E.pickTeam(12, 12), 11);
  });

  await t('eligibility: C-only is not F; G/F fills SG/SF/G/F; F/C fills PF/F/C', () => {
    const el = pos => L.eligibleSlots({ pos }, lay);
    assert.deepStrictEqual(el(['C']), ['C', 'UTIL']);
    assert.ok(!el(['C']).includes('F') && !el(['C']).includes('PF'));
    assert.deepStrictEqual(el(['SG', 'SF']), ['SG', 'G', 'SF', 'F', 'UTIL']);
    assert.deepStrictEqual(el(['G/F']), ['SG', 'G', 'SF', 'F', 'UTIL']);
    assert.deepStrictEqual(el(['F/C']), ['PF', 'F', 'C', 'UTIL']);
    assert.deepStrictEqual(el(['C', 'PF']), ['PF', 'F', 'C', 'UTIL']);
    assert.deepStrictEqual(el(['PG']), ['PG', 'G', 'UTIL']);
    assert.deepStrictEqual(el(['G']), ['SG', 'G', 'UTIL']); // Yahoo "G" token: not PG per the legend
    assert.deepStrictEqual(el(['PG,SG']), ['PG', 'SG', 'G', 'UTIL']);
    assert.deepStrictEqual(L.eligibleSlots({ pos: ['C'], yahooElig: ['PF', 'C', 'UTIL'] }, lay), ['PF', 'C', 'UTIL']);
  });

  await t('assignment: 4 C-only bigs → only 3 start (C + 2 UTIL)', () => {
    const m = L.slotMask({ pos: ['C'] }, lay);
    const r = L.assign([50, 40, 30, 20], [m, m, m, m], lay, true);
    assert.strictEqual(r.value, 120);
    assert.deepStrictEqual(r.starters, [0, 1, 2]);
    assert.ok(r.slotOf.filter(s => s === 'UTIL').length === 2 && r.slotOf.includes('C'));
  });

  await t('assignment: G/F wing slides to SF/F when guards are full', () => {
    const pg = L.slotMask({ pos: ['PG'] }, lay), sg = L.slotMask({ pos: ['SG'] }, lay), gf = L.slotMask({ pos: ['SG', 'SF'] }, lay), c = L.slotMask({ pos: ['C'] }, lay);
    // 3 guards fill PG/SG/G, 2 wings must take SF/F, plus 2 PGs to UTIL, one C
    const r = L.assign([40, 39, 38, 37, 36, 35, 34, 33], [pg, sg, pg, gf, gf, pg, pg, c], lay, true);
    assert.strictEqual(r.value, 40 + 39 + 38 + 37 + 36 + 35 + 34 + 33);
    assert.ok(['SF', 'F', 'SG', 'G'].includes(r.slotOf[3]) && ['SF', 'F', 'SG', 'G'].includes(r.slotOf[4]));
  });

  await t('assignment: DP equals brute force on 300 random rosters', () => {
    const rng = require('../nba/sim/rng').rng(42, 'bf');
    const posSets = [['PG'], ['SG'], ['SF'], ['PF'], ['C'], ['PG', 'SG'], ['SG', 'SF'], ['SF', 'PF'], ['PF', 'C'], ['G'], ['F']];
    const slots = [...lay.positional, 'UTIL', 'UTIL'];
    for (let it = 0; it < 300; it++) {
      const n = 3 + Math.floor(rng() * 9);
      const ps = Array.from({ length: n }, () => ({ pos: posSets[Math.floor(rng() * posSets.length)], v: Math.round(rng() * 60) }));
      const masks = ps.map(p => L.slotMask(p, lay));
      const el = ps.map(p => L.eligibleSlots(p, lay));
      let best = 0;
      const used = new Array(n).fill(false);
      (function rec(s, acc) {
        if (s === slots.length) { if (acc > best) best = acc; return; }
        rec(s + 1, acc);
        for (let i = 0; i < n; i++) if (!used[i] && el[i].includes(slots[s])) { used[i] = true; rec(s + 1, acc + ps[i].v); used[i] = false; }
      })(0, 0);
      const dp = L.assign(ps.map(p => p.v), masks, lay, true);
      assert.strictEqual(dp.value, best, `roster ${JSON.stringify(ps)}`);
      assert.strictEqual(dp.starters.reduce((s, i) => s + ps[i].v, 0), best);
    }
  });

  await t('valuation: no NaN, 22 matchup weeks incl. two 14-day weeks mapped to 2 Sleeper weeks', () => {
    assert.strictEqual(pool.weeks, 22);
    assert.strictEqual(pool.profile.weeks.filter(w => w.days === 14).length, 2);
    pool.profile.weeks.forEach((w, i) => assert.ok(pool.weekMap[i].length === (w.days === 14 ? 2 : 1), `week ${w.week}`));
    for (const p of players) {
      for (const k of ['value', 'mean', 'sd', 'ceiling', 'floor']) assert.ok(Number.isFinite(p[k]), `${p.name} ${k}`);
      assert.ok(p.weekEV.every(Number.isFinite) && p.games.every(Number.isFinite));
      if (p.outForSeason) assert.strictEqual(p.value, 0);
    }
    assert.ok(players[0].value > 50 && players[0].value < 100);
  });

  await t('scoring: DD/TD bonus + tdAlsoCountsDD flag; TO/PF/TECH negative', () => {
    const sc = pool.profile.scoring;
    const row = [0, 1, 0, 30, 20, 10, 10, 1, 1, 3, 2, 1]; // TD line
    const base = 20 + 12 + 15 + 3 + 3 - 3 - 2 - 1;
    assert.strictEqual(+V.rowScore(row, sc, { tdAlsoCountsDD: true }).toFixed(6), +(base + 8).toFixed(6));
    assert.strictEqual(+V.rowScore(row, sc, { tdAlsoCountsDD: false }).toFixed(6), +(base + 3).toFixed(6));
    const dd = [0, 1, 0, 30, 12, 11, 2, 0, 0, 0, 0, 0];
    assert.strictEqual(+V.rowScore(dd, sc, {}).toFixed(6), +(12 + 13.2 + 3 + 5).toFixed(6));
  });

  await t('engine API: createDraft / pickPlayer / botPick / teamValue / recommend', () => {
    const d = E.createDraft({ players, layout: lay, mySlot: 3, seed: 5 });
    assert.strictEqual(E.teamOnClock(d), 0);
    const b = E.botPick(d, 0);
    assert.ok(b >= 0 && !d.taken[b]);
    E.pickPlayer(d, b);
    assert.throws(() => E.pickPlayer(d, b), /already drafted/);
    assert.throws(() => E.pickPlayer(d, 0, 5), /not on the clock/);
    const rec = E.recommend([], E.availableIdx(d), { players, layout: lay, picksUntilNext: 2, consensus: d.consensus });
    assert.ok(rec.length > 10 && rec.every((r, i) => i === 0 || rec[i - 1].score >= r.score));
    assert.ok(rec.every(r => Number.isFinite(r.score) && !d.taken[r.idx]));
    assert.ok(E.teamValue([players[0], players[1]], lay) > players[0].value);
    assert.strictEqual(E.teamValue([], lay), 0);
  });

  await t('192-pick draft completes in < 2s with roster-size invariants', () => {
    const t0 = Date.now();
    const d = E.runDraft({ players, layout: lay, mySlot: 7, seed: 9, policy: 'vorp' });
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `took ${ms}ms`);
    assert.strictEqual(d.picks.length, 192);
    assert.ok(d.rosters.every(r => r.length === 16));
    assert.strictEqual(new Set(d.picks.map(p => p.idx)).size, 192);
    assert.ok(d.picks.every((p, i) => p.team === E.pickTeam(12, i)));
    console.log(`      (vorp draft ${ms} ms)`);
  });

  await t('determinism by seed; different seed differs; no NaN in results', () => {
    const a = R.runOne(pool, { seed: 3, sim: 1, mySlot: 2, policy: 'vorp' });
    const b = R.runOne(pool, { seed: 3, sim: 1, mySlot: 2, policy: 'vorp' });
    const c = R.runOne(pool, { seed: 4, sim: 1, mySlot: 2, policy: 'vorp' });
    assert.deepStrictEqual(a.picks, b.picks);
    assert.strictEqual(a.allPlay, b.allPlay);
    assert.notDeepStrictEqual(a.picks, c.picks);
    for (const k of ['teamValue', 'meanWeekly', 'allPlay', 'wins', 'benchStartShare']) assert.ok(Number.isFinite(a[k]), k);
  });

  await t('policy sanity: VORP-per-need >= best-available over 300 drafts (paired)', () => {
    const vs = [], bf = [], bp = [];
    for (let k = 0; k < 300; k++) {
      const slot = k % 12;
      vs.push(R.runOne(pool, { seed: 11, sim: k, mySlot: slot, policy: 'vorp' }));
      bf.push(R.runOne(pool, { seed: 11, sim: k, mySlot: slot, policy: 'bpa-fill' }));
      bp.push(R.runOne(pool, { seed: 11, sim: k, mySlot: slot, policy: 'bpa' }));
    }
    const d1 = R.paired(vs.map(r => r.allPlay), bf.map(r => r.allPlay));
    const d2 = R.paired(vs.map(r => r.allPlay), bp.map(r => r.allPlay));
    const d3 = R.paired(vs.map(r => r.teamValue), bf.map(r => r.teamValue));
    const line = `vorp - bpa-fill all-play ${(d1.mean * 100).toFixed(2)}pp [${(d1.lo * 100).toFixed(2)}, ${(d1.hi * 100).toFixed(2)}]; teamValue ${d3.mean.toFixed(2)} [${d3.lo.toFixed(2)}, ${d3.hi.toFixed(2)}]; vorp - bpa(rank) all-play ${(d2.mean * 100).toFixed(2)}pp`;
    console.log('      ' + line);
    results.push(line);
    assert.ok(d1.mean >= 0, 'REPORT: VORP-per-need lost to best-available-that-fills: ' + line);
    assert.ok(d2.mean >= 0, 'REPORT: VORP-per-need lost to best-available-by-rank: ' + line);
  });

  await t('groupsOf: C-only → C; PG → G; SG/SF → G,F', () => {
    assert.deepStrictEqual(P.groupsOf({ mask: L.slotMask({ pos: ['C'] }, lay) }, lay), ['C']);
    assert.deepStrictEqual(P.groupsOf({ mask: L.slotMask({ pos: ['PG'] }, lay) }, lay), ['G']);
    assert.deepStrictEqual(P.groupsOf({ mask: L.slotMask({ pos: ['SG', 'SF'] }, lay) }, lay), ['G', 'F']);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
