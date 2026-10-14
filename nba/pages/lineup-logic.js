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

  // "Nov 30" from an ISO date (UTC noon, so no timezone drift).
  function fmtDate(iso) {
    var t = Date.parse(String(iso || '') + 'T12:00:00Z');
    return isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
  }
  // "Nov 30 – Dec 13" / "Oct 20 – 25" (same month collapses).
  function fmtRange(start, end) {
    var a = fmtDate(start), b = fmtDate(end);
    if (!a || !b) return a || b || '';
    if (a.split(' ')[0] === b.split(' ')[0]) b = b.split(' ')[1];
    return a + ' – ' + b;
  }

  // Week picker rows from profile.weeks: [{ week, range, days, long, playoffs, current }].
  function weekOptions(weeks, currentWeek, maxWeek) {
    var out = [], n = (weeks && weeks.length) || maxWeek || 0;
    for (var w = 1; w <= n; w++) {
      var wk = weeks && weeks[w - 1];
      out.push({
        week: w, range: wk ? fmtRange(wk.start, wk.end) : '', days: wk ? wk.days : 7,
        long: !!(wk && wk.days > 7), playoffs: !!(wk && wk.playoffs), current: w === currentWeek
      });
    }
    return out;
  }

  // Optimal-vs-current diff → at most `max` plain-English moves, biggest gain first.
  // { i, text, inName, outName, slot, gain, gainText, warning, forfeits }
  function suggestions(result, max) {
    var diff = (result && result.diff) || [];
    var out = diff.map(function (d, i) {
      var text = d.out && d.in ? 'Start ' + d.in.name + ' over ' + d.out.name
        : d.in ? 'Start ' + d.in.name + ' at ' + d.slot
        : d.out ? 'Bench ' + d.out.name : '';
      return {
        i: i, text: text, inId: d.in ? String(d.in.id) : null, outId: d.out ? String(d.out.id) : null,
        inName: d.in ? d.in.name : null, outName: d.out ? d.out.name : null, slot: d.slot,
        gain: d.gain, gainText: sign(d.gain) + ' expected', warning: d.warning || null, forfeits: d.forfeits || 0
      };
    }).filter(function (s) { return s.text; });
    out.sort(function (a, b) { return (b.gain || 0) - (a.gain || 0); });
    return out.slice(0, max || 3);
  }

  function slotCounts(slotList) {
    var c = {};
    (slotList || []).forEach(function (s) { c[s] = (c[s] || 0) + 1; });
    return c;
  }
  // Is a manual roster's current lineup legal for the slot list (no slot over-filled)?
  function slotsFit(roster, slotList) {
    var cap = slotCounts(slotList), used = {};
    for (var i = 0; i < roster.length; i++) {
      var s = roster[i].slot;
      if (!s || s === 'BN' || s === 'IL') continue;
      used[s] = (used[s] || 0) + 1;
      if (!cap[s] || used[s] > cap[s]) return false;
    }
    return true;
  }
  // Apply the recommendation to a manual roster (pure; returns a new roster).
  //   index == null → the whole optimal lineup (starters to their slots, the rest BN, IL kept)
  //   index = i     → diff[i] plus the free active-slot shuffles (`moved`); falls back to
  //                   the whole lineup if that alone would over-fill a slot. → { roster, full }
  function applyMoves(roster, result, index) {
    var target = {};
    ((result && result.slots) || []).forEach(function (s) { if (s.player && s.player.id != null) target[String(s.player.id)] = s.slot; });
    var slotList = (result && result.spots && result.spots.slots) || ((result && result.slots) || []).map(function (s) { return s.slot; });
    function all() {
      return roster.map(function (r) {
        if (r.slot === 'IL' && !target[r.id]) return { id: r.id, slot: 'IL' };
        return { id: r.id, slot: target[r.id] || 'BN' };
      });
    }
    var d = index == null ? null : ((result && result.diff) || [])[index];
    if (!d) return { roster: all(), full: true };
    var next = roster.map(function (r) { return { id: r.id, slot: r.slot }; });
    function set(id, slot) { next.forEach(function (r) { if (r.id === String(id)) r.slot = slot; }); }
    if (d.out) set(d.out.id, 'BN');
    if (d.in) set(d.in.id, target[String(d.in.id)] || d.slot);
    ((result && result.moved) || []).forEach(function (m) { set(m.id, m.to); });
    if (!slotsFit(next, slotList)) return { roster: all(), full: true };
    return { roster: next, full: false };
  }

  // "Updated 3h ago" from an ISO timestamp.
  function freshness(asOf, now) {
    var t = Date.parse(asOf || '');
    if (!isFinite(t)) return '';
    var m = Math.max(0, Math.round(((now == null ? Date.now() : now) - t) / 60000));
    if (m < 2) return 'Updated just now';
    if (m < 60) return 'Updated ' + m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 48) return 'Updated ' + h + 'h ago';
    return 'Updated ' + Math.round(h / 24) + 'd ago';
  }

  // Yahoo team page from a team key ("466.l.242808.t.3").
  function yahooTeamUrl(teamKey) {
    var m = /\.l\.(\d+)\.t\.(\d+)$/.exec(String(teamKey || ''));
    return m ? 'https://basketball.fantasysports.yahoo.com/nba/' + m[1] + '/' + m[2] : 'https://basketball.fantasysports.yahoo.com/nba';
  }

  return {
    fmtDate: fmtDate, fmtRange: fmtRange, weekOptions: weekOptions, suggestions: suggestions,
    slotsFit: slotsFit, applyMoves: applyMoves, freshness: freshness, yahooTeamUrl: yahooTeamUrl,
    STORAGE_PREFIX: STORAGE_PREFIX, MAX_ROSTER: MAX_ROSTER, SLOT_CHOICES: SLOT_CHOICES,
    slotChoices: slotChoices, slotGroup: slotGroup, scoringText: scoringText, slotListText: slotListText, countWord: countWord,
    normName: normName, searchPlayers: searchPlayers, parseRosterText: parseRosterText,
    emptyManual: emptyManual, storageKey: storageKey, serialize: serialize, deserialize: deserialize,
    bankedFor: bankedFor, setBanked: setBanked, bankedQuery: bankedQuery, manualBody: manualBody,
    dayChips: dayChips, diffText: diffText, sign: sign, gamePips: gamePips, winText: winText, bandGeometry: bandGeometry
  };
});
