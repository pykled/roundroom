#!/usr/bin/env node
/* Backtest of the team page's power rankings on the real 2025-26 Sleeper league
   (spec §5.4.8, D7). Ground truth: league 1270568574406107137 (10 teams, same
   scoring and slots as this season), weekly rosters + points from
   GET /v1/league/{id}/matchups/{w}.

   For every week w in --from..--to (default 5..20, the regular season after a
   month of games):
     board   buildBoard(data, { now: Monday of w, profile }) on 2025 game logs ONLY:
             logs before Monday, team games-rostered counts before week w (a0), no
             projections (every 2025 projection row was revised after its games),
             injury proxy = rostered last week but played none of his team's games
             (the model's own no-hindsight protocol, docs/nba-model.md)
     predict strengthNow = team-analysis weekValue() of the roster Sleeper shows for
             week w (best lineup over the profile slots + bench shares, open spots at
             waiver level computed from that week's rostered players)
     actual  matchup.points for week w (the manager's own lineup, High Score)
   Reports pooled Spearman over all team-weeks, the mean within-week Spearman,
   predicted-winner accuracy per matchup, and two baselines (season-to-date
   points per game; last week's points). Also the "power rank" read: predicted
   mean of weeks w..w+3 vs actual mean points over the same weeks.
   Asserts Spearman ≥ 0.5 and winner accuracy ≥ 60% (exit 1 otherwise).

     node scripts/nba-team-backtest.js [--from=5] [--to=20] [--offline] [--md] [--json]
   Sleeper pulls are cached under data/nba/cache/backtest-2025/ (gitignored); --offline
   uses the cache only. */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const fs = require('fs');
const path = require('path');
const { buildBoard } = require('../nba/model/board');
const { epochDay } = require('../nba/model/sleeper');
const LS = require('../nba/model/league-sync');
const R = require('../nba/model/roster-slots');
const Sc = require('../nba/model/score');
const TA = require('../nba/model/team-analysis');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'nba');
const CACHE = path.join(DATA, 'cache', 'backtest-2025');
const LEAGUE_ID = '1270568574406107137';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const FROM = Number(arg('from', 5)), TO = Number(arg('to', 20));
const OFFLINE = process.argv.includes('--offline');
const MD = process.argv.includes('--md'), JSON_OUT = process.argv.includes('--json');
const SPEARMAN_MIN = 0.5, WINNER_MIN = 0.6;

/* ------------------------------------------------------------------ fetch + cache */
async function cached(name, url) {
  const file = path.join(CACHE, name);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (OFFLINE) throw new Error(`--offline: ${file} not cached`);
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', 'User-Agent': 'pocketff.com NBA backtest' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  const j = await r.json();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(j));
  return j;
}
const SL = 'https://api.sleeper.app/v1';

/* ------------------------------------------------------------------ stats */
function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function pearson(a, b) {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return va && vb ? c / Math.sqrt(va * vb) : 0;
}
const spearman = (a, b) => pearson(ranks(a), ranks(b));
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const f2 = x => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const pct = x => (Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : 'n/a');

/* ------------------------------------------------------------------ 2025 data */
// Team game days from the logs: a day counts for team T when ≥ 3 players whose
// (final) team is T logged a game that day (a traded player alone can't add days).
function teamDatesFromLogs(logs) {
  const byTeamDay = new Map();
  for (const p of Object.values(logs.players)) {
    if (!p.t) continue;
    for (const g of p.g) { const k = p.t + '|' + g[0]; byTeamDay.set(k, (byTeamDay.get(k) || 0) + 1); }
  }
  const out = {};
  for (const [k, n] of byTeamDay) { if (n < 3) continue; const [t, d] = k.split('|'); (out[t] ||= []).push(Number(d)); }
  for (const t of Object.keys(out)) out[t].sort((a, b) => a - b);
  return out;
}

