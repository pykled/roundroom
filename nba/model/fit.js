// Per-player High Score distribution fit. See docs/nba-model.md for the method.
'use strict';
const St = require('./stats');

// Tuned on the 2025 backtest (scripts/test-nba-model.js --tune); see docs/nba-model.md.
const PARAMS = {
  halfLifeDays: 45,    // recency: a game this many days old counts half
  shortFrac: 0.5,      // a game under shortFrac × typical minutes is a "short" game…
  shortWeight: 0.5,    // …(injury exit, blowout, return-from-injury ramp) and gets this weight
  priorGames: 12,      // projection mean counts as this many games when shrinking the mean
  minutesAdj: true,    // rescale to projected minutes (role change) when a projection exists
  rhoMin: 0.7, rhoMax: 1.4,
  bwFactor: 0.25,      // kernel bandwidth multiplier on Silverman's rule (0 = raw empirical)
  maxK: 10,            // precompute E[max of k] for k = 1..maxK (a 14-day matchup week has up to ~8 games)
};

const POOLED_CV_DEFAULT = 0.3;

function minutesTier(min) {
  return min >= 32 ? 't32' : min >= 26 ? 't26' : min >= 18 ? 't18' : 't0';
}
function posGroup(pos) {
  if (!pos || !pos.length) return 'F';
  if (pos.includes('C')) return 'C';
  const guards = pos.filter(p => p === 'PG' || p === 'SG').length;
  return guards > pos.length - guards ? 'G' : 'F';
}

// games: [[epochDay, week, hs, minutes], ...] already filtered to before asOfDay.
// opts: { asOfDay, projMean?, projMin?, meanOverride? (new team: projection replaces the mean), params? }
function fitLogs(games, opts) {
  const P = { ...PARAMS, ...(opts.params || {}) };
  const m = games.length;
  if (!m) return null;
  const xs = new Array(m), ws = new Array(m), mins = new Array(m);
  for (let i = 0; i < m; i++) {
    const g = games[i];
    xs[i] = g[2];
    mins[i] = g[3];
    ws[i] = Math.pow(0.5, Math.max(0, opts.asOfDay - g[0]) / P.halfLifeDays);
  }
  const mRef = St.weightedQuantile(mins, ws, 0.5);
  let short = 0;
  for (let i = 0; i < m; i++) if (mins[i] < P.shortFrac * mRef) { ws[i] *= P.shortWeight; short++; }
  const emp = St.weightedMeanSd(xs, ws);

  let rho = 1;
  if (P.minutesAdj && opts.projMin > 0 && mRef > 0) rho = Math.min(P.rhoMax, Math.max(P.rhoMin, opts.projMin / mRef));
  const empAdj = emp.mean * rho;
  let mean;
  if (opts.meanOverride > 0) mean = opts.meanOverride;
  else if (opts.projMean > 0) mean = (emp.nEff * empAdj + P.priorGames * opts.projMean) / (emp.nEff + P.priorGames);
  else mean = empAdj;
  const scale = emp.mean > 0 ? mean / emp.mean : 1;

  const samples = xs.map(x => x * scale);
  const sd = emp.sd * scale;
  const bw = P.bwFactor > 0 ? P.bwFactor * 1.06 * Math.max(sd, 1) * Math.pow(emp.nEff, -0.2) : 0.01;
  const grid = St.mixtureGrid({ samples, weights: ws, bw });
  const emax = [0];
  for (let k = 1; k <= P.maxK; k++) emax.push(St.gridExpectedMax(grid, k));
  return {
    kind: 'logs',
    mean, sd, nEff: emp.nEff, empMean: emp.mean, mRef, rho, short,
    sampleGames: m,
    emax,
    floor: Math.max(0, St.gridQuantile(grid, 0.1)),
    ceiling: St.gridQuantile(grid, 0.9),
  };
}

// No usable log: normal around the projection mean with a pooled CV.
function fitProjection(projMean, cv, P = PARAMS) {
  const sd = projMean * cv;
  const emax = [0];
  for (let k = 1; k <= P.maxK; k++) emax.push(projMean + sd * St.stdNormMax(k));
  return {
    kind: 'projection', mean: projMean, sd, nEff: 0, sampleGames: 0, emax,
    floor: Math.max(0, projMean - 1.2816 * sd),
    ceiling: projMean + 1.2816 * sd,
  };
}

// Pooled CV by (position group, minutes tier) from well-sampled log fits.
function pooledCv(fits) {
  const groups = {};
  for (const f of fits) {
    if (!f || f.kind !== 'logs' || f.nEff < 15 || !(f.mean > 5)) continue;
    const key = posGroup(f.pos) + ':' + minutesTier(f.mRef);
    (groups[key] ||= []).push(f.sd / f.mean);
  }
  const out = {};
  for (const [k, v] of Object.entries(groups)) {
    v.sort((a, b) => a - b);
    out[k] = v.length >= 5 ? v[v.length >> 1] : POOLED_CV_DEFAULT;
  }
  return out;
}
function cvFor(pooled, pos, min) {
  return pooled[posGroup(pos) + ':' + minutesTier(min || 0)] ?? POOLED_CV_DEFAULT;
}

module.exports = { PARAMS, fitLogs, fitProjection, pooledCv, cvFor, posGroup, minutesTier };
