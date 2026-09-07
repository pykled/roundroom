/* RoundRoom nav — mobile hamburger toggle.
   Toggles `.open` on #rr-nav; shared/styles.css (section 5 + 10) shows
   .rr-links and .rr-auth as a stacked dropdown when open on ≤768px.
   Closes on: link tap, Sign In tap, tap outside, Escape, resize to desktop. */
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
