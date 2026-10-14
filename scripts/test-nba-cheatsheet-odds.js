#!/usr/bin/env node
/* Draft cheat sheet: pick order (snake + third-round reversal), ADP
   availability odds, per-pick ranges, and sanity checks on the committed
   NBA data the odds are built from.
   Run: node scripts/test-nba-cheatsheet-odds.js   (exit 0 = all pass) */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'nba', 'pages', 'draft-logic.js'));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error((msg ? msg + ': ' : '') + 'expected ' + B + ', got ' + A);
}
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy'); }

/* ----------------------------------------------------------- pick order */
console.log('pick order');
// Independent reference: build each round's order explicitly.
function refOrder(teams, rounds, rr) {
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    let fwd = r % 2 === 1;
    if (rr && r === 3) fwd = false;          // round 3 repeats round 2's direction
    else if (rr && r > 3) fwd = r % 2 === 0; // then alternate again: 4 fwd, 5 rev, ...
    for (let i = 0; i < teams; i++) out.push(fwd ? i + 1 : teams - i);
  }
  return out; // out[pick-1] = slot
}
t('12 teams, no 3RR: slot 1 → 1,24,25,48; slot 12 → 12,13,36,37', () => {
  eq(L.picksForSlot(1, 12, 4), [1, 24, 25, 48]);
  eq(L.picksForSlot(12, 12, 4), [12, 13, 36, 37]);
});
t('12 teams, 3RR: slot 1 → 1,24,36,37,60,61; slot 12 → 12,13,25,48,49,72', () => {
  eq(L.picksForSlot(1, 12, 6, 1, true), [1, 24, 36, 37, 60, 61]);
  eq(L.picksForSlot(12, 12, 6, 1, true), [12, 13, 25, 48, 49, 72]);
  eq(L.picksForSlot(6, 12, 4, 1, true), [6, 19, 31, 42]);
});
[8, 10, 12, 14].forEach(n => {
  [false, true].forEach(rr => {
    t(n + ' teams, 3RR ' + (rr ? 'on' : 'off') + ': every slot matches the reference order for 16 rounds', () => {
      const ref = refOrder(n, 16, rr);
      for (let s = 1; s <= n; s++) {
        const want = []; ref.forEach((x, i) => { if (x === s) want.push(i + 1); });
        eq(L.picksForSlot(s, n, 16, 1, rr), want, 'slot ' + s);
      }
      ref.forEach((s, i) => { if (L.slotForPick(i + 1, n, rr) !== s) throw new Error('slotForPick ' + (i + 1)); });
      L.snakeOrder(n, 16, rr).forEach(o => { if (o.slot !== ref[o.pick - 1]) throw new Error('snakeOrder ' + o.pick); });
    });
  });
  t(n + ' teams, 3RR: rounds 1-2 unchanged, round 3 = round 2 order, round 4 = round 1 order', () => {
    for (let s = 1; s <= n; s++) {
      const a = L.picksForSlot(s, n, 4, 1, true), b = L.picksForSlot(s, n, 4, 1, false);
      eq(a.slice(0, 2), b.slice(0, 2));
      eq(a[2] - 2 * n, a[1] - n, 'R3 position = R2 position');
      eq(a[3] - 3 * n, a[0], 'R4 position = R1 position');
    }
  });
});
t('3RR flows through settings: nextPickFor / myPicksSnake / mergePicks slot', () => {
  const st = L.normalizeSettings(Object.assign({}, L.DEFAULT_SETTINGS, { mySlot: 12, thirdRoundReversal: true }));
  ok(st.thirdRoundReversal === true, 'kept by normalizeSettings');
  eq(L.nextPickFor(12, 14, st), 25);
  eq(L.myPicksSnake(st, 1).slice(0, 4), [{ pick: 12, round: 1 }, { pick: 13, round: 2 }, { pick: 25, round: 3 }, { pick: 48, round: 4 }]);
  const plain = L.normalizeSettings(Object.assign({}, L.DEFAULT_SETTINGS, { mySlot: 12 }));
  eq(L.nextPickFor(12, 14, plain), 36);
  ok(!('thirdRoundReversal' in plain), 'off = key absent (old settings shape)');
  const m = L.mergePicks(null, [{ playerId: 'a' }, { playerId: 'b' }].concat(Array.from({ length: 23 }, (_, i) => ({ playerId: 'x' + i }))), { settings: st });
  eq(m.picks[24].pick, 25); eq(m.picks[24].slot, 12, 'pick 25 belongs to slot 12 under 3RR');
});
t('3RR survives save/load and a league-profile refresh', () => {
  const s0 = L.emptyState(null, Object.assign({}, L.DEFAULT_SETTINGS, { thirdRoundReversal: true }));
  ok(L.deserializeState(L.serializeState(s0), null).settings.thirdRoundReversal === true);
  const prof = { teams: 12, slots: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2, BN: 5, IL: 2 }, draft: { rounds: 14 } };
  ok(L.settingsFromProfile(prof, { mySlot: 4, thirdRoundReversal: true }).thirdRoundReversal === true, 'profile without the flag keeps the user choice');
  ok(!L.settingsFromProfile(Object.assign({}, prof, { draft: { rounds: 14, thirdRoundReversal: false } }), { thirdRoundReversal: true }).thirdRoundReversal, 'explicit profile flag wins');
});

