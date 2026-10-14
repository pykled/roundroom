#!/usr/bin/env node
/* Tests for the NBA waivers engine (nba/model/waivers.js) and routes
   (nba/routes/waivers.js). Offline, no framework.
   Run: node scripts/test-nba-waivers.js   (exit 0 = all pass) */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const path = require('path');
const assert = require('assert');
const express = require('express');
const ROOT = path.join(__dirname, '..');
const W0 = require(path.join(ROOT, 'nba/model/waivers'));
const LP = require(path.join(ROOT, 'nba/league-profile'));
const RS = require(path.join(ROOT, 'nba/model/roster-slots'));
// The synthetic engine checks encode Yahoo's High Score defaults (6 starters,
// 10-man roster, no IL, no add limit); the default profile is 242808, so they
// pin the High Score profile. 242808 checks (9 slots, IL 2, 10 adds/week,
// waiver priority) follow in their own section.
const HS = LP.highScoreDefaultProfile();
const HL = LP.defaultProfile();
const W = { ...W0, analyzeWaivers: o => W0.analyzeWaivers({ profile: HS, ...o }) };
const St = require(path.join(ROOT, 'nba/model/stats'));
const waiversRoutes = require(path.join(ROOT, 'nba/routes/waivers'));
const createNbaRouter = require(path.join(ROOT, 'nba/router'));

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Synthetic model Player: hsByWeek = E[max of n games] for a normal(mean, sd), like B's board.
const WEEKS = [1, 2, 3, 4, 5];
function mk(id, elig, mean, games, extra = {}) {
  const sd = extra.sd != null ? extra.sd : mean * 0.22;
  const gamesByWeek = {}, hsByWeek = {};
  WEEKS.forEach((w, i) => {
    const n = Array.isArray(games) ? games[i] : games;
    gamesByWeek[w] = n;
    hsByWeek[w] = n > 0 ? Math.round(St.expectedMaxAvail(k => St.expectedMax({ mean, sd }, k), n, 0.9) * 10) / 10 : 0;
  });
  return Object.assign({
    id: String(id), name: 'P' + id, team: 'T' + (Number(id) % 30), pos: elig.includes('G') ? ['PG'] : ['PF'],
    elig: [...elig, 'UTIL'], injury: null, outForSeason: false, mean, sd, gamesByWeek, hsByWeek,
    ceiling: mean + 1.28 * sd, floor: mean - 1.28 * sd, availability: 0.9, source: 'logs',
  }, extra);
}
// A full 10-man roster: 4 G, 6 F, descending talent.
function baseRoster() {
  return [
    mk(1, ['G'], 50, 3), mk(2, ['G'], 46, 3), mk(3, ['F'], 52, 3), mk(4, ['F'], 48, 3), mk(5, ['F'], 45, 3),
    mk(6, ['G', 'F'], 42, 3), mk(7, ['G'], 30, 3), mk(8, ['F'], 29, 3), mk(9, ['F'], 26, 3), mk(10, ['G'], 18, 2),
  ];
}
function allNumbersFinite(obj, where = 'root') {
  if (typeof obj === 'number') { if (!Number.isFinite(obj)) throw new Error('non-finite number at ' + where); return; }
  if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) allNumbersFinite(v, where + '.' + k);
}
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, `${msg || 'near'}: ${a} vs ${b}`); }
function seeded(seed) { const r = St.seededRng(seed); return r; }

// ---------------------------------------------------------------- engine
test('bestLineup is exact (vs brute force, 300 random rosters)', () => {
  const rnd = seeded(7);
  for (let c = 0; c < 300; c++) {
    const n = 1 + Math.floor(rnd() * 10);
    const items = Array.from({ length: n }, (_, i) => {
      const t = rnd();
      return { id: 'x' + i, v: Math.round(rnd() * 60), g: t < 0.66, f: t > 0.33 };
    });
    // brute force: assign each item to one of slot indexes or bench
    const slots = ['G', 'G', 'F', 'F', 'F', 'U'];
    let best = 0;
    const rec = (i, used, sum) => {
      if (i === items.length) { if (sum > best) best = sum; return; }
      rec(i + 1, used, sum);
      for (let s = 0; s < 6; s++) {
        if (used & (1 << s)) continue;
        const it = items[i];
        if (slots[s] === 'G' && !it.g) continue;
        if (slots[s] === 'F' && !it.f) continue;
        rec(i + 1, used | (1 << s), sum + it.v);
      }
    };
    rec(0, 0, 0);
    const got = W.bestLineup(items);
    assert.strictEqual(Math.round(got.total * 1000), Math.round(best * 1000), `case ${c}`);
    const counts = { G: 0, F: 0, UTIL: 0 };
    for (const s of got.starters) counts[s.slot]++;
    assert.ok(counts.G <= 2 && counts.F <= 3 && counts.UTIL <= 1, 'slot caps');
    const byId = new Map(items.map(i => [i.id, i]));
    for (const s of got.starters) { const it = byId.get(s.id); assert.ok(s.slot === 'UTIL' || (s.slot === 'G' ? it.g : it.f), 'eligibility'); }
    assert.strictEqual(Math.round(got.starters.reduce((a, s) => a + byId.get(s.id).v, 0) * 1000), Math.round(got.total * 1000), 'starters sum to total');
  }
});

test('schedule drives ranking: 4-game FA beats identical 2-game FA', () => {
  const roster = baseRoster();
  const four = mk(100, ['F'], 40, 4), two = mk(101, ['F'], 40, 2);
  for (const h of [1, 2, 4]) {
    const r = W.analyzeWaivers({ roster, pool: [two, four], startWeek: 1, horizon: h });
    assert.strictEqual(r.targets[0].id, '100', `horizon ${h}`);
    assert.ok(r.targets[0].netGain > r.targets[1].netGain, `strictly better at horizon ${h}`);
    assert.deepStrictEqual(r.weeks, WEEKS.slice(0, h));
  }
  const r = W.analyzeWaivers({ roster, pool: [two, four], startWeek: 1, horizon: 1 });
  assert.ok(r.calendar[0].fourGame.some(p => p.id === '100') && !r.calendar[0].fourGame.some(p => p.id === '101'), 'streamer calendar lists only the 4-game FA');
  assert.strictEqual(r.calendar.length, 3, '3-week calendar');
});

