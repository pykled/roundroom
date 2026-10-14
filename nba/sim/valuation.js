// League-scored player pool for the draft simulator (node only).
//
// ADAPTER (documented in docs/nba-draft-strategy.md and docs/nba-handoff-s1.md):
// the model (nba/model, stream B) values players under Yahoo High Score
// DEFAULT scoring (1/1/2/3/3). League 242808 scores PTS1 REB1.2 AST1.5 STL3
// BLK3 TO-1 PF-1 TECH-1 DD+5 TD+3. Until stream H1's profile-aware model is
// merged, this module re-scores every 2025 game stat line under the league
// weights and builds each player's per-game distribution as:
//   shape  = the player's own league-scored 2025 games (empirical),
//   mean   = model per-game HS mean (projection-shrunk, role-aware) x the
//            player's own (league mean / HS mean) ratio over the same games.
// When the board passed in is already profile-aware (H1: result.profile.leagueId
// matches, or players carry `scoringProfile`), the board's own `mean` is used
// as the league mean directly (ratio 1) — i.e. H1's values win.
//
// Each sim player gets, per league matchup week w (profile.weeks, incl. the two
// 14-day weeks): games[w] (team games in those dates), avail[w] (model
// availability rule incl. injury ramps) and weekEV[w] = E[best game of the week]
//   = sum_k Binom(k; games, avail) * E[max of k draws].
// value = mean of weekEV over all matchup weeks (each week counts equally).
'use strict';
const fs = require('fs');
const path = require('path');
const Lineup = require('./lineup');

const ROOT = path.join(__dirname, '..', '..');
const HS_SCORING = { pts: 1, reb: 1, ast: 2, stl: 3, blk: 3, to: 0, pf: 0, tech: 0, dd: 0, td: 0 };

// Local copy of the 242808 profile (used only if nba/league-profile.js is absent).
function fallbackProfile() {
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const lens = [6, 7, 7, 7, 7, 7, 14, 7, 7, 7, 7, 7, 7, 7, 7, 7, 14, 7, 7, 7, 7, 7];
  const weeks = [];
  let start = '2026-10-20';
  lens.forEach((days, i) => { const end = addDays(start, days - 1); weeks.push({ week: i + 1, start, end, days, playoffs: i + 1 >= 20 }); start = addDays(end, 1); });
  return {
    leagueId: '242808', name: 'HALIMSANITY 26-27', teams: 12, draft: { type: 'snake', pickSeconds: 90 },
    scoring: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, pf: -1, tech: -1, dd: 5, td: 3 },
    flags: { tdAlsoCountsDD: true },
    slots: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2, BN: 5, IL: 2 },
    starters: 9, rosterSize: 16, weeks, regularSeasonWeeks: 19, playoffTeams: 6,
  };
}
function loadProfile() {
  try { return require('../league-profile').defaultProfile(); } catch { return fallbackProfile(); }
}

// Game score under scoring weights. Row layout (format 2):
// [day, week, hs, min, pts, reb, ast, stl, blk, to, pf, tf]
function rowScore(g, sc, flags) {
  const pts = g[4], reb = g[5], ast = g[6], stl = g[7], blk = g[8];
  let s = sc.pts * pts + sc.reb * reb + sc.ast * ast + sc.stl * stl + sc.blk * blk +
    (sc.to || 0) * g[9] + (sc.pf || 0) * g[10] + (sc.tech || 0) * g[11];
  const d = (pts >= 10) + (reb >= 10) + (ast >= 10) + (stl >= 10) + (blk >= 10);
  if (d >= 3) s += sc.td || 0;
  if (d >= 2 && (d < 3 || !(flags && flags.tdAlsoCountsDD === false))) s += sc.dd || 0;
  return s;
}

