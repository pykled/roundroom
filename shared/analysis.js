// Team analysis — pure functions shared by trade.html / team.html (browser) and
// node scripts. Works on top of ScoringEngine (season points) and
// LineupOptimizer (who fills which slot); this module answers "what does this
// team need, what does it have too much of, and who in the league needs what
// it has". See docs/team-analysis-design.md.
//
// Inputs mirror what the Trade page already holds:
//   league     /api/league/:id payload (roster_positions, scoring_settings, rosters[], users[])
//   players    /api/players/slim dict   { id: [name, pos, team] }
//   proj       /api/projections/season  { id: { stat: value } }
//   vorpMap    blended VORP (Map or plain object), 0–10000 league-relative scale
//   injuries   /api/injuries `players` dict keyed by lowercase full name → { status, ... }
var AnalysisEngine = (function () {
  'use strict';

  var Scoring = (typeof ScoringEngine !== 'undefined') ? ScoringEngine
    : (typeof require === 'function' ? require('./scoring.js') : null);
  var Lineup = (typeof LineupOptimizer !== 'undefined') ? LineupOptimizer
    : (typeof require === 'function' ? require('./lineup.js') : null);

  var NEED_POSITIONS = ['QB', 'RB', 'WR', 'TE'];
  var ELITE_T = 7500;   // top-tier starter on the 0–10000 scale
  var LIAB_T = 1000;    // near replacement level
  var WEEKS = 17;
  var INJURED_STATUS = { Out: 1, Doubtful: 1, IR: 1, PUP: 1 };

  function getV(vorpMap, id) {
    if (!vorpMap) return 0;
    var v = typeof vorpMap.get === 'function' ? vorpMap.get(id) : vorpMap[id];
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  // Starter slots per position. Flex slots split evenly across eligible
  // positions — same convention as ScoringEngine.computeVORP so "need" lines up
  // with the replacement level the values are built on.
  function starterSlots(rosterPositions) {
    var s = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0 };
    (rosterPositions || []).forEach(function (p) {
      if (s.hasOwnProperty(p)) s[p] += 1;
      else if (p === 'FLEX' || p === 'WRRB_FLEX') { s.RB += 0.5; s.WR += 0.5; }
      else if (p === 'SUPER_FLEX') s.QB += 1;
      else if (p === 'REC_FLEX') { s.WR += 0.5; s.TE += 0.5; }
    });
    return s;
  }

  // Count-only depth: need (rostered ≤ starters), surplus (rostered ≥ 2×
  // starters), else neutral. A position with no starter slot is always neutral.
  // This is the "depth" axis of the tier below and the vocabulary the
  // /api/analysis payload still speaks.
  function assessDepth(rostered, slots) {
    if (!slots || slots <= 0) return 'neutral';
    if (rostered <= slots) return 'need';
    if (rostered >= slots * 2) return 'surplus';
    return 'neutral';
  }

  // Positional tier = depth (count vs slots) × starter quality (this team's
  // starter VORP at the position vs the league). Ordered liability → asset:
  //
  //   quality \ depth   thin (≤ slots)   neutral          deep (≥ 2× slots)
  //   weak  (< avg)     critical         upgrade          upgrade
  //   decent (≥ avg)    thin             solid            deep
  //   strong (top 30%)  thin             solid            loaded
  //
  //   critical  weak starters and nobody behind them — fix first
  //   upgrade   bodies on the roster but the starters are below league average
  //   thin      starters are fine, one injury from trouble — add depth
  //   solid     average-or-better starters, normal depth — hold
  //   deep      good starters with real bench behind them — can deal from here
  //   loaded    top-tier starters AND surplus — prime trade chip
  //
  // `leagueAvg` is the mean starter VORP at the position across the league and
  // `strongCutoff` the starter VORP of the last team inside the top 30%; pass
  // null for either to skip that comparison (no league context → never weak,
  // never strong).
  var TIERS = ['critical', 'upgrade', 'thin', 'solid', 'deep', 'loaded'];
  var STRONG_SHARE = 0.3;

  function assessDepthAndQuality(rostered, slots, myStarterVorp, leagueAvg, strongCutoff) {
    var depth = assessDepth(rostered, slots);
    if (!slots || slots <= 0) return 'solid';
    var v = typeof myStarterVorp === 'number' && isFinite(myStarterVorp) ? myStarterVorp : 0;
    var weak = typeof leagueAvg === 'number' && isFinite(leagueAvg) && v < leagueAvg;
    var strong = !weak && typeof strongCutoff === 'number' && isFinite(strongCutoff) && v >= strongCutoff;
    if (depth === 'need') return weak ? 'critical' : 'thin';
    if (depth === 'surplus') return weak ? 'upgrade' : (strong ? 'loaded' : 'deep');
    return weak ? 'upgrade' : 'solid';
  }

  // Collapse a tier back to the count-era vocabulary (need / neutral / surplus)
  // for consumers that still speak it — the AI payload validator, the Roster
  // Fit multiplier table, partner matching.
  function tierStatus(tier) {
    if (tier === 'critical' || tier === 'upgrade' || tier === 'thin') return 'need';
    if (tier === 'deep' || tier === 'loaded') return 'surplus';
    return 'neutral';
  }

  // Best-effort tier when there is no league to compare against (count only):
  // assume average starters, so need → thin, surplus → deep.
  function tierFromDepth(status) {
    return status === 'need' ? 'thin' : status === 'surplus' ? 'deep' : 'solid';
  }

  // Per-position depth for a list of active player ids:
  // { QB|RB|WR|TE: { rostered, slots, status, tier } }  (tier is count-only here)
  function depthFromRoster(activeIds, players, rosterPositions) {
    var slots = starterSlots(rosterPositions);
    var count = { QB: 0, RB: 0, WR: 0, TE: 0 };
    (activeIds || []).forEach(function (id) {
      var info = players && players[id];
      if (info && count.hasOwnProperty(info[1])) count[info[1]] += 1;
    });
    var depth = {};
    NEED_POSITIONS.forEach(function (p) {
      var status = assessDepth(count[p], slots[p]);
      depth[p] = { rostered: count[p], slots: slots[p], status: status, tier: tierFromDepth(status) };
    });
    return depth;
  }

  function teamName(roster, users) {
    if (!roster || roster.owner_id == null) return 'Open team';
    var u = (users || []).find(function (x) { return String(x.user_id) === String(roster.owner_id); });
    if (!u) return 'Team ' + roster.roster_id;
    var tn = u.metadata && u.metadata.team_name;
    return tn || u.display_name || ('Team ' + roster.roster_id);
  }

  function injuryStatus(id, players, injuries) {
    var info = players && players[id];
    if (!info || !injuries) return null;
    var rec = injuries[String(info[0]).toLowerCase()];
    var st = rec && rec.status;
    return st && INJURED_STATUS[st] ? st : null;
  }

  // Full read on one roster. leagueRosters / leagueUsers are the league payload's
  // rosters[] / users[]; league supplies roster_positions + scoring_settings.
  function analyzeTeam(roster, leagueRosters, leagueUsers, league, players, proj, vorpMap, injuries) {
    players = players || {};
    proj = proj || {};
    var positions = (league && league.roster_positions) || [];
    var scoring = (league && league.scoring_settings) || {};
    var settings = roster.settings || {};

    var skip = {};
    (roster.reserve || []).concat(roster.taxi || []).forEach(function (id) { skip[id] = true; });
    var active = (roster.players || []).filter(function (id) { return !skip[id]; });

    // Optimal lineup by VORP over players the slim dict knows (DEF/IDP ids are
    // left out; the optimizer simply leaves those slots empty).
    var rows = active.filter(function (id) { return players[id]; }).map(function (id) {
      return { id: id, position: players[id][1], value: getV(vorpMap, id) };
    });
    var lineup = Lineup.optimize(rows, positions);
    var starterIds = lineup.starters.map(function (s) { return s.id; }).filter(Boolean);
    var isStarter = {};
    starterIds.forEach(function (id) { isStarter[id] = true; });

    var starterVorp = 0, starterPts = 0, benchVorp = 0;
    var posVorp = { QB: 0, RB: 0, WR: 0, TE: 0 };
    var elite = [], liabilities = [];
    starterIds.forEach(function (id) {
      var pos = players[id][1];
      var v = getV(vorpMap, id);
      starterVorp += v;
      starterPts += Scoring.scorePlayer({ player_id: id, position: pos }, proj, scoring);
      if (posVorp.hasOwnProperty(pos)) {
        posVorp[pos] += v;
        var entry = { id: id, name: players[id][0], position: pos, vorp: v };
        if (v >= ELITE_T) elite.push(entry);
        else if (v < LIAB_T) liabilities.push(entry);
      }
    });
    lineup.bench.forEach(function (id) { benchVorp += getV(vorpMap, id); });
    elite.sort(function (a, b) { return b.vorp - a.vorp; });
    liabilities.sort(function (a, b) { return a.vorp - b.vorp; });

    var depth = depthFromRoster(active, players, positions);
    var byPos = {};
    NEED_POSITIONS.forEach(function (p) {
      var nextUp = 0;
      lineup.bench.forEach(function (id) {
        if (players[id] && players[id][1] === p) nextUp = Math.max(nextUp, getV(vorpMap, id));
      });
      byPos[p] = {
        starterVorp: posVorp[p],
        rostered: depth[p].rostered,
        slots: depth[p].slots,
        status: depth[p].status,   // count-only depth: need | neutral | surplus
        tier: depth[p].tier,       // depth × quality; count-only guess until analyzeLeague fills it
        leagueAvg: null,           // filled by analyzeLeague
        nextUp: nextUp,
        rank: null,                // filled by analyzeLeague
      };
    });

    var injured = [];
    active.forEach(function (id) {
      var st = injuryStatus(id, players, injuries);
      if (st) injured.push({ id: id, name: players[id][0], position: players[id][1], status: st, starter: !!isStarter[id] });
    });

    var fpts = Number(settings.fpts || 0) + Number(settings.fpts_decimal || 0) / 100;
    var user = (leagueUsers || []).find(function (x) { return String(x.user_id) === String(roster.owner_id); });
    return {
      rosterId: roster.roster_id,
      ownerId: roster.owner_id == null ? null : String(roster.owner_id),
      name: teamName(roster, leagueUsers),
      avatar: user && user.avatar ? user.avatar : null,
      record: { wins: settings.wins || 0, losses: settings.losses || 0, ties: settings.ties || 0, fpts: Math.round(fpts * 100) / 100 },
      active: active,
      lineup: lineup,
      starters: starterIds,
      // DEF is excluded: the slim players dict usually omits defenses, so a DEF
      // slot reads as unfilled even when the roster has one.
      emptySlots: lineup.starters.filter(function (s) { return !s.id && s.slot !== 'DEF'; }).length,
      byPos: byPos,
      // Tier-based (critical/upgrade/thin → needs, deep/loaded → surplus).
      // Count-only until analyzeLeague re-derives them with quality applied.
      needs: NEED_POSITIONS.filter(function (p) { return tierStatus(byPos[p].tier) === 'need'; }),
      surplus: NEED_POSITIONS.filter(function (p) { return tierStatus(byPos[p].tier) === 'surplus'; }),
      elite: elite,
      liabilities: liabilities,
      injured: injured,
      starterVorp: starterVorp,
      starterPts: Math.round(starterPts / WEEKS * 10) / 10,
      benchVorp: benchVorp,
      rank: null,            // filled by analyzeLeague
      teamCount: null,
    };
  }

  // Teams whose need positions overlap my surplus positions, best match first.
  // Each entry: { team, overlap: [pos I have that they need], mutual: [pos they
  // have that I need], score }. Up to `limit` (default 3).
  function findPartners(myAnalysis, allTeams, limit) {
    limit = limit || 3;
    if (!myAnalysis) return [];
    var out = [];
    (allTeams || []).forEach(function (t) {
      if (!t || t.rosterId === myAnalysis.rosterId) return;
      var overlap = t.needs.filter(function (p) { return myAnalysis.surplus.indexOf(p) >= 0; });
      if (!overlap.length) return;
      var mutual = t.surplus.filter(function (p) { return myAnalysis.needs.indexOf(p) >= 0; });
      out.push({ team: t, overlap: overlap, mutual: mutual, score: overlap.length * 2 + mutual.length });
    });
    out.sort(function (a, b) { return b.score - a.score || b.team.starterVorp - a.team.starterVorp; });
    return out.slice(0, limit);
  }

  function analyzeLeague(league, players, proj, vorpMap, injuries) {
    var rosters = (league && league.rosters) || [];
    var users = (league && league.users) || [];
    var teams = rosters.map(function (r) {
      return analyzeTeam(r, rosters, users, league, players, proj, vorpMap, injuries);
    });
    teams.sort(function (a, b) { return b.starterVorp - a.starterVorp; });
    teams.forEach(function (t, i) { t.rank = i + 1; t.teamCount = teams.length; });

    // Per-position league context: rank, mean starter VORP, and the cutoff for
    // "strong" (the starter VORP of the last team inside the top 30%, at least
    // one team). Then re-tier every position with quality applied.
    var ranks = {}, leagueAvg = {}, strongCutoff = {};
    var strongCount = Math.max(1, Math.round(teams.length * STRONG_SHARE));
    NEED_POSITIONS.forEach(function (p) {
      var order = teams.slice().sort(function (a, b) { return b.byPos[p].starterVorp - a.byPos[p].starterVorp; });
      ranks[p] = order.map(function (t) { return t.rosterId; });
      order.forEach(function (t, i) { t.byPos[p].rank = i + 1; });
      var sum = 0;
      order.forEach(function (t) { sum += t.byPos[p].starterVorp; });
      leagueAvg[p] = order.length ? sum / order.length : 0;
      strongCutoff[p] = order.length ? order[Math.min(strongCount, order.length) - 1].byPos[p].starterVorp : 0;
      order.forEach(function (t) {
        var c = t.byPos[p];
        c.leagueAvg = leagueAvg[p];
        c.tier = assessDepthAndQuality(c.rostered, c.slots, c.starterVorp, leagueAvg[p], strongCutoff[p]);
      });
    });
    teams.forEach(function (t) {
      t.needs = NEED_POSITIONS.filter(function (p) { return tierStatus(t.byPos[p].tier) === 'need'; });
      t.surplus = NEED_POSITIONS.filter(function (p) { return tierStatus(t.byPos[p].tier) === 'surplus'; });
    });

    function byRosterId(id) {
      return teams.find(function (t) { return String(t.rosterId) === String(id); }) || null;
    }
    return {
      teams: teams,
      ranks: ranks,
      leagueAvg: leagueAvg,
      strongCutoff: strongCutoff,
      strongCount: strongCount,
      team: byRosterId,
      partners: function (myRosterId, limit) { return findPartners(byRosterId(myRosterId), teams, limit); },
    };
  }

  return {
    starterSlots: starterSlots,
    assessDepth: assessDepth,
    assessDepthAndQuality: assessDepthAndQuality,
    tierStatus: tierStatus,
    tierFromDepth: tierFromDepth,
    TIERS: TIERS,
    depthFromRoster: depthFromRoster,
    analyzeTeam: analyzeTeam,
    analyzeLeague: analyzeLeague,
    findPartners: findPartners,
    teamName: teamName,
    ELITE_T: ELITE_T,
    LIAB_T: LIAB_T,
    NEED_POSITIONS: NEED_POSITIONS,
  };
})();

if (typeof module !== 'undefined') module.exports = AnalysisEngine;