/* ------------------------------------------------------- availability */
console.log('availability odds');
function pool(n) { const out = []; for (let i = 0; i < n; i++) out.push({ id: String(i), name: 'P' + i, pos: ['PG', 'SF', 'C'][i % 3], hsValue: 100 - i * 0.3, marketRank: i + 1, tier: 1 + Math.floor(i / 10) }); return out; }
t('nobody gone yet at the pick on the clock: P = 1', () => {
  const ps = pool(200), m = L.adpModel(ps, 1);
  ok(ps.every(p => m.pAvail(p, 1) === 1));
});
t('P(available at k) falls as k grows (every player, picks 1..180)', () => {
  const ps = pool(300), m = L.adpModel(ps, 1);
  ps.slice(0, 150).forEach(p => {
    let prev = 1;
    for (let k = 2; k <= 180; k++) { const q = m.pAvail(p, k); if (q > prev + 1e-9) throw new Error(p.name + ' rises at ' + k); prev = q; }
  });
});
t('P(available at k) rises with ADP (later ADP = more likely there)', () => {
  const ps = pool(300), m = L.adpModel(ps, 1);
  [6, 13, 30, 43, 67, 120].forEach(k => {
    for (let i = 1; i < 250; i++) if (m.pAvail(ps[i], k) + 1e-9 < m.pAvail(ps[i - 1], k)) throw new Error('k ' + k + ' at adp ' + (i + 1));
  });
});
t('expected players gone before pick k = k − 1 (odds add up)', () => {
  const ps = pool(400), m = L.adpModel(ps, 1);
  [2, 6, 12, 25, 60, 120, 168].forEach(k => {
    const gone = ps.reduce((s, p) => s + 1 - m.pAvail(p, k), 0);
    ok(Math.abs(gone - (k - 1)) < 0.01, 'k ' + k + ': ' + gone);
  });
});
t('calibrated shape: ADP 1 gone by 6, ADP 20 likely at 12 and gone by 30, ADP 60 ~50% at 60', () => {
  const ps = pool(400), m = L.adpModel(ps, 1);
  ok(m.pAvail(ps[0], 6) < 0.05, 'adp1@6 ' + m.pAvail(ps[0], 6));
  ok(m.pAvail(ps[19], 12) > 0.9, 'adp20@12 ' + m.pAvail(ps[19], 12));
  ok(m.pAvail(ps[19], 30) < 0.1, 'adp20@30 ' + m.pAvail(ps[19], 30));
  const q = m.pAvail(ps[59], 60); ok(q > 0.4 && q < 0.6, 'adp60@60 ' + q);
});
t('mid-draft re-centring: a faller (ADP 3 still there at pick 10) is likely gone soon', () => {
  const ps = pool(300), avail = ps.slice(9).concat([ps[2]]); // picks 1-9 took ADP 1,2,4..10
  const m = L.adpModel(avail, 10);
  eq(m.mu(ps[2]), 10, 'faller tops the market now');
  ok(m.pAvail(ps[2], 10) === 1 && m.pAvail(ps[2], 15) < 0.2 && m.pAvail(ps[2], 18) < 0.05, 'gone within a few picks');
  const gone = avail.reduce((s, p) => s + 1 - m.pAvail(p, 22), 0);
  ok(Math.abs(gone - 12) < 0.01, '12 picks between 10 and 22: ' + gone);
});
t('players without ADP sit behind every ranked player (stay available)', () => {
  const ps = pool(200); ps.push({ id: 'nomkt', name: 'No ADP', pos: ['C'], hsValue: 99 });
  const m = L.adpModel(ps, 1);
  eq(m.mu(ps[200]), 201);
  ok(m.pAvail(ps[200], 150) >= m.pAvail(ps[199], 150) && m.pAvail(ps[200], 100) > 0.99);
});
t('adpSd grows with ADP and is capped', () => {
  ok(L.adpSd(1) < L.adpSd(20) && L.adpSd(20) < L.adpSd(100) && L.adpSd(1000) === 40);
  ok(Math.abs(L.normCdf(0) - 0.5) < 1e-7 && Math.abs(L.normCdf(1.96) - 0.975) < 1e-4);
});

