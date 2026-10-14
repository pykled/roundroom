// Pocket NBA — High Score trade evaluator (stream E). Method: docs/nba-trade.md.
//
//   evaluateTrade({ players, currentWeek, myRoster, partnerRoster?, give, get, settings?, leagueRostered? })
//     players        board Player[] from getPlayers() (needs hsByWeek / gamesByWeek)
//     myRoster       my player ids (sleeper) before the trade; give ⊆ myRoster
//     partnerRoster  partner ids before the trade (get ⊆ it); omitted → a mid-draft roster is estimated
//     leagueRostered every rostered id in the league (waiver replacement level); omitted → percentile
//     settings       { teams, rosterSize, slots:{G,F,UTIL}, endWeek, playoffStartWeek, playoffWeight }
//   → { verdict, you, them, weeks, lineup, players, roster, why, replacement, meta }
//
// A player's worth is never his raw hsValue: it is the change in the team's
// best G,G,F,F,F,UTIL lineup (plus a discounted bench share) summed over the
// remaining weeks, with open roster spots filled at waiver replacement level.
'use strict';

const DEFAULT_SLOTS = { G: 2, F: 3, UTIL: 1 };
const BENCH_SHARE = [0.12, 0.07, 0.04, 0.02]; // 7th..10th man: share of value above replacement
const REPL_RANK = 3;          // replacement = Nth best player outside rosters that week
const REPL_DISCOUNT = 0.9;    // waiver adds aren't free: one claim, uncertain role
const PLAYOFF_WEIGHT = 1.5;   // only when the league gives a playoff start week
const FAIR_BAND = 0.0075;     // |Δ| under this share of the weekly lineup = a wash
const MAX_DROP_CANDIDATES = 20;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const r1 = x => Math.round(num(x) * 10) / 10;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// NOTE (merge): stream D's nba/model/lineup.js wasn't in this tree; this is a
// tiny exact optimiser for the same slot shape. Dedupe at merge if D exports one.
// items: [{ id, G:bool, F:bool, v }] → { total, slotOf: Map(id → 'G'|'F'|'UTIL') }
// Exact DP over (G used, F used, UTIL used); every player is benched or takes one slot.
function bestLineup(items, slots = DEFAULT_SLOTS) {
  const NG = slots.G, NF = slots.F, NU = slots.UTIL;
  const idx = (g, f, u) => (g * (NF + 1) + f) * (NU + 1) + u;
  const S = (NG + 1) * (NF + 1) * (NU + 1);
  let best = new Array(S).fill(-Infinity);
  best[0] = 0;
  const back = []; // back[i][state] = [prevState, slot|null]
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const v = num(it.v);
    const next = best.slice();
    const bk = new Array(S).fill(null);
    for (let s = 0; s < S; s++) bk[s] = [s, null];
    for (let g = 0; g <= NG; g++) for (let f = 0; f <= NF; f++) for (let u = 0; u <= NU; u++) {
      const s = idx(g, f, u);
      if (best[s] === -Infinity) continue;
      const tryMove = (t, slot) => {
        const val = best[s] + v;
        if (val > next[t] + 1e-9) { next[t] = val; bk[t] = [s, slot]; }
      };
      if (it.G && g < NG) tryMove(idx(g + 1, f, u), 'G');
      if (it.F && f < NF) tryMove(idx(g, f + 1, u), 'F');
      if (u < NU) tryMove(idx(g, f, u + 1), 'UTIL');
    }
    best = next;
    back.push(bk);
  }
  let end = 0;
  for (let s = 1; s < S; s++) if (best[s] > best[end] + 1e-9) end = s;
  const slotOf = new Map();
  for (let i = items.length - 1, s = end; i >= 0; i--) {
    const [prev, slot] = back[i][s];
    if (slot) slotOf.set(items[i].id, slot);
    s = prev;
  }
  return { total: best[end], slotOf };
}

function eligOf(p) {
  const e = (p && p.elig) || [];
  return { G: e.includes('G'), F: e.includes('F') };
}

function normSettings(s = {}) {
  const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const slots = s.slots || {};
  return {
    teams: int(s.teams, 2, 20, 10),
    rosterSize: int(s.rosterSize, 6, 20, 10),
    slots: { G: int(slots.G, 0, 6, DEFAULT_SLOTS.G), F: int(slots.F, 0, 6, DEFAULT_SLOTS.F), UTIL: int(slots.UTIL, 0, 6, DEFAULT_SLOTS.UTIL) },
    endWeek: s.endWeek == null ? null : int(s.endWeek, 1, 30, null),
    playoffStartWeek: s.playoffStartWeek == null ? null : int(s.playoffStartWeek, 1, 30, null),
    playoffWeight: s.playoffWeight == null ? PLAYOFF_WEIGHT : Math.max(1, Math.min(3, num(Number(s.playoffWeight)) || 1)),
  };
}

