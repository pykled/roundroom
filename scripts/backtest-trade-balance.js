#!/usr/bin/env node
// Trade-balance backtest: is the value SCALE right for N-for-M trades?
//
//   node scripts/backtest-trade-balance.js [--dir=/tmp/balance/bt] [--json=out.json]
//        [--trades=300] [--horizon=4]
//
// Inputs in --dir (see scripts/backtest-trade-value.js --fetch for the layout):
//   proj-YYYY-W.json / stats-YYYY-W.json  Sleeper weekly projections (final
//                                        pre-kickoff version) and actuals
//   fc_1qb.json                          FantasyCalc 1-QB redraft list (today)
//   slim.json                            /api/players/slim
//   inj-wkW.json                         data/injuries.json before week W kickoff
//
// Everything is no-hindsight: at T0 = week k the model sees only the week-k
// projection (week k+1 for a bye), statuses before Thursday, and the market as
// FantasyCalc's value − trend30Day (only valid for the T0 that is 30 days ago).
//
// Part A  per-player value curve: bucket players by model rank at T0 and compare
//         the model's value share per bucket with the realized VORP share over
//         the next `horizon` weeks, for VORP exponents 1.0 / 1.25 / 1.5 and a
//         deeper replacement line. Answers "how steep should the curve be?"
// Part B  synthetic trades (1-1, 2-1, 3-1, 2-2, 3-2) scored on realized VORP:
//         sign accuracy, calibration slope and the lean toward the single-player
//         side per candidate. Answers "does the calc favour consolidation?"
// Part C  same trades at the one T0 with a market point (value − trend30Day),
//         production chain vs exponents vs market-only vs FC+waiver.
// Part D  fresh-injury class: players who played last week but have a zero /
//         missing projection this week (no timeline yet) — what they produced
//         over the next 4 and 8 weeks relative to their pre-injury projection.
'use strict';

const fs = require('fs');
const path = require('path');
const Scoring = require('../shared/scoring.js');
const Lineup = require('../shared/lineup.js');
global.LineupOptimizer = Lineup;
const Fit = require('../shared/trade-fit.js');

