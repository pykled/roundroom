#!/usr/bin/env node
/**
 * retired-players.js — shared retired-player guard for the data pipeline.
 *
 * Sleeper's legacy player records still mark some retired players status
 * "Active" (e.g. Tom Brady, player_id 167: status "Active", team "",
 * years_exp 23), and joke picks in crawled mock drafts give them enough
 * times_drafted to survive aggregation — Brady made it into adp.json /
 * composite_adp.json with a real-looking ADP of ~157. Filter them at the
 * source so no downstream dataset carries them.
 *
 * Two signals:
 *   1. Name blocklist of well-known retired players.
 *   2. Long-tenured veteran with no NFL team: skill-position pick whose
 *      metadata shows years_exp >= 15 and no team. Threshold is deliberately
 *      high — ordinary veteran free agents (e.g. Tyreek Hill / Joe Mixon at
 *      ~10 years exp, team "FA"/null) are draftable and must NOT be dropped.
 */

const RETIRED_NAMES = new Set([
  'tom brady', 'rob gronkowski', 'ben roethlisberger', 'drew brees',
  'philip rivers', 'andrew luck', 'matt ryan', 'jason kelce',
  'ryan fitzpatrick', 'cam newton', 'jimmy graham', 'adrian peterson',
  'frank gore', 'lesean mccoy', 'julian edelman',
]);

const SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

function isRetiredName(name) {
  return RETIRED_NAMES.has(normalizeName(name));
}

// For raw crawl picks (has metadata with years_exp).
function isRetiredPick(pick) {
  if (isRetiredName(pick.player_name)) return true;
  const meta = pick.metadata || {};
  const pos = (pick.position || '').trim().toUpperCase();
  const team = pick.team || meta.team || null;
  const yearsExp = parseInt(meta.years_exp, 10);
  if (!team && SKILL_POSITIONS.has(pos) && Number.isFinite(yearsExp) && yearsExp >= 15) return true;
  return false;
}

// For aggregated player records (name/position/team only). No years_exp is
// available here, so a bare "no team" is NOT enough — veteran free agents
// legitimately carry team null/"FA". Blocklist only.
function isRetiredPlayerRecord(p) {
  return isRetiredName(p.name);
}

module.exports = { RETIRED_NAMES, isRetiredName, isRetiredPick, isRetiredPlayerRecord };
