// Pocket NBA draft simulator engine (UMD: node + browser; pure, no I/O).
// Snake draft for T teams x R rounds (default 12 x 16 = 192 picks, IL spots
// drafted like bench), Yahoo slot eligibility, exact optimal lineup assignment.
//
// Small API for the board/mock UI:
//   createDraft({ players, layout, teams=12, rounds=16, mySlot=0, seed=1, field?, wHS? })
//   pickPlayer(draft, playerIdx[, teamIdx])   → pick record (throws on illegal pick)
//   botPick(draft, teamIdx, rng?)             → player index the bot would take (not applied)
//   teamValue(roster, layout?)                → mean over matchup weeks of the best 9-slot
//                                              lineup's expected best-game total (each week
//                                              counts equally, 14-day weeks included)
//   recommend(roster, available, ctx)         → [{ idx, player, gain, next, score }]
//   teamOnClock(draft), pickTeam(T, pickNo), availableIdx(draft)
// `players` are valuation.js pool entries (need: value, weekEV[], mask, rank, hsRank).
// In the browser, load rng.js, lineup.js, bots.js, policies.js, then engine.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rng'), require('./lineup'), require('./bots'), require('./policies'));
  } else root.NbaSimEngine = factory(root.NbaSimRng, root.NbaSimLineup, root.NbaSimBots, root.NbaSimPolicies);
})(typeof self !== 'undefined' ? self : this, function (Rng, Lineup, Bots, Policies) {
  'use strict';

  // Snake: round r (0-based) goes 0..T-1 when r is even, T-1..0 when odd.
  function pickTeam(T, pickNo) {
    const r = Math.floor(pickNo / T), i = pickNo % T;
    return r % 2 === 0 ? i : T - 1 - i;
  }

  function createDraft(opts) {
    const players = opts.players;
    if (!players || !players.length) throw new Error('createDraft: players required');
    const layout = opts.layout || Lineup.layout();
    const teams = opts.teams || 12, rounds = opts.rounds || 16;
    const mySlot = opts.mySlot || 0;
    const rng = Rng.rng(opts.seed == null ? 1 : opts.seed, 'bots');
    // Bot field: assign models to the non-me teams in a seeded random order.
    const base = (opts.field || Bots.DEFAULT_FIELD).slice();
    for (let i = base.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [base[i], base[j]] = [base[j], base[i]]; }
    const field = [];
    let k = 0;
    for (let t = 0; t < teams; t++) field.push(t === mySlot ? null : base[k++ % base.length]);
    const botList = Bots.makeBots(players, field.map(f => f || 'adp'), rng, { wHS: opts.wHS });
    // Public consensus (no noise) for "who goes before my next pick".
    const wHS = opts.wHS != null ? opts.wHS : 0.5;
    const consensus = new Float64Array(players.length);
    players.forEach((p, i) => { consensus[i] = p.value > 0 ? Bots.consensusRank(p, wHS) : 1e9 + i; });
    return {
      players, layout, teams, rounds, mySlot, totalPicks: teams * rounds,
      pickNo: 0, picks: [], rosters: Array.from({ length: teams }, () => []),
      taken: new Uint8Array(players.length), bots: botList.map((b, t) => (t === mySlot ? null : b)),
      consensus,
    };
  }

  const teamOnClock = d => (d.pickNo < d.totalPicks ? pickTeam(d.teams, d.pickNo) : -1);
  const availableIdx = d => { const out = []; for (let i = 0; i < d.players.length; i++) if (!d.taken[i]) out.push(i); return out; };

  function pickPlayer(d, idx, teamIdx) {
    if (d.pickNo >= d.totalPicks) throw new Error('draft complete');
    const team = teamOnClock(d);
    if (teamIdx != null && teamIdx !== team) throw new Error(`team ${teamIdx} is not on the clock (team ${team} is)`);
    if (!(idx >= 0 && idx < d.players.length)) throw new Error('bad player index ' + idx);
    if (d.taken[idx]) throw new Error(`${d.players[idx].name} already drafted`);
    if (d.rosters[team].length >= d.rounds) throw new Error('roster full');
    d.taken[idx] = 1;
    d.rosters[team].push(idx);
    const rec = { pick: d.pickNo + 1, round: Math.floor(d.pickNo / d.teams) + 1, team, idx, id: d.players[idx].id, name: d.players[idx].name };
    d.picks.push(rec);
    d.pickNo++;
    return rec;
  }

  function botPick(d, teamIdx, rng) {
    void rng; // bot boards are drawn at createDraft; rng kept for API symmetry
    const bot = d.bots[teamIdx] || Bots.makeBots(d.players, ['adp'], rng || Rng.rng(teamIdx, d.pickNo), {})[0];
    return Bots.choose(bot, d.rosters[teamIdx], d.taken, d.players, d.layout, Math.floor(d.pickNo / d.teams), d.rounds);
  }

  // Picks until team's next turn after the current pick (for VONA).
  function picksUntilNext(d, team) {
    for (let p = d.pickNo + 1; p < d.totalPicks; p++) if (pickTeam(d.teams, p) === team) return p - d.pickNo - 1;
    return d.totalPicks;
  }

  function teamValue(roster, layout) {
    const lay = layout || Lineup.layout();
    if (!roster.length) return 0;
    const W = roster[0].weekEV.length;
    const masks = roster.map(p => p.mask != null ? p.mask : Lineup.slotMask(p, lay));
    let s = 0;
    for (let w = 0; w < W; w++) s += Lineup.assign(roster.map(p => p.weekEV[w]), masks, lay, false).value;
    return s / W;
  }

  function recommend(roster, available, ctx) {
    // roster/available may be indexes (ctx.players) or player objects with .idx
    const toIdx = a => a.map(x => (typeof x === 'number' ? x : x.idx));
    return Policies.recommend(toIdx(roster), toIdx(available), ctx);
  }

  // Run a whole draft: myPolicy for mySlot, bots elsewhere. Returns the draft.
  function runDraft(opts) {
    const d = createDraft(opts);
    const ctxBase = { players: d.players, layout: d.layout, consensus: d.consensus, alpha: opts.alpha };
    while (d.pickNo < d.totalPicks) {
      const team = teamOnClock(d);
      let idx;
      if (team === d.mySlot && opts.policy) {
        idx = Policies.choose(opts.policy, {
          round: Math.floor(d.pickNo / d.teams), rounds: d.rounds, roster: d.rosters[team],
          available: availableIdx(d), ctx: Object.assign({ picksUntilNext: picksUntilNext(d, team) }, ctxBase),
        });
      } else idx = botPick(d, team);
      pickPlayer(d, idx);
    }
    return d;
  }

  return { createDraft, pickPlayer, botPick, teamValue, recommend, runDraft, pickTeam, teamOnClock, availableIdx, picksUntilNext };
});
