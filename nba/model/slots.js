// Roster-slot eligibility and value over replacement by slot.
//
// SLOT_ELIG is the Yahoo legend from docs/nba-contracts.md (Phase 3): slot ← the
// Yahoo player positions that may fill it. UTIL takes anyone. FC (the High
// Score default's forward/center slot) takes SF/PF/F/C/F/C.
//
// Player positions: Yahoo's own (display_position / eligible_positions) when
// known; before Yahoo is connected the model uses Sleeper `fantasy_positions`
// (PG/SG/SF/PF/C) token-for-token as Yahoo positions and marks the result
// eligConfidence 'sleeper-mapped'. Sleeper lists are often WIDER than Yahoo's
// (Jaylen Brown: Sleeper PF,SF,SG), so treat mapped eligibility as optimistic.
'use strict';

const SLOT_ELIG = {
  PG: ['PG'],
  SG: ['SG', 'G', 'G/F'],
  G: ['PG', 'SG', 'G', 'G/F'],
  SF: ['SF', 'F', 'G/F'],
  PF: ['PF', 'F', 'F/C'],
  F: ['SF', 'PF', 'F', 'G/F', 'F/C'],
  C: ['C', 'F/C'],
  FC: ['SF', 'PF', 'F', 'F/C', 'C'],
  UTIL: null, // anyone
};
const SLOT_ORDER = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'FC', 'UTIL'];
const NON_STARTING = new Set(['BN', 'IL', 'IR']);

// Accepts ['PG','SG'], 'PG,SG', or Yahoo eligible_positions (may already contain
// slot names like 'G' or 'UTIL'; those are positions too in Yahoo's legend).
function normPositions(pos) {
  const list = Array.isArray(pos) ? pos : String(pos || '').split(',');
  return [...new Set(list.map(s => String(s).trim().toUpperCase()).filter(Boolean))];
}

function slotsForPositions(pos) {
  const p = normPositions(pos);
  return SLOT_ORDER.filter(slot => SLOT_ELIG[slot] === null || SLOT_ELIG[slot].some(x => p.includes(x)));
}

// Starting slots (count > 0) of a profile, in SLOT_ORDER.
function startingSlots(profile) {
  const s = (profile && profile.slots) || {};
  return SLOT_ORDER.filter(k => !NON_STARTING.has(k) && (s[k] || 0) > 0);
}

// Value over replacement per starting slot.
// ASSUMPTION ("realistic draft"): the drafted pool is the top teams × (rosterSize − IL)
// players by hsValue, skipping out-for-season players (they go to IL spots, which
// don't consume active picks). Replacement level at slot S = hsValue of the best
// player OUTSIDE that pool who is eligible for S (the free-agent you could stream
// into S). vorpBySlot[S] = hsValue − replacement[S]; vorp = max over the player's
// eligible starting slots. Adds vorp/vorpBySlot/vorpRank to each player in place.
function applyVorp(players, profile) {
  const slots = startingSlots(profile);
  const il = (profile.slots && profile.slots.IL) || 0;
  const poolSize = Math.max(0, (profile.teams || 0) * ((profile.rosterSize || 0) - il));
  const candidates = players.filter(p => !p.outForSeason).sort((a, b) => b.hsValue - a.hsValue || a.rank - b.rank);
  const pool = new Set(candidates.slice(0, poolSize).map(p => p.id));
  const replacement = {};
  for (const s of slots) {
    const best = candidates.find(p => !pool.has(p.id) && p.yahooElig.includes(s));
    replacement[s] = best ? best.hsValue : 0;
  }
  const r1 = x => Math.round(x * 10) / 10;
  for (const p of players) {
    p.vorpBySlot = {};
    let v = -Infinity;
    for (const s of slots) {
      if (!p.yahooElig.includes(s)) continue;
      p.vorpBySlot[s] = r1(p.hsValue - replacement[s]);
      if (p.vorpBySlot[s] > v) v = p.vorpBySlot[s];
    }
    p.vorp = Number.isFinite(v) ? v : 0;
  }
  const order = [...players].sort((a, b) => b.vorp - a.vorp || b.hsValue - a.hsValue || a.rank - b.rank);
  order.forEach((p, i) => { p.vorpRank = i + 1; });
  return { replacement, poolSize, slots };
}

module.exports = { SLOT_ELIG, SLOT_ORDER, normPositions, slotsForPositions, startingSlots, applyVorp };
