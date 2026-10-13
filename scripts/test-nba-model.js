#!/usr/bin/env node
// Tests + no-hindsight backtest for nba/model. Offline (committed snapshot only).
//   node scripts/test-nba-model.js          # unit tests + sanity + backtest report, exit 0 on pass
//   node scripts/test-nba-model.js --tune   # also grid-search fit params on the backtest
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../nba/model');
const St = require('../nba/model/stats');
const Fit = require('../nba/model/fit');
const { epochDay } = require('../nba/model/sleeper');
const { availability, HEALTHY_FLOOR } = require('../nba/model/board');

const DATA = path.join(__dirname, '..', 'data', 'nba');
const readData = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL ${name}\n  ${err.message}`); process.exitCode = 1; }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b} (±${eps})`);

// ───────────────────────── expectedMax ─────────────────────────
test('expectedMax: empirical exact order statistic', () => {
  near(M.expectedMax([10, 20, 30], 1), 20, 1e-9);
  // max of 2 draws from {10,20,30}: P(max=10)=1/9, 20: 3/9, 30: 5/9 → 220/9
  near(M.expectedMax([30, 10, 20], 2), 220 / 9, 1e-9);
  near(M.expectedMax([42], 4), 42, 1e-9);
  assert.strictEqual(M.expectedMax([10, 20], 0), 0);
  assert.strictEqual(M.expectedMax([], 3), 0);
});
test('expectedMax: normal matches known order-statistic constants', () => {
  const e = [0, 0, 0.5642, 0.8463, 1.0294, 1.1630];
  for (let n = 1; n <= 5; n++) near(M.expectedMax({ mean: 0, sd: 1 }, n), e[n], 2e-3, `e_${n}`);
  near(M.expectedMax({ mean: 50, sd: 10 }, 3), 50 + 8.463, 0.02);
  assert.strictEqual(M.expectedMax({ mean: 40, sd: 0 }, 4), 40);
});
test('expectedMax: monotone in n, and 4 games > 2 games for identical player', () => {
  const xs = [31, 44, 52, 38, 61, 47, 55, 29, 49, 58];
  let prev = 0;
  for (let n = 1; n <= 5; n++) { const v = M.expectedMax(xs, n); assert.ok(v > prev); prev = v; }
  const fit = Fit.fitLogs(xs.map((x, i) => [20000 + i, 1, x, 34]), { asOfDay: 20011 });
  const em = k => fit.emax[k];
  assert.ok(St.expectedMaxAvail(em, 4, 0.95) > St.expectedMaxAvail(em, 2, 0.95) + 3, '4-game > 2-game');
  assert.strictEqual(St.expectedMaxAvail(em, 0, 0.95), 0);
});
test('expectedMax: exact mixture integration agrees with seeded Monte-Carlo', () => {
  const rng = St.seededRng(42);
  const samples = Array.from({ length: 40 }, () => 30 + 25 * rng());
  const weights = samples.map((_, i) => Math.pow(0.5, (40 - i) / 20));
  const dist = { samples, weights, bw: 3 };
  const wsum = weights.reduce((a, b) => a + b, 0);
  const draw = () => {
    let u = rng() * wsum, i = 0;
    while (u > weights[i]) u -= weights[i++];
    // Box–Muller kernel noise
    const z = Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
    return samples[Math.min(i, samples.length - 1)] + 3 * z;
  };
  for (const n of [1, 3, 5]) {
    let s = 0;
    const T = 40000;
    for (let t = 0; t < T; t++) { let m = -Infinity; for (let k = 0; k < n; k++) m = Math.max(m, draw()); s += m; }
    near(M.expectedMax(dist, n), s / T, 0.25, `mixture n=${n}`);
  }
});

