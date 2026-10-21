/* Pocket NBA — team page controller (Stream C).
   League mode: the nav chip's Sleeper status (sleeper-chip.js) → GET /api/nba/team?league_id=&user_id=
   (power rankings + my team + trade ideas), GET /api/nba/team/detail on a row tap.
   Manual mode: roster editor (saved in localStorage) → POST /api/nba/team/manual
   (my team graded against a typical league; no power table). */
(function () {
  'use strict';
  var L = window.NbaTeam, U = window.NbaUI;
  var esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  var S = {
    st: L.emptyState(), connected: false, userId: null, username: null, leagues: [], leagueId: null,
    data: null, error: null, loading: true, sort: { key: 'rank', dir: 1 }, seq: 0,
    manual: false, manualData: null, manualBusy: false, manualTimer: null, board: null, boardById: {}, detailSeq: 0
  };

  function save() { try { localStorage.setItem(L.STORAGE_KEY, L.serialize(S.st)); } catch (e) {} }
  function load() { try { S.st = L.parseState(localStorage.getItem(L.STORAGE_KEY)); } catch (e) { S.st = L.emptyState(); } }
  function pref(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function setPref(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function f1(x) { return L.f1(x); }
  // Best healthy bench player minus a waiver add, signed ("+4.4", "−2.6"); "—" with no healthy bench.
  function coverValue(t) { return t.benchCover ? L.signed(t.benchCover.vsWaiver).replace('-', '−') : '—'; }
  function dir(n) { return n > 0.05 ? 'is-up' : n < -0.05 ? 'is-down' : ''; }

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
    var b = $('tm-banner');
    if (!msg) { b.hidden = true; b.innerHTML = ''; return; }
    b.innerHTML = U.callout(kind || 'warn', msg);
    b.hidden = false;
  }

  /* ------------------------------------------------------------ helpers */
  function analysis() { return S.manual ? (S.manualData && S.manualData.analysis) : (S.data && S.data.analysis); }
  function players() { return (S.manual ? S.manualData && S.manualData.players : S.data && S.data.players) || {}; }
  function myTeam() {
    var a = analysis(); if (!a || !a.myRosterId) return null;
    for (var i = 0; i < a.teams.length; i++) if (a.teams[i].rosterId === a.myRosterId) return a.teams[i];
    return null;
  }
  function teamById(id) { var a = analysis(); if (!a) return null; for (var i = 0; i < a.teams.length; i++) if (a.teams[i].rosterId === id) return a.teams[i]; return null; }
  function initials(name) {
    var parts = String(name || '').replace(/[^A-Za-z0-9À-ɏ\s]/g, '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0].charAt(0) + (parts.length > 1 ? parts[1].charAt(0) : '')).toUpperCase();
  }
  function teamAvatar(t, size) {
    var url = L.avatarUrl(t && t.avatar), sz = size || 'md', px = { sm: 32, md: 40, lg: 56 }[sz] || 40;
    return '<span class="nu-avatar nu-avatar--' + sz + '" role="img" aria-label="' + esc(t ? t.name : 'Team') + '"><span aria-hidden="true">' + esc(initials(t && t.name)) + '</span>' +
      (url ? '<img src="' + esc(url) + '" data-srcs="' + esc(url) + '" alt="" loading="lazy" decoding="async" width="' + px + '" height="' + px + '">' : '') + '</span>';
  }
  function playerAvatar(p, size) { return U.avatar(p || {}, { size: size || 'sm', teamBadge: true, injuryDot: true }); }
  function playerCell(p, extraMeta, size, line) {
    p = p || {};
    var meta = U.posPill((p.pos || []).slice(0, 2)) + (p.team ? '<span>' + esc(p.team) + '</span>' : '<span>FA</span>') +
      (p.injury || p.outForSeason ? U.injuryBadge(p.injury, { outForSeason: p.outForSeason }) : '') + (extraMeta || '');
    return '<div class="nu-player">' + playerAvatar(p, size) + '<div class="nu-player__text"><span class="nu-player__name">' + esc(p.name || 'Player') + '</span><div class="nu-player__meta">' + meta + '</div>' +
      (line ? '<div class="nu-hint">' + esc(line) + '</div>' : '') + '</div></div>';
  }
  function tierHtml(group, team, opts) {
    opts = opts || {};
    var g = team.groups && team.groups[group];
    var m = L.tierMeta(g && g.tier);
    var est = analysis() && analysis().estimated;
    var rank = team.groupRank ? L.ordinal(team.groupRank[group]) : '';
    return '<span class="tm-tier' + (opts.pill ? ' tm-tier--pill' : '') + '" data-tone="' + m.tone + '" title="' + esc(L.GROUP_NAME[group] + ': ' + m.label + '. ' + m.help) + '">' +
      (opts.pill ? '<span class="tm-g">' + esc(group) + '</span>' : '') + (opts.label ? '<span class="tm-glabel">' + esc(group) + '</span>' : '') +
      '<span class="tm-tier__main"><span class="tm-tier__glyph" aria-hidden="true">' + m.glyph + '</span>' + esc(m.label) + '</span>' +
      (opts.noRank ? '' : '<span class="tm-tier__rank">' + esc(rank) + (est ? ' vs typical' : '') + '</span>') + '</span>';
  }
  function leanChip(lean) { return '<span class="nu-tag tm-lean" data-lean="' + esc(lean) + '">' + esc(L.LEAN[lean] || 'Preseason') + '</span>'; }

  /* ------------------------------------------------------------ header + mode */
  function renderHeader() {
    var a = analysis(), d = S.manual ? S.manualData : S.data;
    var lg = d && d.league;
    if (S.manual) {
      $('tm-eyebrow').textContent = 'High Score · Manual';
      $('tm-title').textContent = 'Your Team';
      $('tm-sub').textContent = 'Your roster graded slot by slot against a typical 12-team league, with the weeks and injuries that matter.';
    } else {
      $('tm-eyebrow').textContent = lg ? lg.name + ' · Week ' + lg.currentWeek + (a && a.gamesPlayed ? '' : ' · Preseason') : 'High Score · Team';
      $('tm-title').textContent = 'Power Rankings';
      $('tm-sub').textContent = 'Every team ranked by its best weekly lineup, with the spots each team is short at and who to trade with.';
    }
    var foot = [];
    if (d && d.asOf) foot.push('Player data ' + String(d.asOf).slice(0, 10));
    if (lg) foot.push(lg.teams + ' teams · ' + lg.starters + ' starters (' + (lg.slotList || []).join(' ') + ')' + (lg.playoffStartWeek ? ' · playoffs from week ' + lg.playoffStartWeek : ''));
    if (a && a.replacement) foot.push('waiver level ' + f1(a.replacement.ros) + '/wk');
    $('tm-foot').textContent = foot.join(' · ');
  }

  function renderMode() {
    var sel = $('tm-league'), va = $('tm-viewas');
    $('tm-connect').hidden = S.connected || S.loading;
    var tag = $('tm-mode-tag');
    tag.hidden = !S.manual || S.loading;
    tag.textContent = 'Manual';
    var d = S.data;
    var showVA = !S.manual && d && d.analysis && (!d.ownRosterId);
    va.hidden = !showVA;
    if (showVA) {
      var cur = d.analysis.myRosterId || '';
      va.innerHTML = '<option value="">Pick a team to view as</option>' + d.analysis.teams.slice().sort(function (x, y) { return Number(x.rosterId) - Number(y.rosterId); })
        .map(function (t) { return '<option value="' + esc(t.rosterId) + '"' + (t.rosterId === cur ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('');
    }
    sel.hidden = !S.connected || !S.leagues.length;
    var h = $('tm-horizon');
    Array.prototype.forEach.call(h.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-value') === S.st.horizon ? 'true' : 'false'); });
  }

  /* ------------------------------------------------------------ my team summary */
  function renderMe() {
    var box = $('tm-me'), a = analysis(), t = myTeam();
    if (!a || !t) { box.hidden = true; return; }
    var n = a.teams.length;
    var injTotal = t.injuryExposure || {};
    var stats = [
      U.statTile({ label: 'Strength', value: t.strengthRos, sub: 'pts/wk · ' + (a.estimated ? 'vs typical' : L.ordinal(t.powerRank) + ' of ' + n), tone: 'accent' }),
      U.statTile({ label: 'This Week', value: t.strengthNow, sub: a.estimated ? (t.scheduleThisWeek.games + ' games') : L.ordinal(t.nowRank) + ' · ' + t.scheduleThisWeek.games + ' games' }),
      U.statTile({ label: 'Injury Cost', value: injTotal.thisWeek ? -injTotal.thisWeek : 0, sub: (injTotal.count || 0) + ' hurt · this week' }),
      U.statTile({ label: 'Bench Cover', value: coverValue(t), sub: a.estimated ? 'vs waiver add' : L.ordinal(t.coverRank) + ' · vs waiver add' })
    ];
    var groups = L.GROUPS.map(function (g) {
      var G = t.groups[g] || {};
      return '<div class="tm-gcell"><span class="tm-glabel">' + esc(L.GROUP_NAME[g]) + (g === 'UTIL' ? '' : ' (' + g + ')') + '</span>' + tierHtml(g, t, { noRank: true }) +
        '<div class="tm-gcell__v">' + f1(G.starterValue) + ' vs ' + f1(a.leagueAvg[g]) + ' avg' + (a.estimated ? '' : ' · ' + L.ordinal(t.groupRank[g])) + '</div></div>';
    }).join('');
    box.innerHTML = '<div class="tm-me__top"><div class="tm-me__id">' +
      (a.estimated ? '' : '<span class="tm-me__rank">#' + t.powerRank + '<small>/' + n + '</small></span>') + teamAvatar(t, 'lg') +
      '<div style="min-width:0"><div class="tm-me__name" id="tm-me-h">' + esc(t.name) + (a.estimated ? '' : '<span class="tm-you">You</span>') + '</div>' +
      '<div class="tm-me__line">' + esc(L.teamHeadline(t, a)) + '</div>' +
      '<div class="tm-me__chips">' + leanChip(t.lean) + '<span class="nu-tag">' + esc(L.HORIZON[a.horizon]) + '</span>' + (a.estimated ? '<span class="tm-badge-est">Vs Typical League</span>' : '') + '</div></div></div>' +
      '<div class="nu-stats">' + stats.join('') + '</div></div>' +
      '<div class="tm-me__groups">' + groups + '</div>';
    box.hidden = false;
    U.hydrateImages && U.hydrateImages(box);
  }

  /* ------------------------------------------------------------ power table */
  var COLS = [
    { key: 'rank', label: '#', num: true },
    { key: 'team', label: 'Team', cls: 'tm-col-team' },
    { key: 'record', label: 'Record', num: true },
    { key: 'pts', label: 'Pts', num: true, wide: true },
    { key: 'strength', label: 'Strength', num: true },
    { key: 'now', label: 'This Wk', num: true },
    { key: 'G', label: 'G' }, { key: 'F', label: 'F' }, { key: 'C', label: 'C' }, { key: 'UTIL', label: 'UTIL', wide: true },
    { key: 'inj', label: 'Injuries', num: true },
    { key: 'cover', label: 'Cover', num: true, wide: true }
  ];
  function renderPower() {
    var box = $('tm-power'), a = analysis();
    if (S.manual || !a) { box.hidden = true; return; }
    box.hidden = false;
    var sorted = L.sortTeams(a.teams, S.sort.key, S.sort.dir);
    var max = Math.max.apply(null, a.teams.map(function (t) { return t.strengthRos || 0; }));
    var min = Math.min.apply(null, a.teams.map(function (t) { return t.strengthRos || 0; }));
    var bar = function (v) { var f = max > min ? 0.15 + 0.85 * (v - min) / (max - min) : 1; return '<span class="tm-bar" aria-hidden="true"><i style="width:' + (f * 100).toFixed(1) + '%"></i></span>'; };
    var gp = a.gamesPlayed;
    $('tm-power-note').textContent = 'Strength = projected weekly lineup points, ' + L.HORIZON[a.horizon].toLowerCase() + (a.horizon === 'ros' ? ' (playoff weeks 1.5×)' : '') + '. Tap a team for its roster.';
    $('tm-thead').innerHTML = '<tr>' + COLS.map(function (c) {
      var on = S.sort.key === c.key;
      var sortAttr = on ? ' aria-sort="' + (S.sort.dir === 1 ? 'ascending' : 'descending') + '"' : '';
      return '<th scope="col" class="' + [c.num ? 'nu-col-num' : '', c.cls || '', c.wide ? 'tm-col-wide' : ''].join(' ').trim() + '"' + sortAttr + '><button type="button" data-sort="' + c.key + '">' + esc(c.label) + '</button></th>';
    }).join('') + '</tr>';
    $('tm-tbody').innerHTML = sorted.map(function (t) {
      var me = t.rosterId === a.myRosterId;
      var inj = t.injuryExposure || {};
      return '<tr data-team="' + esc(t.rosterId) + '" tabindex="0" class="' + (me ? 'is-me' : '') + '" aria-label="' + esc(L.ordinal(t.powerRank) + ': ' + t.name + ', ' + f1(t.strengthRos) + ' points per week') + '">' +
        '<td class="nu-col-num"><span class="tm-rank"' + (t.powerRank <= 3 ? ' data-top="true"' : '') + '>' + t.powerRank + '</span></td>' +
        '<td class="tm-col-team"><div class="tm-team">' + teamAvatar(t, 'sm') + '<div class="tm-team__text"><span class="tm-team__name">' + esc(t.name) + (me ? '<span class="tm-you">You</span>' : '') + '</span>' +
          '<span class="tm-team__sub">' + (t.displayName ? '@' + esc(t.displayName) : '') + (t.lean && t.lean !== 'preseason' ? ' · ' + esc(L.LEAN[t.lean]) : '') + '</span></div></div></td>' +
        '<td class="nu-col-num">' + esc(L.recordText(t, gp)) + '</td>' +
        '<td class="nu-col-num tm-col-wide">' + (gp ? f1(t.record.fpts) : '—') + '</td>' +
        '<td class="nu-col-num"><div class="tm-strength"><b>' + f1(t.strengthRos) + '</b>' + bar(t.strengthRos) + '</div></td>' +
        '<td class="nu-col-num">' + f1(t.strengthNow) + '<div class="tm-sub">' + esc(L.ordinal(t.nowRank)) + '</div></td>' +
        L.GROUPS.map(function (g) { return '<td' + (g === 'UTIL' ? ' class="tm-col-wide"' : '') + '>' + tierHtml(g, t) + '</td>'; }).join('') +
        '<td class="nu-col-num"><span class="tm-inj"><b>' + (inj.count || 0) + '</b><span class="' + (inj.thisWeek >= 0.1 ? 'is-down' : 'tm-sub') + '">' + (inj.thisWeek >= 0.1 ? '−' + f1(inj.thisWeek) : 'none') + '</span></span></td>' +
        '<td class="nu-col-num tm-col-wide" title="' + esc(L.coverText(t.benchCover)) + '">' + coverValue(t) + '</td></tr>';
    }).join('');
    $('tm-sort-m').value = S.sort.key in L.SORTS ? S.sort.key : 'rank';
    $('tm-cards').innerHTML = sorted.map(function (t) {
      var me = t.rosterId === a.myRosterId, inj = t.injuryExposure || {};
      return '<li><button type="button" class="tm-card' + (me ? ' is-me' : '') + '" data-team="' + esc(t.rosterId) + '" aria-label="' + esc(L.ordinal(t.powerRank) + ': ' + t.name + '. Open roster') + '">' +
        '<span class="tm-rank"' + (t.powerRank <= 3 ? ' data-top="true"' : '') + '>' + t.powerRank + '</span>' +
        '<span class="tm-team">' + teamAvatar(t, 'sm') + '<span class="tm-team__text"><span class="tm-team__name">' + esc(t.name) + (me ? '<span class="tm-you">You</span>' : '') + '</span>' +
          '<span class="tm-team__sub">' + (gp ? esc(L.recordText(t, gp)) + ' · ' : '') + (t.displayName ? '@' + esc(t.displayName) : '') + '</span></span></span>' +
        '<span class="tm-card__num"><b>' + f1(t.strengthRos) + '</b><span class="tm-sub">pts/wk</span></span>' +
        '<span class="tm-card__tiers">' + L.GROUPS.map(function (g) { return tierHtml(g, t, { label: true }); }).join('') + '</span>' +
        '<span class="tm-card__foot"><span>This week <b>' + f1(t.strengthNow) + '</b> (' + esc(L.ordinal(t.nowRank)) + ')</span><span>Hurt <b>' + (inj.count || 0) + '</b>' + (inj.thisWeek >= 0.1 ? ' −' + f1(inj.thisWeek) : '') + '</span><span>Cover <b>' + coverValue(t) + '</b></span></span>' +
        '</button></li>';
    }).join('');
    U.hydrateImages && U.hydrateImages(box);
  }

  /* ------------------------------------------------------------ my team details */
  function linesHtml(items) {
    var ic = { good: '+', bad: '!', warn: '!', flat: '·' };
    return '<ul class="tm-lines">' + items.map(function (x) { return '<li data-tone="' + x.tone + '"><span class="tm-lines__ic" aria-hidden="true">' + ic[x.tone] + '</span><span>' + esc(x.text) + '</span></li>'; }).join('') + '</ul>';
  }
  function renderDetails() {
    var box = $('tm-details'), a = analysis(), t = myTeam();
    if (!a || !t) { box.hidden = true; return; }
    box.hidden = false;
    var byId = players(), n = a.teams.length;
    // Strengths + weaknesses
    var weak = t.weaknesses.map(function (w) { return { tone: L.tierMeta(w.tier).tone === 'bad' ? 'bad' : 'warn', text: L.weaknessText(t, w, n, byId, a.leagueAvg[w.group]) }; });
    var strong = t.strengths.map(function (s) { return { tone: 'good', text: L.strengthText(t, s, n, byId) }; });
    var needs = '<div class="nu-card__head"><h2 class="nu-card__title" id="tm-needs-h">Strengths and Weaknesses</h2></div>';
    needs += weak.length ? '<div class="tm-sub-h">Needs</div>' + linesHtml(weak) : '<div class="tm-sub-h">Needs</div><p class="nu-hint">No weak spot: every group is at or above the league average with depth.</p>';
    if (strong.length) needs += '<div class="tm-sub-h">Strengths</div>' + linesHtml(strong);
    if (t.elite && t.elite.length) needs += '<div class="tm-sub-h">Elite Starters</div><div class="tm-chips">' + t.elite.map(function (e) { return '<span class="nu-tag">' + esc(e.name) + ' <b>' + f1(e.value) + '</b></span>'; }).join('') + '</div>';
    if (t.liabilities && t.liabilities.length) needs += '<div class="tm-sub-h">Weak Starters (Near Waiver Level)</div><div class="tm-chips">' + t.liabilities.map(function (e) { return '<span class="nu-tag">' + esc(e.slot) + ' · ' + esc(e.name) + ' <b>' + f1(e.value) + '</b></span>'; }).join('') + '</div>';
    $('tm-needs').innerHTML = needs;

    // Injuries + schedule
    var h = '<div class="nu-card__head"><h2 class="nu-card__title" id="tm-health-h">Injuries and Schedule</h2></div>';
    var inj = t.injured || [];
    h += '<div class="tm-sub-h">Injured (' + inj.length + ')</div>';
    h += inj.length ? inj.map(function (x) {
      var p = byId[x.id] || { id: x.id, name: x.name, team: x.team, injury: x.status, outForSeason: x.outForSeason };
      return '<div class="tm-inj-row">' + playerCell(p, '', 'sm', L.injuryLine(x)) +
        (x.lostThisWeek >= 0.1 ? '<span class="tm-inj-row__lost" title="Lineup points this injury costs this week">−' + f1(x.lostThisWeek) + '</span>' : '') + '</div>';
    }).join('') : '<p class="nu-hint">Nobody on your roster is listed as injured.</p>';
    if (inj.length) h += '<p class="nu-hint" style="margin-top:var(--nu-2)">Red numbers: points the injury costs this week' + (inj.some(function (x) { return x.eta; }) ? '' : '. Return dates show here once the injury feed has them') + '.</p>';
    var sched = L.scheduleText(t);
    var avgVol = a.teams.reduce(function (s, x) { return s + (x.volatility || 0); }, 0) / (a.teams.length || 1);
    h += '<div class="tm-sub-h">This Week</div><ul class="tm-lines">' +
      (sched ? '<li data-tone="flat"><span class="tm-lines__ic" aria-hidden="true">·</span><span>' + esc(sched) + '.</span></li>' : '') +
      (!a.estimated && t.opponent && teamById(t.opponent) ? '<li data-tone="flat"><span class="tm-lines__ic" aria-hidden="true">·</span><span>' + esc('Matchup vs ' + teamById(t.opponent).name + ' (' + f1(teamById(t.opponent).strengthNow) + ' projected).') + '</span></li>' : '') +
      (t.volatility != null ? '<li data-tone="flat"><span class="tm-lines__ic" aria-hidden="true">·</span><span>' + esc(t.volatility > avgVol * 1.05 ? 'Boom-or-bust lineup: your starters swing more than the league average, which High Score rewards.' : t.volatility < avgVol * 0.95 ? 'Steady lineup: your starters swing less than the league average.' : 'Average game-to-game swing for your starters.') + '</span></li>' : '') + '</ul>';
    $('tm-health').innerHTML = h;

    // Trade ideas
    var tr = '<div class="nu-card__head"><h2 class="nu-card__title" id="tm-trade-h">Trade Ideas</h2></div>';
    $('tm-trade').hidden = !!a.estimated; // manual mode: the roster card already offers Connect Sleeper
    if (a.estimated) {
      tr += '<p class="nu-body">Connect Sleeper to find the teams in your league that need what you have, with one-tap trades scored by the calculator.</p>' +
        '<button type="button" class="nu-btn nu-btn--sleeper" data-act="connect" style="margin-top:var(--nu-4)"><span class="nu-y" aria-hidden="true">S</span>Connect Sleeper</button>';
    } else {
      tr += '<div class="tm-sub-h">Teams That Need What You Have</div>';
      tr += a.partners && a.partners.length ? a.partners.map(function (p) {
        var pt = teamById(p.rosterId) || p;
        return '<div class="tm-partner"><div class="tm-team">' + teamAvatar(pt, 'sm') + '<div class="tm-team__text"><span class="tm-team__name">' + esc(p.name) + '</span><span class="tm-team__sub">' + esc(L.partnerText(p)) + '</span></div></div>' +
          '<button type="button" class="nu-btn nu-btn--ghost nu-btn--sm" data-team="' + esc(p.rosterId) + '" aria-label="View ' + esc(p.name) + '">View</button></div>';
      }).join('') : '<p class="nu-hint">No team is short where you have depth right now.</p>';
      tr += '<div class="tm-sub-h">Trade Targets</div>';
      var tg = a.targets || [];
      tr += tg.length ? tg.map(function (x) {
        var g = x.give[0], r = x.get[0];
        var gp = byId[g.id] || g, rp = byId[r.id] || r;
        return '<div class="tm-target"><div class="tm-target__swap">' +
          '<div class="tm-target__side"><span class="nu-label">Give</span><div class="tm-target__p">' + playerAvatar(gp, 'xs') + '<span>' + esc(g.name) + '</span></div></div>' +
          '<span class="tm-target__arrow" aria-hidden="true">⇄</span>' +
          '<div class="tm-target__side"><span class="nu-label">Get · Fills ' + esc(x.fills) + '</span><div class="tm-target__p">' + playerAvatar(rp, 'xs') + '<span>' + esc(r.name) + '</span></div></div></div>' +
          '<div class="tm-target__foot"><span class="tm-target__nums">You <b class="' + dir(x.you) + '">' + L.signed(x.you) + '</b>/wk · ' + esc(x.partnerName) + ' <b class="' + dir(x.them) + '">' + L.signed(x.them) + '</b>/wk</span>' +
          '<a class="nu-btn nu-btn--primary nu-btn--sm" href="' + esc(x.href) + '">Open in Trade</a></div></div>';
      }).join('') : '<p class="nu-hint">' + esc(a.targetsNote || 'No trade targets yet.') + '</p>';
    }
    $('tm-trade').innerHTML = tr;
    U.hydrateImages && U.hydrateImages(box);
  }

  /* ------------------------------------------------------------ manual */
  function renderManual() {
    var box = $('tm-manual');
    box.hidden = !S.manual;
    if (!S.manual) return;
    var ids = S.st.roster, by = S.boardById;
    // Connected but in manual mode (outage, categories league, no leagues): no Connect pitch.
    $('tm-manual-eyebrow').textContent = S.connected ? 'Manual Mode' : 'No League Connected';
    $('tm-manual-body').textContent = S.connected
      ? 'Add your players here and we grade your roster against a typical 12-team league. Pick a Sleeper league above to rank your real league.'
      : 'Connect Sleeper to rank every team in your league. Or add your players here and we grade your roster against a typical 12-team league.';
    $('tm-manual-connect').hidden = S.connected;
    $('tm-roster-n').textContent = 'Your Roster · ' + ids.length + ' player' + (ids.length === 1 ? '' : 's') + (ids.length && ids.length < 10 ? ' · add ' + (13 - ids.length) + ' more for a full lineup' : '');
    $('tm-roster-clear').hidden = !ids.length;
    var trade = L.tradeRoster(pref(L.TRADE_KEY));
    $('tm-roster-import').hidden = !!ids.length || !trade.length;
    $('tm-roster-list').innerHTML = ids.map(function (id) {
      var p = by[id] || players()[id] || { id: id, name: 'Player ' + id };
      return '<li>' + playerCell(p, p.hsValue != null ? '<span>' + f1(p.hsValue) + '/wk</span>' : '', 'sm') +
        '<button type="button" class="nu-btn nu-btn--ghost nu-btn--icon nu-btn--sm" data-remove="' + esc(id) + '" aria-label="Remove ' + esc(p.name) + '">' + U.icon.close + '</button></li>';
    }).join('');
    var q = $('tm-roster-q').value;
    var res = q && S.board ? L.search(S.board, q, 30).filter(function (p) { return ids.indexOf(String(p.id)) < 0; }).slice(0, 6) : [];
    $('tm-roster-opts').innerHTML = res.map(function (p) { return '<button type="button" class="tm-opt" role="option" data-add="' + esc(p.id) + '">' + playerCell(p, '', 'sm') + '</button>'; }).join('');
    U.hydrateImages && U.hydrateImages(box);
  }

  function scheduleManual() {
    clearTimeout(S.manualTimer);
    if (!S.manual) return;
    if (!S.st.roster.length) { S.manualData = null; render(); return; }
    S.manualTimer = setTimeout(runManual, 250);
  }
  function runManual() {
    var seq = ++S.seq;
    S.manualBusy = true;
    api('/api/nba/team/manual', { method: 'POST', body: { roster: S.st.roster, horizon: S.st.horizon } }).then(function (j) {
      if (seq !== S.seq) return;
      S.manualData = j;
      if (j.warnings && j.warnings.length) banner(esc(j.warnings.join(' ')));
    }).catch(function (e) {
      if (seq !== S.seq) return;
      S.manualData = null;
      banner(e.status === 429 ? 'Too many changes at once. Try again in a few seconds.' : e.status === 503 ? 'Player data is unavailable right now. Try again in a minute.' : esc(e.message || 'Network error'), 'error');
    }).then(function () { if (seq === S.seq) { S.manualBusy = false; render(); } });
  }

  function loadBoard() {
    if (S.board) return Promise.resolve();
    return api('/api/nba/players?profile=242808').then(function (d) {
      S.board = (d.players || []).filter(function (p) { return /^\d+$/.test(String(p.id)); }).sort(function (a, b) { return (a.rank || 1e9) - (b.rank || 1e9); });
      S.boardById = {}; S.board.forEach(function (p) { S.boardById[String(p.id)] = p; });
    }).catch(function () { banner('Player search is unavailable right now. Try again in a minute.', 'error'); });
  }

  function enterManual(reason, tone) {
    S.manual = true; S.data = null;
    if (reason) banner(reason, tone || 'warn');
    if (S.connected && S.leagues.length) $('tm-league').value = '';
    if (!S.st.roster.length) { var tr = L.tradeRoster(pref(L.TRADE_KEY)); if (tr.length) S.st.roster = tr; }
    render();
    return loadBoard().then(function () { render(); scheduleManual(); });
  }

  /* ------------------------------------------------------------ detail sheet */
  function openDetail(rid) {
    var a = analysis(); if (!a || S.manual) return;
    var t = teamById(rid); if (!t) return;
    var body = $('tm-detail-body');
    $('tm-detail-t').textContent = t.name;
    body.innerHTML = detailHead(t, a) + '<div style="margin-top:var(--nu-4)">' + U.skeleton(6) + '</div>';
    U.sheet.open('tm-detail-sheet');
    var seq = ++S.detailSeq;
    api('/api/nba/team/detail?league_id=' + encodeURIComponent(S.leagueId) + '&roster_id=' + encodeURIComponent(rid) + (S.userId ? '&user_id=' + encodeURIComponent(S.userId) : '') + (S.st.horizon !== 'ros' ? '&horizon=' + S.st.horizon : '')).then(function (d) {
      if (seq !== S.detailSeq) return;
      body.innerHTML = detailHead(t, a) + detailSpark(d.weeks) + detailRoster(d);
      U.hydrateImages && U.hydrateImages(body);
    }).catch(function (e) {
      if (seq !== S.detailSeq) return;
      body.innerHTML = detailHead(t, a) + U.callout('error', '<b>Couldn\'t load this roster.</b> ' + esc(e.status === 429 ? 'Sleeper is rate-limiting us. Try again in a few seconds.' : e.message || 'Network error'));
    });
  }
  function detailHead(t, a) {
    var n = a.teams.length, inj = t.injuryExposure || {};
    return '<div class="tm-dhead">' + teamAvatar(t, 'lg') + '<div style="min-width:0;flex:1"><div class="tm-me__line">' + esc(L.ordinal(t.powerRank) + ' of ' + n + ' · ' + (t.displayName ? '@' + t.displayName : '') + (a.gamesPlayed ? ' · ' + L.recordText(t, true) : '')) + '</div>' +
      '<div class="tm-me__chips">' + leanChip(t.lean) + (t.rosterId === a.myRosterId ? '<span class="tm-you" style="margin-left:0">You</span>' : '') + '</div></div></div>' +
      '<div class="nu-stats">' + U.statTile({ label: 'Strength', value: t.strengthRos, sub: L.ordinal(t.powerRank) + ' · pts/wk', tone: 'accent' }) + U.statTile({ label: 'This Week', value: t.strengthNow, sub: L.ordinal(t.nowRank) }) +
      U.statTile({ label: 'Injury Cost', value: inj.thisWeek ? -inj.thisWeek : 0, sub: (inj.count || 0) + ' hurt' }) + U.statTile({ label: 'Bench Cover', value: coverValue(t), sub: L.ordinal(t.coverRank) + ' · vs waiver add' }) + '</div>' +
      '<div class="tm-me__groups">' + L.GROUPS.map(function (g) { return '<div class="tm-gcell"><span class="tm-glabel">' + esc(L.GROUP_NAME[g]) + '</span>' + tierHtml(g, t) + '<div class="tm-gcell__v">' + f1((t.groups[g] || {}).starterValue) + ' vs ' + f1(a.leagueAvg[g]) + ' avg</div></div>'; }).join('') + '</div>';
  }
  function detailSpark(weeks) {
    var vals = (weeks || []).map(function (w) { return w.value; });
    if (vals.length < 2) return '';
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    return '<div class="tm-dspark"><div class="tm-sub-h">Strength by Week</div>' + U.sparkline(vals, { w: 640, h: 56, tone: 'good', label: 'Projected lineup points by week, ' + f1(lo) + ' to ' + f1(hi) }) +
      '<div class="tm-dspark__axis"><span>Wk ' + weeks[0].week + '</span><span>Low ' + f1(lo) + ' · High ' + f1(hi) + '</span><span>Wk ' + weeks[weeks.length - 1].week + '</span></div></div>';
  }
  function detailRoster(d) {
    var groups = [{ title: 'Starters', rows: [] }, { title: 'Bench', rows: [] }, { title: 'Injured List', rows: [] }];
    (d.roster || []).forEach(function (r) { (r.slot === 'IL' ? groups[2] : r.slot === 'BN' ? groups[1] : groups[0]).rows.push(r); });
    var html = '';
    groups.forEach(function (g) {
      if (!g.rows.length) return;
      html += '<div class="tm-rgroup">' + g.title + '</div><ul class="tm-roster-rows">' + g.rows.map(function (r) {
        var s = r.signals, tags = [];
        var fm = L.formText(s); if (fm) tags.push('<span class="nu-tag" data-tone="' + fm.tone + '" title="' + esc(fm.text) + '">' + esc(fm.label) + ' · ' + esc(fm.text) + '</span>');
        var mn = L.minutesText(s); if (mn && mn.tone !== 'flat') tags.push('<span class="nu-tag" data-tone="' + mn.tone + '">' + esc(mn.label) + ' · ' + esc(mn.text) + '</span>');
        var eta = s && s.availability ? L.etaText(s.availability.eta) : null; if (eta) tags.push('<span class="nu-tag" data-tone="warn">Back ' + esc(eta) + '</span>');
        if (s && s.market && s.market.rank) tags.push('<span class="nu-tag">Market #' + s.market.rank + '</span>');
        tags.push('<span class="nu-tag">' + r.gamesThisWeek + ' games this week</span>');
        return '<li class="tm-rrow' + (r.slot === 'IL' ? ' is-il' : '') + '"><span class="nu-slot">' + U.posPill(r.slot === 'BN' || r.slot === 'IL' ? r.slot : r.slot.replace(/\d+$/, '')) + '</span>' +
          playerCell(r.player, '', 'md') + '<span class="tm-rrow__nums"><b>' + f1(r.value.ros) + '</b><small>ROS · now ' + f1(r.value.now) + '</small></span>' +
          '<div class="tm-rrow__meta">' + tags.join('') + '</div></li>';
      }).join('') + '</ul>';
    });
    if (d.unmatched && d.unmatched.length) html += '<p class="nu-hint" style="margin-top:var(--nu-3)">' + d.unmatched.length + ' player' + (d.unmatched.length > 1 ? 's aren\'t' : ' isn\'t') + ' in the model and ' + (d.unmatched.length > 1 ? 'are' : 'is') + ' left out.</p>';
    return html;
  }

  /* ------------------------------------------------------------ render */
  function renderLoading() {
    if (!S.loading) return;
    var box = $('tm-me');
    box.hidden = false;
    box.innerHTML = '<span class="nu-skel nu-skel--title" style="display:block;width:40%"></span><div class="nu-stats" style="margin-top:var(--nu-4)">' + U.skeleton(4, { kind: 'tile' }) + '</div>';
    $('tm-power').hidden = false;
    $('tm-tbody').innerHTML = '';
    $('tm-cards').innerHTML = '<li>' + U.skeleton(6) + '</li>';
    $('tm-thead').innerHTML = '';
  }
  function render() {
    renderHeader(); renderMode();
    if (S.loading) { renderLoading(); return; }
    renderMe(); renderPower(); renderDetails(); renderManual();
  }

  /* ------------------------------------------------------------ league mode */
  function fetchTeam() {
    var seq = ++S.seq;
    var view = S.st.viewAs && S.st.viewAs[S.leagueId] || null;
    S.error = null;
    return api(L.teamUrl({ leagueId: S.leagueId, userId: S.userId, rosterId: view, horizon: S.st.horizon })).then(function (j) {
      if (seq !== S.seq) return;
      S.data = j; S.manual = false; banner(null);
      if (!j.ownRosterId && !j.analysis.myRosterId) banner('@' + esc(S.username || 'you') + ' doesn\'t own a team in this league. Pick a team above to view it as yours.', 'info');
      if (j.unmatched && j.unmatched.length) banner(j.unmatched.length + ' rostered player' + (j.unmatched.length > 1 ? 's aren\'t' : ' isn\'t') + ' in the model and ' + (j.unmatched.length > 1 ? 'are' : 'is') + ' left out of the rankings.', 'info');
    }).catch(function (e) {
      if (seq !== S.seq) return;
      if (e.status === 404 && e.code === 'team_not_found' && view) { delete S.st.viewAs[S.leagueId]; save(); return fetchTeam(); }
      var msg = e.code === 'league_not_points' ? 'This is a categories league. Power rankings work for points (High Score) leagues. Manual mode still works.'
        : e.status === 429 ? 'Sleeper is rate-limiting us. Try again in a few seconds; manual mode still works.'
        : e.status === 404 ? 'That league isn\'t on Sleeper anymore. Manual mode still works.'
        : e.status === 503 ? 'Player data is unavailable right now. Try again in a minute.'
        : 'Couldn\'t load the Sleeper league (' + (e.status || 'network') + '). Manual mode still works.';
      return enterManual(msg, e.code === 'league_not_points' ? 'warn' : 'error');
    }).then(function () { if (seq === S.seq || S.manual) { S.loading = false; render(); } });
  }

  function initSleeper() {
    var status = window.PocketSleeper && window.PocketSleeper.status ? window.PocketSleeper.status() : Promise.resolve({ connected: false });
    return status.then(function (s) {
      S.connected = !!(s && s.connected); S.leagues = (s && s.leagues) || []; S.userId = (s && s.userId) || null; S.username = (s && s.username) || null;
      if (s && s.connected && (s.httpStatus || s.code)) S.sleeperDown = true;
    }).catch(function () { S.connected = false; S.leagues = []; }).then(function () {
      var sel = $('tm-league');
      if (!S.connected || !S.leagues.length) {
        S.loading = false;
        return enterManual(S.connected ? (S.sleeperDown ? 'Sleeper isn\'t responding right now. Manual mode still works.' : 'No NBA leagues on Sleeper for @' + esc(S.username || 'you') + ' this season. Manual mode still works.') : null);
      }
      sel.innerHTML = S.leagues.map(function (l) {
        return '<option value="' + esc(l.league_id || l.league_key) + '">' + esc(l.name) + ' · ' + esc(l.num_teams) + ' teams' + (l.scoring_type === 'categories' ? ' · Categories' : '') + '</option>';
      }).join('') + '<option value="">Manual (No League)</option>';
      var p = pref(L.LEAGUE_KEY);
      var pick = p === '' ? '' : S.leagues.some(function (l) { return (l.league_id || l.league_key) === p; }) ? p : (S.leagues[0].league_id || S.leagues[0].league_key);
      sel.value = pick; sel.hidden = false;
      return selectLeague(pick || null);
    });
  }

  function selectLeague(id) {
    if (!id) { S.leagueId = null; setPref(L.LEAGUE_KEY, ''); S.loading = false; return enterManual(null); }
    S.leagueId = id; setPref(L.LEAGUE_KEY, id);
    S.manual = false; S.loading = !S.data; render();
    return fetchTeam();
  }

  /* ------------------------------------------------------------ clerk (account button) */
  function initClerk() {
    var key = window.__clerk_publishable_key;
    if (!key || key.indexOf('PLACEHOLDER') >= 0) return;
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
    s.crossOrigin = 'anonymous'; s.async = true;
    s.onload = function () {
      try { var clerk = (window.Clerk && typeof window.Clerk.load === 'function') ? window.Clerk : new window.Clerk(key); clerk.load({ telemetry: { disabled: true } }).catch(function () {}); } catch (e) { console.warn('Clerk init failed', e); }
    };
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------ bind */
  function connect() { if (window.PocketSleeper && window.PocketSleeper.openConnect) window.PocketSleeper.openConnect(); }
  function bind() {
    document.addEventListener('click', function (e) {
      var sortB = e.target.closest('[data-sort]');
      if (sortB) { var k = sortB.getAttribute('data-sort'); S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: L.DEFAULT_DIR[k] || 1 }; renderPower(); return; }
      var row = e.target.closest('[data-team]');
      if (row && !e.target.closest('a')) { openDetail(row.getAttribute('data-team')); return; }
      var add = e.target.closest('[data-add]');
      if (add) { var id = add.getAttribute('data-add'); if (S.st.roster.indexOf(id) < 0 && S.st.roster.length < L.MAX_ROSTER) S.st.roster.push(id); $('tm-roster-q').value = ''; save(); renderManual(); scheduleManual(); $('tm-roster-q').focus(); return; }
      var rm = e.target.closest('[data-remove]');
      if (rm) { var rid = rm.getAttribute('data-remove'); S.st.roster = S.st.roster.filter(function (x) { return x !== rid; }); save(); renderManual(); scheduleManual(); return; }
      var act = e.target.closest('[data-act]');
      if (act && act.getAttribute('data-act') === 'connect') connect();
    });
    document.addEventListener('keydown', function (e) {
      var row = e.target.closest && e.target.closest('tr[data-team]');
      if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(row.getAttribute('data-team')); }
    });
    U.segmented($('tm-horizon'), { onChange: function (v) {
      if (!v || v === S.st.horizon) return;
      S.st.horizon = v; save();
      if (S.manual) scheduleManual(); else if (S.leagueId) fetchTeam();
    } });
    $('tm-league').addEventListener('change', function () { selectLeague(this.value || null); });
    $('tm-viewas').addEventListener('change', function () { var v = this.value; S.st.viewAs = S.st.viewAs || {}; if (v) S.st.viewAs[S.leagueId] = v; else delete S.st.viewAs[S.leagueId]; save(); fetchTeam(); });
    $('tm-sort-m').addEventListener('change', function () { var k = this.value; S.sort = { key: k, dir: L.DEFAULT_DIR[k] || 1 }; renderPower(); });
    $('tm-how').addEventListener('click', function () { U.sheet.open('tm-how-sheet'); });
    $('tm-connect').addEventListener('click', function (e) { e.preventDefault(); connect(); });
    $('tm-manual-connect').addEventListener('click', function (e) { e.preventDefault(); connect(); });
    $('tm-roster-q').addEventListener('input', renderManual);
    $('tm-roster-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var b = $('tm-roster-opts').querySelector('[data-add]'); if (b) { e.preventDefault(); b.click(); } } });
    $('tm-roster-clear').addEventListener('click', function () {
      var prev = S.st.roster.slice(); S.st.roster = []; save(); renderManual(); scheduleManual();
      U.toast('Roster cleared', { action: { label: 'Undo', onClick: function () { S.st.roster = prev; save(); renderManual(); scheduleManual(); } } });
    });
    $('tm-roster-import').addEventListener('click', function () { var ids = L.tradeRoster(pref(L.TRADE_KEY)); if (ids.length) { S.st.roster = ids; save(); renderManual(); scheduleManual(); U.toast('Imported ' + ids.length + ' players', { tone: 'good' }); } });
    $('tm-legend').innerHTML = Object.keys(L.TIER).map(function (k) { var m = L.TIER[k]; return '<dt><span class="tm-tier" data-tone="' + m.tone + '"><span class="tm-tier__main"><span class="tm-tier__glyph" aria-hidden="true">' + m.glyph + '</span>' + esc(m.label) + '</span></span></dt><dd>' + esc(m.help) + '</dd>'; }).join('');
  }

  function boot() {
    load(); bind(); initClerk();
    render();
    initSleeper().then(function () { render(); });
  }
  window.addEventListener('pocket-nba:account', function () { S.data = null; S.loading = true; render(); initSleeper().then(function () { render(); }); });
  // sleeper-chip.js loads after this file: boot once every script has run.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
