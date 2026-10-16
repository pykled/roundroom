// Pocket NBA — High Score trade evaluator (stream E; league-profile-driven, L1; v2 = NBA trade spec §4).
// Method: docs/nba-trade.md.
//
//   evaluateTrade({ players, currentWeek, myRoster, partnerRoster?, give, get, settings?, leagueRostered?, profile?, today?,
//                   options?, context?, leagueRosters? })
//     players        board Player[] from getPlayers() (needs hsByWeek / gamesByWeek)
//     myRoster       my player ids (sleeper) before the trade; give ⊆ myRoster
//     partnerRoster  partner ids before the trade (get ⊆ it); omitted → a mid-draft roster is estimated
//     leagueRostered every rostered id in the league (waiver replacement level); omitted → percentile
//     profile        league profile (object or id; default 242808): slots, bench, IL, teams,
//                    playoff weeks, trade deadline / review rules
//     settings       overrides { teams, rosterSize (active spots), slots, endWeek, playoffStartWeek, playoffWeight }
//                    slots: a profile slot map {PG,…,UTIL,BN,IL} or legacy {G,F,UTIL}
//     today          'YYYY-MM-DD' (trade deadline countdown); default = now
//     options        v2 { horizon: 'ros'|'next4'|'playoffs', lean: 'contend'|'balanced' } (default ros / contend)
//     context        v2 signal inputs { logs, proj, market, eta, bio, asOf: { board, market, injuryEta } }
//     leagueRosters  v2 every team's ids ([[id]]): league-relative tiers on the fit panel; omitted → depth-only tiers
//   → { verdict, you, them, weeks, lineup, players, roster, why, replacement, meta,            (v1, unchanged)
//       version: 2, options, value, fit, themFit, summary, dataAsOf }                        (v2, §4.1)
//
// A player's worth is never his raw hsValue: it is the change in the team's
// best lineup over the profile's starting slots (242808: PG,SG,G,SF,PF,F,C,
// UTIL,UTIL; plus a discounted bench share) summed over the remaining weeks,
// with open roster spots filled at waiver replacement level. That is the Fit
// axis (verdict). v2 adds a league-neutral Value axis (asset value in vs out,
// market-aware) and per-player signals; neither changes the verdict.
'use strict';
const R = require('./roster-slots');
const SIG = require('./signals');
const RA = require('./roster-analysis');
const Interim = require('./trade-interim');

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
// v2 (spec §4.1). Horizon = which weeks count; lean = how much the playoff weeks weigh.
const HORIZONS = ['ros', 'next4', 'playoffs'];
const LEANS = ['contend', 'balanced'];
const PLAYOFFS_HORIZON_FROM_WEEK = 10; // the playoffs-only horizon is meaningless before week 10
// Value axis: asset value above a free waiver add, NFL-style transform (shared/scoring.js
// computeVORP: VORP^1.25). Raw pts/wk compress star value (73 vs 55 reads 25% apart; above
// replacement it is 48 vs 30), so the fairness label reads the transformed values.
const VALUE_POWER = 1.25;
const VALUE_FLOOR_ABOVE = 20;  // label denominator never below a top-25 player (~20 pts/wk above a waiver add)
const VALUE_BANDS = [[0.10, 'even'], [0.25, 'leans'], [0.40, 'favors'], [Infinity, 'lopsided']];

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
// horizon (v2): 'ros' every remaining week, 'next4' the next four, 'playoffs'
// the playoff weeks only (falls back to 'ros' when the league has none).
function scheduleWeeks(players, currentWeek, st, horizon = 'ros') {
  const all = new Set();
  for (const p of players.slice(0, 50)) for (const w of Object.keys(p.hsByWeek || {})) all.add(Number(w));
  let weeks = [...all].filter(Number.isFinite).sort((a, b) => a - b);
  const cw = Number(currentWeek) || weeks[0] || 1;
  const inSeason = weeks.filter(w => st.endWeek == null || w <= st.endWeek);
  const rest = inSeason.filter(w => w >= cw);
  // Past the last week: score the final in-season week only and say so (meta.pastEnd).
  let out = (rest.length ? rest : (inSeason.length ? inSeason : weeks).slice(-1)).map(w => {
    const playoff = st.playoffStartWeek != null && w >= st.playoffStartWeek;
    return { week: w, weight: playoff ? st.playoffWeight : 1, playoff };
  });
  const pastEnd = !rest.length && out.length > 0;
  let applied = 'ros';
  if (horizon === 'next4' && out.length) { out = out.slice(0, 4); applied = 'next4'; }
  else if (horizon === 'playoffs' && out.some(w => w.playoff)) { out = out.filter(w => w.playoff); applied = 'playoffs'; }
  out.pastEnd = pastEnd;
  out.horizon = applied;
  return out;
}

