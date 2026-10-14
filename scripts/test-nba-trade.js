#!/usr/bin/env node
/* Tests for the NBA trade calculator: nba/model/trade.js, nba/routes/trade.js,
   nba/pages/trade-logic.js. Offline (NBA_MODEL_OFFLINE=1), no framework.
   Run: node scripts/test-nba-trade.js   (exit 0 = all pass) */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const path = require('path');
const http = require('http');
const express = require('express');
const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'nba', 'model', 'trade.js'));
const createTradeRoutes = require(path.join(ROOT, 'nba', 'routes', 'trade.js'));
const L = require(path.join(ROOT, 'nba', 'pages', 'trade-logic.js'));

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error((msg ? msg + ': ' : '') + 'expected ' + B + ', got ' + A);
}
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg || 'near'}: ${a} vs ${b} (tol ${tol})`); }

/* ------------------------------------------------------------ fixtures */
const WEEKS = 20;
// P(id, 'G'|'F'|'GF', perWeek value or fn(w), opts)
function P(id, el, v, o = {}) {
  const elig = (el === 'GF' ? ['G', 'F'] : [el]).concat('UTIL');
  const hsByWeek = {}, gamesByWeek = {};
  for (let w = 1; w <= WEEKS; w++) {
    gamesByWeek[w] = o.games ? o.games(w) : 3;
    hsByWeek[w] = typeof v === 'function' ? v(w) : v;
  }
  const vals = Object.values(hsByWeek);
  return {
    id: String(id), name: o.name || 'P' + id, team: 'T' + (id % 30), pos: [], elig, injury: o.injury || null,
    outForSeason: !!o.ofs, hsByWeek, gamesByWeek, hsValue: vals.reduce((a, b) => a + b, 0) / vals.length,
    mean: 40, sd: 10, games: 3, rank: 0, source: o.source || 'logs', sampleGames: o.sampleGames == null ? 60 : o.sampleGames,
  };
}
// A deterministic 200-player league pool: values 70 → ~20.
function pool(n = 200) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(P(1000 + i, ['G', 'F', 'GF', 'F'][i % 4], Math.round((70 - i * 0.25) * 10) / 10));
  out.forEach((p, i) => { p.rank = i + 1; });
  return out;
}
const base = pool();
const byId = id => base.find(p => p.id === String(id));
const ids = arr => arr.map(p => p.id);

/* ------------------------------------------------------------ lineup */
t('bestLineup is exact (random rosters vs brute force)', () => {
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let k = 0; k < 150; k++) {
    const n = 4 + Math.floor(rnd() * 8);
    const items = [];
    for (let i = 0; i < n; i++) { const r = rnd(); items.push({ id: 'x' + i, G: r < 0.6, F: r > 0.35, v: Math.round(rnd() * 600) / 10 }); }
    const got = T.bestLineup(items).total;
    // brute force: every item → bench/G/F/UTIL
    let best = 0;
    const rec = (i, g, f, u, sum) => {
      if (i === n) { best = Math.max(best, sum); return; }
      const it = items[i];
      rec(i + 1, g, f, u, sum);
      if (it.G && g < 2) rec(i + 1, g + 1, f, u, sum + it.v);
      if (it.F && f < 3) rec(i + 1, g, f + 1, u, sum + it.v);
      if (u < 1) rec(i + 1, g, f, u + 1, sum + it.v);
    };
    rec(0, 0, 0, 0, 0);
    near(got, best, 1e-6, 'case ' + k);
  }
});

t('dual-eligible player moves so a pure G can start', () => {
  const r = T.bestLineup([
    { id: 'gf', G: true, F: true, v: 50 }, { id: 'g1', G: true, F: false, v: 45 }, { id: 'g2', G: true, F: false, v: 44 },
    { id: 'f1', G: false, F: true, v: 30 }, { id: 'f2', G: false, F: true, v: 29 },
  ]);
  near(r.total, 198, 1e-9);
  eq(r.slotOf.get('gf'), 'F');
});

/* ------------------------------------------------------------ evaluate */
// Two 10-man rosters from the pool (snake slots 1 and 6).
function snake(slot, teams = 10, rounds = 10) {
  const out = [];
  for (let r = 1; r <= rounds; r++) out.push(base[(r % 2 ? (r - 1) * teams + slot : r * teams - slot + 1) - 1]);
  return out;
}
const A = snake(1), B = snake(6);
const leagueRostered = [];
for (let s = 1; s <= 10; s++) leagueRostered.push(...ids(snake(s)));
const ev = o => T.evaluateTrade({ players: base, currentWeek: 1, leagueRostered, ...o });

t('symmetry: swapping perspectives swaps you/them; reversing the trade negates your delta', () => {
  const give = [A[1].id], get = [B[0].id];
  const r = ev({ myRoster: ids(A), partnerRoster: ids(B), give, get });
  const s = ev({ myRoster: ids(B), partnerRoster: ids(A), give: get, get: give });
  near(r.you.ros, s.them.ros, 0.11, 'you ↔ them');
  near(r.them.ros, s.you.ros, 0.11, 'them ↔ you');
  const A2 = ids(A).filter(id => id !== give[0]).concat(get), B2 = ids(B).filter(id => id !== get[0]).concat(give);
  const back = ev({ myRoster: A2, partnerRoster: B2, give: get, get: give });
  near(back.you.ros, -r.you.ros, 0.11, 'reverse negates');
  near(back.them.ros, -r.them.ros, 0.11, 'reverse negates (them)');
  const empty = ev({ myRoster: ids(A), partnerRoster: ids(B), give: [], get: [] });
  eq(empty.you.ros, 0); eq(empty.verdict, null);
});

t('positional surplus: a 5th great F is worth little to a team full of Fs, a lot to a team with an F hole', () => {
  // Team full of forwards: F1-3 + UTIL taken by 60s; guards at 45.
  const deep = [P(1, 'F', 62), P(2, 'F', 61), P(3, 'F', 60), P(4, 'F', 59), P(5, 'G', 45), P(6, 'G', 44), P(7, 'G', 30), P(8, 'F', 25), P(9, 'G', 24), P(10, 'F', 23)];
  const hole = [P(11, 'G', 62), P(12, 'G', 61), P(13, 'G', 60), P(14, 'F', 45), P(15, 'F', 30), P(16, 'G', 29), P(17, 'G', 25), P(18, 'G', 24), P(19, 'G', 23), P(20, 'G', 22)];
  const star = P(21, 'F', 58, { name: 'Big' });
  const partner = [star, P(22, 'G', 46), P(23, 'G', 43), P(24, 'F', 40), P(25, 'F', 38), P(26, 'G', 35), P(27, 'F', 33), P(28, 'G', 31), P(29, 'F', 28), P(30, 'G', 26)];
  const players = [...deep, ...hole, ...partner, ...pool(150)];
  const run = (mine, giveId) => T.evaluateTrade({ players, currentWeek: 1, myRoster: ids(mine), partnerRoster: ids(partner), give: [giveId], get: [star.id] });
  const rDeep = run(deep, '5');   // give a 45 G for a 58 F
  const rHole = run(hole, '13');  // give a 60 G (3rd guard → UTIL) for a 58 F
  const bigDeep = rDeep.players.find(p => p.id === star.id);
  ok(bigDeep.forYou < 0.35 * bigDeep.rosValue, `surplus forYou ${bigDeep.forYou} vs raw ${bigDeep.rosValue}`);
  ok(rDeep.you.perWeek < 0, 'raw +13 but lineup delta negative: ' + rDeep.you.perWeek);
  eq(rDeep.verdict, 'Decline');
  ok(rHole.you.perWeek > 5, 'hole team gains: ' + rHole.you.perWeek);
  eq(rHole.verdict, 'Accept');
  ok(rHole.why.some(w => /fills your F\d hole/.test(w)), 'hole bullet: ' + rHole.why.join(' | '));
  ok(rHole.lineup.changed.length >= 1);
});

t('2-for-1: receiving two forces a drop; giving two frees a spot filled at replacement', () => {
  const give = [A[0].id], get = [B[2].id, B[3].id];
  const r = ev({ myRoster: ids(A), partnerRoster: ids(B), give, get });
  eq(r.roster.you.dropped.length, 1, 'one drop');
  const naive = byId(get[0]).hsValue + byId(get[1]).hsValue - byId(give[0]).hsValue;
  ok(r.you.perWeek < naive, `lineup delta ${r.you.perWeek} < naive points sum ${naive}`);
  ok(/must drop/.test(r.consolidation), r.consolidation);
  eq(r.roster.them.openAfter, 1, 'partner gets an open spot');
  ok(r.them.perWeek > -(byId(get[0]).hsValue + byId(get[1]).hsValue - byId(give[0]).hsValue), 'partner keeps replacement value');
  // Same 2-for-1 seen from the partner's side: frees a spot.
  const s = ev({ myRoster: ids(B), partnerRoster: ids(A), give: get, get: give });
  ok(/frees 1 roster spot/.test(s.consolidation), s.consolidation);
  // With an open spot already, no drop.
  const r9 = ev({ myRoster: ids(A).slice(0, 9).concat([]), partnerRoster: ids(B), give: [A[0].id], get });
  eq(r9.roster.you.dropped.length, 0);
  ok(/open roster spot/.test(r9.consolidation), r9.consolidation);
});

t('determinism: identical output for identical input and for shuffled roster order', () => {
  const o = { myRoster: ids(A), partnerRoster: ids(B), give: [A[2].id, A[5].id], get: [B[1].id] };
  const a = JSON.stringify(ev(o)), b = JSON.stringify(ev(o));
  eq(a === b, true);
  const sh = JSON.stringify(ev({ ...o, myRoster: ids(A).reverse(), partnerRoster: ids(B).reverse() }));
  eq(JSON.parse(sh).you, JSON.parse(a).you);
  eq(JSON.parse(sh).them, JSON.parse(a).them);
});

t('injured star: value follows the return ramp; late in the season he is worth ~0', () => {
  const star = P(900, 'F', w => (w <= 12 ? 0 : 72), { name: 'Hurt Star', injury: 'OUT' });
  const players = [...base, star];
  const partner = ids(B).slice(0, 9).concat(star.id);
  const early = T.evaluateTrade({ players, currentWeek: 1, myRoster: ids(A), partnerRoster: partner, give: [A[3].id], get: [star.id], leagueRostered });
  const late = T.evaluateTrade({ players, currentWeek: 11, myRoster: ids(A), partnerRoster: partner, give: [A[3].id], get: [star.id], leagueRostered, settings: { endWeek: 12 } });
  ok(late.you.perWeek < 0, 'season ends before he returns → negative: ' + late.you.perWeek);
  eq(late.verdict, 'Decline');
  ok(early.you.perWeek > late.you.perWeek, 'early > late');
  const sp = early.players.find(p => p.id === star.id);
  eq(sp.nowValue, 0);
  ok(early.why.some(w => /Hurt Star \(OUT\)/.test(w)), early.why.join(' | '));
  ok(sp.uncertainty > early.players.find(p => p.id === A[3].id).uncertainty, 'injured → wider');
  const ofs = P(901, 'F', 0, { name: 'Gone', ofs: true, injury: 'Out' });
  const r = T.evaluateTrade({ players: [...base, ofs], currentWeek: 1, myRoster: ids(A), give: [A[9].id], get: [ofs.id] });
  ok(r.why.some(w => /out for the season/.test(w)));
  ok(r.you.perWeek <= 0);
});

t('schedule: playoff weeks weigh more only when the league gives them', () => {
  const heavyLate = P(950, 'F', w => (w >= 18 ? 60 : 40), { games: w => (w >= 18 ? 4 : 2) });
  const flat = P(951, 'F', 41);
  const players = [...base, heavyLate, flat];
  const mine = ids(A).slice(0, 9).concat(flat.id);
  const partner = ids(B).slice(0, 9).concat(heavyLate.id);
  const o = { players, currentWeek: 1, myRoster: mine, partnerRoster: partner, give: [flat.id], get: [heavyLate.id], leagueRostered };
  const plain = T.evaluateTrade(o);
  const po = T.evaluateTrade({ ...o, settings: { playoffStartWeek: 18 } });
  eq(plain.meta.playoffWeight, 1);
  eq(po.meta.playoffWeight, 1.5);
  ok(po.you.perWeek > plain.you.perWeek, `${po.you.perWeek} > ${plain.you.perWeek}`);
  ok(po.weeks.filter(w => w.playoff).every(w => w.weight === 1.5));
  ok(po.why.some(w => /Playoff weeks/.test(w)), po.why.join(' | '));
});

t('replacement level: league rosters vs percentile', () => {
  const st = T.normSettings({});
  const weeks = T.scheduleWeeks(base, 1, st);
  const lg = T.replacementLevel(base, weeks, st, new Set(leagueRostered));
  const pc = T.replacementLevel(base, weeks, st, null);
  eq(lg.source, 'league'); eq(pc.source, 'percentile');
  // 100 rostered = pool[0..99]; 3rd best FA = pool[102] = 70 − 102·0.25 = 44.5 → ×0.9
  near(lg.perWeek[1], 0.9 * 44.5, 0.06);
  near(pc.perWeek[1], 0.9 * 44.5, 0.06);
});

t('partner estimated when their roster is unknown; ranges contain the point estimate', () => {
  const r = ev({ myRoster: ids(A), give: [A[1].id], get: [B[0].id] });
  eq(r.them.estimated, true);
  for (const s of [r.you, r.them]) {
    ok(s.perWeekRange[0] <= s.perWeek && s.perWeek <= s.perWeekRange[1], JSON.stringify(s));
    ok(s.rosRange[0] <= s.ros && s.ros <= s.rosRange[1]);
  }
  ok(['likely', 'maybe', 'unlikely'].includes(r.them.likely));
  ok(['Accept', 'Counter', 'Decline'].includes(r.verdict));
  ok(typeof r.headline === 'string' && r.headline.length > 10);
});

t('verdict bands: lopsided win → Accept / unlikely, wash → Counter', () => {
  const win = ev({ myRoster: ids(A), partnerRoster: ids(B), give: [A[9].id], get: [B[0].id] });
  eq(win.verdict, 'Accept'); eq(win.them.likely, 'unlikely');
  const lose = ev({ myRoster: ids(A), partnerRoster: ids(B), give: [A[0].id], get: [B[9].id] });
  // Checker E: a 1st-rounder for a 10th-rounder used to read 'Counter' because they gain big.
  eq(lose.verdict, 'Decline', 'lopsided loss is a Decline however much they gain');
  ok(lose.you.perWeek <= -3 * lose.meta.fairBand, 'the loss really is beyond 3 bands');
  const giveAway = ev({ myRoster: ids(A), partnerRoster: ids(B), give: [A[0].id], get: [] });
  eq(giveAway.verdict, 'Decline', 'giving a starter for nothing');
  // boundaries (band 2.5): wash, modest loss they profit from, big loss, loss nobody gains from
  eq(T.verdictFor(2.5, -2.5, 2.5), 'Accept'); eq(T.verdictFor(2.4, 0, 2.5), 'Counter');
  eq(T.verdictFor(-5, 5, 2.5), 'Counter'); eq(T.verdictFor(-5, 1, 2.5), 'Decline');
  eq(T.verdictFor(-7.5, 30, 2.5), 'Decline'); eq(T.verdictFor(-7.4, 7.4, 2.5), 'Counter');
  // two near-identical F starters swapped
  const x = P(960, 'F', 50), y = P(961, 'F', 50.1);
  const wash = T.evaluateTrade({ players: [...base, x, y], currentWeek: 1, myRoster: ids(A).slice(0, 9).concat(x.id), partnerRoster: ids(B).slice(0, 9).concat(y.id), give: [x.id], get: [y.id] });
  eq(wash.verdict, 'Counter');
});

t('no-NaN fuzz: garbage values, unknown ids, odd rosters', () => {
  let s = 99;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const junk = [NaN, undefined, null, -5, Infinity, '12', 0];
  for (let k = 0; k < 60; k++) {
    const players = pool(60).map((p, i) => {
      if (rnd() < 0.15) p.hsByWeek[1 + (i % WEEKS)] = junk[i % junk.length];
      if (rnd() < 0.05) delete p.hsByWeek;
      if (rnd() < 0.05) p.elig = [];
      if (rnd() < 0.05) p.gamesByWeek = null;
      return p;
    });
    const pick = n => Array.from({ length: n }, () => players[Math.floor(rnd() * players.length)].id);
    const r = T.evaluateTrade({
      players, currentWeek: Math.floor(rnd() * 25), myRoster: pick(Math.floor(rnd() * 14)), partnerRoster: rnd() < 0.5 ? pick(Math.floor(rnd() * 14)) : undefined,
      give: pick(Math.floor(rnd() * 4)).concat(rnd() < 0.2 ? ['nope'] : []), get: pick(Math.floor(rnd() * 4)),
      settings: rnd() < 0.3 ? { teams: 'x', rosterSize: -3, playoffStartWeek: 'abc', slots: { G: 9 } } : {},
      leagueRostered: rnd() < 0.5 ? pick(40) : undefined,
    });
    const bad = [];
    (function walk(v, p) {
      if (typeof v === 'number' && !Number.isFinite(v)) bad.push(p);
      else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, p + '.' + kk);
    })(r, 'r');
    eq(bad, [], 'case ' + k);
    ok(!/NaN|Infinity/.test(JSON.stringify(r)), 'stringified');
  }
});

t('real board (offline snapshot): evaluates fast with sane output', async () => {
  let board;
  try { board = await require(path.join(ROOT, 'nba', 'model')).getPlayers({}); } catch (e) { console.log('       (skipped: ' + e.message + ')'); return; }
  const P2 = board.players;
  const mine = P2.filter((p, i) => i % 10 === 0).slice(0, 10).map(p => p.id);
  const theirs = P2.filter((p, i) => i % 10 === 5).slice(0, 10).map(p => p.id);
  const t0 = Date.now();
  const r = T.evaluateTrade({ players: P2, currentWeek: board.currentWeek, myRoster: mine, partnerRoster: theirs, give: [mine[1]], get: [theirs[0], theirs[4]], settings: { playoffStartWeek: 22 } });
  const ms = Date.now() - t0;
  ok(ms < 1000, 'took ' + ms + 'ms');
  ok(r.verdict && r.why.length >= 2);
  ok(!/NaN/.test(JSON.stringify(r)));
  eq(r.lineup.after.starters.length, 6);
});

/* ------------------------------------------------------------ trade-logic (UI) */
t('trade-logic: toggle, request body, formatting, persistence', () => {
  let st = L.emptyState();
  st = L.toggle(st, 'give', '1'); st = L.toggle(st, 'get', '2'); st = L.toggle(st, 'give', '1');
  eq(st.give, []); eq(st.get, ['2']);
  st = L.toggle(st, 'give', '3'); st = L.toggle(st, 'get', '3');
  eq(st.give, [], 'a player is on one side only'); eq(st.get, ['2', '3']);
  st.myRoster = ['3', '9'];
  const body = L.requestBody(st);
  eq(body.get, ['2', '3']); eq(body.myRoster, ['3', '9']);
  ok(!('partnerRoster' in body), 'manual: no partner roster');
  eq(L.signed(3.25), '+3.3'); eq(L.signed(-2), '−2.0'); eq(L.signed(0), '0.0');
  eq(L.verdictTone('Accept'), 'good'); eq(L.verdictTone('Decline'), 'bad');
  const back = L.parseState(L.serialize(st));
  eq(back.get, st.get);
  eq(L.parseState('garbage').give, []);
  eq(L.search([{ id: '1', name: 'Nikola Jokić' }, { id: '2', name: 'Luka Dončić' }], 'jokic').map(p => p.id), ['1']);
  ok(L.canEvaluate({ give: ['1'], get: [] }) && !L.canEvaluate({ give: [], get: [] }));
});

/* ------------------------------------------------------------ routes */
function fakeYahoo(state) {
  // 4 teams × 10 players from the pool; team 1 is mine; one unmatched Yahoo player.
  const teams = [1, 2, 3, 4].map(n => ({ team_key: `466.l.77.t.${n}`, name: 'Team ' + n, is_owned_by_current_login: n === 1 }));
  const rosterOf = tk => {
    const n = Number(tk.split('.t.')[1]);
    const players = snake(n, 4, 10).map(p => ({ player_key: '466.p.' + p.id, name: { full: p.name }, selected_position: 'BN' }));
    if (n === 2) players.push({ player_key: '466.p.1', name: { full: 'Mystery Man' }, selected_position: 'IL' });
    return { team: {}, players };
  };
  return () => ({
    async getLeague() {
      if (state.fail) { const e = new Error('nc'); e.code = 'not_connected'; throw e; }
      return { league_key: '466.l.77', name: 'Test League', num_teams: 4, current_week: 1, end_week: 20, settings: { uses_playoff: true, playoff_start_week: 18 },
        roster_positions: [{ position: 'G', count: 2 }, { position: 'F', count: 3 }, { position: 'Util', count: 1 }, { position: 'BN', count: 4 }, { position: 'IL', count: 2 }] };
    },
    async getTeams() { return teams; },
    async getRoster(tk) { state.rosterCalls = (state.rosterCalls || 0) + 1; return rosterOf(tk); },
    async getPlayersByKeys(lk, keys) { return keys.map(k => ({ player_key: k, name: { full: (byId(k.split('.p.')[1]) || {}).name || 'Nobody' } })); },
  });
}

function makeApp({ rateLimit, state = {} } = {}) {
  const app = express();
  const cache = new Map();
  const { YahooError } = require(path.join(ROOT, 'nba', 'yahoo', 'client.js'));
  const deps = {
    auth: (req, res, next) => (req.get('x-user') ? next() : res.status(401).json({ error: 'Unauthorized' })),
    getAuth: req => ({ userId: req.get('x-user') || null }),
    apiCached: async (k, ttl, fn) => { if (!cache.has(k)) cache.set(k, await fn()); return cache.get(k); },
    modelPlayers: async () => ({ season: 2026, week: null, currentWeek: 1, asOf: 'x', players: base }),
    matcher: async () => yp => { const p = base.find(x => x.name === yp.name.full); return p ? { sleeperId: p.id, matchConfidence: 0.95 } : { sleeperId: null, matchConfidence: 0 }; },
    clientFor: fakeYahoo(state),
    sendYahooError: (res, err) => (err.code === 'not_connected' ? res.status(409).json({ code: 'yahoo_not_connected' }) : res.status(502).json({ error: 'Yahoo request failed' })),
    log: { error() {}, warn() {} },
    env: {},
  };
  if (rateLimit) deps.rateLimit = rateLimit;
  app.use(createTradeRoutes(deps));
  void YahooError;
  return app;
}

function listen(app) {
  return new Promise(res => { const s = http.createServer(app).listen(0, '127.0.0.1', () => res(s)); });
}
async function call(server, method, url, { body, headers = {}, raw } = {}) {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, headers: { ...(body !== undefined || raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw != null ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* html */ }
  return { status: r.status, json, headers: r.headers };
}

t('route: POST evaluate (manual, Sleeper ids) → verdict', async () => {
  const s = await listen(makeApp());
  try {
    const r = await call(s, 'POST', '/api/nba/trade/evaluate', { body: { myRoster: ids(A), partnerRoster: ids(B), give: [A[1].id], get: [B[0].id], leagueRostered } });
    eq(r.status, 200);
    ok(['Accept', 'Counter', 'Decline'].includes(r.json.verdict));
    eq(r.json.warnings, []);
    const u = await call(s, 'POST', '/api/nba/trade/evaluate', { body: { myRoster: ids(A), give: [A[1].id], get: ['77777'] } });
    eq(u.status, 200); ok(/not found/.test(u.json.warnings[0]));
  } finally { s.close(); }
});

t('route: validation, size limit, bad JSON', async () => {
  const s = await listen(makeApp());
  try {
    eq((await call(s, 'POST', '/api/nba/trade/evaluate', { body: { give: [], get: [] } })).status, 400);
    eq((await call(s, 'POST', '/api/nba/trade/evaluate', { body: { give: 'x', get: [] } })).status, 400);
    eq((await call(s, 'POST', '/api/nba/trade/evaluate', { body: { give: ['../etc'], get: [] } })).status, 400);
    eq((await call(s, 'POST', '/api/nba/trade/evaluate', { body: { give: ids(A).slice(0, 7), get: [] } })).status, 400);
    eq((await call(s, 'POST', '/api/nba/trade/evaluate', { body: { give: ['1'], league_key: 'nope' } })).status, 400);
    eq((await call(s, 'POST', '/api/nba/trade/evaluate', { raw: '{"give":' })).status, 400);
    eq((await call(s, 'POST', '/api/nba/trade/evaluate', { body: [1, 2] })).status, 400);
    const big = await call(s, 'POST', '/api/nba/trade/evaluate', { body: { give: ['1'], pad: 'x'.repeat(20000) } });
    eq(big.status, 413);
  } finally { s.close(); }
});

t('route: rate limit → 429 with Retry-After', async () => {
  const s = await listen(makeApp({ rateLimit: createTradeRoutes.createRateLimit({ max: 3 }) }));
  try {
    const body = { myRoster: ids(A), give: [A[1].id], get: [B[0].id] };
    for (let i = 0; i < 3; i++) eq((await call(s, 'POST', '/api/nba/trade/evaluate', { body })).status, 200);
    const r = await call(s, 'POST', '/api/nba/trade/evaluate', { body });
    eq(r.status, 429); ok(Number(r.headers.get('retry-after')) > 0);
  } finally { s.close(); }
});

t('route: Yahoo player_keys need a signed-in league; with one they resolve and league settings apply', async () => {
  const state = {};
  const s = await listen(makeApp({ state }));
  try {
    const keys = { give: ['466.p.' + A[1].id], get: ['466.p.' + B[0].id], myRoster: ids(A).map(id => '466.p.' + id) };
    const anon = await call(s, 'POST', '/api/nba/trade/evaluate', { body: keys });
    eq(anon.status, 400); eq(anon.json.code, 'player_keys_need_yahoo');
    const r = await call(s, 'POST', '/api/nba/trade/evaluate', { body: { ...keys, league_key: '466.l.77' }, headers: { 'x-user': 'u1' } });
    eq(r.status, 200);
    eq(r.json.meta.playoffStartWeek, 18);
    eq(r.json.meta.settings.teams, 4);
    eq(r.json.replacement.source, 'league');
    eq(r.json.meta.unknown, []);
    ok(r.json.players.some(p => p.id === A[1].id && p.side === 'give'));
    // Sleeper ids + league_key, Yahoo down → still answers with a warning.
    const st2 = { fail: true };
    const s2 = await listen(makeApp({ state: st2 }));
    try {
      const w = await call(s2, 'POST', '/api/nba/trade/evaluate', { body: { myRoster: ids(A), give: [A[1].id], get: [B[0].id], league_key: '466.l.77' }, headers: { 'x-user': 'u1' } });
      eq(w.status, 200); ok(/Yahoo league unavailable/.test(w.json.warnings[0]));
    } finally { s2.close(); }
  } finally { s.close(); }
});

t('route: GET context needs auth, returns normalized rosters + unmatched, caches', async () => {
  const state = {};
  const s = await listen(makeApp({ state }));
  try {
    eq((await call(s, 'GET', '/api/nba/trade/context?league_key=466.l.77')).status, 401);
    eq((await call(s, 'GET', '/api/nba/trade/context?league_key=bad', { headers: { 'x-user': 'u1' } })).status, 400);
    eq((await call(s, 'GET', '/api/nba/trade/context?league_key=466.l.77&team_key=466.l.78.t.1', { headers: { 'x-user': 'u1' } })).status, 400);
    const r = await call(s, 'GET', '/api/nba/trade/context?league_key=466.l.77', { headers: { 'x-user': 'u1' } });
    eq(r.status, 200);
    eq(r.json.myTeamKey, '466.l.77.t.1');
    eq(r.json.teams.length, 4);
    eq(r.json.teams[0].players[0].sleeperId, snake(1, 4, 10)[0].id);
    eq(r.json.unmatched, [{ team_key: '466.l.77.t.2', player_key: '466.p.1', name: 'Mystery Man' }]);
    eq(r.json.league.settings, { teams: 4, slots: { G: 2, F: 3, UTIL: 1 }, rosterSize: 10 });
    eq(r.json.league.playoff_start_week, 18);
    const r2 = await call(s, 'GET', '/api/nba/trade/context?league_key=466.l.77&team_key=466.l.77.t.3', { headers: { 'x-user': 'u1' } });
    eq(r2.json.myTeamKey, '466.l.77.t.3');
    eq(state.rosterCalls, 4, 'cached');
    eq((await call(s, 'GET', '/api/nba/trade/context?league_key=466.l.77&team_key=466.l.77.t.9', { headers: { 'x-user': 'u1' } })).status, 404);
    const st2 = { fail: true };
    const s2 = await listen(makeApp({ state: st2 }));
    try { eq((await call(s2, 'GET', '/api/nba/trade/context?league_key=466.l.77', { headers: { 'x-user': 'u1' } })).status, 409); } finally { s2.close(); }
  } finally { s.close(); }
});

t('route: mounted through nba/router (one line) — page + evaluate', async () => {
  const createNbaRouter = require(path.join(ROOT, 'nba', 'router.js'));
  const app = express();
  app.use('/', createNbaRouter({
    auth: (req, res, next) => res.status(401).end(), getAuth: () => ({}),
    apiCached: async (k, ttl, fn) => fn(), env: {},
    loadModel: () => ({ getPlayers: async () => ({ season: 2026, week: null, currentWeek: 1, asOf: 'x', players: base }), matchYahooPlayer: () => null }),
    store: { get: async () => null, save: async () => {}, remove: async () => {} },
    log: { error() {}, warn() {} },
  }));
  const s = await listen(app);
  try {
    const page = await fetch(`http://127.0.0.1:${s.address().port}/nba/trade`);
    eq(page.status, 200);
    ok(/Trade/.test(await page.text()));
    const r = await call(s, 'POST', '/api/nba/trade/evaluate', { body: { myRoster: ids(A), give: [A[1].id], get: [B[0].id] } });
    eq(r.status, 200); ok(r.json.verdict);
    eq((await call(s, 'GET', '/api/nba/trade/context?league_key=466.l.77')).status, 401);
    eq((await fetch(`http://127.0.0.1:${s.address().port}/nba/routes/trade.js`)).status, 404);
  } finally { s.close(); }
});

t('rosterShape: Yahoo positions → slots', () => {
  eq(createTradeRoutes.rosterShape([{ position: 'PG', count: 1 }, { position: 'SG', count: 1 }, { position: 'C', count: 1 }, { position: 'Util', count: 2 }, { position: 'BN', count: 3 }, { position: 'IL+', count: 1 }]),
    { slots: { G: 2, F: 1, UTIL: 2 }, rosterSize: 8 });
  eq(createTradeRoutes.rosterShape([]), null);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
