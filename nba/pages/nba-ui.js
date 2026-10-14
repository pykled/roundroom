/* Pocket NBA — design-system helpers (window.NbaUI / require('nba/pages/nba-ui.js')).
   Contract: docs/nba-design-system.md. Styles: nba/pages/nba-ui.css.

   Plain UMD script, no dependencies. Every *HTML-returning* helper is pure
   (string in, string out) so it runs in node tests and in the browser alike;
   every value interpolated into markup goes through NbaUI.esc().

   Browser-only behaviour (installed when this file loads in a page):
     - headshot fallback chain: a capture-phase 'error' listener walks an
       <img data-srcs="a|b|c"> to the next source, then removes the <img> so the
       initials underneath show. A 'load' listener fades the image in.
     - NbaUI.mountNav / sheet / tabs / segmented / toast.

   Load order on a page:
     <link rel="stylesheet" href="/shared/styles.css">
     <link rel="stylesheet" href="/nba/pages/nba-ui.css">
     <script src="/nba/pages/nba-ui.js"></script>          (NOT defer: mountNav must run before nav.js)
     <script defer src="/shared/nav.js"></script>
   then, first thing in <body class="sport-nba nba-ui">:
     <div data-nu-nav></div><script>NbaUI.mountNav({ active: 'lineup' })</script> */