test('mergeLogs: re-fetched weeks replace cached weeks', () => {
  const S = require('../nba/model/sleeper');
  const row = (pid, w, date, team, opp, sp, pts) => ({ player_id: pid, game_id: `${team}${date}`, week: w, date, team, opponent: opp, stats: sp ? { sp, pts } : {} });
  const wk1 = [row('1', 1, '2026-10-21', 'DEN', 'GSW', 2000, 30), row('2', 1, '2026-10-21', 'GSW', 'DEN', 0)];
  const wk2a = [row('1', 2, '2026-10-28', 'DEN', 'LAL', 1800, 10)];            // in-progress snapshot
  const wk2b = [row('1', 2, '2026-10-28', 'DEN', 'LAL', 2100, 25), row('1', 2, '2026-10-30', 'DEN', 'PHX', 0)];
  const cached = S.compactLogs(2026, { 1: wk1, 2: wk2a });
  const merged = S.mergeLogs(cached, S.compactLogs(2026, { 2: wk2b }));
  const full = S.compactLogs(2026, { 1: wk1, 2: wk2b });
  assert.deepStrictEqual(merged.players, full.players);
  assert.deepStrictEqual(merged.teamGames, full.teamGames);
  assert.deepStrictEqual(merged.players['1'].g.map(g => g[2]), [30, 25]);
});

// ───────────────────────── names ─────────────────────────
test('normalizeName', () => {
  const cases = [
    ['Nikola Jokić', 'nikola jokic'], ['Luka Dončić', 'luka doncic'], ['Alperen Şengün', 'alperen sengun'],
    ['Kristaps Porziņģis', 'kristaps porzingis'], ['P.J. Washington', 'pj washington'], ['T.J. McConnell', 'tj mcconnell'],
    ["De'Aaron Fox", 'deaaron fox'], ['Shai Gilgeous-Alexander', 'shai gilgeous alexander'],
    ['Jaren Jackson Jr.', 'jaren jackson'], ['Trey Murphy III', 'trey murphy'], ['Marcus Morris Sr.', 'marcus morris'],
    ['Nicolas Claxton', 'nic claxton'], ['Nic Claxton', 'nic claxton'], ['Herb Jones', 'herb jones'], ['Herbert Jones', 'herb jones'],
    ["Nah'Shon Hyland", 'bones hyland'], ['Carlton Carrington', 'bub carrington'], ['Kenyon Martin Jr.', 'kj martin'],
    ['GG Jackson II', 'gg jackson'], ['Gregory Jackson II', 'gg jackson'], ['Patrick Williams', 'patrick williams'],
    ['Dennis Schröder', 'dennis schroder'], ['  OG   Anunoby ', 'og anunoby'], [null, ''],
  ];
  for (const [inp, out] of cases) assert.strictEqual(M.normalizeName(inp), out, `${inp}`);
});

// ───────────────────────── board sanity ─────────────────────────
let board, boardWk;
const perf = {};
(async () => {
  let t = Date.now();
  board = await M.getPlayers({ season: 2026 });
  perf.cold = Date.now() - t;
  t = Date.now();
  for (let i = 0; i < 20; i++) await M.getPlayers({ season: 2026 });
  perf.warm = (Date.now() - t) / 20;
  t = Date.now();
  boardWk = await M.getPlayers({ week: 3 });
  perf.coldWeek = Date.now() - t;
  runBoardTests();
  runMatchTests();
  runDataTests();
  runBacktest();
  console.log(`\nperf: cold build ${perf.cold} ms (incl. snapshot load), week build ${perf.coldWeek} ms, warm ${perf.warm.toFixed(2)} ms`);
  console.log(process.exitCode ? `\nFAILED (${passed} passed)` : `\nOK — ${passed} checks passed`);
})().catch(err => { console.error(err); process.exit(1); });

