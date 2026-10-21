#!/usr/bin/env node
// Trade-calculator health check. Rebuilds trade.html's value pipeline in node
// against a running server and measures it against the FantasyCalc market:
//
//   node scripts/trade-calc-health.js [--base=http://localhost:7898]
//        [--ppr=1|0.5|0] [--sf=0|1] [--dynasty=0|1] [--teams=12]
//        [--proj=ros|season]   projection source for the VORP half
//                              (ros = sum of Sleeper weekly projections from the
//                              current week on, season = Sleeper full-season)
//        [--inj=ros|table]     injury handling: 'table' = TradeFit.INJURY_MULT on
//                              every status; 'ros' = weekly projections carry the
//                              missed games, so only Questionable/Doubtful nudge
//        [--player="A.J. Brown"]   stage-by-stage trace for one player
//        [--json=out.json]     dump the measurements
//
// Reports: data freshness, the player trace, market-vs-model rank for the top
// WRs, Spearman by position, bias by age bucket / injury status / games missed,
// top-200 market players the model values at zero or far below market, and a
// set of consolidation (2-for-1, 3-for-1) trades under the raw verdict.
'use strict';

const Scoring = require('../shared/scoring.js');
const Lineup = require('../shared/lineup.js');
global.LineupOptimizer = Lineup;
const Fit = require('../shared/trade-fit.js');

