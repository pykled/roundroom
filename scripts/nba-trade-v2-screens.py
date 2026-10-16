#!/usr/bin/env python3
"""NBA Trade Calculator v2: browser checks + screenshots at 375x812 and 1280x800
against the mock server (scripts/nba-trade-mock.js: real NBA router + offline
model, Sleeper faked with Dillon's league fixtures).

  node scripts/nba-trade-mock.js --port=4797 &
  BASE=http://127.0.0.1:4797 python3 scripts/nba-trade-v2-screens.py

Scenarios: empty (manual), manual example trade (value meter, depth-only fit,
player signals), connected league trade (real rosters 1 vs 2: league-relative
fit, both sides), horizon Next 4 + Playoffs locked before week 10, lean
Balanced, deep link from the team page (?league_id=&partner=&give=&get=, not
connected: my team inferred from the give player, URL cleaned), Sleeper outage
(banner, manual still works). Every scenario: no horizontal scroll, tap targets
>= 44px on the trade controls, no page errors / console errors (external image
404s for missing headshots are allowed; nothing on our origin may fail).
Saves docs/nba-trade-v2/{scenario}-{375,1280}.png. Exit 1 on any problem."""
import os, sys, json, re, subprocess, urllib.request
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

# No BASE: spawn the mock on a free port for this run (and stop it at the end).
SPAWNED = None
if not os.environ.get('BASE'):
    SPAWNED = subprocess.Popen(['node', os.path.join(os.path.dirname(__file__), 'nba-trade-mock.js'), '--port=0'], stdout=subprocess.PIPE, text=True)
    line = SPAWNED.stdout.readline()
    m = re.search(r'(http://127\.0\.0\.1:\d+)', line)
    if not m:
        print('mock server did not start: ' + line)
        sys.exit(1)
    os.environ['BASE'] = m.group(1)
BASE = os.environ.get('BASE', 'http://127.0.0.1:4797')
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'nba-trade-v2')
os.makedirs(OUT, exist_ok=True)
LEAGUE = '1411447094215991296'
USER = {'username': 'pykle', 'userId': '1044077615075872768', 'displayName': 'pykle'}
problems = []
ALLOW = {'sleeper_errors': False}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail else ''))
    if not ok:
        problems.append(name)


def mock(sleeper):
    urllib.request.urlopen(urllib.request.Request(f'{BASE}/__mock/mode?sleeper={sleeper}', method='POST')).read()


def fresh(page, user=False, pref=None, path='/nba/trade'):
    page.goto(BASE + '/api/nba/health')  # same origin, no app running: nothing re-saves state after the clear
    page.evaluate("""([user, pref]) => { localStorage.clear(); localStorage.setItem('pocket-nba-firstrun-done', '1');
      if (user) localStorage.setItem('pocket-nba-sleeper', JSON.stringify(user));
      if (pref) localStorage.setItem('pocket-nba-league', pref); }""", [USER if user else None, pref])
    page.goto(BASE + path)
    page.wait_for_function("() => !document.querySelector('#nt-give-list .nu-skel')", timeout=20000)
    page.wait_for_timeout(600)


def wait_verdict(page, timeout=15000):
    page.wait_for_selector('#nt-verdict .nt-vword__word', timeout=timeout)
    page.wait_for_function("() => document.getElementById('nt-verdict').getAttribute('aria-busy') === 'false'", timeout=timeout)
    page.wait_for_timeout(400)


def no_hscroll(page, tag):
    w = page.evaluate('() => document.documentElement.scrollWidth - document.documentElement.clientWidth')
    check(f'{tag}: no horizontal scroll', w <= 1, f'overflow {w}px')


