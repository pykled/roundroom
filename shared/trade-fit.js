// Trade fit — pure functions shared by trade.html (browser) and
// scripts/test-trade-fit.js (node). Everything here adjusts the blended VORP
// the Trade page already builds (computeVORP → rescaleVORP → blendWithMarket)
// for things that number alone can't see:
//
//   leagueFormat     superflex / 2-QB, dynasty vs redraft, PPR, team count
//   injuryMult       season-long discount for a player's current injury status
//   ageMult          dynasty-only age curve per position (applied to the VORP
//                    half of the blend; FantasyCalc dynasty values already carry age)
//   slotFactor       would this player START for this roster, or sit? A 7th WR
//                    is worth far less to you than a 2nd WR even at equal VORP
//   seasonContext    week + record → buy / sell / hold lean
//   formSignal       last 2 games vs season projection → hot (sell high) /
//                    cold (buy low); ±5% regression-to-the-mean nudge
//   playoffSOS       opponents in the fantasy playoff weeks ranked by fantasy
//                    points allowed to the position → easy +5% … hard −5%
//
// Superflex note: the base pipeline is ALREADY superflex-aware in two places —
// computeVORP counts SUPER_FLEX as a second QB starter slot (replacement QB
// moves from QB12 to QB24 in a 12-team league), and /api/market-values
// requests FantasyCalc's 2-QB list (numQbs=2), where QB1 ≈ RB1 instead of
// ≈ ½ RB1. leagueFormat() is the single source of truth for that detection so
// the market fetch, the VORP slots and the UI chip can't disagree.
var TradeFit = (function () {
  'use strict';

  var Lineup = (typeof LineupOptimizer !== 'undefined') ? LineupOptimizer
    : (typeof require === 'function' ? require('./lineup.js') : null);

  var SKILL = { QB: 1, RB: 1, WR: 1, TE: 1 };

  // ---- League format ------------------------------------------------------
  // league: /api/league/:id payload (or any object with roster_positions,
  // scoring_settings, settings, total_rosters). Missing fields fall back to a
  // 1-QB PPR redraft so manual mode can pass a synthetic object.
  function leagueFormat(league) {
    league = league || {};
    var positions = Array.isArray(league.roster_positions) ? league.roster_positions : [];
    var qbSlots = 0, sfSlots = 0;
    positions.forEach(function (p) {
      if (p === 'QB') qbSlots += 1;
      else if (p === 'SUPER_FLEX') sfSlots += 1;
    });
    var settings = league.settings || {};
    // Sleeper settings.type: 0 redraft, 1 keeper, 2 dynasty. Anything else
    // (e.g. 3, seen on a 32-team novelty league) is treated as redraft.
    var type = Number(settings.type);
    var sc = league.scoring_settings || {};
    var rec = sc.rec != null ? parseFloat(sc.rec) : 1;
    return {
      sf: sfSlots > 0 || qbSlots >= 2,
      qbStarters: qbSlots + sfSlots,        // how many QBs a team can start
      dynasty: type === 2,
      keeper: type === 1,
      ppr: rec >= 0.9 ? 1 : rec >= 0.3 ? 0.5 : 0,
      teams: Number(league.total_rosters) || (Array.isArray(league.rosters) ? league.rosters.length : 0) || 12,
      // Last regular-season week; trades after this matter only for the playoffs.
      regularSeasonWeeks: Number(settings.playoff_week_start) > 1 ? Number(settings.playoff_week_start) - 1 : 14,
    };
  }

  // Short label for the league bar: "Superflex · Dynasty · 14 teams"
  function formatLabel(fmt) {
    var bits = [];
    bits.push(fmt.sf ? 'Superflex' : '1 QB');
    bits.push(fmt.dynasty ? 'Dynasty' : fmt.keeper ? 'Keeper' : 'Redraft');
    bits.push(fmt.ppr === 1 ? 'PPR' : fmt.ppr === 0.5 ? 'Half PPR' : 'Standard');
    return bits.join(' · ');
  }

  // ---- Injury discount ----------------------------------------------------
  // Season-long value lost to the CURRENT status. Sleeper statuses: Questionable,
  // Doubtful, Out, IR, PUP, Sus, NA, COV, DNR. Moderate on purpose: the 30%
  // FantasyCalc share of the blend already prices injuries in, so these only
  // correct the projection-driven 70%. Dynasty discounts are milder because the
  // asset outlives this season's lost games.
  //
  // TODO: scale Out/IR by expected games missed (needs a return-timeline feed;
  // Sleeper exposes injury_body_part but no ETA). Until then a fixed multiplier.
  var INJURY_MULT = {
    redraft: { Questionable: 0.97, Doubtful: 0.90, Out: 0.80, IR: 0.55, PUP: 0.55, Sus: 0.85, COV: 0.90, DNR: 0.40, NA: 1 },
    dynasty: { Questionable: 0.98, Doubtful: 0.95, Out: 0.92, IR: 0.82, PUP: 0.82, Sus: 0.92, COV: 0.96, DNR: 0.60, NA: 1 },
  };

  function injuryMult(status, opts) {
    if (!status) return 1;
    var table = INJURY_MULT[opts && opts.dynasty ? 'dynasty' : 'redraft'];
    var s = String(status).replace(/\.$/, '');
    return table.hasOwnProperty(s) ? table[s] : 1;
  }

  // vorpMap: Map<id, value>; players: slim dict { id: [name, pos, team, injury_status, age?] }
  // Returns a NEW Map so the caller can keep the undiscounted values around.
  function applyInjury(vorpMap, players, opts) {
    var out = new Map();
    vorpMap.forEach(function (v, id) {
      var info = players && players[id];
      var m = info ? injuryMult(info[3], opts) : 1;
      out.set(id, m === 1 ? v : Math.round(v * m));
    });
    return out;
  }

  // ---- Age curve (dynasty) ------------------------------------------------
  // Multiplier on the projection-driven VORP half of the blend. Breakpoints
  // follow the well-documented positional cliffs: RBs fall off hardest and
  // earliest, WRs hold to ~30, TEs and QBs age slowest. Unknown age → 1.0.
  var AGE_CURVE = {
    RB: [[24, 1.08], [26, 1.00], [27, 0.95], [28, 0.88], [29, 0.80], [Infinity, 0.70]],
    WR: [[24, 1.08], [27, 1.00], [29, 0.95], [30, 0.88], [Infinity, 0.78]],
    TE: [[25, 1.06], [29, 1.00], [31, 0.92], [Infinity, 0.82]],
    QB: [[26, 1.06], [32, 1.00], [35, 0.92], [Infinity, 0.80]],
  };

  function ageMult(pos, age) {
    var curve = AGE_CURVE[pos];
    if (!curve || typeof age !== 'number' || !isFinite(age) || age <= 0) return 1;
    for (var i = 0; i < curve.length; i++) if (age <= curve[i][0]) return curve[i][1];
    return 1;
  }

  // Age comes from the slim dict's 5th element ([name, pos, team, injury, age]).
  function applyAge(vorpMap, players) {
    var out = new Map();
    vorpMap.forEach(function (v, id) {
      var info = players && players[id];
      var m = info ? ageMult(info[1], info[4]) : 1;
      out.set(id, m === 1 ? v : Math.round(v * m));
    });
    return out;
  }

  // ---- Lineup-slot scarcity -----------------------------------------------
  // Where a player lands on YOUR depth chart decides most of what he's worth
  // to you: a starter carries full value; a bench player carries injury /
  // bye insurance, which is worth progressively less the deeper he sits.
  //
  //   starter          1.00
  //   1st bench at pos 0.85
  //   2nd bench        0.72
  //   3rd+ bench       0.60
  //
  // Starters are decided by the shared LineupOptimizer over the roster AS IT
  // WOULD LOOK after the trade (for received players) or as it is today (for
  // players you give), so FLEX and SUPER_FLEX are handled the same way the
  // lineup page fills them — no per-position slot arithmetic to drift.
  var BENCH_FACTOR = [0.85, 0.72, 0.60];

  function benchFactor(benchIndex) {
    return BENCH_FACTOR[Math.min(Math.max(benchIndex, 1), BENCH_FACTOR.length) - 1];
  }

  // Build { starter: {id:true}, benchRank: {id: n} } for a roster (ids) using
  // vorpMap for ranking. benchRank is 1-based within the player's position.
  function depthChart(rosterIds, players, vorpMap, rosterPositions) {
    var rows = [];
    (rosterIds || []).forEach(function (id) {
      var info = players && players[id];
      if (!info || !SKILL[info[1]]) return;
      var v = vorpMap && typeof vorpMap.get === 'function' ? vorpMap.get(id) : (vorpMap ? vorpMap[id] : 0);
      rows.push({ id: id, position: info[1], value: typeof v === 'number' ? v : 0 });
    });
    var lineup = Lineup.optimize(rows, rosterPositions || []);
    var starter = {};
    lineup.starters.forEach(function (s) { if (s.id) starter[s.id] = true; });
    var benchRank = {}, seen = { QB: 0, RB: 0, WR: 0, TE: 0 };
    // optimize() returns bench sorted by value desc, so the walk order is the rank.
    lineup.bench.forEach(function (id) {
      var pos = players[id][1];
      seen[pos] += 1;
      benchRank[id] = seen[pos];
    });
    return { starter: starter, benchRank: benchRank };
  }

  // Per-player slot read for one side of the trade.
  //   side 'recv' → roster − give + recv;  side 'give' → roster as-is.
  // Returns { factor, slot: 'starter' | 'bench', benchRank } for each id on that side.
  function slotFactors(side, ctx) {
    var roster = ctx.roster || [];
    var give = ctx.give || [], recv = ctx.recv || [];
    var ids = side === 'recv' ? recv : give;
    var pool;
    if (side === 'recv') {
      var giving = {};
      give.forEach(function (id) { giving[id] = true; });
      pool = roster.filter(function (id) { return !giving[id]; });
      recv.forEach(function (id) { if (pool.indexOf(id) < 0) pool.push(id); });
    } else {
      pool = roster.slice();
      give.forEach(function (id) { if (pool.indexOf(id) < 0) pool.push(id); });  // player typed that we don't own: rank him anyway
    }
    var chart = depthChart(pool, ctx.players, ctx.vorp, ctx.rosterPositions);
    var out = {};
    ids.forEach(function (id) {
      var info = ctx.players && ctx.players[id];
      if (!info || !SKILL[info[1]]) { out[id] = { factor: 1, slot: 'starter', benchRank: 0 }; return; }
      if (chart.starter[id]) out[id] = { factor: 1, slot: 'starter', benchRank: 0 };
      else {
        var r = chart.benchRank[id] || 1;
        out[id] = { factor: benchFactor(r), slot: 'bench', benchRank: r };
      }
    });
    return out;
  }

  // ---- Season context -----------------------------------------------------
  // { lean: 'buy' | 'sell' | 'hold' | null, label, text }
  // Only fires once there are 3+ decisions and the season is past week 3;
  // before that a record says nothing. Dynasty leans move toward youth/picks
  // (sell) or proven production (buy); redraft leans are about risk appetite,
  // since a redraft team can't bank anything for next year.
  function seasonContext(ctx) {
    ctx = ctx || {};
    var rec = ctx.record || {};
    var w = Number(rec.wins) || 0, l = Number(rec.losses) || 0, t = Number(rec.ties) || 0;
    var games = w + l + t;
    var week = Number(ctx.week) || 1;
    var regWeeks = Number(ctx.regularSeasonWeeks) || 14;
    if (games < 3 || week < 4) return null;
    var pct = (w + 0.5 * t) / games;
    var left = Math.max(0, regWeeks - week + 1);
    var dyn = !!ctx.dynasty;
    if (pct <= 0.35) {
      return dyn
        ? { lean: 'sell', label: 'Sell', text: w + '-' + l + ' in week ' + week + ' — rebuild mode: favor players 25 and under and picks, move vets 28+ while they still hold value' }
        : { lean: 'buy', label: 'Swing', text: w + '-' + l + ' with ' + left + ' week' + (left === 1 ? '' : 's') + ' left — you need upside: accept a small value loss for a higher-ceiling starter' };
    }
    if (pct >= 0.65) {
      return dyn
        ? { lean: 'buy', label: 'Buy', text: w + '-' + l + ' — contend now: proven production beats long-term value; a 29-year-old RB1 is worth more to you than the market says' }
        : { lean: 'buy', label: 'Contend', text: w + '-' + l + ' — favor floor and health over upside; bench depth matters less than starter quality' };
    }
    return { lean: 'hold', label: 'Hold', text: w + '-' + l + ' — in the mix: take value wins, don\'t overpay to force a move' };
  }

  // ---- Recent form: sell high / buy low ------------------------------------
  // The market half of the blend chases the last box score; the projection
  // half ignores it. A player whose last two games ran ≥20% above his season
  // projection is priced at his peak (sell high), one ≥20% below at his trough
  // (buy low). Either way the number that matters is the regression-adjusted
  // one, so the value is nudged 5% toward the projection: hot ×0.95, cold
  // ×1.05. Symmetric on purpose — giving a hot player counts as giving less
  // (you sold high), receiving a cold one counts as getting more (you bought
  // low). Dynasty halves it: two games say little about a multi-year asset.
  var FORM_GAMES = 2;               // games compared
  var FORM_HOT = 1.2, FORM_COLD = 0.8;
  var FORM_MULT = { hot: 0.95, cold: 1.05 };
  var FORM_MIN_PROJ = 5;            // projected pts/game floor — below this the ratio is noise
  var SEASON_GAMES = 17;            // season projection → per-game
  var POINTS_KEY = { 1: 'pts_ppr', 0.5: 'pts_half_ppr', 0: 'pts_std' };

  function pointsKey(ppr) { return POINTS_KEY[ppr] || 'pts_ppr'; }
  function mean(a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // games: actual points per game played, most recent first (byes / DNP
  // omitted). projPerGame: season projection ÷ 17 under the same scoring.
  // opts.projGames: Sleeper's per-game projection for those same games (same
  // order/filter; NaN where a week has none). With 2+ finite entries the mean of
  // the ones matching the compared games is the baseline — the contemporaneous
  // expectation — else projPerGame ('season'), which never catches up to a role
  // change. Returns null without two games or a readable baseline, else
  // { label: 'hot' | 'cold' | null, ratio, avg, proj, games, mult, baseline }.
  function formSignal(games, projPerGame, opts) {
    var used = (games || []).filter(function (g) { return typeof g === 'number' && isFinite(g); }).slice(0, FORM_GAMES);
    if (used.length < FORM_GAMES) return null;
    var baseline = 'season', base = projPerGame;
    var pg = ((opts && opts.projGames) || []).slice(0, FORM_GAMES).filter(function (g) { return typeof g === 'number' && isFinite(g); });
    if (pg.length >= 2) { baseline = 'weekly'; base = mean(pg); }
    if (!(base >= FORM_MIN_PROJ)) return null;
    var avg = mean(used);
    var ratio = avg / base;
    var label = ratio >= FORM_HOT ? 'hot' : ratio <= FORM_COLD ? 'cold' : null;
    var mult = label ? FORM_MULT[label] : 1;
    if (label && opts && opts.dynasty) mult = 1 + (mult - 1) / 2;
    return { label: label, ratio: Math.round(ratio * 100) / 100, avg: Math.round(avg * 10) / 10, proj: Math.round(base * 10) / 10, games: used.length, mult: Math.round(mult * 1000) / 1000, baseline: baseline };
  }

  // ---- Role change ------------------------------------------------------------
  // A season projection is effectively preseason, so a player who just took over
  // a backfield reads "hot" all year — the Hot discount would fire on a real role
  // change. roleSignal detects the change (usage jump, or an injured teammate's
  // vacated share); gateForm then swaps Hot/Cold for a role chip at mult 1.
  var ROLE_SHARE_PP = 0.08;        // absolute share delta
  var ROLE_SHARE_RATIO = 1.25;     // relative share delta (down: 1 / 1.25)
  var ROLE_SNAP_PP = 0.10;         // snap-share move that corroborates → 'high'
  var ROLE_MIN_SHARE = 0.15;       // teammate's season share to count as vacated
  var ROLE_MIN_VACATED = 0.15;
  var ROLE_OUT_STATUS = { Out: 1, IR: 1, PUP: 1, Doubtful: 1, Sus: 1 };
  var ROLE_SHARE_KEY = { RB: 'carryShare', WR: 'tgtShare', TE: 'tgtShare' };   // QB → no role signal
  var ROLE_EPS = 1e-9;

  function pct(v) { return Math.round(v * 100) + '%'; }
  function statusWord(st) {
    return st === 'IR' || st === 'PUP' ? 'on ' + st : st === 'Sus' ? 'suspended' : String(st).toLowerCase();
  }

  // usage: one /api/recent-stats player { recent, season, prior? }. teammatesOut:
  // [{ id, name, status, usage }] same team + position (self excluded).
  // opts: { recentWindow (1–2), dynasty }. Returns null without a signal, else
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
        var text = noun + ' share ' + pct(p) + ' → ' + pct(r) + ' over ' + (rec.games >= 2 ? 'the last ' + rec.games + ' weeks' : 'the last week') +
          (haveSnap ? ' (snaps ' + pct(prev.snapPct) + ' → ' + pct(rec.snapPct) + ')' : '') +
          (rec.games === 1 ? ' — 1 game of evidence' : '');
        var sig = { label: up ? 'up' : 'down', confidence: high ? 'high' : 'med', source: 'usage', volRatio: p > 0 ? r / p : 1, share: r, sharePrev: p, snap: rec.snapPct, snapPrev: prev.snapPct, vacated: 0, teammates: [], text: text };
        if (dynasty && up) sig.hold = true;
        return sig;
      }
    }

    // Injury-implied: a same-position teammate who played recently and is now out
    // — his absence is in no projection or box score yet (mirrors stepUpMultiplier).
    var window = opts && opts.recentWindow > 0 ? opts.recentWindow : 1;
    var vacated = 0, mates = [], parts = [];
    (teammatesOut || []).forEach(function (t) {
      if (!t || !ROLE_OUT_STATUS[t.status]) return;
      var sea = t.usage && t.usage.season, tr = t.usage && t.usage.recent;
      if (!sea || !(sea.games > 0)) return;                 // never played → projections already exclude him
      var share = sea[shareKey] != null ? sea[shareKey] : 0;
      if (share < ROLE_MIN_SHARE) return;                   // depth piece, no volume to inherit
      var fresh = clamp(((tr && tr.games) || 0) / window, 0, 1);
      if (fresh === 0) return;                              // out 2+ weeks: role already re-projected
      vacated += share * fresh;
      mates.push({ id: t.id, name: t.name, status: t.status, share: share, fresh: fresh });
      parts.push((t.name || t.id) + ' ' + statusWord(t.status) + ' (' + pct(share) + ' of ' + (pos === 'RB' ? 'carries' : 'targets') + ', played ' + (fresh < 1 ? 'recently' : 'last week') + ')');
    });
    if (vacated >= ROLE_MIN_VACATED - ROLE_EPS) {
      var t2 = parts.join(' · ') + (dynasty ? ' — temporary if he returns; hold, don\'t chase' : '');
      var s2 = { label: 'up', confidence: 'med', source: 'injury', volRatio: 1, share: rec && rec[shareKey] != null ? rec[shareKey] : null, sharePrev: prev && prev[shareKey] != null ? prev[shareKey] : null, snap: rec && rec.snapPct != null ? rec.snapPct : null, snapPrev: prev && prev.snapPct != null ? prev.snapPct : null, vacated: vacated, teammates: mates, text: t2 };
      if (dynasty) s2.hold = true;
      return s2;
    }
    return null;
  }

  // The entry applyFactors reads. A role change explains a hot/cold streak, so
  // it replaces the label and drops the regression nudge (mult 1, never stacked).
  // Anything else passes `form` through unchanged (role attached for tooltips).
  // Gated entries (role-up / role-down) carry `form` and `role` sub-objects and
  // have no top-level avg/proj/ratio/games — readers must use entry.form.*.
  function gateForm(form, role, opts) {
    if (!form) return null;
    if (role && form.label === 'hot' && role.label === 'up') {
      var effRatio = form.ratio / (role.volRatio || 1);
      // volRatio is only measured on the usage path (injury path fixes it at 1),
      // so effRatio and the per-touch note apply there alone.
      var measured = role.source === 'usage';
      var perTouch = measured && effRatio >= FORM_HOT;
      var text = role.text + (perTouch ? ' — also running hot per touch; some per-touch regression possible' : '');
      return { label: 'role-up', mult: 1, form: form, role: role, effRatio: measured ? Math.round(effRatio * 100) / 100 : null, perTouch: perTouch, text: text };
    }
    if (role && form.label === 'cold' && role.label === 'down') {
      return { label: 'role-down', mult: 1, form: form, role: role, text: role.text };
    }
    if (!role) return form;
    var out = {};
    for (var k in form) out[k] = form[k];
    out.role = role;
    return out;
  }

  // players: slim dict { id: [name, pos, team, injury_status, age] }; usage:
  // /api/recent-stats `players`. Returns { TEAM: { POS: [{ id, name, status,
  // usage }] } } — out/IR/doubtful/PUP/suspended RB/WR/TE per team. No usage → {}.
  var TEAM_OUT_STATUS = ROLE_OUT_STATUS;
  function teamOuts(players, usage) {
    var out = {};
    if (!usage || !players) return out;
    for (var id in players) {
      var p = players[id];
      if (!p || !TEAM_OUT_STATUS[p[3]] || !ROLE_SHARE_KEY[p[1]] || !p[2] || p[2] === 'FA') continue;
      var u = usage[id];
      if (!u) continue;
      var byPos = out[p[2]] || (out[p[2]] = {});
      (byPos[p[1]] || (byPos[p[1]] = [])).push({ id: id, name: p[0], status: p[3], usage: u });
    }
    return out;
  }

  // statsByWeek: { week: { id: { gp, pts_ppr, pts_half_ppr, pts_std } } } from
  // /api/recent-points; weeks: completed weeks, most recent first; proj: the
  // season projection dict (Sleeper pts_* fields). opts.ppr picks the points
  // column so actual and projection are read on the same scale.
  // Optional opts: projByWeek (/api/recent-points `proj`) → weekly baseline;
  // usage (/api/recent-stats `players`), teamOuts (teamOuts()), recentWindow →
  // role gate. Without them the output is the plain form signal.
  // Returns Map<id, entry> for skill players with enough data.
  function formMap(players, statsByWeek, weeks, proj, opts) {
    var out = new Map();
    if (!players || !statsByWeek || !weeks || !weeks.length || !proj) return out;
    var key = pointsKey(opts && opts.ppr);
    var projByWeek = opts && opts.projByWeek;
    var usageMap = opts && opts.usage, outs = opts && opts.teamOuts;
    Object.keys(players).forEach(function (id) {
      var info = players[id];
      if (!info || !SKILL[info[1]]) return;
      var p = proj[id];
      var season = p && Number(p[key]);
      if (!(season > 0)) return;
      var games = [], projGames = [];
      for (var i = 0; i < weeks.length; i++) {
        var wk = statsByWeek[weeks[i]];
        var s = wk && wk[id];
        // A stat line with a game played (gp) or any points counts, even at 0;
        // no line at all = bye / inactive → skipped, not a zero.
        if (s && (Number(s.gp) > 0 || s[key] != null)) {
          games.push(Number(s[key]) || 0);
          var wp = projByWeek && projByWeek[weeks[i]] && projByWeek[weeks[i]][id];
          projGames.push(wp && wp[key] != null && isFinite(Number(wp[key])) ? Number(wp[key]) : NaN);
        }
      }
      var fopts = opts;
      if (projByWeek) { fopts = {}; for (var k in opts) fopts[k] = opts[k]; fopts.projGames = projGames; }
      var sig = formSignal(games, season / SEASON_GAMES, fopts);
      if (!sig) return;
      var role = null;
      if (usageMap && usageMap[id]) {
        var mates = ((outs && info[2] && outs[info[2]] && outs[info[2]][info[1]]) || []).filter(function (t) { return t.id !== id; });
        role = roleSignal(usageMap[id], mates, info[1], opts);
      }
      var entry = gateForm(sig, role, opts);
      if (entry) out.set(id, entry);
    });
    return out;
  }

  // ---- Playoff schedule strength --------------------------------------------
  // A season-long asset pays out in the fantasy playoffs. Each playoff-week
  // opponent is ranked by fantasy points allowed to the position (1 = allows
  // the most = easiest), averaging this season's Sleeper FPA with FantasyPros'
  // matchup rank when both are present (the FP rank carries priors, which
  // steadies the read early in the year). Average rank → linear multiplier:
  // rank 1 → +5%, rank 16.5 → 0, rank 32 → −5%. Dynasty halves it.
  var PLAYOFF_SWING = 0.05;
  var PLAYOFF_EASY_RANK = 11, PLAYOFF_HARD_RANK = 22;   // badge thresholds on the average rank
  var NFL_TEAMS = 32;
  var DEFAULT_PLAYOFF_START = 15;

  // Fantasy playoff weeks from Sleeper league settings: playoff_week_start
  // (default 15), playoff_teams → rounds (4 → 2, 6 → 3, 8 → 3, 12 → 4),
  // playoff_round_type 0 = one week per round, 1 = two-week final, 2 = two
  // weeks per round. Capped at week 18. Null league → weeks 15–17.
  function playoffWeeks(league) {
    var s = (league && league.settings) || {};
    var start = Number(s.playoff_week_start) > 1 ? Number(s.playoff_week_start) : DEFAULT_PLAYOFF_START;
    var teams = Number(s.playoff_teams) > 1 ? Number(s.playoff_teams) : 6;
    var rounds = Math.max(1, Math.ceil(Math.log(teams) / Math.LN2));
    var type = Number(s.playoff_round_type) || 0;
    var n = type === 2 ? rounds * 2 : type === 1 ? rounds + 1 : rounds;
    var weeks = [];
    for (var w = start; w < start + n && w <= 18; w++) weeks.push(w);
    return weeks;
  }

  // fpa: { current: { WR: { KC: 21.3, … } }, fpMatchupRanks: { WR: { KC: 24, … } } }
  // (data/fpa-current.json). Rank of `team`'s defence against `pos`, 1 = easiest.
  function defenseRank(fpa, pos, team) {
    if (!fpa || !team) return null;
    var ranks = [];
    var cur = fpa.current && fpa.current[pos];
    if (cur && cur[team] != null && isFinite(cur[team])) {
      var mine = Number(cur[team]), better = 0, n = 0;
      for (var t in cur) { if (!isFinite(cur[t])) continue; n++; if (Number(cur[t]) > mine) better++; }
      if (n >= 16) ranks.push(better + 1);
    }
    var fp = fpa.fpMatchupRanks && fpa.fpMatchupRanks[pos];
    if (fp && fp[team] != null && isFinite(fp[team])) ranks.push(Number(fp[team]));
    return ranks.length ? mean(ranks) : null;
  }

  // schedule: { week: { TEAM: { opp, home } } } (one /api/schedule/:week payload
  // per playoff week). A week that is loaded but has no game for the team is a
  // bye — the worst possible playoff week, ranked 32. Weeks that never loaded
  // are skipped. Returns null with nothing to rank, else
  // { label: 'easy' | 'hard' | null, avgRank, mult, weeks, opps: [{ week, opp, home, rank }] }.
  function playoffSOS(team, pos, weeks, schedule, fpa, opts) {
    if (!team || team === 'FA' || !SKILL[pos] || !weeks || !weeks.length) return null;
    var opps = [], ranks = [];
    weeks.forEach(function (w) {
      var wk = schedule && schedule[w];
      if (!wk || !Object.keys(wk).length) return;
      var g = wk[team];
      if (!g) { opps.push({ week: w, opp: null, home: null, rank: NFL_TEAMS }); ranks.push(NFL_TEAMS); return; }
      var r = defenseRank(fpa, pos, g.opp);
      opps.push({ week: w, opp: g.opp, home: !!g.home, rank: r == null ? null : Math.round(r * 10) / 10 });
      if (r != null) ranks.push(r);
    });
    if (!ranks.length) return null;
    var avg = mean(ranks);
    var mult = 1 + PLAYOFF_SWING * ((NFL_TEAMS + 1) / 2 - avg) / ((NFL_TEAMS - 1) / 2);
    if (opts && opts.dynasty) mult = 1 + (mult - 1) / 2;
    mult = clamp(mult, 1 - PLAYOFF_SWING, 1 + PLAYOFF_SWING);
    var label = avg <= PLAYOFF_EASY_RANK ? 'easy' : avg >= PLAYOFF_HARD_RANK ? 'hard' : null;
    return { label: label, avgRank: Math.round(avg * 10) / 10, mult: Math.round(mult * 1000) / 1000, weeks: weeks.slice(), opps: opps };
  }

  // Map<id, playoffSOS> for every skill player, memoised per team × position.
  function playoffMap(players, weeks, schedule, fpa, opts) {
    var out = new Map();
    if (!players || !weeks || !weeks.length || !schedule) return out;
    var memo = {};
    Object.keys(players).forEach(function (id) {
      var info = players[id];
      if (!info || !SKILL[info[1]]) return;
      var k = info[2] + ':' + info[1];
      if (!memo.hasOwnProperty(k)) memo[k] = playoffSOS(info[2], info[1], weeks, schedule, fpa, opts);
      if (memo[k]) out.set(id, memo[k]);
    });
    return out;
  }

  // Multiply each value by the `mult` of every factor map that has the id.
  // Returns a NEW Map; ids absent from every map are copied through.
  function applyFactors(vorpMap, factorMaps) {
    var out = new Map();
    vorpMap.forEach(function (v, id) {
      var m = 1;
      (factorMaps || []).forEach(function (fm) {
        var f = fm && typeof fm.get === 'function' ? fm.get(id) : null;
        if (f && typeof f.mult === 'number' && isFinite(f.mult)) m *= f.mult;
      });
      out.set(id, m === 1 ? v : Math.round(v * m));
    });
    return out;
  }

  // ---- Roster-spot imbalance ------------------------------------------------
  // Pure context for the verdict text: an N-for-M trade changes how many
  // roster spots you use, which the value totals never show. Never alters value.
  // Returns null for an even swap, else { give, recv, net, tone, text }.
  function rosterImbalance(giveCount, recvCount) {
    var g = Number(giveCount) || 0, r = Number(recvCount) || 0;
    if (!g || !r || g === r) return null;
    var net = r - g;
    if (net < 0) {
      return {
        give: g, recv: r, net: net, tone: 'warn',
        text: g + '-for-' + r + ' — trading depth for upside: you\'ll be thinner on the bench, with ' + (-net) + ' open roster spot' + (net === -1 ? '' : 's') + ' to fill from waivers',
      };
    }
    return {
      give: g, recv: r, net: net, tone: 'good',
      text: g + '-for-' + r + ' — you gain ' + net + ' roster bod' + (net === 1 ? 'y' : 'ies') + ': more depth for byes and injuries, but you\'ll need to drop ' + (net === 1 ? 'someone' : net + ' players') + ' to make room',
    };
  }

  return {
    leagueFormat: leagueFormat,
    formatLabel: formatLabel,
    injuryMult: injuryMult,
    applyInjury: applyInjury,
    ageMult: ageMult,
    applyAge: applyAge,
    slotFactors: slotFactors,
    depthChart: depthChart,
    benchFactor: benchFactor,
    seasonContext: seasonContext,
    formSignal: formSignal,
    formMap: formMap,
    roleSignal: roleSignal,
    gateForm: gateForm,
    teamOuts: teamOuts,
    pointsKey: pointsKey,
    playoffWeeks: playoffWeeks,
    defenseRank: defenseRank,
    playoffSOS: playoffSOS,
    playoffMap: playoffMap,
    applyFactors: applyFactors,
    rosterImbalance: rosterImbalance,
    INJURY_MULT: INJURY_MULT,
    AGE_CURVE: AGE_CURVE,
    BENCH_FACTOR: BENCH_FACTOR,
    FORM_MULT: FORM_MULT,
    FORM_HOT: FORM_HOT,
    FORM_COLD: FORM_COLD,
    ROLE_SHARE_PP: ROLE_SHARE_PP,
    ROLE_SHARE_RATIO: ROLE_SHARE_RATIO,
    ROLE_SNAP_PP: ROLE_SNAP_PP,
    ROLE_MIN_SHARE: ROLE_MIN_SHARE,
    ROLE_MIN_VACATED: ROLE_MIN_VACATED,
    ROLE_OUT_STATUS: ROLE_OUT_STATUS,
    ROLE_SHARE_KEY: ROLE_SHARE_KEY,
    PLAYOFF_SWING: PLAYOFF_SWING,
    SEASON_GAMES: SEASON_GAMES,
  };
})();

if (typeof module !== 'undefined') module.exports = TradeFit;
