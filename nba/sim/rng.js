// Seeded RNG helpers for the draft simulator (UMD: node + browser).
// mulberry32 (same generator as nba/model/stats.js seededRng) + string/int hashing
// so a stream can be derived from (seed, sim, player, ...) deterministically.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NbaSimRng = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // FNV-1a over the string form of every part → 32-bit seed.
  function hash(...parts) {
    let h = 0x811c9dc5;
    const s = parts.join('|');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    return h >>> 0;
  }
  function rng(...parts) { return mulberry32(hash(...parts)); }
  // Standard normal via Box-Muller (one draw per call; simple and deterministic).
  function gauss(r) {
    let u = r();
    if (u < 1e-12) u = 1e-12;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  }
  return { mulberry32, hash, rng, gauss };
});
