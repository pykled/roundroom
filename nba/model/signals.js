// Shared layer (Stream A): per-player signals for the trade calculator (B) and
// the team page (C). Contract: docs/nba-trade-team-spec.md §3.3.
// Example output: docs/nba-spec/fixtures/signals.example.json.
//
//   playerSignals(player, ctx) → Signals
//   signalsFor(players, ctx)   → Map<id, Signals>
//   ctx = { profile, currentWeek, weeks: [{ week, weight, playoff }], logs, proj, market, eta, bio, replacement, today }
//
// Every number is finite or null (never NaN). Form/minutes carry `stale` when the
// last logged game is more than 21 days old. `usage` stays null until Stream D
// adds fga/fta to the compact logs. Stubs until Stream A lands.
'use strict';

const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';
function notImplemented(name) {
  const e = new Error(`nba shared layer: ${name} not implemented yet (Stream A)`);
  e.code = NOT_IMPLEMENTED;
  throw e;
}

// Thresholds shared with the NFL side (shared/factors.js) and nba/model/research.js.
const FORM_HOT = 1.20, FORM_COLD = 0.80, FORM_GAMES = 5, FORM_MIN_SEASON_GAMES = 10, FORM_MIN_MEAN = 10;
const MINUTES_TREND = 3;            // ± minutes per game, last 5 vs season
const STALE_DAYS = 21;
const HEAVY_WEEK = 4, LIGHT_WEEK = 2;
const MARKET_WEIGHT0 = 0.30, MARKET_DECAY_WEEKS = 10;   // weight = 0.30 · max(0, 1 − (week−1)/10)
const FLAGS = ['hot', 'cold', 'minutes-up', 'minutes-down', 'out-until', 'ofs', 'heavy-schedule', 'light-schedule', 'market-value', 'market-reach', 'rookie', 'new-team', 'thin-sample', 'stale-stats'];

function marketWeight(currentWeek) {
  const w = Number(currentWeek) || 1;
  return Math.max(0, MARKET_WEIGHT0 * (1 - (w - 1) / MARKET_DECAY_WEEKS));
}

function playerSignals() { notImplemented('playerSignals'); }
function signalsFor() { notImplemented('signalsFor'); }

module.exports = {
  playerSignals, signalsFor, marketWeight,
  FORM_HOT, FORM_COLD, FORM_GAMES, FORM_MIN_SEASON_GAMES, FORM_MIN_MEAN, MINUTES_TREND, STALE_DAYS, HEAVY_WEEK, LIGHT_WEEK,
  MARKET_WEIGHT0, MARKET_DECAY_WEEKS, FLAGS, NOT_IMPLEMENTED,
};
