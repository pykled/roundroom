#!/usr/bin/env node
// Trade-value backtest: is the blended value (Sleeper-projection VORP ×
// FantasyCalc market) more accurate than the market alone, and at what weight?
//
//   node scripts/backtest-trade-value.js [--dir=/tmp/blend] [--fetch] [--json=out.json]
//        [--base=http://localhost:7898]   server for /api/players/slim (slim dict)
//        [--boot=1000]                     bootstrap resamples
//
// Study A — 2026 frozen-at-week-3 (no hindsight):
//   market at T0  = FantasyCalc `value − trend30Day` (the list's own 30-day
//                   trend, i.e. the value ~2026-09-20, week 2 Sunday)
//   model at T0   = VORP on Sleeper's week-2/3 weekly projections (published
//                   before those games; per-game proxy for the ROS sum)
//   statuses at T0 = data/injuries.json as committed before week-3 kickoff
//   realized      = Sleeper actual points weeks 3–6 (total, with 0 for games
//                   missed) → realized VORP over the same replacement ranks
//   compared      : market only, model only, blends 0.25/0.5/0.75, and the
//                   production chain (blend × injury residual × form)
//   for 1QB / SF redraft and 1QB / SF dynasty, by position / age / status
// Study B — component tests on 2025 (weeks 3–18) + 2026 (weeks 3–6), weekly,
//   no hindsight: form (hot/cold) nudge, FPA matchup factor, Questionable tag.
//
// Files in --dir (written by --fetch): proj-YYYY-W.json / stats-YYYY-W.json
// (Sleeper), fc_{1qb,sf,dyn,dyn_sf}.json (FantasyCalc), slim.json, inj-wkW.json
// (git show <commit>:data/injuries.json before each Thursday kickoff).
'use strict';

const fs = require('fs');
const path = require('path');
const Scoring = require('../shared/scoring.js');
const Lineup = require('../shared/lineup.js');
global.LineupOptimizer = Lineup;
const Fit = require('../shared/trade-fit.js');

const args = process.argv.slice(2);
const arg = (n, d) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const DIR = arg('dir', '/tmp/blend');
const BASE = String(arg('base', 'http://localhost:7898')).replace(/\/$/, '');
const JSON_OUT = arg('json', null);
const BOOT = Number(arg('boot', 1000));
const SKILL = { QB: 1, RB: 1, WR: 1, TE: 1 };
const POS = ['QB', 'RB', 'WR', 'TE'];
const PTS = 'pts_ppr';
const POSQ = 'position[]=QB&position[]=RB&position[]=WR&position[]=TE';

// ---------------------------------------------------------------- helpers
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const median = a => { const s = a.slice().sort((p, q) => p - q); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const f2 = x => Number.isFinite(x) ? x.toFixed(2) : 'n/a';
const f3 = x => Number.isFinite(x) ? x.toFixed(3) : 'n/a';
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
const lpad = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
function ranks(a) {
  const n = a.length, idx = a.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]), r = new Array(n);
  for (let i = 0; i < n;) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
  return r;
}
function spearman(xs, ys) {
  const n = xs.length; if (n < 4) return NaN;
  const rx = ranks(xs), ry = ranks(ys), mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}
// seeded PRNG for reproducible bootstraps
let seed = 20261020;
function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
function quantile(a, q) { const s = a.slice().sort((p, r) => p - r); const i = Math.max(0, Math.min(s.length - 1, Math.round(q * (s.length - 1)))); return s[i]; }

