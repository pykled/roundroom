// Pocket NBA — High Score trade evaluator (stream E; league-profile-driven, L1).
// Method: docs/nba-trade.md.
//
//   evaluateTrade({ players, currentWeek, myRoster, partnerRoster?, give, get, settings?, leagueRostered?, profile?, today? })
//     players        board Player[] from getPlayers() (needs hsByWeek / gamesByWeek)
//     myRoster       my player ids (sleeper) before the trade; give ⊆ myRoster
//     partnerRoster  partner ids before the trade (get ⊆ it); omitted → a mid-draft roster is estimated
//     leagueRostered every rostered id in the league (waiver replacement level); omitted → percentile
//     profile        league profile (object or id; default 242808): slots, bench, IL, teams,
//                    playoff weeks, trade deadline / review rules
//     settings       overrides { teams, rosterSize (active spots), slots, endWeek, playoffStartWeek, playoffWeight }
//                    slots: a profile slot map {PG,…,UTIL,BN,IL} or legacy {G,F,UTIL}
//     today          'YYYY-MM-DD' (trade deadline countdown); default = now
//   → { verdict, you, them, weeks, lineup, players, roster, why, replacement, meta }
//
// A player's worth is never his raw hsValue: it is the change in the team's
// best lineup over the profile's starting slots (242808: PG,SG,G,SF,PF,F,C,
// UTIL,UTIL; plus a discounted bench share) summed over the remaining weeks,
// with open roster spots filled at waiver replacement level.
'use strict';
const R = require('./roster-slots');

const DEFAULT_SLOTS = { G: 2, F: 3, UTIL: 1 }; // legacy shape accepted in settings.slots
// Bench share of value above replacement, by bench rank. High Score curve
// (6 starters) 12/7/4/2%, scaled by starters/6 and cut to the bench size
// (242808: 9 starters, 5 BN → 18/10.5/6/3/1.5%). See R.benchShares.
const BENCH_SHARE = R.benchShares(require('../league-profile').highScoreDefaultProfile());
const REPL_RANK = 3;          // replacement = Nth best player outside rosters that week
const REPL_DISCOUNT = 0.9;    // waiver adds aren't free: one claim, uncertain role
const PLAYOFF_WEIGHT = 1.5;   // only when the league gives a playoff start week
const FAIR_BAND = 0.0075;     // |Δ| under this share of the weekly lineup = a wash
const MAX_DROP_CANDIDATES = 10;
const COUNTER_BANDS = 3;     // a loss beyond 3 fair bands is a Decline, however much they gain

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const r1 = x => Math.round(num(x) * 10) / 10;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Exact lineup over a slot list (roster-slots.js). items: [{ id, v, elig:Set }]
// → { total, slotOf: Map(id → slot) }.
function lineupOf(items, slotList) {
  const a = R.bestAssignment(items, slotList);
  return { total: a.total, slotOf: a.slotOf };
}

// Legacy High Score shape kept for callers/tests: items [{ id, G, F, v }],
// slots { G, F, UTIL }. Exact DP over (G used, F used, UTIL used).
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

