#!/usr/bin/env node
// Checks for stream D (NBA weekly lineup picker): optimiser vs brute force,
// multi-eligibility, banked-score floors, forfeiture warnings, locks,
// back-to-backs, determinism, matchup Monte Carlo, and the HTTP routes with a
// mocked Yahoo client. Run: node scripts/test-nba-lineup.js (no network).
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const assert = require('assert');
const http = require('http');
const express = require('express');

const L = require('../nba/model/lineup');
const St = require('../nba/model/stats');
const createNbaRouter = require('../nba/router');
const createLineupRoutes = require('../nba/routes/lineup');
const { YahooError } = require('../nba/yahoo/client');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name); console.error(e); process.exitCode = 1; }
}

// Synthetic board player. hsByWeek is built with the same normal order
// statistics the picker calibrates against, so the calibrated mean == mean.
function hsFor(mean, sd, N, a) {
  const P = L.poissonBinomial(new Array(N).fill(a));
  let v = 0;
  for (let k = 1; k <= N; k++) v += P[k] * (mean + sd * St.stdNormMax(k));
  return v;
}
function mk(id, elig, mean, { sd = 10, games = 3, injury = null, a = 0.9, name, week = 1 } = {}) {
  return {
    id: String(id), name: name || `P${id}`, team: 'TST', pos: elig.includes('G') ? ['PG'] : ['PF'],
    elig: [...elig, 'UTIL'], injury, outForSeason: false, mean, sd, availability: a,
    games, gamesByWeek: { [week]: games }, hsValue: hsFor(mean, sd, games, a), hsByWeek: { [week]: hsFor(mean, sd, games, a) },
  };
}
const base = { week: 1, currentWeek: 0, weekLength: 7 }; // currentWeek < week → injury-free availability = max(a0, 0.55)

// Exhaustive search with the same rules as the optimiser.
function brute(evals, { forbidForfeit = false } = {}) {
  const val = e => (e.starter ? e.keep : e.insert);
  let best = -Infinity;
  (function go(i, g, f, u, v) {
    if (i === evals.length) { if (v > best) best = v; return; }
    const e = evals[i];
    const mustStart = e.starter && (e.locked || (forbidForfeit && e.banked > 0));
    const mustBench = !e.starter && e.locked;
    if (!mustStart) go(i + 1, g, f, u, v);
    if (mustBench || e.unmatched || e.slot === 'IL') return;
    const ok = t => !(mustStart && e.locked && t !== e.slot);
    if (e.elig.includes('G') && g < 2 && ok('G')) go(i + 1, g + 1, f, u, v + val(e));
    if (e.elig.includes('F') && f < 3 && ok('F')) go(i + 1, g, f + 1, u, v + val(e));
    if (u < 1 && ok('UTIL')) go(i + 1, g, f, u + 1, v + val(e));
  })(0, 0, 0, 0, 0);
  return best;
}

