#!/usr/bin/env python3
"""U0 (NBA design system): screenshots of /nba/pages/styleguide.html in a real
browser at 375x812 and 1280x800, plus interaction states.

  DATABASE_URL= PORT=7992 node --env-file=.env.local server.js &
  BASE=http://127.0.0.1:7992 python3 scripts/nba-u0-screens.py

Saves docs/nba-ui/u0-*.png. Prints console errors, horizontal overflow and a
few behaviour checks (sheet focus trap + ESC, tabs keys, avatar fallback).
Exit 1 on any problem.
"""
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:7992')
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'nba-ui')
URL = BASE + '/nba/pages/styleguide.html'
problems = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail else ''))
    if not ok:
        problems.append(name + ' ' + str(detail))


def watch(page):
    errs = []
    # CSP blocks ESPN images today (documented API need); those are expected and handled by the fallback.
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'clerk' not in m.text.lower()
            and 'Content Security Policy' not in m.text and 'Failed to load resource' not in m.text else None)
    page.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
    return errs


def shot(page, name, errs, full=False, clip_el=None):
    over = page.evaluate('() => document.documentElement.scrollWidth - window.innerWidth')
    path = os.path.join(OUT, name)
    if clip_el:
        page.locator(clip_el).screenshot(path=path)
    else:
        page.screenshot(path=path, full_page=full)
    status = 'ok'
    if over > 0:
        problems.append(f'{name}: horizontal overflow {over}px'); status = f'OVERFLOW {over}px'
    if errs:
        problems.append(f'{name}: console {errs[:3]}'); status += f' errors={errs[:3]}'
    print(f'{name}: {status}')


