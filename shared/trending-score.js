// Trending players score — pure functions shared by trending.html (browser) and
// /api/trending in server.js. Computes a [-1,+1] trend score per player from
// usage deltas (week-over-week role change), form vs projection, and Sleeper
// add/drop market momentum.
//
//   trend = 0.35·usageΔ + 0.25·form + 0.25·market + 0.15·stepUp
//
// scoreTrending(players, usageByWeek, pointsByWeek, projByWeek,
//               trendingAdds, trendingDrops, opts)
//
//   players:       { id: { name, pos, team, injury } }
//   usageByWeek:   { week: { playerId: { tgtShare, carryShare, snapPct } } }
//   pointsByWeek:  { week: { playerId: { pts_half_ppr, pts_ppr, pts_std } } }
//   projByWeek:    { week: { playerId: { pts_half_ppr, pts_ppr, pts_std } } }
//   trendingAdds:  [{ player_id, count }] sorted desc, limit 100, numeric ids only
//   trendingDrops: same for drops
//   opts:          { pos: 'ALL'|'QB'|'RB'|'WR'|'TE', scoring: 'half_ppr'|'ppr'|'std',
//                    n: 10, week: N (last completed week number) }
//
// Returns { up: [...], down: [...], byId: { id: player } }
var TrendingScore = (function () {
  'use strict';

  var USAGE_POS = { RB: 1, WR: 1, TE: 1 };
  var SHARE_KEY = { RB: 'carryShare', WR: 'tgtShare', TE: 'tgtShare' };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function formatCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }

  // Average a numeric field across an array of week-data dicts for a player id.
  function avgField(weekDicts, id, field) {
    var sum = 0, count = 0;
    for (var i = 0; i < weekDicts.length; i++) {
      var entry = weekDicts[i] && weekDicts[i][id];
      if (entry && entry[field] != null) { sum += entry[field]; count++; }
    }
    return count > 0 ? sum / count : null;
  }

  function scoreTrending(players, usageByWeek, pointsByWeek, projByWeek, trendingAdds, trendingDrops, opts) {
    opts = opts || {};
    var posFilter = opts.pos || 'ALL';
    var scoring = opts.scoring || 'half_ppr';
    var n = Math.min(opts.n || 10, 25);
    var scoringKey = 'pts_' + scoring;

    var allUsageWeeks = Object.keys(usageByWeek || {}).map(Number).sort(function (a, b) { return a - b; });
    var lastWeek = opts.week || (allUsageWeeks.length ? allUsageWeeks[allUsageWeeks.length - 1] : 1);
    var priorWeeks = allUsageWeeks.filter(function (w) { return w < lastWeek; });

    var priorUsageDicts = priorWeeks.map(function (w) { return usageByWeek[w] || {}; });
    var priorPointsDicts = priorWeeks.map(function (w) { return pointsByWeek[w] || {}; });
    var priorProjDicts   = priorWeeks.map(function (w) { return projByWeek[w]   || {}; });

    var lastUsage  = usageByWeek[lastWeek]  || {};
    var lastPoints = pointsByWeek[lastWeek] || {};
    var lastProj   = projByWeek[lastWeek]   || {};

    // Build add/drop lookup maps. trendingAdds is already sorted desc → index+1 = rank.
    var addMap = {}, dropMap = {}, addRankMap = {};
    var maxAddCount = 0, maxDropCount = 0;

    (trendingAdds || []).forEach(function (e, i) {
      addMap[e.player_id] = e.count;
      addRankMap[e.player_id] = i + 1;
      if (e.count > maxAddCount) maxAddCount = e.count;
    });
    (trendingDrops || []).forEach(function (e) {
      dropMap[e.player_id] = e.count;
      if (e.count > maxDropCount) maxDropCount = e.count;
    });

    var results = {};

    for (var id in players) {
      var p = players[id];
      if (!p) continue;
      if (posFilter !== 'ALL' && p.pos !== posFilter) continue;

      var addCount = addMap[id] || 0;
      var isUsagePos = !!USAGE_POS[p.pos];
      var shareKeyForPos = SHARE_KEY[p.pos] || null;

      // Eligibility: ≥1 completed week with a snap (RB/WR/TE) or pts > 0 (QB/other)
      var hasSnap = false;
      if (isUsagePos) {
        hasSnap = !!(lastUsage[id] && lastUsage[id].snapPct != null);
      } else {
        hasSnap = !!(lastPoints[id] && (lastPoints[id][scoringKey] || 0) > 0);
      }
      if (!hasSnap) continue;

      // Noise filter: must have significant market activity OR meaningful role change
      var rawShareChange = 0;
      if (isUsagePos && shareKeyForPos && lastUsage[id]) {
        var sNow = lastUsage[id][shareKeyForPos] || 0;
        var sPrev = avgField(priorUsageDicts, id, shareKeyForPos);
        rawShareChange = sPrev != null ? Math.abs(sNow - sPrev) : 0;
      }
      if (isUsagePos  && addCount < 1000 && rawShareChange < 0.1) continue;
      if (!isUsagePos && addCount < 1000) continue;

      // ── usageΔ component (RB/WR/TE only) ──────────────────────────────────
      var usageComponent = 0;
      var usageData = null;

      if (isUsagePos && lastUsage[id]) {
        var uRow = lastUsage[id];
        var shareNow = shareKeyForPos ? (uRow[shareKeyForPos] || 0) : 0;
        var snapNow  = uRow.snapPct || 0;

        var sharePriorAvg = shareKeyForPos ? avgField(priorUsageDicts, id, shareKeyForPos) : null;
        var snapPriorAvg  = avgField(priorUsageDicts, id, 'snapPct');

        var shareDeltaRaw = sharePriorAvg != null ? shareNow - sharePriorAvg : 0;
        var snapDeltaRaw  = snapPriorAvg  != null ? snapNow  - snapPriorAvg  : 0;

        // Scale: ±10pp share → ±1; ±20pp snap → ±1
        var shareDeltaNorm = clamp(shareDeltaRaw / 0.10, -1, 1);
        var snapDeltaNorm  = clamp(snapDeltaRaw  / 0.20, -1, 1);
        usageComponent = 0.6 * shareDeltaNorm + 0.4 * snapDeltaNorm;

        usageData = {
          week:      lastWeek,
          share:     shareNow,
          sharePrev: sharePriorAvg,
          snap:      snapNow,
          snapPrev:  snapPriorAvg,
        };
      }

      // ── form component ─────────────────────────────────────────────────────
      var formComponent = 0;
      var formData = null;

      var ptsRow  = lastPoints[id];
      var projRow = lastProj[id];
      var actual  = ptsRow  ? (ptsRow[scoringKey]  || 0) : 0;
      var proj    = projRow ? (projRow[scoringKey] || 0) : 0;

      if (actual > 0 || proj > 0) {
        var formLast = clamp((actual - proj) / Math.max(proj, 5), -1, 1);
        formComponent = formLast;

        if (priorWeeks.length > 0) {
          var ptsP  = (priorPointsDicts[priorPointsDicts.length - 1] || {})[id];
          var projP = (priorProjDicts[priorProjDicts.length - 1]   || {})[id];
          var actualP  = ptsP  ? (ptsP[scoringKey]  || 0) : 0;
          var projPv   = projP ? (projP[scoringKey] || 0) : 0;
          if (actualP > 0 || projPv > 0) {
            var formPrior = clamp((actualP - projPv) / Math.max(projPv, 5), -1, 1);
            formComponent = 0.6 * formLast + 0.4 * formPrior;
          }
        }

        formData = { week: lastWeek, actual: actual, proj: proj };
      }

      // ── leading indicator: snaps rising, production hasn't followed ────────
      var leadingFlag = false;
      if (usageData && usageData.snapPrev != null) {
        var snapDeltaNormCheck = clamp((usageData.snap - usageData.snapPrev) / 0.20, -1, 1);
        if (snapDeltaNormCheck > 0.4 && formComponent <= 0) leadingFlag = true;
      }

      // ── market component ───────────────────────────────────────────────────
      var addScore  = maxAddCount  > 0 ? Math.log(addCount  + 1) / Math.log(maxAddCount  + 1) : 0;
      var dropCount = dropMap[id] || 0;
      var dropScore = maxDropCount > 0 ? Math.log(dropCount + 1) / Math.log(maxDropCount + 1) : 0;
      var marketComponent = addScore - dropScore;

      var marketData = {
        adds24h:  addCount,
        addRank:  addRankMap[id] || null,
        drops24h: dropCount,
      };

      // ── stepUp component ───────────────────────────────────────────────────
      // TODO: stepUp — requires full teammate injury join with averageUsage;
      //       handled by the lineup optimizer and left for a future pass here.
      var stepUpComponent = 0;

      // ── composite score ────────────────────────────────────────────────────
      var trend = 0.35 * usageComponent + 0.25 * formComponent + 0.25 * marketComponent + 0.15 * stepUpComponent;
      trend = clamp(trend, -1, 1);

      // Confidence: count components with meaningful signal
      var nonZero = 0;
      if (Math.abs(usageComponent)   > 0.01) nonZero++;
      if (Math.abs(formComponent)    > 0.01) nonZero++;
      if (Math.abs(marketComponent)  > 0.01) nonZero++;
      if (Math.abs(stepUpComponent)  > 0.01) nonZero++;
      var confidence = nonZero >= 3 ? 'high' : nonZero >= 2 ? 'med' : 'low';

      // ── why strings ────────────────────────────────────────────────────────
      var why = [];

      if (usageData && usageData.sharePrev != null && shareKeyForPos) {
        var shareLabel = p.pos === 'RB' ? 'Carry share' : 'Target share';
        why.push(shareLabel + ' ' + Math.round(usageData.sharePrev * 100) + '% → ' + Math.round(usageData.share * 100) + '%');
      }

      if (leadingFlag && usageData && usageData.snapPrev != null) {
        why.push('Snaps rising (' + Math.round(usageData.snapPrev * 100) + '% → ' + Math.round(usageData.snap * 100) + '%), points haven\'t followed yet');
      }

      if (formData && formData.proj > 0) {
        var diff    = formData.actual - formData.proj;
        var diffPct = Math.round(Math.abs(diff) / Math.max(formData.proj, 5) * 100);
        if (diff > 1) {
          why.push('Outperformed proj by ' + diffPct + '% (' + formData.actual.toFixed(1) + ' vs ' + formData.proj.toFixed(1) + ')');
        } else if (diff < -1) {
          why.push('Underperformed proj by ' + diffPct + '%');
        }
      }

      if (marketData.addRank) {
        var rank = marketData.addRank;
        if (rank === 1) {
          why.push('#1 most-added on Sleeper (' + formatCount(addCount) + ' adds/24h)');
        } else if (rank <= 5) {
          why.push('Top-5 most-added on Sleeper');
        }
      }

      results[id] = {
        id:         id,
        name:       p.name,
        pos:        p.pos,
        team:       p.team,
        injury:     p.injury || null,
        trend:      +trend.toFixed(3),
        direction:  trend >= 0 ? 'up' : 'down',
        confidence: confidence,
        components: {
          usage:   +usageComponent.toFixed(3),
          form:    +formComponent.toFixed(3),
          market:  +marketComponent.toFixed(3),
          stepUp:  stepUpComponent,
        },
        usage:   usageData,
        form:    formData,
        market:  marketData,
        leading: leadingFlag,
        why:     why,
      };
    }

    var all = Object.keys(results).map(function (k) { return results[k]; });
    var up = all
      .filter(function (r) { return r.trend > 0; })
      .sort(function (a, b) { return b.trend - a.trend; })
      .slice(0, n);
    var down = all
      .filter(function (r) { return r.trend < 0; })
      .sort(function (a, b) { return a.trend - b.trend; })
      .slice(0, n);

    return { up: up, down: down, byId: results };
  }

  return { scoreTrending: scoreTrending };
})();

if (typeof module !== 'undefined') module.exports = TrendingScore;
