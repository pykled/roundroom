// Lineup optimizer — pure functions shared by lineup.html (browser) and tests (node).
// Works on top of ScoringEngine values: callers supply a value per player and the
// league's roster_positions; this module only decides who fills which slot.
var LineupOptimizer = (function () {
  'use strict';

  var SLOT_ELIGIBLE = {
    QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'],
    FLEX: ['RB', 'WR', 'TE'],
    WRRB_FLEX: ['RB', 'WR'],
    REC_FLEX: ['WR', 'TE'],
    SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  };
  var FLEX_SLOTS = { FLEX: 1, WRRB_FLEX: 1, REC_FLEX: 1, SUPER_FLEX: 1 };
  var NON_STARTER = { BN: 1, IR: 1, TAXI: 1 };

  function eligible(slot) { return SLOT_ELIGIBLE[slot] || null; }

  // Starter slots in display order, skipping bench/IR/taxi and unknown (IDP) slots.
  function starterSlots(rosterPositions) {
    var out = [];
    for (var i = 0; i < (rosterPositions || []).length; i++) {
      var s = rosterPositions[i];
      if (NON_STARTER[s] || !SLOT_ELIGIBLE[s]) continue;
      out.push({ slot: s, index: i });
    }
    return out;
  }

  // players: [{ id, position, value }]  (value = whatever the caller ranks by)
  // Greedy: dedicated slots first (highest value eligible player), then flex
  // slots in order, so a WR never gets pulled into FLEX before the WR slots
  // are full. Returns { starters: [{ slot, id|null }], bench: [id] }.
  function optimize(players, rosterPositions) {
    var slots = starterSlots(rosterPositions);
    var placed = {};
    var byValue = players.slice().sort(function (a, b) { return (b.value || 0) - (a.value || 0); });
    var result = slots.map(function (s) { return { slot: s.slot, index: s.index, id: null }; });

    function fill(pred) {
      for (var i = 0; i < result.length; i++) {
        var r = result[i];
        if (!pred(r.slot)) continue;
        var ok = SLOT_ELIGIBLE[r.slot];
        for (var j = 0; j < byValue.length; j++) {
          var p = byValue[j];
          if (placed[p.id] || ok.indexOf(p.position) < 0) continue;
          r.id = p.id; placed[p.id] = true;
          break;
        }
      }
    }
    fill(function (slot) { return !FLEX_SLOTS[slot]; });
    fill(function (slot) { return FLEX_SLOTS[slot]; });

    var bench = [];
    for (var k = 0; k < byValue.length; k++) if (!placed[byValue[k].id]) bench.push(byValue[k].id);
    return {
      starters: result.map(function (r) { return { slot: r.slot, id: r.id }; }),
      bench: bench,
    };
  }

  // Compare the optimal lineup with the one currently set on Sleeper.
  // currentStarters: Sleeper's roster.starters array (ids, "0" for empty).
  // Returns { in: [ids to start], out: [ids to bench] }.
  function diff(optimal, currentStarters) {
    var opt = {}, cur = {};
    optimal.starters.forEach(function (s) { if (s.id) opt[s.id] = true; });
    (currentStarters || []).forEach(function (id) { if (id && id !== '0') cur[id] = true; });
    var toStart = [], toBench = [];
    for (var a in opt) if (!cur[a]) toStart.push(a);
    for (var b in cur) if (!opt[b]) toBench.push(b);
    return { in: toStart, out: toBench };
  }

  return { optimize: optimize, diff: diff, starterSlots: starterSlots, eligible: eligible };
})();

if (typeof module !== 'undefined') module.exports = LineupOptimizer;
