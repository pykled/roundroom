/* Pocket NBA — draft board controller.
   Works with no Yahoo connection (manual tracking, localStorage per league) and
   upgrades to Yahoo-first live sync when /api/nba/yahoo/status says connected.
   Pure logic lives in draft-logic.js (window.NbaDraft); the look comes from the
   design system (nba-ui.css + window.NbaUI) plus draft-board.css.
   Board rows are keyed DOM nodes (built once per player, then only their state
   and order change), so a pick never re-creates 400 rows or reloads headshots. */
(function () {
  'use strict';
  var L = window.NbaDraft;
  var U = window.NbaUI;
  var $ = function (id) { return document.getElementById(id); };
  var LEAGUE_PREF = 'pocket-nba-league';
  var TIMER_PREF = 'pocket-nba-pick-timer';      // user's pick-timer seconds ('' = use league / default)
  var TIMER_RUN = 'pocket-nba-pick-timer-run';   // sessionStorage: [{leagueKey, pick, startedAt}] of recent running clocks
  var FIRSTRUN_PREF = 'pocket-nba-firstrun-done';
  var SORT_PREF = 'pocket-nba-board-sort';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var phoneMQ = window.matchMedia ? window.matchMedia('(max-width: 1023px)') : { matches: false };

  var S = {
    players: [], byId: {}, byYahooPid: {}, alias: {}, asOf: null,
    // league profile (GET /api/nba/league-profile); null until loaded / if unavailable
    profile: null, profileErr: false,
    state: L.emptyState(null),
    // yahoo
    connected: false, leagues: [], leagueKey: null, league: null, teams: [], myTeamKey: null,
    sync: 'off',            // off | connecting | live | degraded
    failures: 0, lastOk: 0, nextPollAt: 0, pollTimer: null, lastErr: '',
    auction: false, signedOut: false, yahooDown: false,
    // pick timer: restarts whenever the pick on the clock changes
    timer: { pick: null, startedAt: 0, beeped: false },
    // ui
    pos: 'ALL', q: '', showTaken: false, tierMax: 0, hideOut: false, sort: 'rank', view: 'board', sheetId: null, matching: null, pulse: [],
    merged: { picks: [], unmatched: [], confirmedManual: [] }, lastYahooCount: -1
  };
  try { var sp = localStorage.getItem(SORT_PREF); if (sp) S.sort = sp; } catch (e) {}

  /* ------------------------------------------------------------ utils */
  var esc = U.esc;
  function n1(v) { return typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—'; }
  function n0(v) { return typeof v === 'number' && isFinite(v) ? String(Math.round(v)) : '—'; }
  // Colour family for a slot / position: guards, forwards, centers, UTIL.
  function fam(t) { return /^(PG|SG|G)$/.test(t) ? 'G' : /^(SF|PF|F|FC)$/.test(t) ? 'F' : t === 'C' ? 'C' : 'UTIL'; }
  function slotLabel(t) { return t === 'UTIL' ? 'UTIL' : t === 'FC' ? 'F/C' : t; }
  // 'Michael Porter Jr.' → 'Porter', 'Jaren Jackson Jr.' → 'Jackson'.
  function shortName(name) {
    var w = String(name || '').split(' ').filter(Boolean);
    while (w.length > 1 && /^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(w[w.length - 1])) w.pop();
    return w[w.length - 1] || '';
  }
  function pill(x, low, why) {
    return '<span class="nu-pos' + (low ? ' is-est' : '') + '" data-pos="' + esc(x === 'FC' ? 'F' : x) + '"' + (low ? ' title="Not confirmed by Yahoo (' + esc(why) + ')"' : '') + '>' + esc(x === 'UTIL' ? 'UTL' : slotLabel(x)) + '</span>';
  }
  // Yahoo position pills; dashed + "?" when eligibility isn't confirmed by Yahoo.
  function posPills(p) {
    if (L.isLegacy(S.state.settings)) {
      var e = (p.elig || []).filter(function (x) { return x !== 'UTIL'; });
      if (!e.length) e = ['UTIL'];
      return '<span class="nu-pos-group">' + e.map(function (x) { return pill(x); }).join('') + '</span>';
    }
    var el = L.slotElig(p), list = L.displayPositions(p), low = el.source !== 'yahoo' || el.low;
    if (!list.length) list = ['UTIL'];
    var why = el.source !== 'yahoo' ? 'estimated positions' : 'eligibility source: ' + (p.eligConfidence == null ? 'unknown' : p.eligConfidence);
    return '<span class="nu-pos-group">' + list.map(function (x) { return pill(x, low, why); }).join('') + '</span>' +
      (low ? '<span class="nd-elig-badge" title="Positions not confirmed by Yahoo (' + esc(why) + ')" aria-label="Positions not confirmed by Yahoo">?</span>' : '');
  }
  function vorpTxt(p) { return typeof p.vorp === 'number' && isFinite(p.vorp) ? (p.vorp >= 0 ? '+' : '') + p.vorp.toFixed(1) : null; }
  function injBadge(p) { return p && (p.injury || p.outForSeason) ? U.injuryBadge(p.injury, { outForSeason: p.outForSeason }) : ''; }
  function isOut(p) { return /OUT|SUS/.test(L.injuryShort(p.injury)); }
  function gamesChip(p) {
    if (typeof p.games !== 'number') return '';
    var cls = p.games >= 4 ? ' hi' : p.games <= 2 ? ' lo' : '';
    return '<span class="nd-gm' + cls + '" title="' + esc(p.games) + ' games in a typical week">' + esc(+p.games.toFixed(1)) + 'g</span>';
  }
  function avatar(p, size, extra) { return U.avatar(p, Object.assign({ size: size }, extra || {})); }
  function teamName(slot) {
    if (slot === S.state.settings.mySlot) return 'You';
    if (S.teams && S.teams.length) {
      var t = S.teams.filter(function (x) { return parseInt(x.draft_position, 10) === slot; })[0];
      if (t && t.name) return t.name;
    }
    return 'Team ' + slot;
  }
  function teamNameForKey(key, slot) {
    if (key && key === S.myTeamKey) return 'You';
    var t = (S.teams || []).filter(function (x) { return x.team_key === key; })[0];
    return t && t.name ? t.name : teamName(slot);
  }
  // One toast at a time: fast drafting must never stack notices over the board.
  var lastToast = null;
  function toast(msg, opts) { if (lastToast) lastToast.dismiss(); lastToast = U.toast(msg, Object.assign({ timeout: 2200 }, opts || {})); }
  function researchId(p) { return p.sleeperId || p.id; }

  /* ------------------------------------------------------------ state */
  function save() {
    S.state.updatedAt = Date.now();
    try { localStorage.setItem(L.storageKey(S.state.leagueKey), L.serializeState(S.state)); } catch (e) { /* private mode: in-memory only */ }
  }
  function load(leagueKey, defaults) {
    var raw = null;
    try { raw = localStorage.getItem(L.storageKey(leagueKey)); } catch (e) {}
    S.state = L.deserializeState(raw, leagueKey, defaults);
    if (S.players.length) migrateIds();
  }
  // Manual board follows the league profile (12 teams, 9 starters…) unless the
  // user edited settings in the League dialog. Older saved boards (10-team
  // G/F/UTIL) migrate here, keeping picks and draft slot.
  function applyProfile() {
    if (S.state.settingsSource === 'user' || (S.connected && S.leagueKey)) return;
    var prev = S.state.settings;
    var next = S.profile ? L.settingsFromProfile(S.profile, prev) : L.normalizeSettings({ mySlot: prev && prev.mySlot });
    if (JSON.stringify(next) !== JSON.stringify(prev)) { S.state.settings = next; save(); }
  }
  function leagueName() {
    if (S.connected && S.leagueKey && S.league && S.league.name) return S.league.name;
    return (S.profile && S.profile.name) || 'League 242808';
  }

  function recompute() {
    var y = S.connected && S.leagueKey ? S.state.yahoo : null;
    S.merged = L.mergePicks(y, S.state.manual, { settings: S.state.settings, myTeamKey: S.myTeamKey, overrides: S.state.overrides, playersById: S.byId, byYahooPid: S.byYahooPid, alias: S.alias });
    if (S.merged.confirmedManual.length) {
      var gone = {}; S.merged.confirmedManual.forEach(function (id) { gone[id] = 1; });
      S.state.manual = S.state.manual.filter(function (m) { return !gone[String(m.playerId)]; });
      save();
    }
    // Live: if Yahoo didn't give a draft position, learn my slot from my first pick.
    if (y && S.myTeamKey) {
      var first = S.merged.picks.filter(function (p) { return p.source === 'yahoo' && p.mine; })[0];
      if (first && first.slot !== S.state.settings.mySlot) { S.state.settings.mySlot = first.slot; save(); }
    }
  }

  function takenMap() {
    var m = {};
    S.merged.picks.forEach(function (p) { if (p.playerId) m[p.playerId] = p; });
    return m;
  }
  function currentPick() { return S.merged.picks.length + 1; }
  function myRoster() {
    return S.merged.picks.filter(function (p) { return p.mine; }).map(function (p) {
      return (p.playerId && S.byId[p.playerId]) || { id: 'y:' + (p.player_key || p.pick), name: p.name, elig: [], hsValue: 0, unmatched: true };
    });
  }
  function available() {
    var t = takenMap();
    return S.players.filter(function (p) { return !t[p.id]; });
  }
  function liveYahoo() { return S.connected && S.leagueKey && !S.auction; }
  function pendingCount() { return S.merged.picks.filter(function (p) { return p.source === 'manual'; }).length; }
  /* Who's on the clock. Live Yahoo leagues use Yahoo's own pick order (team_key
     per pick: keepers and traded picks come out right); manual mode, or a
     Yahoo league that hasn't published an order, assumes a snake. */
  function clockInfo() {
    var st = S.state.settings;
    var yc = liveYahoo() ? L.yahooClock(S.state.yahoo, S.myTeamKey, pendingCount()) : null;
    if (yc) {
      // Yahoo's own pick list is the truth for the draft length (14 vs 16 rounds).
      return { cur: yc.cur, total: yc.total > 0 ? yc.total : L.totalPicks(st), done: yc.done, round: yc.round || (yc.done ? L.draftRounds(st) : L.roundOf(yc.cur, st.teams)),
        slot: null, teamKey: yc.teamKey, onMe: yc.onMe, myNext: yc.myNext, myAfter: yc.myAfter,
        myNextRound: yc.myNextRound || (yc.myNext ? L.roundOf(yc.myNext, st.teams) : null),
        awayN: yc.awayN, gapNow: yc.gapNow, gapNext: yc.gapNext, fromYahoo: true };
    }
    var cur = currentPick(), total = L.totalPicks(st);
    var done = cur > total;
    var slot = done ? null : L.slotForPick(cur, st.teams);
    var mine = L.nextPickFor(st.mySlot, cur, st);
    var after = mine ? L.nextPickFor(st.mySlot, mine + 1, st) : null;
    return { cur: cur, total: total, done: done, round: done ? L.draftRounds(st) : L.roundOf(cur, st.teams), slot: slot, teamKey: null, onMe: slot === st.mySlot, myNext: mine, myAfter: after,
      myNextRound: mine ? L.roundOf(mine, st.teams) : null,
      awayN: mine ? mine - cur : null, gapNow: after ? after - cur - 1 : 0, gapNext: mine && after ? after - mine - 1 : 0, fromYahoo: false };
  }
  function clockTeamName(ci) { return ci.teamKey ? teamNameForKey(ci.teamKey, null) : teamName(ci.slot); }

  /* --------------------------------------------------------- actions */
  function draftPlayer(id, mine) {
    var p = S.byId[id]; if (!p) return;
    if (takenMap()[id]) { toast(p.name + ' is already drafted'); return; }
    var ci = clockInfo();
    if (ci.done) { toast('Draft is complete'); return; }
    if (mine == null) mine = ci.onMe;
    S.state.manual.push({ playerId: id, mine: !!mine, at: Date.now() });
    save(); recompute(); render();
    var live = liveYahoo();
    toast((mine ? 'You took ' : clockTeamName(ci) + ' took ') + p.name + (live ? ' · waiting for Yahoo' : ''),
      { tone: mine ? 'good' : undefined, action: { label: 'Undo', onClick: function () { if (S.state.manual.length && String(S.state.manual[S.state.manual.length - 1].playerId) === String(id)) undo(); } } });
  }
  function undo() {
    if (!S.state.manual.length) return;
    var m = S.state.manual.pop();
    save(); recompute(); render();
    var p = S.byId[m.playerId];
    toast('Undid ' + (p ? p.name : 'last pick'));
  }
  function removeManual(id) {
    S.state.manual = S.state.manual.filter(function (m) { return String(m.playerId) !== String(id); });
    save(); recompute(); render();
  }
  function toggleMine(id) {
    S.state.manual.forEach(function (m) { if (String(m.playerId) === String(id)) m.mine = !m.mine; });
    save(); recompute(); render();
  }
  function startMatch(playerKey, name) {
    S.matching = { key: playerKey, name: name };
    if (U.sheet.isOpen()) U.sheet.close(true);
    var bar = $('nd-matchbar');
    bar.innerHTML = '<span>Tap the board player who is <b>' + esc(name) + '</b> (Yahoo pick).</span><button type="button" class="nu-btn nu-btn--sm" id="nd-match-cancel">Cancel</button>';
    bar.hidden = false;
    $('nd-match-cancel').onclick = endMatch;
    S.showTaken = false; $('nd-search').value = L.normName(name).split(' ').slice(-1)[0] || ''; S.q = $('nd-search').value;
    render();
    $('nd-search').focus();
  }
  function endMatch() { S.matching = null; $('nd-matchbar').hidden = true; S.q = ''; $('nd-search').value = ''; render(); }
  function completeMatch(id) {
    var m = S.matching; if (!m) return;
    S.state.overrides[m.key] = id;
    save(); endMatch(); recompute(); render();
    toast('Matched ' + m.name + ' → ' + S.byId[id].name);
  }

  /* ------------------------------------------------------------ render */
  // One shared snapshot per render so every panel agrees and the expensive
  // calls (clock, roster assignment, recommendation) run once.
  var V = null;
  function snapshot() {
    var st = S.state.settings, ci = clockInfo(), roster = myRoster(), matched = roster.filter(function (p) { return !p.unmatched; });
    var a = L.assignSlots(matched, st), avail = available();
    var openN = 0; Object.keys(a.open).forEach(function (t) { openN += a.open[t]; });
    V = { st: st, ci: ci, roster: roster, matched: matched, a: a, avail: avail, openN: openN, taken: takenMap() };
  }
  function render() {
    snapshot();
    renderHead(); renderFirstRun(); renderClock(); renderPulse(); renderReco(); renderWarns(); renderFilters(); renderBoard();
    renderRoster(); renderPicks(); renderReview(); renderSync(); renderMinibar();
    if (S.view === 'cheat') renderCheat();
    if (S.sheetId) renderSheet();
  }

  function renderHead() {
    var st = V.st, secs = timerSeconds();
    $('nd-eyebrow').textContent = leagueName() + ' · Yahoo High Score';
    var mode = liveYahoo() ? '' : S.connected && S.leagueKey && S.auction ? '' : 'Manual · ';
    $('nd-sub').innerHTML = '<span class="nd-status__lg">' + esc(leagueName()) + ' · </span>' + esc(mode) + '<b>Slot ' + esc(st.mySlot) + '</b> of ' + esc(st.teams) + ' · ' + esc(L.draftRounds(st)) + ' rounds' + (secs ? ' · ' + esc(secs) + 's picks' : '') +
      '<span class="nd-status__more"> · ' + esc(L.starterCount(st)) + ' starters + ' + esc(st.bench) + ' BN' + (st.il ? ' + ' + esc(st.il) + ' IL' : '') + '</span>';
  }

  // Top-40 supply per slot + "run" detection from the last round of picks.
  function renderPulse() {
    var st = V.st, recent = [];
    S.merged.picks.slice(-st.teams).forEach(function (p) { if (p.playerId && S.byId[p.playerId]) recent.push(S.byId[p.playerId]); });
    S.pulse = S.players.length ? L.slotPulse(V.avail, recent, S.players, st, 40) : [];
    // Picks other teams make before I choose again (on the clock: until my following pick).
    var ci = V.ci, k = ci.onMe ? ci.gapNow : ci.myNext ? ci.awayN : st.teams - 1;
    S.warns = L.balanceWarnings(V.matched, st, { available: V.avail, players: S.players, picksUntilNext: k });
  }

  function renderClock() {
    var ci = V.ci, st = V.st;
    $('nd-round').textContent = ci.round;
    $('nd-pick').textContent = ci.done ? ci.total : ci.cur;
    $('nd-of').textContent = '/' + ci.total;
    $('nd-clock').classList.toggle('mine', !!ci.onMe && !ci.done && !S.auction);
    document.body.classList.toggle('nd-on-clock', !!ci.onMe && !ci.done && !S.auction);
    var who = $('nd-otc-who'), sub = $('nd-otc-sub');
    if (S.auction) { who.textContent = 'Auction draft · manual tracking'; sub.textContent = 'Mark players as they’re won; ★ the ones you win'; }
    else if (ci.done) { who.textContent = 'Draft complete'; sub.textContent = 'Your roster is set — see My team'; }
    else if (ci.onMe) { who.textContent = "You're on the clock"; sub.textContent = !ci.myAfter ? 'Last pick of your draft' : ci.gapNow ? 'Then ' + ci.gapNow + ' picks until #' + ci.myAfter : 'Back-to-back: you also pick #' + ci.myAfter; }
    else {
      who.textContent = clockTeamName(ci) + ' on the clock';
      sub.textContent = ci.myNext ? 'You pick in ' + ci.awayN + ' · #' + ci.myNext + (ci.myAfter ? ', then #' + ci.myAfter : '') : 'Your picks are done';
    }
    renderTimer(ci);
    var undoBtn = $('nd-undo');
    undoBtn.disabled = !S.state.manual.length;
    var last = S.state.manual[S.state.manual.length - 1];
    undoBtn.setAttribute('aria-label', last && S.byId[last.playerId] ? 'Undo pick: ' + S.byId[last.playerId].name : 'Undo last pick');
    undoBtn.title = last && S.byId[last.playerId] ? 'Undo ' + S.byId[last.playerId].name : 'Undo last pick';
    $('nd-ticker').innerHTML = timelineHtml(ci, st);
  }
  // Compact upcoming-picks timeline: one dot per pick from now through my
  // following pick (max ~26), round turns marked, my picks as labelled pills.
  function timelineHtml(ci, st) {
    if (ci.done || S.auction) return '';
    var items = [];
    if (ci.fromYahoo) {
      L.openSlots(S.state.yahoo).slice(pendingCount(), pendingCount() + 26).forEach(function (o) {
        var t = (S.teams || []).filter(function (x) { return x.team_key === o.team_key; })[0];
        items.push({ pick: o.pick, me: !!(o.team_key && o.team_key === S.myTeamKey), round: o.round || L.roundOf(o.pick, st.teams), who: t ? t.name : '' });
      });
    } else {
      for (var p = ci.cur; p <= Math.min(ci.total, ci.cur + 25); p++) {
        var s = L.slotForPick(p, st.teams);
        items.push({ pick: p, me: s === st.mySlot, round: L.roundOf(p, st.teams), who: teamName(s) });
      }
    }
    var stop = ci.myAfter || ci.myNext;
    var out = [], mineSeen = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (i && it.round !== items[i - 1].round) out.push('<span class="nd-tl__turn">R' + it.round + '</span>');
      if (it.me) { mineSeen++; out.push('<span class="nd-tl__me' + (i === 0 ? ' is-now' : '') + '">' + (i === 0 ? 'You' : '#' + it.pick) + '</span>'); }
      else out.push('<span class="nd-tl__dot' + (i === 0 ? ' is-now' : '') + '" title="#' + it.pick + ' ' + esc(it.who) + '"></span>');
      if (stop && it.pick >= stop && mineSeen >= 2) break;
      if (!stop && i >= 11) break;
    }
    return '<span class="nd-tl">' + out.join('') + '</span>';
  }

  var recoCache = [];
  function renderReco() {
    var el = $('nd-reco'), ci = V.ci, st = V.st;
    if (!S.players.length || ci.done || !ci.myNext) { el.hidden = true; recoCache = []; return; }
    var k = ci.onMe ? ci.gapNow : ci.gapNext;
    var list = L.bestAvailable(V.avail, V.matched, st, { picksUntilNext: k, nextPick: ci.myAfter, limit: 3 });
    recoCache = list;
    if (!list.length || S.view !== 'board') { el.hidden = true; return; }
    var top = list[0], p = top.player;
    var label = ci.onMe ? 'Your pick now' : 'Best for your pick #' + ci.myNext;
    var tag = top.slot === 'BENCH' ? 'Bench' : top.ownSlot ? 'Starts ' + slotLabel(top.ownSlot) : (top.upgrade ? 'Upgrade ' : 'Fills ') + slotLabel(top.slot);
    var nums = '<span class="nd-reco__num"><b class="nu-num">' + n1(p.hsValue) + '</b><small>value</small></span>' +
      '<span class="nd-reco__num nd-reco__num--2"><b class="nu-num">' + n0(p.ceiling) + '</b><small>ceil</small></span>' +
      (vorpTxt(p) ? '<span class="nd-reco__num nd-reco__num--2"><b class="nu-num">' + esc(vorpTxt(p)) + '</b><small>vorp</small></span>' : '');
    el.classList.toggle('is-live', !!ci.onMe);
    el.innerHTML =
      '<div class="nd-reco__top"><span class="nu-eyebrow">' + esc(label) + '</span><span class="nd-fill" data-fam="' + fam(top.slot) + '">' + esc(tag) + '</span></div>' +
      '<div class="nd-reco__main">' +
        '<button type="button" class="nd-reco__who" data-act="sheet" data-id="' + esc(p.id) + '" aria-label="Details for ' + esc(p.name) + '">' +
          avatar(p, 'lg', { teamBadge: true, injuryDot: true, eager: true }) +
          '<span class="nd-reco__text"><span class="nd-reco__name">' + esc(p.name) + '</span><span class="nd-meta">' + posPills(p) + '<span class="nd-tm">' + esc(p.team || 'FA') + '</span>' + gamesChip(p) + injBadge(p) + '</span></span>' +
        '</button>' +
        '<div class="nd-reco__nums">' + nums + '</div>' +
        (ci.onMe && !S.auction ? '<button type="button" class="nu-btn nu-btn--primary nd-reco__go" data-act="mine" data-id="' + esc(p.id) + '">Draft ' + esc(shortName(p.name)) + '</button>' : '') +
      '</div>' +
      '<p class="nd-reco-why">' + esc(top.reason) + '</p>' +
      (list.length > 1 ? '<div class="nd-reco__alts"><span class="nu-label">Also</span>' + list.slice(1).map(function (r) {
        return '<button type="button" class="nd-alt" data-act="sheet" data-id="' + esc(r.player.id) + '" title="' + esc(r.reason) + '">' + avatar(r.player, 'xs') + '<span class="nd-alt__n">' + esc(r.player.name) + '</span><span class="nd-alt__v nu-num">' + (r.slot === 'BENCH' ? 'BN' : esc(slotLabel(r.ownSlot || r.slot))) + ' ' + n1(r.player.hsValue) + '</span></button>';
      }).join('') + '</div>' : '');
    el.hidden = false;
  }

  // ONE "positions running low" strip instead of a stack of warning cards.
  // Each chip filters the board to that slot.
  function renderWarns() {
    var el = $('nd-warns'), chips = [], seen = {}, warns = S.warns || [];
    if (S.view !== 'board') { el.innerHTML = ''; return; }
    var head = warns.filter(function (w) { return w.level === 'danger' && /open starter slots/.test(w.text); })[0];
    warns.forEach(function (w) {
      var m = /^(\w+) is drying up: (\d+) starter-grade/.exec(w.text), c = /no (\w+) yet|Needs a \w+ (\w+)/.exec(w.text);
      if (m) { seen[m[1]] = 1; chips.push({ slot: m[1], level: w.level, label: m[1] + ' · ' + m[2] + ' left', title: w.text }); }
      else if (c) { var s = c[1] || c[2]; seen[s] = 1; chips.push({ slot: s, level: w.level, label: (c[1] ? 'No ' + s + ' yet' : 'Need ' + s), title: w.text }); }
      else if (w !== head && w.level !== 'info') chips.push({ slot: null, level: w.level, label: w.text, title: w.text });
    });
    chips = chips.filter(function (c) { return c.level !== 'info'; });
    S.pulse.forEach(function (x) {
      if (x.run && !seen[x.slot]) chips.push({ slot: x.slot, level: 'warn', label: slotLabel(x.slot) + ' run ▲', title: slotLabel(x.slot) + ' run: ' + x.recent + ' of the last ' + V.st.teams + ' picks · ' + x.left + ' left in the top 40' });
    });
    if (!chips.length && !head) { el.innerHTML = ''; return; }
    var lvl = head || chips.some(function (c) { return c.level === 'danger'; }) ? 'danger' : chips.some(function (c) { return c.level === 'warn'; }) ? 'warn' : 'info';
    el.innerHTML = '<div class="nd-low__in" data-level="' + lvl + '"><span class="nd-low__lbl">' + (head ? esc(head.text) : 'Running low') + '</span>' +
      chips.map(function (c) {
        return c.slot ? '<button type="button" class="nd-low__chip" data-level="' + c.level + '" data-act="pos" data-pos="' + esc(c.slot) + '" title="' + esc(c.title) + '" aria-label="' + esc(c.title) + '. Show ' + esc(slotLabel(c.slot)) + ' players">' + esc(c.label) + '</button>'
          : '<span class="nd-low__chip" data-level="' + c.level + '" title="' + esc(c.title) + '">' + esc(c.label) + '</span>';
      }).join('') + '</div>';
  }

  // Market (Yahoo-first consensus) rank + reach/value delta; empty cell when absent.
  function mktCell(p) {
    if (p.marketRank == null) return '<span class="nd-mkt nu-muted">—</span>';
    var lab = p.label === 'value' || p.label === 'reach' ? p.label : '';
    var d = typeof p.adpDelta === 'number' ? Math.abs(p.adpDelta) : null;
    var tip = 'Market #' + p.marketRank + (lab ? ' · ' + lab + (d != null ? ' by ' + d : '') : '') + (p.contested ? ' · sources disagree' : '');
    return '<span class="nd-mkt' + (p.marketConfidence != null && p.marketConfidence < 0.4 ? ' low' : '') + '" title="' + esc(tip) + '">' + esc(p.marketRank) +
      (lab ? '<i class="' + lab + (p.strong ? ' strong' : '') + '">' + (lab === 'value' ? '▲' : '▼') + (d != null ? d : '') + '</i>' : '') + '</span>';
  }

  /* Keyed rows: static HTML once per player, state patched per render. */
  var rowCache = {}, tierCache = {}, emptyEl = null;
  function buildRow(p) {
    var el = document.createElement('div');
    el.className = 'nd-row';
    el.setAttribute('role', 'listitem');
    el.setAttribute('data-act', 'sheet');
    el.setAttribute('data-id', p.id);
    el.innerHTML =
      '<span class="nd-c-rk"><b>' + esc(p.rank) + '</b>' + (p.yahooPreRank != null ? '<small title="Yahoo pre-season rank">Y' + esc(p.yahooPreRank) + '</small>' : '') + '</span>' +
      '<button type="button" class="nd-row-main nd-c-pl" data-act="sheet" data-id="' + esc(p.id) + '" aria-label="' + esc(p.name + ', ' + (p.team || '') + ', value ' + n1(p.hsValue) + (p.injury ? ', ' + p.injury : '')) + '">' +
        avatar(p, 'md', { teamBadge: true }) +
        '<span class="nd-who"><span class="nd-name">' + esc(p.name) + '</span>' +
        '<span class="nd-meta">' + posPills(p) + '<span class="nd-tm">' + esc(p.team || 'FA') + '</span>' + gamesChip(p) + injBadge(p) +
          (p.noLogData ? '<span class="nd-flag" title="No game-log data: value estimated from Yahoo projection">EST</span>' : '') +
          '<span class="nd-takenby"></span></span></span>' +
      '</button>' +
      '<span class="nd-c-tier">' + U.tierBadge(p.tier) + '</span>' +
      '<span class="nd-c-val"><b>' + n1(p.hsValue) + '</b><small>ceil ' + n0(p.ceiling) + '</small></span>' +
      '<span class="nd-c-cf">' + n0(p.ceiling) + '<i> / </i>' + n0(p.floor) + '</span>' +
      '<span class="nd-c-vorp">' + esc(vorpTxt(p) || '—') + '</span>' +
      '<span class="nd-c-mkt">' + mktCell(p) + '</span>' +
      '<span class="nd-c-act"><button type="button" class="nd-draft" data-act="draft" data-id="' + esc(p.id) + '">Draft</button></span>';
    el._btn = el.lastChild.firstChild;
    el._by = el.querySelector('.nd-takenby');
    el._legacy = L.isLegacy(S.state.settings);
    return el;
  }
  function rowFor(p) {
    var el = rowCache[p.id];
    if (!el || el._legacy !== L.isLegacy(S.state.settings)) { el = rowCache[p.id] = buildRow(p); }
    return el;
  }
  function patchRow(el, p, t, ctx) {
    var sig = (t ? t.source + '|' + t.mine + '|' + t.pick + '|' + (t.team_key || '') + '|' + t.slot : '-') + '|' + ctx.onMe + '|' + (p.id === ctx.recoId) + '|' + (S.matching ? S.matching.name : '') + '|' + ctx.clockName;
    if (el._sig === sig) return;
    el._sig = sig;
    el.className = 'nd-row' + (t ? ' taken' : '') + (p.id === ctx.recoId ? ' reco' : '') + (ctx.onMe ? ' nd-on-me' : '') + (S.matching ? ' nd-matching' : '') + (t && t.mine ? ' mine' : '');
    var b = el._btn;
    var act = S.matching ? 'match' : t ? (t.source === 'manual' ? 'remove' : 'noop') : 'draft';
    b.setAttribute('data-act', act);
    b.textContent = S.matching ? 'Match' : t ? (t.source === 'manual' ? 'Undo' : 'Taken') : ctx.onMe ? 'Take' : 'Draft';
    b.setAttribute('aria-label', S.matching ? 'Match ' + S.matching.name + ' to ' + p.name
      : t ? (t.source === 'manual' ? 'Remove pick of ' + p.name : p.name + ' drafted by ' + teamNameForKey(t.team_key, t.slot))
      : ctx.onMe ? 'Draft ' + p.name + ' to your team' : 'Mark ' + p.name + ' drafted by ' + ctx.clockName);
    b.disabled = !!(t && t.source !== 'manual' && !S.matching);
    el._by.textContent = t ? (t.mine ? 'You' : teamNameForKey(t.team_key, t.slot)) + ' #' + t.pick : '';
  }
  var SORTS = {
    value: function (a, b) { return (b.hsValue || 0) - (a.hsValue || 0) || a.rank - b.rank; },
    ceiling: function (a, b) { return (b.ceiling || 0) - (a.ceiling || 0) || a.rank - b.rank; },
    vorp: function (a, b) { return (typeof b.vorp === 'number' ? b.vorp : -1e9) - (typeof a.vorp === 'number' ? a.vorp : -1e9) || a.rank - b.rank; },
    market: function (a, b) { return (a.marketRank == null ? 1e9 : a.marketRank) - (b.marketRank == null ? 1e9 : b.marketRank) || a.rank - b.rank; },
    yahoo: function (a, b) { return (a.yahooPreRank == null ? 1e9 : a.yahooPreRank) - (b.yahooPreRank == null ? 1e9 : b.yahooPreRank) || a.rank - b.rank; }
  };
  var sortedCache = { key: null, list: null };
  function sortedPlayers() {
    if (!SORTS[S.sort]) return S.players;
    if (sortedCache.key !== S.sort || sortedCache.src !== S.players) sortedCache = { key: S.sort, src: S.players, list: S.players.slice().sort(SORTS[S.sort]) };
    return sortedCache.list;
  }
  function renderBoard() {
    var list = $('nd-list');
    document.body.classList.toggle('nd-sorted', S.sort !== 'rank');
    if (!S.players.length) {
      if (!list.firstChild) list.innerHTML = U.skeleton(10);
      return;
    }
    var taken = V.taken, ci = V.ci;
    var ctx = { onMe: !!ci.onMe && !ci.done, recoId: recoCache[0] && recoCache[0].player.id, clockName: ci.done ? '' : clockTeamName(ci) };
    var nodes = [], lastTier = null, shown = 0, availN = 0, tiers = S.sort === 'rank' && !S.q;
    sortedPlayers().forEach(function (p) {
      var t = taken[p.id];
      if (!t) availN++;
      if (t && !S.showTaken) return;
      if (!L.matchesPos(p, S.pos, V.st) || !L.matchesQuery(p, S.q)) return;
      if (S.tierMax && !(p.tier <= S.tierMax)) return;
      if (S.hideOut && !t && isOut(p)) return;
      shown++;
      if (shown > 400) return;
      if (tiers && p.tier !== lastTier) {
        var d = tierCache[p.tier];
        if (!d) { d = tierCache[p.tier] = document.createElement('div'); d.className = 'nu-tier-rule nd-tier-rule'; d.setAttribute('role', 'presentation'); d.innerHTML = '<b>Tier ' + esc(p.tier) + '</b>'; }
        nodes.push(d); lastTier = p.tier;
      }
      var el = rowFor(p);
      patchRow(el, p, t, ctx);
      nodes.push(el);
    });
    if (!shown) {
      if (!emptyEl) { emptyEl = document.createElement('div'); emptyEl.innerHTML = U.emptyState({ title: 'No players match', body: 'Try another name, or clear the position / tier filters.' }); }
      nodes.push(emptyEl);
    }
    // Only touch the DOM order when it actually changed.
    var cur = list.children, same = cur.length === nodes.length;
    for (var i = 0; same && i < nodes.length; i++) if (cur[i] !== nodes[i]) same = false;
    if (!same) {
      if (list.replaceChildren) list.replaceChildren.apply(list, nodes);
      else { list.innerHTML = ''; var f = document.createDocumentFragment(); nodes.forEach(function (n) { f.appendChild(n); }); list.appendChild(f); }
    }
    $('nd-count').textContent = availN + ' available · ' + (S.players.length - availN) + ' drafted' + (shown > 400 ? ' · showing the top 400 of ' + shown : '');
  }

  function renderFilters() {
    var st = V.st, types = L.slotTypes(st);
    if (S.pos !== 'ALL' && types.indexOf(S.pos) < 0) S.pos = 'ALL';
    var pulse = {}; S.pulse.forEach(function (x) { pulse[x.slot] = x; });
    var seg = $('nd-seg');
    var html = ['ALL'].concat(types).map(function (t) {
      var x = pulse[t], cls = x ? (x.run ? ' run' : x.scarce ? ' scarce' : '') : '';
      var title = t === 'ALL' ? 'All players' : x ? slotLabel(t) + '-eligible: ' + x.left + ' left in the top 40' + (x.recent ? ', ' + x.recent + ' taken in the last ' + st.teams + ' picks' : '') + (x.run ? ' — position run' : x.scarce ? ' — thin' : '') : (t === 'UTIL' ? 'Everyone (UTIL)' : slotLabel(t));
      return '<button type="button" class="nu-chip nd-slotchip' + cls + '" data-fam="' + fam(t === 'ALL' ? 'UTIL' : t) + '" data-act="pos" data-pos="' + t + '" aria-pressed="' + (S.pos === t) + '" title="' + esc(title) + '" aria-label="' + esc(title) + '">' +
        '<span>' + (t === 'ALL' ? 'All' : t === 'UTIL' ? 'UTIL' : slotLabel(t)) + '</span>' + (x ? '<span class="nu-chip__n">' + x.left + '</span>' : '') + '</button>';
    }).join('');
    if (seg._html !== html) { seg.innerHTML = html; seg._html = html; }
    var tiers = {}; S.players.forEach(function (p) { if (p.tier != null) tiers[p.tier] = 1; });
    var tsel = $('nd-tier'), keys = Object.keys(tiers).map(Number).filter(isFinite).sort(function (x, y) { return x - y; });
    var want = '<option value="0">All tiers</option>' + keys.map(function (k) { return '<option value="' + k + '">Tier ≤ ' + k + '</option>'; }).join('');
    if (tsel.getAttribute('data-sig') !== String(keys.length)) { tsel.innerHTML = want; tsel.setAttribute('data-sig', String(keys.length)); }
    tsel.value = String(S.tierMax || 0);
    $('nd-sort').value = SORTS[S.sort] ? S.sort : 'rank';
    var derived = S.players.length && S.players.filter(function (p) { return L.slotElig(p).source !== 'yahoo'; }).length > S.players.length / 2;
    $('nd-elig-note').hidden = !(derived && !L.isLegacy(st));
  }

  // Roster markup (desktop sticky column + the phone "My team" sheet).
  function rosterHtml() {
    var st = V.st, a = V.a, roster = V.roster;
    var need = {}; (S.warns || []).forEach(function (w) { var m = /no (\w+) yet|Needs a \w+ (\w+)/.exec(w.text); if (m) need[m[1] || m[2]] = 1; });
    var html = '<div class="nd-slots">';
    a.starters.forEach(function (s) {
      html += '<div class="nd-slot' + (s.player ? ' is-filled' : ' is-open') + (!s.player && need[s.slot] ? ' need' : '') + '">' +
        '<span class="nd-slot__pos" data-fam="' + fam(s.slot) + '">' + esc(s.slot === 'UTIL' ? 'UTIL' : slotLabel(s.slot)) + '</span>' +
        (s.player
          ? '<button type="button" class="nd-slot__who" data-act="sheet" data-id="' + esc(s.player.id) + '">' + avatar(s.player, 'sm', { injuryDot: true }) + '<span class="nd-slot__nm">' + esc(s.player.name) + '</span></button><span class="nd-slot__v nu-num">' + n1(s.player.hsValue) + '</span>'
          : '<span class="nd-slot__open">' + (need[s.slot] ? 'Open · catch up' : 'Open') + '</span>') +
        '</div>';
    });
    html += '</div>';
    var bench = a.bench.concat(roster.filter(function (p) { return p.unmatched; }));
    if (st.bench || bench.length) {
      html += '<div class="nd-sub-h"><span class="nu-label">Bench</span><span class="nu-hint">' + Math.min(bench.length, st.bench) + '/' + st.bench + '</span></div><div class="nd-bench">';
      bench.forEach(function (p) {
        html += '<div class="nd-slot nd-slot--bn is-filled"><span class="nd-slot__pos" data-fam="UTIL">BN</span>' +
          (p.unmatched ? '<span class="nd-slot__nm">' + esc(p.name) + '</span><span class="nd-flag um">REVIEW</span>'
            : '<button type="button" class="nd-slot__who" data-act="sheet" data-id="' + esc(p.id) + '">' + avatar(p, 'xs') + '<span class="nd-slot__nm">' + esc(p.name) + '</span></button>' + posPills(p) + '<span class="nd-slot__v nu-num">' + n1(p.hsValue) + '</span>') + '</div>';
      });
      for (var i = bench.length; i < st.bench; i++) html += '<div class="nd-slot nd-slot--bn is-open"><span class="nd-slot__pos" data-fam="UTIL">BN</span><span class="nd-slot__open">Open</span></div>';
      html += '</div>';
    }
    if (st.il) {
      html += '<div class="nd-sub-h"><span class="nu-label">IL</span><span class="nu-hint">injured players only</span></div><div class="nd-bench">';
      a.il.forEach(function (p) {
        html += '<div class="nd-slot nd-slot--bn is-filled"><span class="nd-slot__pos" data-fam="UTIL">IL</span><button type="button" class="nd-slot__who" data-act="sheet" data-id="' + esc(p.id) + '">' + avatar(p, 'xs') + '<span class="nd-slot__nm">' + esc(p.name) + '</span></button>' +
          (isOut(p) ? injBadge(p) : '<span class="nd-flag" title="Healthy players can’t sit on IL in Yahoo">NOT IL</span>') + '<span class="nd-slot__v nu-num">' + n1(p.hsValue) + '</span></div>';
      });
      for (var j = a.il.length; j < st.il; j++) html += '<div class="nd-slot nd-slot--bn is-open"><span class="nd-slot__pos" data-fam="UTIL">IL</span><span class="nd-slot__open">Open</span></div>';
      html += '</div>';
    }
    return html;
  }
  function rosterTotal() {
    return V.roster.length + '/' + L.draftRounds(V.st) + ' drafted · ' + (V.openN ? V.openN + ' starter slot' + (V.openN > 1 ? 's' : '') + ' open' : 'starters ' + n1(V.a.total));
  }
  function renderRoster() {
    var html = rosterHtml();
    $('nd-roster').innerHTML = html;
    $('nd-roster-total').textContent = rosterTotal();
    if (teamSheetOpen) { $('nd-ts-body').innerHTML = html + '<div class="nd-sub-h nd-sub-h--picks"><span class="nu-label">Recent picks</span></div>' + picksHtml(8); $('nd-ts-total').textContent = rosterTotal(); }
  }

  function picksHtml(n) {
    var picks = S.merged.picks.slice().reverse().slice(0, n);
    if (!picks.length) return '<div class="nu-hint nd-picks-empty">No picks yet. Tap Draft on the board as players go.</div>';
    return picks.map(function (p) {
      var pl = p.playerId && S.byId[p.playerId];
      var flag = p.source === 'manual' && !p.confirmed && liveYahoo() ? '<span class="nd-flag" title="Marked here; Yahoo has not confirmed it yet">PENDING</span>'
        : !p.playerId ? '<span class="nd-flag um">REVIEW</span>' : '';
      var ctl = p.source === 'manual'
        ? '<button type="button" class="nd-mini-btn" data-act="mine-toggle" data-id="' + esc(p.playerId) + '" aria-pressed="' + p.mine + '" aria-label="' + (p.mine ? 'Mark ' + esc(p.name) + ' as another team\'s pick' : 'Mark ' + esc(p.name) + ' as my pick') + '">★</button>' +
          '<button type="button" class="nd-mini-btn" data-act="remove" data-id="' + esc(p.playerId) + '" aria-label="Remove pick ' + esc(p.name) + '">✕</button>'
        : '';
      return '<div class="nd-pick' + (p.mine ? ' mine' : '') + '" data-pick="' + p.pick + '"><span class="n nu-num">' + p.round + '.' + String(((p.pick - 1) % S.state.settings.teams) + 1).padStart(2, '0') + '</span>' +
        (pl ? avatar(pl, 'xs') : '') + '<span class="nm">' + esc(p.name) + '</span>' + flag + '<span class="tm">' + esc(p.mine ? 'You' : teamNameForKey(p.team_key, p.slot)) + '</span>' + ctl + '</div>';
    }).join('');
  }
  function renderPicks() {
    $('nd-picks-total').textContent = S.merged.picks.length ? S.merged.picks.length + ' made' : '';
    $('nd-picks').innerHTML = picksHtml(12);
  }

  function renderReview() {
    var um = S.merged.unmatched || [];
    var el = $('nd-review');
    if (!um.length) { el.hidden = true; return; }
    el.hidden = false;
    $('nd-review-sum').textContent = um.length + ' Yahoo pick' + (um.length > 1 ? 's' : '') + ' to review';
    $('nd-review-list').innerHTML = um.map(function (u) {
      return '<div class="nd-pick"><span class="n nu-num">' + (u.pick ? '#' + u.pick : '—') + '</span><span class="nm">' + esc(u.name) + '</span>' +
        '<button type="button" class="nu-btn nu-btn--sm nd-match-btn" data-act="start-match" data-key="' + esc(u.player_key) + '" data-name="' + esc(u.name) + '">Match</button></div>';
    }).join('');
  }

  function renderSync() {
    var pill = $('nd-sync'), banner = $('nd-banner');
    var set = function (state, html) { pill.setAttribute('data-state', state); pill.innerHTML = '<span class="nd-dot" aria-hidden="true"></span>' + html; pill.hidden = false; };
    if (S.connected && S.leagueKey && S.auction) {
      set('off', 'Auction · manual');
      banner.className = 'nd-banner';
      banner.innerHTML = U.callout('info', '<b>Auction drafts aren’t supported yet — manual mode.</b> “' + esc((S.league && S.league.name) || S.leagueKey) + '” is an auction league, so Yahoo picks aren’t synced here. Mark players as they’re won (★ for yours); rankings and roster fit still work.');
      banner.hidden = false;
      return;
    }
    if (!S.connected || !S.leagueKey) {
      if (S.yahooDown && !S.connected) set('error', 'Yahoo unavailable');
      else if (S.connected) set('off', 'Yahoo connected');
      else set('off', 'Manual board');
      if (S.sync !== 'degraded') banner.hidden = true;
      return;
    }
    var y = S.state.yahoo, ago = S.lastOk ? L.agoText(Date.now() - S.lastOk) : '';
    if (S.sync === 'degraded') {
      var wait = Math.max(0, Math.round((S.nextPollAt - Date.now()) / 1000));
      set('error', 'Yahoo sync paused');
      banner.className = 'nd-banner';
      banner.innerHTML = '<div class="nu-callout nu-callout--warn nd-degraded" role="alert">' + U.icon.alert + '<div><b>Can’t reach Yahoo' + (S.lastErr ? ' (' + esc(S.lastErr) + ')' : '') + '.</b> Keep tapping Draft as picks happen; they’re marked pending until Yahoo confirms. ' +
        (S.lastOk ? 'Last sync ' + esc(ago) + ' · ' : '') + 'retry in <span class="nu-num">' + wait + 's</span>.</div><button type="button" class="nu-btn nu-btn--sm" id="nd-retry">Retry now</button></div>';
      banner.hidden = false;
      $('nd-retry').onclick = function () { poll(true); };
    } else {
      banner.hidden = true;
      var status = y && y.status;
      var txt = S.sync === 'connecting' ? 'Connecting to Yahoo…'
        : status === 'postdraft' ? 'Yahoo draft complete'
        : status === 'predraft' ? 'Yahoo · waiting for draft'
        : 'Live from Yahoo';
      set(S.sync === 'connecting' ? 'syncing' : S.sync === 'live' ? 'connected' : 'off', esc(txt) + (S.lastOk && S.sync === 'live' ? ' <span class="nd-ago nu-num">· ' + esc(ago) + '</span>' : ''));
    }
  }

  function renderMinibar() {
    var st = V.st, ci = V.ci, a = V.a, reco = recoCache[0];
    var need = {}; (S.warns || []).forEach(function (w) { var m = /no (\w+) yet|Needs a \w+ (\w+)/.exec(w.text); if (m) need[m[1] || m[2]] = 1; });
    $('nd-mb-slots').innerHTML = a.starters.map(function (s) {
      return '<span class="nd-mb-slot' + (s.player ? ' on' : need[s.slot] ? ' need' : '') + '" data-fam="' + fam(s.slot) + '"></span>';
    }).join('');
    var head = S.auction ? 'Auction · manual' : ci.done ? 'Draft complete' : ci.onMe ? 'You’re on the clock' : ci.myNext ? 'You pick in ' + ci.awayN + ' · #' + ci.myNext : 'Your picks are done';
    var act = $('nd-mb-act');
    var w = (S.warns || []).filter(function (x) { return x.level !== 'info'; })[0];
    $('nd-mb-txt').innerHTML = '<b>' + esc(head) + '</b><span>' + (ci.onMe && !ci.done ? 'Tap to see your team' : w ? esc(w.text) : esc(V.roster.length + '/' + L.draftRounds(st) + ' · ' + (V.openN ? V.openN + ' open' : 'starters set'))) + '</span>';
    $('nd-mb-btn').setAttribute('aria-label', head + '. Open my team');
    if (ci.onMe && !ci.done && reco && !S.auction) {
      act.innerHTML = '<button type="button" class="nu-btn nu-btn--primary nd-mb-draft" data-act="mine" data-id="' + esc(reco.player.id) + '">Draft ' + esc(shortName(reco.player.name)) + '<small>' + esc(reco.slot === 'BENCH' ? 'bench' : slotLabel(reco.slot)) + '</small></button>';
      act.hidden = false;
    } else { act.hidden = true; act.innerHTML = ''; }
  }

  /* ------------------------------------------------------ cheat sheet */
  function myRemainingPicks(ci) {
    var st = S.state.settings;
    if (ci.fromYahoo) {
      return L.openSlots(S.state.yahoo).slice(pendingCount()).filter(function (o) { return o.team_key && o.team_key === S.myTeamKey; })
        .map(function (o) { return { pick: o.pick, round: o.round || L.roundOf(o.pick, st.teams) }; });
    }
    return ci.done ? [] : L.myPicksSnake(st, ci.cur);
  }
  function renderCheat() {
    var el = $('nd-cheat'), st = V.st, ci = V.ci;
    if (!S.players.length) { el.innerHTML = U.skeleton(6); return; }
    var made = S.merged.picks.filter(function (p) { return p.mine; }).map(function (p) { return { pick: p.pick, round: p.round, player: p.playerId ? S.byId[p.playerId] : null, name: p.name }; });
    var cs = L.cheatSheet({ available: V.avail, settings: st, cur: ci.cur, myPicks: myRemainingPicks(ci), made: made,
      roster: V.matched, perRound: 5, perSlot: 10 });
    var roundsLeft = cs.rounds.filter(function (r) { return !r.done; }).length;
    var html = '<div class="nd-cheat-head"><div><h2 class="nu-title">Cheat sheet</h2><p class="nu-hint">' + esc(leagueName()) + ' · slot ' + st.mySlot + ' of ' + st.teams + ' · ' + roundsLeft + ' pick' + (roundsLeft === 1 ? '' : 's') + ' left. Targets are the players the board expects near each of your picks; ★ = fills a starter slot you still need.</p></div>' +
      '<button type="button" class="nu-btn nu-btn--sm" data-act="print">Print</button></div>';
    html += '<div class="nd-cs-warns">' + (S.warns || []).filter(function (w) { return w.level !== 'info'; }).map(function (w) { return '<div class="nd-warn ' + w.level + '">' + esc(w.text) + '</div>'; }).join('') + '</div>';
    html += '<ol class="nd-cs-rounds">' + cs.rounds.map(function (r) {
      var head = '<span class="r">R' + r.round + '</span><span class="pk">#' + r.pick + '</span>';
      if (r.done) return '<li class="done">' + head + '<span class="got">' + (r.player ? avatar(r.player, 'xs') : '') + esc(r.player ? r.player.name : r.name || '—') + (r.player ? ' ' + posPills(r.player) : '') + '</span></li>';
      return '<li' + (r.pick === ci.cur && ci.onMe ? ' class="now"' : '') + '>' + head + '<span class="tg">' + r.targets.map(function (x) {
        return '<button type="button" class="nd-cs-p' + (x.need.length ? ' need' : '') + '" data-act="sheet" data-id="' + esc(x.player.id) + '" title="' + esc(x.need.length ? 'Fills open ' + x.need.map(slotLabel).join('/') : 'Depth') + '">' + avatar(x.player, 'xs') + (x.need.length ? '★ ' : '') + esc(x.player.name) + ' <i>' + esc(L.displayPositions(x.player).join('/') || 'U') + ' · T' + esc(x.player.tier) + '</i></button>';
      }).join('') + '</span></li>';
    }).join('') + '</ol>';
    html += '<h3 class="nu-section__title nd-cs-h3">By slot · best available, tiered</h3><div class="nd-cs-slots">' + cs.bySlot.map(function (b) {
      return '<section class="nd-cs-slot"><h4><span class="nu-pos" data-pos="' + esc(b.slot === 'FC' ? 'F' : b.slot) + '">' + esc(slotLabel(b.slot)) + '</span>' + (b.open ? '<span class="nd-flag">' + b.open + ' open</span>' : '<span class="nu-hint">set</span>') + '</h4>' +
        b.tiers.map(function (t) {
          return '<div class="nd-cs-tier"><span class="t">T' + esc(t.tier) + '</span><span class="ps">' + t.players.map(function (p) { return '<button type="button" data-act="sheet" data-id="' + esc(p.id) + '">' + esc(p.name) + (L.injuryShort(p.injury) ? ' <em>' + esc(L.injuryShort(p.injury)) + '</em>' : '') + '</button>'; }).join('') + '</span></div>';
        }).join('') + '</section>';
    }).join('') + '</div>';
    el.innerHTML = html;
  }
  function setView(v) {
    S.view = v === 'cheat' ? 'cheat' : 'board';
    $('nd-cheat').hidden = S.view !== 'cheat';
    $('nd-boardview').hidden = S.view === 'cheat';
    Array.prototype.forEach.call(document.querySelectorAll('#nd-views button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === S.view)); });
    render();
  }

  /* ------------------------------------------------------ pick timer */
  // Seconds per pick: the user's setting, else the Yahoo league's
  // draft_pick_time, else the league profile's draft.pickSeconds (90). 0 = off.
  function timerSeconds() {
    var v = null; try { v = localStorage.getItem(TIMER_PREF); } catch (e) {}
    if (v != null && v !== '') return L.normalizeTimerSeconds(v);
    if (S.league && S.league.draft_pick_time > 0) return L.normalizeTimerSeconds(S.league.draft_pick_time);
    return L.profilePickSeconds(S.profile);
  }
  function renderTimer(ci) {
    var el = $('nd-timer'), mb = $('nd-mb-timer'); if (!el) return;
    var yStatus = S.state.yahoo && S.state.yahoo.status;
    // Yahoo says predraft: quiet even with keepers on the board, unless the
    // user is already marking picks by hand.
    var off = S.auction || ci.done || !timerSeconds() ||
      (liveYahoo() && yStatus === 'predraft' && !S.merged.picks.some(function (p) { return p.source === 'manual'; }));
    if (off) { el.hidden = true; mb.hidden = true; document.title = baseTitle; return; }
    // Restart when the pick on the clock changes. Manual board, first pick:
    // idle until the user taps the timer (we can't know when the draft starts).
    // A reload keeps the running clock for the same league + pick.
    if (S.timer.pick !== ci.cur) {
      var first = S.timer.pick === null, now = Date.now(), saved = null;
      try { saved = JSON.parse(sessionStorage.getItem(TIMER_RUN) || 'null'); } catch (e) {}
      S.timer.pick = ci.cur; S.timer.beeped = false;
      S.timer.startedAt = L.restoreTimerStart(saved, S.leagueKey, ci.cur, now, timerSeconds()) ||
        (first && !S.merged.picks.length ? 0 : now);
      saveTimerRun();
    }
    var t = L.timerState(S.timer.startedAt, timerSeconds(), Date.now());
    el.hidden = false;
    el.className = 'nd-timer ' + t.level + (ci.onMe ? ' me' : '');
    el.querySelector('.t').textContent = t.level === 'idle' ? '▶ ' + t.text : t.text;
    el.setAttribute('aria-label', t.level === 'idle' ? 'Start the ' + timerSeconds() + ' second pick timer' : (ci.onMe ? 'Your pick: ' : clockTeamName(ci) + ': ') + t.left + ' seconds left. Tap to restart.');
    el.querySelector('.w').textContent = ci.onMe ? 'Your pick' : t.level === 'idle' ? 'Pick clock' : clockTeamName(ci);
    mb.hidden = !(ci.onMe && t.level !== 'idle');
    mb.className = 'nd-mb-timer nu-num ' + t.level;
    mb.textContent = t.text;
    // Loud for me: tab title countdown + one beep/vibration at 10s.
    document.title = ci.onMe && t.running ? '⏰ ' + t.text + ' · Your pick — ' + baseTitle : baseTitle;
    if (ci.onMe && t.running && t.left <= 10 && !S.timer.beeped) { S.timer.beeped = true; alertMe(); }
  }
  function saveTimerRun() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(TIMER_RUN) || 'null');
      sessionStorage.setItem(TIMER_RUN, JSON.stringify(L.rememberTimerStart(saved, S.leagueKey, S.timer.pick, S.timer.startedAt)));
    } catch (e) {}
  }
  var baseTitle = document.title, audioCtx = null, userGestured = false;
  document.addEventListener('pointerdown', function () { userGestured = true; }, { once: true, capture: true });
  function alertMe() {
    try { if (navigator.vibrate) navigator.vibrate([120, 80, 120]); } catch (e) {}
    if (!userGestured) return; // browsers block audio before a user gesture
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach(function (at) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = 880; g.gain.value = 0.08;
        o.connect(g); g.connect(audioCtx.destination);
        o.start(audioCtx.currentTime + at); o.stop(audioCtx.currentTime + at + 0.12);
      });
    } catch (e) {}
  }

  /* --------------------------------------------- first run + messages */
  // The full setup card shows only on a first visit (not connected, no picks,
  // not dismissed). After that, setup is the one-line status above the clock.
  function renderFirstRun() {
    var el = $('nd-firstrun'); if (!el) return;
    var done = false; try { done = localStorage.getItem(FIRSTRUN_PREF) === '1'; } catch (e) {}
    var show = !done && !S.connected && !S.merged.picks.length && !S.yahooDown;
    el.hidden = !show;
    document.body.classList.toggle('nd-firstvisit', show);
    if (!show) return;
    $('nd-fr-connect-sub').textContent = S.signedOut ? 'Sign in to Pocket first (free), then approve read-only access on Yahoo.' : 'You’ll approve read-only access on Yahoo, then come straight back.';
  }
  function dismissFirstRun() { try { localStorage.setItem(FIRSTRUN_PREF, '1'); } catch (e) {} renderFirstRun(); }

  // /nba?yahoo=… after the OAuth round trip: say what happened, then tidy the URL.
  var YAHOO_MSG = {
    connected: 'Yahoo connected — pick your league above',
    disconnected: 'Yahoo disconnected',
    signin: 'Sign in to Pocket first, then connect Yahoo',
    denied: 'Yahoo access was not granted — manual board is ready',
    error: 'Couldn’t finish connecting Yahoo — try again',
    misconfigured: 'Yahoo is unavailable on our side right now — manual board is ready'
  };
  function handleYahooParam() {
    var m = /[?&]yahoo=([a-z]+)/.exec(location.search);
    if (!m || !YAHOO_MSG[m[1]]) return;
    setTimeout(function () { toast(YAHOO_MSG[m[1]]); }, 300);
    if (m[1] === 'signin') setTimeout(function () { if (window.Clerk && window.Clerk.openSignIn) window.Clerk.openSignIn({ redirectUrl: '/nba/auth/login' }); }, 1200);
    if (m[1] === 'connected') dismissFirstRun();
    try { history.replaceState(null, '', location.pathname + location.search.replace(/([?&])yahoo=[a-z]+&?/, '$1').replace(/[?&]$/, '') + location.hash); } catch (e) {}
  }

  /* -------------------------------------------------- player sheet */
  var detail = {}; // research id -> detail payload | 'loading' | 'error'
  function openSheet(id) {
    if (!S.byId[id]) return;
    S.sheetId = id;
    renderSheet();
    if (!U.sheet.isOpen() || !$('nd-sheet').classList.contains('is-open')) {
      U.sheet.open('nd-sheet', { initialFocus: '#nd-p-name', onClose: function () { S.sheetId = null; } });
    }
    fetchDetail(S.byId[id]);
  }
  function closeSheet() { if (S.sheetId && U.sheet.isOpen()) U.sheet.close(); S.sheetId = null; }
  function fetchDetail(p) {
    var rid = researchId(p);
    if (detail[rid]) return;
    detail[rid] = 'loading';
    api('/api/nba/player/' + encodeURIComponent(rid)).then(function (d) { detail[rid] = d; }, function () { detail[rid] = 'error'; })
      .then(function () { if (S.sheetId === p.id) renderSheetDetail(p); });
  }
  function renderSheet() {
    var p = S.byId[S.sheetId]; if (!p) return closeSheet();
    var t = V.taken[p.id], ci = V.ci;
    var reco = recoCache.filter(function (r) { return r.player.id === p.id; })[0];
    $('nd-sheet-head').innerHTML =
      '<div class="nd-ph">' + avatar(p, 'xl', { teamBadge: true, eager: true }) +
        '<div class="nd-ph__text"><h2 class="nd-ph__name" id="nd-p-name" tabindex="-1">' + esc(p.name) + '</h2>' +
        '<div class="nd-meta nd-ph__meta">' + posPills(p) + U.teamLogo(p.team, { size: 'sm' }) + '<span class="nd-tm">' + esc(p.team || 'FA') + '</span>' + gamesChip(p) + injBadge(p) + U.tierBadge(p.tier) + '</div>' +
        '<div class="nu-hint nd-ph__src">' + esc(L.yahooPosString(p) ? 'Yahoo ' + L.yahooPosString(p) : 'Est. ' + (Array.isArray(p.pos) ? p.pos.join('/') : (p.pos || '—'))) + (t ? ' · drafted #' + t.pick + ' by ' + esc(t.mine ? 'you' : teamNameForKey(t.team_key, t.slot)) + (t.source === 'manual' && !t.confirmed && liveYahoo() ? ' (pending Yahoo)' : '') : '') + '</div></div>' +
      '</div>' +
      '<button class="nu-btn nu-btn--ghost nu-btn--icon nu-btn--sm nd-ph__x" data-nu-close type="button" aria-label="Close player details">' + U.icon.close + '</button>';
    var lo = Math.max(0, Math.floor(Math.min(p.floor || 0, p.hsValue || 0) - 4)), hi = Math.ceil(Math.max(p.ceiling || 0, p.hsValue || 0) + 4);
    var ranks = '<dl class="nu-kv nd-kv">' +
      '<dt>Board rank</dt><dd>#' + esc(p.rank) + ' · T' + esc(p.tier) + '</dd>' +
      (p.posRank != null ? '<dt>Position rank</dt><dd>#' + esc(p.posRank) + '</dd>' : '') +
      '<dt>Market rank</dt><dd>' + (p.marketRank != null ? '#' + esc(p.marketRank) + (p.label && p.label !== 'fair' ? ' · ' + esc(p.label) + (typeof p.adpDelta === 'number' && p.adpDelta ? ' ' + (p.adpDelta > 0 ? '+' : '') + esc(p.adpDelta) : '') : '') : '—') + '</dd>' +
      '<dt>Yahoo rank</dt><dd>' + (p.yahooPreRank != null ? '#' + esc(p.yahooPreRank) : '—') + (p.yahooPctRos != null ? ' · ' + esc(p.yahooPctRos) + '% rostered' : '') + '</dd>' +
      '</dl>';
    $('nd-sheet-body').innerHTML =
      (reco ? '<p class="nd-why"><span class="nu-eyebrow">Why now</span> ' + esc(reco.reason) + '</p>' : '') +
      '<div class="nu-stats nd-ptiles">' +
        U.statTile({ label: 'Best-game value', value: p.hsValue, tone: 'accent' }) +
        U.statTile({ label: 'Ceiling', value: p.ceiling, dp: 0 }) +
        U.statTile({ label: 'Floor', value: p.floor, dp: 0 }) +
        U.statTile({ label: 'VORP', value: vorpTxt(p) || '—' }) +
      '</div>' +
      (typeof p.floor === 'number' && typeof p.ceiling === 'number' ? '<div class="nd-psec"><div class="nu-label">Single-game range (p10 – p90)</div>' +
        U.rangeBand({ min: lo, max: hi, lo: p.floor, hi: p.ceiling, mark: p.hsValue, labels: ['Floor ' + n0(p.floor), 'Ceiling ' + n0(p.ceiling)], ariaLabel: 'Floor ' + n0(p.floor) + ', ceiling ' + n0(p.ceiling) + ', best-game value ' + n1(p.hsValue) }) + '</div>' : '') +
      '<div id="nd-p-detail" class="nd-pdetail"></div>' +
      '<div class="nd-psec">' + ranks + '</div>' +
      (p.marketRank != null ? '<p class="nu-hint">Market = Yahoo-first consensus' + (p.contested ? ' (sources disagree)' : '') + '. A sanity check only; the board never sorts by it unless you choose to.</p>' : '') +
      (p.source === 'yahoo-only' ? '<p class="nu-hint">No game-log data: this player is in Yahoo’s pool but not in our NBA data feed, so the value is a conservative estimate from Yahoo’s projected fantasy points per game.</p>'
        : p.source && p.source !== 'logs' ? '<p class="nu-hint">' + (p.source === 'rookie' ? 'Rookie: value is projection-only (no NBA game logs yet), so the range is wider than it looks.' : 'Projection-only: not enough recent game logs for a measured spread.') + '</p>' : '') +
      '<a class="nd-full" href="/nba/research?player=' + encodeURIComponent(researchId(p)) + '">Full profile <span aria-hidden="true">→</span></a>';
    renderSheetDetail(p);
    var acts = $('nd-sheet-actions');
    if (S.matching) acts.innerHTML = '<button type="button" class="nu-btn nu-btn--primary" data-act="match" data-id="' + esc(p.id) + '">This is ' + esc(S.matching.name) + '</button>';
    else if (t) acts.innerHTML = t.source === 'manual'
      ? '<button type="button" class="nu-btn" data-act="remove" data-id="' + esc(p.id) + '">Remove pick</button><button type="button" class="nu-btn" data-act="mine-toggle" data-id="' + esc(p.id) + '">' + (t.mine ? 'Not mine' : 'Mine') + '</button>'
      : '<button type="button" class="nu-btn" disabled>Drafted on Yahoo</button>';
    else if (ci.done) acts.innerHTML = '<button type="button" class="nu-btn" disabled>Draft complete</button>';
    else acts.innerHTML = ci.onMe
      ? '<button type="button" class="nu-btn" data-act="other" data-id="' + esc(p.id) + '">Other team</button><button type="button" class="nu-btn nu-btn--primary" data-act="mine" data-id="' + esc(p.id) + '">Draft to my team</button>'
      : '<button type="button" class="nu-btn" data-act="other" data-id="' + esc(p.id) + '">' + esc(clockTeamName(ci)) + ' took him</button><button type="button" class="nu-btn nu-btn--primary" data-act="mine" data-id="' + esc(p.id) + '">Mine</button>';
  }
  // Lazy part of the sheet: last season's per-game line, weekly best-game
  // sparkline, single-game histogram and injury notes from /api/nba/player/:id.
  function renderSheetDetail(p) {
    var box = $('nd-p-detail'); if (!box) return;
    var d = detail[researchId(p)];
    var weeks = p.hsByWeek ? Object.keys(p.hsByWeek).sort(function (a, b) { return a - b; }).map(function (k) { return p.hsByWeek[k]; }) : null;
    var inj = d && typeof d === 'object' && d.injury && (d.injury.status || d.injury.notes) ? d.injury : null;
    var injHtml = inj || p.injury ? '<div class="nu-callout nu-callout--warn nd-inj">' + U.icon.alert + '<div><b>' + esc((inj && (inj.status || inj.tag)) || p.injury) + (inj && inj.bodyPart ? ' · ' + esc(inj.bodyPart) : '') + '</b>' + (inj && inj.notes ? ' ' + esc(inj.notes) : '') + '</div></div>' : '';
    if (d === 'loading' || !d) {
      box.innerHTML = injHtml + '<div class="nd-psec"><div class="nu-label">Last season per game</div><div class="nd-line nd-line--skel"><span class="nu-skel" style="height:40px"></span></div></div>';
      return;
    }
    var html = injHtml, ls = d !== 'error' && d.lastSeason, wb = d !== 'error' && d.weeklyBest;
    if (ls && ls.perGame) {
      var g = ls.perGame;
      html += '<div class="nd-psec"><div class="nd-psec__h"><span class="nu-label">' + esc(ls.season) + '-' + esc(String((ls.season + 1) % 100).padStart(2, '0')) + ' per game</span><span class="nu-hint">' + esc(ls.gp) + ' GP · ' + n1(ls.mpg) + ' MPG</span></div><div class="nd-line">' +
        [['PTS', g.pts], ['REB', g.reb], ['AST', g.ast], ['STL', g.stl], ['BLK', g.blk], ['TO', g.to]].map(function (x) { return '<span><b class="nu-num">' + n1(x[1]) + '</b><small>' + x[0] + '</small></span>'; }).join('') + '</div></div>';
    } else if (d !== 'error' && d.projection && d.projection.pts != null) {
      var pr = d.projection;
      html += '<div class="nd-psec"><div class="nd-psec__h"><span class="nu-label">' + esc(pr.season) + ' projection per game</span><span class="nu-hint">' + n1(pr.min) + ' MPG</span></div><div class="nd-line">' +
        [['PTS', pr.pts], ['REB', pr.reb], ['AST', pr.ast], ['STL', pr.stl], ['BLK', pr.blk], ['TO', pr.to]].map(function (x) { return '<span><b class="nu-num">' + n1(x[1]) + '</b><small>' + x[0] + '</small></span>'; }).join('') + '</div></div>';
    }
    var best = wb && wb.weeks && wb.weeks.length ? wb.weeks.map(function (w) { return w.best; }) : null;
    var series = best || weeks;
    if (series && series.length > 1) {
      var sm = best ? wb.summary : null;
      html += '<div class="nd-psec nd-charts"><div class="nd-chart"><div class="nd-psec__h"><span class="nu-label">' + (best ? 'Best game each week, last season' : 'Projected best game by week') + '</span><span class="nu-hint nu-num">' +
        (sm ? 'avg ' + n1(sm.mean) + ' · max ' + n1(sm.max) : 'avg ' + n1(series.reduce(function (s, x) { return s + x; }, 0) / series.length)) + '</span></div>' +
        U.sparkline(series, { w: 320, h: 48, label: best ? 'Weekly best game last season' : 'Projected weekly best game' }) + '</div>';
      var hb = d !== 'error' && d.histogram;
      if (hb && hb.bins && hb.bins.length) {
        var vals = []; hb.bins.forEach(function (b) { for (var i = 0; i < b.count; i++) vals.push((b.lo + b.hi) / 2); });
        html += '<div class="nd-chart"><div class="nd-psec__h"><span class="nu-label">Every game, last season</span><span class="nu-hint nu-num">' + esc(hb.games) + ' games</span></div>' +
          U.histogram(vals, { bins: hb.bins.length, range: [hb.bins[0].lo, hb.bins[hb.bins.length - 1].hi], w: 320, h: 64, mark: p.hsValue, highlightFrom: p.ceiling, label: 'Distribution of single-game scores' }) + '</div>';
      }
      html += '</div>';
    }
    box.innerHTML = html;
  }

  /* My team sheet (phones) */
  var teamSheetOpen = false;
  function openSide() {
    teamSheetOpen = true; renderRoster();
    U.sheet.open('nd-team-sheet', { onClose: function () { teamSheetOpen = false; } });
  }

  /* ------------------------------------------------------ settings */
  var SETTING_SLOTS = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'];
  function openSettings() {
    var f = $('nd-settings-form'), st = S.state.settings, live = S.connected && S.leagueKey;
    var types = SETTING_SLOTS.slice();
    L.slotTypes(st).forEach(function (t) { if (types.indexOf(t) < 0) types.splice(types.length - 1, 0, t); }); // e.g. FC
    var fld = function (label, name, val, max) { return '<label class="nu-field"><span class="nu-field__label">' + label + '</span><input class="nu-input" name="' + name + '" type="number" inputmode="numeric" min="0" max="' + max + '" value="' + val + '"' + (live ? ' disabled' : '') + '></label>'; };
    $('nd-slot-fields').innerHTML = types.map(function (t) { return fld(slotLabel(t), 'slot_' + t, st.slots[t] || 0, 6); }).join('') +
      fld('BN', 'bench', st.bench, 15) + fld('IL', 'il', st.il || 0, 5) + fld('Rounds', 'rounds', L.draftRounds(st), 30);
    f.teams.value = st.teams; f.mySlot.value = st.mySlot;
    f.timer.value = timerSeconds();
    f.teams.disabled = !!live;
    f.mySlot.disabled = !!(live && S.myTeamKey && S.merged.picks.some(function (p) { return p.source === 'yahoo' && p.mine; }));
    $('nd-profile-reset').hidden = !!live || S.state.settingsSource !== 'user';
    $('nd-settings-hint').textContent = live
      ? 'Loaded from Yahoo league “' + ((S.league && S.league.name) || S.leagueKey) + '”. Reset clears only picks marked on this device.'
      : 'Manual draft tracking. Defaults come from ' + leagueName() + ' (' + st.teams + ' teams, ' + L.starterCount(st) + ' starters, ' + L.rosterSize(st) + ' roster spots, ' + L.draftRounds(st) + ' draft rounds: Yahoo doesn’t draft IL spots). Check the round count in Yahoo’s draft room; with Yahoo connected its pick order wins.';
    U.sheet.open('nd-settings', { initialFocus: 'input[name=mySlot]:not([disabled]), input[name=timer]' });
  }
  function onSettingsSave() {
    var f = $('nd-settings-form'), live = S.connected && S.leagueKey;
    if (!live) {
      var slots = {};
      Array.prototype.forEach.call(f.querySelectorAll('input[name^="slot_"]'), function (i) { slots[i.name.slice(5)] = i.value; });
      S.state.settings = L.normalizeSettings({ teams: f.teams.value, mySlot: f.mySlot.value, slots: slots, bench: f.bench.value, il: f.il.value, rounds: f.rounds.value });
      S.state.settingsSource = 'user';
    } else S.state.settings = L.normalizeSettings(Object.assign({}, S.state.settings, { mySlot: f.mySlot.value }));
    try { localStorage.setItem(TIMER_PREF, String(L.normalizeTimerSeconds(f.timer.value))); } catch (e) {}
    S.timer.startedAt = S.timer.startedAt ? Date.now() : 0; S.timer.beeped = false; saveTimerRun();
    U.sheet.close();
    save(); recompute(); render(); toast('League settings saved', { tone: 'good' });
  }

  /* ----------------------------------------------------------- yahoo */
  function api(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error('HTTP ' + r.status); e.status = r.status; e.code = j && j.code; throw e;
        });
      }
      return r.json();
    });
  }

  function yahooStatus() {
    // One shared /status fetch with the nav chip (yahoo-chip.js) when present.
    if (window.PocketYahoo) return window.PocketYahoo.status();
    return api('/api/nba/yahoo/status').catch(function (e) { return { connected: false, leagues: [], httpStatus: e.status || 0, code: e.code }; });
  }

  function initYahoo() {
    return yahooStatus().then(function (st) {
      S.connected = !!(st && st.connected);
      S.leagues = (st && st.leagues) || [];
      S.signedOut = !!(st && st.httpStatus === 401);
      S.yahooDown = !!(st && (st.httpStatus === 503 || st.code === 'yahoo_misconfigured'));
    }).catch(function () { S.connected = false; S.leagues = []; }).then(function () {
      var sel = $('nd-league');
      if (!S.connected || !S.leagues.length) { sel.hidden = true; return selectLeague(null); }
      var pref = null; try { pref = localStorage.getItem(LEAGUE_PREF); } catch (e) {}
      var pick = S.leagues.filter(function (l) { return l.league_key === pref; })[0]
        || S.leagues.filter(function (l) { return l.draft_status !== 'postdraft'; })[0] || S.leagues[0];
      sel.innerHTML = S.leagues.map(function (l) {
        return '<option value="' + esc(l.league_key) + '">' + esc(l.name) + ' · ' + esc(l.num_teams) + ' teams' + (l.draft_status === 'postdraft' ? ' · drafted' : '') + '</option>';
      }).join('') + '<option value="">Manual board (no league)</option>';
      sel.value = pref === '' ? '' : pick.league_key;
      sel.hidden = false;
      return selectLeague(sel.value || null);
    });
  }

  function selectLeague(key) {
    stopPolling();
    S.leagueKey = key; S.league = null; S.teams = []; S.myTeamKey = null; S.failures = 0; S.lastOk = 0; S.lastYahooCount = -1; S.auction = false;
    try { if (S.connected) localStorage.setItem(LEAGUE_PREF, key || ''); } catch (e) {}
    if (S.connected) window.dispatchEvent(new CustomEvent('pocket-nba:league', { detail: { leagueKey: key || null, source: 'page' } }));
    load(key, L.DEFAULT_SETTINGS);
    if (!key) { S.sync = 'off'; applyProfile(); recompute(); render(); return Promise.resolve(); }
    S.sync = 'connecting'; recompute(); render();
    return api('/api/nba/yahoo/league?league_key=' + encodeURIComponent(key)).then(function (d) {
      S.league = d.league || null; S.teams = d.teams || []; S.myTeamKey = d.myTeamKey || null;
      // Yahoo's roster_positions win; the profile fills anything Yahoo leaves out.
      var base = S.profile ? L.settingsFromProfile(S.profile, S.state.settings) : S.state.settings;
      S.state.settings = L.settingsFromYahoo(S.league, S.myTeamKey, S.teams, base);
      S.auction = L.isAuction(S.league, null);
      save();
    }).catch(function (e) {
      S.lastErr = e.code === 'yahoo_misconfigured' ? 'Yahoo unavailable' : e.status ? 'league ' + e.status : 'network';
    }).then(function () {
      recompute(); render();
      if (S.auction) { S.sync = 'off'; stopPolling(); return; } // auction: manual mode, no Yahoo pick sync
      poll(true);
    });
  }

  function stopPolling() { clearTimeout(S.pollTimer); S.pollTimer = null; }
  function schedulePoll() {
    stopPolling();
    if (!S.connected || !S.leagueKey || S.auction) return;
    var plan = L.pollPlan(document.hidden, S.state.yahoo && S.state.yahoo.status, S.failures);
    S.nextPollAt = Date.now() + plan.delay;
    if (!plan.run) return; // resumes on visibilitychange
    S.pollTimer = setTimeout(function () { poll(true); }, plan.delay);
  }
  var inflight = false;
  function poll(force) {
    if (!S.connected || !S.leagueKey || S.auction || inflight) return;
    if (document.hidden && !force) return;
    inflight = true;
    var key = S.leagueKey;
    api('/api/nba/yahoo/draft?league_key=' + encodeURIComponent(key)).then(function (d) {
      if (key !== S.leagueKey) return;
      var before = S.lastYahooCount;
      if (L.isAuction(null, d)) {
        S.auction = true; S.state.yahoo = null; S.sync = 'off';
        save(); recompute(); render(); return;
      }
      S.state.yahoo = { status: d.status, picks: d.picks || [], unmatched: d.unmatched || [], order: d.order || null, polledAt: d.polledAt || new Date().toISOString() };
      S.failures = 0; S.lastOk = Date.now(); S.sync = 'live'; S.lastErr = '';
      save(); recompute(); render();
      var n = S.state.yahoo.picks.length;
      if (before >= 0 && n > before) {
        var last = S.merged.picks.filter(function (p) { return p.source === 'yahoo'; }).pop();
        if (last) toast('Pick ' + last.pick + ': ' + last.name + ' → ' + (last.mine ? 'you' : teamNameForKey(last.team_key, last.slot)));
        if (!reduceMotion) Array.prototype.forEach.call(document.querySelectorAll('.nd-pick'), function (el) {
          if (+el.getAttribute('data-pick') > before) el.classList.add('flash');
        });
      }
      S.lastYahooCount = n;
    }).catch(function (e) {
      if (key !== S.leagueKey) return;
      S.failures++; S.lastErr = e.code === 'yahoo_misconfigured' ? 'Yahoo app issue on our side' : e.code === 'yahoo_reauth' ? 'Yahoo sign-in expired — reconnect' : e.status ? 'HTTP ' + e.status : 'offline';
      if (S.failures >= 2 || !S.lastOk) S.sync = 'degraded';
    }).then(function () { inflight = false; if (key === S.leagueKey) { schedulePoll(); renderSync(); } });
  }

  /* --------------------------------------------------------- events */
  function bind() {
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
      if (act === 'sheet') { if (S.matching) completeMatch(id); else openSheet(id); }
      else if (act === 'draft') { draftPlayer(id); }
      else if (act === 'mine') { closeSheet(); draftPlayer(id, true); }
      else if (act === 'other') { closeSheet(); draftPlayer(id, false); }
      else if (act === 'remove') { closeSheet(); removeManual(id); }
      else if (act === 'mine-toggle') { toggleMine(id); }
      else if (act === 'match') { closeSheet(); completeMatch(id); }
      else if (act === 'start-match') { startMatch(b.getAttribute('data-key'), b.getAttribute('data-name')); }
      else if (act === 'pos') {
        var pos = b.getAttribute('data-pos');
        S.pos = b.closest('.nd-low') && S.pos === pos ? 'ALL' : pos;
        if (b.closest('.nd-low')) { var f = $('nd-filters'); if (f && f.scrollIntoView && phoneMQ.matches) f.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' }); }
        renderFilters(); renderBoard();
      }
      else if (act === 'print') { window.print(); }
    });
    $('nd-undo').onclick = undo;
    $('nd-search').addEventListener('input', function (e) { S.q = e.target.value; renderBoard(); });
    $('nd-tier').onchange = function () { S.tierMax = parseInt(this.value, 10) || 0; renderBoard(); };
    $('nd-sort').onchange = function () { S.sort = this.value; try { localStorage.setItem(SORT_PREF, S.sort); } catch (e) {} renderBoard(); };
    $('nd-hide-out').onclick = function () { S.hideOut = !S.hideOut; this.setAttribute('aria-pressed', String(S.hideOut)); renderBoard(); };
    Array.prototype.forEach.call(document.querySelectorAll('#nd-views button'), function (b) { b.onclick = function () { setView(b.getAttribute('data-view')); window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }); }; });
    $('nd-profile-reset').onclick = function () {
      S.state.settingsSource = null; applyProfile(); save(); recompute(); render();
      U.sheet.close(); toast('Using the ' + leagueName() + ' profile');
    };
    $('nd-show-taken').onclick = function () { S.showTaken = !S.showTaken; this.setAttribute('aria-pressed', String(S.showTaken)); renderBoard(); };
    $('nd-mb-btn').onclick = openSide;
    $('nd-settings-btn').onclick = openSettings;
    $('nd-slot-edit').onclick = openSettings;
    $('nd-about-btn').onclick = function () { U.sheet.open('nd-about'); };
    $('nd-settings-form').addEventListener('submit', function (e) { e.preventDefault(); onSettingsSave(); });
    $('nd-reset').onclick = function () {
      if (!confirm('Clear every pick marked on this device for this league?')) return;
      S.state.manual = []; S.state.overrides = {}; save(); recompute(); render();
      U.sheet.close(); toast('Draft reset');
    };
    $('nd-league').onchange = function () {
      selectLeague(this.value || null);
    };
    // League chosen from the nav chip.
    window.addEventListener('pocket-nba:league', function (e) {
      if (!e.detail || e.detail.source !== 'chip' || !S.connected) return;
      var k = e.detail.leagueKey || '';
      $('nd-league').value = k;
      if ((k || null) !== S.leagueKey) selectLeague(k || null);
    });
    $('nd-timer').onclick = function () { S.timer.startedAt = Date.now(); S.timer.beeped = false; saveTimerRun(); renderTimer(clockInfo()); };
    $('nd-fr-manual').onclick = function () { dismissFirstRun(); toast('Manual board: tap Draft as picks happen'); };
    $('nd-fr-close').onclick = function () { dismissFirstRun(); };
    $('nd-fr-connect').onclick = function (e) {
      if (S.signedOut && window.Clerk && window.Clerk.openSignIn) { e.preventDefault(); window.Clerk.openSignIn({ redirectUrl: '/nba/auth/login' }); }
    };
    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (e.key === 'Escape' && S.matching && !U.sheet.isOpen()) endMatch();
      if (U.sheet.isOpen()) return;
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && tag !== 'INPUT' && tag !== 'SELECT') setView(S.view === 'cheat' ? 'board' : 'cheat');
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && tag !== 'INPUT') { e.preventDefault(); undo(); }
      if (e.key === '/' && tag !== 'INPUT') { e.preventDefault(); $('nd-search').focus(); }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) schedulePoll(); else if (S.connected && S.leagueKey) poll(true);
    });
    // "updated Ns ago" + retry countdown tick
    setInterval(function () { if (S.connected && S.leagueKey) renderSync(); renderTimer(clockInfo()); }, 1000);
    // Another tab drafting the same league → pick it up.
    window.addEventListener('storage', function (e) {
      if (e.key === L.storageKey(S.state.leagueKey)) { load(S.state.leagueKey, S.state.settings); recompute(); render(); }
    });
    // Sticky offsets follow the real nav / clock heights.
    var setOffsets = function () {
      var nav = $('rr-nav'), clock = $('nd-clock'), filt = $('nd-filters');
      var r = document.documentElement.style;
      r.setProperty('--nd-nav-h', (nav ? nav.offsetHeight : 56) + 'px');
      r.setProperty('--nd-clock-h', clock.offsetHeight + 'px');
      r.setProperty('--nd-filters-h', filt.offsetHeight + 'px');
    };
    setOffsets();
    if (window.ResizeObserver) new ResizeObserver(setOffsets).observe($('nd-clock'));
    window.addEventListener('resize', setOffsets);
  }

  /* ----------------------------------------------------------- clerk */
  function initClerk() {
    var key = window.__clerk_publishable_key;
    if (!key || key.indexOf('PLACEHOLDER') >= 0) return;
    // The NbaUI nav has no auth slots of its own: add them next to the Yahoo chip.
    var auth = document.querySelector('#rr-nav .rr-auth');
    if (auth && !$('user-btn-mount')) auth.insertAdjacentHTML('beforeend', '<div id="user-btn-mount"></div><button id="rr-sign-in" class="nu-btn nu-btn--sm" type="button" hidden>Sign in</button>');
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
    s.crossOrigin = 'anonymous'; s.async = true;
    s.onload = function () {
      try {
        var clerk = (window.Clerk && typeof window.Clerk.load === 'function') ? window.Clerk : new window.Clerk(key);
        clerk.load({ telemetry: { disabled: true } }).then(function () {
          var btn = $('rr-sign-in'), mount = $('user-btn-mount');
          if (!btn || !mount) return;
          if (clerk.user) { clerk.mountUserButton(mount); btn.hidden = true; }
          else { btn.hidden = false; btn.onclick = function () { clerk.openSignIn({ redirectUrl: '/nba' }); }; }
        }).catch(function (e) { console.warn('Clerk load failed', e); });
      } catch (e) { console.warn('Clerk init failed', e); }
    };
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------ boot */
  function loadPlayers() {
    return api('/api/nba/players?profile=' + encodeURIComponent((S.profile && S.profile.leagueId) || '242808')).then(function (d) {
      var list = (d && d.players) || [];
      // Board identity = Yahoo player id when present (Yahoo draft sync speaks
      // Yahoo player_keys), else the Sleeper id. Sleeper ids stay as aliases so
      // picks/overrides saved before the switch still resolve.
      S.byYahooPid = {}; S.alias = {};
      S.hasMarket = list.some(function (p) { return p.marketRank != null; });
      list.forEach(function (p) {
        p.sleeperId = p.source !== 'yahoo-only' && p.id != null && p.id !== '' ? String(p.id) : null;
        p.id = L.playerKey(p);
        if (p.yahooPid != null && p.yahooPid !== '') S.byYahooPid[String(p.yahooPid)] = p.id;
        if (p.sleeperId && p.sleeperId !== p.id && !S.alias[p.sleeperId]) S.alias[p.sleeperId] = p.id;
      });
      list.sort(function (a, b) { return (a.rank || 1e9) - (b.rank || 1e9) || (b.hsValue || 0) - (a.hsValue || 0); });
      S.players = list; S.asOf = d.asOf;
      S.byId = {}; list.forEach(function (p) { S.byId[p.id] = p; });
      rowCache = {}; $('nd-list').innerHTML = '';
      migrateIds();
    }).catch(function (e) {
      $('nd-list').innerHTML = U.emptyState({ title: 'Couldn’t load players' + (e.status ? ' (HTTP ' + e.status + ')' : ''), body: 'Your picks are saved on this device.', action: '<button type="button" class="nu-btn" id="nd-reload">Try again</button>' });
      $('nd-reload').onclick = function () { loadPlayers().then(function () { recompute(); render(); }); };
    });
  }

  // Rewrite saved Sleeper ids (manual picks, match overrides) to board ids.
  function migrateIds() {
    var changed = false, a = S.alias;
    S.state.manual.forEach(function (m) { var k = m && m.playerId != null && a[String(m.playerId)]; if (k) { m.playerId = k; changed = true; } });
    Object.keys(S.state.overrides || {}).forEach(function (pk) { var k = a[String(S.state.overrides[pk])]; if (k) { S.state.overrides[pk] = k; changed = true; } });
    if (changed) save();
  }

  // League profile (12 teams / 9 starters / 90s for 242808). If it can't load,
  // the logic's built-in 242808 defaults apply and a toast says so.
  function loadProfile() {
    return api('/api/nba/league-profile').then(function (p) {
      if (p && p.slots && p.teams) { S.profile = p; S.profileErr = false; } else throw new Error('bad profile');
    }).catch(function () { S.profile = null; S.profileErr = true; setTimeout(function () { toast('League profile unavailable — using built-in league 242808 settings'); }, 400); })
      .then(function () { applyProfile(); recompute(); render(); });
  }

  bind();
  handleYahooParam();
  initClerk();
  load(null, L.DEFAULT_SETTINGS);
  recompute(); render();
  var profileP = loadProfile();
  Promise.all([loadPlayers(), profileP.then(initYahoo)]).then(function () { recompute(); render(); });
})();
