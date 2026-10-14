// Pocket NBA — Yahoo High Score value model (stream B). Contract: docs/nba-contracts.md.
//   getPlayers({ season, week, profile }) → { season, week, asOf, players, profile? }
//     profile: a league id ('242808') or a profile object (nba/league-profile.js).
//     Omitted → legacy High Score defaults on Sleeper weeks (pre-phase-3 behaviour).
//   expectedMax(samples | { mean, sd }, n), normalizeName(s), matchYahooPlayer(yahooPlayer, players)
// Method + backtest: docs/nba-model.md.
'use strict';
const Data = require('./data');
const { buildBoard } = require('./board');
const { expectedMax } = require('./stats');
const { normalizeName, matchYahooPlayer } = require('./names');
const { getProfile, unverifiedFor } = require('../league-profile');
const Score = require('./score');
const Slots = require('./slots');

const BOARD_TTL_MS = 10 * 60 * 1000; // availability/recency depend on "today"
const boards = new Map();             // `${week}|${dataVersion}` → { value, time }

function resolveProfile(profile) {
  if (profile == null || profile === '') return null;
  if (typeof profile === 'object') return profile;
  const p = getProfile(profile);
  if (!p) { const e = new Error(`nba model: unknown league profile ${profile}`); e.status = 404; throw e; }
  return p;
}
// Compact profile summary echoed in the getPlayers response.
function profileMeta(p, vorpMeta, yahooMeta) {
  return {
    leagueId: p.leagueId, name: p.name, teams: p.teams, scoring: p.scoring, flags: p.flags,
    slots: p.slots, starters: p.starters, rosterSize: p.rosterSize,
    weeks: p.weeks.length, longWeeks: p.weeks.filter(w => w.days > 7).map(w => w.week),
    replacement: vorpMeta ? vorpMeta.replacement : null,
    draftedPool: vorpMeta ? vorpMeta.poolSize : null,
    unverified: unverifiedFor(p),
    yahoo: yahooMeta ? {
      source: yahooMeta.source, fetchedAt: yahooMeta.fetchedAt, matched: yahooMeta.matched, total: yahooMeta.total,
      matchRate: yahooMeta.matchRate, unmatchedCount: yahooMeta.unmatched.length,
      unmatchedTop: yahooMeta.unmatched.filter(u => u.preRank != null && u.preRank <= 300),
    } : null,
  };
}

async function getPlayers({ season, week, profile } = {}) {
  const prof = resolveProfile(profile);
  const data = Data.load();
  Data.maybeRefresh(); // background; never awaited on the request path
  if (season != null && String(season) !== data.proj.season) {
    throw new Error(`nba model: season ${season} not available (have ${data.proj.season})`);
  }
  const wk = week == null || week === '' || Number(week) === 0 ? null : Number(week);
  if (wk != null && !(Number.isInteger(wk) && wk > 0)) throw new Error(`nba model: bad week ${week}`);
  const pkey = prof ? JSON.stringify([prof.leagueId, prof.scoring, prof.flags, prof.slots, prof.teams, prof.rosterSize, prof.weeks]) : '-';
  const key = `${wk}|${pkey}|${Data.version()}`;
  const hit = boards.get(key);
  if (hit && Date.now() - hit.time < BOARD_TTL_MS) return hit.value;
  const board = buildBoard(data, { week: wk, profile: prof });
  const value = { season: board.season, week: board.week, currentWeek: board.currentWeek, asOf: data.asOf, players: board.players };
  if (prof) value.profile = profileMeta(prof, board.vorpMeta, board.yahooMeta);
  for (const k of boards.keys()) if (!k.endsWith(`|${Data.version()}`)) boards.delete(k);
  boards.set(key, { value, time: Date.now() });
  return value;
}

module.exports = {
  getPlayers, expectedMax, normalizeName, matchYahooPlayer, status: Data.status,
  gameScore: Score.gameScore, slotsForPositions: Slots.slotsForPositions,
};
