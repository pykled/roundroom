// League profiles: the one source of truth for a league's scoring, roster slots
// and matchup-week calendar (docs/nba-contracts.md "Phase 3 addendum").
//
//   getProfile(leagueId = '242808') → profile | null (unknown league)
//   defaultProfile()                → Dillon's league 242808 "HALIMSANITY 26-27"
//   highScoreDefaultProfile()       → Yahoo High Score defaults (1/1/2/3/3, G,G,FC,FC,FC,UTIL)
//
// Every call returns a fresh deep copy, so callers may mutate (e.g. a later
// Yahoo sync overriding fields from /api/nba/yahoo/league) without leaking state.
'use strict';

const DAY_MS = 86400000;
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

// Consecutive matchup weeks starting `first`, with the given lengths in days.
function buildWeeks(first, lengths, playoffFrom) {
  const out = [];
  let start = first;
  lengths.forEach((days, i) => {
    const end = addDays(start, days - 1);
    const w = { week: i + 1, start, end, days };
    if (playoffFrom) w.playoffs = i + 1 >= playoffFrom;
    out.push(w);
    start = addDays(end, 1);
  });
  return out;
}

const rep = (n, v) => Array.from({ length: n }, () => v);

// 242808, from the league Settings pages read 2026-10-13 (confirmed by Dillon):
// week 1 = Oct 20-25 (6 days); weeks 7 (Nov 30-Dec 13) and 17 (Feb 15-28) are
// 14-day matchups; regular season 1-19, playoffs (6 teams) 20-22.
const HALIMSANITY = {
  leagueId: '242808',
  name: 'HALIMSANITY 26-27',
  teams: 12,
  aggregation: 'high-score', // each starter's single best game of the matchup week counts
  draft: { type: 'snake', pickSeconds: 90 },
  scoring: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, pf: -1, tech: -1, dd: 5, td: 3 },
  // Yahoo's stat feed records Double-Doubles and Triple-Doubles as two separate
  // stats, and a triple-double game also satisfies the double-double definition
  // (10+ in at least two of PTS/REB/AST/STL/BLK), so it earns both bonuses.
  // Sleeper's feed (same convention) marks dd=1 on every td=1 row. NOT confirmed
  // from an official Yahoo help page; see docs/nba-model.md "DD/TD semantics".
  flags: { tdAlsoCountsDD: true },
  slots: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2, BN: 5, IL: 2 },
  starters: 9,
  rosterSize: 16,
  weeks: buildWeeks('2026-10-20', [6, ...rep(5, 7), 14, ...rep(9, 7), 14, ...rep(5, 7)], 20),
  regularSeasonWeeks: 19,
  playoffTeams: 6,
  maxAddsPerWeek: 10,
  tradeEnd: '2027-03-04',
};

// Yahoo High Score defaults, for any league without a stored profile.
const HIGH_SCORE_DEFAULT = {
  leagueId: null,
  name: 'Yahoo High Score (defaults)',
  teams: 10,
  aggregation: 'high-score',
  draft: { type: 'snake', pickSeconds: 90 },
  scoring: { pts: 1, reb: 1, ast: 2, stl: 3, blk: 3, to: 0, pf: 0, tech: 0, dd: 0, td: 0 },
  flags: { tdAlsoCountsDD: true },
  slots: { PG: 0, SG: 0, G: 2, SF: 0, PF: 0, F: 0, FC: 3, C: 0, UTIL: 1, BN: 4, IL: 0 },
  starters: 6,
  rosterSize: 10,
  // Plain Mon-Sun weeks (week 1 Tue-Sun) through the end of the NBA regular season.
  weeks: buildWeeks('2026-10-20', [6, ...rep(24, 7)]),
  regularSeasonWeeks: 25,
  playoffTeams: 0,
  maxAddsPerWeek: null,
  tradeEnd: null,
};

const PROFILES = { 242808: HALIMSANITY };
const DEFAULT_LEAGUE_ID = '242808';

const clone = o => JSON.parse(JSON.stringify(o));

function getProfile(leagueId = DEFAULT_LEAGUE_ID) {
  const id = String(leagueId == null || leagueId === '' ? DEFAULT_LEAGUE_ID : leagueId).trim();
  const p = PROFILES[id];
  return p ? clone(p) : null;
}
// Profile settings not confirmed against Yahoo data, surfaced in API meta.
// Yahoo's league-scored fanPts (data/nba/yahoo-snapshot-242808.json) reproduce
// PTS+1.2REB+1.5AST+3STL+3BLK-TO-PF exactly; Yahoo's list shows no DD/TD/tech
// values, so whether the +5/+3 bonuses actually score is unverified.
function unverifiedFor(p) {
  if (!p || !p.scoring || !(p.scoring.dd || p.scoring.td)) return [];
  return [`DD/TD bonus unverified: Yahoo player list shows no DD/TD stats; bonuses applied per contract (tdAlsoCountsDD=${!(p.flags && p.flags.tdAlsoCountsDD === false)})`];
}
function defaultProfile() { return getProfile(DEFAULT_LEAGUE_ID); }
function highScoreDefaultProfile() { return clone(HIGH_SCORE_DEFAULT); }

module.exports = { getProfile, defaultProfile, highScoreDefaultProfile, unverifiedFor, DEFAULT_LEAGUE_ID, buildWeeks };
