var ScoringEngine = (function () {
  'use strict';

  // projections: { player_id: { stat_key: value, ... } }
  // scoringSettings: { rec: 1, rec_yd: 0.1, ... }
  function scorePlayer(player, projections, scoringSettings) {
    var stats = projections[player.player_id];
    if (!stats) return 0;
    var total = 0;
    for (var key in scoringSettings) {
      if (typeof stats[key] === 'number') total += stats[key] * scoringSettings[key];
    }
    return Math.max(0, total);
  }

  // players: [{ player_id, position }]
  // rosterPositions: e.g. ["QB","RB","RB","WR","WR","WR","TE","FLEX","K",...]
  // returns Map<player_id, vorp>
  function computeVORP(players, projections, scoringSettings, rosterPositions, teamCount) {
    var starters = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0 };
    for (var i = 0; i < rosterPositions.length; i++) {
      var pos = rosterPositions[i];
      if (starters.hasOwnProperty(pos)) {
        starters[pos] += 1;
      } else if (pos === 'FLEX') {
        starters.RB += 0.5; starters.WR += 0.5;
      } else if (pos === 'SUPER_FLEX') {
        starters.QB += 1;
      } else if (pos === 'WRRB_FLEX') {
        starters.WR += 0.5; starters.RB += 0.5;
      } else if (pos === 'REC_FLEX') {
        starters.WR += 0.5; starters.TE += 0.5;
      }
    }

    var replRank = {};
    for (var p in starters) replRank[p] = Math.round(teamCount * starters[p]);

    var byPos = { QB: [], RB: [], WR: [], TE: [], K: [] };
    for (var j = 0; j < players.length; j++) {
      var pl = players[j];
      if (!byPos.hasOwnProperty(pl.position)) continue;
      byPos[pl.position].push({ id: pl.player_id, score: scorePlayer(pl, projections, scoringSettings) });
    }
    for (var pp in byPos) byPos[pp].sort(function (a, b) { return b.score - a.score; });

    var replScore = {};
    for (var rp in byPos) {
      var rank = replRank[rp] || 0;
      replScore[rp] = byPos[rp][rank] ? byPos[rp][rank].score : 0;
    }

    var vorpMap = new Map();
    for (var k = 0; k < players.length; k++) {
      var pl2 = players[k];
      if (!byPos.hasOwnProperty(pl2.position)) continue;
      var sc = scorePlayer(pl2, projections, scoringSettings);
      vorpMap.set(pl2.player_id, Math.max(0, sc - (replScore[pl2.position] || 0)));
    }
    return vorpMap;
  }

  // Apply ^1.25 power curve and rescale to 0–10000
  function rescaleVORP(vorpMap) {
    var maxV = 0;
    var powered = new Map();
    vorpMap.forEach(function (vorp, id) {
      var v = Math.pow(vorp, 1.25);
      powered.set(id, v);
      if (v > maxV) maxV = v;
    });
    var scaled = new Map();
    powered.forEach(function (v, id) {
      scaled.set(id, maxV > 0 ? Math.round(v / maxV * 10000) : 0);
    });
    return scaled;
  }

  // givePlayers / receivePlayers: arrays of player_ids (from giver's perspective)
  // verdict: WIN = giver gets more value, LOSE = giver gives more, FAIR = within ±10%
  function evaluateTrade(givePlayers, receivePlayers, vorpMap, _rosterPositions) {
    var giverValue = givePlayers.reduce(function (s, id) { return s + (vorpMap.get(id) || 0); }, 0);
    var receiverValue = receivePlayers.reduce(function (s, id) { return s + (vorpMap.get(id) || 0); }, 0);
    var maxVal = Math.max(giverValue, receiverValue, 1);
    var deltaPct = (receiverValue - giverValue) / maxVal;
    var verdict = Math.abs(deltaPct) <= 0.10 ? 'FAIR' : deltaPct > 0.10 ? 'WIN' : 'LOSE';
    return { giverValue: giverValue, receiverValue: receiverValue, verdict: verdict, deltaPct: deltaPct };
  }

  return { scorePlayer: scorePlayer, computeVORP: computeVORP, rescaleVORP: rescaleVORP, evaluateTrade: evaluateTrade };
})();

if (typeof module !== 'undefined') module.exports = ScoringEngine;
