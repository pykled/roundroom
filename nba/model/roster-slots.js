// Profile-driven starting-lineup assignment shared by the lineup picker, trade
// evaluator and waiver engine (stream L1). Every slot count comes from the
// league profile (nba/league-profile.js); nothing here assumes 6 starters.
//
//   slotList(profile)            → ['PG','SG','G','SF','PF','F','C','UTIL','UTIL'] (242808)
//   eligFor(player, profile)     → Set of the profile's starting slots the player can fill
//   bestAssignment(items, slots, opts) → { total, slotOf: Map(id → slot), starters:[{id,slot}] }
//   benchShares(profile, base)   → per-bench-rank depth shares, scaled by starters
//   activeSpots / ilSlots / ilEligible / weekWindow / gameDaysIn
//
// Eligibility follows the Yahoo legend in nba/model/slots.js (C-only is NOT
// F-eligible; G/F fills SG, G, SF, F; UTIL takes anyone). Yahoo positions
// (`yahooElig`, computed by the model for the profile) win; without them the
// player's positions are mapped through the same legend, plus the legacy
// High Score groups (elig 'G' → G, 'F' → F/FC) for boards built without a profile.
'use strict';
const Slots = require('./slots');
const LP = require('../league-profile');

const NON_STARTING = new Set(['BN', 'IL', 'IR']);

function resolveProfile(profile) {
  if (profile && typeof profile === 'object') return profile;
  if (profile != null && profile !== '') return LP.getProfile(profile) || LP.highScoreDefaultProfile();
  return LP.defaultProfile();
}

// Starting slots, one entry per slot unit, in Yahoo display order.
function slotList(profile) {
  const s = (resolveProfile(profile).slots) || {};
  const out = [];
  for (const k of Slots.SLOT_ORDER) if (!NON_STARTING.has(k)) for (let i = 0; i < (s[k] || 0); i++) out.push(k);
  return out;
}
const starterCount = profile => slotList(profile).length;
// Starters + bench: the roster spots an IL player does not use.
function activeSpots(profile) {
  const p = resolveProfile(profile);
  return starterCount(p) + ((p.slots && p.slots.BN) || 0);
}
const ilSlots = profile => ((resolveProfile(profile).slots || {}).IL) || 0;

function eligFor(p, profile) {
  const prof = resolveProfile(profile);
  const have = new Set(slotList(prof));
  const out = new Set();
  if (Array.isArray(p && p.yahooElig) && p.yahooElig.length) {
    for (const s of p.yahooElig) out.add(String(s).toUpperCase());
  } else {
    for (const s of Slots.slotsForPositions((p && (p.yahooPos || p.pos)) || [])) out.add(s);
    const legacy = Array.isArray(p && p.elig) ? p.elig : [];
    if (legacy.includes('G')) out.add('G');
    if (legacy.includes('F')) { out.add('F'); out.add('FC'); }
  }
  out.add('UTIL');
  return new Set([...out].filter(s => have.has(s)));
}

// Yahoo selected_position → this profile's slot name (or BN / IL).
function slotOf(pos, profile) {
  const u = String(pos || '').trim().toUpperCase();
  if (!u || u === 'BN' || u === 'BENCH') return 'BN';
  if (u.startsWith('IL') || u === 'IR') return 'IL';
  if (u === 'UT' || u === 'UTIL' || u === 'FLEX') return 'UTIL';
  const have = new Set(slotList(profile));
  if (have.has(u)) return u;
  // Older clients / other leagues used group names; fold into what the league has.
  if (['PG', 'SG', 'G'].includes(u) && have.has('G')) return 'G';
  if (['SF', 'PF', 'F', 'C', 'FC'].includes(u)) {
    if (have.has('FC')) return 'FC';
    if (have.has('F')) return 'F';
  }
  return 'BN';
}