// v2 request options → { horizon, lean, leanSource }. Unknown values fall back to the defaults.
function normOptions(o) {
  const x = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  const horizon = HORIZONS.includes(x.horizon) ? x.horizon : 'ros';
  const lean = LEANS.includes(x.lean) ? x.lean : 'contend';
  const leanSource = ['user', 'record', 'default'].includes(x.leanSource) ? x.leanSource : LEANS.includes(x.lean) ? 'user' : 'default';
  return { horizon, lean, leanSource };
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

function createEvaluator({ players, currentWeek, settings, leagueRostered, profile, options }) {
  const st = normSettings(settings, profile);
  const opts = normOptions(options);
  // Lean: contend keeps the playoff weighting; balanced counts every week the same.
  if (opts.lean === 'balanced') st.playoffWeight = 1;
  const ALL = new Set(st.slotList);
  const eligOf = p => R.eligFor(p, st.profile);
  // Roster cap: active spots + IL slots actually holding IL-eligible (Out) players.
  const capFor = roster => st.rosterSize + Math.min(st.il, roster.filter(R.ilEligible).length);
  const index = new Map(players.map(p => [String(p.id), p]));
  const weeks = scheduleWeeks(players, currentWeek, st, opts.horizon);
  const rostered = leagueRostered ? new Set(leagueRostered.map(String)) : null;
  const repl = replacementLevel(players, weeks, st, rostered);
  const wSum = weeks.reduce((s, w) => s + w.weight, 0) || 1;
  const val = (p, w, scale) => num((p.hsByWeek || {})[w]) * (scale && scale.has(p.id) ? scale.get(p.id) : 1);
  const rosAvg = (p, scale) => weeks.reduce((s, w) => s + w.weight * val(p, w.week, scale), 0) / wSum;

  // One week's team value: best lineup (open spots filled at replacement) plus
  // a discounted share of bench depth above replacement.
  // A starting slot nobody can fill (no C, say) or can only fill below waiver
  // level isn't worth that: you'd drop your worst bench player for a waiver add
  // who plays it. v2: the stream is offered for every slot (one waiver add per
  // player who has to sit), not only unfillable ones, so receiving an extra
  // player can never leave a slot worse than the waiver add it displaced
  // (spec §4.6 #3; Dillon's 13/14 roster broke it by up to 4.4/wk).
  function weekValue(roster, cap, week, scale, keepSlots) {
    const rv = repl.perWeek[week] || 0;
    const items = roster.map(p => ({ id: p.id, elig: eligOf(p), v: val(p, week, scale) }));
    const open = Math.max(0, cap - roster.length);
    for (let i = 0; i < Math.min(open, st.slotList.length); i++) items.push({ id: `~repl${i}`, elig: ALL, v: rv });
    const spare = Math.min(st.slotList.length, Math.max(0, roster.length - st.slotList.length));
    for (let i = 0; i < spare; i++) items.push({ id: `~swap${i}`, elig: ALL, v: rv });
    items.sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
    const lu = lineupOf(items, st.slotList);
    const bench = items.filter(it => !lu.slotOf.has(it.id) && !it.id.startsWith('~'));
    let swaps = 0;
    for (const id of lu.slotOf.keys()) if (id.startsWith('~swap')) swaps++;
    const holes = Math.min(st.slotList.length - lu.slotOf.size, Math.max(0, bench.length - swaps));
    const holeFill = holes > 0 ? holes * rv : 0;
    let benchVal = 0;
    bench.slice(0, Math.max(0, bench.length - swaps - holes)).forEach((it, i) => { if (i < st.bench.length) benchVal += st.bench[i] * Math.max(0, it.v - rv); });
    const out = { total: lu.total + holeFill + benchVal, starters: lu.total + holeFill, holes: holes + swaps };
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
  // Incoming players are always drop candidates (v2 monotonicity, spec §4.6 #3: receiving
  // an extra player can never leave you worse than not receiving him, since you can waive him).
  function settle(roster, allowance, scale, protect, incoming = new Set()) {
    let cur = roster.slice();
    const dropped = [];
    while (cur.length > capFor(cur) + allowance) {
      const cap = capFor(cur) + allowance;
      let best = null;
      const cheap = cur.filter(p => !protect.has(p.id)).sort((a, b) => rosAvg(a) - rosAvg(b) || byId(a, b)).slice(0, MAX_DROP_CANDIDATES);
      const cands = cheap.concat(cur.filter(p => incoming.has(p.id) && !protect.has(p.id) && !cheap.includes(p)));
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
    const s = settle(after0, allowance, scale, new Set(), new Set(incoming.map(p => p.id)));
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
    // Same stream rule as weekValue: a slot only playable below waiver level shows a waiver add.
    const spare = Math.min(st.slotList.length, Math.max(0, roster.length - st.slotList.length));
    for (let i = 0; i < spare; i++) items.push({ id: `~swap${i}`, elig: ALL, v: rv, hole: true });
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
        const row = { slot: label, id: p ? p.id : null, name: p ? p.name : 'Waiver add', value: r1(it.v), replacement: !p };
        if (!p && it.hole) row.hole = true;
        rows.push(row);
      }
    }
    const bench = items.filter(it => !lu.slotOf.has(it.id) && !it.id.startsWith('~')).map(it => ({ id: it.id, name: index.get(it.id).name, value: r1(it.v) }));
    return { starters: rows, bench };
  }

  return { st, opts, index, weeks, repl, wSum, val, rosAvg, side, teamValue, typicalLineup, capFor };
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
  const E = createEvaluator({ players, currentWeek: input.currentWeek, settings: input.settings, leagueRostered: input.leagueRostered, profile: input.profile, options: input.options });
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
  // v2 (spec §4.1): superset of v1. A failure in the v2 layer never costs the
  // verdict: the v1 answer still goes out, with the v2 blocks empty and a note.
  out.version = 2;
  out.options = { horizon: weeks.horizon || 'ros', lean: E.opts.lean, leanSource: E.opts.leanSource, weights: { playoff: out.meta.playoffWeight } };
  if (E.opts.horizon !== out.options.horizon) notes.push(`No playoff weeks in this league's schedule; showing the rest of the season.`);
  try {
    Object.assign(out, v2Layer({ input, E, out, give, get, mine, myBefore, theirBefore, you, them, partnerEstimated, players }));
  } catch (err) {
    out.value = null; out.fit = null; out.themFit = null; out.summary = null; out.dataAsOf = null;
    out.meta.v2Error = String((err && err.message) || err).slice(0, 200);
  }
  return out;
}

/* ------------------------------------------------------------------ v2 layer */

// Stream A's shared function when implemented; the interim stand-in while it throws NOT_IMPLEMENTED.
function shared(fnA, fnB, args) {
  try { return { value: fnA(...args), source: 'shared' }; } catch (e) {
    if (e && e.code === SIG.NOT_IMPLEMENTED) return { value: fnB(...args), source: 'interim' };
    throw e;
  }
}

const GROUP_LABEL = { G: 'guard', F: 'forward', C: 'center', UTIL: 'UTIL' };
const GROUP_OF_SLOT = { PG: 'G', SG: 'G', G: 'G', SF: 'F', PF: 'F', F: 'F', FC: 'F', C: 'C', UTIL: 'UTIL' };
const TIER_RANK = { critical: 0, upgrade: 1, thin: 2, solid: 3, deep: 4, loaded: 5 };
const fmt1 = x => (Math.round(num(x) * 10) / 10).toFixed(1);
const sgn = x => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(Math.round(num(x) * 10) / 10).toFixed(1);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monDay = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : null; };
const seasonLabel = y => (Number.isInteger(y) ? `${y}-${String((y + 1) % 100).padStart(2, '0')}` : null);
const HORIZON_TEXT = { ros: 'rest of season', next4: 'next 4 weeks', playoffs: 'playoff weeks' };

