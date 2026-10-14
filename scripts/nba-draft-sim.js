#!/usr/bin/env node
// Pocket NBA mock-draft simulator for league 242808 (12 teams, snake, 16 rounds,
// 9 starters PG SG G SF PF F C UTIL UTIL, High Score best-game weeks).
//
//   node scripts/nba-draft-sim.js --sims 100 --seed 1 --my-slot all --policy vorp,bpa-fill,hs-fill
//   node scripts/nba-draft-sim.js --report rankings     # league vs High Score default ranks
//   node scripts/nba-draft-sim.js --report runs --sims 200
//   options: --sims N  --seed S  --my-slot K|all (1-based)  --policy a,b,...
//            --wHS x (bot consensus weight on default ranks, 0..1, default 0.5)
//            --alpha x (VONA weight)  --json file (write raw aggregates)
// Policies: bpa, bpa-fill, hs-rank, hs-fill, vorp, vorp-a<alpha>, c-round<K>, stars, safe,
//           <policy>:waiver-bench. The first policy is the baseline for paired CIs.
'use strict';
const fs = require('fs');
const V = require('../nba/sim/valuation');
const R = require('../nba/sim/run');

function args(argv) {
  const a = { sims: 50, seed: 1, slot: 'all', policy: 'vorp,bpa-fill,hs-fill', report: null, json: null, wHS: null, alpha: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--sims') { a.sims = +v; i++; } else if (k === '--seed') { a.seed = +v; i++; } else if (k === '--my-slot') { a.slot = v; i++; } else if (k === '--policy') { a.policy = v; i++; } else if (k === '--report') { a.report = v; i++; } else if (k === '--json') { a.json = v; i++; } else if (k === '--wHS') { a.wHS = +v; i++; } else if (k === '--alpha') { a.alpha = +v; i++; } else if (k === '-h' || k === '--help') { a.help = true; } else throw new Error('unknown arg ' + k);
  }
  return a;
}
const f1 = x => (Number.isFinite(x) ? x.toFixed(1) : '-');
const pct = x => (x * 100).toFixed(1) + '%';
const pad = (s, n) => String(s).padEnd(n);

async function rankingsReport() {
  const res = await (async () => { process.env.NBA_MODEL_OFFLINE = '1'; return require('../nba/model').getPlayers({}); })();
  const league = V.buildPool(res);
  const hs = V.buildPool(res, { scoring: V.HS_SCORING });
  const noBonus = V.buildPool(res, { scoring: Object.assign({}, league.profile.scoring, { dd: 0, td: 0 }) });
  const rankOf = pool => new Map(pool.players.map(p => [p.id, p.rank]));
  const rh = rankOf(hs), rn = rankOf(noBonus);
  const top = league.players.slice(0, 150);
  const rows = top.map(p => ({ name: p.name, pos: p.pos.join('/'), league: p.rank, hs: rh.get(p.id), noBonus: rn.get(p.id), model: p.hsRank, value: p.value }));
  console.log(`Lines source: ${league.linesSource}; H1 profile values used: ${league.h1Values}`);
  console.log('\nTop 150 by league value: biggest movers vs High Score default scoring (same pipeline, 1/1/2/3/3, no TO/PF/DD)');
  const movers = rows.filter(r => r.hs).sort((a, b) => Math.abs(b.hs - b.league) - Math.abs(a.hs - a.league)).slice(0, 15);
  for (const r of movers) console.log(`${pad(r.name, 26)} ${pad(r.pos, 9)} league #${pad(r.league, 4)} HS-default #${pad(r.hs, 4)} (Δ ${r.hs - r.league > 0 ? '+' : ''}${r.hs - r.league})  no-DD/TD #${r.noBonus}  model #${r.model}`);
  console.log('\nDD/TD bonus effect alone (league scoring vs same scoring with DD=TD=0), top 150:');
  const ddm = rows.sort((a, b) => Math.abs(b.noBonus - b.league) - Math.abs(a.noBonus - a.league)).slice(0, 10);
  for (const r of ddm) console.log(`${pad(r.name, 26)} ${pad(r.pos, 9)} league #${pad(r.league, 4)} no-DD/TD #${pad(r.noBonus, 4)} (Δ ${r.noBonus - r.league})`);
  console.log('\nTop 30 league board:');
  for (const p of league.players.slice(0, 30)) console.log(`${pad(p.rank, 3)} ${pad(p.name, 26)} ${pad(p.pos.join('/'), 9)} value ${f1(p.value)}  mean ${f1(p.mean)} sd ${f1(p.sd)}  HS-model #${p.hsRank}`);
  return { movers, ddm };
}