def taps(page, sel, tag):
    small = page.evaluate("""(sel) => Array.from(document.querySelectorAll(sel)).filter(e => e.offsetParent && !e.disabled)
      .map(e => { const r = e.getBoundingClientRect(); return [e.textContent.trim().slice(0, 24), Math.round(r.width), Math.round(r.height)]; })
      .filter(([, w, h]) => h < 44 || w < 44)""", sel)
    check(f'{tag}: tap targets >= 44px ({sel})', not small, json.dumps(small)[:200])


def text(page, sel):
    return page.locator(sel).first.inner_text() if page.locator(sel).count() else ''


def visible(page, sel):
    return page.locator(sel).first.is_visible() if page.locator(sel).count() else False


def shot(page, name, w, full=True):
    page.screenshot(path=os.path.join(OUT, f'{name}-{w}.png'), full_page=full)


CONTROLS = '#nt-horizon button, #nt-lean button, .nt-add, #nt-roster-btn, #nt-how, .nt-vactions .nu-btn'


def common(page, tag):
    no_hscroll(page, tag)
    taps(page, CONTROLS, tag)


def add_get(page, w, name):
    """Add a player on the get side through the UI (inline search >= 769px, sheet below)."""
    if w >= 769:
        page.fill('#nt-get-q', name)
        page.wait_for_timeout(250)
        page.locator('#nt-get-opts [data-opt]').first.click()
        page.keyboard.press('Escape')
    else:
        page.locator('[data-pick="get"]').click()
        page.fill('#nt-pick-q', name)
        page.wait_for_timeout(250)
        page.locator('#nt-pick-list [data-opt]').first.click()
        page.locator('#nt-pick-done').click()
    page.wait_for_timeout(300)


def add_give(page, w, name):
    if w >= 769:
        page.fill('#nt-give-q', name)
        page.wait_for_timeout(250)
        page.locator('#nt-give-opts [data-opt]').first.click()
        page.keyboard.press('Escape')
    else:
        page.locator('[data-pick="give"]').click()
        page.fill('#nt-pick-q', name)
        page.wait_for_timeout(250)
        page.locator('#nt-pick-list [data-opt]').first.click()
        page.locator('#nt-pick-done').click()
    page.wait_for_timeout(300)