// League-relative tier inputs (team page rule, spec §5.1): mean group starter value across
// teams and the starter value of the last team inside the top 30%. Cached per board + key.
const leagueCtxCache = new WeakMap();
function leagueGroupContext(rosters, ctx) {
  const key = JSON.stringify([ctx.weeks.map(w => [w.week, w.weight]), rosters, ctx.profile.leagueId, ctx.profile.slots]);
  let m = leagueCtxCache.get(ctx.board);
  if (!m) { m = new Map(); leagueCtxCache.set(ctx.board, m); }
  if (m.has(key)) return m.get(key);
  const per = rosters.map(ids => ctx.analyze(ids.map(id => ctx.index.get(String(id))).filter(Boolean), null));
  const leagueAvg = {}, strongCutoff = {};
  for (const g of RA.GROUPS) {
    const vals = per.map(a => num(a.groups[g] && a.groups[g].starterValue)).sort((a, b) => b - a);
    if (!vals.length) continue;
    leagueAvg[g] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
    strongCutoff[g] = vals[Math.max(1, Math.floor(RA.STRONG_SHARE * vals.length)) - 1];
  }
  const v = { leagueAvg, strongCutoff, teams: per.length };
  if (m.size > 50) m.clear();
  m.set(key, v);
  return v;
}

