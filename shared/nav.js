/* Pocket nav — mobile hamburger toggle.
   Toggles `.open` on #rr-nav; shared/styles.css (section 5 + 10) shows
   .rr-links and .rr-auth as a stacked dropdown when open on ≤768px.
   Closes on: link tap, Sign In tap, tap outside, Escape, resize to desktop.

   Also injects the NFL | NBA sport switch after the logo on every page that
   has #rr-nav (window.PocketNav.sportSwitchHtml() returns the same markup for
   pages that want to render it themselves; an existing .rr-sport is kept). */
(function () {
  var nav = document.getElementById('rr-nav');
  var isNba = /^\/nba(\/|$)/.test(location.pathname);

  function sportSwitchHtml(sport) {
    var nba = sport ? sport === 'nba' : isNba;
    return '<a href="/nfl" class="rr-sport-opt' + (nba ? '' : ' active') + '"' + (nba ? '' : ' aria-current="page"') + '>NFL</a>' +
      '<a href="/nba" class="rr-sport-opt' + (nba ? ' active' : '') + '"' + (nba ? ' aria-current="page"' : '') + '>NBA</a>';
  }
  window.PocketNav = { sportSwitchHtml: sportSwitchHtml };

  if (!nav || nav.querySelector('.rr-sport')) return;
  if (!document.getElementById('rr-sport-css')) {
    var css = document.createElement('style');
    css.id = 'rr-sport-css';
    css.textContent =
      '#rr-nav .rr-sport{display:inline-flex;align-items:center;gap:2px;margin:0 0.75rem 0 0.25rem;padding:2px;' +
      'border:1px solid var(--border,rgba(255,255,255,0.12));border-radius:999px;flex-shrink:0}' +
      '#rr-nav .rr-sport-opt{font-size:0.72rem;font-weight:600;letter-spacing:0.04em;padding:0.2rem 0.55rem;border-radius:999px;' +
      'color:var(--text-secondary,#9aa);text-decoration:none;line-height:1.4}' +
      '#rr-nav .rr-sport-opt:hover{color:var(--text-primary,#fff)}' +
      '#rr-nav .rr-sport-opt.active{color:var(--text-primary,#fff);background:var(--accent-glow,rgba(120,140,255,0.2))}';
    document.head.appendChild(css);
  }
  var sw = document.createElement('div');
  sw.className = 'rr-sport';
  sw.setAttribute('role', 'group');
  sw.setAttribute('aria-label', 'Sport');
  sw.innerHTML = sportSwitchHtml();
  var logo = nav.querySelector('.rr-logo');
  if (logo && logo.nextSibling) nav.insertBefore(sw, logo.nextSibling);
  else if (logo) nav.appendChild(sw);
  else nav.insertBefore(sw, nav.firstChild);
})();

(function () {
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

  // Tap a nav link or Sign In → close.
  nav.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('a.rr-link, #rr-sign-in')) setOpen(false);
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
