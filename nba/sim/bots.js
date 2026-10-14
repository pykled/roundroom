// Opponent drafter models (UMD: node + browser). Deterministic given the rng.
//
// Every bot ranks the available pool by a private key = consensus rank + noise,
// drawn ONCE per draft (so a bot's board doesn't jitter pick to pick, and the
// same sim seed gives the same bot boards whatever "my" policy does).
//   adp    — consensus + N(0, sigma), sigma 6-12 picks. No position logic
//            beyond a soft cap on bigs.
//   needs  — like adp (sigma 8) but penalises players who don't fill an open
//            starting slot (stronger late), mimicking a manager filling PG..C.
//   reach  — sigma 16 and a board weighted toward default (High Score) ranks:
//            name-value drafter who reaches.
//   auto   — Yahoo-style autopick: strict consensus queue (no noise) but fills
//            open starting slots first.
// Consensus rank = wHS * (High Score default rank) + (1 - wHS) * (league rank);
// default wHS 0.5 (other managers see Yahoo's default-ish ranks, partly adjust).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rng'), require('./lineup'));
  else root.NbaSimBots = factory(root.NbaSimRng, root.NbaSimLineup);
})(typeof self !== 'undefined' ? self : this, function (Rng, Lineup) {
  'use strict';
  const MODELS = {
    adp: { sigma: 9, needPenEarly: 0, needPenLate: 6, wHS: null },
    needs: { sigma: 8, needPenEarly: 5, needPenLate: 25, wHS: null },
    reach: { sigma: 16, needPenEarly: 0, needPenLate: 6, wHS: 0.8 },
    auto: { sigma: 0, needPenEarly: 12, needPenLate: 40, wHS: null },
  };
  // Default 11-bot field (my team is the 12th).
  const DEFAULT_FIELD = ['adp', 'adp', 'adp', 'adp', 'adp', 'needs', 'needs', 'needs', 'reach', 'reach', 'auto'];

  function consensusRank(p, wHS) { return wHS * (p.hsRank || p.rank) + (1 - wHS) * p.rank; }

  // Build per-bot keys. field[i] = model name for bot i; returns [{model, keys:Float64Array}]
  function makeBots(players, field, rng, opts = {}) {
    const wDefault = opts.wHS != null ? opts.wHS : 0.5;
    return field.map(name => {
      const m = MODELS[name] || MODELS.adp;
      const sigma = name === 'adp' ? 6 + 6 * rng() : m.sigma;
      const wHS = m.wHS != null ? m.wHS : wDefault;
      const keys = new Float64Array(players.length);
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        keys[i] = p.value > 0 ? consensusRank(p, wHS) + sigma * Rng.gauss(rng) : 1e9 + i;
      }
      return { model: name, sigma, wHS, keys, params: m };
    });
  }

  // Open starting slots of a roster: { openMask, utilFree }.
  function openSlots(roster, players, lay) {
    const vals = roster.map(i => players[i].value), masks = roster.map(i => players[i].mask);
    const res = Lineup.assign(vals, masks, lay, true);
    let used = 0, util = 0;
    res.starters.forEach(k => {
      const s = res.slotOf[k];
      if (s === 'UTIL') util++;
      else { const idx = lay.positional.findIndex((x, j) => x === s && !(used & (1 << j))); used |= 1 << idx; }
    });
    const all = (1 << lay.positional.length) - 1;
    return { openMask: all & ~used, utilFree: lay.util - util };
  }

  // Choose a player index for bot b on roster `roster` at round r (0-based).
  function choose(bot, roster, taken, players, lay, round, rounds) {
    const late = round >= Math.floor(rounds * 0.6);
    const open = bot.params.needPenEarly || bot.params.needPenLate ? openSlots(roster, players, lay) : null;
    const nBigs = roster.filter(i => players[i].mask === (players[i].mask & cMask(lay)) && players[i].mask).length;
    let best = -1, bestKey = Infinity;
    // Scan candidates in key order cheaply: keys are fixed, so a linear scan is fine (650 players).
    for (let i = 0; i < players.length; i++) {
      if (taken[i]) continue;
      const p = players[i];
      let k = bot.keys[i];
      if (p.outForSeason && round < rounds - 2) k += 300;
      if (open) {
        const fills = (p.mask & open.openMask) || open.utilFree > 0;
        if (!fills) k += late ? bot.params.needPenLate : bot.params.needPenEarly;
      }
      // Humans rarely roster 3+ C-only bigs (one C slot).
      if (p.mask && p.mask === (p.mask & cMask(lay)) && nBigs >= 2) k += 25;
      if (k < bestKey) { bestKey = k; best = i; }
    }
    return best;
  }
  function cMask(lay) {
    let m = 0;
    lay.positional.forEach((s, i) => { if (s === 'C') m |= 1 << i; });
    return m;
  }

  return { MODELS, DEFAULT_FIELD, makeBots, choose, openSlots, consensusRank };
});