// A player's team as of a date, from his own last games (no hindsight): the one
// team that played on every one of his last 5 game days (else last 3), else his
// final team. Catches mid-season trades that the logs' final team would hide.
function teamAsOf(p, startDay, daySets) {
  const days = p.g.filter(r => r[0] < startDay).map(r => r[0]);
  for (const k of [5, 3]) {
    const last = days.slice(-k);
    if (last.length < k) continue;
    const cands = Object.keys(daySets).filter(t => last.every(d => daySets[t].has(d)));
    if (cands.length === 1) return cands[0];
  }
  return p.t;
}

function dataAsOf(base, logs, teamDates, week, startDay, daySets) {
  const players = {};
  const trimmed = {};
  for (const [pid, p] of Object.entries(logs.players)) {
    if (!/^\d+$/.test(pid)) continue; // Sleeper's TEAM_* aggregate rows
    const rw = {};
    for (const [w, n] of Object.entries(p.rw || {})) if (Number(w) < week) rw[w] = n;
    const g = p.g.filter(r => r[0] < startDay);
    const team = teamAsOf(p, startDay, daySets);
    trimmed[pid] = { t: team, rw, g };
    const cur = base[pid] || {};
    const lastWkTeamGames = (p.rw || {})[week - 1] || 0;
    const playedLastWk = p.g.some(r => r[1] === week - 1);
    players[pid] = {
      n: cur.n || `Player ${pid}`, t: team, p: cur.p && cur.p.length ? cur.p : ['F'], x: g.length ? Math.max(1, Number(cur.x) || 1) : (cur.x ?? 1),
      i: lastWkTeamGames > 0 && !playedLastWk && g.length ? 'Out' : null, in: null, ib: null,
    };
  }
  const proj = { season: '2025', weeks: logs.weeks, teamGames: logs.teamGames, teamDates, seasonProj: {}, weekly: {} };
  return { players, state: { season: '2025', season_type: 'regular' }, logs: [{ season: '2025', format: logs.format, players: trimmed }], proj };
}

