// Shared layer (Stream A): injury return dates from ESPN's injuries feed.
// Contract: docs/nba-trade-team-spec.md §2.3 and §3.2 / §4.3.
// Sample payload: docs/nba-spec/fixtures/espn-injuries-sample.json.
//
//   fetchInjuryEta({ fetchImpl, cacheDir, now }) → Promise<EtaDoc>   (background only)
//   loadInjuryEta() → EtaDoc | null                                   (memory → disk cache → null)
//   matchEta(etaDoc, player, { logs }) → EtaMatch | null
//   applyEtaToAvailability(a0, injury, eta, weekDef, currentWeekDef) → number
//
// EtaDoc = { source, fetchedAt, rows: [{ name, norm, team, status, fantasyStatus, returnDate, bodyPart, detail, comment, date }] }
// EtaMatch = { status: 'OUT'|'GTD'|'OFS', returnDate, returnWeek?, bodyPart, detail, comment, asOf, stale }
// Stubs until Stream A lands (every function throws NOT_IMPLEMENTED).
'use strict';

const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';
function notImplemented(name) {
  const e = new Error(`nba shared layer: ${name} not implemented yet (Stream A)`);
  e.code = NOT_IMPLEMENTED;
  throw e;
}

const URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';
const TTL_MS = 60 * 60 * 1000;      // refresh hourly, in the background
const STALE_DAYS = 14;              // ignore a row older than this when the player has played since

async function fetchInjuryEta() { notImplemented('fetchInjuryEta'); }
function loadInjuryEta() { notImplemented('loadInjuryEta'); }
function matchEta() { notImplemented('matchEta'); }
function applyEtaToAvailability() { notImplemented('applyEtaToAvailability'); }

module.exports = { fetchInjuryEta, loadInjuryEta, matchEta, applyEtaToAvailability, URL, TTL_MS, STALE_DAYS, NOT_IMPLEMENTED };
