// Weekly lineup picker for Yahoo High Score (stream D). Rules + method:
// docs/nba-lineup.md. Pure and deterministic: same inputs (incl. seed) → same output.
//
//   recommend({ roster, players, week, currentWeek, weekLength, day, opponent, options })
//
// roster entries: { id, name?, slot?: 'G'|'F'|'UTIL'|'BN'|'IL', banked?, locked?,
//                   gamesLeft?, gamesPlayed?, gameDays?: number[] }
//   slot     current Yahoo slot (G/F/UTIL = starting; BN/IL = not). Missing = BN.
//   banked   best game so far this week *while continuously started* (only
//            counts for a current starter; benching him wipes it).
//   locked   the player's game today has started → he can't be moved.
//   gameDays remaining game day indices (0 = first day of the week) — enables
//            exact back-to-back detection; otherwise estimated from counts.
// players: the model board (getPlayers().players) — array or { id: player }.
'use strict';
const St = require('./stats');
const { availability } = require('./board');

const SLOTS = ['G', 'G', 'F', 'F', 'F', 'UTIL'];
const CAP = { G: 2, F: 3, UTIL: 1 };
const STARTING = new Set(['G', 'F', 'UTIL']);
// Back-to-back second legs: chance the player sits for rest on top of normal
// availability. Heuristic (no rest-day data in the model; see docs).
const REST = { base: 0.04, star: 0.06, starMean: 50, fragile: 0.05, fragileA0: 0.75 };
const DEFAULT_REPLACEMENT = { mean: 30, sd: 9, a: 0.9 };
const MC_N = 2000;
const r1 = x => Math.round(x * 10) / 10;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// P(K = k) for K = number of games played, games independent with probs ps.
function poissonBinomial(ps) {
  let d = [1];
  for (const p of ps) {
    const n = new Array(d.length + 1).fill(0);
    for (let k = 0; k < d.length; k++) { n[k] += d[k] * (1 - p); n[k + 1] += d[k] * p; }
    d = n;
  }
  return d;
}
function binom(N, a) { return poissonBinomial(new Array(N).fill(a)); }

// E[max(B, X_1..X_k)], X ~ N(mu, sd); k = 0 → B. B = -Infinity → plain E[max].
function emaxFloor(mu, sd, k, B = -Infinity) {
  if (k <= 0) return Number.isFinite(B) ? B : 0;
  if (!(sd > 0)) return Math.max(B, mu);
  if (!Number.isFinite(B) || B <= mu - 8 * sd) return mu + sd * St.stdNormMax(k);
  const hi = mu + 9 * sd;
  if (B >= hi) return B;
  const steps = 400, dx = (hi - B) / steps;
  let s = 0;
  for (let i = 0; i < steps; i++) {
    const x = B + (i + 0.5) * dx;
    s += (1 - Math.pow(St.normCdf((x - mu) / sd), k)) * dx;
  }
  return B + s;
}
// P(at least one of k games beats B)
function pBeat(mu, sd, k, B) {
  if (k <= 0) return 0;
  if (!(sd > 0)) return mu > B ? 1 : 0;
  return 1 - Math.pow(St.normCdf((B - mu) / sd), k);
}

function slotOf(s) {
  const u = String(s || '').toUpperCase();
  if (u === 'G' || u === 'PG' || u === 'SG') return 'G';
  if (u === 'F' || u === 'SF' || u === 'PF' || u === 'C' || u === 'FC') return 'F';
  if (u === 'UTIL' || u === 'UT' || u === 'FLEX') return 'UTIL';
  if (u.startsWith('IL')) return 'IL';
  return 'BN';
}

// Count back-to-back second legs among sorted day indices.
function b2bLegs(days) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  const legs = new Set();
  for (let i = 1; i < d.length; i++) if (d[i] - d[i - 1] === 1) legs.add(i);
  return legs; // indices into d
}

