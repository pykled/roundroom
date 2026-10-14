// Pocket NBA — waiver / streaming engine (stream F). Pure and deterministic:
// same roster + pool + board → same output. Rules and method: docs/nba-waivers.md.
//
//   analyzeWaivers({ roster, pool, startWeek, horizon, weeks, roles, rosterSize, profile,
//                    ilIds?, midWeek?, waiverIds?, addsUsed?, priority?, priorityModel? })
//     roster / pool: model Player objects (nba/model getPlayers shape)
//     profile: league profile (object or id; default 242808) — slots, bench, IL,
//              teams, max adds per week, waiver rules
//     → { targets, pairs, dropCandidates, injuryReplacements, calendar, baseline, adds, priority, rules, ... }
//
// Value of a player in week w = hsByWeek[w] (B's E[best game] given that week's
// team games and availability). Value of a roster in week w = its best legal
// lineup over the profile's starting slots (242808: PG,SG,G,SF,PF,F,C,UTIL,UTIL).
// Everything here is a difference of best lineups, so a free agent only earns
// credit for the slot he would actually take.
'use strict';
const St = require('./stats');
const R = require('./roster-slots');

// Legacy High Score slot counts (kept for the exported bestLineup below).
const SLOTS = { G: 2, F: 3, UTIL: 1 };
const HORIZONS = [1, 2, 4];
const WEEK_DISCOUNT = 0.85;         // week k of the horizon weighs 0.85^k (news decays)
const INJURED = /^(OUT|O|IR|IL|INJ|SUS|DOUBTFUL|D)$/i;
const ROLE_RECENT = 5;              // last N played games
const ROLE_MIN_DELTA = 4;           // minutes/game up vs season baseline
const ROLE_MIN_RATIO = 1.12;
const ROLE_FRESH_DAYS = 21;         // older signals (e.g. last season) are shown as stale, no badge
const MAX_CANDIDATES = 80;          // free agents scored exactly (pool pre-cut by raw horizon value)
// Bench depth: only starters score, but the best bench players cover a starter
// who sits mid-week (lineups are daily). They earn a small share of their value
// so a 4-game bench streamer beats a 2-game one and ties don't collapse to 0.
// L1: the waiver engine now uses the shared bench curve (R.benchShares: 12/7/4/2/1%
// for 6 starters, scaled by starters/6, one share per bench spot), same as the
// trade evaluator. DEPTH_WEIGHTS is kept as the old two-spot export.
const DEPTH_WEIGHTS = [0.12, 0.06];
// Waiver-priority cost (continual rolling list: a successful claim sends you to
// the bottom). Holding priority p is worth the chance it lands the next
// breakout before anyone else does:
//   V(p) = breakouts × lift × D × (1 − rivalClaim)^(p − 1)
//   cost of a claim = V(p) − V(teams)   (after it you're last)
// breakouts = claim-worthy breakouts expected over the next ~2 weeks, lift =
// HS points/week such a player adds to your lineup, D = the horizon's discount
// sum (same units as netGain), rivalClaim = chance each team ahead of you puts
// in a claim for him. All tunable via opts.priorityModel; docs/nba-waivers.md.
const PRIORITY_MODEL = { breakouts: 1, lift: 6, rivalClaim: 0.35 };
// Never stream away a better long-term asset: a drop is only suggested when the
// added player's rest-of-season weekly value is within this many HS points of
// the dropped player's (or the dropped player is out for the season).
const KEEP_MARGIN = 4;

const num = x => (Number.isFinite(+x) ? +x : 0);
const r1 = x => Math.round(num(x) * 10) / 10;

function eligOf(p) {
  const e = Array.isArray(p && p.elig) ? p.elig : [];
  return { G: e.includes('G'), F: e.includes('F') };
}

