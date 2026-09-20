// FPA calibration — pure functions shared by lineup.html (browser), server.js
// and scripts (node). Turns the per-week history files in data/history/ into a
// per-position scale for the matchup factor in shared/weekly-score.js.
//
// The matchup factor assumes a #1 matchup (opponent allows the most points to
// the position) is worth ×1.2 and a #32 matchup ×0.8 — a straight line from
// rank fraction 0 → 1 with slope −0.4. Each history file records, for every
// player who played that week, the matchup rank the engine saw BEFORE the
// week (no hindsight) plus his projection and actual points. Regressing
// actual ÷ projected on the rank fraction gives the slope the data actually
// shows; scale = observed slope ÷ modelled slope. Examples:
//   scale 1.0  → the ±20% swing is right as modelled
//   scale 0.5  → high-FPA matchups only paid off half as much → swing ±10%
//   scale 0    → no relationship (or backwards) → matchup factor neutral
// Confidence ramps with the number of logged weeks (nothing below 3, full at
// 6) so a 3-week fluke can only nudge the swing, not flip it.
//
// history: [{ week, fpa: { name: { pos, fpaRank, fpaTeams, proj, actualPoints } } }]
var FPACalibration = (function () {
  'use strict';

  var MODELLED_SLOPE = -0.4;       // MATCHUP_BEST − MATCHUP_WORST over the rank fraction 0 → 1
  var MIN_WEEKS = 3;               // no calibration until this many weeks are logged
  var FULL_WEEKS = 6;              // full confidence from here
  var MIN_PROJ = 5;                // half-PPR projection floor: below this actual/proj is noise
  var MIN_SAMPLES_POS = 60;        // per-position fit needs this many player-weeks
  var MIN_SAMPLES_ALL = 150;       // pooled fit needs this many
  var RATIO_CAP = 3;               // one 4-TD game shouldn't own the regression
  var SCALE_MIN = 0, SCALE_MAX = 1.5;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // One sample per player-week with a usable rank + projection.
  function samples(history) {
    var out = [];
    (history || []).forEach(function (h) {
      var entries = h && h.fpa;
      if (!entries) return;
      for (var name in entries) {
        var e = entries[name];
        if (!e || !(e.proj >= MIN_PROJ) || e.actualPoints == null) continue;
        if (!(e.fpaRank >= 1) || !(e.fpaTeams >= 2)) continue;
        out.push({
          week: h.week, pos: e.pos,
          frac: (e.fpaRank - 1) / (e.fpaTeams - 1),
          ratio: clamp(e.actualPoints / e.proj, 0, RATIO_CAP),
          w: e.proj,
        });
      }
    });
    return out;
  }

  // Weighted least squares of ratio on frac → { n, slope, intercept }.
  function fit(rows) {
    var sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    rows.forEach(function (r) {
      sw += r.w; sx += r.w * r.frac; sy += r.w * r.ratio;
      sxx += r.w * r.frac * r.frac; sxy += r.w * r.frac * r.ratio;
    });
    if (!sw) return { n: rows.length, slope: null, intercept: null };
    var mx = sx / sw, my = sy / sw;
    var vx = sxx / sw - mx * mx;
    if (vx <= 1e-9) return { n: rows.length, slope: null, intercept: my };
    var slope = (sxy / sw - mx * my) / vx;
    return { n: rows.length, slope: slope, intercept: my - slope * mx };
  }

  function confidence(weeks) {
    return clamp((weeks - (MIN_WEEKS - 1)) / (FULL_WEEKS - (MIN_WEEKS - 1)), 0, 1);
  }

  // rawScale = observed ÷ modelled slope; scale = rawScale shrunk toward 1 by confidence.
  function calibrate(rows, weeks, minSamples) {
    var f = fit(rows);
    var enough = f.n >= minSamples && f.slope != null;
    var rawScale = enough ? clamp(f.slope / MODELLED_SLOPE, SCALE_MIN, SCALE_MAX) : null;
    var conf = confidence(weeks);
    return {
      n: f.n, slope: f.slope, intercept: f.intercept,
      rawScale: rawScale,
      confidence: conf,
      scale: rawScale == null ? 1 : 1 + (rawScale - 1) * conf,
      enough: enough,
    };
  }

  // history → { weeks, samples, byPos, overall, active }. `active` is false
  // when fewer than MIN_WEEKS weeks are logged (every scale is then 1).
  function build(history) {
    var rows = samples(history);
    var weekSet = {};
    (history || []).forEach(function (h) { if (h && h.week && h.fpa && Object.keys(h.fpa).length) weekSet[h.week] = true; });
    var weeks = Object.keys(weekSet).map(Number).sort(function (a, b) { return a - b; });
    var active = weeks.length >= MIN_WEEKS;
    var byPos = {};
    var groups = {};
    rows.forEach(function (r) { (groups[r.pos] = groups[r.pos] || []).push(r); });
    for (var pos in groups) {
      var c = calibrate(groups[pos], weeks.length, MIN_SAMPLES_POS);
      if (!active) c.scale = 1;
      byPos[pos] = c;
    }
    var overall = calibrate(rows, weeks.length, MIN_SAMPLES_ALL);
    if (!active) overall.scale = 1;
    return {
      modelledSlope: MODELLED_SLOPE,
      weeks: weeks, samples: rows.length, active: active,
      byPos: byPos, overall: overall,
      generatedAt: new Date().toISOString(),
    };
  }

  // Effective scale for a position: per-position fit when it had enough
  // samples, else the pooled fit, else 1. Same lookup weekly-score.js does
  // inline (kept dependency-free there), exposed here for tests and the UI.
  function scaleFor(calibration, pos) {
    if (!calibration || !calibration.active) return 1;
    var p = calibration.byPos && calibration.byPos[pos];
    if (p && p.enough) return p.scale;
    var o = calibration.overall;
    if (o && o.enough) return o.scale;
    return 1;
  }

  return {
    build: build, samples: samples, fit: fit, scaleFor: scaleFor, confidence: confidence,
    MODELLED_SLOPE: MODELLED_SLOPE, MIN_WEEKS: MIN_WEEKS, FULL_WEEKS: FULL_WEEKS, MIN_PROJ: MIN_PROJ,
    MIN_SAMPLES_POS: MIN_SAMPLES_POS, MIN_SAMPLES_ALL: MIN_SAMPLES_ALL,
  };
})();

if (typeof module !== 'undefined') module.exports = FPACalibration;