function readJSON(f) { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
function tryRead(f) { try { return readJSON(f); } catch (e) { return null; } }
function rowsToDict(rows) {
  const out = {};
  (rows || []).forEach(r => { if (r && r.player_id && r.stats) out[r.player_id] = Object.assign({}, r.stats, { __team: r.team, __opp: r.opponent, __pos: r.player && r.player.position }); });
  return out;
}

async function fetchAll() {
  fs.mkdirSync(DIR, { recursive: true });
  const get = async (url, f) => { const r = await fetch(url); if (!r.ok) throw new Error(url + ' → ' + r.status); fs.writeFileSync(path.join(DIR, f), await r.text()); };
  for (let w = 1; w <= 18; w++) {
    await get(`https://api.sleeper.com/projections/nfl/2025/${w}?season_type=regular&${POSQ}`, `proj-2025-${w}.json`);
    await get(`https://api.sleeper.com/stats/nfl/2025/${w}?season_type=regular&${POSQ}`, `stats-2025-${w}.json`);
  }
  for (let w = 1; w <= 7; w++) await get(`https://api.sleeper.com/projections/nfl/2026/${w}?season_type=regular&${POSQ}`, `proj-2026-${w}.json`);
  for (let w = 1; w <= 6; w++) await get(`https://api.sleeper.com/stats/nfl/2026/${w}?season_type=regular&${POSQ}`, `stats-2026-${w}.json`);
  await get('https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=1', 'fc_1qb.json');
  await get('https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=2&numTeams=12&ppr=1', 'fc_sf.json');
  await get('https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=1&numTeams=12&ppr=1', 'fc_dyn.json');
  await get('https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=12&ppr=1', 'fc_dyn_sf.json');
  await get(BASE + '/api/players/slim', 'slim.json');
  console.log('fetched into ' + DIR + ' (inj-wkN.json must be dumped from git: see header)');
}

// ---------------------------------------------------------------- data
function loadSeason(year, weeks) {
  const proj = {}, stats = {};
  weeks.forEach(w => { proj[w] = rowsToDict(tryRead(`proj-${year}-${w}.json`)); stats[w] = rowsToDict(tryRead(`stats-${year}-${w}.json`)); });
  return { proj, stats };
}
function statusAt(injFile, slim) {
  // injuries.json players: [{ name, position, team, status }] → { id: status }
  const inj = tryRead(injFile); const out = {};
  if (!inj || !inj.players) return out;
  const byKey = {};
  Object.keys(slim).forEach(id => { const p = slim[id]; if (SKILL[p[1]]) byKey[(p[0] + '|' + p[1]).toLowerCase()] = id; });
  inj.players.forEach(p => { const id = byKey[(p.name + '|' + p.position).toLowerCase()]; if (id && p.status) out[id] = String(p.status).replace(/\.$/, ''); });
  return out;
}
const played = s => s && (Number(s.gp) > 0 || (s[PTS] != null && Number(s[PTS]) !== 0));

// ---------------------------------------------------------------- Study A
function studyA(slim, s26, fcFile, fmtName, cfg) {
  const fc = readJSON(fcFile);
  const marketT0 = {}, marketNow = {};
  let unlisted = 0;
  fc.forEach(r => { const id = r.player && r.player.sleeperId; if (!id) return; marketNow[id] = r.value; const v = r.value - (r.trend30Day || 0); if (v > 0) marketT0[id] = v; else unlisted++; });

  // T0 projection proxy: mean of the week-2 and week-3 weekly projections (rows > 0)
  const projT0 = {}, projSeason = {};
  Object.keys(slim).forEach(id => {
    if (!SKILL[slim[id][1]]) return;
    const rows = [2, 3].map(w => s26.proj[w][id]).filter(r => r && Number(r[PTS]) > 0).map(r => Number(r[PTS]));
    if (!rows.length) return;
    const pg = mean(rows);
    projT0[id] = { [PTS]: pg };
    projSeason[id] = { [PTS]: pg * 17 };
  });
  const statusT0 = statusAt('inj-wk3.json', slim);
  const slimT0 = {};
  Object.keys(slim).forEach(id => { const p = slim[id].slice(); p[3] = statusT0[id] || null; slimT0[id] = p; });

  const league = {
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX'].concat(cfg.sf ? ['SUPER_FLEX'] : []),
    scoring_settings: { [PTS]: 1 }, settings: { type: cfg.dynasty ? 2 : 0 }, total_rosters: 12,
  };
  const fmt = Fit.leagueFormat(league);
  const pool = Object.keys(slim).filter(id => SKILL[slim[id][1]]).map(id => ({ player_id: id, position: slim[id][1] }));
  const raw = Scoring.computeVORP(pool, projT0, league.scoring_settings, league.roster_positions, 12);
  let scaled = Scoring.rescaleVORP(raw);
  if (fmt.dynasty) scaled = Fit.applyAge(scaled, slimT0);
  const blends = {};
  [0, 0.25, 0.5, 0.75, 1].forEach(w => { blends[w] = Scoring.blendWithMarket(scaled, marketT0, w); });
  const prodW = fmt.dynasty ? 0.5 : 0.3;
  const base = Scoring.blendWithMarket(scaled, marketT0, prodW);
  const form = Fit.formMap(slimT0, { 1: s26.stats[1], 2: s26.stats[2] }, [2, 1], projSeason, { ppr: 1, dynasty: fmt.dynasty, projByWeek: { 1: s26.proj[1], 2: s26.proj[2] } });
  const injOpts = { dynasty: fmt.dynasty, ros: true };
  const injured = Fit.applyInjury(base, slimT0, injOpts);
  const prod = Fit.applyFactors(injured, [form]);
  const prodNoForm = injured;
  const prodNoInj = Fit.applyFactors(base, [form]);

  // realized weeks 3–6
  const REAL_WEEKS = [3, 4, 5, 6];
  const realTot = {}, realGames = {};
  pool.forEach(p => {
    let t = 0, g = 0;
    REAL_WEEKS.forEach(w => { const s = s26.stats[w][p.player_id]; if (played(s)) { t += Number(s[PTS]) || 0; g++; } });
    realTot[p.player_id] = t; realGames[p.player_id] = g;
  });
  const replRank = { QB: cfg.sf ? 24 : 12, RB: 30, WR: 42, TE: 12 };
  const replReal = {};
  POS.forEach(pos => { const s = pool.filter(p => p.position === pos).map(p => realTot[p.player_id]).sort((a, b) => b - a); replReal[pos] = s[replRank[pos]] || 0; });
  const realV = {};
  pool.forEach(p => { realV[p.player_id] = Math.max(0, realTot[p.player_id] - replReal[p.position]); });

  // sample: on the market 30 days ago, skill, with a T0 projection
  const listed = Object.keys(marketT0).filter(id => slim[id] && SKILL[slim[id][1]]);
  const sample = listed.filter(id => projT0[id]);
  const inactive = listed.filter(id => !projT0[id]);

  const cands = {
    'market only (w=1)': blends[1], 'blend w=0.75': blends[0.75], 'blend w=0.5': blends[0.5], 'blend w=0.25': blends[0.25], 'model only (w=0)': blends[0],
    [`production (w=${prodW} × inj × form)`]: prod, [`production w/o form`]: prodNoForm, [`production w/o injury`]: prodNoInj,
  };

  function metrics(map, ids) {
    const v = ids.map(id => map.get(id) || 0), r = ids.map(id => realV[id]);
    const rho = spearman(v, r);
    const byPos = {};
    POS.forEach(pos => { const sub = ids.filter(id => slim[id][1] === pos); byPos[pos] = { n: sub.length, rho: spearman(sub.map(id => map.get(id) || 0), sub.map(id => realV[id])) }; });
    // top-N hits per position (N = min(12, n/2)) and overall top 24
    let hits = 0, hitN = 0;
    POS.forEach(pos => {
      const sub = ids.filter(id => slim[id][1] === pos); const N = Math.min(12, Math.floor(sub.length / 2)); if (N < 3) return;
      const topV = sub.slice().sort((a, b) => (map.get(b) || 0) - (map.get(a) || 0)).slice(0, N);
      const topR = new Set(sub.slice().sort((a, b) => realV[b] - realV[a]).slice(0, N));
      hits += topV.filter(id => topR.has(id)).length; hitN += N;
    });
    const top24V = ids.slice().sort((a, b) => (map.get(b) || 0) - (map.get(a) || 0)).slice(0, 24);
    const top24R = new Set(ids.slice().sort((a, b) => realV[b] - realV[a]).slice(0, 24));
    // decisive pairs (gap > 10 % of the larger value, the FAIR band) → right order?
    let pairs = 0, right = 0, xpairs = 0, xright = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = map.get(ids[i]) || 0, b = map.get(ids[j]) || 0, ra = realV[ids[i]], rb = realV[ids[j]];
      if (Math.abs(a - b) / Math.max(a, b, 1) <= 0.10 || ra === rb) continue;
      const ok = (a > b) === (ra > rb);
      pairs++; if (ok) right++;
      if (slim[ids[i]][1] !== slim[ids[j]][1]) { xpairs++; if (ok) xright++; }
    }
    // calibration: realized VORP ~ a + b·value, RMSE in points
    const mv = mean(v), mr = mean(r); let sxy = 0, sxx = 0;
    for (let i = 0; i < v.length; i++) { sxy += (v[i] - mv) * (r[i] - mr); sxx += (v[i] - mv) ** 2; }
    const b = sxx ? sxy / sxx : 0, a = mr - b * mv;
    const rmse = Math.sqrt(mean(v.map((x, i) => (a + b * x - r[i]) ** 2)));
    return { n: ids.length, rho, byPos, topPosHit: hitN ? hits / hitN : NaN, top24Hit: top24V.filter(id => top24R.has(id)).length / 24, pairAcc: pairs ? right / pairs : NaN, pairs, xPairAcc: xpairs ? xright / xpairs : NaN, xpairs, rmse };
  }

  console.log(`\n==== Study A · ${fmtName} · T0 = week 3 (market = value − trend30Day) · realized weeks ${REAL_WEEKS.join('–')} (PPR) ====`);
  console.log(`  FantasyCalc list ${fc.length} rows, ${unlisted} not listed 30 days ago; sample ${sample.length} (listed at T0, skill, with a week-2/3 projection); ${inactive.length} listed but no week-2/3 projection (inactive at T0, see below)`);
  console.log(`  replacement realized totals: ${POS.map(p => p + ' ' + replReal[p].toFixed(1)).join(', ')}; statuses at T0: ${Object.keys(statusT0).length} tagged; form signals at T0: ${form.size}`);
  const res = { format: fmtName, n: sample.length, inactive: inactive.length, unlisted, cands: {} };
  console.log('  ' + pad('candidate', 36) + lpad('rho', 7) + lpad('QB', 7) + lpad('RB', 7) + lpad('WR', 7) + lpad('TE', 7) + lpad('top12/pos', 11) + lpad('top24', 7) + lpad('pairs', 7) + lpad('x-pos', 7) + lpad('rmse', 7));
  Object.keys(cands).forEach(k => {
    const m = metrics(cands[k], sample); res.cands[k] = m;
    console.log('  ' + pad(k, 36) + lpad(f3(m.rho), 7) + POS.map(p => lpad(f2(m.byPos[p].rho), 7)).join('') + lpad(f2(m.topPosHit), 11) + lpad(f2(m.top24Hit), 7) + lpad(f3(m.pairAcc), 7) + lpad(f3(m.xPairAcc), 7) + lpad(m.rmse.toFixed(1), 7));
  });
  console.log(`  n by position: ${POS.map(p => p + ' ' + sample.filter(id => slim[id][1] === p).length).join(', ')}`);

  // bootstrap: Δ vs market-only
  const ref = cands['market only (w=1)'];
  const bootKeys = Object.keys(cands).filter(k => cands[k] !== ref);
  const dRho = {}, dPair = {}; bootKeys.forEach(k => { dRho[k] = []; dPair[k] = []; });
  for (let b = 0; b < BOOT; b++) {
    const ids = []; for (let i = 0; i < sample.length; i++) ids.push(sample[Math.floor(rnd() * sample.length)]);
    const uniq = Array.from(new Set(ids));
    const mRef = metrics(ref, uniq);
    bootKeys.forEach(k => { const m = metrics(cands[k], uniq); dRho[k].push(m.rho - mRef.rho); dPair[k].push(m.pairAcc - mRef.pairAcc); });
  }
  console.log(`  bootstrap (${BOOT} resamples) — Δ vs market only: rho [2.5%, 97.5%] · pair accuracy [2.5%, 97.5%]`);
  res.boot = {};
  bootKeys.forEach(k => {
    const r = [quantile(dRho[k], 0.025), quantile(dRho[k], 0.975)], p = [quantile(dPair[k], 0.025), quantile(dPair[k], 0.975)];
    res.boot[k] = { rho: r, pair: p, rhoMean: mean(dRho[k]), pairMean: mean(dPair[k]) };
    console.log('  ' + pad(k, 36) + `rho ${f3(mean(dRho[k]))} [${f3(r[0])}, ${f3(r[1])}]   pairs ${f3(mean(dPair[k]))} [${f3(p[0])}, ${f3(p[1])}]`);
  });

  // disagreement pairs: model and market order a pair differently (both decisive)
  const mkt = blends[1], mdl = blends[0];
  let dis = 0, mdlRight = 0, mktRight = 0, xdis = 0, xMdl = 0;
  for (let i = 0; i < sample.length; i++) for (let j = i + 1; j < sample.length; j++) {
    const a = sample[i], b = sample[j];
    const ma = mkt.get(a) || 0, mb = mkt.get(b) || 0, da = mdl.get(a) || 0, db = mdl.get(b) || 0;
    if (Math.abs(ma - mb) / Math.max(ma, mb, 1) <= 0.10 || Math.abs(da - db) / Math.max(da, db, 1) <= 0.10) continue;
    if ((ma > mb) === (da > db)) continue;
    if (realV[a] === realV[b]) continue;
    dis++; const mktOk = (ma > mb) === (realV[a] > realV[b]); if (mktOk) mktRight++; else mdlRight++;
    if (slim[a][1] !== slim[b][1]) { xdis++; if (!mktOk) xMdl++; }
  }
  res.disagree = { pairs: dis, modelRight: mdlRight, marketRight: mktRight, xpairs: xdis, xModelRight: xMdl };
  console.log(`  disagreement pairs (market and model order them oppositely, both outside the FAIR band): ${dis} — market right ${mktRight} (${f2(mktRight / Math.max(dis, 1))}), model right ${mdlRight}; cross-position ${xdis}, model right ${xMdl}`);

  // buckets: rho within bucket for key candidates
  function bucketTable(title, keyFn, order) {
    const groups = {}; sample.forEach(id => { const k = keyFn(id); if (k == null) return; (groups[k] || (groups[k] = [])).push(id); });
    const keys = order || Object.keys(groups);
    const show = ['market only (w=1)', 'blend w=0.5', 'model only (w=0)', Object.keys(cands)[5]];
    console.log(`  ${title}: n · rho for ${show.join(' / ')} · mean realized VORP`);
    const out = {};
    keys.forEach(k => { const ids = groups[k]; if (!ids || ids.length < 6) return; const row = show.map(c => spearman(ids.map(id => cands[c].get(id) || 0), ids.map(id => realV[id]))); out[k] = { n: ids.length, rho: row }; console.log('    ' + pad(k, 16) + lpad(ids.length, 4) + row.map(x => lpad(f2(x), 8)).join('') + lpad(mean(ids.map(id => realV[id])).toFixed(1), 8)); });
    return out;
  }
  res.byAge = bucketTable('age bucket', id => { const a = slim[id][4]; return a == null ? null : a <= 24 ? '≤24' : a <= 27 ? '25–27' : a <= 29 ? '28–29' : '30+'; }, ['≤24', '25–27', '28–29', '30+']);
  res.byStatus = bucketTable('status at T0', id => statusT0[id] ? (statusT0[id] === 'Questionable' ? 'Questionable' : 'Out/IR/D/Sus') : 'healthy', ['healthy', 'Questionable', 'Out/IR/D/Sus']);
  res.byForm = bucketTable('form label at T0', id => { const f = form.get(id); return f ? (f.label || 'on pace') : 'no signal'; }, ['hot', 'cold', 'on pace', 'no signal']);
  // form at T0: did hot players regress / cold players bounce over weeks 3–6 (per-game vs their T0 projection)?
  const fb = { hot: [], cold: [], 'on pace': [] };
  sample.forEach(id => { const f = form.get(id); if (!f || !projT0[id] || realGames[id] < 2) return; fb[f.label || 'on pace'].push((realTot[id] / realGames[id]) / projT0[id][PTS]); });
  res.formRegress = {};
  Object.keys(fb).forEach(k => { res.formRegress[k] = { n: fb[k].length, meanRatio: mean(fb[k]), medianRatio: median(fb[k]) }; });
  console.log(`  form at T0 → realized PPG weeks 3–6 ÷ T0 projection: ${Object.keys(fb).map(k => `${k} n=${fb[k].length} mean ${f2(mean(fb[k]))} median ${f2(median(fb[k]))}`).join(' · ')}`);
  // market-side premise of "sell high": does the market over-rank hot players (and under-rank cold) relative to realized, more than the model does?
  const mkt0 = blends[1], mdl0 = blends[0];
  const realRank0 = {}; POS.forEach(pos => { sample.filter(id => slim[id][1] === pos).sort((a, b) => realV[b] - realV[a]).forEach((id, i) => { realRank0[id] = i + 1; }); });
  const posRank0 = (map, id) => { const pos = slim[id][1]; let r = 1; const v = map.get(id) || 0; sample.forEach(j => { if (slim[j][1] === pos && (map.get(j) || 0) > v) r++; }); return r; };
  res.formBias = {};
  const biasRows = ['hot', 'cold', 'on pace'].map(k => {
    const ids = sample.filter(id => { const f = form.get(id); return f && (f.label || 'on pace') === k; });
    const dm = ids.map(id => posRank0(mkt0, id) - realRank0[id]), dd = ids.map(id => posRank0(mdl0, id) - realRank0[id]);
    res.formBias[k] = { n: ids.length, marketRankBias: mean(dm), modelRankBias: mean(dd) };
    return `${k} n=${ids.length}: market ${f2(mean(dm))}, model ${f2(mean(dd))}`;
  });
  console.log(`  mean (value rank − realized rank) within position by form label (negative = ranked better than it turned out): ${biasRows.join(' · ')}`);
  // power-curve sensitivity: rescale exponent 1.0 / 1.25 (production) / 1.5 on model-only and the production blend weight
  res.exponent = {};
  const expRows = [1.0, 1.25, 1.5].map(e => {
    let maxV = 0; const pw = new Map(); raw.forEach((v, id) => { const x = Math.pow(v, e); pw.set(id, x); if (x > maxV) maxV = x; });
    let sc = new Map(); pw.forEach((v, id) => sc.set(id, maxV > 0 ? Math.round(v / maxV * 10000) : 0));
    if (fmt.dynasty) sc = Fit.applyAge(sc, slimT0);
    const m0 = metrics(sc, sample), mb = metrics(Scoring.blendWithMarket(sc, marketT0, prodW), sample);
    res.exponent[e] = { modelRho: m0.rho, modelXPair: m0.xPairAcc, blendRho: mb.rho, blendXPair: mb.xPairAcc };
    return `^${e}: model rho ${f3(m0.rho)} x-pos pairs ${f3(m0.xPairAcc)} · blend w=${prodW} rho ${f3(mb.rho)} x-pos ${f3(mb.xPairAcc)}`;
  });
  console.log(`  VORP power curve: ${expRows.join(' | ')}`);

  // inactive-at-T0 (listed, no week-2/3 projection): market only vs realized
  const inV = inactive.map(id => marketT0[id]), inR = inactive.map(id => realV[id]);
  res.inactive = { n: inactive.length, rhoMarket: spearman(inV, inR), meanReal: mean(inR), meanGames: mean(inactive.map(id => realGames[id])), names: inactive.map(id => `${slim[id][0]} (${statusT0[id] || '?'}, ${realGames[id]}g, ${realTot[id].toFixed(0)} pts)`) };
  console.log(`  inactive at T0 (n=${inactive.length}, model has no value): market-only rho vs realized ${f2(res.inactive.rhoMarket)}; mean games played wks 3–6 ${f2(res.inactive.meanGames)}; mean realized VORP ${f2(res.inactive.meanReal)} (sample mean ${f2(mean(sample.map(id => realV[id])))})`);
  console.log('    ' + res.inactive.names.slice(0, 12).join('; '));

  // top movers between market and model at T0 and who was right
  const movers = sample.map(id => { const m = mkt.get(id) || 0, d = mdl.get(id) || 0; return { id, name: slim[id][0], pos: slim[id][1], age: slim[id][4], status: statusT0[id] || '', mkt: m, mdl: d, diff: d - m, real: realV[id], games: realGames[id] }; });
  const realRank = {}; POS.forEach(pos => { sample.filter(id => slim[id][1] === pos).sort((a, b) => realV[b] - realV[a]).forEach((id, i) => { realRank[id] = i + 1; }); });
  const posRank = (map, id) => { const pos = slim[id][1]; let r = 1; const v = map.get(id) || 0; sample.forEach(j => { if (slim[j][1] === pos && (map.get(j) || 0) > v) r++; }); return r; };
  movers.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  console.log('  top 15 |model − market| at T0 (0–10000 scale): market rank → model rank → realized rank (pos)');
  res.movers = movers.slice(0, 15).map(x => { const mr = posRank(mkt, x.id), dr = posRank(mdl, x.id), rr = realRank[x.id]; const closer = Math.abs(dr - rr) < Math.abs(mr - rr) ? 'model' : Math.abs(dr - rr) > Math.abs(mr - rr) ? 'market' : 'tie'; console.log(`    ${pad(x.name, 22)} ${x.pos} ${pad(x.status, 12)} mkt ${lpad(x.mkt, 5)} mdl ${lpad(x.mdl, 5)}  ${lpad(mr, 3)} → ${lpad(dr, 3)} → real ${lpad(rr, 3)}  ${closer}`); return Object.assign(x, { mr, dr, rr, closer }); });
  const closer = res.movers.reduce((s, x) => { s[x.closer] = (s[x.closer] || 0) + 1; return s; }, {});
  console.log(`    closer to realized rank: ${JSON.stringify(closer)}`);
  return res;
}

