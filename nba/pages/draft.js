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
    players: [], byId: {}, asOf: null,
    state: L.emptyState(null),
    // yahoo
    connected: false, leagues: [], leagueKey: null, league: null, teams: [], myTeamKey: null,
    sync: 'off',            // off | connecting | live | degraded
    failures: 0, lastOk: 0, nextPollAt: 0, pollTimer: null, lastErr: '',
    auction: false, signedOut: false, yahooDown: false,
    // pick timer: restarts whenever the pick on the clock changes
    timer: { pick: null, startedAt: 0, beeped: false },
    // ui
    pos: 'ALL', q: '', showTaken: false, sheetId: null, matching: null, lastFocus: null,
    merged: { picks: [], unmatched: [], confirmedManual: [] }, lastYahooCount: -1
  };

  /* ------------------------------------------------------------ utils */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n1(v) { return typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—'; }
  function n0(v) { return typeof v === 'number' && isFinite(v) ? String(Math.round(v)) : '—'; }
  function posPills(p) {
    var e = (p.elig || []).filter(function (x) { return x !== 'UTIL'; });
    if (!e.length) e = ['UTIL'];
    return e.map(function (x) { return '<span class="pp ' + x + '">' + x + '</span>'; }).join('');
  }
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
  }

  function recompute() {
    var y = S.connected && S.leagueKey ? S.state.yahoo : null;
    S.merged = L.mergePicks(y, S.state.manual, { settings: S.state.settings, myTeamKey: S.myTeamKey, overrides: S.state.overrides, playersById: S.byId });
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
      return { cur: yc.cur, total: Math.max(yc.total, L.totalPicks(st)), done: yc.done, round: yc.round || (yc.done ? L.rosterSize(st) : L.roundOf(yc.cur, st.teams)),
        slot: null, teamKey: yc.teamKey, onMe: yc.onMe, myNext: yc.myNext, myAfter: yc.myAfter,
        myNextRound: yc.myNextRound || (yc.myNext ? L.roundOf(yc.myNext, st.teams) : null),
        awayN: yc.awayN, gapNow: yc.gapNow, gapNext: yc.gapNext, fromYahoo: true };
    }
    var cur = currentPick(), total = L.totalPicks(st);
    var done = cur > total;
    var slot = done ? null : L.slotForPick(cur, st.teams);
    var mine = L.nextPickFor(st.mySlot, cur, st);
    var after = mine ? L.nextPickFor(st.mySlot, mine + 1, st) : null;
    return { cur: cur, total: total, done: done, round: done ? L.rosterSize(st) : L.roundOf(cur, st.teams), slot: slot, teamKey: null, onMe: slot === st.mySlot, myNext: mine, myAfter: after,
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
    renderFirstRun(); renderClock(); renderReco(); renderBoard(); renderRoster(); renderPicks(); renderReview(); renderSync(); renderMinibar();
    if (S.sheetId) renderSheet();
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
      sub.textContent = ci.myNext ? 'You pick in ' + away + ' · #' + ci.myNext + (ci.myNextRound ? ' (R' + ci.myNextRound + ')' : '') : 'Your picks are done';
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
    el.innerHTML =
      '<div class="lbl"><span class="section-label">' + esc(label) + '</span><span class="section-label">Value / ceiling</span></div>' +
      '<div class="nd-reco-main">' +
        '<button type="button" class="nd-reco-name" data-act="sheet" data-id="' + esc(p.id) + '" aria-label="Details for ' + esc(p.name) + '">' + esc(p.name) + '<small>' + posPills(p) + ' ' + esc(p.team || '') + ' ' + gamesChip(p) + ' ' + injBadge(p) + '</small></button>' +
        '<div class="nd-reco-val"><b>' + n1(p.hsValue) + '</b><span>ceil ' + n0(p.ceiling) + '</span></div>' +
      '</div>' +
      '<p class="nd-reco-why">' + esc(top.reason) + '</p>' +
      '<div class="nd-reco-alts">' +
        (ci.onMe ? '<button type="button" class="btn-primary" data-act="mine" data-id="' + esc(p.id) + '">Draft ' + esc(p.name.split(' ').slice(-1)[0]) + '</button>' : '') +
        list.slice(1).map(function (r) {
          return '<button type="button" class="nd-alt" data-act="sheet" data-id="' + esc(r.player.id) + '" title="' + esc(r.reason) + '">' + esc(r.player.name) + ' <span class="v">' + n1(r.player.hsValue) + '</span></button>';
        }).join('') +
      '</div>';
    el.hidden = false;
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
      if (!L.matchesPos(p, S.pos) || !L.matchesQuery(p, S.q)) return;
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
            '<span class="nd-rk">' + esc(p.rank) + '</span>' +
            '<span class="nd-who"><span class="nd-name">' + esc(p.name) + '</span>' +
              '<span class="nd-meta">' + posPills(p) + '<span class="tm">' + esc(p.team || 'FA') + '</span>' + gamesChip(p) + injBadge(p) +
              (t ? '<span>· ' + esc(t.mine ? 'You' : teamNameForKey(t.team_key, t.slot)) + ' #' + t.pick + '</span>' : '') + '</span></span>' +
            '<span class="nd-val"><b>' + n1(p.hsValue) + '</b><small>' + n0(p.ceiling) + '/' + n0(p.floor) + '</small></span>' +
          '</button>' +
          '<button type="button" class="nd-draft" data-act="' + (S.matching ? 'match' : t ? (t.source === 'manual' ? 'remove' : 'noop') : 'draft') + '" data-id="' + esc(p.id) + '" aria-label="' + esc(btnLbl) + '"' + (t && t.source !== 'manual' && !S.matching ? ' disabled' : '') + '>' + btnTxt + '</button>' +
        '</div>');
    });
    if (!shown) rows.push('<div class="empty-hint" style="margin-top:1rem"><span>No players match</span><span class="eh-sub">Try another name, or switch the position filter to All.</span></div>');
    list.innerHTML = rows.join('');
    $('nd-count').textContent = availN + ' available · ' + (S.players.length - availN) + ' drafted' + (shown > 400 ? ' · showing top 400' : '');
  }

  function renderRoster() {
    var st = S.state.settings, roster = myRoster();
    var a = L.assignSlots(roster.filter(function (p) { return !p.unmatched; }), st);
    var html = '';
    a.starters.forEach(function (s) {
      html += '<div class="nd-slot"><span class="sl ' + s.slot + '">' + s.slot + '</span>' +
        (s.player ? '<span class="nm">' + esc(s.player.name) + '</span>' + injBadge(s.player) + '<span class="v">' + n1(s.player.hsValue) + '</span>'
                  : '<span class="nm open">Open</span>') + '</div>';
    });
    var bench = a.bench.concat(roster.filter(function (p) { return p.unmatched; }));
    var benchOpen = Math.max(0, L.rosterSize(st) - roster.length - (a.open.G + a.open.F + a.open.UTIL));
    if (st.bench) {
      html += '<div class="nd-bench-hdr">Bench</div>';
      bench.forEach(function (p) {
        html += '<div class="nd-slot"><span class="sl BN">BN</span><span class="nm">' + esc(p.name) + '</span>' +
          (p.unmatched ? '<span class="nd-flag um">REVIEW</span>' : posPills(p) + '<span class="v">' + n1(p.hsValue) + '</span>') + '</div>';
      });
      for (var i = 0; i < Math.min(benchOpen, st.bench - bench.length); i++) html += '<div class="nd-slot"><span class="sl BN">BN</span><span class="nm open">Open</span></div>';
    }
    $('nd-roster').innerHTML = html;
    $('nd-roster-total').textContent = roster.length + '/' + L.rosterSize(st) + ' · starters ' + n1(a.total);
    var ci = clockInfo();
    var k = ci.myNext ? ci.awayN : st.teams - 1;
    var warns = L.balanceWarnings(roster.filter(function (p) { return !p.unmatched; }), st, { available: available(), players: S.players, picksUntilNext: k });
    S.warns = warns;
    $('nd-warns').innerHTML = warns.map(function (w) { return '<div class="nd-warn ' + w.level + '">' + esc(w.text) + '</div>'; }).join('');
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
    $('nd-mb-slots').innerHTML = a.starters.map(function (s) {
      return '<span class="nd-mb-slot ' + s.slot + (s.player ? ' on' : '') + '">' + (s.slot === 'UTIL' ? 'U' : s.slot) + '</span>';
    }).join('');
    var head = S.auction ? 'Auction · manual' : ci.done ? 'Draft complete' : ci.onMe ? 'On the clock' : ci.myNext ? 'You pick in ' + ci.awayN : 'Your picks are done';
    var w = (S.warns || [])[0];
    $('nd-mb-txt').innerHTML = '<b>' + esc(head) + '</b>' + (w ? '<span class="w">' + esc(w.text) + '</span>' : roster.length + '/' + L.rosterSize(st) + ' rostered · bench ' + a.bench.length + '/' + st.bench);
  }

  /* ------------------------------------------------------ pick timer */
  // Seconds per pick: the user's setting, else the Yahoo league's
  // draft_pick_time, else 60. 0 = off.
  function timerSeconds() {
    var v = null; try { v = localStorage.getItem(TIMER_PREF); } catch (e) {}
    if (v != null && v !== '') return L.normalizeTimerSeconds(v);
    if (S.league && S.league.draft_pick_time > 0) return L.normalizeTimerSeconds(S.league.draft_pick_time);
    return L.DEFAULT_PICK_SECONDS;
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
      '<div class="nd-p-meta">' + posPills(p) + '<span>' + esc(p.team || 'FA') + '</span><span>·</span><span>' + esc((p.pos || []).join('/')) + '</span>' + gamesChip(p) + injBadge(p) +
      '<span>· Rank ' + esc(p.rank) + ' · Tier ' + esc(p.tier) + '</span></div></div>' +
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
      (p.source && p.source !== 'logs' ? '<p class="nd-p-note">' + (p.source === 'rookie' ? 'Rookie: value is projection-only (no NBA game logs yet), so the range is wider than it looks.' : 'Projection-only: not enough recent game logs for a measured spread.') + '</p>' : '') +
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
  function openSettings() {
    var f = $('nd-settings-form'), st = S.state.settings, live = S.connected && S.leagueKey;
    f.teams.value = st.teams; f.mySlot.value = st.mySlot; f.G.value = st.slots.G; f.F.value = st.slots.F; f.UTIL.value = st.slots.UTIL; f.bench.value = st.bench;
    f.timer.value = timerSeconds();
    ['teams', 'G', 'F', 'UTIL', 'bench'].forEach(function (k) { f[k].disabled = !!live; });
    f.mySlot.disabled = !!(live && S.myTeamKey && S.merged.picks.some(function (p) { return p.source === 'yahoo' && p.mine; }));
    $('nd-settings-hint').textContent = live
      ? 'Loaded from Yahoo league “' + ((S.league && S.league.name) || S.leagueKey) + '”. Reset clears only picks marked on this device.'
      : 'Manual draft tracking. Defaults match Yahoo High Score: 10 teams, 6 starters (G, G, F, F, F, UTIL), 4 bench.';
    var dlg = $('nd-settings');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function onSettingsClose() {
    var dlg = $('nd-settings');
    if (dlg.returnValue !== 'save') return;
    var f = $('nd-settings-form');
    S.state.settings = L.normalizeSettings({ teams: f.teams.value, mySlot: f.mySlot.value, slots: { G: f.G.value, F: f.F.value, UTIL: f.UTIL.value }, bench: f.bench.value });
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
    if (!key) { S.sync = 'off'; recompute(); render(); return Promise.resolve(); }
    S.sync = 'connecting'; recompute(); render();
    return api('/api/nba/yahoo/league?league_key=' + encodeURIComponent(key)).then(function (d) {
      S.league = d.league || null; S.teams = d.teams || []; S.myTeamKey = d.myTeamKey || null;
      S.state.settings = L.settingsFromYahoo(S.league, S.myTeamKey, S.teams, S.state.settings);
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
    });
    $('nd-undo').onclick = undo;
    $('nd-search').addEventListener('input', function (e) { S.q = e.target.value; renderBoard(); });
    Array.prototype.forEach.call(document.querySelectorAll('.nd-seg button'), function (b) {
      b.onclick = function () {
        S.pos = b.getAttribute('data-pos');
        Array.prototype.forEach.call(document.querySelectorAll('.nd-seg button'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        renderBoard();
      };
    });
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
      var nav = $('rr-nav'), clock = $('nd-clock'), filt = document.querySelector('.nd-filters');
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
    return api('/api/nba/players').then(function (d) {
      var list = (d && d.players) || [];
      list.forEach(function (p) { p.id = String(p.id); });
      list.sort(function (a, b) { return (a.rank || 1e9) - (b.rank || 1e9) || (b.hsValue || 0) - (a.hsValue || 0); });
      S.players = list; S.asOf = d.asOf;
      S.byId = {}; list.forEach(function (p) { S.byId[p.id] = p; });
    }).catch(function (e) {
      $('nd-list').innerHTML = '<div class="empty-hint" style="margin-top:1rem"><span>Couldn’t load players' + (e.status ? ' (HTTP ' + e.status + ')' : '') + '</span><span class="eh-sub">Your picks are saved on this device.</span><button type="button" class="btn-secondary" id="nd-reload" style="margin-top:.5rem">Try again</button></div>';
      $('nd-reload').onclick = function () { loadPlayers().then(function () { recompute(); render(); }); };
    });
  }

  bind();
  handleYahooParam();
  initClerk();
  load(null, L.DEFAULT_SETTINGS);
  recompute(); render();
  Promise.all([loadPlayers(), initYahoo()]).then(function () { recompute(); render(); });
})();
