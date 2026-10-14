// Yahoo player-list snapshot (data/nba/yahoo-snapshot-<leagueId>.json, written
// from Dillon's real league) → canonical identity + positions on the board.
//
// Yahoo is the source of truth for positions/eligibility: a matched player's
// yahooElig comes from the snapshot's `pos` ('PG,SG', 'PF,C', ...) via the
// contract slot table and eligConfidence = 'yahoo'. Unmatched players keep the
// Sleeper-mapped fallback. Also exposes yahooPid, yahooPreRank, yahooPctRos and
// yahooFanPts (Yahoo's league-scored 2025-26 total) for the market-blend stream.
'use strict';
const fs = require('fs');
const path = require('path');
const { matchYahooPlayer } = require('./names');
const Slots = require('./slots');

const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'nba');
const DEFAULT_LEAGUE = '242808';
const cache = new Map(); // leagueId → snapshot | null

function loadSnapshot(leagueId = DEFAULT_LEAGUE) {
  const id = String(leagueId || DEFAULT_LEAGUE);
  if (cache.has(id)) return cache.get(id);
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, `yahoo-snapshot-${id}.json`), 'utf8')); } catch { snap = null; }
  if (snap && !Array.isArray(snap.players)) snap = null;
  cache.set(id, snap);
  return snap;
}

// Snapshot row → the Yahoo player shape matchYahooPlayer expects.
const asYahooPlayer = y => ({ player_id: y.pid, name: y.name, editorial_team_abbr: y.team, display_position: y.pos });

// Match every snapshot row to a board player (name+team, names.js). When two
// Yahoo rows land on one Sleeper player the higher-confidence match wins.
// Returns { bySleeper: Map(sleeperId → { y, confidence, reason }), unmatched: [y...] }.
function matchSnapshot(snap, players) {
  const bySleeper = new Map();
  const unmatched = [];
  for (const y of snap.players) {
    const m = matchYahooPlayer(asYahooPlayer(y), players);
    if (!m) { unmatched.push(y); continue; }
    const prev = bySleeper.get(m.player.id);
    if (prev && prev.confidence >= m.confidence) { unmatched.push(y); continue; }
    if (prev) unmatched.push(prev.y);
    bySleeper.set(m.player.id, { y, confidence: m.confidence, reason: m.reason });
  }
  return { bySleeper, unmatched };
}

// Mutates players in place (must run before slot VORP). profileSlots: Set of the
// profile's slot names, or null for all slots. Returns match meta for the API.
function applyYahoo(players, { leagueId, profileSlots } = {}) {
  const snap = loadSnapshot(leagueId);
  for (const p of players) {
    p.yahooPid = null; p.yahooPreRank = null; p.yahooPctRos = null; p.yahooFanPts = null; p.yahooPos = null;
  }
  if (!snap) return { source: null, matched: 0, total: 0, matchRate: 0, unmatched: [] };
  const { bySleeper, unmatched } = matchSnapshot(snap, players);
  for (const p of players) {
    const m = bySleeper.get(p.id);
    if (!m) continue;
    const y = m.y;
    p.yahooPid = y.pid != null && y.pid !== '' ? String(y.pid) : null; // a few deep rows carry no pid
    p.yahooPos = Slots.normPositions(y.pos);
    p.yahooPreRank = Number.isFinite(y.preRank) ? y.preRank : null;
    p.yahooPctRos = Number.isFinite(y.pctRos) ? y.pctRos : null;
    p.yahooFanPts = Number.isFinite(y.fanPts) ? y.fanPts : null;
    if (p.yahooPos.length) {
      const el = Slots.slotsForPositions(p.yahooPos);
      p.yahooElig = profileSlots ? el.filter(s => profileSlots.has(s)) : el;
      p.eligConfidence = 'yahoo';
    }
  }
  const total = snap.players.length;
  return {
    source: `yahoo-snapshot-${snap.leagueId || leagueId}`,
    fetchedAt: snap.fetchedAt || null,
    matched: bySleeper.size,
    total,
    matchRate: total ? Math.round(bySleeper.size / total * 1000) / 1000 : 0,
    missingPid: snap.players.filter(y => y.pid == null || y.pid === '').length,
    unmatched: unmatched
      .sort((a, b) => (a.preRank || 1e9) - (b.preRank || 1e9))
      .map(y => ({ pid: y.pid != null ? String(y.pid) : null, name: y.name, team: y.team, preRank: y.preRank ?? null })),
  };
}

module.exports = { loadSnapshot, matchSnapshot, applyYahoo, DEFAULT_LEAGUE };
