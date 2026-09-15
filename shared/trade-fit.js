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
    INJURY_MULT: INJURY_MULT,
    AGE_CURVE: AGE_CURVE,
    BENCH_FACTOR: BENCH_FACTOR,
  };
})();

if (typeof module !== 'undefined') module.exports = TradeFit;
