/* Pocket NBA — weekly lineup picker logic (stream D).
   Pure functions only: no DOM, no fetch, no storage access. Loaded as a plain
   <script> in the browser (exposes window.NbaLineup) and via require() in node
   (scripts/test-nba-lineup.js). The optimiser itself runs server-side
   (nba/model/lineup.js); this file only shapes inputs and formats output. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NbaLineup = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORAGE_PREFIX = 'pocket-nba-lineup:';
  var MAX_ROSTER = 20;
  // Every slot name any profile uses (242808: PG…C, UTIL; High Score: G, FC, UTIL).
  var SLOT_CHOICES = ['BN', 'PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'FC', 'UTIL', 'IL'];
  var SLOT_GROUP = { PG: 'G', SG: 'G', G: 'G', SF: 'F', PF: 'F', F: 'F', FC: 'F', C: 'C', UTIL: 'UTIL' };
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function normName(s) {
    return String(s == null ? '' : s).toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[ıİ]/g, 'i').replace(/ø/g, 'o').replace(/đ/g, 'd').replace(/ł/g, 'l').replace(/ß/g, 'ss')
      .replace(/[.'’]/g, '').replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
  }

  // Search the board by name/team; best matches first (prefix > word prefix > contains).
  function searchPlayers(q, players, limit) {
    var n = normName(q);
    if (!n) return [];
    var out = [];
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      var name = normName(p.name);
      var score = name === n ? 0 : name.indexOf(n) === 0 ? 1 : (' ' + name).indexOf(' ' + n) >= 0 ? 2 : name.indexOf(n) >= 0 ? 3 : String(p.team || '').toLowerCase() === n ? 4 : -1;
      if (score >= 0) out.push({ p: p, s: score });
    }
    out.sort(function (a, b) { return a.s - b.s || (a.p.rank || 9999) - (b.p.rank || 9999); });
    return out.slice(0, limit || 8).map(function (x) { return x.p; });
  }

  // Pasted roster text (lines / commas / semicolons) → { ids, unknown }.
  // A name maps only when it is an exact normalized match or a unique prefix/word match.
  function parseRosterText(text, players) {
    var byNorm = {};
    players.forEach(function (p) { var k = normName(p.name); (byNorm[k] = byNorm[k] || []).push(p); });
    var ids = [], unknown = [], seen = {};
    String(text || '').split(/[\n,;]+/).forEach(function (raw) {
      var line = raw.replace(/\(.*?\)/g, '').replace(/\b(PG|SG|SF|PF|C|G|F|UTIL|BN|IL\+?|GTD|DTD|O|Q|INJ)\b/g, ' ').replace(/\s+-\s+.*$/, '').trim();
      if (!line) return;
      var n = normName(line);
      var hit = byNorm[n] && byNorm[n].length === 1 ? byNorm[n][0] : null;
      if (!hit) {
        var cands = searchPlayers(line, players, 3).filter(function (p) { return normName(p.name).indexOf(n) >= 0; });
        if (cands.length === 1) hit = cands[0];
      }
      if (hit) { if (!seen[hit.id]) { seen[hit.id] = 1; ids.push(String(hit.id)); } }
      else unknown.push(raw.trim());
    });
    return { ids: ids.slice(0, MAX_ROSTER), unknown: unknown };
  }

  function emptyManual() { return { v: 1, roster: [], opponent: [], updatedAt: 0 }; }
  function storageKey(scope) { return STORAGE_PREFIX + (scope || 'manual'); }
  function serialize(state) { return JSON.stringify(state); }
  function deserialize(raw) {
    var s = emptyManual();
    try {
      var j = JSON.parse(raw);
      if (!j || typeof j !== 'object') return s;
      if (Array.isArray(j.roster)) s.roster = j.roster.filter(function (r) { return r && /^[A-Za-z0-9_-]{1,24}$/.test(String(r.id)); }).slice(0, MAX_ROSTER).map(function (r) {
        return { id: String(r.id), slot: SLOT_CHOICES.indexOf(r.slot) >= 0 ? r.slot : 'BN' };
      });
      if (Array.isArray(j.opponent)) s.opponent = j.opponent.map(String).filter(function (id) { return /^[A-Za-z0-9_-]{1,24}$/.test(id); }).slice(0, MAX_ROSTER);
      if (j.banked && typeof j.banked === 'object') s.banked = j.banked;
      s.updatedAt = Number(j.updatedAt) || 0;
    } catch (e) { /* corrupt → empty */ }
    return s;
  }

  // Banked scores are per week: { [week]: { [id]: score } }.
  function bankedFor(banked, week) { return (banked && banked[week]) || {}; }
  function setBanked(banked, week, id, score) {
    var out = {}; var k;
    for (k in (banked || {})) out[k] = Object.assign({}, banked[k]);
    out[week] = out[week] || {};
    var x = Number(score);
    if (score === '' || score == null || !isFinite(x) || x <= 0) delete out[week][id];
    else out[week][id] = Math.min(300, Math.round(x * 10) / 10);
    return out;
  }
  function bankedQuery(map) {
    return Object.keys(map || {}).filter(function (id) { return map[id] > 0; }).map(function (id) { return id + ':' + map[id]; }).join(',');
  }

  // Slot picker options for a profile's starting slots: bench, each slot once, IL.
  function slotChoices(slotList, ilSlots) {
    var seen = {}, out = ['BN'];
    (slotList || ['G', 'F', 'UTIL']).forEach(function (s) { if (!seen[s]) { seen[s] = 1; out.push(s); } });
    if (ilSlots == null || ilSlots > 0) out.push('IL');
    return out;
  }
  // CSS colour group for a slot or position badge.
  function slotGroup(s) { return SLOT_GROUP[s] || 'UTIL'; }
  // "PTS 1 · REB 1.2 · AST 1.5 · … · DD +5" from a profile scoring map.
  function scoringText(sc) {
    if (!sc) return '';
    var lab = { pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO', pf: 'PF', tech: 'TECH', dd: 'DD', td: 'TD' };
    return Object.keys(lab).filter(function (k) { return sc[k]; }).map(function (k) {
      var v = sc[k];
      return lab[k] + ' ' + (k === 'dd' || k === 'td' ? '+' + v : v < 0 ? '−' + Math.abs(v) : v);
    }).join(' · ');
  }
  // "PG, SG, G, SF, PF, F, C, 2 UTIL"
  function slotListText(slotList) {
    var counts = {}, order = [];
    (slotList || []).forEach(function (s) { if (!counts[s]) order.push(s); counts[s] = (counts[s] || 0) + 1; });
    return order.map(function (s) { return (counts[s] > 1 ? counts[s] + ' ' : '') + s; }).join(', ');
  }
  var NUM_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  function countWord(n) { return NUM_WORD[n] || String(n); }

  function manualBody(state, week, day, leagueId) {
    var b = bankedFor(state.banked, week);
    var body = {
      week: week,
      roster: state.roster.map(function (r) {
        var e = { id: r.id, slot: r.slot || 'BN' };
        if (r.slot && r.slot !== 'BN' && r.slot !== 'IL' && b[r.id] > 0) e.banked = b[r.id];
        return e;
      })
    };
    if (day != null) body.day = day;
    if (state.opponent && state.opponent.length) body.opponent = state.opponent.slice();
    if (leagueId) body.league_id = String(leagueId);
    return body;
  }

  // Day chips for the week: [{ day, label, date }] (day = index of "today": games before it are played).
  function dayChips(dates, weekLength) {
    var len = weekLength || 7;
    var start = dates && dates[0] ? Date.parse(dates[0] + 'T12:00:00Z') : NaN;
    var out = [];
    for (var d = 0; d < len; d++) {
      var label = 'D' + (d + 1), date = null;
      if (isFinite(start)) {
        var t = new Date(start + d * 86400000);
        label = DOW[t.getUTCDay()]; date = t.getUTCDate();
      }
      out.push({ day: d, label: label, date: date });
    }
    return out;
  }

  function sign(v) { return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1); }
  function diffText(d) {
    if (d.out && d.in) return 'Swap ' + d.out.name + ' for ' + d.in.name + ': ' + sign(d.gain) + ' expected';
    if (d.in) return 'Start ' + d.in.name + ' at ' + d.slot + ': ' + sign(d.gain) + ' expected';
    if (d.out) return 'Bench ' + d.out.name + ': ' + sign(d.gain) + ' expected';
    return '';
  }

  // Games-left pips: played (dim) then remaining (lit).
  function gamePips(gamesLeft, gamesWeek) {
    var total = Math.max(gamesWeek || 0, gamesLeft || 0), out = [];
    for (var i = 0; i < total; i++) out.push(i >= total - (gamesLeft || 0) ? 'left' : 'done');
    return out;
  }

  function winText(p) {
    if (typeof p !== 'number' || !isFinite(p)) return '';
    var pct = Math.round(p * 100);
    if (pct >= 99 && p < 1) return '>99%';
    if (pct <= 1 && p > 0) return '<1%';
    return pct + '%';
  }

  // Map the band onto a 0..100 track: [lo, hi] padded 8% each side.
  function bandGeometry(total) {
    if (!total || !isFinite(total.p10) || !isFinite(total.p90) || total.p90 <= total.p10) return null;
    var pad = (total.p90 - total.p10) * 0.35;
    var lo = total.p10 - pad, hi = total.p90 + pad, span = hi - lo;
    var at = function (x) { return Math.max(0, Math.min(100, ((x - lo) / span) * 100)); };
    return { left: at(total.p10), width: at(total.p90) - at(total.p10), mark: at(total.expected) };
  }

  return {
    STORAGE_PREFIX: STORAGE_PREFIX, MAX_ROSTER: MAX_ROSTER, SLOT_CHOICES: SLOT_CHOICES,
    slotChoices: slotChoices, slotGroup: slotGroup, scoringText: scoringText, slotListText: slotListText, countWord: countWord,
    normName: normName, searchPlayers: searchPlayers, parseRosterText: parseRosterText,
    emptyManual: emptyManual, storageKey: storageKey, serialize: serialize, deserialize: deserialize,
    bankedFor: bankedFor, setBanked: setBanked, bankedQuery: bankedQuery, manualBody: manualBody,
    dayChips: dayChips, diffText: diffText, sign: sign, gamePips: gamePips, winText: winText, bandGeometry: bandGeometry
  };
});
