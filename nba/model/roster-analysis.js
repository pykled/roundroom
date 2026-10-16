// Shared layer (Stream A): one roster's lineup, slot-group tiers, needs and
// surplus. Used by the trade calculator (fit before/after) and the team page
// (per-team rows). Contract: docs/nba-trade-team-spec.md §3.4.
// Example output: docs/nba-spec/fixtures/roster-analysis.example.json.
//
//   analyzeRoster({ players, profile, weeks, replacement, leagueAvg?, strongCutoff?, eta? }) → RosterAnalysis
//   weekValue(players, profile, week, replacement, opts?) → { total, starters, bench, holes }
//
// Groups (slot groups, not positions): G = PG+SG+G slots (PG/SG-eligible players),
// F = SF+PF+F (SF/PF-eligible), C = C, UTIL = depth. PG/SG/SF/PF are display-only
// single slots by primary position. Tier matrix is the NFL one (shared/analysis.js):
// depth (rostered ≤ slots → need, ≥ 2× → surplus) × quality (starterValue vs league
// avg; strong = top 30%) → critical / upgrade / thin / solid / deep / loaded.
// Stubs until Stream A lands.
'use strict';

const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';
function notImplemented(name) {
  const e = new Error(`nba shared layer: ${name} not implemented yet (Stream A)`);
  e.code = NOT_IMPLEMENTED;
  throw e;
}

const GROUPS = ['G', 'F', 'C', 'UTIL'];
const DISPLAY_GROUPS = ['PG', 'SG', 'SF', 'PF'];
const GROUP_SLOTS = { G: ['PG', 'SG', 'G'], F: ['SF', 'PF', 'F'], C: ['C'], UTIL: ['UTIL'] };
const GROUP_ELIG = { G: ['PG', 'SG'], F: ['SF', 'PF'], C: ['C'], UTIL: null };
const TIERS = ['critical', 'upgrade', 'thin', 'solid', 'deep', 'loaded'];
const STRONG_SHARE = 0.30;
const ELITE_VALUE = 45;             // pts/wk, or top-24 on the board
const LIABILITY_MARGIN = 3;         // starter within this many pts/wk of replacement
// Same multipliers the NFL Roster Fit uses (trade.html NEED_MULT); the NBA trade
// calculator shows them as context on the fit panel, it does not re-multiply values.
const NEED_MULT = { critical: 1.30, upgrade: 1.15, thin: 1.10, solid: 1.00, deep: 0.90, loaded: 0.80 };

// Collapse a tier to need / neutral / surplus (partner matching vocabulary).
function tierStatus(tier) {
  if (tier === 'critical' || tier === 'upgrade' || tier === 'thin') return 'need';
  if (tier === 'deep' || tier === 'loaded') return 'surplus';
  return 'neutral';
}

// NFL matrix, verbatim (shared/analysis.js assessDepthAndQuality).
function assessTier(rostered, slots, starterValue, leagueAvg, strongCutoff) {
  if (!slots || slots <= 0) return 'solid';
  const depth = rostered <= slots ? 'need' : rostered >= slots * 2 ? 'surplus' : 'neutral';
  const v = Number.isFinite(starterValue) ? starterValue : 0;
  const weak = Number.isFinite(leagueAvg) && v < leagueAvg;
  const strong = !weak && Number.isFinite(strongCutoff) && v >= strongCutoff;
  if (depth === 'need') return weak ? 'critical' : 'thin';
  if (depth === 'surplus') return weak ? 'upgrade' : (strong ? 'loaded' : 'deep');
  return weak ? 'upgrade' : 'solid';
}

function analyzeRoster() { notImplemented('analyzeRoster'); }
function weekValue() { notImplemented('weekValue'); }

module.exports = {
  analyzeRoster, weekValue, tierStatus, assessTier,
  GROUPS, DISPLAY_GROUPS, GROUP_SLOTS, GROUP_ELIG, TIERS, STRONG_SHARE, ELITE_VALUE, LIABILITY_MARGIN, NEED_MULT, NOT_IMPLEMENTED,
};