function v2Layer({ input, E, out, give, get, myBefore, theirBefore, you, them, partnerEstimated, players }) {
  const { st, index, weeks } = E;
  const c = input.context && typeof input.context === 'object' ? input.context : {};
  const cw = Number(input.currentWeek) || (weeks[0] && weeks[0].week) || 1;
  const sigCtx = {
    profile: st.profile, currentWeek: cw, weeks: weeks.map(w => ({ week: w.week, weight: w.weight, playoff: w.playoff })),
    logs: c.logs || null, proj: c.proj || null, market: c.market || null, eta: c.eta || null, bio: c.bio || null,
    replacement: E.repl, today: input.today || null, board: players,
  };
  const replRos = num(out.replacement.perWeek);

  // Signals for everyone the trade touches (traded + forced drops).
  const touched = [...new Set([...give, ...get, ...you.dropped.map(p => p.id), ...them.dropped.map(p => p.id)])].map(id => index.get(id)).filter(Boolean);
  const sig = shared(SIG.signalsFor, Interim.signalsFor, [touched, sigCtx]);
  const S = sig.value instanceof Map ? sig.value : new Map(Object.entries(sig.value || {}));
  const blended = id => { const s = S.get(String(id)); return s && s.value ? num(s.value.blended) : 0; };

  // ---- Value axis (league-neutral, market-aware). Raw = pts/wk; surplus = above replacement ^1.25.
  const surplus = v => Math.pow(Math.max(0, v - replRos), VALUE_POWER);
  const sum = (ids, f) => ids.reduce((s, id) => s + f(blended(id)), 0);
  const assetIn = sum(get, x => x), assetOut = sum(give, x => x);
  // Roster spots, by head count only (IL moves are a lineup matter, priced on the Fit axis):
  // each extra player takes a spot worth a waiver add (replacement), and past the roster
  // limit the side waives its cheapest player (his value above replacement is lost). A side
  // that frees spots gets waiver adds. Traded players count at their blended value, the
  // rest of the roster at its rest-of-season value.
  const valueOf = p => (S.has(String(p.id)) ? blended(p.id) : E.rosAvg(p));
  const spotAdj = (before, outIds, inIds) => {
    const net = inIds.length - outIds.length;
    if (net <= 0) return { raw: -net * replRos, sur: 0, drops: [] };
    const outSet = new Set(outIds);
    const after = before.filter(p => !outSet.has(p.id)).concat(inIds.map(id => index.get(id)).filter(Boolean));
    const limit = Math.max(before.length, st.rosterSize);
    const drops = after.slice().sort((x, y) => valueOf(x) - valueOf(y) || byId(x, y)).slice(0, Math.max(0, after.length - limit));
    const lost = drops.reduce((a, p) => a + surplus(valueOf(p)), 0);
    return { raw: -net * replRos - drops.reduce((a, p) => a + Math.max(0, valueOf(p) - replRos), 0), sur: -lost, drops };
  };
  const aMe = spotAdj(myBefore, give, get), aThem = spotAdj(theirBefore, get, give);
  // Half each side's spot effect, so swapping perspectives negates the gap exactly.
  const consolidationAdj = (aMe.raw - aThem.raw) / 2;
  const gap = assetIn - assetOut + consolidationAdj;
  const surIn = sum(get, surplus), surOut = sum(give, surplus);
  const surGap = surIn - surOut + (aMe.sur - aThem.sur) / 2;
  const floor = Math.pow(VALUE_FLOOR_ABOVE, VALUE_POWER);
  const gapPct = (give.length || get.length) ? surGap / Math.max(surIn, surOut, floor) : 0;
  const a = Math.abs(gapPct);
  const band = VALUE_BANDS.find(([t]) => a <= t + 1e-9)[1];
  const dir = band === 'even' ? null : gapPct > 0 ? 'you' : 'them';
  const label = band === 'even' ? 'Even' : `${{ leans: 'Leans', favors: 'Favors', lopsided: 'Lopsided for' }[band]} ${dir === 'you' ? (band === 'leans' ? 'your way' : 'you') : (band === 'leans' ? 'their way' : 'them')}`;
  const value = {
    assetIn: r1(assetIn), assetOut: r1(assetOut), gap: r1(gap), gapPct: Math.round(gapPct * 1000) / 1000, label, band, direction: dir,
    marketWeight: Math.round(SIG.marketWeight(cw) * 1000) / 1000, consolidationAdj: r1(consolidationAdj),
    surplusIn: r1(surIn), surplusOut: r1(surOut), surplusGap: r1(surGap), replacement: r1(replRos),
    basis: `season value (pts/wk, market-blended); label on value above a waiver add ^${VALUE_POWER}`,
  };

  // ---- Team fit (before/after) with league-relative tiers when every roster is known.
  const analyze = (ps, lg) => shared(RA.analyzeRoster, Interim.analyzeRoster, [{
    players: ps, profile: st.profile, weeks: sigCtx.weeks, replacement: E.repl,
    leagueAvg: lg ? lg.leagueAvg : null, strongCutoff: lg ? lg.strongCutoff : null, currentWeek: cw, board: players,
  }]).value;
  const rosters = Array.isArray(input.leagueRosters) ? input.leagueRosters.filter(r => Array.isArray(r) && r.length).map(r => r.map(String)) : [];
  const lg = rosters.length >= 4 ? leagueGroupContext(rosters, { ...sigCtx, index, analyze }) : null;
  const fitFor = (before, after, lineupB, lineupA, who) => {
    const fb = analyze(before, lg), fa = analyze(after, lg);
    const deltaByGroup = {};
    for (const g of RA.GROUPS) {
      const b = fb.groups[g], x = fa.groups[g];
      deltaByGroup[g] = { tierBefore: b.tier, tierAfter: x.tier, starterValueDelta: r1(num(x.starterValue) - num(b.starterValue)), rosteredBefore: b.rostered, rosteredAfter: x.rostered, slots: b.slots };
    }
    return { before: fb, after: fa, deltaByGroup, notes: fitNotes({ fb, fa, deltaByGroup, lineupB, lineupA, touchedGroups: touchedGroups([...give, ...get]), who }), leagueRelative: !!lg };
  };
  const touchedGroups = ids => {
    const gs = new Set();
    for (const id of ids) { const p = index.get(id); if (!p) continue; for (const s of R.eligFor(p, st.profile)) if (GROUP_OF_SLOT[s] && s !== 'UTIL') gs.add(GROUP_OF_SLOT[s]); }
    return gs;
  };
  const myAfter = you.roster;
  const fit = fitFor(myBefore, myAfter, out.lineup.before, out.lineup.after, 'you');
  let themFit = null, theirLineupB = null, theirLineupA = null;
  theirLineupB = E.typicalLineup(theirBefore, them.cap);
  theirLineupA = E.typicalLineup(them.roster, them.capAfter);
  if (!partnerEstimated) themFit = fitFor(theirBefore, them.roster, theirLineupB, theirLineupA, 'them');

  // ---- Per-player additions.
  const slotIn = (lineup, id) => {
    if (!lineup) return null;
    const s = lineup.starters.find(x => x.id === id);
    if (s) return s.slot;
    return lineup.bench.some(x => x.id === id) ? 'BN' : null;
  };
  const groupOf = (p, slot) => {
    const base = slot ? String(slot).replace(/\d+$/, '') : null;
    if (base && GROUP_OF_SLOT[base]) return GROUP_OF_SLOT[base];
    const e = R.eligFor(p, st.profile);
    const pos0 = Array.isArray(p.pos) && p.pos[0];
    if (pos0 && GROUP_OF_SLOT[pos0] && e.has(pos0)) return GROUP_OF_SLOT[pos0];
    for (const s of ['C', 'PG', 'SG', 'G', 'SF', 'PF', 'F', 'FC']) if (e.has(s)) return GROUP_OF_SLOT[s];
    return 'UTIL';
  };
  for (const pl of out.players) {
    const p = index.get(pl.id);
    const s = S.get(String(pl.id)) || null;
    const mineNow = pl.side === 'give';
    pl.signals = s;
    pl.slotBefore = mineNow ? slotIn(out.lineup.before, pl.id) : slotIn(theirLineupB, pl.id);
    pl.slotAfter = mineNow ? slotIn(theirLineupA, pl.id) : slotIn(out.lineup.after, pl.id);
    const mySlot = mineNow ? pl.slotBefore : pl.slotAfter;
    const g = groupOf(p, mySlot === 'BN' ? null : mySlot);
    pl.fit = { group: g, tierBefore: fit.before.groups[g] ? fit.before.groups[g].tier : null, tierAfter: fit.after.groups[g] ? fit.after.groups[g].tier : null };
    pl.why = s ? playerWhy(pl, s, p, { weeks, horizon: out.options.horizon, profile: st.profile, mySlot, cw }) : [];
  }

  // ---- Plain-English summary (≤ 4 sentences).
  const who = partnerEstimated ? 'a typical partner' : 'them';
  const take = { likely: 'they should accept', maybe: 'they might accept', unlikely: 'they will probably say no' }[out.them.likely];
  const verdictLine = out.verdict ? `${sgn(out.you.perWeek)} pts/wk for you · ${sgn(out.them.perWeek)} for ${who} (${take}).` : null;
  const valueLine = (give.length || get.length) ? `Value: ${label.toLowerCase()} (you give ${fmt1(assetOut)}, get ${fmt1(assetIn)} in season value).` : null;
  const lower = n => (/^[A-Z][a-z]/.test(n) ? n.charAt(0).toLowerCase() + n.slice(1) : n);
  const fitLine = fit.notes.length ? `Fit: ${fit.notes.slice(0, 3).map(lower).join('; ')}.` : null;
  const notes = [];
  if (sig.source === 'interim') notes.push('Injury return dates are model estimates until the ESPN feed is wired in.');
  if (value.marketWeight > 0 && touched.some(p => { const x = S.get(String(p.id)); return x && x.market && x.market.rank != null; })) notes.push(`Value blends in the preseason market at ${Math.round(value.marketWeight * 100)}% (fades to 0 by week 11).`);
  const stale = touched.map(p => S.get(String(p.id))).filter(x => x && x.flags && x.flags.includes('stale-stats'));
  if (stale.length) notes.push(`Form and minutes come from ${seasonLabel(stale[0].statSeason) || 'last season'} until this season's games are logged.`);
  const summary = { headline: out.headline, verdictLine, valueLine, fitLine, notes };

  const asOf = c.asOf || {};
  const logsSeason = Array.isArray(c.logs) && c.logs.length ? Math.max(...c.logs.map(l => Number(l.season)).filter(Number.isFinite)) : null;
  const dataAsOf = { board: asOf.board || null, market: asOf.market || (c.market && (c.market.builtAt || c.market.asOf)) || null, injuryEta: asOf.injuryEta || (c.eta && c.eta.fetchedAt) || null, logsSeason: Number.isFinite(logsSeason) ? logsSeason : null, signals: sig.source };
  return { value, fit, themFit, summary, dataAsOf };
}

