/* Pocket NBA waivers page controller. Yahoo-first (GET /api/nba/waivers);
   falls back to manual mode (POST /api/nba/waivers/manual) with a roster kept
   in localStorage. Pure helpers live in waivers-logic.js (window.NbaWaivers);
   markup comes from the design system (window.NbaUI, docs/nba-design-system.md).

   Each load asks for two horizons at once: the one the user ranks by and a
   second one for the other gain column ("This week" vs "Next 4 wks"). */
(function () {
  'use strict';
  var L = window.NbaWaivers;
  var U = window.NbaUI;
  var esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  var PAGE = 20;
  var DEFAULT_TEAMS = 12, DEFAULT_PER_TEAM = 14;

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
    result: null,              // primary horizon
    alt: null,                 // { id: netGain } for the secondary horizon
    altH: 4,
    players: null,
    byId: {},
    open: {},
    shown: PAGE,
    loading: false,
    seq: 0
  };

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

  function callout(tone, html) { $('wv-callout').innerHTML = html ? U.callout(tone, html) : ''; }

  /* ------------------------------------------------------------ helpers */
  // Board players carry Yahoo positions in yahooPos; engine rows put them in pos.
  function posOf(x) { var a = x ? (x.yahooPos && x.yahooPos.length ? x.yahooPos : x.pos && x.pos.length ? x.pos : x.elig) : []; return (a || []).filter(function (e) { return e !== 'UTIL'; }); }
  // Merge an engine row with the board player (sleeper id for the headshot, espnId, Yahoo positions).
  function person(x) {
    var b = x && S.byId[String(x.id)];
    return { id: x && x.id, name: (x && x.name) || (b && b.name), team: (x && x.team) || (b && b.team), injury: x && x.injury !== undefined ? x.injury : b && b.injury, espnId: b && b.espnId, headshot: b && b.headshot, sleeperId: b && b.sleeperId };
  }
  function meta(x, extra) {
    var bits = [U.posPill(posOf(x).slice(0, 3)), '<span>' + esc(x.team || 'FA') + '</span>'];
    if (x.injury) bits.push(U.injuryBadge(x.injury));
    return bits.concat(extra || []).filter(Boolean).join('');
  }
  function cell(x, opts) {
    opts = opts || {};
    var p = person(x);
    return U.playerCell(p, { size: opts.size || 'md', teamBadge: opts.teamBadge !== false, injuryDot: true, meta: opts.meta != null ? opts.meta : meta(x, opts.extra) });
  }
  function gm(n, label) {
    var tone = L.gamesTone(n);
    return '<span class="wv-gm' + (tone === 'hi' ? ' is-hi' : tone === 'lo' || tone === 'zero' ? ' is-lo' : '') + '" title="' + esc(n + ' games ' + label) + '"><b>' + esc(n) + '</b>' + esc(label) + '</span>';
  }
  function statusChip(t) {
    var r = S.result, st = L.statusLabel(t, r && r.waiverRules && r.waiverRules.waiverDays);
    return '<span class="wv-st" data-kind="' + st.kind + '">' + esc(st.text) + '</span>';
  }
  function horizonWord(h) { return h === 1 ? 'this week' : 'next ' + h + ' wks'; }
  function gainSpan() { var r = S.result; return r && r.midWeek ? 'over the games left this week' : 'this week'; }

  /* ------------------------------------------------------------- render */
  function renderControls() {
    [].forEach.call($('wv-horizon').querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.h) === S.prefs.horizon)); });
    [].forEach.call($('wv-filters').querySelectorAll('[data-pos]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.pos === S.prefs.pos)); });
    [].forEach.call($('wv-filters').querySelectorAll('[data-flag]'), function (b) { b.setAttribute('aria-pressed', String(!!S.prefs[b.dataset.flag])); });
    [].forEach.call($('wv-sort').querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.sort === S.prefs.sort)); });
    var r = S.result, sel = $('wv-week');
    var opts = L.weekOptions(r && r.weekDates);
    if (opts.length) {
      var cur = S.prefs.week || (r && r.startWeek);
      sel.innerHTML = opts.map(function (o) { return '<option value="' + o.week + '"' + (o.week === cur ? ' selected' : '') + '>' + esc(o.label + (o.long ? ' · 14 days' : '')) + '</option>'; }).join('');
      sel.hidden = false;
    }
  }

  function renderHero(r) {
    var el = $('wv-hero');
    if (!r) {
      el.innerHTML = S.loading ? U.skeleton(3, { kind: 'tile' }) : '';
      el.hidden = !S.loading;
      return;
    }
    el.hidden = false;
    var a = r.adds || {}, pr = r.priority || {}, manual = S.source === 'manual';
    var addsTile;
    if (a.max == null) addsTile = U.statTile({ label: 'Adds this week', value: 'No limit', sub: a.seasonMax == null ? 'No season cap' : a.seasonMax + ' per season' });
    else {
      var pips = L.addPips(a).map(function (p) { return '<i class="' + (p.used ? 'u' : '') + '"></i>'; }).join('');
      addsTile = '<div class="nu-stat"><span class="nu-stat__label">Add budget</span>' +
        '<span class="nu-stat__value">' + esc(a.left) + '<small>of ' + esc(a.max) + ' left</small></span>' +
        '<div class="wv-pips" style="--n:' + a.max + '" aria-hidden="true">' + pips + '</div>' +
        (manual ? '<span class="nu-stat__sub">' + (S.manual.addsUsed != null ? S.manual.addsUsed + ' used' : '0 used') + '<button type="button" class="nu-btn nu-btn--ghost nu-btn--sm wv-set" data-open-roster data-focus="#wv-adds-used">Set</button></span>'
          : '<span class="nu-stat__sub">' + (a.source === 'yahoo' ? 'From Yahoo' : a.known ? '' : 'Yahoo didn\'t report adds used') + (a.seasonMax == null ? ' · no season cap' : '') + '</span>') + '</div>';
    }
    var prTile = '<div class="nu-stat"><span class="nu-stat__label">Waiver priority</span>' +
      '<span class="nu-stat__value">' + (pr.position ? '#' + esc(pr.position) + '<small>of ' + esc(pr.teams) + '</small>' : '—') + '</span>' +
      (manual ? '<span class="nu-stat__sub">' + (pr.position ? (pr.rolling ? 'A claim sends you last' : 'Priority list') : 'Not set') + '<button type="button" class="nu-btn nu-btn--ghost nu-btn--sm wv-set" data-open-roster data-focus="#wv-priority">Set</button></span>'
        : '<span class="nu-stat__sub">' + esc(pr.position ? (pr.rolling ? 'Rolling list: a claim sends you last' : 'Priority list') : 'Not reported by Yahoo') + '</span>') + '</div>';
    var best = (r.pairs || [])[0];
    var bestTile = U.statTile({ label: 'Best gain ' + (r.midWeek ? 'rest of week' : 'this week'), value: best ? L.fmtGain(best.netGain) : '—', tone: best ? 'accent' : null, sub: best ? 'Add ' + best.add.name : 'No swap helps' });
    el.innerHTML = addsTile + prTile + bestTile.replace('class="nu-stat', 'class="wv-tile-best nu-stat');
  }

  function swapCard(p, i, r, focus) {
    var span = gainSpan();
    var add = Object.assign({}, p.add, { status: p.add.status });
    return '<article class="nu-card wv-swap' + (focus ? ' nu-card--focus wv-swap--focus' : ' wv-swap--compact') + '">' +
      '<div class="wv-swap__pair">' +
        '<div class="wv-swap__side"><span class="wv-swap__verb">' + (p.add.status === 'W' ? 'Claim' : 'Add') + '</span>' +
          cell(p.add, { size: focus ? 'lg' : 'md', extra: [gm(p.add.games, ' games')] }) + '</div>' +
        '<span class="wv-swap__arrow" aria-hidden="true">' + U.icon.trade + '</span>' +
        '<div class="wv-swap__side wv-swap__side--drop"><span class="wv-swap__verb">' + (p.drop ? 'Drop' : 'Open spot') + '</span>' +
          (p.drop ? cell(p.drop, { size: focus ? 'lg' : 'md', extra: [gm(p.drop.games, ' games')].concat(p.drop.bankedGames > 0 ? ['<span class="wv-badge wv-badge--save" title="His team already played; dropping him can lose that score">played ' + p.drop.bankedGames + '</span>'] : []) })
            : '<span class="nu-meta">No drop needed</span>') + '</div>' +
      '</div>' +
      '<div class="wv-swap__foot"><div class="wv-swap__gain"><b>' + L.fmtGain(p.netGain) + '</b><span>pts ' + esc(span) + '</span></div>' +
        (focus ? statusChip(add) : '') +
        '<button type="button" class="nu-btn' + (focus ? '' : ' nu-btn--sm nu-btn--ghost') + '" data-copy="' + i + '" data-umami-event="nba-waivers-copy">Copy Claim</button></div>' +
    '</article>';
  }

  function renderSwaps(r) {
    var sec = $('wv-swaps-sec');
    if (!r) { sec.hidden = true; $('wv-actionbar').hidden = true; document.body.classList.remove('nu-has-actionbar'); return; }
    sec.hidden = false;
    var pairs = r.pairs || [];
    var wk = L.weekLabel(r.weeks[0], r.weekDates);
    $('wv-swaps-hint').textContent = wk.title + (wk.span ? ' · ' + wk.span : '');
    if (!pairs.length) {
      var why = r.adds && r.adds.left === 0 ? { title: 'No Adds Left This Week', body: 'You\'ve used your weekly adds. The list below still shows who to watch for next week.' }
        : r.targets && r.targets.length ? { title: 'Your Roster Is Set', body: 'No add/drop beats your current lineup this week. Check the calendar for next week\'s 4-game streamers.' }
        : { title: 'No Free Agents to Rank', body: r.unmatched && r.unmatched.roster && r.unmatched.roster.length ? 'Some of your players aren\'t in our model yet (see Not Matched).' : 'Try a different week or show more players.' };
      $('wv-swaps').innerHTML = '<div class="nu-card">' + U.emptyState(why) + '</div>';
      $('wv-more-swaps').innerHTML = ''; $('wv-more-swaps-h').hidden = true;
      $('wv-actionbar').hidden = true; document.body.classList.remove('nu-has-actionbar');
      return;
    }
    $('wv-swaps').innerHTML = swapCard(pairs[0], 0, r, true);
    $('wv-more-swaps-h').hidden = pairs.length < 2;
    $('wv-more-swaps').innerHTML = pairs.slice(1).map(function (p, i) { return swapCard(p, i + 1, r, false); }).join('');
    var p = pairs[0];
    $('wv-ab-title').textContent = (p.add.status === 'W' ? 'Claim ' : 'Add ') + p.add.name + (p.drop ? ', drop ' + p.drop.name : '');
    $('wv-ab-sub').textContent = L.fmtGain(p.netGain) + ' pts ' + gainSpan();
    $('wv-actionbar').hidden = false; document.body.classList.add('nu-has-actionbar');
  }

  function gainCol(label, v, max) {
    var n = Number(v) || 0;
    return '<div class="wv-g"><span class="wv-g__lbl">' + esc(label) + '</span><span class="wv-g__val ' + (n > 0.05 ? 'is-pos' : 'is-zero') + '">' + L.fmtGain(n) + '</span>' + U.meter(L.barFrac(n, max), 'good') + '</div>';
  }

  function targetCard(t, i, r, maxA, maxB) {
    var open = !!S.open[t.id];
    var h = S.prefs.horizon, ah = S.altH;
    var gainH = Number(t.netGain) || 0, gainAlt = S.alt ? S.alt[String(t.id)] : null;
    // Left column always = this week, right = the longer horizon.
    var wkGain = h === 1 ? gainH : gainAlt, longGain = h === 1 ? gainAlt : gainH, longH = h === 1 ? ah : h;
    var g = t.gamesByWeek || [], cg = t.calendarGames || g;
    var chips = [gm(cg[0] != null ? cg[0] : g[0], ' this wk')];
    if ((cg[1] != null ? cg[1] : g[1]) != null) chips.push(gm(cg[1] != null ? cg[1] : g[1], ' next'));
    var badges = [statusChip(t)];
    if (t.roleUp) badges.push('<span class="wv-badge wv-badge--up" title="Minutes up over his last 5 games">Role ↑</span>');
    if (t.advice === 'save-priority') badges.push('<span class="wv-badge wv-badge--save" title="The gain is smaller than the value of keeping your waiver spot">Keep priority</span>');
    if (t.advice === 'no-adds-left') badges.push('<span class="wv-badge wv-badge--mute">No adds left</span>');
    var sub = [];
    if (gainH > 0.05 && t.drop) sub.push('Drop <b>' + esc(t.drop.name) + '</b>' + (t.drop.bankedGames > 0 ? ' <span class="is-warn">(already played ' + t.drop.bankedGames + ')</span>' : ''));
    else if (gainH > 0.05 && r.openSpots) sub.push('Fills an open roster spot');
    if (gainH <= 0.05 && !(gainAlt > 0.05)) sub.push('Doesn\'t beat your current players yet' + (L.gamesTone(g[0]) === 'hi' ? '; watch him if a starter sits' : ''));
    if (t.onWaivers && t.priorityCost > 0) sub.push('<span class="is-warn">Claim costs your priority (≈' + L.fmt1(t.priorityCost) + ' pts of future value) → nets ' + L.fmtGain(t.claimNet) + '</span>');
    var detail = '';
    if (open) {
      detail = '<div class="wv-t__detail" id="wv-d-' + esc(t.id) + '">' +
        '<div class="nu-table-wrap"><table class="nu-table nu-table--compact"><thead><tr><th>Week</th>' + r.weeks.map(function (w) { return '<th class="nu-col-num">' + w + '</th>'; }).join('') + '</tr></thead><tbody>' +
        '<tr><td>Games</td>' + (t.gamesByWeek || []).map(function (n) { return '<td class="nu-col-num">' + n + '</td>'; }).join('') + '</tr>' +
        '<tr><td>Best game</td>' + (t.valueByWeek || []).map(function (v) { return '<td class="nu-col-num">' + L.fmt1(v) + '</td>'; }).join('') + '</tr></tbody></table></div>' +
        '<div>Typical game <b class="nu-num">' + L.fmt1(t.mean) + '</b> · ceiling <b class="nu-num">' + L.fmt1(t.ceiling) + '</b> · floor <b class="nu-num">' + L.fmt1(t.floor) + '</b>' +
        (t.role && !t.role.stale ? ' · minutes last 5: <b class="nu-num">' + L.fmt1(t.role.recentMin) + '</b> vs ' + L.fmt1(t.role.seasonMin) : '') + '</div>' +
        (t.reasons && t.reasons.length ? '<div>' + t.reasons.map(esc).join(' · ') + '</div>' : '') +
        '<div class="wv-acts"><button type="button" class="nu-btn nu-btn--sm" data-copy-t="' + esc(t.id) + '">Copy Claim</button>' +
        (S.source === 'manual' ? '<button type="button" class="nu-btn nu-btn--sm nu-btn--ghost" data-act="taken" data-id="' + esc(t.id) + '">Someone owns him</button><button type="button" class="nu-btn nu-btn--sm nu-btn--ghost" data-act="waiver" data-id="' + esc(t.id) + '">' + (t.onWaivers ? 'He\'s a free agent' : 'He\'s on waivers') + '</button><button type="button" class="nu-btn nu-btn--sm nu-btn--ghost" data-act="add" data-id="' + esc(t.id) + '">I added him</button>' : '') +
        '</div></div>';
    }
    return '<li class="nu-card wv-t" data-open="' + open + '"><button type="button" class="wv-t__main" data-id="' + esc(t.id) + '" aria-expanded="' + open + '"' + (open ? ' aria-controls="wv-d-' + esc(t.id) + '"' : '') + '>' +
      '<span class="nu-rank' + (i < 3 ? ' is-top' : '') + '">' + (i + 1) + '</span>' +
      '<span class="wv-t__who">' + cell(t, { size: 'lg' }) +
        '<span class="wv-t__line">' + chips.join('') + badges.join('') + '</span>' +
        (sub.length ? '<span class="wv-t__sub">' + sub.join('') + '</span>' : '') + '</span>' +
      '<span class="wv-t__gains">' + gainCol('This week', wkGain, maxA) + gainCol(horizonWord(longH).replace('next', 'Next'), longGain, maxB) + '</span>' +
      '</button>' + detail + '</li>';
  }

  function renderList(r) {
    var list = $('wv-list');
    if (!r) return;
    var f = { pos: S.prefs.pos, roleUp: S.prefs.roleUp, fourGame: S.prefs.fourGame, hideInjured: S.prefs.hideInjured };
    var all = L.sortTargets(L.filterTargets(r.targets, f), S.prefs.sort);
    var shown = all.slice(0, S.shown);
    $('wv-count').textContent = all.length + ' of ' + r.targets.length + ' free agents';
    $('wv-list-hint').textContent = r.midWeek ? 'Counts only games left this week' : 'Gain to your best lineup';
    if (!all.length) {
      list.innerHTML = '<li class="nu-card">' + U.emptyState(r.targets.length ? { title: 'Nobody Matches These Filters', body: 'Turn a filter off to see more players.' } : { title: 'No Free Agents Found', body: 'Your league may have no one left to add.' }) + '</li>';
      $('wv-more').hidden = true;
      return;
    }
    // Bars share one scale per column so lengths compare down the list.
    var h = S.prefs.horizon, vals = all.map(function (t) { return [Number(t.netGain) || 0, S.alt ? S.alt[String(t.id)] || 0 : 0]; });
    var wkIdx = h === 1 ? 0 : 1, lgIdx = h === 1 ? 1 : 0;
    var maxA = Math.max.apply(null, vals.map(function (v) { return v[wkIdx]; }).concat(0.1));
    var maxB = Math.max.apply(null, vals.map(function (v) { return v[lgIdx]; }).concat(0.1));
    list.innerHTML = shown.map(function (t, i) { return targetCard(t, i, r, maxA, maxB); }).join('');
    $('wv-more').hidden = all.length <= S.shown;
  }

  function renderCalendar(r) {
    var sec = $('wv-cal-sec');
    if (!r || !r.calendar || !r.calendar.length) { sec.hidden = true; return; }
    sec.hidden = false;
    $('wv-cal').innerHTML = r.calendar.map(function (c) {
      var wk = L.weekLabel(c.week, r.weekDates), d = (r.weekDates || {})[c.week] || {}, long = Number(d.days) >= 10;
      return '<div class="nu-card" data-long="' + long + '"><div class="wv-cal__head"><b>' + esc(wk.title) + '</b><span>' + esc(wk.span) + '</span></div>' +
        (long ? '<span class="nu-tag wv-cal__long">14-day week · double the games</span>' : '') +
        (c.fourGame.length ? '<ol class="wv-mini">' + c.fourGame.slice(0, 5).map(function (p) {
          return '<li>' + cell(p, { size: 'sm', teamBadge: false, meta: U.posPill(posOf(p).slice(0, 2)) + '<span>' + esc(p.team || '') + '</span>' }) + gm(p.games, '') + '<span class="wv-mini__v" title="Expected best game">' + L.fmt1(p.value) + '</span></li>';
        }).join('') + '</ol>' : '<p class="nu-meta" style="margin:0">No free agent plays 4+ games.</p>') + '</div>';
    }).join('');
  }

  function renderSide(r) {
    var drops = (r && r.dropCandidates) || [];
    drops = drops.filter(function (d) { return !d.keeper && !d.ilSlot; }).concat(drops.filter(function (d) { return d.keeper || d.ilSlot; }));
    $('wv-drops').hidden = !drops.length;
    $('wv-drops-body').innerHTML = drops.slice(0, 4).map(function (d) {
      var tag = d.keeper ? '<span class="wv-badge wv-badge--mute">Keep</span>' : d.ilSlot ? '<span class="wv-badge wv-badge--mute">IL</span>' : '';
      return '<div class="wv-drop"><div class="wv-drop__top">' + cell(d, { size: 'md', teamBadge: false, extra: [tag] }) +
        '<span class="wv-mini__v">' + (d.dropCost > 0.05 ? '−' + L.fmt1(d.dropCost) : '0.0') + '</span></div><p>' + esc(L.dropReason(d, r.weeks.length)) + '</p></div>';
    }).join('');

    var inj = (r && r.injuryReplacements) || [];
    $('wv-inj').hidden = !inj.length;
    $('wv-inj-body').innerHTML = inj.map(function (x) {
      return '<div class="wv-drop"><div class="wv-drop__top">' + cell(x.injured, { size: 'md', teamBadge: false }) + '</div><p>About ' + L.fmt1(x.lostValue) + ' pts lost while he\'s out. ' + (x.replacements.length ? 'Best cover:' : 'Your bench covers it.') + '</p>' +
        (x.replacements.length ? '<ol class="wv-mini">' + x.replacements.slice(0, 3).map(function (p) {
          return '<li>' + cell(p, { size: 'sm', teamBadge: false }) + '<span class="wv-mini__v nu-good">' + L.fmtGain(p.netGain) + '</span></li>';
        }).join('') + '</ol>' : '') + '</div>';
    }).join('');

    var lu = r && r.lineup;
    $('wv-lineup').hidden = !(lu && lu.starters && lu.starters.length);
    if (lu && lu.starters) {
      $('wv-lineup-wk').textContent = 'Wk ' + lu.week + ' · ' + L.fmt1(lu.total);
      var order = {};
      (lu.slots || r.slots || []).forEach(function (s, i) { if (order[s] == null) order[s] = i; });
      $('wv-lineup-body').innerHTML = lu.starters.slice().sort(function (a, b) { return (order[a.slot] || 0) - (order[b.slot] || 0) || b.value - a.value; }).map(function (s) {
        return '<li><span class="wv-mini__slot">' + U.posPill(s.slot) + '</span>' + cell(s, { size: 'sm', teamBadge: false, meta: '<span>' + esc(s.team || '') + '</span>' + (s.injury ? U.injuryBadge(s.injury) : '') }) + '<span class="wv-mini__v">' + L.fmt1(s.value) + '</span></li>';
      }).join('');
    }

    var un = r && r.unmatched;
    var names = un ? (un.roster || []).concat(un.freeAgents || []).map(function (u) { return u.name; }).filter(Boolean) : [];
    $('wv-unmatched').hidden = !names.length;
    $('wv-unmatched-body').textContent = names.length ? names.length + ' Yahoo player' + (names.length > 1 ? 's' : '') + ' not in our model, left out of the ranking: ' + names.slice(0, 8).join(', ') + (names.length > 8 ? '…' : '') : '';
  }

  function renderRules(r) {
    var notes = (r && r.waiverRules && r.waiverRules.notes) || [];
    $('wv-rules-h').hidden = !notes.length;
    $('wv-rules').innerHTML = notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
    var name = r && r.profile && r.profile.name;
    $('wv-eyebrow').textContent = (name ? name + ' · ' : 'Yahoo fantasy basketball · ') + (S.source === 'manual' ? 'Manual roster' : 'Waivers');
  }

  function renderManual() {
    var sec = $('wv-manual');
    var manual = S.source === 'manual';
    sec.hidden = !manual;
    if (!manual) return;
    var ids = S.manual.roster;
    var hasDraft = !!L.importFromDraft(store.get(L.DRAFT_MANUAL_KEY));
    if (!ids.length) {
      sec.innerHTML = U.emptyState({ title: 'Add Your Roster to Find Pickups', body: 'Search your players and we\'ll rank every free agent by how much he adds to your lineup. Your roster stays on this device.',
        action: '<div class="nu-row-flex" style="justify-content:center;gap:8px;margin-top:16px"><button type="button" class="nu-btn nu-btn--primary" data-open-roster>Add Players</button>' + (hasDraft ? '<button type="button" class="nu-btn" data-import>Import from Draft Board</button>' : '') + '</div>' });
    } else {
      var stack = ids.slice(0, 7).map(function (id) { var p = S.byId[id] || { id: id, name: id }; return U.avatar(p, { size: 'sm' }); }).join('');
      sec.innerHTML = '<div class="wv-roster-sum"><span class="wv-stack" aria-hidden="true">' + stack + '</span><span class="wv-roster-sum__txt"><b>' + ids.length + ' player' + (ids.length === 1 ? '' : 's') + ' on your team</b><span class="nu-hint">' +
        (S.manual.assumeTaken === false ? 'Everyone else counts as available' : 'Top of the board counts as owned') + (S.manual.exclude.length ? ' · ' + S.manual.exclude.length + ' hidden' : '') + '</span></span>' +
        '<button type="button" class="nu-btn nu-btn--sm" data-open-roster>Edit Roster</button></div>';
    }
    renderRosterSheet();
  }

  function renderRosterSheet() {
    var ids = S.manual.roster;
    $('wv-rcount').textContent = 'On Your Team · ' + ids.length + ' / ' + L.MAX_ROSTER;
    $('wv-rlist').innerHTML = ids.map(function (id) {
      var p = S.byId[id] || { id: id, name: id };
      return '<li>' + U.playerCell(p, { size: 'md', meta: U.posPill(posOf(p).slice(0, 3)) + '<span>' + esc(p.team || '') + '</span>' + (p.injury ? U.injuryBadge(p.injury) : '') }) +
        '<button type="button" class="nu-btn nu-btn--ghost nu-btn--icon nu-btn--sm" data-rm="' + esc(id) + '" aria-label="Remove ' + esc(p.name) + '">' + U.icon.close + '</button></li>';
    }).join('') || '<li class="nu-hint">No players yet. Search above.</li>';
    $('wv-assume').setAttribute('aria-checked', String(S.manual.assumeTaken !== false));
    var au = $('wv-adds-used'), pi = $('wv-priority'), r = S.result;
    if (document.activeElement !== au) au.value = S.manual.addsUsed != null ? S.manual.addsUsed : '';
    if (document.activeElement !== pi) pi.value = S.manual.priority != null ? S.manual.priority : '';
    if (r && r.adds && r.adds.max != null) au.max = r.adds.max;
    if (r && r.priority && r.priority.teams) pi.max = r.priority.teams;
    $('wv-import').hidden = !L.importFromDraft(store.get(L.DRAFT_MANUAL_KEY));
  }

  function renderAll() {
    renderControls();
    renderManual();
    var r = S.result;
    renderHero(r);
    renderSwaps(r);
    renderList(r);
    renderCalendar(r);
    renderSide(r);
    renderRules(r);
    if (!r && !S.loading) { $('wv-list').innerHTML = ''; $('wv-count').textContent = ''; }
    var emptyManual = S.source === 'manual' && !S.manual.roster.length;
    $('wv-grid').hidden = !r && !S.loading;
    $('wv-horizon').hidden = emptyManual;
    if (emptyManual) $('wv-week').hidden = true;
    U.hydrateImages(document.getElementById('wv-app'));
  }

  function skeleton() {
    $('wv-list').innerHTML = '<li class="nu-card nu-card--flush">' + U.skeleton(6) + '</li>';
    $('wv-count').textContent = 'Ranking free agents…';
    $('wv-hero').hidden = false;
    $('wv-hero').innerHTML = U.skeleton(3, { kind: 'tile' });
  }

  /* --------------------------------------------------------------- data */
  function altHorizon(h) { return h === 1 ? 4 : 1; }

  function load() {
    var my = ++S.seq;
    S.loading = true;
    skeleton();
    var done = function (pair) {
      if (my !== S.seq) return;
      var r = pair[0];
      S.loading = false; S.result = r; S.alt = pair[1] ? L.gainsById(pair[1]) : null; S.altH = altHorizon(S.prefs.horizon); S.shown = PAGE;
      if (r && r.mode === 'yahoo' && r.rules && r.rules.uses_faab) callout('info', '<b>FAB league.</b> Waiver claims are blind bids; free agents can be added straight away.');
      else if (r && r.mode !== 'manual') callout(null, '');
      renderAll();
      U.stagger($('wv-list'));
    };
    var fail = function (e) {
      if (my !== S.seq) return;
      S.loading = false; S.result = null;
      if (e.code === 'yahoo_not_connected' || e.code === 'yahoo_reauth') {
        callout('error', '<b>Yahoo needs reconnecting.</b> <a href="/nba/auth/login">Connect Yahoo</a> or switch to Manual roster.');
      } else {
        callout('error', '<b>Couldn\'t rank free agents.</b> ' + esc(e.message) + ' <button type="button" class="nu-btn nu-btn--sm" id="wv-retry">Retry</button>');
        var b = $('wv-retry'); if (b) b.onclick = load;
      }
      renderAll();
    };
    var h = S.prefs.horizon, ah = altHorizon(h);
    if (S.source === 'manual') {
      callout(null, '');
      if (!S.manual.roster.length) {
        S.loading = false; S.result = null; renderAll();
        $('wv-hero').hidden = true;
        return Promise.resolve();
      }
      var extra = S.manual.assumeTaken === false ? [] : L.likelyRostered(S.players || [], S.manual.roster, DEFAULT_TEAMS, DEFAULT_PER_TEAM);
      var req = function (hz) { return api('/api/nba/waivers/manual', { method: 'POST', body: L.manualRequest(S.manual, hz, S.prefs.week, extra) }); };
      return Promise.all([req(h), req(ah).catch(function () { return null; })]).then(done, fail);
    }
    var lk = S.source;
    var tkP = S.teamKey ? Promise.resolve(S.teamKey) : api('/api/nba/yahoo/league?league_key=' + encodeURIComponent(lk)).then(function (j) {
      if (!j.myTeamKey) throw new Error('No team of yours in this league.');
      S.teamKey = j.myTeamKey; return S.teamKey;
    });
    return tkP.then(function (tk) {
      var url = function (hz) { return '/api/nba/waivers?league_key=' + encodeURIComponent(lk) + '&team_key=' + encodeURIComponent(tk) + '&weeks=' + hz + (S.prefs.week ? '&week=' + S.prefs.week : ''); };
      return Promise.all([api(url(h)), api(url(ah)).catch(function () { return null; })]);
    }).then(done, fail);
  }

  function ensurePlayers() {
    if (S.players) return Promise.resolve(S.players);
    return api('/api/nba/players?profile=242808').then(function (j) {
      S.players = (j.players || []).slice().sort(function (a, b) { return (a.rank || 1e9) - (b.rank || 1e9); });
      S.byId = {}; S.players.forEach(function (p) { S.byId[String(p.id)] = p; });
      return S.players;
    }).catch(function () { S.players = []; return S.players; });
  }

  function populateSources() {
    var sel = $('wv-source');
    if (!S.leagues.length) { sel.hidden = true; return; }
    sel.innerHTML = S.leagues.map(function (l) { return '<option value="' + esc(l.league_key) + '">' + esc(l.name || l.league_key) + '</option>'; }).join('') + '<option value="manual">Manual roster</option>';
    sel.value = S.source;
    sel.hidden = false;
  }

  function boot() {
    renderControls();
    skeleton();
    // One shared status fetch with the nav's Yahoo chip (yahoo-chip.js) when it's on the page.
    var statusP = (window.PocketYahoo && window.PocketYahoo.status ? Promise.resolve(window.PocketYahoo.status()) : api('/api/nba/yahoo/status'))
      .then(function (st) { return st || { connected: false }; }, function () { return { connected: false }; });
    return Promise.all([statusP, ensurePlayers()]).then(function (res) {
      var st = res[0];
      S.leagues = st.connected && Array.isArray(st.leagues) ? st.leagues : [];
      $('wv-connect').hidden = !!st.connected;
      var pref = S.prefs.source;
      if (S.leagues.length && pref !== 'manual') {
        S.source = S.leagues.some(function (l) { return l.league_key === pref; }) ? pref : S.leagues[0].league_key;
      } else S.source = 'manual';
      populateSources();
      return load();
    });
  }

  /* ------------------------------------------------------------- copy */
  function copy(text, btn) {
    var ok = function () { U.toast('Claim copied. Paste it in Yahoo or your notes.', { tone: 'good' }); if (btn) { btn.setAttribute('data-done', '1'); } };
    var fallback = function () {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { U.toast('Copy failed: ' + text, { tone: 'bad', timeout: 8000 }); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
  }
  function pairText(p) {
    var r = S.result;
    return L.claimText(Object.assign({}, S.byId[p.add.id], p.add), p.drop ? Object.assign({}, S.byId[p.drop.id], p.drop) : null, { gain: p.netGain, span: 'pts ' + gainSpan(), waiverDays: r && r.waiverRules && r.waiverRules.waiverDays });
  }

  /* ----------------------------------------------------------- events */
  function reloadManual() { saveManual(); renderManual(); load(); }

  function bind() {
    $('wv-how-ic').innerHTML = U.icon.info;
    $('wv-search-ic').innerHTML = U.icon.search;
    $('wv-how-x').innerHTML = U.icon.close;
    $('wv-roster-x').innerHTML = U.icon.close;
    $('wv-how').addEventListener('click', function () { U.sheet.open('wv-how-sheet'); });

    $('wv-horizon').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-h]'); if (!b) return;
      S.prefs.horizon = L.normalizeHorizon(b.dataset.h); savePrefs(); renderControls(); load();
    });
    $('wv-week').addEventListener('change', function (e) {
      var w = Number(e.target.value);
      S.prefs.week = w && S.result && w === S.result.startWeek && !S.prefs.week ? null : w; savePrefs(); load();
    });
    $('wv-filters').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.pos) S.prefs.pos = b.dataset.pos;
      else if (b.dataset.flag) S.prefs[b.dataset.flag] = !S.prefs[b.dataset.flag];
      else return;
      S.shown = PAGE; savePrefs(); renderControls(); renderList(S.result); U.hydrateImages($('wv-list'));
    });
    $('wv-sort').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-sort]'); if (!b) return;
      S.prefs.sort = b.dataset.sort; savePrefs(); renderControls(); renderList(S.result); U.hydrateImages($('wv-list'));
    });
    $('wv-more').addEventListener('click', function () { S.shown += PAGE; renderList(S.result); U.hydrateImages($('wv-list')); });
    $('wv-source').addEventListener('change', function (e) { S.source = e.target.value; S.teamKey = null; S.result = null; callout(null, ''); savePrefs(); renderAll(); load(); });

    $('wv-list').addEventListener('click', function (e) {
      var ct = e.target.closest('button[data-copy-t]');
      if (ct) {
        var t = (S.result.targets || []).filter(function (x) { return String(x.id) === ct.dataset.copyT; })[0];
        if (t) copy(L.claimText(Object.assign({}, S.byId[t.id], t), t.drop ? Object.assign({}, S.byId[t.drop.id], t.drop) : null, { gain: t.netGain, span: 'pts over ' + horizonWord(S.prefs.horizon), waiverDays: S.result.waiverRules && S.result.waiverRules.waiverDays }), ct);
        return;
      }
      var act = e.target.closest('button[data-act]');
      if (act) {
        var id = act.dataset.id;
        S.manual = act.dataset.act === 'add' ? L.addToRoster(S.manual, id) : act.dataset.act === 'waiver' ? L.toggleWaiver(S.manual, id) : L.toggleExclude(S.manual, id);
        delete S.open[id];
        if (act.dataset.act === 'taken') U.toast('Hidden. He won\'t show up again.', { action: { label: 'Undo', onClick: function () { S.manual = L.toggleExclude(S.manual, id); reloadManual(); } } });
        reloadManual();
        return;
      }
      var row = e.target.closest('button.wv-t__main'); if (!row) return;
      var rid = row.dataset.id;
      if (S.open[rid]) delete S.open[rid]; else S.open[rid] = 1;
      renderList(S.result); U.hydrateImages($('wv-list'));
      var again = $('wv-list').querySelector('button.wv-t__main[data-id="' + rid.replace(/"/g, '') + '"]'); if (again) again.focus();
    });

    var onCopyPair = function (e) {
      var b = e.target.closest('button[data-copy]'); if (!b || !S.result) return;
      var p = (S.result.pairs || [])[Number(b.dataset.copy)]; if (p) copy(pairText(p), b);
    };
    $('wv-swaps').addEventListener('click', onCopyPair);
    $('wv-more-swaps').addEventListener('click', onCopyPair);
    $('wv-ab-copy').addEventListener('click', function () { var p = S.result && (S.result.pairs || [])[0]; if (p) copy(pairText(p), this); });

    $('wv-roster-sheet').addEventListener('change', function (e) {
      var id = e.target.id;
      if (id !== 'wv-adds-used' && id !== 'wv-priority') return;
      S.manual = L.setNumber(S.manual, id === 'wv-priority' ? 'priority' : 'addsUsed', e.target.value);
      saveManual(); dirty = true;
    });
    var openRoster = function (e) {
      var o = e.target.closest('[data-open-roster]');
      if (o) { U.sheet.open('wv-roster-sheet', { initialFocus: o.dataset.focus || '#wv-search', onClose: function () { setTimeout(flush, 0); } }); return; }
      if (e.target.closest('[data-import]')) importDraft();
    };
    $('wv-manual').addEventListener('click', openRoster);
    $('wv-hero').addEventListener('click', openRoster);
    var importDraft = function () {
      var st = L.importFromDraft(store.get(L.DRAFT_MANUAL_KEY));
      if (!st) return;
      S.manual = st; reloadManual(); renderRosterSheet();
    };
    $('wv-import').addEventListener('click', importDraft);
    $('wv-rlist').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-rm]'); if (!b) return;
      S.manual = L.removeFromRoster(S.manual, b.dataset.rm); saveManual(); renderRosterSheet(); U.hydrateImages($('wv-rlist'));
      dirty = true;
    });
    $('wv-assume').addEventListener('click', function () {
      var on = S.manual.assumeTaken === false;
      var st = L.loadManual(S.manual);
      if (on) delete st.assumeTaken; else st.assumeTaken = false;
      S.manual = L.loadManual(st); saveManual(); renderRosterSheet(); dirty = true;
    });

    // The roster sheet batches edits: reload once when it closes.
    var dirty = false;
    var search = $('wv-search'), results = $('wv-results');
    var hideResults = function () { results.innerHTML = ''; };
    search.addEventListener('input', function () {
      var hits = L.searchPlayers(S.players || [], search.value, S.manual.roster, 6);
      if (!hits.length) return hideResults();
      results.innerHTML = hits.map(function (p) {
        return '<li><button type="button" role="option" data-pick="' + esc(p.id) + '">' + U.playerCell(p, { size: 'md', meta: U.posPill(posOf(p).slice(0, 3)) + '<span>' + esc(p.team || 'FA') + '</span>' + (p.injury ? U.injuryBadge(p.injury) : '') + '<span class="nu-sep"></span><span class="nu-num">#' + esc(p.rank || '—') + '</span>' }) + '<span class="nu-accent" aria-hidden="true">' + U.icon.waivers + '</span></button></li>';
      }).join('');
      U.hydrateImages(results);
    });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var f = results.querySelector('button'); if (f) { e.preventDefault(); f.click(); } }
    });
    results.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-pick]'); if (!b) return;
      S.manual = L.addToRoster(S.manual, b.dataset.pick); saveManual();
      search.value = ''; hideResults(); renderRosterSheet(); U.hydrateImages($('wv-rlist')); search.focus();
      dirty = true;
    });
    function flush() { if (dirty && !U.sheet.isOpen()) { dirty = false; renderManual(); load(); } }

    window.addEventListener('storage', function (e) {
      if (e.key === L.MANUAL_KEY && S.source === 'manual') { S.manual = L.loadManual(e.newValue); renderManual(); load(); }
    });
  }

  /* ------------------------------------------------------------ clerk */
  function initClerk() {
    var key = window.__clerk_publishable_key;
    if (!key || key.indexOf('PLACEHOLDER') >= 0) return;
    var auth = document.querySelector('#rr-nav .rr-auth');
    if (auth && !$('user-btn-mount')) auth.insertAdjacentHTML('beforeend', '<div id="user-btn-mount"></div><button type="button" class="nu-btn nu-btn--sm" id="rr-sign-in" hidden>Sign In</button>');
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
    s.crossOrigin = 'anonymous'; s.async = true;
    s.onload = function () {
      try {
        var clerk = (window.Clerk && typeof window.Clerk.load === 'function') ? window.Clerk : new window.Clerk(key);
        clerk.load({ telemetry: { disabled: true } }).then(function () {
          var btn = $('rr-sign-in');
          if (clerk.user) {
            clerk.mountUserButton($('user-btn-mount')); if (btn) btn.hidden = true;
            if (!S.leagues.length) boot(); // session was not ready for the first status call
          } else if (btn) { btn.hidden = false; btn.onclick = function () { clerk.openSignIn({ redirectUrl: '/nba/waivers' }); }; }
        });
      } catch (e) { console.warn('Clerk init failed', e); }
    };
    document.head.appendChild(s);
  }

  bind();
  renderControls();
  skeleton();
  // Deferred scripts (nav.js, yahoo-chip.js) have run by DOMContentLoaded.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { boot(); initClerk(); });
  else { boot(); initClerk(); }
}());
