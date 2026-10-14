/* Pocket nav — sport switch + mobile hamburger toggle.

   Sport switch (NFL | NBA):
   - The current sport comes from location.pathname: /nba and /nba/* are NBA,
     everything else is NFL.
   - Every page with #rr-nav gets a compact pill after the logo (kept visible on
     the mobile bar) plus a second copy inside the hamburger menu. A page that
     already ships its own switch (.rr-sport or #rr-sport-switch, e.g. the NBA
     pages) keeps it; only the menu copy is added.
   - On NBA pages whose .rr-links still point at NFL tools, the links are
     replaced with the NBA set (Draft board, Lineup). NBA pages that already
     link to /nba* are left alone apart from marking the current link.
   - Styles live in shared/styles.css ("NBA theme" section 12a).
   window.PocketNav exposes the helpers for pages and tests.

   Hamburger: toggles `.open` on #rr-nav; shared/styles.css (section 5 + 10)
   shows .rr-links and .rr-auth as a stacked dropdown when open on ≤768px.
   Closes on: link tap, Sign In tap, tap outside, Escape, resize to desktop. */
(function () {
  var NBA_LINKS = [
    { href: '/nba', label: 'Draft board', match: /^\/nba(\/draft)?\/?$/ },
    { href: '/nba/lineup', label: 'Lineup', match: /^\/nba\/lineup\/?$/ },
  ];

  function sportFor(pathname) {
    return /^\/nba(\/|$)/i.test(pathname || '') ? 'nba' : 'nfl';
  }

  function sportSwitchHtml(sport) {
    var nba = (sport || sportFor(location.pathname)) === 'nba';
    function opt(key, href, label, on) {
      return '<a href="' + href + '" class="rr-sport-opt' + (on ? ' active' : '') + '" data-sport="' + key + '"' +
        ' data-umami-event="' + (key === 'nba' ? 'nba-nav-switch' : 'nfl-nav-switch') + '"' +
        (on ? ' aria-current="page"' : '') + '>' + label + '</a>';
    }
    return opt('nfl', '/nfl', 'NFL', !nba) + opt('nba', '/nba', 'NBA', nba);
  }

  function nbaLinksHtml(pathname) {
    return NBA_LINKS.map(function (l) {
      var on = l.match.test(pathname || '');
      return '<a href="' + l.href + '" class="rr-link' + (on ? ' active' : '') + '"' + (on ? ' aria-current="page"' : '') + '>' + l.label + '</a>';
    }).join('');
  }

  function makeSwitch(doc, sport) {
    var sw = doc.createElement('div');
    sw.className = 'rr-sport';
    sw.setAttribute('role', 'group');
    sw.setAttribute('aria-label', 'Sport');
    sw.innerHTML = sportSwitchHtml(sport);
    return sw;
  }

  // Applies the switch + NBA link set to one nav element. Safe to call twice.
  function enhance(nav, pathname, doc) {
    doc = doc || document;
    if (!nav || nav.getAttribute('data-sport-ready')) return;
    nav.setAttribute('data-sport-ready', '1');
    var sport = sportFor(pathname);
    nav.setAttribute('data-sport', sport);

    // 1. Bar pill (unless the page ships its own switch).
    if (!nav.querySelector('.rr-sport, #rr-sport-switch')) {
      var sw = makeSwitch(doc, sport);
      var logo = nav.querySelector('.rr-logo');
      if (logo) nav.insertBefore(sw, logo.nextSibling);
      else nav.insertBefore(sw, nav.firstChild);
    }

    // 2. NBA link set on /nba* pages that still carry NFL links.
    var links = nav.querySelector('.rr-links');
    if (sport === 'nba' && links) {
      var hasNba = false, as = links.querySelectorAll('a[href]');
      for (var i = 0; i < as.length; i++) if (/^\/nba(\/|$)/.test(as[i].getAttribute('href'))) hasNba = true;
      if (!hasNba) links.innerHTML = nbaLinksHtml(pathname);
      var logoA = nav.querySelector('a.rr-logo');
      if (logoA && !/^\/nba/.test(logoA.getAttribute('href') || '')) logoA.setAttribute('href', '/nba');
    }

    // 3. Menu copy of the switch, shown only inside the open hamburger (CSS).
    if (nav.querySelector('.nav-hamburger') && !nav.querySelector('.rr-sport-menu')) {
      var row = doc.createElement('div');
      row.className = 'rr-sport-menu';
      var lbl = doc.createElement('span');
      lbl.textContent = 'Sport';
      row.appendChild(lbl);
      row.appendChild(makeSwitch(doc, sport));
      nav.appendChild(row);
    }
  }

  var api = { sportFor: sportFor, sportSwitchHtml: sportSwitchHtml, nbaLinksHtml: nbaLinksHtml, enhance: enhance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined') return;
  window.PocketNav = api;
  enhance(document.getElementById('rr-nav'), location.pathname, document);
})();

(function () {
  if (typeof document === 'undefined') return;
  var nav = document.getElementById('rr-nav');
  if (!nav) return;
  var btn = nav.querySelector('.nav-hamburger');
  if (!btn) return;

  function isOpen() { return nav.classList.contains('open'); }
  function setOpen(open) {
    nav.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? '✕' : '☰';
  }

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    setOpen(!isOpen());
  });

  // Tap a nav link, a sport option or Sign In → close.
  nav.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('a.rr-link, a.rr-sport-opt, #rr-sign-in')) setOpen(false);
  });

  // Tap outside the nav → close.
  document.addEventListener('click', function (e) {
    if (isOpen() && !nav.contains(e.target)) setOpen(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) setOpen(false);
  });

  // Reset if the viewport grows past the mobile breakpoint.
  var mq = window.matchMedia('(min-width: 769px)');
  var onChange = function (ev) { if (ev.matches && isOpen()) setOpen(false); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
})();