// Per-game mean for the week, calibrated so that with no banked score and the
// full week ahead the value equals the model's hsByWeek (normal order stats).
function calibratedMean(p, week, a) {
  const N = (p.gamesByWeek || {})[week] ?? p.games ?? 0;
  const hs = (p.hsByWeek || {})[week] ?? p.hsValue ?? 0;
  const sd = p.sd > 0 ? p.sd : Math.max(1, 0.3 * (p.mean || 0));
  if (!(N > 0) || !(hs > 0) || !(a > 0)) return { mu: p.mean || 0, sd, N };
  const P = binom(N, a);
  let S = 0;
  for (let k = 1; k <= N; k++) S += P[k] * St.stdNormMax(k);
  let mu = (hs - sd * S) / (1 - P[0]);
  if (!(Number.isFinite(mu) && mu > 0)) mu = p.mean || 0;
  // Guard against an availability mismatch with the board (e.g. surgery notes we
  // can't see): the week's mean stays within the model's projection-scaling range.
  if (p.mean > 0) mu = Math.min(1.4 * p.mean, Math.max(0.7 * p.mean, mu));
  return { mu, sd, N };
}

function evalPlayer(entry, p, ctx) {
  const slot = slotOf(entry.slot);
  const starter = STARTING.has(slot);
  const banked = starter && Number(entry.banked) > 0 ? Number(entry.banked) : 0;
  const base = { id: String(entry.id), slot, starter, banked, locked: !!entry.locked };
  if (!p) return { ...base, name: entry.name || String(entry.id), unmatched: true, elig: [], keep: banked, insert: 0, gamesLeft: 0, gamesWeek: 0, probs: [], mu: 0, sd: 0 };
  const a = availability({ injury: p.injury, outForSeason: p.outForSeason }, p.availability ?? 0.85, ctx.week - ctx.currentWeek);
  const { mu, sd, N } = calibratedMean(p, ctx.week, a);
  const daysLeft = Math.max(0, ctx.weekLength - ctx.day);
  let gamesLeft, days = null;
  if (Array.isArray(entry.gameDays)) {
    days = entry.gameDays.map(Number).filter(d => Number.isInteger(d) && d >= ctx.day && d < ctx.weekLength);
    gamesLeft = new Set(days).size;
  } else if (entry.gamesLeft != null && Number.isFinite(Number(entry.gamesLeft))) {
    gamesLeft = Math.max(0, Math.min(N || 7, Math.round(Number(entry.gamesLeft))));
  } else if (entry.gamesPlayed != null && Number.isFinite(Number(entry.gamesPlayed))) {
    gamesLeft = Math.max(0, N - Math.round(Number(entry.gamesPlayed)));
  } else {
    gamesLeft = ctx.day <= 0 ? N : Math.max(0, N - Math.round(N * ctx.day / ctx.weekLength));
  }
  // Rest risk on back-to-back second legs.
  let rest = REST.base;
  if ((p.mean || 0) >= REST.starMean) rest += REST.star;
  if ((p.availability ?? 1) < REST.fragileA0) rest += REST.fragile;
  let legs;
  if (days) legs = b2bLegs(days).size;
  else legs = Math.max(0, gamesLeft - Math.ceil(daysLeft / 2)); // minimum forced by the calendar
  const probs = [];
  for (let i = 0; i < gamesLeft; i++) probs.push(i < gamesLeft - legs ? a : a * (1 - rest));
  const K = poissonBinomial(probs);
  let keep = 0, insert = 0;
  for (let k = 0; k < K.length; k++) {
    keep += K[k] * emaxFloor(mu, sd, k, banked > 0 ? banked : 0);
    insert += K[k] * (k ? emaxFloor(mu, sd, k) : 0);
  }
  let beat = 0;
  if (banked > 0) for (let k = 1; k < K.length; k++) beat += K[k] * pBeat(mu, sd, k, banked);
  return {
    ...base, name: p.name, team: p.team, pos: p.pos, elig: (p.elig || []).filter(e => e !== 'UTIL'),
    injury: p.injury || null, availability: Math.round(a * 100) / 100,
    gamesWeek: N, gamesLeft, b2b: legs, restRisk: legs ? Math.round(rest * 100) / 100 : 0,
    mu, sd, probs, keep, insert, pBeat: banked > 0 ? beat : null,
  };
}

// Value of starting this player from now (current starter keeps his banked).
const startValue = e => (e.starter ? e.keep : e.insert);

