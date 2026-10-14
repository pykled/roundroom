// My-team draft policies + the recommender (UMD: node + browser).
//
// recommend(roster, available, ctx) — "VORP-per-need" (value over next
// available, per open need):
//   gain(c)  = mean over ALL matchup weeks of [best lineup(roster + c) − best lineup(roster)]
//              (exact slot assignment on each week's E[best game], 14-day weeks
//              included; bench players count only when they would start in some
//              week, i.e. schedule/game-count depth). Screened on the season-average
//              week first, top candidates refined exactly.
//   next(c)  = best such gain among players of c's position group still likely
//              available at my next pick (pool minus the next N consensus picks,
//              N = picks until my next turn)
//   score    = gain(c) − alpha · next(c)          (alpha default 0.5)
// Groups: C = C-slot eligible; G = guard-slot eligible; F = forward-slot eligible
// (a G/F wing uses the larger of G and F).
//
// Policies: bpa (league value), hs-rank (High Score default rank = naive),
// vorp, c-round:K (take the best C-eligible at my round-K pick, no C before),
// stars / safe (VORP score ± 0.3·sd: needs-aware variance tilt), stars-raw (value + 0.6·sd, ignores needs),
// and any policy + ':waiver-bench' (last 5 picks = worst available, to price bench depth).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./lineup'));
  else root.NbaSimPolicies = factory(root.NbaSimLineup);
})(typeof self !== 'undefined' ? self : this, function (Lineup) {
  'use strict';

  function lineupValue(idxs, players, lay, w) {
    const vals = new Float64Array(idxs.length), masks = new Int32Array(idxs.length);
    for (let i = 0; i < idxs.length; i++) {
      const p = players[idxs[i]];
      vals[i] = w == null ? p.value : p.weekEV[w];
      masks[i] = p.mask;
    }
    return Lineup.assign(vals, masks, lay, false).value;
  }

  function groupsOf(p, lay) {
    const g = [];
    lay.positional.forEach((s, i) => {
      if (!(p.mask & (1 << i))) return;
      const k = s === 'C' ? 'C' : (s === 'PG' || s === 'SG' || s === 'G') ? 'G' : 'F';
      if (!g.includes(k)) g.push(k);
    });
    return g.length ? g : ['U'];
  }

  // ctx = { players, layout, picksUntilNext, consensus?: Float64Array (lower = earlier), alpha, refine }
  // Two-stage for speed: every candidate is screened on the season-average week
  // (exact for starter value), then the top `refine` (default 10) plus the 4 best
  // by value are re-scored exactly over ALL matchup weeks (adds schedule depth).
  function recommend(roster, available, ctx) {
    const players = ctx.players, lay = ctx.layout;
    const W = players[0] ? players[0].weekEV.length : 0;
    const alpha = ctx.alpha != null ? ctx.alpha : 0.5;
    const baseAvg = lineupValue(roster, players, lay, null);
    let baseWeeks = null;
    const gainAvg = i => lineupValue(roster.concat(i), players, lay, null) - baseAvg;
    const gainFull = i => {
      if (!baseWeeks) baseWeeks = Array.from({ length: W }, (_, w) => lineupValue(roster, players, lay, w));
      const r = roster.concat(i);
      let s = 0;
      for (let w = 0; w < W; w++) s += lineupValue(r, players, lay, w) - baseWeeks[w];
      return s / W;
    };
    const all = available.slice().sort((a, b) => players[b].value - players[a].value);
    const live = all.filter(i => players[i].value > 0);
    const avail = live.length ? live : all;
    const groupTop = { C: [], G: [], F: [], U: [] };
    const cands = new Set(avail.slice(0, 20));
    for (const i of avail) {
      for (const g of groupsOf(players[i], lay)) if (groupTop[g].length < 4) { groupTop[g].push(i); cands.add(i); }
    }
    // Pool expected at my next pick: drop the next N by consensus.
    const N = Math.max(0, ctx.picksUntilNext || 0);
    const cons = ctx.consensus || null;
    const byCons = avail.slice().sort((a, b) => (cons ? cons[a] - cons[b] : players[a].rank - players[b].rank));
    const gone = new Set(byCons.slice(0, N));
    const later = avail.filter(i => !gone.has(i));
    const next = {};
    for (const g of ['C', 'G', 'F', 'U']) {
      const top = later.filter(i => groupsOf(players[i], lay).includes(g)).slice(0, 2);
      next[g] = top.length ? Math.max(...top.map(gainAvg)) : 0;
    }
    const out = [];
    for (const i of cands) {
      const gain = gainAvg(i);
      const nx = Math.max(...groupsOf(players[i], lay).map(g => next[g]));
      out.push({ idx: i, player: players[i], gain, next: nx, score: gain - alpha * nx + 1e-3 * players[i].value });
    }
    out.sort((a, b) => b.score - a.score);
    const K = ctx.refine != null ? ctx.refine : 10;
    const refine = new Set(out.slice(0, K));
    out.slice().sort((a, b) => b.player.value - a.player.value).slice(0, 4).forEach(r => refine.add(r));
    for (const r of refine) { r.gain = gainFull(r.idx); r.score = r.gain - alpha * r.next + 1e-3 * r.player.value; r.refined = true; }
    // Unrefined candidates keep their screening score but rank below refined ones.
    const maxGain = out.reduce((m, r) => (r.refined ? Math.max(m, r.gain) : m), 0);
    if (maxGain < 0.05) out.sort((a, b) => (b.refined - a.refined) || b.player.value - a.player.value);
    else out.sort((a, b) => (b.refined - a.refined) || b.score - a.score);
    return out;
  }

  // Open starting slots of a roster (null when all 9 are filled).
  function openStarter(roster, players, lay) {
    const vals = roster.map(i => players[i].value), masks = roster.map(i => players[i].mask);
    const res = Lineup.assign(vals, masks, lay, true);
    let used = 0, util = 0;
    for (const k of res.starters) {
      const s = res.slotOf[k];
      if (s === 'UTIL') util++;
      else used |= 1 << lay.positional.findIndex((x, j) => x === s && !(used & (1 << j)));
    }
    const openMask = ((1 << lay.positional.length) - 1) & ~used;
    return openMask || util < lay.util ? { openMask, utilFree: lay.util - util } : null;
  }

  function bestBy(available, f) {
    let best = -1, bv = -Infinity;
    for (const i of available) { const v = f(i); if (v > bv) { bv = v; best = i; } }
    return best;
  }

  // Returns the chosen player index. st = { round, rounds, roster, available, ctx }
  function choose(policy, st) {
    const players = st.ctx.players, lay = st.ctx.layout;
    const [name, mod] = String(policy).split(':waiver-bench');
    const benchStart = st.rounds - 5;
    if (policy.includes(':waiver-bench') && st.round >= benchStart) {
      // Price of bench depth: spend the bench picks on the worst playable players.
      const playable = st.available.filter(i => players[i].value > 0);
      const pool = playable.sort((a, b) => players[a].value - players[b].value);
      return pool.length ? pool[Math.min(pool.length - 1, 40)] : st.available[0];
    }
    void mod;
    const isC = i => groupsOf(players[i], lay).includes('C');
    const healthy = i => !players[i].outForSeason || st.round >= st.rounds - 2;
    const avail = st.available.filter(healthy);
    if (name === 'bpa') return bestBy(avail, i => players[i].value);
    if (name === 'bpa-fill' || name === 'hs-fill') {
      // Best available (league value / default rank) that fills an open starting slot while any is open.
      const open = openStarter(st.roster, players, lay);
      const fills = open ? avail.filter(i => (players[i].mask & open.openMask) || open.utilFree > 0) : avail;
      const f = name === 'bpa-fill' ? (i => players[i].value) : (i => -(players[i].hsRank || 1e6));
      return bestBy(fills.length ? fills : avail, f);
    }
    if (name === 'hs-rank') return bestBy(avail, i => -(players[i].hsRank || 1e6));
    // Variance tilt on top of VORP-per-need (needs-aware, so only the risk preference differs).
    if (name === 'stars' || name === 'safe' || name === 'stars-raw') {
      if (name === 'stars-raw') return bestBy(avail, i => players[i].value + 0.6 * players[i].sd);
      const tilt = name === 'stars' ? 0.3 : -0.3;
      const rec = recommend(st.roster, avail, st.ctx);
      let best = rec[0];
      for (const r of rec) if (r.score + tilt * r.player.sd > best.score + tilt * best.player.sd) best = r;
      return best.idx;
    }
    const m = /^c-round(\d+)$/.exec(name);
    if (m) {
      const K = +m[1] - 1;
      const haveC = st.roster.some(isC);
      if (!haveC && st.round === K) return bestBy(avail.filter(isC), i => players[i].value);
      const pool = !haveC && st.round < K ? avail.filter(i => !isC(i)) : avail;
      return recommend(st.roster, pool, st.ctx)[0].idx;
    }
    if (name === 'vorp' || name.startsWith('vorp')) {
      const a = /^vorp-a([\d.]+)$/.exec(name);
      const ctx = a ? Object.assign({}, st.ctx, { alpha: +a[1] }) : st.ctx;
      return recommend(st.roster, avail, ctx)[0].idx;
    }
    throw new Error('unknown policy ' + policy);
  }

  return { recommend, choose, groupsOf, lineupValue };
});
