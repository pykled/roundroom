// Waiver targets cross-reference — pure function shared by /api/me/waivers in
// server.js and scripts/test-waivers.js. Given the trending-up list and each
// league's roster data, finds players who are free agents in at least one of
// the user's leagues.
//
//   buildWaiverTargets(trendingUp, leagues, leagueDataById, sleeperUserId)
//
//   trendingUp:      [...] — trending.up from TrendingScore.scoreTrending (direction up only)
//   leagues:         [{ league_id, name, ... }] — the user's leagues (fetchSleeperLeagues result)
//   leagueDataById:  { league_id: { rosters: [{ owner_id, co_owners, players }] } } —
//                    only successfully-loaded leagues are present as keys
//   sleeperUserId:   Sleeper user id string
//
// Returns [{ ...trendingPlayer, faIn, faCount, onMyTeamIn, highDemand }],
// sorted by faCount desc then trend desc. Players rostered in every
// successfully-loaded league are omitted.
var WaiverTargets = (function () {
  'use strict';

  function buildWaiverTargets(trendingUp, leagues, leagueDataById, sleeperUserId) {
    var uid = String(sleeperUserId);
    var perLeague = leagues
      .filter(function (l) { return leagueDataById[l.league_id]; })
      .map(function (l) {
        var data = leagueDataById[l.league_id];
        var rosters = data.rosters || [];
        var rostered = new Set();
        var mine = null;
        rosters.forEach(function (r) {
          (r.players || []).forEach(function (pid) { rostered.add(String(pid)); });
          var owner = String(r.owner_id);
          var coOwners = (r.co_owners || []).map(String);
          if (owner === uid || coOwners.indexOf(uid) !== -1) mine = r;
        });
        return { league_id: l.league_id, rostered: rostered, mine: mine };
      });

    var targets = [];
    (trendingUp || []).forEach(function (p) {
      var faIn = [];
      var onMyTeamIn = [];
      perLeague.forEach(function (l) {
        if (!l.rostered.has(String(p.id))) faIn.push(l.league_id);
        if (l.mine && (l.mine.players || []).indexOf(String(p.id)) !== -1) onMyTeamIn.push(l.league_id);
      });
      if (!faIn.length) return;
      var highDemand = !!(p.market && p.market.addRank != null && p.market.addRank <= 10);
      var out = {};
      for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k];
      out.faIn = faIn;
      out.faCount = faIn.length;
      out.onMyTeamIn = onMyTeamIn;
      out.highDemand = highDemand;
      targets.push(out);
    });

    targets.sort(function (a, b) {
      if (b.faCount !== a.faCount) return b.faCount - a.faCount;
      return b.trend - a.trend;
    });

    return targets;
  }

  return { buildWaiverTargets: buildWaiverTargets };
})();

if (typeof module !== 'undefined') module.exports = WaiverTargets;
