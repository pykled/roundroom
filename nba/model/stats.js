// Distribution math for the High Score value model. Pure, deterministic.
//
// expectedMax uses EXACT order statistics, not simulation:
//   E[max of n iid draws] = ∫ x d(F(x)^n)
// - plain sample array  → discrete empirical CDF, closed form Σ x_(i)·[(i/m)^n − ((i−1)/m)^n]
// - { mean, sd }        → normal; mean + sd·e_n with e_n = E[max of n std normals] (tabulated once)
// - { samples, weights, bw } → weighted Gaussian-kernel mixture, F^n integrated on a grid
// Exact integration is deterministic by construction (no RNG, no Monte-Carlo noise
// between requests) and ~50× cheaper than a 10k-draw simulation per player.
// scripts/test-nba-model.js cross-checks it against a seeded Monte-Carlo run.
'use strict';

// Abramowitz–Stegun 7.1.26 erf (|error| < 1.5e-7).
function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// e_n = E[max of n iid N(0,1)] = ∫ (1 − Φ(z)^n) dz over z>0 − ∫ Φ(z)^n dz over z<0
const stdNormMaxCache = [0];
function stdNormMax(n) {
  if (stdNormMaxCache[n] != null) return stdNormMaxCache[n];
  const step = 0.005;
  let s = 0;
  for (let z = -9; z < 9; z += step) {
    const zm = z + step / 2;
    const Fn = Math.pow(normCdf(zm), n);
    s += zm >= 0 ? (1 - Fn) * step : -Fn * step;
  }
  stdNormMaxCache[n] = s;
  return s;
}

// Mixture-of-Gaussians CDF evaluated on a uniform grid → { xs, F }.
const GRID = 240;
function mixtureGrid({ samples, weights, bw }) {
  const m = samples.length;
  let wsum = 0;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < m; i++) {
    wsum += weights ? weights[i] : 1;
    if (samples[i] < lo) lo = samples[i];
    if (samples[i] > hi) hi = samples[i];
  }
  const h = Math.max(bw || 0, 1e-6);
  lo -= 5 * h; hi += 5 * h;
  const dx = (hi - lo) / (GRID - 1);
  const xs = new Float64Array(GRID);
  const F = new Float64Array(GRID);
  for (let g = 0; g < GRID; g++) {
    const x = lo + g * dx;
    xs[g] = x;
    let c = 0;
    for (let i = 0; i < m; i++) c += (weights ? weights[i] : 1) * normCdf((x - samples[i]) / h);
    F[g] = c / wsum;
  }
  return { xs, F, dx };
}

function gridExpectedMax(grid, n) {
  const { xs, F, dx } = grid;
  // E[max] = hi − ∫ F^n dx  (support [lo, hi]); lo carries the mass below the grid (≈0).
  let integral = 0;
  for (let g = 0; g < xs.length - 1; g++) {
    integral += (Math.pow(F[g], n) + Math.pow(F[g + 1], n)) / 2 * dx;
  }
  return xs[xs.length - 1] - integral;
}

function gridQuantile(grid, p) {
  const { xs, F } = grid;
  for (let g = 1; g < xs.length; g++) {
    if (F[g] >= p) {
      const f0 = F[g - 1], f1 = F[g];
      return f1 > f0 ? xs[g - 1] + (p - f0) / (f1 - f0) * (xs[g] - xs[g - 1]) : xs[g];
    }
  }
  return xs[xs.length - 1];
}

function expectedMax(dist, n) {
  n = Math.floor(n);
  if (!dist || !(n > 0)) return 0;
  if (Array.isArray(dist)) {
    const xs = dist.filter(Number.isFinite).sort((a, b) => a - b);
    const m = xs.length;
    if (!m) return 0;
    let e = 0, prev = 0;
    for (let i = 1; i <= m; i++) {
      const cur = Math.pow(i / m, n);
      e += xs[i - 1] * (cur - prev);
      prev = cur;
    }
    return e;
  }
  if (dist.samples) {
    if (!dist.samples.length) return 0;
    return gridExpectedMax(dist.grid || mixtureGrid(dist), n);
  }
  const mean = +dist.mean || 0;
  const sd = Math.max(+dist.sd || 0, 0);
  return mean + sd * stdNormMax(n);
}

// Expected max when each of n scheduled games is played independently with
// probability a (missed games score 0, and a week with no games played scores 0):
//   Σ_k C(n,k) a^k (1−a)^(n−k) · E[max_k]
function expectedMaxAvail(emaxByK, n, a) {
  if (!(n > 0) || !(a > 0)) return 0;
  if (a >= 1) return emaxByK(n);
  let e = 0, c = 1;
  for (let k = 0; k <= n; k++) {
    if (k > 0) {
      c = c * (n - k + 1) / k;
      e += c * Math.pow(a, k) * Math.pow(1 - a, n - k) * emaxByK(k);
    }
  }
  return e;
}

function weightedMeanSd(xs, ws) {
  let sw = 0, sx = 0, sw2 = 0;
  for (let i = 0; i < xs.length; i++) { sw += ws[i]; sx += ws[i] * xs[i]; sw2 += ws[i] * ws[i]; }
  const mean = sx / sw;
  let v = 0;
  for (let i = 0; i < xs.length; i++) v += ws[i] * (xs[i] - mean) ** 2;
  const nEff = sw * sw / sw2;
  // Bessel-style correction on the effective sample size.
  const sd = Math.sqrt(v / sw * (nEff > 1 ? nEff / (nEff - 1) : 1));
  return { mean, sd, nEff };
}

function weightedQuantile(xs, ws, p) {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const total = ws.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const i of idx) { acc += ws[i]; if (acc >= p * total) return xs[i]; }
  return xs[idx[idx.length - 1]];
}

// mulberry32 — seeded PRNG for the Monte-Carlo cross-check in tests.
function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  normCdf, stdNormMax, mixtureGrid, gridExpectedMax, gridQuantile,
  expectedMax, expectedMaxAvail, weightedMeanSd, weightedQuantile, seededRng,
};
