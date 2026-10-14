/* Pocket NBA — weekly lineup picker controller (stream D).
   Yahoo-first: when /api/nba/yahoo/status says connected, the roster (and the
   week's opponent) come from Yahoo via GET /api/nba/lineup. Otherwise manual
   mode: pick/paste a roster, stored in localStorage, scored by
   POST /api/nba/lineup/manual. Pure helpers live in lineup-logic.js. */
(function () {
  'use strict';
  var L = window.NbaLineup;
  var $ = function (id) { return document.getElementById(id); };
  var LEAGUE_PREF = 'pocket-nba-league';
  var MODE_PREF = 'pocket-nba-lineup-mode';
  var DEFAULT_LEAGUE = '242808';
  // League profile (slots, matchup weeks, scoring) from /api/nba/league-profile.
  function maxWeek() { return S.profile && S.profile.weeks && S.profile.weeks.length ? S.profile.weeks.length : 25; }
  function leagueId() { var m = /\.l\.(\d+)$/.exec(S.leagueKey || ''); return S.mode === 'yahoo' && m ? m[1] : DEFAULT_LEAGUE; }
  function slotListOf() { return (S.result && S.result.spots && S.result.spots.slots) || (S.profile && profileSlots(S.profile)) || ['G', 'G', 'FC', 'FC', 'FC', 'UTIL']; }
  function profileSlots(p) {
    var order = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'FC', 'UTIL'], out = [];
    order.forEach(function (k) { for (var i = 0; i < ((p.slots || {})[k] || 0); i++) out.push(k); });
    return out;
  }

  var S = {
    players: [], byId: {}, currentWeek: 1, week: null, day: null, profile: null,
    mode: 'manual', connected: false, leagues: [], leagueKey: null, myTeamKey: null,
    manual: L.emptyManual(), yahooBanked: {},
    result: null, error: null, loading: false, seq: 0,
    q: '', oq: '', showPaste: false, unknown: []
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n1(v) { return typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—'; }
  function api(url, opts) {
    return fetch(url, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; e.code = j.code; throw e; }
        return j;
      });
    });
  }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function saveManual() { S.manual.updatedAt = Date.now(); store(L.storageKey('manual'), L.serialize(S.manual)); }
  function yahooScope() { return 'yahoo:' + S.leagueKey; }
  function saveYahooBanked() { store(L.storageKey(yahooScope()), JSON.stringify(S.yahooBanked)); }

  /* ------------------------------------------------------------ data */
  function loadPlayers(week) {
    return api('/api/nba/players' + (week ? '?week=' + week : '')).then(function (d) {
      S.players = (d.players || []).slice().sort(function (a, b) { return (a.rank || 9999) - (b.rank || 9999); });
      S.byId = {};
      S.players.forEach(function (p) { S.byId[String(p.id)] = p; });
      if (d.currentWeek) S.currentWeek = Math.max(1, Math.min(maxWeek(), d.currentWeek));
    });
  }
  function loadProfile() {
    return api('/api/nba/league-profile?league_id=' + encodeURIComponent(leagueId())).then(function (p) { S.profile = p; })
      .catch(function () { S.profile = null; /* unknown league → High Score defaults (server side) */ });
  }

  function refresh() {
    var seq = ++S.seq;
    S.loading = true; S.error = null;
    renderResult();
    var p;
    if (S.mode === 'yahoo' && S.leagueKey && S.myTeamKey) {
      var q = '/api/nba/lineup?league_key=' + encodeURIComponent(S.leagueKey) + '&team_key=' + encodeURIComponent(S.myTeamKey) + '&week=' + S.week;
      if (S.day != null) q += '&day=' + S.day;
      var bq = L.bankedQuery(L.bankedFor(S.yahooBanked, S.week));
      if (bq) q += '&banked=' + encodeURIComponent(bq);
      p = api(q);
    } else {
      if (!S.manual.roster.length) { S.loading = false; S.result = null; renderAll(); return Promise.resolve(); }
      p = api('/api/nba/lineup/manual', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(L.manualBody(S.manual, S.week, S.day, DEFAULT_LEAGUE)) });
    }
    return p.then(function (r) {
      if (seq !== S.seq) return;
      S.result = r; S.loading = false;
      if (S.day == null) S.day = r.day;
      renderAll();
    }).catch(function (e) {
      if (seq !== S.seq) return;
      S.loading = false; S.error = e;
      if (S.mode === 'yahoo' && (e.code === 'yahoo_not_connected' || e.code === 'yahoo_reauth' || e.status === 401)) {
        S.connected = false; S.mode = 'manual';
        banner('Yahoo needs reconnecting, so this is manual mode. <a href="/nba/auth/login">Reconnect Yahoo</a>.', 'error');
        return refresh();
      }
      renderAll();
    });
  }
  var debounceT = null;
  function refreshSoon() { clearTimeout(debounceT); debounceT = setTimeout(refresh, 250); }

  function initYahoo() {
    return api('/api/nba/yahoo/status').then(function (st) {
      if (!st || !st.connected) { if (st && st.reauth) banner('Your Yahoo login expired. <a href="/nba/auth/login">Reconnect</a> to load your roster.', 'info'); return; }
      S.connected = true;
      S.leagues = st.leagues || [];
      if (!S.leagues.length) return;
      var pref = read(LEAGUE_PREF);
      S.leagueKey = S.leagues.some(function (l) { return l.league_key === pref; }) ? pref : S.leagues[0].league_key;
      return loadLeague();
    }).catch(function () { /* signed out / any error → manual */ });
  }
  function loadLeague() {
    return api('/api/nba/yahoo/league?league_key=' + encodeURIComponent(S.leagueKey)).then(function (d) {
      S.myTeamKey = d.myTeamKey || null;
      var cw = d.league && Number(d.league.current_week);
      if (cw >= 1 && cw <= maxWeek() && S.week == null) S.week = cw;
      try { S.yahooBanked = JSON.parse(read(L.storageKey(yahooScope())) || '{}') || {}; } catch (e) { S.yahooBanked = {}; }
      if (S.myTeamKey && read(MODE_PREF) !== 'manual') S.mode = 'yahoo';
    }).catch(function (e) {
      banner('Couldn’t load your Yahoo league (' + esc(e.message) + '). Using manual mode.', 'error');
    });
  }

  /* ------------------------------------------------------------ render */
  function banner(html, cls) {
    var el = document.createElement('div');
    el.className = 'ln-banner ' + (cls || '');
    el.innerHTML = '<div>' + html + '</div>';
    $('ln-banners').appendChild(el);
  }

  function renderHead() {
    var sel = $('ln-week');
    var weeks = (S.profile && S.profile.weeks) || [];
    var key = weeks.length + ':' + (S.profile && S.profile.leagueId);
    if (sel.dataset.key !== key) {
      var h = '';
      for (var w = 1; w <= maxWeek(); w++) {
        var wk = weeks[w - 1];
        h += '<option value="' + w + '">Wk ' + w + (wk ? ' · ' + fmtDate(wk.start) + (wk.days !== 7 ? ' · ' + wk.days + 'd' : '') + (wk.playoffs ? ' · PO' : '') : '') + '</option>';
      }
      sel.innerHTML = h;
      sel.dataset.key = key;
    }
    sel.value = String(S.week);
    $('ln-prev').disabled = S.week <= 1;
    $('ln-next').disabled = S.week >= maxWeek();
    var r = S.result;
    var win = r && r.window;
    $('ln-title').textContent = 'Week ' + S.week + ' lineup' + (win && win.days > 7 ? ' · ' + win.days + '-day matchup' : '');
    var sub = S.mode === 'yahoo' ? 'From your Yahoo roster' : 'Manual roster';
    if (r && r.dates) sub += ' · ' + fmtDate(r.dates[0]) + ' – ' + fmtDate(r.dates[1]);
    var sl = slotListOf();
    sub += ' · ' + L.countWord(sl.length) + ' starters (' + L.slotListText(sl) + '), each scores his single best game of the matchup week';
    $('ln-sub').textContent = sub;
    var ey = $('ln-eyebrow');
    if (ey) ey.textContent = (r && r.profile && r.profile.name ? r.profile.name : S.profile ? S.profile.name : 'Yahoo High Score') + ' · Lineup';
    $('ln-mode').hidden = !S.connected || !S.myTeamKey;
    Array.prototype.forEach.call($('ln-mode').querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)); });
    var lg = $('ln-league');
    lg.hidden = !(S.connected && S.mode === 'yahoo' && S.leagues.length > 1);
    if (!lg.hidden) {
      lg.innerHTML = S.leagues.map(function (l) { return '<option value="' + esc(l.league_key) + '">' + esc(l.name || l.league_key) + '</option>'; }).join('');
      lg.value = S.leagueKey;
    }
    $('ln-connect').hidden = S.connected;
  }
  function fmtDate(iso) {
    var t = Date.parse(iso + 'T12:00:00Z');
    return isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
  }

  function renderDays() {
    var r = S.result;
    $('ln-days').hidden = $('ln-days-lbl').hidden = !r;
    if (!r) return;
    var len = r.weekLength || 7;
    var chips = L.dayChips(r && r.dates, len);
    var el = $('ln-days');
    el.style.setProperty('--n', String(len + 1));
    var day = S.day == null ? 0 : S.day;
    var h = '';
    chips.forEach(function (c) {
      var cls = c.day < day ? ' done' : c.day === day ? ' today' : '';
      h += '<button type="button" class="ln-day' + cls + '" data-day="' + c.day + '" aria-pressed="' + (c.day === day) + '">' + esc(c.label) + '<b>' + (c.date == null ? c.day + 1 : c.date) + '</b></button>';
    });
    var after = day >= len;
    h += '<button type="button" class="ln-day' + (after ? ' today' : '') + '" data-day="' + len + '" aria-pressed="' + after + '">Final<b>✓</b></button>';
    el.innerHTML = h;
    // Long (14-day) weeks scroll sideways on phones: keep today in view.
    var t = el.querySelector('.today');
    if (t && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, t.offsetLeft - el.offsetLeft - el.clientWidth / 2 + t.offsetWidth / 2);
    $('ln-days-range').textContent = day === 0 ? 'Nothing played yet' : after ? 'Week over' : (day + ' day' + (day > 1 ? 's' : '') + ' played');
  }

  function playerOf(id) { return S.byId[String(id)] || null; }
  function injBadge(inj) {
    if (!inj) return '';
    var out = /out|ir|sus/i.test(inj);
    return '<span class="inj' + (out ? ' out' : '') + '">' + esc(String(inj).slice(0, 4).toUpperCase()) + '</span>';
  }
  // Position pills: Yahoo positions (PG, SG, SF, PF, C) when we have them.
  function posPills(pos) {
    return (pos || []).filter(function (e) { return e !== 'UTIL'; }).map(function (e) { return '<span class="pp ' + L.slotGroup(e) + '">' + esc(e) + '</span>'; }).join('');
  }
  function posOf(p) { return p ? (p.yahooPos || p.pos || p.elig) : []; }

  function renderEditor() {
    var ed = $('ln-editor');
    ed.hidden = S.mode !== 'manual';
    if (ed.hidden) return;
    var ros = S.manual.roster;
    var h = '<h3>Your roster <small>' + ros.length + '/' + L.MAX_ROSTER + '</small></h3>';
    var choices = L.slotChoices(slotListOf(), S.profile && S.profile.slots ? S.profile.slots.IL : null);
    h += '<p class="hint">' + (S.connected ? 'Manual mode. Switch to Yahoo above to load your real roster.' : 'Not connected to Yahoo: add your players, then mark who is starting now (' + esc(choices.slice(1).filter(function (c) { return c !== 'IL'; }).join(' / ')) + ') and who is on IL, so swaps, forfeits and IL spots are checked.') + '</p>';
    h += '<div class="ln-search"><input id="ln-q" type="search" autocomplete="off" placeholder="Add a player: name or team" value="' + esc(S.q) + '" aria-label="Add a player">' + resultsHtml(S.q, 'add') + '</div>';
    if (ros.length) {
      h += '<div class="ln-rlist">' + ros.map(function (r, i) {
        var p = playerOf(r.id);
        var opts = choices.indexOf(r.slot) >= 0 ? choices : choices.concat([r.slot]);
        return '<div class="ln-rrow"><div class="nm">' + esc(p ? p.name : r.id) + '<small>' + esc(p ? p.team || '' : '?') + '</small> ' + (p ? posPills(posOf(p)) + injBadge(p.injury) : '') + '</div>' +
          '<select data-slot="' + i + '" aria-label="Current slot for ' + esc(p ? p.name : r.id) + '">' + opts.map(function (s) { return '<option value="' + s + '"' + (r.slot === s ? ' selected' : '') + '>' + (s === 'BN' ? 'Bench' : s) + '</option>'; }).join('') + '</select>' +
          '<button type="button" class="ln-x" data-rm="' + i + '" aria-label="Remove ' + esc(p ? p.name : r.id) + '">✕</button></div>';
      }).join('') + '</div>';
    }
    h += '<div class="ln-tools"><button type="button" class="btn-secondary" id="ln-paste-btn">' + (S.showPaste ? 'Hide paste' : 'Paste roster') + '</button>' + (ros.length ? '<button type="button" class="btn-secondary" id="ln-clear">Clear</button>' : '') + '</div>';
    if (S.showPaste) {
      h += '<div class="ln-paste" style="margin-top:.6rem"><textarea id="ln-paste" aria-label="Paste roster, one player per line" placeholder="One player per line (or commas). E.g.&#10;Nikola Jokic&#10;Luka Doncic&#10;Cooper Flagg"></textarea><div class="ln-tools"><button type="button" class="btn-primary" id="ln-paste-go">Add players</button></div></div>';
    }
    if (S.unknown.length) h += '<div class="ln-unknown">Not found: ' + S.unknown.map(esc).join(', ') + '</div>';
    var opp = S.manual.opponent;
    h += '<details class="ln-more"' + (opp.length ? ' open' : '') + '><summary>Opponent roster (optional) · win probability</summary>' +
      '<div class="ln-search" style="margin-top:.4rem"><input id="ln-oq" type="search" autocomplete="off" placeholder="Add an opponent player" value="' + esc(S.oq) + '" aria-label="Add an opponent player">' + resultsHtml(S.oq, 'opp') + '</div>' +
      '<div class="ln-opp-chips">' + opp.map(function (id, i) { var p = playerOf(id); return '<button type="button" data-orm="' + i + '" aria-label="Remove ' + esc(p ? p.name : id) + '">' + esc(p ? p.name : id) + ' ✕</button>'; }).join('') + '</div></details>';
    ed.innerHTML = h;
  }
  function resultsHtml(q, kind) {
    if (!q || q.length < 2) return '';
    var taken = {};
    (kind === 'add' ? S.manual.roster.map(function (r) { return r.id; }) : S.manual.opponent).forEach(function (id) { taken[id] = 1; });
    var res = L.searchPlayers(q, S.players, 7).filter(function (p) { return !taken[p.id]; });
    if (!res.length) return '<div class="ln-results"><button type="button" disabled>No players match</button></div>';
    return '<div class="ln-results" role="listbox">' + res.map(function (p) {
      return '<button type="button" data-' + kind + '="' + esc(p.id) + '">' + posPills(posOf(p)) + ' ' + esc(p.name) + injBadge(p.injury) + '<span class="tm">' + esc(p.team || 'FA') + ' · ' + n1(p.hsValue) + '</span></button>';
    }).join('') + '</div>';
  }

  function renderResult() {
    var el = $('ln-result');
    if (S.loading && !S.result) { el.innerHTML = '<div class="ln-loading">Working out your best lineup…</div>'; return; }
    if (S.error && !S.result) { el.innerHTML = '<div class="ln-banner error"><div><b>Couldn’t build the lineup.</b> ' + esc(S.error.message) + '</div></div>'; return; }
    var r = S.result;
    if (!r) {
      var sl0 = slotListOf();
      el.innerHTML = S.mode === 'manual' ? '<div class="ln-banner info"><div><b>Add your roster above.</b> Up to 20 players: the picker chooses the ' + L.countWord(sl0.length) + ' starters (' + esc(L.slotListText(sl0)) + ') with the highest expected best game.</div></div>' : '';
      return;
    }
    var h = '';
    if (S.error) h += '<div class="ln-banner error"><div>' + esc(S.error.message) + ' Showing the last result.</div></div>';
    if (r.unmatched && r.unmatched.length) h += '<div class="ln-banner"><div><b>' + r.unmatched.length + ' player' + (r.unmatched.length > 1 ? 's' : '') + ' not matched</b> to our model, so not projected (starters stay in their slot, bench players are left out): ' + r.unmatched.map(function (u) { return esc(u.name || u.id); }).join(', ') + '.</div></div>';
    if (r.matchupError) h += '<div class="ln-banner info"><div>' + esc(r.matchupError) + '; win probability skipped.</div></div>';

    // summary
    var g = L.bandGeometry(r.total);
    h += '<div class="ln-top"><div class="ln-card"><div class="ln-lbl">Expected week total · optimal ' + L.countWord(r.spots ? r.spots.starters : r.slots.length) + '</div><div class="ln-total"><span class="big">' + n1(r.total.expected) + '</span>' +
      (r.gain != null ? '<span class="gain' + (r.gain > 0.05 ? '' : ' zero') + '">' + (r.gain > 0.05 ? L.sign(r.gain) + ' vs current' : 'current lineup is optimal') + '</span>' : '') + '</div>' +
      (g ? '<div class="ln-band" aria-hidden="true"><div class="track"></div><div class="rng" style="left:' + g.left + '%;width:' + g.width + '%"></div><div class="mk" style="left:' + g.mark + '%"></div></div><div class="ln-band-lbl"><span>p10 ' + n1(r.total.p10) + '</span><span>p90 ' + n1(r.total.p90) + '</span></div>' : '') + '</div>';
    if (r.matchup) {
      var wp = r.matchup.winProb;
      h += '<div class="ln-card"><div class="ln-lbl">Matchup win probability</div><div class="ln-vs"><span class="pct">' + L.winText(wp) + '</span><span class="who">vs ' + esc(r.matchup.opponentName || 'opponent') + '</span></div>' +
        '<div class="ln-wp" role="img" aria-label="' + L.winText(wp) + ' chance to win"><div class="me" style="width:' + (wp * 100).toFixed(1) + '%"></div><div class="opp" style="width:' + ((1 - wp) * 100).toFixed(1) + '%"></div></div>' +
        '<div class="ln-wp-lbl"><span>You ' + n1(r.total.expected) + '</span><span>Them ' + n1(r.matchup.opponentExpected) + '</span></div></div>';
    } else {
      h += '<div class="ln-card"><div class="ln-lbl">Matchup win probability</div><div class="ln-empty-mu">' + (S.mode === 'yahoo' ? 'No opponent found for this week.' : 'Add your opponent’s roster below the editor to see your odds.') + '</div></div>';
    }
    h += '</div>';

    // changes
    if (r.current) {
      if (r.diff.length || r.moved.length) {
        h += '<section class="ln-diff" aria-label="Lineup changes"><h3>' + r.diff.length + ' change' + (r.diff.length === 1 ? '' : 's') + ' to make <span>' + L.sign(r.gain) + '</span></h3>';
        r.diff.forEach(function (d) {
          h += '<div class="ln-swap"><div class="txt">' + (d.out ? '<span class="out">' + esc(d.out.name) + '</span><span class="arrow">→</span>' : 'Start ') + (d.in ? '<span class="in">' + esc(d.in.name) + '</span> <span class="pp ' + (d.slot === 'UTIL' ? '' : d.slot) + '">' + d.slot + '</span>' : ' (leave empty)') + '</div><div class="g' + (d.gain < 0 ? ' neg' : '') + '" aria-label="' + esc(L.diffText(d)) + '">' + L.sign(d.gain) + '</div>' +
            (d.warning ? '<div class="ln-warn">' + esc(d.warning) + '</div>' : '') + '</div>';
        });
        if (r.moved.length) h += '<div class="ln-move">Also move ' + r.moved.map(function (m) { return esc(m.name) + ' ' + m.from + '→' + m.to; }).join(', ') + ' (no forfeit: he stays active).</div>';
        h += '</section>';
      } else {
        h += '<section class="ln-diff ok"><h3>Your current lineup is already optimal <span style="color:var(--text-muted)">±0.0</span></h3></section>';
      }
    }
    var others = (r.warnings || []).filter(function (w) { return w.type !== 'forfeit' && w.type !== 'forfeit-unknown'; });
    others.forEach(function (w) { h += '<div class="ln-banner"><div>' + esc(w.message) + '</div></div>'; });
    // Roster spots: active (starters + bench) and IL.
    if (r.spots) {
      var sp = r.spots;
      h += '<div class="ln-spots" aria-label="Roster spots"><span><b>' + sp.active + '</b>/' + sp.activeCap + ' active</span><span><b>' + sp.il + '</b>/' + sp.ilCap + ' IL</span>' +
        (sp.benchOpen ? '<span class="open">' + sp.benchOpen + ' open spot' + (sp.benchOpen > 1 ? 's' : '') + ' for an add</span>' : '') + '</div>';
      (sp.ilMoves || []).forEach(function (m) { h += '<div class="ln-banner info"><div>' + esc(m.message) + '</div></div>'; });
    }

    // slots
    h += '<div class="ln-sec"><h2>Starters</h2><small>expected best game from today</small></div><div class="ln-slots">';
    r.slots.forEach(function (s) {
      var isNew = r.current && (!s.currentSlot || s.currentSlot === 'BN' || s.currentSlot === 'IL');
      var pips = s.unmatched ? '' : L.gamePips(s.gamesLeft, s.gamesWeek).map(function (c) { return '<i class="pip ' + c + '"></i>'; }).join('');
      h += '<article class="ln-slot' + (isNew ? ' new' : '') + (s.locked ? ' locked' : '') + '">' +
        '<div class="ln-slot-top"><span class="sp ' + L.slotGroup(s.slot) + '">' + s.slot + '</span><div class="ln-who"><div class="ln-name">' + esc(s.player.name) + '</div><div class="ln-meta"><span class="tm">' + esc(s.player.team || '') + '</span>' + posPills(s.player.pos && s.player.pos.length ? s.player.pos : s.player.elig) + injBadge(s.player.injury) + (isNew ? '<span class="ln-tag new">Start</span>' : '') + (s.locked ? '<span class="ln-tag lock">Locked</span>' : '') + '</div></div>' +
        '<div class="ln-xv"><b>' + n1(s.expected) + '</b><span>exp</span></div></div>' +
        '<div class="ln-chips">' + (s.unmatched ? '<span class="chip zero">Not in our data</span>' : '<span class="chip' + (s.gamesLeft ? '' : ' zero') + '" title="' + s.gamesLeft + ' of ' + s.gamesWeek + ' games left"><span class="pips">' + pips + '</span>' + s.gamesLeft + ' left</span>') +
        (s.banked != null ? '<span class="chip bank" title="Best game so far while started">Banked ' + n1(s.banked) + (s.pBeat != null ? ' · ' + Math.round(s.pBeat * 100) + '% to beat' : '') + '</span>' : '') +
        (s.b2b ? '<span class="chip b2b">B2B ×' + s.b2b + '</span>' : '') + '</div>' +
        '<div class="ln-why">' + esc(s.rationale) + '</div>' +
        '<div class="ln-stream' + (/^Streamable/.test(s.streamNote) ? ' go' : '') + '">' + esc(s.streamNote) + '</div>' +
        (s.alternatives.length ? '<div class="ln-alts">Next best: ' + s.alternatives.map(function (a) { return '<span class="a">' + esc(a.name) + ' <span class="d">' + n1(a.expected) + '</span></span>'; }).join('') + '</div>' : '') +
        (S.day > 0 && !isNew && !s.unmatched ? '<label class="ln-bank-edit">Best game so far <input type="number" inputmode="decimal" min="0" max="300" step="0.5" data-bank="' + esc(s.player.id) + '" value="' + (s.banked != null ? s.banked : '') + '" placeholder="—"></label>' : '') +
        '</article>';
    });
    h += '</div>';

    if (r.bench.length) {
      h += '<div class="ln-sec"><h2>Bench</h2><small>' + r.bench.length + ' player' + (r.bench.length > 1 ? 's' : '') + '</small></div><div class="ln-bench">';
      r.bench.forEach(function (b) {
        h += '<div class="ln-brow"><div class="ln-who" style="flex:1"><div class="ln-name" style="font-size:.85rem">' + esc(b.player.name) + (b.slot === 'IL' ? ' <span class="ln-tag lock">IL</span>' : '') + '</div><div class="ln-meta"><span class="tm">' + esc(b.player.team || '') + '</span>' + posPills(b.player.pos && b.player.pos.length ? b.player.pos : b.player.elig) + injBadge(b.player.injury) + '<span class="why">' + b.gamesLeft + ' left · ' + esc(b.reason) + '</span></div></div><span class="v">' + n1(b.expected) + '</span></div>';
      });
      h += '</div>';
    }
    el.innerHTML = h;
  }

  function renderFoot() {
    var f = $('ln-foot-scoring');
    if (!f) return;
    var sc = (S.result && S.result.profile && S.result.profile.scoring) || (S.profile && S.profile.scoring);
    f.textContent = sc ? L.scoringText(sc) : 'pts + reb + 2·ast + 3·stl + 3·blk';
  }
  function renderAll() { renderHead(); renderDays(); renderEditor(); renderResult(); renderFoot(); }

  /* ------------------------------------------------------------ events */
  function setWeek(w) {
    w = Math.max(1, Math.min(maxWeek(), w));
    if (w === S.week) return;
    S.week = w; S.day = null; S.result = null;
    renderAll(); refresh();
  }
  $('ln-prev').addEventListener('click', function () { setWeek(S.week - 1); });
  $('ln-next').addEventListener('click', function () { setWeek(S.week + 1); });
  $('ln-week').addEventListener('change', function (e) { setWeek(Number(e.target.value)); });
  $('ln-days').addEventListener('click', function (e) {
    var b = e.target.closest('[data-day]');
    if (!b) return;
    S.day = Number(b.dataset.day);
    renderDays(); refresh();
  });
  $('ln-mode').addEventListener('click', function (e) {
    var b = e.target.closest('[data-mode]');
    if (!b || b.dataset.mode === S.mode) return;
    S.mode = b.dataset.mode; store(MODE_PREF, S.mode);
    S.result = null;
    loadProfile().then(function () { renderAll(); refresh(); });
  });
  $('ln-league').addEventListener('change', function (e) {
    S.leagueKey = e.target.value; store(LEAGUE_PREF, S.leagueKey);
    S.result = null; S.myTeamKey = null;
    Promise.all([loadLeague(), loadProfile()]).then(function () { renderAll(); refresh(); });
  });

  var ed = $('ln-editor');
  ed.addEventListener('input', function (e) {
    if (e.target.id === 'ln-q' || e.target.id === 'ln-oq') {
      var key = e.target.id === 'ln-q' ? 'q' : 'oq';
      S[key] = e.target.value;
      var box = e.target.parentNode;
      var old = box.querySelector('.ln-results');
      if (old) old.remove();
      box.insertAdjacentHTML('beforeend', resultsHtml(S[key], key === 'q' ? 'add' : 'opp'));
    }
  });
  ed.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset.slot != null) { S.manual.roster[Number(t.dataset.slot)].slot = t.value; saveManual(); refreshSoon(); }
  });
  ed.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.add) {
      if (S.manual.roster.length >= L.MAX_ROSTER) return;
      S.manual.roster.push({ id: t.dataset.add, slot: 'BN' }); S.q = '';
      saveManual(); renderEditor(); $('ln-q').focus(); refreshSoon();
    } else if (t.dataset.opp) {
      if (S.manual.opponent.length >= L.MAX_ROSTER) return;
      S.manual.opponent.push(t.dataset.opp); S.oq = '';
      saveManual(); renderEditor(); refreshSoon();
    } else if (t.dataset.rm != null) {
      S.manual.roster.splice(Number(t.dataset.rm), 1); saveManual(); renderEditor(); refreshSoon();
    } else if (t.dataset.orm != null) {
      S.manual.opponent.splice(Number(t.dataset.orm), 1); saveManual(); renderEditor(); refreshSoon();
    } else if (t.id === 'ln-paste-btn') {
      S.showPaste = !S.showPaste; renderEditor();
      if (S.showPaste) $('ln-paste').focus();
    } else if (t.id === 'ln-paste-go') {
      var res = L.parseRosterText($('ln-paste').value, S.players);
      var have = {}; S.manual.roster.forEach(function (r) { have[r.id] = 1; });
      res.ids.forEach(function (id) { if (!have[id] && S.manual.roster.length < L.MAX_ROSTER) S.manual.roster.push({ id: id, slot: 'BN' }); });
      S.unknown = res.unknown; S.showPaste = !!res.unknown.length;
      saveManual(); renderEditor(); refreshSoon();
    } else if (t.id === 'ln-clear') {
      S.manual.roster = []; S.unknown = []; saveManual(); S.result = null; renderAll();
    }
  });
  $('ln-result').addEventListener('change', function (e) {
    var id = e.target.dataset.bank;
    if (id == null) return;
    if (S.mode === 'yahoo') { S.yahooBanked = L.setBanked(S.yahooBanked, S.week, id, e.target.value); saveYahooBanked(); }
    else { S.manual.banked = L.setBanked(S.manual.banked, S.week, id, e.target.value); saveManual(); }
    refreshSoon();
  });
  window.addEventListener('storage', function (e) {
    if (e.key === L.storageKey('manual') && S.mode === 'manual') { S.manual = L.deserialize(e.newValue); renderEditor(); refreshSoon(); }
  });

  /* ------------------------------------------------------------ boot */
  S.manual = L.deserialize(read(L.storageKey('manual')));
  var qs = new URLSearchParams(location.search);
  if (qs.get('yahoo') === 'signin') banner('Sign in first, then connect Yahoo.', 'info');
  Promise.all([loadPlayers(null).catch(function (e) { banner('Player data unavailable (' + esc(e.message) + ').', 'error'); }), initYahoo()]).then(loadProfile).then(function () {
    var qw = Number(qs.get('week'));
    if (qw >= 1 && qw <= maxWeek()) S.week = qw;
    var qd = qs.get('day');
    if (qd != null && /^\d{1,2}$/.test(qd)) S.day = Number(qd);
    if (S.week == null) S.week = S.currentWeek;
    renderAll();
    return refresh();
  });
})();
