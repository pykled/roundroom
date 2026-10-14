/* Pocket NBA waivers page — pure logic (UMD: window.NbaWaivers / require).
   No DOM, no fetch. Tested by scripts/test-nba-waivers.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NbaWaivers = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var HORIZONS = [1, 2, 4];
  var MANUAL_KEY = 'pocket-nba-waivers:manual';
  var PREFS_KEY = 'pocket-nba-waivers:prefs';
  var DRAFT_MANUAL_KEY = 'pocket-nba-draft:manual';
  var MAX_ROSTER = 20;
  var MAX_EXCLUDE = 400;

  function normalizeHorizon(v) { var n = Number(v); return HORIZONS.indexOf(n) >= 0 ? n : 1; }

  function num(x) { var n = Number(x); return isFinite(n) ? n : 0; }

  // "+3.4", "0.0", "−1.2" (true minus sign for display)
  function fmtGain(x) {
    var n = Math.round(num(x) * 10) / 10;
    if (n > 0) return '+' + n.toFixed(1);
    if (n < 0) return '−' + Math.abs(n).toFixed(1);
    return '0.0';
  }
  function fmt1(x) { return (Math.round(num(x) * 10) / 10).toFixed(1); }

  // Games chip tone: 4+ is the High Score edge, 2 or fewer is a light week.
  function gamesTone(n) { n = num(n); return n >= 4 ? 'hi' : n > 0 && n <= 2 ? 'lo' : n === 0 ? 'zero' : ''; }

  function stripAccents(s) {
    s = String(s || '').toLowerCase();
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* old engines */ }
    return s.replace(/[.'’]/g, '');
  }

  // filters: { pos: 'ALL'|'G'|'F', roleUp: bool, hideInjured: bool, q: string }
  function filterTargets(targets, f) {
    f = f || {};
    var q = stripAccents(f.q || '').trim();
    return (targets || []).filter(function (t) {
      if (!t) return false;
      var el = t.elig || [];
      if (f.pos === 'G' && el.indexOf('G') < 0) return false;
      if (f.pos === 'F' && el.indexOf('F') < 0) return false;
      if (f.roleUp && !t.roleUp) return false;
      if (f.hideInjured && t.injury) return false;
      if (q && stripAccents(t.name).indexOf(q) < 0 && stripAccents(t.team).indexOf(q) < 0) return false;
      return true;
    });
  }

  // Sort: 'gain' (engine order), 'ceiling', 'games' (games this week, then gain).
  function sortTargets(targets, by) {
    var list = (targets || []).slice();
    if (by === 'ceiling') list.sort(function (a, b) { return num(b.ceiling) - num(a.ceiling) || num(b.netGain) - num(a.netGain); });
    else if (by === 'games') list.sort(function (a, b) { return num((b.gamesByWeek || [])[0]) - num((a.gamesByWeek || [])[0]) || num(b.netGain) - num(a.netGain); });
    return list;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) : '';
  }
  function weekLabel(week, dates) {
    var d = dates && dates[week];
    var span = d ? shortDate(d.start) + '–' + shortDate(d.end) : '';
    return { title: 'Wk ' + week, span: span };
  }

  // Injury tag short form, shared look with the draft board.
  function injuryTag(s) {
    if (!s) return null;
    var u = String(s).toUpperCase();
    if (/OUT|^O$|IR|IL|INJ|SEASON/.test(u)) return 'OUT';
    if (/SUS/.test(u)) return 'SUS';
    if (/DOUBT|^D$/.test(u)) return 'D';
    if (/GTD|DTD|DAY|QUEST|^Q$/.test(u)) return 'GTD';
    return 'P';
  }

  // ---- manual roster state ---------------------------------------------
  function emptyManual() { return { v: 1, roster: [], exclude: [] }; }
  function cleanIds(a, max) {
    var out = [];
    (Array.isArray(a) ? a : []).forEach(function (x) {
      var s = String(x == null ? '' : x);
      if (/^[A-Za-z0-9_-]{1,16}$/.test(s) && out.indexOf(s) < 0 && out.length < max) out.push(s);
    });
    return out;
  }
  function loadManual(raw) {
    var o;
    try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return emptyManual(); }
    if (!o || typeof o !== 'object' || o.v !== 1) return emptyManual();
    var roster = cleanIds(o.roster, MAX_ROSTER);
    return { v: 1, roster: roster, exclude: cleanIds(o.exclude, MAX_EXCLUDE).filter(function (id) { return roster.indexOf(id) < 0; }) };
  }
  function saveManual(st) { return JSON.stringify(loadManual(st)); }
  function addToRoster(st, id) {
    st = loadManual(st); id = String(id);
    if (st.roster.indexOf(id) < 0 && st.roster.length < MAX_ROSTER) st.roster.push(id);
    st.exclude = st.exclude.filter(function (x) { return x !== id; });
    return st;
  }
  function removeFromRoster(st, id) { st = loadManual(st); st.roster = st.roster.filter(function (x) { return x !== String(id); }); return st; }
  function toggleExclude(st, id) {
    st = loadManual(st); id = String(id);
    if (st.roster.indexOf(id) >= 0) return st;
    var i = st.exclude.indexOf(id);
    if (i >= 0) st.exclude.splice(i, 1); else if (st.exclude.length < MAX_EXCLUDE) st.exclude.push(id);
    return st;
  }
  // The draft board's manual state: my picks → roster, everyone else's → exclude.
  function importFromDraft(raw) {
    var o;
    try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
    if (!o || !Array.isArray(o.manual)) return null;
    var st = emptyManual();
    o.manual.forEach(function (m) {
      if (!m || m.playerId == null) return;
      if (m.mine) st = addToRoster(st, m.playerId); else st = toggleExclude(st, m.playerId);
    });
    return st.roster.length ? st : null;
  }
  function manualRequest(st, horizon, week) {
    st = loadManual(st);
    var body = { roster: st.roster, weeks: normalizeHorizon(horizon) };
    if (st.exclude.length) body.exclude = st.exclude;
    if (week) body.week = Number(week);
    return body;
  }

  // Accent-insensitive player search for the roster editor.
  function searchPlayers(players, q, skipIds, limit) {
    q = stripAccents(q).trim();
    if (!q) return [];
    var skip = {}; (skipIds || []).forEach(function (id) { skip[String(id)] = 1; });
    var out = [];
    for (var i = 0; i < (players || []).length && out.length < (limit || 8); i++) {
      var p = players[i];
      if (!p || skip[String(p.id)]) continue;
      if (stripAccents(p.name).indexOf(q) >= 0) out.push(p);
    }
    return out;
  }

  function prefs(raw) {
    var o; try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { o = null; }
    o = o && typeof o === 'object' ? o : {};
    return {
      horizon: normalizeHorizon(o.horizon), pos: o.pos === 'G' || o.pos === 'F' ? o.pos : 'ALL',
      roleUp: !!o.roleUp, sort: o.sort === 'ceiling' || o.sort === 'games' ? o.sort : 'gain',
      source: typeof o.source === 'string' ? o.source : null,
    };
  }

  return {
    HORIZONS: HORIZONS, MANUAL_KEY: MANUAL_KEY, PREFS_KEY: PREFS_KEY, DRAFT_MANUAL_KEY: DRAFT_MANUAL_KEY, MAX_ROSTER: MAX_ROSTER,
    normalizeHorizon: normalizeHorizon, fmtGain: fmtGain, fmt1: fmt1, gamesTone: gamesTone, stripAccents: stripAccents,
    filterTargets: filterTargets, sortTargets: sortTargets, weekLabel: weekLabel, shortDate: shortDate, injuryTag: injuryTag,
    emptyManual: emptyManual, loadManual: loadManual, saveManual: saveManual, addToRoster: addToRoster,
    removeFromRoster: removeFromRoster, toggleExclude: toggleExclude, importFromDraft: importFromDraft,
    manualRequest: manualRequest, searchPlayers: searchPlayers, prefs: prefs
  };
}));
