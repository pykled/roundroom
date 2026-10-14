/* Pocket NBA — trade calculator page logic (stream E).
   Pure functions only: no DOM, no fetch, no storage. Loaded as a plain
   <script> (window.NbaTrade) and via require() in scripts/test-nba-trade.js.
   Valuation itself is server-side (nba/model/trade.js); this module only
   shapes state, requests and display strings.

   state { mode: 'manual'|'yahoo', leagueKey, myTeamKey, partnerKey,
           myRoster: [id], give: [id], get: [id] } */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NbaTrade = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORAGE_KEY = 'pocket-nba-trade:v1';
  var DRAFT_KEY = 'pocket-nba-draft:manual';
  var MAX_SIDE = 6;

  function emptyState() {
    return { mode: 'manual', leagueKey: null, myTeamKey: null, partnerKey: null, myRoster: [], give: [], get: [] };
  }

  function uniq(a) {
    var seen = {}, out = [];
    (a || []).forEach(function (x) { x = String(x); if (!seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }

  // Tap a player onto/off a side. A player lives on one side only.
  function toggle(state, side, id) {
    id = String(id);
    var other = side === 'give' ? 'get' : 'give';
    var next = Object.assign({}, state, { give: state.give.slice(), get: state.get.slice() });
    var i = next[side].indexOf(id);
    if (i >= 0) next[side].splice(i, 1);
    else if (next[side].length < MAX_SIDE) {
      next[side].push(id);
      var j = next[other].indexOf(id);
      if (j >= 0) next[other].splice(j, 1);
    }
    return next;
  }

  function canEvaluate(state) { return !!(state && (state.give.length || state.get.length)); }

  // POST /api/nba/trade/evaluate body. Yahoo mode adds the partner's roster and league.
  function requestBody(state, ctx) {
    var body = { give: state.give.slice(), get: state.get.slice(), myRoster: uniq(state.myRoster.concat(state.give)) };
    if (state.mode === 'yahoo' && ctx && state.leagueKey) {
      body.league_key = state.leagueKey;
      var partner = teamOf(ctx, state.partnerKey);
      if (partner) body.partnerRoster = rosterIds(partner);
    }
    return body;
  }

  function teamOf(ctx, key) {
    if (!ctx || !ctx.teams) return null;
    for (var i = 0; i < ctx.teams.length; i++) if (ctx.teams[i].team_key === key) return ctx.teams[i];
    return null;
  }
  function rosterIds(team) {
    return (team && team.players || []).map(function (p) { return p.sleeperId; }).filter(Boolean).map(String);
  }

  function fold(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '');
  }
  function search(players, q, limit) {
    var f = fold(q).trim();
    if (!f) return [];
    var out = [];
    for (var i = 0; i < players.length && out.length < (limit || 12); i++) {
      if (fold(players[i].name).indexOf(f) >= 0) out.push(players[i]);
    }
    return out;
  }

  // "+3.2" / "−1.0" with a real minus sign.
  function signed(n, digits) {
    var d = digits == null ? 1 : digits;
    var x = Number(n) || 0;
    var s = Math.abs(x).toFixed(d);
    if (Number(s) === 0) return (0).toFixed(d);
    return (x > 0 ? '+' : '−') + s;
  }
  function range(r) { return r ? signed(r[0]) + ' to ' + signed(r[1]) : ''; }

  function verdictTone(v) { return v === 'Accept' ? 'good' : v === 'Decline' ? 'bad' : v === 'Counter' ? 'warn' : 'none'; }
  function likelyText(l, estimated) {
    var who = estimated ? 'A typical partner' : 'They';
    return { likely: who + ' should accept', maybe: who + ' might accept', unlikely: who + ' will probably decline' }[l] || '';
  }

  // Bar heights for the per-week strip: [-1, 1] scaled to the largest |Δ|.
  function weekBars(weeks) {
    var m = 0;
    (weeks || []).forEach(function (w) { m = Math.max(m, Math.abs(w.you || 0)); });
    return (weeks || []).map(function (w) { return { week: w.week, playoff: !!w.playoff, h: m ? (w.you || 0) / m : 0, you: w.you || 0, games: (w.gamesIn || 0) - (w.gamesOut || 0) }; });
  }

  function serialize(state) {
    return JSON.stringify({
      v: 1, mode: state.mode, leagueKey: state.leagueKey || null, myTeamKey: state.myTeamKey || null, partnerKey: state.partnerKey || null,
      myRoster: uniq(state.myRoster), give: uniq(state.give), get: uniq(state.get)
    });
  }
  function parseState(raw) {
    var st = emptyState();
    var o;
    try { o = JSON.parse(raw); } catch (e) { return st; }
    if (!o || typeof o !== 'object' || o.v !== 1) return st;
    st.mode = o.mode === 'yahoo' ? 'yahoo' : 'manual';
    st.leagueKey = typeof o.leagueKey === 'string' ? o.leagueKey : null;
    st.myTeamKey = typeof o.myTeamKey === 'string' ? o.myTeamKey : null;
    st.partnerKey = typeof o.partnerKey === 'string' ? o.partnerKey : null;
    ['myRoster', 'give', 'get'].forEach(function (k) { st[k] = Array.isArray(o[k]) ? uniq(o[k]).slice(0, k === 'myRoster' ? 25 : MAX_SIDE) : []; });
    return st;
  }

  // My picks from the draft board's manual state (localStorage['pocket-nba-draft:manual']).
  function draftImport(raw) {
    var o;
    try { o = JSON.parse(raw); } catch (e) { return []; }
    var m = o && Array.isArray(o.manual) ? o.manual : [];
    return uniq(m.filter(function (x) { return x && x.mine && x.playerId != null; }).map(function (x) { return x.playerId; }));
  }

  return {
    STORAGE_KEY: STORAGE_KEY, DRAFT_KEY: DRAFT_KEY, MAX_SIDE: MAX_SIDE,
    emptyState: emptyState, toggle: toggle, canEvaluate: canEvaluate, requestBody: requestBody,
    teamOf: teamOf, rosterIds: rosterIds, search: search, fold: fold,
    signed: signed, range: range, verdictTone: verdictTone, likelyText: likelyText, weekBars: weekBars,
    serialize: serialize, parseState: parseState, draftImport: draftImport
  };
});