const args = process.argv.slice(2);
const arg = (n, d) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const DIR = arg('dir', '/tmp/balance/bt');
const JSON_OUT = arg('json', null);
const TRADES = Number(arg('trades', 300));
const HORIZON = Number(arg('horizon', 4));
const SKILL = { QB: 1, RB: 1, WR: 1, TE: 1 };
const POS = ['QB', 'RB', 'WR', 'TE'];
const PTS = 'pts_ppr';
const STARTERS = { QB: 1, RB: 2.5, WR: 3.5, TE: 1 };     // 12-team 1QB, FLEX split ½ RB ½ WR
const SF_QB = 2;                                         // superflex: a second QB starter
let SF = false;
const replRank = (pos, depth) => Math.round(12 * (pos === 'QB' && SF ? SF_QB : STARTERS[pos]) * depth);
const QB_DEPTHS = [1.125, 1.25, 1.5];                    // QB replacement deeper, other positions at 1×
const REPL = { get QB() { return replRank('QB', 1); }, get RB() { return replRank('RB', 1); }, get WR() { return replRank('WR', 1); }, get TE() { return replRank('TE', 1); } };
const DEPTHS = [1, 1.25, 1.5, 2];

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const median = a => { const s = a.slice().sort((p, q) => p - q); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const f2 = x => Number.isFinite(x) ? x.toFixed(2) : 'n/a';
const f3 = x => Number.isFinite(x) ? x.toFixed(3) : 'n/a';
const pct = x => Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'n/a';
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
const lpad = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
let seed = 20261110;
function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
function ols(xs, ys) { const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } const b = sxx ? sxy / sxx : NaN; return { slope: b, intercept: my - b * mx }; }
function readJSON(f) { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
function tryRead(f) { try { return readJSON(f); } catch (e) { return null; } }
function rowsToDict(rows) {
  const out = {};
  (rows || []).forEach(r => { if (r && r.player_id && r.stats) out[r.player_id] = Object.assign({}, r.stats, { __team: r.team, __opp: r.opponent, __pos: r.player && r.player.position }); });
  return out;
}
const played = s => s && (Number(s.gp) > 0 || (s[PTS] != null && Number(s[PTS]) !== 0));

function loadSeason(year, weeks) {
  const proj = {}, stats = {}, byeTeams = {};
  weeks.forEach(w => {
    proj[w] = rowsToDict(tryRead(`proj-${year}-${w}.json`)); stats[w] = rowsToDict(tryRead(`stats-${year}-${w}.json`));
    // Every team has rows every week (deep bench players carry no opponent), so
    // "has a game" = at least one row for the team names an opponent.
    const teams = new Set(Object.values(proj[w]).filter(r => r.__opp).map(r => r.__team).filter(Boolean));
    byeTeams[w] = teams;   // teams WITH a game; a team absent here is on bye
  });
  return { year, proj, stats, byeTeams, weeks };
}
function statusAt(injFile, slim) {
  const inj = tryRead(injFile); const out = {};
  if (!inj || !inj.players) return out;
  const byKey = {};
  Object.keys(slim).forEach(id => { const p = slim[id]; if (SKILL[p[1]]) byKey[(p[0] + '|' + p[1]).toLowerCase()] = id; });
  inj.players.forEach(p => { const id = byKey[(p.name + '|' + p.position).toLowerCase()]; if (id && p.status) out[id] = String(p.status).replace(/\.$/, ''); });
  return out;
}

// ---- T0 snapshot ------------------------------------------------------------
// Per-game projection at week k: the week-k final row, or week k+1 for a bye
// (team has no week-k rows at all). A player ruled out for week k (row = 0)
// is "inactive at T0" — tracked separately, not valued.
function snapshot(season, k, slim) {
  const pg = {}, inactive = [];
  Object.keys(slim).forEach(id => {
    const pos = slim[id][1]; if (!SKILL[pos]) return;
    const r = season.proj[k][id];
    const next = season.proj[k + 1] && season.proj[k + 1][id];
    const team = (r && r.__team) || (next && next.__team) || null;
    const bye = !!(team && season.byeTeams[k] && !season.byeTeams[k].has(team));
    let v = r ? Number(r[PTS]) || 0 : 0;
    if (bye) v = next ? Number(next[PTS]) || 0 : 0;
    if (v > 0) pg[id] = v; else if (played(season.stats[k - 1] && season.stats[k - 1][id])) inactive.push(id);
  });
  return { pg, inactive };
}
// realized over [k, k+h-1]: total points, games, and VORP (truncated and raw)
function realize(season, k, h, pool, slim, byPos) {
  const weeks = []; for (let w = k; w < k + h; w++) if (season.stats[w] && Object.keys(season.stats[w]).length) weeks.push(w);
  const tot = {}, games = {};
  pool.forEach(id => { let t = 0, g = 0; weeks.forEach(w => { const s = season.stats[w][id]; if (played(s)) { t += Number(s[PTS]) || 0; g++; } }); tot[id] = t; games[id] = g; });
  // baseline A: realized rank-N total (what the earlier study used; biased UP by
  // selection, since the realized ranking picks up the lucky players)
  // baseline B: mean realized total of the players PROJECTED at ranks N−2…N+2
  // at T0 — an unbiased estimate of what a replacement-level player produced
  const repl = {}, replP = {};
  POS.forEach(pos => {
    const s = pool.filter(id => slim[id][1] === pos).map(id => tot[id]).sort((a, b) => b - a); repl[pos] = s[REPL[pos]] || 0;
    const around = (byPos && byPos[pos] ? byPos[pos].slice(Math.max(0, REPL[pos] - 2), REPL[pos] + 3) : []).map(id => tot[id] || 0);
    replP[pos] = around.length ? mean(around) : repl[pos];
  });
  const vTrunc = {}, vRaw = {}, vTruncP = {}, vRawP = {}, vLA = {};
  // lineup-aware: a missed game is a 0 (you start someone else), not −replacement;
  // a projected starter's played games count raw; a projected bench player's
  // window is truncated at 0 (he only plays when he is the better option).
  const projRank = {}; if (byPos) POS.forEach(pos => byPos[pos].forEach((id, i) => { projRank[id] = i + 1; }));
  pool.forEach(id => {
    const pos = slim[id][1]; const d = tot[id] - repl[pos]; vRaw[id] = d; vTrunc[id] = Math.max(0, d);
    const e = tot[id] - replP[pos]; vRawP[id] = e; vTruncP[id] = Math.max(0, e);
    const perGame = weeks.length ? replP[pos] / weeks.length : 0;
    const la = tot[id] - perGame * games[id];
    vLA[id] = (projRank[id] || Infinity) > REPL[pos] ? Math.max(0, la) : la;
  });
  return { weeks, tot, games, repl, replP, vTrunc, vRaw, vTruncP, vRawP, vLA };
}
// value maps for the model-only candidates from a per-game projection
function modelValues(pg, slim) {
  const ids = Object.keys(pg);
  const byPos = {}; POS.forEach(p => { byPos[p] = ids.filter(id => slim[id][1] === p).sort((a, b) => pg[b] - pg[a]); });
  const vorpAt = {};
  DEPTHS.forEach(d => {
    const rp = {}; POS.forEach(p => { const r = replRank(p, d); rp[p] = byPos[p][r] ? pg[byPos[p][r]] : 0; });
    vorpAt[d] = {}; ids.forEach(id => { vorpAt[d][id] = Math.max(0, pg[id] - rp[slim[id][1]]); });
  });
  QB_DEPTHS.forEach(d => {
    const rp = {}; POS.forEach(p => { const r = replRank(p, p === 'QB' ? d : 1); rp[p] = byPos[p][r] ? pg[byPos[p][r]] : 0; });
    vorpAt['qb' + d] = {}; ids.forEach(id => { vorpAt['qb' + d][id] = Math.max(0, pg[id] - rp[slim[id][1]]); });
  });
  const scale = (src, e) => { let mx = 0; const pw = {}; ids.forEach(id => { pw[id] = Math.pow(src[id], e); if (pw[id] > mx) mx = pw[id]; }); const m = new Map(); ids.forEach(id => m.set(id, mx > 0 ? Math.round(pw[id] / mx * 10000) : 0)); return m; };
  const cands = {
    '^1.0': scale(vorpAt[1], 1.0), '^1.25 (prod)': scale(vorpAt[1], 1.25), '^1.5': scale(vorpAt[1], 1.5),
    'repl×1.25 ^1.25': scale(vorpAt[1.25], 1.25),
    'repl×1.5 ^1.0': scale(vorpAt[1.5], 1.0), 'repl×1.5 ^1.25': scale(vorpAt[1.5], 1.25),
    'repl×2 ^1.25': scale(vorpAt[2], 1.25),
    'QB×1.125 ^1.25': scale(vorpAt['qb1.125'], 1.25), 'QB×1.25 ^1.25': scale(vorpAt['qb1.25'], 1.25), 'QB×1.5 ^1.25': scale(vorpAt['qb1.5'], 1.25),
    'QB×1.125 ^1.0 (new)': scale(vorpAt['qb1.125'], 1.0),
    'raw proj pts': (() => { const m = new Map(); let mx = Math.max(...ids.map(id => pg[id])); ids.forEach(id => m.set(id, Math.round(pg[id] / mx * 10000))); return m; })(),
  };
  return { cands, vorp: vorpAt[1], byPos, ids };
}

// ---- Part A: value curve by bucket -------------------------------------------
const BUCKETS = [[1, 12], [13, 24], [25, 48], [49, 72], [73, 96], [97, 120], [121, 150], [151, 200]];
function partA(seasons, slim, horizon) {
  console.log(`\n==== Part A · value share by model-rank bucket vs realized VORP share, next ${horizon} weeks (12-team 1QB PPR, pooled T0s) ====`);
  const acc = {};   // cand → bucket → [sum value, sum real, n]
  const keys = ['^1.0', '^1.25 (prod)', '^1.5', 'repl×1.25 ^1.25', 'repl×1.5 ^1.0', 'repl×1.5 ^1.25', 'repl×2 ^1.25', 'raw proj pts'];
  const realKeys = ['real VORP (trunc)', 'real VORP (raw)', 'real VORP projBase (trunc)', 'real VORP projBase (raw)', 'real pts'];
  const floorStat = { n: 0, real: 0, realRaw: 0, top: 0, topN: 0, games: 0 };
  let t0s = 0;
  seasons.forEach(season => {
    season.weeks.forEach(k => {
      if (k < 3 || k + horizon - 1 > season.lastStats) return;
      const snap = snapshot(season, k, slim);
      const mv = modelValues(snap.pg, slim);
      const rz = realize(season, k, horizon, mv.ids, slim, mv.byPos);
      t0s++;
      // rank by production value (ranking is exponent-invariant)
      const ranked = mv.ids.slice().sort((a, b) => (mv.cands['^1.25 (prod)'].get(b) || 0) - (mv.cands['^1.25 (prod)'].get(a) || 0));
      const rankOf = {}; ranked.forEach((id, i) => { rankOf[id] = i + 1; });
      // deep-repl ranking differs slightly (its own ranks)
      ranked.forEach(id => {
        const r = rankOf[id];
        const b = BUCKETS.findIndex(([lo, hi]) => r >= lo && r <= hi); if (b < 0) return;
        keys.forEach(key => { const a = acc[key] || (acc[key] = BUCKETS.map(() => [0, 0])); a[b][0] += mv.cands[key].get(id) || 0; a[b][1]++; });
        const ra = acc['real VORP (trunc)'] || (acc['real VORP (trunc)'] = BUCKETS.map(() => [0, 0])); ra[b][0] += rz.vTrunc[id]; ra[b][1]++;
        const rb = acc['real VORP (raw)'] || (acc['real VORP (raw)'] = BUCKETS.map(() => [0, 0])); rb[b][0] += rz.vRaw[id]; rb[b][1]++;
        const rc = acc['real pts'] || (acc['real pts'] = BUCKETS.map(() => [0, 0])); rc[b][0] += rz.tot[id]; rc[b][1]++;
        const rd = acc['real VORP projBase (trunc)'] || (acc['real VORP projBase (trunc)'] = BUCKETS.map(() => [0, 0])); rd[b][0] += rz.vTruncP[id]; rd[b][1]++;
        const re = acc['real VORP projBase (raw)'] || (acc['real VORP projBase (raw)'] = BUCKETS.map(() => [0, 0])); re[b][0] += rz.vRawP[id]; re[b][1]++;
      });
      // floor: below-replacement players among the top-200 by projection
      ranked.slice(0, 200).forEach(id => { if (mv.vorp[id] === 0) { floorStat.n++; floorStat.real += rz.vTrunc[id]; floorStat.realRaw += rz.vRaw[id]; floorStat.games += rz.games[id]; } });
      ranked.slice(0, 12).forEach(id => { floorStat.top += rz.vTrunc[id]; floorStat.topN++; });
    });
  });
  console.log(`  ${t0s} T0 weeks pooled. Each row = mean per player in the bucket, as a share of the top-12 bucket (so the curve shape is comparable).`);
  console.log('  ' + pad('candidate', 28) + BUCKETS.map(([lo, hi]) => lpad(lo + '-' + hi, 8)).join(''));
  const out = {};
  keys.concat(realKeys).forEach(key => {
    const a = acc[key]; if (!a) return;
    const means = a.map(([s, n]) => n ? s / n : NaN); const top = means[0];
    out[key] = means.map(m => m / top);
    console.log('  ' + pad(key, 28) + means.map(m => lpad(f2(m / top), 8)).join('') + (key.startsWith('real') ? `   (top-12 mean ${means[0].toFixed(1)} pts)` : ''));
  });
  console.log(`  below-replacement players in the projection top-200 (value 0 on the model half): n=${floorStat.n}, mean realized VORP(trunc) ${f2(floorStat.real / floorStat.n)} = ${pct(floorStat.real / floorStat.n / (floorStat.top / floorStat.topN))} of the top-12 mean (${f2(floorStat.top / floorStat.topN)}); raw ${f2(floorStat.realRaw / floorStat.n)}; games/${horizon} ${f2(floorStat.games / floorStat.n)}`);
  return { t0s, shares: out, floor: floorStat };
}

// ---- Part B: synthetic trades --------------------------------------------------
const SHAPES = [
  { name: '1-for-1', g: 1, r: 1, bandG: [1, 120], bandR: [1, 120], maxGap: 40 },
  { name: '2-for-1', g: 2, r: 1, bandG: [8, 120], bandR: [1, 40] },
  { name: '3-for-1', g: 3, r: 1, bandG: [12, 150], bandR: [1, 30] },
  { name: '2-for-2', g: 2, r: 2, bandG: [1, 120], bandR: [1, 120] },
  { name: '3-for-2', g: 3, r: 2, bandG: [8, 150], bandR: [1, 80] },
];
function pickN(ranked, band, n, exclude) {
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < 1000) {
    const r = band[0] + Math.floor(rnd() * (band[1] - band[0] + 1));
    const id = ranked[r - 1]; if (!id || out.includes(id) || exclude.includes(id)) continue;
    out.push(id);
  }
  return out;
}
function makeTrades(ranked, n) {
  const trades = [];
  SHAPES.forEach(sh => {
    for (let i = 0; i < n; i++) {
      const recv = pickN(ranked, sh.bandR, sh.r, []);
      let give = pickN(ranked, sh.bandG, sh.g, recv);
      if (sh.maxGap) { const rr = ranked.indexOf(recv[0]); give = []; let guard = 0; while (!give.length && guard++ < 200) { const lo = Math.max(1, rr + 1 - sh.maxGap), hi = Math.min(ranked.length, rr + 1 + sh.maxGap); const g = pickN(ranked, [lo, hi], 1, recv); if (g.length) give = g; } }
      if (give.length === sh.g && recv.length === sh.r) trades.push({ shape: sh.name, give, recv });
    }
  });
  return trades;
}
const delta = (g, r) => (r - g) / Math.max(Math.abs(g), Math.abs(r), 1);
function posPairs(trades, cands, real, slim, idOf) {
  // 1-for-1 only: bias when a QB or TE is on one side (recv = the QB/TE side)
  const ts = trades.filter(t => t.shape === '1-for-1');
  const out = {};
  console.log('  1-for-1 position pairs — recv side holds the named position: pred>0 / real>0 = share of trades where that side wins, acc(dec)');
  console.log('  ' + pad('pair', 12) + Object.keys(cands).map(c => lpad(c, 22)).join(''));
  [['QB-vs-skill', 'QB'], ['TE-vs-skill', 'TE'], ['RB-vs-WR', 'RB']].forEach(([label, pos]) => {
    const other = pos === 'RB' ? { WR: 1 } : { RB: 1, WR: 1, TE: pos === 'QB' ? 1 : 0 };
    const sel = [];
    ts.forEach(t => {
      const pg = slim[idOf(t.give[0])][1], pr = slim[idOf(t.recv[0])][1];
      if (pr === pos && other[pg]) sel.push({ a: t.give[0], b: t.recv[0] });
      else if (pg === pos && other[pr]) sel.push({ a: t.recv[0], b: t.give[0] });
    });
    const row = {};
    const line = Object.keys(cands).map(ck => {
      const m = cands[ck]; let pp = 0, rp = 0, dec = 0, ok = 0;
      sel.forEach(s => { const p = delta(m.get(s.a) || 0, m.get(s.b) || 0), r = delta(real[s.a] || 0, real[s.b] || 0); if (p > 0) pp++; if (r > 0) rp++; if (Math.abs(p) > 0.1) { dec++; if (r !== 0 && Math.sign(p) === Math.sign(r)) ok++; } });
      row[ck] = { n: sel.length, predPos: pp / sel.length, realPos: rp / sel.length, accDec: ok / Math.max(dec, 1) };
      return lpad(`${pct(pp / sel.length)}/${pct(rp / sel.length)} ${pct(ok / Math.max(dec, 1))}`, 22);
    }).join('');
    out[label] = row;
    console.log('  ' + pad(label + ' n=' + sel.length, 12) + line);
  });
  return out;
}
function scoreTrades(trades, cands, real, label) {
  // orientation: for N-for-1 shapes "recv" is the single player, so delta > 0 = single side wins
  const res = {};
  const shapes = [...new Set(trades.map(t => t.shape))];
  console.log(`  ${label}`);
  console.log('  ' + pad('shape', 9) + pad('candidate', 24) + lpad('n', 6) + lpad('acc(dec)', 10) + lpad('acc(all)', 10) + lpad('pred>0', 8) + lpad('real>0', 8) + lpad('mean pred', 11) + lpad('mean real', 11) + lpad('slope', 7) + lpad('FAIR n', 8) + lpad('real|FAIR', 11) + lpad('WIN→real', 10) + lpad('LOSE→real', 11));
  shapes.forEach(shape => {
    const ts = trades.filter(t => t.shape === shape);
    res[shape] = {};
    Object.keys(cands).forEach(ck => {
      const m = cands[ck];
      const pred = [], rl = [];
      ts.forEach(t => {
        const g = t.give.reduce((s, id) => s + (m.get(id) || 0), 0), r = t.recv.reduce((s, id) => s + (m.get(id) || 0), 0);
        const rg = t.give.reduce((s, id) => s + (real[id] || 0), 0), rr = t.recv.reduce((s, id) => s + (real[id] || 0), 0);
        pred.push(delta(g, r)); rl.push(delta(rg, rr));
      });
      let dec = 0, decOk = 0, allOk = 0, fairN = 0, fairReal = 0, winN = 0, winReal = 0, loseN = 0, loseReal = 0;
      for (let i = 0; i < pred.length; i++) {
        if (rl[i] !== 0 && Math.sign(pred[i]) === Math.sign(rl[i])) allOk++;
        if (Math.abs(pred[i]) > 0.10) { dec++; if (rl[i] !== 0 && Math.sign(pred[i]) === Math.sign(rl[i])) decOk++; if (pred[i] > 0) { winN++; winReal += rl[i]; } else { loseN++; loseReal += rl[i]; } }
        else { fairN++; fairReal += rl[i]; }
      }
      const fit = ols(pred, rl);
      const row = { n: ts.length, accDec: decOk / Math.max(dec, 1), accAll: allOk / ts.length, predPos: pred.filter(x => x > 0).length / pred.length, realPos: rl.filter(x => x > 0).length / rl.length, meanPred: mean(pred), meanReal: mean(rl), slope: fit.slope, fairN, fairReal: fairReal / Math.max(fairN, 1), winReal: winReal / Math.max(winN, 1), loseReal: loseReal / Math.max(loseN, 1) };
      res[shape][ck] = row;
      console.log('  ' + pad(shape, 9) + pad(ck, 24) + lpad(ts.length, 6) + lpad(pct(row.accDec), 10) + lpad(pct(row.accAll), 10) + lpad(pct(row.predPos), 8) + lpad(pct(row.realPos), 8) + lpad(f3(row.meanPred), 11) + lpad(f3(row.meanReal), 11) + lpad(f2(row.slope), 7) + lpad(fairN, 8) + lpad(f3(row.fairReal), 11) + lpad(f3(row.winReal), 10) + lpad(f3(row.loseReal), 11));
    });
  });
  return res;
}
function partB(seasons, slim, horizon) {
  console.log(`\n==== Part B · synthetic trades scored on realized VORP (truncated), next ${horizon} weeks, model-only candidates, pooled T0s ====`);
  console.log('  For 2-for-1 / 3-for-1 the "recv" side is the single player: delta > 0 = the consolidating side wins. acc(dec) = sign accuracy on |pred| > 10 %;');
  console.log('  pred>0 vs real>0 = how often each says the single side wins; slope = OLS of realized delta on predicted; real|FAIR = mean realized delta on FAIR calls (should be ~0).');
  seed = 20261110;
  const all = []; const allRaw = {}, allRawNeg = {}, allTruncP = {}, allRawP = {}, allLA = {}; const idOf = {};
  const candsAll = {};
  seasons.forEach(season => {
    season.weeks.forEach(k => {
      if (k < 3 || k + horizon - 1 > season.lastStats) return;
      const snap = snapshot(season, k, slim);
      const mv = modelValues(snap.pg, slim);
      const rz = realize(season, k, horizon, mv.ids, slim, mv.byPos);
      const ranked = mv.ids.slice().sort((a, b) => (mv.cands['^1.25 (prod)'].get(b) || 0) - (mv.cands['^1.25 (prod)'].get(a) || 0)).slice(0, 200);
      const tag = season.year + 'w' + k + ':';
      makeTrades(ranked, TRADES).forEach(t => { all.push({ shape: t.shape, give: t.give.map(id => tag + id), recv: t.recv.map(id => tag + id) }); });
      Object.keys(mv.cands).forEach(ck => { const m = candsAll[ck] || (candsAll[ck] = new Map()); mv.cands[ck].forEach((v, id) => m.set(tag + id, v)); });
      Object.keys(rz.vTrunc).forEach(id => { allRaw[tag + id] = rz.vTrunc[id]; allRawNeg[tag + id] = rz.vRaw[id]; allTruncP[tag + id] = rz.vTruncP[id]; allRawP[tag + id] = rz.vRawP[id]; allLA[tag + id] = rz.vLA[id]; idOf[tag + id] = id; });
    });
  });
  const few = {}; ['^1.0', '^1.25 (prod)', '^1.5', 'repl×1.25 ^1.25', 'repl×1.5 ^1.25', 'repl×2 ^1.25', 'QB×1.125 ^1.25', 'QB×1.25 ^1.25', 'QB×1.5 ^1.25', 'QB×1.125 ^1.0 (new)'].forEach(k => { few[k] = candsAll[k]; });
  const sub = all.filter(t => t.shape !== '2-for-2');
  const trunc = scoreTrades(all, candsAll, allRaw, `${all.length} trades · realized VORP truncated at 0 per player, replacement = realized rank-N total`);
  const pairs = posPairs(all, candsAll, allRaw, slim, k => idOf[k]);
  const truncP = scoreTrades(sub, few, allTruncP, `${sub.length} trades · realized VORP truncated, replacement = mean of players PROJECTED at ranks N−2…N+2 (unbiased)`);
  const pairsP = posPairs(all, few, allTruncP, slim, k => idOf[k]);
  const rawP = scoreTrades(sub, few, allRawP, `${sub.length} trades · realized VORP RAW (negative allowed), projected-rank replacement`);
  const pairsRawP = posPairs(all, few, allRawP, slim, k => idOf[k]);
  const la = scoreTrades(sub, few, allLA, `${sub.length} trades · realized LINEUP-AWARE VORP (missed games = 0, projected starters raw, projected bench truncated), projected-rank replacement`);
  const pairsLA = posPairs(all, few, allLA, slim, k => idOf[k]);
  return { trunc, pairs, truncP, pairsP, rawP, pairsRawP, la, pairsLA };
}