function runBoardTests() {
  test('getPlayers: contract shape + no NaN', () => {
    for (const b of [board, boardWk]) {
      assert.ok(b.players.length > 400);
      assert.ok(b.asOf);
      for (const p of b.players) {
        for (const k of ['id', 'name', 'team', 'pos', 'elig', 'mean', 'sd', 'games', 'gamesByWeek', 'hsValue', 'hsByWeek', 'ceiling', 'floor', 'rank', 'tier', 'posRank', 'sampleGames', 'source']) {
          assert.ok(k in p, `${p.name} missing ${k}`);
        }
        assert.ok('injury' in p);
        for (const k of ['mean', 'sd', 'games', 'hsValue', 'ceiling', 'floor', 'rank', 'tier', 'posRank', 'sampleGames']) {
          assert.ok(Number.isFinite(p[k]), `${p.name}.${k}=${p[k]}`);
        }
        for (const v of Object.values(p.hsByWeek)) assert.ok(Number.isFinite(v), `${p.name} hsByWeek NaN`);
        assert.ok(['logs', 'projection-only', 'rookie'].includes(p.source));
        assert.ok(p.elig.includes('UTIL'));
        assert.ok(p.floor <= p.mean + 1e-9 && p.mean <= p.ceiling + 1e-9 || p.mean === 0, `${p.name} floor/mean/ceiling order`);
      }
    }
    assert.strictEqual(boardWk.week, 3);
    assert.strictEqual(board.week, null);
  });
  test('getPlayers: Jokic/Luka-tier players top the board', () => {
    const top = board.players.slice(0, 5).map(p => p.name);
    assert.ok(top.includes('Nikola Jokić'), top.join(', '));
    assert.ok(top.includes('Luka Dončić'), top.join(', '));
    assert.strictEqual(board.players[0].tier, 1);
  });
  test('getPlayers: no player with 0 games valued > 0', () => {
    for (const p of [...board.players, ...boardWk.players]) {
      for (const [w, n] of Object.entries(p.gamesByWeek)) if (!n) assert.strictEqual(p.hsByWeek[w], 0, `${p.name} wk${w}`);
      if (!p.games) assert.strictEqual(p.hsValue, 0, p.name);
    }
  });
  test('getPlayers: ranks, posRank, elig', () => {
    board.players.forEach((p, i) => assert.strictEqual(p.rank, i + 1));
    for (let i = 1; i < board.players.length; i++) assert.ok(board.players[i - 1].hsValue >= board.players[i].hsValue);
    const firstG = board.players.find(p => p.elig.includes('G'));
    assert.strictEqual(firstG.posRanks.G, 1);
    const jok = board.players.find(p => p.name === 'Nikola Jokić');
    assert.deepStrictEqual(jok.elig, ['F', 'UTIL']);
    const flagg = board.players.find(p => p.pos.includes('PG') && p.pos.includes('SF'));
    if (flagg) assert.deepStrictEqual(flagg.elig, ['G', 'F', 'UTIL']);
    const tiers = new Set(board.players.map(p => p.tier));
    assert.ok(tiers.size >= 5 && tiers.size <= 25, `tiers ${tiers.size}`);
  });
  test('getPlayers: injury availability rules', () => {
    assert.strictEqual(availability({ outForSeason: true }, 0.9, 0), 0);
    assert.ok(availability({ injury: 'Out' }, 0.9, 0) < 0.2);
    assert.ok(availability({ injury: 'Out' }, 0.9, 4) >= 0.89);
    assert.ok(availability({ injury: 'DTD' }, 0.9, 0) < availability({ injury: null }, 0.9, 0));
    for (const p of board.players) if (p.outForSeason) assert.strictEqual(p.hsValue, 0, p.name);
  });
  test('getPlayers: same player is worth more in a 4-game week than a 2-game week', () => {
    let checked = 0;
    for (const p of board.players.slice(0, 150)) {
      const w4 = Object.keys(p.gamesByWeek).filter(w => p.gamesByWeek[w] === 4);
      const w2 = Object.keys(p.gamesByWeek).filter(w => p.gamesByWeek[w] === 2);
      if (!w4.length || !w2.length || p.outForSeason || p.injury) continue;
      // Compare weeks the same distance out (availability is flat beyond the current week).
      const avg = ws => ws.reduce((s, w) => s + p.hsByWeek[w], 0) / ws.length;
      assert.ok(avg(w4.filter(w => w > 1)) > avg(w2.filter(w => w > 1)), p.name);
      checked++;
    }
    assert.ok(checked > 50, `checked ${checked}`);
  });
  test('perf: warm getPlayers < 300 ms', () => assert.ok(perf.warm < 300, `${perf.warm} ms`));
}

