// Pocket NBA — Yahoo High Score value model (stream B). Contract: docs/nba-contracts.md.
//   getPlayers({ season, week, profile, eta }) → { season, week, asOf, players, profile?, injuryEta }
//     profile: a league id ('242808') or a profile object (nba/league-profile.js,
//              or nba/model/league-sync.js profileFromSleeper for Sleeper leagues).
//     Omitted → legacy High Score defaults on Sleeper weeks (pre-phase-3 behaviour).
//     eta: an injury-eta EtaDoc, or null for none; omitted → the cached ESPN
//          document (injury-eta.js loadInjuryEta; refreshed hourly in the background).
//   expectedMax(samples | { mean, sd }, n), normalizeName(s), matchYahooPlayer(yahooPlayer, players)
// Method + backtest: docs/nba-model.md. ESPN return dates: docs/nba-shared-layer.md.
'use strict';
const crypto = require('crypto');
const Data = require('./data');
const ETA = require('./injury-eta');
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
    ...(p.source ? {
      source: p.source, sleeperLeagueId: p.sleeperLeagueId || null, marketSnapshotId: p.marketSnapshotId || null, aggregation: p.aggregation || null,
      playoffStartWeek: (p.weeks.find(w => w.playoffs) || {}).week ?? null, tradeDeadlineWeek: p.tradeDeadlineWeek ?? null, tradeEnd: p.tradeEnd ?? null,
    } : {}),
    replacement: vorpMeta ? vorpMeta.replacement : null,
    draftedPool: vorpMeta ? vorpMeta.poolSize : null,
    unverified: unverifiedFor(p).concat(Array.isArray(p.unverified) ? p.unverified : []),
    positionSource: p.positionSource || 'sleeper',
    yahoo: yahooMeta ? {
      source: yahooMeta.source, positionSource: yahooMeta.positionSource, fetchedAt: yahooMeta.fetchedAt, matched: yahooMeta.matched, total: yahooMeta.total,
      matchRate: yahooMeta.matchRate, unmatchedCount: yahooMeta.unmatched.length,
      unmatchedTop: yahooMeta.unmatched.filter(u => u.preRank != null && u.preRank <= 300),
    } : null,
  };
}

// Memo key part for a profile: every field can change the board (slots, weeks,
// scoring, the market snapshot it joins), so the whole object is hashed.
const profileKey = prof => (prof ? crypto.createHash('sha1').update(JSON.stringify(prof)).digest('base64url') : '-');

async function getPlayers({ season, week, profile, eta } = {}) {
  const prof = resolveProfile(profile);
  const data = Data.load();
  Data.maybeRefresh(); // background; never awaited on the request path
  ETA.maybeRefresh();  // ESPN return dates, hourly, background
  if (season != null && String(season) !== data.proj.season) {
    throw new Error(`nba model: season ${season} not available (have ${data.proj.season})`);
  }
  const wk = week == null || week === '' || Number(week) === 0 ? null : Number(week);
  if (wk != null && !(Number.isInteger(wk) && wk > 0)) throw new Error(`nba model: bad week ${week}`);
  const etaDoc = eta === undefined ? ETA.loadInjuryEta() : (eta && Array.isArray(eta.rows) ? eta : null);
  const ekey = etaDoc ? `${etaDoc.fetchedAt}:${etaDoc.rows.length}` : '-';
  const key = `${wk}|${profileKey(prof)}|${ekey}|${Data.version()}`;
  const hit = boards.get(key);
  if (hit && Date.now() - hit.time < BOARD_TTL_MS) return hit.value;
  const board = buildBoard(data, { week: wk, profile: prof, eta: etaDoc });
  const value = { season: board.season, week: board.week, currentWeek: board.currentWeek, asOf: data.asOf, players: board.players, injuryEta: board.etaMeta };
  if (prof) value.profile = profileMeta(prof, board.vorpMeta, board.yahooMeta);
  for (const k of boards.keys()) if (!k.endsWith(`|${Data.version()}`)) boards.delete(k);
  boards.set(key, { value, time: Date.now() });
  return value;
}

module.exports = {
  getPlayers, expectedMax, normalizeName, matchYahooPlayer, status: Data.status, profileKey,
  gameScore: Score.gameScore, slotsForPositions: Slots.slotsForPositions,
};
