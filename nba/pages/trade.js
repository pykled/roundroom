/* Pocket NBA — trade calculator controller (stream E).
   Board from /api/nba/players, verdict from POST /api/nba/trade/evaluate,
   Yahoo rosters from /api/nba/yahoo/status + /api/nba/trade/context.
   Works fully without Yahoo (manual roster, persisted in localStorage). */
(function () {
  'use strict';
  var L = window.NbaTrade;
  var $ = function (id) { return document.getElementById(id); };
  var S = {
    st: L.emptyState(), players: [], byId: {}, ctx: null, connected: false, leagues: [],
    editing: false, result: null, busy: false, seq: 0, timer: null, error: null
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function save() { try { localStorage.setItem(L.STORAGE_KEY, L.serialize(S.st)); } catch (e) {} }
  function load() { try { S.st = L.parseState(localStorage.getItem(L.STORAGE_KEY)); } catch (e) { S.st = L.emptyState(); } }
  function fmt(n) { return (Math.round((Number(n) || 0) * 10) / 10).toFixed(1); }
  function tone(n) { return n > 0.05 ? 'pos' : n < -0.05 ? 'neg' : ''; }

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
    if (!msg) { b.hidden = true; return; }
    b.className = 'nt-banner' + (kind === 'error' ? ' error' : '');
    b.textContent = msg; b.hidden = false;
  }

  /* --------------------------------------------------------- rows */
  function pips(p) {
    return (p.elig || []).filter(function (e) { return e === 'G' || e === 'F'; }).map(function (e) { return '<span class="pp ' + e + '">' + e + '</span>'; }).join('');
  }
  function injTag(p) {
    if (!p.injury) return '';
    var k = String(p.injury).toUpperCase();
    var short = /OUT|^O$|IR|SEASON/.test(k) ? 'OUT' : /SUS/.test(k) ? 'SUS' : /DTD|GTD|DAY/.test(k) ? 'GTD' : k.slice(0, 3);
    return '<span class="inj ' + (short === 'OUT' ? 'OUT' : '') + '">' + esc(short) + '</span>';
  }
  function row(p, side, on, opts) {
    opts = opts || {};
    if (!p) return '';
    var meta = pips(p) + '<span class="tm">' + esc(p.team || 'FA') + '</span>' + (p.games ? '<span>' + fmt(p.games) + ' g/wk</span>' : '') + injTag(p);
    var main = '<button type="button" class="nt-row-main" data-side="' + side + '" data-id="' + esc(p.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      '<span class="nt-check" aria-hidden="true">' + (on ? '✓' : '') + '</span>' +
      '<span class="nt-who"><span class="nt-name">' + esc(p.name) + '</span><span class="nt-meta">' + meta + '</span></span>' +
      '<span class="nt-val"><b>' + fmt(p.hsValue) + '</b><span>/wk</span></span></button>';
    var x = opts.remove ? '<button type="button" class="nt-x" data-remove="' + esc(p.id) + '" data-from="' + esc(opts.remove) + '" aria-label="Remove ' + esc(p.name) + '">×</button>' : '';
    return '<li class="nt-row' + (on ? ' on' : '') + '">' + main + x + '</li>';
  }
  function unmatchedRow(yp) {
    return '<li class="nt-row unmatched"><div class="nt-row-main"><span class="nt-check" aria-hidden="true"></span><span class="nt-who"><span class="nt-name">' + esc(yp.name) +
      '</span><span class="nt-meta">Not matched to the model, so not tradeable here</span></span></div></li>';
  }
  function sortByValue(list) { return list.slice().sort(function (a, b) { return (b.hsValue || 0) - (a.hsValue || 0); }); }

  function myTeam() { return S.st.mode === 'yahoo' ? L.teamOf(S.ctx, S.st.myTeamKey) : null; }
  function partnerTeam() { return S.st.mode === 'yahoo' ? L.teamOf(S.ctx, S.st.partnerKey) : null; }

  function renderLists() {
    var st = S.st, yahoo = st.mode === 'yahoo' && S.ctx;
    // ---- give side (my roster)
    var mine = sortByValue(st.myRoster.map(function (id) { return S.byId[id]; }).filter(Boolean));
    var html = '';
    if (!mine.length && !yahoo) {
      html = '<li class="nt-empty"><b>Add your roster</b>Search your players above, or import the team you marked as yours on the draft board.</li>';
    } else {
      html = mine.map(function (p) { return row(p, 'give', st.give.indexOf(p.id) >= 0, { remove: !yahoo && S.editing ? 'roster' : null }); }).join('');
      if (yahoo) (myTeam() || { players: [] }).players.filter(function (y) { return !y.sleeperId; }).forEach(function (y) { html += unmatchedRow(y); });
    }
    $('nt-my-list').innerHTML = html;
    $('nt-my-tools').hidden = !!yahoo || (!S.editing && mine.length > 0);
    $('nt-edit-roster').hidden = !!yahoo || !mine.length;
    $('nt-edit-roster').setAttribute('aria-pressed', S.editing ? 'true' : 'false');
    $('nt-edit-roster').textContent = S.editing ? 'Done' : 'Edit roster';
    $('nt-give-count').textContent = st.give.length ? st.give.length + ' selected' : (mine.length ? mine.length + ' on roster' : '');

    // ---- get side
    var partner = partnerTeam();
    $('nt-partner-tools').hidden = !yahoo;
    $('nt-get-tools').hidden = !!yahoo;
    if (yahoo) {
      var sel = $('nt-partner');
      var opts = '<option value="">Pick a trade partner</option>' + S.ctx.teams.filter(function (t) { return t.team_key !== st.myTeamKey; })
        .map(function (t) { return '<option value="' + esc(t.team_key) + '"' + (t.team_key === st.partnerKey ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('');
      if (sel.innerHTML !== opts) sel.innerHTML = opts;
      if (!partner) html = '<li class="nt-empty"><b>Pick a team</b>Their roster shows here; tap the players you want.</li>';
      else {
        var theirs = sortByValue(L.rosterIds(partner).map(function (id) { return S.byId[id]; }).filter(Boolean));
        html = theirs.map(function (p) { return row(p, 'get', st.get.indexOf(p.id) >= 0); }).join('');
        partner.players.filter(function (y) { return !y.sleeperId; }).forEach(function (y) { html += unmatchedRow(y); });
      }
    } else {
      var gets = st.get.map(function (id) { return S.byId[id]; }).filter(Boolean);
      html = gets.length ? gets.map(function (p) { return row(p, 'get', true, { remove: 'get' }); }).join('')
        : '<li class="nt-empty"><b>Who are you getting?</b>Search any player. Without their team\'s roster, a typical mid-draft roster stands in for the other side.</li>';
    }
    $('nt-get-list').innerHTML = html;
    $('nt-get-count').textContent = st.get.length ? st.get.length + ' selected' : '';
  }

  /* ------------------------------------------------------ verdict */
  function renderVerdict() {
    var box = $('nt-verdict'), r = S.result, st = S.st;
    box.classList.toggle('busy', S.busy);
    if (!L.canEvaluate(st) || !r || !r.verdict) {
      box.className = 'nt-verdict' + (S.busy ? ' busy' : '');
      box.innerHTML = S.error
        ? '<div class="nt-v-empty"><b>Couldn\'t score this trade</b>' + esc(S.error) + '</div>'
        : '<div class="nt-v-empty"><b>No trade yet</b>Tap players on your roster to give and pick players to get. The verdict updates as you go.</div>';
      $('nt-lineup-card').hidden = true; $('nt-weeks-card').hidden = true;
      renderVbar(); return;
    }
    var t = L.verdictTone(r.verdict);
    box.className = 'nt-verdict ' + t + (S.busy ? ' busy' : '');
    var them = r.them;
    var themWho = them.estimated ? 'Typical partner' : (partnerTeam() ? partnerTeam().name : 'Them');
    var h = '<div class="nt-v-top"><span class="nt-badge">' + esc(r.verdict) + '</span><span class="nt-v-label">Rest of season · ' + esc(r.meta.weeks) + ' wks</span></div>' +
      '<p class="nt-headline">' + esc(r.headline) + '</p>' +
      '<div class="nt-sides">' +
      stat('You', r.you) + stat(themWho, them) +
      '</div>' +
      '<p class="nt-likely">' + esc(L.likelyText(them.likely, them.estimated)) + '.' + (them.estimated ? ' Pick their team in a Yahoo league for their real roster.' : '') + '</p>';
    if (r.why && r.why.length) h += '<ul class="nt-why">' + r.why.filter(function (w) { return w !== r.consolidation; }).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
    if (r.consolidation) h += '<div class="nt-note">' + esc(r.consolidation) + '</div>';
    if (r.warnings && r.warnings.length) h += '<div class="nt-note">' + esc(r.warnings.join(' · ')) + '</div>';
    box.innerHTML = h;
    renderLineup(r); renderWeeks(r); renderVbar();
  }
  function stat(who, s) {
    return '<div class="nt-stat"><div class="who">' + esc(who) + '</div>' +
      '<div class="big ' + tone(s.perWeek) + '">' + L.signed(s.perWeek) + '<small>/wk</small></div>' +
      '<div class="rng">range ' + L.range(s.perWeekRange) + '</div>' +
      '<div class="ros">' + L.signed(s.ros, 0) + ' rest of season</div></div>';
  }

  function renderLineup(r) {
    var b = r.lineup.before.starters, a = r.lineup.after.starters;
    var cell = function (x, cls) {
      if (!x || !x.id) return '<td class="' + cls + ' repl">' + (x && x.replacement ? 'Waiver add' : 'Empty') + (x && x.value ? '<span class="v">' + fmt(x.value) + '</span>' : '') + '</td>';
      return '<td class="' + cls + '">' + esc(x.name) + '<span class="v">' + fmt(x.value) + '</span></td>';
    };
    var html = '<thead><tr><th>Slot</th><th>Now</th><th>After</th></tr></thead><tbody>';
    for (var i = 0; i < a.length; i++) {
      var chg = r.lineup.changed.indexOf(a[i].slot) >= 0;
      html += '<tr class="' + (chg ? 'chg' : '') + '"><td class="slot">' + esc(a[i].slot) + '</td>' + cell(b[i], 'before') + cell(a[i], 'after') + '</tr>';
    }
    $('nt-lu').innerHTML = html + '</tbody>';
    var sumB = b.reduce(function (s, x) { return s + (x.value || 0); }, 0), sumA = a.reduce(function (s, x) { return s + (x.value || 0); }, 0);
    $('nt-lu-delta').innerHTML = '<span class="' + tone(sumA - sumB) + '">' + L.signed(sumA - sumB) + '</span>';
    var bench = r.lineup.after.bench;
    $('nt-bench').textContent = bench.length ? 'Bench after: ' + bench.map(function (x) { return x.name + ' ' + fmt(x.value); }).join(', ') : '';
    $('nt-lineup-card').hidden = false;
  }

  function renderWeeks(r) {
    var bars = L.weekBars(r.weeks);
    if (bars.length < 2) { $('nt-weeks-card').hidden = true; return; }
    $('nt-weeks').innerHTML = bars.map(function (b) {
      var pct = Math.round(Math.abs(b.h) * 48);
      var title = 'Week ' + b.week + ': ' + L.signed(b.you) + (b.games ? ' · games ' + (b.games > 0 ? '+' : '') + b.games : '') + (b.playoff ? ' · playoffs' : '');
      return '<div class="nt-wk' + (b.playoff ? ' po' : '') + '" title="' + esc(title) + '"><i class="' + (b.h >= 0 ? 'up' : 'dn') + '" style="height:' + pct + '%"></i></div>';
    }).join('');
    $('nt-weeks').setAttribute('aria-label', 'Change in your weekly score by week, from ' + L.signed(Math.min.apply(null, bars.map(function (b) { return b.you; }))) + ' to ' + L.signed(Math.max.apply(null, bars.map(function (b) { return b.you; }))));
    $('nt-wk-axis').innerHTML = '<span>Wk ' + bars[0].week + '</span><span>Wk ' + bars[bars.length - 1].week + '</span>';
    $('nt-weeks-sum').innerHTML = '<span class="' + tone(r.you.ros) + '">' + L.signed(r.you.ros, 0) + '</span>';
    var hasPo = bars.some(function (b) { return b.playoff; });
    $('nt-legend').innerHTML = 'Bars: your weekly gain (up) or loss (down). Taller in weeks where the players in and out have more or fewer games.' + (hasPo ? ' <span class="po"></span>Playoff weeks count ' + esc(r.meta.playoffWeight) + '×.' : '');
    $('nt-weeks-card').hidden = false;
  }

  var verdictVisible = true;
  function renderVbar() {
    var bar = $('nt-vbar'), r = S.result;
    var show = !!(r && r.verdict && L.canEvaluate(S.st) && !verdictVisible && !S.typing);
    bar.classList.toggle('show', show);
    bar.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (!r || !r.verdict) return;
    bar.className = 'nt-vbar ' + L.verdictTone(r.verdict) + (show ? ' show' : '');
    $('nt-vbar-badge').textContent = r.verdict;
    $('nt-vbar-txt').innerHTML = '<b>' + L.signed(r.you.perWeek) + '/wk</b>Them ' + L.signed(r.them.perWeek) + '/wk · ' + esc(r.them.likely);
  }

  function render() { renderLists(); renderVerdict(); }

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
      S.result = null;
      S.error = e.status === 429 ? 'Too many changes at once. Try again in a few seconds.' : e.status === 503 ? 'Player data is unavailable right now.' : (e.message || 'Network error');
    }).then(function () {
      if (seq !== S.seq) return;
      S.busy = false; renderVerdict();
    });
  }

  function change(fn) { fn(); save(); render(); schedule(); }

  /* ------------------------------------------------------ search */
  function bindSearch(inputId, resultsId, exclude, onPick) {
    var input = $(inputId), box = $(resultsId);
    function close() { box.hidden = true; box.innerHTML = ''; }
    input.addEventListener('input', function () {
      var ex = exclude();
      var res = L.search(S.players, input.value, 20).filter(function (p) { return ex.indexOf(p.id) < 0; }).slice(0, 8);
      if (!res.length) { close(); return; }
      box.innerHTML = res.map(function (p) {
        return '<button type="button" role="option" data-pick="' + esc(p.id) + '">' + pips(p) + '<span>' + esc(p.name) + '</span><span class="tm" style="color:var(--text-muted);font-family:var(--font-mono);font-size:.68rem">' + esc(p.team || '') + '</span><span class="v">' + fmt(p.hsValue) + '</span></button>';
      }).join('');
      box.hidden = false;
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { close(); input.blur(); }
      if (e.key === 'Enter') { var b = box.querySelector('button'); if (b) { e.preventDefault(); b.click(); } }
    });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-pick]');
      if (!b) return;
      onPick(b.getAttribute('data-pick'));
      input.value = ''; close(); input.focus();
    });
    document.addEventListener('click', function (e) { if (!box.contains(e.target) && e.target !== input) close(); });
  }

  /* ------------------------------------------------------ yahoo */
  function initYahoo() {
    return api('/api/nba/yahoo/status').then(function (s) {
      S.connected = !!(s && s.connected); S.leagues = (s && s.leagues) || [];
    }).catch(function () { S.connected = false; S.leagues = []; }).then(function () {
      var sel = $('nt-league');
      if (!S.connected || !S.leagues.length) {
        $('nt-connect').hidden = S.connected;
        sel.hidden = true;
        if (S.st.mode === 'yahoo') { S.st.mode = 'manual'; S.st.give = []; S.st.get = []; S.st.myRoster = []; save(); }
        return;
      }
      sel.innerHTML = S.leagues.map(function (l) { return '<option value="' + esc(l.league_key) + '">' + esc(l.name) + ' · ' + esc(l.num_teams) + ' teams</option>'; }).join('') +
        '<option value="">Manual (no league)</option>';
      var pick = S.st.mode === 'yahoo' && S.leagues.some(function (l) { return l.league_key === S.st.leagueKey; }) ? S.st.leagueKey
        : S.st.mode === 'manual' && S.st.leagueKey === '' ? '' : S.leagues[0].league_key;
      sel.value = pick; sel.hidden = false;
      return selectLeague(pick || null);
    });
  }

  function selectLeague(key) {
    if (!key) {
      if (S.st.mode === 'yahoo') { S.st = Object.assign(L.emptyState(), { leagueKey: '' }); }
      S.st.leagueKey = ''; S.ctx = null; save(); render(); schedule(); return Promise.resolve();
    }
    var same = S.st.mode === 'yahoo' && S.st.leagueKey === key;
    banner(null);
    $('nt-my-list').innerHTML = '<li class="nt-empty">Loading your league…</li>';
    return api('/api/nba/trade/context?league_key=' + encodeURIComponent(key)).then(function (ctx) {
      S.ctx = ctx;
      var st = S.st;
      st.mode = 'yahoo'; st.leagueKey = key; st.myTeamKey = ctx.myTeamKey;
      var mine = L.teamOf(ctx, ctx.myTeamKey);
      st.myRoster = L.rosterIds(mine);
      if (!same || !L.teamOf(ctx, st.partnerKey) || st.partnerKey === st.myTeamKey) st.partnerKey = null;
      var theirs = st.partnerKey ? L.rosterIds(L.teamOf(ctx, st.partnerKey)) : [];
      st.give = st.give.filter(function (id) { return st.myRoster.indexOf(id) >= 0; });
      st.get = st.get.filter(function (id) { return theirs.indexOf(id) >= 0; });
      if (ctx.unmatched && ctx.unmatched.length) banner(ctx.unmatched.length + ' Yahoo player' + (ctx.unmatched.length > 1 ? 's' : '') + ' couldn\'t be matched to the model and are shown greyed out.');
      save(); render(); schedule();
    }).catch(function (e) {
      S.ctx = null; S.st.mode = 'manual'; S.st.leagueKey = '';
      $('nt-league').value = '';
      banner(e.code === 'yahoo_reauth' || e.code === 'yahoo_not_connected' ? 'Yahoo needs reconnecting. Manual mode still works.' : 'Couldn\'t load the Yahoo league (' + (e.status || 'network') + '). Manual mode still works.', 'error');
      save(); render(); schedule();
    });
  }

  /* ------------------------------------------------------ clerk */
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
          else { btn.hidden = false; btn.onclick = function () { clerk.openSignIn({ redirectUrl: '/nba/trade' }); }; }
        });
      } catch (e) { console.warn('Clerk init failed', e); }
    };
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------ boot */
  function bind() {
    document.addEventListener('click', function (e) {
      var rm = e.target.closest('[data-remove]');
      if (rm) {
        var id = rm.getAttribute('data-remove'), from = rm.getAttribute('data-from');
        change(function () {
          if (from === 'roster') { S.st.myRoster = S.st.myRoster.filter(function (x) { return x !== id; }); S.st.give = S.st.give.filter(function (x) { return x !== id; }); }
          else S.st.get = S.st.get.filter(function (x) { return x !== id; });
        });
        return;
      }
      var b = e.target.closest('.nt-row-main[data-side]');
      if (b) { var side = b.getAttribute('data-side'), pid = b.getAttribute('data-id'); change(function () { S.st = L.toggle(S.st, side, pid); }); }
    });
    $('nt-edit-roster').addEventListener('click', function () { S.editing = !S.editing; renderLists(); if (S.editing) $('nt-my-search').focus(); });
    $('nt-import').addEventListener('click', function () {
      var raw = null; try { raw = localStorage.getItem(L.DRAFT_KEY); } catch (e) {}
      var ids = L.draftImport(raw).filter(function (id) { return S.byId[id]; });
      if (!ids.length) { banner('No players marked as yours on the draft board yet. Search to add them instead.'); return; }
      banner(null);
      change(function () { S.st.myRoster = ids; S.st.give = []; S.st.get = S.st.get.filter(function (id) { return ids.indexOf(id) < 0; }); S.editing = false; });
    });
    bindSearch('nt-my-search', 'nt-my-results', function () { return S.st.myRoster; }, function (id) {
      change(function () { if (S.st.myRoster.length < 25) S.st.myRoster.push(id); S.st.get = S.st.get.filter(function (x) { return x !== id; }); });
    });
    bindSearch('nt-get-search', 'nt-get-results', function () { return S.st.myRoster.concat(S.st.get); }, function (id) {
      change(function () { S.st = L.toggle(S.st, 'get', id); });
    });
    $('nt-league').addEventListener('change', function () { S.st.give = []; S.st.get = []; selectLeague(this.value || null); });
    $('nt-partner').addEventListener('change', function () { var v = this.value || null; change(function () { S.st.partnerKey = v; S.st.get = []; }); });
    $('nt-vbar-btn').addEventListener('click', function () { $('nt-verdict').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); });
    // Phones: the fixed verdict bar would sit over a focused search box / keyboard.
    document.addEventListener('focusin', function (e) { if (e.target.matches && e.target.matches('input')) { S.typing = true; renderVbar(); } });
    document.addEventListener('focusout', function (e) { if (e.target.matches && e.target.matches('input')) { S.typing = false; renderVbar(); } });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { verdictVisible = es[0].isIntersecting; renderVbar(); }, { threshold: 0.15 }).observe($('nt-verdict'));
    }
  }

  function boot() {
    load(); bind(); initClerk();
    $('nt-my-list').innerHTML = '<li class="nt-empty">Loading players…</li>';
    api('/api/nba/players').then(function (d) {
      S.players = (d.players || []).slice().sort(function (a, b) { return (a.rank || 1e9) - (b.rank || 1e9); });
      S.byId = {}; S.players.forEach(function (p) { S.byId[String(p.id)] = p; });
    }).catch(function () {
      banner('Player data is unavailable right now. Try again in a minute.', 'error');
    }).then(function () {
      render();
      return initYahoo();
    }).then(function () { render(); schedule(); });
  }
  boot();
})();