test('schedule in a later week only counts inside the horizon', () => {
  const roster = baseRoster();
  const later = mk(110, ['F'], 40, [2, 4, 4, 4, 4]); // 4 games from week 2
  const now = mk(111, ['F'], 40, [4, 2, 2, 2, 2]);
  const h1 = W.analyzeWaivers({ roster, pool: [later, now], startWeek: 1, horizon: 1 });
  assert.strictEqual(h1.targets[0].id, '111', '1-week horizon favours this week');
  const h4 = W.analyzeWaivers({ roster, pool: [later, now], startWeek: 1, horizon: 4 });
  assert.strictEqual(h4.targets[0].id, '110', '4-week horizon favours the better run');
});

test('drop candidate = lowest marginal player; swap gain matches recomputation', () => {
  const roster = baseRoster();
  const fa = mk(200, ['G'], 33, 4);
  const r = W.analyzeWaivers({ roster, pool: [fa], startWeek: 1, horizon: 2 });
  assert.strictEqual(r.dropCandidate.id, '10', 'weakest 2-game bench G');
  for (let i = 1; i < r.dropCandidates.length; i++) assert.ok(r.dropCandidates[i - 1].dropCost <= r.dropCandidates[i].dropCost, 'sorted ascending');
  const t = r.targets[0];
  assert.strictEqual(t.drop.id, '10');
  const wv = (ps, w) => W.rosterWeekValue(ps, w, W.ctxFor(HS));
  const base = wv(roster, 1) + W.WEEK_DISCOUNT * wv(roster, 2);
  const swapped = roster.filter(p => p.id !== '10').concat(fa);
  const net = wv(swapped, 1) + W.WEEK_DISCOUNT * wv(swapped, 2) - base;
  assert.strictEqual(t.netGain, Math.round(net * 10) / 10);
  assert.ok(t.netGain > 0);
  assert.strictEqual(r.pairs[0].add.id, '200');
  assert.strictEqual(r.pairs[0].drop.id, '10');
});

test('starters are never suggested as drops when a bench drop is better', () => {
  const roster = baseRoster();
  const r = W.analyzeWaivers({ roster, pool: [mk(201, ['F'], 44, 4)], startWeek: 1, horizon: 1 });
  const starters = new Set(r.lineup.starters.map(s => s.id));
  assert.ok(!starters.has(r.targets[0].drop.id), 'drop is a bench player');
  assert.strictEqual(r.lineup.starters.length, 6);
});

test('open roster spot: add without drop, gain = addGain', () => {
  const roster = baseRoster().slice(0, 9);
  const r = W.analyzeWaivers({ roster, pool: [mk(202, ['F'], 35, 4)], startWeek: 1, horizon: 1, rosterSize: 10 });
  assert.strictEqual(r.openSpots, 1);
  assert.strictEqual(r.targets[0].drop, null);
  assert.strictEqual(r.targets[0].netGain, r.targets[0].addGain);
  assert.strictEqual(r.pairs[0].drop, null);
});

test('injury replacement: injured starter surfaces with the best eligible FA', () => {
  const roster = baseRoster();
  const star = roster[2]; // F 52
  roster[2] = Object.assign({}, star, { injury: 'Out', hsByWeek: Object.assign({}, star.hsByWeek, { 1: 0, 2: 0 }) });
  const gOnly = mk(300, ['G'], 41, 3), fGood = mk(301, ['F'], 41, 3), fBad = mk(302, ['F'], 28, 3);
  const r = W.analyzeWaivers({ roster, pool: [gOnly, fGood, fBad], startWeek: 1, horizon: 2 });
  assert.strictEqual(r.injuryReplacements.length, 1);
  const ir = r.injuryReplacements[0];
  assert.strictEqual(ir.injured.id, '3');
  assert.ok(ir.lostValue > 50, 'two missed weeks of a ~60 HS player');
  const rid = ir.replacements.map(x => x.id);
  assert.strictEqual(rid[0], '301', 'F-eligible replacement first');
  assert.ok(!rid.includes('300'), 'G-only FA is not listed for an F hole');
  assert.ok(rid.indexOf('302') === -1 || rid.indexOf('302') > rid.indexOf('301'), 'weak FA ranks below');
  assert.ok(ir.replacements[0].netGain > 10);
  assert.ok(!r.lineup.starters.some(s => s.id === '3'), 'injured star not started in week 1');
  // healthy roster → none
  assert.strictEqual(W.analyzeWaivers({ roster: baseRoster(), pool: [fGood], startWeek: 1 }).injuryReplacements.length, 0);
});

test('keeper protection: a short-term streamer never replaces a better long-term asset', () => {
  const roster = baseRoster();
  // Star F out for weeks 1-2, elite after; bench is otherwise healthy and weak.
  const star = mk(3, ['F'], 60, 3);
  star.injury = 'Out';
  star.hsByWeek = Object.assign({}, star.hsByWeek, { 1: 0, 2: 0 });
  roster[2] = star;
  const streamer = mk(320, ['F'], 30, 4);
  const r = W.analyzeWaivers({ roster, pool: [streamer], startWeek: 1, horizon: 1 });
  assert.ok(W.longRun(star, 1) - W.longRun(streamer, 1) > W.KEEP_MARGIN);
  for (const t of r.targets) assert.ok(!t.drop || t.drop.id !== '3', 'injured star never the suggested drop');
  for (const p of r.pairs) assert.ok(!p.drop || p.drop.id !== '3');
  assert.strictEqual(r.dropCandidates.find(d => d.id === '3').keeper, true);
  assert.notStrictEqual(r.dropCandidate.id, '3');
  // out for the season → droppable
  roster[2] = Object.assign({}, star, { outForSeason: true, hsByWeek: Object.fromEntries(WEEKS.map(w => [w, 0])) });
  const r2 = W.analyzeWaivers({ roster, pool: [streamer], startWeek: 1, horizon: 1 });
  assert.strictEqual(r2.dropCandidate.id, '3');
  assert.strictEqual(r2.targets[0].drop.id, '3');
});

