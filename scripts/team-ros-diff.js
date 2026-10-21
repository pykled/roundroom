#!/usr/bin/env node
// Quantifies how far /team (full-season projection VORP) and /trade
// (rest-of-season projection VORP) disagree for one league's rosters.
//
//   node scripts/team-ros-diff.js [leagueId] [--base=http://localhost:7898] [--v]
//
// Rebuilds team.html's value pipeline (computeVORP → rescaleVORP → [age] →
// blendWithMarket, no injury/form/playoff factors) twice — once on
// /api/projections/season, once on /api/projections/ros — then runs
// AnalysisEngine.analyzeLeague on both and reports: rostered players moving
// more than 10 %, roster power-rank changes, positional tier changes, and a
// named-player trace (A.J. Brown by default).
'use strict';

const Scoring = require('../shared/scoring.js');
const Lineup = require('../shared/lineup.js');
global.LineupOptimizer = Lineup;
const Fit = require('../shared/trade-fit.js');
const Analysis = require('../shared/analysis.js');

const args = process.argv.slice(2);
const leagueId = args.find(a => /^\d+$/.test(a)) || '1399457768158547968';
const baseArg = args.find(a => a.startsWith('--base='));
const BASE = baseArg ? baseArg.slice(7).replace(/\/$/, '') : 'http://localhost:7898';
const VERBOSE = args.includes('--v');
const TRACE = (args.find(a => a.startsWith('--player=')) || '--player=A.J. Brown').slice(9);