// ───────────────────────── Yahoo matching ─────────────────────────
function runMatchTests() {
  const P = board.players;
  const byName = n => P.find(p => p.name === n);
  const Y = (key, full, team, pos) => ({
    player_key: `466.p.${key}`, player_id: String(key), name: { full, first: full.split(' ')[0], last: full.split(' ').slice(1).join(' ') },
    editorial_team_abbr: team, display_position: pos, eligible_positions: pos.split(',').concat(['Util']),
  });
  // [yahooPlayer, expected Sleeper full_name | null]
  const cases = [
    [Y(5352, 'Nikola Jokić', 'Den', 'C'), 'Nikola Jokić'],
    [Y(6450, 'Luka Dončić', 'LAL', 'PG'), 'Luka Dončić'],
    [Y(6016, 'Shai Gilgeous-Alexander', 'OKC', 'PG,SG'), 'Shai Gilgeous-Alexander'],
    [Y(6160, 'Nicolas Claxton', 'Chi', 'C'), 'Nic Claxton'],
    [Y(6563, 'Herb Jones', 'NO', 'SF,PF'), 'Herbert Jones'],
    [Y(6560, "Nah'Shon Hyland", 'Min', 'PG,SG'), 'Bones Hyland'],
    [Y(6790, 'Carlton Carrington', 'Was', 'PG,SG'), 'Bub Carrington'],
    [Y(6234, 'Kenyon Martin Jr.', 'Min', 'SF,PF'), 'KJ Martin'],
    [Y(6630, 'GG Jackson II', 'Mem', 'SF,PF'), 'GG Jackson'],
    [Y(5826, 'P.J. Washington', 'Dal', 'PF,C'), 'P.J. Washington'],
    [Y(6214, 'Jaren Jackson Jr.', 'Uta', 'PF,C'), 'Jaren Jackson'],
    [Y(6395, 'Alperen Sengun', 'Hou', 'PF,C'), 'Alperen Şengün'],
    [Y(6434, 'Trey Murphy III', 'NO', 'SG,SF'), 'Trey Murphy'],
    [Y(6788, 'Ronald Holland II', 'Det', 'SF,PF'), 'Ronald Holland'],
    [Y(6781, 'Alexandre Sarr', 'Was', 'C'), 'Alex Sarr'],
    [Y(5934, 'Cam Johnson', 'Den', 'SF,PF'), 'Cameron Johnson'],
    [Y(5468, 'Tim Hardaway Jr.', 'Mia', 'SG,SF'), 'Tim Hardaway'],
    [Y(5737, 'OG Anunoby', 'NY', 'SF,PF'), 'OG Anunoby'],
    [Y(6013, "De'Aaron Fox", 'SA', 'PG'), "De'Aaron Fox"],
    [Y(6744, "Kel'el Ware", 'Mil', 'C'), "Kel'el Ware"],
    [Y(4563, 'Dennis Schroder', 'Cha', 'PG,SG'), 'Dennis Schröder'],
    [Y(5642, 'Moe Wagner', 'Bkn', 'C'), 'Moritz Wagner'],
    [Y(6100, 'Joshua Okogie', 'Utah', 'SG,SF'), 'Josh Okogie'],             // fuzzy: first-name prefix + team
    [Y(3704, 'Kevin Durant', 'Pho', 'SF,PF'), 'Kevin Durant'],             // stale Yahoo team, unique name
    [Y(5352, 'Nikola Jokic', 'FA', 'C'), 'Nikola Jokić'],                  // no team, unique name
    [Y(9999, 'John Doe', 'LAL', 'PG'), null],                              // unknown
    [Y(9998, 'Chris Paul', 'LAC', 'PG'), null],                            // not on a Sleeper roster → no guess
    [Y(2156, 'Jalen Smith', 'GS', 'PF,C'), 'Jalen Smith'],                 // unique name, Yahoo team differs → low-confidence match
    [Y(9997, 'J. Johnson', 'FA', 'SF'), null],                             // initial only, no team → below threshold
  ];
  test('matchYahooPlayer: realistic Yahoo examples', () => {
    for (const [yp, expected] of cases) {
      const m = M.matchYahooPlayer(yp, P);
      if (expected === null) { assert.strictEqual(m, null, `${yp.name.full} should not match (got ${m && m.player.name} ${m && m.reason})`); continue; }
      assert.ok(byName(expected), `fixture: ${expected} not on board`);
      assert.ok(m, `${yp.name.full} → null, expected ${expected}`);
      assert.strictEqual(m.player.name, expected, `${yp.name.full} → ${m.player.name} (${m.reason})`);
      assert.ok(m.confidence >= 0.75 && m.confidence <= 1, `${yp.name.full} confidence ${m.confidence}`);
      assert.ok(typeof m.reason === 'string' && m.reason);
    }
    const kd = M.matchYahooPlayer(cases[23][0], P);
    assert.ok(/team-mismatch/.test(kd.reason) && kd.confidence < 0.9, kd.reason);
    assert.ok(/^fuzzy/.test(M.matchYahooPlayer(cases[22][0], P).reason));
    assert.strictEqual(M.matchYahooPlayer(null, P), null);
    assert.strictEqual(M.matchYahooPlayer(cases[0][0], []), null);
  });
  test('matchYahooPlayer: team abbreviation variants', () => {
    const T = require('../nba/model/names').normalizeTeam;
    const pairs = { GS: 'GSW', GSW: 'GSW', NO: 'NOP', NOP: 'NOP', SA: 'SAS', SAS: 'SAS', NY: 'NYK', NYK: 'NYK', PHO: 'PHX', Pho: 'PHX', PHX: 'PHX', UTAH: 'UTA', Uta: 'UTA', WSH: 'WAS', Was: 'WAS', Bkn: 'BKN', FA: null };
    for (const [y, s] of Object.entries(pairs)) assert.strictEqual(T(y), s, y);
  });
}

