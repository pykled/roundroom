/* Pocket NBA waivers page controller. Yahoo-first (GET /api/nba/waivers);
   falls back to manual mode (POST /api/nba/waivers/manual) with a roster kept
   in localStorage. Pure helpers live in waivers-logic.js (window.NbaWaivers). */
(function () {
  'use strict';
  var L = window.NbaWaivers;
  var $ = function (id) { return document.getElementById(id); };
  var PAGE = 25;

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };

  var S = {
    prefs: L.prefs(store.get(L.PREFS_KEY)),
    manual: L.loadManual(store.get(L.MANUAL_KEY)),
    leagues: [],
    source: 'manual',          // 'manual' | league_key
    teamKey: null,
    result: null,
    players: null,             // board for manual search / names
    byId: {},
    open: {},
    shown: PAGE,
    loading: false,
    seq: 0
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function savePrefs() { var p = S.prefs; p.source = S.source; store.set(L.PREFS_KEY, JSON.stringify(p)); }
  function saveManual() { store.set(L.MANUAL_KEY, L.saveManual(S.manual)); }

  function api(url, opts) {
    opts = opts || {};
    return fetch(url, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: opts.body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; e.code = j.code; throw e; }
        return j;
      });
    });
  }

  function banner(kind, html) {
    var b = $('nw-banner');
    if (!html) { b.hidden = true; return; }
    b.className = 'nw-banner' + (kind ? ' ' + kind : '');
    b.innerHTML = '<span>' + html + '</span>';
    b.hidden = false;
  }

  /* --------------------------------------------------------------- render */
  // Yahoo positions (PG, SG, SF, PF, C) coloured by guard / forward / center.
  var GROUP = { PG: 'G', SG: 'G', G: 'G', SF: 'F', PF: 'F', F: 'F', FC: 'F', C: 'C' };
  function pills(el) { return (el || []).filter(function (e) { return e !== 'UTIL'; }).map(function (e) { return '<span class="pp ' + (GROUP[e] || '') + '">' + esc(e) + '</span>'; }).join(''); }
  // Board players carry Yahoo positions in yahooPos (pos = Sleeper's); engine rows put them in pos.
  function posOf(x) { return x ? (x.yahooPos && x.yahooPos.length ? x.yahooPos : x.pos && x.pos.length ? x.pos : x.elig) : []; }

  // Weekly add budget + waiver priority + league waiver rules (L1).
  function renderBudget(r) {
    var el = $('nw-budget');
    if (!el) return;
    if (!r || !r.adds) { el.hidden = true; return; }
    el.hidden = false;
    var a = r.adds, pr = r.priority || {}, manual = S.source === 'manual';
    var pips = L.addPips(a).map(function (p) { return '<i class="' + (p.used ? 'u' : '') + '"></i>'; }).join('');
    var left = a.max == null ? 'No weekly add limit' : (a.known || a.source ? a.left + ' of ' + a.max + ' adds left this week' : a.max + ' adds per week (enter how many you\'ve used)');
    var html = '<div class="nw-bud-row"><div class="nw-bud"><div class="lbl">Weekly add budget' + (a.seasonMax == null ? ' · no season cap' : '') + '</div><div class="big">' + esc(left) + '</div>' + (pips ? '<div class="nw-pips" aria-hidden="true">' + pips + '</div>' : '') +
      (manual ? '<label>Adds used <input type="number" id="nw-adds-used" inputmode="numeric" min="0" max="' + (a.max || 99) + '" value="' + (S.manual.addsUsed != null ? S.manual.addsUsed : '') + '" placeholder="0"></label>' : (a.source === 'yahoo' ? '<small>from Yahoo</small>' : '')) + '</div>' +
      '<div class="nw-bud"><div class="lbl">Waiver priority</div><div class="big">' + (pr.position ? '#' + pr.position + ' <small>of ' + pr.teams + '</small>' : 'Unknown') + '</div>' +
      '<p class="nw-bud-note">' + esc(pr.note || '') + '</p>' +
      (manual ? '<label>My priority <input type="number" id="nw-priority" inputmode="numeric" min="1" max="' + (pr.teams || 20) + '" value="' + (S.manual.priority != null ? S.manual.priority : '') + '" placeholder="—"></label>' : (pr.source === 'yahoo' ? '<small>from Yahoo</small>' : '')) + '</div></div>';
    var notes = (r.waiverRules && r.waiverRules.notes) || [];
    if (notes.length) html += '<ul class="nw-rules">' + notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    el.innerHTML = html;
  }
  function gmChips(games, weeks) {
    return '<span class="gms">' + (games || []).map(function (n, i) {
      var tone = L.gamesTone(n);
      var lbl = weeks && weeks.length > 1 ? (i === 0 ? 'now' : i === 1 ? 'nx' : '+' + i) : '';
      return '<span class="gm ' + tone + '" title="' + n + ' games in week ' + (weeks ? weeks[i] : '') + '">' + n + (lbl ? '<small>' + lbl + '</small>' : '') + '</span>';
    }).join('') + '</span>';
  }
  // Mid-week: dropping someone whose team already played this week may forfeit those games.
  function bankedNote(d) { return d && d.bankedGames > 0 ? ' · <span class="inj GTD" title="His team already played ' + d.bankedGames + ' game' + (d.bankedGames > 1 ? 's' : '') + ' this week; dropping him can lose that score">played ' + d.bankedGames + '</span>' : ''; }
  function injTag(s) { var t = L.injuryTag(s); return t ? '<span class="inj ' + t + '" title="' + esc(s) + '">' + t + '</span>' : ''; }

  function renderBest(r) {
    var el = $('nw-best');
    var pairs = (r && r.pairs) || [];
    if (!r) { el.hidden = true; return; }
    el.hidden = false;
    var wk = L.weekLabel(r.weeks[0], r.weekDates);
    if (!pairs.length) {
      el.innerHTML = '<div class="lbl">Best move · ' + esc(wk.title) + (wk.span ? ' · ' + esc(wk.span) : '') + '</div>' +
        '<p class="nw-empty" style="margin:.5rem 0 0">' + (r.targets && r.targets.length ? 'No add/drop improves your lineup this week. Your bench already covers the free-agent pool.' : 'No free agents to rank' + (r.unmatched && r.unmatched.roster && r.unmatched.roster.length ? '; some of your players aren’t in our model (see Not matched).' : '.')) + '</p>';
      return;
    }
    var p = pairs[0];
    var html = '<div class="lbl">Best move · ' + esc(wk.title) + (wk.span ? ' · ' + esc(wk.span) : '') + '</div>' +
      '<div class="nw-move"><div class="nw-move-who">' +
      '<div class="nw-move-add"><span class="verb">' + (p.add.status === 'W' ? 'CLAIM' : 'ADD') + '</span>' + esc(p.add.name) + (p.add.status === 'W' ? ' <span class="badge w">W</span>' : ' <span class="badge fa">FA</span>') + '</div>' +
      '<div class="nw-move-drop">' + (p.drop ? '<span class="verb">DROP</span>' + esc(p.drop.name) + ' · ' + p.drop.games + ' games' + bankedNote(p.drop) : 'Open roster spot, no drop needed') +
      ' · ' + gmChips([p.add.games]) + ' for ' + esc(p.add.team || '') + '</div></div>' +
      '<div class="nw-move-val"><b>' + L.fmtGain(p.netGain) + '</b><span>' + (r.midWeek ? 'pts, games left this week' : 'pts this week') + '</span></div></div>';
    if (pairs.length > 1) {
      html += '<ol class="nw-alts">' + pairs.slice(1).map(function (q) {
        return '<li><span class="nm">' + esc(q.add.name) + '</span>' + gmChips([q.add.games]) + '<span class="arrow">for</span><span class="nm">' + (q.drop ? esc(q.drop.name) : 'open spot') + '</span><span class="g">' + L.fmtGain(q.netGain) + '</span></li>';
      }).join('') + '</ol>';
    }
    el.innerHTML = html;
  }

  function renderCalendar(r) {
    var sec = $('nw-cal');
    if (!r || !r.calendar || !r.calendar.length) { sec.hidden = true; return; }
    sec.hidden = false;
    $('nw-cal-strip').innerHTML = r.calendar.map(function (c) {
      var wk = L.weekLabel(c.week, r.weekDates);
      return '<div class="nw-wk"><div class="nw-wk-h"><b>' + esc(wk.title) + '</b><span>' + esc(wk.span) + '</span></div>' +
        (c.fourGame.length ? '<ol>' + c.fourGame.slice(0, 5).map(function (p) {
          return '<li>' + pills(posOf(p)) + '<span class="nm">' + esc(p.name) + '</span><span class="gm hi">' + p.games + '</span><span class="v">' + L.fmt1(p.value) + '</span></li>';
        }).join('') + '</ol>' : '<p class="none">No free agent plays 4+ games.</p>') + '</div>';
    }).join('');
  }

  function renderList(r) {
    var list = $('nw-list');
    if (!r) return;
    var f = { pos: S.prefs.pos, roleUp: S.prefs.roleUp };
    var all = L.sortTargets(L.filterTargets(r.targets, f), S.prefs.sort);
    var shown = all.slice(0, S.shown);
    $('nw-count').textContent = all.length + ' of ' + r.targets.length + ' free agents · ' + (r.weeks.length > 1 ? 'weeks ' + r.weeks[0] + '–' + r.weeks[r.weeks.length - 1] : 'week ' + r.weeks[0]) +
      (r.midWeek ? ' · week ' + r.midWeek.week + ' counts only games left' : '');
    if (!all.length) {
      list.innerHTML = '<li class="nw-empty" style="padding:1rem .4rem">' + (r.targets.length ? 'No free agents match these filters.' : 'No free agents found.') + '</li>';
      $('nw-more').hidden = true;
      return;
    }
    list.innerHTML = shown.map(function (t, i) {
      var open = !!S.open[t.id];
      var gain = Number(t.netGain) || 0;
      var detail = '';
      if (open) {
        detail = '<div class="nw-detail" id="nw-d-' + esc(t.id) + '">' +
          '<table><tr><th>week</th>' + r.weeks.map(function (w) { return '<th>' + w + '</th>'; }).join('') + '</tr>' +
          '<tr><td>games</td>' + t.gamesByWeek.map(function (n) { return '<td>' + n + '</td>'; }).join('') + '</tr>' +
          '<tr><td>best game</td>' + t.valueByWeek.map(function (v) { return '<td>' + L.fmt1(v) + '</td>'; }).join('') + '</tr></table>' +
          'Avg game ' + L.fmt1(t.mean) + ' · ceiling ' + L.fmt1(t.ceiling) + ' · floor ' + L.fmt1(t.floor) +
          ' · add to an open spot ' + L.fmtGain(t.addGain) +
          (t.role ? '<br>Minutes: last 5 ' + L.fmt1(t.role.recentMin) + ' vs ' + L.fmt1(t.role.seasonMin) + ' before' + (t.role.stale ? ' (last season)' : '') : '') +
          (t.reasons && t.reasons.length ? '<br>' + t.reasons.map(esc).join(' · ') : '') +
          (t.onWaivers ? '<br>On waivers: a claim clears after the waiver period and costs your priority (' + L.fmt1(t.priorityCost) + ' option value), so it nets ' + L.fmtGain(t.claimNet) + '.' : '') +
          (S.source === 'manual' ? '<div class="acts"><button type="button" class="btn-secondary" data-act="taken" data-id="' + esc(t.id) + '">Rostered elsewhere, hide</button><button type="button" class="btn-secondary" data-act="waiver" data-id="' + esc(t.id) + '">' + (t.onWaivers ? 'He\'s a free agent' : 'He\'s on waivers (W)') + '</button><button type="button" class="btn-secondary" data-act="add" data-id="' + esc(t.id) + '">I added him</button></div>' : '') +
          '</div>';
      }
      return '<li class="nw-row"><button type="button" class="nw-row-main" data-id="' + esc(t.id) + '" aria-expanded="' + open + '"' + (open ? ' aria-controls="nw-d-' + esc(t.id) + '"' : '') + '>' +
        '<span class="nw-rk">' + (i + 1) + '</span>' +
        '<span class="nw-who"><span class="nw-name"><span class="n">' + esc(t.name) + '</span>' +
        (t.roleUp ? '<span class="badge up" title="Minutes up over his last 5 games">ROLE ↑</span>' : '') +
        (t.onWaivers ? '<span class="badge w" title="On waivers: needs a claim">W</span>' : '<span class="badge fa" title="Free agent: added immediately">FA</span>') +
        (t.advice === 'save-priority' ? '<span class="badge save" title="Gain is below the value of keeping your waiver priority">SAVE PRIORITY</span>' : t.advice === 'no-adds-left' ? '<span class="badge save">NO ADDS LEFT</span>' : '') + injTag(t.injury) + '</span>' +
        '<span class="nw-meta"><span class="tm">' + esc(t.team || 'FA') + '</span>' + pills(posOf(t)) + gmChips(t.gamesByWeek, r.weeks) + '</span></span>' +
        '<span class="nw-val"><b class="' + (gain > 0 ? 'pos' : 'zero') + '">' + L.fmtGain(gain) + '</b><small>' + (t.onWaivers && t.priorityCost > 0 ? 'priority −' + L.fmt1(t.priorityCost) + ' · ' : '') + (gain <= 0.05 ? 'no gain' : t.drop ? 'drop ' + esc(t.drop.name) + (t.drop.bankedGames > 0 ? ' ⚠' : '') : r.openSpots ? 'open spot' : 'no gain') + '</small></span>' +
        '</button>' + detail + '</li>';
    }).join('');
    $('nw-more').hidden = all.length <= S.shown;
  }

  function renderSide(r) {
    var inj = (r && r.injuryReplacements) || [];
    $('nw-inj').hidden = !inj.length;
    $('nw-inj-body').innerHTML = inj.map(function (x) {
      return '<div class="nw-inj-item"><div class="who">' + esc(x.injured.name) + injTag(x.injured.injury || 'Out') + '</div>' +
        '<div class="sub">about ' + L.fmt1(x.lostValue) + ' pts lost over the horizon</div>' +
        (x.replacements.length ? '<ol class="nw-mini">' + x.replacements.map(function (p) {
          return '<li>' + pills(posOf(p)) + '<span class="nm">' + esc(p.name) + '</span>' + gmChips(p.gamesByWeek.slice(0, 1)) + '<span class="v">' + L.fmtGain(p.netGain) + '</span></li>';
        }).join('') + '</ol>' : '<p class="nw-empty">Your bench covers it.</p>') + '</div>';
    }).join('');

    var drops = (r && r.dropCandidates) || [];
    $('nw-drops').hidden = !drops.length;
    // Keepers (worth more rest-of-season than any free agent) go last and are labelled.
    drops = drops.filter(function (d) { return !d.keeper && !d.ilSlot; }).concat(drops.filter(function (d) { return d.keeper || d.ilSlot; }));
    $('nw-drops-body').innerHTML = drops.slice(0, 4).map(function (d) {
      return '<li>' + pills(posOf(d)) + '<span class="nm">' + esc(d.name) + '</span>' + injTag(d.injury) + (d.keeper ? '<span class="badge w" title="Worth more rest-of-season than any free agent">KEEP</span>' : '') + (d.ilSlot ? '<span class="badge w" title="In an IL slot: dropping him does not open a roster spot">IL</span>' : '') + gmChips(d.gamesByWeek.slice(0, 1)) + '<span class="v">' + (d.dropCost > 0 ? '−' + L.fmt1(d.dropCost) : '0.0') + '</span></li>';
    }).join('');

    var lu = r && r.lineup;
    $('nw-lineup').hidden = !(lu && lu.starters.length);
    if (lu) {
      $('nw-lineup-wk').textContent = 'wk ' + lu.week + ' · ' + L.fmt1(lu.total);
      var order = {};
      (lu.slots || r.slots || ['G', 'F', 'UTIL']).forEach(function (s, i) { if (order[s] == null) order[s] = i; });
      $('nw-lineup-body').innerHTML = lu.starters.slice().sort(function (a, b) { return order[a.slot] - order[b.slot] || b.value - a.value; }).map(function (s) {
        return '<li><span class="slot">' + s.slot + '</span><span class="nm">' + esc(s.name) + '</span>' + injTag(s.injury) + '<span class="v">' + L.fmt1(s.value) + '</span></li>';
      }).join('');
    }

    var un = r && r.unmatched;
    var names = un ? un.roster.concat(un.freeAgents).map(function (u) { return u.name; }).filter(Boolean) : [];
    $('nw-unmatched').hidden = !names.length;
    $('nw-unmatched-body').textContent = names.length ? names.length + ' Yahoo player' + (names.length > 1 ? 's' : '') + ' not in our model, left out of the ranking: ' + names.slice(0, 8).join(', ') + (names.length > 8 ? '…' : '') : '';
  }

  function renderManual() {
    var sec = $('nw-manual');
    sec.hidden = S.source !== 'manual';
    if (sec.hidden) return;
    $('nw-roster-count').textContent = S.manual.roster.length + ' / ' + L.MAX_ROSTER + (S.manual.exclude.length ? ' · ' + S.manual.exclude.length + ' hidden' : '');
    $('nw-chips').innerHTML = S.manual.roster.map(function (id) {
      var p = S.byId[id];
      return '<span class="nw-chip">' + (p ? pills(posOf(p)) : '') + esc(p ? p.name : id) + '<button type="button" data-rm="' + esc(id) + '" aria-label="Remove ' + esc(p ? p.name : id) + '">✕</button></span>';
    }).join('') || '<span class="nw-empty">Add the players on your team. Your roster stays on this device.</span>';
    var hasDraft = !!L.importFromDraft(store.get(L.DRAFT_MANUAL_KEY));
    $('nw-import').hidden = !hasDraft;
  }

  function renderControls() {
    [].forEach.call($('nw-horizon').querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.h) === S.prefs.horizon)); });
    [].forEach.call($('nw-pos').querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.pos === S.prefs.pos)); });
    $('nw-roleup').setAttribute('aria-pressed', String(S.prefs.roleUp));
    $('nw-sort').value = S.prefs.sort;
  }

  function renderAll() {
    renderControls();
    renderManual();
    var r = S.result;
    renderBudget(r);
    renderBest(r);
    renderCalendar(r);
    renderList(r);
    renderSide(r);
    if (!r && !S.loading) { $('nw-list').innerHTML = ''; $('nw-count').textContent = ''; }
  }

  function skeleton() {
    $('nw-list').innerHTML = new Array(8).join('<li class="nw-skel" aria-hidden="true"></li>');
    $('nw-count').textContent = 'Ranking free agents…';
  }

  /* ----------------------------------------------------------------- data */
  function load() {
    var my = ++S.seq;
    S.loading = true;
    skeleton();
    var done = function (r) {
      if (my !== S.seq) return;
      S.loading = false; S.result = r; S.shown = PAGE;
      if (r && r.mode === 'yahoo') {
        banner(r.rules && r.rules.uses_faab ? 'info' : null, r.rules && r.rules.uses_faab ? '<b>FAB league.</b> Claims on waiver players (W) are blind bids; free agents can be added straight away.' : '');
      }
      renderAll();
    };
    var fail = function (e) {
      if (my !== S.seq) return;
      S.loading = false; S.result = null;
      if (e.code === 'yahoo_not_connected' || e.code === 'yahoo_reauth') {
        banner('error', '<b>Yahoo needs reconnecting.</b> <a href="/nba/auth/login">Connect Yahoo</a> or switch to the manual roster.');
      } else {
        banner('error', '<b>Could not rank free agents.</b> ' + esc(e.message) + ' <button type="button" class="btn-secondary" id="nw-retry">Retry</button>');
        var b = $('nw-retry'); if (b) b.onclick = load;
      }
      renderAll();
    };
    if (S.source === 'manual') {
      banner('info', '<b>Manual mode.</b> Ranking against every player not on your roster. Hide players other teams own to tighten the list' + ($('nw-connect').hidden ? '' : ', or connect Yahoo for your league’s real free agents') + '.');
      if (!S.manual.roster.length) {
        S.loading = false; S.result = null; renderAll();
        $('nw-count').textContent = '';
        $('nw-list').innerHTML = '<li class="nw-empty" style="padding:1rem .4rem">Add your roster above to see who to pick up.</li>';
        return Promise.resolve();
      }
      return api('/api/nba/waivers/manual', { method: 'POST', body: L.manualRequest(S.manual, S.prefs.horizon) }).then(done, fail);
    }
    var lk = S.source;
    var tkP = S.teamKey ? Promise.resolve(S.teamKey) : api('/api/nba/yahoo/league?league_key=' + encodeURIComponent(lk)).then(function (j) {
      if (!j.myTeamKey) throw new Error('No team of yours in this league.');
      S.teamKey = j.myTeamKey; return S.teamKey;
    });
    return tkP.then(function (tk) {
      return api('/api/nba/waivers?league_key=' + encodeURIComponent(lk) + '&team_key=' + encodeURIComponent(tk) + '&weeks=' + S.prefs.horizon);
    }).then(done, fail);
  }

  function ensurePlayers() {
    if (S.players) return Promise.resolve(S.players);
    return api('/api/nba/players').then(function (j) {
      S.players = (j.players || []).slice().sort(function (a, b) { return (a.rank || 1e9) - (b.rank || 1e9); });
      S.byId = {}; S.players.forEach(function (p) { S.byId[String(p.id)] = p; });
      return S.players;
    }).catch(function () { S.players = []; return S.players; });
  }

  function populateSources() {
    var sel = $('nw-source');
    if (!S.leagues.length) { sel.hidden = true; return; }
    sel.innerHTML = S.leagues.map(function (l) { return '<option value="' + esc(l.league_key) + '">' + esc(l.name || l.league_key) + '</option>'; }).join('') + '<option value="manual">Manual roster</option>';
    sel.value = S.source;
    sel.hidden = false;
  }

  function boot() {
    renderControls();
    var statusP = api('/api/nba/yahoo/status').catch(function () { return { connected: false }; });
    return Promise.all([statusP, ensurePlayers()]).then(function (res) {
      var st = res[0];
      S.leagues = st.connected && Array.isArray(st.leagues) ? st.leagues : [];
      $('nw-connect').hidden = !!st.connected;
      var pref = S.prefs.source;
      if (S.leagues.length && pref !== 'manual') {
        S.source = S.leagues.some(function (l) { return l.league_key === pref; }) ? pref : S.leagues[0].league_key;
      } else S.source = 'manual';
      populateSources();
      return load();
    });
  }

  /* --------------------------------------------------------------- events */
  function bind() {
    $('nw-horizon').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-h]'); if (!b) return;
      S.prefs.horizon = L.normalizeHorizon(b.dataset.h); savePrefs(); load();
    });
    $('nw-pos').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-pos]'); if (!b) return;
      S.prefs.pos = b.dataset.pos; S.shown = PAGE; savePrefs(); renderControls(); renderList(S.result);
    });
    $('nw-roleup').addEventListener('click', function () { S.prefs.roleUp = !S.prefs.roleUp; S.shown = PAGE; savePrefs(); renderControls(); renderList(S.result); });
    $('nw-sort').addEventListener('change', function (e) { S.prefs.sort = e.target.value; savePrefs(); renderList(S.result); });
    $('nw-more').addEventListener('click', function () { S.shown += PAGE; renderList(S.result); });
    $('nw-source').addEventListener('change', function (e) { S.source = e.target.value; S.teamKey = null; S.result = null; banner(null, ''); savePrefs(); renderAll(); load(); });
    $('nw-list').addEventListener('click', function (e) {
      var act = e.target.closest('button[data-act]');
      if (act) {
        var id = act.dataset.id;
        S.manual = act.dataset.act === 'add' ? L.addToRoster(S.manual, id) : act.dataset.act === 'waiver' ? L.toggleWaiver(S.manual, id) : L.toggleExclude(S.manual, id);
        delete S.open[id]; saveManual(); renderManual(); load();
        return;
      }
      var row = e.target.closest('button.nw-row-main'); if (!row) return;
      var rid = row.dataset.id;
      if (S.open[rid]) delete S.open[rid]; else S.open[rid] = 1;
      renderList(S.result);
    });
    var budget = $('nw-budget');
    if (budget) budget.addEventListener('change', function (e) {
      var id = e.target.id;
      if (id !== 'nw-adds-used' && id !== 'nw-priority') return;
      S.manual = L.setNumber(S.manual, id === 'nw-priority' ? 'priority' : 'addsUsed', e.target.value);
      saveManual(); load();
    });
    $('nw-chips').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-rm]'); if (!b) return;
      S.manual = L.removeFromRoster(S.manual, b.dataset.rm); saveManual(); renderManual(); load();
    });
    var search = $('nw-search'), results = $('nw-results');
    var hideResults = function () { results.hidden = true; results.innerHTML = ''; };
    search.addEventListener('input', function () {
      var hits = L.searchPlayers(S.players || [], search.value, S.manual.roster, 8);
      if (!hits.length) return hideResults();
      results.innerHTML = hits.map(function (p) { return '<li><button type="button" role="option" data-pick="' + esc(p.id) + '">' + pills(posOf(p)) + esc(p.name) + '<span class="tm">' + esc(p.team || 'FA') + '</span></button></li>'; }).join('');
      results.hidden = false;
    });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideResults();
      if (e.key === 'Enter') { var f = results.querySelector('button'); if (f) { e.preventDefault(); f.click(); } }
    });
    results.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-pick]'); if (!b) return;
      S.manual = L.addToRoster(S.manual, b.dataset.pick); saveManual();
      search.value = ''; hideResults(); renderManual(); load(); search.focus();
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('.nw-add')) hideResults(); });
    $('nw-import').addEventListener('click', function () {
      var st = L.importFromDraft(store.get(L.DRAFT_MANUAL_KEY));
      if (!st) return;
      S.manual = st; saveManual(); renderManual(); load();
    });
    window.addEventListener('storage', function (e) {
      if (e.key === L.MANUAL_KEY && S.source === 'manual') { S.manual = L.loadManual(e.newValue); renderManual(); load(); }
    });
  }

  /* ---------------------------------------------------------------- clerk */
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
          if (clerk.user) {
            clerk.mountUserButton($('user-btn-mount')); btn.hidden = true;
            if (!S.leagues.length) boot(); // session was not ready for the first status call
          } else { btn.hidden = false; btn.onclick = function () { clerk.openSignIn({ redirectUrl: '/nba/waivers' }); }; }
        });
      } catch (e) { console.warn('Clerk init failed', e); }
    };
    document.head.appendChild(s);
  }

  bind();
  boot();
  initClerk();
}());