// Prefer H1's format-2 logs (rows carry stat lines) when present, else our build.
function loadLines() {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'nba', 'logs-2025.json'), 'utf8'));
    const first = Object.values(l.players).find(p => p.g && p.g.length);
    if (first && first.g[0].length >= 12) {
      const out = {};
      for (const [pid, p] of Object.entries(l.players)) out[pid] = p.g;
      return { players: out, source: 'data/nba/logs-2025.json (format 2)' };
    }
  } catch { /* fall through */ }
  const f = path.join(__dirname, 'data', 'lines-2025.json');
  const l = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { players: l.players, source: 'nba/sim/data/lines-2025.json' };
}

// Discrete closed-form E[max of k] for sorted samples.
function emaxTable(sorted, K) {
  const m = sorted.length, out = new Float64Array(K + 1);
  if (!m) return out;
  for (let k = 1; k <= K; k++) {
    let e = 0, prev = 0;
    for (let i = 1; i <= m; i++) { const cur = Math.pow(i / m, k); e += sorted[i - 1] * (cur - prev); prev = cur; }
    out[k] = e;
  }
  return out;
}
function weekEVOf(emax, n, a) {
  if (!(n > 0) || !(a > 0)) return 0;
  let e = 0, c = 1;
  for (let k = 1; k <= n; k++) {
    c = c * (n - k + 1) / k;
    e += c * Math.pow(a, k) * Math.pow(1 - a, n - k) * emax[Math.min(k, emax.length - 1)];
  }
  return e;
}
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 1; };
const quantile = (s, p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
const NORM_Q = (() => { // 25 normal quantiles for synthetic samples (rookies / thin logs)
  const out = [];
  for (let i = 0; i < 25; i++) {
    const p = (i + 0.5) / 25;
    // Acklam-lite: inverse normal via bisection on erf approximation
    let lo = -5, hi = 5;
    for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (cdf(mid) < p) lo = mid; else hi = mid; }
    out.push((lo + hi) / 2);
  }
  return out;
  function cdf(z) {
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
    return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
})();
const group = p => (/C/.test((p.pos || []).join(',')) ? 'C' : null);

// boardRes = await require('../model').getPlayers({}) ; opts.scoring overrides profile.scoring.
function buildPool(boardRes, opts = {}) {
  const profile = opts.profile || loadProfile();
  const sc = opts.scoring || profile.scoring;
  const flags = opts.flags || profile.flags;
  const lay = Lineup.layout(profile.slots);
  const proj = opts.proj || JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'nba', 'proj-2026.json'), 'utf8'));
  const lines = opts.lines || loadLines();
  const h1 = !!(boardRes.profile && boardRes.profile.leagueId === profile.leagueId) ||
    !!(boardRes.players[0] && boardRes.players[0].scoringProfile === profile.leagueId);
  const isHS = opts.scoring === HS_SCORING;
  let availability = null, rawPlayers = {};
  try { availability = require('../model/board').availability; } catch { /* keep null */ }
  try { rawPlayers = require('../model/data').load().players; } catch { /* no notes */ }

  // League matchup week -> Sleeper projection weeks whose start date falls inside it.
  const sw = Object.entries(proj.weeks).map(([w, [s, e]]) => ({ w: +w, s, e }));
  const weekMap = profile.weeks.map(W => sw.filter(x => x.s >= W.start && x.s <= W.end).map(x => x.w));
  const W = profile.weeks.length;
  const K = 9;

  // Pass 1: per-player league/HS ratio from own games.
  const fits = new Map();
  const ratiosByGroup = { C: [], G: [], F: [] };
  // Basketball players only (Sleeper's NBA feed also lists team "DEF" entries).
  const board = boardRes.players.filter(p => (p.pos || []).some(x => /^(PG|SG|SF|PF|C|G|F|G\/F|F\/C)$/.test(String(x).toUpperCase())));
  for (const p of board) {
    const g = (lines.players[p.id] || []).filter(r => r[3] >= 4);
    const grp = group(p) || ((p.pos || []).some(x => /G/.test(x)) ? 'G' : 'F');
    if (g.length >= 8) {
      const ls = g.map(r => rowScore(r, sc, flags));
      const hsMean = g.reduce((s, r) => s + r[2], 0) / g.length;
      const lMean = ls.reduce((s, x) => s + x, 0) / ls.length;
      const ratio = hsMean > 1 ? lMean / hsMean : 1;
      fits.set(p.id, { ls, ratio, n: g.length, grp });
      if (g.length >= 20 && hsMean > 15) ratiosByGroup[grp].push(ratio);
    } else fits.set(p.id, { ls: null, ratio: null, n: g.length, grp });
  }
  const groupRatio = { C: median(ratiosByGroup.C), G: median(ratiosByGroup.G), F: median(ratiosByGroup.F) };

  const pool = [];
  for (const p of board) {
    const f = fits.get(p.id);
    const ratio = h1 ? 1 : (f.ratio != null ? f.ratio : groupRatio[f.grp]);
    const mean = Math.max(0, (p.mean || 0) * ratio);
    let samples;
    if (f.ls && mean > 0) {
      const m0 = f.ls.reduce((s, x) => s + x, 0) / f.ls.length;
      const k = m0 > 0.5 ? mean / m0 : 1;
      samples = f.ls.map(x => x * k);
    } else if (mean > 0) {
      const sd = Math.max(1, (p.sd || mean * 0.3) * (h1 ? 1 : ratio));
      samples = NORM_Q.map(z => mean + sd * z);
    } else samples = [0];
    samples.sort((a, b) => a - b);
    const sMean = samples.reduce((s, x) => s + x, 0) / samples.length;
    const sSd = Math.sqrt(samples.reduce((s, x) => s + (x - sMean) ** 2, 0) / Math.max(1, samples.length - 1));
    const emax = emaxTable(samples, K);
    const a0 = Number.isFinite(p.availability) ? p.availability : 0.85;
    const info = { injury: p.injury, injuryNotes: (rawPlayers[p.id] || {}).in, outForSeason: p.outForSeason };
    const games = new Float64Array(W), avail = new Float64Array(W), weekEV = new Float64Array(W);
    for (let w = 0; w < W; w++) {
      let n = 0;
      for (const s of weekMap[w]) n += ((proj.teamGames[p.team] || {})[s] || 0);
      games[w] = n;
      avail[w] = p.outForSeason ? 0 : availability ? availability(info, a0, w) : Math.max(a0, 0.55);
      weekEV[w] = mean > 0 ? weekEVOf(emax, n, avail[w]) : 0;
    }
    const value = weekEV.reduce((s, x) => s + x, 0) / W;
    pool.push({
      id: p.id, name: p.name, team: p.team, pos: p.pos, yahooElig: p.yahooElig || null,
      injury: p.injury || null, outForSeason: !!p.outForSeason,
      mean: sMean, sd: sSd, ceiling: quantile(samples, 0.9), floor: quantile(samples, 0.1),
      samples: Float64Array.from(samples), bw: 0.25 * 1.06 * sSd * Math.pow(samples.length, -0.2),
      emax, games, avail, weekEV, value, a0,
      hsRank: p.rank, hsValue: p.hsValue, sampleGames: f.n, source: p.source, ratio,
      posLowConfidence: !p.yahooElig, // Sleeper→Yahoo position mapping until Yahoo connects
    });
  }
  pool.sort((a, b) => b.value - a.value || b.mean - a.mean || a.name.localeCompare(b.name));
  pool.forEach((p, i) => { p.rank = i + 1; p.idx = i; p.mask = Lineup.slotMask(p, lay); });
  return { profile, layout: lay, players: pool, weeks: W, weekMap, groupRatio, linesSource: lines.source, h1Values: h1 };
}

async function loadPool(opts = {}) {
  if (opts.offline !== false) process.env.NBA_MODEL_OFFLINE = process.env.NBA_MODEL_OFFLINE || '1';
  const res = await require('../model').getPlayers({});
  return buildPool(res, opts);
}

module.exports = { buildPool, loadPool, loadProfile, fallbackProfile, rowScore, emaxTable, weekEVOf, HS_SCORING };