// Optimal starters: the starting slots form a transversal matroid over the
// players (a set is feasible iff it can be matched to distinct eligible slot
// units) and a player's value doesn't depend on the slot he takes, so adding
// players in descending value whenever the set stays matchable is exact.
// items: [{ id, v, elig: Set|array, pin?: slot, must?: bool, prefer?: slot }]
//   pin    fixed in that exact slot (locked / unprojected current starter)
//   must   has to start (any eligible slot)
//   prefer try this slot first (keeps current starters where they are)
// Returns null when the pins/musts can't all be placed.
function bestAssignment(items, slots, { minValue = 0 } = {}) {
  const units = slots.slice();
  const holder = new Array(units.length).fill(-1); // unit → item index
  const fixed = new Array(units.length).fill(false);
  const list = items.map((it, i) => ({ ...it, i, el: it.elig instanceof Set ? it.elig : new Set(it.elig || []) }));
  const slotOf = new Map();
  let total = 0;
  for (const it of list) {
    if (!it.pin) continue;
    const u = units.findIndex((s, k) => s === it.pin && holder[k] < 0);
    if (u < 0) return null;
    holder[u] = it.i; fixed[u] = true; total += it.v; slotOf.set(it.id, it.pin);
  }
  // Display order: the player's current slot first, UTIL last, so the flex
  // slots go to whoever is left once position slots are filled.
  const unitOrder = it => {
    const rank = k => (units[k] === it.prefer ? 0 : units[k] === 'UTIL' ? 2 : 1);
    return units.map((_, k) => k).filter(k => it.el.has(units[k])).sort((a, b) => rank(a) - rank(b) || a - b);
  };
  const byIdx = new Map(list.map(it => [it.i, it]));
  // Free unit first; only then re-route someone (augmenting path).
  function augment(it, seen) {
    const ks = unitOrder(it);
    for (const k of ks) if (!seen[k] && !fixed[k] && holder[k] < 0) { seen[k] = true; holder[k] = it.i; return true; }
    for (const k of ks) {
      if (seen[k] || fixed[k]) continue;
      seen[k] = true;
      if (augment(byIdx.get(holder[k]), seen)) { holder[k] = it.i; return true; }
    }
    return false;
  }
  const cmp = (a, b) => b.v - a.v || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const musts = list.filter(it => !it.pin && it.must).sort(cmp);
  const rest = list.filter(it => !it.pin && !it.must && it.v > minValue).sort(cmp);
  for (const it of musts) {
    if (!augment(it, new Array(units.length).fill(false))) return null;
    total += it.v;
  }
  for (const it of rest) {
    if (!holder.includes(-1)) break;
    if (augment(it, new Array(units.length).fill(false))) total += it.v;
  }
  for (let k = 0; k < units.length; k++) if (holder[k] >= 0) slotOf.set(byIdx.get(holder[k]).id, units[k]);
  const starters = [];
  for (let k = 0; k < units.length; k++) if (holder[k] >= 0) starters.push({ id: byIdx.get(holder[k]).id, slot: units[k] });
  return { total, slotOf, starters };
}

// Exhaustive reference for tests (small rosters only).
function bruteAssignment(items, slots) {
  let best = 0;
  const n = items.length;
  const els = items.map(it => (it.elig instanceof Set ? it.elig : new Set(it.elig || [])));
  for (let mask = 0; mask < 1 << n; mask++) {
    let v = 0, cnt = 0;
    for (let i = 0; i < n; i++) if (mask >> i & 1) { v += items[i].v; cnt++; }
    if (cnt > slots.length || v <= best) continue;
    const holder = new Array(slots.length).fill(-1);
    const aug = (i, seen) => {
      for (let k = 0; k < slots.length; k++) {
        if (seen[k] || !els[i].has(slots[k])) continue;
        seen[k] = true;
        if (holder[k] < 0 || aug(holder[k], seen)) { holder[k] = i; return true; }
      }
      return false;
    };
    let ok = true;
    for (let i = 0; i < n && ok; i++) if (mask >> i & 1) ok = aug(i, new Array(slots.length).fill(false));
    if (ok) best = v;
  }
  return best;
}

// Bench depth shares by bench rank. Lineups are daily, so the bench covers
// starters who miss games; more starters means more absences to cover each
// week, so the High Score curve (tuned for 6 starters) scales with starters/6.
// Only as many shares as the profile has bench spots.
const DEPTH_BASE = [0.12, 0.07, 0.04, 0.02, 0.01, 0.005, 0.0025];
function benchShares(profile, base = DEPTH_BASE) {
  const p = resolveProfile(profile);
  const bn = (p.slots && p.slots.BN) || 0;
  const scale = starterCount(p) / 6;
  return base.slice(0, Math.max(0, bn)).map(x => Math.min(0.5, x * scale));
}

// Yahoo's IL slot takes players listed Out / on the NBA injured list (not
// day-to-day). Our injury strings come from Sleeper: Out, IR, DTD, GTD, SUS.
const IL_RE = /^(OUT|O|IR|IL|INJ|NA|OFS)$/i;
const ilEligible = p => !!(p && (p.outForSeason || IL_RE.test(String(p.injury || '').trim())));

const DAY_MS = 86400000;
const dayNum = s => Math.floor(Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') / DAY_MS);
// Matchup-week window from the profile: { week, start, end, days, playoffs }.
function weekWindow(profile, week) {
  const w = (resolveProfile(profile).weeks || []).find(x => Number(x.week) === Number(week));
  return w ? { ...w, startDay: dayNum(w.start), endDay: dayNum(w.end) } : null;
}
// Matchup week containing an ET date string (YYYY-MM-DD); before week 1 → 1, after → last.
function weekForDate(profile, date) {
  const weeks = resolveProfile(profile).weeks || [];
  if (!weeks.length) return null;
  const d = dayNum(date);
  for (const w of weeks) if (d >= dayNum(w.start) && d <= dayNum(w.end)) return w.week;
  return d < dayNum(weeks[0].start) ? weeks[0].week : weeks[weeks.length - 1].week;
}
// Game day indices (0 = first day of the window) for a team's epoch-day list.
function gameDaysIn(teamDays, win) {
  if (!Array.isArray(teamDays) || !win) return null;
  return [...new Set(teamDays.filter(d => d >= win.startDay && d <= win.endDay).map(d => d - win.startDay))].sort((a, b) => a - b);
}

module.exports = {
  resolveProfile, slotList, starterCount, activeSpots, ilSlots, eligFor, slotOf,
  bestAssignment, bruteAssignment, benchShares, DEPTH_BASE, ilEligible, IL_RE,
  weekWindow, weekForDate, gameDaysIn, dayNum,
};