test('role signal: minutes up over last 5 → roleUp; old data → stale, no badge', () => {
  const today = 20000;
  const games = [];
  for (let i = 0; i < 30; i++) games.push([today - 60 + i * 2, 1, 25, i < 25 ? 22 : 31]);
  const s = W.roleSignal(games, today);
  assert.strictEqual(s.trend, 'up');
  assert.strictEqual(s.roleUp, true);
  assert.ok(s.deltaMin >= 8);
  const old = W.roleSignal(games, today + 200);
  assert.strictEqual(old.trend, 'up');
  assert.strictEqual(old.stale, true);
  assert.strictEqual(old.roleUp, false);
  const flat = W.roleSignal(games.map(g => [g[0], g[1], g[2], 28]), today);
  assert.strictEqual(flat.trend, 'flat');
  assert.strictEqual(W.roleSignal(games.slice(0, 5), today), null, 'too few games');
  // wired through analyzeWaivers
  const r = W.analyzeWaivers({ roster: baseRoster(), pool: [mk(400, ['G'], 35, 3)], startWeek: 1, roles: { 400: s } });
  assert.strictEqual(r.targets[0].roleUp, true);
  assert.ok(r.targets[0].reasons.some(x => /minutes up/.test(x)));
});

test('no-NaN fuzz: garbage players never produce non-finite numbers', () => {
  const rnd = seeded(99);
  const junk = [NaN, undefined, null, -5, Infinity, '12', 'abc', 0, 30];
  const pick = a => a[Math.floor(rnd() * a.length)];
  for (let c = 0; c < 150; c++) {
    const mkJunk = id => {
      const p = { id: String(id), name: rnd() < 0.2 ? undefined : 'J' + id, elig: pick([undefined, [], ['G'], ['F', 'UTIL'], 'G', ['G', 'F', 'UTIL']]),
        mean: pick(junk), sd: pick(junk), ceiling: pick(junk), floor: pick(junk), injury: pick([null, 'Out', 'GTD', 'IR', '', 7]),
        availability: pick(junk), outForSeason: rnd() < 0.1 };
      if (rnd() < 0.8) { p.hsByWeek = {}; p.gamesByWeek = {}; for (const w of WEEKS) { p.hsByWeek[w] = pick(junk); p.gamesByWeek[w] = pick(junk); } }
      return p;
    };
    const roster = Array.from({ length: Math.floor(rnd() * 12) }, (_, i) => mkJunk(i));
    const pool = Array.from({ length: Math.floor(rnd() * 30) }, (_, i) => mkJunk(1000 + i));
    if (rnd() < 0.1) pool.push(null, undefined, { id: null });
    const r = W.analyzeWaivers({ roster, pool, startWeek: pick([1, 3, undefined, NaN, 99]), horizon: pick([1, 2, 4, 3, 'x']), weeks: rnd() < 0.5 ? WEEKS : undefined });
    allNumbersFinite(r);
    assert.ok(JSON.stringify(r).indexOf('NaN') === -1);
  }
});

test('determinism: same inputs in any order → identical output', () => {
  const roster = baseRoster();
  const pool = Array.from({ length: 40 }, (_, i) => mk(500 + i, i % 3 ? ['F'] : ['G'], 25 + (i % 7) * 3, [2, 3, 4][i % 3]));
  const a = JSON.stringify(W.analyzeWaivers({ roster, pool, startWeek: 1, horizon: 4 }));
  const rnd = seeded(3);
  const shuffle = xs => { const o = xs.slice(); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };
  for (let k = 0; k < 5; k++) {
    const b = JSON.stringify(W.analyzeWaivers({ roster: shuffle(roster), pool: shuffle(pool), startWeek: 1, horizon: 4 }));
    // drop candidates with exactly equal cost keep id order, so whole output must match
    assert.strictEqual(b, a, 'shuffle ' + k);
  }
});

test('real model board: runs offline, finite, < 1s', async () => {
  const M = require(path.join(ROOT, 'nba/model'));
  const D = require(path.join(ROOT, 'nba/model/data'));
  const b = await M.getPlayers({});
  const ps = b.players;
  const roster = [0, 12, 25, 37, 50, 62, 75, 87, 99, 110].map(i => ps[i]);
  const t0 = Date.now();
  const roles = W.roleSignalsFromData(D.load(), ps.map(p => p.id));
  const r = W.analyzeWaivers({ roster, pool: ps.slice(100).filter(p => !roster.includes(p)), startWeek: b.currentWeek, horizon: 4, roles });
  assert.ok(Date.now() - t0 < 1000, 'fast');
  allNumbersFinite(r);
  assert.ok(r.targets.length > 0 && r.calendar.length === 3);
});

// ---------------------------------------------------------------- page logic
const UI = require(path.join(ROOT, 'nba/pages/waivers-logic.js'));
test('page logic: filters, sorting, formatting', () => {
  const ts = [
    { id: '1', name: 'Luka Dončić', team: 'LAL', elig: ['G', 'UTIL'], netGain: 2, ceiling: 80, gamesByWeek: [2], roleUp: false },
    { id: '2', name: 'Big Man', team: 'DEN', elig: ['F', 'UTIL'], netGain: 1, ceiling: 90, gamesByWeek: [4], roleUp: true, injury: 'GTD' },
    { id: '3', name: 'Swing', team: 'BOS', elig: ['G', 'F', 'UTIL'], netGain: 0, ceiling: 50, gamesByWeek: [3] },
  ];
  assert.deepStrictEqual(UI.filterTargets(ts, { pos: 'G' }).map(t => t.id), ['1', '3']);
  assert.deepStrictEqual(UI.filterTargets(ts, { pos: 'F' }).map(t => t.id), ['2', '3']);
  assert.deepStrictEqual(UI.filterTargets(ts, { roleUp: true }).map(t => t.id), ['2']);
  assert.deepStrictEqual(UI.filterTargets(ts, { q: 'doncic' }).map(t => t.id), ['1'], 'accent-insensitive');
  assert.deepStrictEqual(UI.filterTargets(ts, { hideInjured: true }).map(t => t.id), ['1', '3']);
  assert.deepStrictEqual(UI.sortTargets(ts, 'ceiling').map(t => t.id), ['2', '1', '3']);
  assert.deepStrictEqual(UI.sortTargets(ts, 'games').map(t => t.id), ['2', '3', '1']);
  assert.deepStrictEqual(UI.sortTargets(ts, 'gain').map(t => t.id), ['1', '2', '3']);
  assert.strictEqual(UI.fmtGain(1.234), '+1.2');
  assert.strictEqual(UI.fmtGain(-0.26), '\u22120.3');
  assert.strictEqual(UI.fmtGain(NaN), '0.0');
  assert.strictEqual(UI.gamesTone(4), 'hi');
  assert.strictEqual(UI.gamesTone(2), 'lo');
  assert.strictEqual(UI.gamesTone(3), '');
  assert.strictEqual(UI.normalizeHorizon('4'), 4);
  assert.strictEqual(UI.normalizeHorizon(3), 1);
  assert.deepStrictEqual(UI.weekLabel(2, { 2: { start: '2026-10-26', end: '2026-11-01' } }), { title: 'Wk 2', span: 'Oct 26\u2013Nov 1' });
  assert.strictEqual(UI.injuryTag('Out'), 'OUT');
  assert.strictEqual(UI.injuryTag('Questionable'), 'GTD');
});

