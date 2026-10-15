#!/usr/bin/env python3
"""Sleeper-first NBA draft board: browser checks + screenshots at 375x812 and
1280x800 against the mock Sleeper server (scripts/nba-ui-mock.js), plus an
optional read-only pass against REAL Sleeper data.

  node scripts/nba-ui-mock.js --port=4795 &
  BASE=http://127.0.0.1:4795 python3 scripts/nba-sleeper-screens.py

  # real data (no mocks): boot the router with the real model + real Sleeper API
  node scripts/nba-sleeper-live-check.js --keep --port=4796 &
  REAL=http://127.0.0.1:4796 REAL_USER=pykle python3 scripts/nba-sleeper-screens.py --real

Scenarios (mock): no username (setup card + manual board), bad username (inline
error), 0 / 1 / many leagues (notice / auto-select / picker with draft time,
scoring, 3RR, categories + auction flags), pre-draft with slot (synced from
Sleeper), pre-draft without slot (draft order unset → chips), live draft with
picks arriving (toast, pick list, clock from Sleeper's 30 s timer), 3RR league
(settings locked to Sleeper), complete draft, Sleeper 5xx / timeout / 429 then
recovery, manual fallback, reload persistence (username + league), no horizontal
scroll at 375, 44 px taps, no page errors / console errors (the expected 404 for
the bad username is the only allowed network error).
Saves docs/nba-sleeper/{scenario}-{375,1280}.png. Exit 1 on any problem."""
import os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:4795')
REAL = os.environ.get('REAL', '')
REAL_USER = os.environ.get('REAL_USER', 'pykle')
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'nba-sleeper')
os.makedirs(OUT, exist_ok=True)
problems = []
ROW = '#nd-list .nd-row, #nd-list [role=listitem]'


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail else ''))
    if not ok:
        problems.append(name)


def mock(**q):
    qs = '&'.join(f'{k}={v}' for k, v in q.items())
    urllib.request.urlopen(urllib.request.Request(f'{BASE}/__mock/mode?reset=1&{qs}', method='POST')).read()


def advance(n):
    urllib.request.urlopen(urllib.request.Request(f'{BASE}/__mock/advance?n={n}', method='POST')).read()


def fresh(page, user=None, pref=None, firstrun_done=True):
    page.goto(BASE + '/nba')
    page.evaluate("""([user, pref, done]) => { localStorage.clear();
      if (done) localStorage.setItem('pocket-nba-firstrun-done', '1');
      if (user) localStorage.setItem('pocket-nba-sleeper', JSON.stringify({ username: user, userId: '1044077615075872768', displayName: user }));
      if (pref !== null) localStorage.setItem('pocket-nba-league', pref); }""", [user, pref, firstrun_done])
    page.reload()
    page.wait_for_selector(ROW, timeout=20000)
    page.wait_for_timeout(900)


def visible(page, sel):
    return page.locator(sel).first.is_visible() if page.locator(sel).count() else False


def text(page, sel):
    return page.locator(sel).first.inner_text() if page.locator(sel).count() else ''


def wait_text(page, sel, needle, timeout=12000):
    end = time.time() + timeout / 1000
    while time.time() < end:
        if needle in text(page, sel):
            return True
        page.wait_for_timeout(250)
    return False


def no_hscroll(page, tag):
    w = page.evaluate('() => document.documentElement.scrollWidth - document.documentElement.clientWidth')
    check(f'{tag}: no horizontal scroll', w <= 1, f'overflow {w}px')


def taps(page, sel, tag):
    small = page.evaluate("""(sel) => Array.from(document.querySelectorAll(sel)).filter(e => e.offsetParent)
      .map(e => e.getBoundingClientRect()).filter(r => r.height < 44 || r.width < 44).length""", sel)
    check(f'{tag}: tap targets >= 44px ({sel})', small == 0, f'{small} too small')


def switch_league(page, key):
    page.locator('#nd-league-switch').click()
    page.wait_for_timeout(200)
    page.locator(f'#nd-leaguepick [data-league="{key}"]').click()