// Remaining weeks with their weights. Default weight 1.0; playoff weeks get
// playoffWeight only when the league told us where the playoffs start.
function scheduleWeeks(players, currentWeek, st) {
  const all = new Set();
  for (const p of players.slice(0, 50)) for (const w of Object.keys(p.hsByWeek || {})) all.add(Number(w));
  let weeks = [...all].filter(Number.isFinite).sort((a, b) => a - b);
  const cw = Number(currentWeek) || weeks[0] || 1;
  const rest = weeks.filter(w => w >= cw && (st.endWeek == null || w <= st.endWeek));
  weeks = rest.length ? rest : weeks.slice(-1);
  return weeks.map(w => {
    const playoff = st.playoffStartWeek != null && w >= st.playoffStartWeek;
    return { week: w, weight: playoff ? st.playoffWeight : 1, playoff };
  });
}

// Waiver replacement level per week: Nth best outside league rosters when they
// are known, else the Nth player past the teams × rosterSize line (percentile).
function replacementLevel(players, weeks, st, rostered) {
  const known = rostered && rostered.size >= st.teams * 3;
  const pool = players.filter(p => !p.outForSeason && (!known || !rostered.has(String(p.id))));
  const k = known ? REPL_RANK - 1 : st.teams * st.rosterSize + REPL_RANK - 1;
  const perWeek = {};
  for (const { week } of weeks) {
    const vals = pool.map(p => num((p.hsByWeek || {})[week])).sort((a, b) => b - a);
    perWeek[week] = r1(REPL_DISCOUNT * (vals[Math.min(k, vals.length - 1)] || 0));
  }
  return { perWeek, source: known ? 'league' : 'percentile' };
}

// Per-player uncertainty of the rest-of-season value (drives the ranges).
function uncertainty(p) {
  let u = 0.1;
  if (p.source && p.source !== 'logs') u += 0.1;
  if (p.injury) u += 0.08;
  if (num(p.sampleGames) < 20) u += 0.05;
  return Math.min(0.35, u);
}