// Best legal lineup value. items: [{ v, g, f, id }]. DP over (G used, F used,
// UTIL used); each player takes one slot he is eligible for or sits.
// Returns { total, starters: ids }.
function bestLineup(items) {
  const S = (SLOTS.G + 1) * (SLOTS.F + 1) * (SLOTS.UTIL + 1);
  const idx = (g, f, u) => (g * (SLOTS.F + 1) + f) * (SLOTS.UTIL + 1) + u;
  let dp = new Float64Array(S).fill(-Infinity);
  dp[0] = 0;
  const choice = [];
  // Order is irrelevant for optimality; fixed order keeps ties deterministic.
  const list = items.filter(it => it.v > 0).sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const it of list) {
    const next = Float64Array.from(dp);
    const ch = new Int8Array(S).fill(-1); // -1 sit, 0 G, 1 F, 2 UTIL (state reached by placing it)
    for (let g = 0; g <= SLOTS.G; g++) for (let f = 0; f <= SLOTS.F; f++) for (let u = 0; u <= SLOTS.UTIL; u++) {
      const cur = dp[idx(g, f, u)];
      if (cur === -Infinity) continue;
      const tryPut = (g2, f2, u2, c) => {
        const k = idx(g2, f2, u2);
        if (cur + it.v > next[k]) { next[k] = cur + it.v; ch[k] = c; }
      };
      if (it.g && g < SLOTS.G) tryPut(g + 1, f, u, 0);
      if (it.f && f < SLOTS.F) tryPut(g, f + 1, u, 1);
      if (u < SLOTS.UTIL) tryPut(g, f, u + 1, 2);
    }
    choice.push(ch);
    dp = next;
  }
  let best = 0, bk = 0;
  for (let k = 0; k < S; k++) if (dp[k] > best) { best = dp[k]; bk = k; }
  // Backtrack the starters.
  const starters = [];
  let k = bk;
  for (let i = list.length - 1; i >= 0; i--) {
    const c = choice[i][k];
    if (c < 0) continue;
    starters.push({ id: list[i].id, slot: c === 0 ? 'G' : c === 1 ? 'F' : 'UTIL' });
    let u = k % (SLOTS.UTIL + 1); let rest = (k - u) / (SLOTS.UTIL + 1);
    let f = rest % (SLOTS.F + 1); let g = (rest - f) / (SLOTS.F + 1);
    if (c === 0) g--; else if (c === 1) f--; else u--;
    k = idx(g, f, u);
  }
  return { total: best, starters: starters.reverse() };
}

// Rest-of-season value per week (B's hsByWeek averaged over weeks >= from).
function longRun(p, from) {
  const ws = Object.keys((p && p.hsByWeek) || {}).map(Number).filter(w => Number.isFinite(w) && w >= from);
  if (!ws.length) return 0;
  return ws.reduce((s, w) => s + weekValue(p, w), 0) / ws.length;
}
const protectedFrom = (d, add, from) => !d.outForSeason && longRun(add, from) < longRun(d, from) - KEEP_MARGIN;

const weekValue = (p, w) => Math.max(0, num(p && p.hsByWeek && p.hsByWeek[w]));
const weekGames = (p, w) => Math.max(0, num(p && p.gamesByWeek && p.gamesByWeek[w]));

// Lineup context for a profile: slot units + depth shares + per-player eligibility (cached).
function ctxFor(profile) {
  const prof = R.resolveProfile(profile);
  const elig = new WeakMap();
  return {
    profile: prof, slots: R.slotList(prof), depth: R.benchShares(prof),
    elig: p => { let e = elig.get(p); if (!e) { e = R.eligFor(p, prof); elig.set(p, e); } return e; },
  };
}
const DEFAULT_CTX = ctxFor();
function itemsFor(players, w, C = DEFAULT_CTX) {
  return players.map(p => ({ id: String(p.id), v: weekValue(p, w), elig: C.elig(p) }));
}
function lineupFor(players, w, C = DEFAULT_CTX) {
  const a = R.bestAssignment(itemsFor(players, w, C), C.slots);
  return { total: a.total, starters: a.starters };
}
// Week value of a roster = best lineup + depth credit for the top bench players.
function rosterWeekValue(players, w, C = DEFAULT_CTX) {
  const items = itemsFor(players, w, C);
  const lu = R.bestAssignment(items, C.slots);
  const on = new Set(lu.starters.map(s => s.id));
  const bench = items.filter(it => !on.has(it.id)).map(it => it.v).sort((a, b) => b - a);
  let depth = 0;
  C.depth.forEach((k, i) => { depth += k * (bench[i] || 0); });
  return lu.total + depth;
}
function horizonValue(players, weeks, C = DEFAULT_CTX) {
  let s = 0;
  weeks.forEach((w, i) => { s += Math.pow(WEEK_DISCOUNT, i) * rosterWeekValue(players, w, C); });
  return s;
}
function perWeek(players, weeks, C = DEFAULT_CTX) { return weeks.map(w => lineupFor(players, w, C).total); }