/* ------------------------------------------------------------------ main */
(async () => {
  const t0 = Date.now();
  const league = await cached('league.json', `${SL}/league/${LEAGUE_ID}`);
  const users = await cached('users.json', `${SL}/league/${LEAGUE_ID}/users`);
  const lastWeek = Math.min(23, TO + 3);
  const matchups = {};
  for (let w = 1; w <= lastWeek; w++) matchups[w] = await cached(`matchups-${w}.json`, `${SL}/league/${LEAGUE_ID}/matchups/${w}`);
  const profile = LS.profileFromSleeper({ league, state: { season_start_date: '2025-10-21', league_season: '2025' } });
  const logs = JSON.parse(fs.readFileSync(path.join(DATA, 'logs-2025.json'), 'utf8'));
  const base = JSON.parse(fs.readFileSync(path.join(DATA, 'players.json'), 'utf8')).players;
  const teamDates = teamDatesFromLogs(logs);
  const daySets = Object.fromEntries(Object.entries(teamDates).map(([t, d]) => [t, new Set(d)]));
  // Realized best game per player-week under the league scoring (diagnostic only).
  const bestOf = new Map();
  for (const [pid, p] of Object.entries(logs.players)) for (const g of p.g) {
    const k = pid + '|' + g[1], v = Sc.rowScore(g, profile);
    if (!bestOf.has(k) || v > bestOf.get(k)) bestOf.set(k, v);
  }
  const slotList = R.slotList(profile);

  // Calendar + schedule sanity: profile weeks = Sleeper weeks; derived team games = logged team games.
  const calOk = profile.weeks.every(w => !logs.weeks[w.week] || (logs.weeks[w.week][0] >= w.start && logs.weeks[w.week][1] <= w.end));
  let schedDiff = 0, schedN = 0;
  for (const [t, byW] of Object.entries(logs.teamGames)) {
    for (const w of profile.weeks) {
      const n = (teamDates[t] || []).filter(d => d >= epochDay(w.start) && d <= epochDay(w.end)).length;
      if (byW[w.week] != null) { schedN++; schedDiff += Math.abs(n - byW[w.week]); }
    }
  }
  const nameOf = new Map();
  for (const u of users) nameOf.set(String(u.user_id), (u.metadata && u.metadata.team_name) || u.display_name);

  const rows = [];        // team-weeks
  const games = [];       // matchups
  const powerWeeks = [];  // per-week next-4 Spearman
  let unmatchedSlots = 0, totalSlots = 0;
  const predByRW = new Map(); // `${rid}|${w}` → predicted strengthNow
  for (let w = FROM; w <= TO; w++) {
    const pw = profile.weeks[w - 1];
    const startDay = epochDay(pw.start);
    const data = dataAsOf(base, logs, teamDates, w, startDay, daySets);
    const board = buildBoard(data, { now: new Date(pw.start + 'T12:00:00Z'), profile });
    if (board.currentWeek !== w) throw new Error(`board week ${board.currentWeek} != ${w}`);
    const index = new Map(board.players.map(p => [String(p.id), p]));
    const ms = (matchups[w] || []).filter(m => m && m.roster_id != null);
    const rostered = ms.flatMap(m => (m.players || []).map(String));
    const horizon = [w, w + 1, w + 2, w + 3].filter(x => x <= profile.weeks.length);
    const repl = TA.replacementFor(board.players, profile, horizon, rostered);
    const weekRows = [];
    for (const m of ms) {
      const ids = (m.players || []).map(String);
      totalSlots += ids.length;
      const ps = ids.filter(id => index.has(id)).map(id => index.get(id));
      unmatchedSlots += ids.length - ps.length;
      const vNow = TA.weekValue(ps, profile, w, repl);
      const next4 = horizon.map(x => TA.weekValue(ps, profile, x, repl).total);
      const actualNext = horizon.map(x => { const mm = (matchups[x] || []).find(y => y && String(y.roster_id) === String(m.roster_id)); return mm ? Number(mm.points) || 0 : null; }).filter(x => x != null);
      // Baselines known on Monday: season-to-date points per week, last week's points.
      const prior = [];
      for (let x = 1; x < w; x++) { const mm = (matchups[x] || []).find(y => y && String(y.roster_id) === String(m.roster_id)); if (mm) prior.push(Number(mm.points) || 0); }
      // Diagnostic: the best lineup the roster could have set on the games actually played.
      const realized = R.bestAssignment(ps.map(p => ({ id: String(p.id), elig: R.eligFor(p, profile), v: bestOf.get(p.id + '|' + w) || 0 })), slotList).total;
      const filled = (m.starters || []).filter(s => s && s !== '0').length;
      const row = { week: w, rosterId: String(m.roster_id), matchupId: m.matchup_id, pred: vNow.total, actual: Number(m.points) || 0, realized, fullLineup: filled >= slotList.length,
        predNext4: mean(next4), actualNext4: mean(actualNext), avgPrior: prior.length ? mean(prior) : null, lastWeek: prior.length ? prior[prior.length - 1] : null, starters: vNow.starters.filter(s => s.id).length };
      rows.push(row); weekRows.push(row);
      predByRW.set(row.rosterId + '|' + w, row.pred);
    }
    if (weekRows.length >= 4) powerWeeks.push({ week: w, rho: spearman(weekRows.map(r => r.predNext4), weekRows.map(r => r.actualNext4)), rhoNow: spearman(weekRows.map(r => r.pred), weekRows.map(r => r.actual)) });
    const byM = new Map();
    for (const r of weekRows) if (r.matchupId != null) (byM.get(r.matchupId) || byM.set(r.matchupId, []).get(r.matchupId)).push(r);
    for (const pair of byM.values()) {
      if (pair.length !== 2 || pair[0].actual === pair[1].actual) continue;
      const [a, b] = pair;
      const actualA = a.actual > b.actual;
      const call = (x, y) => (x == null || y == null || x === y ? null : (x > y) === actualA);
      games.push({ week: w, model: call(a.pred, b.pred), avgPrior: call(a.avgPrior, b.avgPrior), lastWeek: call(a.lastWeek, b.lastWeek), margin: Math.abs(a.pred - b.pred) });
    }
  }

  const P = rows.map(r => r.pred), A = rows.map(r => r.actual);
  const rho = spearman(P, A), r = pearson(P, A);
  const bias = mean(rows.map(x => x.pred - x.actual)), mae = mean(rows.map(x => Math.abs(x.pred - x.actual)));
  const acc = k => { const g = games.filter(x => x[k] != null); return { n: g.length, acc: g.filter(x => x[k]).length / (g.length || 1) }; };
  const wModel = acc('model'), wAvg = acc('avgPrior'), wLast = acc('lastWeek');
  const close = games.filter(g => g.margin < 15), clear = games.filter(g => g.margin >= 30);
  const wkRho = mean(powerWeeks.map(x => x.rhoNow)), powerRho = mean(powerWeeks.map(x => x.rho));
  const baseRows = rows.filter(x => x.avgPrior != null);
  const full = rows.filter(x => x.fullLineup);
  const diag = {
    spearmanPredVsRealizedOptimal: spearman(P, rows.map(x => x.realized)),
    spearmanRealizedOptimalVsActual: spearman(rows.map(x => x.realized), A),
    managerEfficiency: mean(rows.map(x => (x.realized > 0 ? x.actual / x.realized : 1))),
    biasVsRealizedOptimal: mean(rows.map(x => x.pred - x.realized)),
    fullLineupTeamWeeks: full.length, spearmanFullLineups: spearman(full.map(x => x.pred), full.map(x => x.actual)),
  };
  const rhoAvg = spearman(baseRows.map(x => x.avgPrior), baseRows.map(x => x.actual));
  const out = {
    league: LEAGUE_ID, season: '2025-26', weeks: [FROM, TO], teams: Number(league.total_rosters) || null, teamWeeks: rows.length, matchups: games.length,
    spearman: rho, pearson: r, bias, mae, meanPred: mean(P), meanActual: mean(A),
    withinWeekSpearman: wkRho, powerRankSpearmanNext4: powerRho,
    winner: { model: wModel, seasonAvg: wAvg, lastWeek: wLast, closeGames: { n: close.length, acc: close.filter(g => g.model).length / (close.length || 1) }, clearGames: { n: clear.length, acc: clear.filter(g => g.model).length / (clear.length || 1) } },
    baselineSpearmanSeasonAvg: rhoAvg, diagnostics: diag,
    calendarMatchesSleeperWeeks: calOk, scheduleAbsDiffPerTeamWeek: schedN ? schedDiff / schedN : null, unmatchedRosterSlots: unmatchedSlots, totalRosterSlots: totalSlots,
    slots: profile.slots, starters: profile.starters, ms: Date.now() - t0,
    pass: { spearman: rho >= SPEARMAN_MIN, winner: wModel.acc >= WINNER_MIN },
  };
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, 'result.json'), JSON.stringify({ ...out, perWeek: powerWeeks }, null, 2));
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); }
  else if (MD) {
    console.log(`| metric | value |\n|---|---|`);
    console.log(`| team-weeks (weeks ${FROM}-${TO}, ${out.teams} teams) | ${rows.length} |`);
    console.log(`| Spearman, predicted strengthNow vs actual points (pooled) | **${f2(rho)}** (assert ≥ ${SPEARMAN_MIN}) |`);
    console.log(`| Pearson r | ${f2(r)} |`);
    console.log(`| mean within-week Spearman | ${f2(wkRho)} |`);
    console.log(`| predicted weekly winner correct | **${pct(wModel.acc)}** of ${wModel.n} (assert ≥ ${pct(WINNER_MIN)}) |`);
    console.log(`| … when the projected margin is ≥ 30 / < 15 | ${pct(out.winner.clearGames.acc)} of ${clear.length} / ${pct(out.winner.closeGames.acc)} of ${close.length} |`);
    console.log(`| baseline: season-to-date points/week picks the winner | ${pct(wAvg.acc)} of ${wAvg.n} (Spearman ${f2(rhoAvg)}) |`);
    console.log(`| baseline: last week's points picks the winner | ${pct(wLast.acc)} of ${wLast.n} |`);
    console.log(`| power rank: predicted next-4 mean vs actual next-4 mean (mean weekly Spearman) | ${f2(powerRho)} |`);
    console.log(`| bias / MAE (optimal lineup vs the manager's actual lineup) | ${bias.toFixed(1)} / ${mae.toFixed(1)} (pred ${mean(P).toFixed(1)}, actual ${mean(A).toFixed(1)}) |`);
    console.log(`| roster slots not on the 2025 board (no 2025 games) | ${unmatchedSlots} of ${totalSlots} |`);
    console.log(`| diagnostic: Spearman, predicted vs the roster's realized optimal lineup | ${f2(diag.spearmanPredVsRealizedOptimal)} (bias ${diag.biasVsRealizedOptimal.toFixed(1)}) |`);
    console.log(`| diagnostic: Spearman, realized optimal vs actual points (lineup management noise) | ${f2(diag.spearmanRealizedOptimalVsActual)}; managers banked ${pct(diag.managerEfficiency)} of their optimal |`);
    console.log(`| diagnostic: Spearman on team-weeks with all ${slotList.length} starter slots filled | ${f2(diag.spearmanFullLineups)} (${full.length} team-weeks) |`);
  } else {
    console.log(`team backtest ${LEAGUE_ID} weeks ${FROM}-${TO}: ${rows.length} team-weeks, ${games.length} matchups (${out.ms} ms)`);
    console.log(`  calendar = Sleeper weeks: ${calOk}; derived schedule |Δ games| per team-week: ${f2(out.scheduleAbsDiffPerTeamWeek)}; unmatched roster slots ${unmatchedSlots}/${totalSlots}`);
    console.log(`  Spearman ${f2(rho)} (≥ ${SPEARMAN_MIN}: ${out.pass.spearman ? 'PASS' : 'FAIL'}), Pearson ${f2(r)}, within-week Spearman ${f2(wkRho)}`);
    console.log(`  winner ${pct(wModel.acc)} of ${wModel.n} (≥ ${pct(WINNER_MIN)}: ${out.pass.winner ? 'PASS' : 'FAIL'}); margin ≥30: ${pct(out.winner.clearGames.acc)} of ${clear.length}; <15: ${pct(out.winner.closeGames.acc)} of ${close.length}`);
    console.log(`  baselines: season-avg winner ${pct(wAvg.acc)} (Spearman ${f2(rhoAvg)}), last-week winner ${pct(wLast.acc)}`);
    console.log(`  power rank next-4 Spearman (mean over weeks) ${f2(powerRho)}`);
    console.log(`  bias ${bias.toFixed(1)}, MAE ${mae.toFixed(1)} (pred ${mean(P).toFixed(1)} vs actual ${mean(A).toFixed(1)})`);
    console.log(`  diagnostics: pred vs realized-optimal Spearman ${f2(diag.spearmanPredVsRealizedOptimal)} (bias ${diag.biasVsRealizedOptimal.toFixed(1)}); realized-optimal vs actual ${f2(diag.spearmanRealizedOptimalVsActual)}; managers banked ${pct(diag.managerEfficiency)}; full-lineup team-weeks ${full.length}: Spearman ${f2(diag.spearmanFullLineups)}`);
  }
  process.exit(out.pass.spearman && out.pass.winner ? 0 : 1);
})().catch(err => { console.error('team backtest failed:', err && err.stack ? err.stack : err); process.exit(2); });