async function getJSON(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}
const pad = (s, n) => { s = String(s == null ? '' : s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
const lpad = (s, n) => { s = String(s == null ? '' : s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };

(async () => {
  const league = await getJSON(`/api/league/${leagueId}`);
  const fmt = Fit.leagueFormat(league);
  const [players, season, ros, injRes, market] = await Promise.all([
    getJSON('/api/players/slim?def=1'),
    getJSON('/api/projections/season'),
    getJSON('/api/projections/ros'),
    getJSON('/api/injuries').catch(() => ({ players: {} })),
    getJSON(`/api/market-values?ppr=${fmt.ppr}&sf=${fmt.sf ? 1 : 0}&dynasty=${fmt.dynasty ? 1 : 0}`).catch(() => ({})),
  ]);
  const injuries = injRes && injRes.players ? injRes.players : {};
  const sc = league.scoring_settings || {};
  const positions = league.roster_positions || [];
  const teams = league.total_rosters || (league.rosters || []).length;
  const pool = Object.keys(players).map(id => ({ player_id: id, position: players[id][1] }));

  function build(proj, weeks) {
    const raw = Scoring.computeVORP(pool, proj, sc, positions, teams);
    let scaled = Scoring.rescaleVORP(raw);
    if (fmt.dynasty) scaled = Fit.applyAge(scaled, players);
    const vorp = Scoring.blendWithMarket(scaled, market || {}, fmt.dynasty ? 0.5 : 0.3);
    const out = Analysis.analyzeLeague(league, players, proj, vorp, injuries, weeks ? { weeks } : undefined);
    return { raw, vorp, out };
  }
  const A = build(season), B = build(ros.players, ros.weeks.length);

  console.log(`${league.name} · ${teams} teams · ${fmt.sf ? 'SF' : '1QB'} · ${fmt.dynasty ? 'dynasty' : 'redraft'} · ppr ${fmt.ppr} · ROS weeks ${ros.weeks[0]}–${ros.weeks[ros.weeks.length - 1]} (${ros.weeks.length})`);

  // ---- per-player movement over every rostered player ---------------------------
  const rostered = [];
  for (const r of league.rosters || []) for (const id of r.players || []) if (players[id] && A.vorp.has(id) && /^(QB|RB|WR|TE)$/.test(players[id][1])) rostered.push(id);
  const uniq = [...new Set(rostered)];
  const rows = uniq.map(id => {
    const a = A.vorp.get(id) || 0, b = B.vorp.get(id) || 0;
    const pct = a > 0 ? (b - a) / a : (b > 0 ? Infinity : 0);
    return { id, name: players[id][0], pos: players[id][1], status: players[id][3] || '', season: a, ros: b, pct, absPct: Math.abs(pct) };
  });
  const movers = rows.filter(r => r.absPct > 0.10);
  const up = movers.filter(r => r.pct > 0).length, down = movers.length - up;
  const med = arr => { const s = arr.slice().sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };
  console.log(`\nrostered skill players: ${rows.length}; moving > 10 %: ${movers.length} (${up} up, ${down} down); median |Δ| ${(med(rows.map(r => r.absPct)) * 100).toFixed(0)} %`);
  const big = rows.slice().sort((p, q) => Math.abs(q.ros - p.ros) > 0 ? Math.abs(q.ros - q.season) - Math.abs(p.ros - p.season) : 0).slice(0, 15);
  console.log('largest absolute moves (team value → trade value)');
  big.forEach(r => console.log(`  ${pad(r.name, 22)} ${pad(r.pos, 3)} ${pad(r.status, 12)} ${lpad(r.season, 6)} → ${lpad(r.ros, 6)}  ${r.pct === Infinity ? '  new' : lpad((r.pct * 100).toFixed(0) + ' %', 6)}`));

  // ---- team-level -------------------------------------------------------------------
  console.log('\nteam power rank (starter VORP) and starters/wk pts, season vs ROS');
  const byId = o => Object.fromEntries(o.teams.map(t => [t.rosterId, t]));
  const a = byId(A.out), b = byId(B.out);
  let rankMoves = 0, sumMoves = [];
  for (const t of A.out.teams) {
    const u = b[t.rosterId];
    if (t.rank !== u.rank) rankMoves++;
    sumMoves.push((u.starterVorp - t.starterVorp) / Math.max(1, t.starterVorp));
    console.log(`  ${pad(t.name, 22)} #${lpad(t.rank, 2)} → #${lpad(u.rank, 2)}   starterVorp ${lpad(Math.round(t.starterVorp), 6)} → ${lpad(Math.round(u.starterVorp), 6)} (${lpad(((u.starterVorp - t.starterVorp) / Math.max(1, t.starterVorp) * 100).toFixed(0), 4)} %)   pts/wk ${t.starterPts} → ${u.starterPts}`);
  }
  console.log(`  rank changes: ${rankMoves} of ${A.out.teams.length}; starter-sum Δ range ${(Math.min(...sumMoves) * 100).toFixed(0)} % … ${(Math.max(...sumMoves) * 100).toFixed(0)} %`);

  // ---- tiers --------------------------------------------------------------------------
  let tierMoves = 0, cells = 0, strMoves = 0;
  const changes = [];
  for (const t of A.out.teams) {
    const u = b[t.rosterId];
    for (const p of Analysis.NEED_POSITIONS) {
      cells++;
      const x = t.byPos[p].tier, y = u.byPos[p].tier;
      if (x !== y) { tierMoves++; changes.push(`${t.name} ${p} ${x}→${y}`); }
      if (Analysis.tierStatus(x) !== Analysis.tierStatus(y)) strMoves++;
    }
  }
  console.log(`\npositional tiers: ${tierMoves} of ${cells} cells change (${strMoves} flip need/neutral/surplus)`);
  if (VERBOSE || changes.length <= 20) changes.forEach(c => console.log('  ' + c));

  // ---- trace ---------------------------------------------------------------------------
  const pid = Object.keys(players).find(id => players[id][0] === TRACE);
  if (pid) {
    const sp = Scoring.scorePlayer({ player_id: pid }, season, sc), rp = Scoring.scorePlayer({ player_id: pid }, ros.players, sc);
    const onRoster = (league.rosters || []).find(r => (r.players || []).includes(pid));
    console.log(`\n${TRACE} (${players[pid][1]} ${players[pid][2]} ${players[pid][3] || 'healthy'})${onRoster ? ' — rostered by ' + (a[onRoster.roster_id] || {}).name : ' — not rostered in this league'}`);
    console.log(`  season proj ${sp.toFixed(1)} pts → raw VORP ${Math.round(A.raw.get(pid) || 0)} → value ${A.vorp.get(pid)}`);
    console.log(`  ROS proj    ${rp.toFixed(1)} pts → raw VORP ${Math.round(B.raw.get(pid) || 0)} → value ${B.vorp.get(pid)}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