function createEvaluator({ players, currentWeek, settings, leagueRostered }) {
  const st = normSettings(settings);
  const index = new Map(players.map(p => [String(p.id), p]));
  const weeks = scheduleWeeks(players, currentWeek, st);
  const rostered = leagueRostered ? new Set(leagueRostered.map(String)) : null;
  const repl = replacementLevel(players, weeks, st, rostered);
  const wSum = weeks.reduce((s, w) => s + w.weight, 0) || 1;
  const val = (p, w, scale) => num((p.hsByWeek || {})[w]) * (scale && scale.has(p.id) ? scale.get(p.id) : 1);
  const rosAvg = (p, scale) => weeks.reduce((s, w) => s + w.weight * val(p, w.week, scale), 0) / wSum;

  // One week's team value: best lineup (open spots filled at replacement) plus
  // a discounted share of bench depth above replacement.
  function weekValue(roster, cap, week, scale, keepSlots) {
    const rv = repl.perWeek[week] || 0;
    const items = roster.map(p => ({ id: p.id, ...eligOf(p), v: val(p, week, scale) }));
    const open = Math.max(0, cap - roster.length);
    for (let i = 0; i < Math.min(open, 6); i++) items.push({ id: `~repl${i}`, G: true, F: true, v: rv });
    items.sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
    const lu = bestLineup(items, st.slots);
    const bench = items.filter(it => !lu.slotOf.has(it.id) && !it.id.startsWith('~'));
    let benchVal = 0;
    bench.forEach((it, i) => { if (i < BENCH_SHARE.length) benchVal += BENCH_SHARE[i] * Math.max(0, it.v - rv); });
    const out = { total: lu.total + benchVal, starters: lu.total };
    if (keepSlots) out.slotOf = lu.slotOf;
    return out;
  }

  function teamValue(roster, cap, scale) {
    let total = 0;
    const byWeek = {};
    for (const w of weeks) {
      const v = weekValue(roster, cap, w.week, scale).total;
      byWeek[w.week] = v;
      total += w.weight * v;
    }
    return { total, byWeek };
  }

  // After a trade a roster over its cap drops whoever costs the least.
  function settle(roster, cap, scale, protect) {
    let cur = roster.slice();
    const dropped = [];
    while (cur.length > cap) {
      let best = null;
      const cands = cur.filter(p => !protect.has(p.id)).sort((a, b) => rosAvg(a) - rosAvg(b) || byId(a, b)).slice(0, MAX_DROP_CANDIDATES);
      for (const p of cands.length ? cands : cur) {
        const rest = cur.filter(x => x !== p);
        const v = teamValue(rest, cap, scale).total;
        if (!best || v > best.v + 1e-9) best = { p, v, rest };
      }
      dropped.push(best.p);
      cur = best.rest;
    }
    return { roster: cur, dropped };
  }

  // Δ for one side: (roster − out + in), settled to its cap, minus before.
  function side(before, outIds, inIds, scale) {
    const cap = Math.max(st.rosterSize, before.length);
    const outSet = new Set(outIds);
    const incoming = inIds.map(id => index.get(id)).filter(Boolean);
    const after0 = before.filter(p => !outSet.has(p.id)).concat(incoming);
    // Protect nothing: if dropping an incoming player is cheapest, that is the truth.
    const s = settle(after0, cap, scale, new Set());
    const b = teamValue(before, cap, scale);
    const a = teamValue(s.roster, cap, scale);
    return { before: b, after: a, delta: a.total - b.total, roster: s.roster, dropped: s.dropped, cap, openAfter: Math.max(0, cap - s.roster.length), openBefore: Math.max(0, cap - before.length) };
  }

  // Representative ("typical remaining week") lineup using ROS-average values.
  function typicalLineup(roster, cap) {
    const avg = new Map(roster.map(p => [p.id, rosAvg(p)]));
    const rv = weeks.reduce((s, w) => s + w.weight * (repl.perWeek[w.week] || 0), 0) / wSum;
    const items = roster.map(p => ({ id: p.id, ...eligOf(p), v: avg.get(p.id) }));
    const open = Math.max(0, cap - roster.length);
    for (let i = 0; i < Math.min(open, 6); i++) items.push({ id: `~repl${i}`, G: true, F: true, v: rv });
    items.sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
    const lu = bestLineup(items, st.slots);
    const rows = [];
    for (const slot of ['G', 'F', 'UTIL']) {
      const ids = items.filter(it => lu.slotOf.get(it.id) === slot);
      for (let i = 0; i < st.slots[slot]; i++) {
        const it = ids[i];
        const label = slot === 'UTIL' ? (st.slots.UTIL > 1 ? `UTIL${i + 1}` : 'UTIL') : `${slot}${i + 1}`;
        if (!it) { rows.push({ slot: label, id: null, name: 'Empty', value: 0 }); continue; }
        const p = index.get(it.id);
        rows.push({ slot: label, id: p ? p.id : null, name: p ? p.name : 'Waiver add', value: r1(it.v), replacement: !p });
      }
    }
    const bench = items.filter(it => !lu.slotOf.has(it.id) && !it.id.startsWith('~')).map(it => ({ id: it.id, name: index.get(it.id).name, value: r1(it.v) }));
    return { starters: rows, bench };
  }

  return { st, index, weeks, repl, wSum, val, rosAvg, side, teamValue, typicalLineup };
}

// Mid-draft roster for a partner we can't see: the board taken in order, our
// players excluded, the middle slot's snake picks; the players we'd get replace
// its last rounds.
function estimatePartner(players, mine, getIds, st) {
  const taken = new Set([...mine, ...getIds]);
  const avail = players.filter(p => !taken.has(String(p.id))).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9) || b.hsValue - a.hsValue || byId(a, b));
  const slot = Math.ceil(st.teams / 2);
  const picks = [];
  for (let r = 1; r <= st.rosterSize; r++) {
    const pick = r % 2 === 1 ? (r - 1) * st.teams + slot : r * st.teams - slot + 1;
    if (avail[pick - 1]) picks.push(String(avail[pick - 1].id));
  }
  return getIds.concat(picks.slice(0, Math.max(0, st.rosterSize - getIds.length)));
}

function likelihood(perWeek, band) {
  if (perWeek >= -band) return 'likely';
  if (perWeek > -3 * band) return 'maybe';
  return 'unlikely';
}

