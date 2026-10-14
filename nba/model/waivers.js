// Pocket NBA — waiver / streaming engine (stream F). Pure and deterministic:
// same roster + pool + board → same output. Rules and method: docs/nba-waivers.md.
//
//   analyzeWaivers({ roster, pool, startWeek, horizon, weeks, roles, rosterSize })
//     roster / pool: model Player objects (nba/model getPlayers shape)
//     → { targets, pairs, dropCandidates, injuryReplacements, calendar, baseline, ... }
//
// Value of a player in week w = hsByWeek[w] (B's E[best game] given that week's
// team games and availability). Value of a roster in week w = its best legal
// G,G,F,F,F,UTIL lineup. Everything here is a difference of best lineups, so a
// free agent only earns credit for the slot he would actually take.
'use strict';
const St = require('./stats');

// Stream D's nba/model/lineup.js did not exist when this was written; this is
// the small internal assignment it would provide (exact DP over slot counts).
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
const DEPTH_WEIGHTS = [0.12, 0.06];

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

const weekValue = (p, w) => Math.max(0, num(p && p.hsByWeek && p.hsByWeek[w]));
const weekGames = (p, w) => Math.max(0, num(p && p.gamesByWeek && p.gamesByWeek[w]));

function itemsFor(players, w) {
  return players.map(p => { const e = eligOf(p); return { id: String(p.id), v: weekValue(p, w), g: e.G, f: e.F }; });
}
// Week value of a roster = best lineup + depth credit for the top bench players.
function rosterWeekValue(players, w) {
  const items = itemsFor(players, w);
  const lu = bestLineup(items);
  const on = new Set(lu.starters.map(s => s.id));
  const bench = items.filter(it => !on.has(it.id)).map(it => it.v).sort((a, b) => b - a);
  let depth = 0;
  DEPTH_WEIGHTS.forEach((k, i) => { depth += k * (bench[i] || 0); });
  return lu.total + depth;
}
function horizonValue(players, weeks) {
  let s = 0;
  weeks.forEach((w, i) => { s += Math.pow(WEEK_DISCOUNT, i) * rosterWeekValue(players, w); });
  return s;
}
function perWeek(players, weeks) { return weeks.map(w => bestLineup(itemsFor(players, w)).total); }

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

function isInjured(p) {
  return !!(p && (p.outForSeason || INJURED.test(String(p.injury || '').trim())));
}

function brief(p) {
  return { id: String(p.id), name: p.name || String(p.id), team: p.team || null, pos: p.pos || [], elig: p.elig || ['UTIL'], injury: p.injury || null };
}