// Waiver-priority cost of a successful claim at position `pos` of `teams`
// (0 when unknown or already last). Monotone: better priority → higher cost.
function priorityCost(pos, teams, horizonWeeks, model = {}) {
  const m = { ...PRIORITY_MODEL, ...model };
  const T = Math.round(Number(teams)), p = Math.round(Number(pos));
  if (!(T >= 2) || !(p >= 1 && p <= T)) return 0;
  let D = 0;
  for (let i = 0; i < Math.max(1, horizonWeeks); i++) D += Math.pow(WEEK_DISCOUNT, i);
  const q = 1 - Math.min(0.95, Math.max(0, m.rivalClaim));
  const V = k => Math.max(0, m.breakouts) * Math.max(0, m.lift) * D * Math.pow(q, k - 1);
  return V(p) - V(T);
}

// Role change: last ROLE_RECENT played games' minutes vs the player's baseline
// over the same season. logs: [[epochDay, week, hs, minutes], ...] (B's format).
function roleSignal(games, asOfDay) {
  const g = (games || []).filter(x => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[3]))
    .slice().sort((a, b) => a[0] - b[0]);
  if (g.length < ROLE_RECENT + 3) return null;
  const recent = g.slice(-ROLE_RECENT);
  const lastDay = recent[recent.length - 1][0];
  // Season = games within 240 days of the last one (one NBA season).
  const season = g.filter(x => x[0] > lastDay - 240);
  const base = season.slice(0, -ROLE_RECENT);
  if (base.length < 3) return null;
  const avg = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
  const recentMin = avg(recent.map(x => x[3]));
  const seasonMin = avg(base.map(x => x[3]));
  const recentHs = avg(recent.map(x => x[2]));
  const seasonHs = avg(base.map(x => x[2]));
  const delta = recentMin - seasonMin;
  const up = delta >= ROLE_MIN_DELTA && recentMin >= ROLE_MIN_RATIO * seasonMin;
  const down = -delta >= ROLE_MIN_DELTA && seasonMin >= ROLE_MIN_RATIO * recentMin;
  const stale = asOfDay != null && asOfDay - lastDay > ROLE_FRESH_DAYS;
  return {
    recentMin: r1(recentMin), seasonMin: r1(seasonMin), deltaMin: r1(delta),
    recentHs: r1(recentHs), seasonHs: r1(seasonHs),
    trend: up ? 'up' : down ? 'down' : 'flat', roleUp: up && !stale, stale, lastGameDay: lastDay,
  };
}

// roles for a set of ids from B's loaded data ({ logs: [{season, players:{pid:{g}}}] }).
function roleSignalsFromData(data, ids, now = new Date()) {
  const asOfDay = Math.floor(now.getTime() / 86400000);
  const out = {};
  if (!data || !Array.isArray(data.logs)) return out;
  for (const id of ids) {
    const games = [];
    for (const f of data.logs) { const p = f && f.players && f.players[id]; if (p && Array.isArray(p.g)) for (const x of p.g) if (x[0] < asOfDay) games.push(x); }
    const s = roleSignal(games, asOfDay);
    if (s) out[id] = s;
  }
  return out;
}

// Healthy week value: what the player would be worth this week at his normal
// availability (used to size an injured starter's hole).
function healthyWeekValue(p, w) {
  const n = weekGames(p, w);
  if (!(n > 0) || !(num(p.mean) > 0)) return 0;
  const sd = Math.max(0, num(p.sd));
  const a = Math.min(0.98, Math.max(0.55, num(p.availability) || 0.85));
  return St.expectedMaxAvail(k => St.expectedMax({ mean: num(p.mean), sd }, k), Math.round(n), a);
}

