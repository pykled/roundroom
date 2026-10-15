/* Pocket NBA — Sleeper account chip for the nav (any NBA page).
   Include after nba-ui.js:  <script src="/nba/pages/sleeper-chip.js"></script>
   Renders a small "Sleeper" chip + menu in #rr-nav .rr-auth (or in an element
   with [data-nba-sleeper-chip]): username form, connected state, league
   picker, switch account, disconnect. Sleeper's API is public, so "connecting"
   is just remembering a username on this device (localStorage), like the NFL
   side's Sleeper-username flow; the NFL field (rr_username) pre-fills the form.
   Uses GET /api/nba/sleeper/user and GET /api/nba/sleeper/leagues.

   window.PocketSleeper
     .status()          -> Promise<{ connected, username, userId, displayName, avatar, season, leagues, httpStatus?, code?, error? }> (one shared fetch)
     .refresh()         -> re-fetch and re-render
     .connect(username) -> Promise<status> (resolves the username, remembers it, loads leagues)
     .disconnect()      -> forget the username on this device
     .user()            -> { username, userId, displayName } | null
     .league()          -> currently chosen league_key ('' = manual board, null = unset)
     .setLeague(key)    -> remember + broadcast 'pocket-nba:league' (detail: { leagueKey })
     .openConnect()     -> open the menu on the username form
   Events: 'pocket-nba:account' (detail: { status }) after connect / disconnect / refresh;
   'pocket-nba:league' (detail: { leagueKey, source }) on league choice. */
