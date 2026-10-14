// Season simulator (UMD: node + browser). Given drafted rosters, plays every
// matchup week (incl. the two 14-day weeks and the 3 playoff weeks):
//  - each player follows a seeded injury-spell chain (start 3.5%/week, end
//    40%/week → ~8% of weeks out, known at week start so the manager benches him);
//  - in a healthy week each scheduled game is played with prob a_eff
//    (= model availability rescaled so overall availability matches the model);
//  - a played game's score = empirical league-scored sample + kernel jitter;
//    the player's week score = his BEST game (High Score aggregation);
//  - the manager sets the 9 starters at week start by exact slot assignment on
//    expected best game given games scheduled and health (no mid-week moves:
//    benching mid-week forfeits earlier games in High Score);
//  - team week score = sum of starters' best games.
// Player outcomes are seeded by (seed, player id), so the same player has the
// same season whichever team drafted him (common random numbers across policies).
// Schedule: 12-team circle round robin for regular weeks; playoffs top 6
// (1-2 bye; 3v6, 4v5; semis; final).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rng'), require('./lineup'));
  else root.NbaSimSeason = factory(root.NbaSimRng, root.NbaSimLineup);
})(typeof self !== 'undefined' ? self : this, function (Rng, Lineup) {
  'use strict';
  const SPELL_START = 0.035, SPELL_END = 0.4;
  const OUT_SHARE = SPELL_START / (SPELL_START + SPELL_END);

  function weekEVOf(emax, n, a) {
    if (!(n > 0) || !(a > 0)) return 0;
    let e = 0, c = 1;
    for (let k = 1; k <= n; k++) { c = c * (n - k + 1) / k; e += c * Math.pow(a, k) * Math.pow(1 - a, n - k) * emax[Math.min(k, emax.length - 1)]; }
    return e;
  }

  function trajectory(p, seed) {
    const W = p.weekEV.length;
    const r = Rng.rng(seed, 'player', p.id);
    const ev = new Float64Array(W), score = new Float64Array(W);
    let out = r() < OUT_SHARE;
    for (let w = 0; w < W; w++) {
      out = out ? r() >= SPELL_END : r() < SPELL_START;
      const n = p.games[w];
      const a = Math.min(0.99, p.avail[w] / (1 - OUT_SHARE));
      // Draw the week regardless of `out` so the stream stays aligned.
      let best = 0, played = 0;
      const m = p.samples.length;
      for (let g = 0; g < n; g++) {
        if (r() < a) {
          played++;
          const x = p.samples[Math.min(m - 1, Math.floor(r() * m))] + p.bw * Rng.gauss(r);
          if (played === 1 || x > best) best = x;
        }
      }
      if (out || !(p.avail[w] > 0) || !(p.value > 0)) { ev[w] = 0; score[w] = 0; continue; }
      ev[w] = weekEVOf(p.emax, n, a);
      score[w] = played ? best : 0;
    }
    return { ev, score };
  }

  function roundRobin(T, W) {
    const ids = Array.from({ length: T }, (_, i) => i);
    const rounds = [];
    for (let r = 0; r < T - 1; r++) {
      const pairs = [];
      for (let i = 0; i < T / 2; i++) pairs.push([ids[i], ids[T - 1 - i]]);
      rounds.push(pairs);
      ids.splice(1, 0, ids.pop()); // rotate all but the first
    }
    return Array.from({ length: W }, (_, w) => rounds[w % rounds.length]);
  }

  // rosters: array of arrays of player indexes; players: pool.players; lay: layout
  function simulate(rosters, players, lay, opts = {}) {
    const seed = opts.seed || 0;
    const W = players[0].weekEV.length;
    const regW = opts.regularSeasonWeeks || 19;
    const T = rosters.length;
    const traj = new Map();
    for (const r of rosters) for (const i of r) traj.set(i, trajectory(players[i], seed));
    const weekly = rosters.map(() => new Float64Array(W));
    let benchStarts = 0, starterSlots = 0;
    rosters.forEach((r, t) => {
      for (let w = 0; w < W; w++) {
        const vals = r.map(i => traj.get(i).ev[w]);
        const masks = r.map(i => players[i].mask);
        const res = Lineup.assign(vals, masks, lay, true);
        let s = 0;
        for (const k of res.starters) {
          s += traj.get(r[k]).score[w];
          if (t === opts.focus) { starterSlots++; if (k >= (opts.coreSize || 9)) benchStarts++; }
        }
        weekly[t][w] = s;
      }
    });
    const sched = roundRobin(T, regW);
    const wins = new Float64Array(T), pf = new Float64Array(T), allPlay = new Float64Array(T);
    for (let w = 0; w < regW; w++) {
      for (const [a, b] of sched[w]) {
        if (weekly[a][w] > weekly[b][w]) wins[a]++; else if (weekly[b][w] > weekly[a][w]) wins[b]++; else { wins[a] += 0.5; wins[b] += 0.5; }
      }
      for (let t = 0; t < T; t++) {
        pf[t] += weekly[t][w];
        let c = 0;
        for (let u = 0; u < T; u++) if (u !== t) c += weekly[t][w] > weekly[u][w] ? 1 : weekly[t][w] === weekly[u][w] ? 0.5 : 0;
        allPlay[t] += c / (T - 1);
      }
    }
    const seeds = Array.from({ length: T }, (_, i) => i).sort((a, b) => wins[b] - wins[a] || pf[b] - pf[a]);
    const nPO = Math.min(opts.playoffTeams || 6, T);
    const playoff = new Uint8Array(T), champ = new Uint8Array(T);
    seeds.slice(0, nPO).forEach(t => { playoff[t] = 1; });
    if (W >= regW + 3 && nPO === 6) {
      const s = seeds;
      const g = (a, b, w) => (weekly[a][w] >= weekly[b][w] ? a : b);
      const q1 = g(s[2], s[5], regW), q2 = g(s[3], s[4], regW);
      const low = seeds.indexOf(q1) > seeds.indexOf(q2) ? q1 : q2, high = low === q1 ? q2 : q1;
      const f1 = g(s[0], low, regW + 1), f2 = g(s[1], high, regW + 1);
      champ[g(f1, f2, regW + 2)] = 1;
    }
    return {
      teams: rosters.map((_, t) => ({
        meanWeekly: weekly[t].reduce((a, b) => a + b, 0) / W,
        allPlay: allPlay[t] / regW, wins: wins[t], playoff: playoff[t], champion: champ[t],
      })),
      benchStartShare: starterSlots ? benchStarts / starterSlots : 0,
    };
  }

  return { simulate, trajectory, roundRobin, OUT_SHARE };
});