const SLOT_KEYS = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'FC', 'UTIL'];
// Profile + overrides → settings. Every slot / roster / week input comes from
// the league profile unless the caller (Yahoo league settings, manual form)
// overrides it. Counts are clamped so a hostile body can't blow up the search.
function normSettings(s = {}, profileIn) {
  const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const prof = R.resolveProfile(profileIn || s.profile);
  let slots = { ...(prof.slots || {}) };
  const o = s.slots && typeof s.slots === 'object' && !Array.isArray(s.slots) ? s.slots : null;
  if (o && Object.keys(o).some(k => !['G', 'F', 'UTIL'].includes(k))) {
    slots = {};
    for (const k of SLOT_KEYS) slots[k] = int(o[k], 0, 4, 0);
    slots.BN = int(o.BN, 0, 10, 0);
    slots.IL = int(o.IL, 0, 4, 0);
  } else if (o) { // legacy High Score shape: F = frontcourt
    slots = { G: int(o.G, 0, 4, DEFAULT_SLOTS.G), FC: int(o.F, 0, 5, DEFAULT_SLOTS.F), UTIL: int(o.UTIL, 0, 3, DEFAULT_SLOTS.UTIL), IL: 0 };
    slots.BN = Math.max(0, int(s.rosterSize, 6, 20, 10) - slots.G - slots.FC - slots.UTIL);
  }
  const p = { ...prof, slots };
  const slotList = R.slotList(p);
  if (s.rosterSize != null) p.slots.BN = Math.max(0, int(s.rosterSize, 6, 20, R.activeSpots(p)) - slotList.length);
  const playoffWeek = ((prof.weeks || []).find(w => w.playoffs) || {}).week;
  return {
    profile: p,
    slotList,
    teams: int(s.teams ?? prof.teams, 2, 20, 10),
    rosterSize: R.activeSpots(p),
    il: R.ilSlots(p),
    bench: R.benchShares(p),
    draftRounds: (prof.draft && prof.draft.rounds) || R.activeSpots(p),
    endWeek: s.endWeek != null ? int(s.endWeek, 1, 30, null) : (prof.weeks && prof.weeks.length && prof.leagueId ? prof.weeks.length : null),
    playoffStartWeek: s.playoffStartWeek != null ? int(s.playoffStartWeek, 1, 30, null) : (playoffWeek ?? null),
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
  const inSeason = weeks.filter(w => st.endWeek == null || w <= st.endWeek);
  const rest = inSeason.filter(w => w >= cw);
  // Past the last week: score the final in-season week only and say so (meta.pastEnd).
  const out = (rest.length ? rest : (inSeason.length ? inSeason : weeks).slice(-1)).map(w => {
    const playoff = st.playoffStartWeek != null && w >= st.playoffStartWeek;
    return { week: w, weight: playoff ? st.playoffWeight : 1, playoff };
  });
  out.pastEnd = !rest.length && out.length > 0;
  return out;
}

// Waiver replacement level per week: Nth best outside league rosters when they
// are known, else the Nth player past the teams × rosterSize line (percentile).
function replacementLevel(players, weeks, st, rostered) {
  const known = rostered && rostered.size >= st.teams * 3;
  const pool = players.filter(p => !p.outForSeason && (!known || !rostered.has(String(p.id))));
  const k = known ? REPL_RANK - 1 : st.teams * (st.rosterSize + st.il) + REPL_RANK - 1;
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

function createEvaluator({ players, currentWeek, settings, leagueRostered, profile }) {
  const st = normSettings(settings, profile);
  const ALL = new Set(st.slotList);
  const eligOf = p => R.eligFor(p, st.profile);
  // Roster cap: active spots + IL slots actually holding IL-eligible (Out) players.
  const capFor = roster => st.rosterSize + Math.min(st.il, roster.filter(R.ilEligible).length);
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
    const items = roster.map(p => ({ id: p.id, elig: eligOf(p), v: val(p, week, scale) }));
    const open = Math.max(0, cap - roster.length);
    for (let i = 0; i < Math.min(open, st.slotList.length); i++) items.push({ id: `~repl${i}`, elig: ALL, v: rv });
    items.sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
    const lu = lineupOf(items, st.slotList);
    const bench = items.filter(it => !lu.slotOf.has(it.id) && !it.id.startsWith('~'));
    // A starting slot nobody on a full roster can fill (no C, say) isn't worth
    // 0: you'd drop your worst bench player for a waiver add who fills it.
    const holes = Math.min(st.slotList.length - lu.slotOf.size, bench.length);
    const holeFill = holes > 0 ? holes * rv : 0;
    let benchVal = 0;
    bench.slice(0, bench.length - holes).forEach((it, i) => { if (i < st.bench.length) benchVal += st.bench[i] * Math.max(0, it.v - rv); });
    const out = { total: lu.total + holeFill + benchVal, starters: lu.total + holeFill, holes };
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
  // allowance = overflow the roster already had before the trade (tolerated).
  function settle(roster, allowance, scale, protect) {
    let cur = roster.slice();
    const dropped = [];
    while (cur.length > capFor(cur) + allowance) {
      const cap = capFor(cur) + allowance;
      let best = null;
      const cands = cur.filter(p => !protect.has(p.id)).sort((a, b) => rosAvg(a) - rosAvg(b) || byId(a, b)).slice(0, MAX_DROP_CANDIDATES);
      for (const p of cands.length ? cands : cur) {
        const rest = cur.filter(x => x !== p);
        const v = teamValue(rest, capFor(rest) + allowance, scale).total;
        if (!best || v > best.v + 1e-9) best = { p, v, rest };
      }
      dropped.push(best.p);
      cur = best.rest;
    }
    return { roster: cur, dropped };
  }

  // Δ for one side: (roster − out + in), settled to its cap, minus before.
  function side(before, outIds, inIds, scale) {
    const allowance = Math.max(0, before.length - capFor(before));
    const capB = capFor(before) + allowance;
    const outSet = new Set(outIds);
    const incoming = inIds.map(id => index.get(id)).filter(Boolean);
    const after0 = before.filter(p => !outSet.has(p.id)).concat(incoming);
    // Protect nothing: if dropping an incoming player is cheapest, that is the truth.
    const s = settle(after0, allowance, scale, new Set());
    const capA = capFor(s.roster) + allowance;
    const b = teamValue(before, capB, scale);
    const a = teamValue(s.roster, capA, scale);
    return { before: b, after: a, delta: a.total - b.total, roster: s.roster, dropped: s.dropped, cap: capB, capAfter: capA, openAfter: Math.max(0, capA - s.roster.length), openBefore: Math.max(0, capB - before.length) };
  }

  // Representative ("typical remaining week") lineup using ROS-average values.
  function typicalLineup(roster, cap) {
    const avg = new Map(roster.map(p => [p.id, rosAvg(p)]));
    const rv = weeks.reduce((s, w) => s + w.weight * (repl.perWeek[w.week] || 0), 0) / wSum;
    const items = roster.map(p => ({ id: p.id, elig: eligOf(p), v: avg.get(p.id) }));
    const open = Math.max(0, cap - roster.length);
    for (let i = 0; i < Math.min(open, st.slotList.length); i++) items.push({ id: `~repl${i}`, elig: ALL, v: rv });
    items.sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
    const lu = lineupOf(items, st.slotList);
    let holesLeft = Math.min(st.slotList.length - lu.slotOf.size, items.filter(it => !lu.slotOf.has(it.id) && !it.id.startsWith('~')).length);
    const rows = [];
    const counts = {};
    for (const sl of st.slotList) counts[sl] = (counts[sl] || 0) + 1;
    for (const slot of Object.keys(counts)) {
      const ids = items.filter(it => lu.slotOf.get(it.id) === slot);
      for (let i = 0; i < counts[slot]; i++) {
        const it = ids[i];
        const label = counts[slot] > 1 ? `${slot}${i + 1}` : slot;
        if (!it && holesLeft > 0) { holesLeft--; rows.push({ slot: label, id: null, name: 'Waiver add', value: r1(rv), replacement: true, hole: true }); continue; }
        if (!it) { rows.push({ slot: label, id: null, name: 'Empty', value: 0 }); continue; }
        const p = index.get(it.id);
        rows.push({ slot: label, id: p ? p.id : null, name: p ? p.name : 'Waiver add', value: r1(it.v), replacement: !p });
      }
    }
    const bench = items.filter(it => !lu.slotOf.has(it.id) && !it.id.startsWith('~')).map(it => ({ id: it.id, name: index.get(it.id).name, value: r1(it.v) }));
    return { starters: rows, bench };
  }

  return { st, index, weeks, repl, wSum, val, rosAvg, side, teamValue, typicalLineup, capFor };
}

// Mid-draft roster for a partner we can't see: the board taken in order, our
// players excluded, the middle slot's snake picks; the players we'd get replace
// its last rounds.
function estimatePartner(players, mine, getIds, st) {
  const taken = new Set([...mine, ...getIds]);
  const avail = players.filter(p => !taken.has(String(p.id))).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9) || b.hsValue - a.hsValue || byId(a, b));
  const slot = Math.ceil(st.teams / 2);
  const picks = [];
  for (let r = 1; r <= st.draftRounds; r++) {
    const pick = r % 2 === 1 ? (r - 1) * st.teams + slot : r * st.teams - slot + 1;
    if (avail[pick - 1]) picks.push(String(avail[pick - 1].id));
  }
  return getIds.concat(picks.slice(0, Math.max(0, st.draftRounds - getIds.length)));
}

