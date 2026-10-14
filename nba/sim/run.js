// Monte-Carlo driver shared by scripts/nba-draft-sim.js and scripts/test-nba-sim.js (node).
// Common random numbers: for a given (seed, sim) the bot boards depend only on
// (seed, sim, slot) and player seasons only on (seed, sim), so policy
// comparisons are paired and their differences have tight intervals.
'use strict';
const Rng = require('./rng');
const Engine = require('./engine');
const Season = require('./season');

function runOne(pool, { seed = 1, sim = 0, mySlot = 0, policy = 'vorp', field, wHS, alpha }) {
  const draftSeed = Rng.hash(seed, 'draft', sim, mySlot);
  const d = Engine.runDraft({ players: pool.players, layout: pool.layout, teams: pool.profile.teams, rounds: pool.profile.rosterSize, mySlot, seed: draftSeed, policy, field, wHS, alpha });
  const s = Season.simulate(d.rosters, pool.players, pool.layout, {
    seed: Rng.hash(seed, 'season', sim), focus: mySlot,
    regularSeasonWeeks: pool.profile.regularSeasonWeeks || 19, playoffTeams: pool.profile.playoffTeams || 6,
  });
  const me = s.teams[mySlot];
  const mine = d.rosters[mySlot].map(i => pool.players[i]);
  return {
    sim, mySlot, policy,
    teamValue: Engine.teamValue(mine, pool.layout),
    meanWeekly: me.meanWeekly, allPlay: me.allPlay, wins: me.wins, playoff: me.playoff, champion: me.champion,
    benchStartShare: s.benchStartShare,
    firstC: (() => { const k = mine.findIndex(p => p.mask & cBit(pool.layout)); return k < 0 ? null : k + 1; })(),
    nC: mine.filter(p => p.mask & cBit(pool.layout)).length,
    picks: d.picks,
    roster: mine.map(p => p.name),
  };
}
const cBit = lay => lay.positional.reduce((m, s, i) => (s === 'C' ? m | (1 << i) : m), 0);

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const q = p => s[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  return { n, mean, sd, se: sd / Math.sqrt(n), median: q(0.5), p10: q(0.1), p90: q(0.9) };
}
// Paired difference a - b with 95% CI.
function paired(a, b) {
  const d = a.map((x, i) => x - b[i]);
  const st = stats(d);
  return { mean: st.mean, lo: st.mean - 1.96 * st.se, hi: st.mean + 1.96 * st.se, n: st.n };
}

// Run `sims` drafts for each (policy, slot). slots are 0-based.
function runGrid(pool, { policies, slots, sims, seed = 1, field, wHS, alpha, onProgress }) {
  const out = {};
  for (const pol of policies) {
    out[pol] = {};
    for (const slot of slots) {
      const rs = [];
      for (let k = 0; k < sims; k++) rs.push(runOne(pool, { seed, sim: k, mySlot: slot, policy: pol, field, wHS, alpha }));
      out[pol][slot] = rs;
      if (onProgress) onProgress(pol, slot);
    }
  }
  return out;
}

module.exports = { runOne, runGrid, stats, paired };
