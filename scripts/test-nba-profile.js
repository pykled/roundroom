#!/usr/bin/env node
// League-profile model tests (stream H1). Plain node, offline, exits 0 on success.
//   node scripts/test-nba-profile.js
// Covers: profile values vs docs/nba-contracts.md, per-game scoring by hand,
// profile swap changes values, 14-day matchup weeks, slot eligibility, VORP,
// NaN fuzz, determinism, HTTP routes (ETag/gzip), warm perf, and a 2025
// no-hindsight backtest under the league's scoring.
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const express = require('express');
const compression = require('compression');

const LP = require('../nba/league-profile');
const Sc = require('../nba/model/score');
const Slots = require('../nba/model/slots');
const Data = require('../nba/model/data');
const M = require('../nba/model');
const Fit = require('../nba/model/fit');
const St = require('../nba/model/stats');
const { buildBoard, HEALTHY_FLOOR } = require('../nba/model/board');
const { epochDay } = require('../nba/model/sleeper');
const createNbaRouter = require('../nba/router');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { failed++; console.error('  FAIL', name); console.error(e); }
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

(async () => {
  const P = LP.getProfile('242808');
  const HS = LP.highScoreDefaultProfile();

  console.log('league profile');
  await test('242808 profile matches the contract exactly', () => {
    assert.strictEqual(P.leagueId, '242808');
    assert.strictEqual(P.name, 'HALIMSANITY 26-27');
    assert.strictEqual(P.teams, 12);
    assert.deepStrictEqual(P.draft, { type: 'snake', pickSeconds: 90, rounds: 14 }); // IL not drafted (docs/nba-checker-integration-2026-10-14.md)
    assert.deepStrictEqual(P.scoring, { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, pf: -1, tech: -1, dd: 5, td: 3 });
    assert.strictEqual(typeof P.flags.tdAlsoCountsDD, 'boolean');
    assert.deepStrictEqual(P.slots, { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2, BN: 5, IL: 2 });
    assert.strictEqual(P.starters, 9);
    assert.strictEqual(P.rosterSize, 16);
    const starters = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'].reduce((s, k) => s + P.slots[k], 0);
    assert.strictEqual(starters, 9);
    assert.strictEqual(starters + P.slots.BN + P.slots.IL, 16);
    assert.strictEqual(P.teams * P.rosterSize, 192);
    assert.strictEqual(P.maxAddsPerWeek, 10);
    assert.strictEqual(P.tradeEnd, '2027-03-04');
    assert.strictEqual(P.weeks.length, 22);
    assert.deepStrictEqual(P.weeks[0], { week: 1, start: '2026-10-20', end: '2026-10-25', days: 6, playoffs: false });
    assert.deepStrictEqual(P.weeks[6], { week: 7, start: '2026-11-30', end: '2026-12-13', days: 14, playoffs: false });
    assert.deepStrictEqual(P.weeks[16], { week: 17, start: '2027-02-15', end: '2027-02-28', days: 14, playoffs: false });
    assert.deepStrictEqual(P.weeks[21], { week: 22, start: '2027-03-29', end: '2027-04-04', days: 7, playoffs: true });
    assert.strictEqual(P.weeks[19].playoffs, true);
    assert.strictEqual(P.weeks[18].playoffs, false);
    for (let i = 0; i < P.weeks.length; i++) {
      const w = P.weeks[i];
      assert.strictEqual(w.week, i + 1);
      assert.strictEqual(w.days, i === 0 ? 6 : (w.week === 7 || w.week === 17 ? 14 : 7), `week ${w.week}`);
      assert.strictEqual(epochDay(w.end) - epochDay(w.start) + 1, w.days);
      if (i) assert.strictEqual(epochDay(w.start), epochDay(P.weeks[i - 1].end) + 1, 'contiguous');
    }
    assert.deepStrictEqual(LP.defaultProfile(), P);
    assert.deepStrictEqual(LP.getProfile(), P);
    assert.strictEqual(LP.getProfile('999'), null);
  });
  await test('highScoreDefaultProfile: 1/1/2/3/3, 6 starters G,G,FC,FC,FC,UTIL, 10 players', () => {
    assert.deepStrictEqual(HS.scoring, { pts: 1, reb: 1, ast: 2, stl: 3, blk: 3, to: 0, pf: 0, tech: 0, dd: 0, td: 0 });
    assert.strictEqual(HS.starters, 6);
    assert.strictEqual(HS.rosterSize, 10);
    assert.deepStrictEqual(Slots.startingSlots(HS), ['G', 'FC', 'UTIL']);
    assert.strictEqual(HS.slots.G + HS.slots.FC + HS.slots.UTIL, 6);
  });
  await test('getProfile returns independent copies', () => {
    const a = LP.getProfile('242808'); a.scoring.pts = 99; a.weeks[0].days = 0;
    assert.strictEqual(LP.getProfile('242808').scoring.pts, 1);
    assert.strictEqual(LP.getProfile('242808').weeks[0].days, 6);
  });

  console.log('per-game score');
  const line = (pts, reb, ast, stl, blk, to, pf, tech) => ({ pts, reb, ast, stl, blk, to, pf, tech });
  await test('hand-computed lines under 242808', () => {
    // 25 + 8*1.2 + 6*1.5 + 2*3 + 1*3 − 3 − 2 = 47.6 (no doubles)
    assert.ok(close(Sc.gameScore(line(25, 8, 6, 2, 1, 3, 2, 0), P), 47.6));
    // double-double: 20 + 14.4 + 4.5 + 3 − 2 − 3 = 36.9, + DD 5 = 41.9
    assert.ok(close(Sc.gameScore(line(20, 12, 3, 1, 0, 2, 3, 0), P), 41.9));
    // blocks count toward doubles: 10 pts + 10 blk: 10 + 2.4 + 1.5 + 30 − 1 − 4 = 38.9 + DD 5 = 43.9
    assert.ok(close(Sc.gameScore(line(10, 2, 1, 0, 10, 1, 4, 0), P), 43.9));
  });
  await test('triple-double: TD +3, plus DD +5 when flags.tdAlsoCountsDD', () => {
    // 30 + 14.4 + 16.5 + 6 + 3 − 5 − 3 − 1 = 60.9
    const td = line(30, 12, 11, 2, 1, 5, 3, 1);
    const on = { ...P, flags: { tdAlsoCountsDD: true } };
    const off = { ...P, flags: { tdAlsoCountsDD: false } };
    assert.ok(close(Sc.gameScore(td, on), 68.9), String(Sc.gameScore(td, on)));
    assert.ok(close(Sc.gameScore(td, off), 63.9), String(Sc.gameScore(td, off)));
    assert.strictEqual(Sc.doublesOf(td), 3);
    assert.strictEqual(Sc.gameScore(td, HS), 30 + 12 + 22 + 6 + 3); // 73, no TO/PF/bonus in HS defaults
  });
  await test('turnover-heavy game', () => {
    // 18 + 4.8 + 10.5 + 3 − 9 − 4 − 2 = 21.3
    assert.ok(close(Sc.gameScore(line(18, 4, 7, 1, 0, 9, 4, 2), P), 21.3));
    assert.strictEqual(Sc.gameScore(line(18, 4, 7, 1, 0, 9, 4, 2), HS), 18 + 4 + 14 + 3);
  });
  await test('rowScore reads compact log rows (tf column = tech); rejects rows without a stat line', () => {
    const row = [20000, 1, 0, 34.5, 30, 12, 11, 2, 1, 5, 3, 1];
    assert.ok(close(Sc.rowScore(row, P), 68.9));
    assert.throws(() => Sc.rowScore([20000, 1, 40, 30], P));
    assert.throws(() => Sc.gameScore(line(1, 1, 1, 1, 1, 0, 0, 0), null));
  });
  await test('no hardcoded weights: a custom profile changes scores linearly', () => {
    const custom = { scoring: { pts: 2, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, pf: 0, tech: 0, dd: 0, td: 0 }, flags: {} };
    assert.strictEqual(Sc.gameScore(line(25, 8, 6, 2, 1, 3, 2, 0), custom), 50);
  });
  await test('snapshot stat lines reproduce the committed High Score column', () => {
    const logs = Data.load().logs[0];
    let n = 0;
    for (const p of Object.values(logs.players)) for (const g of p.g) { assert.ok(close(Sc.rowScore(g, HS), g[2], 1e-6)); n++; }
    assert.ok(n > 20000, `${n} games`);
  });

  console.log('board under the league profile');
  const data = Data.load();
  const now = new Date('2026-10-14T12:00:00Z');
  const t0 = Date.now();
  const board = buildBoard(data, { now, profile: P });
  const coldMs = Date.now() - t0;
  const hsBoard = buildBoard(data, { now, profile: HS });
  const byId = Object.fromEntries(board.players.map(p => [p.id, p]));
  await test('scoring changes with profile (highScoreDefaultProfile gives different values)', () => {
    const jok = byId['1658'];
    const jokHS = hsBoard.players.find(p => p.id === '1658');
    assert.notStrictEqual(jok.hsValue, jokHS.hsValue);
    assert.notStrictEqual(jok.mean, jokHS.mean);
    let diff = 0;
    const hsById = Object.fromEntries(hsBoard.players.map(p => [p.id, p]));
    for (const p of board.players.slice(0, 100)) if (hsById[p.id].rank !== p.rank) diff++;
    assert.ok(diff > 20, `${diff} of top-100 ranks differ`);
  });
  await test('contract shape + new fields + no NaN anywhere', () => {
    assert.ok(board.players.length > 400);
    for (const p of board.players) {
      for (const k of ['id', 'name', 'team', 'pos', 'elig', 'mean', 'sd', 'games', 'gamesByWeek', 'hsValue', 'hsByWeek', 'ceiling', 'floor', 'rank', 'tier', 'posRank', 'source', 'yahooElig', 'eligConfidence', 'vorp', 'vorpBySlot', 'vorpRank', 'yahooPid', 'yahooPreRank', 'yahooPctRos', 'yahooFanPts']) assert.ok(k in p, `${p.name} missing ${k}`);
      const nums = [p.mean, p.sd, p.games, p.hsValue, p.ceiling, p.floor, p.vorp, ...Object.values(p.hsByWeek), ...Object.values(p.gamesByWeek), ...Object.values(p.vorpBySlot)];
      for (const x of nums) assert.ok(Number.isFinite(x), `${p.name} non-finite`);
      assert.deepStrictEqual(Object.keys(p.hsByWeek).map(Number), P.weeks.map(w => w.week));
      assert.ok(p.yahooElig.includes('UTIL'));
      for (const s of p.yahooElig) assert.ok(Slots.startingSlots(P).includes(s), s);
    }
  });
  await test('top of the board is sensible (Jokić / Wembanyama / Dončić top 5)', () => {
    const top5 = board.players.slice(0, 5).map(p => p.id);
    for (const id of ['1658', '2577']) assert.ok(top5.includes(id), id);
    assert.ok(byId['1970'].rank <= 6);
  });
  await test('14-day weeks: games counted by date over 14 days; value rises with games', () => {
    const den = byId['1658'];
    // DEN: 2026-11-30, 12-02, 12-12 scheduled + 2 NBA Cup-window games still undated by the NBA.
    assert.strictEqual(den.gamesByWeek[7], 5);
    const td = data.proj.teamDates;
    for (const team of Object.keys(td)) {
      const p = board.players.find(x => x.team === team);
      const total = Object.values(p.gamesByWeek).reduce((a, b) => a + b, 0);
      const after = td[team].filter(d => d > epochDay('2027-04-04')).length;
      assert.strictEqual(total, 82 - after, `${team} season games in weeks 1-22`);
    }
    // Week 7 (14 days) carries more games than an average 7-day week for nearly every team.
    let more = 0, teams = 0;
    for (const team of Object.keys(td)) {
      const p = board.players.find(x => x.team === team);
      const reg = P.weeks.filter(w => w.days === 7).map(w => p.gamesByWeek[w.week]);
      teams++; if (p.gamesByWeek[7] > reg.reduce((a, b) => a + b, 0) / reg.length) more++;
    }
    assert.ok(more >= 28, `${more}/${teams}`);
    // Same player: E[max] grows with games, so a 5-game week beats his 3-game weeks.
    const three = P.weeks.filter(w => den.gamesByWeek[w.week] === 3).map(w => den.hsByWeek[w.week]);
    assert.ok(den.hsByWeek[7] > Math.max(...three));
  });
  await test('pre-draft hsValue = equal-weight average over all matchup weeks', () => {
    for (const p of board.players.slice(0, 50)) {
      const avg = P.weeks.reduce((s, w) => s + p.hsByWeek[w.week], 0) / P.weeks.length;
      assert.ok(Math.abs(avg - p.hsValue) <= 0.06, `${p.name} ${avg} vs ${p.hsValue}`);
    }
  });
  await test('currentWeek follows the profile calendar by date', () => {
    const at = d => buildBoard(data, { now: new Date(d + 'T18:00:00Z'), profile: P }).currentWeek;
    assert.strictEqual(at('2026-10-13'), 1);
    assert.strictEqual(at('2026-12-05'), 7);
    assert.strictEqual(at('2026-12-13'), 7);
    assert.strictEqual(at('2026-12-14'), 8);
    assert.strictEqual(at('2027-02-20'), 17);
    const wk7 = buildBoard(data, { now, profile: P, week: 7 });
    assert.strictEqual(wk7.players.find(p => p.id === '1658').hsValue, byId['1658'].hsByWeek[7]);
  });
  await test('synthetic: identical player, 14-day week with 2x games is worth more than a 7-day week', () => {
    const fit = Fit.fitProjection(45, 0.3);
    const em = k => fit.emax[Math.min(k, fit.emax.length - 1)];
    const v7 = St.expectedMaxAvail(em, 3, 0.85), v14 = St.expectedMaxAvail(em, 7, 0.85);
    assert.ok(v14 > v7 + 3, `${v7} → ${v14}`);
    assert.ok(fit.emax.length >= 9, 'E[max] precomputed for 8-game matchups');
  });

  console.log('slot eligibility (Yahoo legend)');
  const sl = pos => Slots.slotsForPositions(pos);
  await test('C-only is C/UTIL, NOT F or PF', () => {
    assert.deepStrictEqual(sl(['C']).filter(s => s !== 'FC'), ['C', 'UTIL']);
    assert.ok(!sl(['C']).includes('F'));
    assert.ok(!sl(['C']).includes('PF'));
  });
  await test('G/F fills SG, SF, G, F (not PG/PF/C)', () => {
    const s = sl('G/F');
    for (const x of ['SG', 'SF', 'G', 'F', 'UTIL']) assert.ok(s.includes(x), x);
    for (const x of ['PG', 'PF', 'C']) assert.ok(!s.includes(x), x);
  });
  await test('F/C fills PF, F, C; PG fills PG/G only; SG fills SG/G; G fills SG/G', () => {
    const fc = sl('F/C');
    for (const x of ['PF', 'F', 'C']) assert.ok(fc.includes(x), x);
    for (const x of ['SF', 'PG', 'SG', 'G']) assert.ok(!fc.includes(x), x);
    assert.deepStrictEqual(sl('PG').filter(s => s !== 'FC'), ['PG', 'G', 'UTIL']);
    assert.deepStrictEqual(sl('SG'), ['SG', 'G', 'UTIL']);
    assert.deepStrictEqual(sl('G'), ['SG', 'G', 'UTIL']);
    assert.deepStrictEqual(sl('PG,SG').filter(s => s !== 'FC'), ['PG', 'SG', 'G', 'UTIL']);
  });
  await test('UTIL takes anyone (incl. unknown / empty positions)', () => {
    for (const pos of [[], 'XYZ', ['PG'], ['C'], 'G/F', ['SF', 'PF']]) assert.ok(sl(pos).includes('UTIL'), JSON.stringify(pos));
    assert.deepStrictEqual(sl([]), ['UTIL']);
  });
  await test('board (Sleeper-first profile): Sleeper fantasy_positions are the eligibility source; Yahoo snapshot only adds identity', () => {
    assert.deepStrictEqual(byId['1658'].yahooElig, ['C', 'UTIL']); // Jokić: Sleeper 'C' → no F slot
    assert.strictEqual(P.positionSource, 'sleeper');
    for (const p of board.players) {
      assert.strictEqual(p.eligConfidence, 'sleeper', p.name);
      assert.deepStrictEqual(p.yahooElig, Slots.slotsForPositions(p.pos).filter(s => s !== 'FC'), p.name);
    }
    // Flagg: Sleeper lists PG/SG/SF (Yahoo had SG,SF,PF) → on a Sleeper league he is PG-eligible.
    const flagg = board.players.find(p => p.name === 'Cooper Flagg');
    assert.ok(flagg.yahooElig.includes('PG') && flagg.yahooPos && flagg.yahooPid, flagg.yahooElig.join(','));
    assert.strictEqual(board.yahooMeta.positionSource, 'sleeper');
  });
  await test('board (positionSource yahoo): Yahoo positions override eligibility; Sleeper only as flagged fallback', () => {
    const yb = buildBoard(data, { now, profile: Object.assign(LP.getProfile('242808'), { positionSource: 'yahoo' }) });
    const yById = Object.fromEntries(yb.players.map(p => [p.id, p]));
    assert.deepStrictEqual(yById['1658'].yahooElig, ['C', 'UTIL']);
    for (const p of yb.players) {
      assert.ok(['yahoo', 'sleeper-mapped'].includes(p.eligConfidence));
      assert.strictEqual(p.eligConfidence === 'yahoo', p.yahooPos != null, p.name);
      if (p.eligConfidence === 'yahoo') assert.deepStrictEqual(p.yahooElig, Slots.slotsForPositions(p.yahooPos).filter(s => s !== 'FC'), p.name);
    }
    const flagg = yb.players.find(p => p.name === 'Cooper Flagg');
    assert.strictEqual(flagg.eligConfidence, 'yahoo');
    assert.ok(flagg.yahooElig.includes('PF') && !flagg.yahooElig.includes('PG'), flagg.yahooElig.join(','));
    assert.strictEqual(yb.yahooMeta.positionSource, 'yahoo');
  });

  console.log('VORP by slot');
  await test('replacement per starting slot; vorp = best eligible slot; vorpRank is a permutation', () => {
    const v = board.vorpMeta;
    assert.strictEqual(v.poolSize, 12 * 14);
    assert.deepStrictEqual(Object.keys(v.replacement), ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL']);
    for (const r of Object.values(v.replacement)) assert.ok(r > 0 && Number.isFinite(r));
    // UTIL replacement = best undrafted overall, so it is the highest bar.
    for (const r of Object.values(v.replacement)) assert.ok(v.replacement.UTIL >= r);
    for (const p of board.players) {
      assert.deepStrictEqual(Object.keys(p.vorpBySlot).sort(), p.yahooElig.slice().sort());
      assert.strictEqual(p.vorp, Math.max(...Object.values(p.vorpBySlot)));
      for (const [s, x] of Object.entries(p.vorpBySlot)) assert.ok(Math.abs(x - (p.hsValue - v.replacement[s])) < 0.06);
    }
    const ranks = board.players.map(p => p.vorpRank).sort((a, b) => a - b);
    ranks.forEach((r, i) => assert.strictEqual(r, i + 1));
    const top = board.players.find(p => p.vorpRank === 1);
    assert.ok(['1658', '2577'].includes(top.id), top.name);
  });

  console.log('Yahoo snapshot (league 242808)');
  const Y = require('../nba/model/yahoo');
  const snap = Y.loadSnapshot('242808');
  const ym = board.yahooMeta;
  await test('identity: yahooPid / yahooPreRank / yahooPctRos attached; match rate reported', () => {
    assert.ok(snap && snap.players.length >= 700);
    assert.strictEqual(ym.total, snap.players.length);
    assert.strictEqual(ym.matched + ym.unmatched.length, ym.total);
    const pids = board.players.map(p => p.yahooPid).filter(Boolean);
    assert.strictEqual(board.players.filter(p => p.yahooPos).length, ym.matched);
    assert.strictEqual(pids.length + ym.missingPid, ym.matched + ym.unmatched.filter(u => u.pid == null).length);
    assert.strictEqual(new Set(pids).size, pids.length, 'a Yahoo pid matched to two players');
    assert.strictEqual(byId['1658'].yahooPid, '5352');
    assert.strictEqual(byId['1658'].yahooPreRank, 1);
    assert.strictEqual(byId['1658'].yahooPctRos, 100);
    // Everyone Yahoo ranks in the top 200 is on the board and matched.
    const top = snap.players.filter(y => y.preRank != null && y.preRank <= 200);
    const matched = new Set(pids);
    const miss = top.filter(y => !matched.has(String(y.pid))).map(y => y.name);
    assert.deepStrictEqual(miss, []);
    // Every unmatched Yahoo row is absent from Sleeper's player list (no name we failed to match).
    const sleeperNames = new Set(Object.values(data.players).map(p => M.normalizeName(p.n)));
    const fixable = ym.unmatched.filter(u => sleeperNames.has(M.normalizeName(u.name))).map(u => u.name);
    assert.deepStrictEqual(fixable, []);
    console.log(`        matched ${ym.matched}/${ym.total} Yahoo players (${(ym.matchRate * 100).toFixed(1)}%); ${ym.unmatched.length} unmatched, all missing from Sleeper (best: ${ym.unmatched.slice(0, 4).map(u => `${u.name} #${u.preRank}`).join(', ')})`);
  });
  // Yahoo's fanPts are league-scored with NO DD/TD/tech component, so compare under
  // the league profile with those weights zeroed (profile-driven, nothing hardcoded).
  const linear = { ...P, scoring: { ...P.scoring, dd: 0, td: 0, tech: 0 } };
  const yTop = snap.players.filter(y => y.fanPts != null).sort((a, b) => b.fanPts - a.fanPts).slice(0, 200);
  await test('ground truth: league scoring of Yahoo stat totals == Yahoo fanPts (top 200, ±0.1)', () => {
    assert.strictEqual(yTop.length, 200);
    const bad = yTop.map(y => [y.name, Sc.gameScore(y, linear), y.fanPts]).filter(([, s, f]) => Math.abs(s - f) > 0.1);
    assert.deepStrictEqual(bad, []);
  });
  await test('Yahoo totals are 2026-27 projections: per-game rates equal Sleeper projections; our projected mean tracks fanPts/gp', () => {
    // Yahoo's "last-season" columns are its pre-season projection (Haliburton/Lillard
    // missed 2025-26 yet show 60+ GP), so the per-game log sum cannot reproduce them;
    // the per-game projection inputs can be checked instead.
    const curve = Sc.ddCurve(data.logs);
    const logs = data.logs.find(l => String(l.season) === '2025');
    const asOf = epochDay('2026-10-14');
    const ks = ['pts', 'reb', 'ast', 'stl', 'blk', 'to'];
    const byPid = new Map(board.players.filter(p => p.yahooPid).map(p => [p.yahooPid, p]));
    let n = 0, same = 0, se = 0, sa = 0;
    const worst = [];
    for (const y of snap.players.filter(q => q.preRank != null && q.gp > 0).sort((a, b) => a.preRank - b.preRank).slice(0, 200)) {
      const p = byPid.get(String(y.pid));
      const sp = p && data.proj.seasonProj[p.id];
      if (!sp) continue;
      n++;
      const means = Object.fromEntries(ks.map((k, i) => [k, sp[3 + i]]));
      if (ks.every(k => Math.abs(means[k] - y[k] / y.gp) <= 0.011)) same++;
      const ex = Sc.playerExtras(((logs && logs.players[p.id]) || { g: [] }).g, asOf);
      const d = Sc.projectedMean(means, sp[1], ex, curve, linear) - y.fanPts / y.gp;
      assert.ok(Number.isFinite(d), p.name);
      se += d; sa += Math.abs(d);
      worst.push([p.name, d]);
    }
    worst.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    console.log(`        ${n} matched: ${same} identical per-game projections; our linear mean − Yahoo fanPts/gp: bias ${(se / n).toFixed(2)}, MAE ${(sa / n).toFixed(2)}; largest ${worst.slice(0, 3).map(([nm, d]) => `${nm} ${d.toFixed(1)}`).join(', ')}`);
    assert.ok(n >= 190 && same / n >= 0.6, `${same}/${n}`);
    assert.ok(Math.abs(se / n) < 0.5 && sa / n < 2, `bias ${se / n} MAE ${sa / n}`);
  });

  console.log('robustness');
  await test('NaN fuzz: random lines × random profiles stay finite', () => {
    const rng = St.seededRng(42);
    const rnd = (a, b) => a + Math.floor(rng() * (b - a + 1));
    for (let i = 0; i < 20000; i++) {
      const prof = { scoring: { pts: rng() * 3, reb: rng() * 3, ast: rng() * 3, stl: rng() * 5, blk: rng() * 5, to: -rng() * 2, pf: -rng(), tech: -rng() * 3, dd: rng() * 10, td: rng() * 10 }, flags: { tdAlsoCountsDD: rng() < 0.5 } };
      const l = { pts: rnd(0, 70), reb: rnd(0, 25), ast: rnd(0, 20), stl: rnd(0, 8), blk: rnd(0, 10), to: rnd(0, 12), pf: rnd(0, 6), tech: rnd(0, 2) };
      if (rng() < 0.1) delete l.blk;
      if (rng() < 0.1) l.reb = undefined;
      if (rng() < 0.05) l.ast = 'x';
      assert.ok(Number.isFinite(Sc.gameScore(l, prof)), JSON.stringify(l));
    }
    assert.strictEqual(Sc.gameScore(null, P), 0);
    assert.strictEqual(Sc.gameScore({}, P), 0);
  });
  await test('determinism: identical inputs → identical board JSON', () => {
    const a = JSON.stringify(buildBoard(data, { now, profile: P }).players);
    const b = JSON.stringify(buildBoard(data, { now, profile: LP.getProfile('242808') }).players);
    assert.strictEqual(a, b);
  });
  await test('legacy getPlayers() (no profile) is unchanged: High Score defaults on Sleeper weeks', async () => {
    const leg = await M.getPlayers({});
    assert.strictEqual(leg.profile, undefined);
    assert.strictEqual(Object.keys(leg.players[0].hsByWeek).length, Object.keys(data.proj.weeks).length);
  });

  console.log('HTTP');
  const app = express();
  app.use(compression());
  const cache = new Map();
  const apiCached = async (k, ttl, fn) => { const e = cache.get(k); if (e && e.exp > Date.now()) return e.v; const v = await fn(); cache.set(k, { v, exp: Date.now() + ttl }); return v; };
  app.use('/', createNbaRouter({ auth: (q, s, n) => n(), getAuth: () => ({ userId: null }), db: null, apiCached, env: {}, loadModel: () => M, log: { error() {}, warn() {} } }));
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    const u = new URL(base + p);
    http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  try {
    await test('GET /api/nba/league-profile (default, explicit, unknown, invalid)', async () => {
      const a = await get('/api/nba/league-profile');
      assert.strictEqual(a.status, 200);
      const { unverified, ...body } = JSON.parse(a.body);
      assert.deepStrictEqual(body, P);
      assert.ok(unverified.some(u => /DD\/TD bonus unverified/.test(u)));
      assert.deepStrictEqual(JSON.parse((await get('/api/nba/league-profile?league_id=242808')).body), { ...P, unverified });
      assert.strictEqual((await get('/api/nba/league-profile?league_id=12345')).status, 404);
      assert.strictEqual((await get('/api/nba/league-profile?league_id=abc')).status, 400);
    });
    await test('GET /api/nba/players: profile meta (default 242808), gzip, weak ETag → 304, bad/unknown profile', async () => {
      const a = await get('/api/nba/players', { 'accept-encoding': 'gzip' });
      assert.strictEqual(a.status, 200);
      assert.strictEqual(a.headers['content-encoding'], 'gzip');
      assert.ok(/^W\//.test(a.headers.etag));
      const j = JSON.parse(zlib.gunzipSync(a.body));
      assert.strictEqual(j.profile.leagueId, '242808');
      assert.deepStrictEqual(j.profile.scoring, P.scoring);
      assert.deepStrictEqual(j.profile.longWeeks, [7, 17]);
      assert.ok(j.profile.unverified.some(u => /DD\/TD bonus unverified/.test(u)));
      assert.ok(j.profile.yahoo.matched > 550 && j.profile.yahoo.matchRate > 0.75, JSON.stringify(j.profile.yahoo));
      const jok = j.players.find(p => p.id === '1658');
      assert.strictEqual(jok.yahooPid, '5352');
      assert.strictEqual(jok.eligConfidence, 'sleeper');
      assert.strictEqual(j.profile.positionSource, 'sleeper');
      assert.ok(j.players[0].yahooElig && 'vorp' in j.players[0]);
      const b = await get('/api/nba/players?profile=242808', { 'if-none-match': a.headers.etag });
      assert.strictEqual(b.status, 304);
      assert.strictEqual(b.body.length, 0);
      assert.strictEqual((await get('/api/nba/players?profile=nope')).status, 400);
      assert.strictEqual((await get('/api/nba/players?profile=111')).status, 404);
      const w = JSON.parse((await get('/api/nba/players?week=7')).body);
      assert.strictEqual(w.week, 7);
      assert.strictEqual(w.players.find(p => p.id === '1658').games, 5);
    });
    await test('perf: warm /api/nba/players < 300 ms; model cold build reported', async () => {
      const t = Date.now();
      await get('/api/nba/players');
      const warm = Date.now() - t;
      const t2 = Date.now(); await M.getPlayers({ profile: '242808' }); const warmModel = Date.now() - t2;
      console.log(`        cold board build ${coldMs} ms, warm HTTP ${warm} ms, warm model ${warmModel} ms`);
      assert.ok(warm < 300 && warmModel < 300);
    });
  } finally { srv.close(); }

  console.log('\nTop 15 by vorpRank under 242808 scoring (pre-draft):');
  for (const p of [...board.players].sort((a, b) => a.vorpRank - b.vorpRank).slice(0, 15)) {
    console.log(`  ${String(p.vorpRank).padStart(2)}. ${p.name.padEnd(26)} ${p.team} ${p.yahooElig.filter(s => s !== 'UTIL').join('/').padEnd(16)} hs ${p.hsValue.toFixed(1)}  vorp ${p.vorp.toFixed(1)}  mean ${p.mean.toFixed(1)}`);
  }

  runBacktest(P);

  console.log(`\n${failed ? 'FAILED' : 'OK'} — ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

// ─────────────── backtest: 2025, no hindsight, league scoring ───────────────
// Same protocol as scripts/test-nba-model.js, every game re-scored with the
// profile: fit on 2025 games strictly before week k, predict the max single-game
// league score of week k (N = team games, availability from history + last-week
// proxy). No projections (2025 rows were revised post-game). The "14-day" run
// merges Sleeper weeks (k, k+1) into one matchup to check long-week calibration.
function runBacktest(profile) {
  const logs = Data.load().logs.find(l => l.season === '2025');
  const weeks = Object.keys(logs.weeks).map(Number).sort((a, b) => a - b);
  const score = g => Sc.rowScore(g, profile);
  const players = Object.entries(logs.players).filter(([pid]) => /^\d+$/.test(pid)).map(([pid, p]) => ({ pid, rw: p.rw, g: p.g.map(g => [g[0], g[1], score(g), g[3]]) }));
  const run = span => {
    const out = [];
    for (const k of weeks.filter(w => w >= 4 && (span === 1 || (w % 2 === 0 && weeks.includes(w + 1))))) {
      const ks = span === 1 ? [k] : [k, k + 1];
      const startDay = epochDay(logs.weeks[k][0]);
      for (const p of players) {
        const N = ks.reduce((s, w) => s + (p.rw[w] || 0), 0);
        if (!N) continue;
        const prior = p.g.filter(g => g[0] < startDay);
        if (prior.length < 5) continue;
        const fit = Fit.fitLogs(prior, { asOfDay: startDay });
        let rostered = 0;
        for (const w of weeks) if (w < k) rostered += p.rw[w] || 0;
        const a0 = Math.min(0.98, Math.max(0.4, (prior.length + 0.85 * 20) / (rostered + 20)));
        const lastWkPlayed = p.g.some(g => g[1] === k - 1);
        const a = (p.rw[k - 1] || 0) && !lastWkPlayed ? 0.2 : Math.max(a0, HEALTHY_FLOOR);
        const em = j => fit.emax[Math.min(j, fit.emax.length - 1)];
        const played = p.g.filter(g => ks.includes(g[1]));
        out.push({ N, pred: St.expectedMaxAvail(em, N, a), real: played.length ? Math.max(...played.map(g => g[2])) : 0, n: played.length, cond: played.length ? em(played.length) : null });
      }
    }
    return out;
  };
  const metrics = pairs => {
    const n = pairs.length;
    let sp = 0, sr = 0, se = 0, sa = 0;
    for (const [p, r] of pairs) { sp += p; sr += r; se += p - r; sa += Math.abs(p - r); }
    const mp = sp / n, mr = sr / n;
    let cov = 0, vp = 0, vr = 0;
    for (const [p, r] of pairs) { cov += (p - mp) * (r - mr); vp += (p - mp) ** 2; vr += (r - mr) ** 2; }
    return `n=${n} bias=${(se / n).toFixed(2)} MAE=${(sa / n).toFixed(2)} r=${(cov / Math.sqrt(vp * vr)).toFixed(3)} (pred ${mp.toFixed(1)} / real ${mr.toFixed(1)})`;
  };
  console.log(`\nBacktest 2025 under league ${profile.leagueId} scoring (fit on weeks < k, predict week k, k >= 4):`);
  const one = run(1);
  console.log(`  7-day weeks, all rostered player-weeks:  ${metrics(one.map(r => [r.pred, r.real]))}`);
  console.log(`  7-day weeks, given games played:          ${metrics(one.filter(r => r.n).map(r => [r.cond, r.real]))}`);
  const two = run(2);
  console.log(`  14-day (2 merged weeks), all:             ${metrics(two.map(r => [r.pred, r.real]))}`);
  console.log(`  14-day (2 merged weeks), given played:    ${metrics(two.filter(r => r.n).map(r => [r.cond, r.real]))}`);
}