// ---------------------------------------------------------------- Study B
function studyB(slim, seasons) {
  console.log('\n==== Study B · weekly component tests (no hindsight) ====');
  const posOf = (row, id) => (row && row.__pos) || (slim[id] && slim[id][1]);
  // ---- form: last-2-games ratio vs this week's projection -----------------
  const form = { hot: [], cold: [], 'on pace': [] }, form4 = { hot: [], cold: [], 'on pace': [] };
  const ratioPairs = [];
  seasons.forEach(({ year, s, weeks }) => {
    weeks.forEach(k => {
      if (k < 3) return;
      Object.keys(s.proj[k]).forEach(id => {
        const p = s.proj[k][id]; const pos = posOf(p, id); if (!SKILL[pos]) return;
        const pk = Number(p[PTS]); if (!(pk >= 5)) return;
        const a = s.stats[k][id]; if (!played(a)) return;           // conditional on playing
        const games = [], pg = [];
        for (let w = k - 1; w >= 1 && games.length < 2; w--) { const st = s.stats[w][id], pr = s.proj[w][id]; if (played(st) && pr && Number(pr[PTS]) > 0) { games.push(Number(st[PTS]) || 0); pg.push(Number(pr[PTS])); } }
        const sig = Fit.formSignal(games, pk, { projGames: pg });
        if (!sig) return;
        const label = sig.label || 'on pace';
        form[label].push((Number(a[PTS]) || 0) / pk);
        ratioPairs.push([sig.ratio, (Number(a[PTS]) || 0) / pk]);
        // 4-week-ahead per-game (weeks k..k+3 played), vs week-k projection
        let t = 0, g = 0; for (let w = k; w <= Math.min(k + 3, weeks[weeks.length - 1]); w++) { const st = s.stats[w][id]; if (played(st)) { t += Number(st[PTS]) || 0; g++; } }
        if (g >= 2) form4[label].push((t / g) / pk);
      });
    });
  });
  console.log('  form (hot ≥1.2 / cold ≤0.8 of the last-2 weekly projections) → this-week actual ÷ this-week Sleeper projection, and next-4-games PPG ÷ projection');
  const res = { form: {} };
  Object.keys(form).forEach(k => { res.form[k] = { n: form[k].length, mean: mean(form[k]), median: median(form[k]), n4: form4[k].length, mean4: mean(form4[k]), median4: median(form4[k]) }; console.log(`    ${pad(k, 8)} n=${lpad(form[k].length, 5)} week mean ${f3(mean(form[k]))} median ${f3(median(form[k]))}   next-4 n=${lpad(form4[k].length, 5)} mean ${f3(mean(form4[k]))} median ${f3(median(form4[k]))}`); });
  // bootstrap CI on (hot − on pace) and (cold − on pace) mean ratios
  function ciDiff(a, b) { const d = []; for (let i = 0; i < 2000; i++) { let sa = 0, sb = 0; for (let j = 0; j < a.length; j++) sa += a[Math.floor(rnd() * a.length)]; for (let j = 0; j < b.length; j++) sb += b[Math.floor(rnd() * b.length)]; d.push(sa / a.length - sb / b.length); } return [quantile(d, 0.025), quantile(d, 0.975)]; }
  res.form.ci = { hotWeek: ciDiff(form.hot, form['on pace']), coldWeek: ciDiff(form.cold, form['on pace']), hot4: ciDiff(form4.hot, form4['on pace']), cold4: ciDiff(form4.cold, form4['on pace']) };
  console.log(`    95% CI of mean(actual/proj) difference vs on-pace — hot: week [${f3(res.form.ci.hotWeek[0])}, ${f3(res.form.ci.hotWeek[1])}] next-4 [${f3(res.form.ci.hot4[0])}, ${f3(res.form.ci.hot4[1])}] · cold: week [${f3(res.form.ci.coldWeek[0])}, ${f3(res.form.ci.coldWeek[1])}] next-4 [${f3(res.form.ci.cold4[0])}, ${f3(res.form.ci.cold4[1])}]  (production nudges: hot −0.05, cold +0.05)`);
  res.form.rhoRatioResidual = spearman(ratioPairs.map(x => x[0]), ratioPairs.map(x => x[1]));
  console.log(`    Spearman(last-2 ratio, this-week actual/proj) over ${ratioPairs.length} player-weeks: ${f3(res.form.rhoRatioResidual)}  (positive = momentum persists beyond the projection; negative = regression; ~0 = projection already absorbs it)`);
  // implied multiplier: what mult on the projection would be unbiased for each label
  console.log(`    implied unbiased multiplier (mean actual/proj): hot ${f3(res.form.hot.mean)} vs production 0.95 · cold ${f3(res.form.cold.mean)} vs production 1.05 · on-pace ${f3(res.form['on pace'].mean)}`);

  // ---- FPA matchup factor: opponent rank by points allowed to the position through week k−1 → week-k actual/proj
  const fpaB = { easy: [], mid: [], hard: [] }, fpaByPos = {};
  POS.forEach(p => { fpaByPos[p] = { easy: [], mid: [], hard: [] }; });
  const fpaPairs = [];
  seasons.forEach(({ year, s, weeks }) => {
    const allowed = {};   // pos → team → [pts per game]
    weeks.forEach(k => {
      if (k >= 5) {
        const rank = {};
        POS.forEach(pos => { const teams = Object.keys(allowed[pos] || {}); const avg = {}; teams.forEach(t => { avg[t] = mean(allowed[pos][t]); }); const sorted = teams.sort((a, b) => avg[b] - avg[a]); rank[pos] = {}; sorted.forEach((t, i) => { rank[pos][t] = i + 1; }); });
        Object.keys(s.proj[k]).forEach(id => {
          const p = s.proj[k][id]; const pos = posOf(p, id); if (!SKILL[pos]) return;
          const pk = Number(p[PTS]); if (!(pk >= 5)) return;
          const a = s.stats[k][id]; if (!played(a)) return;
          const opp = p.__opp || a.__opp; const r = rank[pos] && rank[pos][opp]; if (!r) return;
          const ratio = (Number(a[PTS]) || 0) / pk;
          const b = r <= 11 ? 'easy' : r >= 22 ? 'hard' : 'mid';
          fpaB[b].push(ratio); fpaByPos[pos][b].push(ratio); fpaPairs.push([r, ratio]);
        });
      }
      // accumulate week k into FPA (points allowed per defense per position, per game)
      const perGame = {};
      Object.keys(s.stats[k]).forEach(id => { const st = s.stats[k][id]; const pos = posOf(st, id); if (!SKILL[pos] || !st.__opp) return; const key = pos + '|' + st.__opp; perGame[key] = (perGame[key] || 0) + (Number(st[PTS]) || 0); });
      Object.keys(perGame).forEach(key => { const [pos, t] = key.split('|'); (allowed[pos] || (allowed[pos] = {}))[t] = (allowed[pos][t] || []).concat([perGame[key]]); });
    });
  });
  res.fpa = {};
  console.log('  FPA matchup: opponent rank in pts allowed to the position through week k−1 (1 = allows most) → week-k actual ÷ Sleeper projection');
  Object.keys(fpaB).forEach(b => { res.fpa[b] = { n: fpaB[b].length, mean: mean(fpaB[b]), median: median(fpaB[b]) }; console.log(`    ${pad(b, 6)} n=${lpad(fpaB[b].length, 5)} mean ${f3(mean(fpaB[b]))} median ${f3(median(fpaB[b]))}   by pos: ${POS.map(p => p + ' ' + f3(mean(fpaByPos[p][b]))).join(' · ')}`); });
  res.fpa.ci = { easyMid: ciDiff(fpaB.easy, fpaB.mid), hardMid: ciDiff(fpaB.hard, fpaB.mid) };
  console.log(`    95% CI of mean difference vs mid — easy [${f3(res.fpa.ci.easyMid[0])}, ${f3(res.fpa.ci.easyMid[1])}] · hard [${f3(res.fpa.ci.hardMid[0])}, ${f3(res.fpa.ci.hardMid[1])}]`);
  res.fpa.rho = spearman(fpaPairs.map(x => -x[0]), fpaPairs.map(x => x[1]));
  console.log(`    Spearman(easiness, actual/proj) over ${fpaPairs.length} player-weeks: ${f3(res.fpa.rho)}  (production: rank 1 → ×1.05, rank 32 → ×0.95 on top of the projection)`);

  // ---- Questionable tag (2026 only: injuries.json snapshots before each Thursday)
  // Sleeper's stored weekly projection is the final pre-kickoff version (0 for a
  // game-day scratch), so the baseline is the PREVIOUS week's projection of a
  // player who played that week — fixed before this week's news — and DNP = 0.
  const q = { Questionable: [], healthy: [], Doubtful: [] }, qPlayed = { Questionable: [0, 0], healthy: [0, 0], Doubtful: [0, 0] };
  const s26 = seasons.find(x => x.year === 2026);
  if (s26) {
    s26.weeks.forEach(k => {
      if (k < 2) return;
      const st = statusAt(`inj-wk${k}.json`, slim); if (!Object.keys(st).length) return;
      Object.keys(s26.s.proj[k - 1]).forEach(id => {
        const p = s26.s.proj[k - 1][id]; const pos = posOf(p, id); if (!SKILL[pos]) return;
        const pk = Number(p[PTS]); if (!(pk >= 5) || !played(s26.s.stats[k - 1][id])) return;
        const bye = !s26.s.proj[k][id] && !s26.s.stats[k][id] && !(slim[id] && slim[id][2] && slim[id][2] !== 'FA');
        const tag = st[id] === 'Questionable' ? 'Questionable' : st[id] === 'Doubtful' ? 'Doubtful' : st[id] ? null : 'healthy';
        if (!tag) return;
        // skip byes: no projection row this week AND no stat row; (teams on bye have no row at all)
        if (!s26.s.proj[k][id] && !s26.s.stats[k][id]) return;
        const a = s26.s.stats[k][id]; const pl = played(a);
        qPlayed[tag][1]++; if (pl) qPlayed[tag][0]++;
        q[tag].push(pl ? (Number(a[PTS]) || 0) / pk : 0);
        void bye;
      });
    });
    res.questionable = {};
    console.log('  Questionable / Doubtful on Thursday (2026 weeks 2–6; baseline = last week\'s projection ≥ 5 of a player who played last week): share that played, week actual ÷ baseline with DNP = 0');
    Object.keys(q).forEach(t => { res.questionable[t] = { n: q[t].length, played: qPlayed[t][0] / Math.max(qPlayed[t][1], 1), mean: mean(q[t]), median: median(q[t]) }; console.log(`    ${pad(t, 13)} n=${lpad(q[t].length, 4)} played ${f2(qPlayed[t][0] / Math.max(qPlayed[t][1], 1))}  mean ${f3(mean(q[t]))} median ${f3(median(q[t]))}`); });
    const w = 12; // ROS weeks the production tag is applied to
    const impliedQ = 1 - (1 - res.questionable.Questionable.mean / Math.max(res.questionable.healthy.mean, 1e-9)) / w;
    res.questionable.impliedRosMultQ = impliedQ;
    console.log(`    implied ROS multiplier for a Questionable tag if only this week is at risk (${w} weeks left): ${f3(impliedQ)} vs production 0.97 (ros table)`);
  }
  return res;
}

