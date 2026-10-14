/* Pocket NBA — player research page (/nba/research).
   Data: /api/nba/research, /api/nba/player/:id, /api/nba/search, /api/nba/trending,
   /api/nba/research/meta (docs/nba-research-api.md). UI kit: NbaUI (nba-ui.js).
   Pure logic (URL state, query building, copy) lives in research-logic.js.

   Layout: ≥1024px list + sticky detail pane; <1024px list only and the detail
   opens in a sheet (full screen on phones). Tables ≥768px, card rows below. */
(function () {
  'use strict';
  var U = window.NbaUI, L = window.ResearchLogic;
  var esc = U.esc, fmt = U.fmt;
  var $ = function (id) { return document.getElementById(id); };

  var TEAM_NAMES = {
    ATL: 'Atlanta Hawks', BOS: 'Boston Celtics', BKN: 'Brooklyn Nets', CHA: 'Charlotte Hornets', CHI: 'Chicago Bulls',
    CLE: 'Cleveland Cavaliers', DAL: 'Dallas Mavericks', DEN: 'Denver Nuggets', DET: 'Detroit Pistons', GSW: 'Golden State Warriors',
    HOU: 'Houston Rockets', IND: 'Indiana Pacers', LAC: 'LA Clippers', LAL: 'Los Angeles Lakers', MEM: 'Memphis Grizzlies',
    MIA: 'Miami Heat', MIL: 'Milwaukee Bucks', MIN: 'Minnesota Timberwolves', NOP: 'New Orleans Pelicans', NYK: 'New York Knicks',
    OKC: 'Oklahoma City Thunder', ORL: 'Orlando Magic', PHI: 'Philadelphia 76ers', PHX: 'Phoenix Suns', POR: 'Portland Trail Blazers',
    SAC: 'Sacramento Kings', SAS: 'San Antonio Spurs', TOR: 'Toronto Raptors', UTA: 'Utah Jazz', WAS: 'Washington Wizards',
  };

  // ---- state ------------------------------------------------------------------
  var state = L.parseState(location.search);
  var meta = null, rows = [], total = 0, tableSeq = 0, detailSeq = 0;
  var paneId = null, sheetId = null, pushedDetail = false, closingFromPop = false;
  var trend = null, trendMode = 'adds';
  var mqTable = window.matchMedia('(min-width: 768px)');
  var mqPane = window.matchMedia('(min-width: 1024px)');

  // image hit counters (read by the browser checks: window.__rsImg)
  var imgStats = window.__rsImg = { load: 0, error: 0 };
  document.addEventListener('load', function (e) { var t = e.target; if (t && t.tagName === 'IMG' && t.closest && t.closest('.nu-avatar')) imgStats.load++; }, true);
  document.addEventListener('error', function (e) { var t = e.target; if (t && t.tagName === 'IMG' && t.closest && t.closest('.nu-avatar')) imgStats.error++; }, true);

  // ---- fetch with an in-memory cache ------------------------------------------
  var cache = new Map();
  function getJson(url) {
    if (cache.has(url)) return cache.get(url);
    var p = fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) { var e = new Error(body.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return body;
      });
    });
    cache.set(url, p);
    p.catch(function () { cache.delete(url); });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return p;
  }

  // ---- small render helpers -----------------------------------------------------
  function n1(x) { return fmt.score(x, 1); }
  function posList(p) { return (p.posList && p.posList.length ? p.posList : String(p.pos || '').split(',')).filter(Boolean); }
  function teamOf(p) { return p.teamAbbr || p.team || null; }
  function sourceTag(src) {
    var l = L.SOURCE_LABEL[src];
    return l ? '<span class="nu-tag rs-src" data-src="' + esc(src) + '">' + esc(l) + '</span>' : '';
  }
  function metaHtml(p) {
    var t = teamOf(p), parts = [U.posPill(posList(p))];
    parts.push('<span class="rs-team">' + (t ? U.teamLogo(t, { size: 'sm' }) + '<span>' + esc(t) + '</span>' : '<span>FA</span>') + '</span>');
    if (p.injury || p.injuryTag || p.outForSeason) parts.push(U.injuryBadge(p.injuryTag === 'OFS' ? 'OFS' : (p.injury || p.injuryTag), { outForSeason: p.outForSeason }));
    return parts.join('');
  }
  function avatarOf(p, size, opts) {
    opts = opts || {};
    return U.avatar({ id: p.id, sleeperId: p.sleeperId, name: p.name, team: teamOf(p), injury: p.injury || p.injuryTag, espnId: p.imageHints && p.imageHints.espnId, headshot: null },
      { size: size, injuryDot: opts.injuryDot, teamBadge: opts.teamBadge, eager: opts.eager });
  }
  function formHtml(delta) {
    var f = L.form(delta);
    return '<span class="rs-form" data-dir="' + f.dir + '" title="' + esc(f.label) + '"><span class="nu-sr">' + esc(f.label) + '</span><span aria-hidden="true">' + esc(f.text) + '</span></span>';
  }
  function marketHtml(p) {
    if (p.marketRank == null) return '<span class="nu-muted">—</span>';
    var badge = p.marketLabel === 'value' || p.marketLabel === 'reach' ? U.valueBadge(p.marketLabel) : '';
    return '<span class="rs-mkt">' + badge + '<span>' + esc(fmt.rank(p.marketRank)) + '</span></span>';
  }
  function playerHref(id) { return '/nba/research' + L.serializeState(Object.assign({}, state, { player: id })); }
  function unavailTag(reason) {
    return '<span class="rs-unavail"><span class="nu-tag">Unavailable</span>' + (reason ? '<span class="nu-hint">' + esc(reason) + '</span>' : '') + '</span>';
  }
  function section(title, body, opts) {
    opts = opts || {};
    return '<section class="nu-section rs-sec' + (opts.cls ? ' ' + opts.cls : '') + '"' + (opts.label ? ' aria-label="' + esc(opts.label) + '"' : '') + '>' +
      '<div class="nu-section__head"><h3 class="nu-section__title">' + esc(title) + '</h3>' + (opts.right || '') + '</div>' + body + '</section>';
  }

  // ---- controls -------------------------------------------------------------
  function renderPos() {
    var chips = ['ALL'].concat(L.SLOTS).map(function (p) {
      var on = p === 'ALL' ? !state.pos.length : state.pos.indexOf(p) >= 0;
      var label = p === 'ALL' ? 'All' : p === 'UTIL' ? 'UTIL' : p;
      return '<button type="button" class="nu-chip" data-pos="' + p + '" aria-pressed="' + on + '">' + esc(label) + '</button>';
    });
    $('rs-pos').innerHTML = chips.join('');
  }
  function controlsHtml(px) {
    var teams = (meta && meta.filters && meta.filters.team) || Object.keys(TEAM_NAMES);
    var teamOpts = '<option value="">All teams</option>' + teams.map(function (t) {
      return '<option value="' + esc(t) + '"' + (state.team === t ? ' selected' : '') + '>' + esc(TEAM_NAMES[t] || t) + '</option>';
    }).join('');
    var injOpts = L.INJ.map(function (o) { return '<option value="' + o.value + '"' + (state.inj === o.value ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('');
    var sortOpts = L.SORTS.map(function (s) { return '<option value="' + s.key + '"' + (state.sort === s.key ? ' selected' : '') + '>' + esc(s.label) + '</option>'; }).join('');
    var asc = state.dir === 'asc';
    return '<div class="nu-field rs-f-sort"><label for="' + px + '-sort">Sort by</label><div class="rs-sortpair">' +
        '<select class="nu-select" id="' + px + '-sort" data-f="sort">' + sortOpts + '</select>' +
        '<button type="button" class="nu-btn nu-btn--icon rs-dir" data-f="dir" aria-label="' + (asc ? 'Ascending: lowest first. Switch to highest first' : 'Descending: highest first. Switch to lowest first') + '" title="' + (asc ? 'Lowest first' : 'Highest first') + '"><span aria-hidden="true">' + (asc ? '↑' : '↓') + '</span></button></div></div>' +
      '<div class="nu-field rs-f-team"><label for="' + px + '-team">Team</label><select class="nu-select" id="' + px + '-team" data-f="team">' + teamOpts + '</select></div>' +
      '<div class="nu-field rs-f-inj"><label for="' + px + '-inj">Health</label><select class="nu-select" id="' + px + '-inj" data-f="inj">' + injOpts + '</select></div>' +
      '<div class="rs-f-yahoo"><span class="rs-f-yahoo__t" id="' + px + '-yo-l">Yahoo-only<small>No game logs</small></span>' +
        '<button type="button" class="nu-switch" role="switch" data-f="src" aria-checked="' + (state.src === 'yahoo-only') + '" aria-labelledby="' + px + '-yo-l"></button></div>';
  }
  function renderControls() {
    $('rs-tools').innerHTML = controlsHtml('rs-d');
    $('rs-filter-body').innerHTML = '<div class="rs-sheet-pos"><div class="nu-field__label" id="rs-s-pos-l">Position slot</div><div class="nu-chip-row" role="group" aria-labelledby="rs-s-pos-l">' +
      $('rs-pos').innerHTML + '</div></div>' + controlsHtml('rs-s');
    var n = L.activeFilterCount(state) + (state.sort !== 'hsValue' ? 1 : 0);
    var badge = $('rs-filter-n');
    badge.hidden = !n; badge.textContent = n;
    $('rs-filter-btn').setAttribute('aria-label', 'Filters and sort' + (n ? ', ' + n + ' active' : ''));
  }

  function setState(patch, opts) {
    opts = opts || {};
    var before = L.tableQuery(state);
    Object.assign(state, patch);
    if (!('page' in patch)) state.page = 1;
    syncUrl(false);
    renderPos(); renderControls();
    if (L.tableQuery(state) !== before) loadTable(opts);
  }
  function syncUrl(push) {
    var url = location.pathname + L.serializeState(state);
    if (url === location.pathname + location.search) return;
    history[push ? 'pushState' : 'replaceState'](null, '', url);
  }

  // ---- table / cards -----------------------------------------------------------
  var COLS = [
    { key: 'hsValue', label: 'Best gm', title: 'Best-game value: expected best game per matchup week', cls: 'rs-c-hs' },
    { key: 'mean', label: 'Avg', title: 'Per-game league score (model)', cls: 'rs-c-avg' },
    { key: 'ceiling', label: 'Ceil', title: 'Ceiling: a great night (90th percentile)', cls: 'rs-c-ceil' },
    { key: 'floor', label: 'Floor', title: 'Floor: a poor night (10th percentile)', cls: 'rs-c-floor' },
    { key: 'last5Delta', label: 'Form', title: 'Last 5 games vs season average', cls: 'rs-c-form' },
    { key: 'marketRank', label: 'Market', title: 'Draft-market rank and model-vs-market badge', cls: 'rs-c-mkt' },
    { key: 'yahooPreRank', label: 'Y! rk', title: 'Yahoo pre-season rank', cls: 'rs-c-y' },
    { key: 'yahooPctRos', label: '%Ros', title: 'Share of Yahoo leagues rostering him', cls: 'rs-c-ros' },
  ];
  function th(c) {
    var on = state.sort === c.key, aria = on ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return '<th scope="col" class="nu-col-num ' + c.cls + '" aria-sort="' + aria + '" title="' + esc(c.title) + '"><button type="button" data-sort="' + c.key + '">' + esc(c.label) + '</button></th>';
  }
  function tableHtml() {
    var head = '<thead><tr><th scope="col" class="rs-c-rk">#</th><th scope="col" class="nu-col-name" aria-sort="' + (state.sort === 'name' ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '"><button type="button" data-sort="name">Player</button></th>' + COLS.map(th).join('') + '</tr></thead>';
    var body = rows.map(function (p) {
      var sel = p.id === (state.player || paneId) && mqPane.matches;
      return '<tr class="is-clickable' + (sel ? ' is-selected' : '') + '" data-id="' + esc(p.id) + '"' + (sel ? ' aria-current="true"' : '') + '>' +
        '<td class="rs-c-rk"><span class="nu-rank' + (p.rank && p.rank <= 12 ? ' is-top' : '') + '">' + esc(p.rank || '—') + '</span></td>' +
        '<td class="nu-col-name"><div class="nu-player">' + avatarOf(p, 'md', { injuryDot: true }) +
          '<div class="nu-player__text"><a class="nu-player__name" href="' + esc(playerHref(p.id)) + '" data-open="' + esc(p.id) + '">' + esc(p.name) + '</a>' +
          '<div class="nu-player__meta">' + metaHtml(p) + sourceTag(p.source) + '</div></div></div></td>' +
        '<td class="nu-col-num rs-c-hs"><b>' + n1(p.hsValue) + '</b></td>' +
        '<td class="nu-col-num rs-c-avg">' + n1(p.mean) + '</td>' +
        '<td class="nu-col-num rs-c-ceil">' + n1(p.ceiling) + '</td>' +
        '<td class="nu-col-num rs-c-floor">' + n1(p.floor) + '</td>' +
        '<td class="nu-col-num rs-c-form">' + formHtml(p.last5Delta) + '</td>' +
        '<td class="nu-col-num rs-c-mkt">' + marketHtml(p) + '</td>' +
        '<td class="nu-col-num rs-c-y">' + esc(fmt.rank(p.yahooPreRank)) + '</td>' +
        '<td class="nu-col-num rs-c-ros">' + (p.yahooPctRos == null ? '—' : esc(Math.round(p.yahooPctRos) + '%')) + '</td></tr>';
    }).join('');
    return '<div class="nu-table-wrap rs-table-wrap"><table class="nu-table rs-table"><caption class="nu-sr">Players sorted by ' + esc((L.sortDef(state.sort) || {}).label || state.sort) + '. Select a row for the full profile.</caption>' + head + '<tbody>' + body + '</tbody></table></div>';
  }
  function cardsHtml() {
    return '<ol class="nu-list rs-cards" aria-label="Players">' + rows.map(function (p) {
      var mk = p.marketLabel === 'value' || p.marketLabel === 'reach' ? ' data-label="' + p.marketLabel + '"' : '';
      return '<li><a class="rs-card" href="' + esc(playerHref(p.id)) + '" data-open="' + esc(p.id) + '">' +
        '<div class="rs-card__top">' + avatarOf(p, 'lg', { injuryDot: true }) +
          '<div class="nu-player__text"><span class="nu-player__name">' + esc(p.name) + '</span><div class="nu-player__meta">' + metaHtml(p) + sourceTag(p.source) + '</div></div>' +
          '<div class="rs-card__val"><b>' + n1(p.hsValue) + '</b><small>Best gm</small></div></div>' +
        '<dl class="rs-card__stats">' +
          '<div><dt>Avg</dt><dd>' + n1(p.mean) + '</dd></div>' +
          '<div><dt>Ceil</dt><dd>' + n1(p.ceiling) + '</dd></div>' +
          '<div><dt>Floor</dt><dd>' + n1(p.floor) + '</dd></div>' +
          '<div><dt>Form</dt><dd>' + formHtml(p.last5Delta) + '</dd></div>' +
          '<div><dt>Mkt</dt><dd class="rs-card__mkt"' + mk + '>' + esc(fmt.rank(p.marketRank)) + '</dd></div>' +
          '<div><dt>Y!</dt><dd>' + esc(fmt.rank(p.yahooPreRank)) + '</dd></div>' +
        '</dl></a></li>';
    }).join('') + '</ol>';
  }
  function renderResults() {
    var box = $('rs-results');
    if (!rows.length) {
      var filtered = state.q || L.activeFilterCount(state);
      box.innerHTML = '<div class="nu-card">' + U.emptyState({
        title: state.q ? 'No players match “' + state.q + '”' : 'No players match these filters',
        body: filtered ? 'Try a different spelling, or clear the filters.' : 'Player data is not available right now.',
        action: filtered ? '<button type="button" class="nu-btn" data-clear>Clear Search and Filters</button>' : '',
      }) + '</div>';
      return;
    }
    box.innerHTML = mqTable.matches ? tableHtml() : cardsHtml();
    U.hydrateImages(box);
  }
  function renderCount() {
    var s = L.sortDef(state.sort);
    var pi = L.pageInfo(total, state.page);
    $('rs-count').innerHTML = '<b>' + esc(total.toLocaleString()) + '</b> player' + (total === 1 ? '' : 's') + (s ? ' <span class="nu-sep" aria-hidden="true"></span> sorted by ' + esc(s.label.toLowerCase()) + (state.dir === 'asc' ? ' (low to high)' : '') : '') +
      (pi.pages > 1 ? ' <span class="nu-sep" aria-hidden="true"></span> ' + pi.from + '–' + pi.to : '');
    var pg = $('rs-pager');
    pg.hidden = pi.pages <= 1;
    if (pi.pages > 1) {
      pg.innerHTML = '<button type="button" class="nu-btn nu-btn--sm" data-page="' + (pi.page - 1) + '"' + (pi.hasPrev ? '' : ' disabled') + '>‹ Prev</button>' +
        '<span class="rs-pager__t">Page <b>' + pi.page + '</b> of ' + pi.pages + '</span>' +
        '<button type="button" class="nu-btn nu-btn--sm" data-page="' + (pi.page + 1) + '"' + (pi.hasNext ? '' : ' disabled') + '>Next ›</button>';
    }
  }
  function loadTable(opts) {
    opts = opts || {};
    var seq = ++tableSeq, url = L.tableQuery(state);
    var box = $('rs-results');
    box.setAttribute('aria-busy', 'true');
    var t = setTimeout(function () { if (seq === tableSeq) box.innerHTML = '<div class="nu-list">' + U.skeleton(10) + '</div>'; }, cache.has(url) ? 0 : 120);
    return getJson(url).then(function (d) {
      clearTimeout(t);
      if (seq !== tableSeq) return;
      rows = d.rows || []; total = d.total || 0;
      if (d.offset && !rows.length && state.page > 1) { state.page = 1; syncUrl(false); return loadTable(); }
      renderResults(); renderCount();
      box.removeAttribute('aria-busy');
      if (opts.scroll) $('rs-count').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      if (mqPane.matches && !state.player && rows.length && (!paneId || !opts.keepPane)) showInPane(rows[0].id, false);
    }).catch(function (e) {
      clearTimeout(t);
      if (seq !== tableSeq) return;
      box.removeAttribute('aria-busy');
      box.innerHTML = U.callout('error', '<b>Could not load players.</b> ' + esc(e.message) + ' <button type="button" class="nu-btn nu-btn--sm" data-retry>Try Again</button>');
      $('rs-count').textContent = '';
    });
  }

  // ---- trending strip --------------------------------------------------------
  function renderTrend() {
    var list = $('rs-trend-list');
    if (!trend) { list.innerHTML = '<div class="rs-tcard rs-tcard--skel" aria-hidden="true">' + U.skeleton(1) + '</div>'; return; }
    var items = (trend[trendMode] || []).slice(0, 12);
    $('rs-trend-src').textContent = trend.derived ? 'Sleeper trending unavailable: biggest last-5 form swings' : 'Sleeper adds and drops, last ' + (trend.lookbackHours || 24) + 'h';
    if (!items.length) { list.innerHTML = '<p class="nu-hint">Nothing trending right now.</p>'; return; }
    list.innerHTML = items.map(function (it, i) {
      var p = it.player, name = (p && p.name) || it.name || 'Unknown player';
      var stat = it.count != null ? (trendMode === 'adds' ? '+' : '−') + L.count(it.count) : (p && p.last5Delta != null ? L.signed(p.last5Delta) + ' form' : '');
      var sub = p ? U.posPill(String(p.pos || '').split(',').filter(Boolean)[0] || '') + '<span>' + esc(p.team || '') + '</span>' : '<span>' + esc(it.team || 'Not on the board') + '</span>';
      var inner = (p ? avatarOf(p, 'sm', { eager: i < 6 }) : U.avatar({ name: name }, { size: 'sm', noImage: true })) +
        '<span class="rs-tcard__text"><span class="rs-tcard__name">' + esc(name) + '</span><span class="rs-tcard__meta">' + sub + '</span></span>' +
        '<span class="rs-tcard__n" data-mode="' + trendMode + '">' + esc(stat) + '</span>';
      return p ? '<a role="listitem" class="rs-tcard" href="' + esc(playerHref(p.id)) + '" data-open="' + esc(p.id) + '">' + inner + '</a>'
        : '<div role="listitem" class="rs-tcard is-off" title="Not in this league’s player pool">' + inner + '</div>';
    }).join('');
    U.hydrateImages(list);
  }
  function loadTrend() {
    renderTrend();
    getJson('/api/nba/trending?limit=15').then(function (d) { trend = d; renderTrend(); })
      .catch(function () { $('rs-trend').hidden = true; });
  }

  // ---- autocomplete -------------------------------------------------------------
  var acItems = [], acActive = -1, acTimer = null, acSeq = 0;
  function hl(name, q) {
    var n = L.norm(name), k = L.norm(q).trim();
    if (!k) return esc(name);
    // map normalised index back to the original (accents are 1:1 after NFD strip for Latin names)
    var i = n.indexOf(k);
    if (i < 0 || n.length !== String(name).length) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + k.length)) + '</mark>' + esc(name.slice(i + k.length));
  }
  function acRender(q) {
    var ul = $('rs-ac'), inp = $('rs-q');
    if (!acItems.length) { acClose(); if (q) { ul.innerHTML = '<li class="rs-ac__none" role="option" aria-disabled="true">No players found</li>'; ul.hidden = false; inp.setAttribute('aria-expanded', 'true'); } return; }
    ul.innerHTML = acItems.map(function (p, i) {
      return '<li role="option" id="rs-ac-' + i + '" data-id="' + esc(p.id) + '" aria-selected="' + (i === acActive) + '">' + avatarOf(p, 'sm') +
        '<span class="rs-ac__text"><span class="rs-ac__name">' + hl(p.name, q) + '</span><span class="rs-ac__meta">' + U.posPill(String(p.pos || '').split(',').filter(Boolean)) + '<span>' + esc(p.team || 'FA') + '</span>' + (p.injuryTag ? U.injuryBadge(p.injuryTag) : '') + '</span></span>' +
        '<span class="rs-ac__val"><b>' + n1(p.hsValue) + '</b><small>' + esc(fmt.rank(p.rank)) + '</small></span></li>';
    }).join('');
    ul.hidden = false; inp.setAttribute('aria-expanded', 'true');
    if (acActive >= 0) inp.setAttribute('aria-activedescendant', 'rs-ac-' + acActive); else inp.removeAttribute('aria-activedescendant');
    U.hydrateImages(ul);
  }
  function acClose() { var ul = $('rs-ac'); ul.hidden = true; ul.innerHTML = ''; acActive = -1; $('rs-q').setAttribute('aria-expanded', 'false'); $('rs-q').removeAttribute('aria-activedescendant'); }
  function onSearchInput() {
    var q = $('rs-q').value.slice(0, 64);
    clearTimeout(acTimer);
    acTimer = setTimeout(function () {
      var seq = ++acSeq, t = q.trim();
      setState({ q: t });
      if (!t) { acItems = []; acClose(); return; }
      getJson('/api/nba/search?limit=8&q=' + encodeURIComponent(t)).then(function (d) {
        if (seq !== acSeq || document.activeElement !== $('rs-q')) return;
        acItems = d.results || []; acActive = -1; acRender(t);
      }).catch(function () { acItems = []; acClose(); });
    }, 150);
  }

  // ---- detail ----------------------------------------------------------------
  function detailSkeleton() {
    return '<div class="rs-detail" aria-busy="true"><div class="rs-hero"><span class="nu-skel nu-skel--circle rs-hero__skel"></span><div class="rs-hero__text" style="flex:1"><span class="nu-skel nu-skel--title"></span><span class="nu-skel" style="width:55%;margin-top:10px"></span></div></div>' +
      '<div class="nu-stats nu-stats--3">' + U.skeleton(6, { kind: 'tile' }) + '</div>' + U.skeleton(1, { kind: 'card' }) + '</div>';
  }
  function heroHtml(d, ctx) {
    var id = d.identity || {}, bio = d.bio || {}, pos = d.positions || {}, v = d.value || {}, inj = d.injury || {};
    var t = d.teamAbbr || d.team;
    var p = { id: d.id, sleeperId: id.sleeperId, espnId: id.espnId, name: id.name, team: t, injury: inj.status || inj.tag };
    var bits = [];
    if (bio.jersey) bits.push('#' + bio.jersey);
    var h = L.heightFt(bio.height); if (h) bits.push(h);
    if (bio.weightLb) bits.push(bio.weightLb + ' lb');
    if (bio.age != null) bits.push('Age ' + bio.age);
    if (bio.rookie) bits.push('Rookie'); else if (bio.experience != null) bits.push(bio.experience + (bio.experience === 1 ? ' season' : ' seasons'));
    if (bio.college) bits.push(bio.college);
    var tags = [v.tier != null ? U.tierBadge(v.tier) : '', v.rank != null ? '<span class="nu-tag">Board ' + esc(fmt.rank(v.rank)) + '</span>' : '',
      v.posRank != null && pos.list && pos.list.length ? '<span class="nu-tag">Pos ' + esc(fmt.rank(v.posRank)) + '</span>' : '', sourceTag(d.source)].join('');
    var injHtml = '';
    if (inj.status || inj.tag || inj.outForSeason) {
      var detail = [inj.bodyPart, inj.notes].filter(Boolean).join(' · ');
      injHtml = '<div class="rs-inj">' + U.injuryBadge(inj.tag === 'OFS' ? 'OFS' : (inj.status || inj.tag), { outForSeason: inj.outForSeason }) +
        '<span>' + esc(inj.outForSeason ? 'Out for the season' : (inj.status || inj.tag)) + (detail ? ': ' + esc(detail) : '') + '</span>' +
        (inj.newsUpdated ? '<span class="nu-hint">updated ' + esc(L.timeAgo(inj.newsUpdated)) + '</span>' : '') + '</div>';
    }
    return '<header class="rs-hero" style="--team:' + esc(U.TEAM_COLORS[t] || '#2a2f37') + '">' +
      '<div class="rs-hero__img">' + U.avatar(p, { size: 'hero', eager: true, teamBadge: true }) + '</div>' +
      '<div class="rs-hero__text"><div class="rs-hero__tags">' + tags + '</div>' +
        '<h2 class="rs-hero__name" id="rs-name-' + ctx + '" tabindex="-1">' + esc(id.name || 'Player') + '</h2>' +
        '<div class="rs-hero__meta">' + U.posPill(pos.list || []) + (t ? '<span class="rs-team">' + U.teamLogo(t, { size: 'md' }) + '<span>' + esc(TEAM_NAMES[t] || t) + '</span></span>' : '<span>Free agent</span>') + '</div>' +
        (bits.length ? '<div class="rs-hero__bio">' + bits.map(esc).join('<span class="nu-sep" aria-hidden="true"></span>') + '</div>' : '') +
        (pos.yahooElig && pos.yahooElig.length ? '<div class="rs-hero__elig"><span class="nu-label">Yahoo slots</span>' + U.posPill(pos.yahooElig) + '</div>' : '') +
      '</div></header>' + injHtml;
  }
  function tilesHtml(d) {
    var v = d.value || {}, c = d.consistency, r = d.rates;
    var noLogs = L.unavailable(d, 'logs') ? 'no game logs' : null;
    return '<div class="nu-stats nu-stats--3 rs-tiles">' +
      U.statTile({ label: 'Best game', value: v.hsValue, sub: d.injury && d.injury.status && v.hsValue != null && v.mean != null && v.hsValue < v.mean ? 'lowered by injury' : 'per matchup week', tone: 'accent' }) +
      U.statTile({ label: 'Avg game', value: v.mean, sub: 'league points' }) +
      U.statTile({ label: 'Ceiling', value: v.ceiling, sub: 'a great night' }) +
      U.statTile({ label: 'Floor', value: v.floor, sub: 'a poor night' }) +
      U.statTile({ label: 'Boom rate', value: c && c.boomRate != null ? L.pct(c.boomRate) : null, sub: c ? '30%+ over his avg' : noLogs || 'not enough games' }) +
      U.statTile({ label: 'DD rate', value: r && r.ddPct != null ? L.pct(r.ddPct) : null, sub: r ? 'TD ' + L.pct(r.tdPct) + ' of games' : noLogs || 'not enough games' }) +
      '</div>' +
      (v.floor != null && v.ceiling != null ? '<div class="rs-range">' + U.rangeBand({ min: 0, max: Math.max(10, Math.ceil(v.ceiling * 1.1 / 10) * 10), lo: v.floor, hi: v.ceiling, mark: v.mean,
        labels: ['Floor ' + n1(v.floor), 'Avg ' + n1(v.mean) + ' · Ceiling ' + n1(v.ceiling)], ariaLabel: 'Typical game range ' + n1(v.floor) + ' to ' + n1(v.ceiling) + ', average ' + n1(v.mean) }) + '</div>' : '') +
      (v.valueNote ? '<p class="nu-hint">' + esc(v.valueNote) + '</p>' : '');
  }
  function nextWeekHtml(d) {
    var nw = d.nextWeek;
    if (!nw) return '<div class="nu-card rs-next">' + '<div class="nu-section__head"><h3 class="nu-section__title">Next Matchup Week</h3></div>' + unavailTag(L.unavailable(d, 'nextWeek') || 'No schedule model for this player') + '</div>';
    var chips = L.probChips(nw.pBestAtLeast).map(function (c) {
      return '<li class="rs-prob" data-tone="' + c.tone + '" aria-label="' + esc(c.label) + '"><span class="rs-prob__t">' + c.t + '+</span><span class="rs-prob__p">' + esc(c.text) + '</span></li>';
    }).join('');
    var avail = nw.availability != null && nw.baseAvailability != null && nw.availability < nw.baseAvailability - 0.05
      ? '<p class="rs-next__warn">' + U.icon.alert + '<span>Injury lowers his chance to play: ' + L.pct(nw.availability) + ' this week vs ' + L.pct(nw.baseAvailability) + ' normally.</span></p>' : '';
    return '<div class="nu-card nu-card--focus rs-next">' +
      '<div class="rs-next__head"><div><div class="nu-eyebrow">Week ' + esc(nw.week) + ' · ' + esc(L.dateRange(nw.start, nw.end)) + '</div>' +
        '<div class="rs-next__title">' + esc(nw.games) + ' game' + (nw.games === 1 ? '' : 's') + (nw.days > 7 ? ' <span class="nu-tag">' + nw.days + '-day week</span>' : '') + '</div></div>' +
        '<div class="rs-next__exp"><b>' + n1(nw.expectedBest) + '</b><small>expected best game</small></div></div>' +
      '<p class="rs-next__q">Chance his best game this week reaches…</p><ul class="rs-probs">' + chips + '</ul>' + avail +
      '<p class="nu-hint">Model estimate from his game-by-game spread, games played and health. Not betting odds.</p></div>';
  }
  function scheduleHtml(d) {
    var s = d.schedule;
    if (!s || !s.length) return section('Schedule', unavailTag(L.unavailable(d, 'schedule')));
    var cards = s.map(function (w) {
      var c = L.scheduleCard(w);
      var games = c.games ? '<ul class="rs-wk__games">' + c.games.map(function (g) {
        return '<li' + (g.b2b ? ' class="is-b2b"' : '') + '><span class="rs-wk__day">' + esc(L.weekday(g.date)) + '</span><span class="rs-wk__ha">' + (g.home ? 'vs' : '@') + '</span>' + U.teamLogo(g.opp, { size: 'sm' }) + '<span class="rs-wk__opp">' + esc(g.opp || '?') + '</span>' + (g.b2b ? '<span class="rs-b2b" title="Back-to-back">B2B</span>' : '') + '</li>';
      }).join('') + '</ul>' : '<p class="nu-hint">' + esc(L.unavailable(d, 'scheduleOpponents') || 'Opponents unavailable') + '</p>';
      return '<li class="rs-wk' + (c.long ? ' is-long' : '') + '"><div class="rs-wk__head"><span class="nu-label">Wk ' + esc(c.week) + '</span>' + (c.long ? '<span class="rs-wk__long">' + c.days + ' days</span>' : '') + '</div>' +
        '<div class="rs-wk__range">' + esc(c.range) + '</div>' +
        '<div class="rs-wk__n"><b>' + (c.count == null ? '—' : c.count) + '</b> game' + (c.count === 1 ? '' : 's') + (c.b2b ? '<span class="rs-wk__b2b">' + c.b2b + '× B2B</span>' : '') + '</div>' +
        games + (c.hsValue != null ? '<div class="rs-wk__hs"><span>Best gm</span><b>' + n1(c.hsValue) + '</b></div>' : '') + '</li>';
    }).join('');
    return section('Next 4 Matchup Weeks', '<ol class="rs-sched">' + cards + '</ol>', { right: '<span class="nu-hint">B2B = back-to-back nights</span>' });
  }
  function scoutHtml(d) {
    var lines = L.scouting(d);
    if (!lines.length) return '';
    return section('Scouting Report', '<div class="nu-card rs-scout"><p>' + lines.map(esc).join(' ') + '</p></div>');
  }
  function marketBlock(d) {
    var v = d.value || {}, m = d.market || {};
    var r = L.marketReading(v.rank, m);
    var kv = '<dl class="rs-kv4">' +
      '<div><dt>Our rank</dt><dd>' + esc(fmt.rank(v.rank)) + '</dd></div>' +
      '<div><dt>Market</dt><dd>' + esc(fmt.rank(m.marketRank)) + '</dd></div>' +
      '<div><dt>Yahoo rank</dt><dd>' + esc(fmt.rank(m.yahooPreRank)) + '</dd></div>' +
      '<div><dt>Rostered</dt><dd>' + (m.yahooPctRos == null ? '—' : esc(Math.round(m.yahooPctRos) + '%')) + '</dd></div></dl>';
    return section('Market vs. Model', '<div class="nu-card rs-market">' + kv + '<p class="rs-market__read" data-tone="' + r.tone + '">' + (m.label ? U.valueBadge(m.label, m.strong) : '') + '<span>' + esc(r.text) + '</span></p>' +
      (m.contested ? '<p class="nu-hint">Drafters disagree a lot on him, so his draft spot is hard to predict.</p>' : '') + '</div>');
  }
  function similarHtml(d) {
    var s = d.similar || [];
    if (!s.length) return section('Similar Players', '<p class="nu-hint">' + esc(d.source === 'yahoo-only' ? 'Not available for Yahoo-only players (no game logs to compare).' : 'No close matches.') + '</p>');
    return section('Similar Players', '<div class="nu-list rs-similar">' + s.map(function (p) {
      return '<a class="nu-row nu-row--compact" href="' + esc(playerHref(p.id)) + '" data-open="' + esc(p.id) + '">' +
        '<div class="nu-player">' + avatarOf(p, 'md') + '<div class="nu-player__text"><span class="nu-player__name">' + esc(p.name) + '</span><span class="nu-player__meta rs-sim-why">' + esc(String(p.reason || '').replace(/^shares \w+ · /, '').replace(/HS value/g, 'Best gm').replace(/pts\/game/g, 'avg')) + '</span></div></div>' +
        '<div class="nu-row__end"><div class="nu-row__num"><b>' + n1(p.hsValue) + '</b><small>' + esc(fmt.rank(p.rank)) + '</small></div></div></a>';
    }).join('') + '</div>');
  }
  function weeklyChart(wb, hsValue) {
    var W = 360, H = 120, g = L.weeklyBars(wb.weeks, W, H);
    var avg = wb.summary && wb.summary.mean;
    var bars = g.bars.map(function (b) {
      return '<rect class="rs-bar' + (b.value != null && hsValue != null && b.value >= hsValue ? ' is-hi' : '') + '" x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="2"><title>Week ' + b.week + ': ' + (b.value == null ? 'no games' : n1(b.value)) + (b.date ? ' (' + L.shortDate(b.date) + ')' : '') + '</title></rect>';
    }).join('');
    var avgY = avg != null ? (H - (avg / g.top) * H).toFixed(1) : null;
    var line = avgY != null ? '<line class="rs-bars__avg" x1="0" x2="' + W + '" y1="' + avgY + '" y2="' + avgY + '"/>' : '';
    var labels = g.bars.filter(function (b, i) { return i === 0 || (i + 1) % 5 === 0 || i === g.bars.length - 1; }).map(function (b) {
      return '<text x="' + (b.x + b.w / 2).toFixed(1) + '" y="' + (H + 14) + '" text-anchor="middle">' + b.week + '</text>';
    }).join('');
    return '<svg class="rs-bars" viewBox="0 -4 ' + W + ' ' + (H + 20) + '" role="img" aria-label="Best game in each week of last season, ' + g.bars.length + ' weeks, average ' + n1(avg) + ', top ' + n1(g.max) + '">' +
      '<text class="rs-bars__top" x="0" y="6">' + g.top + '</text>' + bars + line + labels + '</svg>';
  }
  function highScoreHtml(d) {
    var v = d.value || {}, wb = d.weeklyBest, gl = d.gameLog, out = [nextWeekHtml(d)];
    if (!wb || !wb.weeks || !wb.weeks.length) {
      out.push(section('Last Season, Week by Week', unavailTag(L.unavailable(d, 'logs') || 'No game logs')));
      return out.join('');
    }
    var s = wb.summary || {};
    out.push(section('His Best Game Each Week · ' + seasonLabel(wb.season),
      '<div class="nu-stats rs-mini4">' +
        U.statTile({ label: 'Average', value: s.mean, tone: 'accent' }) + U.statTile({ label: 'Median', value: s.median }) +
        U.statTile({ label: 'Top 10%', value: s.p90 }) + U.statTile({ label: 'Best', value: s.max }) + '</div>' +
      '<div class="rs-chart">' + weeklyChart(wb, v.hsValue) + '<p class="rs-legend"><span class="rs-key rs-key--hi"></span>at or above his best-game value (' + n1(v.hsValue) + ')<span class="rs-key rs-key--avg"></span>season average</p></div>' +
      '<p class="nu-hint">In High Score only this game counts each week. Weeks are Monday–Sunday from last season.</p>'));
    var scores = L.scoresOf(gl && gl.games);
    if (scores.length) {
      var lo = Math.floor(Math.min.apply(null, scores) / 10) * 10, hi = Math.ceil(Math.max.apply(null, scores) / 10) * 10;
      var mean = L.mean(scores);
      out.push(section('Every Game Last Season',
        '<div class="rs-chart">' + U.histogram(scores, { bins: Math.max(6, Math.min(20, (hi - lo) / 5)), w: 360, h: 96, range: [lo, Math.max(hi, lo + 10)], mark: mean, highlightFrom: v.hsValue != null ? Math.floor(v.hsValue / 5) * 5 : null, label: scores.length + ' games, league points per game, average ' + n1(mean) }) +
        '<p class="rs-legend">' + scores.length + ' games<span class="nu-sep" aria-hidden="true"></span>dashed line = average ' + n1(mean) + '<span class="nu-sep" aria-hidden="true"></span>bright = ' + n1(v.hsValue) + '+ games</p></div>' +
        (d.consistency ? '<dl class="rs-kv4"><div><dt>Boom games</dt><dd>' + L.pct(d.consistency.boomRate) + '</dd></div><div><dt>Bust games</dt><dd>' + L.pct(d.consistency.bustRate) + '</dd></div><div><dt>Double-dbl</dt><dd>' + (d.rates ? d.rates.ddCount : '—') + '</dd></div><div><dt>Triple-dbl</dt><dd>' + (d.rates ? d.rates.tdCount : '—') + '</dd></div></dl>' +
          '<p class="nu-hint">Boom = 30%+ above his average; bust = 30%+ below.</p>' : '')));
    }
    return out.join('');
  }
  function seasonLabel(y) { return y ? y + '–' + String((+y + 1) % 100).padStart(2, '0') : ''; }
  var STAT_COLS = [['min', 'MIN'], ['pts', 'PTS'], ['reb', 'REB'], ['ast', 'AST'], ['stl', 'STL', 1], ['blk', 'BLK', 1], ['to', 'TO', 1]];
  function gamesHtml(d) {
    var out = [];
    var games = d.last10 || [];
    if (games.length) {
      var head = '<tr><th scope="col">Date</th><th scope="col">Opp</th>' + STAT_COLS.map(function (c) { return '<th scope="col" class="nu-col-num' + (c[2] ? ' nu-col-opt' : '') + '">' + c[1] + '</th>'; }).join('') + '<th scope="col" class="nu-col-num">Score</th></tr>';
      var body = games.map(function (g) {
        var tag = g.td ? '<span class="rs-dd" title="Triple-double">TD</span>' : g.dd ? '<span class="rs-dd" title="Double-double">DD</span>' : '';
        return '<tr><td>' + esc(L.shortDate(g.date)) + '</td><td class="rs-opp">' + (g.opp ? (g.home ? 'vs ' : '@ ') + esc(g.opp) : '—') + '</td>' +
          STAT_COLS.map(function (c) { var x = g[c[0]]; return '<td class="nu-col-num' + (c[2] ? ' nu-col-opt' : '') + '">' + (x == null ? '—' : esc(c[0] === 'min' ? Math.round(x) : x)) + '</td>'; }).join('') +
          '<td class="nu-col-num rs-score"><b>' + n1(g.score) + '</b>' + tag + '</td></tr>';
      }).join('');
      out.push(section('Last ' + games.length + ' Games · ' + seasonLabel(d.gameLog && d.gameLog.season), '<div class="nu-table-wrap"><table class="nu-table nu-table--compact rs-log"><caption class="nu-sr">Recent games with league score</caption><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
        (L.unavailable(d, 'gameContext') ? '<p class="nu-hint">Opponents: ' + esc(L.unavailable(d, 'gameContext')) + '</p>' : '')));
    } else {
      out.push(section('Recent Games', unavailTag(L.unavailable(d, 'logs') || 'No game logs')));
    }
    // season line vs projection
    var ls = d.lastSeason, pj = d.projection, lines = [];
    if (ls && ls.perGame) lines.push({ label: seasonLabel(ls.season), sub: ls.gp + ' games', s: Object.assign({ min: ls.mpg }, ls.perGame), score: ls.scored && ls.scored.mean });
    if (pj && pj.pts != null) lines.push({ label: seasonLabel(pj.season), sub: 'projection', s: pj, score: pj.modelMean });
    if (lines.length) {
      var h2 = '<tr><th scope="col">Per game</th>' + STAT_COLS.map(function (c) { return '<th scope="col" class="nu-col-num' + (c[2] ? ' nu-col-opt' : '') + '">' + c[1] + '</th>'; }).join('') + '<th scope="col" class="nu-col-num">Score</th></tr>';
      var b2 = lines.map(function (l) {
        return '<tr><th scope="row" class="rs-line-l">' + esc(l.label) + '<small>' + esc(l.sub) + '</small></th>' + STAT_COLS.map(function (c) { var x = l.s[c[0]]; return '<td class="nu-col-num' + (c[2] ? ' nu-col-opt' : '') + '">' + (x == null ? '—' : n1(x)) + '</td>'; }).join('') +
          '<td class="nu-col-num rs-score"><b>' + n1(l.score) + '</b></td></tr>';
      }).join('');
      out.push(section('Season Line', '<div class="nu-table-wrap"><table class="nu-table nu-table--compact rs-line"><caption class="nu-sr">Season per-game stats and projection, scored with league settings</caption><thead>' + h2 + '</thead><tbody>' + b2 + '</tbody></table></div>' +
        '<p class="nu-hint">Score = league points per game with this league’s scoring, including double-double and triple-double bonuses.</p>'));
    } else if (pj) {
      out.push(section('Projection', '<p class="rs-body">' + esc(pj.note || 'Estimate only.') + (pj.yahooFanPts != null ? ' Yahoo projects ' + esc(Math.round(pj.yahooFanPts)) + ' fantasy points for the season.' : '') + '</p>'));
    }
    if (d.splits && (d.splits.home || d.splits.away)) {
      var sp = d.splits;
      out.push(section('Home and Away', '<dl class="rs-kv4"><div><dt>Home avg</dt><dd>' + n1(sp.home && sp.home.mean) + '</dd></div><div><dt>Home games</dt><dd>' + esc(sp.home ? sp.home.gp : '—') + '</dd></div><div><dt>Away avg</dt><dd>' + n1(sp.away && sp.away.mean) + '</dd></div><div><dt>Away games</dt><dd>' + esc(sp.away ? sp.away.gp : '—') + '</dd></div></dl>'));
    }
    return out.join('');
  }
  function newsHtml(d) {
    var n = d.news, items = (n && n.items) || [];
    var inj = d.injury || {};
    var injNote = inj.status ? U.callout('warn', '<b>' + esc(inj.status) + '</b>' + (inj.bodyPart ? ' · ' + esc(inj.bodyPart) : '') + (inj.notes ? ' · ' + esc(inj.notes) : '') + (inj.newsUpdated ? ' <span class="nu-hint">(' + esc(L.timeAgo(inj.newsUpdated)) + ')</span>' : '')) : '';
    if (!items.length) {
      return injNote + '<div class="nu-card">' + U.emptyState({ title: 'No Recent News', body: L.unavailable(d, 'news') || 'Nothing from Rotowire about him lately.' }) + '</div>';
    }
    return injNote + '<ol class="rs-news">' + items.slice(0, 8).map(function (it) {
      return '<li class="rs-news__item"><div class="rs-news__meta"><span class="nu-label">' + esc(it.source || 'news') + '</span><time datetime="' + esc(it.published || '') + '">' + esc(L.timeAgo(it.published)) + '</time></div>' +
        '<h4 class="rs-news__t">' + esc(it.title) + '</h4>' + (it.description ? '<p>' + esc(it.description) + '</p>' : '') +
        (it.analysis ? '<details class="rs-news__more"><summary>Analysis</summary><p>' + esc(it.analysis) + '</p></details>' : '') + '</li>';
    }).join('') + '</ol><p class="nu-hint">News: Rotowire via Sleeper.</p>';
  }
  function freshHtml(d) {
    var parts = [];
    if (d.asOf) parts.push('Model data ' + L.timeAgo(d.asOf));
    if (d.generatedAt) parts.push('page built ' + L.timeAgo(d.generatedAt));
    return '<p class="rs-fresh-line nu-hint">' + esc(parts.join(' · ')) + (meta && meta.leagueName ? ' · scored for ' + esc(meta.leagueName) : '') + '</p>';
  }
  var TABS = [['ov', 'Overview'], ['hs', 'High Score'], ['gm', 'Games'], ['nw', 'News']];
  function detailHtml(d, ctx) {
    var newsN = d.news && d.news.items ? d.news.items.length : 0;
    var tabs = '<div class="nu-tabs rs-tabs" role="tablist" aria-label="Player sections">' + TABS.map(function (t, i) {
      return '<button type="button" class="nu-tab" role="tab" id="rs-t-' + ctx + '-' + t[0] + '" aria-controls="rs-p-' + ctx + '-' + t[0] + '" aria-selected="' + (i === 0) + '" data-value="' + t[0] + '">' + t[1] + (t[0] === 'nw' && newsN ? ' <span class="nu-chip__n">' + newsN + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    var panels = {
      ov: tilesHtml(d) + scoutHtml(d) + scheduleHtml(d) + marketBlock(d) + similarHtml(d),
      hs: highScoreHtml(d), gm: gamesHtml(d), nw: newsHtml(d),
    };
    return '<article class="rs-detail" aria-labelledby="rs-name-' + ctx + '">' + heroHtml(d, ctx) + tabs +
      TABS.map(function (t, i) { return '<div class="rs-panel" role="tabpanel" id="rs-p-' + ctx + '-' + t[0] + '" aria-labelledby="rs-t-' + ctx + '-' + t[0] + '" tabindex="0"' + (i ? ' hidden' : '') + '>' + panels[t[0]] + '</div>'; }).join('') +
      freshHtml(d) + '</article>';
  }
  function detailError(e, id) {
    if (e && e.status === 404) return U.emptyState({ title: 'Player Not Found', body: 'No player with id ' + id + '. He may have left the league pool.' });
    return U.callout('error', '<b>Could not load this player.</b> ' + esc(e && e.message) + ' <button type="button" class="nu-btn nu-btn--sm" data-retry-detail="' + esc(id) + '">Try Again</button>');
  }
  function mountDetail(box, id, ctx, onDone) {
    var seq = ++detailSeq;
    var url = '/api/nba/player/' + encodeURIComponent(id);
    if (!cache.has(url)) box.innerHTML = detailSkeleton();
    getJson(url).then(function (d) {
      if (seq !== detailSeq) return;
      box.innerHTML = detailHtml(d, ctx);
      U.hydrateImages(box);
      var tl = box.querySelector('[role="tablist"]');
      U.tabs(tl, {});
      if (onDone) onDone(d);
    }).catch(function (e) {
      if (seq !== detailSeq) return;
      box.innerHTML = detailError(e, id);
      if (onDone) onDone(null);
    });
  }
  function markSelected(id) {
    Array.prototype.forEach.call(document.querySelectorAll('#rs-results tr[data-id]'), function (tr) {
      var on = tr.getAttribute('data-id') === id;
      tr.classList.toggle('is-selected', on);
      if (on) tr.setAttribute('aria-current', 'true'); else tr.removeAttribute('aria-current');
    });
  }
  function showInPane(id, focus) {
    paneId = id;
    var pane = $('rs-pane');
    markSelected(id);
    mountDetail(pane, id, 'p', function (d) {
      pane.scrollTop = 0;
      if (focus) { var h = $('rs-name-p'); if (h) h.focus({ preventScroll: true }); }
      if (d && focus) { var r = pane.getBoundingClientRect(); if (r.top < 0) pane.scrollIntoView({ block: 'start' }); }
    });
  }
  function showInSheet(id) {
    sheetId = id;
    var body = $('rs-detail-body');
    $('rs-detail-t').textContent = 'Player';
    mountDetail(body, id, 's', function (d) {
      body.scrollTop = 0;
      $('rs-detail-t').textContent = d && d.identity ? d.identity.name : 'Player';
    });
    if (!U.sheet.isOpen()) {
      U.sheet.open('rs-detail-sheet', { initialFocus: '#rs-detail-t', onClose: onDetailClosed });
    }
  }
  function onDetailClosed() {
    sheetId = null;
    if (closingFromPop) { closingFromPop = false; return; }
    if (!state.player) return;
    state.player = '';
    if (pushedDetail) { pushedDetail = false; history.back(); }
    else syncUrl(false);
  }
  function openPlayer(id, opts) {
    opts = opts || {};
    if (!id) return;
    var wasOpen = !!state.player;
    state.player = id;
    if (opts.push !== false) {
      if (wasOpen) syncUrl(false); else { syncUrl(true); pushedDetail = true; }
    }
    acClose();
    if (mqPane.matches) showInPane(id, opts.focus !== false);
    else showInSheet(id);
  }

  // ---- events -----------------------------------------------------------------
  function onClick(e) {
    var t = e.target;
    var chip = t.closest('[data-pos]');
    if (chip) { setState({ pos: L.togglePos(state.pos, chip.getAttribute('data-pos')) }); return; }
    var s = t.closest('th [data-sort]');
    if (s) { setState(L.nextSort(state, s.getAttribute('data-sort'))); return; }
    var dirBtn = t.closest('[data-f="dir"]');
    if (dirBtn) { setState({ dir: state.dir === 'asc' ? 'desc' : 'asc' }); focusSame(dirBtn); return; }
    var sw = t.closest('[data-f="src"]');
    if (sw) { setState({ src: state.src === 'yahoo-only' ? '' : 'yahoo-only' }); focusSame(sw); return; }
    var pg = t.closest('[data-page]');
    if (pg && !pg.disabled) { setState({ page: +pg.getAttribute('data-page') }, { scroll: true }); return; }
    if (t.closest('[data-clear]')) { $('rs-q').value = ''; setState({ q: '', pos: [], team: '', inj: '', src: '' }); return; }
    if (t.closest('[data-retry]')) { loadTable(); return; }
    var rd = t.closest('[data-retry-detail]');
    if (rd) { openPlayer(rd.getAttribute('data-retry-detail'), { push: false }); return; }
    var ac = t.closest('#rs-ac [data-id]');
    if (ac) { e.preventDefault(); openPlayer(ac.getAttribute('data-id')); return; }
    var link = t.closest('[data-open]');
    if (link && !(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) { e.preventDefault(); openPlayer(link.getAttribute('data-open')); return; }
    var tr = t.closest('#rs-results tr[data-id]');
    if (tr && !t.closest('a,button')) { openPlayer(tr.getAttribute('data-id')); return; }
    if (!t.closest('#rs-search-wrap')) acClose();
  }
  // controls re-render on every change: put focus back on the twin control
  function focusSame(el) {
    var id = el.id, f = el.getAttribute('data-f'), inSheet = !!el.closest('#rs-filter-sheet');
    var scope = inSheet ? $('rs-filter-body') : $('rs-tools');
    var n = id ? $(id) : scope.querySelector('[data-f="' + f + '"]');
    if (n) n.focus();
  }
  function onChange(e) {
    var t = e.target, f = t.getAttribute('data-f');
    if (!f) return;
    var patch = {};
    if (f === 'sort') { patch.sort = t.value; patch.dir = L.defaultDir(t.value); }
    else if (f === 'team') patch.team = t.value;
    else if (f === 'inj') patch.inj = t.value;
    else return;
    setState(patch);
    focusSame(t);
  }
  function onSearchKey(e) {
    var ul = $('rs-ac');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!acItems.length) return;
      e.preventDefault();
      acActive = e.key === 'ArrowDown' ? (acActive + 1) % acItems.length : (acActive <= 0 ? acItems.length - 1 : acActive - 1);
      acRender($('rs-q').value);
      var a = $('rs-ac-' + acActive); if (a) a.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (acActive >= 0 && acItems[acActive]) { e.preventDefault(); openPlayer(acItems[acActive].id); }
      else { acClose(); }
    } else if (e.key === 'Escape') {
      if (!ul.hidden) { e.preventDefault(); acClose(); }
    }
  }
  function onPop() {
    var prev = L.tableQuery(state);
    var next = L.parseState(location.search);
    state = next;
    $('rs-q').value = state.q;
    renderPos(); renderControls();
    if (L.tableQuery(state) !== prev) loadTable({ keepPane: true });
    if (state.player) {
      pushedDetail = false;
      if (mqPane.matches) showInPane(state.player, false); else showInSheet(state.player);
    } else if (U.sheet.isOpen() && sheetId) {
      closingFromPop = true; pushedDetail = false; U.sheet.close();
    }
  }
  function onLayoutChange() {
    renderResults();
    if (mqPane.matches) {
      if (U.sheet.isOpen() && sheetId) { closingFromPop = true; U.sheet.close(); }
      var id = state.player || paneId || (rows[0] && rows[0].id);
      if (id) showInPane(id, false);
    } else {
      $('rs-pane').innerHTML = '';
      paneId = null;
    }
  }

  // ---- boot -------------------------------------------------------------------
  function loadMeta() {
    return getJson('/api/nba/research/meta').then(function (m) {
      meta = m;
      if (m.leagueName) $('rs-eyebrow').textContent = m.leagueName + ' · Yahoo High Score';
      if (m.players) $('rs-sub').textContent = m.players + ' players valued by the one game that counts: their best game of each matchup week.';
      if (m.asOf) {
        var f = $('rs-fresh');
        f.hidden = false;
        f.innerHTML = '<span class="nu-dot rs-dot" aria-hidden="true"></span>Data ' + esc(L.timeAgo(m.asOf));
        f.title = 'Model data as of ' + new Date(m.asOf).toLocaleString() + (m.market && m.market.asOf ? '; market ' + new Date(m.market.asOf).toLocaleString() : '');
      }
      renderControls();
    }).catch(function () { /* the table still works with default lists */ });
  }
  function init() {
    // icons
    document.querySelector('.rs-search-ico').outerHTML = U.icon.search;
    document.querySelector('.rs-filter-ico').outerHTML = U.icon.filter;
    $('rs-filter-x').innerHTML = U.icon.close; $('rs-about-x').innerHTML = U.icon.close;
    document.querySelector('.rs-back-ico').outerHTML = '<span class="rs-back-ico" aria-hidden="true">' + U.icon.chevron + '</span>';

    $('rs-q').value = state.q;
    renderPos(); renderControls();
    $('rs-results').innerHTML = '<div class="nu-list">' + U.skeleton(10) + '</div>';
    if (mqPane.matches) $('rs-pane').innerHTML = detailSkeleton();

    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    $('rs-q').addEventListener('input', onSearchInput);
    $('rs-q').addEventListener('keydown', onSearchKey);
    $('rs-q').addEventListener('focus', function () { if (acItems.length && this.value) acRender(this.value); });
    $('rs-q').addEventListener('search', function () { if (!this.value) { acItems = []; acClose(); setState({ q: '' }); } });
    $('rs-filter-btn').addEventListener('click', function () { U.sheet.open('rs-filter-sheet', { initialFocus: '#rs-s-sort' }); });
    $('rs-filter-reset').addEventListener('click', function () { setState({ pos: [], team: '', inj: '', src: '', sort: 'hsValue', dir: 'desc' }); });
    $('rs-about-btn').addEventListener('click', function () { U.sheet.open('rs-about'); });
    U.segmented($('rs-trend-seg'), { onChange: function (v) { trendMode = v || 'adds'; renderTrend(); } });
    window.addEventListener('popstate', onPop);
    (mqPane.addEventListener ? mqPane.addEventListener('change', onLayoutChange) : mqPane.addListener(onLayoutChange));
    (mqTable.addEventListener ? mqTable.addEventListener('change', renderResults) : mqTable.addListener(renderResults));

    loadMeta();
    loadTable({ keepPane: !!state.player });
    loadTrend();
    if (state.player) openPlayer(state.player, { push: false, focus: false });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