// ---- Part C: one T0 with a market point ----------------------------------------
function partC(season, k, slim, horizon, fcFile) {
  seed = 20261110;
  console.log(`\n==== Part C · ${season.year} T0 = week ${k} with the market (${fcFile}: value − trend30Day), realized weeks ${k}–${k + horizon - 1}${SF ? ' · SUPERFLEX' : ''} ====`);
  const fc = readJSON(fcFile);
  const marketT0 = {};
  fc.forEach(r => { const id = r.player && r.player.sleeperId; if (!id) return; const v = r.value - (r.trend30Day || 0); if (v > 0) marketT0[id] = v; });
  const snap = snapshot(season, k, slim);
  const mv = modelValues(snap.pg, slim);
  const rz = realize(season, k, horizon, mv.ids, slim, mv.byPos);
  const statusT0 = statusAt(`inj-wk${k}.json`, slim);
  const slimT0 = {}; Object.keys(slim).forEach(id => { const p = slim[id].slice(); p[3] = statusT0[id] || null; slimT0[id] = p; });
  const projSeason = {}; Object.keys(snap.pg).forEach(id => { projSeason[id] = { [PTS]: snap.pg[id] * 17 }; });
  const form = Fit.formMap(slimT0, { [k - 1]: season.stats[k - 1], [k - 2]: season.stats[k - 2] }, [k - 1, k - 2], projSeason, { ppr: 1, projByWeek: { [k - 1]: season.proj[k - 1], [k - 2]: season.proj[k - 2] } });
  const injOpts = { ros: true };
  const blend = (m, w) => Scoring.blendWithMarket(m, marketT0, w);
  const prodChain = m => Fit.applyFactors(Fit.applyInjury(m, slimT0, injOpts), [form]);
  const fcMax = Math.max(...Object.values(marketT0));
  const marketOnly = new Map(); Object.keys(marketT0).forEach(id => marketOnly.set(id, Math.round(marketT0[id] / fcMax * 10000)));
  const cands = {
    'production ^1.25 w.3': prodChain(blend(mv.cands['^1.25 (prod)'], 0.3)),
    '^1.0 w.3 +inj+form': prodChain(blend(mv.cands['^1.0'], 0.3)),
    '^1.5 w.3 +inj+form': prodChain(blend(mv.cands['^1.5'], 0.3)),
    'repl×1.5 ^1.25 w.3': prodChain(blend(mv.cands['repl×1.5 ^1.25'], 0.3)),
    'repl×1.5 ^1.0 w.3': prodChain(blend(mv.cands['repl×1.5 ^1.0'], 0.3)),
    'repl×2 ^1.25 w.3': prodChain(blend(mv.cands['repl×2 ^1.25'], 0.3)),
    'QB×1.125 ^1.25 w.3': prodChain(blend(mv.cands['QB×1.125 ^1.25'], 0.3)),
    'QB×1.125 ^1.0 w.3': prodChain(blend((() => { const ids = mv.ids; const src = {}; ids.forEach(id => { src[id] = Math.pow(mv.cands['QB×1.125 ^1.25'].get(id) || 0, 1 / 1.25); }); let mx = 0; ids.forEach(id => { if (src[id] > mx) mx = src[id]; }); const m = new Map(); ids.forEach(id => m.set(id, mx ? Math.round(src[id] / mx * 10000) : 0)); return m; })(), 0.3)),
    '^1.25 w.5 +inj+form': prodChain(blend(mv.cands['^1.25 (prod)'], 0.5)),
    'model only ^1.25': mv.cands['^1.25 (prod)'],
    'market only': marketOnly,
  };
  // pool: on the market at T0, skill, with a T0 projection; ranked by market
  const listed = Object.keys(marketT0).filter(id => slim[id] && SKILL[slim[id][1]] && snap.pg[id]);
  const ranked = listed.sort((a, b) => marketT0[b] - marketT0[a]).slice(0, 160);
  console.log(`  pool ${ranked.length} listed-at-T0 players with a week-${k} projection; statuses ${Object.keys(statusT0).length} tagged; form signals ${form.size}`);
  const trades = makeTrades(ranked, TRADES);
  // FC+waiver: FC sum + 750 per open spot to the side receiving fewer players — evaluated as its own candidate via a wrapper map
  const res = scoreTrades(trades, cands, rz.vTrunc, `${trades.length} trades (${TRADES} per shape) · realized VORP truncated, realized-rank replacement`);
  const resP = scoreTrades(trades.filter(t => t.shape !== '2-for-2'), cands, rz.vTruncP, `realized VORP truncated, projected-rank replacement`);
  const resRawP = scoreTrades(trades.filter(t => t.shape !== '2-for-2'), cands, rz.vRawP, `realized VORP RAW, projected-rank replacement`);
  const resLA = scoreTrades(trades.filter(t => t.shape !== '2-for-2'), cands, rz.vLA, `realized LINEUP-AWARE VORP, projected-rank replacement`);
  posPairs(trades, cands, rz.vLA, slim, k => k);
  void resLA;
  // FC+waiver needs the count, do it inline
  const fcW = {};
  [...new Set(trades.map(t => t.shape))].forEach(shape => {
    const ts = trades.filter(t => t.shape === shape); const pred = [], rl = [];
    ts.forEach(t => { let g = t.give.reduce((s, id) => s + marketT0[id], 0), r = t.recv.reduce((s, id) => s + marketT0[id], 0); if (t.recv.length < t.give.length) r += 750 * (t.give.length - t.recv.length); else if (t.give.length < t.recv.length) g += 750 * (t.recv.length - t.give.length); pred.push(delta(g, r)); rl.push(delta(t.give.reduce((s, id) => s + rz.vTrunc[id], 0), t.recv.reduce((s, id) => s + rz.vTrunc[id], 0))); });
    let dec = 0, ok = 0; for (let i = 0; i < pred.length; i++) if (Math.abs(pred[i]) > 0.1) { dec++; if (rl[i] !== 0 && Math.sign(pred[i]) === Math.sign(rl[i])) ok++; }
    fcW[shape] = { accDec: ok / Math.max(dec, 1), predPos: pred.filter(x => x > 0).length / pred.length, meanPred: mean(pred), slope: ols(pred, rl).slope };
    console.log('  ' + pad(shape, 9) + pad('FC + 750/spot', 24) + lpad(ts.length, 6) + lpad(pct(fcW[shape].accDec), 10) + lpad('', 10) + lpad(pct(fcW[shape].predPos), 8) + lpad('', 8) + lpad(f3(fcW[shape].meanPred), 11) + lpad('', 11) + lpad(f2(fcW[shape].slope), 7));
  });
  // per-player: rho vs realized for each candidate
  const sp = (xs, ys) => { const n = xs.length; const rk = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]); const r = new Array(n); for (let i = 0; i < n;) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const av = (i + j) / 2 + 1; for (let q = i; q <= j; q++) r[idx[q][1]] = av; i = j + 1; } return r; }; const rx = rk(xs), ry = rk(ys), mx = mean(rx), my = mean(ry); let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; } return num / Math.sqrt(dx * dy); };
  console.log('  per-player Spearman vs realized VORP over the pool: ' + Object.keys(cands).map(ck => `${ck} ${f3(sp(ranked.map(id => cands[ck].get(id) || 0), ranked.map(id => rz.vTrunc[id])))}`).join(' · '));
  return { trades: res, truncP: resP, rawP: resRawP, fcWaiver: fcW };
}

