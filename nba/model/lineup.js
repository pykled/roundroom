// Weekly lineup picker for Yahoo High Score aggregation (stream D; made
// league-profile-driven by L1). Rules + method: docs/nba-lineup.md. Pure and
// deterministic: same inputs (incl. seed) → same output.
//
//   recommend({ roster, players, week, currentWeek, weekLength, day, opponent, options, profile })
//
// profile: league profile object or id (nba/league-profile.js); default 242808.
//   Starting slots, bench and IL counts all come from it (242808: PG,SG,G,SF,PF,
//   F,C,UTIL,UTIL + 5 BN + 2 IL; High Score defaults: G,G,FC,FC,FC,UTIL).
// roster entries: { id, name?, slot?: any profile slot | 'BN' | 'IL', banked?, locked?,
//                   gamesLeft?, gamesPlayed?, gameDays?: number[] }
//   slot     current Yahoo slot (a starting slot, BN or IL). Missing = BN.
//   banked   best game so far this week *while continuously started* (only
//            counts for a current starter; benching him wipes it).
//   locked   the player's game today has started → he can't be moved.
//   gameDays remaining game day indices (0 = first day of the week) — enables
//            exact back-to-back detection; otherwise estimated from counts.
// players: the model board (getPlayers().players) — array or { id: player }.
'use strict';
const St = require('./stats');
const { availability } = require('./board');
const R = require('./roster-slots');

// High Score default slot list, kept as an export for older callers; the picker
// itself always reads the slots from the profile.
const SLOTS = R.slotList(require('../league-profile').highScoreDefaultProfile());
const isStarting = s => s !== 'BN' && s !== 'IL';
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

const slotOf = (s, profile) => R.slotOf(s, profile);

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
  const slot = slotOf(entry.slot, ctx.profile);
  const starter = isStarting(slot);
  const banked = starter && Number(entry.banked) > 0 ? Number(entry.banked) : 0;
  const bankedKnown = entry.banked != null && entry.banked !== '' && Number.isFinite(Number(entry.banked));
  const base = { id: String(entry.id), slot, starter, banked, bankedKnown, locked: !!entry.locked };
  if (!p) return { ...base, name: entry.name || String(entry.id), unmatched: true, elig: [], can: new Set(), keep: banked, insert: 0, gamesLeft: 0, gamesWeek: 0, probs: [], mu: 0, sd: 0, ilOk: false };
  const a = availability({ injury: p.injury, outForSeason: p.outForSeason }, p.availability ?? 0.85, ctx.week - ctx.currentWeek);
  const { mu, sd, N } = calibratedMean(p, ctx.week, a);
  const daysLeft = Math.max(0, ctx.weekLength - ctx.day);
  let gamesLeft, days = null;
  if (Array.isArray(entry.gameDays)) {
    days = entry.gameDays.map(Number).filter(d => Number.isInteger(d) && d >= ctx.day && d < ctx.weekLength);
    gamesLeft = new Set(days).size;
  } else if (entry.gamesLeft != null && Number.isFinite(Number(entry.gamesLeft))) {
    gamesLeft = Math.max(0, Math.min(N || ctx.weekLength, Math.round(Number(entry.gamesLeft))));
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
  const can = R.eligFor(p, ctx.profile);
  return {
    ...base, name: p.name, team: p.team, pos: p.yahooPos || p.pos, elig: [...can].filter(e => e !== 'UTIL'), can,
    injury: p.injury || null, availability: Math.round(a * 100) / 100, ilOk: R.ilEligible(p),
    gamesWeek: N, gamesLeft, b2b: legs, restRisk: legs ? Math.round(rest * 100) / 100 : 0,
    mu, sd, probs, keep, insert, pBeat: banked > 0 ? beat : null,
  };
}

// Value of starting this player from now (current starter keeps his banked).
const startValue = e => (e.starter ? e.keep : e.insert);

