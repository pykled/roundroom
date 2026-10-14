#!/usr/bin/env python3
"""Pick-clock Pause/Resume + Reset menu: browser checks and screenshots on /nba
(manual board) at 375x812 and 1280x800.

  DATABASE_URL= PORT=4791 node --env-file=.env.local server.js &
  BASE=http://127.0.0.1:4791 python3 scripts/nba-clock-screens.py

Checks: pause stops the countdown and shows Paused; reload while paused stays
paused with the same time; a pick recorded while paused moves on and stays
paused (full time); Resume counts down again; a second tab sees pause/resume;
Reset Clock restarts the pick time; Reset Draft shows the pick count, Cancel
keeps the picks, Clear empties the board (slot + settings + other leagues
kept), Undo brings them back; 44px taps; no horizontal scroll; no console
errors. Saves docs/nba-clock/{375,1280}-*.png. Exit 1 on any problem.
"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:4791')
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'nba-clock')
os.makedirs(OUT, exist_ok=True)
problems = []
OTHER_KEY = 'pocket-nba-draft:466.l.1'
OTHER_VAL = json.dumps({'v': 1, 'leagueKey': '466.l.1', 'manual': [{'playerId': '1', 'mine': True, 'at': 1}], 'settings': {'teams': 10, 'mySlot': 2}})
OTHER_CLOCK = 'pocket-nba-clock:466.l.1'
OTHER_CLOCK_VAL = json.dumps({'v': 1, 'leagueKey': '466.l.1', 'pick': 2, 'startedAt': 0, 'pausedLeft': 5000})


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail else ''))
    if not ok:
        problems.append(name)


def wait_js(page, expr, timeout=8000):
    """Poll `expr` from Python (the page CSP blocks wait_for_function's eval)."""
    end = time.time() + timeout / 1000
    while time.time() < end:
        if page.evaluate(expr):
            return True
        page.wait_for_timeout(50)
    return False


def board_ready(page):
    page.wait_for_selector('#nd-list .nd-row', timeout=20000)
    page.wait_for_timeout(300)


def secs(page):
    t = page.inner_text('#nd-timer .t').replace('▶', '').strip()
    m, s = t.split(':')
    return int(m) * 60 + int(s)


def pick_no(page):
    return int(page.inner_text('#nd-pick'))


def overflow(page):
    return page.evaluate('() => document.documentElement.scrollWidth - window.innerWidth')


def tap_ok(page, sel):
    """>= 44px hit area (nu-btn--sm adds a 4px ::after ring around 36px buttons)."""
    b = page.locator(sel).bounding_box()
    ring = 8 if page.evaluate(f'() => document.querySelector({json.dumps(sel)}).classList.contains("nu-btn--sm")') else 0
    return b and b['height'] + ring >= 44 and b['width'] + ring >= 44, b


def draft_first(page):
    page.locator('#nd-list [data-act="draft"]').first.click()
    page.wait_for_timeout(250)


def toast_clear(page):
    page.evaluate('() => document.querySelectorAll(".nu-toast").forEach(t => t.remove())')


def run(browser, w, h):
    tag = str(w)
    ctx = browser.new_context(viewport={'width': w, 'height': h})
    page = ctx.new_page()
    errs = []
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/nba')
    page.evaluate(f"""() => {{ localStorage.clear(); localStorage.setItem('pocket-nba-firstrun-done', '1');
      localStorage.setItem({json.dumps(OTHER_KEY)}, {json.dumps(OTHER_VAL)}); localStorage.setItem({json.dumps(OTHER_CLOCK)}, {json.dumps(OTHER_CLOCK_VAL)}); }}""")
    page.reload(); board_ready(page)
    page.click('#nd-slotpick [data-slot="3"]'); page.wait_for_timeout(200)
    toast_clear(page)

    check(f'{tag}: Pause hidden while the first pick is idle', page.is_hidden('#nd-pause'))
    page.click('#nd-timer'); page.wait_for_timeout(1200)
    check(f'{tag}: Pause shows once the clock runs', page.is_visible('#nd-pause'))
    for sel in ('#nd-pause', '#nd-reset-btn', '#nd-timer'):
        ok, b = tap_ok(page, sel); check(f'{tag}: {sel} tap target >= 44px', ok, str(b))
    if w >= 1000:
        check(f'{tag}: Pause button reads "Pause"', page.inner_text('#nd-pause').strip() == 'Pause')
    page.screenshot(path=os.path.join(OUT, f'{tag}-1-running.png'))

    # ---- pause
    page.click('#nd-pause'); page.wait_for_timeout(100)
    s0 = secs(page); page.wait_for_timeout(2300); s1 = secs(page)
    check(f'{tag}: paused countdown does not move', s0 == s1, f'{s0} -> {s1}')
    check(f'{tag}: timer shows Paused', 'paused' in page.get_attribute('#nd-timer', 'class') and page.inner_text('#nd-timer .w').strip().lower() == 'paused')
    check(f'{tag}: Pause toggles to Resume', page.get_attribute('#nd-pause', 'aria-label') == 'Resume pick clock' and page.get_attribute('#nd-pause', 'aria-pressed') == 'true')
    if w >= 1000:
        check(f'{tag}: button label reads "Resume"', page.inner_text('#nd-pause').strip() == 'Resume')
    check(f'{tag}: Paused label visible on the timer', page.is_visible('#nd-timer .w'))
    page.screenshot(path=os.path.join(OUT, f'{tag}-2-paused.png'))

    # ---- second tab sees the pause
    tab2 = ctx.new_page(); tab2.goto(BASE + '/nba'); board_ready(tab2)
    check(f'{tag}: second tab opens paused', 'paused' in (tab2.get_attribute('#nd-timer', 'class') or ''))

    # ---- reload while paused
    page.wait_for_timeout(1500)
    page.reload(); board_ready(page)
    check(f'{tag}: reload keeps paused', 'paused' in page.get_attribute('#nd-timer', 'class'))
    check(f'{tag}: reload keeps the time left', secs(page) == s0, f'{secs(page)} vs {s0}')
    page.screenshot(path=os.path.join(OUT, f'{tag}-3-reloaded-paused.png'))

    # ---- pick while paused: next pick, still paused, full time
    p0 = pick_no(page); draft_first(page); toast_clear(page)
    check(f'{tag}: pick recorded while paused', pick_no(page) == p0 + 1)
    check(f'{tag}: next pick stays paused', 'paused' in page.get_attribute('#nd-timer', 'class'))
    check(f'{tag}: next pick paused at the full 1:30', secs(page) == 90, str(secs(page)))
    check(f'{tag}: second tab follows the pick, still paused',
          wait_js(tab2, f'() => document.getElementById("nd-pick").textContent.trim() === "{p0 + 1}" && document.getElementById("nd-timer").classList.contains("paused")'))

    # ---- resume
    page.click('#nd-pause'); page.wait_for_timeout(2300)
    check(f'{tag}: resume counts down again', secs(page) <= 88 and 'paused' not in page.get_attribute('#nd-timer', 'class'), str(secs(page)))
    check(f'{tag}: Resume toggles back to Pause', page.get_attribute('#nd-pause', 'aria-label') == 'Pause pick clock')
    check(f'{tag}: second tab resumes too', wait_js(tab2, '() => !document.getElementById("nd-timer").classList.contains("paused")'))
    tab2.close()

    # ---- reset clock
    before = secs(page)
    page.click('#nd-reset-btn'); page.wait_for_selector('#nd-reset-sheet.is-open'); page.wait_for_timeout(250)
    check(f'{tag}: reset menu lists Reset Clock + Reset Draft', page.is_visible('#nd-rs-clock') and page.is_visible('#nd-rs-draft'))
    check(f'{tag}: Reset Draft shows the pick count', '1 recorded pick' in page.inner_text('#nd-rs-draft-sub'), page.inner_text('#nd-rs-draft-sub'))
    for sel in ('#nd-rs-clock', '#nd-rs-draft'):
        ok, b = tap_ok(page, sel); check(f'{tag}: {sel} tap target >= 44px', ok, str(b))
    check(f'{tag}: no horizontal scroll (menu open)', overflow(page) <= 0, str(overflow(page)))
    page.screenshot(path=os.path.join(OUT, f'{tag}-4-reset-menu.png'))
    page.click('#nd-rs-clock'); page.wait_for_timeout(400)
    check(f'{tag}: Reset Clock restarts the pick time', secs(page) >= 89 and before < 89, f'{before} -> {secs(page)}')
    check(f'{tag}: Reset Clock keeps it running', 'paused' not in page.get_attribute('#nd-timer', 'class'))
    toast_clear(page)

    # paused + reset clock: full time, still paused
    page.click('#nd-pause'); page.wait_for_timeout(1300)
    page.click('#nd-reset-btn'); page.wait_for_selector('#nd-reset-sheet.is-open'); page.wait_for_timeout(250)
    page.click('#nd-rs-clock'); page.wait_for_timeout(300)
    check(f'{tag}: Reset Clock while paused: 1:30, still paused', secs(page) == 90 and 'paused' in page.get_attribute('#nd-timer', 'class'))
    page.click('#nd-pause'); toast_clear(page)

    # ---- reset draft: confirm / cancel / clear / undo
    draft_first(page); draft_first(page); toast_clear(page)
    n = pick_no(page) - 1
    page.click('#nd-reset-btn'); page.wait_for_selector('#nd-reset-sheet.is-open'); page.wait_for_timeout(250)
    page.click('#nd-rs-draft'); page.wait_for_timeout(150)
    txt = page.inner_text('#nd-rs-confirm-txt')
    check(f'{tag}: confirm step names the count', f'Clear all {n} recorded picks' in txt, txt)
    check(f'{tag}: confirm button names the count', page.inner_text('#nd-rs-go').strip() == f'Clear {n} Picks', page.inner_text('#nd-rs-go'))
    for sel in ('#nd-rs-go', '#nd-rs-back'):
        ok, b = tap_ok(page, sel); check(f'{tag}: {sel} tap target >= 44px', ok, str(b))
    page.screenshot(path=os.path.join(OUT, f'{tag}-5-reset-confirm.png'))
    page.click('#nd-rs-back'); page.wait_for_timeout(150)
    check(f'{tag}: Cancel goes back to the menu', page.is_visible('#nd-rs-opts') and page.is_hidden('#nd-rs-confirm'))
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    check(f'{tag}: cancel keeps every pick', pick_no(page) == n + 1)

    settings_before = page.evaluate('() => JSON.parse(localStorage.getItem("pocket-nba-draft:manual")).settings')
    page.click('#nd-reset-btn'); page.wait_for_selector('#nd-reset-sheet.is-open'); page.wait_for_timeout(250)
    page.click('#nd-rs-draft'); page.click('#nd-rs-go'); page.wait_for_timeout(400)
    st = page.evaluate('() => JSON.parse(localStorage.getItem("pocket-nba-draft:manual"))')
    check(f'{tag}: Reset Draft back to pick 1', pick_no(page) == 1)
    check(f'{tag}: Reset Draft clears saved picks', st['manual'] == [])
    check(f'{tag}: Reset Draft keeps slot + settings', st['settings'] == settings_before and st['slotChosen'] is True and st['settings']['mySlot'] == 3)
    check(f'{tag}: slot picker still says #3', 'You pick #3' in page.inner_text('#nd-slotpick'))
    check(f'{tag}: other league board untouched', page.evaluate(f'() => localStorage.getItem({json.dumps(OTHER_KEY)})') == OTHER_VAL)
    check(f'{tag}: other league clock untouched', page.evaluate(f'() => localStorage.getItem({json.dumps(OTHER_CLOCK)})') == OTHER_CLOCK_VAL)
    check(f'{tag}: clock idle after reset (tap to start)', page.inner_text('#nd-timer .t').startswith('▶'))
    toast = page.locator('.nu-toast').last
    check(f'{tag}: undo toast shown', toast.is_visible() and 'Undo' in toast.inner_text(), toast.inner_text() if toast.count() else '')
    page.screenshot(path=os.path.join(OUT, f'{tag}-6-reset-done.png'))
    toast.locator('.nu-toast__action').click(); page.wait_for_timeout(400)
    check(f'{tag}: Undo restores the picks', pick_no(page) == n + 1)

    # clear for real, then reload: still empty
    page.click('#nd-reset-btn'); page.wait_for_selector('#nd-reset-sheet.is-open'); page.wait_for_timeout(250)
    page.click('#nd-rs-draft'); page.click('#nd-rs-go'); page.wait_for_timeout(300)
    page.reload(); board_ready(page)
    check(f'{tag}: reset survives a reload', pick_no(page) == 1)
    page.click('#nd-reset-btn'); page.wait_for_selector('#nd-reset-sheet.is-open'); page.wait_for_timeout(250)
    check(f'{tag}: Reset Draft disabled with no picks', page.is_disabled('#nd-rs-draft'))
    page.keyboard.press('Escape'); page.wait_for_timeout(300)

    # League settings' Reset Draft opens the same menu
    draft_first(page); toast_clear(page)
    page.click('#nd-settings-btn'); page.wait_for_timeout(400); page.click('#nd-reset'); page.wait_for_timeout(400)
    check(f'{tag}: League Settings Reset Draft opens the reset menu', page.is_visible('#nd-reset-sheet') and page.is_hidden('#nd-settings'))
    page.keyboard.press('Escape'); page.wait_for_timeout(300)

    check(f'{tag}: no horizontal scroll', overflow(page) <= 0, str(overflow(page)))
    check(f'{tag}: no console errors', not errs, '; '.join(errs[:3]))
    ctx.close()


with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h in [(375, 812), (1280, 800)]:
        run(b, w, h)
    b.close()

print(f'\n{len(problems)} problem(s)')
sys.exit(1 if problems else 0)