(function (root, factory) {
  var api = factory(typeof window !== 'undefined' ? window : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NbaUI = api;
})(typeof window !== 'undefined' ? window : null, function (win) {
  'use strict';
  var doc = win && win.document;

  // ---- utils -------------------------------------------------------------
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function num(x) { return typeof x === 'number' && isFinite(x); }
  function cls() { return Array.prototype.filter.call(arguments, Boolean).join(' '); }
  function attrs(o) {
    var out = '';
    for (var k in o) if (o[k] != null && o[k] !== false) out += ' ' + k + (o[k] === true ? '' : '="' + esc(o[k]) + '"');
    return out;
  }

  // ---- format ------------------------------------------------------------
  var DASH = '—';
  var fmt = {
    // 62.94 -> "62.9"; null/NaN -> "—"
    score: function (x, dp) { return num(x) ? x.toFixed(dp == null ? 1 : dp) : DASH; },
    // 3 -> "#3"
    rank: function (n) { return num(n) && n > 0 ? '#' + Math.round(n) : DASH; },
    ordinal: function (n) {
      if (!num(n)) return DASH;
      n = Math.round(n); var v = n % 100, s = ['th', 'st', 'nd', 'rd'];
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    },
    // 0.634 -> "63%"
    pct: function (x, dp) { return num(x) ? (x * 100).toFixed(dp || 0) + '%' : DASH; },
    signed: function (x, dp) { if (!num(x)) return DASH; var s = x.toFixed(dp == null ? 1 : dp); return x > 0 ? '+' + s : (Number(s) === 0 ? s.replace('-', '') : s); },
    // delta(2.34) -> { text: "▲ 2.3", dir: "up", cls: "is-up" }; |x| < eps -> flat
    delta: function (x, dp, eps) {
      if (!num(x)) return { text: DASH, dir: 'none', cls: '' };
      var d = dp == null ? 1 : dp, e = eps == null ? Math.pow(10, -d) / 2 : eps;
      if (Math.abs(x) < e) return { text: '– ' + (0).toFixed(d), dir: 'flat', cls: '' };
      return x > 0 ? { text: '▲ ' + x.toFixed(d), dir: 'up', cls: 'is-up' } : { text: '▼ ' + Math.abs(x).toFixed(d), dir: 'down', cls: 'is-down' };
    },
    initials: function (name) {
      var parts = String(name || '').replace(/\b(Jr|Sr|II|III|IV)\.?$/i, '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return '?';
      var a = parts[0].charAt(0), b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
      return (a + b).toUpperCase();
    },
  };

  function deltaHtml(x, dp) {
    var d = fmt.delta(x, dp);
    var label = d.dir === 'up' ? 'up ' : d.dir === 'down' ? 'down ' : '';
    return '<span class="' + cls('nu-delta', d.cls) + '"' + (label ? ' aria-label="' + label + esc(d.text.slice(2)) + '"' : '') + '>' + esc(d.text) + '</span>';
  }

  // ---- teams -------------------------------------------------------------
  // Primary colours (initials background + accents). ESPN uses its own slugs for
  // two teams (measured: /nop.png and /uta.png are 404).
  var TEAM_COLORS = {
    ATL: '#e03a3e', BOS: '#007a33', BKN: '#3a3a3a', CHA: '#00788c', CHI: '#ce1141', CLE: '#860038', DAL: '#00538c',
    DEN: '#0e2240', DET: '#c8102e', GSW: '#1d428a', HOU: '#ce1141', IND: '#002d62', LAC: '#1d428a', LAL: '#552583',
    MEM: '#5d76a9', MIA: '#98002e', MIL: '#00471b', MIN: '#0c2340', NOP: '#0c2340', NYK: '#006bb6', OKC: '#007ac1',
    ORL: '#0077c0', PHI: '#006bb6', PHX: '#1d1160', POR: '#e03a3e', SAC: '#5a2d81', SAS: '#8a8d8f', TOR: '#ce1141',
    UTA: '#002b5c', WAS: '#002b5c',
  };
  var ESPN_TEAM_SLUG = { NOP: 'no', UTA: 'utah' };
  function teamLogoSrcs(abbr) {
    var a = String(abbr || '').toUpperCase();
    if (!TEAM_COLORS[a]) return [];
    return [
      'https://sleepercdn.com/images/team_logos/nba/' + a.toLowerCase() + '.png',
      'https://a.espncdn.com/i/teamlogos/nba/500/' + (ESPN_TEAM_SLUG[a] || a.toLowerCase()) + '.png',
    ];
  }
  function teamLogo(abbr, opts) {
    opts = opts || {};
    var a = String(abbr || '').toUpperCase(), srcs = teamLogoSrcs(a);
    var size = opts.size || 'sm';
    var img = srcs.length ? '<img src="' + esc(srcs[0]) + '" data-srcs="' + esc(srcs.join('|')) + '" alt="" loading="lazy" decoding="async" width="40" height="40">' : '';
    return '<span class="nu-team-logo nu-team-logo--' + esc(size) + '" role="img" aria-label="' + esc(a || 'Free agent') + '">' +
      '<span aria-hidden="true">' + esc(a ? a.slice(0, 3) : 'FA') + '</span>' + img + '</span>';
  }

  // ---- headshots ---------------------------------------------------------
  // Chain (measured, docs/nba-design-system.md "Player images"):
  //   1. Sleeper  sleepercdn.com/content/nba/players/thumb/{sleeperId}.jpg   (all Sleeper-id players)
  //   2. ESPN     a.espncdn.com/i/headshots/nba/players/full/{espnId}.png    (needs espnId from the API + CSP)
  //   3. Yahoo    player.headshot (absolute https URL from the Yahoo API)       (needs API + CSP)
  //   4. initials (always rendered underneath)
  // `size` >= 96px asks Sleeper for the full-size image instead of the thumb.
  var SIZE_PX = { xs: 24, sm: 32, md: 40, lg: 56, xl: 96, hero: 128 };
  function sleeperId(p) {
    var id = p && (p.sleeperId != null ? p.sleeperId : p.id);
    return id != null && /^\d+$/.test(String(id)) ? String(id) : null;
  }
  function headshotSrcs(p, opts) {
    if (!p) return [];
    var px = SIZE_PX[(opts && opts.size) || 'md'] || 40, big = px >= 96;
    var out = [], sid = sleeperId(p);
    if (sid) out.push('https://sleepercdn.com/content/nba/players/' + (big ? '' : 'thumb/') + sid + '.jpg');
    // ESPN's resizer on the same host: 2x the avatar size (600x436 source, ~190 KB -> ~10-30 KB)
    if (p.espnId != null && /^\d+$/.test(String(p.espnId))) {
      var w = Math.min(600, px * 2 * 1.4 | 0), h = Math.round(w * 436 / 600);
      out.push('https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/' + p.espnId + '.png&w=' + w + '&h=' + h);
    }
    if (p.headshot && /^https:\/\//.test(String(p.headshot))) out.push(String(p.headshot));
    return out;
  }
  function srcKind(url) { return /espncdn/.test(url) ? 'espn' : /sleepercdn/.test(url) ? 'sleeper' : 'yahoo'; }
  function avatar(p, opts) {
    opts = opts || {};
    p = p || {};
    var size = SIZE_PX[opts.size] ? opts.size : 'md';
    var srcs = opts.noImage ? [] : headshotSrcs(p, { size: size });
    var team = String(p.team || '').toUpperCase();
    var style = TEAM_COLORS[team] ? ' style="--team:' + TEAM_COLORS[team] + '"' : '';
    var px = SIZE_PX[size];
    var img = srcs.length
      ? '<img src="' + esc(srcs[0]) + '" data-srcs="' + esc(srcs.join('|')) + '" data-src-kind="' + srcKind(srcs[0]) + '" alt="" loading="' + (opts.eager ? 'eager' : 'lazy') + '" decoding="async" width="' + px + '" height="' + px + '">'
      : '';
    var a = '<span class="' + cls('nu-avatar', 'nu-avatar--' + size, opts.square && 'nu-avatar--square') + '"' + style +
      ' role="img" aria-label="' + esc(p.name || 'Player') + '"><span aria-hidden="true">' + esc(fmt.initials(p.name)) + '</span>' + img + '</span>';
    if (!opts.teamBadge && !opts.injuryDot) return a;
    var inj = injuryKey(p.injury);
    return '<span class="nu-avatar-wrap">' + a +
      (opts.teamBadge && team ? teamLogo(team, { size: size === 'xl' || size === 'hero' ? 'md' : 'sm' }) : '') +
      (opts.injuryDot && inj ? '<span class="nu-inj-dot" data-status="' + inj + '" aria-hidden="true"></span>' : '') + '</span>';
  }

  // ---- pills -------------------------------------------------------------
  var POS_ORDER = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'];
  function posPill(pos) {
    var list = (Array.isArray(pos) ? pos : [pos]).filter(Boolean).map(function (x) { return String(x).toUpperCase(); });
    if (!list.length) return '';
    var pills = list.map(function (x) { return '<span class="nu-pos" data-pos="' + esc(x) + '">' + esc(x === 'UTIL' ? 'UTL' : x) + '</span>'; });
    return pills.length === 1 ? pills[0] : '<span class="nu-pos-group">' + pills.join('') + '</span>';
  }
  function tierBadge(tier) {
    if (!num(tier)) return '';
    return '<span class="nu-tier" data-tier="' + Math.round(tier) + '" title="Tier ' + Math.round(tier) + '">T' + Math.round(tier) + '</span>';
  }
  // Model injury strings seen in /api/nba/players: null, "DTD", "GTD", "Out", "OUT", "Q", "IR"; outForSeason flag.
  function injuryKey(s) {
    if (!s) return null;
    var k = String(s).toLowerCase().replace(/[^a-z]/g, '');
    if (k === 'out' || k === 'o') return 'out';
    if (k === 'ir' || k === 'il' || k === 'ofs' || k === 'outforseason' || k === 'sus' || k === 'suspended') return 'out';
    if (k === 'q' || k === 'questionable') return 'q';
    if (k === 'gtd') return 'gtd';
    if (k === 'dtd' || k === 'daytoday') return 'dtd';
    if (k === 'd' || k === 'doubtful') return 'out';
    if (k === 'p' || k === 'probable') return 'prob';
    return 'q';
  }
  var INJ_LABEL = { out: 'Out', q: 'Q', gtd: 'GTD', dtd: 'DTD', prob: 'Prob' };
  function injuryBadge(s, opts) {
    var k = (opts && opts.outForSeason) ? 'out' : injuryKey(s);
    if (!k) return '';
    var label = (opts && opts.outForSeason) ? 'OFS' : (/^ir$/i.test(String(s)) ? 'IR' : INJ_LABEL[k]);
    return '<span class="nu-inj" data-status="' + k + '" title="Injury: ' + esc(s || label) + '">' + esc(label) + '</span>';
  }
  // market label from the model: 'value' | 'fair' | 'reach'
  function valueBadge(label, strong) {
    if (!label) return '';
    var txt = { value: 'Value', fair: 'Fair', reach: 'Reach' }[label] || label;
    return '<span class="nu-value" data-label="' + esc(label) + '"' + (strong ? ' data-strong="true"' : '') + '>' + esc(txt) + '</span>';
  }

  // ---- stat tile, range band ----------------------------------------------
  // statTile({ label, value, sub?, delta?, tone?: 'accent'|'hero', id? })
  function statTile(o) {
    o = o || {};
    var v = num(o.value) ? fmt.score(o.value, o.dp) : (o.value == null || o.value === '' || typeof o.value === 'number' ? DASH : String(o.value));
    return '<div class="' + cls('nu-stat', o.tone && 'nu-stat--' + o.tone) + '"' + (o.id ? ' id="' + esc(o.id) + '"' : '') + '>' +
      '<span class="nu-stat__label">' + esc(o.label) + '</span>' +
      '<span class="nu-stat__value">' + esc(v) + '</span>' +
      ((o.sub != null || o.delta != null) ? '<span class="nu-stat__sub">' + (o.delta != null ? deltaHtml(o.delta) : '') + (o.sub != null ? '<span>' + esc(o.sub) + '</span>' : '') + '</span>' : '') +
      '</div>';
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  // rangeBand({ min, max, lo, hi, mark, labels?:[left,right] }) -> floor–ceiling band
  function rangeBand(o) {
    var lo = o.min, span = o.max - o.min;
    if (!num(lo) || !num(span) || span <= 0) return '';
    function at(x) { return (clamp01((x - lo) / span) * 100).toFixed(2) + '%'; }
    var band = num(o.lo) && num(o.hi) ? '<span class="nu-range__band" style="left:' + at(o.lo) + ';width:calc(' + at(o.hi) + ' - ' + at(o.lo) + ')"></span>' : '';
    var mark = num(o.mark) ? '<span class="nu-range__mark" style="left:' + at(o.mark) + '"></span>' : '';
    var labels = o.labels ? '<div class="nu-range__labels"><span>' + esc(o.labels[0]) + '</span><span>' + esc(o.labels[1]) + '</span></div>' : '';
    return '<div class="nu-range" role="img" aria-label="' + esc(o.ariaLabel || ('Range ' + fmt.score(o.lo) + ' to ' + fmt.score(o.hi))) + '"><span class="nu-range__track"></span>' + band + mark + '</div>' + labels;
  }
  function meter(frac, tone) {
    var f = num(frac) ? clamp01(frac) : 0;
    return '<div class="' + cls('nu-meter', tone && 'nu-meter--' + tone) + '" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(f * 100) + '"><span style="width:' + (f * 100).toFixed(1) + '%"></span></div>';
  }

  // ---- charts (pure math + SVG) -------------------------------------------
  function finite(values) { return (values || []).filter(num); }
  // sparkPoints(values, w, h, pad) -> [[x,y],...] in SVG space (y down). Flat
  // series sit mid-height; one value sits centred. Non-finite values dropped.
  function sparkPoints(values, w, h, pad) {
    var v = finite(values); pad = pad == null ? 2 : pad;
    if (!v.length) return [];
    var min = Math.min.apply(null, v), max = Math.max.apply(null, v), span = max - min;
    var iw = w - pad * 2, ih = h - pad * 2;
    return v.map(function (y, i) {
      var x = v.length === 1 ? w / 2 : pad + (iw * i) / (v.length - 1);
      var yy = span === 0 ? h / 2 : pad + ih - ((y - min) / span) * ih;
      return [Math.round(x * 100) / 100, Math.round(yy * 100) / 100];
    });
  }
  // sparkline(values, { w, h, tone: 'good'|'bad'|'muted', area, dot, label })
  function sparkline(values, opts) {
    opts = opts || {};
    var w = opts.w || 96, h = opts.h || 28, pts = sparkPoints(values, w, h, 3);
    var label = opts.label || 'Trend';
    if (!pts.length) return '<svg class="nu-spark nu-spark--muted" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + ': no data"></svg>';
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join('');
    var last = pts[pts.length - 1];
    var area = opts.area !== false && pts.length > 1 ? '<path class="nu-spark__area" d="' + d + 'L' + last[0] + ' ' + h + 'L' + pts[0][0] + ' ' + h + 'Z"/>' : '';
    return '<svg class="' + cls('nu-spark', opts.tone && 'nu-spark--' + opts.tone) + '" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '">' +
      area + '<path class="nu-spark__line" d="' + d + '"/>' + (opts.dot !== false ? '<circle class="nu-spark__dot" cx="' + last[0] + '" cy="' + last[1] + '" r="2.5"/>' : '') + '</svg>';
  }
  // binCounts(values, bins, [min, max]) -> { counts, edges, min, max }; every
  // finite value lands in exactly one bin (max goes in the last bin).
  function binCounts(values, bins, range) {
    var v = finite(values); bins = Math.max(1, Math.floor(bins || 10));
    var min = range && num(range[0]) ? range[0] : (v.length ? Math.min.apply(null, v) : 0);
    var max = range && num(range[1]) ? range[1] : (v.length ? Math.max.apply(null, v) : 1);
    if (max === min) { max = min + 1; }
    var counts = new Array(bins).fill(0), width = (max - min) / bins, edges = [];
    for (var i = 0; i <= bins; i++) edges.push(min + width * i);
    v.forEach(function (x) {
      if (x < min || x > max) return;
      var b = Math.floor((x - min) / width); if (b >= bins) b = bins - 1;
      counts[b]++;
    });
    return { counts: counts, edges: edges, min: min, max: max };
  }
  // histogram(values, { bins, w, h, range, mark, highlightFrom, labels, label })
  function histogram(values, opts) {
    opts = opts || {};
    var w = opts.w || 280, h = opts.h || 72, bins = opts.bins || 16, labelH = opts.labels === false ? 0 : 14;
    var r = binCounts(values, bins, opts.range), top = Math.max.apply(null, r.counts) || 1;
    var bw = w / bins, ch = h - labelH, gap = Math.min(2, bw * 0.2);
    var bars = r.counts.map(function (c, i) {
      var bh = (c / top) * (ch - 2), x = i * bw + gap / 2, y = ch - bh;
      var hi = num(opts.highlightFrom) && r.edges[i] >= opts.highlightFrom;
      return '<rect class="' + cls('nu-hist__bar', hi && 'is-hi') + '" x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + Math.max(0.5, bw - gap).toFixed(2) + '" height="' + bh.toFixed(2) + '" rx="1.5"><title>' +
        esc(fmt.score(r.edges[i]) + '–' + fmt.score(r.edges[i + 1]) + ': ' + c) + '</title></rect>';
    }).join('');
    var mark = '';
    if (num(opts.mark)) { var mx = (clamp01((opts.mark - r.min) / (r.max - r.min)) * w).toFixed(2); mark = '<line class="nu-hist__mark" x1="' + mx + '" x2="' + mx + '" y1="0" y2="' + ch + '"/>'; }
    var labels = labelH ? '<text x="0" y="' + (h - 2) + '">' + esc(fmt.score(r.min, 0)) + '</text><text x="' + w + '" y="' + (h - 2) + '" text-anchor="end">' + esc(fmt.score(r.max, 0)) + '</text>' : '';
    return '<svg class="nu-hist" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" preserveAspectRatio="none" role="img" aria-label="' + esc(opts.label || 'Distribution') + '">' +
      bars + '<line class="nu-hist__base" x1="0" x2="' + w + '" y1="' + ch + '" y2="' + ch + '"/>' + mark + labels + '</svg>';
  }

  // ---- composites ----------------------------------------------------------
  // playerCell(p, { size, meta: html, teamBadge, injuryDot, href, lg })
  function playerCell(p, opts) {
    opts = opts || {}; p = p || {};
    var metaParts = [];
    if (opts.meta != null) metaParts.push(opts.meta);
    else {
      if (p.pos) metaParts.push(posPill(Array.isArray(p.pos) ? p.pos.slice(0, 2) : p.pos));
      if (p.team) metaParts.push('<span>' + esc(p.team) + '</span>');
      if (p.injury || p.outForSeason) metaParts.push(injuryBadge(p.injury, { outForSeason: p.outForSeason }));
    }
    var name = opts.href ? '<a class="nu-player__name" href="' + esc(opts.href) + '">' + esc(p.name) + '</a>' : '<span class="nu-player__name">' + esc(p.name) + '</span>';
    return '<div class="' + cls('nu-player', opts.lg && 'nu-player--lg') + '">' +
      avatar(p, { size: opts.size || (opts.lg ? 'xl' : 'md'), teamBadge: opts.teamBadge, injuryDot: opts.injuryDot }) +
      '<div class="nu-player__text">' + name + '<div class="nu-player__meta">' + metaParts.join('') + '</div></div></div>';
  }
  // pageHeader({ eyebrow, title, sub, actions: html, court: true, id })
  function pageHeader(o) {
    o = o || {};
    return '<header class="' + cls('nu-page-head', o.court !== false && 'nu-page-head--court') + '"' + (o.id ? ' id="' + esc(o.id) + '"' : '') + '>' +
      '<div class="nu-page-head__text">' + (o.eyebrow ? '<div class="nu-eyebrow">' + esc(o.eyebrow) + '</div>' : '') +
      '<h1 class="nu-page-head__title">' + esc(o.title) + '</h1>' + (o.sub ? '<p class="nu-page-head__sub">' + esc(o.sub) + '</p>' : '') + '</div>' +
      (o.actions ? '<div class="nu-page-head__actions">' + o.actions + '</div>' : '') + '</header>';
  }
  // skeleton(n, { kind: 'row'|'tile'|'card' }) -> loading placeholders (aria-hidden)
  function skeleton(n, opts) {
    n = Math.max(0, Math.floor(n || 0)); var kind = (opts && opts.kind) || 'row', out = '';
    for (var i = 0; i < n; i++) {
      var w1 = 38 + ((i * 37) % 30), w2 = 22 + ((i * 53) % 20);
      if (kind === 'tile') out += '<div class="nu-stat" aria-hidden="true"><span class="nu-skel" style="width:50%;height:10px"></span><span class="nu-skel" style="width:70%;height:26px"></span></div>';
      else if (kind === 'card') out += '<div class="nu-card" aria-hidden="true"><span class="nu-skel nu-skel--title"></span><span class="nu-skel" style="margin-top:14px;width:90%"></span><span class="nu-skel" style="margin-top:8px;width:70%"></span></div>';
      else out += '<div class="nu-skel-row" aria-hidden="true"><span class="nu-skel nu-skel--circle" style="width:40px;height:40px"></span><span class="nu-skel-row__text"><span class="nu-skel" style="width:' + w1 + '%"></span><span class="nu-skel" style="width:' + w2 + '%;height:10px"></span></span><span class="nu-skel" style="width:44px;height:18px"></span></div>';
    }
    return out;
  }
  function emptyState(o) {
    o = o || {};
    return '<div class="nu-empty"><span class="nu-ball" aria-hidden="true"></span><div class="nu-empty__title">' + esc(o.title || 'Nothing here yet') + '</div>' +
      (o.body ? '<div class="nu-empty__body">' + esc(o.body) + '</div>' : '') + (o.action || '') + '</div>';
  }
  function callout(tone, html) {
    var role = tone === 'error' ? 'alert' : 'status';
    return '<div class="' + cls('nu-callout', tone && 'nu-callout--' + tone) + '" role="' + role + '">' + ICON[tone === 'error' || tone === 'warn' ? 'alert' : 'info'] + '<div>' + html + '</div></div>';
  }

  // ---- icons (24px, 1.75 stroke, currentColor) ----------------------------
  function svg(p) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + p + '</svg>'; }
  var ICON = {
    board: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M3.5 9.5h17M9.5 9.5v11"/>'),
    research: svg('<circle cx="10.5" cy="8" r="3.5"/><path d="M4 20c.8-3.6 3.4-5.5 6.5-5.5 1.3 0 2.5.3 3.5 1"/><circle cx="17.5" cy="16.5" r="2.5"/><path d="m19.4 18.4 1.8 1.8"/>'),
    lineup: svg('<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="M4 12h16"/><circle cx="12" cy="12" r="2.6"/><path d="M8.5 3.5v2.8a3.5 3.5 0 0 0 7 0V3.5M8.5 20.5v-2.8a3.5 3.5 0 0 1 7 0v2.8"/>'),
    trade: svg('<path d="M4 8h13.5M14 4.5 17.5 8 14 11.5M20 16H6.5M10 12.5 6.5 16l3.5 3.5"/>'),
    waivers: svg('<path d="M12 5v14M5 12h14"/><circle cx="12" cy="12" r="9"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    alert: svg('<path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4M12 17h.01"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    chevron: svg('<path d="m9 6 6 6-6 6"/>'),
    filter: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'),
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>'),
    star: svg('<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"/>'),
  };

  // ---- nav -------------------------------------------------------------------
  var NAV_TABS = [
    { key: 'board', href: '/nba', label: 'Board', long: 'Draft Board', icon: 'board' },
    { key: 'research', href: '/nba/research', label: 'Research', long: 'Research', icon: 'research' },
    { key: 'lineup', href: '/nba/lineup', label: 'Lineup', long: 'Lineup', icon: 'lineup' },
    { key: 'trade', href: '/nba/trade', label: 'Trade', long: 'Trade', icon: 'trade' },
    { key: 'waivers', href: '/nba/waivers', label: 'Waivers', long: 'Waivers', icon: 'waivers' },
  ];
  function activeFromPath(pathname) {
    var p = String(pathname || '').replace(/\/+$/, '') || '/';
    if (p === '/nba' || p === '/nba/draft') return 'board';
    var m = /^\/nba\/(research|lineup|trade|waivers)/.exec(p);
    return m ? m[1] : null;
  }
  // navHtml({ active }) -> markup for #rr-nav + the mobile tab bar. Uses the
  // shared/nav.js classes: .rr-logo, .rr-sport/.rr-sport-opt (with the same
  // data-umami-event names), .rr-links/.rr-link, .rr-auth, .nav-hamburger.
  function navHtml(o) {
    o = o || {};
    var active = o.active;
    // same markup + umami events as shared/nav.js sportSwitchHtml('nba')
    var sportSwitch = '<a href="/nfl" class="rr-sport-opt" data-sport="nfl" data-umami-event="nfl-nav-switch">NFL</a>' +
      '<a href="/nba" class="rr-sport-opt active" data-sport="nba" data-umami-event="nba-nav-switch" aria-current="page">NBA</a>';
    var links = NAV_TABS.map(function (t) {
      var on = t.key === active;
      return '<a href="' + t.href + '" class="rr-link' + (on ? ' active' : '') + '" data-umami-event="nba-nav-' + t.key + '"' + (on ? ' aria-current="page"' : '') + '>' + ICON[t.icon] + '<span>' + esc(t.long) + '</span></a>';
    }).join('');
    var tabs = NAV_TABS.map(function (t) {
      var on = t.key === active;
      return '<a href="' + t.href + '" data-umami-event="nba-tabbar-' + t.key + '"' + (on ? ' aria-current="page"' : '') + '>' + ICON[t.icon] + '<span>' + esc(t.label) + '</span></a>';
    }).join('');
    return {
      nav: '<nav id="rr-nav" aria-label="Main">' +
        '<a href="/nba" class="rr-logo"><span class="nu-ball" aria-hidden="true"></span>Pocket</a>' +
        '<div class="rr-sport" role="group" aria-label="Sport">' + sportSwitch + '</div>' +
        '<div class="rr-links">' + links + '</div>' +
        '<div class="rr-auth"><span class="nu-nav-status" id="nu-nav-status" data-nba-yahoo-chip></span></div>' +
        '<button class="nav-hamburger" type="button" aria-label="Open menu" aria-controls="rr-nav" aria-expanded="false">&#9776;</button>' +
        '</nav>',
      tabbar: '<nav class="nu-tabbar" aria-label="NBA tools">' + tabs + '</nav>',
    };
  }
  // mountNav({ active?, target? }) — replaces [data-nu-nav] (or prepends to
  // <body>) with the nav and appends the mobile tab bar. Call it synchronously
  // in <body> BEFORE the deferred /shared/nav.js runs; if nav.js already ran,
  // this re-runs PocketNav.enhance (hamburger then needs a reload — see doc).
  function mountNav(o) {
    if (!doc) return null;
    o = o || {};
    var active = o.active || activeFromPath(win.location && win.location.pathname);
    var h = navHtml({ active: active });
    var old = doc.getElementById('rr-nav');
    var target = o.target || doc.querySelector('[data-nu-nav]');
    var wrap = doc.createElement('div');
    wrap.innerHTML = h.nav;
    var nav = wrap.firstChild;
    if (target) target.parentNode.replaceChild(nav, target);
    else if (old) old.parentNode.replaceChild(nav, old);
    else doc.body.insertBefore(nav, doc.body.firstChild);
    if (old && old !== nav && old.parentNode) old.parentNode.removeChild(old);
    if (!doc.querySelector('.nu-tabbar')) {
      wrap.innerHTML = h.tabbar;
      doc.body.appendChild(wrap.firstChild);
    }
    doc.body.classList.add('nba-ui', 'nu-has-tabbar');
    if (win.PocketNav && win.PocketNav.enhance) win.PocketNav.enhance(nav, win.location.pathname, doc);
    return nav;
  }
  // statusChip(state, label) -> nav status chip; state: connected|syncing|error|off
  function statusChip(state, label, href) {
    var tag = href ? 'a' : 'span';
    return '<' + tag + ' class="nu-status-chip" data-state="' + esc(state || 'off') + '"' + (href ? ' href="' + esc(href) + '"' : '') + '><span class="nu-dot" aria-hidden="true"></span>' + esc(label || 'Yahoo') + '</' + tag + '>';
  }

  // ---- browser behaviours -------------------------------------------------
  // Image fallback: walk data-srcs; at the end remove the <img> so initials show.
  function nextSrc(img) {
    var list = String(img.getAttribute('data-srcs') || '').split('|').filter(Boolean);
    var i = list.indexOf(img.getAttribute('src'));
    var next = list[i + 1];
    if (next) { img.setAttribute('data-src-kind', srcKind(next)); img.src = next; return true; }
    if (img.parentNode) img.parentNode.removeChild(img);
    return false;
  }
  function hydrateImages(scope) {
    if (!doc) return;
    var imgs = (scope || doc).querySelectorAll('img[data-srcs]');
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if (im.complete) { if (im.naturalWidth > 0) im.classList.add('is-loaded'); else if (im.getAttribute('src')) nextSrc(im); }
    }
  }
  if (doc) {
    doc.addEventListener('error', function (e) { var t = e.target; if (t && t.tagName === 'IMG' && t.hasAttribute('data-srcs')) nextSrc(t); }, true);
    doc.addEventListener('load', function (e) { var t = e.target; if (t && t.tagName === 'IMG' && t.hasAttribute('data-srcs')) t.classList.add('is-loaded'); }, true);
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { hydrateImages(); });
  }

  // toast(msg, { tone: 'good'|'bad', timeout: ms, action: { label, onClick } })
  var toastRegion = null;
  function toast(msg, opts) {
    if (!doc) return null;
    opts = opts || {};
    if (!toastRegion || !toastRegion.isConnected) {
      toastRegion = doc.createElement('div');
      toastRegion.className = 'nu-toast-region';
      toastRegion.setAttribute('role', 'status');
      toastRegion.setAttribute('aria-live', 'polite');
      doc.body.appendChild(toastRegion);
    }
    var t = doc.createElement('div');
    t.className = 'nu-toast';
    if (opts.tone) t.setAttribute('data-tone', opts.tone);
    var span = doc.createElement('span'); span.textContent = msg; t.appendChild(span);
    function dismiss() {
      if (!t.parentNode) return;
      t.classList.add('is-leaving');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
    }
    if (opts.action) {
      var b = doc.createElement('button'); b.type = 'button'; b.className = 'nu-toast__action'; b.textContent = opts.action.label;
      b.addEventListener('click', function () { try { opts.action.onClick(); } finally { dismiss(); } });
      t.appendChild(b);
    }
    toastRegion.appendChild(t);
    while (toastRegion.children.length > 3) toastRegion.removeChild(toastRegion.firstChild);
    setTimeout(dismiss, opts.timeout || 3200);
    return { el: t, dismiss: dismiss };
  }

  // sheet.open(elOrId, { onClose, initialFocus }) / sheet.close()
  // The element is a .nu-sheet with role="dialog" aria-modal="true"
  // aria-labelledby=...; it is moved to <body> on first open. Focus is trapped,
  // ESC + backdrop click + any [data-nu-close] inside close it, focus returns to
  // the opener, body scroll locks, background gets inert.
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  var sheetState = null;
  function focusables(el) { return Array.prototype.filter.call(el.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null || n === doc.activeElement; }); }
  function sheetOpen(elOrId, opts) {
    if (!doc) return;
    opts = opts || {};
    var el = typeof elOrId === 'string' ? doc.getElementById(elOrId) : elOrId;
    if (!el) return;
    if (sheetState) sheetClose(true);
    if (el.parentNode !== doc.body) doc.body.appendChild(el);
    var bd = doc.createElement('div'); bd.className = 'nu-sheet-backdrop'; bd.setAttribute('aria-hidden', 'true');
    doc.body.insertBefore(bd, el);
    var inerted = [];
    Array.prototype.forEach.call(doc.body.children, function (c) {
      if (c !== el && c !== bd && c !== toastRegion && !c.hasAttribute('inert') && c.tagName !== 'SCRIPT') { c.setAttribute('inert', ''); inerted.push(c); }
    });
    el.hidden = false;
    el.setAttribute('role', el.getAttribute('role') || 'dialog');
    el.setAttribute('aria-modal', 'true');
    doc.body.classList.add('nu-scroll-lock');
    // next frame so the transition runs
    var raf = win.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    // focus only once .is-open is on: a visibility:hidden sheet can't take focus
    var focusTarget = null;
    raf(function () { raf(function () { if (!sheetState || sheetState.el !== el) return; el.classList.add('is-open'); bd.classList.add('is-open'); if (focusTarget) focusTarget.focus({ preventScroll: true }); }); });
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); sheetClose(); return; }
      if (e.key !== 'Tab') return;
      var f = focusables(el); if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function onClick(e) { if (e.target.closest && e.target.closest('[data-nu-close]')) { e.preventDefault(); sheetClose(); } }
    bd.addEventListener('click', function () { sheetClose(); });
    doc.addEventListener('keydown', onKey, true);
    el.addEventListener('click', onClick);
    sheetState = { el: el, bd: bd, opener: doc.activeElement, onKey: onKey, onClick: onClick, inerted: inerted, onClose: opts.onClose };
    // Focus the dialog itself (no ring flash on the close button for touch
    // users) unless the page asks for a field; Tab then enters the trap.
    var target = opts.initialFocus ? el.querySelector(opts.initialFocus) : el.querySelector('[autofocus]');
    if (!target) el.setAttribute('tabindex', '-1');
    focusTarget = target || el;
  }
  function sheetClose(immediate) {
    if (!sheetState) return;
    var s = sheetState; sheetState = null;
    doc.removeEventListener('keydown', s.onKey, true);
    s.el.removeEventListener('click', s.onClick);
    s.inerted.forEach(function (c) { c.removeAttribute('inert'); });
    doc.body.classList.remove('nu-scroll-lock');
    s.el.classList.remove('is-open'); s.bd.classList.remove('is-open');
    var done = function () { if (s.bd.parentNode) s.bd.parentNode.removeChild(s.bd); if (!s.el.classList.contains('is-open')) s.el.hidden = true; };
    if (immediate) done(); else setTimeout(done, 340);
    if (s.opener && s.opener.focus) s.opener.focus({ preventScroll: true });
    if (typeof s.onClose === 'function') s.onClose();
  }
  var sheet = { open: sheetOpen, close: sheetClose, isOpen: function () { return !!sheetState; } };

  // tabs(root, { onChange }) — root is role=tablist with role=tab buttons
  // carrying aria-controls. Arrow/Home/End move + activate (automatic tabs).
  function tabs(root, opts) {
    if (!root) return null;
    opts = opts || {};
    var list = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      list.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        var panel = t.getAttribute('aria-controls') && doc.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
      if (opts.onChange) opts.onChange(tab.getAttribute('data-value') || tab.id, tab);
    }
    list.forEach(function (t) {
      t.addEventListener('click', function () { select(t); });
      t.addEventListener('keydown', function (e) {
        var i = list.indexOf(t), n = list.length, j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % n; else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
        else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = n - 1;
        if (j != null) { e.preventDefault(); select(list[j], true); }
      });
    });
    var init = list.filter(function (t) { return t.getAttribute('aria-selected') === 'true'; })[0] || list[0];
    if (init) { list.forEach(function (t) { t.tabIndex = t === init ? 0 : -1; }); }
    return { select: function (v) { var t = list.filter(function (x) { return (x.getAttribute('data-value') || x.id) === v; })[0]; if (t) select(t); } };
  }
  // segmented(root, { onChange, multi }) — buttons with aria-pressed + data-value.
  function segmented(root, opts) {
    if (!root) return null;
    opts = opts || {};
    var btns = Array.prototype.slice.call(root.querySelectorAll('button'));
    function value() {
      var on = btns.filter(function (b) { return b.getAttribute('aria-pressed') === 'true'; }).map(function (b) { return b.getAttribute('data-value'); });
      return opts.multi ? on : (on[0] || null);
    }
    function set(v, quiet) {
      btns.forEach(function (b) {
        var bv = b.getAttribute('data-value');
        var on = opts.multi ? (Array.isArray(v) && v.indexOf(bv) >= 0) : bv === v;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (!quiet && opts.onChange) opts.onChange(value());
    }
    btns.forEach(function (b) {
      if (!b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () {
        if (opts.multi) { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); if (opts.onChange) opts.onChange(value()); }
        else set(b.getAttribute('data-value'));
      });
    });
    return { value: value, set: set };
  }
  // stagger(container): sets --i on children with .nu-rise for the entrance.
  function stagger(container) {
    if (!container) return;
    Array.prototype.forEach.call(container.children, function (c, i) { c.style.setProperty('--i', i); c.classList.add('nu-rise'); });
  }

  return {
    version: '1.0.0',
    esc: esc, fmt: fmt, icon: ICON, TEAM_COLORS: TEAM_COLORS, NAV_TABS: NAV_TABS, POS_ORDER: POS_ORDER,
    avatar: avatar, headshotSrcs: headshotSrcs, teamLogo: teamLogo, teamLogoSrcs: teamLogoSrcs,
    posPill: posPill, tierBadge: tierBadge, injuryBadge: injuryBadge, injuryKey: injuryKey, valueBadge: valueBadge,
    delta: deltaHtml, statTile: statTile, rangeBand: rangeBand, meter: meter,
    sparkline: sparkline, sparkPoints: sparkPoints, histogram: histogram, binCounts: binCounts,
    playerCell: playerCell, pageHeader: pageHeader, skeleton: skeleton, emptyState: emptyState, callout: callout,
    statusChip: statusChip, navHtml: navHtml, mountNav: mountNav, activeFromPath: activeFromPath,
    hydrateImages: hydrateImages, toast: toast, sheet: sheet, tabs: tabs, segmented: segmented, stagger: stagger,
  };
});
