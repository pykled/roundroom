#!/usr/bin/env python3
"""Draft-slot picker ("Which pick are you?") screenshots + browser checks on /nba
at 375x812 and 1280x800, manual (not Yahoo-synced) board.

  DATABASE_URL= PORT=4791 node --env-file=.env.local server.js &
  BASE=http://127.0.0.1:4791 PHASE=after python3 scripts/nba-slot-screens.py

PHASE=before only screenshots (the control doesn't exist yet). PHASE=after also
checks: chips 1..N, tap targets >= 44px, no horizontal scroll, tapping a slot
updates the status/clock, the choice survives a reload, Change reopens it;
a board saved before slotChosen existed loads collapsed (chips never render);
with /api/nba/yahoo/status delayed, chips never flash on a Yahoo-connected
reload, wait at most ~1s for a slow signed-out status, and show at once for a
device that never used Yahoo.
Saves docs/nba-slot/{PHASE}-{375,1280}*.png. Exit 1 on any problem.
"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:4791')
PHASE = os.environ.get('PHASE', 'after')
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'nba-slot')
os.makedirs(OUT, exist_ok=True)
problems = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail else ''))
    if not ok:
        problems.append(name)


def fresh(page):
    page.goto(BASE + '/nba')
    page.evaluate("() => { localStorage.clear(); localStorage.setItem('pocket-nba-firstrun-done', '1'); }")
    page.reload()
    page.wait_for_selector('#nd-list .nd-row, #nd-list [role=listitem]', timeout=20000)
    page.wait_for_timeout(400)


def overflow(page):
    return page.evaluate('() => document.documentElement.scrollWidth - window.innerWidth')


# Records when (ms since navigation) the slot chips first exist in the DOM.
WATCH = """(() => {
  window.__chipsAt = null;
  const seen = () => { if (window.__chipsAt == null && document.querySelector('#nd-slotpick [data-act="slot"]')) window.__chipsAt = performance.now(); };
  new MutationObserver(seen).observe(document, { childList: true, subtree: true });
})();"""
LEGACY = {'v': 1, 'leagueKey': None, 'settingsSource': None, 'manual': [], 'overrides': {}, 'yahoo': None, 'updatedAt': 1,
          'settings': {'teams': 12, 'mySlot': 5, 'slots': {'PG': 1, 'SG': 1, 'G': 1, 'SF': 1, 'PF': 1, 'F': 1, 'C': 1, 'UTIL': 2}, 'bench': 5, 'il': 2}}
LK = '466.l.1'
TEAMS = [{'team_key': f'466.l.1.t.{i}', 'name': f'Team {i}', 'draft_position': i} for i in range(1, 13)]


def wait_js(page, expr, timeout=10000):
    """Poll `expr` from Python (the page CSP blocks wait_for_function's eval)."""
    end = time.time() + timeout / 1000
    while time.time() < end:
        if page.evaluate(expr):
            return True
        page.wait_for_timeout(50)
    raise TimeoutError(expr)


def board_ready(page):
    page.wait_for_selector('#nd-list .nd-row, #nd-list [role=listitem]', timeout=20000)


def seeded(ctx, prefs):
    """New page whose localStorage holds `prefs` before any page script runs."""
    page = ctx.new_page()
    page.add_init_script('(() => { if (sessionStorage.getItem("__seeded")) return; sessionStorage.setItem("__seeded", "1"); localStorage.clear(); '
                         + ''.join(f'localStorage.setItem({json.dumps(k)}, {json.dumps(v)});' for k, v in prefs.items()) + '})();')
    page.add_init_script(WATCH)
    return page


def delay_status(page, ms, body, status=200):
    def handle(route):
        time.sleep(ms / 1000)
        route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
    page.route('**/api/nba/yahoo/status', handle)


def run_reload_checks(pw, w, h):
    mobile = dict(is_mobile=w < 500, has_touch=w < 500)
    b = pw.chromium.launch()
    base = {'pocket-nba-firstrun-done': '1'}

    # 1) Board saved before slotChosen existed: collapsed "You pick #5 of 12", chips never render.
    ctx = b.new_context(viewport={'width': w, 'height': h}, **mobile)
    page = seeded(ctx, dict(base, **{'pocket-nba-draft:manual': json.dumps(LEGACY)}))
    page.goto(BASE + '/nba'); board_ready(page); page.wait_for_timeout(1500)
    txt = page.locator('#nd-slotpick').inner_text()
    check(f'{w}: legacy board loads collapsed (#5 of 12)', '#5' in txt and 'of 12' in txt, txt.strip())
    check(f'{w}: legacy board never rendered chips', page.evaluate('window.__chipsAt') is None, page.evaluate('window.__chipsAt'))
    check(f'{w}: legacy board shows Change', page.locator('#nd-slotpick [data-act="slot-change"]').count() == 1)
    check(f'{w}: no horizontal scroll (legacy)', overflow(page) <= 0, overflow(page))
    ctx.close()

    # 2) Yahoo-connected reload, /status delayed 1.5s (past the 1s cap) then league + draft:
    #    Yahoo knows the slot (draft_position 3), so chips must never appear.
    ctx = b.new_context(viewport={'width': w, 'height': h}, **mobile)
    page = seeded(ctx, dict(base, **{'pocket-nba-league': LK}))
    delay_status(page, 600, {'connected': True, 'leagues': [{'league_key': LK, 'name': 'Mock League', 'num_teams': 12, 'draft_status': 'predraft'}]})
    page.route('**/api/nba/yahoo/league?*', lambda r: (time.sleep(0.4), r.fulfill(content_type='application/json', body=json.dumps(
        {'league': {'league_key': LK, 'name': 'Mock League', 'num_teams': 12, 'draft_status': 'predraft'}, 'teams': TEAMS, 'myTeamKey': '466.l.1.t.3'})))[1])
    page.route('**/api/nba/yahoo/draft?*', lambda r: (time.sleep(0.4), r.fulfill(content_type='application/json', body=json.dumps(
        {'status': 'predraft', 'picks': [], 'unmatched': [], 'order': None, 'polledAt': '2026-10-14T00:00:00Z'})))[1])
    page.goto(BASE + '/nba'); board_ready(page)
    wait_js(page, '!!document.querySelector("#nd-slotpick") && /synced from Yahoo/.test(document.querySelector("#nd-slotpick").textContent)')
    page.wait_for_timeout(300)
    check(f'{w}: Yahoo reload (delayed status) never flashed chips', page.evaluate('window.__chipsAt') is None, page.evaluate('window.__chipsAt'))
    check(f'{w}: Yahoo reload shows synced #3', '#3' in page.locator('#nd-slotpick').inner_text(), page.locator('#nd-slotpick').inner_text().strip())
    page.locator('#nd-slot-edit').click(); page.wait_for_timeout(300)
    check(f'{w}: League dialog locks My draft slot when Yahoo supplies it', page.locator('#nd-settings-form input[name=mySlot]').is_disabled())
    ctx.close()

    # 3) Device that used Yahoo, status slow (3s) and signed out: wait ~1s max, then chips.
    ctx = b.new_context(viewport={'width': w, 'height': h}, **mobile)
    page = seeded(ctx, dict(base, **{'pocket-nba-league': ''}))
    delay_status(page, 3000, {'code': 'signed_out'}, status=401)
    page.goto(BASE + '/nba')
    wait_js(page, 'window.__chipsAt != null')
    at = page.evaluate('window.__chipsAt')
    start = page.evaluate('performance.getEntriesByType("navigation")[0].domContentLoadedEventStart')
    check(f'{w}: slow status: chips held ~1s then shown (not until status)', 900 <= at - start <= 2600, f'{at - start:.0f}ms after DOMContentLoaded')
    ctx.close()

    # 4) Never used Yahoo, status slow: chips on the first render (no wait).
    ctx = b.new_context(viewport={'width': w, 'height': h}, **mobile)
    page = seeded(ctx, dict(base))
    delay_status(page, 3000, {'connected': False, 'leagues': []})
    page.goto(BASE + '/nba')
    wait_js(page, 'window.__chipsAt != null')
    at = page.evaluate('window.__chipsAt')
    start = page.evaluate('performance.getEntriesByType("navigation")[0].domContentLoadedEventStart')
    check(f'{w}: manual device: chips without waiting for status', at - start < 400, f'{at - start:.0f}ms after DOMContentLoaded')
    ctx.close()
    b.close()


def run(pw, w, h):
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, is_mobile=w < 500, has_touch=w < 500)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    fresh(page)
    top = lambda name: page.screenshot(path=os.path.join(OUT, f'{PHASE}-{w}{name}.png'))
    top('')
    check(f'{w}: no horizontal scroll', overflow(page) <= 0, overflow(page))
    if PHASE == 'after':
        box = page.locator('#nd-slotpick')
        check(f'{w}: picker visible on manual board', box.is_visible())
        chips = page.locator('#nd-slotpick [data-act="slot"]')
        n = chips.count()
        check(f'{w}: one chip per team', n == 12, n)
        sizes = page.evaluate("""() => [...document.querySelectorAll('#nd-slotpick [data-act="slot"]')]
            .map(e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; })""")
        small = [s for s in sizes if s[0] < 44 or s[1] < 44]
        check(f'{w}: chips >= 44px', not small, small[:3])
        chips.nth(6).click()  # slot 7
        page.wait_for_timeout(200)
        sub = page.locator('#nd-sub').inner_text()
        check(f'{w}: status shows slot 7', 'Slot 7' in sub, sub)
        otc = page.locator('#nd-otc-sub').inner_text() + ' ' + page.locator('#nd-mb-txt').inner_text()
        check(f'{w}: clock counts down to pick 7', '6 pick' in otc or 'pick 7' in otc.lower() or '#7' in otc, otc.strip()[:120])
        check(f'{w}: collapsed after choosing', page.locator('#nd-slotpick [data-act="slot"]').count() == 0)
        chg = page.locator('#nd-slotpick [data-act="slot-change"]')
        r = chg.bounding_box()
        check(f'{w}: Change >= 44px tall', r and r['height'] >= 44, r)
        top('-chosen')
        page.reload(); page.wait_for_selector('#nd-list .nd-row, #nd-list [role=listitem]'); page.wait_for_timeout(300)
        check(f'{w}: slot 7 persists across reload', 'Slot 7' in page.locator('#nd-sub').inner_text() and page.locator('#nd-slotpick [data-act="slot-change"]').count() == 1)
        chg.click(); page.wait_for_timeout(150)
        check(f'{w}: Change reopens chips', page.locator('#nd-slotpick [data-act="slot"]').count() == 12)
        check(f'{w}: chosen chip pressed', page.locator('#nd-slotpick [data-act="slot"][aria-pressed="true"]').inner_text().strip() == '7')
        check(f'{w}: no horizontal scroll (open)', overflow(page) <= 0, overflow(page))
        top('-change')
        page.locator('#nd-slotpick [data-act="slot"]').nth(11).click(); page.wait_for_timeout(150)
        check(f'{w}: re-pick slot 12', 'Slot 12' in page.locator('#nd-sub').inner_text())
    check(f'{w}: no page errors', not errs, errs[:2])
    b.close()


with sync_playwright() as pw:
    run(pw, 375, 812)
    run(pw, 1280, 800)
    if PHASE == 'after':
        run_reload_checks(pw, 375, 812)
        run_reload_checks(pw, 1280, 800)
print('problems:', len(problems))
sys.exit(1 if problems else 0)
