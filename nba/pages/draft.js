/* Pocket NBA — draft board controller (stream C).
   Works with no Yahoo connection (manual tracking, localStorage per league) and
   upgrades to Yahoo-first live sync when /api/nba/yahoo/status says connected.
   Pure logic lives in draft-logic.js (window.NbaDraft). */
(function () {
  'use strict';
  var L = window.NbaDraft;
  var $ = function (id) { return document.getElementById(id); };
  var LEAGUE_PREF = 'pocket-nba-league';
  var TIMER_PREF = 'pocket-nba-pick-timer';
  var TIMER_RUN = 'pocket-nba-pick-timer-run';  // sessionStorage: [{leagueKey, pick, startedAt}] of recent running clocks     // user's pick-timer seconds ('' = use league / default)
  var FIRSTRUN_PREF = 'pocket-nba-firstrun-done';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    pos: 'ALL', q: '', showTaken: false, tierMax: 0, hideOut: false, view: 'board', sheetId: null, matching: null, lastFocus: null, pulse: [],
    merged: { picks: [], unmatched: [], confirmedManual: [] }, lastYahooCount: -1
  };

  /* ------------------------------------------------------------ utils */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
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
  function posPills(p) {
    if (L.isLegacy(S.state.settings)) {
      var e = (p.elig || []).filter(function (x) { return x !== 'UTIL'; });
      if (!e.length) e = ['UTIL'];
      return e.map(function (x) { return '<span class="pp ' + x + '">' + x + '</span>'; }).join('');
    }
    // Yahoo-style positions; dashed when eligibility isn't confirmed by Yahoo.
    var el = L.slotElig(p), list = L.displayPositions(p), low = el.source !== 'yahoo' || el.low;
    if (!list.length) list = ['UTIL'];
    var why = el.source !== 'yahoo' ? 'from Sleeper positions' : 'eligibility source: ' + (p.eligConfidence == null ? 'unknown' : p.eligConfidence);
    return list.map(function (x) {
      return '<span class="pp ' + fam(x) + (low ? ' low' : '') + '"' + (low ? ' title="Not confirmed by Yahoo (' + esc(why) + ')"' : '') + '>' + x + '</span>';
    }).join('') + (low ? '<span class="nd-elig-badge" title="Positions not confirmed by Yahoo (' + esc(why) + ')" aria-label="Positions not confirmed by Yahoo">?</span>' : '');
  }
  function vorpTxt(p) { return typeof p.vorp === 'number' && isFinite(p.vorp) ? (p.vorp >= 0 ? '+' : '') + p.vorp.toFixed(1) : null; }
  function injBadge(p) {
    var s = L.injuryShort(p.injury);
    return s ? '<span class="inj ' + s + '" title="' + esc(p.injury) + '">' + s + '</span>' : '';
  }
  function gamesChip(p) {
    if (typeof p.games !== 'number') return '';
    var cls = p.games >= 4 ? ' hi' : p.games <= 2 ? ' lo' : '';
    return '<span class="nd-gm' + cls + '" title="' + p.games + ' games this week">' + p.games + 'g</span>';
  }
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
  var toastT = null;
  function toast(msg) {
    var el = $('nd-toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

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
    toast((mine ? 'You took ' : clockTeamName(ci) + ' took ') + p.name + (live ? ' · waiting for Yahoo' : ''));
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
    closeSide();
    var bar = $('nd-matchbar');
    bar.innerHTML = '<span>Tap the board player who is <b>' + esc(name) + '</b> (Yahoo pick).</span><button type="button" class="btn-secondary" id="nd-match-cancel">Cancel</button>';
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
  function render() {
    renderHead(); renderFirstRun(); renderClock(); renderPulse(); renderReco(); renderFilters(); renderBoard(); renderRoster(); renderPicks(); renderReview(); renderSync(); renderMinibar();
    if (S.view === 'cheat') renderCheat();
    if (S.sheetId) renderSheet();
  }

  function renderHead() {
    var st = S.state.settings, types = L.slotTypes(st), parts = [];
    types.forEach(function (t) { var c = st.slots[t]; parts.push(slotLabel(t) + (c > 1 ? '×' + c : '')); });
    var secs = timerSeconds();
    $('nd-eyebrow').textContent = 'NBA · ' + leagueName();
    $('nd-sub').textContent = st.teams + ' teams · ' + parts.join(', ') + ' + ' + st.bench + ' BN' + (st.il ? ' + ' + st.il + ' IL' : '') +
      ' · ' + L.draftRounds(st) + ' rounds' + (secs ? ' · ' + secs + 's picks' : '') + '. Ranked by expected best game of the week under your league’s scoring.';
  }

  // Top-40 supply per slot + "run" detection from the last round of picks.
  function renderPulse() {
    var st = S.state.settings, recent = [];
    S.merged.picks.slice(-st.teams).forEach(function (p) { if (p.playerId && S.byId[p.playerId]) recent.push(S.byId[p.playerId]); });
    S.pulse = S.players.length ? L.slotPulse(available(), recent, S.players, st, 40) : [];
  }

  function renderClock() {
    var ci = clockInfo(), st = S.state.settings;
    $('nd-round').textContent = ci.round;
    $('nd-pick').textContent = ci.done ? ci.total : ci.cur;
    $('nd-of').textContent = '/' + ci.total;
    $('nd-clock').classList.toggle('mine', !!ci.onMe);
    var who = $('nd-otc-who'), sub = $('nd-otc-sub');
    if (S.auction) { who.textContent = 'Auction draft · manual tracking'; sub.textContent = 'Mark players as they’re won; ★ the ones you win'; }
    else if (ci.done) { who.textContent = 'Draft complete'; sub.textContent = 'Your roster is set — see My team'; }
    else if (ci.onMe) { who.textContent = "You're on the clock"; sub.textContent = !ci.myAfter ? 'Last pick of your draft' : ci.gapNow ? 'Then ' + ci.gapNow + ' picks until #' + ci.myAfter : 'Back-to-back: you also pick #' + ci.myAfter; }
    else {
      who.textContent = clockTeamName(ci) + ' on the clock';
      var away = ci.awayN;
      sub.textContent = ci.myNext ? 'You pick in ' + away + ' · #' + ci.myNext + (ci.myNextRound ? ' (R' + ci.myNextRound + ')' : '') + (ci.myAfter ? ', then #' + ci.myAfter : '') : 'Your picks are done';
    }
    renderTimer(ci);
    var undoBtn = $('nd-undo');
    undoBtn.disabled = !S.state.manual.length;
    var last = S.state.manual[S.state.manual.length - 1];
    undoBtn.setAttribute('aria-label', last && S.byId[last.playerId] ? 'Undo pick: ' + S.byId[last.playerId].name : 'Undo last pick');
    // ticker: next ~24 picks
    var html = '';
    if (!ci.done && ci.fromYahoo) {
      // Yahoo order: show each upcoming slot's owner (draft position, or YOU).
      L.openSlots(S.state.yahoo).slice(pendingCount(), pendingCount() + 24).forEach(function (o, i) {
        var mineT = o.team_key && o.team_key === S.myTeamKey;
        var t = (S.teams || []).filter(function (x) { return x.team_key === o.team_key; })[0];
        var lbl = mineT ? 'YOU' : (t && t.draft_position) || (t && t.team_id) || (o.team_key || '').split('.t.')[1] || '?';
        html += '<span class="nd-tick' + (i === 0 ? ' now' : '') + (mineT ? ' me' : '') + '" title="#' + o.pick + ' ' + esc(t ? t.name : '') + '">' + esc(lbl) + '</span>';
      });
    } else if (!ci.done && !S.auction) {
      for (var p = ci.cur; p < Math.min(ci.total + 1, ci.cur + 24); p++) {
        var s = L.slotForPick(p, st.teams);
        var cls = 'nd-tick' + (p === ci.cur ? ' now' : '') + (s === st.mySlot ? ' me' : '') + (p > ci.cur && (p - 1) % st.teams === 0 ? ' turn' : '');
        html += '<span class="' + cls + '">' + (s === st.mySlot ? 'YOU' : s) + '</span>';
      }
    }
    $('nd-ticker').innerHTML = html;
  }

  var recoCache = [];
  function renderReco() {
    var el = $('nd-reco'), ci = clockInfo(), st = S.state.settings;
    if (!S.players.length || ci.done || !ci.myNext) { el.hidden = true; recoCache = []; return; }
    var k = ci.onMe ? ci.gapNow : ci.gapNext;
    var list = L.bestAvailable(available(), myRoster().filter(function (p) { return !p.unmatched; }), st,
      { picksUntilNext: k, nextPick: ci.onMe ? ci.myAfter : ci.myAfter, limit: 3 });
    recoCache = list;
    if (!list.length) { el.hidden = true; return; }
    var top = list[0], p = top.player;
    var label = ci.onMe ? 'Your pick now' : 'Best for your pick #' + ci.myNext;
    var tag = top.slot === 'BENCH' ? 'Bench' : top.ownSlot ? 'Starts ' + slotLabel(top.ownSlot) : (top.upgrade ? 'Upgrade ' : 'Fills ') + slotLabel(top.slot);
    el.innerHTML =
      '<div class="lbl"><span class="section-label">' + esc(label) + ' <span class="nd-fill ' + fam(top.slot) + '">' + esc(tag) + '</span></span><span class="section-label">Value / ceiling</span></div>' +
      '<div class="nd-reco-main">' +
        '<button type="button" class="nd-reco-name" data-act="sheet" data-id="' + esc(p.id) + '" aria-label="Details for ' + esc(p.name) + '">' + esc(p.name) + '<small>' + posPills(p) + ' ' + esc(p.team || '') + ' ' + gamesChip(p) + ' ' + injBadge(p) + '</small></button>' +
        '<div class="nd-reco-val"><b>' + n1(p.hsValue) + '</b><span>ceil ' + n0(p.ceiling) + (vorpTxt(p) ? ' · vorp ' + vorpTxt(p) : '') + '</span></div>' +
      '</div>' +
      '<p class="nd-reco-why">' + esc(top.reason) + '</p>' +
      '<div class="nd-reco-alts">' +
        (ci.onMe ? '<button type="button" class="btn-primary" data-act="mine" data-id="' + esc(p.id) + '">Draft ' + esc(shortName(p.name)) + '</button>' : '') +
        list.slice(1).map(function (r) {
          return '<button type="button" class="nd-alt" data-act="sheet" data-id="' + esc(r.player.id) + '" title="' + esc(r.reason) + '">' + esc(r.player.name) + ' <span class="v">' + (r.slot === 'BENCH' ? 'BN' : slotLabel(r.ownSlot || r.slot)) + ' ' + n1(r.player.hsValue) + '</span></button>';
        }).join('') +
      '</div>';
    el.hidden = false;
  }

  // Market (Yahoo-first consensus) rank + reach/value badge; empty cell when absent.
  function mktCell(p) {
    if (!S.hasMarket) return '';
    if (p.marketRank == null) return '<span class="nd-mkt" aria-hidden="true"></span>';
    var lab = p.label === 'value' || p.label === 'reach' ? p.label : '';
    var d = typeof p.adpDelta === 'number' ? Math.abs(p.adpDelta) : null;
    var tip = 'Market #' + p.marketRank + (lab ? ' · ' + lab + (d != null ? ' by ' + d : '') : '') + (p.contested ? ' · sources disagree' : '');
    return '<span class="nd-mkt' + (p.marketConfidence != null && p.marketConfidence < 0.4 ? ' low' : '') + '" title="' + esc(tip) + '"><span class="mr">M' + esc(p.marketRank) + '</span>' +
      (lab ? '<span class="mb ' + lab + (p.strong ? ' strong' : '') + '">' + (lab === 'value' ? '▲' : '▼') + (d != null ? d : '') + '</span>' : '') + '</span>';
  }

  function renderBoard() {
    var list = $('nd-list');
    if (!S.players.length) return;
    var taken = takenMap(), ci = clockInfo();
    var recoId = recoCache[0] && recoCache[0].player.id;
    var rows = [], lastTier = null, shown = 0, availN = 0;
    S.players.forEach(function (p) {
      var t = taken[p.id];
      if (!t) availN++;
      if (t && !S.showTaken) return;
      if (!L.matchesPos(p, S.pos, S.state.settings) || !L.matchesQuery(p, S.q)) return;
      if (S.tierMax && !(p.tier <= S.tierMax)) return;
      if (S.hideOut && !t && /OUT|SUS/.test(L.injuryShort(p.injury))) return;
      shown++;
      if (shown > 400) return;
      if (p.tier !== lastTier && !S.q) { rows.push('<div class="rsch-tier-divider" role="presentation">Tier ' + esc(p.tier) + '</div>'); lastTier = p.tier; }
      var cls = 'nd-row' + (t ? ' taken' : '') + (p.id === recoId ? ' reco' : '') + (ci.onMe ? ' nd-on-me' : '') + (S.matching ? ' nd-matching' : '');
      var btnTxt = S.matching ? 'Match' : t ? (t.source === 'manual' ? 'Undo' : 'Taken') : ci.onMe ? 'Take' : 'Draft';
      var btnLbl = S.matching ? 'Match ' + S.matching.name + ' to ' + p.name
        : t ? (t.source === 'manual' ? 'Remove pick of ' + p.name : p.name + ' drafted by ' + teamNameForKey(t.team_key, t.slot))
        : ci.onMe ? 'Draft ' + p.name + ' to your team' : 'Mark ' + p.name + ' drafted by ' + clockTeamName(ci);
      rows.push(
        '<div class="' + cls + '" role="listitem">' +
          '<button type="button" class="nd-row-main" data-act="sheet" data-id="' + esc(p.id) + '" aria-label="' + esc(p.name + ', ' + (p.team || '') + ', value ' + n1(p.hsValue) + (p.injury ? ', ' + p.injury : '')) + '">' +
            '<span class="nd-rk">' + esc(p.rank) + (p.yahooPreRank != null ? '<small title="Yahoo pre-season rank">Y' + esc(p.yahooPreRank) + '</small>' : '') + '</span>' +
            '<span class="nd-who"><span class="nd-name">' + esc(p.name) + '</span>' +
              '<span class="nd-meta">' + posPills(p) + '<span class="tm">' + esc(p.team || 'FA') + '</span>' + gamesChip(p) + injBadge(p) +
              (p.noLogData ? '<span class="nd-flag nolog" title="No game-log data: value estimated from Yahoo projection">NO LOGS</span>' : '') +
              (t ? '<span>· ' + esc(t.mine ? 'You' : teamNameForKey(t.team_key, t.slot)) + ' #' + t.pick + '</span>' : '') + '</span></span>' +
            mktCell(p) +
            '<span class="nd-val"><b>' + n1(p.hsValue) + '</b><small>' + n0(p.ceiling) + '/' + n0(p.floor) + '</small></span>' +
          '</button>' +
          '<button type="button" class="nd-draft" data-act="' + (S.matching ? 'match' : t ? (t.source === 'manual' ? 'remove' : 'noop') : 'draft') + '" data-id="' + esc(p.id) + '" aria-label="' + esc(btnLbl) + '"' + (t && t.source !== 'manual' && !S.matching ? ' disabled' : '') + '>' + btnTxt + '</button>' +
        '</div>');
    });
    if (!shown) rows.push('<div class="empty-hint" style="margin-top:1rem"><span>No players match</span><span class="eh-sub">Try another name, or clear the position / tier filters.</span></div>');
    list.innerHTML = rows.join('');
    $('nd-count').textContent = availN + ' available · ' + (S.players.length - availN) + ' drafted' + (shown > 400 ? ' · showing top 400' : '');
  }

  function renderFilters() {
    var st = S.state.settings, types = L.slotTypes(st);
    if (S.pos !== 'ALL' && types.indexOf(S.pos) < 0) S.pos = 'ALL';
    var pulse = {}; S.pulse.forEach(function (x) { pulse[x.slot] = x; });
    var seg = $('nd-seg');
    seg.style.setProperty('--n', types.length + 1);
    seg.innerHTML = ['ALL'].concat(types).map(function (t) {
      var x = pulse[t], cls = x ? (x.run ? ' run' : x.scarce ? ' scarce' : '') : '';
      var title = t === 'ALL' ? 'All players' : x ? slotLabel(t) + '-eligible: ' + x.left + ' left in the top 40' + (x.recent ? ', ' + x.recent + ' taken in the last ' + st.teams + ' picks' : '') + (x.run ? ' — position run' : x.scarce ? ' — thin' : '') : (t === 'UTIL' ? 'Everyone (UTIL)' : slotLabel(t));
      return '<button type="button" class="' + fam(t === 'ALL' ? 'UTIL' : t) + cls + '" data-act="pos" data-pos="' + t + '" aria-pressed="' + (S.pos === t) + '" title="' + esc(title) + '" aria-label="' + esc(title) + '">' +
        '<span>' + (t === 'ALL' ? 'All' : t === 'UTIL' ? 'U' : slotLabel(t)) + '</span>' + (x ? '<small>' + x.left + '</small>' : '') + '</button>';
    }).join('');
    var tiers = {}; S.players.forEach(function (p) { if (p.tier != null) tiers[p.tier] = 1; });
    var tsel = $('nd-tier'), keys = Object.keys(tiers).map(Number).filter(isFinite).sort(function (x, y) { return x - y; });
    var want = '<option value="0">All tiers</option>' + keys.map(function (k) { return '<option value="' + k + '">Tier ≤ ' + k + '</option>'; }).join('');
    if (tsel.getAttribute('data-sig') !== String(keys.length)) { tsel.innerHTML = want; tsel.setAttribute('data-sig', String(keys.length)); }
    tsel.value = String(S.tierMax || 0);
    var derived = S.players.length && S.players.filter(function (p) { return L.slotElig(p).source !== 'yahoo'; }).length > S.players.length / 2;
    $('nd-elig-note').hidden = !(derived && !L.isLegacy(st));
  }

  function renderRoster() {
    var st = S.state.settings, roster = myRoster();
    var a = L.assignSlots(roster.filter(function (p) { return !p.unmatched; }), st);
    var ci = clockInfo();
    // Picks other teams make before I choose again (on the clock: until my following pick).
    var k = ci.onMe ? ci.gapNow : ci.myNext ? ci.awayN : st.teams - 1;
    var warns = L.balanceWarnings(roster.filter(function (p) { return !p.unmatched; }), st, { available: available(), players: S.players, picksUntilNext: k });
    S.warns = warns;
    var need = {}; warns.forEach(function (w) { var m = /no (\w+) yet|Needs a \w+ (\w+)/.exec(w.text); if (m) need[m[1] || m[2]] = 1; });
    var html = '';
    a.starters.forEach(function (s) {
      html += '<div class="nd-slot' + (!s.player && need[s.slot] ? ' need' : '') + '"><span class="sl ' + fam(s.slot) + '">' + slotLabel(s.slot) + '</span>' +
        (s.player ? '<span class="nm">' + esc(s.player.name) + '</span>' + injBadge(s.player) + '<span class="v">' + n1(s.player.hsValue) + '</span>'
                  : '<span class="nm open">Open</span>') + '</div>';
    });
    var bench = a.bench.concat(roster.filter(function (p) { return p.unmatched; }));
    if (st.bench || bench.length) {
      html += '<div class="nd-bench-hdr">Bench</div>';
      bench.forEach(function (p) {
        html += '<div class="nd-slot"><span class="sl BN">BN</span><span class="nm">' + esc(p.name) + '</span>' +
          (p.unmatched ? '<span class="nd-flag um">REVIEW</span>' : posPills(p) + '<span class="v">' + n1(p.hsValue) + '</span>') + '</div>';
      });
      for (var i = bench.length; i < st.bench; i++) html += '<div class="nd-slot"><span class="sl BN">BN</span><span class="nm open">Open</span></div>';
    }
    if (st.il) {
      html += '<div class="nd-bench-hdr">IL <span class="nd-hdr-note">injured players only</span></div>';
      a.il.forEach(function (p) {
        var hurt = /OUT|SUS/.test(L.injuryShort(p.injury));
        html += '<div class="nd-slot"><span class="sl BN">IL</span><span class="nm">' + esc(p.name) + '</span>' + (hurt ? injBadge(p) : '<span class="nd-flag" title="Healthy players can’t sit on IL in Yahoo">NOT IL</span>') + '<span class="v">' + n1(p.hsValue) + '</span></div>';
      });
      for (var j = a.il.length; j < st.il; j++) html += '<div class="nd-slot"><span class="sl BN">IL</span><span class="nm open">Open</span></div>';
    }
    $('nd-roster').innerHTML = html;
    var openN = 0; Object.keys(a.open).forEach(function (t) { openN += a.open[t]; });
    $('nd-roster-total').textContent = roster.length + '/' + L.draftRounds(st) + ' · ' + (openN ? openN + ' starter slot' + (openN > 1 ? 's' : '') + ' open' : 'starters ' + n1(a.total));
    $('nd-warns').innerHTML = warns.map(function (w) { return '<div class="nd-warn ' + w.level + '">' + esc(w.text) + '</div>'; }).join('');
    // Which positions are thin / running right now (top-40 supply).
    var hot = S.pulse.filter(function (x) { return x.run || x.scarce; });
    $('nd-scarce').innerHTML = S.pulse.length
      ? '<span class="section-label">Top 40 left</span>' + S.pulse.map(function (x) {
          return '<span class="nd-sc ' + fam(x.slot) + (x.run ? ' run' : x.scarce ? ' scarce' : '') + (a.open[x.slot] ? ' open' : '') + '" title="' + esc(slotLabel(x.slot) + (x.run ? ': run — ' + x.recent + ' of the last ' + st.teams + ' picks' : x.scarce ? ': thin' : '') + (a.open[x.slot] ? ' · you have it open' : '')) + '">' + slotLabel(x.slot) + ' <b>' + x.left + '</b>' + (x.run ? ' ▲' : '') + '</span>';
        }).join('') + (hot.length ? '' : '')
      : '';
  }

  function renderPicks() {
    var picks = S.merged.picks.slice().reverse().slice(0, 14);
    $('nd-picks-total').textContent = S.merged.picks.length ? S.merged.picks.length + ' made' : '';
    if (!picks.length) { $('nd-picks').innerHTML = '<div class="rf-empty">No picks yet. Tap Draft on the board as players go.</div>'; return; }
    $('nd-picks').innerHTML = picks.map(function (p) {
      var flag = p.source === 'manual' && !p.confirmed ? '<span class="nd-flag" title="Marked here; Yahoo has not confirmed it yet">PENDING</span>'
        : !p.playerId ? '<span class="nd-flag um">REVIEW</span>' : '';
      var ctl = p.source === 'manual'
        ? '<button type="button" class="nd-mini-btn" data-act="mine-toggle" data-id="' + esc(p.playerId) + '" aria-pressed="' + p.mine + '" aria-label="' + (p.mine ? 'Mark ' + esc(p.name) + ' as another team\'s pick' : 'Mark ' + esc(p.name) + ' as my pick') + '">★</button>' +
          '<button type="button" class="nd-mini-btn" data-act="remove" data-id="' + esc(p.playerId) + '" aria-label="Remove pick ' + esc(p.name) + '">✕</button>'
        : '';
      return '<div class="nd-pick' + (p.mine ? ' mine' : '') + '" data-pick="' + p.pick + '"><span class="n">' + p.round + '.' + String(((p.pick - 1) % S.state.settings.teams) + 1).padStart(2, '0') + '</span>' +
        '<span class="nm">' + esc(p.name) + '</span>' + flag + '<span class="tm">' + esc(p.mine ? 'You' : teamNameForKey(p.team_key, p.slot)) + '</span>' + ctl + '</div>';
    }).join('');
  }

  function renderReview() {
    var um = S.merged.unmatched || [];
    var el = $('nd-review');
    if (!um.length) { el.hidden = true; return; }
    el.hidden = false;
    $('nd-review-sum').textContent = um.length + ' Yahoo pick' + (um.length > 1 ? 's' : '') + ' to review';
    $('nd-review-list').innerHTML = um.map(function (u) {
      return '<div class="nd-pick"><span class="n">' + (u.pick ? '#' + u.pick : '—') + '</span><span class="nm">' + esc(u.name) + '</span>' +
        '<button type="button" class="nd-match-btn" data-act="start-match" data-key="' + esc(u.player_key) + '" data-name="' + esc(u.name) + '">Match</button></div>';
    }).join('');
  }

  function renderSync() {
    var pill = $('nd-sync'), conn = $('nd-connect'), banner = $('nd-banner');
    conn.hidden = S.connected;
    if (S.connected && S.leagueKey && S.auction) {
      pill.hidden = false; pill.className = 'nd-sync'; pill.innerHTML = '<span class="dot"></span>Auction · manual mode';
      banner.className = 'nd-banner info';
      banner.innerHTML = '<div><b>Auction drafts aren’t supported yet — manual mode.</b> “' + esc((S.league && S.league.name) || S.leagueKey) + '” is an auction league, so Yahoo picks aren’t synced here. Mark players as they’re won (★ for yours); rankings and roster fit still work.</div>';
      banner.hidden = false;
      return;
    }
    if (S.yahooDown && !S.connected) {
      pill.hidden = false; pill.className = 'nd-sync degraded'; pill.innerHTML = '<span class="dot"></span>Yahoo unavailable · manual';
    }
    if (!S.connected || !S.leagueKey) {
      pill.hidden = !S.connected && !S.yahooDown;
      if (S.connected) { pill.className = 'nd-sync'; pill.innerHTML = '<span class="dot"></span>Yahoo connected · manual board'; }
      if (S.sync !== 'degraded') banner.hidden = true;
      return;
    }
    pill.hidden = false;
    var y = S.state.yahoo, ago = S.lastOk ? L.agoText(Date.now() - S.lastOk) : '';
    if (S.sync === 'degraded') {
      var wait = Math.max(0, Math.round((S.nextPollAt - Date.now()) / 1000));
      pill.className = 'nd-sync degraded';
      pill.innerHTML = '<span class="dot"></span>Yahoo sync paused';
      banner.className = 'nd-banner';
      banner.innerHTML = '<div><b>Can’t reach Yahoo' + (S.lastErr ? ' (' + esc(S.lastErr) + ')' : '') + '.</b> Manual tracking is on: tap Draft as picks happen and they’ll be flagged pending until Yahoo confirms them. ' +
        (S.lastOk ? 'Last synced ' + ago + '. ' : '') + 'Retrying in ' + wait + 's.</div><button type="button" class="btn-secondary" id="nd-retry">Retry now</button>';
      banner.hidden = false;
      $('nd-retry').onclick = function () { poll(true); };
    } else {
      banner.hidden = true;
      var status = y && y.status;
      pill.className = 'nd-sync' + (S.sync === 'live' ? ' live' : '');
      var txt = S.sync === 'connecting' ? 'Connecting to Yahoo…'
        : status === 'postdraft' ? 'Yahoo draft complete'
        : status === 'predraft' ? 'Yahoo · waiting for draft'
        : 'Live from Yahoo';
      pill.innerHTML = '<span class="dot"></span>' + txt + (S.lastOk && S.sync === 'live' ? ' · <span class="ago"><span class="upd">updated </span>' + ago + '</span>' : '');
    }
  }

  function renderMinibar() {
    var st = S.state.settings, roster = myRoster(), ci = clockInfo();
    var a = L.assignSlots(roster.filter(function (p) { return !p.unmatched; }), st);
    var need = {}; (S.warns || []).forEach(function (w) { var m = /no (\w+) yet|Needs a \w+ (\w+)/.exec(w.text); if (m) need[m[1] || m[2]] = 1; });
    $('nd-mb-slots').style.setProperty('--n', a.starters.length);
    $('nd-mb-slots').innerHTML = a.starters.map(function (s) {
      return '<span class="nd-mb-slot ' + fam(s.slot) + (s.player ? ' on' : need[s.slot] ? ' need' : '') + '" title="' + esc(slotLabel(s.slot) + ': ' + (s.player ? s.player.name : 'open')) + '">' + (s.slot === 'UTIL' ? 'U' : slotLabel(s.slot)) + '</span>';
    }).join('');
    var openN = 0; Object.keys(a.open).forEach(function (t) { openN += a.open[t]; });
    var head = S.auction ? 'Auction · manual' : ci.done ? 'Draft complete' : ci.onMe ? 'You’re on the clock' : ci.myNext ? 'You pick in ' + ci.awayN + ' · #' + ci.myNext : 'Your picks are done';
    var w = (S.warns || [])[0];
    var reco = recoCache[0];
    var act = $('nd-mb-act');
    if (ci.onMe && !ci.done && reco && !S.auction) {
      var last = shortName(reco.player.name);
      act.innerHTML = '<button type="button" class="btn-primary nd-mb-draft" data-act="mine" data-id="' + esc(reco.player.id) + '">Draft ' + esc(last) + ' <small>' + esc(reco.slot === 'BENCH' ? 'bench' : (reco.upgrade ? 'upgrade ' : '→ ') + slotLabel(reco.slot)) + '</small></button>';
      act.hidden = false;
      $('nd-mb-txt').hidden = true;
    } else {
      act.hidden = true; act.innerHTML = '';
      $('nd-mb-txt').hidden = false;
      $('nd-mb-txt').innerHTML = '<b>' + esc(head) + '</b>' + (w ? '<span class="w ' + w.level + '">' + esc(w.text) + '</span>' : '<span>' + roster.length + '/' + L.draftRounds(st) + ' drafted · ' + (openN ? openN + ' starter slot' + (openN > 1 ? 's' : '') + ' open' : 'starters set') + '</span>');
    }
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
    var el = $('nd-cheat'), st = S.state.settings, ci = clockInfo();
    if (!S.players.length) { el.innerHTML = ''; return; }
    var made = S.merged.picks.filter(function (p) { return p.mine; }).map(function (p) { return { pick: p.pick, round: p.round, player: p.playerId ? S.byId[p.playerId] : null, name: p.name }; });
    var cs = L.cheatSheet({ available: available(), settings: st, cur: ci.cur, myPicks: myRemainingPicks(ci), made: made,
      roster: myRoster().filter(function (p) { return !p.unmatched; }), perRound: 5, perSlot: 10 });
    var roundsLeft = cs.rounds.filter(function (r) { return !r.done; }).length;
    var html = '<div class="nd-cheat-head"><div><h2>Cheat sheet</h2><p>' + esc(leagueName()) + ' · slot ' + st.mySlot + ' of ' + st.teams + ' · ' + roundsLeft + ' pick' + (roundsLeft === 1 ? '' : 's') + ' left. Targets are the players the board expects near each of your picks; ★ = fills a starter slot you still need.</p></div>' +
      '<button type="button" class="btn-secondary" data-act="print">Print</button></div>';
    html += '<div class="nd-cs-warns">' + (S.warns || []).filter(function (w) { return w.level !== 'info'; }).map(function (w) { return '<div class="nd-warn ' + w.level + '">' + esc(w.text) + '</div>'; }).join('') + '</div>';
    html += '<ol class="nd-cs-rounds">' + cs.rounds.map(function (r) {
      var head = '<span class="r">R' + r.round + '</span><span class="pk">#' + r.pick + '</span>';
      if (r.done) return '<li class="done">' + head + '<span class="got">' + esc(r.player ? r.player.name : r.name || '—') + (r.player ? ' ' + posPills(r.player) : '') + '</span></li>';
      return '<li' + (r.pick === ci.cur && ci.onMe ? ' class="now"' : '') + '>' + head + '<span class="tg">' + r.targets.map(function (x) {
        return '<button type="button" class="nd-cs-p' + (x.need.length ? ' need' : '') + '" data-act="sheet" data-id="' + esc(x.player.id) + '" title="' + esc(x.need.length ? 'Fills open ' + x.need.map(slotLabel).join('/') : 'Depth') + '">' + (x.need.length ? '★ ' : '') + esc(x.player.name) + ' <i>' + esc(L.displayPositions(x.player).join('/') || 'U') + ' · T' + esc(x.player.tier) + '</i></button>';
      }).join('') + '</span></li>';
    }).join('') + '</ol>';
    html += '<h3 class="nd-cs-h3">By slot · best available, tiered</h3><div class="nd-cs-slots">' + cs.bySlot.map(function (b) {
      return '<section class="nd-cs-slot"><h4><span class="sl ' + fam(b.slot) + '">' + slotLabel(b.slot) + '</span>' + (b.open ? '<span class="nd-flag">' + b.open + ' open</span>' : '<span class="ok">set</span>') + '</h4>' +
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
    if (S.view === 'cheat') renderCheat();
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
    var el = $('nd-timer'); if (!el) return;
    var yStatus = S.state.yahoo && S.state.yahoo.status;
    // Yahoo says predraft: quiet even with keepers on the board, unless the
    // user is already marking picks by hand.
    var off = S.auction || ci.done || !timerSeconds() ||
      (liveYahoo() && yStatus === 'predraft' && !S.merged.picks.some(function (p) { return p.source === 'manual'; }));
    if (off) { el.hidden = true; document.title = baseTitle; return; }
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
    el.querySelector('.w').textContent = ci.onMe ? 'YOUR PICK' : clockTeamName(ci);
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
  function renderFirstRun() {
    var el = $('nd-firstrun'); if (!el) return;
    var done = false; try { done = localStorage.getItem(FIRSTRUN_PREF) === '1'; } catch (e) {}
    var show = !done && !S.connected && !S.merged.picks.length && !S.yahooDown;
    el.hidden = !show;
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
  function openSheet(id) {
    S.sheetId = id; S.lastFocus = document.activeElement;
    renderSheet();
    $('nd-sheet').classList.add('open'); $('nd-scrim').classList.add('open');
    setTimeout(function () { var h = $('nd-p-name'); if (h) h.focus(); }, 30);
  }
  function closeSheet() {
    if (!S.sheetId) return;
    S.sheetId = null;
    $('nd-sheet').classList.remove('open');
    if (!$('nd-side').classList.contains('open')) $('nd-scrim').classList.remove('open');
    if (S.lastFocus && S.lastFocus.focus) S.lastFocus.focus();
  }
  function renderSheet() {
    var p = S.byId[S.sheetId]; if (!p) return closeSheet();
    var t = takenMap()[p.id], ci = clockInfo();
    var lo = Math.max(0, Math.floor(Math.min(p.floor || 0, p.hsValue || 0) - 5)), hi = Math.ceil(Math.max(p.ceiling || 0, p.hsValue || 0) + 5);
    var pct = function (v) { return ((v - lo) / Math.max(1, hi - lo) * 100).toFixed(1) + '%'; };
    var reco = recoCache.filter(function (r) { return r.player.id === p.id; })[0];
    $('nd-sheet-body').innerHTML =
      '<div class="nd-p-head"><h2 class="nd-p-name" id="nd-p-name" tabindex="-1">' + esc(p.name) + '</h2>' +
      '<div class="nd-p-meta">' + posPills(p) + '<span>' + esc(p.team || 'FA') + '</span><span>·</span><span>' + esc(L.yahooPosString(p) ? 'Yahoo ' + L.yahooPosString(p) : 'Sleeper ' + (Array.isArray(p.pos) ? p.pos.join('/') : (p.pos || '—'))) + '</span>' + gamesChip(p) + injBadge(p) +
      '<span>· Rank ' + esc(p.rank) + (p.yahooPreRank != null ? ' · Yahoo #' + esc(p.yahooPreRank) : '') + ' · Tier ' + esc(p.tier) + (p.yahooPctRos != null ? ' · ' + esc(p.yahooPctRos) + '% rostered' : '') + '</span></div></div>' +
      '<div class="nd-p-tiles">' +
        '<div class="stat-tile"><div class="stat-val">' + n1(p.hsValue) + '</div><div class="stat-lbl">Best-game value</div></div>' +
        '<div class="stat-tile"><div class="stat-val">' + n1(p.mean) + '</div><div class="stat-lbl">Avg game</div></div>' +
        '<div class="stat-tile"><div class="stat-val">' + (typeof p.games === 'number' ? p.games : '—') + '</div><div class="stat-lbl">Games this wk</div></div>' +
      '</div>' +
      '<div class="nd-range"><div class="section-label">Single-game range (p10 – p90)</div>' +
        '<div class="nd-range-bar" role="img" aria-label="Floor ' + n0(p.floor) + ', ceiling ' + n0(p.ceiling) + ', best-game value ' + n1(p.hsValue) + '">' +
          '<span class="band" style="left:' + pct(p.floor) + ';right:calc(100% - ' + pct(p.ceiling) + ')"></span><span class="mk" style="left:' + pct(p.hsValue) + '"></span></div>' +
        '<div class="nd-range-lbl"><span>floor ' + n0(p.floor) + '</span><span>value ' + n1(p.hsValue) + '</span><span>ceiling ' + n0(p.ceiling) + '</span></div></div>' +
      (reco ? '<p class="nd-p-note"><b>Why now:</b> ' + esc(reco.reason) + '</p>' : '') +
      (p.marketRank != null ? '<p class="nd-p-note">Market (Yahoo-first) #' + esc(p.marketRank) + (p.label ? ' · ' + esc(p.label) + (typeof p.adpDelta === 'number' && p.adpDelta ? ' (' + (p.adpDelta > 0 ? '+' : '') + esc(p.adpDelta) + ' vs our rank)' : '') : '') + (p.contested ? ' · sources disagree' : '') + '. A sanity check only; the board never sorts by it.</p>' : '') +
      (p.source === 'yahoo-only' ? '<p class="nd-p-note">No game-log data: this player is in Yahoo’s pool but not in Sleeper, so the value is a conservative estimate from Yahoo’s projected fantasy points per game.</p>'
        : p.source && p.source !== 'logs' ? '<p class="nd-p-note">' + (p.source === 'rookie' ? 'Rookie: value is projection-only (no NBA game logs yet), so the range is wider than it looks.' : 'Projection-only: not enough recent game logs for a measured spread.') + '</p>' : '') +
      (t ? '<p class="nd-p-note">Drafted #' + t.pick + ' by ' + esc(t.mine ? 'you' : teamNameForKey(t.team_key, t.slot)) + (t.source === 'manual' && !t.confirmed ? ' (pending Yahoo)' : '') + '.</p>' : '');
    var acts = $('nd-sheet-actions');
    if (S.matching) acts.innerHTML = '<button type="button" class="btn-primary" data-act="match" data-id="' + esc(p.id) + '">This is ' + esc(S.matching.name) + '</button>';
    else if (t) acts.innerHTML = t.source === 'manual'
      ? '<button type="button" class="btn-secondary" data-act="remove" data-id="' + esc(p.id) + '">Remove pick</button><button type="button" class="btn-secondary" data-act="mine-toggle" data-id="' + esc(p.id) + '">' + (t.mine ? 'Not mine' : 'Mine') + '</button>'
      : '<button type="button" class="btn-secondary" disabled>Drafted on Yahoo</button>';
    else if (ci.done) acts.innerHTML = '<button type="button" class="btn-secondary" disabled>Draft complete</button>';
    else acts.innerHTML = ci.onMe
      ? '<button type="button" class="btn-secondary" data-act="other" data-id="' + esc(p.id) + '">Other team</button><button type="button" class="btn-primary" data-act="mine" data-id="' + esc(p.id) + '">Draft to my team</button>'
      : '<button type="button" class="btn-secondary" data-act="other" data-id="' + esc(p.id) + '">' + esc(clockTeamName(ci)) + ' took him</button><button type="button" class="btn-primary" data-act="mine" data-id="' + esc(p.id) + '">Mine</button>';
  }

  function openSide() { S.lastFocus = document.activeElement; $('nd-side').classList.add('open'); $('nd-scrim').classList.add('open'); $('nd-mb-btn').setAttribute('aria-expanded', 'true'); setTimeout(function () { $('nd-side-close').focus(); }, 30); }
  function closeSide() {
    if (!$('nd-side').classList.contains('open')) return;
    $('nd-side').classList.remove('open'); $('nd-mb-btn').setAttribute('aria-expanded', 'false');
    if (!S.sheetId) $('nd-scrim').classList.remove('open');
    if (S.lastFocus && S.lastFocus.focus) S.lastFocus.focus();
  }

  /* ------------------------------------------------------ settings */
  var SETTING_SLOTS = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'];
  function openSettings() {
    var f = $('nd-settings-form'), st = S.state.settings, live = S.connected && S.leagueKey;
    var types = SETTING_SLOTS.slice();
    L.slotTypes(st).forEach(function (t) { if (types.indexOf(t) < 0) types.splice(types.length - 1, 0, t); }); // e.g. FC
    $('nd-slot-fields').innerHTML = types.map(function (t) {
      return '<label>' + slotLabel(t) + '<input name="slot_' + t + '" type="number" inputmode="numeric" min="0" max="6" value="' + (st.slots[t] || 0) + '"' + (live ? ' disabled' : '') + '></label>';
    }).join('') +
      '<label>BN<input name="bench" type="number" inputmode="numeric" min="0" max="15" value="' + st.bench + '"' + (live ? ' disabled' : '') + '></label>' +
      '<label>IL<input name="il" type="number" inputmode="numeric" min="0" max="5" value="' + (st.il || 0) + '"' + (live ? ' disabled' : '') + '></label>' +
      '<label>Rounds<input name="rounds" type="number" inputmode="numeric" min="1" max="30" value="' + L.draftRounds(st) + '"' + (live ? ' disabled' : '') + '></label>';
    f.teams.value = st.teams; f.mySlot.value = st.mySlot;
    f.timer.value = timerSeconds();
    f.teams.disabled = !!live;
    f.mySlot.disabled = !!(live && S.myTeamKey && S.merged.picks.some(function (p) { return p.source === 'yahoo' && p.mine; }));
    $('nd-profile-reset').hidden = !!live || S.state.settingsSource !== 'user';
    $('nd-settings-hint').textContent = live
      ? 'Loaded from Yahoo league “' + ((S.league && S.league.name) || S.leagueKey) + '”. Reset clears only picks marked on this device.'
      : 'Manual draft tracking. Defaults come from ' + leagueName() + ' (' + st.teams + ' teams, ' + L.starterCount(st) + ' starters, ' + L.rosterSize(st) + ' roster spots, ' + L.draftRounds(st) + ' draft rounds: Yahoo doesn’t draft IL spots). Check the round count in Yahoo’s draft room; with Yahoo connected its pick order wins.';
    var dlg = $('nd-settings');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function onSettingsClose() {
    var dlg = $('nd-settings');
    if (dlg.returnValue !== 'save') return;
    var f = $('nd-settings-form'), live = S.connected && S.leagueKey;
    if (!live) {
      var slots = {};
      Array.prototype.forEach.call(f.querySelectorAll('input[name^="slot_"]'), function (i) { slots[i.name.slice(5)] = i.value; });
      S.state.settings = L.normalizeSettings({ teams: f.teams.value, mySlot: f.mySlot.value, slots: slots, bench: f.bench.value, il: f.il.value, rounds: f.rounds.value });
      S.state.settingsSource = 'user';
    } else S.state.settings = L.normalizeSettings(Object.assign({}, S.state.settings, { mySlot: f.mySlot.value }));
    try { localStorage.setItem(TIMER_PREF, String(L.normalizeTimerSeconds(f.timer.value))); } catch (e) {}
    S.timer.startedAt = S.timer.startedAt ? Date.now() : 0; S.timer.beeped = false; saveTimerRun();
    save(); recompute(); render(); toast('League settings saved');
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
      else if (act === 'mine') { draftPlayer(id, true); closeSheet(); }
      else if (act === 'other') { draftPlayer(id, false); closeSheet(); }
      else if (act === 'remove') { removeManual(id); closeSheet(); }
      else if (act === 'mine-toggle') { toggleMine(id); }
      else if (act === 'match') { completeMatch(id); closeSheet(); }
      else if (act === 'start-match') { startMatch(b.getAttribute('data-key'), b.getAttribute('data-name')); }
      else if (act === 'pos') { S.pos = b.getAttribute('data-pos'); renderFilters(); renderBoard(); }
      else if (act === 'print') { window.print(); }
    });
    $('nd-undo').onclick = undo;
    $('nd-search').addEventListener('input', function (e) { S.q = e.target.value; renderBoard(); });
    $('nd-tier').onchange = function () { S.tierMax = parseInt(this.value, 10) || 0; renderBoard(); };
    $('nd-hide-out').onclick = function () { S.hideOut = !S.hideOut; this.setAttribute('aria-pressed', String(S.hideOut)); renderBoard(); };
    Array.prototype.forEach.call(document.querySelectorAll('#nd-views button'), function (b) { b.onclick = function () { setView(b.getAttribute('data-view')); window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }); }; });
    $('nd-profile-reset').onclick = function () {
      S.state.settingsSource = null; applyProfile(); save(); recompute(); render();
      $('nd-settings').close('cancel'); toast('Using the ' + leagueName() + ' profile');
    };
    $('nd-show-taken').onclick = function () { S.showTaken = !S.showTaken; this.setAttribute('aria-pressed', String(S.showTaken)); renderBoard(); };
    $('nd-sheet-close').onclick = closeSheet;
    $('nd-scrim').onclick = function () { closeSheet(); closeSide(); };
    $('nd-mb-btn').onclick = openSide;
    $('nd-side-close').onclick = closeSide;
    $('nd-settings-btn').onclick = openSettings;
    $('nd-settings').addEventListener('close', onSettingsClose);
    $('nd-reset').onclick = function () {
      if (!confirm('Clear every pick marked on this device for this league?')) return;
      S.state.manual = []; S.state.overrides = {}; save(); recompute(); render();
      $('nd-settings').close('cancel'); toast('Draft reset');
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
    $('nd-fr-connect').onclick = function (e) {
      if (S.signedOut && window.Clerk && window.Clerk.openSignIn) { e.preventDefault(); window.Clerk.openSignIn({ redirectUrl: '/nba/auth/login' }); }
    };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (S.matching) endMatch(); closeSheet(); closeSide(); }
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') setView(S.view === 'cheat' ? 'board' : 'cheat');
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); undo(); }
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('nd-search').focus(); }
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
      var nav = $('rr-nav'), clock = $('nd-clock'), filt = document.querySelector('.nd-filters-wrap');
      var r = document.documentElement.style;
      r.setProperty('--nav-h', nav.offsetHeight + 'px');
      r.setProperty('--clock-h', clock.offsetHeight + 'px');
      r.setProperty('--filters-h', filt.offsetHeight + 'px');
    };
    setOffsets();
    // Phones: once the page head scrolls away, the clock drops its ticker to save height.
    if (window.IntersectionObserver) new IntersectionObserver(function (en) {
      $('nd-clock').classList.toggle('compact', !en[0].isIntersecting && en[0].boundingClientRect.top < 0);
    }).observe($('nd-sentinel'));
    if (window.ResizeObserver) new ResizeObserver(setOffsets).observe(document.body);
    window.addEventListener('resize', setOffsets);
  }

  /* ----------------------------------------------------------- clerk */
  function initClerk() {
    var key = window.__clerk_publishable_key;
    if (!key || key.indexOf('PLACEHOLDER') >= 0) return;
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
    s.crossOrigin = 'anonymous'; s.async = true;
    s.onload = function () {
      try {
        var clerk = (window.Clerk && typeof window.Clerk.load === 'function') ? window.Clerk : new window.Clerk(key);
        clerk.load({ telemetry: { disabled: true } }).then(function () {
          var btn = $('rr-sign-in');
          if (clerk.user) { clerk.mountUserButton($('user-btn-mount')); btn.hidden = true; }
          else { btn.hidden = false; btn.onclick = function () { clerk.openSignIn({ redirectUrl: '/nba' }); }; }
        });
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
      migrateIds();
    }).catch(function (e) {
      $('nd-list').innerHTML = '<div class="empty-hint" style="margin-top:1rem"><span>Couldn’t load players' + (e.status ? ' (HTTP ' + e.status + ')' : '') + '</span><span class="eh-sub">Your picks are saved on this device.</span><button type="button" class="btn-secondary" id="nd-reload" style="margin-top:.5rem">Try again</button></div>';
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