// ───────────────────────── data: dedupe vs ESPN, schedule ─────────────────────────
function runDataTests() {
  const logs = readData('logs-2025.json');
  const espn = readData('espn-check.json');
  test('dedupe: Sleeper game counts/dates match ESPN gamelogs (All-Star excluded)', () => {
    assert.ok(espn.players.length >= 3);
    for (const s of espn.players) {
      const g = logs.players[s.sleeperId].g.map(x => new Date(x[0] * 86400000).toISOString().slice(0, 10));
      assert.strictEqual(g.length, s.regularGames, `${s.name}: sleeper ${g.length} vs espn ${s.regularGames}`);
      assert.deepStrictEqual(g, s.dates, `${s.name} dates`);
      const b = board.players.find(p => p.id === s.sleeperId);
      assert.ok(b && b.sampleGames >= s.regularGames, `${s.name} board sampleGames`);
    }
    assert.strictEqual(logs.dedupe.dupes, 0);
    assert.ok(logs.dedupe.nonFranchise > 0, 'All-Star rows should have been dropped');
  });
  test('schedule: Sleeper projection team dates match ESPN 2026-27 schedule', () => {
    for (const s of espn.schedule) {
      assert.strictEqual(s.onlyEspn.length + s.onlySleeper.length, 0, `${s.team}: ${JSON.stringify(s)}`);
    }
    const jok = board.players.find(p => p.id === '1658');
    const total = Object.values(jok.gamesByWeek).reduce((a, b) => a + b, 0);
    assert.strictEqual(total, espn.schedule.find(s => s.team === 'DEN').espn);
  });
}

