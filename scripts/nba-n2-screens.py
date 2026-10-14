#!/usr/bin/env python3
"""N2 (orange theme + basketball copy): screenshots of every NBA page in a real
browser against a real local server and the real /api/nba/players data.

  DATABASE_URL= PORT=7999 node --env-file=.env.local server.js &
  python3 scripts/nba-n2-screens.py [draft|pages|manual|fallback ...]

Saves docs/nba-ui/n2-*.png at 375x812 and 1280x800. Prints, per shot, console
errors, horizontal overflow and (draft) a few behaviour checks. Exit 1 on any.
"""
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:7999')
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'nba-ui')
SIZES = [(375, 812), (1280, 800)]
WHAT = sys.argv[1:] or ['draft', 'pages', 'manual', 'fallback']
problems = []

def ctx_for(br, w, h):
    return br.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w < 500 else 1,
                          is_mobile=w < 500, has_touch=w < 500, reduced_motion='reduce')

def watch(page, tag):
    errs = []
    # 401 = /api/nba/yahoo/status while signed out (expected; the page shows Connect Yahoo).
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'clerk' not in m.text.lower() and '401' not in m.text else None)
    page.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
    return errs

def shot(page, name, errs, full=False):
    over = page.evaluate('() => document.documentElement.scrollWidth - window.innerWidth')
    page.screenshot(path=os.path.join(OUT, name), full_page=full)
    status = 'ok'
    if over > 0: problems.append(f'{name}: horizontal overflow {over}px'); status = f'OVERFLOW {over}px'
    if errs: problems.append(f'{name}: console {errs[:3]}'); status += f' errors={len(errs)}'
    print(f'{name}: {status}')

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail else ''))
    if not ok: problems.append(name + ' ' + str(detail))

def draft(br, w, h):
    tag = str(w)
    ctx = ctx_for(br, w, h); page = ctx.new_page(); errs = watch(page, tag)
    page.goto(BASE + '/nba', wait_until='networkidle')
    page.wait_for_selector('.nd-row', timeout=20000)
    check(f'{tag} body.sport-nba', page.evaluate("() => document.body.classList.contains('sport-nba')"))
    check(f'{tag} theme-color', page.evaluate("() => document.querySelector('meta[name=theme-color]').content") == '#1a110b')
    shot(page, f'n2-draft-empty-{tag}.png', errs)
    if page.locator('#nd-fr-manual').is_visible(): page.click('#nd-fr-manual')
    # About sheet
    page.click('#nd-about-btn'); page.wait_for_timeout(200)
    check(f'{tag} about sheet opens', page.evaluate("() => document.getElementById('nd-about').open"))
    shot(page, f'n2-draft-about-{tag}.png', errs)
    page.click('#nd-about button[value=close]'); page.wait_for_timeout(150)
    check(f'{tag} about sheet closes', not page.evaluate("() => document.getElementById('nd-about').open"))
    # Draft slot 5 via League settings
    page.click('#nd-settings-btn'); page.fill('input[name=mySlot]', '5')
    page.click('#nd-settings-form button[value=save]'); page.wait_for_timeout(200)
    shot(page, f'n2-draft-start-{tag}.png', errs)
    # ~40 picks through the page's own buttons: my turn = recommendation, else top row.
    for i in range(40):
        reco = page.locator('#nd-reco button[data-act=mine]')
        if reco.count() and reco.first.is_visible():
            pid = reco.first.get_attribute('data-id'); reco.first.click()
        else:
            b = page.locator('.nd-row:not(.taken) .nd-draft[data-act=draft]').first
            pid = b.get_attribute('data-id'); b.click()
        page.wait_for_function(f"() => !document.querySelector('.nd-draft[data-act=draft][data-id=\"{pid}\"]')", timeout=5000)
    n = page.inner_text('#nd-pick')
    check(f'{tag} 40 picks made', n.strip() == '41', n)
    page.evaluate('window.scrollTo(0,0)'); page.wait_for_timeout(150)
    shot(page, f'n2-draft-mid-{tag}.png', errs)
    # Undo, then reload persistence
    before = page.inner_text('#nd-pick'); page.click('#nd-undo'); page.wait_for_timeout(150)
    after = page.inner_text('#nd-pick')
    check(f'{tag} undo', int(after) == int(before) - 1, f'{before}->{after}')
    page.reload(wait_until='networkidle'); page.wait_for_selector('.nd-row', timeout=20000)
    check(f'{tag} reload keeps picks', page.inner_text('#nd-pick').strip() == after.strip(), page.inner_text('#nd-pick'))
    # Filter: C chip
    c = page.locator('#nd-seg button', has_text='C').last
    c.click(); page.wait_for_timeout(150)
    check(f'{tag} slot filter pressed', c.get_attribute('aria-pressed') == 'true')
    shot(page, f'n2-draft-filter-{tag}.png', errs)
    c.click()
    # Cheat sheet view
    page.click('#nd-views button[data-view=cheat]'); page.wait_for_timeout(200)
    shot(page, f'n2-draft-cheat-{tag}.png', errs)
    page.click('#nd-views button[data-view=board]')
    if w < 500:
        page.click('#nd-mb-btn'); page.wait_for_timeout(250)
        shot(page, f'n2-draft-team-sheet-{tag}.png', errs)
    else:
        page.evaluate('window.scrollTo(0, 600)'); page.wait_for_timeout(150)
        shot(page, f'n2-draft-scrolled-{tag}.png', errs)
    ctx.close()