/* ------------------------------------------------------- per-pick plan */
console.log('cheat sheet ranges');
const LP = Object.assign({}, L.DEFAULT_SETTINGS);
// Value order ≠ market order: ids 0..199 by value; market rank shuffled ±.
function marketPool() {
  const ps = pool(260);
  // A value player the market undervalues (value #3, ADP 40) and an overvalued one (value #50, ADP 5).
  const key = new Map(ps.map((p, i) => [p, i + 1]));
  key.set(ps[2], 40.5); key.set(ps[49], 4.5);
  ps.slice().sort((a, b) => key.get(a) - key.get(b)).forEach((p, i) => { p.marketRank = i + 1; });
  return ps;
}
t('every listed player is in the right band; take/fallback ≥75%, could 25-75%, gone <25%', () => {
  const ps = marketPool(), st = Object.assign({}, LP, { mySlot: 6 });
  const cs = L.cheatSheet({ available: ps, settings: st, cur: 1, myPicks: L.myPicksSnake(st, 1), roster: [] });
  eq(cs.rounds.length, 14);
  cs.rounds.forEach(r => {
    [r.take].concat(r.fallback, r.expect).filter(Boolean).forEach(x => ok(x.p >= 0.75, r.pick + ' ' + x.player.name + ' ' + x.p));
    r.could.forEach(x => ok(x.p >= 0.25 && x.p < 0.75, 'could ' + x.p));
    r.gone.forEach(x => ok(x.p < 0.25, 'gone ' + x.p));
    r.wait.forEach(x => ok(x.pNext >= 0.6 && r.next, 'wait ' + x.pNext));
    ok(!r.range || r.range.lo <= r.range.hi, 'range');
  });
});
t('Out / IR players are never the Target or fallback; Rest DTD tags do not block', () => {
  const ps = marketPool(), st = Object.assign({}, LP, { mySlot: 6 });
  const base = L.cheatSheet({ available: ps, settings: st, cur: 1, myPicks: L.myPicksSnake(st, 1), roster: [] });
  const victim = base.rounds[3].take.player;
  const hurt = ps.map(p => p === victim ? Object.assign({}, p, { injury: 'Out', injuryBody: 'Foot' }) : p);
  const cs = L.cheatSheet({ available: hurt, settings: st, cur: 1, myPicks: L.myPicksSnake(st, 1), roster: [] });
  cs.rounds.forEach(r => [r.take].concat(r.fallback).filter(Boolean).forEach(x => ok(x.player.id !== victim.id, 'Out player targeted at ' + r.pick)));
  const rest = ps.map(p => p === victim ? Object.assign({}, p, { injury: 'DTD', injuryBody: 'Rest' }) : p);
  const cs2 = L.cheatSheet({ available: rest, settings: st, cur: 1, myPicks: L.myPicksSnake(st, 1), roster: [] });
  eq(cs2.rounds[3].take.player.id, victim.id);
});
t('value guy the market sleeps on (ADP 40): Don\'t Reach at #6 and #19, the target at #30', () => {
  const ps = marketPool(), st = Object.assign({}, LP, { mySlot: 6 });
  const cs = L.cheatSheet({ available: ps, settings: st, cur: 1, myPicks: L.myPicksSnake(st, 1), roster: [] });
  const r1 = cs.rounds[0], r2 = cs.rounds[1], r3 = cs.rounds[2];
  eq([r1.pick, r2.pick, r3.pick], [6, 19, 30]);
  ok(r1.wait.some(x => x.player === ps[2]), 'wait at #6: ' + JSON.stringify(r1.wait.map(x => x.player.name)));
  ok(r2.wait.some(x => x.player === ps[2] && x.pNext >= 0.6), 'still a wait at #19 (likely there at #30)');
  ok(r1.take.player !== ps[2] && r2.take.player !== ps[2], 'not a target before #30');
  ok(r3.take.player === ps[2], '#30 target: ' + r3.take.player.name + ' (he is < 60% at #43)');
});
t('overvalued guy (value #50, ADP 5) is never a target at #6', () => {
  const ps = marketPool(), st = Object.assign({}, LP, { mySlot: 6 });
  const cs = L.cheatSheet({ available: ps, settings: st, cur: 1, myPicks: L.myPicksSnake(st, 1), roster: [] });
  ok(!cs.rounds[0].targets.some(x => x.player === ps[49] && x.p >= 0.75));
});
t('range follows the pick: pick 6 → ADP ~low single digits, pick 43 → ADP 30s-50s', () => {
  const ps = pool(300), st = Object.assign({}, LP, { mySlot: 6 });
  const cs = L.cheatSheet({ available: ps, settings: st, cur: 1, myPicks: L.myPicksSnake(st, 1), roster: [] });
  const r1 = cs.rounds[0].range, r4 = cs.rounds[3].range;
  ok(r1.lo >= 3 && r1.hi <= 9, JSON.stringify(r1));
  eq(cs.rounds[3].pick, 43);
  ok(r4.lo >= 30 && r4.lo <= 43 && r4.hi >= 43 && r4.hi <= 56, JSON.stringify(r4));
});
t('back-to-back turn (slot 12 at #12/#13): two different targets', () => {
  const ps = pool(300), st = Object.assign({}, LP, { mySlot: 12 });
  const cs = L.cheatSheet({ available: ps, settings: st, cur: 1, myPicks: L.myPicksSnake(st, 1), roster: [] });
  eq([cs.rounds[0].pick, cs.rounds[1].pick], [12, 13]);
  ok(cs.rounds[0].take && cs.rounds[1].take && cs.rounds[0].take.player !== cs.rounds[1].take.player);
});
t('3RR moves slot 12\'s third pick to #25 and the plan follows', () => {
  const ps = pool(300), st = Object.assign({}, LP, { mySlot: 12, thirdRoundReversal: true });
  const cs = L.cheatSheet({ available: ps, settings: st, cur: 1, myPicks: L.myPicksSnake(st, 1), roster: [] });
  eq(cs.rounds.slice(0, 4).map(r => r.pick), [12, 13, 25, 48]);
  ok(cs.rounds[2].range.lo < 30, 'R3 at #25 sees ADP ~20s: ' + JSON.stringify(cs.rounds[2].range));
});
t('out-for-season players are left off; picks before the clock are dropped', () => {
  const ps = pool(200); ps[30].outForSeason = true;
  const st = Object.assign({}, LP, { mySlot: 1 });
  const cs = L.cheatSheet({ available: ps.slice(25), settings: st, cur: 26, myPicks: L.myPicksSnake(st, 1), roster: [] });
  eq(cs.rounds[0].pick, 48);
  ok(!cs.rounds.some(r => r.expect.concat(r.could, r.gone).some(x => x.player === ps[30])));
  ok(!cs.bySlot.some(b => b.tiers.some(tr => tr.players.some(x => x.player === ps[30]))));
});
t('by-slot "last shot" = latest of my picks with P ≥ 50%', () => {
  const ps = pool(300), st = Object.assign({}, LP, { mySlot: 6 });
  const cs = L.cheatSheet({ available: ps, settings: st, cur: 1, myPicks: L.myPicksSnake(st, 1), roster: [] });
  const all = []; cs.bySlot.forEach(b => b.tiers.forEach(tr => tr.players.forEach(x => all.push(x))));
  const p0 = all.find(x => x.player === ps[0]); eq(p0.last, null, 'ADP 1 is gone before #6');
  const p20 = all.find(x => x.player === ps[19]); eq(p20.last && p20.last.pick, 19, 'ADP 20: last realistic shot is #19');
});
t('rest-day tags are not injuries; real ones stay', () => {
  eq(L.draftInjury({ injury: 'DTD', injuryBody: 'Rest' }), '');
  eq(L.draftInjury({ injury: 'GTD', injuryBody: 'Not Injury Related' }), '');
  eq(L.draftInjury({ injury: 'DTD', injuryBody: 'Hamstring' }), 'DTD');
  eq(L.draftInjury({ injury: 'Out', injuryBody: 'Rest' }), 'Out');
  eq(L.draftInjury({ injury: 'DTD' }), 'DTD');
});