function evaluateTrade(input = {}) {
  const players = Array.isArray(input.players) ? input.players : [];
  const ids = a => [...new Set((Array.isArray(a) ? a : []).map(String))];
  const E = createEvaluator({ players, currentWeek: input.currentWeek, settings: input.settings, leagueRostered: input.leagueRostered });
  const { st, index, weeks, wSum } = E;
  const unknown = [];
  const known = list => list.filter(id => (index.has(id) ? true : (unknown.push(id), false)));

  const give = known(ids(input.give));
  const get = known(ids(input.get)).filter(id => !give.includes(id));
  const mineIds = known(ids(input.myRoster));
  for (const id of give) if (!mineIds.includes(id)) mineIds.push(id);
  const mine = mineIds.filter(id => !get.includes(id));
  const partnerEstimated = !Array.isArray(input.partnerRoster) || !input.partnerRoster.length;
  const theirsIds = partnerEstimated ? estimatePartner(players, mine, get, st) : known(ids(input.partnerRoster));
  for (const id of get) if (!theirsIds.includes(id)) theirsIds.push(id);
  const theirs = theirsIds.filter(id => !give.includes(id) && !mine.includes(id));

  const roster = list => list.map(id => index.get(id));
  const myBefore = roster(mine), theirBefore = roster(theirs);

  const you = E.side(myBefore, give, get, null);
  const them = E.side(theirBefore, get, give, null);

  // Ranges: each traded player's ROS value moves by ±u on its own; the swings
  // combine in quadrature (independent errors), not all in the worst direction.
  const spread = (before, outIds, inIds, base) => {
    let ss = 0;
    for (const id of [...inIds, ...outIds]) {
      const m = new Map([[id, 1 - uncertainty(index.get(id))]]);
      ss += (E.side(before, outIds, inIds, m).delta - base) ** 2;
    }
    return Math.sqrt(ss);
  };
  const youSd = spread(myBefore, give, get, you.delta);
  const themSd = spread(theirBefore, get, give, them.delta);
  const youLo = you.delta - youSd, youHi = you.delta + youSd;
  const themLo = them.delta - themSd, themHi = them.delta + themSd;

  const perWk = x => r1(x / wSum);
  const myWeekly = you.before.total / wSum;
  const band = Math.max(1, FAIR_BAND * myWeekly);
  const youPW = you.delta / wSum, themPW = them.delta / wSum;
  const likely = likelihood(themPW, Math.max(1, FAIR_BAND * them.before.total / wSum));

  let verdict;
  if (!give.length && !get.length) verdict = null;
  else if (youPW >= band) verdict = 'Accept';
  else if (youPW > -band) verdict = 'Counter';
  else verdict = themPW >= 2 * band ? 'Counter' : 'Decline';

  // Per-player marginal value for MY team (and theirs): roster with vs without.
  const marginal = (base, p, cap, adding) => {
    const withP = adding ? base.concat([p]) : base;
    const without = adding ? base : base.filter(x => x.id !== p.id);
    return (E.teamValue(withP, cap).total - E.teamValue(without, cap).total) / wSum;
  };
  const myCap = you.cap, theirCap = them.cap;
  const games = p => weeks.reduce((s, w) => s + num((p.gamesByWeek || {})[w.week]), 0);
  const heavy = p => weeks.filter(w => num((p.gamesByWeek || {})[w.week]) >= 4).length;
  const playoffGames = p => weeks.filter(w => w.playoff).reduce((s, w) => s + num((p.gamesByWeek || {})[w.week]), 0);
  const pl = [];
  for (const id of give) {
    const p = index.get(id);
    pl.push({ side: 'give', id, name: p.name, team: p.team, elig: p.elig, injury: p.injury || null, outForSeason: !!p.outForSeason,
      rosValue: r1(E.rosAvg(p)), forYou: r1(marginal(myBefore, p, myCap, false)), forThem: r1(marginal(theirBefore.filter(x => !get.includes(x.id)), p, theirCap, true)),
      games: games(p), heavyWeeks: heavy(p), playoffGames: playoffGames(p), uncertainty: uncertainty(p), nowValue: r1(E.val(p, weeks[0].week)) });
  }
  for (const id of get) {
    const p = index.get(id);
    pl.push({ side: 'get', id, name: p.name, team: p.team, elig: p.elig, injury: p.injury || null, outForSeason: !!p.outForSeason,
      rosValue: r1(E.rosAvg(p)), forYou: r1(marginal(myBefore.filter(x => !give.includes(x.id)), p, myCap, true)), forThem: r1(marginal(theirBefore, p, theirCap, false)),
      games: games(p), heavyWeeks: heavy(p), playoffGames: playoffGames(p), uncertainty: uncertainty(p), nowValue: r1(E.val(p, weeks[0].week)) });
  }

  const lineupBefore = E.typicalLineup(myBefore, myCap);
  const lineupAfter = E.typicalLineup(you.roster, myCap);
  const changed = lineupBefore.starters.filter((r, i) => r.id !== lineupAfter.starters[i].id).map(r => r.slot);

  const out = {
    verdict,
    you: {
      perWeek: perWk(you.delta), perWeekRange: [perWk(Math.min(youLo, youHi)), perWk(Math.max(youLo, youHi))],
      ros: r1(you.delta), rosRange: [r1(Math.min(youLo, youHi)), r1(Math.max(youLo, youHi))],
      beforePerWeek: perWk(you.before.total), afterPerWeek: perWk(you.after.total),
    },
    them: {
      perWeek: perWk(them.delta), perWeekRange: [perWk(Math.min(themLo, themHi)), perWk(Math.max(themLo, themHi))],
      ros: r1(them.delta), rosRange: [r1(Math.min(themLo, themHi)), r1(Math.max(themLo, themHi))],
      beforePerWeek: perWk(them.before.total), afterPerWeek: perWk(them.after.total),
      estimated: partnerEstimated, likely,
    },
    weeks: weeks.map(w => ({
      week: w.week, weight: w.weight, playoff: w.playoff,
      you: r1(you.after.byWeek[w.week] - you.before.byWeek[w.week]),
      them: r1(them.after.byWeek[w.week] - them.before.byWeek[w.week]),
      gamesIn: get.reduce((s, id) => s + num((index.get(id).gamesByWeek || {})[w.week]), 0),
      gamesOut: give.reduce((s, id) => s + num((index.get(id).gamesByWeek || {})[w.week]), 0),
      replacement: E.repl.perWeek[w.week],
    })),
    lineup: { before: lineupBefore, after: lineupAfter, changed },
    players: pl,
    roster: {
      you: { size: myBefore.length, cap: myCap, dropped: you.dropped.map(p => ({ id: p.id, name: p.name, rosValue: r1(E.rosAvg(p)) })), openBefore: you.openBefore, openAfter: you.openAfter },
      them: { size: theirBefore.length, cap: theirCap, dropped: them.dropped.map(p => ({ id: p.id, name: p.name, rosValue: r1(E.rosAvg(p)) })), openBefore: them.openBefore, openAfter: them.openAfter },
    },
    replacement: { perWeek: r1(weeks.reduce((s, w) => s + w.weight * (E.repl.perWeek[w.week] || 0), 0) / wSum), source: E.repl.source },
    meta: {
      weeks: weeks.length, firstWeek: weeks[0] && weeks[0].week, lastWeek: weeks.length ? weeks[weeks.length - 1].week : null,
      currentWeek: Number(input.currentWeek) || null, playoffStartWeek: st.playoffStartWeek, playoffWeight: st.playoffStartWeek != null ? st.playoffWeight : 1,
      fairBand: r1(band), unknown, settings: { teams: st.teams, rosterSize: st.rosterSize, slots: st.slots },
    },
  };
  out.consolidation = consolidationNote(out, give, get);
  out.why = whyBullets(out, E);
  out.headline = headline(out);
  return out;
}

