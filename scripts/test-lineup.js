#!/usr/bin/env node
// Unit checks for shared/lineup.js — greedy fill + locked-slot pinning.
// Run: node scripts/test-lineup.js
const assert = require('assert');
const L = require('../shared/lineup.js');

const POS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN'];
const players = [
  { id: 'qb1', position: 'QB', value: 20 },
  { id: 'rb1', position: 'RB', value: 18 },
  { id: 'rb2', position: 'RB', value: 15 },
  { id: 'rb3', position: 'RB', value: 12 },
  { id: 'rb4', position: 'RB', value: 6 },
  { id: 'wr1', position: 'WR', value: 16 },
  { id: 'wr2', position: 'WR', value: 14 },
  { id: 'wr3', position: 'WR', value: 11 },
  { id: 'te1', position: 'TE', value: 9 },
  { id: 'k1', position: 'K', value: 8 },
  { id: 'def1', position: 'DEF', value: 7 },
];
const ids = r => r.starters.map(s => s.id);
const slotOf = (r, id) => r.starters.find(s => s.id === id).slot;

// --- baseline: no pins → best RB (rb3, 12) takes FLEX over wr3 (11)
let r = L.optimize(players, POS);
assert.deepStrictEqual(ids(r), ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3', 'k1', 'def1']);
assert.deepStrictEqual(r.bench, ['wr3', 'rb4']);
assert.ok(r.starters.every(s => s.pinned === false));

// --- pin a weak RB into FLEX (his game started while he was in Sleeper's FLEX slot):
//     he stays in FLEX, the two RB slots still take rb1/rb2, rb3 drops to the bench.
r = L.optimize(players, POS, { 6: 'rb4' });
assert.strictEqual(slotOf(r, 'rb4'), 'FLEX');
assert.strictEqual(r.starters[6].pinned, true);
assert.deepStrictEqual(ids(r), ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb4', 'k1', 'def1']);
assert.deepStrictEqual(r.bench, ['rb3', 'wr3']);

// --- pin the best RB into a dedicated RB slot: the FLEX stays open for rb3, not a WR
r = L.optimize(players, POS, { 2: 'rb1' });
assert.strictEqual(slotOf(r, 'rb1'), 'RB');
assert.strictEqual(r.starters[2].id, 'rb1');       // exactly the pinned index, not RB1
assert.strictEqual(r.starters[1].id, 'rb2');
assert.strictEqual(slotOf(r, 'rb3'), 'FLEX');

// --- pinned id absent from the candidate list still occupies the slot and never lands on the bench
r = L.optimize(players.filter(p => p.id !== 'rb4'), POS, { 6: 'rb4' });
assert.strictEqual(r.starters[6].id, 'rb4');
assert.ok(r.bench.indexOf('rb4') < 0);
assert.ok(r.bench.indexOf('rb3') >= 0);

// --- "0" (empty Sleeper slot) and duplicate pins are ignored; a pinned id is never placed twice
r = L.optimize(players, POS, { 1: '0', 2: 'rb2', 6: 'rb2' });
assert.strictEqual(r.starters[2].id, 'rb2');
assert.strictEqual(r.starters[6].id, 'rb3');
assert.strictEqual(ids(r).filter(id => id === 'rb2').length, 1);

// --- locked bench players are the caller's job: excluded from candidates → never started
const locked = { wr1: true };
r = L.optimize(players.filter(p => !locked[p.id]), POS);
assert.ok(ids(r).indexOf('wr1') < 0);
assert.deepStrictEqual(ids(r).slice(3, 5), ['wr2', 'wr3']);

// --- pinLocked maps roster.starters index → id for locked ids only
const cur = ['qb1', 'rb1', '0', 'wr1', 'wr2', 'te1', 'rb4', 'k1', 'def1'];
assert.deepStrictEqual(L.pinLocked(cur, id => id === 'rb4' || id === 'qb1'), { 0: 'qb1', 6: 'rb4' });
assert.deepStrictEqual(L.pinLocked(cur, () => false), {});
assert.deepStrictEqual(L.pinLocked(null, () => true), {});

// --- end-to-end: locked starters pinned + locked bench excluded, then diff against Sleeper
//     rb4 (FLEX) and qb1 are locked in; wr1 is locked on the bench and cannot come in.
const isLocked = id => id === 'rb4' || id === 'qb1' || id === 'wr1';
const curStarters = ['qb1', 'rb1', 'rb3', 'wr3', 'wr2', 'te1', 'rb4', 'k1', 'def1'];   // wr1 benched, rb2 benched
const pinned = L.pinLocked(curStarters, isLocked);
const pinnedIds = new Set(Object.values(pinned));
const candidates = players.filter(p => !isLocked(p.id) || pinnedIds.has(p.id));
r = L.optimize(candidates, POS, pinned);
const d = L.diff(r, curStarters);
assert.deepStrictEqual(d.in.sort(), ['rb2']);       // rb2 replaces rb3; wr1 can't be suggested (locked on bench)
assert.deepStrictEqual(d.out.sort(), ['rb3']);
assert.ok(d.in.indexOf('wr1') < 0 && d.out.indexOf('rb4') < 0 && d.out.indexOf('qb1') < 0);

console.log('lineup.js: all checks passed');