test('page logic: manual roster state, draft import, request body', () => {
  let st = UI.loadManual('not json');
  assert.deepStrictEqual(st, { v: 1, roster: [], exclude: [] });
  st = UI.addToRoster(st, '12');
  st = UI.addToRoster(st, '12');
  st = UI.toggleExclude(st, '99');
  st = UI.toggleExclude(st, '12');
  assert.deepStrictEqual(st, { v: 1, roster: ['12'], exclude: ['99'] }, 'no dupes; roster ids cannot be hidden');
  st = UI.addToRoster(st, '99');
  assert.deepStrictEqual(st.exclude, [], 'adding un-hides');
  for (let i = 0; i < 30; i++) st = UI.addToRoster(st, String(100 + i));
  assert.strictEqual(st.roster.length, UI.MAX_ROSTER);
  assert.deepStrictEqual(UI.loadManual(UI.saveManual(st)), st, 'round trip');
  assert.deepStrictEqual(UI.loadManual({ v: 1, roster: ['<x>', '5', 5], exclude: ['5', '6'] }), { v: 1, roster: ['5'], exclude: ['6'] });
  const draft = JSON.stringify({ v: 1, manual: [{ playerId: '1', mine: true }, { playerId: '2', mine: false }, { playerId: '3', mine: true }] });
  assert.deepStrictEqual(UI.importFromDraft(draft), { v: 1, roster: ['1', '3'], exclude: ['2'] });
  assert.strictEqual(UI.importFromDraft('{"manual":[{"playerId":"2"}]}'), null, 'no picks of mine');
  assert.strictEqual(UI.importFromDraft('garbage'), null);
  assert.deepStrictEqual(UI.manualRequest({ v: 1, roster: ['1'], exclude: ['2'] }, 4), { roster: ['1'], weeks: 4, exclude: ['2'] });
  assert.deepStrictEqual(UI.manualRequest({ v: 1, roster: ['1'], exclude: [] }, 7), { roster: ['1'], weeks: 1 });
  const ps = [{ id: '1', name: 'Nikola Jokić' }, { id: '2', name: 'Nikola Vučević' }, { id: '3', name: 'Jalen Brunson' }];
  assert.deepStrictEqual(UI.searchPlayers(ps, 'nikola', ['1']).map(p => p.id), ['2']);
  assert.deepStrictEqual(UI.searchPlayers(ps, 'jokic').map(p => p.id), ['1']);
  assert.deepStrictEqual(UI.searchPlayers(ps, '  ').length, 0);
  assert.deepStrictEqual(UI.prefs('{"horizon":2,"pos":"X","sort":"ceiling","roleUp":1}'), { horizon: 2, pos: 'ALL', roleUp: true, sort: 'ceiling', source: null });
});

// ---------------------------------------------------------------- routes
const yp = (key, full, team, pos) => ({ player_key: key, player_id: key.split('.p.')[1], name: { full }, editorial_team_abbr: team, display_position: pos, eligible_positions: pos.split(',') });
function fakeModel(players) {
  return {
    async getPlayers() { return { season: 2026, week: null, currentWeek: 1, asOf: 'test', players }; },
    matchYahooPlayer(y, ps) { const p = ps.find(x => x.name === y.name.full); return p ? { player: p, confidence: 0.95 } : null; },
  };
}
function routePlayers() {
  const r = baseRoster().map(p => Object.assign(p, { name: 'Roster ' + p.id }));
  const fa = [mk(600, ['F'], 38, 4, { name: 'Four Game' }), mk(601, ['F'], 38, 2, { name: 'Two Game' }), mk(602, ['G'], 34, 4, { name: 'Waiver Guard' })];
  return { roster: r, fa, all: r.concat(fa) };
}
function fakeClient(calls, { fail, il } = {}) {
  const { roster } = routePlayers();
  return {
    async getRoster(tk) {
      calls.push(['roster', tk]); if (fail) throw fail;
      // il: the 10th roster player (weakest) sits in an IL slot and one bench spot is empty.
      const ps = roster.map((p, i) => Object.assign(yp('466.p.' + (i + 1), p.name, 'DEN', 'PG'), { selected_position: il && i === 9 ? 'IL' : 'BN' }));
      return { players: ps.concat([yp('466.p.999', 'Nobody Known', 'BOS', 'SF')]) };
    },
    async getPlayers(lk, o) {
      calls.push(['players', lk, o.status, o.start]);
      if (o.status === 'FA' && o.start === 0) return [yp('466.p.600', 'Four Game', 'DEN', 'PF'), yp('466.p.601', 'Two Game', 'DEN', 'PF'), yp('466.p.700', 'Mystery Man', 'NYK', 'C')];
      if (o.status === 'W') return [yp('466.p.602', 'Waiver Guard', 'DEN', 'PG')];
      return [];
    },
    async getLeague() { return { roster_positions: [{ position: 'G', count: 2 }, { position: 'F', count: 3 }, { position: 'Util', count: 1 }, { position: 'BN', count: 4 }, { position: 'IL', count: 2 }], settings: { waiver_type: 'R', uses_faab: '0', waiver_time: '2' }, weeks: [{ week: 1, start: '2026-10-20', end: '2026-10-25' }] }; },
  };
}
async function serve(router) {
  const app = express();
  app.set('trust proxy', false);
  app.use(router);
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => new Promise(r => srv.close(r)) };
}
const fakeAuth = (req, res, next) => (req.headers['x-user'] ? next() : res.status(401).json({ error: 'unauth' }));
const fakeGetAuth = req => ({ userId: req.headers['x-user'] || null });
const passCache = async (k, t, fn) => fn();
function mkRouter(opts = {}) {
  const calls = [];
  const players = routePlayers().all;
  const r = waiversRoutes(Object.assign({
    auth: fakeAuth, getAuth: fakeGetAuth, apiCached: passCache, loadModel: () => fakeModel(players),
    clientFor: () => fakeClient(calls, opts), loadData: () => null, log: { error() {}, warn() {} },
    sendYahooError: (res, err) => res.status(err.code === 'not_connected' ? 409 : 502).json({ error: 'y', code: err.code }),
  }, opts.deps || {}));
  return { r, calls };
}

