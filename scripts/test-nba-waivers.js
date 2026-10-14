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
const W = require(path.join(ROOT, 'nba/model/waivers'));
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
  const wv = (ps, w) => W.rosterWeekValue(ps, w);
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
function fakeClient(calls, { fail } = {}) {
  const { roster } = routePlayers();
  return {
    async getRoster(tk) { calls.push(['roster', tk]); if (fail) throw fail; return { players: roster.map((p, i) => yp('466.p.' + (i + 1), p.name, 'DEN', 'PG')).concat([yp('466.p.999', 'Nobody Known', 'BOS', 'SF')]) }; },
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