def populated(br):
    # Manual mode with a real roster: reuse L1's driver (same localStorage
    # fixtures, real /api/nba/players ids), renaming its shots l1-* -> n2-*.
    import importlib.util
    spec = importlib.util.spec_from_file_location('l1', os.path.join(os.path.dirname(__file__), 'nba-l1-screens.py'))
    l1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(l1)
    import tempfile
    l1.BASE = BASE
    l1.OUT = tempfile.mkdtemp()  # L1's extra crops go here, never over the committed l1-*.png
    def renamed(pg, name, full=True):
        over = pg.evaluate('() => document.documentElement.scrollWidth - window.innerWidth')
        if over > 0: problems.append(f'{name}: horizontal overflow {over}px')
        out = name.replace('l1-', 'n2-manual-', 1)
        pg.screenshot(path=os.path.join(OUT, out), full_page=full)
        print('saved', out)
    l1.shot = renamed
    for fn in ('lineup', 'trade', 'waivers'): getattr(l1, fn)(br)
    problems.extend(l1.errors)

def pages(br, w, h):
    tag = str(w)
    for name in ['lineup', 'trade', 'waivers']:
        ctx = ctx_for(br, w, h); page = ctx.new_page(); errs = watch(page, tag)
        page.goto(f'{BASE}/nba/{name}', wait_until='networkidle'); page.wait_for_timeout(1200)
        check(f'{tag} {name} body.sport-nba', page.evaluate("() => document.body.classList.contains('sport-nba')"))
        shot(page, f'n2-{name}-{tag}.png', errs)
        ctx.close()

def fallback(br, w, h):
    # The router's never-500 page, rendered from comingSoonHtml() through a data route.
    import subprocess, json
    html = subprocess.check_output(['node', '-e', "process.stdout.write(require('./nba/router').comingSoonHtml('Playoffs'))"])
    ctx = ctx_for(br, w, h); page = ctx.new_page(); errs = watch(page, str(w))
    page.route(BASE + '/nba/__n2_fallback', lambda r: r.fulfill(status=200, content_type='text/html', body=html))
    page.goto(BASE + '/nba/__n2_fallback', wait_until='networkidle')
    shot(page, f'n2-fallback-{w}.png', errs)
    ctx.close()

with sync_playwright() as pw:
    br = pw.chromium.launch()
    for w, h in SIZES:
        if 'draft' in WHAT: draft(br, w, h)
        if 'pages' in WHAT: pages(br, w, h)
        if 'fallback' in WHAT: fallback(br, w, h)
    if 'manual' in WHAT: populated(br)
    br.close()

print('\nproblems:', len(problems))
for p in problems: print(' -', p)
sys.exit(1 if problems else 0)
