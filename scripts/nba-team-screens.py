#!/usr/bin/env python3
"""NBA team page (Stream C): browser checks + screenshots at 375x812 and 1280x800
against scripts/nba-team-mock.js (real router + real offline model + recorded
Sleeper fixtures of Dillon's league). Starts its own mock unless BASE is set.

  python3 scripts/nba-team-screens.py            # spawns the mock on a free port
  BASE=http://127.0.0.1:4811 python3 scripts/nba-team-screens.py

Scenarios: empty (no Sleeper, no roster), manual (13-man roster vs a typical
league), connected (power table / cards, my team, trade targets), detail (roster
sheet), horizon switch, view-as (user owns no team), Sleeper 429 (banner + manual),
categories league (notice + manual), zero leagues. Every scenario at both widths:
no horizontal scroll, tap targets >= 44 px inside the page, no page errors, no
console errors (resource-load noise from player/team images is ignored; failed API
calls are checked per scenario instead). Saves docs/nba-team/{scenario}-{375,1280}.png.
Exit 1 on any problem."""
import json, os, re, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'docs', 'nba-team')
os.makedirs(OUT, exist_ok=True)
LID = '1411447094215991296'
PYKLE = {'username': 'pykle', 'userId': '1044077615075872768', 'displayName': 'pykle'}
STRANGER = {'username': 'stranger', 'userId': '999000111222333444', 'displayName': 'stranger'}
ROSTER1 = [str(x) for x in json.load(open(os.path.join(ROOT, 'docs', 'nba-spec', 'fixtures', 'sleeper-rosters.json')))[0]['players']]
problems = []

mock = None
BASE = os.environ.get('BASE', '')
if not BASE:
    mock = subprocess.Popen(['node', os.path.join(ROOT, 'scripts', 'nba-team-mock.js'), '--port=0'], stdout=subprocess.PIPE, text=True)
    line = mock.stdout.readline()
    BASE = re.search(r'(http://127\.0\.0\.1:\d+)', line).group(1)
print('mock', BASE)


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail else ''))
    if not ok:
        problems.append(name)


def mode(**q):
    qs = '&'.join(f'{k}={v}' for k, v in q.items())
    urllib.request.urlopen(urllib.request.Request(f'{BASE}/__mock/mode?{qs}', method='POST')).read()


def fresh(page, user=None, league=None, roster=None, horizon=None):
    page.goto(BASE + '/nba/team')
    page.evaluate("""([user, league, roster, horizon]) => { localStorage.clear();
      if (user) localStorage.setItem('pocket-nba-sleeper', JSON.stringify(user));
      if (league !== null) localStorage.setItem('pocket-nba-league', league);
      if (roster || horizon) localStorage.setItem('pocket-nba-team:v1', JSON.stringify({ v: 1, horizon: horizon || 'ros', roster: roster || [], viewAs: {} })); }""", [user, league, roster, horizon])
    page.reload()


def wait(page, sel, timeout=20000):
    try:
        page.wait_for_selector(sel, timeout=timeout, state='visible')
        return True
    except Exception:
        return False


def visible(page, sel):
    loc = page.locator(sel)
    return loc.count() > 0 and loc.first.is_visible()


def text(page, sel):
    return page.locator(sel).first.inner_text() if page.locator(sel).count() else ''


def common(page, tag, w):
    ov = page.evaluate('() => document.documentElement.scrollWidth - document.documentElement.clientWidth')
    check(f'{tag}: no horizontal scroll', ov <= 1, f'overflow {ov}px')
    small = page.evaluate("""() => Array.from(document.querySelectorAll('#tm-app button, #tm-app a.nu-btn, #tm-app select, #tm-app input, #tm-tbody tr, .tm-card, #tm-detail-body button, #tm-detail-body a'))
      .filter(e => e.offsetParent).map(e => { const r = e.getBoundingClientRect(); return { r, id: e.id || e.className || e.tagName, t: (e.textContent || '').trim().slice(0, 20) }; })
      .filter(x => x.r.height < 44 || (x.r.width < 44 && x.r.width > 0)).map(x => x.id + ':' + x.t + ':' + Math.round(x.r.width) + 'x' + Math.round(x.r.height))""")
    check(f'{tag}: tap targets >= 44px', not small, ', '.join(small[:6]))
    check(f'{tag}: no "Yahoo" on the page', 'Yahoo' not in page.evaluate('() => document.body.innerText'))