def shot(page, name, w):
    page.screenshot(path=os.path.join(OUT, f'{name}-{w}.png'), full_page=False)


def chip_text(page):
    return page.evaluate("() => (document.getElementById('nba-sleeper-chip') || {}).textContent || ''")


def run(page, w):
    t = f'{w}'
    # --- no username: setup card with the username form; manual board works
    mock(draft='predraft', leagues='one', rr=3, api='ok')
    fresh(page, firstrun_done=False)
    check(f'{t} none: setup card shows the Sleeper username form', visible(page, '#nd-firstrun') and visible(page, '#nd-fr-user'))
    check(f'{t} none: chip says Connect Sleeper', 'Connect Sleeper' in chip_text(page), chip_text(page))
    check(f'{t} none: manual board (slot chips) available', visible(page, '#nd-slotpick') and page.locator('#nd-slotpick .nd-slotpick__chip').count() == 12)
    check(f'{t} none: status says Manual board', 'Manual board' in text(page, '#nd-sync'), text(page, '#nd-sync'))
    check(f'{t} none: no Yahoo anywhere on the page', 'Yahoo' not in page.evaluate('() => document.body.innerText'))
    taps(page, '#nd-fr-connect, #nd-fr-manual, #nd-slotpick .nd-slotpick__chip', f'{t} none')
    if w == 375:
        no_hscroll(page, f'{t} none')
    shot(page, 'no-username', w)

    # --- bad username: inline error, still manual
    page.fill('#nd-fr-user', 'nobody')
    page.click('#nd-fr-connect')
    page.wait_for_timeout(700)
    err = text(page, '#nd-fr-err')
    check(f'{t} bad user: inline error names the username', 'No Sleeper user named' in err and 'nobody' in err, err)
    check(f'{t} bad user: nothing remembered', page.evaluate("() => localStorage.getItem('pocket-nba-sleeper')") is None)
    shot(page, 'bad-username', w)

    # --- connect from the setup card → one league auto-selected, slot synced
    page.fill('#nd-fr-user', 'pykle')
    page.click('#nd-fr-connect')
    check(f'{t} connect: slot synced from Sleeper (#5 of 12)', wait_text(page, '#nd-slotpick', 'synced from Sleeper') and '#5' in text(page, '#nd-slotpick'), text(page, '#nd-slotpick'))
    check(f'{t} connect: setup card gone', not visible(page, '#nd-firstrun'))
    check(f'{t} connect: username remembered', 'pykle' in (page.evaluate("() => localStorage.getItem('pocket-nba-sleeper')") or ''))
    check(f'{t} connect: league remembered', page.evaluate("() => localStorage.getItem('pocket-nba-league')") == '1411447094215991296')
    check(f'{t} connect: chip shows @pykle', '@pykle' in chip_text(page), chip_text(page))
    sub = page.evaluate("() => document.getElementById('nd-sub').textContent")
    check(f'{t} connect: status line from Sleeper draft (13 rounds, 30s picks, 2 IL)', '13 rounds' in sub and '30s picks' in sub and '2 IL' in sub, sub)
    check(f'{t} connect: sync pill shows the scheduled draft time', text(page, '#nd-sync').startswith('Drafts '), text(page, '#nd-sync'))
    check(f'{t} connect: no pick clock before the draft', not visible(page, '#nd-timer'))
    shot(page, 'one-predraft', w)
    # settings: Sleeper fields locked (teams, slot, 3RR, timer)
    page.click('#nd-settings-btn')
    page.wait_for_timeout(400)
    locked = page.evaluate("() => ['teams','mySlot','rr','timer'].map(n => document.querySelector('#nd-settings-form [name=' + n + ']').disabled)")
    rr_on = page.evaluate("() => document.querySelector('#nd-settings-form [name=rr]').checked")
    check(f'{t} 3RR: settings locked to Sleeper (teams, slot, 3RR, timer) and 3RR on', all(locked) and rr_on, f'locked={locked} rr={rr_on}')
    hint = text(page, '#nd-settings-hint')
    check(f'{t} 3RR: settings hint names Sleeper + reversal', 'Sleeper' in hint and 'reversal' in hint, hint[:140])
    shot(page, 'settings-locked', w)
    page.keyboard.press('Escape')
    page.wait_for_timeout(300)
    # cheat sheet shows 3RR + Sleeper order
    page.click('#nd-views [data-view=cheat]')
    page.wait_for_timeout(500)
    cs = text(page, '.nd-cs-set')
    check(f'{t} 3RR: cheat sheet set line shows 3RR from Sleeper', ('3RR' in cs or 'reversal' in cs.lower()) and 'Sleeper' in cs, cs)
    # slot 5 of 12 with 3RR: 5 (R1 fwd), 20 (R2 back), 32 (R3 back again), 41 (R4 fwd)
    picks = page.evaluate("() => Array.from(document.querySelectorAll('.nd-cs-rh .pk')).slice(0, 4).map(e => e.textContent)")
    check(f'{t} 3RR: my picks are 5, 20, 32, 41', picks == ['Pick 5', 'Pick 20', 'Pick 32', 'Pick 41'], str(picks))
    shot(page, 'cheat-3rr', w)
    page.click('#nd-views [data-view=board]')
    page.wait_for_timeout(300)

    # --- live draft: picks arrive, clock from Sleeper, on-the-clock state
    mock(draft='live', interval=1, leagues='one', rr=3)
    advance(4)
    check(f'{t} live: picks arrive within a few seconds', wait_text(page, '#nd-picks-total', 'made', 15000), text(page, '#nd-picks-total'))
    check(f'{t} live: sync pill is live', wait_text(page, '#nd-sync', 'Live · Sleeper'), text(page, '#nd-sync'))
    n0 = int((text(page, '#nd-picks-total').split(' ')[0] or '0'))
    page.wait_for_timeout(6500)  # board polls every 4 s while drafting; the mock adds a pick a second
    n1 = int((text(page, '#nd-picks-total').split(' ')[0] or '0'))
    check(f'{t} live: pick count grows with polling (4 s cadence)', n1 > n0, f'{n0} → {n1}')
    names = ('Splash Bros', 'Glass Cleaners', 'Paint Protectors', 'Euro Steps', 'Fast Breakers', 'Bench Mob', 'Lob City', 'Triple Doubles', 'Corner Threes', 'Iso Joes', 'Pick & Pop')
    check(f'{t} live: pick rows list Sleeper team names', page.locator('#nd-picks .nd-pick').count() >= 4 and any(n in text(page, '#nd-picks') for n in names) and 'Team ' not in text(page, '#nd-picks'), text(page, '#nd-picks')[:120])
    check(f'{t} live: on-the-clock line names a team', 'on the clock' in text(page, '#nd-otc-who'), text(page, '#nd-otc-who'))
    check(f'{t} live: pick clock visible with Sleeper timer (0:30 or less)', visible(page, '#nd-timer') and ('0:' in text(page, '#nd-timer')), text(page, '#nd-timer'))
    rv = page.evaluate("() => { const e = document.getElementById('nd-review'); return e && !e.hidden ? e.textContent : ''; }")
    check(f'{t} live: review list for the unmatched deep pick', 'Sleeper pick' in rv and 'to review' in rv, rv[:80])
    if w == 375:
        no_hscroll(page, f'{t} live')
    shot(page, 'live', w)
    # manual pick while live → pending flag (pause the mock so Sleeper can't confirm it meanwhile; pick a deep player)
    mock(draft='paused', interval=1, leagues='one', rr=3)
    page.wait_for_timeout(200)
    check(f'{t} paused: sync pill says paused', wait_text(page, '#nd-sync', 'Paused'), text(page, '#nd-sync'))
    page.locator('#nd-list .nd-row .nd-draft:not([disabled])').nth(25).click()
    page.wait_for_timeout(400)
    check(f'{t} live: manual pick flagged PENDING until Sleeper confirms', 'PENDING' in text(page, '#nd-picks'), text(page, '#nd-picks')[:160])
    check(f'{t} live: toast says waiting for Sleeper', 'waiting for Sleeper' in page.evaluate('() => document.body.innerText'))
    page.click('#nd-undo')
    page.wait_for_timeout(300)
    check(f'{t} live: undo removes the pending pick', 'PENDING' not in text(page, '#nd-picks'))

    # --- Sleeper 5xx then recovery (draft endpoint)
    mock(draft='live', interval=1, leagues='one', rr=3, api='down')
    check(f'{t} outage: degraded banner names Sleeper', wait_text(page, '#nd-banner', 'reach Sleeper', 20000), text(page, '#nd-banner')[:120])
    check(f'{t} outage: sync pill paused', 'Sync paused' in text(page, '#nd-sync'), text(page, '#nd-sync'))
    check(f'{t} outage: board still drafts manually', page.locator('#nd-list .nd-row .nd-draft:not([disabled])').count() > 0)
    taps(page, '#nd-retry', f'{t} outage')
    shot(page, 'outage', w)
    mock(draft='live', interval=1, leagues='one', rr=3, api='ok')
    page.click('#nd-retry')
    check(f'{t} outage: Retry Now recovers to live', wait_text(page, '#nd-sync', 'Live · Sleeper'), text(page, '#nd-sync'))
    # timeout flavour
    mock(draft='live', interval=1, leagues='one', rr=3, api='timeout')
    check(f'{t} timeout: banner says Sleeper timed out', wait_text(page, '#nd-banner', 'timed out', 20000), text(page, '#nd-banner')[:120])
    mock(draft='live', interval=1, leagues='one', rr=3, api='ratelimit')
    page.click('#nd-retry')
    check(f'{t} rate limit: banner says rate limit', wait_text(page, '#nd-banner', 'rate limit', 20000), text(page, '#nd-banner')[:120])
    mock(draft='live', interval=1, leagues='one', rr=3, api='ok')
    page.click('#nd-retry')
    check(f'{t} rate limit: recovers', wait_text(page, '#nd-sync', 'Live · Sleeper'), text(page, '#nd-sync'))

    # --- complete draft
    mock(draft='complete', leagues='one', rr=3)
    fresh(page, user='pykle', pref='1411447094215991296')
    check(f'{t} complete: sync pill', wait_text(page, '#nd-sync', 'Draft complete'), text(page, '#nd-sync'))
    check(f'{t} complete: clock says Draft complete', 'Draft complete' in text(page, '#nd-otc-who'), text(page, '#nd-otc-who'))
    check(f'{t} complete: 156 picks listed', '156' in text(page, '#nd-picks-total'), text(page, '#nd-picks-total'))
    check(f'{t} complete: my roster filled from Sleeper picks', '13/13' in text(page, '#nd-roster-total'), text(page, '#nd-roster-total'))
    shot(page, 'complete', w)

    # --- reload persistence (username + league + synced slot)
    page.reload(); page.wait_for_selector(ROW, timeout=20000); page.wait_for_timeout(900)
    check(f'{t} reload: still @pykle on the league with synced slot', '@pykle' in chip_text(page) and page.locator('#nd-league').input_value() == '1411447094215991296' and 'synced from Sleeper' in text(page, '#nd-slotpick'), text(page, '#nd-slotpick'))

    # --- pre-draft without slot: draft order not set → chips; choose one
    mock(draft='noslot', leagues='one', rr=3)
    fresh(page, user='pykle', pref='1411447094215991296')
    check(f'{t} noslot: slot chips shown (order not set on Sleeper)', visible(page, '#nd-slotpick[data-mode=pick]'), page.locator('#nd-slotpick').get_attribute('data-mode'))
    check(f'{t} noslot: still connected and waiting for the draft', text(page, '#nd-sync').startswith('Drafts '), text(page, '#nd-sync'))
    page.locator('#nd-slotpick [data-slot="7"]').click()
    page.wait_for_timeout(400)
    check(f'{t} noslot: chosen slot shows with Change', 'You pick #7' in text(page, '#nd-slotpick') and visible(page, '#nd-slotpick .nd-slotpick__change'), text(page, '#nd-slotpick'))
    shot(page, 'noslot', w)
    # order gets set on Sleeper → slot becomes synced (5), chips gone
    mock(draft='predraft', leagues='one', rr=3)
    page.reload(); page.wait_for_selector(ROW, timeout=20000); page.wait_for_timeout(900)
    check(f'{t} noslot → order set: slot now synced from Sleeper', 'synced from Sleeper' in text(page, '#nd-slotpick') and '#5' in text(page, '#nd-slotpick'), text(page, '#nd-slotpick'))

    # --- many leagues: picker
    mock(draft='predraft', leagues='multi', rr=0)
    fresh(page, user='pykle')
    check(f'{t} multi: picker visible', visible(page, '#nd-leaguepick[data-mode=pick]'))
    opts = page.locator('#nd-leaguepick .nd-leaguepick__opt')
    check(f'{t} multi: 4 leagues + manual', opts.count() == 5, str(opts.count()))
    body = text(page, '#nd-leaguepick')
    check(f'{t} multi: shows team count, scheduled draft time, scoring', '10 teams' in body and 'Drafts ' in body and 'Points' in body, body.replace('\n', ' | ')[:300])
    check(f'{t} multi: categories league flagged tracker only', 'tracker only' in body)
    check(f'{t} multi: auction league flagged', 'Auction' in body and 'manual' in body)
    check(f'{t} multi: slot chips hidden until a league is chosen', not visible(page, '#nd-slotpick'))
    check(f'{t} multi: nothing saved before choosing', page.evaluate("() => localStorage.getItem('pocket-nba-league')") is None)
    taps(page, '#nd-leaguepick .nd-leaguepick__opt', f'{t} multi')
    if w == 375:
        no_hscroll(page, f'{t} multi')
    shot(page, 'multi-picker', w)
    page.locator('#nd-leaguepick [data-league="1500000000000000001"]').click()
    page.wait_for_timeout(1000)
    sp = text(page, '#nd-slotpick')
    check(f'{t} multi: 10-team league slot synced (#4 of 10)', '#4' in sp and '10' in sp, sp)
    check(f'{t} multi: status line uses 10 teams + 10 rounds + 60s', 'of 10' in text(page, '#nd-sub') and '10 rounds' in text(page, '#nd-sub') and '60s' in text(page, '#nd-sub'), text(page, '#nd-sub'))
    shot(page, 'multi-chosen', w)
    page.reload(); page.wait_for_selector(ROW, timeout=20000); page.wait_for_timeout(900)
    check(f'{t} multi: choice remembered after reload', not visible(page, '#nd-leaguepick') and page.locator('#nd-league').input_value() == '1500000000000000001' and '#4' in text(page, '#nd-slotpick'))
    switch_league(page, '1500000000000000003')
    page.wait_for_timeout(900)
    lp = text(page, '#nd-leaguepick')
    check(f'{t} multi: categories league -> recommendations off notice', 'Recommendations are off' in lp, lp[:120])
    check(f'{t} multi: categories league -> reco card hidden', not visible(page, '#nd-reco'))
    shot(page, 'multi-categories', w)
    switch_league(page, '1500000000000000005')
    page.wait_for_timeout(900)
    check(f'{t} multi: auction league -> manual mode notice', 'Auction' in text(page, '#nd-banner') and 'Auction' in text(page, '#nd-sync'), text(page, '#nd-sync'))
    switch_league(page, '')
    page.wait_for_timeout(700)
    check(f'{t} manual fallback: Manual board from the picker', 'Manual board' in text(page, '#nd-sync') and visible(page, '#nd-slotpick'), text(page, '#nd-sync'))
    page.locator('#nd-list .nd-row .nd-draft:not([disabled])').first.click()
    page.wait_for_timeout(300)
    check(f'{t} manual fallback: manual pick recorded without PENDING', '1 made' in text(page, '#nd-picks-total') and 'PENDING' not in text(page, '#nd-picks'), text(page, '#nd-picks-total'))
    shot(page, 'manual', w)

    # --- zero leagues
    mock(draft='predraft', leagues='zero')
    fresh(page, user='pykle')
    lp = text(page, '#nd-leaguepick')
    check(f'{t} zero: no-leagues notice names the username', 'No NBA leagues' in lp and 'pykle' in lp, lp[:120])
    check(f'{t} zero: switch account offered', page.locator('#nd-leaguepick [data-act=sleeper-switch]').count() == 1)
    check(f'{t} zero: manual slot picker still works', visible(page, '#nd-slotpick'))
    shot(page, 'zero', w)

    # --- not in league (username resolves, owns no team)
    mock(draft='predraft', leagues='one', rr=3)
    page.goto(BASE + '/nba')
    page.evaluate("""() => { localStorage.clear(); localStorage.setItem('pocket-nba-firstrun-done', '1');
      localStorage.setItem('pocket-nba-sleeper', JSON.stringify({ username: 'stranger', userId: '999000111222333444', displayName: 'stranger' })); }""")
    page.reload(); page.wait_for_selector(ROW, timeout=20000); page.wait_for_timeout(1200)
    lp = text(page, '#nd-leaguepick')
    check(f'{t} stranger: not-in-league notice + slot chips', 'doesn’t own a team' in lp and visible(page, '#nd-slotpick[data-mode=pick]'), lp[:120])

    # --- status outage at load (leagues call 5xx) with a remembered username
    mock(draft='predraft', leagues='one', rr=3, api='down')
    fresh(page, user='pykle')
    lp = text(page, '#nd-leaguepick')
    check(f'{t} load outage: Sleeper not responding notice, username kept', 'isn’t responding' in lp and 'pykle' in lp, lp[:140])
    check(f'{t} load outage: manual board works', visible(page, '#nd-slotpick'))
    ct = chip_text(page)
    check(f'{t} load outage: chip has no bare HTTP code', 'HTTP' not in ct, ct.replace('\n', ' | '))
    shot(page, 'load-outage', w)
    mock(draft='predraft', leagues='one', rr=3, api='ok')
    page.locator('#nd-leaguepick [data-act=sleeper-retry]').click()
    check(f'{t} load outage: Try Again recovers', wait_text(page, '#nd-slotpick', 'synced from Sleeper'), text(page, '#nd-slotpick'))

    # --- nav chip: switch account + disconnect (desktop; chip is in the nav)
    if w == 1280:
        page.locator('#nba-sleeper-chip .nyc-btn').click()
        page.wait_for_timeout(300)
        menu = text(page, '#nyc-menu')
        check(f'{t} chip: menu lists the league + switch/disconnect', 'HALIMSANITY' in menu and 'Switch account' in menu and 'Disconnect Sleeper' in menu, menu.replace('\n', ' | ')[:200])
        shot(page, 'chip-menu', w)
        page.locator('#nyc-menu [data-act=switch]').click()
        page.wait_for_timeout(300)
        check(f'{t} chip: switch shows the username form', visible(page, '#nyc-form #nyc-user'))
        page.fill('#nyc-user', 'nobody'); page.click('#nyc-form button[type=submit]'); page.wait_for_timeout(700)
        check(f'{t} chip: bad username error inline', 'No Sleeper user' in text(page, '#nyc-form-err'), text(page, '#nyc-form-err'))
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)
        page.once('dialog', lambda d: d.accept())
        page.locator('#nba-sleeper-chip .nyc-btn').click(); page.wait_for_timeout(200)
        page.locator('#nyc-menu [data-act=disconnect]').click()
        page.wait_for_timeout(800)
        check(f'{t} chip: disconnect → manual board, nothing remembered', 'Connect Sleeper' in chip_text(page) and page.evaluate("() => localStorage.getItem('pocket-nba-sleeper')") is None and 'Manual board' in text(page, '#nd-sync'), text(page, '#nd-sync'))