test('GET /api/nba/waivers: auth + validation', async () => {
  const { r } = mkRouter();
  const s = await serve(r);
  try {
    const q = '?league_key=466.l.1&team_key=466.l.1.t.3';
    assert.strictEqual((await fetch(s.base + '/api/nba/waivers' + q)).status, 401);
    const H = { headers: { 'x-user': 'u1' } };
    assert.strictEqual((await fetch(s.base + '/api/nba/waivers?league_key=bad&team_key=466.l.1.t.3', H)).status, 400);
    assert.strictEqual((await fetch(s.base + '/api/nba/waivers?league_key=466.l.1&team_key=466.l.2.t.3', H)).status, 400, 'team from another league');
    assert.strictEqual((await fetch(s.base + '/api/nba/waivers' + q + '&weeks=3', H)).status, 400);
    assert.strictEqual((await fetch(s.base + '/api/nba/waivers' + q + '&week=0', H)).status, 400);
  } finally { await s.close(); }
});

test('GET /api/nba/waivers: Yahoo roster + FA/W pool, unmatched surfaced, ranked by schedule', async () => {
  const { r, calls } = mkRouter();
  const s = await serve(r);
  try {
    const res = await fetch(s.base + '/api/nba/waivers?league_key=466.l.1&team_key=466.l.1.t.3&weeks=2', { headers: { 'x-user': 'u1' } });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    const j = await res.json();
    assert.strictEqual(j.mode, 'yahoo');
    assert.strictEqual(j.horizon, 2);
    assert.ok(calls.some(c => c[0] === 'players' && c[2] === 'FA') && calls.some(c => c[0] === 'players' && c[2] === 'W'), 'FA and W pulled');
    assert.ok(calls.filter(c => c[2] === 'FA').length === 1, 'stops paging on a short page');
    assert.deepStrictEqual(j.unmatched.roster.map(u => u.name), ['Nobody Known']);
    assert.deepStrictEqual(j.unmatched.freeAgents.map(u => u.name), ['Mystery Man']);
    assert.strictEqual(j.freeAgentCount, 3);
    const ids = j.targets.map(t => t.name);
    assert.ok(ids.indexOf('Four Game') < ids.indexOf('Two Game'), '4-game first');
    assert.strictEqual(j.targets.find(t => t.name === 'Waiver Guard').onWaivers, true);
    assert.strictEqual(j.rosterSize, 10, 'IL excluded from roster size');
    assert.strictEqual(j.rules.uses_faab, false);
    assert.strictEqual(j.rules.waiver_type, 'R');
    assert.deepStrictEqual(j.weekDates['1'], { start: '2026-10-20', end: '2026-10-25' });
    assert.ok(j.dropCandidate && j.pairs.length >= 1);
    allNumbersFinite(j);
  } finally { await s.close(); }
});