function consolidationNote(r, give, get) {
  if (give.length === get.length) return null;
  const y = r.roster.you;
  const repl = r.replacement.perWeek;
  if (get.length > give.length) {
    const n = get.length - give.length;
    if (y.dropped.length) return `${get.length}-for-${give.length}: you must drop ${y.dropped.map(d => `${d.name} (${d.rosValue}/wk)`).join(', ')}. That loss is already in the numbers.`;
    return `${get.length}-for-${give.length}: uses ${n} of your open roster spot${n > 1 ? 's' : ''}, so no drop needed.`;
  }
  const n = give.length - get.length;
  return `${give.length}-for-${get.length}: frees ${n} roster spot${n > 1 ? 's' : ''}. A waiver add at ~${repl}/wk fills it; that is already in the numbers.`;
}

function headline(r) {
  if (!r.verdict) return 'Add players to both sides';
  const s = x => (x > 0 ? '+' : '') + x;
  const who = r.them.estimated ? 'a typical partner' : 'them';
  const take = { likely: 'they should accept', maybe: 'they might accept', unlikely: 'they will probably say no' }[r.them.likely];
  if (r.verdict === 'Accept') return `${s(r.you.perWeek)}/wk for you; ${s(r.them.perWeek)}/wk for ${who}, so ${take}.`;
  if (r.verdict === 'Decline') return `Costs you ${Math.abs(r.you.perWeek)}/wk. Decline unless they add more.`;
  if (r.you.perWeek <= -r.meta.fairBand) return `You lose ${Math.abs(r.you.perWeek)}/wk but they gain ${r.them.perWeek}/wk, so there is room to ask for more.`;
  return `Close to even (${s(r.you.perWeek)}/wk). Ask for a small add.`;
}