// Team-fit notes for one side: holes filled/opened, tier changes in the groups the trade
// touches, bench depth. Short clauses; the first three make the summary's fit line.
function fitNotes({ fb, fa, deltaByGroup, lineupB, lineupA, touchedGroups, who }) {
  const your = who === 'you' ? 'your' : 'their';
  const notes = [];
  const rowsB = (lineupB && lineupB.starters) || [], rowsA = (lineupA && lineupA.starters) || [];
  rowsB.forEach((b, i) => {
    const x = rowsA[i];
    if (!x) return;
    const slot = String(b.slot).replace(/\d+$/, '');
    if (!b.id && x.id) notes.push(`Fills ${your} ${slot} hole (waiver add ${fmt1(b.value)} → ${x.name} ${fmt1(x.value)})`);
    else if (b.id && !x.id) notes.push(`Opens a hole at ${slot} (${b.name} ${fmt1(b.value)} → waiver add ${fmt1(x.value)})`);
  });
  for (const g of ['C', 'G', 'F']) {
    const d = deltaByGroup[g];
    if (!d) continue;
    const name = GROUP_LABEL[g];
    const slots = `${d.rosteredAfter} eligible for ${d.slots} slot${d.slots === 1 ? '' : 's'}`;
    if (d.tierBefore !== d.tierAfter) {
      const worse = TIER_RANK[d.tierAfter] < TIER_RANK[d.tierBefore];
      const needNow = RA.tierStatus(d.tierAfter) === 'need';
      if (worse && needNow) notes.push(d.tierAfter === 'thin' ? `Leaves ${g} thin: ${slots}` : `Leaves ${g} ${d.tierAfter === 'critical' ? 'critical' : 'needing an upgrade'}: ${slots}`);
      else if (!worse && RA.tierStatus(d.tierBefore) === 'need') notes.push(`Fixes ${your} ${name} need (${d.tierBefore} → ${d.tierAfter})`);
      else notes.push(`${g} goes ${d.tierBefore} → ${d.tierAfter}`);
    } else if (touchedGroups.has(g)) {
      notes.push(d.tierAfter === 'upgrade' ? `${g} still needs an upgrade` : d.tierAfter === 'critical' ? `${g} is still critical` : `${g} stays ${d.tierAfter}`);
    }
  }
  const nb = fb.lineup.bench.length, na = fa.lineup.bench.length;
  if (na < nb) notes.push(`Bench thinner by ${nb - na === 1 ? 'one' : nb - na}`);
  else if (na > nb) notes.push(`Deeper bench (+${na - nb})`);
  return notes;
}