// ---- Part D: fresh-injury class -------------------------------------------------
function partD(seasons, slim) {
  console.log('\n==== Part D · fresh injuries: played last week, zero/missing projection this week (not a bye) — production over the next 4 / 8 weeks vs the pre-injury projection ====');
  const groups = { 'fresh (proj=0 this wk)': [], 'healthy (proj>0)': [] };
  const byStatus = {};
  seasons.forEach(season => {
    season.weeks.forEach(k => {
      if (k < 3 || k + 3 > season.lastStats) return;
      const st = season.year === 2026 ? statusAt(`inj-wk${k}.json`, slim) : null;
      Object.keys(slim).forEach(id => {
        if (!SKILL[slim[id][1]]) return;
        const prev = season.proj[k - 1][id], prevSt = season.stats[k - 1][id];
        if (!prev || !(Number(prev[PTS]) >= 8) || !played(prevSt)) return;    // meaningful player who played last week
        const cur = season.proj[k][id];
        const team = prev.__team; if (!team || !season.byeTeams[k].has(team)) return;   // bye this week → skip
        const curV = cur ? Number(cur[PTS]) || 0 : 0;
        const base = Number(prev[PTS]);
        const rec = (h) => { let t = 0, g = 0, n = 0; for (let w = k; w < k + h && w <= season.lastStats; w++) { if (!season.byeTeams[w].has(team)) continue; n++; const s = season.stats[w][id]; if (played(s)) { t += Number(s[PTS]) || 0; g++; } } return n ? { ratio: (t / n) / base, games: g / n, n } : null; };
        const r4 = rec(4), r8 = rec(8);
        if (!r4) return;
        const entry = { id, name: slim[id][0], pos: slim[id][1], year: season.year, k, base, r4, r8, status: st ? (st[id] || 'untagged') : null };
        groups[curV > 0 ? 'healthy (proj>0)' : 'fresh (proj=0 this wk)'].push(entry);
        if (curV === 0 && st) (byStatus[entry.status] || (byStatus[entry.status] = [])).push(entry);
      });
    });
  });
  const out = {};
  const show = (label, arr) => {
    const a4 = arr.map(e => e.r4), a8 = arr.filter(e => e.r8 && e.r8.n >= 6).map(e => e.r8);
    out[label] = { n: arr.length, ratio4: mean(a4.map(x => x.ratio)), games4: mean(a4.map(x => x.games)), median4: median(a4.map(x => x.ratio)), n8: a8.length, ratio8: mean(a8.map(x => x.ratio)), games8: mean(a8.map(x => x.games)) };
    console.log(`  ${pad(label, 30)} n=${lpad(arr.length, 4)}  next-4: pts/wk ÷ prior proj ${f2(out[label].ratio4)} (median ${f2(out[label].median4)}), games ${pct(out[label].games4)}   next-8 (n=${a8.length}): ${f2(out[label].ratio8)}, games ${pct(out[label].games8)}`);
  };
  Object.keys(groups).forEach(g => show(g, groups[g]));
  console.log('  fresh, by Thursday status (2026 only):');
  Object.keys(byStatus).sort().forEach(s => show('   ' + s, byStatus[s]));
  // by prior-projection tier
  const fresh = groups['fresh (proj=0 this wk)'];
  show('  fresh, prior proj ≥ 14 ppg', fresh.filter(e => e.base >= 14));
  show('  fresh, prior proj 8–14 ppg', fresh.filter(e => e.base < 14));
  // distribution of the next-4 ratio for fresh
  const rs = fresh.map(e => e.r4.ratio).sort((a, b) => a - b);
  const q = p => rs[Math.min(rs.length - 1, Math.floor(p * rs.length))];
  console.log(`  fresh next-4 ratio quantiles: p10 ${f2(q(0.1))} p25 ${f2(q(0.25))} p50 ${f2(q(0.5))} p75 ${f2(q(0.75))} p90 ${f2(q(0.9))}; share with 0 games in 4: ${pct(fresh.filter(e => e.r4.games === 0).length / fresh.length)}`);
  console.log('  2026 fresh cases: ' + fresh.filter(e => e.year === 2026).map(e => `${e.name} wk${e.k} (${e.status}; ${e.base.toFixed(0)} ppg → ${f2(e.r4.ratio)}, ${Math.round(e.r4.games * e.r4.n)}/${e.r4.n} g)`).join('; '));
  return out;
}