// Accept a clear gain; Counter a wash, or a modest loss when they gain (an add
// can close the gap); Decline a loss past COUNTER_BANDS however much they gain.
function verdictFor(youPW, themPW, band) {
  if (youPW >= band) return 'Accept';
  if (youPW > -band) return 'Counter';
  return youPW > -COUNTER_BANDS * band && themPW >= band ? 'Counter' : 'Decline';
}

function likelihood(perWeek, band) {
  if (perWeek >= -band) return 'likely';
  if (perWeek > -3 * band) return 'maybe';
  return 'unlikely';
}

function evaluateTrade(input = {}) {
  const players = Array.isArray(input.players) ? input.players : [];
  const ids = a => [...new Set((Array.isArray(a) ? a : []).map(String))];
  const E = createEvaluator({ players, currentWeek: input.currentWeek, settings: input.settings, leagueRostered: input.leagueRostered, profile: input.profile });
  const { st, index, weeks, wSum } = E;
  const unknown = [];
  const known = list => list.filter(id => (index.has(id) ? true : (unknown.push(id), false)));

  const notes = [];
  const nameOf = id => index.get(id).name;
  const give = known(ids(input.give));
  const mineIds = known(ids(input.myRoster));
  const getAll = known(ids(input.get));
  // Ids that can't be part of a trade: on both sides, or "getting" someone I already own.
  for (const id of getAll) {
    if (give.includes(id)) notes.push(`${nameOf(id)} is on both sides; counted as given only.`);
    else if (mineIds.includes(id)) notes.push(`${nameOf(id)} is already on your roster; left out of what you get.`);
  }
  const get = getAll.filter(id => !give.includes(id) && !mineIds.includes(id));
  const hadRoster = mineIds.length > 0;
  for (const id of give) if (!mineIds.includes(id)) {
    if (hadRoster) notes.push(`${nameOf(id)} isn't on your roster; counted as yours.`);
    mineIds.push(id);
  }
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

  const verdict = give.length || get.length ? verdictFor(youPW, themPW, band) : null;

  // Per-player marginal value for MY team (and theirs): roster with vs without.
  const marginal = (base, p, cap, adding) => {
    const withP = adding ? base.concat([p]) : base;
    const without = adding ? base : base.filter(x => x.id !== p.id);
    return (E.teamValue(withP, cap).total - E.teamValue(without, cap).total) / wSum;
  };
  const myCap = you.cap, theirCap = them.cap;
  const pubElig = p => [...R.eligFor(p, st.profile)].filter(x => x !== 'UTIL');
  const games = p => weeks.reduce((s, w) => s + num((p.gamesByWeek || {})[w.week]), 0);
  const heavy = p => weeks.filter(w => num((p.gamesByWeek || {})[w.week]) >= 4).length;
  const playoffGames = p => weeks.filter(w => w.playoff).reduce((s, w) => s + num((p.gamesByWeek || {})[w.week]), 0);
  const pl = [];
  for (const id of give) {
    const p = index.get(id);
    pl.push({ side: 'give', id, name: p.name, team: p.team, elig: pubElig(p), injury: p.injury || null, outForSeason: !!p.outForSeason,
      rosValue: r1(E.rosAvg(p)), forYou: r1(marginal(myBefore, p, myCap, false)), forThem: r1(marginal(theirBefore.filter(x => !get.includes(x.id)), p, theirCap, true)),
      games: games(p), heavyWeeks: heavy(p), playoffGames: playoffGames(p), uncertainty: uncertainty(p), nowValue: weeks.length ? r1(E.val(p, weeks[0].week)) : 0 });
  }
  for (const id of get) {
    const p = index.get(id);
    pl.push({ side: 'get', id, name: p.name, team: p.team, elig: pubElig(p), injury: p.injury || null, outForSeason: !!p.outForSeason,
      rosValue: r1(E.rosAvg(p)), forYou: r1(marginal(myBefore.filter(x => !give.includes(x.id)), p, myCap, true)), forThem: r1(marginal(theirBefore, p, theirCap, false)),
      games: games(p), heavyWeeks: heavy(p), playoffGames: playoffGames(p), uncertainty: uncertainty(p), nowValue: weeks.length ? r1(E.val(p, weeks[0].week)) : 0 });
  }

  const lineupBefore = E.typicalLineup(myBefore, myCap);
  const lineupAfter = E.typicalLineup(you.roster, you.capAfter);
  alignSlots(lineupBefore.starters, lineupAfter.starters);
  stabilize(lineupBefore.starters, lineupAfter.starters, id => { const p = index.get(id); return p ? R.eligFor(p, st.profile) : null; });
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
      fairBand: r1(band), unknown, notes, pastEnd: !!weeks.pastEnd,
      settings: { teams: st.teams, rosterSize: st.rosterSize, il: st.il, slots: st.profile.slots, slotList: st.slotList, starters: st.slotList.length, benchShare: st.bench.map(x => Math.round(x * 1000) / 1000) },
      rules: tradeRules(st.profile, input.today),
    },
  };
  out.consolidation = consolidationNote(out, give, get);
  out.why = whyBullets(out, E);
  out.headline = headline(out);
  return out;
}

