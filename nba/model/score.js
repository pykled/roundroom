// League-profile scoring. Every score computation takes the profile: no stat
// weights are hardcoded here (nba/league-profile.js is the source of truth).
//
//   gameScore(line, profile)  line = { pts, reb, ast, stl, blk, to, pf, tech, ff? }
//   rowScore(logRow, profile) compact log row (sleeper.js): [day, week, hs, min, pts, reb, ast, stl, blk, to, pf, tf]
//                             (format 3 appends fga, fta, tpm, ff; ff scores when present, else 0)
//   playerExtras(rows, asOfDay)  recency-weighted pf/tech per minute + DD/TD game rates
//   ddCurve(logFiles)            league prior P(DD|means), P(TD|means) from historical games
//   projectedMean(statMeans, minutes, extras, curve, profile)
//
// DD/TD: a game's "doubles" = number of PTS/REB/AST/STL/BLK at 10 or more.
// DD bonus when doubles >= 2, TD bonus when doubles >= 3; whether a TD game
// also earns the DD bonus is profile.flags.tdAlsoCountsDD (see docs/nba-model.md).
'use strict';

const CATS = ['pts', 'reb', 'ast', 'stl', 'blk'];
const LINEAR = ['pts', 'reb', 'ast', 'stl', 'blk', 'to', 'pf', 'tech', 'ff'];
// Compact log row column of each stat (sleeper.js STAT_KEYS start at column 4; tf = tech).
const COL = { pts: 4, reb: 5, ast: 6, stl: 7, blk: 8, to: 9, pf: 10, tech: 11 };
// Flagrant fouls (Sleeper scores ff −1) sit at column 15 of format-3 rows
// ([…, tf, fga, fta, tpm, ff], Stream D). Format-2 rows carry no ff → 0.
const FF_COL = 15;
const ROW_LEN = 12;

function weightsOf(profile) {
  if (!profile || !profile.scoring) throw new Error('nba score: a league profile with .scoring is required');
  return profile.scoring;
}
const tdAlsoDD = profile => !(profile.flags && profile.flags.tdAlsoCountsDD === false);

function bonusFor(doubles, profile) {
  const sc = weightsOf(profile);
  let b = 0;
  if (doubles >= 3) b += sc.td || 0;
  if (doubles >= 2 && (doubles < 3 || tdAlsoDD(profile))) b += sc.dd || 0;
  return b;
}

const round2 = x => Math.round(x * 100) / 100;

function doublesOf(line) {
  let n = 0;
  for (const k of CATS) if ((+line[k] || 0) >= 10) n++;
  return n;
}

function gameScore(line, profile) {
  const sc = weightsOf(profile);
  if (!line) return 0;
  let s = 0;
  for (const k of LINEAR) {
    const v = k === 'tech' ? (line.tech ?? line.tf) : line[k];
    s += (sc[k] || 0) * (+v || 0);
  }
  return round2(s + bonusFor(doublesOf(line), profile));
}

function rowLine(g) {
  const line = {};
  for (const [k, c] of Object.entries(COL)) line[k] = g[c] || 0;
  line.ff = g.length > FF_COL ? +g[FF_COL] || 0 : 0;
  return line;
}
function hasLine(g) { return Array.isArray(g) && g.length >= ROW_LEN; }

// Score a compact log row. Rows without a stat line (format-1 data) cannot be
// re-scored, so this throws rather than silently using the old 1/1/2/3/3 value.
function rowScore(g, profile) {
  if (!hasLine(g)) throw new Error('nba score: log row has no stat line (re-run scripts/nba-ingest.js)');
  return gameScore(rowLine(g), profile);
}

// Expected DD/TD bonus per game given P(doubles >= 2) and P(doubles >= 3).
function expectedBonus(pDD, pTD, profile) {
  const sc = weightsOf(profile);
  const pd = Math.max(0, pDD), pt = Math.max(0, Math.min(pTD, pd));
  return (sc.dd || 0) * (tdAlsoDD(profile) ? pd : pd - pt) + (sc.td || 0) * pt;
}

// --- league prior: P(DD) and P(TD) as a function of a player's per-game means ---
// From historical games, not from means: for every well-sampled player the
// share of his games with >=2 (>=3) doubles is binned by the 2nd (3rd) largest
// of his PTS/REB/AST/STL/BLK means, averaged per bin and forced monotone.
const MIN_PLAYER_GAMES = 15;
const BINS = 20;

function kth(means, k) {
  return CATS.map(c => +means[c] || 0).sort((a, b) => b - a)[k - 1];
}