/* --------------------------------------------------------- data sanity */
console.log('data sanity (data/nba)');
const market = require(path.join(ROOT, 'data', 'nba', 'market.json'));
const proj = require(path.join(ROOT, 'data', 'nba', 'proj-2026.json'));
const snap = require(path.join(ROOT, 'data', 'nba', 'yahoo-snapshot-242808.json'));
t('season is 2026-27 (projections season 2026, week 1 in Oct 2026)', () => {
  eq(String(proj.season), '2026');
  ok(/^2026-10/.test(proj.weeks['1'][0]), proj.weeks['1'][0]);
});
t('market ranks are 1..N, unique, with no gaps (they are pick numbers)', () => {
  const r = market.rows.filter(x => x.marketRank != null).map(x => x.marketRank).sort((a, b) => a - b);
  r.forEach((x, i) => { if (x !== i + 1) throw new Error('gap/dupe at ' + (i + 1) + ': ' + x); });
});
t('no duplicate players in the market top 300 (id or folded name)', () => {
  const top = market.rows.filter(x => x.marketRank != null && x.marketRank <= 300);
  const ids = new Set(top.map(x => x.id)), names = new Set(top.map(x => L.normName(x.name)));
  eq(ids.size, top.length); eq(names.size, top.length);
});
t('every Yahoo top-200 player is on the market list', () => {
  const have = new Set(market.rows.map(x => String(x.yahooPid)));
  const miss = snap.players.filter(p => p.preRank <= 200 && !have.has(String(p.pid))).map(p => p.preRank + ' ' + p.name);
  eq(miss, []);
});
t('market top 12 are real first-rounders (all in Yahoo top 20, all with ESPN or Sleeper ADP ≤ 25)', () => {
  market.rows.filter(x => x.marketRank <= 12).forEach(x => {
    ok(x.yahooPreRank <= 20, x.name + ' yahoo ' + x.yahooPreRank);
    const a = x.adp || {}; ok(Math.min(a.espn || 999, a.sleeper || 999) <= 25, x.name + ' adp ' + JSON.stringify(a));
  });
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
