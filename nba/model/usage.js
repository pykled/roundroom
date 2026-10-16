// Usage proxy from format-3 compact log rows (sleeper.js LOG_FORMAT 3):
//   [day, week, hs, min, pts, reb, ast, stl, blk, to, pf, tf, fga, fta, tpm, ff]
//
// usageRate per game = (fga + 0.44·fta + to) / min, summed over games then divided
// by summed minutes (minute-weighted, so a 4-minute garbage-time game doesn't
// dominate). Season rate vs the last 5 games gives the trend at ±0.03.
// Format-2 rows have no fga/fta; they are skipped, and a player with none
// gets nulls (never NaN), which is the shape signals.usage already allows.
'use strict';

const COL = { min: 3, to: 9, fga: 12, fta: 13, tpm: 14, ff: 15 };
const MIN_MINUTES = 40;   // below this a rate is noise
const LAST_N = 5;
const TREND = 0.03;

const hasUsage = g => Array.isArray(g) && g.length > COL.ff - 2 && Number.isFinite(g[COL.fga]) && Number.isFinite(g[COL.fta]);
const r3 = x => Math.round(x * 1000) / 1000;

function rate(rows) {
  let min = 0, poss = 0;
  for (const g of rows) { min += g[COL.min]; poss += g[COL.fga] + 0.44 * g[COL.fta] + g[COL.to]; }
  return min >= MIN_MINUTES ? poss / min : null;
}

// rows: a player's compact log rows (oldest → newest). Returns
// { fga, fta, usageRate, last5, trend: 'up'|'down'|'flat'|null, games }
// fga/fta are per-game season means.
function usageStats(rows) {
  const ok = (rows || []).filter(hasUsage);
  const out = { fga: null, fta: null, usageRate: null, last5: null, trend: null, games: ok.length };
  if (!ok.length) return out;
  out.fga = r3(ok.reduce((s, g) => s + g[COL.fga], 0) / ok.length);
  out.fta = r3(ok.reduce((s, g) => s + g[COL.fta], 0) / ok.length);
  const season = rate(ok);
  const recent = rate(ok.slice(-LAST_N));
  out.usageRate = season == null ? null : r3(season);
  out.last5 = recent == null ? null : r3(recent);
  if (season != null && recent != null) {
    const d = recent - season;
    out.trend = d >= TREND ? 'up' : d <= -TREND ? 'down' : 'flat';
  }
  return out;
}

module.exports = { usageStats, hasUsage, COL, TREND, LAST_N };