function ddCurve(logFiles) {
  const acc = { dd: Array.from({ length: BINS }, () => [0, 0]), td: Array.from({ length: BINS }, () => [0, 0]) };
  let pf = 0, tech = 0, min = 0;
  for (const file of logFiles || []) {
    for (const [pid, p] of Object.entries(file.players || {})) {
      if (!/^\d+$/.test(pid)) continue; // Sleeper also emits team-total rows (TEAM_DEN, ...)
      const rows = p.g.filter(hasLine);
      for (const g of rows) { pf += g[COL.pf]; tech += g[COL.tech]; min += g[3]; }
      if (rows.length < MIN_PLAYER_GAMES) continue;
      const means = {};
      for (const c of CATS) means[c] = rows.reduce((s, g) => s + g[COL[c]], 0) / rows.length;
      let nd = 0, nt = 0;
      for (const g of rows) { const d = doublesOf(rowLine(g)); if (d >= 2) nd++; if (d >= 3) nt++; }
      const bd = Math.min(BINS - 1, Math.floor(kth(means, 2)));
      const bt = Math.min(BINS - 1, Math.floor(kth(means, 3)));
      acc.dd[bd][0] += nd / rows.length; acc.dd[bd][1]++;
      acc.td[bt][0] += nt / rows.length; acc.td[bt][1]++;
    }
  }
  const curve = k => {
    const out = [];
    let prev = 0;
    for (let b = 0; b < BINS; b++) {
      const [s, n] = acc[k][b];
      const v = n ? s / n : prev;
      prev = Math.max(prev, v); // monotone non-decreasing in the mean
      out.push(Math.min(1, prev));
    }
    return out;
  };
  return {
    dd: curve('dd'), td: curve('td'),
    pfPerMin: min > 0 ? pf / min : 0.065,
    techPerMin: min > 0 ? tech / min : 0.0005,
  };
}

function priorDD(curve, means) {
  const b2 = Math.max(0, Math.min(BINS - 1, Math.floor(kth(means, 2))));
  const b3 = Math.max(0, Math.min(BINS - 1, Math.floor(kth(means, 3))));
  return { pDD: curve.dd[b2], pTD: Math.min(curve.td[b3], curve.dd[b2]) };
}

// --- per-player extras from his own games (recency-weighted like fit.js) ---
const EXTRA_PRIOR_GAMES = 10; // DD/TD rate shrinks to the league prior with this many pseudo-games

function playerExtras(rows, asOfDay, halfLifeDays = 45) {
  let sw = 0, sw2 = 0, wmin = 0, wpf = 0, wtech = 0, wdd = 0, wtd = 0;
  const wc = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0 };
  for (const g of rows || []) {
    if (!hasLine(g)) continue;
    const w = Math.pow(0.5, Math.max(0, asOfDay - g[0]) / halfLifeDays);
    sw += w; sw2 += w * w;
    wmin += w * g[3]; wpf += w * g[COL.pf]; wtech += w * g[COL.tech];
    const line = rowLine(g);
    const d = doublesOf(line);
    if (d >= 2) wdd += w;
    if (d >= 3) wtd += w;
    for (const c of CATS) wc[c] += w * line[c];
  }
  if (!(sw > 0)) return null;
  const means = {};
  for (const c of CATS) means[c] = wc[c] / sw;
  return {
    nEff: sw * sw / sw2,
    pfPerMin: wmin > 0 ? wpf / wmin : null,
    techPerMin: wmin > 0 ? wtech / wmin : null,
    ddRate: wdd / sw, tdRate: wtd / sw, means,
  };
}

// Expected per-game score under the profile for a projected stat line.
// statMeans = { pts, reb, ast, stl, blk, to } per-game means (Sleeper projection);
// pf / tech come from the player's own per-minute rates (league rate if none),
// DD/TD from his historical game rates shrunk to the league prior at these means.
function projectedMean(statMeans, minutes, extras, curve, profile) {
  const sc = weightsOf(profile);
  let s = 0;
  for (const k of ['pts', 'reb', 'ast', 'stl', 'blk', 'to']) s += (sc[k] || 0) * (+statMeans[k] || 0);
  const min = +minutes || 0;
  const pfRate = extras && extras.pfPerMin != null ? extras.pfPerMin : curve.pfPerMin;
  const techRate = extras && extras.techPerMin != null ? extras.techPerMin : curve.techPerMin;
  s += (sc.pf || 0) * pfRate * min + (sc.tech || 0) * techRate * min;
  const pr = priorDD(curve, statMeans);
  let pDD = pr.pDD, pTD = pr.pTD;
  if (extras) {
    const k = EXTRA_PRIOR_GAMES;
    pDD = (extras.nEff * extras.ddRate + k * pr.pDD) / (extras.nEff + k);
    pTD = (extras.nEff * extras.tdRate + k * pr.pTD) / (extras.nEff + k);
  }
  return s + expectedBonus(pDD, pTD, profile);
}

module.exports = {
  CATS, COL, FF_COL, ROW_LEN, gameScore, rowScore, rowLine, hasLine, doublesOf, bonusFor, expectedBonus,
  ddCurve, priorDD, playerExtras, projectedMean,
};