// Exact optimal assignment: DP over players with state (G used, F used, UTIL used).
// Each player → bench | G | F | UTIL (if eligible). 3·4·2 = 24 states.
function optimise(evals, { forbidForfeit = false } = {}) {
  const key = (g, f, u) => (g * 4 + f) * 2 + u;
  let dp = new Map([[key(0, 0, 0), { v: 0, picks: [] }]]);
  for (let i = 0; i < evals.length; i++) {
    const e = evals[i];
    const next = new Map();
    const put = (k, v, picks) => {
      const cur = next.get(k);
      if (!cur || v > cur.v + 1e-9) next.set(k, { v, picks });
    };
    const val = startValue(e);
    const mustStart = e.starter && (e.locked || (forbidForfeit && e.banked > 0));
    const mustBench = !e.starter && e.locked;
    const canStart = !e.unmatched && e.slot !== 'IL';
    for (const [k, s] of dp) {
      const u = k % 2, f = (k >> 1) % 4, g = k >> 3;
      if (!mustStart) put(k, s.v, s.picks);
      if (mustBench || !canStart) continue;
      // Tiny preference for leaving a current starter where he is (no churn on ties).
      const stay = t => (e.starter && e.slot === t ? 1e-6 : 0);
      const opts = [];
      if (e.elig.includes('G') && g < CAP.G) opts.push(['G', key(g + 1, f, u)]);
      if (e.elig.includes('F') && f < CAP.F) opts.push(['F', key(g, f + 1, u)]);
      if (u < CAP.UTIL) opts.push(['UTIL', key(g, f, 1)]);
      for (const [t, nk] of opts) {
        if (mustStart && e.locked && t !== e.slot) continue; // locked: can't even change slot
        put(nk, s.v + val + stay(t), [...s.picks, [i, t]]);
      }
    }
    dp = next;
  }
  let best = null;
  for (const s of dp.values()) if (!best || s.v > best.v + 1e-9) best = s;
  return best || { v: 0, picks: [] };
}

// Normal draw via Box–Muller from the seeded generator.
function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
function simTotals(starters, n, rng) {
  const out = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    let tot = 0;
    for (const e of starters) {
      let best = e.useBanked ? e.banked : 0;
      for (const p of e.probs) if (rng() < p) best = Math.max(best, Math.max(0, e.mu + e.sd * gauss(rng)));
      tot += best;
    }
    out[s] = tot;
  }
  return out;
}
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

function playerIndex(players) {
  if (!players) return new Map();
  if (players instanceof Map) return players;
  const arr = Array.isArray(players) ? players : Object.values(players);
  return new Map(arr.map(p => [String(p.id), p]));
}

function buildSide(roster, index, ctx, options) {
  const evals = roster.map(r => evalPlayer(r, index.get(String(r.id)), ctx));
  const best = optimise(evals, options);
  const chosen = new Map(best.picks.map(([i, t]) => [i, t]));
  const starters = [...chosen.entries()].map(([i, t]) => ({ ...evals[i], to: t, value: startValue(evals[i]), useBanked: evals[i].starter }));
  return { evals, chosen, starters, total: best.v - starters.reduce((s, e) => s + (e.starter && e.slot === e.to ? 1e-6 : 0), 0) };
}