def run(page, w):
    t = str(w)
    mock('ok')

    # --- empty, manual
    fresh(page)
    check(f'{t} empty: build-a-trade card + lens visible', 'Build a Trade' in text(page, '#nt-verdict') and visible(page, '#nt-lens'))
    check(f'{t} empty: Playoffs locked before week 10', page.locator('[data-horizon="playoffs"]').is_disabled())
    common(page, f'{t} empty')
    shot(page, 'empty', w, full=False)

    # --- manual example trade
    page.locator('[data-act="example"]').click()
    wait_verdict(page)
    v = text(page, '#nt-verdict')
    check(f'{t} manual: verdict word', any(x in v for x in ('Accept', 'Counter', 'Decline')), v[:80])
    check(f'{t} manual: value meter (league-neutral)', 'value' in v.lower() and 'in season value' in v.lower(), v[-300:])
    check(f'{t} manual: team fit card (depth only)', visible(page, '#nt-fit-card') and 'Depth Only' in text(page, '#nt-fit-scope'))
    check(f'{t} manual: player signals with why lines', page.locator('#nt-sig > li').count() >= 2 and page.locator('.nt-sig__why li').count() >= 4)
    common(page, f'{t} manual')
    shot(page, 'manual-result', w)

    # --- connected league trade: roster 1 (pykle) gives Lillard, gets Nurkić from roster 2
    fresh(page, user=True, pref=LEAGUE)
    page.wait_for_function("() => document.getElementById('nt-mode-tag').textContent.includes('Sleeper')", timeout=15000)
    page.select_option('#nt-partner', '2')
    page.wait_for_timeout(300)
    add_give(page, w, 'Lillard')
    add_get(page, w, 'Nurki')
    wait_verdict(page)
    check(f'{t} league: fit is league-relative', 'Vs Your League' in text(page, '#nt-fit-scope'), text(page, '#nt-fit-scope'))
    check(f'{t} league: their fit line', visible(page, '#nt-fit-them'), text(page, '#nt-fit-them')[:80])
    check(f'{t} league: verdict meta says Rest of Season · 23 Weeks', 'rest of season · 23 weeks' in text(page, '.nt-vword__meta').lower(), text(page, '.nt-vword__meta'))
    sig = text(page, '#nt-sig')
    check(f'{t} league: signals name the 2025-26 stats + model return week', '2025-26' in sig and 'Out until ~wk' in sig, sig[:160])
    common(page, f'{t} league')
    shot(page, 'league-result', w)

    # --- horizon Next 4 + lean Balanced
    page.locator('[data-horizon="next4"]').click()
    wait_verdict(page)
    check(f'{t} next4: verdict meta Next 4 Weeks · 4 weeks', 'next 4 weeks · 4 weeks' in text(page, '.nt-vword__meta').lower(), text(page, '.nt-vword__meta'))
    page.locator('[data-lean="balanced"]').click()
    wait_verdict(page)
    check(f'{t} balanced: lean note', 'Every week counts the same' in text(page, '#nt-lens-note'), text(page, '#nt-lens-note'))
    common(page, f'{t} lens')
    shot(page, 'lens-next4-balanced', w, full=False)

    # --- deep link from the team page, not connected
    fresh(page, path=f'/nba/trade?league_id={LEAGUE}&partner=2&give=1444&get=1583')
    wait_verdict(page)
    check(f'{t} deep link: league mode from the link', 'Sleeper' in text(page, '#nt-mode-tag'))
    check(f'{t} deep link: give + get prefilled', page.locator('#nt-give-list .nt-prow').count() == 1 and page.locator('#nt-get-list .nt-prow').count() == 1)
    check(f'{t} deep link: URL cleaned', page.evaluate('() => location.search') == '')
    common(page, f'{t} deep link')
    shot(page, 'deep-link', w, full=False)

    # --- Sleeper outage: banner, manual still works
    mock('down')
    ALLOW['sleeper_errors'] = True
    fresh(page, user=True, pref=LEAGUE)
    page.wait_for_timeout(800)
    check(f'{t} outage: banner', 'Sleeper' in text(page, '#nt-banner') and 'Manual' in text(page, '#nt-banner'), text(page, '#nt-banner')[:120])
    check(f'{t} outage: manual mode', 'Manual' in text(page, '#nt-mode-tag'))
    common(page, f'{t} outage')
    shot(page, 'sleeper-down', w, full=False)
    ALLOW['sleeper_errors'] = False
    mock('ok')


with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h in ((375, 812), (1280, 800)):
        ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w == 375 else 1)
        page = ctx.new_page()
        errs = []
        origin = urlparse(BASE).netloc
        def on_console(m, errs=errs):
            if m.type != 'error':
                return
            url = (m.location or {}).get('url', '') if hasattr(m, 'location') else ''
            if 'Failed to load resource' in m.text and urlparse(url).netloc not in ('', origin):
                return  # external headshot / logo 404 (missing CDN image falls back to the team logo)
            if ALLOW['sleeper_errors'] and 'Failed to load resource' in m.text and '/api/nba/sleeper/' in url:
                return  # the outage scenario's expected Sleeper 5xx
            errs.append('console: ' + m.text + (' @ ' + url if url else ''))
        page.on('pageerror', lambda e, errs=errs: errs.append(str(e)))
        page.on('console', on_console)
        try:
            run(page, w)
        except Exception as e:
            check(f'{w}: scenario run', False, repr(e)[:300])
        check(f'{w}: no page errors / console errors', not errs, '; '.join(errs)[:500])
        ctx.close()
    b.close()

if SPAWNED:
    SPAWNED.terminate()
print(f'\n{len(problems)} problem(s)' if problems else '\nall checks passed')
sys.exit(1 if problems else 0)