// Exact optimal assignment over the profile's slot units (roster-slots.js:
// matroid greedy + augmenting paths, checked against brute force in tests).
// Pinned starters (locked, or not in our data so we can't judge them) stay in
// their current Yahoo slot whatever the model's eligibility says: Yahoo already
// allowed him there. If the pins alone overfill a slot (bad manual input) the
// pins are dropped rather than returning an empty lineup.
function optimise(evals, opts = {}) {
  const best = optimiseOnce(evals, opts);
  if (best) return best;
  return optimiseOnce(evals, { ...opts, relaxPins: true }) || { v: 0, picks: [], relaxed: true };
}
const isPinned = (e, relaxPins) => !relaxPins && e.starter && (e.locked || e.unmatched);
// Tiny preference for leaving a current starter in (no churn on ties).
const STAY = 1e-6;
function optimiseOnce(evals, { forbidForfeit = false, relaxPins = false, slots = SLOTS } = {}) {
  const items = [];
  evals.forEach((e, i) => {
    const pinned = isPinned(e, relaxPins);
    const mustBench = !e.starter && e.locked && !relaxPins;
    const canStart = (pinned || !e.unmatched) && e.slot !== 'IL';
    if (mustBench || !canStart) return;
    const must = !pinned && e.starter && forbidForfeit && e.banked > 0 && !e.unmatched;
    items.push({
      id: i, v: startValue(e) + (e.starter ? STAY : 0), elig: e.can || new Set(),
      pin: pinned ? e.slot : null, must, prefer: e.starter ? e.slot : null,
    });
  });
  const a = R.bestAssignment(items, slots);
  if (!a) return null;
  const picks = a.starters.map(s => [s.id, s.slot]).sort((x, y) => x[0] - y[0]);
  const v = picks.reduce((t, [i]) => t + startValue(evals[i]) + (evals[i].starter && evals[i].slot === slotOfPick(picks, i) ? STAY : 0), 0);
  return { v, picks, relaxed: relaxPins };
}
const slotOfPick = (picks, i) => (picks.find(p => p[0] === i) || [])[1];

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

const dedupe = roster => {
  const seen = new Set();
  return (Array.isArray(roster) ? roster : []).filter(r => r && r.id != null && !seen.has(String(r.id)) && seen.add(String(r.id)));
};
function buildSide(roster, index, ctx, options) {
  const evals = dedupe(roster).map(r => evalPlayer(r, index.get(String(r.id)), ctx));
  const best = optimise(evals, { ...options, slots: ctx.slots });
  const chosen = new Map(best.picks.map(([i, t]) => [i, t]));
  const starters = [...chosen.entries()].map(([i, t]) => ({ ...evals[i], to: t, value: startValue(evals[i]), useBanked: evals[i].starter }));
  return { evals, chosen, starters, relaxed: !!best.relaxed, total: best.v - starters.reduce((s, e) => s + (e.starter && e.slot === e.to ? 1e-6 : 0), 0) };
}