function analyzeWaivers(opts = {}) {
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
  const pool = (opts.pool || []).filter(p => p && p.id != null && !rosterIds.has(String(p.id)));
  const rosterSize = Number(opts.rosterSize) > 0 ? Number(opts.rosterSize) : 10;
  const openSpots = Math.max(0, rosterSize - roster.length);

  const base = horizonValue(roster, weeks);
  const basePer = perWeek(roster, weeks);
  const without = new Map(); // dropId → horizon value of roster minus that player
  for (const d of roster) without.set(String(d.id), horizonValue(roster.filter(p => p !== d), weeks));

  // Drop candidates: cheapest player to lose (lowest marginal value to my best lineups).
  const dropCandidates = roster.map(d => ({
    ...brief(d),
    dropCost: r1(base - without.get(String(d.id))),
    valueByWeek: weeks.map(w => r1(weekValue(d, w))),
    gamesByWeek: weeks.map(w => weekGames(d, w)),
  })).sort((a, b) => a.dropCost - b.dropCost || a.valueByWeek.reduce((s, x) => s + x, 0) - b.valueByWeek.reduce((s, x) => s + x, 0) || (a.id < b.id ? -1 : 1));

  // Pre-cut the pool by raw horizon value (cheap), then score exactly.
  const raw = p => weeks.reduce((s, w, i) => s + Math.pow(WEEK_DISCOUNT, i) * weekValue(p, w), 0);
  const cands = pool.map(p => ({ p, raw: raw(p) })).filter(x => x.raw > 0)
    .sort((a, b) => b.raw - a.raw || num(b.p.ceiling) - num(a.p.ceiling) || (String(a.p.id) < String(b.p.id) ? -1 : 1))
    .slice(0, Math.max(1, Number(opts.maxCandidates) || MAX_CANDIDATES));

  const targets = cands.map(({ p }) => {
    const id = String(p.id);
    const addGain = horizonValue([...roster, p], weeks) - base; // as if a roster spot were free
    let bestDrop = null, netGain = openSpots > 0 ? addGain : -Infinity;
    if (openSpots === 0) {
      for (const d of roster) {
        const others = roster.filter(x => x !== d);
        const net = horizonValue([...others, p], weeks) - base;
        if (net > netGain + 1e-9) { netGain = net; bestDrop = d; }
      }
    }
    if (!Number.isFinite(netGain)) netGain = 0;
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
      drop: bestDrop ? { id: String(bestDrop.id), name: bestDrop.name } : null,
      mean: r1(p.mean), sd: r1(p.sd), ceiling: r1(p.ceiling), floor: r1(p.floor),
      roleUp: !!(role && role.roleUp), role,
      source: p.source || null,
      reasons,
    };
  }).sort((a, b) => b.netGain - a.netGain || b.addGain - a.addGain || b.ceiling - a.ceiling || (a.id < b.id ? -1 : 1));

  // Stream plan for the coming week: best add/drop pairs, each player used once.
  const w0 = weeks[0];
  const pairs = [];
  if (roster.length) {
    const base0 = rosterWeekValue(roster, w0);
    const opts0 = [];
    for (const { p } of cands.slice(0, 40)) {
      for (const d of (openSpots > 0 ? [null] : roster)) {
        const set = d ? roster.filter(x => x !== d) : roster;
        const gain = rosterWeekValue([...set, p], w0) - base0;
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
        week: w0, add: { ...brief(o.p), games: weekGames(o.p, w0), value: r1(weekValue(o.p, w0)) },
        drop: o.d ? { ...brief(o.d), games: weekGames(o.d, w0), value: r1(weekValue(o.d, w0)) } : null,
        netGain: r1(o.gain),
      });
      if (pairs.length >= 5) break;
    }
  }

  // Injury replacements: an injured rostered player whose hole is a starter-sized hole.
  const injuryReplacements = [];
  for (const inj of roster.filter(isInjured)) {
    const lost = weeks.reduce((s, w, i) => s + Math.pow(WEEK_DISCOUNT, i) * Math.max(0, healthyWeekValue(inj, w) - weekValue(inj, w)), 0);
    if (lost < 1) continue;
    const others = roster.filter(x => x !== inj);
    const reps = cands.slice(0, 40).map(({ p }) => ({ p, gain: horizonValue([...others, p], weeks) - base }))
      .filter(x => x.gain > 0.05)
      .sort((a, b) => b.gain - a.gain || (String(a.p.id) < String(b.p.id) ? -1 : 1))
      .slice(0, 3)
      .map(x => ({ ...brief(x.p), netGain: r1(x.gain), gamesByWeek: weeks.map(w => weekGames(x.p, w)) }));
    injuryReplacements.push({
      injured: { ...brief(inj), outForSeason: !!inj.outForSeason },
      lostValue: r1(lost),
      replacements: reps,
    });
  }
  injuryReplacements.sort((a, b) => b.lostValue - a.lostValue);

  // Streamer calendar: free agents on 4+ game weeks over the next 3 weeks.
  const calendar = calWeeks.map(w => ({
    week: w,
    fourGame: pool.filter(p => weekGames(p, w) >= 4 && weekValue(p, w) > 0)
      .sort((a, b) => weekValue(b, w) - weekValue(a, w) || (String(a.id) < String(b.id) ? -1 : 1))
      .slice(0, 8)
      .map(p => ({ ...brief(p), games: weekGames(p, w), value: r1(weekValue(p, w)) })),
  }));

  const lineup0 = bestLineup(itemsFor(roster, w0));
  const byId = new Map(roster.map(p => [String(p.id), p]));
  return {
    horizon, weeks, startWeek: start, openSpots, rosterSize,
    discount: WEEK_DISCOUNT,
    baseline: { total: r1(base), perWeek: basePer.map(r1) },
    lineup: { week: w0, total: r1(lineup0.total), starters: lineup0.starters.map(s => ({ slot: s.slot, ...brief(byId.get(s.id)), value: r1(weekValue(byId.get(s.id), w0)) })) },
    targets,
    pairs,
    dropCandidates,
    dropCandidate: dropCandidates[0] || null,
    injuryReplacements,
    calendar,
  };
}

module.exports = { analyzeWaivers, bestLineup, rosterWeekValue, DEPTH_WEIGHTS, roleSignal, roleSignalsFromData, healthyWeekValue, isInjured, HORIZONS, SLOTS, WEEK_DISCOUNT };
