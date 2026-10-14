/* Pocket NBA — draft board logic (Yahoo High Score).
   Pure functions only: no DOM, no fetch, no storage access. Loaded as a plain
   <script> in the browser (exposes window.NbaDraft) and via require() in node
   (scripts/test-nba-ui.js).

   Conventions
     pick     1-based overall pick number
     slot     1-based draft slot (team position in round 1)
     settings { teams, mySlot, slots: { PG, SG, G, SF, PF, F, C, UTIL } | { G, F, UTIL }, bench, il }
              Position-aware leagues (any of PG/SG/SF/PF/C/FC in slots, e.g. league
              242808) use Yahoo slot eligibility; G/F/UTIL-only leagues (Yahoo
              High Score default) keep the model's `elig` (C counts as F).
     player   contract Player: { id, name, team, pos: ['PG'..'C'], elig: ['G'|'F'|'UTIL'],
              yahooElig?: ['PG'..'UTIL'], eligConfidence?, hsValue, vorp?, vorpBySlot?,
              ceiling, floor, injury, tier, ... } */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NbaDraft = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORAGE_PREFIX = 'pocket-nba-draft:';
  var STATE_VERSION = 1;
  // Every starter slot type the board understands, in display order.
  var SLOT_TYPES = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'FC', 'C', 'UTIL'];
  var LEGACY_TYPES = ['G', 'F', 'UTIL'];
  var POS_SLOT = { PG: 1, SG: 1, SF: 1, PF: 1, FC: 1, C: 1 }; // any of these => position-aware league
  // Narrow slots first: a PG who can start at PG, G or UTIL takes PG.
  var SUBSLOTS = { G: ['PG', 'SG'], F: ['SF', 'PF'], FC: ['SF', 'PF', 'F', 'C'] };
  var SPECIFIC = { PG: 3, SG: 3, SF: 3, PF: 3, C: 3, G: 2, F: 2, FC: 2, UTIL: 1 };
  /* Yahoo position token -> starter slots it can fill (Phase 3 addendum legend:
     PG<-PG; SG<-SG,G,G/F; G<-PG,SG,G,G/F; SF<-SF,F,G/F; PF<-PF,F,F/C;
     F<-SF,PF,F,G/F,F/C; C<-C,F/C; FC<-forwards+centers; UTIL<-anyone).
     A C-only player is NOT F-eligible. */
  var TOKEN_SLOTS = {
    PG: ['PG', 'G'], SG: ['SG', 'G'], G: ['SG', 'G'], GF: ['SG', 'G', 'SF', 'F', 'FC'],
    SF: ['SF', 'F', 'FC'], PF: ['PF', 'F', 'FC'], F: ['SF', 'PF', 'F', 'FC'], FC: ['PF', 'F', 'FC', 'C'], C: ['C', 'FC']
  };

  // League 242808 "HALIMSANITY 26-27" (docs/nba-contracts.md Phase 3) — used only
  // until GET /api/nba/league-profile answers (or if it can't).
  var DEFAULT_SETTINGS = { teams: 12, mySlot: 1, slots: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2 }, bench: 5, il: 2 };
  // Yahoo High Score default roster (G, G, F, F, F, UTIL + 4 bench) for other leagues.
  var HIGH_SCORE_SETTINGS = { teams: 10, mySlot: 1, slots: { G: 2, F: 3, UTIL: 1 }, bench: 4, il: 0 };
  var DEFAULT_PICK_SECONDS_PROFILE = 90;

  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  function hasPosSlots(slots) {
    return !!slots && Object.keys(slots).some(function (k) { return POS_SLOT[k] && parseInt(slots[k], 10) > 0; });
  }

  /* No slots given → league 242808 profile. G/F/UTIL-only slots → High Score
     shape (missing ones default to G2/F3/UTIL1). Any PG/SG/SF/PF/C/FC slot →
     position-aware: missing types are 0. */
  function normalizeSettings(s) {
    s = s || {};
    var given = s.slots && typeof s.slots === 'object' ? s.slots : null;
    var known = given ? Object.keys(given).filter(function (k) { return SLOT_TYPES.indexOf(k) >= 0; }) : [];
    var pos = hasPosSlots(given);
    var base = !known.length ? DEFAULT_SETTINGS : pos ? null : HIGH_SCORE_SETTINGS;
    var slots = {};
    if (!known.length) Object.keys(DEFAULT_SETTINGS.slots).forEach(function (k) { slots[k] = DEFAULT_SETTINGS.slots[k]; });
    else if (pos) SLOT_TYPES.forEach(function (k) { var c = clampInt(given[k], 0, 6, 0); if (c > 0) slots[k] = c; });
    else LEGACY_TYPES.forEach(function (k) { slots[k] = clampInt(given[k], 0, 6, HIGH_SCORE_SETTINGS.slots[k]); });
    var out = {
      teams: clampInt(s.teams, 2, 20, (base || DEFAULT_SETTINGS).teams),
      mySlot: 1,
      slots: slots,
      bench: clampInt(s.bench, 0, 15, (base || DEFAULT_SETTINGS).bench),
      il: clampInt(s.il, 0, 5, base ? base.il : 0)
    };
    out.mySlot = clampInt(s.mySlot, 1, out.teams, 1);
    // Draft rounds: Yahoo drafts active + bench spots only (IL starts empty), so
    // the default is starters + BN; a profile / the League dialog can override.
    var n = 0; Object.keys(slots).forEach(function (k) { n += slots[k] || 0; });
    out.rounds = clampInt(s.rounds, 1, 30, n + out.bench);
    return out;
  }

  function isLegacy(settings) { return !hasPosSlots(settings && settings.slots); }
  // Starter slot types present in this league, in display order.
  function slotTypes(settings) { return SLOT_TYPES.filter(function (t) { return (settings.slots[t] || 0) > 0; }); }
  function starterCount(settings) { var n = 0; Object.keys(settings.slots).forEach(function (k) { n += settings.slots[k] || 0; }); return n; }
  function rosterSize(settings) { return starterCount(settings) + settings.bench + (settings.il || 0); }
  function draftRounds(settings) { return settings.rounds > 0 ? settings.rounds : starterCount(settings) + settings.bench; }
  function totalPicks(settings) { return settings.teams * draftRounds(settings); }

  /* League profile (GET /api/nba/league-profile) → settings. Keeps prev.mySlot. */
  function settingsFromProfile(profile, prev) {
    if (!profile || !profile.slots || typeof profile.slots !== 'object') return normalizeSettings(prev);
    var sl = {};
    SLOT_TYPES.forEach(function (t) { if (profile.slots[t] != null) sl[t] = profile.slots[t]; });
    return normalizeSettings({ teams: profile.teams, mySlot: prev && prev.mySlot, slots: sl, bench: profile.slots.BN, il: profile.slots.IL,
      rounds: profile.draft && profile.draft.rounds });
  }
  function profilePickSeconds(profile) {
    var n = profile && profile.draft && parseInt(profile.draft.pickSeconds, 10);
    return n > 0 ? Math.min(600, n) : DEFAULT_PICK_SECONDS_PROFILE;
  }

  /* ---------------------------------------------------------------- snake */

  function roundOf(pick, teams) { return Math.ceil(pick / teams); }

  function slotForPick(pick, teams) {
    var r = roundOf(pick, teams);
    var idx = (pick - 1) % teams;
    return r % 2 === 1 ? idx + 1 : teams - idx;
  }

  function snakeOrder(teams, rounds) {
    var out = [];
    for (var p = 1; p <= teams * rounds; p++) {
      out.push({ pick: p, round: roundOf(p, teams), pickInRound: ((p - 1) % teams) + 1, slot: slotForPick(p, teams) });
    }
    return out;
  }

  // Overall pick numbers belonging to `slot`, at or after `fromPick`.
  function picksForSlot(slot, teams, rounds, fromPick) {
    var out = [];
    for (var r = 1; r <= rounds; r++) {
      var p = r % 2 === 1 ? (r - 1) * teams + slot : r * teams - slot + 1;
      if (p >= (fromPick || 1)) out.push(p);
    }
    return out;
  }

  // Next pick number >= currentPick owned by mySlot, or null when the draft is over for us.
  function nextPickFor(slot, currentPick, settings) {
    var list = picksForSlot(slot, settings.teams, draftRounds(settings), currentPick);
    return list.length ? list[0] : null;
  }

  /* ------------------------------------------------------- eligibility */

  // Legacy G/F/UTIL eligibility from the model's `elig` (C counts as F there).
  function eligFor(p) {
    var e = (p && p.elig) || [];
    if (!e.length && p && p.pos) {
      // no elig from the model: PG/SG → G, everything else → F (B's mapping)
      e = [];
      posTokens(p.pos).forEach(function (t) { e.push(t === 'PG' || t === 'SG' || t === 'G' ? 'G' : 'F'); });
    }
    return { G: e.indexOf('G') >= 0, F: e.indexOf('F') >= 0, UTIL: e.indexOf('UTIL') >= 0 || e.indexOf('G') >= 0 || e.indexOf('F') >= 0 };
  }

  // 'PG,SG' | ['PG','SG'] | 'G/F' | 'F-C' → ['PG','SG'] / ['GF'] / ['FC']
  function posTokens(pos) {
    var list = Array.isArray(pos) ? pos : typeof pos === 'string' ? pos.split(/[,\s]+/) : [];
    var out = [];
    list.forEach(function (x) {
      var k = String(x || '').toUpperCase().replace(/[^A-Z/\-]/g, '');
      if (k === 'G/F' || k === 'G-F' || k === 'GF') k = 'GF';
      else if (k === 'F/C' || k === 'F-C' || k === 'C/F' || k === 'FC' || k === 'CF') k = 'FC';
      if (TOKEN_SLOTS[k] && out.indexOf(k) < 0) out.push(k);
    });
    return out;
  }

  var eligCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  /* Slots p can fill in a position-aware league:
     { slots: {PG:true,..,UTIL:true}, source: 'yahoo'|'derived'|'none', low: bool }.
     Yahoo's yahooElig wins; otherwise derive from Sleeper pos[] via the contract
     legend (flagged low confidence); last resort the model's G/F elig. */
  function slotElig(p) {
    if (p && typeof p === 'object' && eligCache) { var hit = eligCache.get(p); if (hit) return hit; }
    var slots = { UTIL: true }, source = 'none', low = true;
    var ye = p && Array.isArray(p.yahooElig) ? p.yahooElig : null;
    if (ye && ye.length) {
      ye.forEach(function (s) {
        var k = String(s || '').toUpperCase();
        if (k === 'UTIL' || k === 'UTILITY') return;
        if (k === 'F/C') k = 'FC';
        if (SLOT_TYPES.indexOf(k) >= 0) slots[k] = true;
      });
      source = 'yahoo';
      // H1 sends 'yahoo' when eligibility came from Yahoo's own snapshot; any
      // other string (e.g. 'sleeper', 'inferred') or a numeric score < .7 is a guess.
      var c = p.eligConfidence;
      low = c == null ? false : typeof c === 'number' ? c < 0.7 : String(c).toLowerCase() !== 'yahoo' && String(c).toLowerCase() !== 'high';
    } else {
      var toks = posTokens(p && p.pos);
      if (toks.length) {
        toks.forEach(function (t) { TOKEN_SLOTS[t].forEach(function (s) { slots[s] = true; }); });
        source = 'derived';
      } else if (p && Array.isArray(p.elig)) {
        if (p.elig.indexOf('G') >= 0) slots.G = true;
        if (p.elig.indexOf('F') >= 0) slots.F = true;
      }
    }
    var r = { slots: slots, source: source, low: low };
    if (p && typeof p === 'object' && eligCache) eligCache.set(p, r);
    return r;
  }

  // Can p start in slot `type` under these settings?
  function canFill(p, type, settings) {
    if (type === 'UTIL') return true;
    if (settings && isLegacy(settings)) return !!eligFor(p)[type];
    return !!slotElig(p).slots[type];
  }

  // Display positions for a player: Yahoo-style base positions (PG, SG, SF, PF, C).
  function displayPositions(p) {
    var ys = yahooPosString(p);
    if (ys) return ys.split(',');
    var e = slotElig(p).slots, out = [];
    ['PG', 'SG', 'SF', 'PF', 'C'].forEach(function (k) { if (e[k]) out.push(k); });
    if (!out.length) { if (e.G) out.push('G'); if (e.F) out.push('F'); }
    return out;
  }

  // Yahoo's own position string ('PG,SG'), from p.yahooPos when H1 sends it,
  // else rebuilt from yahooElig. null when Yahoo eligibility is unknown.
  function yahooPosString(p) {
    if (!p) return null;
    var raw = typeof p.yahooPos === 'string' ? p.yahooPos : null;
    var toks = raw ? raw.toUpperCase().split(/[,/\s]+/) : Array.isArray(p.yahooElig) ? p.yahooElig.map(function (x) { return String(x || '').toUpperCase(); }) : [];
    var out = ['PG', 'SG', 'SF', 'PF', 'C'].filter(function (k) { return toks.indexOf(k) >= 0; });
    return out.length ? out.join(',') : null;
  }

  /* Stable identity for a board player: Yahoo's player id when the model has
     one (Yahoo draft sync speaks Yahoo player_keys), else the Sleeper id. */
  function playerKey(p) {
    if (!p) return '';
    if (p.yahooPid != null && p.yahooPid !== '') return 'y' + String(p.yahooPid);
    return String(p.id);
  }
  // '466.p.5352' → '5352'; bare ids pass through. null when not parseable.
  function yahooPidFromKey(k) {
    if (k == null) return null;
    var m = /(?:^|\.p\.)(\d+)$/.exec(String(k));
    return m ? m[1] : null;
  }

  /* ------------------------------------------------------- slot assignment */

  function val(p) { return (p && typeof p.hsValue === 'number' && isFinite(p.hsValue)) ? p.hsValue : 0; }
  function byValThenId(a, b) { return val(b) - val(a) || (String(a && a.id) < String(b && b.id) ? -1 : String(a && a.id) > String(b && b.id) ? 1 : 0); }
  // Assignment weight: value, +1e-6 so a 0-value player still fills an open
  // slot, + a hair for narrow slots so flexible ones (G, F, UTIL) stay open.
  function weight(p, t) { return val(p) + 1e-6 + SPECIFIC[t] * 1e-8; }

  var MAX_STATES = 20000;
  function slotPlan(settings) {
    var types = slotTypes(settings), caps = [], mult = [], n = 1;
    types.forEach(function (t, i) { caps[i] = settings.slots[t]; mult[i] = n; n *= caps[i] + 1; });
    return { types: types, caps: caps, mult: mult, states: n };
  }
  function usedAt(plan, s, i) { return Math.floor(s / plan.mult[i]) % (plan.caps[i] + 1); }

  /* Exact max-weight assignment of roster players to starter slots: DP over
     "how many slots of each type are used" (242808: 2^7·3 = 384 states).
     Returns { plan, players, dp (best weight per used-state, any subset),
     baseState, base, placed: [typeIndex|-1 per player] }. */
  function solveSlots(roster, settings) {
    var plan = slotPlan(settings);
    var players = (roster || []).filter(Boolean).slice().sort(byValThenId);
    if (plan.states > MAX_STATES) return greedySolve(players, settings, plan);
    var S = plan.states, k = plan.types.length;
    var dp = new Float64Array(S); for (var z = 1; z < S; z++) dp[z] = -Infinity; dp[0] = 0;
    var layers = [];
    players.forEach(function (p) {
      var el = [];
      for (var i = 0; i < k; i++) if (canFill(p, plan.types[i], settings)) el.push(i);
      var next = new Float64Array(S), ch = new Int8Array(S);
      for (var s0 = 0; s0 < S; s0++) { next[s0] = -Infinity; ch[s0] = -2; }
      for (var s = 0; s < S; s++) {
        var v0 = dp[s];
        if (v0 === -Infinity) continue;
        if (v0 > next[s]) { next[s] = v0; ch[s] = -1; }
        for (var j = 0; j < el.length; j++) {
          var ti = el[j];
          if (usedAt(plan, s, ti) >= plan.caps[ti]) continue;
          var s2 = s + plan.mult[ti], v = v0 + weight(p, plan.types[ti]);
          if (v > next[s2]) { next[s2] = v; ch[s2] = ti; }
        }
      }
      layers.push(ch); dp = next;
    });
    var best = 0;
    for (var b = 1; b < S; b++) if (dp[b] > dp[best]) best = b;
    var placed = new Array(players.length), cur = best;
    for (var q = players.length - 1; q >= 0; q--) {
      var c = layers[q][cur];
      placed[q] = c >= 0 ? c : -1;
      if (c >= 0) cur -= plan.mult[c];
    }
    return { plan: plan, players: players, dp: dp, baseState: best, base: dp[best], placed: placed };
  }
  // Absurd custom slot counts only (state space too big): narrowest-slot greedy.
  function greedySolve(players, settings, plan) {
    var used = plan.types.map(function () { return 0; }), placed = [], base = 0;
    players.forEach(function (p) {
      var bestI = -1;
      plan.types.forEach(function (t, i) {
        if (used[i] < plan.caps[i] && canFill(p, t, settings) && (bestI < 0 || SPECIFIC[t] > SPECIFIC[plan.types[bestI]])) bestI = i;
      });
      placed.push(bestI);
      if (bestI >= 0) { used[bestI]++; base += weight(p, plan.types[bestI]); }
    });
    return { plan: plan, players: players, dp: null, baseState: null, base: base, placed: placed, greedyUsed: used };
  }

  function isOut(p) { var s = injuryShort(p && p.injury); return s === 'OUT' || s === 'SUS'; }

  /* Assign roster players to starter slots to maximise starter hsValue
     (exact; dual-eligible players land wherever they help most).
     Returns { starters: [{slot, player|null}], bench: [player], il: [player],
               open: {type: n}, total, ilHealthy } */
  function assignSlots(roster, settings) {
    settings = normalizeSettings(settings);
    var sol = solveSlots(roster, settings), plan = sol.plan;
    var byType = plan.types.map(function () { return []; }), rest = [], total = 0;
    sol.players.forEach(function (p, i) {
      var ti = sol.placed[i];
      if (ti >= 0) { byType[ti].push(p); total += val(p); } else rest.push(p);
    });
    var starters = [], open = {};
    if (isLegacy(settings)) LEGACY_TYPES.forEach(function (t) { open[t] = 0; }); // G/F leagues keep the {G,F,UTIL} shape
    plan.types.forEach(function (t, i) {
      for (var j = 0; j < plan.caps[i]; j++) starters.push({ slot: t, player: byType[i][j] || null });
      open[t] = plan.caps[i] - byType[i].length;
    });
    // Non-starters: OUT players go to IL first, then bench fills, overflow → IL.
    var ilCap = settings.il || 0, il = [], bench = [];
    rest.forEach(function (p) { if (il.length < ilCap && isOut(p)) il.push(p); else bench.push(p); });
    while (bench.length > settings.bench && il.length < ilCap) il.push(bench.pop());
    var ilHealthy = il.filter(function (p) { return !isOut(p); }).length;
    return { starters: starters, bench: bench, il: il, open: open, total: total, ilHealthy: ilHealthy };
  }

  function starterTotal(roster, settings) { return assignSlots(roster, settings).total; }

  /* What adding p to the roster does: { gain (starter value added), slot (type p
     starts at, or 'BENCH'), opens: true when it fills a slot that was open,
     upgrade: true when it pushes a starter to the bench }. O(states·types). */
  function addInfo(sol, p, settings) {
    var plan = sol.plan;
    if (!sol.dp) { // greedy fallback
      var bi = -1;
      plan.types.forEach(function (t, i) { if (sol.greedyUsed[i] < plan.caps[i] && canFill(p, t, settings) && (bi < 0 || SPECIFIC[t] > SPECIFIC[plan.types[bi]])) bi = i; });
      return bi < 0 ? { gain: 0, slot: 'BENCH', opens: false, upgrade: false } : { gain: val(p), slot: plan.types[bi], opens: true, upgrade: false };
    }
    var el = [];
    for (var i = 0; i < plan.types.length; i++) if (canFill(p, plan.types[i], settings)) el.push(i);
    var best = sol.base, bestS = -1, bestT = -1, dp = sol.dp;
    for (var s = 0; s < dp.length; s++) {
      var v0 = dp[s];
      if (v0 === -Infinity) continue;
      for (var j = 0; j < el.length; j++) {
        var ti = el[j];
        if (usedAt(plan, s, ti) >= plan.caps[ti]) continue;
        var v = v0 + weight(p, plan.types[ti]);
        if (v > best + 1e-9) { best = v; bestS = s; bestT = ti; }
      }
    }
    if (bestT < 0) return { gain: 0, slot: 'BENCH', opens: false, upgrade: false };
    var ns = bestS + plan.mult[bestT], filled = null;
    for (var q = 0; q < plan.types.length; q++) {
      if (usedAt(plan, ns, q) > usedAt(plan, sol.baseState, q)) { if (q === bestT || filled == null) filled = q; }
    }
    var gain = Math.round(Math.max(0, best - sol.base) * 1e4) / 1e4; // drop the tie-break epsilons
    return filled != null
      ? { gain: gain, slot: plan.types[filled], opens: true, upgrade: false, placedAt: plan.types[bestT] }
      : { gain: gain, slot: plan.types[bestT], opens: false, upgrade: true, placedAt: plan.types[bestT] };
  }

  /* -------------------------------------------------- best available (VONA) */

  var INJ_FACTOR = { OUT: 0.55, O: 0.55, IR: 0.5, INJ: 0.6, SUS: 0.6, D: 0.8, DTD: 0.9, GTD: 0.9, Q: 0.92, QUESTIONABLE: 0.92, P: 0.97, PROBABLE: 0.97 };
  function injuryFactor(inj) {
    if (!inj) return 1;
    var k = String(inj).toUpperCase().replace(/[^A-Z]/g, '');
    if (INJ_FACTOR[k] != null) return INJ_FACTOR[k];
    if (k.indexOf('OUT') === 0) return INJ_FACTOR.OUT;
    if (k.indexOf('DAY') >= 0) return INJ_FACTOR.DTD;
    return 0.9;
  }
  function injuryShort(inj) {
    if (!inj) return '';
    var k = String(inj).toUpperCase();
    if (/OUT|^O$|IR/.test(k)) return 'OUT';
    if (/SUS/.test(k)) return 'SUS';
    if (/DAY|DTD|GTD/.test(k)) return 'GTD';
    if (/^Q|QUEST/.test(k)) return 'Q';
    if (/^P|PROB/.test(k)) return 'P';
    if (/^D|DOUBT/.test(k)) return 'D';
    return k.slice(0, 3);
  }

  // Which slot type p would occupy if added to roster (a slot type or 'BENCH').
  function filledSlot(roster, p, settings) {
    settings = normalizeSettings(settings);
    return addInfo(solveSlots(roster, settings), p, settings).slot;
  }

  function ordinal(n) { return ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth'][n] || (n + 'th'); }
  function fmt1(n) { return (Math.round(n * 10) / 10).toFixed(1); }

  /* Supply per slot type: how many of the top-N available players (board order
     as given) can fill each type. Returns { topN, left: {type: n} }. */
  function slotSupply(available, settings, topN) {
    settings = normalizeSettings(settings);
    var n = topN || 40, top = (available || []).slice(0, n), left = {};
    slotTypes(settings).forEach(function (t) {
      left[t] = t === 'UTIL' ? top.length : top.filter(function (p) { return canFill(p, t, settings); }).length;
    });
    return { topN: n, left: left };
  }

  /* Position pulse for the filter chips / run indicator.
     available: board order; recent: players taken in the last ~teams picks;
     all: every player (baseline share). Returns [{ slot, left, recent, run, scarce }]
     for each non-UTIL starter type. Run = that slot is going much faster than
     its share of the pool; scarce = well under its usual share of the top N. */
  function slotPulse(available, recent, all, settings, topN) {
    settings = normalizeSettings(settings);
    var n = topN || 40, sup = slotSupply(available, settings, n);
    var base = (all || available || []).slice(0, 150), rec = recent || [];
    return slotTypes(settings).filter(function (t) { return t !== 'UTIL'; }).map(function (t) {
      var share = base.length ? base.filter(function (p) { return canFill(p, t, settings); }).length / base.length : 0;
      var r = rec.filter(function (p) { return p && canFill(p, t, settings); }).length;
      var expected = Math.min(n, (available || []).length) * share;
      return {
        slot: t, left: sup.left[t], recent: r,
        run: rec.length >= 4 && r >= 3 && r >= 1.6 * rec.length * share,
        scarce: expected >= 1 && sup.left[t] <= Math.max(1, Math.floor(expected * 0.55))
      };
    });
  }

  /* Rank available players for my next pick.
     score = starter gain now (fills an open slot = full value; upgrade = the
     difference) + 0.6 x (gain now − gain from the best player for the same slot
     still expected at my following pick) + scarcity bonus when the slot is open
     and its top-N supply is under the picks before my turn + ceiling bias,
     all x injury factor. Deterministic: ties break by value then id.
     opts: { picksUntilNext, nextPick, ceilingBias (0..1, default 0.35), limit, topN } */
  function mktKey(p) {
    if (p && typeof p.marketRank === 'number' && isFinite(p.marketRank)) return p.marketRank;
    if (p && typeof p.rank === 'number' && isFinite(p.rank)) return p.rank;
    return 1e6;
  }
  // P(a player at market position pos (0-based among the available) is taken
  // in the next k picks); market noise sd grows with depth (2 + 12% of rank).
  function probGone(pos, k, mk) {
    if (pos == null || !(k > 0)) return 0;
    var sd = 2 + 0.12 * Math.min(mk, 400), z = (k - 0.5 - pos) / sd;
    return 1 / (1 + Math.exp(-1.702 * z)); // logistic ≈ normal CDF
  }

  function bestAvailable(available, myRoster, settings, opts) {
    settings = normalizeSettings(settings);
    opts = opts || {};
    var bias = opts.ceilingBias == null ? 0.35 : opts.ceilingBias;
    var k = Math.max(0, opts.picksUntilNext == null ? settings.teams - 1 : opts.picksUntilNext);
    var roster = (myRoster || []).filter(Boolean);
    if (roster.length >= draftRounds(settings)) return [];
    var sol = solveSlots(roster, settings);
    var pool = (available || []).filter(Boolean).slice().sort(byValThenId);
    var topN = opts.topN || 40;
    var sup = slotSupply(pool, settings, topN);
    var cands = pool.slice(0, Math.max(60, (opts.limit || 3) * 4));
    // Who is gone before my next pick: the other teams draft by market (ADP),
    // not by our value, so when the board has market ranks the top-k by
    // market are removed and each candidate gets P(taken before my next pick).
    // Without market data: the old "others take the top-k by value".
    var hasMkt = pool.some(function (q) { return typeof q.marketRank === 'number' && isFinite(q.marketRank); });
    var mpos = null, later;
    if (hasMkt) {
      var byMkt = pool.slice().sort(function (x, y) { return mktKey(x) - mktKey(y) || byValThenId(x, y); });
      mpos = new Map(); byMkt.forEach(function (q, i) { mpos.set(q, i); });
      later = pool.filter(function (q) { return mpos.get(q) >= k; });
    } else later = pool.slice(k);
    // Bench depth: eligible roster players beyond each starting slot's count.
    var cover = {};
    sol.plan.types.forEach(function (t) {
      if (t === 'UTIL') return;
      var n = 0; roster.forEach(function (q) { if (canFill(q, t, settings)) n++; });
      cover[t] = Math.max(0, n - (settings.slots[t] || 0));
    });

    var bestLater = {}; // slot type -> top-2 [{gain, player}] (2nd is used when the candidate is the 1st)
    later.slice(0, 80).forEach(function (q) {
      var info = addInfo(sol, q, settings);
      var top = bestLater[info.slot] || (bestLater[info.slot] = []);
      top.push({ gain: info.gain, player: q });
      top.sort(function (x, y) { return y.gain - x.gain || byValThenId(x.player, y.player); });
      if (top.length > 2) top.length = 2;
    });

    var benchLine = later.length ? val(later[0]) : 0;
    var out = cands.map(function (p) {
      var info = addInfo(sol, p, settings), slot = info.slot, gain = info.gain;
      var top = bestLater[slot] || [];
      var ref = top[0] && top[0].player === p ? top[1] : top[0];
      var pGone = mpos ? probGone(mpos.get(p), k, mktKey(p)) : 1;
      var vona = (gain - (ref ? ref.gain : 0)) * pGone;
      var ceil = typeof p.ceiling === 'number' && isFinite(p.ceiling) ? p.ceiling : val(p);
      var upside = Math.max(0, ceil - val(p)) * 0.1 * bias;
      var supply = sup.left[slot] != null ? sup.left[slot] : null;
      var pressure = info.opens && slot !== 'UTIL' && supply != null ? Math.max(0, Math.min(1, (k + 1 - supply) / (k + 1))) : 0;
      var score, need = 0, needSlot = null;
      if (slot === 'BENCH') {
        var bv = typeof p.vorp === 'number' && isFinite(p.vorp) ? Math.max(0, p.vorp) * 0.05 : 0;
        score = 0.35 * Math.max(0, val(p) - benchLine * 0.9) + upside + val(p) * 0.01 + bv;
        // Prefer backups for thin slots: 4 C-eligibles already → a 5th C is worth less.
        sol.plan.types.forEach(function (t) { if (t !== 'UTIL' && canFill(p, t, settings)) { var nd = 1 / (1 + cover[t]); if (nd > need) { need = nd; needSlot = t; } } });
        score *= 0.3 + 0.7 * (needSlot ? need : 0.25);
      } else {
        // Half-weight on raw gain, full VONA: with market-aware pGone a player the
        // market leaves for my next pick shouldn't win on raw value alone
        // (offline 96-draft sim vs market bots: +2.8 starter pts over gain + 0.6·vona).
        score = 0.5 * gain + vona + 0.15 * pressure * gain + upside;
      }
      score *= injuryFactor(p.injury);
      if (!isFinite(score)) score = 0;
      return { player: p, slot: slot, gain: gain, vona: vona, score: score, opens: info.opens, upgrade: info.upgrade, supply: supply, pressure: pressure,
        pGone: pGone, depthFor: slot === 'BENCH' && needSlot && need >= 0.5 ? needSlot : null };
    });
    out.sort(function (a, b) { return b.score - a.score || byValThenId(a.player, b.player); });
    out = out.slice(0, opts.limit || 3);
    var a0 = assignSlots(roster, settings);
    // A pick can open a slot it can't play itself (PF-only Banchero lets Barnes
    // slide PF → C): report the player's own slot and who moves.
    out.forEach(function (r) {
      if (r.slot === 'BENCH' || canFill(r.player, r.slot, settings)) return;
      var a1 = assignSlots(roster.concat([r.player]), settings), own = null, mover = null;
      a1.starters.forEach(function (x) { if (x.player === r.player) own = x.slot; });
      a1.starters.forEach(function (x) {
        if (mover || x.slot !== r.slot || !x.player || x.player === r.player) return;
        if (!a0.starters.some(function (y) { return y.slot === r.slot && y.player === x.player; })) mover = x.player;
      });
      if (own) { r.ownSlot = own; r.mover = mover; }
    });
    out.forEach(function (r) { r.reason = reasonFor(r, a0, settings, opts, topN); });
    return out;
  }

  function reasonFor(r, a, settings, opts, topN) {
    var p = r.player;
    var ceil = typeof p.ceiling === 'number' && isFinite(p.ceiling) ? Math.round(p.ceiling) : null;
    var inj = injuryShort(p.injury);
    var parts;
    if (r.slot === 'BENCH') {
      parts = ['Starters set — best bench upside' + (ceil != null ? ' (ceiling ' + ceil + ')' : '') + (r.depthFor ? '; adds ' + r.depthFor + ' depth' : '')];
    } else {
      var filled = 0;
      a.starters.forEach(function (s) { if (s.slot === r.slot && s.player) filled++; });
      var head;
      if (r.ownSlot && r.ownSlot !== r.slot) head = 'Starts at ' + r.ownSlot + (r.mover ? '; ' + (r.mover.name || 'a teammate') + ' slides to your open ' + r.slot : '; fills your open ' + r.slot + ' by reshuffling');
      else if (r.upgrade) head = 'Upgrades your ' + r.slot + ' (+' + fmt1(r.gain) + ')';
      else if (r.slot === 'UTIL') head = 'Fills open UTIL slot';
      else {
        head = 'Fills open ' + r.slot + ' slot' + ((settings.slots[r.slot] || 0) > 1 ? ' (your ' + ordinal(filled + 1) + ' ' + r.slot + ')' : '');
        if (r.supply != null) head += '; ' + r.supply + ' ' + r.slot + '-eligible' + (r.supply === 1 ? '' : 's') + ' left in top ' + topN;
      }
      var tail = r.vona > 0.05
        ? '+' + fmt1(r.vona) + ' over the best ' + r.slot + ' likely left at ' + (opts.nextPick ? '#' + opts.nextPick : 'your next pick')
        : 'value holds — ' + r.slot + ' depth is deep';
      parts = [head, tail];
      if (r.pGone != null && r.pGone < 0.35 && typeof p.marketRank === 'number') parts.push('market #' + p.marketRank + ': likely still there next pick');
      if (ceil != null && ceil - val(p) >= 12) parts.push('ceiling ' + ceil);
    }
    if (inj) parts.push(inj === 'OUT' ? 'currently OUT' : inj + ' tag');
    return parts.join(' · ');
  }

  /* ------------------------------------------------------ balance warnings */

  /* ctx: { available, players (all, for starter-grade lines), picksUntilNext }
     Returns [{ level: 'danger'|'warn'|'info', text }] most severe first. */
  function balanceWarnings(myRoster, settings, ctx) {
    settings = normalizeSettings(settings);
    ctx = ctx || {};
    var roster = (myRoster || []).filter(Boolean);
    var a = assignSlots(roster, settings);
    var picksLeft = draftRounds(settings) - roster.length;
    var types = slotTypes(settings);
    var openTotal = 0; types.forEach(function (t) { openTotal += a.open[t] || 0; });
    var out = [];
    if (picksLeft <= 0) return out;

    if (openTotal > picksLeft) {
      out.push({ level: 'danger', text: picksLeft + ' pick' + (picksLeft === 1 ? '' : 's') + ' left for ' + openTotal + ' open starter slots' });
    }

    // Catch-up: open starter slots with the draft running out.
    var urgent = picksLeft - openTotal <= 2 || roster.length >= Math.ceil(draftRounds(settings) / 2);
    types.filter(function (t) { return t !== 'UTIL'; }).sort(function (x, y) { return (a.open[y] || 0) - (a.open[x] || 0); }).forEach(function (pos) {
      var open = a.open[pos];
      if (!open || !urgent) return;
      var filled = settings.slots[pos] - open;
      var text = settings.slots[pos] > 1
        ? 'Needs a ' + ordinal(filled + 1) + ' ' + pos + (open > 1 ? ' (' + open + ' ' + pos + ' slots open)' : '')
        : 'Catch-up: no ' + pos + ' yet';
      out.push({ level: picksLeft - openTotal <= 0 ? 'danger' : 'warn', text: text + ' · ' + picksLeft + ' pick' + (picksLeft === 1 ? '' : 's') + ' left' });
    });

    // Positional scarcity: starter-grade = top (teams x starter slots for pos) eligible by value.
    var avail = ctx.available || [];
    var all = ctx.players || avail;
    var k = ctx.picksUntilNext == null ? settings.teams - 1 : ctx.picksUntilNext;
    types.filter(function (t) { return t !== 'UTIL'; }).forEach(function (pos) {
      if (!a.open[pos]) return;
      var eligAll = all.filter(function (p) { return canFill(p, pos, settings); }).sort(byValThenId);
      // League-wide demand for this pool: the slot itself plus the narrower slots
      // it overlaps (G competes with PG/SG starters, F with SF/PF, F/C with SF/PF/F/C).
      var demand = 0;
      types.forEach(function (t) { if (t === pos || (SUBSLOTS[pos] || []).indexOf(t) >= 0) demand += settings.slots[t]; });
      var line = eligAll[Math.min(eligAll.length - 1, settings.teams * demand - 1)];
      if (!line) return;
      var grade = avail.filter(function (p) { return canFill(p, pos, settings) && val(p) >= val(line); }).length;
      if (grade === 0 && urgent) return; // already a catch-up line for this slot
      if (grade <= k) {
        out.push({ level: grade <= a.open[pos] + Math.floor(k / 3) ? 'warn' : 'info', text: pos + ' is drying up: ' + grade + ' starter-grade ' + pos + ' left, ' + k + ' picks before your turn' });
      }
    });

    // One-position-heavy bench (G/F leagues): more single-position players than they can start.
    if (isLegacy(settings)) ['G', 'F'].forEach(function (pos) {
      var other = pos === 'G' ? 'F' : 'G';
      var only = roster.filter(function (p) { var e = eligFor(p); return e[pos] && !e[other]; }).length;
      var cap = (settings.slots[pos] || 0) + (settings.slots.UTIL || 0);
      if (only > cap + 1) out.push({ level: 'info', text: (pos === 'G' ? 'Guard' : 'Forward') + '-heavy: ' + only + ' ' + pos + '-only players for ' + cap + ' startable ' + pos + '/UTIL slots' });
    });

    if (a.ilHealthy) out.push({ level: 'info', text: a.ilHealthy + ' healthy player' + (a.ilHealthy > 1 ? 's' : '') + ' past the bench — IL spots only hold injured players' });

    var rank = { danger: 0, warn: 1, info: 2 };
    out.sort(function (x, y) { return rank[x.level] - rank[y.level]; });
    return out;
  }

  /* ---------------------------------------------------------- cheat sheet */

  /* Rounds 1..N targets + by-slot tiers.
     ctx: { available (board order), settings, cur (pick on the clock),
            myPicks: [{ pick, round }] my remaining picks (Yahoo order or snake),
            made: [{ pick, round, player }] my picks so far, roster: [player], perRound }
     Returns { rounds: [{ round, pick, done, player?, targets: [{ player, need }] }],
               bySlot: [{ slot, tiers: [{ tier, players }] }] } */
  function cheatSheet(ctx) {
    var settings = normalizeSettings(ctx.settings);
    var avail = (ctx.available || []).filter(Boolean);
    var cur = ctx.cur || 1, per = ctx.perRound || 5;
    var a = assignSlots(ctx.roster || [], settings);
    var openTypes = slotTypes(settings).filter(function (t) { return t !== 'UTIL' && a.open[t] > 0; });
    var rounds = [];
    (ctx.made || []).forEach(function (m) { rounds.push({ round: m.round, pick: m.pick, done: true, player: m.player || null, name: m.name, targets: [] }); });
    (ctx.myPicks || []).forEach(function (m) {
      var idx = Math.max(0, m.pick - cur);
      // Players expected around this pick: others take ~ (pick − cur) first.
      var win = avail.slice(Math.max(0, idx - Math.floor(per / 2)), Math.max(0, idx - Math.floor(per / 2)) + per);
      rounds.push({ round: m.round, pick: m.pick, done: false, targets: win.map(function (p) {
        return { player: p, need: openTypes.filter(function (t) { return canFill(p, t, settings); }) };
      }) });
    });
    rounds.sort(function (x, y) { return x.pick - y.pick; });
    var bySlot = slotTypes(settings).filter(function (t) { return t !== 'UTIL'; }).map(function (t) {
      var list = avail.filter(function (p) { return canFill(p, t, settings); }).slice(0, ctx.perSlot || 10);
      var tiers = [];
      list.forEach(function (p) {
        var last = tiers[tiers.length - 1];
        if (!last || last.tier !== p.tier) tiers.push(last = { tier: p.tier, players: [] });
        last.players.push(p);
      });
      return { slot: t, open: a.open[t] || 0, tiers: tiers };
    });
    return { rounds: rounds, bySlot: bySlot };
  }

  // My remaining picks on the snake from `fromPick`: [{pick, round}].
  function myPicksSnake(settings, fromPick) {
    settings = normalizeSettings(settings);
    return picksForSlot(settings.mySlot, settings.teams, draftRounds(settings), fromPick || 1).map(function (p) { return { pick: p, round: roundOf(p, settings.teams) }; });
  }

  /* ------------------------------------------------------ Yahoo pick merge */

  /* Merge Yahoo draft results (truth) with locally tracked manual picks.
     yahoo:    { picks: [{pick, round, team_key, player_key, sleeperId|null, name, matchConfidence}], unmatched: [...] } | null
     manual:   [{ playerId, mine, at }] in the order they were marked
     ctx:      { settings, myTeamKey, overrides: {player_key: playerId}, playersById,
                 byYahooPid?: {yahooPid: playerId}, alias?: {sleeperId|playerId: playerId} }
               A Yahoo pick resolves by its player_key's Yahoo id first, then by
               sleeperId, then by a manual override; alias maps legacy Sleeper
               ids (saved picks, overrides) onto board ids.
     Returns {
       picks: [{ pick, round, slot, playerId|null, name, mine, source: 'yahoo'|'manual', confirmed, player_key?, team_key? }],
       unmatched: [{ pick, player_key, name, team_key }],
       confirmedManual: [playerId]   // manual picks Yahoo has now confirmed (caller prunes)
     } */
  function mergePicks(yahoo, manual, ctx) {
    ctx = ctx || {};
    var settings = normalizeSettings(ctx.settings);
    var overrides = ctx.overrides || {};
    var byId = ctx.playersById || {};
    var byYpid = ctx.byYahooPid || {}, alias = ctx.alias || null;
    var canon = function (x) { if (x == null || x === '') return null; x = String(x); return alias && alias[x] != null ? String(alias[x]) : x; };
    var out = [], unmatched = [], seen = {}, confirmed = [];

    var ypicks = (yahoo && yahoo.picks ? yahoo.picks : []).filter(function (p) { return p && p.pick > 0; })
      .slice().sort(function (a, b) { return a.pick - b.pick; });
    var lastPick = 0;
    ypicks.forEach(function (yp) {
      if (seen['#' + yp.pick]) return; // duplicate pick number from a flaky poll
      seen['#' + yp.pick] = 1;
      var ypid = yahooPidFromKey(yp.player_key);
      var id = (ypid != null && byYpid[ypid] != null) ? String(byYpid[ypid])
        : yp.sleeperId != null && yp.sleeperId !== '' ? canon(yp.sleeperId)
        : (overrides[yp.player_key] != null ? canon(overrides[yp.player_key]) : null);
      if (id && seen[id]) id = null; // same player twice → treat the later one as unmatched
      if (id) seen[id] = 1;
      var row = {
        pick: yp.pick, round: yp.round || roundOf(yp.pick, settings.teams), slot: slotForPick(yp.pick, settings.teams),
        playerId: id, name: (id && byId[id] && byId[id].name) || yp.name || 'Unknown player',
        mine: !!(ctx.myTeamKey && yp.team_key === ctx.myTeamKey), source: 'yahoo', confirmed: true,
        player_key: yp.player_key, team_key: yp.team_key
      };
      if (!id) unmatched.push({ pick: yp.pick, player_key: yp.player_key, name: row.name, team_key: yp.team_key });
      out.push(row);
      lastPick = Math.max(lastPick, yp.pick);
    });

    // Server-reported unmatched entries not already represented by a pick.
    (yahoo && yahoo.unmatched ? yahoo.unmatched : []).forEach(function (u) {
      if (!u || !u.player_key || overrides[u.player_key] != null) return;
      var upid = yahooPidFromKey(u.player_key);
      if (upid != null && byYpid[upid] != null) return; // board knows this Yahoo id
      if (unmatched.some(function (x) { return x.player_key === u.player_key; })) return;
      if (out.some(function (x) { return x.player_key === u.player_key && x.playerId; })) return;
      unmatched.push({ pick: u.pick || null, player_key: u.player_key, name: (u.name && u.name.full) || u.name || 'Unknown player', team_key: u.team_key || null });
    });

    // With Yahoo's remaining order (keepers / traded picks), pending manual
    // picks fill the next open Yahoo slots, owner included; otherwise they
    // follow Yahoo's last pick on the snake.
    var open = openSlots(yahoo);
    var n = lastPick, oi = 0;
    open.forEach(function (o) { n = Math.max(n, o.pick); });
    if (!open.length) n = lastPick;
    (manual || []).forEach(function (m) {
      if (!m || m.playerId == null) return;
      var id = canon(m.playerId);
      if (seen[id]) { if (yahoo) confirmed.push(id); return; }
      seen[id] = 1;
      var o = open[oi++], pk;
      if (o) pk = o.pick; else { n++; pk = n; }
      var row = {
        pick: pk, round: (o && o.round) || roundOf(pk, settings.teams), slot: slotForPick(pk, settings.teams),
        playerId: id, name: (byId[id] && byId[id].name) || m.name || id,
        mine: !!m.mine, source: 'manual', confirmed: !yahoo
      };
      if (o && o.team_key) row.team_key = o.team_key;
      out.push(row);
    });

    out.sort(function (a, b) { return a.pick - b.pick; });
    return { picks: out, unmatched: unmatched, confirmedManual: confirmed };
  }

  // Yahoo's unfilled pick slots in pick order: [{pick, round, team_key}].
  function openSlots(yahoo) {
    if (!yahoo || !Array.isArray(yahoo.order)) return [];
    var seenPick = {};
    (yahoo.picks || []).forEach(function (p) { if (p && p.pick) seenPick[p.pick] = 1; });
    // seenPick also drops a slot Yahoo listed twice.
    return yahoo.order.filter(function (o) { return o && o.pick > 0 && !seenPick[o.pick] && (seenPick[o.pick] = 1); })
      .slice().sort(function (a, b) { return a.pick - b.pick; });
  }

  /* Who is on the clock according to Yahoo (draft order with team_key per
     pick), so keepers and traded picks are right. pending = local picks not
     yet confirmed by Yahoo (they occupy the next open slots).
     Returns null when Yahoo gave no order (caller falls back to the snake), else
     { cur, round, teamKey, total, done, onMe, myNext, myAfter, myNextRound,
       awayN (picks before my next), gapNow (others' picks between now and my
       following pick when I'm up), gapNext (others' picks between my next two) } */
  function yahooClock(yahoo, myTeamKey, pending) {
    var open = openSlots(yahoo);
    var picks = (yahoo && yahoo.picks) || [];
    // No open slots listed: only trust that as "draft over" when Yahoo says
    // postdraft; otherwise Yahoo just didn't send future slots → snake fallback.
    if (!open.length && !(yahoo && yahoo.status === 'postdraft' && picks.length)) return null;
    var total = 0;
    picks.forEach(function (p) { if (p && p.pick > total) total = p.pick; });
    open.forEach(function (o) { if (o.pick > total) total = o.pick; });
    var k = Math.max(0, pending || 0);
    var rest = open.slice(k);
    if (!rest.length) return { cur: total + 1, round: null, teamKey: null, total: total, done: true, onMe: false, myNext: null, myAfter: null, myNextRound: null, awayN: null, gapNow: 0, gapNext: 0 };
    var now = rest[0];
    var mineIdx = [];
    rest.forEach(function (o, i) { if (myTeamKey && o.team_key === myTeamKey) mineIdx.push(i); });
    var i0 = mineIdx.length ? mineIdx[0] : -1, i1 = mineIdx.length > 1 ? mineIdx[1] : -1;
    return {
      cur: now.pick, round: now.round || null, teamKey: now.team_key || null, total: total, done: false,
      onMe: !!myTeamKey && now.team_key === myTeamKey,
      myNext: i0 >= 0 ? rest[i0].pick : null, myAfter: i1 >= 0 ? rest[i1].pick : null,
      myNextRound: i0 >= 0 ? rest[i0].round || null : null,
      awayN: i0 >= 0 ? i0 : null,
      gapNow: i0 === 0 ? (i1 >= 0 ? i1 - 1 : 0) : 0,
      gapNext: i0 >= 0 && i1 >= 0 ? i1 - i0 - 1 : 0
    };
  }

  /* Auction leagues: Yahoo settings or draft results say so. The board has no
     nomination/bidding model yet, so the page drops to manual mode. */
  function isAuction(league, yahoo) {
    if (league && (league.is_auction_draft === true || league.is_auction_draft === 1 || league.is_auction_draft === '1' ||
        /auction/i.test(String(league.draft_type || '')) || (league.settings && (league.settings.is_auction_draft === true || /auction/i.test(String(league.settings.draft_type || '')))))) return true;
    return !!(yahoo && (yahoo.auction === true || (yahoo.picks || []).some(function (p) { return p && p.cost != null; })));
  }

  /* ---------------------------------------------------------- pick timer */
  var DEFAULT_PICK_SECONDS = 60;
  function normalizeTimerSeconds(v) {
    var n = parseInt(v, 10);
    if (!isFinite(n) || n < 0) return DEFAULT_PICK_SECONDS;
    return Math.min(600, n); // 0 = off
  }
  // { running, left (whole seconds), level: 'off'|'idle'|'ok'|'warn'|'urgent'|'expired', text }
  function timerState(startedAt, seconds, now) {
    seconds = normalizeTimerSeconds(seconds);
    if (!seconds) return { running: false, left: 0, level: 'off', text: '' };
    if (!startedAt) return { running: false, left: seconds, level: 'idle', text: fmtClock(seconds) };
    var left = Math.ceil((startedAt + seconds * 1000 - now) / 1000);
    if (left <= 0) return { running: true, left: 0, level: 'expired', text: '0:00' };
    var level = left <= 10 ? 'urgent' : left <= Math.max(15, Math.round(seconds / 3)) ? 'warn' : 'ok';
    return { running: true, left: left, level: level, text: fmtClock(left) };
  }
  // Start time for the clock on `pick` after a reload: the saved one when it
  // is for the same league + pick and still plausible, else null (start now).
  // `saved` is one {leagueKey, pick, startedAt} or a list of them (a reload
  // briefly renders the local board first, so several picks get recorded).
  function restoreTimerStart(saved, leagueKey, pick, now, seconds) {
    var list = Array.isArray(saved) ? saved : saved ? [saved] : [];
    var hit = null;
    list.forEach(function (e) { if (e && e.leagueKey === (leagueKey || null) && e.pick === pick) hit = e; });
    if (!hit) return null;
    var t = Number(hit.startedAt);
    if (!isFinite(t) || t <= 0 || t > now) return null;
    // Older than the pick time plus a grace minute → stale (draft paused / left open).
    return now - t <= (normalizeTimerSeconds(seconds) + 60) * 1000 ? t : null;
  }
  // Add/replace the running clock for (leagueKey, pick); keeps the newest few.
  function rememberTimerStart(saved, leagueKey, pick, startedAt) {
    var list = (Array.isArray(saved) ? saved : saved ? [saved] : []).filter(function (e) {
      return e && !(e.leagueKey === (leagueKey || null) && e.pick === pick);
    });
    if (startedAt > 0) list.push({ leagueKey: leagueKey || null, pick: pick, startedAt: startedAt });
    return list.slice(-4);
  }
  function fmtClock(s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  /* ----------------------------------------------------- yahoo league map */

  // Yahoo roster_positions → settings.slots/bench. Accepts [{position,count}],
  // ['G','G',...] or {G:2,...}. PG/SG/SF/PF/C/F-C make it a position-aware
  // league; unknown starter positions count as UTIL.
  function settingsFromYahoo(league, myTeamKey, teams, prev) {
    var s = normalizeSettings(prev);
    if (!league) return s;
    var num = parseInt(league.num_teams, 10);
    if (num > 1) s.teams = Math.min(20, num);
    var rp = league.roster_positions;
    // An empty list ([] or {}) means Yahoo didn't send positions: keep current settings.
    if (rp && (Array.isArray(rp) ? rp.length : Object.keys(rp).length)) {
      var counts = {};
      if (Array.isArray(rp)) rp.forEach(function (x) {
        var pos = typeof x === 'string' ? x : (x.position || x.roster_position && x.roster_position.position);
        var c = typeof x === 'string' ? 1 : parseInt(x.count || (x.roster_position && x.roster_position.count) || 1, 10);
        if (pos) counts[pos] = (counts[pos] || 0) + c;
      });
      else Object.keys(rp).forEach(function (k) { counts[k] = parseInt(rp[k], 10) || 0; });
      // Yahoo names → slot types: Util → UTIL, F/C → FC, IL/IL+/IR → il, BN → bench.
      var slots = {}, bench = 0, il = 0, unknown = 0;
      Object.keys(counts).forEach(function (k0) {
        var k = String(k0).toUpperCase().replace(/\s+/g, '');
        var n = counts[k0] || 0;
        if (k === 'BN') { bench += n; return; }
        if (k === 'IL' || k === 'IL+' || k === 'IR' || k === 'NA') { if (k !== 'NA') il += n; return; }
        if (k === 'UTIL' || k === 'UTILITY') k = 'UTIL';
        else if (k === 'F/C' || k === 'C/F') k = 'FC';
        if (SLOT_TYPES.indexOf(k) < 0) { unknown += n; return; }
        slots[k] = (slots[k] || 0) + n;
      });
      if (unknown) slots.UTIL = (slots.UTIL || 0) + unknown; // unknown starter slots: anyone can fill
      var total = 0; Object.keys(slots).forEach(function (k) { total += slots[k]; });
      if (total > 0) {
        if (hasPosSlots(slots)) {
          var ps = {}; SLOT_TYPES.forEach(function (t) { if (slots[t]) ps[t] = Math.min(6, slots[t]); });
          s.slots = ps;
        } else s.slots = { G: Math.min(6, slots.G || 0), F: Math.min(6, slots.F || 0), UTIL: Math.min(6, slots.UTIL || 0) };
      }
      s.bench = Math.min(15, bench);
      s.il = Math.min(5, il);
      s.rounds = undefined; // re-derive from Yahoo's roster (IL not drafted); Yahoo's pick list governs once live
    }
    if (myTeamKey && Array.isArray(teams)) {
      var mine = teams.filter(function (t) { return t.team_key === myTeamKey; })[0];
      var dp = mine && parseInt(mine.draft_position, 10);
      if (dp >= 1 && dp <= s.teams) s.mySlot = dp;
    }
    return normalizeSettings(s);
  }

  /* Has Yahoo told us where I pick? Live (connected, non-auction) leagues only:
     my team's draft_position, my team_key in Yahoo's published pick order, or
     a Yahoo pick already credited to me. */
  function yahooSlotKnown(o) {
    o = o || {};
    if (!o.live || !o.myTeamKey) return false;
    var n = (o.settings && o.settings.teams) || 0;
    var mine = (o.teams || []).filter(function (t) { return t && t.team_key === o.myTeamKey; })[0];
    var dp = mine && parseInt(mine.draft_position, 10);
    if (dp >= 1 && (!n || dp <= n)) return true;
    if (yahooOrderSlot(o.yahoo, o.myTeamKey, n)) return true;
    return (o.picks || []).some(function (p) { return p && p.source === 'yahoo' && p.mine; });
  }

  /* My round-1 pick in Yahoo's published order (= my draft slot), or null. */
  function yahooOrderSlot(yahoo, myTeamKey, teams) {
    if (!yahoo || !Array.isArray(yahoo.order) || !myTeamKey) return null;
    var best = null;
    yahoo.order.forEach(function (x) {
      var p = x && parseInt(x.pick, 10);
      if (x && x.team_key === myTeamKey && p >= 1 && (!teams || p <= teams) && (best == null || p < best)) best = p;
    });
    return best;
  }

  /* "Which pick are you?" control. mode: 'yahoo' = synced (no chips), 'pick' =
     chips open, 'chosen' = collapsed with a Change button. chips = 1..teams. */
  function slotPickerView(settings, o) {
    o = o || {};
    var st = normalizeSettings(settings), chips = [];
    for (var i = 1; i <= st.teams; i++) chips.push(i);
    var mode = o.yahooKnown ? 'yahoo' : (o.chosen && !o.open ? 'chosen' : 'pick');
    return { mode: mode, slot: st.mySlot, teams: st.teams, chips: mode === 'pick' ? chips : [] };
  }

  /* --------------------------------------------------------- persistence */

  function storageKey(leagueKey) { return STORAGE_PREFIX + (leagueKey || 'manual'); }

  function emptyState(leagueKey, settings) {
    return { v: STATE_VERSION, leagueKey: leagueKey || null, settings: normalizeSettings(settings), settingsSource: null, slotChosen: false, manual: [], overrides: {}, yahoo: null, updatedAt: 0 };
  }

  function serializeState(st) {
    return JSON.stringify({
      v: STATE_VERSION,
      leagueKey: st.leagueKey || null,
      settings: normalizeSettings(st.settings),
      settingsSource: st.settingsSource || null,
      slotChosen: !!st.slotChosen,
      manual: (st.manual || []).filter(function (m) { return m && m.playerId != null; })
        .map(function (m) { return { playerId: String(m.playerId), mine: !!m.mine, at: m.at || 0, name: m.name || undefined }; }),
      overrides: st.overrides || {},
      yahoo: st.yahoo ? { status: st.yahoo.status, picks: st.yahoo.picks || [], unmatched: st.yahoo.unmatched || [], polledAt: st.yahoo.polledAt || null } : null,
      updatedAt: st.updatedAt || Date.now()
    });
  }

  // Never throws: corrupt / foreign / older data yields a fresh state.
  function deserializeState(raw, leagueKey, defaults) {
    var fresh = emptyState(leagueKey, defaults);
    if (!raw) return fresh;
    var o;
    try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return fresh; }
    if (!o || typeof o !== 'object' || o.v !== STATE_VERSION) return fresh;
    if ((o.leagueKey || null) !== (leagueKey || null)) return fresh;
    return {
      v: STATE_VERSION,
      leagueKey: leagueKey || null,
      settings: normalizeSettings(o.settings || defaults),
      // 'user' = edited in the League dialog (kept); anything else follows the league profile / Yahoo.
      settingsSource: o.settingsSource === 'user' ? 'user' : null,
      slotChosen: o.slotChosen === true,
      manual: Array.isArray(o.manual) ? o.manual.filter(function (m) { return m && m.playerId != null; }).map(function (m) { return { playerId: String(m.playerId), mine: !!m.mine, at: m.at || 0, name: m.name }; }) : [],
      overrides: o.overrides && typeof o.overrides === 'object' ? o.overrides : {},
      yahoo: o.yahoo && Array.isArray(o.yahoo.picks) ? o.yahoo : null,
      updatedAt: o.updatedAt || 0
    };
  }

  /* ---------------------------------------------------------- polling */

  var POLL_MS = 4000;
  // Delay before the next poll after `failures` consecutive errors (0 = healthy).
  function pollDelay(failures) {
    if (!failures) return POLL_MS;
    return Math.min(30000, POLL_MS * Math.pow(2, failures));
  }
  // Hidden tab: during a live Yahoo draft keep polling (slower) so the "your
  // pick" title countdown / beep still fires while the user sits in Yahoo's
  // draft room; otherwise pause until the tab is visible again.
  var HIDDEN_POLL_MS = 10000;
  function pollPlan(hidden, yahooStatus, failures) {
    var d = pollDelay(failures);
    if (!hidden) return { run: true, delay: d };
    if (yahooStatus !== 'drafting') return { run: false, delay: d };
    return { run: true, delay: Math.max(d, HIDDEN_POLL_MS) };
  }

  function agoText(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return 'just now';
    var s = Math.floor(ms / 1000);
    if (s < 2) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
  }

  /* ------------------------------------------------------------ search */

  function normName(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }

  function matchesQuery(p, q) {
    q = normName(q);
    if (!q) return true;
    var hay = normName(p.name) + ' ' + normName(p.team);
    return q.split(' ').every(function (t) { return hay.indexOf(t) >= 0; });
  }

  // Board filter: 'ALL' | 'G' | 'F' | 'UTIL' (UTIL = everyone eligible for UTIL, i.e. all).
  // Board filter: 'ALL' or a slot type (UTIL = everyone). With settings, uses
  // that league's eligibility; without, G/F/UTIL use the model's elig.
  function matchesPos(p, pos, settings) {
    if (!pos || pos === 'ALL' || pos === 'UTIL') return true;
    if (settings) return canFill(p, pos, normalizeSettingsCached(settings));
    if (LEGACY_TYPES.indexOf(pos) >= 0) return !!eligFor(p)[pos];
    return !!slotElig(p).slots[pos];
  }
  var nsCache = { src: null, out: null };
  function normalizeSettingsCached(s) {
    if (nsCache.src !== s) { nsCache.src = s; nsCache.out = normalizeSettings(s); }
    return nsCache.out;
  }

  return {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS, STORAGE_PREFIX: STORAGE_PREFIX, POLL_MS: POLL_MS,
    HIGH_SCORE_SETTINGS: HIGH_SCORE_SETTINGS, SLOT_TYPES: SLOT_TYPES,
    normalizeSettings: normalizeSettings, starterCount: starterCount, rosterSize: rosterSize, draftRounds: draftRounds, totalPicks: totalPicks,
    isLegacy: isLegacy, slotTypes: slotTypes, settingsFromProfile: settingsFromProfile, profilePickSeconds: profilePickSeconds,
    roundOf: roundOf, slotForPick: slotForPick, snakeOrder: snakeOrder, picksForSlot: picksForSlot, nextPickFor: nextPickFor,
    eligFor: eligFor, posTokens: posTokens, slotElig: slotElig, canFill: canFill, displayPositions: displayPositions,
    yahooPosString: yahooPosString, playerKey: playerKey, yahooPidFromKey: yahooPidFromKey,
    assignSlots: assignSlots, starterTotal: starterTotal, filledSlot: filledSlot,
    injuryFactor: injuryFactor, injuryShort: injuryShort,
    bestAvailable: bestAvailable, balanceWarnings: balanceWarnings, slotSupply: slotSupply, slotPulse: slotPulse,
    cheatSheet: cheatSheet, myPicksSnake: myPicksSnake,
    mergePicks: mergePicks, settingsFromYahoo: settingsFromYahoo, yahooSlotKnown: yahooSlotKnown, yahooOrderSlot: yahooOrderSlot, slotPickerView: slotPickerView,
    openSlots: openSlots, yahooClock: yahooClock, isAuction: isAuction,
    DEFAULT_PICK_SECONDS: DEFAULT_PICK_SECONDS, normalizeTimerSeconds: normalizeTimerSeconds, timerState: timerState, restoreTimerStart: restoreTimerStart,
    rememberTimerStart: rememberTimerStart, pollPlan: pollPlan, HIDDEN_POLL_MS: HIDDEN_POLL_MS,
    probGone: probGone, mktKey: mktKey,
    storageKey: storageKey, emptyState: emptyState, serializeState: serializeState, deserializeState: deserializeState,
    pollDelay: pollDelay, agoText: agoText, normName: normName, matchesQuery: matchesQuery, matchesPos: matchesPos
  };
});
