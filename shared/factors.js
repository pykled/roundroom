// Shared player-signal primitives — the single home for the "form" (hot / cold),
// "step-up" (vacated volume from an injured teammate) and "role change" (usage
// delta) logic that trade-fit.js, weekly-score.js and trending-score.js each
// used to reimplement with slightly different thresholds. Everything here is a
// pure function usable from the browser (global `PocketFactors`) or node
// (`require('./factors.js')`).
//
// THRESHOLD RECONCILIATION (why these numbers, not an average of the three):
//
//   FORM_HOT / FORM_COLD = 1.2 / 0.8
//     The only discrete hot/cold line of the three lived in trade-fit; it is
//     symmetric (±20% off expectation) and already the most-tested, so it wins.
//     weekly-score's momentum multiplier clamps its ratio at the SAME 0.8 floor
//     (FORM_COLD) — that lower bound is now sourced from here instead of a local
//     copy. weekly-score keeps a 1.25 ceiling on the UPSIDE of its clamp because
//     its factor is a momentum boost (start-him signal), not the regression
//     nudge formSignal returns; the two multipliers point in opposite directions
//     on purpose, so only the shared classification thresholds are unified, not
//     the multiplier itself.
//
//   MIN_BASELINE = 5 pts/game
//     Below ~5 projected points a game the recent-vs-expected ratio is noise.
//     trade-fit's formSignal already floored at 5 (FORM_MIN_PROJ) and trending's
//     form component divided by max(proj, 5); identical value, now one constant.
//
//   STEP_UP_MIN_SHARE = 0.15  (+ every-down snap qualifier 0.10 share / 0.60 snaps)
//     weekly-score and trade-fit both treated a 15% season touch share as the
//     line for "this teammate carried real volume." weekly-score additionally
//     counted an every-down player (≥60% snaps) at a 10% share; that rule is the
//     more correct one (a bell-cow-adjacent back inherits work when the starter
//     sits) so it is adopted as canonical. This makes trade-fit's injury-implied
//     role signal very slightly more sensitive in the 10–15% share band; no
//     existing test crosses that band, and it never flips a hot ↔ cold label
//     (the injury path only ever raises a role-up, mult 1).
//
//   FORM_MULT = { hot: 0.95, cold: 1.05 }
//     The trade-value regression nudge: a hot player is priced at his peak (sell
//     high → count him as worth 5% less), a cold one at his trough (buy low →
//     5% more). Symmetric, halved for dynasty by the caller's opts.
var PocketFactors = (function () {
  'use strict';

  // ---- Form (hot / cold) ----------------------------------------------------
  var FORM_GAMES = 2;                 // recent games the discrete classifier compares
  var FORM_HOT = 1.2, FORM_COLD = 0.8;
  var FORM_MULT = { hot: 0.95, cold: 1.05 };
  var MIN_BASELINE = 5;               // baseline pts/game below which the ratio is noise

  // ---- Step-up (vacated volume from an injured same-position teammate) -------
  var STEP_UP_MIN_SHARE = 0.15, STEP_UP_SNAP_SHARE = 0.10, STEP_UP_MIN_SNAP = 0.60;
  var STEP_UP_PER_SHARE = 0.4;        // +10% for a vacated 25% share
  var STEP_UP_MAX_SHARE = 0.35, STEP_UP_MAX = 1.14;
  var STEP_UP_POS = { RB: 'carryShare', WR: 'tgtShare', TE: 'tgtShare' };
  // Statuses that count a teammate as unavailable. Canonical set = weekly-score's
  // (it included the trailing-dot 'Sus.' Sleeper sometimes appends); trade-fit's
  // old ROLE_OUT_STATUS lacked 'Sus.' and so silently ignored a suspended-with-dot
  // teammate. Unifying on the fuller set fixes that latent gap: a 'Sus.' teammate
  // now correctly raises trade-fit's role-up (mult 1) just like 'Sus' / 'Out'.
  var OUT_STATUS = { Out: 1, IR: 1, Doubtful: 1, PUP: 1, Sus: 1, 'Sus.': 1 };

  // ---- Role change (usage delta) --------------------------------------------
  var ROLE_SHARE_PP = 0.08;           // absolute share delta
  var ROLE_SHARE_RATIO = 1.25;        // relative share delta (down: 1 / 1.25)
  var ROLE_SNAP_PP = 0.10;            // corroborating snap-share move → 'high'
  var ROLE_MIN_SHARE = STEP_UP_MIN_SHARE;   // teammate's season share to count as vacated (same 0.15)
  var ROLE_MIN_VACATED = 0.15;        // summed vacated share for the injury signal to fire
  var ROLE_SHARE_KEY = { RB: 'carryShare', WR: 'tgtShare', TE: 'tgtShare' };   // QB → no role signal
  var ROLE_EPS = 1e-9;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function mean(a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; }
  function sharePct(v) { return Math.round(v * 100) + '%'; }
  function pctMult(mult) { var p = Math.round((mult - 1) * 100); return (p > 0 ? '+' : '') + p + '%'; }
  function statusWord(st) {
    var s = String(st).replace(/\.$/, '');   // tolerate Sleeper's trailing-dot 'Sus.'
    return s === 'IR' || s === 'PUP' ? 'on ' + s : s === 'Sus' ? 'suspended' : s.toLowerCase();
  }

  // ---- formSignal -----------------------------------------------------------
  // The discrete hot / cold classifier (moved verbatim from trade-fit).
  // games: actual points per game played, most recent first (byes / DNP omitted).
  // baseline: expected points per game (season projection ÷ 17, or a weekly mean).
  // opts.projGames: per-game projections for the compared games (same order);
  //   with 2+ finite entries their mean is the contemporaneous baseline instead
  //   of `baseline`. opts.dynasty halves the nudge. Returns null without two
  //   games or a readable baseline, else
  //   { label: 'hot'|'cold'|null, ratio, avg, proj, games, mult, baseline }.
  function formSignal(games, baseline, opts) {
    var used = (games || []).filter(function (g) { return typeof g === 'number' && isFinite(g); }).slice(0, FORM_GAMES);
    if (used.length < FORM_GAMES) return null;
    var baselineSource = 'season', base = baseline;
    var pg = ((opts && opts.projGames) || []).slice(0, FORM_GAMES).filter(function (g) { return typeof g === 'number' && isFinite(g); });
    if (pg.length >= 2) { baselineSource = 'weekly'; base = mean(pg); }
    if (!(base >= MIN_BASELINE)) return null;
    var avg = mean(used);
    var ratio = avg / base;
    var label = ratio >= FORM_HOT ? 'hot' : ratio <= FORM_COLD ? 'cold' : null;
    var mult = label ? FORM_MULT[label] : 1;
    if (label && opts && opts.dynasty) mult = 1 + (mult - 1) / 2;
    return { label: label, ratio: Math.round(ratio * 100) / 100, avg: Math.round(avg * 10) / 10, proj: Math.round(base * 10) / 10, games: used.length, mult: Math.round(mult * 1000) / 1000, baseline: baselineSource };
  }

  // ---- formDeviation --------------------------------------------------------
  // Signed, normalized recent-vs-expected deviation in [-1, +1] for one
  // observation (trending-score's per-week form component). Shares MIN_BASELINE
  // with formSignal so both floor a noisy projection at the same point.
  function formDeviation(actual, proj) {
    return clamp((actual - proj) / Math.max(proj, MIN_BASELINE), -1, 1);
  }

  // ---- vacatedVolume --------------------------------------------------------
  // Shared teammate selection + summed vacated touch share, used by both
  // stepUpFactor (turns it into a start-him boost) and roleSignal's injury path
  // (turns it into a role-up detection). teammatesOut: [{ id, name, status,
  // usage: { recent: { games }, season: { carryShare|tgtShare, snapPct, games } } }]
  // — same-team same-position players (the caller filters by team/position).
  // opts.recentWindow: completed weeks in the usage `recent` window (freshness
  // denominator). Returns { vacated, hits: [{ t, share, snap, fresh }] }.
  function vacatedVolume(teammatesOut, pos, opts) {
    var shareKey = STEP_UP_POS[pos];
    if (!shareKey || !teammatesOut || !teammatesOut.length) return { vacated: 0, hits: [] };
    var window = opts && opts.recentWindow > 0 ? opts.recentWindow : 1;
    var vacated = 0, hits = [];
    for (var i = 0; i < teammatesOut.length; i++) {
      var t = teammatesOut[i];
      if (!t || !OUT_STATUS[t.status]) continue;
      var sea = t.usage && t.usage.season, rec = t.usage && t.usage.recent;
      if (!sea || !(sea.games > 0)) continue;                       // never played → projections already exclude him
      var share = sea[shareKey] != null ? sea[shareKey] : 0;
      var snap = sea.snapPct != null ? sea.snapPct : 0;
      var volume = share >= STEP_UP_MIN_SHARE || (share >= STEP_UP_SNAP_SHARE && snap >= STEP_UP_MIN_SNAP);
      if (!volume) continue;                                        // depth piece, no real volume to inherit
      var fresh = clamp(((rec && rec.games) || 0) / window, 0, 1);
      if (fresh === 0) continue;                                    // out 2+ weeks: role already re-projected
      vacated += share * fresh;
      hits.push({ t: t, share: share, snap: snap, fresh: fresh });
    }
    return { vacated: vacated, hits: hits };
  }

  // ---- stepUpFactor ---------------------------------------------------------
  // Vacated volume → a start-him multiplier for the healthy player behind an
  // injured teammate (weekly-score's public form). recentWindow via opts.
  // Returns { mult, label, vacated?, teammates?, detail, source }.
  function stepUpFactor(teammatesOut, pos, opts) {
    if (!STEP_UP_POS[pos]) return { mult: 1, label: 'Step-up', detail: 'No step-up rule for ' + pos, source: 'neutral' };
    if (!teammatesOut || !teammatesOut.length) return { mult: 1, label: 'Step-up', detail: 'No injured starters at ' + pos + ' on this team', source: 'neutral' };
    var vv = vacatedVolume(teammatesOut, pos, opts);
    if (!vv.hits.length) return { mult: 1, label: 'Step-up', detail: 'Injured teammates were not carrying real volume', source: 'neutral' };
    var parts = vv.hits.map(function (h) {
      var t = h.t;
      var statusTxt = (t.status === 'IR' || t.status === 'PUP') ? 'on ' + t.status : String(t.status).toLowerCase();
      return (t.name || t.id) + ' ' + statusTxt + ' (' + Math.round(h.share * 100) + '% of ' + (pos === 'RB' ? 'carries' : 'targets') + ', ' + Math.round(h.snap * 100) + '% snaps' + (h.fresh < 1 ? ', ' + Math.round(h.fresh * 100) + '% weight — missed last week too' : '') + ')';
    });
    var mult = Math.min(STEP_UP_MAX, 1 + Math.min(vv.vacated, STEP_UP_MAX_SHARE) * STEP_UP_PER_SHARE);
    return {
      mult: mult, label: 'Step-up', vacated: vv.vacated, teammates: vv.hits.map(function (h) { return h.t; }),
      detail: parts.join(' · ') + ' — vacated volume (' + pctMult(mult) + ')',
      source: 'live',
    };
  }

  // ---- roleSignal -----------------------------------------------------------
  // A season projection is effectively preseason, so a player who just took over
  // a backfield reads "hot" all year. roleSignal detects the change (a usage
  // jump, or an injured teammate's vacated share) so the caller can swap a
  // hot/cold label for a role chip. Moved verbatim from trade-fit; the injury
  // path now shares vacatedVolume with stepUpFactor.
  // usage: one /api/recent-stats player { recent, season, prior? }. teammatesOut:
  // [{ id, name, status, usage }] same team + position (self excluded). opts:
  // { recentWindow (1–2), dynasty }. Returns null without a signal, else
  // { label: 'up'|'down', confidence: 'high'|'med', source: 'usage'|'injury',
  //   volRatio, share, sharePrev, snap, snapPrev, vacated, teammates, text, hold? }.
  function roleSignal(usage, teammatesOut, pos, opts) {
    var shareKey = ROLE_SHARE_KEY[pos];
    if (!shareKey || !usage) return null;
    var dynasty = !!(opts && opts.dynasty);
    var rec = usage.recent;
    var prev = usage.prior && usage.prior.games > 0 ? usage.prior : usage.season;
    var noun = pos === 'RB' ? 'Carry' : 'Target';

    if (rec && prev && rec.games >= 1 && prev.games >= 1 && rec[shareKey] != null && prev[shareKey] != null) {
      var r = rec[shareKey], p = prev[shareKey];
      var up = r - p >= ROLE_SHARE_PP - ROLE_EPS && (p > 0 ? r / p >= ROLE_SHARE_RATIO - ROLE_EPS : r >= ROLE_SHARE_PP);
      var down = p - r >= ROLE_SHARE_PP - ROLE_EPS && r / p <= 1 / ROLE_SHARE_RATIO + ROLE_EPS;
      if (up || down) {
        var haveSnap = rec.snapPct != null && prev.snapPct != null;
        var snapMove = haveSnap ? rec.snapPct - prev.snapPct : 0;
        var high = up ? snapMove >= ROLE_SNAP_PP - ROLE_EPS : snapMove <= -ROLE_SNAP_PP + ROLE_EPS;
        var text = noun + ' share ' + sharePct(p) + ' → ' + sharePct(r) + ' over ' + (rec.games >= 2 ? 'the last ' + rec.games + ' weeks' : 'the last week') +
          (haveSnap ? ' (snaps ' + sharePct(prev.snapPct) + ' → ' + sharePct(rec.snapPct) + ')' : '') +
          (rec.games === 1 ? ' — 1 game of evidence' : '');
        var sig = { label: up ? 'up' : 'down', confidence: high ? 'high' : 'med', source: 'usage', volRatio: p > 0 ? r / p : 1, share: r, sharePrev: p, snap: rec.snapPct, snapPrev: prev.snapPct, vacated: 0, teammates: [], text: text };
        if (dynasty && up) sig.hold = true;
        return sig;
      }
    }

    // Injury-implied: a same-position teammate who played recently and is now out
    // — his absence is in no projection or box score yet (mirrors stepUpFactor).
    var vv = vacatedVolume(teammatesOut, pos, opts);
    var vacated = vv.vacated;
    var mates = vv.hits.map(function (h) { return { id: h.t.id, name: h.t.name, status: h.t.status, share: h.share, fresh: h.fresh }; });
    var parts = vv.hits.map(function (h) {
      return (h.t.name || h.t.id) + ' ' + statusWord(h.t.status) + ' (' + sharePct(h.share) + ' of ' + (pos === 'RB' ? 'carries' : 'targets') + ', played ' + (h.fresh < 1 ? 'recently' : 'last week') + ')';
    });
    if (vacated >= ROLE_MIN_VACATED - ROLE_EPS) {
      var t2 = parts.join(' · ') + (dynasty ? ' — temporary if he returns; hold, don\'t chase' : '');
      var s2 = { label: 'up', confidence: 'med', source: 'injury', volRatio: 1, share: rec && rec[shareKey] != null ? rec[shareKey] : null, sharePrev: prev && prev[shareKey] != null ? prev[shareKey] : null, snap: rec && rec.snapPct != null ? rec.snapPct : null, snapPrev: prev && prev.snapPct != null ? prev.snapPct : null, vacated: vacated, teammates: mates, text: t2 };
      if (dynasty) s2.hold = true;
      return s2;
    }
    return null;
  }

  return {
    formSignal: formSignal,
    formDeviation: formDeviation,
    vacatedVolume: vacatedVolume,
    stepUpFactor: stepUpFactor,
    roleSignal: roleSignal,
    clamp: clamp,
    mean: mean,
    // thresholds (single source of truth; re-exported by the three consumers)
    FORM_GAMES: FORM_GAMES,
    FORM_HOT: FORM_HOT,
    FORM_COLD: FORM_COLD,
    FORM_MULT: FORM_MULT,
    MIN_BASELINE: MIN_BASELINE,
    STEP_UP_MIN_SHARE: STEP_UP_MIN_SHARE,
    STEP_UP_SNAP_SHARE: STEP_UP_SNAP_SHARE,
    STEP_UP_MIN_SNAP: STEP_UP_MIN_SNAP,
    STEP_UP_PER_SHARE: STEP_UP_PER_SHARE,
    STEP_UP_MAX_SHARE: STEP_UP_MAX_SHARE,
    STEP_UP_MAX: STEP_UP_MAX,
    STEP_UP_POS: STEP_UP_POS,
    OUT_STATUS: OUT_STATUS,
    ROLE_SHARE_PP: ROLE_SHARE_PP,
    ROLE_SHARE_RATIO: ROLE_SHARE_RATIO,
    ROLE_SNAP_PP: ROLE_SNAP_PP,
    ROLE_MIN_SHARE: ROLE_MIN_SHARE,
    ROLE_MIN_VACATED: ROLE_MIN_VACATED,
    ROLE_SHARE_KEY: ROLE_SHARE_KEY,
  };
})();

if (typeof module !== 'undefined') module.exports = PocketFactors;