function recommend({ roster = [], players, week, currentWeek, weekLength = 7, day = 0, opponent = null, options = {}, profile } = {}) {
  const wk = Number(week);
  if (!Number.isInteger(wk) || wk < 1) throw new Error('lineup: bad week');
  const prof = R.resolveProfile(profile);
  const ctx = {
    profile: prof, slots: R.slotList(prof),
    week: wk,
    currentWeek: Number.isInteger(Number(currentWeek)) ? Number(currentWeek) : wk,
    weekLength: Math.max(1, Math.min(14, Number(weekLength) || 7)),
    day: Math.max(0, Math.min(14, Math.floor(Number(day) || 0))),
  };
  const index = playerIndex(players);
  const side = buildSide(roster, index, ctx, options);
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
  const order = Object.fromEntries([...new Set(ctx.slots)].map((s, i) => [s, i]));
  starters.sort((a, b) => order[a.to] - order[b.to] || b.value - a.value || a.id.localeCompare(b.id));
  const slots = starters.map(e => {
    const alts = bench.filter(({ e: b }) => !b.unmatched && b.slot !== 'IL' && !(b.locked && !b.starter) && b.can.has(e.to))
      .map(({ e: b }) => ({ id: b.id, name: b.name, expected: r1(startValue(b)), delta: r1(startValue(b) - e.value), gamesLeft: b.gamesLeft }))
      .sort((x, y) => y.expected - x.expected || x.id.localeCompare(y.id)).slice(0, 3);
    const why = [];
    if (e.unmatched) {
      return {
        slot: e.to, player: pub(e), expected: r1(e.value), banked: e.banked ? r1(e.banked) : null,
        gamesLeft: null, gamesWeek: null, availability: null, b2b: 0, pBeat: null,
        locked: e.locked, currentSlot: e.slot, unmatched: true, alternatives: alts,
        rationale: 'not in our player data, so we can\'t project him; left in his current slot (benching a starter can forfeit his best game)',
        streamNote: 'Check him yourself: not in our player data.',
      };
    }
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
    else if (ctx.day > 0 && !o.bankedKnown) {
      d.warning = `Check ${o.name}'s best game so far before benching him: we don't know it, and benching forfeits it.`;
      warnings.push({ type: 'forfeit-unknown', id: o.id, message: d.warning });
    }
    if (o.locked) d.warning = (d.warning ? d.warning + ' ' : '') + 'He is locked today; make this move before his game.';
    diff.push(d);
  }
  for (const n of insLeft) diff.push({ out: null, in: { id: n.id, name: n.name, expected: r1(n.value) }, slot: n.to, gain: r1(n.value), forfeits: 0 });
  const moved = starters.filter(s => s.starter && s.slot !== s.to).map(s => ({ id: s.id, name: s.name, from: s.slot, to: s.to }));
  if (side.relaxed) warnings.push({ type: 'lock-conflict', message: 'More locked starters than slots for them, so locks were ignored. Check the slots you entered.' });
  for (const e of evals) {
    if (e.unmatched) {
      if (e.starter && starters.some(s => s.id === e.id)) warnings.push({ type: 'unmatched-starter', id: e.id, message: `${e.name} isn't in our player data, so he was left in his ${e.slot} slot unprojected.` });
      continue;
    }
    if (starters.some(s => s.id === e.id) && e.gamesLeft === 0 && !e.banked) warnings.push({ type: 'no-games', id: e.id, message: `${e.name} has no games left this week.` });
    if (e.injury && /out|ir|sus/i.test(e.injury) && starters.some(s => s.id === e.id)) warnings.push({ type: 'injury', id: e.id, message: `${e.name} is ${e.injury}; started only because nobody better is eligible.` });
  }
  const openSlots = ctx.slots.length - starters.length;
  if (openSlots > 0) warnings.push({ type: 'open-slots', message: `${openSlots} starting slot${openSlots > 1 ? 's' : ''} can't be filled from this roster.` });

  // Roster spots (profile): IL players don't use an active spot, so an Out
  // player sitting on the bench should move to a free IL slot (frees a spot for
  // an add); a healthy player left in IL makes Yahoo block adds and drops.
  const ilCap = R.ilSlots(prof), activeCap = R.activeSpots(prof);
  const onIl = evals.filter(e => e.slot === 'IL');
  const active = evals.length - onIl.length;
  let ilFree = Math.max(0, ilCap - onIl.length);
  const ilMoves = [];
  for (const { e } of bench.filter(({ e }) => e.slot === 'BN' && e.ilOk && !e.locked).sort((x, y) => startValue(x.e) - startValue(y.e) || x.e.id.localeCompare(y.e.id))) {
    if (!ilFree) break;
    ilFree--;
    ilMoves.push({ id: e.id, name: e.name, injury: e.injury, from: 'BN', to: 'IL', message: `Move ${e.name} (${e.injury || 'out'}) to IL: frees a bench spot for an add.` });
  }
  for (const e of onIl) {
    if (!e.unmatched && !e.ilOk) warnings.push({ type: 'il-healthy', id: e.id, message: `${e.name} is in an IL slot but isn't listed Out${e.injury ? ` (${e.injury})` : ''}. Yahoo blocks adds and drops until you activate him.` });
  }
  if (active > activeCap) warnings.push({ type: 'roster-over', message: `${active} players on active spots; the league has ${activeCap} (${ctx.slots.length} starters + ${activeCap - ctx.slots.length} BN). Move an Out player to IL or drop someone.` });

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
    spots: { starters: ctx.slots.length, slots: ctx.slots, active, activeCap, benchOpen: Math.max(0, activeCap - active), il: onIl.length, ilCap, ilMoves },
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