function recommend({ roster = [], players, week, currentWeek, weekLength = 7, day = 0, opponent = null, options = {} } = {}) {
  const wk = Number(week);
  if (!Number.isInteger(wk) || wk < 1) throw new Error('lineup: bad week');
  const ctx = {
    week: wk,
    currentWeek: Number.isInteger(Number(currentWeek)) ? Number(currentWeek) : wk,
    weekLength: Math.max(1, Math.min(14, Number(weekLength) || 7)),
    day: Math.max(0, Math.min(14, Math.floor(Number(day) || 0))),
  };
  const index = playerIndex(players);
  const seen = new Set();
  const ros = roster.filter(r => r && r.id != null && !seen.has(String(r.id)) && seen.add(String(r.id)));
  const side = buildSide(ros, index, ctx, options);
  const { evals, chosen, starters } = side;
  const rep = { ...DEFAULT_REPLACEMENT, ...(options.replacement || {}) };
  const daysLeft = Math.max(0, ctx.weekLength - ctx.day);
  const repGames = Math.max(0, Math.min(daysLeft, Math.round(daysLeft * 3.5 / 7)));
  const repValue = (() => {
    const K = binom(repGames, rep.a);
    let v = 0;
    for (let k = 1; k < K.length; k++) v += K[k] * emaxFloor(rep.mean, rep.sd, k);
    return v;
  })();

  const pub = e => ({ id: e.id, name: e.name, team: e.team || null, pos: e.pos || [], elig: e.elig, injury: e.injury || null });
  const bench = evals.map((e, i) => ({ e, i })).filter(({ i }) => !chosen.has(i));

  // Per-slot cards in canonical slot order.
  const order = { G: 0, F: 1, UTIL: 2 };
  starters.sort((a, b) => order[a.to] - order[b.to] || b.value - a.value || a.id.localeCompare(b.id));
  const slots = starters.map(e => {
    const alts = bench.filter(({ e: b }) => !b.unmatched && b.slot !== 'IL' && (e.to === 'UTIL' || b.elig.includes(e.to)))
      .map(({ e: b }) => ({ id: b.id, name: b.name, expected: r1(startValue(b)), delta: r1(startValue(b) - e.value), gamesLeft: b.gamesLeft }))
      .sort((x, y) => y.expected - x.expected || x.id.localeCompare(y.id)).slice(0, 3);
    const why = [];
    if (e.banked > 0) {
      why.push(`banked ${r1(e.banked)}; ${e.gamesLeft} game${e.gamesLeft === 1 ? '' : 's'} left with ${Math.round((e.pBeat || 0) * 100)}% chance to beat it (+${r1(e.keep - e.banked)} expected upside)`);
    } else {
      why.push(`${e.gamesLeft} game${e.gamesLeft === 1 ? '' : 's'} left, ~${r1(e.mu)}/game`);
    }
    if (e.injury) why.push(`${e.injury}: plays each game ~${Math.round(e.availability * 100)}%`);
    if (e.b2b) why.push(`${e.b2b} back-to-back leg${e.b2b > 1 ? 's' : ''} (rest risk ${Math.round(e.restRisk * 100)}%)`);
    if (alts[0]) why.push(`beats ${alts[0].name} by ${r1(-alts[0].delta)}`);
    if (e.starter && e.slot !== e.to) why.push(`move ${e.slot}→${e.to} (stays active, banked kept)`);
    if (!e.starter) why.push('starts from now: only games from now on count');
    let stream;
    const gain = repValue - e.value;
    if (e.locked) stream = 'Locked: his game today has started.';
    else if (gain > 0.5) stream = `Streamable: a typical free agent with ~${repGames} game${repGames === 1 ? '' : 's'} left projects ${r1(repValue)} (+${r1(gain)}). Uses an add.`;
    else if (e.banked > 0 && (e.pBeat || 0) < 0.25) stream = `Done for the week: keep him to protect the banked ${r1(e.banked)}.`;
    else stream = `Not worth streaming (free agent ~${r1(repValue)}).`;
    return {
      slot: e.to, player: pub(e), expected: r1(e.value), banked: e.banked ? r1(e.banked) : null,
      gamesLeft: e.gamesLeft, gamesWeek: e.gamesWeek, availability: e.availability, b2b: e.b2b,
      pBeat: e.pBeat == null ? null : Math.round(e.pBeat * 100) / 100,
      locked: e.locked, currentSlot: e.slot, rationale: why.join('; '), alternatives: alts, streamNote: stream,
    };
  });

  // Current lineup (as Yahoo has it now) and the swap diff.
  const curStarters = evals.filter(e => e.starter);
  const currentTotal = curStarters.reduce((s, e) => s + e.keep, 0);
  const outs = curStarters.filter(e => !starters.some(s => s.id === e.id));
  const ins = starters.filter(s => !s.starter);
  const warnings = [];
  const diff = [];
  const insLeft = [...ins];
  for (const o of outs.sort((a, b) => b.keep - a.keep || a.id.localeCompare(b.id))) {
    let j = insLeft.findIndex(n => n.to === o.slot);
    if (j < 0) j = 0;
    const n = insLeft.splice(j, 1)[0] || null;
    const d = { out: { id: o.id, name: o.name, banked: o.banked ? r1(o.banked) : null, expected: r1(o.keep) }, in: n ? { id: n.id, name: n.name, expected: r1(n.value) } : null, slot: n ? n.to : o.slot, gain: r1((n ? n.value : 0) - o.keep), forfeits: o.banked > 0 ? r1(o.banked) : 0 };
    if (o.banked > 0) {
      d.warning = `Benching ${o.name} forfeits his banked ${r1(o.banked)}. If you reinsert him later only games from then on count.`;
      warnings.push({ type: 'forfeit', id: o.id, banked: r1(o.banked), message: d.warning });
    }
    if (o.locked) d.warning = (d.warning ? d.warning + ' ' : '') + 'He is locked today; make this move before his game.';
    diff.push(d);
  }
  for (const n of insLeft) diff.push({ out: null, in: { id: n.id, name: n.name, expected: r1(n.value) }, slot: n.to, gain: r1(n.value), forfeits: 0 });
  const moved = starters.filter(s => s.starter && s.slot !== s.to).map(s => ({ id: s.id, name: s.name, from: s.slot, to: s.to }));
  for (const e of evals) {
    if (e.unmatched) continue;
    if (starters.some(s => s.id === e.id) && e.gamesLeft === 0 && !e.banked) warnings.push({ type: 'no-games', id: e.id, message: `${e.name} has no games left this week.` });
    if (e.injury && /out|ir|sus/i.test(e.injury) && starters.some(s => s.id === e.id)) warnings.push({ type: 'injury', id: e.id, message: `${e.name} is ${e.injury}; started only because nobody better is eligible.` });
  }
  const openSlots = SLOTS.length - starters.length;
  if (openSlots > 0) warnings.push({ type: 'open-slots', message: `${openSlots} starting slot${openSlots > 1 ? 's' : ''} can't be filled from this roster.` });

  // Monte Carlo band (+ head-to-head when an opponent roster is given).
  const n = Math.max(200, Math.min(20000, Number(options.n) || MC_N));
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : 20261020;
  const rng = mulberry32(seed);
  const mineRaw = simTotals(starters, n, rng);
  const mine = Float64Array.from(mineRaw).sort();
  const expected = starters.reduce((s, e) => s + e.value, 0);
  const out = {
    week: ctx.week, day: ctx.day, weekLength: ctx.weekLength,
    slots,
    bench: bench.map(({ e }) => ({ player: pub(e), slot: e.slot, expected: r1(startValue(e)), gamesLeft: e.gamesLeft, banked: e.banked ? r1(e.banked) : null, unmatched: !!e.unmatched, reason: e.unmatched ? 'not matched to a model player' : e.slot === 'IL' ? 'on IL' : e.locked ? 'locked on the bench today' : 'lower expected best game' }))
      .sort((a, b) => b.expected - a.expected || a.player.id.localeCompare(b.player.id)),
    total: { expected: r1(expected), p10: r1(quantile(mine, 0.1)), p50: r1(quantile(mine, 0.5)), p90: r1(quantile(mine, 0.9)) },
    current: curStarters.length ? { expected: r1(currentTotal), starters: curStarters.map(e => ({ id: e.id, slot: e.slot })) } : null,
    gain: curStarters.length ? r1(expected - currentTotal) : null,
    diff, moved, warnings,
    replacement: { expected: r1(repValue), games: repGames },
    unmatched: evals.filter(e => e.unmatched).map(e => ({ id: e.id, name: e.name })),
    mc: { n, seed },
  };
  if (opponent && Array.isArray(opponent.roster) && opponent.roster.length) {
    const opp = buildSide(opponent.roster, index, ctx, {});
    const theirs = simTotals(opp.starters, n, rng);
    // Draw i of mine vs draw i of theirs (independent streams of one seeded RNG).
    let w = 0;
    for (let i = 0; i < n; i++) w += mineRaw[i] > theirs[i] ? 1 : mineRaw[i] === theirs[i] ? 0.5 : 0;
    const ts = Float64Array.from(theirs).sort();
    out.matchup = {
      opponentName: opponent.name || null,
      opponentExpected: r1(opp.starters.reduce((s, e) => s + e.value, 0)),
      opponentP10: r1(quantile(ts, 0.1)), opponentP90: r1(quantile(ts, 0.9)),
      winProb: Math.round((w / n) * 1000) / 1000,
      opponentStarters: opp.starters.map(e => ({ id: e.id, name: e.name, slot: e.to, expected: r1(e.value) })),
      unmatched: opp.evals.filter(e => e.unmatched).length,
    };
  }
  return out;
}

module.exports = { recommend, optimise, evalPlayer, emaxFloor, pBeat, poissonBinomial, calibratedMean, slotOf, mulberry32, SLOTS, REST, DEFAULT_REPLACEMENT };