function whyBullets(r, E) {
  const out = [];
  const s = x => (x > 0 ? '+' : '') + x;
  const slotOfAfter = new Map(r.lineup.after.starters.filter(x => x.id).map(x => [x.id, x.slot]));
  const slotOfBefore = new Map(r.lineup.before.starters.filter(x => x.id).map(x => [x.id, x.slot]));
  for (const p of r.players.filter(x => x.side === 'get')) {
    if (p.outForSeason) { out.push(`${p.name} is out for the season: worth 0 to you.`); continue; }
    const slot = slotOfAfter.get(p.id);
    const prev = slot ? r.lineup.before.starters.find(x => x.slot === slot) : null;
    if (slot && prev && (prev.replacement || !prev.id || prev.value < 0.8 * p.rosValue)) {
      out.push(`${p.name} fills your ${slot} hole (${prev.replacement || !prev.id ? 'waiver level' : prev.name} ${prev.value}/wk now): ${s(p.forYou)}/wk.`);
    } else if (slot) {
      out.push(`${p.name} starts at ${slot}: ${s(p.forYou)}/wk.`);
    } else if (p.rosValue > 0 && p.forYou < 0.35 * p.rosValue) {
      out.push(`Positional surplus: ${p.name} (${p.rosValue}/wk) mostly sits behind your starters, so he adds only ${s(p.forYou)}/wk.`);
    } else {
      out.push(`${p.name} is depth for you: ${s(p.forYou)}/wk.`);
    }
  }
  for (const p of r.players.filter(x => x.side === 'give')) {
    const slot = slotOfBefore.get(p.id);
    if (slot) {
      const repl = r.lineup.after.starters.find(x => x.slot === slot);
      out.push(`Losing ${p.name} costs ${s(-p.forYou)}/wk at ${slot}${repl && repl.name && repl.id !== p.id ? ` (${repl.name} steps in)` : ''}.`);
    } else if (p.forYou > 0.5) out.push(`${p.name} is bench depth for you (${s(-p.forYou)}/wk).`);
  }
  // Schedule.
  const avg = (side, k) => { const xs = r.players.filter(x => x.side === side); return xs.length ? xs.reduce((a, x) => a + x[k], 0) / xs.length : 0; };
  const heavyIn = avg('get', 'heavyWeeks'), heavyOut = avg('give', 'heavyWeeks');
  const per = (x, n) => `${Math.round(x * 10) / 10} per player ${n}`;
  if (heavyOut - heavyIn >= 1.5) out.push(`Costs you 4-game weeks: ${per(heavyOut, 'out')} vs ${per(heavyIn, 'in')}.`);
  else if (heavyIn - heavyOut >= 1.5) out.push(`Adds 4-game weeks: ${per(heavyIn, 'in')} vs ${per(heavyOut, 'out')}.`);
  if (r.meta.playoffStartWeek != null) {
    const pin = avg('get', 'playoffGames'), pout = avg('give', 'playoffGames');
    if (Math.abs(pin - pout) >= 1) out.push(`Playoff weeks (${r.meta.playoffStartWeek}+, weighted ×${r.meta.playoffWeight}): ${per(pin, 'in')} vs ${per(pout, 'out')} games.`);
  }
  // Injuries.
  for (const p of r.players) {
    if (!p.injury || p.outForSeason) continue;
    if (p.nowValue < 0.6 * p.rosValue) out.push(`${p.name} (${p.injury}) is worth ${p.nowValue} this week, ${p.rosValue}/wk over the rest of the season once healthy.`);
  }
  if (r.consolidation) out.push(r.consolidation);
  return out.slice(0, 7);
}

module.exports = { evaluateTrade, bestLineup, replacementLevel, scheduleWeeks, normSettings, estimatePartner, uncertainty, createEvaluator, BENCH_SHARE, REPL_RANK };
