#!/usr/bin/env python3
"""Yahoo league picker + Yahoo error states on /nba, against the mock server,
at 375x812 and 1280x800.

  node scripts/nba-ui-mock.js --port=4792 &
  BASE=http://127.0.0.1:4792 python3 scripts/nba-league-screens.py

Scenarios (switched with POST /__mock/mode?yahoo=…&leagues=…):
  one       single league: auto-selected, no picker, slot synced from Yahoo
  multi     three leagues (12t points, 10t points, 12t categories): picker shows,
            slot chips hidden until a league is chosen; choosing the 10-team
            league syncs "#4 of 10"; the choice survives a reload; the
            categories league shows the "recommendations off" notice
  zero      no NBA leagues: notice + Reconnect, manual board still works
  upstream  /status 502 yahoo_upstream: "isn't responding" + Try again, which
            recovers once Yahoo is back; the chip never says "HTTP 502"
  blocked   /status 503 yahoo_app_blocked: "Yahoo sync is unavailable"
  expired   reauth: "sign-in expired" + Reconnect
Also: tap targets >= 44px and no horizontal scroll at 375.
Saves docs/nba-league/{scenario}-{375,1280}.png. Exit 1 on any problem.
"""
import os, sys, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:4792')
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'nba-league')
os.makedirs(OUT, exist_ok=True)
problems = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail else ''))
    if not ok:
        problems.append(name)


def mock(**q):
    qs = '&'.join(f'{k}={v}' for k, v in q.items())
    urllib.request.urlopen(urllib.request.Request(f'{BASE}/__mock/mode?reset=1&{qs}', method='POST')).read()


def fresh(page, pref=None):
    page.goto(BASE + '/nba')
    page.evaluate("""(pref) => { localStorage.clear(); localStorage.setItem('pocket-nba-firstrun-done', '1');
      if (pref !== null) localStorage.setItem('pocket-nba-league', pref); }""", pref)
    page.reload()
    page.wait_for_selector('#nd-list .nd-row, #nd-list [role=listitem]', timeout=20000)
    page.wait_for_timeout(700)


def visible(page, sel):
    return page.locator(sel).first.is_visible() if page.locator(sel).count() else False


def text(page, sel):
    return page.locator(sel).first.inner_text() if page.locator(sel).count() else ''


def no_hscroll(page, tag):
    w = page.evaluate('() => document.documentElement.scrollWidth - document.documentElement.clientWidth')
    check(f'{tag}: no horizontal scroll', w <= 1, f'overflow {w}px')


def taps(page, sel, tag):
    small = page.evaluate("""(sel) => Array.from(document.querySelectorAll(sel)).filter(e => e.offsetParent)
      .map(e => e.getBoundingClientRect()).filter(r => r.height < 44 || r.width < 44).length""", sel)
    check(f'{tag}: tap targets >= 44px ({sel})', small == 0, f'{small} too small')


def switch_league(page, key):
    # Phones: "Leagues" in the status line reopens the picker (select + nav chip are desktop-only).
    page.locator('#nd-league-switch').click()
    page.wait_for_timeout(200)
    page.locator(f'#nd-leaguepick [data-league="{key}"]').click()


def shot(page, name, w):
    page.screenshot(path=os.path.join(OUT, f'{name}-{w}.png'), full_page=False)


