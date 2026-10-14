/* Pocket NBA — Yahoo connection chip for the nav (any NBA page).
   Include after /shared/nav.js:  <script defer src="/nba/pages/yahoo-chip.js"></script>
   Renders a small "Yahoo" chip + menu in #rr-nav .rr-auth (or in an element
   with [data-nba-yahoo-chip]): connected state, league picker, reconnect,
   disconnect (POST /nba/auth/logout, same-origin). Uses only
   GET /api/nba/yahoo/status.

   window.PocketYahoo
     .status()          -> Promise<{ connected, leagues, yahooGuid?, reauth?, httpStatus? }> (one shared fetch)
     .refresh()         -> re-fetch and re-render
     .league()          -> currently chosen league_key ('' = manual board, null = unset)
     .setLeague(key)    -> remember + broadcast 'pocket-nba:league' (detail: { leagueKey })
     .disconnect()      -> Promise<boolean>
   The chip listens for 'pocket-nba:league' too, so pages can drive it. */
(function () {
  'use strict';
  if (window.PocketYahoo) return;
  var LEAGUE_PREF = 'pocket-nba-league';
  var EVT = 'pocket-nba:league';
  var statusPromise = null, last = null, root = null, open = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function fetchStatus() {
    statusPromise = fetch('/api/nba/yahoo/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) return { connected: false, leagues: [], httpStatus: r.status, code: j && j.code };
          j.leagues = j.leagues || [];
          return j;
        });
      })
      .catch(function () { return { connected: false, leagues: [], httpStatus: 0 }; })
      .then(function (s) { last = s; render(); return s; });
    return statusPromise;
  }

  function getLeague() { try { return localStorage.getItem(LEAGUE_PREF); } catch (e) { return null; } }
  function setLeague(key, quiet) {
    try { localStorage.setItem(LEAGUE_PREF, key || ''); } catch (e) {}
    render();
    if (!quiet) window.dispatchEvent(new CustomEvent(EVT, { detail: { leagueKey: key || null, source: 'chip' } }));
  }

  function disconnect() {
    return fetch('/nba/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok; }).catch(function () { return false; })
      .then(function (ok) { if (ok) fetchStatus(); return ok; });
  }

  function signIn() {
    if (window.Clerk && typeof window.Clerk.openSignIn === 'function') window.Clerk.openSignIn({ redirectUrl: location.pathname });
    else location.href = '/nba/auth/login';
  }

  var CSS = '.nyc{position:relative;display:inline-flex;margin-right:.5rem}' +
    '.nyc-btn{display:inline-flex;align-items:center;gap:.4rem;min-height:32px;padding:0 .7rem;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);color:inherit;font:600 .72rem/1 inherit;font-family:inherit;cursor:pointer;white-space:nowrap}' +
    '.nyc-btn .y{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:4px;background:#6001d2;color:#fff;font-size:.62rem;font-weight:800}' +
    '.nyc-btn .d{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.35)}' +
    '.nyc.on .d{background:#10b981}.nyc.warn .d{background:#f59e0b}.nyc.err .d{background:#ef4444}' +
    '.nyc-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:1000;min-width:240px;max-width:min(320px,92vw);padding:.4rem;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:#141414;box-shadow:0 18px 50px rgba(0,0,0,.6);font-size:.78rem}' +
    '.nyc-menu[hidden]{display:none}' +
    '.nyc-h{padding:.45rem .55rem .35rem;color:rgba(255,255,255,.6);line-height:1.4}.nyc-h b{color:#fff}' +
    '.nyc-sec{padding:.35rem .55rem .2rem;font-size:.6rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.45)}' +
    '.nyc-item{display:flex;align-items:center;gap:.5rem;width:100%;min-height:38px;padding:0 .55rem;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;text-decoration:none;cursor:pointer}' +
    '.nyc-item:hover,.nyc-item:focus-visible{background:rgba(255,255,255,.07)}' +
    '.nyc-item[aria-checked="true"]::before{content:"✓";color:#fb923c}.nyc-item[aria-checked="false"]::before{content:"";width:.6em}' +
    '.nyc-item.danger{color:#f87171}.nyc-sep{height:1px;margin:.3rem .2rem;background:rgba(255,255,255,.1)}';

  function mount() {
    if (root) return root;
    var host = document.querySelector('[data-nba-yahoo-chip]') || document.querySelector('#rr-nav .rr-auth');
    if (!host) return null;
    if (!document.getElementById('nyc-css')) { var st = document.createElement('style'); st.id = 'nyc-css'; st.textContent = CSS; document.head.appendChild(st); }
    root = document.createElement('div');
    root.className = 'nyc';
    root.id = 'nba-yahoo-chip';
    host.insertBefore(root, host.firstChild);
    root.addEventListener('click', onClick);
    document.addEventListener('click', function (e) { if (open && root && !root.contains(e.target)) toggle(false); });
    document.addEventListener('keydown', function (e) { if (open && e.key === 'Escape') { toggle(false); var b = root.querySelector('.nyc-btn'); if (b) b.focus(); } });
    return root;
  }

  function toggle(v) {
    open = v == null ? !open : v;
    var m = root && root.querySelector('.nyc-menu'), b = root && root.querySelector('.nyc-btn');
    if (m) m.hidden = !open;
    if (b) b.setAttribute('aria-expanded', String(open));
  }

  function render() {
    if (!mount()) return;
    var s = last;
    if (!s) { root.hidden = true; return; }
    root.hidden = false;
    var cls = 'nyc', label, menu = '';
    if (s.connected) {
      cls += ' on'; label = 'Yahoo';
      var cur = getLeague();
      var guid = s.yahooGuid ? String(s.yahooGuid) : '';
      menu += '<div class="nyc-h"><b>Connected to Yahoo</b>' + (guid ? '<br>account ••••' + esc(guid.slice(-4)) : '') + '<br>' + s.leagues.length + ' NBA league' + (s.leagues.length === 1 ? '' : 's') + '</div>';
      if (s.leagues.length) {
        menu += '<div class="nyc-sec">League</div>';
        s.leagues.forEach(function (l) {
          menu += '<button type="button" class="nyc-item" role="menuitemradio" data-league="' + esc(l.league_key) + '" aria-checked="' + (cur === l.league_key) + '">' + esc(l.name) + ' · ' + esc(l.num_teams) + 't' + (l.draft_status === 'postdraft' ? ' · drafted' : '') + '</button>';
        });
        menu += '<button type="button" class="nyc-item" role="menuitemradio" data-league="" aria-checked="' + (cur === '') + '">Manual board (no league)</button>';
      }
      menu += '<div class="nyc-sep"></div><a class="nyc-item" role="menuitem" href="/nba/auth/login">Reconnect Yahoo</a>' +
        '<button type="button" class="nyc-item danger" role="menuitem" data-act="disconnect">Disconnect Yahoo</button>';
    } else if (s.httpStatus === 401) {
      label = 'Yahoo';
      menu = '<div class="nyc-h"><b>Sign in to connect Yahoo.</b><br>The board works without it in manual mode.</div><button type="button" class="nyc-item" role="menuitem" data-act="signin">Sign in</button>';
    } else if (s.httpStatus === 503 || s.code === 'yahoo_misconfigured') {
      cls += ' err'; label = 'Yahoo unavailable';
      menu = '<div class="nyc-h"><b>Yahoo is unavailable right now.</b><br>Your connection is kept; manual mode works meanwhile.</div><button type="button" class="nyc-item" role="menuitem" data-act="retry">Try again</button>';
    } else if (s.httpStatus) {
      cls += ' err'; label = 'Yahoo';
      menu = '<div class="nyc-h"><b>Couldn’t check Yahoo (HTTP ' + esc(s.httpStatus) + ').</b></div><button type="button" class="nyc-item" role="menuitem" data-act="retry">Try again</button>';
    } else if (s.reauth) {
      cls += ' warn'; label = 'Reconnect Yahoo';
      menu = '<div class="nyc-h"><b>Yahoo sign-in expired.</b><br>Reconnect to keep live sync.</div><a class="nyc-item" role="menuitem" href="/nba/auth/login">Reconnect Yahoo</a>';
    } else {
      label = 'Connect Yahoo';
      menu = '<div class="nyc-h"><b>Not connected.</b><br>Connect to load your league settings, draft order and live picks.</div><a class="nyc-item" role="menuitem" href="/nba/auth/login">Connect Yahoo</a>';
    }
    root.className = cls;
    root.innerHTML = '<button type="button" class="nyc-btn" aria-haspopup="true" aria-expanded="' + open + '" aria-controls="nyc-menu"><span class="y" aria-hidden="true">Y!</span><span class="d" aria-hidden="true"></span>' + esc(label) + '</button>' +
      '<div class="nyc-menu" id="nyc-menu" role="menu" aria-label="Yahoo connection"' + (open ? '' : ' hidden') + '>' + menu + '</div>';
  }

  function onClick(e) {
    var t = e.target.closest('button,a');
    if (!t) return;
    if (t.classList.contains('nyc-btn')) { toggle(); return; }
    if (t.hasAttribute('data-league')) { setLeague(t.getAttribute('data-league')); toggle(false); return; }
    var act = t.getAttribute('data-act');
    if (act === 'disconnect') {
      if (!confirm('Disconnect Yahoo from Pocket? Picks marked on this device stay.')) return;
      t.disabled = true;
      disconnect().then(function (ok) { if (!ok) alert('Could not disconnect right now. Try again.'); else location.reload(); });
    } else if (act === 'signin') { toggle(false); signIn(); }
    else if (act === 'retry') { toggle(false); fetchStatus(); }
  }

  window.addEventListener(EVT, function (e) { if (e.detail && e.detail.source !== 'chip') render(); });

  window.PocketYahoo = {
    status: function () { return statusPromise || fetchStatus(); },
    refresh: fetchStatus,
    league: getLeague,
    setLeague: function (k) { setLeague(k); },
    disconnect: disconnect,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mount(); window.PocketYahoo.status(); });
  else { mount(); window.PocketYahoo.status(); }
})();