// ───────────────────────── backtest (2025, no hindsight) ─────────────────────────
// For each week k ≥ 4: fit every player on 2025 games strictly before week k's
// first date, value them for week k with N = team games that week, and compare
// to the realized max single-game HS score (0 if he played no game).
// Inputs known before week k: logs before k, team schedule, last-week activity
// (injury proxy). 2025 Sleeper projections are NOT used in the headline run —
// their rows were last modified after the games (possible hindsight).
function backtest(params, { useProj = false } = {}) {
  const logs = readData('logs-2025.json');
  const proj = useProj ? readData('proj-2025.json').weekly : null;
  const weeks = Object.keys(logs.weeks).map(Number).sort((a, b) => a - b);
  const out = [];
  for (const k of weeks.filter(w => w >= 4)) {
    const startDay = epochDay(logs.weeks[k][0]);
    for (const [pid, p] of Object.entries(logs.players)) {
      const N = p.rw[k] || 0;
      if (!N) continue;
      const prior = p.g.filter(g => g[0] < startDay);
      if (prior.length < 5) continue;
      const pj = proj && proj[pid] && proj[pid][k];
      const fit = Fit.fitLogs(prior, { asOfDay: startDay, projMean: pj ? pj[0] : 0, projMin: pj ? pj[1] : 0, params });
      let rostered = 0;
      for (const w of weeks) if (w < k) rostered += p.rw[w] || 0;
      const a0 = Math.min(0.98, Math.max(0.4, (prior.length + 0.85 * 20) / (rostered + 20)));
      const lastWkRostered = p.rw[k - 1] || 0;
      const lastWkPlayed = p.g.filter(g => g[1] === k - 1).length;
      const a = lastWkRostered && !lastWkPlayed ? 0.2 : Math.max(a0, HEALTHY_FLOOR);
      const em = j => fit.emax[Math.min(j, fit.emax.length - 1)];
      const played = p.g.filter(g => g[1] === k);
      out.push({
        pid, k, N, pred: St.expectedMaxAvail(em, N, a),
        real: played.length ? Math.max(...played.map(g => g[2])) : 0,
        nPlayed: played.length,
        predGivenPlayed: played.length ? em(played.length) : null,
        meanOnly: fit.mean,
      });
    }
  }
  return out;
}
function metrics(pairs) {
  const n = pairs.length;
  let sp = 0, sr = 0, se = 0, sa = 0;
  for (const [p, r] of pairs) { sp += p; sr += r; se += p - r; sa += Math.abs(p - r); }
  const mp = sp / n, mr = sr / n;
  let cov = 0, vp = 0, vr = 0;
  for (const [p, r] of pairs) { cov += (p - mp) * (r - mr); vp += (p - mp) ** 2; vr += (r - mr) ** 2; }
  return { n, bias: se / n, mae: sa / n, corr: cov / Math.sqrt(vp * vr), meanPred: mp, meanReal: mr };
}
const fmt = m => `n=${m.n} bias=${m.bias.toFixed(2)} MAE=${m.mae.toFixed(2)} r=${m.corr.toFixed(3)} (pred ${m.meanPred.toFixed(1)} / real ${m.meanReal.toFixed(1)})`;