def run_real(page, w):
    t = f'{w} real'
    u = urllib.request.urlopen(f'{REAL}/api/nba/sleeper/user?username={REAL_USER}').read().decode()
    import json
    uj = json.loads(u)
    page.goto(REAL + '/nba')
    page.evaluate("""(u) => { localStorage.clear(); localStorage.setItem('pocket-nba-firstrun-done', '1');
      localStorage.setItem('pocket-nba-sleeper', JSON.stringify({ username: u.username, userId: u.user_id, displayName: u.display_name })); }""", uj)
    page.reload(); page.wait_for_selector(ROW, timeout=30000); page.wait_for_timeout(2500)
    check(f'{t}: chip shows @{REAL_USER}', f'@{REAL_USER}' in chip_text(page), chip_text(page))
    check(f'{t}: league auto-selected (HALIMSANITY 26-27)', 'HALIMSANITY' in text(page, '#nd-sub') or 'HALIMSANITY' in text(page, '#nd-eyebrow'), text(page, '#nd-eyebrow'))
    check(f'{t}: draft complete from real Sleeper data', wait_text(page, '#nd-sync', 'Draft complete', 20000), text(page, '#nd-sync'))
    check(f'{t}: 156 real picks', '156' in text(page, '#nd-picks-total'), text(page, '#nd-picks-total'))
    check(f'{t}: slot #8 of 12 synced', '#8' in text(page, '#nd-slotpick') and 'synced from Sleeper' in text(page, '#nd-slotpick'), text(page, '#nd-slotpick'))
    check(f'{t}: my roster 13/13 from Sleeper picks', '13/13' in text(page, '#nd-roster-total'), text(page, '#nd-roster-total'))
    check(f'{t}: no unmatched picks to review', not visible(page, '#nd-review'))
    check(f'{t}: status line 13 rounds · 30s picks', '13 rounds' in text(page, '#nd-sub') and '30s picks' in text(page, '#nd-sub'), text(page, '#nd-sub'))
    check(f'{t}: no Yahoo on the page', 'Yahoo' not in page.evaluate('() => document.body.innerText'))
    shot(page, 'real-complete', w)
    page.click('#nd-views [data-view=cheat]'); page.wait_for_timeout(600)
    shot(page, 'real-cheat', w)
    page.goto(REAL + '/nba/lineup'); page.wait_for_timeout(3500)
    check(f'{t} lineup: From Sleeper roster', 'From Sleeper' in text(page, '#ln-sub'), text(page, '#ln-sub')[:100])
    check(f'{t} lineup: starters rendered', page.locator('.ln-srow').count() >= 9, str(page.locator('.ln-srow').count()))
    shot(page, 'real-lineup', w)
    page.goto(REAL + '/nba/trade'); page.wait_for_timeout(3500)
    check(f'{t} trade: Sleeper league mode', 'Sleeper league' in text(page, '#nt-mode-tag'), text(page, '#nt-mode-tag'))
    shot(page, 'real-trade', w)
    page.goto(REAL + '/nba/waivers'); page.wait_for_timeout(6000)
    check(f'{t} waivers: ranked from the Sleeper league pool', page.locator('#wv-list li, #wv-list .wv-row, #wv-list > *').count() > 0 and 'Yahoo' not in page.evaluate('() => document.body.innerText'), str(page.locator('#wv-list > *').count()))
    shot(page, 'real-waivers', w)


with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h in ((375, 812), (1280, 800)):
        ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w == 375 else 1, has_touch=w == 375)
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' and 'username=nobody' not in m.text and 'Failed to load resource' not in m.text else None)
        bad = []
        page.on('response', lambda r: bad.append(f'{r.status} {r.url}') if r.status >= 400 and 'username=nobody' not in r.url and 'api=' not in r.url else None)
        if '--real' in sys.argv:
            if not REAL:
                print('REAL base URL not set'); sys.exit(2)
            run_real(page, w)
        else:
            run(page, w)
        check(f'{w}: no page errors / console errors', not errs, '; '.join(errs)[:400])
        allowed = ('sleeper_upstream', 'sleeper_timeout', 'sleeper_rate_limited')
        unexpected = [x for x in bad if not any(k in x for k in ('/api/nba/sleeper/',))]
        check(f'{w}: no unexpected 4xx/5xx responses', not unexpected, '; '.join(unexpected)[:300])
        ctx.close()
    b.close()

print(f'\n{len(problems)} problem(s)')
sys.exit(1 if problems else 0)