async function main() {
  const a = args(process.argv);
  if (a.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 14).join('\n')); return; }
  if (a.report === 'rankings') return rankingsReport();
  const pool = await V.loadPool();
  const policies = a.policy.split(',').map(s => s.trim()).filter(Boolean);
  const slots = a.slot === 'all' ? Array.from({ length: pool.profile.teams }, (_, i) => i) : String(a.slot).split(',').map(s => +s - 1);
  const t0 = Date.now();
  const grid = R.runGrid(pool, { policies, slots, sims: a.sims, seed: a.seed, wHS: a.wHS == null ? undefined : a.wHS, alpha: a.alpha == null ? undefined : a.alpha });
  const secs = (Date.now() - t0) / 1000;
  console.log(`league ${pool.profile.leagueId} ${pool.profile.teams} teams x ${pool.profile.rosterSize} rounds; sims/slot ${a.sims}; seed ${a.seed}; ${policies.length} policies x ${slots.length} slots in ${secs.toFixed(1)}s; lines: ${pool.linesSource}`);

  if (a.report === 'runs') return runsReport(grid, pool, policies[0]);

  const flat = pol => slots.flatMap(s => grid[pol][s]);
  console.log('\n== Policy summary (all chosen slots pooled) ==');
  console.log(pad('policy', 22) + pad('teamValue mean/med [p10,p90]', 34) + pad('weekly', 8) + pad('all-play', 10) + pad('playoff', 9) + pad('title', 8) + 'firstC  nC  benchStart');
  for (const pol of policies) {
    const rs = flat(pol);
    const tv = R.stats(rs.map(r => r.teamValue));
    const fc = rs.filter(r => r.firstC).map(r => r.firstC);
    console.log(pad(pol, 22) + pad(`${f1(tv.mean)} / ${f1(tv.median)} [${f1(tv.p10)}, ${f1(tv.p90)}]`, 34) + pad(f1(R.stats(rs.map(r => r.meanWeekly)).mean), 8) +
      pad(pct(R.stats(rs.map(r => r.allPlay)).mean), 10) + pad(pct(R.stats(rs.map(r => r.playoff)).mean), 9) + pad(pct(R.stats(rs.map(r => r.champion)).mean), 8) +
      pad(fc.length ? f1(fc.reduce((x, y) => x + y, 0) / fc.length) : '-', 8) + pad(f1(R.stats(rs.map(r => r.nC)).mean), 4) + pct(R.stats(rs.map(r => r.benchStartShare)).mean));
  }
  if (policies.length > 1) {
    const base = policies[0];
    console.log(`\n== Paired differences vs ${base} (95% CI; same bot boards & player seasons) ==`);
    for (const pol of policies.slice(1)) {
      const A = flat(pol), B = flat(base);
      const dv = R.paired(A.map(r => r.teamValue), B.map(r => r.teamValue));
      const da = R.paired(A.map(r => r.allPlay), B.map(r => r.allPlay));
      const dp = R.paired(A.map(r => r.playoff), B.map(r => r.playoff));
      console.log(`${pad(pol, 22)} teamValue ${f1(dv.mean)} [${f1(dv.lo)}, ${f1(dv.hi)}]   all-play ${(da.mean * 100).toFixed(1)}pp [${(da.lo * 100).toFixed(1)}, ${(da.hi * 100).toFixed(1)}]   playoff ${(dp.mean * 100).toFixed(1)}pp [${(dp.lo * 100).toFixed(1)}, ${(dp.hi * 100).toFixed(1)}]`);
    }
  }
  console.log('\n== Per draft slot: all-play win% (teamValue) ==');
  console.log(pad('slot', 6) + policies.map(p => pad(p, 22)).join('') + 'best');
  for (const s of slots) {
    const cells = policies.map(pol => { const rs = grid[pol][s]; return { pol, ap: R.stats(rs.map(r => r.allPlay)), tv: R.stats(rs.map(r => r.teamValue)) }; });
    const best = cells.slice().sort((x, y) => y.ap.mean - x.ap.mean)[0];
    console.log(pad(s + 1, 6) + cells.map(c => pad(`${pct(c.ap.mean)}±${(c.ap.se * 196).toFixed(1)} (${f1(c.tv.mean)})`, 22)).join('') + best.pol);
  }
  if (a.json) {
    const agg = {};
    for (const pol of policies) {
      agg[pol] = {};
      for (const s of slots) {
        const rs = grid[pol][s];
        agg[pol][s + 1] = { teamValue: R.stats(rs.map(r => r.teamValue)), allPlay: R.stats(rs.map(r => r.allPlay)), playoff: R.stats(rs.map(r => r.playoff)), champion: R.stats(rs.map(r => r.champion)), firstC: R.stats(rs.map(r => r.firstC || 17)), benchStartShare: R.stats(rs.map(r => r.benchStartShare)), teamValueRaw: rs.map(r => r.teamValue), allPlayRaw: rs.map(r => r.allPlay) };
      }
    }
    fs.writeFileSync(a.json, JSON.stringify({ args: a, league: pool.profile.leagueId, agg }, null, 1));
    console.log('wrote', a.json);
  }
}

// Position runs: by round, share of picks that are C-eligible / guards / forwards; and when the Nth C goes.
function runsReport(grid, pool, pol) {
  const lay = pool.layout;
  const P = require('../nba/sim/policies');
  const rows = Array.from({ length: pool.profile.rosterSize }, () => ({ C: 0, G: 0, F: 0, n: 0 }));
  const nthC = Array.from({ length: 12 }, () => []);
  for (const rs of Object.values(grid[pol])) for (const r of rs) {
    let c = 0;
    for (const pk of r.picks) {
      const p = pool.players[pk.idx];
      const g = P.groupsOf(p, lay);
      const row = rows[pk.round - 1];
      row.n++;
      if (g.includes('C')) { row.C++; if (c < 12) nthC[c++].push(pk.pick); } else if (g.includes('G') && !g.includes('F')) row.G++; else row.F++;
    }
  }
  console.log(`\nPosition mix by round (all 12 teams, policy ${pol} for me): C-eligible / guard-only / forward-or-wing`);
  rows.forEach((r, i) => console.log(`round ${pad(i + 1, 3)} C ${pct(r.C / r.n)}  G ${pct(r.G / r.n)}  F/wing ${pct(r.F / r.n)}`));
  console.log('\nWhen the Nth C-eligible player is drafted (overall pick, median [p10,p90]):');
  nthC.forEach((xs, i) => { if (xs.length) { const s = R.stats(xs); console.log(`C #${pad(i + 1, 3)} pick ${s.median} [${s.p10}, ${s.p90}]`); } });
}

main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
