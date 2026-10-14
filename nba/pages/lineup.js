/* Pocket NBA — weekly lineup picker controller (stream D, UI rebuilt in P3).
   Yahoo-first: when /api/nba/yahoo/status says connected, the roster (and the
   week's opponent) come from Yahoo via GET /api/nba/lineup. Otherwise manual
   mode: build a roster with search/paste (localStorage), scored by
   POST /api/nba/lineup/manual. Pure helpers live in lineup-logic.js; every
   component comes from nba-ui.js (NbaUI). */
(function () {
  'use strict';
  var L = window.NbaLineup;
  var U = window.NbaUI;
  var esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  var LEAGUE_PREF = 'pocket-nba-league';
  var MODE_PREF = 'pocket-nba-lineup-mode';
  var DEFAULT_LEAGUE = '242808';
  var ROSTER_CAP = 16; // 242808: 14 active + 2 IL (the manual API takes up to 20)

  function maxWeek() { return S.profile && S.profile.weeks && S.profile.weeks.length ? S.profile.weeks.length : 25; }
  function leagueId() { var m = /\.l\.(\d+)$/.exec(S.leagueKey || ''); return S.mode === 'yahoo' && m ? m[1] : DEFAULT_LEAGUE; }
  function slotListOf() { return (S.result && S.result.spots && S.result.spots.slots) || (S.profile && profileSlots(S.profile)) || ['G', 'G', 'FC', 'FC', 'FC', 'UTIL']; }
  function profileSlots(p) {
    var order = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'FC', 'UTIL'], out = [];
    order.forEach(function (k) { for (var i = 0; i < ((p.slots || {})[k] || 0); i++) out.push(k); });
    return out;
  }
  function rosterCap() { var s = S.profile && S.profile.slots; return s ? Math.min(L.MAX_ROSTER, (s.BN || 0) + (s.IL || 0) + profileSlots(S.profile).length) : ROSTER_CAP; }

  var S = {
    players: [], byId: {}, currentWeek: 1, week: null, day: null, profile: null, asOf: null,
    mode: 'manual', connected: false, leagues: [], leagueKey: null, myTeamKey: null,
    manual: L.emptyManual(), yahooBanked: {},
    result: null, error: null, loading: true, seq: 0,
    q: '', oq: '', showPaste: false, unknown: [], sheetSlot: null
  };

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
  function bankedMap() { return L.bankedFor(S.mode === 'yahoo' ? S.yahooBanked : S.manual.banked, S.week); }

  /* ------------------------------------------------------------ data */
  function loadPlayers() {
    return api('/api/nba/players?profile=' + DEFAULT_LEAGUE).then(function (d) {
      S.players = (d.players || []).slice().sort(function (a, b) { return (a.rank || 9999) - (b.rank || 9999); });
      S.byId = {};
      S.players.forEach(function (p) { S.byId[String(p.id)] = p; });
      S.asOf = d.asOf || null;
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
    renderResult(); renderBar();
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
        banner('error', 'Yahoo needs reconnecting, so this is manual mode. <a href="/nba/auth/login">Reconnect Yahoo</a>.');
        return refresh();
      }
      renderAll();
    });
  }
  var debounceT = null;
  function refreshSoon() { clearTimeout(debounceT); debounceT = setTimeout(refresh, 250); }

  function initYahoo() {
    // Share the nav chip's status fetch (yahoo-chip.js) instead of asking twice.
    var st0 = window.PocketYahoo && window.PocketYahoo.status ? window.PocketYahoo.status() : api('/api/nba/yahoo/status');
    return st0.then(function (st) {
      if (!st || !st.connected) { if (st && st.reauth) banner('info', 'Your Yahoo login expired. <a href="/nba/auth/login">Reconnect</a> to load your roster.'); return; }
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
      S.teamName = null;
      (d.teams || []).forEach(function (t) { if (t.team_key === S.myTeamKey) S.teamName = t.name; });
      var cw = d.league && Number(d.league.current_week);
      if (cw >= 1 && cw <= maxWeek() && S.week == null) S.week = cw;
      try { S.yahooBanked = JSON.parse(read(L.storageKey(yahooScope())) || '{}') || {}; } catch (e) { S.yahooBanked = {}; }
      if (S.myTeamKey && read(MODE_PREF) !== 'manual') S.mode = 'yahoo';
    }).catch(function (e) {
      banner('error', 'Couldn’t load your Yahoo league (' + esc(e.message) + '). Using manual mode.');
    });
  }

  /* ------------------------------------------------------------ small renderers */
  function banner(tone, html) { $('ln-banners').insertAdjacentHTML('beforeend', U.callout(tone, html)); }
  function full(p) { var b = p && S.byId[String(p.id)]; return b ? Object.assign({}, b, p, { team: p.team || b.team, injury: p.injury !== undefined ? p.injury : b.injury }) : (p || {}); }
  // Yahoo positions (PG, SG, SF, PF, C) when we have them.
  function posOf(p) { var b = p && S.byId[String(p.id)]; return (b && (b.yahooPos || b.pos)) || (p && (p.yahooPos || (p.pos && p.pos.length ? p.pos : p.elig))) || []; }
  function pills(p, max) { var l = posOf(p).filter(function (x) { return x !== 'UTIL'; }); return U.posPill(max ? l.slice(0, max) : l); }
  function pips(left, week) { return '<span class="ln-pips" aria-hidden="true">' + L.gamePips(left, week).map(function (c) { return '<i class="' + c + '"></i>'; }).join('') + '</span>'; }
  function gl(left, week) { return '<span class="ln-gl' + (left ? '' : ' is-zero') + '" title="' + left + ' of ' + week + ' games left">' + pips(left, week) + left + ' left</span>'; }
  function icon(name) { return U.icon[name] || ''; }

  /* ------------------------------------------------------------ head + controls */
  function renderHead() {
    var weeks = (S.profile && S.profile.weeks) || [];
    var wk = weeks[S.week - 1];
    var r = S.result;
    var win = (r && r.window) || (wk ? { start: wk.start, end: wk.end, days: wk.days, playoffs: wk.playoffs } : null);
    $('ln-title').textContent = 'Week ' + S.week + ' lineup';
    var name = (r && r.profile && r.profile.name) || (S.profile && S.profile.name);
    $('ln-eyebrow').textContent = (name ? name + ' · ' : '') + 'Yahoo High Score';
    var sl = slotListOf();
    var src = S.mode === 'yahoo' ? 'From Yahoo' + (S.teamName ? ' · ' + S.teamName : '') : 'Manual roster';
    $('ln-sub').textContent = src + ' · ' + L.countWord(sl.length) + ' starters (' + L.slotListText(sl) + '), each scores his single best game of the week.';
    // week stepper
    $('ln-week-label').textContent = 'Week ' + S.week + (win && win.days > 7 ? ' · ' + win.days + ' days' : '') + (win && win.playoffs ? ' · Playoffs' : '') + (S.week === S.currentWeek ? ' · Now' : '');
    $('ln-week-range').textContent = win ? L.fmtRange(win.start, win.end) : 'Matchup week';
    $('ln-prev').disabled = S.week <= 1;
    $('ln-next').disabled = S.week >= maxWeek();
    $('ln-mode').hidden = !S.connected || !S.myTeamKey;
    Array.prototype.forEach.call($('ln-mode').querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)); });
    var lg = $('ln-league');
    lg.hidden = !(S.connected && S.mode === 'yahoo' && S.leagues.length > 1);
    if (!lg.hidden) {
      lg.innerHTML = S.leagues.map(function (l) { return '<option value="' + esc(l.league_key) + '">' + esc(l.name || l.league_key) + '</option>'; }).join('');
      lg.value = S.leagueKey;
    }
    $('ln-connect').hidden = S.connected;
    Array.prototype.forEach.call(document.querySelectorAll('[data-starters]'), function (e) { e.textContent = L.countWord(sl.length); });
    var data = $('ln-about-data');
    if (data) data.textContent = (S.asOf ? L.freshness(S.asOf) + ' (' + new Date(S.asOf).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '). ' : '') + 'Projections and injuries refresh daily; the schedule is the real NBA calendar.' + (S.profile && S.profile.unverified && S.profile.unverified.length ? ' Unverified league settings: ' + S.profile.unverified.join(' ') : '');
  }

  function renderDays() {
    var el = $('ln-days');
    var weeks = (S.profile && S.profile.weeks) || [];
    var wk = weeks[S.week - 1];
    var r = S.result;
    var len = (r && r.weekLength) || (wk && wk.days) || 7;
    var dates = (r && r.dates) || (wk ? [wk.start, wk.end] : null);
    var day = S.day == null ? 0 : S.day;
    var h = L.dayChips(dates, len).map(function (c) {
      var on = c.day === day;
      return '<button type="button" class="ln-day' + (c.day < day ? ' is-done' : '') + '" data-day="' + c.day + '" aria-pressed="' + on + '" aria-label="' + esc(c.label + ' ' + (c.date == null ? c.day + 1 : c.date)) + (on ? ', today' : c.day < day ? ', played' : '') + '">' + esc(c.label) + '<b>' + (c.date == null ? c.day + 1 : c.date) + '</b></button>';
    }).join('');
    var after = day >= len;
    h += '<button type="button" class="ln-day" data-day="' + len + '" aria-pressed="' + after + '" aria-label="Week over">End<b>✓</b></button>';
    el.innerHTML = h;
    // Long (14-day) weeks scroll sideways on phones: keep today in view.
    var t = el.querySelector('[aria-pressed="true"]');
    el.classList.toggle('is-fit', el.scrollWidth <= el.clientWidth);
    if (t && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, t.offsetLeft - el.offsetLeft - el.clientWidth / 2 + t.offsetWidth / 2);
  }

  /* ------------------------------------------------------------ result */
  function renderResult() {
    var el = $('ln-result');
    var r = S.result;
    if (S.loading && !r) {
      el.innerHTML = '<div class="ln-layout"><section class="nu-card ln-hero" aria-busy="true"><div class="nu-stats nu-stats--2">' + U.skeleton(2, { kind: 'tile' }) + '</div></section><section class="ln-board"><div class="nu-list">' + U.skeleton(9) + '</div></section></div>';
      return;
    }
    if (S.error && !r) { el.innerHTML = U.callout('error', '<b>Couldn’t build the lineup.</b> ' + esc(S.error.message) + ' <button type="button" class="nu-btn nu-btn--sm" data-act="retry">Try again</button>'); return; }
    if (!r) { el.innerHTML = S.mode === 'manual' ? emptyHtml() : ''; hydrate(el); return; }

    var h = '';
    if (S.error) h += U.callout('error', esc(S.error.message) + ' Showing the last result.');
    if (r.unmatched && r.unmatched.length) h += U.callout('warn', '<b>' + r.unmatched.length + ' player' + (r.unmatched.length > 1 ? 's' : '') + ' not in our data:</b> ' + r.unmatched.map(function (u) { return esc(u.name || u.id); }).join(', ') + '. Starters stay in their slot; bench players are left out.');
    if (r.matchupError) h += U.callout('info', esc(r.matchupError) + '; win probability skipped.');
    (r.warnings || []).filter(function (w) { return w.type !== 'forfeit' && w.type !== 'forfeit-unknown'; }).forEach(function (w) { h += U.callout('warn', esc(w.message)); });
    ((r.spots && r.spots.ilMoves) || []).forEach(function (m) { h += U.callout('info', esc(m.message)); });
    if (h) h = '<div class="nu-stack nu-stack--sm" style="margin-bottom:var(--nu-4)">' + h + '</div>';
    h += '<div class="ln-layout">' + heroHtml(r) + '<div class="ln-aside">' + movesHtml(r) + '</div>' + boardHtml(r) + '</div>';
    el.innerHTML = h;
    hydrate(el);
  }
  function hydrate(el) { U.hydrateImages(el); }

  function heroHtml(r) {
    var t = r.total || {};
    var cur = r.current && r.current.expected;
    var gain = r.gain || 0;
    var lo = t.p10, hi = t.p90, span = (hi - lo) || 1;
    var band = U.rangeBand({ min: lo - span * 0.45, max: hi + span * 0.45, lo: lo, hi: hi, mark: t.expected, labels: ['Low ' + n1(lo), 'High ' + n1(hi)], ariaLabel: '80% of simulated weeks land between ' + n1(lo) + ' and ' + n1(hi) });
    var sub = r.current == null ? 'Best lineup from your roster' : gain > 0.05 ? 'Best lineup · now <span class="nu-num">' + n1(cur) + '</span> <span class="nu-delta is-up">▲ ' + gain.toFixed(1) + '</span>' : 'Your lineup is already the best one';
    var h = '<section class="nu-card ln-hero" aria-label="This week"><div><div class="nu-label">Expected week total</div>' +
      '<div class="ln-hero__num"><b>' + n1(t.expected) + '</b><span>pts</span></div><div class="ln-hero__sub">' + sub + '</div>' + band + '</div>';
    h += '<div class="ln-hero__mu">';
    if (r.matchup) {
      var wp = r.matchup.winProb;
      h += '<div class="nu-label">Win probability' + (r.matchup.opponentName ? ' · vs ' + esc(r.matchup.opponentName) : '') + '</div><div class="ln-hero__pct">' + L.winText(wp) + '</div>' +
        '<div class="nu-meter nu-meter--split" role="img" aria-label="' + L.winText(wp) + ' chance to win"><span class="ln-me" style="width:' + (wp * 100).toFixed(1) + '%"></span><span class="ln-them" style="width:' + ((1 - wp) * 100).toFixed(1) + '%"></span></div>' +
        '<div class="ln-hero__vs"><span>You ' + n1(t.expected) + '</span><span>Them ' + n1(r.matchup.opponentExpected) + '</span></div>' +
        (S.mode === 'manual' ? '<div><button type="button" class="nu-btn nu-btn--ghost nu-btn--sm" data-act="opp" style="margin-left:-12px">Edit opponent</button></div>' : '');
    } else {
      h += '<div class="nu-label">Win probability</div><p class="nu-hint" style="line-height:1.5">' + (S.mode === 'yahoo' ? 'No opponent found for this week.' : 'Add your opponent’s players to see your odds this week.') + '</p>' +
        (S.mode === 'manual' ? '<div><button type="button" class="nu-btn nu-btn--sm" data-act="opp">Add opponent</button></div>' : '');
    }
    h += '</div>';
    var len = r.weekLength || 7, day = r.day || 0;
    h += '<div class="ln-hero__foot"><span>' + (day >= len ? 'Week over' : day === 0 ? 'Nothing played yet' : 'Day ' + (day + 1) + ' of ' + len) + '</span>' +
      (S.asOf ? '<span class="ln-live">' + esc(L.freshness(S.asOf)) + '</span>' : '') +
      '<button type="button" class="nu-btn nu-btn--ghost nu-btn--sm" data-act="about">' + icon('info') + 'What is this?</button></div>';
    return h + '</section>';
  }

  function movesHtml(r) {
    if (!r.current) return '';
    var sug = L.suggestions(r, 3);
    if (!sug.length) {
      var moved = (r.moved || []).length;
      return '<section class="nu-card ln-moves" aria-label="Suggested moves"><div class="ln-ok"><span class="ln-ok__icon">' + icon('check') + '</span><div><b>Lineup is set</b><span>' + (moved ? 'Only slot shuffles left (' + moved + '), no points at stake.' : 'No move beats your current starters.') + '</span></div></div></section>';
    }
    var h = '<section class="nu-card nu-card--focus ln-moves" aria-label="Suggested moves"><div class="nu-card__head"><h2 class="nu-card__title">' + (sug.length === 1 ? 'One move to make' : sug.length + ' moves to make') + '</h2><span class="ln-moves__gain">' + L.sign(r.gain) + '</span></div>';
    sug.forEach(function (s) {
      var pin = s.inId ? full({ id: s.inId, name: s.inName }) : null;
      var pout = s.outId ? full({ id: s.outId, name: s.outName }) : null;
      var faces = (pin ? U.avatar(pin, { size: 'md' }) : '') + (pout ? U.avatar(pout, { size: 'xs' }) : '');
      h += '<div class="ln-move"><div class="ln-move__faces">' + faces + '</div><div class="ln-move__text"><b>' + esc(s.text) + '</b><span>' + esc(s.slot || '') + ' · <em>' + esc(s.gainText) + '</em></span></div>' +
        (S.mode === 'manual' ? '<button type="button" class="nu-btn nu-btn--sm" data-apply="' + s.i + '" aria-label="Apply: ' + esc(s.text) + '">Apply</button>' : '<span></span>') +
        (s.warning ? '<div class="ln-note">' + icon('alert') + '<span>' + esc(s.warning) + '</span></div>' : '') + '</div>';
    });
    var extra = r.diff.length - sug.length;
    if (extra > 0) h += '<div class="ln-also">+' + extra + ' smaller move' + (extra > 1 ? 's' : '') + ' included in Apply all.</div>';
    if (r.moved && r.moved.length) h += '<div class="ln-also">Also shuffles ' + r.moved.map(function (m) { return esc(m.name) + ' ' + m.from + '→' + m.to; }).join(', ') + '. Active-to-active moves should keep banked games.</div>';
    if (S.mode === 'yahoo') h += '<div class="ln-also">Make these moves in Yahoo; Pocket can’t edit your lineup.</div>';
    return h + '</section>';
  }

  function slotRow(s, i) {
    var p = full(s.player);
    var isNew = S.result.current && (!s.currentSlot || s.currentSlot === 'BN' || s.currentSlot === 'IL');
    var showBank = S.day > 0 && !isNew && !s.unmatched;
    var bank = s.banked != null ? '<button type="button" class="ln-bank" data-slot-open="' + i + '" data-focus-bank aria-label="Banked ' + n1(s.banked) + ', edit">B ' + n1(s.banked) + '</button>'
      : showBank ? '<button type="button" class="ln-bank is-empty" data-slot-open="' + i + '" data-focus-bank>+ banked</button>' : '';
    var games = s.unmatched ? '<span class="ln-gl is-zero">Not in our data</span>' : gl(s.gamesLeft, s.gamesWeek);
    return '<li class="ln-srow' + (isNew ? ' is-new' : '') + '">' +
      '<span class="ln-srow__slot">' + U.posPill(s.slot) + '</span>' +
      '<button type="button" class="ln-srow__main" data-slot-open="' + i + '" aria-label="' + esc(s.slot + ': ' + p.name + ', ' + n1(s.expected) + ' expected. Details and swap') + '">' +
      U.avatar(p, { size: 'md', injuryDot: true }) +
      '<span class="ln-srow__text"><span class="ln-srow__name"><span>' + esc(p.name) + '</span>' + U.injuryBadge(p.injury) + (isNew ? '<span class="ln-new">Start</span>' : '') + (s.locked ? '<span class="nu-tag">Locked</span>' : '') + '</span>' +
      '<span class="ln-srow__meta">' + U.teamLogo(p.team, { size: 'sm' }) + pills(p, 2) + '<span class="ln-m">' + games + '</span></span></span></button>' +
      '<span class="ln-c">' + games + '</span>' +
      '<span class="ln-c">' + (s.banked != null ? n1(s.banked) : showBank ? '<button type="button" class="ln-bank is-empty" data-slot-open="' + i + '" data-focus-bank>Add</button>' : '—') + '</span>' +
      '<span class="ln-srow__end"><b>' + n1(s.expected) + '</b>' + (bank || '<small>exp</small>') + '</span>' +
      '<button type="button" class="nu-btn nu-btn--ghost nu-btn--icon ln-swap" data-slot-open="' + i + '" aria-label="Swap ' + esc(s.slot) + '">' + icon('trade') + '</button></li>';
  }
  function benchRow(b) {
    var p = full(b.player), il = b.slot === 'IL';
    return '<li class="ln-srow' + (il ? ' is-il' : '') + '"><span class="ln-srow__slot">' + U.posPill(il ? 'IL' : 'BN') + '</span>' +
      '<div class="ln-srow__main" style="cursor:default">' + U.avatar(p, { size: 'md', injuryDot: true }) +
      '<span class="ln-srow__text"><span class="ln-srow__name"><span>' + esc(p.name) + '</span>' + U.injuryBadge(p.injury) + '</span><span class="ln-srow__meta">' + U.teamLogo(p.team, { size: 'sm' }) + pills(p, 2) + '<span class="ln-m">' + (b.unmatched ? '' : gl(b.gamesLeft, b.gamesLeft)) + '</span></span></span></div>' +
      '<span class="ln-c">' + (b.unmatched ? '—' : gl(b.gamesLeft, b.gamesLeft)) + '</span><span class="ln-c">—</span>' +
      '<span class="ln-srow__end"><b style="color:var(--nu-text-2)">' + (b.unmatched ? '—' : n1(b.expected)) + '</b><small>' + (il ? 'IL' : 'exp') + '</small></span><span style="width:44px;flex:none"></span></li>';
  }
  function colhead() { return '<div class="ln-colhead" aria-hidden="true"><span>Slot</span><span>Player</span><span class="ln-c">Games left</span><span class="ln-c">Banked</span><span class="ln-c ln-c--exp">Exp. best</span><span class="ln-c ln-c--act"></span></div>'; }

  function boardHtml(r) {
    var sp = r.spots;
    var bench = r.bench.filter(function (b) { return b.slot !== 'IL'; }), il = r.bench.filter(function (b) { return b.slot === 'IL'; });
    var h = '<div class="ln-board"><section class="nu-section"><div class="nu-section__head"><h2 class="nu-section__title">Starters · ' + r.slots.length + '</h2>' +
      (S.mode === 'manual' ? '<button type="button" class="nu-btn nu-btn--ghost nu-btn--sm" data-act="roster">Edit roster <span class="nu-count">' + S.manual.roster.length + '</span></button>' : '') + '</div>' +
      '<ul class="nu-list ln-slots">' + colhead() + r.slots.map(slotRow).join('') + '</ul></section>';
    h += '<section class="nu-section"><div class="nu-section__head"><h2 class="nu-section__title">Bench · ' + bench.length + (sp ? '/' + (sp.activeCap - sp.starters) : '') + '</h2>' +
      (sp && sp.benchOpen ? '<span class="nu-hint">' + sp.benchOpen + ' open spot' + (sp.benchOpen > 1 ? 's' : '') + ' for an add</span>' : '') + '</div>' +
      (bench.length ? '<ul class="nu-list ln-slots">' + bench.map(benchRow).join('') + '</ul>' : '<p class="nu-hint">Nobody on the bench.</p>') + '</section>';
    if (il.length || (sp && sp.ilCap)) {
      h += '<section class="nu-section"><div class="nu-section__head"><h2 class="nu-section__title">Injured list · ' + il.length + (sp ? '/' + sp.ilCap : '') + '</h2></div>' +
        (il.length ? '<ul class="nu-list ln-slots">' + il.map(benchRow).join('') + '</ul>' : '<p class="nu-hint">Empty. Players listed Out can go here to free a bench spot.</p>') + '</section>';
    }
    return h + '</div>';
  }

  /* ------------------------------------------------------------ manual roster builder */
  function emptyHtml() {
    var sl = slotListOf();
    return '<div class="ln-empty"><section class="nu-card nu-card--focus"><div class="nu-card__head"><h2 class="nu-card__title">Build your roster</h2><span class="ln-cap">0/' + rosterCap() + '</span></div>' +
      '<div class="ln-builder" data-builder>' + builderInner() + '</div></section>' +
      '<aside class="nu-card"><h2 class="nu-card__title" style="margin-bottom:var(--nu-4)">How it works</h2><ol class="ln-empty__how">' +
      '<li><span><b>Add your players.</b> Search by name or paste your Yahoo roster. Not connected to Yahoo? This is the way in.</span></li>' +
      '<li><span><b>Set who is starting now</b> (' + esc(L.slotListText(sl)) + '), so swaps and forfeits are checked.</span></li>' +
      '<li><span><b>Get your moves.</b> We pick the ' + L.countWord(sl.length) + ' starters with the highest expected best game and tell you exactly what to change.</span></li></ol></aside></div>';
  }
  function builderInner() {
    var ros = S.manual.roster;
    var choices = L.slotChoices(slotListOf(), S.profile && S.profile.slots ? S.profile.slots.IL : null);
    var h = '<label class="nu-search">' + icon('search') + '<input class="nu-input" id="ln-q" type="search" autocomplete="off" placeholder="Search players or a team (BOS)" value="' + esc(S.q) + '" aria-label="Add a player"></label>' +
      '<div class="ln-results" id="ln-results" role="list">' + resultsHtml(S.q, 'add') + '</div>';
    if (ros.length) {
      h += '<div class="nu-list ln-rlist">' + ros.map(function (r, i) {
        var p = full(S.byId[r.id] || { id: r.id, name: r.id });
        var opts = choices.indexOf(r.slot) >= 0 ? choices : choices.concat([r.slot]);
        return '<div class="nu-row">' + U.playerCell(p, { size: 'sm', meta: U.teamLogo(p.team, { size: 'sm' }) + pills(p) + U.injuryBadge(p.injury) }) +
          '<div class="nu-row__end"><select class="nu-select" data-slot="' + i + '" aria-label="Current slot for ' + esc(p.name) + '">' + opts.map(function (s) { return '<option value="' + s + '"' + (r.slot === s ? ' selected' : '') + '>' + (s === 'BN' ? 'Bench' : s) + '</option>'; }).join('') + '</select>' +
          '<button type="button" class="nu-btn nu-btn--ghost nu-btn--icon nu-btn--sm" data-rm="' + i + '" aria-label="Remove ' + esc(p.name) + '">' + icon('close') + '</button></div></div>';
      }).join('') + '</div>';
    }
    h += '<div class="nu-row-flex" style="gap:var(--nu-2);flex-wrap:wrap"><button type="button" class="nu-btn nu-btn--sm" data-act="paste">' + (S.showPaste ? 'Hide paste' : 'Paste a roster') + '</button>' +
      (ros.length ? '<button type="button" class="nu-btn nu-btn--ghost nu-btn--sm" data-act="clear">Clear all</button>' : '') + '</div>';
    if (S.showPaste) h += '<div class="ln-paste nu-stack nu-stack--sm"><textarea class="nu-input" id="ln-paste" aria-label="Paste roster, one player per line" placeholder="One player per line (or commas)&#10;Nikola Jokic&#10;Luka Doncic&#10;Cooper Flagg"></textarea><div><button type="button" class="nu-btn nu-btn--sm" data-act="paste-go">Add players</button></div></div>';
    if (S.unknown.length) h += U.callout('warn', 'Not found: ' + S.unknown.map(esc).join(', '));
    return h;
  }
  function resultsHtml(q, kind) {
    if (!q || q.length < 2) return '';
    var taken = {};
    (kind === 'add' ? S.manual.roster.map(function (r) { return r.id; }) : S.manual.opponent).forEach(function (id) { taken[id] = 1; });
    var res = L.searchPlayers(q, S.players, 6).filter(function (p) { return !taken[p.id]; });
    if (!res.length) return '<button type="button" class="nu-row" disabled>No players match “' + esc(q) + '”</button>';
    return res.map(function (p) {
      return '<button type="button" class="nu-row" role="listitem" data-' + kind + '="' + esc(p.id) + '" aria-label="Add ' + esc(p.name) + '">' +
        U.playerCell(p, { size: 'sm', meta: U.teamLogo(p.team, { size: 'sm' }) + pills(p) + U.injuryBadge(p.injury) + '<span class="nu-sep"></span><span class="nu-num">' + n1(p.hsValue) + '</span>' }) +
        '<span class="nu-row__end ln-add">Add</span></button>';
    }).join('');
  }
  function renderBuilder() {
    var box = document.querySelector('[data-builder]');
    if (box) { box.innerHTML = builderInner(); hydrate(box); }
    var cap = document.querySelector('.ln-empty .ln-cap');
    if (cap) cap.textContent = S.manual.roster.length + '/' + rosterCap();
    var sb = $('ln-sheet-roster-body');
    if (U.sheet.isOpen() && sb && sb.closest('.nu-sheet.is-open')) { sb.innerHTML = '<div class="ln-builder" data-builder>' + builderInner() + '</div>'; hydrate(sb); }
  }
  function oppInner() {
    var opp = S.manual.opponent;
    return '<p class="nu-hint" style="margin-bottom:var(--nu-3)">Add their players to see your win probability. We simulate their best lineup too.</p>' +
      '<label class="nu-search">' + icon('search') + '<input class="nu-input" id="ln-oq" type="search" autocomplete="off" placeholder="Search opponent players" value="' + esc(S.oq) + '" aria-label="Add an opponent player"></label>' +
      '<div class="ln-results" id="ln-oresults" role="list" style="margin-top:var(--nu-2)">' + resultsHtml(S.oq, 'opp') + '</div>' +
      '<div class="ln-chips" style="margin-top:var(--nu-3)">' + opp.map(function (id, i) { var p = S.byId[id] || { id: id, name: id }; return '<button type="button" class="nu-chip" data-orm="' + i + '" aria-label="Remove ' + esc(p.name) + '">' + U.avatar(p, { size: 'xs' }) + esc(p.name) + icon('close') + '</button>'; }).join('') + '</div>';
  }

  /* ------------------------------------------------------------ sheets */
  function openSlot(i, focusBank) {
    var r = S.result, s = r && r.slots[i];
    if (!s) return;
    S.sheetSlot = i;
    var p = full(s.player);
    var isNew = r.current && (!s.currentSlot || s.currentSlot === 'BN' || s.currentSlot === 'IL');
    var canBank = S.day > 0 && !isNew && !s.unmatched;
    $('ln-sheet-slot-t').textContent = s.slot + ' slot';
    var h = U.playerCell(p, { lg: true, teamBadge: true, injuryDot: true, meta: pills(p) + '<span>' + esc(p.team || '') + '</span>' + U.injuryBadge(p.injury) }) +
      '<div class="nu-stats nu-stats--3" style="margin:var(--nu-5) 0 var(--nu-4)">' +
      U.statTile({ label: 'Exp. best', value: s.expected, tone: 'accent' }) +
      U.statTile({ label: 'Left', value: s.unmatched ? '—' : s.gamesLeft + '/' + s.gamesWeek }) +
      U.statTile({ label: 'Banked', value: s.banked != null ? s.banked : '—', sub: s.pBeat != null ? Math.round(s.pBeat * 100) + '% to beat' : null }) + '</div>';
    if (s.rationale) h += '<p class="nu-body" style="margin-bottom:var(--nu-2)">' + esc(s.rationale.charAt(0).toUpperCase() + s.rationale.slice(1)) + '.</p>';
    if (s.streamNote) h += '<p class="nu-hint" style="margin-bottom:var(--nu-4)">' + esc(s.streamNote) + '</p>';
    if (canBank) {
      h += '<div class="ln-field-row" style="margin-bottom:var(--nu-5)"><div class="nu-field"><label for="ln-bank-in">Best game so far this week</label>' +
        '<input class="nu-input nu-num" id="ln-bank-in" type="number" inputmode="decimal" min="0" max="300" step="0.5" data-bank="' + esc(p.id) + '" value="' + (s.banked != null ? s.banked : '') + '" placeholder="e.g. 52.5"></div>' +
        '<button type="button" class="nu-btn" data-act="bank-save">Save</button></div>';
    }
    if (s.alternatives && s.alternatives.length) {
      var risky = s.banked > 0 ? 'Swapping him out wipes his banked ' + n1(s.banked) + '. Only games after he’s restarted would count.' : (S.day > 0 && !isNew ? 'If he has played this week, swapping him out wipes those games.' : '');
      h += '<div class="nu-section"><div class="nu-section__head"><h3 class="nu-section__title">' + (S.mode === 'manual' ? 'Swap in' : 'Next best') + '</h3></div>' +
        (risky ? '<div class="ln-note" style="margin-bottom:var(--nu-2)">' + icon('alert') + '<span>' + esc(risky) + '</span></div>' : '') +
        '<div class="nu-list ln-sheet-alts">' + s.alternatives.map(function (a) {
          var ap = full({ id: a.id, name: a.name });
          var inner = U.playerCell(ap, { size: 'sm', meta: pills(ap) + '<span>' + esc(ap.team || '') + '</span><span class="nu-sep"></span><span>' + (a.gamesLeft != null ? a.gamesLeft + ' left' : '') + '</span>' }) +
            '<span class="nu-row__end"><span class="nu-row__num"><b>' + n1(a.expected) + '</b><small>' + (a.delta != null ? L.sign(a.delta) : '') + '</small></span></span>';
          return S.mode === 'manual' ? '<button type="button" class="nu-row" data-swap="' + esc(a.id) + '" aria-label="Start ' + esc(a.name) + ' at ' + esc(s.slot) + '">' + inner + '</button>' : '<div class="nu-row" aria-disabled="true">' + inner + '</div>';
        }).join('') + '</div></div>';
    }
    $('ln-sheet-slot-body').innerHTML = h;
    hydrate($('ln-sheet-slot-body'));
    U.sheet.open('ln-sheet-slot', { initialFocus: focusBank && canBank ? '#ln-bank-in' : undefined });
  }
  function openWeeks() {
    var rows = L.weekOptions((S.profile && S.profile.weeks) || [], S.currentWeek, maxWeek());
    $('ln-weeks').innerHTML = rows.map(function (w) {
      var on = w.week === S.week;
      return '<button type="button" class="nu-row' + (on ? ' is-selected' : '') + '" data-week="' + w.week + '" aria-current="' + (on ? 'true' : 'false') + '"><b>Week ' + w.week + '</b><span class="nu-meta">' + esc(w.range) + '</span>' +
        (w.long ? '<span class="nu-tag">' + w.days + ' days</span>' : '') + (w.playoffs ? '<span class="nu-tag">Playoffs</span>' : '') + (w.current ? '<span class="nu-tag">Now</span>' : '') + (on ? icon('check') : '') + '</button>';
    }).join('');
    U.sheet.open('ln-sheet-week', { initialFocus: '[aria-current="true"]' });
    var cur = $('ln-weeks').querySelector('[aria-current="true"]');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
  }
  function openRoster() {
    $('ln-sheet-roster-body').innerHTML = '<div class="ln-builder" data-builder>' + builderInner() + '</div>';
    $('ln-sheet-roster-t').textContent = 'Your roster · ' + S.manual.roster.length + '/' + rosterCap();
    hydrate($('ln-sheet-roster-body'));
    U.sheet.open('ln-sheet-roster', { initialFocus: '#ln-q' });
  }
  function openOpp() {
    $('ln-sheet-opp-body').innerHTML = oppInner();
    hydrate($('ln-sheet-opp-body'));
    U.sheet.open('ln-sheet-opp', { initialFocus: '#ln-oq' });
  }

  /* ------------------------------------------------------------ action bar */
  function renderBar() {
    var el = $('ln-actionbar'), r = S.result;
    var info = '', btn = '';
    if (S.loading && !r) { el.innerHTML = ''; return; }
    if (!r) {
      if (S.mode !== 'manual') { el.innerHTML = ''; return; }
      var n = S.manual.roster.length;
      info = '<b>' + (n ? n + ' player' + (n > 1 ? 's' : '') + ' added' : 'No roster yet') + '</b><span>Add your players to get this week’s moves</span>';
      btn = '<button type="button" class="nu-btn nu-btn--primary" data-act="focus-search">Add players</button>';
    } else if (r.current && r.diff.length) {
      info = '<b>' + r.diff.length + ' move' + (r.diff.length > 1 ? 's' : '') + ' · ' + L.sign(r.gain) + ' expected</b><span>' + n1(r.current.expected) + ' now → ' + n1(r.total.expected) + ' with the best lineup</span>';
      btn = S.mode === 'manual' ? '<button type="button" class="nu-btn nu-btn--primary" data-apply="all">Apply all</button>'
        : '<a class="nu-btn nu-btn--primary" href="' + esc(L.yahooTeamUrl(S.myTeamKey)) + '" target="_blank" rel="noopener">Set in Yahoo</a>';
    } else {
      info = '<b>Lineup is set · ' + n1(r.total.expected) + ' expected</b><span>' + (r.matchup ? L.winText(r.matchup.winProb) + ' to win this week' : 'Check back daily as games are played') + '</span>';
      btn = S.mode === 'manual' ? '<button type="button" class="nu-btn" data-act="roster">Edit roster</button>' : '';
    }
    el.innerHTML = '<div class="nu-actionbar" role="region" aria-label="Lineup actions"><div class="nu-actionbar__info">' + info + '</div>' + btn + '</div>';
  }

  function renderFoot() {
    var f = $('ln-foot-scoring');
    var sc = (S.result && S.result.profile && S.result.profile.scoring) || (S.profile && S.profile.scoring);
    f.textContent = sc ? L.scoringText(sc) : 'pts + reb + 2·ast + 3·stl + 3·blk';
  }
  function renderAll() { renderHead(); renderDays(); renderResult(); renderBar(); renderFoot(); }

  /* ------------------------------------------------------------ actions */
  function setWeek(w) {
    w = Math.max(1, Math.min(maxWeek(), w));
    if (w === S.week) return;
    S.week = w; S.day = null; S.result = null;
    renderAll(); refresh();
  }
  function apply(which) {
    var r = S.result;
    if (!r || S.mode !== 'manual') return;
    var before = S.manual.roster.map(function (x) { return { id: x.id, slot: x.slot }; });
    var res = L.applyMoves(S.manual.roster, r, which === 'all' ? null : Number(which));
    S.manual.roster = res.roster; saveManual();
    var gain = which === 'all' || res.full ? r.gain : (r.diff[Number(which)] || {}).gain;
    U.toast((res.full ? 'Best lineup applied' : 'Move applied') + ' · ' + L.sign(gain || 0) + ' expected', {
      tone: 'good', action: { label: 'Undo', onClick: function () { S.manual.roster = before; saveManual(); refresh(); } }
    });
    refresh();
  }
  function swapIn(id) {
    var r = S.result, s = r && r.slots[S.sheetSlot];
    if (!s) return;
    var cur = String(s.player.id), roster = S.manual.roster;
    var inE = roster.filter(function (x) { return x.id === String(id); })[0], outE = roster.filter(function (x) { return x.id === cur; })[0];
    if (!inE) return;
    // The current lineup is what changes: the player in this slot (as currently set) steps out.
    var occupant = roster.filter(function (x) { return x.slot === s.slot && x.id !== String(id); })[0] || outE;
    var prev = inE.slot;
    inE.slot = s.slot;
    if (occupant) occupant.slot = prev && prev !== 'IL' && prev !== s.slot ? prev : 'BN';
    saveManual(); U.sheet.close();
    U.toast('Started ' + ((S.byId[id] || {}).name || 'player') + ' at ' + s.slot, { tone: 'good' });
    refresh();
  }
  function saveBank(input) {
    var id = input.dataset.bank;
    if (S.mode === 'yahoo') { S.yahooBanked = L.setBanked(S.yahooBanked, S.week, id, input.value); saveYahooBanked(); }
    else { S.manual.banked = L.setBanked(S.manual.banked, S.week, id, input.value); saveManual(); }
    refreshSoon();
  }
  function addPlayer(id) {
    if (S.manual.roster.length >= L.MAX_ROSTER) return;
    S.manual.roster.push({ id: id, slot: 'BN' }); S.q = '';
    saveManual(); renderBuilder(); renderBar();
    var t = $('ln-sheet-roster-t'); if (t) t.textContent = 'Your roster · ' + S.manual.roster.length + '/' + rosterCap();
    var q = $('ln-q'); if (q) q.focus();
    refreshSoon();
  }

  // icons in static markup
  Array.prototype.forEach.call(document.querySelectorAll('[data-icon]'), function (b) { b.innerHTML = icon(b.dataset.icon); });
  $('ln-prev').innerHTML = icon('chevron'); $('ln-next').innerHTML = icon('chevron');
  $('ln-week-open').insertAdjacentHTML('beforeend', icon('chevron'));

  $('ln-prev').addEventListener('click', function () { setWeek(S.week - 1); });
  $('ln-next').addEventListener('click', function () { setWeek(S.week + 1); });
  $('ln-week-open').addEventListener('click', openWeeks);
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

  // Delegated: page body + sheets (sheets are moved to <body> on first open).
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button, [data-act]');
    if (!t) return;
    var d = t.dataset;
    if (d.week) { U.sheet.close(); setWeek(Number(d.week)); }
    else if (d.slotOpen != null) openSlot(Number(d.slotOpen), d.focusBank != null);
    else if (d.apply != null) apply(d.apply);
    else if (d.swap) swapIn(d.swap);
    else if (d.add) addPlayer(d.add);
    else if (d.opp) {
      if (S.manual.opponent.length >= L.MAX_ROSTER) return;
      S.manual.opponent.push(d.opp); S.oq = '';
      saveManual(); $('ln-sheet-opp-body').innerHTML = oppInner(); hydrate($('ln-sheet-opp-body')); $('ln-oq').focus(); refreshSoon();
    } else if (d.rm != null) {
      S.manual.roster.splice(Number(d.rm), 1); saveManual(); renderBuilder(); refreshSoon();
    } else if (d.orm != null) {
      S.manual.opponent.splice(Number(d.orm), 1); saveManual(); $('ln-sheet-opp-body').innerHTML = oppInner(); hydrate($('ln-sheet-opp-body')); refreshSoon();
    } else if (d.act === 'about') U.sheet.open('ln-sheet-about');
    else if (d.act === 'roster') openRoster();
    else if (d.act === 'opp') openOpp();
    else if (d.act === 'retry') refresh();
    else if (d.act === 'focus-search') { var q = $('ln-q'); if (q) { q.focus(); q.scrollIntoView({ block: 'center' }); } else openRoster(); }
    else if (d.act === 'paste') { S.showPaste = !S.showPaste; renderBuilder(); if (S.showPaste) $('ln-paste').focus(); }
    else if (d.act === 'paste-go') {
      var res = L.parseRosterText($('ln-paste').value, S.players);
      var have = {}; S.manual.roster.forEach(function (r) { have[r.id] = 1; });
      res.ids.forEach(function (id) { if (!have[id] && S.manual.roster.length < L.MAX_ROSTER) S.manual.roster.push({ id: id, slot: 'BN' }); });
      S.unknown = res.unknown; S.showPaste = !!res.unknown.length;
      saveManual(); renderBuilder(); refreshSoon();
    } else if (d.act === 'clear') {
      S.manual.roster = []; S.unknown = []; saveManual(); S.result = null; if (U.sheet.isOpen()) U.sheet.close(); renderAll();
    } else if (d.act === 'bank-save') { var inp = $('ln-bank-in'); if (inp) { saveBank(inp); U.sheet.close(); } }
  });
  document.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id === 'ln-q') { S.q = e.target.value; $('ln-results').innerHTML = resultsHtml(S.q, 'add'); hydrate($('ln-results')); }
    else if (id === 'ln-oq') { S.oq = e.target.value; $('ln-oresults').innerHTML = resultsHtml(S.oq, 'opp'); hydrate($('ln-oresults')); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.slot != null && t.closest('[data-builder]')) { S.manual.roster[Number(t.dataset.slot)].slot = t.value; saveManual(); refreshSoon(); }
    else if (t.dataset && t.dataset.bank != null) saveBank(t);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'ln-bank-in') { e.preventDefault(); saveBank(e.target); U.sheet.close(); }
  });
  window.addEventListener('storage', function (e) {
    if (e.key === L.storageKey('manual') && S.mode === 'manual') { S.manual = L.deserialize(e.newValue); renderBuilder(); refreshSoon(); }
  });

  /* ------------------------------------------------------------ boot */
  S.manual = L.deserialize(read(L.storageKey('manual')));
  var qs = new URLSearchParams(location.search);
  if (qs.get('yahoo') === 'signin') banner('info', 'Sign in first, then connect Yahoo.');
  renderResult();
  function boot() {
  Promise.all([loadPlayers().catch(function (e) { banner('error', 'Player data unavailable (' + esc(e.message) + ').'); }), initYahoo()]).then(loadProfile).then(function () {
    var qw = Number(qs.get('week'));
    if (qw >= 1 && qw <= maxWeek()) S.week = qw;
    var qd = qs.get('day');
    if (qd != null && /^\d{1,2}$/.test(qd)) S.day = Number(qd);
    if (S.week == null) S.week = S.currentWeek;
    renderAll();
    return refresh();
  });
  }
  // after deferred scripts (yahoo-chip.js) so the Yahoo status fetch is shared
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