function runBacktest() {
  const rows = backtest({});
  const all = metrics(rows.map(r => [r.pred, r.real]));
  const played = rows.filter(r => r.nPlayed);
  const cond = metrics(played.map(r => [r.predGivenPlayed, r.real]));
  const naive = metrics(played.map(r => [r.meanOnly, r.real]));
  console.log('\nBacktest 2025 (fit on weeks < k, predict week k, k = 4..25):');
  console.log(`  hsValue vs realized weekly max (all rostered player-weeks): ${fmt(all)}`);
  console.log(`  given games actually played (distribution calibration):     ${fmt(cond)}`);
  console.log(`  baseline "per-game mean" as weekly value (same weeks):       ${fmt(naive)}`);
  console.log('  by scheduled games N (all player-weeks):');
  const byN = {};
  for (const r of rows) (byN[r.N] ||= []).push(r);
  for (const N of Object.keys(byN).sort()) {
    const m = metrics(byN[N].map(r => [r.pred, r.real]));
    console.log(`    N=${N}: ${fmt(m)}`);
  }
  // Same players, 4-game vs 2-game weeks: realized and predicted both higher.
  const per = {};
  for (const r of rows) { const e = (per[r.pid] ||= {}); (e[r.N] ||= []).push(r); }
  let n42 = 0, predUp = 0, realDiff = 0, predDiff = 0;
  for (const e of Object.values(per)) {
    if (!e[4] || !e[2]) continue;
    const avg = (xs, f) => xs.reduce((s, x) => s + f(x), 0) / xs.length;
    n42++;
    if (avg(e[4], x => x.pred) > avg(e[2], x => x.pred)) predUp++;
    realDiff += avg(e[4], x => x.real) - avg(e[2], x => x.real);
    predDiff += avg(e[4], x => x.pred) - avg(e[2], x => x.pred);
  }
  console.log(`  same player, 4-game vs 2-game weeks (${n42} players): predicted +${(predDiff / n42).toFixed(1)}, realized +${(realDiff / n42).toFixed(1)}; predicted higher for ${predUp}/${n42}`);
  const withProj = backtest({}, { useProj: true }).filter(r => r.nPlayed);
  console.log(`  [flagged: 2025 projection prior, rows revised post-game] given played: ${fmt(metrics(withProj.map(r => [r.predGivenPlayed, r.real])))}`);

  test('backtest: calibration', () => {
    assert.ok(Math.abs(all.bias) < 3, `bias ${all.bias}`);
    assert.ok(Math.abs(cond.bias) < 3, `conditional bias ${cond.bias}`);
    assert.ok(cond.corr > 0.7, `corr ${cond.corr}`);
    assert.ok(cond.mae < naive.mae, 'expected-max must beat the per-game mean');
    // Different weeks differ in role/health too, so this is a population check; the
    // strict otherwise-identical check is the synthetic test + the board check below.
    assert.ok(predUp / n42 > 0.9 && predDiff > 0 && realDiff > 0, `4-game vs 2-game: ${predUp}/${n42}`);
  });

  if (process.argv.includes('--tune')) {
    console.log('\nTuning grid (given-played MAE / bias):');
    for (const halfLifeDays of [20, 30, 45, 60, 120, 10000]) {
      for (const shortWeight of [0.2, 0.5, 1]) {
        for (const bwFactor of [0, 0.25, 0.5, 1]) {
          const r = backtest({ halfLifeDays, shortWeight, bwFactor }).filter(x => x.nPlayed);
          const m = metrics(r.map(x => [x.predGivenPlayed, x.real]));
          console.log(`  H=${halfLifeDays} short=${shortWeight} bw=${bwFactor}: MAE=${m.mae.toFixed(3)} bias=${m.bias.toFixed(2)} r=${m.corr.toFixed(4)}`);
        }
      }
    }
    for (const priorGames of [0, 6, 12, 25, 50]) {
      const r = backtest({ priorGames }, { useProj: true }).filter(x => x.nPlayed);
      const m = metrics(r.map(x => [x.predGivenPlayed, x.real]));
      console.log(`  [proj prior] k=${priorGames}: MAE=${m.mae.toFixed(3)} bias=${m.bias.toFixed(2)} r=${m.corr.toFixed(4)}`);
    }
  }
}
