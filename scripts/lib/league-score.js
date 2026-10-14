// League-scoring adapter for the offline cheat sheet (used only when nba/league-profile.js is absent
// or the input JSON is not already profile-valued).
//
// The model values players on Yahoo High Score game = pts + reb + 2ast + 3stl + 3blk. League 242808 scores
// custom weights. Game logs only keep the HS total, so per-stat rates come from a committed snapshot of
// Sleeper's 2026 per-game season projection (scripts/fixtures/nba-cheat-stats.json). Per player we compute
//   ratio = leagueScorePerGame / hsScorePerGame
// and scale the model's hsValue / mean / sd / ceiling / floor by it. Approximation: ignores that the DD/TD
// bonus changes the *shape* of the distribution (it makes it spikier => a touch more upside than shown).
'use strict';
const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'nba-cheat-stats.json');
const LEAGUE_WEIGHTS = { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, pf: -1, tech: -1, dd: 5, td: 3 };
const SLOTS = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'];
const PF_PER_MIN = 0.066;   // Sleeper has no PF for most players: ~2.0 fouls / 30 min league-wide
const TECH_PER_GAME = 0.02; // league-typical technicals per player-game

function loadFixture(file = FIXTURE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Raw Sleeper season-projection rows -> compact fixture.
function compactStats(rows, generatedAt) {
  const stats = {};
  for (const r of rows) {
    const s = r && r.stats;
    if (!r.player_id || !s || !(s.gp > 0) || !(s.pts >= 0)) continue;
    const gp = s.gp;
    const v = k => (s[k] || 0) / gp;
    const rd = x => Math.round(x * 1000) / 1000;
    stats[r.player_id] = [v('pts'), v('reb'), v('ast'), v('stl'), v('blk'), v('to'), v('dd'), v('td'),
      (s.sp || 0) / gp / 60, s.pf != null ? v('pf') : null].map(x => (x == null ? null : rd(x)));
  }
  return { season: '2026', generatedAt, source: 'api.sleeper.com/projections/nba/2026 (season, per game)', fields: ['pts', 'reb', 'ast', 'stl', 'blk', 'to', 'dd', 'td', 'min', 'pf'], stats };
}

const hsPerGame = a => a[0] + a[1] + 2 * a[2] + 3 * a[3] + 3 * a[4];
function leaguePerGame(a, w = LEAGUE_WEIGHTS, flags = {}) {
  const [pts, reb, ast, stl, blk, to, dd, td, min, pf] = a;
  const fouls = pf != null ? pf : PF_PER_MIN * min;
  // Sleeper's dd rate already includes triple-doubles. flags.tdAlsoCountsDD=false => a TD pays td only.
  const ddOnly = flags.tdAlsoCountsDD === false ? Math.max(0, dd - td) : dd;
  return w.pts * pts + w.reb * reb + w.ast * ast + w.stl * stl + w.blk * blk + w.to * to
    + w.pf * fouls + w.tech * TECH_PER_GAME + w.dd * ddOnly + w.td * td;
}

// Eligibility from Sleeper positions (low confidence; Yahoo's own positions replace this once connected).
// Contract: PG<-PG; SG<-SG,G; G<-PG,SG; SF<-SF,F; PF<-PF,F,F/C; F<-SF,PF; C<-C,F/C; UTIL<-anyone.
function eligibility(pos) {
  const has = x => pos.includes(x);
  const out = [];
  if (has('PG')) out.push('PG');
  if (has('SG') || has('G')) out.push('SG');
  if (has('PG') || has('SG') || has('G')) out.push('G');
  if (has('SF') || has('F')) out.push('SF');
  if (has('PF') || has('F')) out.push('PF');
  if (has('SF') || has('PF') || has('F')) out.push('F');
  if (has('C')) out.push('C');
  out.push('UTIL');
  return out;
}

// Gap-based tiers over the top `pool` (same idea as the model: top-15% gaps, min 0.5 points).
function assignTiers(players, pool = 200) {
  const top = players.slice(0, pool);
  const gaps = [];
  for (let i = 0; i < top.length - 1; i++) gaps.push(top[i].value - top[i + 1].value);
  const sorted = [...gaps].sort((a, b) => a - b);
  const thresh = Math.max(0.5, sorted[Math.floor(sorted.length * 0.85)] || 0);
  let tier = 1;
  players.forEach((p, i) => {
    if (i > 0 && i < top.length && gaps[i - 1] >= thresh) tier++;
    if (i === top.length) tier++;
    p.tier = tier;
  });
}

const r1 = x => Math.round(x * 10) / 10;

// modelPlayers: output of nba/model getPlayers().players (HS-valued). Returns league-valued, ranked list.
function applyAdapter(modelPlayers, { fixture, weights = LEAGUE_WEIGHTS, flags = {} } = {}) {
  const stats = (fixture && fixture.stats) || {};
  const ratios = [];
  for (const p of modelPlayers) {
    const a = stats[p.id];
    if (a && hsPerGame(a) > 5) ratios.push(leaguePerGame(a, weights, flags) / hsPerGame(a));
  }
  ratios.sort((x, y) => x - y);
  const medianRatio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
  const out = modelPlayers.map(p => {
    const a = stats[p.id];
    const known = !!(a && hsPerGame(a) > 5);
    const ratio = known ? leaguePerGame(a, weights, flags) / hsPerGame(a) : medianRatio;
    return {
      id: p.id, name: p.name, team: p.team, pos: p.pos, elig: eligibility(p.pos || []),
      injury: p.injury || null, outForSeason: !!p.outForSeason,
      mean: r1(p.mean * ratio), sd: r1(p.sd * ratio), ceiling: r1(p.ceiling * ratio), floor: r1(p.floor * ratio),
      value: r1(p.hsValue * ratio), games: p.games, source: p.source, ratio: Math.round(ratio * 1000) / 1000, ratioKnown: known,
    };
  });
  return finish(out);
}

function finish(list) {
  list.sort((a, b) => b.value - a.value || b.mean - a.mean || a.name.localeCompare(b.name));
  list.forEach((p, i) => { p.rank = i + 1; });
  assignTiers(list);
  return list;
}

module.exports = { LEAGUE_WEIGHTS, SLOTS, FIXTURE, loadFixture, compactStats, leaguePerGame, hsPerGame, eligibility, assignTiers, applyAdapter, finish, r1 };
