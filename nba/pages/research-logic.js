/* Pocket NBA — player research page: pure logic (window.ResearchLogic / require()).
   No DOM, no fetch. Everything here is unit-tested by scripts/test-nba-research-ui.js.
   API contract: docs/nba-research-api.md. Page: nba/pages/research.html + research.js.

   - URL state: parseState(search) / serializeState(state) for ?q ?pos ?team ?inj ?src ?sort ?dir ?page ?player
   - API params: tableQuery(state) -> "/api/nba/research?..." (server-side sort/filter/paging)
   - Sort catalogue (SORTS) with plain-English labels + default directions
   - Formatting (dates, counts, time-ago, probabilities) that never prints NaN
   - Reading helpers that turn API numbers into beginner-friendly sentences */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ResearchLogic = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DASH = '—';
  function num(x) { return typeof x === 'number' && isFinite(x); }
  function str(x) { return x == null ? '' : String(x); }

  // ---- catalogue ----------------------------------------------------------
  var SLOTS = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'];
  var INJ = [
    { value: '', label: 'Any status' },
    { value: 'healthy', label: 'Healthy' },
    { value: 'injured', label: 'Injured (any)' },
    { value: 'dtd', label: 'Day-to-day' },
    { value: 'out', label: 'Out' },
  ];
  var SOURCES = ['logs', 'projection-only', 'rookie', 'yahoo-only'];
  // key = API sort key. dir = the direction a first click asks for. short = column label.
  var SORTS = [
    { key: 'hsValue', label: 'Best-game value', short: 'Best gm', dir: 'desc' },
    { key: 'mean', label: 'Per-game score', short: 'Avg', dir: 'desc' },
    { key: 'ceiling', label: 'Ceiling (big-game score)', short: 'Ceil', dir: 'desc' },
    { key: 'floor', label: 'Floor (bad-game score)', short: 'Floor', dir: 'desc' },
    { key: 'last5Delta', label: 'Last-5 form', short: 'Form', dir: 'desc' },
    { key: 'adpDelta', label: 'Model vs market gap', short: 'Gap', dir: 'desc' },
    { key: 'marketRank', label: 'Market rank', short: 'Mkt', dir: 'asc' },
    { key: 'yahooPreRank', label: 'Yahoo pre-rank', short: 'Y! rk', dir: 'asc' },
    { key: 'yahooPctRos', label: '% rostered on Yahoo', short: '%Ros', dir: 'desc' },
    { key: 'minDelta', label: 'Minutes trend', short: 'Min ±', dir: 'desc' },
    { key: 'hsThisWeek', label: 'This week’s best-game value', short: 'This wk', dir: 'desc' },
    { key: 'gamesThisWeek', label: 'Games this week', short: 'Gms', dir: 'desc' },
    { key: 'ddPct', label: 'Double-double rate', short: 'DD%', dir: 'desc' },
    { key: 'vorp', label: 'Value over a replacement', short: 'VORP', dir: 'desc' },
    { key: 'mpg', label: 'Minutes per game', short: 'MPG', dir: 'desc' },
    { key: 'age', label: 'Age (youngest first)', short: 'Age', dir: 'asc' },
    { key: 'name', label: 'Name (A–Z)', short: 'Name', dir: 'asc' },
  ];
  var SORT_KEYS = SORTS.map(function (s) { return s.key; });
  var DEFAULT = { q: '', pos: [], team: '', inj: '', src: '', sort: 'hsValue', dir: 'desc', page: 1, player: '' };
  var PAGE_SIZE = 50;
  var Q_MAX = 64;

  function sortDef(key) { for (var i = 0; i < SORTS.length; i++) if (SORTS[i].key === key) return SORTS[i]; return null; }
  function defaultDir(key) { var d = sortDef(key); return d ? d.dir : 'desc'; }

  // ---- URL state ------------------------------------------------------------
  function getParam(search, k) {
    if (typeof URLSearchParams !== 'undefined') return new URLSearchParams(search).get(k);
    return null;
  }
  // parseState('?q=jokic&pos=C,PF&sort=ceiling') -> sanitised state (unknown values dropped)
  function parseState(search) {
    var s = str(search);
    var st = {
      q: str(getParam(s, 'q')).slice(0, Q_MAX).trim(),
      pos: [], team: '', inj: '', src: '', sort: DEFAULT.sort, dir: '', page: 1, player: '',
    };
    var pos = str(getParam(s, 'pos')).toUpperCase().split(',');
    pos.forEach(function (p) { p = p.trim(); if (SLOTS.indexOf(p) >= 0 && st.pos.indexOf(p) < 0) st.pos.push(p); });
    st.pos.sort(function (a, b) { return SLOTS.indexOf(a) - SLOTS.indexOf(b); });
    var team = str(getParam(s, 'team')).toUpperCase();
    if (/^[A-Z]{2,4}$/.test(team)) st.team = team;
    var inj = str(getParam(s, 'inj')).toLowerCase();
    if (INJ.some(function (o) { return o.value && o.value === inj; })) st.inj = inj;
    var src = str(getParam(s, 'src')).toLowerCase();
    if (SOURCES.indexOf(src) >= 0) st.src = src;
    var sort = str(getParam(s, 'sort'));
    if (SORT_KEYS.indexOf(sort) >= 0) st.sort = sort;
    var dir = str(getParam(s, 'dir')).toLowerCase();
    st.dir = dir === 'asc' || dir === 'desc' ? dir : defaultDir(st.sort);
    var page = parseInt(str(getParam(s, 'page')), 10);
    if (num(page) && page >= 1 && page <= 100) st.page = page;
    var pl = str(getParam(s, 'player'));
    if (/^y?\d{1,12}$/.test(pl)) st.player = pl;
    return st;
  }
  // serializeState(state) -> "?q=..&pos=C" (defaults omitted; "" when all default)
  function serializeState(st) {
    st = st || {};
    var parts = [];
    function add(k, v) { parts.push(k + '=' + encodeURIComponent(v).replace(/%2C/g, ',')); }
    if (st.q) add('q', str(st.q).slice(0, Q_MAX));
    if (st.pos && st.pos.length) add('pos', st.pos.join(','));
    if (st.team) add('team', st.team);
    if (st.inj) add('inj', st.inj);
    if (st.src) add('src', st.src);
    if (st.sort && st.sort !== DEFAULT.sort) add('sort', st.sort);
    if (st.dir && st.dir !== defaultDir(st.sort || DEFAULT.sort)) add('dir', st.dir);
    if (num(st.page) && st.page > 1) add('page', st.page);
    if (st.player) add('player', st.player);
    return parts.length ? '?' + parts.join('&') : '';
  }
  // the /api/nba/research URL for the table (pos chips filter by Yahoo slot eligibility)
  function tableQuery(st, pageSize) {
    var n = pageSize || PAGE_SIZE, page = num(st.page) && st.page > 0 ? st.page : 1;
    var parts = ['sort=' + encodeURIComponent(st.sort || DEFAULT.sort), 'dir=' + (st.dir || defaultDir(st.sort)), 'limit=' + n, 'offset=' + (page - 1) * n];
    if (st.q) parts.push('q=' + encodeURIComponent(str(st.q).slice(0, Q_MAX)));
    var slots = (st.pos || []).filter(function (p) { return p !== 'UTIL'; });
    if (slots.length) parts.push('slot=' + slots.join(','));
    if (st.team) parts.push('team=' + encodeURIComponent(st.team));
    if (st.inj) parts.push('inj=' + st.inj);
    if (st.src) parts.push('source=' + st.src);
    return '/api/nba/research?' + parts.join('&');
  }
  // header click: same key flips direction, a new key starts at its natural direction
  function nextSort(st, key) {
    if (SORT_KEYS.indexOf(key) < 0) return { sort: st.sort, dir: st.dir };
    if (st.sort === key) return { sort: key, dir: st.dir === 'asc' ? 'desc' : 'asc' };
    return { sort: key, dir: defaultDir(key) };
  }
  function togglePos(list, p) {
    list = (list || []).slice();
    if (!p || p === 'ALL') return [];
    var i = list.indexOf(p);
    if (i >= 0) list.splice(i, 1); else list.push(p);
    return list.sort(function (a, b) { return SLOTS.indexOf(a) - SLOTS.indexOf(b); });
  }
  // number of active non-search filters (badge on the mobile Filters button)
  function activeFilterCount(st) {
    return (st.pos && st.pos.length ? 1 : 0) + (st.team ? 1 : 0) + (st.inj ? 1 : 0) + (st.src ? 1 : 0);
  }
  function pageInfo(total, page, size) {
    size = size || PAGE_SIZE;
    var t = num(total) && total > 0 ? Math.floor(total) : 0;
    var pages = Math.max(1, Math.ceil(t / size));
    var p = Math.min(Math.max(1, num(page) ? Math.floor(page) : 1), pages);
    var from = t ? (p - 1) * size + 1 : 0, to = Math.min(t, p * size);
    return { page: p, pages: pages, from: from, to: to, total: t, hasPrev: p > 1, hasNext: p < pages };
  }

  // ---- formatting -------------------------------------------------------------
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function ymd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(s));
    if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  // '2026-10-20' -> 'Oct 20'
  function shortDate(s) { var d = ymd(s); return d ? MON[d.getUTCMonth()] + ' ' + d.getUTCDate() : DASH; }
  // '2026-10-20' -> 'Tue'
  function weekday(s) { var d = ymd(s); return d ? DOW[d.getUTCDay()] : ''; }
  // ('2026-10-20','2026-10-25') -> 'Oct 20–25'; across months 'Nov 30–Dec 13'
  function dateRange(a, b) {
    var x = ymd(a), y = ymd(b);
    if (!x || !y) return DASH;
    if (x.getUTCMonth() === y.getUTCMonth()) return MON[x.getUTCMonth()] + ' ' + x.getUTCDate() + '–' + y.getUTCDate();
    return shortDate(a) + '–' + shortDate(b);
  }
  // 6912 -> '6.9k', 776 -> '776'
  function count(n) {
    if (!num(n)) return DASH;
    if (Math.abs(n) >= 10000) return Math.round(n / 1000) + 'k';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }
  // ISO -> '3h ago' relative to now (ms); future/invalid -> 'just now' / ''
  function timeAgo(iso, now) {
    var t = Date.parse(str(iso));
    if (!num(t)) return '';
    var s = Math.max(0, ((num(now) ? now : Date.now()) - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    var d = new Date(t);
    return MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }
  function score(x, dp) { return num(x) ? x.toFixed(dp == null ? 1 : dp) : DASH; }
  // 0.453 -> '45%'; 0.004 -> '<1%'; 0.997 -> '>99%'; exact 0/1 stay '0%'/'100%'
  function prob(p) {
    if (!num(p)) return DASH;
    if (p <= 0) return '0%';
    if (p >= 1) return '100%';
    if (p < 0.01) return '<1%';
    if (p > 0.99) return '>99%';
    return Math.round(p * 100) + '%';
  }
  function pct(p) { return num(p) ? Math.round(p * 100) + '%' : DASH; }
  function signed(x, dp) {
    if (!num(x)) return DASH;
    var s = Math.abs(x).toFixed(dp == null ? 1 : dp);
    if (Number(s) === 0) return s;
    return (x > 0 ? '+' : '−') + s;
  }
  // last-5 form -> { dir: up|down|flat|none, text, label }
  function form(delta) {
    if (!num(delta)) return { dir: 'none', text: DASH, label: 'No recent games' };
    if (delta >= 3) return { dir: 'up', text: '▲ ' + delta.toFixed(1), label: 'Hot: up ' + delta.toFixed(1) + ' on his season average' };
    if (delta <= -3) return { dir: 'down', text: '▼ ' + Math.abs(delta).toFixed(1), label: 'Cold: down ' + Math.abs(delta).toFixed(1) + ' on his season average' };
    return { dir: 'flat', text: '– ' + Math.abs(delta).toFixed(1), label: 'Steady: within 3 of his season average' };
  }
  function heightFt(s) { var m = /^(\d)-(\d{1,2})$/.exec(str(s)); return m ? m[1] + '′' + m[2] + '″' : null; }

  // ---- probability chips (P(best game of the week >= T)) ---------------------
  // -> [{ t: 40, p: 0.925, text: '93%', tone: 'good'|'mid'|'low'|'none', label }]
  function probChips(pBest) {
    var out = [];
    if (!pBest || typeof pBest !== 'object') return out;
    Object.keys(pBest).map(Number).filter(num).sort(function (a, b) { return a - b; }).forEach(function (t) {
      var p = pBest[String(t)];
      if (!num(p)) p = null;
      var tone = p == null ? 'none' : p >= 0.6 ? 'good' : p >= 0.3 ? 'mid' : 'low';
      out.push({ t: t, p: p, text: prob(p), tone: tone, label: 'Chance his best game reaches ' + t + '+: ' + prob(p) });
    });
    return out;
  }

  // ---- reading helpers ---------------------------------------------------------
  // market vs model in plain English
  function marketReading(rank, market) {
    market = market || {};
    var mr = market.marketRank, d = market.adpDelta;
    if (!num(mr) || !num(rank)) {
      if (num(market.yahooPreRank)) return { tone: 'none', text: 'No draft-market rank yet. Yahoo ranks him #' + market.yahooPreRank + ' before the season.' };
      return { tone: 'none', text: 'No draft-market data for this player.' };
    }
    if (!num(d)) d = mr - rank;
    var gap = Math.abs(Math.round(d));
    if (gap <= 3 || (market.label === 'fair' && gap < 10)) return { tone: 'fair', text: 'The model and the market agree: he goes about where we rank him (#' + rank + ' vs #' + mr + ').' };
    if (d > 0) return { tone: 'value', text: 'The model likes him more than the market. Drafters take him around #' + mr + '; we rank him #' + rank + ', ' + gap + ' spots higher.' };
    return { tone: 'reach', text: 'The market likes him more than the model. Drafters take him around #' + mr + '; we rank him #' + rank + ', ' + gap + ' spots lower.' };
  }
  function roleText(trend, minDelta) {
    if (trend === 'up') return 'more minutes lately (' + signed(minDelta) + ' a game)';
    if (trend === 'down') return 'fewer minutes lately (' + signed(minDelta) + ' a game)';
    if (trend === 'flat') return 'a steady role';
    return null;
  }
  // generated scouting report: 2-4 short sentences from the detail payload
  function scouting(d) {
    if (!d) return [];
    var v = d.value || {}, out = [], name = (d.identity && d.identity.lastName) || (d.identity && d.identity.name) || 'He';
    var c = d.consistency, r = d.rates, f = d.form;
    if (num(v.rank) && num(v.hsValue)) {
      var band = v.rank <= 12 ? 'a first-round centrepiece' : v.rank <= 36 ? 'a core starter' : v.rank <= 100 ? 'a solid weekly starter' : v.rank <= 200 ? 'a bench or streaming piece' : 'a deep-league flier';
      out.push(name + ' ranks #' + v.rank + ' on our board: ' + band + '. His best game in a typical matchup week should land around ' + v.hsValue.toFixed(1) + ' points.');
    } else if (num(v.hsValue)) {
      out.push('His best game in a typical matchup week should land around ' + v.hsValue.toFixed(1) + ' points.');
    }
    if (c && num(c.cv)) {
      var steady = c.cv < 0.3 ? 'Very steady night to night' : c.cv < 0.45 ? 'Fairly steady' : 'Streaky';
      var boom = num(c.boomRate) ? ', with a big night (30%+ over his average) in ' + pct(c.boomRate) + ' of games' : '';
      out.push(steady + boom + '.');
    }
    if (r && num(r.ddPct) && r.ddPct >= 0.25) {
      out.push('Double-doubles in ' + pct(r.ddPct) + ' of games' + (num(r.tdPct) && r.tdPct >= 0.1 ? ' and triple-doubles in ' + pct(r.tdPct) : '') + ', and each one adds bonus points in this league.');
    }
    if (f && num(f.last5Delta)) {
      var fm = form(f.last5Delta), role = roleText(f.roleTrend, f.minDelta);
      if (fm.dir === 'up') out.push('Finished last season hot (last 5 games ' + signed(f.last5Delta) + ' over his average)' + (role ? ' with ' + role : '') + '.');
      else if (fm.dir === 'down') out.push('Finished last season cold (last 5 games ' + signed(f.last5Delta) + ' under his average)' + (role ? ' with ' + role : '') + '.');
    }
    if (d.source === 'rookie') out.push('Rookie: no NBA games yet, so these numbers come from his projection and are less certain.');
    if (d.source === 'yahoo-only') out.push('Not in our stats feed, so there are no game logs. His value is estimated from Yahoo’s projection.');
    if (d.injury && d.injury.status) out.push('Currently listed ' + d.injury.status + (d.injury.bodyPart ? ' (' + d.injury.bodyPart + (d.injury.notes ? ', ' + d.injury.notes.toLowerCase() : '') + ')' : '') + '.');
    return out;
  }

  // ---- schedule + High Score helpers ------------------------------------------
  // per-week schedule card model
  function scheduleCard(w) {
    w = w || {};
    var games = Array.isArray(w.games) ? w.games : null;
    var n = num(w.gameCount) ? w.gameCount : games ? games.length : (num(w.modelGames) ? w.modelGames : null);
    return {
      week: w.week, range: dateRange(w.start, w.end), days: num(w.days) ? w.days : null,
      long: num(w.days) && w.days > 7, playoffs: !!w.playoffs,
      games: games, count: n, b2b: num(w.b2bCount) ? w.b2bCount : 0,
      hsValue: num(w.hsValue) ? w.hsValue : null,
    };
  }
  // weekly best bars -> geometry in a w×h box; nulls (no games that week) leave gaps
  function weeklyBars(weeks, w, h) {
    var list = (weeks || []).filter(function (x) { return x && num(x.week); });
    var vals = list.map(function (x) { return num(x.best) ? x.best : null; });
    var fin = vals.filter(num);
    var max = fin.length ? Math.max.apply(null, fin) : 0;
    var top = max > 0 ? Math.ceil(max / 10) * 10 : 10;
    var n = Math.max(1, list.length), bw = w / n, gap = Math.min(4, bw * 0.28);
    var bars = list.map(function (x, i) {
      var v = vals[i], bh = num(v) && v > 0 ? (v / top) * h : 0;
      return { week: x.week, value: v, x: +(i * bw + gap / 2).toFixed(2), w: +Math.max(1, bw - gap).toFixed(2), y: +(h - bh).toFixed(2), h: +bh.toFixed(2), date: x.bestDate || null };
    });
    return { bars: bars, top: top, max: fin.length ? max : null };
  }
  function scoresOf(games) { return (games || []).map(function (g) { return g && g.score; }).filter(num); }
  function mean(a) { a = (a || []).filter(num); return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }

  // accent-insensitive normaliser (client-side highlight of search matches)
  function norm(s) {
    s = str(s);
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  }
  // section unavailable? -> reason string or null
  function unavailable(d, key) { return d && d.unavailable && d.unavailable[key] ? String(d.unavailable[key]) : null; }

  var SOURCE_LABEL = { logs: null, 'projection-only': 'Projection only', rookie: 'Rookie', 'yahoo-only': 'Yahoo only' };

  return {
    SLOTS: SLOTS, INJ: INJ, SOURCES: SOURCES, SORTS: SORTS, SORT_KEYS: SORT_KEYS, DEFAULT: DEFAULT, PAGE_SIZE: PAGE_SIZE, SOURCE_LABEL: SOURCE_LABEL,
    sortDef: sortDef, defaultDir: defaultDir,
    parseState: parseState, serializeState: serializeState, tableQuery: tableQuery, nextSort: nextSort, togglePos: togglePos,
    activeFilterCount: activeFilterCount, pageInfo: pageInfo,
    shortDate: shortDate, weekday: weekday, dateRange: dateRange, count: count, timeAgo: timeAgo, score: score, prob: prob, pct: pct, signed: signed, form: form, heightFt: heightFt,
    probChips: probChips, marketReading: marketReading, scouting: scouting, scheduleCard: scheduleCard, weeklyBars: weeklyBars, scoresOf: scoresOf, mean: mean,
    norm: norm, unavailable: unavailable,
  };
});