def run(page, w):
    t = f'{w}'
    # --- one league: auto-select
    mock(yahoo='on', leagues='one')
    fresh(page)
    check(f'{t} one: no league picker', not visible(page, '#nd-leaguepick'))
    check(f'{t} one: league auto-selected + remembered', page.evaluate("() => localStorage.getItem('pocket-nba-league')") == '466.l.242808')
    check(f'{t} one: slot synced from Yahoo (#5 of 12)', '#5' in text(page, '#nd-slotpick') and '12' in text(page, '#nd-slotpick'), text(page, '#nd-slotpick'))
    shot(page, 'one', w)

    # --- multi: picker
    mock(yahoo='on', leagues='multi')
    fresh(page)
    check(f'{t} multi: picker visible', visible(page, '#nd-leaguepick[data-mode=pick]'))
    opts = page.locator('#nd-leaguepick .nd-leaguepick__opt')
    check(f'{t} multi: 3 leagues + manual', opts.count() == 4, str(opts.count()))
    body = text(page, '#nd-leaguepick')
    check(f'{t} multi: shows team count + draft status', '10 teams' in body and 'Draft not started' in body and 'Drafted' in body, body.replace('\n', ' | '))
    check(f'{t} multi: categories league flagged', 'tracker only' in body)
    check(f'{t} multi: slot chips hidden until a league is chosen', not visible(page, '#nd-slotpick'))
    check(f'{t} multi: nothing saved before choosing', page.evaluate("() => localStorage.getItem('pocket-nba-league')") is None)
    taps(page, '#nd-leaguepick .nd-leaguepick__opt', f'{t} multi')
    if w == 375:
        no_hscroll(page, f'{t} multi')
    shot(page, 'multi-picker', w)
    page.locator('#nd-leaguepick [data-league="466.l.55555"]').click()
    page.wait_for_timeout(900)
    check(f'{t} multi: picker gone after choosing', not visible(page, '#nd-leaguepick'))
    sp = text(page, '#nd-slotpick')
    check(f'{t} multi: 10-team league slot synced (#4 of 10)', '#4' in sp and '10' in sp, sp)
    check(f'{t} multi: status line uses 10 teams', 'of 10' in text(page, '#nd-sub'), text(page, '#nd-sub'))
    shot(page, 'multi-chosen', w)
    page.reload(); page.wait_for_selector('#nd-list .nd-row, #nd-list [role=listitem]', timeout=20000); page.wait_for_timeout(900)
    check(f'{t} multi: choice remembered after reload', not visible(page, '#nd-leaguepick') and page.locator('#nd-league').input_value() == '466.l.55555' and '#4' in text(page, '#nd-slotpick'))
    check(f'{t} multi: Leagues switch visible', visible(page, '#nd-league-switch'))
    clip = page.evaluate("""() => { const s = document.getElementById('nd-status').getBoundingClientRect();
      return ['nd-league-switch', 'nd-slot-edit'].filter(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.right > s.right + 1 || r.width < 20; }); }""")
    check(f'{t} multi: Leagues + Edit not clipped in the status line', not clip, ','.join(clip))
    switch_league(page, '466.l.67890')
    page.wait_for_timeout(900)
    lp = text(page, '#nd-leaguepick')
    check(f'{t} multi: categories league -> recommendations off notice', 'Recommendations are off' in lp, lp[:120])
    check(f'{t} multi: categories league -> reco card hidden', not visible(page, '#nd-reco'))
    shot(page, 'multi-categories', w)
    switch_league(page, '466.l.242808')
    page.wait_for_timeout(900)
    check(f'{t} multi: points league -> notice gone', not visible(page, '#nd-leaguepick'))

    # --- zero leagues
    mock(yahoo='on', leagues='zero')
    fresh(page)
    lp = text(page, '#nd-leaguepick')
    check(f'{t} zero: no-leagues notice', 'No NBA leagues' in lp, lp[:120])
    check(f'{t} zero: reconnect offered', page.locator('#nd-leaguepick a[href="/nba/auth/login"]').count() == 1)
    check(f'{t} zero: manual slot picker still works', visible(page, '#nd-slotpick'))
    shot(page, 'zero', w)

    # --- upstream 5xx, then recovery
    mock(yahoo='upstream', leagues='one')
    fresh(page)
    lp = text(page, '#nd-leaguepick')
    check(f'{t} upstream: specific message', 'isn’t responding' in lp, lp[:120])
    if visible(page, '#nba-yahoo-chip .nyc-btn'):  # nav chip is desktop-only
        page.locator('#nba-yahoo-chip .nyc-btn').click()
    chip = page.evaluate("() => (document.getElementById('nba-yahoo-chip') || {}).textContent || ''")
    check(f'{t} upstream: chip has no bare HTTP code', 'HTTP 502' not in chip and 'HTTP' not in chip, chip.replace('\n', ' | '))
    shot(page, 'upstream', w)
    page.keyboard.press('Escape')
    mock(yahoo='on', leagues='one')
    page.locator('#nd-leaguepick [data-act=yahoo-retry]').click()
    page.wait_for_timeout(1200)
    check(f'{t} upstream: Try again recovers', not visible(page, '#nd-leaguepick') and '#5' in text(page, '#nd-slotpick'), text(page, '#nd-slotpick'))

    # --- app blocked (the 2026-10-14 production state)
    mock(yahoo='blocked', leagues='one')
    fresh(page)
    lp = text(page, '#nd-leaguepick')
    check(f'{t} blocked: explains Yahoo approval', 'Yahoo sync is unavailable' in lp and 'approved' in lp, lp[:160])
    chip = page.evaluate("() => (document.getElementById('nba-yahoo-chip') || {}).textContent || ''")
    check(f'{t} blocked: chip label', 'Yahoo sync off' in chip, chip[:120])
    check(f'{t} blocked: manual slot picker works', visible(page, '#nd-slotpick'))
    shot(page, 'blocked', w)

    # --- expired token
    mock(yahoo='expired', leagues='one')
    fresh(page)
    lp = text(page, '#nd-leaguepick')
    check(f'{t} expired: reconnect prompt', 'sign-in expired' in lp and page.locator('#nd-leaguepick a[href="/nba/auth/login"]').count() == 1, lp[:120])
    shot(page, 'expired', w)


with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h in ((375, 812), (1280, 800)):
        ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w == 375 else 1, has_touch=w == 375)
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        run(page, w)
        check(f'{w}: no page errors', not errs, '; '.join(errs)[:300])
        ctx.close()
    b.close()

print(f'\n{len(problems)} problem(s)')
sys.exit(1 if problems else 0)