def run(br, w, h, reduced):
    tag = str(w)
    ctx = br.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w < 500 else 1,
                         is_mobile=w < 500, has_touch=w < 500, reduced_motion='reduce' if reduced else 'no-preference')
    page = ctx.new_page(); errs = watch(page)
    page.goto(URL, wait_until='networkidle')
    page.wait_for_timeout(900)
    check(f'{tag} body.nba-ui + tab bar', page.evaluate("() => document.body.classList.contains('nba-ui') && !!document.querySelector('.nu-tabbar')"))
    check(f'{tag} nav.js enhanced nav', page.evaluate("() => document.getElementById('rr-nav').getAttribute('data-sport-ready') === '1'"))
    tabbar_visible = page.evaluate("() => getComputedStyle(document.querySelector('.nu-tabbar')).display !== 'none'")
    check(f'{tag} tab bar visible only on mobile', tabbar_visible == (w <= 768))
    loaded = page.evaluate("() => [...document.querySelectorAll('.nu-avatar img.is-loaded')].length")
    check(f'{tag} headshots loaded', loaded >= 6, loaded)
    missing = page.evaluate("() => { const a = [...document.querySelectorAll('#sg-avatars .nu-avatar')].pop(); return !a.querySelector('img') && a.textContent.trim() === 'MI'; }")
    check(f'{tag} 404 headshot falls back to initials', missing)
    small = page.evaluate("""() => [...document.querySelectorAll('.nu-btn, .nu-chip, .nu-tab, .nu-tabbar a, .nu-seg > button, .nu-input, .nu-select')]
        .filter(e => e.offsetParent && !e.closest('.nu-sheet')).map(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e, '::after');
          const extra = s.content !== 'none' && s.position === 'absolute' ? 8 : 0; return [e.className, Math.round(r.height + extra)]; })
        .filter(x => x[1] < 44)""")
    check(f'{tag} touch targets >= 44px', not small, small[:5])
    shot(page, f'u0-styleguide-{tag}.png', errs)
    shot(page, f'u0-styleguide-full-{tag}.png', errs, full=True)
    # sections up close
    page.add_style_tag(content='.nu-actionbar{visibility:hidden}')  # sticky demo bar would cover section crops
    for sec in ['players', 'data', 'stats', 'templates']:
        page.locator('#' + sec).scroll_into_view_if_needed()
        shot(page, f'u0-{sec}-{tag}.png', errs, clip_el='#' + sec)
    page.add_style_tag(content='.nu-actionbar{visibility:visible}')
    # hover + focus states
    page.locator('#buttons').scroll_into_view_if_needed()
    if w > 500:
        page.hover('#sg-primary'); page.wait_for_timeout(150)
        shot(page, f'u0-buttons-hover-{tag}.png', errs, clip_el='#buttons')
    page.focus('#sg-primary'); page.keyboard.press('Tab'); page.keyboard.press('Shift+Tab'); page.wait_for_timeout(100)
    shot(page, f'u0-buttons-focus-{tag}.png', errs, clip_el='#buttons')
    # tabs keyboard
    page.focus('#sg-tabs [aria-selected="true"]'); page.keyboard.press('ArrowRight')
    check(f'{tag} tabs ArrowRight selects next', page.evaluate("() => document.querySelector('#sg-tabs [aria-selected=true]').dataset.value") == 'cheat')
    check(f'{tag} tab panel toggles', page.evaluate("() => document.getElementById('sg-tp1').hidden && !document.getElementById('sg-tp2').hidden"))
    # chips
    page.click('#sg-chips [data-value="C"]')
    check(f'{tag} chip toggles', page.evaluate("() => document.querySelector('#sg-chips [data-value=C]').getAttribute('aria-pressed') === 'true' && document.querySelector('#sg-chips [data-value=ALL]').getAttribute('aria-pressed') === 'false'"))
    # sheet
    page.click('#sg-open-sheet'); page.wait_for_timeout(600)
    check(f'{tag} sheet opens + focus inside', page.evaluate("() => document.getElementById('sg-player-sheet').classList.contains('is-open') && document.getElementById('sg-player-sheet').contains(document.activeElement)"))
    check(f'{tag} background inert', page.evaluate("() => document.getElementById('app').hasAttribute('inert')"))
    for _ in range(6): page.keyboard.press('Tab')
    check(f'{tag} focus trapped in sheet', page.evaluate("() => document.getElementById('sg-player-sheet').contains(document.activeElement)"))
    shot(page, f'u0-sheet-{tag}.png', errs)
    page.keyboard.press('Escape'); page.wait_for_timeout(450)
    check(f'{tag} ESC closes sheet + focus returns', page.evaluate("() => !document.getElementById('sg-player-sheet').classList.contains('is-open') && document.activeElement.id === 'sg-open-sheet' && !document.getElementById('app').hasAttribute('inert')"))
    # toast
    page.click('#sg-toast-undo'); page.wait_for_timeout(450)
    shot(page, f'u0-toast-{tag}.png', errs)
    # mobile hamburger still works (shared/nav.js)
    if w <= 768:
        page.evaluate('() => window.scrollTo(0, 0)')
        page.click('.nav-hamburger'); page.wait_for_timeout(200)
        check(f'{tag} hamburger opens', page.evaluate("() => document.getElementById('rr-nav').classList.contains('open')"))
        shot(page, f'u0-nav-menu-{tag}.png', errs)
        page.keyboard.press('Escape')
    ctx.close()


with sync_playwright() as p:
    br = p.chromium.launch()
    for w, h in [(375, 812), (1280, 800)]:
        run(br, w, h, reduced=False)
    # reduced motion: skeleton must be static
    ctx = br.new_context(viewport={'width': 375, 'height': 812}, reduced_motion='reduce')
    page = ctx.new_page(); page.goto(URL, wait_until='networkidle')
    check('reduced-motion: skeleton not animated', page.evaluate("() => getComputedStyle(document.querySelector('.nu-skel')).animationName") == 'none')
    ctx.close()
    br.close()

print('problems:', len(problems))
for x in problems: print(' -', x)
sys.exit(1 if problems else 0)