function listen(app) {
  return new Promise(resolve => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
}
async function call(server, method, path, body, headers = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { ...(body != null ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

(async () => {
  console.log('math');
  await test('calibration: full-week insert value == model hsByWeek (synthetic and real board)', async () => {
    const p = mk(1, ['G'], 42, { sd: 11, games: 4, a: 0.8 });
    const e = L.evalPlayer({ id: '1' }, p, { ...base, day: 0 });
    assert(Math.abs(e.insert - p.hsByWeek[1]) < 0.05, `${e.insert} vs ${p.hsByWeek[1]}`);
    assert(Math.abs(e.mu - 42) < 0.05);
    const { getPlayers } = require('../nba/model');
    const board = await getPlayers({ week: 3 });
    let worst = 0;
    for (const bp of board.players.slice(0, 150)) {
      const r = L.evalPlayer({ id: bp.id }, bp, { week: 3, currentWeek: board.currentWeek, weekLength: 7, day: 0 });
      // Real board: same availability; diff only from rest risk on forced back-to-backs (5-game weeks).
      if (bp.gamesByWeek[3] <= 4) worst = Math.max(worst, Math.abs(r.insert - bp.hsByWeek[3]));
    }
    assert(worst < 0.15, 'max calibration error ' + worst);
  });

  await test('emaxFloor matches a seeded Monte Carlo within 0.3', () => {
    const rng = L.mulberry32(7);
    const g = () => { let u = 0; while (!u) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
    for (const [mu, sd, k, B] of [[40, 10, 3, 55], [40, 10, 1, 30], [60, 15, 2, 80], [30, 8, 4, 0]]) {
      let s = 0; const n = 40000;
      for (let i = 0; i < n; i++) { let m = B; for (let j = 0; j < k; j++) m = Math.max(m, mu + sd * g()); s += m; }
      const exact = L.emaxFloor(mu, sd, k, B);
      assert(Math.abs(exact - s / n) < 0.3, `${[mu, sd, k, B]}: ${exact} vs ${s / n}`);
    }
    assert.strictEqual(L.emaxFloor(40, 10, 0, 55), 55, 'no games left → banked');
    assert(L.emaxFloor(40, 10, 2, 90) > 90 && L.emaxFloor(40, 10, 2, 90) < 90.1, 'big banked barely moves');
  });

  console.log('slot assignment');
  await test('multi-eligibility: G/F swingman goes where he frees the most value', () => {
    // 3 strong pure guards, 1 G/F, 3 forwards: best = G,G (top guards) + G/F at F? No —
    // the 3rd guard can only take UTIL; the swingman covers F.
    const P = [mk(1, ['G'], 50), mk(2, ['G'], 48), mk(3, ['G'], 46), mk(4, ['G', 'F'], 45), mk(5, ['F'], 44), mk(6, ['F'], 43), mk(7, ['F'], 20)];
    const out = L.recommend({ ...base, roster: P.map(p => ({ id: p.id })), players: P, day: 0 });
    const by = Object.fromEntries(out.slots.map(s => [s.player.id, s.slot]));
    assert.strictEqual(by['3'], 'UTIL');
    assert.strictEqual(by['4'], 'F');
    assert(!by['7'], 'weak pure F benched');
    assert.deepStrictEqual(out.slots.map(s => s.slot), L.SLOTS);
  });
  await test('multi-eligibility: only one pure guard → dual player forced to G', () => {
    const P = [mk(1, ['G'], 40), mk(2, ['G', 'F'], 50), mk(3, ['F'], 49), mk(4, ['F'], 48), mk(5, ['F'], 47), mk(6, ['F'], 46)];
    const out = L.recommend({ ...base, roster: P.map(p => ({ id: p.id })), players: P, day: 0 });
    const by = Object.fromEntries(out.slots.map(s => [s.player.id, s.slot]));
    assert.strictEqual(by['2'], 'G');
    assert.strictEqual(by['1'], 'G');
    assert.strictEqual(out.slots.length, 6);
  });
  await test('short roster: open slot warning, no NaN', () => {
    const P = [mk(1, ['F'], 40), mk(2, ['F'], 30)];
    const out = L.recommend({ ...base, roster: P.map(p => ({ id: p.id })).concat([{ id: 'ghost' }]), players: P, day: 0 });
    assert.strictEqual(out.slots.length, 2);
    assert(out.warnings.some(w => w.type === 'open-slots'));
    assert.deepStrictEqual(out.unmatched.map(u => u.id), ['ghost']);
    assert(Number.isFinite(out.total.expected) && Number.isFinite(out.total.p10));
  });
  await test('brute-force cross-check on 400 random rosters (incl. banked, locks, IL, forbidForfeit)', () => {
    const rng = L.mulberry32(99);
    const eligs = [['G'], ['F'], ['G', 'F'], ['G'], ['F']];
    const slots = ['G', 'F', 'UTIL', 'BN', 'BN', 'IL'];
    for (let t = 0; t < 400; t++) {
      const n = 4 + Math.floor(rng() * 10);
      const P = [], roster = [];
      for (let i = 0; i < n; i++) {
        const p = mk(i + 1, eligs[Math.floor(rng() * eligs.length)], 20 + rng() * 45, { sd: 5 + rng() * 12, games: 1 + Math.floor(rng() * 4), a: 0.5 + rng() * 0.45 });
        P.push(p);
        const slot = slots[Math.floor(rng() * slots.length)];
        roster.push({ id: p.id, slot, banked: rng() < 0.4 ? Math.round(rng() * 80) : undefined, locked: rng() < 0.12, gamesLeft: Math.floor(rng() * 4) });
      }
      const idx = new Map(P.map(p => [p.id, p]));
      const ctx = { ...base, day: 3 };
      const evals = roster.map(r => L.evalPlayer(r, idx.get(r.id), ctx));
      for (const forbidForfeit of [false, true]) {
        const opt = L.optimise(evals, { forbidForfeit });
        const val = e => (e.starter ? e.keep : e.insert);
        const got = opt.picks.reduce((s, [i]) => s + val(evals[i]), 0);
        const want = brute(evals, { forbidForfeit });
        if (want === -Infinity) continue; // infeasible lock combo (can't happen with caps but be safe)
        assert(Math.abs(got - want) < 1e-6, `roster ${t} forbid=${forbidForfeit}: dp ${got} vs brute ${want}`);
        const c = { G: 0, F: 0, UTIL: 0 };
        for (const [i, s] of opt.picks) {
          c[s]++;
          if (s !== 'UTIL') assert(evals[i].elig.includes(s), 'eligibility respected');
          assert(evals[i].slot !== 'IL');
        }
        assert(c.G <= 2 && c.F <= 3 && c.UTIL <= 1);
      }
    }
  });

  console.log('banked scores / forfeiture / locks');
  await test('banked 80 starter: value ≈ 80 + small upside; keep him over a 60-expected bench player', () => {
    const P = [mk(1, ['F'], 40, { sd: 10 }), mk(2, ['F'], 52, { sd: 10, games: 3 }), mk(3, ['G'], 30), mk(4, ['G'], 30), mk(5, ['F'], 30), mk(6, ['F'], 30), mk(7, ['G'], 30)];
    const roster = [{ id: '1', slot: 'F', banked: 80, gamesLeft: 2 }, { id: '2', slot: 'BN', gamesLeft: 3 }, { id: '3', slot: 'G' }, { id: '4', slot: 'G' }, { id: '5', slot: 'F' }, { id: '6', slot: 'F' }, { id: '7', slot: 'UTIL' }];
    const out = L.recommend({ ...base, roster, players: P, day: 3 });
    const s1 = out.slots.find(s => s.player.id === '1');
    assert(s1, 'banked 80 stays');
    assert(s1.expected >= 80 && s1.expected < 81, 'expected ' + s1.expected);
    assert(s1.pBeat < 0.05, 'small chance to beat 80');
    assert(out.slots.find(s => s.player.id === '2'), 'bench 52/game guy replaces a 30 guy instead');
    assert(!out.warnings.some(w => w.type === 'forfeit' && w.id === '1'));
  });
  await test('a banked starter is not double-counted after a non-forfeiting slot move', () => {
    const P = [mk(1, ['G', 'F'], 40), mk(2, ['G'], 30), mk(3, ['G'], 60), mk(4, ['F'], 30), mk(5, ['F'], 30), mk(6, ['F'], 30)];
    const roster = [{ id: '1', slot: 'G', banked: 50 }, { id: '2', slot: 'G' }, { id: '3', slot: 'BN' }, { id: '4', slot: 'F' }, { id: '5', slot: 'F' }, { id: '6', slot: 'UTIL' }];
    const out = L.recommend({ ...base, roster, players: P, day: 2 });
    const s1 = out.slots.find(s => s.player.id === '1');
    assert(s1 && s1.banked === 50, 'still starting with banked');
    assert(!out.warnings.some(w => w.type === 'forfeit'));
  });
  await test('forfeit: benching a banked starter is flagged with a warning and the forfeited amount', () => {
    const P = [mk(1, ['F'], 25, { sd: 6 }), mk(2, ['F'], 45, { games: 4 }), mk(3, ['G'], 40), mk(4, ['G'], 40), mk(5, ['F'], 40), mk(6, ['F'], 40), mk(7, ['G'], 40)];
    const roster = [{ id: '1', slot: 'F', banked: 20, gamesLeft: 0 }, { id: '2', slot: 'BN', gamesLeft: 3 }, { id: '3', slot: 'G' }, { id: '4', slot: 'G' }, { id: '5', slot: 'F' }, { id: '6', slot: 'F' }, { id: '7', slot: 'UTIL' }];
    const out = L.recommend({ ...base, roster, players: P, day: 4 });
    const d = out.diff.find(x => x.out && x.out.id === '1');
    assert(d && d.in && d.in.id === '2', 'swap 1 → 2');
    assert.strictEqual(d.forfeits, 20);
    assert(/forfeits his banked 20/.test(d.warning));
    assert(out.warnings.some(w => w.type === 'forfeit' && w.id === '1' && w.banked === 20));
    assert(out.gain > 0, 'swap still positive after the forfeit');
    // forbidForfeit keeps him
    const safe = L.recommend({ ...base, roster, players: P, day: 4, options: { forbidForfeit: true } });
    assert(safe.slots.some(s => s.player.id === '1'));
    assert(!safe.warnings.some(w => w.type === 'forfeit'));
  });
  await test('every recommended forfeit carries a warning (random rosters)', () => {
    const rng = L.mulberry32(5);
    for (let t = 0; t < 150; t++) {
      const P = [], roster = [];
      const slots = ['G', 'G', 'F', 'F', 'F', 'UTIL', 'BN', 'BN', 'BN', 'BN'];
      for (let i = 0; i < 10; i++) {
        const p = mk(i + 1, i % 3 === 0 ? ['G', 'F'] : i % 2 ? ['G'] : ['F'], 20 + rng() * 40);
        P.push(p);
        roster.push({ id: p.id, slot: slots[i], banked: i < 6 && rng() < 0.6 ? Math.round(rng() * 60) : undefined, gamesLeft: Math.floor(rng() * 4) });
      }
      const out = L.recommend({ ...base, roster, players: P, day: 3 });
      const chosen = new Set(out.slots.map(s => s.player.id));
      for (const r of roster) {
        if (r.slot === 'BN' || !(r.banked > 0) || chosen.has(r.id)) continue;
        assert(out.warnings.some(w => w.type === 'forfeit' && w.id === r.id), `roster ${t}: ${r.id} forfeits without warning`);
        assert(out.diff.some(d => d.out && d.out.id === r.id && d.warning), 'diff row warns too');
      }
    }
  });
  await test('locked players stay put (starter keeps slot, bench stays bench)', () => {
    const P = [mk(1, ['G', 'F'], 10), mk(2, ['G'], 60), mk(3, ['G'], 50), mk(4, ['F'], 50), mk(5, ['F'], 50), mk(6, ['F'], 50), mk(7, ['G'], 55)];
    const roster = [{ id: '1', slot: 'UTIL', locked: true }, { id: '2', slot: 'BN', locked: true }, { id: '3', slot: 'G' }, { id: '4', slot: 'F' }, { id: '5', slot: 'F' }, { id: '6', slot: 'F' }, { id: '7', slot: 'G' }];
    const out = L.recommend({ ...base, roster, players: P, day: 2 });
    assert.strictEqual(out.slots.find(s => s.player.id === '1').slot, 'UTIL');
    assert(!out.slots.find(s => s.player.id === '2'));
    assert(/locked/i.test(out.bench.find(b => b.player.id === '2').reason));
  });

  console.log('schedule / injury');
  await test('back-to-back second leg lowers value; spread schedule does not', () => {
    const p = mk(1, ['F'], 52, { games: 2 });
    const ctx = { ...base, day: 0 };
    const b2b = L.evalPlayer({ id: '1', gameDays: [3, 4] }, p, ctx);
    const spread = L.evalPlayer({ id: '1', gameDays: [3, 5] }, p, ctx);
    assert.strictEqual(b2b.b2b, 1); assert.strictEqual(spread.b2b, 0);
    assert(b2b.insert < spread.insert, `${b2b.insert} < ${spread.insert}`);
    const past = L.evalPlayer({ id: '1', gameDays: [0, 1, 5] }, p, { ...base, day: 2 });
    assert.strictEqual(past.gamesLeft, 1, 'played days excluded');
  });
  await test('injury: an OUT player this week is worth far less than a healthy twin', () => {
    const healthy = mk(1, ['F'], 50), out = mk(2, ['F'], 50, { injury: 'Out' });
    out.hsByWeek[1] = hsFor(50, 10, 3, 0.1); // the board values an OUT player with a = 0.1
    const ctx = { week: 1, currentWeek: 1, weekLength: 7, day: 0 };
    assert(L.evalPlayer({ id: '2' }, out, ctx).insert < 0.3 * L.evalPlayer({ id: '1' }, healthy, ctx).insert);
  });
  await test('IL players are never started', () => {
    const P = [mk(1, ['G'], 90), ...[2, 3, 4, 5, 6, 7].map(i => mk(i, i < 4 ? ['G'] : ['F'], 30))];
    const out = L.recommend({ ...base, roster: [{ id: '1', slot: 'IL' }, ...P.slice(1).map(p => ({ id: p.id }))], players: P, day: 0 });
    assert(!out.slots.some(s => s.player.id === '1'));
  });

  console.log('determinism / matchup');
  const P10 = Array.from({ length: 20 }, (_, i) => mk(i + 1, i % 3 ? (i % 2 ? ['G'] : ['F']) : ['G', 'F'], 30 + (i * 7) % 30, { games: 2 + (i % 3) }));
  const mine = P10.slice(0, 10).map(p => ({ id: p.id }));
  const theirs = P10.slice(10).map(p => ({ id: p.id }));
  await test('same input + seed → identical output; band brackets the mean', () => {
    const a = L.recommend({ ...base, roster: mine, players: P10, day: 0, opponent: { roster: theirs } });
    const b = L.recommend({ ...base, roster: mine, players: P10, day: 0, opponent: { roster: theirs } });
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.mc.n, 2000);
    assert(a.total.p10 < a.total.expected && a.total.expected < a.total.p90);
    assert(Math.abs(a.total.p50 - a.total.expected) < 0.05 * a.total.expected, 'MC median near the exact expectation');
  });
  await test('win probability: in [0,1], symmetric-ish, monotone in opponent strength', () => {
    const r = L.recommend({ ...base, roster: mine, players: P10, day: 0, opponent: { roster: mine } });
    assert(r.matchup.winProb > 0.4 && r.matchup.winProb < 0.6, 'mirror match ≈ 50%: ' + r.matchup.winProb);
    const weak = P10.map(p => ({ ...p, id: 'w' + p.id, hsByWeek: { 1: p.hsByWeek[1] * 0.6 }, mean: p.mean * 0.6 }));
    const all = [...P10, ...weak];
    const vsWeak = L.recommend({ ...base, roster: mine, players: all, day: 0, opponent: { roster: weak.slice(0, 10).map(p => ({ id: p.id })) } });
    assert(vsWeak.matchup.winProb > 0.95, 'beats a 60% clone: ' + vsWeak.matchup.winProb);
    assert(vsWeak.matchup.winProb <= 1 && vsWeak.matchup.winProb >= 0);
  });
  await test('outputs: per-slot rationale, alternatives, stream note, diff string inputs', () => {
    const roster = mine.map((r, i) => ({ ...r, slot: ['G', 'G', 'F', 'F', 'F', 'UTIL', 'BN', 'BN', 'BN', 'BN'][i] }));
    const out = L.recommend({ ...base, roster, players: P10, day: 5 });
    for (const s of out.slots) {
      assert(typeof s.rationale === 'string' && s.rationale.length > 5);
      assert(typeof s.streamNote === 'string' && s.streamNote.length > 5);
      assert(Array.isArray(s.alternatives));
    }
    assert(out.current && Number.isFinite(out.current.expected));
    assert(Math.abs(out.gain - (out.total.expected - out.current.expected)) < 0.11);
  });

  console.log('routes');
  const board = Array.from({ length: 14 }, (_, i) => ({ ...mk(100 + i, i % 2 ? ['G'] : ['F'], 30 + i * 2), name: `Player ${100 + i}`, rank: i + 1 }));
  const yp = (i, sel) => ({ player_key: `466.p.${i}`, player_id: String(i), name: { full: `Player ${i}` }, editorial_team_abbr: 'TST', display_position: 'PG', eligible_positions: ['PG'], selected_position: sel });
  const rosters = {
    '466.l.1.t.1': { team: { name: 'Mine' }, players: [yp(100, 'F'), yp(101, 'G'), yp(102, 'F'), yp(103, 'G'), yp(104, 'F'), yp(105, 'Util'), yp(106, 'BN'), yp(999, 'BN')] },
    '466.l.1.t.2': { team: { name: 'Rival' }, players: [yp(107, 'G'), yp(108, 'F'), yp(109, 'G'), yp(110, 'F'), yp(111, 'F'), yp(112, 'Util')] },
  };
  const model = {
    async getPlayers() { return { season: 2026, week: 1, currentWeek: 0, players: board }; },
    matchYahooPlayer(y, players) { const p = players.find(x => x.name === y.name.full); return p ? { player: p, confidence: 0.95, reason: 'name' } : null; },
  };
  let clientMode = 'ok';
  const fakeClient = () => ({
    async getRoster(tk) {
      if (clientMode === 'notconnected') throw new YahooError('Yahoo not connected', 401, 'not_connected');
      return rosters[tk];
    },
    async request(path) {
      if (clientMode === 'nomatchup') throw new YahooError('Yahoo API 500', 500);
      assert(/^team\/466\.l\.1\.t\.1\/matchups;weeks=1$/.test(path), path);
      return { fantasy_content: { team: [[{ team_key: '466.l.1.t.1' }], { matchups: { 0: { matchup: { 0: { teams: { 0: { team: [[{ team_key: '466.l.1.t.1' }]] }, 1: { team: [[{ team_key: '466.l.1.t.2' }]] } } } } } } }] } };
    },
  });
  const apiCache = new Map();
  const apiCached = async (k, ttl, fn) => { if (clientMode !== 'ok') return fn(); if (!apiCache.has(k)) apiCache.set(k, await fn()); return apiCache.get(k); };
  const fakeGetAuth = req => ({ userId: req.headers['x-user'] || null });
  const fakeAuth = (req, res, next) => (fakeGetAuth(req).userId ? next() : res.status(401).json({ error: 'Sign in required' }));
  const app = express();
  app.use('/', createNbaRouter({
    auth: fakeAuth, getAuth: fakeGetAuth, apiCached, env: { YAHOO_CLIENT_ID: 'x', YAHOO_CLIENT_SECRET: 'y' },
    loadModel: () => model, makeClient: fakeClient, log: { error() {}, warn() {} },
  }));
  const server = await listen(app);
  const U = { 'x-user': 'user_1' };
  try {
    await test('GET /api/nba/lineup requires sign-in (401) and validates keys (400)', async () => {
      assert.strictEqual((await call(server, 'GET', '/api/nba/lineup?league_key=466.l.1&team_key=466.l.1.t.1&week=1')).status, 401);
      assert.strictEqual((await call(server, 'GET', '/api/nba/lineup?league_key=bad&team_key=466.l.1.t.1&week=1', null, U)).status, 400);
      assert.strictEqual((await call(server, 'GET', '/api/nba/lineup?league_key=466.l.1&team_key=466.l.2.t.1&week=1', null, U)).status, 400, 'team from another league');
      assert.strictEqual((await call(server, 'GET', '/api/nba/lineup?league_key=466.l.1&team_key=466.l.1.t.1&week=99', null, U)).status, 400);
      assert.strictEqual((await call(server, 'GET', '/api/nba/lineup?league_key=466.l.1&team_key=466.l.1.t.1&week=1&day=x', null, U)).status, 400);
    });
    await test('GET /api/nba/lineup: Yahoo roster → model players, unmatched listed, matchup computed', async () => {
      const r = await call(server, 'GET', '/api/nba/lineup?league_key=466.l.1&team_key=466.l.1.t.1&week=1&day=2&banked=100:55,bogus', null, U);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.source, 'yahoo');
      assert.strictEqual(r.json.slots.length, 6);
      assert.deepStrictEqual(r.json.unmatched.map(u => u.name), ['Player 999']);
      assert.strictEqual(r.json.roster.find(x => x.name === 'Player 105').slot, 'UTIL');
      assert.strictEqual(r.json.slots.find(s => s.player.id === '100').banked, 55);
      assert(r.json.matchup && r.json.matchup.winProb >= 0 && r.json.matchup.winProb <= 1);
      assert.strictEqual(r.json.matchup.opponentName, 'Rival');
      assert(!JSON.stringify(r.json).includes('access_token'));
    });
    await test('GET /api/nba/lineup: opponent failure degrades to matchupError; not connected → 409', async () => {
      clientMode = 'nomatchup';
      const r = await call(server, 'GET', '/api/nba/lineup?league_key=466.l.1&team_key=466.l.1.t.1&week=1&day=0', null, U);
      assert.strictEqual(r.status, 200);
      assert(!r.json.matchup && r.json.matchupError);
      clientMode = 'notconnected';
      const n = await call(server, 'GET', '/api/nba/lineup?league_key=466.l.1&team_key=466.l.1.t.1&week=1', null, U);
      assert.strictEqual(n.status, 409);
      assert.strictEqual(n.json.code, 'yahoo_not_connected');
      clientMode = 'ok';
    });
    await test('POST /api/nba/lineup/manual works signed out; validates input', async () => {
      const ok = await call(server, 'POST', '/api/nba/lineup/manual', { week: 1, day: 0, roster: board.slice(0, 10).map(p => ({ id: p.id })), opponent: board.slice(4, 14).map(p => p.id) });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
      assert.strictEqual(ok.json.source, 'manual');
      assert.strictEqual(ok.json.slots.length, 6);
      assert(ok.json.matchup);
      const ids = await call(server, 'POST', '/api/nba/lineup/manual', { week: 1, ids: ['100', '101', 'nope'] });
      assert.strictEqual(ids.status, 200);
      assert.deepStrictEqual(ids.json.unmatched.map(u => u.id), ['nope']);
      for (const bad of [{ roster: [{ id: '100' }] }, { week: 1 }, { week: 1, roster: [{ id: '<script>' }] }, { week: 1, roster: Array.from({ length: 21 }, (_, i) => ({ id: String(i) })) }, { week: 1, roster: [{ id: '100', banked: -5 }] }, { week: 1, day: 99, roster: [{ id: '100' }] }]) {
        assert.strictEqual((await call(server, 'POST', '/api/nba/lineup/manual', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
      }
      assert.strictEqual((await call(server, 'POST', '/api/nba/lineup/manual', '{bad json')).status, 400);
      const big = await call(server, 'POST', '/api/nba/lineup/manual', JSON.stringify({ week: 1, roster: [{ id: '100' }], pad: 'x'.repeat(10000) }));
      assert.strictEqual(big.status, 413);
    });
    await test('deny list: /nba/routes/lineup.js is not served', async () => {
      assert.strictEqual((await call(server, 'GET', '/nba/routes/lineup.js')).status, 404);
    });
  } finally { server.close(); }

  await test('manual endpoint is rate-limited per IP (429 + Retry-After)', async () => {
    const app2 = express();
    app2.use(createLineupRoutes({ auth: fakeAuth, getAuth: fakeGetAuth, apiCached, loadModel: () => model, modelPlayers: () => model.getPlayers(), clientFor: fakeClient, sendYahooError: () => {}, log: { error() {} }, rate: { windowMs: 60000, max: 3 } }));
    const s = await listen(app2);
    try {
      const body = { week: 1, ids: ['100'] };
      for (let i = 0; i < 3; i++) assert.strictEqual((await call(s, 'POST', '/api/nba/lineup/manual', body)).status, 200);
      const { port } = s.address();
      const r = await fetch(`http://127.0.0.1:${port}/api/nba/lineup/manual`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.strictEqual(r.status, 429);
      assert(Number(r.headers.get('retry-after')) > 0);
    } finally { s.close(); }
  });

  await test('weekClock: day index from ET date; getOpponentKey ignores other leagues', async () => {
    const c = createLineupRoutes.weekClock(['2026-10-26', '2026-11-01'], new Date('2026-10-29T18:00:00Z'));
    assert.deepStrictEqual(c, { weekLength: 7, day: 3 });
    assert.deepStrictEqual(createLineupRoutes.weekClock(['2026-10-20', '2026-10-25'], new Date('2026-10-01T00:00:00Z')), { weekLength: 6, day: 0 });
    const k = await createLineupRoutes.getOpponentKey({ request: async () => ({ a: { team_key: '466.l.9.t.3' }, b: [{ team_key: '466.l.1.t.1' }, { team_key: '466.l.1.t.4' }] }) }, '466.l.1.t.1', 1);
    assert.strictEqual(k, '466.l.1.t.4');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
})();
