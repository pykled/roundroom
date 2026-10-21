#!/usr/bin/env node
// Freeze the trade calculator's inputs for a future no-hindsight backtest.
//
//   node scripts/snapshot-trade-inputs.js [--base=http://localhost:7898] [--out=data/snapshots/trade]
//
// Writes data/snapshots/trade/YYYY-MM-DD.json with the four FantasyCalc lists
// (1QB / SF × redraft / dynasty, raw values keyed by sleeperId), the
// rest-of-season projection the VORP half uses (pts_ppr / half / std per
// player, plus the ROS envelope's week range) and every current injury status
// from the slim dict. ~150 KB per run; weekly (Wednesday) is enough.
//
// Why: FantasyCalc exposes no history, so the 2026-10-20 blend study could
// only use one market snapshot (value − trend30Day) and a 4-week outcome
// window. A season of weekly snapshots lets the same backtest
// (scripts/backtest-trade-value.js) score market / model / blends over 8–12
// week windows without reconstructing anything.
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (n, d) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const BASE = String(arg('base', 'http://localhost:7898')).replace(/\/$/, '');
const OUT = arg('out', path.join(__dirname, '..', 'data', 'snapshots', 'trade'));
const SKILL = { QB: 1, RB: 1, WR: 1, TE: 1 };
const LISTS = [
  ['redraft1qb', 'isDynasty=false&numQbs=1'], ['redraftSf', 'isDynasty=false&numQbs=2'],
  ['dynasty1qb', 'isDynasty=true&numQbs=1'], ['dynastySf', 'isDynasty=true&numQbs=2'],
];

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.json();
}

(async () => {
  const state = await getJSON(BASE + '/api/nfl-state');
  const slim = await getJSON(BASE + '/api/players/slim');
  let ros = null;
  try { ros = await getJSON(BASE + '/api/projections/ros'); } catch (e) { console.error('ros unavailable: ' + e.message); }
  const market = {};
  for (const [key, q] of LISTS) {
    const rows = await getJSON(`https://api.fantasycalc.com/values/current?${q}&numTeams=12&ppr=1`);
    const m = {};
    rows.forEach(r => { const id = r.player && r.player.sleeperId; if (id) m[id] = { value: r.value, trend30Day: r.trend30Day, rank: r.overallRank }; });
    market[key] = m;
  }
  const projections = {};
  if (ros && ros.players) {
    Object.keys(ros.players).forEach(id => {
      const p = ros.players[id]; if (!slim[id] || !SKILL[slim[id][1]]) return;
      projections[id] = { pts_ppr: p.pts_ppr || 0, pts_half_ppr: p.pts_half_ppr || 0, pts_std: p.pts_std || 0 };
    });
  }
  const statuses = {};
  Object.keys(slim).forEach(id => { const p = slim[id]; if (SKILL[p[1]] && p[3]) statuses[id] = p[3]; });
  const snap = {
    fetchedAt: new Date().toISOString(), season: state.season, week: state.week,
    ros: ros ? { fromWeek: ros.fromWeek, weeks: ros.weeks, slateStarted: ros.slateStarted } : null,
    market, projections, statuses,
  };
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, snap.fetchedAt.slice(0, 10) + '.json');
  fs.writeFileSync(file, JSON.stringify(snap));
  console.log(`wrote ${file}: week ${snap.week}, ros ${ros ? ros.weeks[0] + '–' + ros.weeks[ros.weeks.length - 1] : 'none'}, ${Object.keys(projections).length} projections, ${LISTS.map(([k]) => k + ' ' + Object.keys(market[k]).length).join(', ')}, ${Object.keys(statuses).length} statuses`);
})().catch(e => { console.error(e); process.exit(1); });
