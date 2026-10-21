// Shared layer (Stream A): one roster's lineup, slot-group tiers, needs and
// surplus. Used by the trade calculator (fit before/after) and the team page
// (per-team rows). Contract: docs/nba-trade-team-spec.md §3.4.
// Example output: docs/nba-spec/fixtures/roster-analysis.example.json.
//
//   analyzeRoster({ players, profile, weeks, replacement, leagueAvg?, strongCutoff?, eta?, currentWeek?, cap? }) → RosterAnalysis
//   weekValue(players, profile, week, replacement, opts?) → { total, starters, bench, holes }
//
// weekValue is the trade engine's week value (nba/model/trade.js createEvaluator
// weekValue) verbatim: best lineup over the profile's starting slots, open roster
// spots filled at replacement, a starting slot nobody can fill = a waiver add
// that costs the worst bench player, plus bench shares above replacement. So
// team strength and trade deltas agree by construction (test-nba-shared.js
// checks them week by week).
//
// Groups (slot groups, not positions): G = PG+SG+G slots (PG/SG-eligible players),
// F = SF+PF+F (SF/PF-eligible), C = C, UTIL = depth. PG/SG/SF/PF are display-only
// single slots by primary position. Tier matrix is the NFL one (shared/analysis.js):
// depth (rostered ≤ slots → need, ≥ 2× → surplus) × quality (starterValue vs league
// avg; strong = top 30%) → critical / upgrade / thin / solid / deep / loaded.
// UTIL takes anyone, so it is never a positional need or surplus: its tier is
// always solid (its league rank still says how good the flex starters are); the
// G/F/C tiers carry the actual needs. The PG/SG/SF/PF display groups are single
// slots, so headcount says nothing about their depth: their tier is quality-only
// (upgrade when below the league average, else solid).
'use strict';
const R = require('./roster-slots');
const ETA = require('./injury-eta');

const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';

const GROUPS = ['G', 'F', 'C', 'UTIL'];
const DISPLAY_GROUPS = ['PG', 'SG', 'SF', 'PF'];
const GROUP_SLOTS = { G: ['PG', 'SG', 'G'], F: ['SF', 'PF', 'F'], C: ['C'], UTIL: ['UTIL'] };
const GROUP_ELIG = { G: ['PG', 'SG'], F: ['SF', 'PF'], C: ['C'], UTIL: null };
const TIERS = ['critical', 'upgrade', 'thin', 'solid', 'deep', 'loaded'];
const STRONG_SHARE = 0.30;
const ELITE_VALUE = 45;             // pts/wk, or top-24 on the board
const ELITE_RANK = 24;
const LIABILITY_MARGIN = 3;         // starter within this many pts/wk of replacement
// Same multipliers the NFL Roster Fit uses (trade.html NEED_MULT); the NBA trade
// calculator shows them as context on the fit panel, it does not re-multiply values.
const NEED_MULT = { critical: 1.30, upgrade: 1.15, thin: 1.10, solid: 1.00, deep: 0.90, loaded: 0.80 };

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const fin = v => typeof v === 'number' && Number.isFinite(v);
const r1 = x => Math.round(num(x) * 10) / 10;
const byIdCmp = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Collapse a tier to need / neutral / surplus (partner matching vocabulary).
function tierStatus(tier) {
  if (tier === 'critical' || tier === 'upgrade' || tier === 'thin') return 'need';
  if (tier === 'deep' || tier === 'loaded') return 'surplus';
  return 'neutral';
}

// NFL matrix, verbatim (shared/analysis.js assessDepthAndQuality).
function assessTier(rostered, slots, starterValue, leagueAvg, strongCutoff) {
  if (!slots || slots <= 0) return 'solid';
  const depth = rostered <= slots ? 'need' : rostered >= slots * 2 ? 'surplus' : 'neutral';
  const v = Number.isFinite(starterValue) ? starterValue : 0;
  const weak = Number.isFinite(leagueAvg) && v < leagueAvg;
  const strong = !weak && Number.isFinite(strongCutoff) && v >= strongCutoff;
  if (depth === 'need') return weak ? 'critical' : 'thin';
  if (depth === 'surplus') return weak ? 'upgrade' : (strong ? 'loaded' : 'deep');
  return weak ? 'upgrade' : 'solid';
}
// Display groups: depth is neutral by definition (see header).
function qualityTier(slots, starterValue, leagueAvg) {
  if (!slots || slots <= 0) return 'solid';
  return Number.isFinite(leagueAvg) && num(starterValue) < leagueAvg ? 'upgrade' : 'solid';
}