const args = process.argv.slice(2);
function arg(name, dflt) {
  const a = args.find(x => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : dflt;
}
const BASE = String(arg('base', 'http://localhost:7898')).replace(/\/$/, '');
const PPR = Number(arg('ppr', 1));
const SF = arg('sf', '0') === '1';
const DYN = arg('dynasty', '0') === '1';
const TEAMS = Number(arg('teams', 12));
const PROJ_SRC = arg('proj', 'ros');
const INJ_MODE = arg('inj', PROJ_SRC === 'ros' ? 'ros' : 'table');
const PLAYER = arg('player', 'A.J. Brown');
const JSON_OUT = arg('json', null);
const SKILL = { QB: 1, RB: 1, WR: 1, TE: 1 };

async function getJSON(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}
async function tryJSON(path) { try { return await getJSON(path); } catch (e) { return null; } }

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  const rank = a => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
function median(a) { const s = a.slice().sort((p, q) => p - q); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; }
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function lpad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function f2(x) { return Number.isFinite(x) ? x.toFixed(2) : 'n/a'; }

(async () => {
  const out = { base: BASE, format: { ppr: PPR, sf: SF, dynasty: DYN, teams: TEAMS }, proj: PROJ_SRC, inj: INJ_MODE };

  // ---- feeds -------------------------------------------------------------------
  const state = await getJSON('/api/nfl-state');
  const week = Number(state.week) || 1;
  const season = String(state.season || 2026);
  const [slim, seasonProj, market, recent, usage, fpa, injuries] = await Promise.all([
    getJSON('/api/players/slim'), getJSON('/api/projections/season'),
    getJSON(`/api/market-values?ppr=${PPR === 0 ? 0 : 1}&sf=${SF ? 1 : 0}&dynasty=${DYN ? 1 : 0}`),
    tryJSON('/api/recent-points'), tryJSON('/api/recent-stats'), tryJSON('/data/fpa-current.json'), tryJSON('/api/injuries'),
  ]);
  // Rest-of-season projection: /api/projections/ros when the server has it,
  // else summed here from the weekly endpoints (same arithmetic).
  const rosEnv = PROJ_SRC === 'ros' ? await tryJSON('/api/projections/ros') : null;
  let rosProj = rosEnv && rosEnv.players ? rosEnv.players : null;
  let rosWeeks = rosEnv && rosEnv.weeks ? rosEnv.weeks : null;
  if (PROJ_SRC === 'ros' && !rosProj) {
    rosWeeks = [];
    const dicts = [];
    for (let w = week; w <= 18; w++) {
      const wk = await tryJSON('/api/projections/' + w);
      if (!wk || !Object.keys(wk).length) continue;
      rosWeeks.push(w); dicts.push(wk);
    }
    rosProj = Scoring.sumProjections(dicts);
  }
  const proj = PROJ_SRC === 'ros' ? rosProj : seasonProj;
  const playoffWeeksAll = Fit.playoffWeeks(null);
  const playoffWeeks = playoffWeeksAll.filter(w => w >= week);
  const schedule = {};
  for (const w of playoffWeeks) { const s = await tryJSON('/api/schedule/' + w); if (s && s.teams) schedule[w] = s.teams; }
  const fpaOk = fpa && fpa.current && String(fpa.season) === season ? fpa : null;

  console.log(`trade-calc health · ${BASE} · ${SF ? 'SF' : '1QB'} · ${DYN ? 'dynasty' : 'redraft'} · ppr ${PPR} · ${TEAMS} teams · proj=${PROJ_SRC} inj=${INJ_MODE}`);
  console.log('\nfreshness');
  console.log(`  nfl state: season ${season} week ${week}`);
  console.log(`  season projections: ${Object.keys(seasonProj).length} rows (gp=${Object.values(seasonProj).find(p => p.gp) ? Object.values(seasonProj).find(p => p.gp).gp : '?'} for all)`);
  if (rosProj) console.log(`  ROS projections: ${Object.keys(rosProj).length} rows over weeks ${rosWeeks ? rosWeeks.join(',') : '?'}`);
  console.log(`  market: ${Object.keys(market).length} players, max ${Math.max(...Object.values(market))}`);
  console.log(`  recent points: weeks ${recent && recent.weeks ? recent.weeks.join(',') : 'none'}; usage recentWeeks ${usage && usage.recentWeeks ? usage.recentWeeks.join(',') : 'none'}`);
  console.log(`  fpa: season ${fpa && fpa.season} throughWeek ${fpa && fpa.throughWeek} updatedAt ${fpa && fpa.updatedAt} → ${fpaOk ? 'used' : 'IGNORED'}`);
  console.log(`  injuries.json: ${injuries && injuries.fetched_at} (${injuries && injuries.players ? Object.keys(injuries.players).length : 0} players); slim dict: ${Object.keys(slim).length} players, ${Object.values(slim).filter(p => p[3]).length} with a status`);
  console.log(`  playoff weeks ${playoffWeeks.join(',')} schedule loaded for ${Object.keys(schedule).join(',') || 'none'}`);
  out.freshness = { season, week, seasonRows: Object.keys(seasonProj).length, rosWeeks, market: Object.keys(market).length, recentWeeks: recent && recent.weeks, fpaThrough: fpa && fpa.throughWeek, fpaUsed: !!fpaOk, injuriesAt: injuries && injuries.fetched_at };

  // ---- pipeline (mirror of trade.html recompute) ------------------------------
  const league = {
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K'].concat(SF ? ['SUPER_FLEX'] : []),
    scoring_settings: { rec: PPR, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6, pass_yd: 0.04, pass_td: 4, pass_int: -2 },
    settings: { type: DYN ? 2 : 0 }, total_rosters: TEAMS,
  };
  const fmt = Fit.leagueFormat(league);
  const pool = Object.keys(slim).map(id => ({ player_id: id, position: slim[id][1] }));
  const raw = Scoring.computeVORP(pool, proj, league.scoring_settings, league.roster_positions, fmt.teams);
  let scaled = Scoring.rescaleVORP(raw);
  const scaledPreAge = scaled;
  if (fmt.dynasty) scaled = Fit.applyAge(scaled, slim);
  const healthy = Scoring.blendWithMarket(scaled, market, fmt.dynasty ? 0.5 : 0.3);
  const teamOuts = Fit.teamOuts(slim, usage && usage.players);
  const form = Fit.formMap(slim, recent && recent.stats, recent && recent.weeks, seasonProj, {
    ppr: fmt.ppr, dynasty: fmt.dynasty, projByWeek: recent && recent.proj, usage: usage && usage.players, teamOuts,
    recentWindow: usage && Array.isArray(usage.recentWeeks) && usage.recentWeeks.length ? usage.recentWeeks.length : 1,
  });
  const playoff = Fit.playoffMap(slim, playoffWeeks, schedule, fpaOk, { dynasty: fmt.dynasty });
  const injOpts = { dynasty: fmt.dynasty, ros: INJ_MODE === 'ros' };
  const injured = INJ_MODE === 'none' ? healthy : Fit.applyInjury(healthy, slim, injOpts);
  const final = Fit.applyFactors(injured, [form, playoff]);

  // FC normalised to 0–10000 like blendWithMarket does
  const fcMax = Math.max(...Object.values(market));
  const fcNorm = id => market[id] != null ? Math.round(market[id] / fcMax * 10000) : null;
  const posRank = (map, id) => {
    const pos = slim[id][1];
    let r = 1; const v = map.get(id) || 0;
    map.forEach((x, j) => { if (slim[j] && slim[j][1] === pos && x > v) r++; });
    return r;
  };
  const marketPosRank = id => { const pos = slim[id][1], v = market[id]; let r = 1; for (const j in market) if (slim[j] && slim[j][1] === pos && market[j] > v) r++; return r; };
  const projPts = (dict, id) => dict[id] ? Scoring.scorePlayer({ player_id: id }, dict, league.scoring_settings) : 0;

  // ---- player trace --------------------------------------------------------------
  const pid = Object.keys(slim).find(id => slim[id][0].toLowerCase() === PLAYER.toLowerCase());
  if (pid) {
    const p = slim[pid];
    console.log(`\ntrace: ${p[0]} (${p[1]}, ${p[2]}, status ${p[3] || 'healthy'}, age ${p[4]}) id ${pid}`);
    const rows = [
      ['season projection pts', projPts(seasonProj, pid).toFixed(1), posRank(new Map(Object.keys(seasonProj).filter(i => slim[i]).map(i => [i, projPts(seasonProj, i)])), pid)],
      rosProj ? ['ROS projection pts', projPts(rosProj, pid).toFixed(1), posRank(new Map(Object.keys(rosProj).filter(i => slim[i]).map(i => [i, projPts(rosProj, i)])), pid)] : null,
      [`VORP (${PROJ_SRC}) pts over replacement`, (raw.get(pid) || 0).toFixed(1), posRank(raw, pid)],
      ['rescaled ^1.25 → 0–10000', scaledPreAge.get(pid), posRank(scaledPreAge, pid)],
      fmt.dynasty ? ['× age curve ' + Fit.ageMult(p[1], p[4]), scaled.get(pid), posRank(scaled, pid)] : null,
      ['FantasyCalc raw / normalised', market[pid] + ' / ' + fcNorm(pid), marketPosRank(pid)],
      [`blend ${fmt.dynasty ? '50/50' : '70/30'} (base)`, healthy.get(pid), posRank(healthy, pid)],
      ['× injury ' + (INJ_MODE === 'none' ? 1 : Fit.injuryMult(p[3], injOpts)), injured.get(pid), posRank(injured, pid)],
      ['× form ' + (form.get(pid) ? form.get(pid).mult + ' (' + form.get(pid).label + ')' : '1 (no signal)'), '', ''],
      ['× playoff ' + (playoff.get(pid) ? playoff.get(pid).mult + ' (avg #' + playoff.get(pid).avgRank + ')' : '1 (no read)'), '', ''],
      ['FINAL', final.get(pid), posRank(final, pid)],
    ].filter(Boolean);
    console.log('  ' + pad('stage', 42) + lpad('value', 14) + lpad(p[1] + ' rank', 10));
    rows.forEach(r => console.log('  ' + pad(r[0], 42) + lpad(r[1], 14) + lpad(r[2], 10)));
    if (recent && recent.weeks) console.log('  recent weeks ' + recent.weeks.map(w => `wk${w}: ${recent.stats[w][pid] ? JSON.stringify(recent.stats[w][pid]) : 'no line'}`).join(' · '));
    out.trace = { id: pid, name: p[0], seasonPts: projPts(seasonProj, pid), rosPts: rosProj ? projPts(rosProj, pid) : null, vorp: raw.get(pid), scaled: scaledPreAge.get(pid), fc: market[pid], base: healthy.get(pid), final: final.get(pid), finalRank: posRank(final, pid), marketRank: marketPosRank(pid) };
  } else console.log(`\ntrace: player "${PLAYER}" not found in slim dict`);

  // ---- top WRs: market vs model --------------------------------------------------
  const topWR = Object.keys(market).filter(id => slim[id] && slim[id][1] === 'WR').sort((a, b) => market[b] - market[a]).slice(0, 20);
  console.log('\ntop-20 WRs by market: market rank → model rank (final value, fc normalised)');
  topWR.forEach(id => {
    const p = slim[id];
    console.log(`  ${lpad(marketPosRank(id), 3)} → ${lpad(posRank(final, id), 3)}  ${pad(p[0], 24)} ${pad(p[2], 4)} ${pad(p[3] || '', 12)} age ${p[4]}  final ${lpad(final.get(id), 5)}  fc ${lpad(fcNorm(id), 5)}  seasonProj ${lpad(projPts(seasonProj, id).toFixed(0), 4)}${rosProj ? '  ros ' + lpad(projPts(rosProj, id).toFixed(0), 4) : ''}`);
  });

  // ---- correlation / bias -----------------------------------------------------------
  const sample = Object.keys(market).filter(id => slim[id] && SKILL[slim[id][1]]);
  const gamesPlayed = id => { if (!recent || !recent.weeks) return null; return recent.weeks.filter(w => recent.stats[w][id] && (Number(recent.stats[w][id].gp) > 0 || recent.stats[w][id].pts_ppr != null)).length; };
  const ratio = id => { const fc = fcNorm(id), v = final.get(id) || 0; return fc > 0 ? v / fc : null; };
  // Per-player dump (--json): every market player with model vs market position
  // rank, so outliers in either direction can be listed offline.
  out.players = sample.map(id => ({
    id, name: slim[id][0], pos: slim[id][1], team: slim[id][2], status: slim[id][3] || null, age: slim[id][4],
    seasonPts: Math.round(projPts(seasonProj, id) * 10) / 10, rosPts: rosProj ? Math.round(projPts(rosProj, id) * 10) / 10 : null,
    vorp: Math.round((raw.get(id) || 0) * 10) / 10, scaled: scaledPreAge.get(id) || 0, base: healthy.get(id) || 0,
    injMult: INJ_MODE === 'none' ? 1 : Fit.injuryMult(slim[id][3], injOpts),
    formMult: form.get(id) ? form.get(id).mult : 1, playoffMult: playoff.get(id) ? playoff.get(id).mult : 1,
    final: final.get(id) || 0, fc: market[id], fcNorm: fcNorm(id),
    modelRank: posRank(final, id), marketRank: marketPosRank(id), games: gamesPlayed(id),
  }));
  console.log('\nSpearman(final, market) and median model/market ratio by position (top market players)');
  out.byPos = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const ids = sample.filter(id => slim[id][1] === pos);
    const rho = spearman(ids.map(id => final.get(id) || 0), ids.map(id => market[id]));
    const rs = ids.map(ratio).filter(x => x != null);
    out.byPos[pos] = { n: ids.length, rho, medianRatio: median(rs) };
    console.log(`  ${pos}  n=${lpad(ids.length, 3)}  rho=${f2(rho)}  median ratio=${f2(median(rs))}`);
  }
  const all = spearman(sample.map(id => final.get(id) || 0), sample.map(id => market[id]));
  out.rhoAll = all;
  console.log(`  ALL n=${sample.length}  rho=${f2(all)}`);

  function bucketReport(title, keyFn, order) {
    const groups = {};
    sample.forEach(id => { const k = keyFn(id); if (k == null) return; (groups[k] || (groups[k] = [])).push(id); });
    console.log(`\n${title}: n, median model/market ratio, mean (model rank − market rank) within position`);
    const res = {};
    (order || Object.keys(groups)).forEach(k => {
      const ids = groups[k]; if (!ids || !ids.length) return;
      const rs = ids.map(ratio).filter(x => x != null);
      const dr = ids.map(id => posRank(final, id) - marketPosRank(id));
      res[k] = { n: ids.length, medianRatio: median(rs), meanRankDelta: mean(dr) };
      console.log(`  ${pad(k, 22)} n=${lpad(ids.length, 3)}  ratio ${f2(median(rs))}  rankΔ ${lpad(f2(mean(dr)), 6)}`);
    });
    return res;
  }
  out.byAge = bucketReport('age bucket', id => { const a = slim[id][4]; return a == null ? 'unknown' : a <= 24 ? '≤24' : a <= 27 ? '25–27' : a <= 29 ? '28–29' : '30+'; }, ['≤24', '25–27', '28–29', '30+', 'unknown']);
  out.byStatus = bucketReport('injury status', id => slim[id][3] ? String(slim[id][3]).replace(/\.$/, '') : 'healthy', ['healthy', 'Questionable', 'Doubtful', 'Out', 'IR', 'PUP', 'Sus', 'NA']);
  if (recent && recent.weeks) out.byGames = bucketReport(`games with a stat line in weeks ${recent.weeks.join('/')}`, id => { const g = gamesPlayed(id); return g == null ? null : g + ' of ' + recent.weeks.length; });
  const WR_AGE = sample.filter(id => slim[id][1] === 'WR');
  out.wrByAge = {};
  console.log('\nWR only, by age: median ratio');
  [['≤24', a => a <= 24], ['25–27', a => a >= 25 && a <= 27], ['28–29', a => a >= 28 && a <= 29], ['30+', a => a >= 30]].forEach(([k, fn]) => {
    const ids = WR_AGE.filter(id => slim[id][4] != null && fn(slim[id][4]));
    const rs = ids.map(ratio).filter(x => x != null);
    out.wrByAge[k] = { n: ids.length, medianRatio: median(rs) };
    console.log(`  ${pad(k, 8)} n=${lpad(ids.length, 3)} ratio ${f2(median(rs))}`);
  });

  // ---- missing / zero / outlier-low ---------------------------------------------------
  // The model/market ratio bottoms out at the blend's market weight (0.30
  // redraft) for anyone below the VORP replacement line, so "low" is read on
  // position rank: model rank ≥ 8 places below market rank, or value 0/null,
  // or a top-200 market player the model can't see at all.
  const top200 = Object.keys(market).sort((a, b) => market[b] - market[a]).slice(0, 200);
  const belowRepl = top200.filter(id => slim[id] && SKILL[slim[id][1]] && !(raw.get(id) > 0)).length;
  console.log(`\ntop-200 market: ${belowRepl} players sit below the VORP replacement line (value = ${fmt.dynasty ? 0.5 : 0.3} × market by construction)`);
  console.log('top-200 market players the model ranks ≥ 8 places below market, or values null/zero');
  out.low = [];
  top200.forEach(id => {
    if (!slim[id]) { console.log(`  ${id}: in market feed but NOT in slim dict (fc ${market[id]})`); out.low.push({ id, reason: 'not in slim' }); return; }
    const v = final.get(id), r = ratio(id);
    const noProj = !proj[id] || !(projPts(proj, id) > 0);
    const dr = posRank(final, id) - marketPosRank(id);
    if (v == null || v === 0 || dr >= 8) {
      const p = slim[id];
      console.log(`  ${pad(p[0], 24)} ${pad(p[1], 3)} ${pad(p[2], 4)} ${pad(p[3] || '', 12)} age ${lpad(p[4], 2)}  mkt #${lpad(marketPosRank(id), 2)} → model #${lpad(posRank(final, id), 2)}  final ${lpad(v == null ? 'null' : v, 5)}  fc ${lpad(fcNorm(id), 5)}  ratio ${f2(r)}  ${noProj ? 'NO PROJECTION' : 'proj ' + projPts(proj, id).toFixed(0)}  seasonProj ${projPts(seasonProj, id).toFixed(0)}  games ${gamesPlayed(id)}`);
      out.low.push({ id, name: p[0], pos: p[1], status: p[3], final: v, fc: fcNorm(id), ratio: r, rankDelta: dr, noProj });
    }
  });
  if (!out.low.length) console.log('  none');
  // Reverse direction: players the model values but the market feed lacks keep
  // 100% VORP (blendWithMarket passes them through), so a player just off FC's
  // ~200-row list is worth more than the same VORP on the list would be.
  const offList = [...scaled.entries()].filter(([id, v]) => v >= 800 && market[id] == null && slim[id]).sort((a, b) => b[1] - a[1]);
  console.log(`\nplayers with rescaled VORP ≥ 800 but absent from the market feed (kept at 100% VORP): ${offList.length}`);
  offList.slice(0, 15).forEach(([id, v]) => console.log(`  ${pad(slim[id][0], 24)} ${slim[id][1]} ${slim[id][2]} ${slim[id][3] || ''}  vorp ${v}  final ${final.get(id)}`));
  out.offList = offList.map(([id, v]) => ({ id, name: slim[id][0], vorp: v }));

  // ---- consolidation trades -----------------------------------------------------------
  const byPosRank = {};
  ['QB', 'RB', 'WR', 'TE'].forEach(pos => { byPosRank[pos] = Object.keys(market).filter(id => slim[id] && slim[id][1] === pos).sort((a, b) => market[b] - market[a]); });
  const name = id => slim[id][0];
  const trades = [
    ['WR1 for WR6 + WR12', [byPosRank.WR[0]], [byPosRank.WR[5], byPosRank.WR[11]]],
    ['WR1 for WR8 + WR15 + WR25', [byPosRank.WR[0]], [byPosRank.WR[7], byPosRank.WR[14], byPosRank.WR[24]]],
    ['RB1 for RB5 + RB12', [byPosRank.RB[0]], [byPosRank.RB[4], byPosRank.RB[11]]],
    ['RB3 for WR10 + RB18', [byPosRank.RB[2]], [byPosRank.WR[9], byPosRank.RB[17]]],
    ['WR5 for WR20 + WR30 + WR40', [byPosRank.WR[4]], [byPosRank.WR[19], byPosRank.WR[29], byPosRank.WR[39]]],
    ['QB1 for QB8 + WR15', [byPosRank.QB[0]], [byPosRank.QB[7], byPosRank.WR[14]]],
    ['TE1 for TE6 + WR25', [byPosRank.TE[0]], [byPosRank.TE[5], byPosRank.WR[24]]],
    [`${PLAYER} for WR20`, pid ? [pid] : [], pid ? [byPosRank.WR[19]] : []],
    [`${PLAYER} for WR12`, pid ? [pid] : [], pid ? [byPosRank.WR[11]] : []],
  ].filter(t => t[1].length && t[2].length && t[1].every(Boolean) && t[2].every(Boolean));
  console.log('\nconsolidation trades (give → receive): model verdict vs plain FantasyCalc sum');
  out.trades = [];
  trades.forEach(([label, give, recv]) => {
    const r = Scoring.evaluateTrade(give, recv, final);
    const fcG = give.reduce((s, id) => s + market[id], 0), fcR = recv.reduce((s, id) => s + market[id], 0);
    const fcPct = (fcR - fcG) / Math.max(fcG, fcR, 1);
    console.log(`  ${pad(label, 28)} ${give.map(name).join(' + ')}  →  ${recv.map(name).join(' + ')}`);
    console.log(`  ${pad('', 28)} model ${r.giverValue} vs ${r.receiverValue} → ${r.verdict} (${(r.deltaPct * 100).toFixed(1)}%)   fc-sum ${fcG} vs ${fcR} (${(fcPct * 100).toFixed(1)}%)`);
    out.trades.push({ label, give: give.map(name), recv: recv.map(name), model: r, fcPct });
  });

  // ---- bench slot factors on a synthetic roster -----------------------------------------
  const roster = ['QB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'WR', 'WR', 'TE'].map((pos, i) => byPosRank[pos][[3, 4, 12, 20, 6, 14, 22, 30, 38, 4][i]]).filter(Boolean);
  const ctx = { roster, give: [], recv: [byPosRank.WR[45]], players: slim, vorp: final, rosterPositions: league.roster_positions };
  const sl = Fit.slotFactors('recv', ctx);
  console.log(`\nslot factor: receiving ${name(byPosRank.WR[45])} (WR46) onto a 5-WR roster → ${JSON.stringify(sl[byPosRank.WR[45]])}`);

  if (JSON_OUT) { require('fs').writeFileSync(JSON_OUT, JSON.stringify(out, null, 2)); console.log('\nwrote ' + JSON_OUT); }
})().catch(e => { console.error(e); process.exit(1); });
