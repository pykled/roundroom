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

  /* ---------------------------------------------------- P4 view helpers */

  // Server copy uses an ASCII hyphen for negatives ("-1.3/wk"); show a real minus.
  function cleanText(s) {
    return String(s == null ? '' : s).replace(/(^|[\s(\[])-(\d)/g, '$1−$2');
  }

  // Fairness marker for the meter: 0 = all for them, 0.5 = even, 1 = all for you.
  // Driven by the gap between the two sides, scaled by the fair band so a
  // within-band deal sits near the middle and a 4-band gap pins the end.
  function fairness(r) {
    if (!r || !r.you || !r.them) return null;
    var band = Math.max(1, (r.meta && r.meta.fairBand) || 1);
    var gap = (Number(r.you.perWeek) || 0) - (Number(r.them.perWeek) || 0);
    var x = gap / (8 * band);
    var pos = 0.5 + Math.max(-0.5, Math.min(0.5, x));
    var a = Math.abs(gap) / band;
    var label = a < 1 ? 'Even' : a < 2.5 ? (gap > 0 ? 'Leans your way' : 'Leans their way') : a < 6 ? (gap > 0 ? 'Favors you' : 'Favors them') : (gap > 0 ? 'Lopsided for you' : 'Lopsided for them');
    return { pos: Math.round(pos * 1000) / 1000, gap: Math.round(gap * 10) / 10, label: label, even: a < 1 };
  }

  // One plain-English line under the verdict word.
  function oneLiner(r, partnerName) {
    if (!r || !r.verdict) return '';
    var who = partnerName || 'they';
    var y = Number(r.you.perWeek) || 0, t = Number(r.them.perWeek) || 0;
    var you = Math.abs(y) < 0.05 ? 'barely changes your lineup' : (y > 0 ? 'adds ' : 'costs you ') + Math.abs(y).toFixed(1) + ' points a week';
    var them = Math.abs(t) < 0.05 ? who + ' break even' : who + (t > 0 ? ' gain ' : ' lose ') + Math.abs(t).toFixed(1);
    var lead = r.verdict === 'Accept' ? 'Take it. ' : r.verdict === 'Decline' ? 'Pass. ' : 'Close. ';
    var s = lead + 'It ' + you + ', and ' + them + '.';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Range visual: a symmetric axis around 0 that fits both sides' ranges.
  function rangeAxis(r) {
    if (!r || !r.you) return null;
    var vals = [];
    [r.you, r.them].forEach(function (s) { if (s && s.perWeekRange) vals.push(Math.abs(s.perWeekRange[0]), Math.abs(s.perWeekRange[1])); if (s) vals.push(Math.abs(s.perWeek || 0)); });
    var m = Math.max.apply(null, vals.concat([2]));
    var step = m <= 5 ? 5 : m <= 10 ? 10 : m <= 20 ? 20 : m <= 40 ? 40 : Math.ceil(m / 20) * 20;
    var at = function (x) { return Math.round(((Number(x) || 0) + step) / (2 * step) * 1000) / 10; };
    return { max: step, at: at };
  }

  // "Why" bullets with a tone each. Server bullets first (minus the roster note,
  // which gets its own row), then schedule / injury / hole notes derived here.
  function whyItems(r, byId) {
    if (!r || !r.verdict) return [];
    byId = byId || {};
    var out = [];
    (r.why || []).forEach(function (w) {
      if (w === r.consolidation) return;
      var tone = /costs|Losing|lose|−\d|-\d/.test(w) ? 'bad' : /\+\d|starts|adds|gain/.test(w) ? 'good' : 'flat';
      out.push({ text: cleanText(w), tone: tone });
    });
    var before = (r.lineup && r.lineup.before && r.lineup.before.starters) || [];
    var after = (r.lineup && r.lineup.after && r.lineup.after.starters) || [];
    before.forEach(function (b, i) {
      var a = after[i];
      if (b && !b.id && a && a.id) out.push({ text: 'Fills your ' + slotLabel(b.slot) + ' hole: ' + a.name + ' replaces a waiver add there.', tone: 'good' });
      if (b && b.id && a && !a.id) out.push({ text: 'Opens a hole at ' + slotLabel(b.slot) + ': you would start a waiver add there.', tone: 'bad' });
    });
    var w0 = (r.weeks || [])[0];
    if (w0) {
      var net = (w0.gamesIn || 0) - (w0.gamesOut || 0);
      if (net <= -2) out.push({ text: 'Costs you ' + (-net) + ' games in week ' + w0.week + ' (' + (w0.gamesIn || 0) + ' coming in, ' + (w0.gamesOut || 0) + ' going out).', tone: 'bad' });
      else if (net >= 2) out.push({ text: 'Adds ' + net + ' games in week ' + w0.week + ' (' + (w0.gamesIn || 0) + ' coming in, ' + (w0.gamesOut || 0) + ' going out).', tone: 'good' });
    }
    var po = { give: 0, get: 0 };
    (r.players || []).forEach(function (p) { po[p.side] = (po[p.side] || 0) + (p.playoffGames || 0); });
    var poNet = po.get - po.give;
    if ((r.players || []).length && Math.abs(poNet) >= 2 && !/playoff/i.test((r.why || []).join(' '))) {
      out.push({ text: (poNet > 0 ? '+' : '−') + Math.abs(poNet) + ' games in the playoff weeks' + (r.meta && r.meta.playoffStartWeek ? ' (from week ' + r.meta.playoffStartWeek + ')' : '') + '.', tone: poNet > 0 ? 'good' : 'bad' });
    }
    (r.players || []).forEach(function (p) {
      var ret = injuryReturn(byId[p.id] || p, r.meta && r.meta.currentWeek);
      if (!ret) return;
      if ((r.why || []).some(function (w) { return w.indexOf(p.name) >= 0 && /\((Out|IR|O)\)|out\b/i.test(w); })) return;
      out.push(p.side === 'get'
        ? { text: p.name + ' is out now: he scores ~0 for you until about week ' + ret.week + '. That wait is priced in.', tone: 'warn' }
        : { text: p.name + ' is out now, so you lose little until about week ' + ret.week + '.', tone: 'flat' });
    });
    return out;
  }

  // First week an injured player is back near full value (hsByWeek ≥ 60% of hsValue).
  function injuryReturn(p, currentWeek) {
    if (!p || !p.injury || !p.hsByWeek || p.outForSeason) return null;
    var cw = Number(currentWeek) || 1;
    var full = Number(p.hsValue) || 0;
    if (!full) return null;
    var now = Number(p.hsByWeek[cw]);
    if (!(now < 0.3 * full)) return null;
    var weeks = Object.keys(p.hsByWeek).map(Number).filter(function (w) { return w >= cw; }).sort(function (a, b) { return a - b; });
    for (var i = 0; i < weeks.length; i++) if (Number(p.hsByWeek[weeks[i]]) >= 0.6 * full) return { week: weeks[i], now: now };
    return null;
  }

  function slotLabel(s) { return String(s || '').replace(/^UTIL\d?$/, 'UTIL'); }

  // Lineup before/after rows for the slot board.
  function lineupRows(r) {
    if (!r || !r.lineup) return [];
    var b = r.lineup.before.starters || [], a = r.lineup.after.starters || [], ch = r.lineup.changed || [];
    return a.map(function (x, i) {
      var y = b[i] || {};
      return { slot: slotLabel(x.slot), key: x.slot, before: y, after: x, changed: ch.indexOf(x.slot) >= 0, delta: Math.round(((x.value || 0) - (y.value || 0)) * 10) / 10 };
    });
  }

  // Roster-spot notes (2-for-1, 3-for-2, forced drops).
  function rosterNotes(r) {
    if (!r || !r.verdict) return [];
    var out = [];
    if (r.consolidation) out.push(cleanText(r.consolidation));
    var d = r.roster && r.roster.you && r.roster.you.dropped;
    if (d && d.length && !/drop/.test(r.consolidation || '')) out.push('Roster is full: you would drop ' + d.map(function (x) { return x.name || x; }).join(', ') + ' to make room (counted).');
    return out;
  }

  // Quiet league-rule chips from meta.rules.
  function ruleChips(rules) {
    if (!rules) return [];
    var out = [];
    if (rules.tradeEnd) out.push({ text: rules.open ? 'Deadline ' + shortDate(rules.tradeEnd) + (rules.daysLeft != null ? ' · ' + rules.daysLeft + 'd left' : '') : 'Trade deadline passed', tone: rules.open ? '' : 'bad' });
    if (rules.review === 'commissioner') out.push({ text: 'Commissioner review' });
    else if (rules.review === 'league') out.push({ text: 'League vote' });
    if (rules.protestDays) out.push({ text: rules.protestDays + '-day protest window' });
    if (rules.draftPickTrades === false) out.push({ text: 'No draft-pick trades' });
    return out;
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1] : String(iso || '');
  }

  // Plain-text summary for the clipboard.
  function summaryText(r, st, byId, partnerName) {
    byId = byId || {};
    var name = function (id) { var p = byId[id]; return p ? p.name + (p.team ? ' (' + p.team + ')' : '') : String(id); };
    var lines = [];
    lines.push('Trade check · Pocket NBA' + (r && r.profile && r.profile.name ? ' · ' + r.profile.name : ''));
    lines.push('I give: ' + (st.give.length ? st.give.map(name).join(', ') : 'nothing'));
    lines.push('I get: ' + (st.get.length ? st.get.map(name).join(', ') : 'nothing') + (partnerName ? ' from ' + partnerName : ''));
    if (r && r.verdict) {
      lines.push('Verdict: ' + r.verdict.toUpperCase() + ' — ' + cleanText(r.headline));
      lines.push('Me: ' + signed(r.you.perWeek) + ' pts/wk (range ' + range(r.you.perWeekRange) + ')');
      lines.push((r.them.estimated ? 'Typical partner' : (partnerName || 'Them')) + ': ' + signed(r.them.perWeek) + ' pts/wk · ' + likelyText(r.them.likely, r.them.estimated).toLowerCase());
      whyItems(r, byId).slice(0, 4).forEach(function (w) { lines.push('• ' + w.text); });
    }
    lines.push('https://pocketff.com/nba/trade');
    return lines.join('\n');
  }

  // Example trade for a first visit (manual mode, empty roster): my team is the
  // 6th slot of a 12-team, 14-round snake by rank; I give my 2nd best and ask
  // for a similar player picked a slot later.
  function exampleTrade(players) {
    var pool = (players || []).filter(function (p) { return !p.outForSeason && p.rank; }).slice().sort(function (a, b) { return a.rank - b.rank; });
    if (pool.length < 200) return null;
    var mine = [], k = 0;
    for (var r = 0; r < 14; r++) for (var i = 0; i < 12; i++) { var p = pool[k++]; if ((r % 2 ? 11 - i : i) === 5) mine.push(String(p.id)); }
    var giveId = mine[1];
    var gp = pool.filter(function (p) { return String(p.id) === giveId; })[0];
    var target = pool.filter(function (p) { return mine.indexOf(String(p.id)) < 0 && p.rank > gp.rank && !p.injury; })[0];
    return { myRoster: mine, give: [giveId], get: target ? [String(target.id)] : [] };
  }

  return {
    STORAGE_KEY: STORAGE_KEY, DRAFT_KEY: DRAFT_KEY, MAX_SIDE: MAX_SIDE,
    emptyState: emptyState, toggle: toggle, canEvaluate: canEvaluate, requestBody: requestBody,
    teamOf: teamOf, rosterIds: rosterIds, search: search, fold: fold,
    signed: signed, range: range, verdictTone: verdictTone, likelyText: likelyText, weekBars: weekBars,
    serialize: serialize, parseState: parseState, draftImport: draftImport,
    cleanText: cleanText, fairness: fairness, oneLiner: oneLiner, rangeAxis: rangeAxis, whyItems: whyItems,
    injuryReturn: injuryReturn, slotLabel: slotLabel, lineupRows: lineupRows, rosterNotes: rosterNotes,
    ruleChips: ruleChips, shortDate: shortDate, summaryText: summaryText, exampleTrade: exampleTrade
  };
});