(function () {
  'use strict';
  if (window.PocketSleeper) return;
  var USER_PREF = 'pocket-nba-sleeper';     // JSON { username, userId, displayName, avatar }
  var LEAGUE_PREF = 'pocket-nba-league';
  var NFL_USER_PREF = 'rr_username';
  var EVT = 'pocket-nba:league', ACCOUNT_EVT = 'pocket-nba:account';
  var statusPromise = null, last = null, root = null, open = false, formOpen = false, busy = false, formErr = '';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function write(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  function getUser() {
    var raw = read(USER_PREF);
    if (!raw) return null;
    try { var u = JSON.parse(raw); return u && u.username && u.userId ? u : null; } catch (e) { return null; }
  }
  function prefillName() { var u = getUser(); if (u) return u.username; return (read(NFL_USER_PREF) || '').trim(); }

  function api(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && j.error) || ('HTTP ' + r.status)); e.status = r.status; e.code = j && j.code; throw e; }
        return j;
      });
    });
  }

  function offline() { return { connected: false, leagues: [], username: null, userId: null }; }

  function fetchStatus() {
    var u = getUser();
    if (!u) { statusPromise = Promise.resolve(offline()).then(function (s) { last = s; render(); return s; }); return statusPromise; }
    statusPromise = api('/api/nba/sleeper/leagues?user_id=' + encodeURIComponent(u.userId)).then(function (j) {
      var user = j.user || {};
      return { connected: true, username: user.username || u.username, userId: String(j.user_id || u.userId), displayName: user.display_name || u.displayName || u.username,
        avatar: user.avatar || u.avatar || null, season: j.season || null, leagues: j.leagues || [] };
    }).catch(function (e) {
      // Still "connected" on a Sleeper outage (the username is remembered); the board shows the outage.
      return { connected: e.status !== 404, username: u.username, userId: u.userId, displayName: u.displayName || u.username, avatar: u.avatar || null,
        leagues: [], httpStatus: e.status || 0, code: e.code || (e.status ? undefined : 'offline'), error: e.message };
    }).then(function (s) { last = s; render(); return s; });
    return statusPromise;
  }

  function connect(username) {
    var name = String(username || '').trim().replace(/^@/, '');
    if (!name) return Promise.reject(new Error('Enter your Sleeper username'));
    return api('/api/nba/sleeper/user?username=' + encodeURIComponent(name)).then(function (j) {
      write(USER_PREF, JSON.stringify({ username: j.username || name, userId: String(j.user_id), displayName: j.display_name || j.username || name, avatar: j.avatar || null }));
      write(LEAGUE_PREF, null); // a new account → pick the league again
      return fetchStatus();
    }).then(function (s) { window.dispatchEvent(new CustomEvent(ACCOUNT_EVT, { detail: { status: s, action: 'connect' } })); return s; });
  }
  function disconnect() {
    write(USER_PREF, null); write(LEAGUE_PREF, null);
    last = offline(); statusPromise = Promise.resolve(last); formOpen = false; render();
    window.dispatchEvent(new CustomEvent(ACCOUNT_EVT, { detail: { status: last, action: 'disconnect' } }));
    return Promise.resolve(true);
  }

  function getLeague() { return read(LEAGUE_PREF); }
  function setLeague(key, quiet) {
    write(LEAGUE_PREF, key || '');
    render();
    if (!quiet) window.dispatchEvent(new CustomEvent(EVT, { detail: { leagueKey: key || null, source: 'chip' } }));
  }

  var CSS = '.nyc{position:relative;display:inline-flex;margin-right:.5rem}' +
    '.nyc-btn{display:inline-flex;align-items:center;gap:.4rem;min-height:32px;padding:0 .7rem;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);color:inherit;font:600 .72rem/1 inherit;font-family:inherit;cursor:pointer;white-space:nowrap}' +
    '.nyc-btn .y{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:4px;background:#2d3a63;color:#fff;font-size:.62rem;font-weight:800}' +
    '.nyc-btn .d{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.35)}' +
    '.nyc.on .d{background:#10b981}.nyc.warn .d{background:#f59e0b}.nyc.err .d{background:#ef4444}' +
    '.nyc-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:1000;min-width:260px;max-width:min(340px,92vw);padding:.4rem;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:#141414;box-shadow:0 18px 50px rgba(0,0,0,.6);font-size:.78rem}' +
    '.nyc-menu[hidden]{display:none}' +
    '.nyc-h{padding:.45rem .55rem .35rem;color:rgba(255,255,255,.6);line-height:1.4}.nyc-h b{color:#fff}' +
    '.nyc-sec{padding:.35rem .55rem .2rem;font-size:.6rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.45)}' +
    '.nyc-item{display:flex;align-items:center;gap:.5rem;width:100%;min-height:38px;padding:0 .55rem;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;text-decoration:none;cursor:pointer}' +
    '.nyc-item:hover,.nyc-item:focus-visible{background:rgba(255,255,255,.07)}' +
    '.nyc-item[aria-checked="true"]::before{content:"✓";color:#fb923c}.nyc-item[aria-checked="false"]::before{content:"";width:.6em}' +
    '.nyc-item.danger{color:#f87171}.nyc-sep{height:1px;margin:.3rem .2rem;background:rgba(255,255,255,.1)}' +
    '.nyc-form{display:flex;flex-direction:column;gap:.4rem;padding:.35rem .55rem .5rem}' +
    '.nyc-form input{min-height:40px;padding:0 .6rem;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.05);color:#fff;font:inherit;font-size:16px}' +
    '.nyc-form button{min-height:40px;border-radius:8px;border:0;background:#f7711f;color:#1c0b02;font:700 .78rem/1 inherit;font-family:inherit;cursor:pointer}' +
    '.nyc-form button[disabled]{opacity:.6;cursor:default}.nyc-err{color:#f87171;font-size:.72rem;line-height:1.35}' +
    '.nyc-sub{color:rgba(255,255,255,.5);font-size:.68rem;line-height:1.35}';

  function mount() {
    if (root) return root;
    var host = document.querySelector('[data-nba-sleeper-chip]') || document.querySelector('[data-nba-yahoo-chip]') || document.querySelector('#rr-nav .rr-auth');
    if (!host) return null;
    if (!document.getElementById('nyc-css')) { var st = document.createElement('style'); st.id = 'nyc-css'; st.textContent = CSS; document.head.appendChild(st); }
    root = document.createElement('div');
    root.className = 'nyc';
    root.id = 'nba-sleeper-chip';
    host.insertBefore(root, host.firstChild);
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    // Outside click closes the menu. A click that re-rendered the chip leaves a
    // detached target (isConnected false): that one came from inside, keep open.
    document.addEventListener('click', function (e) { if (open && root && e.target && e.target.isConnected && !root.contains(e.target)) toggle(false); });
    document.addEventListener('keydown', function (e) { if (open && e.key === 'Escape') { toggle(false); var b = root.querySelector('.nyc-btn'); if (b) b.focus(); } });
    return root;
  }

  function toggle(v) {
    open = v == null ? !open : v;
    if (!open) formOpen = false;
    var m = root && root.querySelector('.nyc-menu'), b = root && root.querySelector('.nyc-btn');
    if (m) m.hidden = !open;
    if (b) b.setAttribute('aria-expanded', String(open));
  }

  function formHtml(intro) {
    return (intro ? '<div class="nyc-h">' + intro + '</div>' : '') +
      '<form class="nyc-form" id="nyc-form" novalidate><label class="nyc-sub" for="nyc-user">Sleeper username</label>' +
      '<input id="nyc-user" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="username" value="' + esc(prefillName()) + '" aria-describedby="nyc-form-err">' +
      '<button type="submit"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Looking up…' : 'Connect Sleeper') + '</button>' +
      '<div class="nyc-err" id="nyc-form-err" role="alert">' + esc(formErr) + '</div>' +
      '<div class="nyc-sub">Read-only. Pocket only reads public league data; nothing is sent to Sleeper and no password is needed.</div></form>';
  }

  function render() {
    if (!mount()) return;
    var s = last;
    if (!s) { root.hidden = true; return; }
    root.hidden = false;
    var cls = 'nyc', label, menu = '';
    if (s.connected && !formOpen) {
      cls += ' on'; label = '@' + s.username;
      var cur = getLeague();
      if (s.httpStatus || s.code) {
        cls += ' err';
        menu += '<div class="nyc-h"><b>Connected as @' + esc(s.username) + '</b><br>' + (s.httpStatus === 429 ? 'Sleeper is rate-limiting us. Wait a few seconds and try again.' : s.httpStatus === 0 ? 'Can’t reach Pocket right now.' : 'Sleeper isn’t responding right now.') + ' Manual mode works meanwhile.</div>' +
          '<button type="button" class="nyc-item" role="menuitem" data-act="retry">Try again</button>';
      } else {
        menu += '<div class="nyc-h"><b>Connected as @' + esc(s.username) + '</b><br>' +
          (s.leagues.length ? s.leagues.length + ' NBA league' + (s.leagues.length === 1 ? '' : 's') + (s.season ? ' · ' + esc(s.season) + '-' + esc(String((Number(s.season) + 1) % 100).padStart(2, '0')) : '') : 'No NBA leagues on this Sleeper account this season. Joined with another username? Switch account.') + '</div>';
        if (!s.leagues.length) cls += ' warn';
        if (s.leagues.length) {
          menu += '<div class="nyc-sec">League</div>';
          s.leagues.forEach(function (l) {
            menu += '<button type="button" class="nyc-item" role="menuitemradio" data-league="' + esc(l.league_key) + '" aria-checked="' + (cur === l.league_key) + '">' + esc(l.name) + ' · ' + esc(l.num_teams) + 't' + (l.draft_status === 'postdraft' ? ' · drafted' : l.draft_status === 'drafting' ? ' · drafting' : '') + '</button>';
          });
          menu += '<button type="button" class="nyc-item" role="menuitemradio" data-league="" aria-checked="' + (cur === '') + '">Manual board (no league)</button>';
        }
      }
      menu += '<div class="nyc-sep"></div><button type="button" class="nyc-item" role="menuitem" data-act="switch">Switch account</button>' +
        '<button type="button" class="nyc-item danger" role="menuitem" data-act="disconnect">Disconnect Sleeper</button>';
    } else {
      label = s.connected ? '@' + s.username : 'Connect Sleeper';
      if (s.connected) cls += ' on';
      menu = formHtml(s.connected ? '<b>Switch Sleeper account.</b>' : '<b>Not connected.</b><br>Enter your Sleeper username to load your leagues, draft order and live picks. The board works without it in manual mode.');
    }
    root.className = cls;
    root.innerHTML = '<button type="button" class="nyc-btn" aria-haspopup="true" aria-expanded="' + open + '" aria-controls="nyc-menu"><span class="y" aria-hidden="true">S</span><span class="d" aria-hidden="true"></span>' + esc(label) + '</button>' +
      '<div class="nyc-menu" id="nyc-menu" role="menu" aria-label="Sleeper connection"' + (open ? '' : ' hidden') + '>' + menu + '</div>';
    if (open && formOpen) { var inp = root.querySelector('#nyc-user'); if (inp && !busy) inp.focus(); }
  }

  function onSubmit(e) {
    var f = e.target.closest && e.target.closest('#nyc-form');
    if (!f) return;
    e.preventDefault();
    if (busy) return;
    var name = (f.querySelector('#nyc-user').value || '').trim().replace(/^@/, '');
    if (!name) { formErr = 'Enter your Sleeper username.'; render(); return; }
    busy = true; formErr = ''; render();
    connect(name).then(function () { busy = false; formOpen = false; toggle(false); render(); }, function (err) {
      busy = false;
      formErr = err && err.status === 404 ? 'No Sleeper user named “' + name + '”. Check the spelling.'
        : err && err.status === 429 ? 'Sleeper is rate-limiting us. Try again in a few seconds.'
        : err && (err.status >= 500 || err.status === 0 || !err.status) ? 'Sleeper isn’t responding right now. Try again in a moment.'
        : (err && err.message) || 'Couldn’t connect.';
      render();
    });
  }

  function onClick(e) {
    var t = e.target.closest('button,a');
    if (!t || t.closest('form')) return;
    if (t.classList.contains('nyc-btn')) { if (!open && !(last && last.connected)) formOpen = true; toggle(); render(); return; }
    if (t.hasAttribute('data-league')) { setLeague(t.getAttribute('data-league')); toggle(false); return; }
    var act = t.getAttribute('data-act');
    if (act === 'disconnect') {
      if (!confirm('Disconnect Sleeper from Pocket on this device? Picks marked by hand stay.')) return;
      disconnect();
    } else if (act === 'switch') { formOpen = true; formErr = ''; render(); }
    else if (act === 'retry') { toggle(false); fetchStatus(); }
  }

  window.addEventListener(EVT, function (e) { if (e.detail && e.detail.source !== 'chip') render(); });

  window.PocketSleeper = {
    status: function () { return statusPromise || fetchStatus(); },
    refresh: fetchStatus,
    connect: connect,
    disconnect: disconnect,
    user: getUser,
    league: getLeague,
    setLeague: function (k) { setLeague(k); },
    openConnect: function () { if (!mount()) return; formOpen = true; formErr = ''; toggle(true); render(); },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mount(); window.PocketSleeper.status(); });
  else { mount(); window.PocketSleeper.status(); }
})();