// Trade deadline + review process from the profile (UI notes).
function tradeRules(profile, today) {
  const t = profile.trades || {};
  const day = s => Math.floor(Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') / 86400000);
  const now = today && /^\d{4}-\d{2}-\d{2}/.test(String(today)) ? String(today).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const end = profile.tradeEnd || null;
  const daysLeft = end ? day(end) - day(now) : null;
  const notes = [];
  if (end) notes.push(daysLeft < 0 ? `Trades closed on ${end}.` : `Trade deadline ${end} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left).`);
  if (t.review === 'commissioner') notes.push('Trades go to the commissioner for review.');
  else if (t.review === 'league') notes.push('Trades go to a league vote.');
  if (t.protestDays) notes.push(`Other managers have ${t.protestDays} days to protest before it processes, so the players arrive ~${t.protestDays} days after acceptance.`);
  if (t.draftPickTrades === false) notes.push('Draft picks can\'t be traded in this league.');
  return { tradeEnd: end, daysLeft, open: daysLeft == null || daysLeft >= 0, review: t.review || null, protestDays: t.protestDays ?? null, draftPickTrades: t.draftPickTrades ?? null, notes };
}

// Keep a player who stays in the same slot group (G1/G2, F1-F3) on the same row,
// so the before/after diff shows only real changes.
function alignSlots(before, after) {
  const group = r => r.slot.replace(/\d+$/, '');
  for (const g of [...new Set(after.map(group))]) {
    const idx = after.map((r, i) => (group(r) === g ? i : -1)).filter(i => i >= 0);
    const rows = idx.map(i => after[i]);
    const placed = new Array(idx.length).fill(null);
    idx.forEach((bi, k) => { const j = rows.findIndex(r => r && r.id && r.id === before[bi].id); if (j >= 0) { placed[k] = rows[j]; rows[j] = null; } });
    const rest = rows.filter(Boolean);
    idx.forEach((ai, k) => { const r = placed[k] || rest.shift(); after[ai] = { ...r, slot: before[ai].slot }; });
  }
}

// With distinct slot names (PG, SG, …) an incoming player can shuffle others
// between slots. Swap pairs of after-rows while it puts a player back in his
// before slot and both stay eligible, so only real changes are highlighted.
function stabilize(before, after, eligOf) {
  const type = r => r.slot.replace(/\d+$/, '');
  const ok = (row, slotRow) => {
    if (!row.id) return !!row.replacement;
    const e = eligOf(row.id);
    return !!(e && e.has(type(slotRow)));
  };
  for (let pass = 0; pass < after.length; pass++) {
    let changed = false;
    for (let i = 0; i < after.length; i++) {
      const want = before[i] && before[i].id;
      if (!want || after[i].id === want) continue;
      const j = after.findIndex(r => r.id === want);
      if (j < 0) continue;
      const x = after[i], y = after[j];
      if (!ok(y, after[i]) || !ok(x, after[j])) continue;
      after[i] = { ...y, slot: x.slot };
      after[j] = { ...x, slot: y.slot };
      changed = true;
    }
    if (!changed) break;
  }
}

function consolidationNote(r, give, get) {
  if (give.length === get.length) return null;
  const y = r.roster.you;
  const repl = r.replacement.perWeek;
  if (get.length > give.length) {
    const n = get.length - give.length;
    if (!give.length) return y.dropped.length ? `Adding ${n} for nothing: you must drop ${y.dropped.map(d => `${d.name} (${d.rosValue}/wk)`).join(', ')}.` : `Adding ${n} for nothing uses an open roster spot.`;
    if (y.dropped.length) return `${get.length}-for-${give.length}: you must drop ${y.dropped.map(d => `${d.name} (${d.rosValue}/wk)`).join(', ')}. That loss is already in the numbers.`;
    return `${get.length}-for-${give.length}: uses ${n} of your open roster spot${n > 1 ? 's' : ''}, so no drop needed.`;
  }
  const n = give.length - get.length;
  const label = get.length ? `${give.length}-for-${get.length}` : `Giving ${give.length} for nothing`;
  return `${label}: frees ${n} roster spot${n > 1 ? 's' : ''}. A waiver add at ~${repl}/wk fills it; that is already in the numbers.`;
}

function headline(r) {
  if (!r.verdict) return 'Add players to both sides';
  const s = x => (x > 0 ? '+' : '') + Number(x).toFixed(1);
  const who = r.them.estimated ? 'a typical partner' : 'them';
  const take = { likely: 'they should accept', maybe: 'they might accept', unlikely: 'they will probably say no' }[r.them.likely];
  if (r.verdict === 'Accept') return `${s(r.you.perWeek)}/wk for you; ${s(r.them.perWeek)}/wk for ${who}, so ${take}.`;
  if (r.verdict === 'Decline') return `Costs you ${Math.abs(r.you.perWeek).toFixed(1)}/wk. Decline unless they add more.`;
  if (r.you.perWeek <= -r.meta.fairBand) return `You lose ${Math.abs(r.you.perWeek).toFixed(1)}/wk and they gain ${r.them.perWeek.toFixed(1)}/wk. Ask them to add a piece.`;
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
      out.push(`Losing ${p.name} costs ${Math.abs(p.forYou).toFixed(1)}/wk at ${slot}${repl && repl.name && repl.id !== p.id ? ` (${repl.name} steps in)` : ''}.`);
    } else if (p.forYou > 0.5) out.push(`${p.name} is bench depth for you (${Math.abs(p.forYou).toFixed(1)}/wk).`);
  }
  // Schedule.
  const avg = (side, k) => { const xs = r.players.filter(x => x.side === side); return xs.length ? xs.reduce((a, x) => a + x[k], 0) / xs.length : 0; };
  const both = r.players.some(x => x.side === 'get') && r.players.some(x => x.side === 'give');
  const heavyIn = avg('get', 'heavyWeeks'), heavyOut = avg('give', 'heavyWeeks');
  const per = (x, n) => `${Math.round(x * 10) / 10} per player ${n}`; // n: 'going out' | 'coming in'
  if (!both) { /* schedule comparison needs players on both sides */ }
  else if (heavyOut - heavyIn >= 1.5) out.push(`Costs you 4-game weeks: ${per(heavyOut, 'going out')} vs ${per(heavyIn, 'coming in')}.`);
  else if (heavyIn - heavyOut >= 1.5) out.push(`Adds 4-game weeks: ${per(heavyIn, 'coming in')} vs ${per(heavyOut, 'going out')}.`);
  if (both && r.meta.playoffStartWeek != null) {
    const pin = avg('get', 'playoffGames'), pout = avg('give', 'playoffGames');
    if (Math.abs(pin - pout) >= 1) out.push(`Playoff weeks (${r.meta.playoffStartWeek}+, weighted ×${r.meta.playoffWeight}): ${Math.round(pin * 10) / 10} games per player coming in vs ${Math.round(pout * 10) / 10} going out.`);
  }
  // Injuries.
  for (const p of r.players) {
    if (!p.injury || p.outForSeason) continue;
    if (p.nowValue < 0.6 * p.rosValue) out.push(`${p.name} (${p.injury}) is worth ${p.nowValue} this week, ${p.rosValue}/wk over the rest of the season once healthy.`);
  }
  if (r.consolidation) out.push(r.consolidation);
  return out.slice(0, 7);
}

module.exports = { evaluateTrade, verdictFor, bestLineup, replacementLevel, scheduleWeeks, normSettings, estimatePartner, uncertainty, createEvaluator, tradeRules, BENCH_SHARE, REPL_RANK, FAIR_BAND, COUNTER_BANDS };