// replacement: { perWeek: { w: v } } (trade.js replacementLevel), a { w: v } map, or a number.
function replacementAt(replacement, week, fallback = 0) {
  if (fin(replacement)) return replacement;
  if (!replacement || typeof replacement !== 'object') return fallback;
  const pw = replacement.perWeek && typeof replacement.perWeek === 'object' ? replacement.perWeek : replacement;
  return fin(pw[week]) ? pw[week] : fallback;
}

// One week's team value (trade.js weekValue). players: board Player[]; opts:
// { cap (roster cap; default active spots), valueFn(p, week), keepSlots }.
function weekValue(players, profile, week, replacement, opts = {}) {
  const prof = R.resolveProfile(profile);
  const slots = R.slotList(prof);
  const ALL = new Set(slots);
  const shares = R.benchShares(prof);
  const rv = replacementAt(replacement, week, fin(opts.replacementFallback) ? opts.replacementFallback : 0);
  const valueOf = Object.prototype.hasOwnProperty.call(opts, 'valueFn') && typeof opts.valueFn === 'function' ? opts.valueFn : (p, w) => num((p.hsByWeek || {})[w]);
  const roster = (players || []).filter(Boolean);
  const cap = fin(opts.cap) ? opts.cap : R.activeSpots(prof);
  const items = roster.map(p => ({ id: p.id, elig: R.eligFor(p, prof), v: valueOf(p, week) }));
  const open = Math.max(0, cap - roster.length);
  for (let i = 0; i < Math.min(open, slots.length); i++) items.push({ id: `~repl${i}`, elig: ALL, v: rv });
  // Trade v2 stream rule: one waiver add per player who has to sit, so a slot only playable below waiver level is streamed.
  const spare = Math.min(slots.length, Math.max(0, roster.length - slots.length));
  for (let i = 0; i < spare; i++) items.push({ id: `~swap${i}`, elig: ALL, v: rv });
  items.sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
  const lu = R.bestAssignment(items, slots);
  const bench = items.filter(it => !lu.slotOf.has(it.id) && !String(it.id).startsWith('~'));
  let swaps = 0;
  for (const id of lu.slotOf.keys()) if (String(id).startsWith('~swap')) swaps++;
  // A starting slot nobody on a full roster can fill: drop the worst bench player for a waiver add.
  const holes = Math.min(slots.length - lu.slotOf.size, Math.max(0, bench.length - swaps));
  const holeFill = holes > 0 ? holes * rv : 0;
  let benchVal = 0;
  bench.slice(0, Math.max(0, bench.length - swaps - holes)).forEach((it, i) => { if (i < shares.length) benchVal += shares[i] * Math.max(0, it.v - rv); });
  const out = { total: lu.total + holeFill + benchVal, starters: lu.total + holeFill, bench: benchVal, holes: holes + swaps };
  if (opts.keepSlots) out.slotOf = lu.slotOf;
  return out;
}

const positionsOf = p => (Array.isArray(p.yahooPos) && p.yahooPos.length ? p.yahooPos : Array.isArray(p.pos) ? p.pos : []).map(x => String(x).toUpperCase());
function inGroup(p, g) {
  if (g === 'UTIL') return true;
  const pos = positionsOf(p);
  return GROUP_ELIG[g].some(x => pos.includes(x)) || (g !== 'C' && pos.includes(g));
}
// Healthy depth: not out for the season, not an IL-type status (Out / IR / …).
const healthy = p => !p.outForSeason && !R.ilEligible(p);
const slotRank = s => { const i = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'FC', 'UTIL'].indexOf(s); return i < 0 ? 99 : i; };

function normWeeks(weeks, profile, currentWeek) {
  if (Array.isArray(weeks) && weeks.length) {
    return weeks.map(w => (fin(w) ? { week: w, weight: 1, playoff: false } : { week: Number(w.week), weight: fin(w.weight) ? w.weight : 1, playoff: !!w.playoff }))
      .filter(w => Number.isInteger(w.week));
  }
  const cw = Number(currentWeek) || 1;
  return ((profile && profile.weeks) || []).filter(w => w.week >= cw).map(w => ({ week: w.week, weight: 1, playoff: !!w.playoffs }));
}