// Mid-week: a free agent added now only gets his team's games that haven't been
// played yet. B gives E[best of n games]; rescale it to the r games left with the
// same normal-approx curve healthyWeekValue uses (ratio keeps B's calibration).
function remainingWeekValue(p, w, left) {
  const n = weekGames(p, w), v = weekValue(p, w);
  if (!(left < n)) return v;
  if (!(left > 0)) return 0;
  const sd = Math.max(0, num(p.sd)), mean = num(p.mean);
  const a = Math.min(0.98, Math.max(0.55, num(p.availability) || 0.85));
  const em = k => St.expectedMaxAvail(j => St.expectedMax({ mean, sd }, j), k, a);
  const full = em(Math.round(n));
  return full > 0 ? v * em(left) / full : v * left / n;
}
// Copy of a free agent whose week-`mw.week` games/value are only what's left.
function asMidWeekAdd(p, mw) {
  if (!mw || !p || !p.gamesByWeek) return p;
  const w = mw.week, n = weekGames(p, w);
  const left = Math.max(0, n - Math.max(0, num((mw.played || {})[p.team])));
  if (left >= n) return p;
  return { ...p, hsByWeek: { ...(p.hsByWeek || {}), [w]: remainingWeekValue(p, w, left) }, gamesByWeek: { ...p.gamesByWeek, [w]: left }, _fullGames: n };
}

function isInjured(p) {
  return !!(p && (p.outForSeason || INJURED.test(String(p.injury || '').trim())));
}

function rosterById0(roster, id) { return roster.find(p => String(p.id) === id) || {}; }

function briefOf(p, C = DEFAULT_CTX) {
  return { id: String(p.id), name: p.name || String(p.id), team: p.team || null, pos: p.yahooPos || p.pos || [], elig: [...C.elig(p)].filter(x => x !== 'UTIL'), injury: p.injury || null };
}

