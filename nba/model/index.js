// Pocket NBA — Yahoo High Score value model (stream B). Contract: docs/nba-contracts.md.
//   getPlayers({ season, week }) → { season, week, asOf, players }
//   expectedMax(samples | { mean, sd }, n), normalizeName(s), matchYahooPlayer(yahooPlayer, players)
// Method + backtest: docs/nba-model.md.
'use strict';
const Data = require('./data');
const { buildBoard } = require('./board');
const { expectedMax } = require('./stats');
const { normalizeName, matchYahooPlayer } = require('./names');

const BOARD_TTL_MS = 10 * 60 * 1000; // availability/recency depend on "today"
const boards = new Map();             // `${week}|${dataVersion}` → { value, time }

async function getPlayers({ season, week } = {}) {
  const data = Data.load();
  Data.maybeRefresh(); // background; never awaited on the request path
  if (season != null && String(season) !== data.proj.season) {
    throw new Error(`nba model: season ${season} not available (have ${data.proj.season})`);
  }
  const wk = week == null || week === '' || Number(week) === 0 ? null : Number(week);
  if (wk != null && !(Number.isInteger(wk) && wk > 0)) throw new Error(`nba model: bad week ${week}`);
  const key = `${wk}|${Data.version()}`;
  const hit = boards.get(key);
  if (hit && Date.now() - hit.time < BOARD_TTL_MS) return hit.value;
  const board = buildBoard(data, { week: wk });
  const value = { season: board.season, week: board.week, currentWeek: board.currentWeek, asOf: data.asOf, players: board.players };
  for (const k of boards.keys()) if (!k.endsWith(`|${Data.version()}`)) boards.delete(k);
  boards.set(key, { value, time: Date.now() });
  return value;
}

module.exports = { getPlayers, expectedMax, normalizeName, matchYahooPlayer, status: Data.status };