def shot(page, name, w, full=False):
    if not page.locator('.nu-sheet.is-open').count():
        page.evaluate('window.scrollTo(0, 0)')
        page.wait_for_timeout(150)
    page.screenshot(path=os.path.join(OUT, f'{name}-{w}.png'), full_page=full)


def run(page, w, errs, bad):
    t = str(w)
    # --- empty: no Sleeper, no roster
    mode(api='ok', leagues='one', user='pykle')
    errs.clear(); bad.clear()
    fresh(page)
    check(f'{t} empty: manual card', wait(page, '#tm-manual'))
    check(f'{t} empty: no power table', not visible(page, '#tm-power'))
    check(f'{t} empty: Connect Sleeper offered', visible(page, '#tm-manual-connect'))
    check(f'{t} empty: title Your Team', text(page, '#tm-title') == 'Your Team', text(page, '#tm-title'))
    common(page, f'{t} empty', w)
    shot(page, 'empty', w)

    # --- manual: 13 players vs a typical league
    fresh(page, roster=ROSTER1)
    ok = wait(page, '#tm-me .tm-me__rank, #tm-me .tm-badge-est')
    check(f'{t} manual: my team card vs typical league', ok and 'vs typical league' in text(page, '#tm-me').lower(), text(page, '#tm-me')[:120].replace('\n', ' '))
    check(f'{t} manual: roster list has 13 players', page.locator('#tm-roster-list li').count() == 13, str(page.locator('#tm-roster-list li').count()))
    check(f'{t} manual: no power table', not visible(page, '#tm-power'))
    check(f'{t} manual: strengths/weaknesses shown', visible(page, '#tm-needs .tm-lines'))
    page.fill('#tm-roster-q', 'jokic')
    page.wait_for_timeout(300)
    check(f'{t} manual: search finds Jokić', 'Joki' in text(page, '#tm-roster-opts'), text(page, '#tm-roster-opts')[:80])
    page.fill('#tm-roster-q', '')
    page.wait_for_timeout(200)
    common(page, f'{t} manual', w)
    shot(page, 'manual', w)

    # --- connected: power rankings + my team
    errs.clear(); bad.clear()
    fresh(page, user=PYKLE)
    rows_sel = '#tm-tbody tr' if w >= 900 else '#tm-cards .tm-card'
    check(f'{t} connected: power rankings render', wait(page, rows_sel))
    page.wait_for_timeout(600)
    check(f'{t} connected: 12 teams', page.locator(rows_sel).count() == 12, str(page.locator(rows_sel).count()))
    check(f'{t} connected: my row highlighted', page.locator(rows_sel.split(' ')[0] + ' .is-me').count() == 1)
    check(f'{t} connected: eyebrow names the league', 'HALIMSANITY' in text(page, '#tm-eyebrow'), text(page, '#tm-eyebrow'))
    check(f'{t} connected: my team card with rank', visible(page, '#tm-me .tm-me__rank'), text(page, '#tm-me')[:80])
    check(f'{t} connected: G/F/C/UTIL tiers per team', page.locator((rows_sel + ' .tm-tier')).count() == 48)
    links = page.eval_on_selector_all('#tm-trade a.nu-btn', 'els => els.map(e => e.getAttribute("href"))')
    check(f'{t} connected: trade targets deep-link to the calculator', len(links) >= 1 and all(re.match(r'^/nba/trade\?league_id=\d+&partner=\d+&give=\d+&get=\d+$', h) for h in links), str(links[:2]))
    check(f'{t} connected: partners listed', page.locator('#tm-trade .tm-partner').count() >= 1)
    check(f'{t} connected: injuries card', visible(page, '#tm-health'))
    check(f'{t} connected: preseason records show a dash', '—' in (text(page, '#tm-tbody') if w >= 900 else 'x—'))
    if w >= 900:
        page.click('#tm-thead [data-sort="C"]')
        page.wait_for_timeout(200)
        first = page.eval_on_selector('#tm-tbody tr', 'e => e.querySelectorAll("td")[8].innerText')
        check(f'{t} connected: sort by C puts the 1st-ranked C team first', '1st' in first, first)
        page.click('#tm-thead [data-sort="rank"]')
    common(page, f'{t} connected', w)
    shot(page, 'connected', w)
    shot(page, 'connected-full', w, full=True)
    check(f'{t} connected: no failed API calls', not bad, '; '.join(bad[:3]))

    # --- detail sheet
    page.locator(rows_sel.split(' ')[0] + ' .is-me').first.click()
    ok = wait(page, '#tm-detail-sheet .tm-rrow')
    page.wait_for_timeout(500)
    check(f'{t} detail: roster rows', ok and page.locator('#tm-detail-sheet .tm-rrow').count() >= 13, str(page.locator('#tm-detail-sheet .tm-rrow').count()))
    check(f'{t} detail: weekly sparkline', visible(page, '#tm-detail-sheet .nu-spark'))
    check(f'{t} detail: form / minutes / market tags', page.locator('#tm-detail-sheet .tm-rrow__meta .nu-tag').count() >= 13)
    common(page, f'{t} detail', w)
    shot(page, 'detail', w)
    page.keyboard.press('Escape')
    page.wait_for_timeout(400)

    # --- horizon: playoffs
    before = text(page, '#tm-me .nu-stat__value')
    page.click('#tm-horizon [data-value="playoffs"]')
    page.wait_for_timeout(1500)
    after = text(page, '#tm-me .nu-stat__value')
    check(f'{t} horizon: playoffs re-ranks on weeks 21-23', page.get_attribute('#tm-horizon [data-value="playoffs"]', 'aria-pressed') == 'true' and before != after and 'Playoffs' in text(page, '#tm-me'), f'{before} → {after}')
    shot(page, 'horizon-playoffs', w)
    page.click('#tm-horizon [data-value="ros"]')
    page.wait_for_timeout(800)
    check(f'{t} connected flow: no console/page errors', not errs, '; '.join(errs)[:300])

    # --- view as: user owns no team in the league
    errs.clear(); bad.clear()
    fresh(page, user=STRANGER)
    check(f'{t} view-as: table still renders', wait(page, rows_sel))
    page.wait_for_timeout(500)
    check(f'{t} view-as: picker shown', visible(page, '#tm-viewas'))
    check(f'{t} view-as: notice names the user', 'stranger' in text(page, '#tm-banner'), text(page, '#tm-banner')[:100])
    check(f'{t} view-as: no my-team card yet', not visible(page, '#tm-me'))
    page.select_option('#tm-viewas', '5')
    check(f'{t} view-as: team 5 becomes "mine"', wait(page, '#tm-me .tm-me__rank') and 'Tatum of Thrones' in text(page, '#tm-me'), text(page, '#tm-me')[:80])
    common(page, f'{t} view-as', w)
    shot(page, 'view-as', w)

    # --- Sleeper 429 on the league: banner + manual still works
    mode(api='ratelimit', leagues='one')
    errs.clear(); bad.clear()
    fresh(page, user=PYKLE, roster=ROSTER1)
    check(f'{t} 429: error banner', wait(page, '#tm-banner .nu-callout') and 'rate-limiting' in text(page, '#tm-banner'), text(page, '#tm-banner')[:100])
    check(f'{t} 429: manual mode works', wait(page, '#tm-me .tm-badge-est'))
    check(f'{t} 429: only the expected 429', all(' 429 ' in b for b in bad) and bad, '; '.join(bad[:3]))
    common(page, f'{t} 429', w)
    shot(page, 'sleeper-429', w)

    # --- categories league
    mode(api='ok', leagues='cats')
    errs.clear(); bad.clear()
    fresh(page, user=PYKLE)
    check(f'{t} categories: notice', wait(page, '#tm-banner .nu-callout') and 'categories league' in text(page, '#tm-banner'), text(page, '#tm-banner')[:120])
    check(f'{t} categories: manual mode offered', visible(page, '#tm-manual'))
    shot(page, 'categories', w)

    # --- zero leagues
    mode(api='ok', leagues='zero')
    fresh(page, user=PYKLE)
    check(f'{t} zero leagues: notice', wait(page, '#tm-banner .nu-callout') and 'No NBA leagues' in text(page, '#tm-banner'), text(page, '#tm-banner')[:100])
    check(f'{t} zero leagues: manual card', visible(page, '#tm-manual'))
    shot(page, 'zero-leagues', w)
    mode(api='ok', leagues='one')
    check(f'{t} degraded flows: no console/page errors', not errs, '; '.join(errs)[:300])


try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for w, h in [(375, 812), (1280, 800)]:
            ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w == 375 else 1)
            page = ctx.new_page()
            errs, bad = [], []
            page.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
            page.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
            page.on('response', lambda r: bad.append(f'{r.request.method} {r.status} {r.url[len(BASE):][:90]}') if r.status >= 400 and r.url.startswith(BASE) and '/api/' in r.url else None)
            run(page, w, errs, bad)
            ctx.close()
        browser.close()
finally:
    if mock:
        mock.terminate()

print(f'\n{len(problems)} problem(s)' + (': ' + '; '.join(problems) if problems else ''))
sys.exit(1 if problems else 0)