// ---- main ---------------------------------------------------------------------
(async () => {
  const slim = readJSON('slim.json');
  const s25 = loadSeason(2025, Array.from({ length: 18 }, (_, i) => i + 1)); s25.lastStats = 18;
  const s26 = loadSeason(2026, Array.from({ length: 11 }, (_, i) => i + 1));
  s26.lastStats = Math.max(...s26.weeks.filter(w => Object.keys(s26.stats[w]).length > 100));
  console.log(`inputs: 2025 weeks 1–18; 2026 projections 1–${Math.max(...s26.weeks.filter(w => Object.keys(s26.proj[w]).length))}, stats through week ${s26.lastStats}; slim ${Object.keys(slim).length}`);
  const out = {};
  out.A4 = partA([s25, s26], slim, HORIZON);
  out.A8 = partA([s25], slim, 8);
  out.B4 = partB([s25, s26], slim, HORIZON);
  out.B8 = partB([s25], slim, 8);
  SF = true;
  console.log('\n######## SUPERFLEX (QB replacement 24, deep 36) ########');
  out.A4sf = partA([s25, s26], slim, HORIZON);
  out.B4sf = partB([s25, s26], slim, HORIZON);
  SF = false;
  out.C = partC(s26, 6, slim, 4, 'fc_1qb.json');
  SF = true; out.Csf = partC(s26, 6, slim, 4, 'fc_sf.json'); SF = false;
  out.D = partD([s25, s26], slim);
  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2)); console.log('\nwrote ' + JSON_OUT); }
})().catch(e => { console.error(e); process.exit(1); });
