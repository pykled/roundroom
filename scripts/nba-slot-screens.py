#!/usr/bin/env python3
"""Draft-slot picker ("Which pick are you?") screenshots + browser checks on /nba
at 375x812 and 1280x800, manual (not Yahoo-synced) board.

  DATABASE_URL= PORT=4791 node --env-file=.env.local server.js &
  BASE=http://127.0.0.1:4791 PHASE=after python3 scripts/nba-slot-screens.py

PHASE=before only screenshots (the control doesn't exist yet). PHASE=after also
checks: chips 1..N, tap targets >= 44px, no horizontal scroll, tapping a slot
updates the status/clock, the choice survives a reload, Change reopens it.
Saves docs/nba-slot/{PHASE}-{375,1280}*.png. Exit 1 on any problem.
"""
import os, sys
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
print('problems:', len(problems))
sys.exit(1 if problems else 0)
