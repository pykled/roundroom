// Roster slots, Yahoo slot eligibility and exact optimal lineup assignment
// (UMD: node + browser). Spec: docs/nba-contracts.md "Phase 3 addendum".
//
// Eligibility (Yahoo legend, league 242808):
//   PG<-PG; SG<-SG,G,G/F; G<-PG,SG,G,G/F; SF<-SF,F,G/F; PF<-PF,F,F/C;
//   F<-SF,PF,F,G/F,F/C; C<-C,F/C; UTIL<-anyone.
// A player's tokens are his positions (Sleeper PG/SG/SF/PF/C, or Yahoo display
// tokens G, F, G/F, F/C); multi-position players get the union. If a player has
// `yahooElig` (Yahoo eligible_positions), that list is taken literally as slots.
// So C-only players fill C and UTIL only (never F).
//
// Assignment: exact DP over (filled positional-slot mask, UTIL used) per player.
// 7 positional slots x 3 UTIL states = 384 states, ~25k ops for a 16-man roster.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NbaSimLineup = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TABLE = {
    PG: ['PG'],
    SG: ['SG', 'G', 'G/F'],
    G: ['PG', 'SG', 'G', 'G/F'],
    SF: ['SF', 'F', 'G/F'],
    PF: ['PF', 'F', 'F/C'],
    F: ['SF', 'PF', 'F', 'G/F', 'F/C'],
    C: ['C', 'F/C'],
  };
  const ANY = new Set(['UTIL', 'U', 'Util']);
  const NON_STARTING = new Set(['BN', 'IL', 'IL+', 'NA']);
  const DEFAULT_SLOTS = { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2, BN: 5, IL: 2 };

  // slots = profile.slots → { positional: ['PG',...] (expanded by count), util: n, bench, il }
  function layout(slots = DEFAULT_SLOTS) {
    const positional = [];
    let util = 0;
    for (const [k, n] of Object.entries(slots)) {
      if (!n || NON_STARTING.has(k)) continue;
      if (ANY.has(k)) util += n;
      else for (let i = 0; i < n; i++) positional.push(k);
    }
    if (positional.length > 12) throw new Error('lineup: too many positional slots for the DP');
    return { positional, util, starters: positional.length + util, bench: slots.BN || 0, il: slots.IL || 0 };
  }

  function canFill(slot, tokens) {
    const ok = TABLE[slot];
    if (!ok) return false;
    return tokens.some(t => ok.includes(t));
  }

  // Positional-slot bitmask for a player under a layout.
  function slotMask(player, lay) {
    let m = 0;
    if (Array.isArray(player.yahooElig) && player.yahooElig.length) {
      lay.positional.forEach((s, i) => { if (player.yahooElig.includes(s)) m |= 1 << i; });
      return m;
    }
    const tokens = (player.pos || []).flatMap(t => String(t).toUpperCase() === 'G/F' || String(t).toUpperCase() === 'F/C' ? [String(t).toUpperCase()] : String(t).toUpperCase().split(/[,/]/));
    lay.positional.forEach((s, i) => { if (canFill(s, tokens)) m |= 1 << i; });
    return m;
  }
  function eligibleSlots(player, lay) {
    const m = slotMask(player, lay);
    const out = lay.positional.filter((_, i) => m & (1 << i));
    if (lay.util) out.push('UTIL');
    return [...new Set(out)];
  }

  // Reusable buffers (grow-only) to keep the hot path allocation-free.
  let buf = new Float64Array(0);
  function ensure(n) { if (buf.length < n) buf = new Float64Array(n * 2); }

  // values[i] = value of roster[i] this week (<=0 → never starts),
  // masks[i]  = positional-slot mask. Returns { value, starters?: idx[] , slotOf?: [] }.
  function assign(values, masks, lay, wantLineup) {
    const P = lay.positional.length, U = lay.util;
    const S = (1 << P) * (U + 1);
    const n = values.length;
    const layers = wantLineup ? n + 1 : 2;
    ensure(layers * S);
    const NEG = -1e18;
    for (let s = 0; s < S; s++) buf[s] = NEG;
    buf[0] = 0;
    for (let i = 0; i < n; i++) {
      const src = wantLineup ? i * S : (i & 1) * S;
      const dst = wantLineup ? (i + 1) * S : ((i + 1) & 1) * S;
      for (let s = 0; s < S; s++) buf[dst + s] = buf[src + s];
      const v = values[i];
      if (!(v > 0)) continue;
      const m = masks[i];
      for (let s = 0; s < S; s++) {
        const cur = buf[src + s];
        if (cur === NEG) continue;
        const mask = s % (1 << P), u = (s / (1 << P)) | 0;
        let free = m & ~mask;
        while (free) {
          const bit = free & -free;
          free ^= bit;
          const t = s + bit;
          if (cur + v > buf[dst + t]) buf[dst + t] = cur + v;
        }
        if (u < U) {
          const t = s + (1 << P);
          if (cur + v > buf[dst + t]) buf[dst + t] = cur + v;
        }
      }
    }
    const last = wantLineup ? n * S : (n & 1) * S;
    let best = 0, bs = 0;
    for (let s = 0; s < S; s++) if (buf[last + s] > best) { best = buf[last + s]; bs = s; }
    if (!wantLineup) return { value: best };
    // Backtrack.
    const starters = [], slotOf = new Array(n).fill(null);
    let s = bs;
    for (let i = n - 1; i >= 0; i--) {
      const here = buf[(i + 1) * S + s];
      if (buf[i * S + s] === here) continue; // player i not used
      const v = values[i];
      const mask = s % (1 << P), u = (s / (1 << P)) | 0;
      let found = false;
      let bits = masks[i] & mask;
      while (bits) {
        const bit = bits & -bits; bits ^= bit;
        const prev = s - bit;
        if (buf[i * S + prev] !== NEG && Math.abs(buf[i * S + prev] + v - here) < 1e-9) {
          starters.push(i); slotOf[i] = lay.positional[31 - Math.clz32(bit)]; s = prev; found = true; break;
        }
      }
      if (!found && u > 0) {
        const prev = s - (1 << P);
        if (buf[i * S + prev] !== NEG && Math.abs(buf[i * S + prev] + v - here) < 1e-9) {
          starters.push(i); slotOf[i] = 'UTIL'; s = prev; found = true;
        }
      }
    }
    return { value: best, starters: starters.reverse(), slotOf };
  }

  return { TABLE, DEFAULT_SLOTS, layout, slotMask, eligibleSlots, canFill, assign };
});