function analyzeWaivers(opts = {}) {
  const C = ctxFor(opts.profile);
  const prof = C.profile;
  const brief = p => briefOf(p, C);
  const horizon = HORIZONS.includes(Number(opts.horizon)) ? Number(opts.horizon) : 1;
  const allWeeks = (opts.weeks && opts.weeks.length ? opts.weeks : null) ||
    [...new Set([...(opts.roster || []), ...(opts.pool || [])].flatMap(p => Object.keys((p && p.gamesByWeek) || {})))].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const start = Number.isFinite(Number(opts.startWeek)) && Number(opts.startWeek) > 0 ? Number(opts.startWeek) : (allWeeks[0] || 1);
  const future = allWeeks.filter(w => w >= start);
  const weeks = (future.length ? future : [start]).slice(0, horizon);
  const calWeeks = (future.length ? future : [start]).slice(0, 3);
  const roles = opts.roles || {};
  const rosterIds = new Set();
  const roster = (opts.roster || []).filter(p => p && p.id != null && !rosterIds.has(String(p.id)) && rosterIds.add(String(p.id)));
  // Mid-week ({ week, played: {TEAM: games already played/locked} }): only applies
  // when the horizon starts in that week. Adds get the games left; roster players
  // keep their whole week (games they already played are banked).
  const mw = opts.midWeek && Number(opts.midWeek.week) === start ? { week: start, played: opts.midWeek.played || {}, playedToday: opts.midWeek.playedToday || null } : null;
  // Waiver players (status W) arrive after the waiver period (profile waivers.days;
  // 242808 = 1 day), so today's game is lost too: they count games after today.
  const waiverSet = new Set((opts.waiverIds || []).map(String));
  const poolIds = new Set();
  const pool = (opts.pool || []).filter(p => p && p.id != null && !rosterIds.has(String(p.id)) && !poolIds.has(String(p.id)) && poolIds.add(String(p.id)))
    .map(p => asMidWeekAdd(p, mw && waiverSet.has(String(p.id)) && mw.playedToday ? { ...mw, played: mw.playedToday } : mw));
  const banked = d => (mw && weekGames(d, start) > 0 ? Math.min(weekGames(d, start), Math.max(0, num(mw.played[d.team]))) : 0);
  const rosterSize = Number(opts.rosterSize) > 0 ? Number(opts.rosterSize) : R.activeSpots(prof);
  // Players in a Yahoo IL slot don't use a roster spot, and dropping one doesn't
  // free a spot for an add, so they're never the drop half of a swap. Without
  // Yahoo slots (manual mode), Out players fill the profile's IL slots first.
  const ilCap = R.ilSlots(prof);
  let ilIds = new Set((opts.ilIds || []).map(String));
  let ilAuto = false;
  if (!opts.ilIds && ilCap > 0) {
    ilIds = new Set(roster.filter(R.ilEligible).sort((a, b) => num(a.hsValue) - num(b.hsValue) || (String(a.id) < String(b.id) ? -1 : 1)).slice(0, ilCap).map(p => String(p.id)));
    ilAuto = ilIds.size > 0;
  }
  const openSpots = Math.max(0, rosterSize - roster.filter(p => !ilIds.has(String(p.id))).length);

  // Weekly add budget (profile maxAddsPerWeek; 242808 = 10, no season cap).
  const maxAdds = prof.maxAddsPerWeek == null ? null : Number(prof.maxAddsPerWeek);
  const used = Math.max(0, Math.round(num(opts.addsUsed)));
  const addsLeft = maxAdds == null ? null : Math.max(0, maxAdds - used);
  const adds = { max: maxAdds, used: opts.addsUsed == null ? null : used, left: addsLeft, known: opts.addsUsed != null, seasonMax: prof.maxAddsPerSeason ?? null };

  const base = horizonValue(roster, weeks, C);
  const basePer = perWeek(roster, weeks, C);
  const without = new Map(); // dropId → horizon value of roster minus that player
  for (const d of roster) without.set(String(d.id), horizonValue(roster.filter(p => p !== d), weeks, C));

  // Drop candidates: cheapest player to lose (lowest marginal value to my best lineups).
  const dropCandidates = roster.map(d => ({
    ...brief(d),
    dropCost: r1(base - without.get(String(d.id))),
    longRun: r1(longRun(d, start)),
    valueByWeek: weeks.map(w => r1(weekValue(d, w))),
    gamesByWeek: weeks.map(w => weekGames(d, w)),
  })).sort((a, b) => a.dropCost - b.dropCost || a.valueByWeek.reduce((s, x) => s + x, 0) - b.valueByWeek.reduce((s, x) => s + x, 0) || (a.id < b.id ? -1 : 1));

  // Swaps try drops cheapest-first, so equal-gain ties go to the cheapest drop
  // (and the result doesn't depend on roster order).
  // "The" drop candidate: cheapest player who isn't a keeper (a keeper's
  // rest-of-season value tops the best free agent's by more than KEEP_MARGIN).
  const bestFaLong = pool.reduce((m, p) => Math.max(m, longRun(p, start)), 0);
  for (const d of dropCandidates) {
    d.keeper = !rosterById0(roster, d.id).outForSeason && bestFaLong < d.longRun - KEEP_MARGIN;
    d.ilSlot = ilIds.has(d.id);
    d.bankedGames = banked(rosterById0(roster, d.id));
  }
  const rosterById = new Map(roster.map(p => [String(p.id), p]));
  const dropOrder = dropCandidates.filter(d => !d.ilSlot).map(d => rosterById.get(d.id));

  // Pre-cut the pool by raw horizon value (cheap), then score exactly.
  const raw = p => weeks.reduce((s, w, i) => s + Math.pow(WEEK_DISCOUNT, i) * weekValue(p, w), 0);
  const cands = pool.map(p => ({ p, raw: raw(p) })).filter(x => x.raw > 0)
    .sort((a, b) => b.raw - a.raw || num(b.p.ceiling) - num(a.p.ceiling) || (String(a.p.id) < String(b.p.id) ? -1 : 1))
    .slice(0, Math.max(1, Number(opts.maxCandidates) || MAX_CANDIDATES));

  // Waiver priority (continual rolling list). Unknown position → no cost.
  const teams = Number(prof.teams) || 0;
  const pos = Number(opts.priority);
  const pModel = { ...PRIORITY_MODEL, ...(opts.priorityModel || {}) };
  const rolling = !prof.waivers || /rolling/.test(String(prof.waivers.type || ''));
  const claimCost = rolling && pos >= 1 ? priorityCost(pos, teams, weeks.length, pModel) : 0;
  const priority = {
    position: pos >= 1 && pos <= teams ? pos : null, teams, cost: r1(claimCost), model: pModel, rolling,
    note: !(pos >= 1) ? 'Priority unknown: claims are shown without a priority cost.'
      : pos >= teams ? 'You are last in priority: claiming costs nothing extra.'
        : `Priority #${pos} of ${teams}: a successful claim drops you to #${teams}. Holding it is worth ~${r1(claimCost)} (the next breakout you could win first).`,
  };

  const targets = cands.map(({ p }) => {
    const id = String(p.id);
    const addGain = horizonValue([...roster, p], weeks, C) - base; // as if a roster spot were free
    let bestDrop = null, netGain = openSpots > 0 ? addGain : -Infinity;
    if (openSpots === 0) {
      for (const d of dropOrder) {
        const others = roster.filter(x => x !== d);
        if (protectedFrom(d, p, start)) continue;
        const net = horizonValue([...others, p], weeks, C) - base;
        if (net > netGain + 1e-9) { netGain = net; bestDrop = d; }
      }
    }
    if (!Number.isFinite(netGain)) netGain = 0;
    const onWaivers = waiverSet.has(id);
    const cost = onWaivers ? claimCost : 0;
    const claimNet = netGain - cost;
    const advice = addsLeft === 0 ? 'no-adds-left' : netGain <= 0.05 ? 'pass' : !onWaivers ? 'add' : claimNet > 0.05 ? 'claim' : 'save-priority';
    const role = roles[id] || null;
    const reasons = [];
    const g0 = weekGames(p, weeks[0]);
    if (g0 >= 4) reasons.push(`${g0} games in week ${weeks[0]}`);
    if (role && role.roleUp) reasons.push(`minutes up ${role.seasonMin}→${role.recentMin}`);
    if (num(p.ceiling) - num(p.mean) >= 20) reasons.push(`big ceiling ${r1(p.ceiling)}`);
    if (p.injury) reasons.push(`injury: ${p.injury}`);
    return {
      ...brief(p),
      gamesByWeek: weeks.map(w => weekGames(p, w)),
      calendarGames: calWeeks.map(w => weekGames(p, w)),
      valueByWeek: weeks.map(w => r1(weekValue(p, w))),
      addGain: r1(addGain),
      netGain: r1(netGain),
      onWaivers, status: onWaivers ? 'W' : 'FA', priorityCost: r1(cost), claimNet: r1(claimNet), advice,
      drop: bestDrop ? { id: String(bestDrop.id), name: bestDrop.name, bankedGames: banked(bestDrop) } : null,
      gamesLeft: mw ? weekGames(p, start) : null,
      gamesFull: mw ? (p._fullGames != null ? p._fullGames : weekGames(p, start)) : null,
      mean: r1(p.mean), sd: r1(p.sd), ceiling: r1(p.ceiling), floor: r1(p.floor),
      roleUp: !!(role && role.roleUp), role,
      source: p.source || null,
      reasons,
    };
  }).sort((a, b) => b.claimNet - a.claimNet || b.netGain - a.netGain || b.addGain - a.addGain || b.ceiling - a.ceiling || (a.id < b.id ? -1 : 1));

  // Stream plan for the coming week: best add/drop pairs, each player used once.
  const w0 = weeks[0];
  const pairs = [];
  if (roster.length && addsLeft !== 0) {
    const base0 = rosterWeekValue(roster, w0, C);
    const opts0 = [];
    for (const { p } of cands.slice(0, 40)) {
      for (const d of (openSpots > 0 ? [null] : dropOrder)) {
        if (d && protectedFrom(d, p, start)) continue;
        const set = d ? roster.filter(x => x !== d) : roster;
        const gain = rosterWeekValue([...set, p], w0, C) - base0 - (waiverSet.has(String(p.id)) ? priorityCost(pos, teams, 1, pModel) * (rolling && pos >= 1 ? 1 : 0) : 0);
        if (gain > 0.05) opts0.push({ p, d, gain });
      }
    }
    opts0.sort((a, b) => b.gain - a.gain || num(b.p.ceiling) - num(a.p.ceiling) || (String(a.p.id) < String(b.p.id) ? -1 : 1));
    const usedA = new Set(), usedD = new Set();
    for (const o of opts0) {
      const aid = String(o.p.id), did = o.d ? String(o.d.id) : null;
      if (usedA.has(aid) || (did && usedD.has(did))) continue;
      usedA.add(aid); if (did) usedD.add(did);
      pairs.push({
        week: w0, add: { ...brief(o.p), games: weekGames(o.p, w0), value: r1(weekValue(o.p, w0)), status: waiverSet.has(aid) ? 'W' : 'FA' },
        drop: o.d ? { ...brief(o.d), games: weekGames(o.d, w0), value: r1(weekValue(o.d, w0)), bankedGames: banked(o.d) } : null,
        netGain: r1(o.gain),
      });
      if (pairs.length >= Math.min(5, addsLeft == null ? 5 : addsLeft)) break;
    }
  }

  // Injury replacements: an injured rostered player whose hole is a starter-sized hole.
  const injuryReplacements = [];
  for (const inj of dropCandidates.map(d => rosterById.get(d.id)).filter(isInjured)) {
    const lost = weeks.reduce((s, w, i) => s + Math.pow(WEEK_DISCOUNT, i) * Math.max(0, healthyWeekValue(inj, w) - weekValue(inj, w)), 0);
    if (lost < 1) continue;
    // Who fills the hole: the best positive swaps (keeper-protected, so the
    // injured star is only dropped when he isn't worth holding) for an FA who
    // shares a G/F group with him.
    // Same slot family as the injured player (any shared non-UTIL slot).
    const ie = new Set([...C.elig(inj)].filter(x => x !== 'UTIL'));
    const reps = targets
      .filter(t => t.netGain > 0.05 && (!ie.size || t.elig.some(e => ie.has(e))))
      .slice(0, 3)
      .map(t => ({ ...brief(t), netGain: t.netGain, drop: t.drop, gamesByWeek: t.gamesByWeek }));
    injuryReplacements.push({
      injured: { ...brief(inj), outForSeason: !!inj.outForSeason },
      lostValue: r1(lost),
      replacements: reps,
    });
  }
  injuryReplacements.sort((a, b) => b.lostValue - a.lostValue || (a.injured.id < b.injured.id ? -1 : 1));

  // Streamer calendar: free agents on 4+ game weeks over the next 3 weeks.
  const calendar = calWeeks.map(w => ({
    week: w,
    fourGame: pool.filter(p => weekGames(p, w) >= 4 && weekValue(p, w) > 0)
      .sort((a, b) => weekValue(b, w) - weekValue(a, w) || (String(a.id) < String(b.id) ? -1 : 1))
      .slice(0, 8)
      .map(p => ({ ...brief(p), games: weekGames(p, w), value: r1(weekValue(p, w)) })),
  }));

  const lineup0 = lineupFor(roster, w0, C);
  const byId = new Map(roster.map(p => [String(p.id), p]));
  const order = new Map(C.slots.map((x, i) => [x, i]));
  lineup0.starters.sort((a, b) => order.get(a.slot) - order.get(b.slot));
  const wr = prof.waivers || {};
  const rules = {
    waiverType: wr.type || null, waiverDays: wr.days ?? null, postDraft: wr.postDraft || null, freeAgentAdds: wr.freeAgentAdds || null,
    notes: [
      wr.days ? `A player you drop sits on waivers for ${wr.days} day${wr.days === 1 ? '' : 's'} (claimable by priority), then becomes a free agent.` : null,
      wr.days ? `Waiver (W) claims process after ${wr.days} day${wr.days === 1 ? '' : 's'}: the player misses today's game.` : null,
      wr.freeAgentAdds === 'immediate' ? 'Free agents (FA) are added immediately.' : null,
      wr.postDraft === 'waivers' ? 'Right after the draft every undrafted player is on waivers.' : null,
      ilCap ? `IL slots (${ilCap}) take Out players directly and don't use a roster spot.` : null,
    ].filter(Boolean),
  };
  return {
    horizon, weeks, startWeek: start, openSpots, rosterSize, ilSlots: ilCap, ilIds: [...ilIds], ilAuto, slots: C.slots,
    adds, priority, waiverRules: rules,
    midWeek: mw ? { week: mw.week, played: mw.played } : null,
    discount: WEEK_DISCOUNT,
    baseline: { total: r1(base), perWeek: basePer.map(r1) },
    lineup: { week: w0, total: r1(lineup0.total), slots: C.slots, starters: lineup0.starters.map(s => ({ slot: s.slot, ...brief(byId.get(s.id)), value: r1(weekValue(byId.get(s.id), w0)) })) },
    targets,
    pairs,
    dropCandidates,
    dropCandidate: dropCandidates.find(d => !d.keeper && !d.ilSlot) || null,
    injuryReplacements,
    calendar,
  };
}

module.exports = { analyzeWaivers, remainingWeekValue, bestLineup, lineupFor, ctxFor, rosterWeekValue, longRun, priorityCost, PRIORITY_MODEL, DEPTH_WEIGHTS, KEEP_MARGIN, roleSignal, roleSignalsFromData, healthyWeekValue, isInjured, HORIZONS, SLOTS, WEEK_DISCOUNT };