test('GET /api/nba/waivers: Yahoo not connected → 409; model stub → 503', async () => {
  const e = Object.assign(new Error('nc'), { code: 'not_connected' });
  let s = await serve(mkRouter({ fail: e }).r);
  try {
    const res = await fetch(s.base + '/api/nba/waivers?league_key=466.l.1&team_key=466.l.1.t.3', { headers: { 'x-user': 'u1' } });
    assert.strictEqual(res.status, 409);
  } finally { await s.close(); }
  s = await serve(mkRouter({ deps: { loadModel: () => ({ stub: true }) } }).r);
  try {
    const res = await fetch(s.base + '/api/nba/waivers/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roster: ['1'] }) });
    assert.strictEqual(res.status, 503);
  } finally { await s.close(); }
});

test('POST /api/nba/waivers/manual: pool, default pool, unknown ids, validation, size + rate limits', async () => {
  const { r } = mkRouter({ deps: { rate: { windowMs: 60000, max: 8 } } });
  const s = await serve(r);
  const post = (body, raw) => fetch(s.base + '/api/nba/waivers/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw != null ? raw : JSON.stringify(body) });
  try {
    const rosterIds = baseRoster().map(p => p.id);
    let res = await post({ roster: rosterIds, pool: ['600', '601', '1', 'zzz'], weeks: 1 });
    assert.strictEqual(res.status, 200);
    let j = await res.json();
    assert.strictEqual(j.mode, 'manual');
    assert.deepStrictEqual(j.unknown, ['zzz']);
    assert.deepStrictEqual(j.targets.map(t => t.id), ['600', '601'], 'roster id excluded from pool; 4-game first');
    res = await post({ roster: rosterIds, exclude: ['602'] });
    j = await res.json();
    assert.strictEqual(j.freeAgentCount, 2, 'default pool = model players not in roster, minus exclude');
    assert.strictEqual((await post({ roster: [] })).status, 400);
    assert.strictEqual((await post({ roster: ['<script>'] })).status, 400);
    assert.strictEqual((await post({ roster: Array.from({ length: 21 }, (_, i) => String(i)) })).status, 400);
    assert.strictEqual((await post({ roster: ['1'], weeks: 3 })).status, 400);
    res = await post(null, '{"roster":["1"],"pool":[' + '"12345678",'.repeat(2000) + '"1"]}');
    assert.strictEqual(res.status, 413);
    assert.match(res.headers.get('content-type'), /json/);
    res = await post(null, '{bad json');
    assert.strictEqual(res.status, 400);
    assert.match(res.headers.get('content-type'), /json/);
    res = await post({ roster: ['1'] });
    assert.strictEqual(res.status, 429, '9th request in the window is limited');
    assert.ok(Number(res.headers.get('retry-after')) > 0);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- checker regressions (2026-10-13)
test('mid-week: an add only counts the games his team has left', () => {
  const roster = baseRoster();
  // Equal talent. A's team has 4 games but already played 3; B's team has 3, none played.
  const A = mk(120, ['F'], 40, 4, { team: 'AAA' }), B = mk(121, ['F'], 40, 3, { team: 'BBB' });
  const full = W.analyzeWaivers({ roster, pool: [A, B], startWeek: 1, horizon: 1 });
  assert.strictEqual(full.targets[0].id, '120', 'no mid-week info: 4-game week wins');
  const mid = W.analyzeWaivers({ roster, pool: [A, B], startWeek: 1, horizon: 1, midWeek: { week: 1, played: { AAA: 3, BBB: 0, [roster[9].team]: 1 } } });
  assert.strictEqual(mid.targets[0].id, '121', '3 games left beats 1 game left');
  const a = mid.targets.find(t => t.id === '120');
  assert.strictEqual(a.gamesLeft, 1); assert.strictEqual(a.gamesFull, 4);
  assert.deepStrictEqual(a.gamesByWeek, [1]);
  assert.ok(a.valueByWeek[0] < A.hsByWeek[1] - 5, 'one game left is worth much less than four');
  assert.ok(Math.abs(W.remainingWeekValue(A, 1, 4) - A.hsByWeek[1]) < 1e-9 && W.remainingWeekValue(A, 1, 0) === 0);
  assert.strictEqual(mid.midWeek.week, 1);
  const d = mid.dropCandidates.find(x => x.id === roster[9].id);
  assert.strictEqual(d.bankedGames, 1, 'drop warns about games already played this week');
  // midWeek for another week is ignored; later horizon weeks are untouched.
  const other = W.analyzeWaivers({ roster, pool: [A, B], startWeek: 2, horizon: 2, midWeek: { week: 1, played: { AAA: 3 } } });
  assert.strictEqual(other.midWeek, null);
  const two = W.analyzeWaivers({ roster, pool: [A, B], startWeek: 1, horizon: 2, midWeek: { week: 1, played: { AAA: 3 } } });
  assert.strictEqual(two.targets.find(t => t.id === '120').gamesByWeek[1], 4, 'week 2 keeps all games');
  allNumbersFinite(mid);
});

test('midWeekFrom: logs through yesterday, else share of days gone; null outside a week', () => {
  const day = s => Math.floor(Date.parse(s + 'T00:00:00Z') / 86400000);
  const proj = { season: '2026', weeks: { 1: ['2026-10-20', '2026-10-25'], 2: ['2026-10-26', '2026-11-01'] }, teamGames: { AAA: { 1: 4, 2: 3 }, BBB: { 1: 2, 2: 4 } } };
  const R = waiversRoutes.midWeekFrom;
  assert.strictEqual(R({ proj, logs: [] }, new Date('2026-10-20T18:00:00Z')), null, 'first day of week: nothing played yet');
  assert.strictEqual(R({ proj, logs: [] }, new Date('2026-10-01T18:00:00Z')), null);
  const est = R({ proj, logs: [] }, new Date('2026-10-23T18:00:00Z')); // 3 of 6 days gone
  assert.deepStrictEqual(est, { week: 1, played: { AAA: 2, BBB: 1 }, source: 'estimate' });
  const logs = [{ season: 2026, players: { x: { t: 'AAA', g: [[day('2026-10-20'), 1, 30, 30], [day('2026-10-22'), 1, 30, 30]] }, y: { t: 'BBB', g: [[day('2026-10-21'), 1, 20, 20]] }, z: { t: 'AAA', g: [[day('2026-10-22'), 1, 10, 20]] } } }];
  assert.deepStrictEqual(R({ proj, logs }, new Date('2026-10-23T18:00:00Z')), { week: 1, played: { AAA: 2, BBB: 1 }, source: 'logs' });
  assert.deepStrictEqual(R({ proj, logs }, new Date('2026-10-25T18:00:00Z')).played, { AAA: 3, BBB: 2 }, 'stale logs: estimate is the floor');
});

test('IL slot: frees a roster spot and is never the drop half of a swap', () => {
  const roster = baseRoster();
  const fa = mk(130, ['F'], 40, 4);
  // 9 active + 1 in IL, roster size 10 → one open spot, no drop.
  const r1 = W.analyzeWaivers({ roster, pool: [fa], startWeek: 1, ilIds: [roster[9].id], rosterSize: 10 });
  assert.strictEqual(r1.openSpots, 1);
  assert.strictEqual(r1.targets[0].drop, null);
  // Full active roster + IL player: the IL player is not offered as the drop.
  const il = mk(131, ['G'], 10, 0, { injury: 'INJ' });
  const r2 = W.analyzeWaivers({ roster: [...roster, il], pool: [fa], startWeek: 1, ilIds: ['131'], rosterSize: 10 });
  assert.strictEqual(r2.openSpots, 0);
  assert.ok(r2.targets[0].drop && r2.targets[0].drop.id !== '131');
  assert.ok(r2.pairs.every(p => !p.drop || p.drop.id !== '131'));
  assert.notStrictEqual(r2.dropCandidate.id, '131');
  assert.strictEqual(r2.dropCandidates.find(d => d.id === '131').ilSlot, true);
  // An injured starter in an IL slot still gets replacement suggestions.
  const star = mk(132, ['F'], 50, 3, { injury: 'OUT', hsByWeek: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
  const r3 = W.analyzeWaivers({ roster: [...roster.slice(0, 9), star], pool: [fa], startWeek: 1, ilIds: ['132'], rosterSize: 10 });
  assert.ok(r3.injuryReplacements.some(x => x.injured.id === '132'));
});

test('engine dedupes duplicate pool rows', () => {
  const fa = mk(140, ['F'], 40, 4);
  const r = W.analyzeWaivers({ roster: baseRoster(), pool: [fa, fa, { ...fa }], startWeek: 1 });
  assert.strictEqual(r.targets.length, 1);
  assert.strictEqual(r.calendar[0].fourGame.length, 1);
});

test('GET /api/nba/waivers: IL-slot player opens a spot (route reads selected_position)', async () => {
  const { r } = mkRouter({ il: true });
  const s = await serve(r);
  try {
    const j = await (await fetch(s.base + '/api/nba/waivers?league_key=466.l.1&team_key=466.l.1.t.3', { headers: { 'x-user': 'u1' } })).json();
    assert.strictEqual(j.openSpots, 1);
    assert.ok(j.targets.every(t => t.drop == null));
    assert.strictEqual(j.dropCandidates.find(d => d.name === 'Roster 10').ilSlot, true);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- league 242808
// Yahoo-eligibility player for the 242808 profile.
function ymk(id, pos, mean, games, extra = {}) {
  const p = mk(id, [], mean, games, extra);
  p.pos = pos; p.yahooPos = pos; p.yahooElig = [...RS.eligFor({ pos }, HL)];
  delete p.elig;
  return p;
}
const POS9 = [['PG'], ['SG'], ['PG', 'SG'], ['SF'], ['PF'], ['SF', 'PF'], ['C'], ['PF', 'C'], ['SG', 'SF']];
// 14 active players (no C-only), descending talent.
function hlRoster() {
  return Array.from({ length: 14 }, (_, i) => ymk(300 + i, POS9[i % 6], 52 - i * 2, 3));
}
const W8 = o => W0.analyzeWaivers({ profile: HL, ...o });

test('242808: lineup uses the 9 profile slots; a C-only free agent fills the C hole (and can\'t play F)', () => {
  const roster = hlRoster();
  const big = ymk(900, ['C'], 30, 3);
  const r = W8({ roster, pool: [big], startWeek: 1, horizon: 1 });
  eq9(r.slots, ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'UTIL']);
  assert.strictEqual(r.lineup.starters.length, 8, 'no C on the roster: C slot open');
  assert.ok(!r.lineup.starters.some(x => x.slot === 'C'));
  assert.strictEqual(r.rosterSize, 14);
  assert.strictEqual(r.openSpots, 0);
  const t = r.targets[0];
  assert.strictEqual(t.id, '900');
  assert.ok(t.netGain > 20, 'C fills an empty starting slot: ' + t.netGain);
  assert.deepStrictEqual(t.elig, ['C']);
});
function eq9(a, b) { assert.deepStrictEqual(a, b); }

test('242808: IL — Out players take the 2 IL slots (manual mode) and free active spots', () => {
  const roster = hlRoster().slice(0, 12).concat([ymk(400, ['PG'], 45, 3, { injury: 'Out' }), ymk(401, ['C'], 44, 3, { injury: 'Out' }), ymk(402, ['SF'], 20, 3)]);
  const r = W8({ roster, pool: [ymk(901, ['SG'], 28, 4)], startWeek: 1, horizon: 1 });
  assert.strictEqual(r.ilSlots, 2);
  assert.deepStrictEqual(r.ilIds.sort(), ['400', '401']);
  assert.ok(r.ilAuto);
  assert.strictEqual(r.openSpots, 1, '15 players − 2 IL = 13 active of 14');
  assert.strictEqual(r.dropCandidates.find(d => d.id === '400').ilSlot, true, 'IL players flagged');
  assert.ok(r.targets.every(t => !t.drop || !['400', '401'].includes(t.drop.id)), 'an IL player is never the drop half');
  // Yahoo mode passes ilIds explicitly: auto IL is off.
  const y = W8({ roster, pool: [], startWeek: 1, horizon: 1, ilIds: [] });
  assert.strictEqual(y.ilAuto, false);
  assert.strictEqual(y.openSpots, 0);
});

test('242808: weekly add budget from the profile (10); no adds left → no moves suggested', () => {
  const roster = hlRoster();
  const pool = [ymk(902, ['C'], 40, 4), ymk(903, ['C'], 38, 4), ymk(904, ['PF', 'C'], 37, 4)];
  const fresh = W8({ roster, pool, startWeek: 1, horizon: 1, addsUsed: 0 });
  assert.deepStrictEqual([fresh.adds.max, fresh.adds.used, fresh.adds.left], [10, 0, 10]);
  assert.strictEqual(fresh.adds.seasonMax, null, 'no season cap');
  assert.ok(fresh.pairs.length >= 1);
  const two = W8({ roster, pool, startWeek: 1, horizon: 1, addsUsed: 9 });
  assert.strictEqual(two.adds.left, 1);
  assert.ok(two.pairs.length <= 1, 'pairs capped by adds left');
  const none = W8({ roster, pool, startWeek: 1, horizon: 1, addsUsed: 10 });
  assert.strictEqual(none.adds.left, 0);
  assert.strictEqual(none.pairs.length, 0);
  assert.ok(none.targets.every(t => t.advice === 'no-adds-left'));
  const unknown = W8({ roster, pool, startWeek: 1, horizon: 1 });
  assert.strictEqual(unknown.adds.known, false);
  assert.strictEqual(unknown.adds.left, 10);
  const hs = W0.analyzeWaivers({ profile: HS, roster: baseRoster(), pool: [mk(950, ['G'], 30, 4)], startWeek: 1 });
  assert.strictEqual(hs.adds.max, null, 'High Score defaults: no limit in the profile');
});

test('242808: waiver-priority cost is monotone, zero when last, and only charged on W claims', () => {
  const T = HL.teams;
  let prev = Infinity;
  for (let p = 1; p <= T; p++) {
    const c = W0.priorityCost(p, T, 1);
    assert.ok(c >= 0 && c <= prev + 1e-12, `non-increasing at ${p}: ${c} vs ${prev}`);
    prev = c;
  }
  assert.strictEqual(W0.priorityCost(T, T, 1), 0);
  assert.ok(W0.priorityCost(1, T, 1) > W0.priorityCost(2, T, 1));
  assert.ok(W0.priorityCost(1, T, 2) > W0.priorityCost(1, T, 1), 'longer horizon → more option value (same units as netGain)');
  assert.strictEqual(W0.priorityCost(null, T, 1), 0);
  // Tunable: a bigger breakout lift raises the cost proportionally.
  near(W0.priorityCost(1, T, 1, { lift: 12 }), 2 * W0.priorityCost(1, T, 1), 1e-9);
  // A marginal streamer on waivers: claim at #12 (free), save priority at #1.
  const roster = hlRoster();
  const streamer = ymk(905, ['C'], 24, 3);
  const twinFA = ymk(906, ['C'], 24, 3);
  const at1 = W8({ roster, pool: [streamer, twinFA], startWeek: 1, horizon: 1, waiverIds: ['905'], priority: 1 });
  const s1 = at1.targets.find(t => t.id === '905'), f1 = at1.targets.find(t => t.id === '906');
  assert.strictEqual(s1.status, 'W');
  assert.strictEqual(f1.status, 'FA');
  assert.strictEqual(f1.priorityCost, 0, 'free agents cost no priority');
  near(s1.claimNet, s1.netGain - s1.priorityCost, 0.11);
  assert.ok(s1.priorityCost > 5);
  assert.strictEqual(at1.targets[0].id, '906', 'the FA twin ranks first once priority is priced');
  const atLast = W8({ roster, pool: [streamer], startWeek: 1, horizon: 1, waiverIds: ['905'], priority: 12 });
  assert.strictEqual(atLast.targets[0].priorityCost, 0);
  assert.strictEqual(atLast.targets[0].advice, 'claim');
  const marginal = ymk(907, ['PG'], 33, 3);
  const m1 = W8({ roster, pool: [marginal], startWeek: 1, horizon: 1, waiverIds: ['907'], priority: 1 }).targets[0];
  if (m1.netGain > 0.05 && m1.netGain < m1.priorityCost) assert.strictEqual(m1.advice, 'save-priority');
  const breakout = ymk(908, ['C'], 60, 4);
  assert.strictEqual(W8({ roster, pool: [breakout], startWeek: 1, horizon: 1, waiverIds: ['908'], priority: 1 }).targets[0].advice, 'claim');
  assert.ok(at1.priority.note.includes('#1 of 12'));
  assert.ok(at1.waiverRules.notes.some(n => /waivers for 1 day/.test(n)));
});

test('242808: a waiver claim clears tomorrow (misses today\'s game); a free agent plays today', () => {
  const roster = hlRoster();
  const w = ymk(909, ['C'], 40, 4, { team: 'AAA' }), f = ymk(910, ['C'], 40, 4, { team: 'AAA' });
  const midWeek = { week: 1, played: { AAA: 1 }, playedToday: { AAA: 2 } };
  const r = W8({ roster, pool: [w, f], startWeek: 1, horizon: 1, midWeek, waiverIds: ['909'] });
  const tw = r.targets.find(t => t.id === '909'), tf = r.targets.find(t => t.id === '910');
  assert.strictEqual(tf.gamesLeft, 3);
  assert.strictEqual(tw.gamesLeft, 2);
  assert.ok(tw.netGain < tf.netGain);
});

test('242808: 14-day matchup weeks — midWeekProfile counts real games inside the window', () => {
  const td = require(path.join(ROOT, 'nba/routes/league-context')).teamDates();
  const mw = waiversRoutes.midWeekProfile(HL, td, new Date('2026-12-08T18:00:00Z'));
  assert.strictEqual(mw.week, 7);
  const s = RS.dayNum('2026-11-30'), today = RS.dayNum('2026-12-08');
  for (const t of ['DEN', 'BOS', 'LAL']) {
    assert.strictEqual(mw.played[t], td[t].filter(d => d >= s && d < today).length);
    assert.ok(mw.playedToday[t] >= mw.played[t]);
  }
  assert.strictEqual(waiversRoutes.midWeekProfile(HL, td, new Date('2026-11-30T18:00:00Z')), null, 'first day of the week: nothing played yet');
  // Engine on week 7 (14 days): games and value come from that week's board numbers.
  const p = ymk(911, ['C'], 40, [3, 3, 3, 3, 3]);
  p.gamesByWeek[7] = 7; p.hsByWeek[7] = 55;
  const r = W8({ roster: hlRoster(), pool: [p], startWeek: 7, horizon: 1, weeks: [7, 8] });
  assert.deepStrictEqual(r.weeks, [7]);
  assert.deepStrictEqual(r.targets[0].gamesByWeek, [7]);
});

test('242808: profile swap — same roster under High Score defaults gets 6 slots', () => {
  const roster = baseRoster();
  const a = W0.analyzeWaivers({ profile: HS, roster, pool: [mk(951, ['F'], 30, 4)], startWeek: 1 });
  const b = W8({ roster, pool: [mk(951, ['F'], 30, 4)], startWeek: 1 });
  assert.deepStrictEqual(a.slots, ['G', 'G', 'FC', 'FC', 'FC', 'UTIL']);
  assert.strictEqual(b.slots.length, 9);
  assert.strictEqual(a.rosterSize, 10);
  assert.strictEqual(b.rosterSize, 14);
  allNumbersFinite(a); allNumbersFinite(b);
});

test('routes 242808: manual default league = 242808; priority/adds validated; Yahoo team state adapter', async () => {
  const players = hlRoster().concat([ymk(920, ['C'], 35, 4, { name: 'Fill C' })]);
  players.forEach(p => { p.name = p.name || 'P' + p.id; });
  const { r } = mkRouter({ deps: { loadModel: () => fakeModel(players), modelPlayers: async () => ({ players, currentWeek: 1 }) } });
  const s = await serve(r);
  try {
    const post = body => fetch(s.base + '/api/nba/waivers/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await (await post({ roster: hlRoster().map(p => p.id), priority: 1, addsUsed: 3, waivers: ['920'] })).json();
    assert.deepStrictEqual(ok.profile.slotList, ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'UTIL']);
    assert.deepStrictEqual([ok.adds.max, ok.adds.left], [10, 7]);
    assert.strictEqual(ok.priority.position, 1);
    assert.strictEqual(ok.targets.find(t => t.id === '920').status, 'W');
    assert.strictEqual(ok.weekDates['7'].days, 14);
    assert.strictEqual((await post({ roster: ['300'], priority: 0 })).status, 400);
    assert.strictEqual((await post({ roster: ['300'], addsUsed: -1 })).status, 400);
    assert.strictEqual((await post({ roster: ['300'], league_id: '../x' })).status, 400);
    const hs = await (await post({ roster: ['300'], league_id: 'hs' })).json();
    assert.strictEqual(hs.slots.length, 6);
  } finally { await s.close(); }
  const raw = { fantasy_content: { team: [[{ team_key: '466.l.242808.t.3' }, { waiver_priority: 4 }, { roster_adds: { coverage_type: 'week', coverage_value: 2, value: '3' } }]] } };
  const st = await waiversRoutes.teamWaiverState({ request: async () => raw }, '466.l.242808.t.3');
  assert.deepStrictEqual(st, { priority: 4, addsUsed: 3 });
  assert.deepStrictEqual(await waiversRoutes.teamWaiverState({}, 'x'), { priority: null, addsUsed: null });
});

test('mounted via nba/router.js: page + manual route reachable', async () => {
  const players = routePlayers().all;
  const store = { async get() { return null; }, async save() {}, async remove() {} };
  const router = createNbaRouter({ auth: fakeAuth, getAuth: fakeGetAuth, apiCached: passCache, env: {}, store, loadModel: () => fakeModel(players), log: { error() {}, warn() {} } });
  const s = await serve(router);
  try {
    const page = await fetch(s.base + '/nba/waivers');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /waivers-logic\.js/);
    const res = await fetch(s.base + '/api/nba/waivers/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roster: ['1', '2'] }) });
    assert.strictEqual(res.status, 200);
    const g = await fetch(s.base + '/api/nba/waivers?league_key=466.l.1&team_key=466.l.1.t.3', { headers: { 'x-user': 'u1' } });
    assert.strictEqual(g.status, 409, 'no tokens → yahoo_not_connected');
    assert.strictEqual((await g.json()).code, 'yahoo_not_connected');
  } finally { await s.close(); }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