// ---------------------------------------------------------------- main
(async () => {
  if (args.includes('--fetch')) { await fetchAll(); }
  const slim = readJSON('slim.json');
  const s26 = loadSeason(2026, [1, 2, 3, 4, 5, 6, 7]);
  const s25 = loadSeason(2025, Array.from({ length: 18 }, (_, i) => i + 1));
  const out = { generatedAt: new Date().toISOString(), studyA: {}, studyB: null };
  out.studyA['1QB redraft'] = studyA(slim, s26, 'fc_1qb.json', '1QB redraft', { sf: false, dynasty: false });
  out.studyA['SF redraft'] = studyA(slim, s26, 'fc_sf.json', 'SF redraft', { sf: true, dynasty: false });
  out.studyA['1QB dynasty'] = studyA(slim, s26, 'fc_dyn.json', '1QB dynasty', { sf: false, dynasty: true });
  out.studyA['SF dynasty'] = studyA(slim, s26, 'fc_dyn_sf.json', 'SF dynasty', { sf: true, dynasty: true });
  out.studyB = studyB(slim, [
    { year: 2025, s: s25, weeks: Array.from({ length: 18 }, (_, i) => i + 1) },
    { year: 2026, s: s26, weeks: [1, 2, 3, 4, 5, 6] },
  ]);
  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2)); console.log('\nwrote ' + JSON_OUT); }
})().catch(e => { console.error(e); process.exit(1); });