function etaOf(p, etaDoc, profile) {
  const e = p.eta || (etaDoc ? ETA.matchEta(etaDoc, p, { weeks: profile.weeks }) : null);
  if (!e) return null;
  return { status: e.status, returnDate: e.returnDate || null, returnWeek: e.returnWeek ?? null, bodyPart: e.bodyPart || null, detail: e.detail || null, source: 'espn', asOf: e.asOf || null, stale: !!e.stale };
}

function analyzeRoster({ players, profile, weeks, replacement = null, leagueAvg = null, strongCutoff = null, eta = null, currentWeek = null, cap = null } = {}) {
  const prof = R.resolveProfile(profile);
  const roster = (players || []).filter(Boolean).slice().sort(byIdCmp);
  const wk = normWeeks(weeks, prof, currentWeek);
  const wSum = wk.reduce((s, w) => s + w.weight, 0) || 1;
  const cw = currentWeek != null && Number.isFinite(Number(currentWeek)) ? Number(currentWeek) : (wk[0] ? wk[0].week : 1);
  const ros = p => wk.reduce((s, w) => s + w.weight * num((p.hsByWeek || {})[w.week]), 0) / wSum;
  const rvAvg = wk.reduce((s, w) => s + w.weight * replacementAt(replacement, w.week), 0) / wSum;
  const slots = R.slotList(prof);
  const shares = R.benchShares(prof);
  const capN = fin(cap) ? cap : R.activeSpots(prof);
  const avgMap = m => (m && typeof m === 'object' ? m : {});
  const LA = avgMap(leagueAvg), SC = avgMap(strongCutoff);

  // Typical lineup of the players on the roster, on rest-of-horizon values.
  // Open roster spots don't displace anyone here (lineup.openSpots reports
  // them; a starter below replacement shows up in liabilities); the strength
  // numbers below price them exactly like the trade engine does.
  const value = new Map(roster.map(p => [p.id, ros(p)]));
  const items = roster.map(p => ({ id: p.id, elig: R.eligFor(p, prof), v: value.get(p.id) }))
    .sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
  const lu = R.bestAssignment(items, slots);
  const byId = new Map(roster.map(p => [p.id, p]));
  const starters = lu.starters
    .map(s => ({ id: s.id, name: byId.get(s.id).name, slot: s.slot, value: r1(value.get(s.id)) }))
    .sort((a, b) => slotRank(a.slot) - slotRank(b.slot) || b.value - a.value || (a.id < b.id ? -1 : 1));
  const openSpots = Math.max(0, capN - roster.length);
  const benchItems = items.filter(it => !lu.slotOf.has(it.id));
  // Starting slots no rostered player can fill: a waiver add (replacement
  // level) via an open spot, else by dropping the worst bench player, else empty.
  const filled = {};
  for (const s of lu.starters) filled[s.slot] = (filled[s.slot] || 0) + 1;
  const need = {};
  for (const s of slots) need[s] = (need[s] || 0) + 1;
  const open = [];
  let spotsLeft = openSpots, dropsLeft = benchItems.length;
  for (const s of Object.keys(need)) {
    for (let k = filled[s] || 0; k < need[s]; k++) {
      if (spotsLeft > 0) { spotsLeft--; open.push({ slot: s, value: r1(rvAvg), reason: 'open-spot' }); }
      else if (dropsLeft > 0) { dropsLeft--; open.push({ slot: s, value: r1(rvAvg), reason: 'no-eligible' }); }
      else open.push({ slot: s, value: 0, reason: 'empty' });
    }
  }
  const keep = dropsLeft;
  const bench = benchItems.map((it, i) => ({ id: it.id, name: byId.get(it.id).name, value: r1(it.v), share: i < keep && i < shares.length ? shares[i] : 0 }));
  const lineupTotal = starters.reduce((s, x) => s + x.value, 0) + open.reduce((s, x) => s + x.value, 0);
  const benchValue = benchItems.reduce((s, it, i) => s + (i < keep && i < shares.length ? shares[i] * Math.max(0, it.v - rvAvg) : 0), 0);

  // Exact week-by-week strength (the trade engine's weekValue).
  const opts = { cap: capN };
  const strengthRos = wk.reduce((s, w) => s + w.weight * weekValue(roster, prof, w.week, replacement, opts).total, 0) / wSum;
  const hasWeek = (prof.weeks || []).some(w => Number(w.week) === cw) || roster.some(p => p.hsByWeek && p.hsByWeek[cw] != null);
  const strengthNow = hasWeek ? weekValue(roster, prof, cw, replacement, { ...opts, replacementFallback: rvAvg }).total : null;

  // Groups.
  const starterIn = slotNames => starters.filter(s => slotNames.includes(s.slot)).reduce((a, s) => a + s.value, 0)
    + open.filter(o => slotNames.includes(o.slot)).reduce((a, o) => a + o.value, 0);
  const groups = {};
  for (const g of GROUPS) {
    const slotN = GROUP_SLOTS[g].reduce((a, s) => a + ((prof.slots || {})[s] || 0), 0);
    const rostered = roster.filter(p => healthy(p) && inGroup(p, g)).length;
    const starterValue = r1(starterIn(GROUP_SLOTS[g]));
    const nexts = bench.filter(b => inGroup(byId.get(b.id), g) && healthy(byId.get(b.id))).map(b => b.value);
    const la = fin(LA[g]) ? LA[g] : null;
    const tier = g === 'UTIL' ? 'solid' : assessTier(rostered, slotN, starterValue, la, fin(SC[g]) ? SC[g] : null);
    groups[g] = { slots: slotN, rostered, starterValue, nextUp: nexts.length ? Math.max(...nexts) : null, leagueAvg: la, rank: null, tier, status: tierStatus(tier) };
  }
  for (const g of DISPLAY_GROUPS) {
    const slotN = (prof.slots || {})[g] || 0;
    const rostered = roster.filter(p => healthy(p) && Array.isArray(p.pos) && String(p.pos[0] || '').toUpperCase() === g).length;
    const starterValue = r1(starterIn([g]));
    const la = fin(LA[g]) ? LA[g] : null;
    const tier = qualityTier(slotN, starterValue, la);
    groups[g] = { slots: slotN, rostered, starterValue, nextUp: null, leagueAvg: la, rank: null, tier, status: tierStatus(tier), displayOnly: true };
  }

  // Players to call out.
  const elite = starters.filter(s => s.value >= ELITE_VALUE || (fin(byId.get(s.id).rank) && byId.get(s.id).rank > 0 && byId.get(s.id).rank <= ELITE_RANK)).map(s => ({ id: s.id, name: s.name, value: s.value }));
  const liabilities = starters.filter(s => s.value < rvAvg + LIABILITY_MARGIN).map(s => ({ id: s.id, name: s.name, value: s.value, slot: s.slot }));
  const lostAt = (p, w) => (p.healthyByWeek && fin(p.healthyByWeek[w]) ? Math.max(0, p.healthyByWeek[w] - num((p.hsByWeek || {})[w])) : 0);
  const injured = roster.filter(p => p.injury || p.outForSeason || (p.eta && !p.eta.stale)).map(p => {
    const e = etaOf(p, eta, prof);
    return {
      id: p.id, name: p.name, status: p.outForSeason ? 'OFS' : (p.injury || (e && e.status) || null), eta: e && e.returnDate ? e : null,
      lostThisWeek: p.healthyByWeek ? r1(lostAt(p, cw)) : null,
    };
  });
  const injuryExposure = {
    thisWeek: r1(roster.reduce((s, p) => s + lostAt(p, cw), 0)),
    next2: r1(roster.reduce((s, p) => s + lostAt(p, cw) + lostAt(p, cw + 1), 0)),
  };
  const gamesThisWeek = hasWeek ? starters.reduce((s, x) => s + num((byId.get(x.id).gamesByWeek || {})[cw]), 0) : null;

  return {
    lineup: { total: r1(lineupTotal), starters, bench, holes: open.length, open, openSpots },
    strengthRos: r1(strengthRos), strengthNow: strengthNow == null ? null : r1(strengthNow),
    benchValue: r1(benchValue), replacement: r1(rvAvg),
    groups,
    needs: GROUPS.filter(g => groups[g].status === 'need'),
    surplus: GROUPS.filter(g => groups[g].status === 'surplus'),
    elite, liabilities, injured, injuryExposure, gamesThisWeek,
    currentWeek: cw, rosterSize: roster.length, cap: capN,
  };
}

module.exports = {
  analyzeRoster, weekValue, tierStatus, assessTier, qualityTier, replacementAt,
  GROUPS, DISPLAY_GROUPS, GROUP_SLOTS, GROUP_ELIG, TIERS, STRONG_SHARE, ELITE_VALUE, ELITE_RANK, LIABILITY_MARGIN, NEED_MULT, NOT_IMPLEMENTED,
};