// Per-player "why" from his signals (spec §4.1 / §4.5): numbers are pts/wk, ETA as
// "~wk N (Mon D)", last season's stats tagged with the season. Every line maps to a
// signals field or flag; nothing is invented on the page.
function playerWhy(pl, s, p, { weeks, horizon, profile, mySlot, cw }) {
  const out = [];
  const n = weeks.length || 1;
  const tag = s.statSeason != null && (s.flags || []).includes('stale-stats') ? ` (${seasonLabel(s.statSeason)})` : '';
  const per = num(s.schedule && s.schedule.gamesRemaining) / n;
  out.push(`${fmt1(s.value.ros)}/wk ${HORIZON_TEXT[horizon] || HORIZON_TEXT.ros} · ${fmt1(per)} games/wk`);
  const forYou = num(pl.forYou);
  if (pl.side === 'get') {
    if (mySlot && mySlot !== 'BN') out.push(`Starts at ${String(mySlot).replace(/\d+$/, '')} for you: ${sgn(forYou)}/wk to your lineup`);
    else if (!pl.outForSeason) out.push(`Bench for you: ${sgn(forYou)}/wk (depth only)`);
  } else if (mySlot && mySlot !== 'BN') out.push(`Starts at ${String(mySlot).replace(/\d+$/, '')} for you now: losing him costs ${fmt1(Math.abs(forYou))}/wk`);
  else if (mySlot === 'BN') out.push(`On your bench now: losing him costs ${fmt1(Math.abs(forYou))}/wk`);
  const weekStart = w => { const pw = (profile.weeks || []).find(x => x.week === w); return pw ? monDay(pw.start) : null; };
  for (const f of s.flags || []) {
    const m = /^out-until-wk(\d+)$/.exec(f);
    if (m) {
      const wk = Number(m[1]);
      const eta = s.availability && s.availability.eta;
      const back = weeks.filter(w => w.week >= wk).map(w => num((p.hsByWeek || {})[w.week]));
      const backVal = back.length ? back.reduce((a, b) => a + b, 0) / back.length : null;
      const outWeeks = Math.max(0, wk - cw);
      const date = eta && eta.returnDate ? monDay(eta.returnDate) : weekStart(wk);
      const src = eta ? `ESPN: ${[eta.bodyPart, eta.detail].filter(Boolean).join(' ').toLowerCase() || 'injury'}` : 'model estimate';
      out.push(`Out until ~wk ${wk}${date ? ` (${date})` : ''}, ${src}: ~0 for ${outWeeks} week${outWeeks === 1 ? '' : 's'}${backVal != null ? `, ${fmt1(backVal)}/wk after` : ''}`);
      continue;
    }
    if (f === 'ofs') out.push('Out for the season: worth 0 the rest of the way');
    else if (f === 'hot' || f === 'cold') { const fm = s.form || {}; out.push(`${f === 'hot' ? 'Hot' : 'Cold'}: ${fmt1(fm.last5)} over the last 5 vs ${fmt1(fm.seasonMean)} season${tag}`); }
    else if (f === 'minutes-up' || f === 'minutes-down') { const mn = s.minutes || {}; out.push(`Minutes ${f === 'minutes-up' ? 'up' : 'down'}: ${fmt1(mn.last5)} a game over the last 5 vs ${fmt1(mn.mpg)} season${tag}`); }
    else if (f === 'heavy-schedule') out.push(`Heavy schedule: 4-game weeks in ${s.schedule.heavyWeeks} of ${n}`);
    else if (f === 'light-schedule') out.push(`Light schedule: ${s.schedule.lightWeeks} of ${n} weeks with 2 games or fewer`);
    else if ((f === 'market-reach' || f === 'market-value') && s.market && s.market.rank != null) {
      const ranks = `market #${s.market.rank}${s.value.rank != null ? `, model #${s.value.rank}` : ''}`;
      if (f === 'market-reach') out.push(pl.side === 'get' ? `The market rates him above the model (${ranks}): you'd be paying the market's price` : `The market rates him above the model (${ranks}): you're selling high`);
      else out.push(pl.side === 'get' ? `The model rates him above the market (${ranks}): you're buying low` : `The model rates him above the market (${ranks}): you'd be selling low`);
    }
    else if (f === 'rookie') out.push('Rookie: no NBA games yet, so his value is projection only');
    else if (f === 'new-team') out.push('New team this season: last year\'s role may not carry over');
    else if (f === 'thin-sample') out.push(s.sampleGames > 0 ? `Thin sample: ${s.sampleGames} games logged, so his range is wider` : 'No games logged last season: his value is projection-based, so the range is wider');
    else if (f === 'stale-stats' && s.statSeason != null) out.push(`Stats from ${seasonLabel(s.statSeason)}${s.form && s.form.lastGameDate ? ` (last game ${monDay(s.form.lastGameDate)})` : ''}`);
  }
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

module.exports = {
  evaluateTrade, verdictFor, bestLineup, replacementLevel, scheduleWeeks, normSettings, normOptions, estimatePartner, uncertainty, createEvaluator, tradeRules, playerWhy, fitNotes,
  BENCH_SHARE, REPL_RANK, FAIR_BAND, COUNTER_BANDS, HORIZONS, LEANS, PLAYOFFS_HORIZON_FROM_WEEK, VALUE_POWER, VALUE_FLOOR_ABOVE, VALUE_BANDS,
};
