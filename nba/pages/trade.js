/* Pocket NBA — trade calculator controller (stream E, UI rebuilt in P4 on nba-ui; v2 = NBA trade spec §4).
   Board from /api/nba/players (?league_id= for a Sleeper league, else ?profile=242808), verdict from
   POST /api/nba/trade/evaluate, Sleeper rosters from the nav chip's status (sleeper-chip.js) +
   /api/nba/trade/context?league_id=. v2: horizon + lean lens, value meter, Team Fit, Player Signals,
   and deep links from the team page (/nba/trade?league_id=&partner=&give=&get=).
   Works fully without Sleeper (manual roster, persisted in localStorage). */
(function () {
  'use strict';
  var L = window.NbaTrade, U = window.NbaUI;
  var esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  var PROFILE = '242808';
  var S = {
    st: L.emptyState(), players: [], byId: {}, ctx: null, connected: false, userId: null, username: null, leagues: [], profileName: null,
    result: null, busy: false, seq: 0, timer: null, error: null, loading: true, pickSide: null,
    boardKey: null, currentWeek: null, deep: null
  };

  function save() { try { localStorage.setItem(L.STORAGE_KEY, L.serialize(S.st)); } catch (e) {} }
  function load() { try { S.st = L.parseState(localStorage.getItem(L.STORAGE_KEY)); } catch (e) { S.st = L.emptyState(); } }
  function f1(n) { return U.fmt.score(Number(n) || 0, 1); }
  function dir(n) { return n > 0.05 ? 'is-up' : n < -0.05 ? 'is-down' : ''; }
  var reduceMotion = function () { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; };

  function api(url, opts) {
    opts = opts || {};
    return fetch(url, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: Object.assign({ Accept: 'application/json' }, opts.body ? { 'Content-Type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; e.code = j.code; throw e; }
        return j;
      });
    });
  }

  function banner(msg, kind) {
    var b = $('nt-banner');
    if (!msg) { b.hidden = true; b.innerHTML = ''; return; }
    b.innerHTML = U.callout(kind === 'error' ? 'error' : 'warn', esc(msg));
    b.hidden = false;
  }

  function myTeam() { return S.st.mode === 'sleeper' ? L.teamOf(S.ctx, S.st.myTeamKey) : null; }
  function partnerTeam() { return S.st.mode === 'sleeper' ? L.teamOf(S.ctx, S.st.partnerKey) : null; }
  function isYahoo() { return S.st.mode === 'sleeper' && !!S.ctx; } // "league mode" (name kept for the diff)
  function byValue(list) { return list.slice().sort(function (a, b) { return (b.hsValue || 0) - (a.hsValue || 0); }); }
  function rosterPlayers() { return byValue(S.st.myRoster.map(function (id) { return S.byId[id]; }).filter(Boolean)); }
  function partnerPlayers() { var t = partnerTeam(); return t ? byValue(L.rosterIds(t).map(function (id) { return S.byId[id]; }).filter(Boolean)) : []; }
  function resPlayer(id) { var r = S.result; return r && r.players ? r.players.filter(function (p) { return String(p.id) === String(id); })[0] : null; }
  function themName() { var r = S.result; return r && r.them && r.them.estimated ? 'Typical team' : (partnerTeam() ? partnerTeam().name : 'Them'); }

  /* --------------------------------------------------------- players */
  function pos(p) { return (p.yahooPos && p.yahooPos.length ? p.yahooPos : p.pos || []).slice(0, 3); }
  function metaHtml(p) {
    return U.posPill(pos(p)) + (p.team ? '<span>' + esc(p.team) + '</span>' : '<span>FA</span>') +
      (p.injury || p.outForSeason ? U.injuryBadge(p.injury, { outForSeason: p.outForSeason }) : '');
  }
  function playerBlock(p, size, extra) {
    return '<div class="nu-player">' + U.avatar(p, { size: size || 'md', teamBadge: true, injuryDot: true }) +
      '<div class="nu-player__text"><span class="nu-player__name">' + esc(p.name) + '</span>' +
      '<div class="nu-player__meta">' + metaHtml(p) + '</div>' + (extra || '') + '</div></div>';
  }
  function chipsHtml(chips) {
    return chips.length ? '<div class="nt-chips">' + chips.map(function (c) { return '<span class="nt-chip"' + (c.tone ? ' data-tone="' + c.tone + '"' : '') + '>' + esc(c.text) + '</span>'; }).join('') + '</div>' : '';
  }
  function tradeRow(p, side) {
    var rp = resPlayer(p.id);
    var fit = '<span>Ceil <b>' + f1(p.ceiling) + '</b></span>';
    if (rp) {
      fit += ' · <span>ROS <b>' + f1(rp.rosValue) + '</b></span>';
      var impact = side === 'give' ? -(rp.forYou || 0) : (rp.forYou || 0);
      fit += ' · <span>Lineup <b class="' + dir(impact) + '">' + L.signed(impact) + '</b></span>';
    }
    var chips = rp && rp.signals ? chipsHtml(L.signalChips(rp.signals, 3)) : '';
    var removable = true;
    return '<li class="nt-prow">' + playerBlock(p, 'md', '<div class="nt-prow__fit">' + fit + '</div>' + chips) +
      '<div class="nt-prow__nums"><b>' + f1(p.hsValue) + '</b><small>pts/wk</small></div>' +
      (removable ? '<button type="button" class="nu-btn nu-btn--ghost nu-btn--icon nu-btn--sm" data-remove="' + esc(p.id) + '" data-from="' + side + '" aria-label="Remove ' + esc(p.name) + '">' + U.icon.close + '</button>' : '') + '</li>';
  }

  var lastHtml = {};
  function renderSides() {
    var st = S.st, yahoo = isYahoo();
    ['give', 'get'].forEach(function (side) {
      var list = st[side].map(function (id) { return S.byId[id]; }).filter(Boolean);
      var el = $('nt-' + side + '-list');
      var html = S.loading ? '<li>' + U.skeleton(1) + '</li>' : list.map(function (p) { return tradeRow(p, side); }).join('') ||
        '<li class="nt-empty-row"><b>' + (side === 'give' ? 'Nobody yet' : 'Nobody yet') + '</b>' + (side === 'give' ? 'Search above for a player you would send.' : (isYahoo() ? 'Pick a partner, then search their roster.' : 'Search above for any player you want back.')) + '</li>';
      if (lastHtml[side] !== html) { el.innerHTML = html; lastHtml[side] = html; }
      var sum = list.reduce(function (s, p) { return s + (p.hsValue || 0); }, 0);
      $('nt-' + side + '-sum').textContent = list.length ? list.length + ' · ' + f1(sum) + ' pts/wk' : '';
    });

    // partner picker (league mode)
    var sel = $('nt-partner');
    sel.hidden = !yahoo;
    if (yahoo) {
      var opts = '<option value="">Pick a trade partner</option>' + S.ctx.teams.filter(function (t) { return t.team_key !== st.myTeamKey; })
        .map(function (t) { return '<option value="' + esc(t.team_key) + '"' + (t.team_key === st.partnerKey ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('');
      if (sel.innerHTML !== opts) sel.innerHTML = opts;
    }
    var p = partnerTeam();
    $('nt-get-q').placeholder = yahoo ? (p ? 'Search ' + p.name : 'Pick a partner first') : 'Search any player';
    $('nt-get-q').disabled = yahoo && !p;
    $('nt-get-add-sub').textContent = yahoo ? (p ? 'From ' + p.name : 'Pick a trade partner first') : 'Search any player';
    $('nt-give-q').placeholder = yahoo ? 'Search your roster' : (st.myRoster.length ? 'Add from your roster' : 'Search a player you give');
  }

  function renderMode() {
    var yahoo = isYahoo();
    $('nt-mode-tag').textContent = yahoo ? 'Sleeper League' : 'Manual';
    var p = partnerTeam();
    $('nt-mode-note').textContent = yahoo ? (p ? 'Real rosters on both sides' : 'Pick a partner for their real roster') : 'A typical team stands in for the other side';
    $('nt-roster-count').textContent = String(S.st.myRoster.length);
    var lname = yahoo && S.ctx && S.ctx.league && S.ctx.league.name;
    $('nt-eyebrow').textContent = (lname || S.profileName ? (lname || S.profileName) + ' · ' : '') + 'High Score';
    renderLens();
  }

  // Horizon + lean lens. Lean: the user's pick, else the server's default for this team.
  function renderLens() {
    var st = S.st, r = S.result;
    var cw = S.currentWeek;
    Array.prototype.forEach.call($('nt-horizon').querySelectorAll('[data-horizon]'), function (b) {
      var h = b.getAttribute('data-horizon');
      var ok = L.horizonAvailable(h, cw);
      b.disabled = !ok;
      b.title = ok ? '' : 'Opens in week ' + L.PLAYOFFS_FROM_WEEK;
      b.setAttribute('aria-pressed', st.horizon === h ? 'true' : 'false');
    });
    var lean = st.lean || (r && r.options && r.options.lean) || 'contend';
    Array.prototype.forEach.call($('nt-lean').querySelectorAll('[data-lean]'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-lean') === lean ? 'true' : 'false');
    });
    var src = st.lean ? 'user' : (r && r.options && r.options.leanSource) || 'default';
    var po = r && r.meta && r.meta.playoffStartWeek;
    var note = lean === 'contend' ? 'Playoff weeks' + (po ? ' (' + po + '+)' : '') + ' count 1.5×.' : 'Every week counts the same.';
    if (src === 'record') note += ' Set from your record.';
    if (!L.horizonAvailable('playoffs', cw)) note += ' Playoffs view opens in week ' + L.PLAYOFFS_FROM_WEEK + '.';
    $('nt-lens-note').textContent = note;
  }

  /* --------------------------------------------------------- candidates */
  function candidates(side, q) {
    var st = S.st, yahoo = isYahoo(), groups = [];
    var taken = st.give.concat(st.get);
    var match = function (list) { return q ? L.search(list, q, 40) : list; };
    if (side === 'give') {
      var mine = match(rosterPlayers());
      groups.push({ title: 'Your roster', items: mine.slice(0, 30), tag: '' });
      if (!yahoo && q) {
        var rest = L.search(S.players, q, 30).filter(function (p) { return st.myRoster.indexOf(String(p.id)) < 0; }).slice(0, 8);
        groups.push({ title: 'Not on your roster yet (adds him)', items: rest });
      }
    } else if (yahoo) {
      groups.push({ title: partnerTeam() ? partnerTeam().name : 'Pick a trade partner first', items: match(partnerPlayers()).slice(0, 30) });
    } else {
      var pool = S.players.filter(function (p) { return st.myRoster.indexOf(String(p.id)) < 0; });
      groups.push({ title: q ? 'Players' : 'Top available values', items: (q ? L.search(pool, q, 12) : pool.slice(0, 10)) });
    }
    groups.forEach(function (g) { g.items = g.items.map(function (p) { return { p: p, on: taken.indexOf(String(p.id)) >= 0 && st[side].indexOf(String(p.id)) >= 0 }; }); });
    return groups;
  }
  function optHtml(c, side, i) {
    var p = c.p;
    return '<button type="button" class="nt-opt" role="option" id="nt-opt-' + side + '-' + i + '" data-opt="' + esc(p.id) + '" data-side="' + side + '" aria-selected="' + (c.on ? 'true' : 'false') + '">' +
      playerBlock(p, 'sm') + '<span class="nt-opt__num">' + f1(p.hsValue) + '</span>' +
      (c.on ? '<span class="nt-opt__tag" style="color:var(--nu-accent)">' + U.icon.check.replace('<svg', '<svg width="16" height="16"') + '</span>' : '') + '</button>';
  }
  function groupsHtml(groups, side) {
    var i = 0, h = '';
    groups.forEach(function (g) {
      h += '<div class="nt-opt-head">' + esc(g.title) + '</div>';
      if (!g.items.length) h += '<div class="nt-opt-empty">' + (side === 'give' && !S.st.myRoster.length && g.title === 'Your roster' ? 'No roster yet. Type a name to add players.' : 'No matches.') + '</div>';
      g.items.forEach(function (c) { h += optHtml(c, side, i++); });
    });
    return h;
  }

  /* --------------------------------------------------------- inline combobox */
  function bindCombo(side) {
    var input = $('nt-' + side + '-q'), box = $('nt-' + side + '-opts'), active = -1;
    function opts() { return box.querySelectorAll('.nt-opt'); }
    function open() {
      box.innerHTML = groupsHtml(candidates(side, input.value), side);
      box.hidden = false; input.setAttribute('aria-expanded', 'true'); active = -1; input.removeAttribute('aria-activedescendant');
      U.hydrateImages && U.hydrateImages(box);
    }
    function close() { box.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
    function move(d) {
      var o = opts(); if (!o.length) return;
      if (active >= 0 && o[active]) o[active].classList.remove('is-active');
      active = (active + d + o.length) % o.length;
      o[active].classList.add('is-active'); o[active].scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', o[active].id);
    }
    input.addEventListener('focus', open);
    input.addEventListener('input', open);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (box.hidden) open(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { var o = opts(); var t = o[active >= 0 ? active : 0]; if (t && !box.hidden) { e.preventDefault(); t.click(); } }
      else if (e.key === 'Escape') { close(); }
    });
    box.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus in the input
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-opt]'); if (!b) return;
      pick(side, b.getAttribute('data-opt'));
      input.value = ''; open();
    });
    document.addEventListener('click', function (e) { if (!box.contains(e.target) && e.target !== input) close(); });
    input.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== input) close(); }, 120); });
  }

  // Add (or toggle) a player on a side. Giving a player who isn't on the manual roster adds him to it.
  function pick(side, id) {
    id = String(id);
    change(function () {
      if (side === 'give' && !isYahoo() && S.st.myRoster.indexOf(id) < 0 && S.st.myRoster.length < 25) S.st.myRoster.push(id);
      S.st = L.toggle(S.st, side, id);
    });
  }

  /* --------------------------------------------------------- pick sheet (phones) */
  function renderPickSheet() {
    var side = S.pickSide; if (!side) return;
    $('nt-pick-t').textContent = side === 'give' ? 'Add a Player You Give' : 'Add a Player You Get';
    $('nt-pick-q').placeholder = side === 'give' ? 'Search your roster' : (isYahoo() ? 'Search their roster' : 'Search any player');
    $('nt-pick-list').innerHTML = groupsHtml(candidates(side, $('nt-pick-q').value), side);
    var n = S.st[side].length;
    $('nt-pick-done').textContent = n ? 'Done · ' + n + ' selected' : 'Done';
    U.hydrateImages && U.hydrateImages($('nt-pick-list'));
  }
  function openPick(side) {
    if (side === 'get' && isYahoo() && !partnerTeam()) { $('nt-partner').focus(); U.toast('Pick a trade partner first'); return; }
    S.pickSide = side; $('nt-pick-q').value = '';
    renderPickSheet();
    U.sheet.open('nt-pick-sheet', { initialFocus: '#nt-pick-q', onClose: function () { S.pickSide = null; } });
  }

  /* --------------------------------------------------------- roster sheet */
  function renderRosterSheet() {
    var yahoo = isYahoo();
    var mine = rosterPlayers();
    $('nt-roster-tools').hidden = yahoo;
    $('nt-import').hidden = yahoo;
    $('nt-roster-clear').hidden = yahoo || !mine.length;
    $('nt-roster-hint').textContent = yahoo ? 'Loaded from your Sleeper team.' : 'The calculator needs your whole team to know who would start. Add all 14 players, bench included.';
    $('nt-roster-n').textContent = mine.length + ' player' + (mine.length === 1 ? '' : 's') + (yahoo ? '' : ' · ' + Math.max(0, 14 - mine.length) + ' to go');
    if (!yahoo && mine.length >= 14) $('nt-roster-n').textContent = mine.length + ' players';
    var html = mine.map(function (p) {
      return '<div class="nu-row nu-row--compact">' + playerBlock(p, 'sm') + '<div class="nu-row__end"><span class="nu-row__num"><b>' + f1(p.hsValue) + '</b></span>' +
        (yahoo ? '' : '<button type="button" class="nu-btn nu-btn--ghost nu-btn--icon nu-btn--sm" data-remove="' + esc(p.id) + '" data-from="roster" aria-label="Remove ' + esc(p.name) + ' from your roster">' + U.icon.close + '</button>') + '</div></div>';
    }).join('');
    if (yahoo) (myTeam() || { players: [] }).players.filter(function (y) { return !y.sleeperId; }).forEach(function (y) {
      html += '<div class="nu-row nu-row--compact" style="opacity:.55">' + U.playerCell({ name: y.name }, { size: 'sm', meta: '<span>Not matched to the model</span>' }) + '</div>';
    });
    $('nt-roster-list').innerHTML = html || U.emptyState({ title: 'No Players Yet', body: 'Search above, or import the team you marked as yours on the draft board.' });
    var q = $('nt-roster-q').value;
    var res = q ? L.search(S.players, q, 30).filter(function (p) { return S.st.myRoster.indexOf(String(p.id)) < 0; }).slice(0, 6) : [];
    $('nt-roster-opts').innerHTML = res.map(function (p, i) { return optHtml({ p: p, on: false }, 'roster', i); }).join('');
    U.hydrateImages && U.hydrateImages($('nt-roster-sheet'));
  }

  /* --------------------------------------------------------- verdict */
  var VICON = {
    good: U.icon.check,
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h13l-3-3M20 15H7l3 3"/></svg>',
    bad: U.icon.close
  };

  function emptyVerdict() {
    var st = S.st, n = st.myRoster.length, yahoo = isYahoo();
    var steps = [
      { done: n >= 9, html: yahoo ? '<b>Your roster</b> is loaded from Sleeper.' : '<b>Add your roster</b> so we know who starts. <button type="button" class="nu-btn nu-btn--sm nu-btn--ghost" data-act="roster" style="margin-left:4px">' + (n ? n + '/14 added' : 'Add Players') + '</button>' },
      { done: st.give.length > 0, html: '<b>Pick who you give.</b> Tap “Add” under You Give.' },
      { done: st.get.length > 0, html: yahoo ? '<b>Pick a partner and who you get.</b>' : '<b>Pick who you get.</b> Any player works.' }
    ];
    if (yahoo) steps[0].done = true;
    var ex = !yahoo && !n && !st.give.length && !st.get.length && S.players.length ? '<button type="button" class="nu-btn nu-btn--block" data-act="example" style="margin-top:var(--nu-5)">Try an Example Trade</button>' : '';
    return '<div class="nu-eyebrow">Verdict</div><h2 class="nu-title" style="margin-top:6px">Build a Trade</h2>' +
      '<p class="nu-body" style="margin-top:6px">You get Accept, Counter or Decline, with the points per week it adds or costs you.</p>' +
      '<ol class="nt-steps">' + steps.map(function (s) { return '<li class="' + (s.done ? 'is-done' : '') + '"><span>' + s.html + '</span></li>'; }).join('') + '</ol>' + ex;
  }

  function rangesHtml(r) {
    var ax = L.rangeAxis(r); if (!ax) return '';
    var row = function (who, s) {
      var t = s.perWeek > 0.05 ? 'up' : s.perWeek < -0.05 ? 'down' : 'flat';
      var lo = ax.at(s.perWeekRange[0]), hi = ax.at(s.perWeekRange[1]);
      return '<div class="nt-rrow" data-tone="' + t + '"><span class="nt-rrow__who">' + esc(who) + '</span>' +
        '<div class="nt-rtrack" role="img" aria-label="' + esc(who + ': likely ' + L.range(s.perWeekRange) + ' points a week, best guess ' + L.signed(s.perWeek)) + '">' +
        '<span class="nt-rtrack__zero" style="left:50%"></span><span class="nt-rtrack__band" style="left:' + lo + '%;width:' + Math.max(1, hi - lo) + '%"></span>' +
        '<span class="nt-rtrack__mark" style="left:' + ax.at(s.perWeek) + '%"></span></div></div>';
    };
    return '<div class="nt-ranges">' + row('You', r.you) + row(r.them.estimated ? 'Typical' : 'Them', r.them) +
      '<div class="nt-raxis"><span></span><div><span>−' + ax.max + '</span><span>0</span><span>+' + ax.max + '</span></div></div>' +
      '<p class="nt-rcap">Likely range, points per week. You: ' + esc(L.range(r.you.perWeekRange)) + '.</p></div>';
  }

  function fairHtml(r) {
    var f = L.fairness(r); if (!f) return '';
    var title = f.axis === 'value' ? 'Value' : 'Fairness';
    return '<div class="nt-fair"><div class="nt-fair__head"><span class="nu-label">' + title + '</span><span class="nt-fair__label">' + esc(f.label) + '</span></div>' +
      '<div class="nt-fair__track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(f.pos * 100) + '" aria-label="' + title + ': ' + esc(f.label) + '">' +
      '<span class="nt-fair__even" aria-hidden="true"></span><span class="nt-fair__dot" style="left:' + (f.pos * 100).toFixed(1) + '%"></span></div>' +
      '<div class="nt-fair__ends"><span>Favors Them</span><span>Even</span><span>Favors You</span></div>' +
      (f.line ? '<p class="nt-fair__line">' + esc(f.line) + '. League-neutral: the verdict above is about your lineup.</p>' : '') + '</div>';
  }

  // The value line is the meter's caption; the fit line sits under it.
  function summaryHtml(r) {
    var s = r.summary;
    if (!s || !s.fitLine) return '';
    return '<ul class="nt-summary"><li><b>Fit:</b> ' + esc(L.cleanText(s.fitLine.replace(/^Fit:\s*/, ''))) + '</li></ul>';
  }

  function renderVerdict() {
    var box = $('nt-verdict'), r = S.result, st = S.st;
    box.setAttribute('aria-busy', S.busy ? 'true' : 'false');
    var has = L.canEvaluate(st) && r && r.verdict;
    if (!has) {
      box.removeAttribute('data-tone');
      if (S.error && L.canEvaluate(st)) box.innerHTML = '<div class="nu-eyebrow">Verdict</div>' + '<div style="margin-top:var(--nu-3)">' + U.callout('error', '<b>Couldn\'t score this trade.</b> ' + esc(S.error)) + '</div>';
      else if (L.canEvaluate(st) && (S.busy || S.loading)) box.innerHTML = '<div class="nu-eyebrow">Verdict</div><span class="nu-skel" style="display:block;width:55%;height:34px;margin-top:14px"></span><span class="nu-skel" style="display:block;width:90%;margin-top:16px"></span><div class="nu-stats nu-stats--2" style="margin-top:16px">' + U.skeleton(2, { kind: 'tile' }) + '</div>';
      else box.innerHTML = emptyVerdict();
      $('nt-why-card').hidden = true; $('nt-lineup-card').hidden = true; $('nt-weeks-card').hidden = true;
      $('nt-fit-card').hidden = true; $('nt-signals-card').hidden = true;
      renderRules(null); renderBar(); return;
    }
    var tone = L.verdictTone(r.verdict);
    box.setAttribute('data-tone', tone);
    var who = themName();
    var tile = function (label, s, sub) {
      return '<div class="nt-vstat"><div class="nt-vstat__who">' + esc(label) + '</div><div class="nt-vstat__num ' + dir(s.perWeek) + '">' + L.signed(s.perWeek) + '<small>/wk</small></div>' +
        '<div class="nt-vstat__sub">' + esc(sub) + '</div></div>';
    };
    var horizon = L.horizonLabel(r.options && r.options.horizon);
    var span = horizon === 'Rest of Season' ? 'season total' : horizon === 'Playoffs' ? 'over the playoffs' : 'over 4 weeks';
    box.innerHTML =
      '<div class="nt-vword"><span class="nt-vword__icon" aria-hidden="true">' + VICON[tone] + '</span><div class="nt-vword__txt"><span class="nt-vword__word">' + esc(r.verdict) + '</span>' +
      '<span class="nt-vword__meta">' + esc(horizon) + ' · ' + esc(r.meta.weeks) + ' week' + (r.meta.weeks === 1 ? '' : 's') + '</span></div></div>' +
      '<p class="nt-oneliner">' + esc(L.oneLiner(r, r.them.estimated ? 'a typical team' : (partnerTeam() ? partnerTeam().name : 'they'))) + '</p>' +
      '<div class="nt-vstats">' + tile('You', r.you, L.signed(r.you.ros, 0) + ' ' + span) + tile(who, r.them, L.signed(r.them.ros, 0) + ' ' + span) + '</div>' +
      rangesHtml(r) + fairHtml(r) + summaryHtml(r) +
      '<div class="nt-likely" data-l="' + esc(r.them.likely) + '"><span class="nu-dot" aria-hidden="true"></span><span>' + esc(L.likelyText(r.them.likely, r.them.estimated)) + '.' + (r.them.estimated ? ' Connect Sleeper for their real roster.' : '') + '</span></div>' +
      '<div class="nt-vactions"><button type="button" class="nu-btn" data-act="copy">Copy Trade Summary</button><button type="button" class="nu-btn nu-btn--ghost" data-act="clear">Clear Trade</button></div>';
    renderWhy(r); renderFit(r); renderSignals(r); renderLineup(r); renderWeeks(r); renderRules(r.meta && r.meta.rules); renderBar(); renderLens();
  }

  /* --------------------------------------------------------- v2: team fit + player signals */
  function tierTag(t) { return '<span class="nt-tier"' + (L.tierTone(t) ? ' data-tone="' + L.tierTone(t) + '"' : '') + '>' + esc(L.tierLabel(t)) + '</span>'; }
  function renderFit(r) {
    var rows = L.fitRows(r.fit);
    if (!rows.length) { $('nt-fit-card').hidden = true; return; }
    $('nt-fit-scope').textContent = r.fit.leagueRelative ? 'Vs Your League' : 'Depth Only';
    $('nt-fit').innerHTML = rows.map(function (x) {
      return '<li class="' + (x.changed ? 'is-changed' : '') + '"><span class="nt-fit__g"><b>' + esc(x.name) + '</b><small>' + esc(x.depth) + '</small></span>' +
        '<span class="nt-fit__t">' + tierTag(x.tierBefore) + (x.changed ? '<span class="nt-fit__arrow" aria-label="becomes">→</span>' + tierTag(x.tierAfter) : '') + '</span>' +
        '<span class="nt-fit__d ' + dir(x.delta) + '">' + (Math.abs(x.delta) >= 0.05 ? L.signed(x.delta) + '/wk' : '—') + '</span></li>';
    }).join('');
    $('nt-fit-notes').innerHTML = (r.fit.notes || []).map(function (n) { return '<li>' + esc(L.cleanText(n)) + '.</li>'; }).join('');
    var them = r.themFit ? L.fitRows(r.themFit).filter(function (x) { return x.changed; }) : [];
    var tn = partnerTeam() ? partnerTeam().name : 'Their team';
    $('nt-fit-them').hidden = !r.themFit;
    $('nt-fit-them').innerHTML = r.themFit ? '<b>' + esc(tn) + ':</b> ' + (them.length ? them.map(function (x) { return esc(x.name) + ' ' + esc(L.tierLabel(x.tierBefore)) + ' → ' + esc(L.tierLabel(x.tierAfter)); }).join(' · ') : 'no tier changes') + '.' : '';
    $('nt-fit-card').hidden = false;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDay(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) : null; }
  function renderSignals(r) {
    var ps = (r.players || []).filter(function (p) { return p.signals; });
    if (!ps.length) { $('nt-signals-card').hidden = true; return; }
    $('nt-sig').innerHTML = ps.map(function (rp) {
      var p = S.byId[rp.id] || { id: rp.id, name: rp.name, team: rp.team, pos: rp.elig };
      var stats = L.signalStats(rp).map(function (x) { return '<div class="nt-sig__stat"><dt>' + esc(x.k) + '</dt><dd>' + esc(x.v) + '</dd></div>'; }).join('');
      return '<li><div class="nt-sig__head">' + playerBlock(p, 'sm') + '<span class="nt-sig__side" data-side="' + rp.side + '">' + (rp.side === 'give' ? 'You Give' : 'You Get') + '</span></div>' +
        chipsHtml(L.signalChips(rp.signals)) +
        '<dl class="nt-sig__stats">' + stats + '</dl>' +
        '<ul class="nt-sig__why">' + (rp.why || []).map(function (w) { return '<li>' + esc(L.cleanText(w)) + '</li>'; }).join('') + '</ul></li>';
    }).join('');
    var d = r.dataAsOf || {};
    var bits = [];
    if (d.board) bits.push('Model ' + shortDay(d.board));
    if (d.market) bits.push('Market ' + shortDay(d.market));
    if (d.logsSeason) bits.push(d.logsSeason + '-' + String((d.logsSeason + 1) % 100) + ' logs');
    $('nt-sig-asof').textContent = bits.join(' · ');
    $('nt-signals-card').hidden = false;
    U.hydrateImages && U.hydrateImages($('nt-signals-card'));
  }

  function renderWhy(r) {
    var items = L.whyItems(r, S.byId);
    var ic = { good: '+', bad: '−', warn: '!', flat: '·' };
    $('nt-why').innerHTML = items.map(function (w) { return '<li data-tone="' + w.tone + '"><span class="nt-why__ic" aria-hidden="true">' + ic[w.tone] + '</span><span>' + esc(w.text) + '</span></li>'; }).join('');
    var notes = L.rosterNotes(r).map(function (n) { return U.callout('info', esc(n)); });
    (r.warnings || []).forEach(function (w) { notes.push(U.callout('warn', esc(L.cleanText(w)))); });
    $('nt-notes').innerHTML = notes.join('');
    $('nt-notes').hidden = !notes.length;
    $('nt-why-card').hidden = !items.length && !notes.length;
  }

  function slotWho(x, size) {
    if (!x || !x.id) return '<span class="nt-slot__repl">' + (x && x.replacement ? 'Waiver add' : 'Empty') + '</span>';
    var p = S.byId[x.id] || { id: x.id, name: x.name };
    return '<span class="nt-slot__who">' + U.avatar(p, { size: size || 'sm' }) + '<span class="nt-slot__name">' + esc(x.name) + '</span></span>';
  }
  function renderLineup(r) {
    var rows = L.lineupRows(r);
    if (!rows.length) { $('nt-lineup-card').hidden = true; return; }
    $('nt-slots').innerHTML = rows.map(function (x) {
      var who = x.changed
        ? '<div class="nt-slot__stack">' + slotWho(x.after) + '<span class="nt-slot__was">was <span class="nt-slot__name">' + esc(x.before && x.before.id ? x.before.name : (x.before && x.before.replacement ? 'Waiver add' : 'Empty')) + '</span></span></div>'
        : slotWho(x.after);
      return '<li class="nt-slot' + (x.changed ? ' is-changed' : '') + '">' + '<span class="nu-slot">' + U.posPill(x.slot) + '</span>' + who +
        '<span class="nt-slot__num">' + f1(x.after.value) + (x.changed ? U.delta(x.delta) : '') + '</span></li>';
    }).join('');
    var sumB = r.lineup.before.starters.reduce(function (s, x) { return s + (x.value || 0); }, 0);
    var sumA = r.lineup.after.starters.reduce(function (s, x) { return s + (x.value || 0); }, 0);
    $('nt-lu-delta').innerHTML = U.delta(Math.round((sumA - sumB) * 10) / 10);
    var bench = r.lineup.after.bench || [];
    $('nt-bench').innerHTML = bench.length ? '<span class="nu-label">Bench</span>' + bench.map(function (x) {
      var p = S.byId[x.id] || { id: x.id, name: x.name };
      return '<span class="nt-bench__p">' + U.avatar(p, { size: 'xs' }) + esc(x.name) + '</span>';
    }).join('') : '';
    $('nt-bench').hidden = !bench.length;
    $('nt-lineup-card').hidden = false;
    U.hydrateImages && U.hydrateImages($('nt-lineup-card'));
  }

  function renderWeeks(r) {
    var bars = L.weekBars(r.weeks);
    if (bars.length < 2) { $('nt-weeks-card').hidden = true; return; }
    $('nt-weeks').innerHTML = bars.map(function (b) {
      var pct = Math.round(Math.abs(b.h) * 48);
      var title = 'Week ' + b.week + ': ' + L.signed(b.you) + '/wk' + (b.games ? ' · games ' + (b.games > 0 ? '+' : '−') + Math.abs(b.games) : '') + (b.playoff ? ' · playoffs' : '');
      return '<div class="nt-wk' + (b.playoff ? ' po' : '') + '" title="' + esc(title) + '"><i class="' + (b.h >= 0 ? 'up' : 'dn') + '" style="height:' + pct + '%"></i></div>';
    }).join('');
    var ys = bars.map(function (b) { return b.you; });
    $('nt-weeks').setAttribute('aria-label', 'Change in your weekly score by week, from ' + L.signed(Math.min.apply(null, ys)) + ' to ' + L.signed(Math.max.apply(null, ys)));
    $('nt-wk-axis').innerHTML = '<span>Wk ' + bars[0].week + '</span><span>Wk ' + bars[bars.length - 1].week + '</span>';
    $('nt-weeks-sum').innerHTML = '<span class="' + dir(r.you.ros) + '">' + L.signed(r.you.ros, 0) + ' season</span>';
    var hasPo = bars.some(function (b) { return b.playoff; });
    $('nt-legend').textContent = 'Up = you gain that week, down = you lose. Bars swing with how many games each side plays.' + (hasPo ? ' Orange marks playoff weeks (count ' + r.meta.playoffWeight + '×).' : '');
    $('nt-weeks-card').hidden = false;
  }

  function renderRules(rules) {
    var chips = L.ruleChips(rules), el = $('nt-rules');
    el.hidden = !chips.length;
    el.innerHTML = chips.length ? U.icon.info + '<span class="nu-sr">League trade rules:</span>' + chips.map(function (c) { return '<span class="nu-tag"' + (c.tone ? ' data-tone="' + c.tone + '"' : '') + '>' + esc(c.text) + '</span>'; }).join('') : '';
  }

  var verdictVisible = true;
  function renderBar() {
    var bar = $('nt-actionbar'), r = S.result;
    var show = !!(r && r.verdict && L.canEvaluate(S.st) && !verdictVisible);
    bar.hidden = !show;
    if (!r || !r.verdict) return;
    bar.setAttribute('data-tone', L.verdictTone(r.verdict));
    $('nt-ab-pill').textContent = r.verdict;
    $('nt-ab-title').textContent = 'Give ' + S.st.give.length + ' · Get ' + S.st.get.length;
    $('nt-ab-sub').textContent = 'You ' + L.signed(r.you.perWeek) + '/wk · ' + (r.them.estimated ? 'Typical' : 'Them') + ' ' + L.signed(r.them.perWeek) + '/wk';
  }

  function render() {
    renderMode(); renderSides(); renderVerdict();
    if (S.pickSide) renderPickSheet();
    if (U.sheet.isOpen() && !$('nt-roster-sheet').hidden) renderRosterSheet();
  }

  /* ------------------------------------------------------ evaluate */
  function schedule() {
    clearTimeout(S.timer);
    if (!L.canEvaluate(S.st)) { S.result = null; S.error = null; S.busy = false; renderVerdict(); return; }
    S.busy = true; renderVerdict();
    S.timer = setTimeout(evaluate, 220);
  }
  function evaluate() {
    var seq = ++S.seq;
    api('/api/nba/trade/evaluate', { method: 'POST', body: L.requestBody(S.st, S.ctx) }).then(function (r) {
      if (seq !== S.seq) return;
      S.result = r; S.error = null;
    }).catch(function (e) {
      if (seq !== S.seq) return;
      if (e.code === 'horizon_unavailable' && S.st.horizon !== 'ros') { S.st.horizon = 'ros'; save(); U.toast('The Playoffs view opens in week ' + L.PLAYOFFS_FROM_WEEK); schedule(); return; }
      S.result = null;
      S.error = e.status === 429 ? 'Too many changes at once. Try again in a few seconds.' : e.status === 503 ? 'Player data is unavailable right now.'
        : e.code === 'league_not_points' ? 'This is a categories league. The calculator values points leagues only; switch to Manual to try a trade.' : (e.message || 'Network error');
    }).then(function () {
      if (seq !== S.seq) return;
      S.busy = false; renderSides(); renderVerdict();
    });
  }

  function change(fn) { fn(); save(); render(); schedule(); }

  /* ------------------------------------------------------ board (per league profile) */
  // A Sleeper league's board is valued under that league's own profile (/api/nba/players?league_id=);
  // manual mode uses the stored default profile. A failed league board falls back to the default.
  function loadBoard(leagueKey) {
    var key = leagueKey || '';
    if (S.boardKey === key && S.players.length) return Promise.resolve();
    var url = key ? '/api/nba/players?league_id=' + encodeURIComponent(key) : '/api/nba/players?profile=' + PROFILE;
    var apply = function (d) {
      S.players = (d.players || []).slice().sort(function (a, b) { return (a.rank || 1e9) - (b.rank || 1e9); });
      S.byId = {}; S.players.forEach(function (p) { S.byId[String(p.id)] = p; });
      S.profileName = d.profile && d.profile.name || null;
      S.currentWeek = d.currentWeek || null;
      S.boardKey = key;
      if (!L.horizonAvailable(S.st.horizon, S.currentWeek)) S.st.horizon = 'ros';
    };
    return api(url).then(apply).catch(function (e) {
      if (key) return api('/api/nba/players?profile=' + PROFILE).then(apply);
      throw e;
    });
  }

  /* ------------------------------------------------------ sleeper */
  function initSleeper() {
    // One shared status fetch with the nav chip (sleeper-chip.js) when it's loaded.
    var status = window.PocketSleeper && window.PocketSleeper.status ? window.PocketSleeper.status() : Promise.resolve({ connected: false });
    return status.then(function (s) {
      S.connected = !!(s && s.connected); S.leagues = (s && s.leagues) || []; S.userId = (s && s.userId) || null; S.username = (s && s.username) || null;
      if (s && s.connected && (s.httpStatus || s.code)) banner('Sleeper isn’t responding right now. Manual mode still works.', 'error');
    }).catch(function () { S.connected = false; S.leagues = []; }).then(function () {
      var sel = $('nt-league');
      var deep = S.deep;
      S.deep = null;
      if (deep) { try { history.replaceState(null, '', location.pathname); } catch (e) {} }
      // Team page "Open in Trade" link: that league + partner + players (public league data, so it
      // works before connecting; my team is the one holding the players I give).
      if (deep && deep.leagueId) {
        if (S.connected && S.leagues.length) {
          var known = S.leagues.some(function (l) { return l.league_key === deep.leagueId; });
          sel.innerHTML = (known ? '' : '<option value="' + esc(deep.leagueId) + '">League From Link</option>') +
            S.leagues.map(function (l) { return '<option value="' + esc(l.league_key) + '">' + esc(l.name) + ' · ' + esc(l.num_teams) + ' teams</option>'; }).join('') + '<option value="">Manual (no league)</option>';
          sel.value = deep.leagueId; sel.hidden = false; $('nt-connect').hidden = true;
        } else { sel.hidden = true; $('nt-connect').hidden = S.connected; }
        return selectLeague(deep.leagueId, deep);
      }
      if (deep && (deep.give.length || deep.get.length)) {
        S.st.mode = 'manual'; S.st.leagueKey = S.connected ? '' : null; S.ctx = null;
        S.st.give = deep.give; S.st.get = deep.get;
        deep.give.forEach(function (id) { if (S.st.myRoster.indexOf(id) < 0 && S.st.myRoster.length < 25) S.st.myRoster.push(id); });
        if (deep.horizon) S.st.horizon = deep.horizon;
        save();
      }
      if (!S.connected || !S.leagues.length) {
        $('nt-connect').hidden = S.connected;
        sel.hidden = true;
        if (S.st.mode === 'sleeper') { S.st.mode = 'manual'; S.st.give = []; S.st.get = []; S.st.myRoster = []; save(); }
        return loadBoard(null);
      }
      $('nt-connect').hidden = true;
      sel.innerHTML = S.leagues.map(function (l) { return '<option value="' + esc(l.league_key) + '">' + esc(l.name) + ' · ' + esc(l.num_teams) + ' teams</option>'; }).join('') +
        '<option value="">Manual (no league)</option>';
      var pref = null; try { pref = localStorage.getItem('pocket-nba-league'); } catch (e) {}
      var pick = S.st.mode === 'sleeper' && S.leagues.some(function (l) { return l.league_key === S.st.leagueKey; }) ? S.st.leagueKey
        : S.st.mode === 'manual' && S.st.leagueKey === '' ? ''
        : S.leagues.some(function (l) { return l.league_key === pref; }) ? pref : S.leagues[0].league_key;
      sel.value = pick; sel.hidden = false;
      return selectLeague(pick || null);
    });
  }

  function selectLeague(key, deep) {
    if (!key) {
      if (S.st.mode === 'sleeper') { S.st = Object.assign(L.emptyState(), { leagueKey: '', horizon: S.st.horizon, lean: S.st.lean }); }
      S.st.leagueKey = ''; S.ctx = null; save();
      return loadBoard(null).catch(function () {}).then(function () { render(); schedule(); });
    }
    var same = S.st.mode === 'sleeper' && S.st.leagueKey === key;
    banner(null);
    return api('/api/nba/trade/context?league_id=' + encodeURIComponent(key) + (S.userId ? '&user_id=' + encodeURIComponent(S.userId) : '')).then(function (ctx) {
      var myKey = ctx.myTeamKey;
      if (!myKey && deep && deep.give.length) { var holder = L.teamHolding(ctx, deep.give); if (holder) myKey = holder.team_key; }
      if (!myKey) { var e0 = new Error('@' + (S.username || 'you') + ' doesn’t own a team in this league'); e0.code = 'not_in_league'; throw e0; }
      S.ctx = ctx;
      var st = S.st;
      st.mode = 'sleeper'; st.leagueKey = key; st.myTeamKey = myKey;
      st.myRoster = L.rosterIds(L.teamOf(ctx, myKey));
      var skipped = 0;
      if (deep) {
        var pk = deep.partner && L.teamOf(ctx, deep.partner) ? deep.partner : (L.teamHolding(ctx, deep.get) || {}).team_key || null;
        st.partnerKey = pk && pk !== myKey ? pk : null;
        var theirs0 = st.partnerKey ? L.rosterIds(L.teamOf(ctx, st.partnerKey)) : [];
        st.give = deep.give.filter(function (id) { return st.myRoster.indexOf(id) >= 0; });
        st.get = deep.get.filter(function (id) { return theirs0.indexOf(id) >= 0; });
        skipped = deep.give.length + deep.get.length - st.give.length - st.get.length;
        if (deep.horizon) st.horizon = deep.horizon;
      } else {
        if (!same || !L.teamOf(ctx, st.partnerKey) || st.partnerKey === st.myTeamKey) st.partnerKey = null;
        var theirs = st.partnerKey ? L.rosterIds(L.teamOf(ctx, st.partnerKey)) : [];
        st.give = st.give.filter(function (id) { return st.myRoster.indexOf(id) >= 0; });
        st.get = st.get.filter(function (id) { return theirs.indexOf(id) >= 0; });
      }
      var msgs = [];
      if (skipped > 0) msgs.push(skipped + ' player' + (skipped > 1 ? 's' : '') + ' from the link ' + (skipped > 1 ? 'aren\'t' : 'isn\'t') + ' on those rosters anymore and ' + (skipped > 1 ? 'were' : 'was') + ' left out.');
      if (ctx.unmatched && ctx.unmatched.length) msgs.push(ctx.unmatched.length + ' Sleeper player' + (ctx.unmatched.length > 1 ? 's' : '') + ' couldn\'t be matched to the model and ' + (ctx.unmatched.length > 1 ? 'are' : 'is') + ' left out.');
      if (msgs.length) banner(msgs.join(' '));
      save();
      return loadBoard(key).catch(function () {}).then(function () { render(); schedule(); });
    }).catch(function (e) {
      S.ctx = null; S.st.mode = 'manual'; S.st.leagueKey = '';
      $('nt-league').value = '';
      banner(e.code === 'not_in_league' ? e.message + '. Manual mode still works.' : e.status === 429 ? 'Sleeper is rate-limiting us. Try again in a few seconds; manual mode still works.' : 'Couldn\'t load the Sleeper league (' + (e.status || 'network') + '). Manual mode still works.', 'error');
      save();
      return loadBoard(null).catch(function () {}).then(function () { render(); schedule(); });
    });
  }

  /* ------------------------------------------------------ clerk (account button in the nav) */
  function initClerk() {
    var key = window.__clerk_publishable_key;
    if (!key || key.indexOf('PLACEHOLDER') >= 0) return;
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
    s.crossOrigin = 'anonymous'; s.async = true;
    s.onload = function () {
      try {
        var clerk = (window.Clerk && typeof window.Clerk.load === 'function') ? window.Clerk : new window.Clerk(key);
        clerk.load({ telemetry: { disabled: true } }).catch(function () {});
      } catch (e) { console.warn('Clerk init failed', e); }
    };
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------ clipboard */
  function copySummary() {
    var p = partnerTeam();
    var text = L.summaryText(S.result, S.st, S.byId, p ? p.name : null);
    var done = function () { U.toast('Trade summary copied', { tone: 'good' }); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      if (ok) done(); else U.toast('Copy failed. Select and copy manually.', { tone: 'bad' });
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  /* ------------------------------------------------------ boot */
  function bind() {
    document.addEventListener('click', function (e) {
      var rm = e.target.closest('[data-remove]');
      if (rm) {
        var id = rm.getAttribute('data-remove'), from = rm.getAttribute('data-from');
        change(function () {
          if (from === 'roster') { S.st.myRoster = S.st.myRoster.filter(function (x) { return x !== id; }); S.st.give = S.st.give.filter(function (x) { return x !== id; }); }
          else S.st[from] = S.st[from].filter(function (x) { return x !== id; });
        });
        return;
      }
      var opt = e.target.closest('#nt-pick-list [data-opt]');
      if (opt) { pick(S.pickSide, opt.getAttribute('data-opt')); return; }
      var ro = e.target.closest('#nt-roster-opts [data-opt]');
      if (ro) {
        var rid = ro.getAttribute('data-opt');
        change(function () { if (S.st.myRoster.length < 25 && S.st.myRoster.indexOf(rid) < 0) S.st.myRoster.push(rid); S.st.get = S.st.get.filter(function (x) { return x !== rid; }); });
        $('nt-roster-q').value = ''; renderRosterSheet(); $('nt-roster-q').focus();
        return;
      }
      var pk = e.target.closest('[data-pick]');
      if (pk) { openPick(pk.getAttribute('data-pick')); return; }
      var act = e.target.closest('[data-act]');
      if (act) {
        var a = act.getAttribute('data-act');
        if (a === 'copy') copySummary();
        if (a === 'clear') change(function () { S.st.give = []; S.st.get = []; });
        if (a === 'roster') openRoster();
        if (a === 'example') {
          var ex = L.exampleTrade(S.players);
          if (ex) change(function () { S.st.myRoster = ex.myRoster; S.st.give = ex.give; S.st.get = ex.get; });
        }
      }
    });
    bindCombo('give'); bindCombo('get');
    $('nt-pick-q').addEventListener('input', renderPickSheet);
    $('nt-roster-q').addEventListener('input', renderRosterSheet);
    $('nt-roster-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var b = $('nt-roster-opts').querySelector('[data-opt]'); if (b) { e.preventDefault(); b.click(); } } });
    $('nt-roster-btn').addEventListener('click', openRoster);
    $('nt-how').addEventListener('click', function () { U.sheet.open('nt-how-sheet'); });
    $('nt-import').addEventListener('click', function () {
      var raw = null; try { raw = localStorage.getItem(L.DRAFT_KEY); } catch (e) {}
      var ids = L.draftImport(raw).filter(function (id) { return S.byId[id]; });
      if (!ids.length) { U.toast('No players marked as yours on the draft board yet.'); return; }
      change(function () { S.st.myRoster = ids; S.st.give = []; S.st.get = S.st.get.filter(function (id) { return ids.indexOf(id) < 0; }); });
      renderRosterSheet(); U.toast('Imported ' + ids.length + ' players', { tone: 'good' });
    });
    $('nt-roster-clear').addEventListener('click', function () {
      var prev = { r: S.st.myRoster.slice(), g: S.st.give.slice() };
      change(function () { S.st.myRoster = []; S.st.give = []; });
      renderRosterSheet();
      U.toast('Roster cleared', { action: { label: 'Undo', onClick: function () { change(function () { S.st.myRoster = prev.r; S.st.give = prev.g; }); renderRosterSheet(); } } });
    });
    $('nt-league').addEventListener('change', function () { S.st.give = []; S.st.get = []; selectLeague(this.value || null); });
    $('nt-horizon').addEventListener('click', function (e) {
      var b = e.target.closest('[data-horizon]'); if (!b || b.disabled) return;
      var h = b.getAttribute('data-horizon'); if (h === S.st.horizon) return;
      change(function () { S.st.horizon = h; });
    });
    $('nt-lean').addEventListener('click', function (e) {
      var b = e.target.closest('[data-lean]'); if (!b) return;
      var l = b.getAttribute('data-lean');
      change(function () { S.st.lean = l; });
    });
    $('nt-partner').addEventListener('change', function () { var v = this.value || null; change(function () { S.st.partnerKey = v; S.st.get = []; }); });
    $('nt-ab-btn').addEventListener('click', function () {
      var t = $('nt-why-card').hidden ? $('nt-verdict') : $('nt-verdict');
      t.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { verdictVisible = es[0].isIntersecting; renderBar(); }, { threshold: 0.1 }).observe($('nt-verdict'));
    }
  }
  function openRoster() {
    $('nt-roster-q').value = '';
    renderRosterSheet();
    U.sheet.open('nt-roster-sheet', { initialFocus: isYahoo() ? undefined : '#nt-roster-q' });
  }

  function boot() {
    load(); bind(); initClerk();
    S.deep = L.parseDeepLink(location.search);
    render();
    // First board: the league we're about to open (deep link or saved league), so league mode
    // doesn't download two boards.
    var first = (S.deep && S.deep.leagueId) || (S.st.mode === 'sleeper' && S.st.leagueKey) || null;
    loadBoard(first).catch(function () {
      banner('Player data is unavailable right now. Try again in a minute.', 'error');
    }).then(function () {
      S.loading = false;
      render();
      return initSleeper();
    }).then(function () { render(); schedule(); });
  }
  // Connect / switch / disconnect from the nav chip → reload league mode.
  window.addEventListener('pocket-nba:account', function () { initSleeper().then(function () { render(); schedule(); }); });
  var connectBtn = $('nt-connect');
  if (connectBtn) connectBtn.addEventListener('click', function (e) { e.preventDefault(); if (window.PocketSleeper && window.PocketSleeper.openConnect) window.PocketSleeper.openConnect(); });
  boot();
})();
