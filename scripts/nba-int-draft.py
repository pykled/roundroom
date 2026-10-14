#!/usr/bin/env python3
"""Integration check: drive a full 12-team manual draft on /nba/draft against the
REAL server (not the mock). Team MY_SLOT takes the page's recommendation; the
other 11 pick by market rank (Yahoo-first consensus, else board rank) + noise.

  python3 scripts/nba-int-draft.py --base http://localhost:7994 --w 1280 --h 800 --tag 1280 [--rounds 16]

Writes docs/nba-ui/int-<tag>-*.png and prints a JSON report (exit 1 on a hard failure).
"""
import argparse, json, random, re, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--base', default='http://localhost:7994')
ap.add_argument('--w', type=int, default=1280)
ap.add_argument('--h', type=int, default=800)
ap.add_argument('--tag', default='1280')
ap.add_argument('--slot', type=int, default=5)
ap.add_argument('--rounds', type=int, default=0, help='0 = whatever the board says')
ap.add_argument('--seed', type=int, default=7)
ap.add_argument('--shots', default='docs/nba-ui')
a = ap.parse_args()
rng = random.Random(a.seed)
TEAMS = 12

data = json.load(urllib.request.urlopen(a.base + '/api/nba/players?profile=242808'))
players = data['players']
def key(p):
    return 'y' + str(p['yahooPid']) if p.get('yahooPid') not in (None, '') else str(p['id'])
byKey = {key(p): p for p in players}
def mkt(p):
    return p.get('marketRank') if p.get('marketRank') is not None else (p.get('yahooPreRank') or p['rank'] + 40)

def slot_for(pick):
    r = (pick - 1) // TEAMS
    i = (pick - 1) % TEAMS
    return i + 1 if r % 2 == 0 else TEAMS - i

errors, report, fails = [], {'tag': a.tag, 'picks': [], 'mine': [], 'checks': {}}, []
def check(name, ok, detail=''):
    report['checks'][name] = {'ok': bool(ok), 'detail': detail}
    if not ok: fails.append(name + ': ' + str(detail))

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={'width': a.w, 'height': a.h}, device_scale_factor=2 if a.w < 500 else 1,
                         is_mobile=a.w < 500, has_touch=a.w < 500)
    page = ctx.new_page()
    bytes_in = {'n': 0, 'reqs': 0}
    page.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    bad = []
    report['httpErrors'] = bad
    def on_resp(r):
        bytes_in['reqs'] += 1
        if r.status >= 400: bad.append(f'{r.status} {r.url}')
        try:
            h = r.headers
            bytes_in['n'] += int(h.get('content-length') or 0) or len(r.body())
        except Exception:
            pass
    page.on('response', on_resp)
    t0 = time.time()
    page.goto(a.base + '/nba/draft', wait_until='networkidle')
    page.wait_for_selector('.nd-row', timeout=15000)
    report['loadMs'] = int((time.time() - t0) * 1000)
    report['pageBytes'] = bytes_in['n']; report['pageReqs'] = bytes_in['reqs']
    if page.locator('#nd-fr-manual').is_visible():
        page.click('#nd-fr-manual')
    # My draft slot via the League dialog (what Dillon does ~30 min before)
    page.click('#nd-settings-btn')
    page.fill('input[name=mySlot]', str(a.slot))
    if a.rounds:
        page.fill('#nd-slot-fields input[name=rounds]', str(a.rounds))
    page.click('#nd-settings-form button[value=save]')
    page.wait_for_timeout(300)
    page.screenshot(path=f'{a.shots}/int-{a.tag}-empty.png')

    def picks_done():
        return page.evaluate("() => { const t = document.getElementById('nd-picks-total'); return t ? t.textContent : '' }")
    def board_text():
        return page.evaluate("() => document.body.innerText")

    total_txt = page.inner_text('#nd-of') if page.locator('#nd-of').count() else ''
    m = re.search(r'(\d+)', total_txt or '')
    total = int(m.group(1)) if m else (a.rounds or 14) * TEAMS
    rounds = total // TEAMS
    report['boardOf'] = total_txt
    taken = set()
    timings = []
    warn_log = []
    did_undo = did_reload = False
    for pick in range(1, total + 1):
        s = slot_for(pick)
        t1 = time.time()
        if s == a.slot:
            # Page's recommendation (what the one-tap button would draft)
            btn = page.locator('#nd-reco button[data-act=mine]')
            if not btn.count():
                check(f'reco-present-{pick}', False, 'no Draft button in recommendation on my pick')
                break
            pid = btn.first.get_attribute('data-id')
            reason = page.inner_text('#nd-reco .nd-reco-why') if page.locator('#nd-reco .nd-reco-why').count() else ''
            tag = page.inner_text('#nd-reco .nd-fill') if page.locator('#nd-reco .nd-fill').count() else ''
            p = byKey.get(pid, {})
            report['mine'].append({'pick': pick, 'name': p.get('name'), 'pos': p.get('yahooPos'), 'rank': p.get('rank'),
                                   'mkt': p.get('marketRank'), 'hs': p.get('hsValue'), 'tag': tag, 'why': reason})
            btn.first.click()
        else:
            avail = [p for p in players if key(p) not in taken]
            avail.sort(key=lambda p: mkt(p) + rng.gauss(0, 2 + 0.12 * mkt(p)))
            p = avail[0]; pid = key(p)
            loc = page.locator(f'.nd-draft[data-act=draft][data-id="{pid}"]')
            if not loc.count():
                page.fill('#nd-search', p['name'])
                loc = page.locator(f'.nd-draft[data-act=draft][data-id="{pid}"]')
            loc.first.click()
            if page.input_value('#nd-search'):
                page.fill('#nd-search', '')
        taken.add(pid)
        page.wait_for_function(f"() => !document.querySelector('.nd-draft[data-act=draft][data-id=\"{pid}\"]')", timeout=5000)
        timings.append((time.time() - t1) * 1000)
        report['picks'].append(pid)
        if page.locator('#nd-warns').count():
            w = page.inner_text('#nd-warns').strip()
            if w: warn_log.append((pick, w.replace('\n', ' | ')[:200]))
        if pick == 2:
            v1 = page.inner_text('#nd-timer'); page.wait_for_timeout(2100); v2 = page.inner_text('#nd-timer')
            report['timer'] = [v1, v2]
            check('pick clock counts down', v1 != v2, f'{v1!r} -> {v2!r}')
        if pick == 30 and not did_undo:
            n_before = len(page.locator('#nd-picks .nd-pick').all()) if page.locator('#nd-picks .nd-pick').count() else None
            page.click('#nd-undo'); page.wait_for_timeout(200)
            back = page.locator(f'.nd-draft[data-act=draft][data-id="{pid}"]').count() > 0 or bool(page.evaluate(f"() => !!document.querySelector('[data-id=\"{pid}\"]')"))
            check('undo restores last pick', back, pid)
            # redo the same pick
            loc = page.locator(f'.nd-draft[data-act=draft][data-id="{pid}"]')
            if not loc.count():
                page.fill('#nd-search', byKey[pid]['name']); loc = page.locator(f'.nd-draft[data-act=draft][data-id="{pid}"]')
            loc.first.click(); page.fill('#nd-search', '')
            did_undo = True
        if pick in (24, 60, 120, total - 1):
            page.screenshot(path=f'{a.shots}/int-{a.tag}-p{pick}.png')
        if pick == 100 and not did_reload:
            before = page.inner_text('#nd-pick')
            page.reload(wait_until='networkidle'); page.wait_for_selector('.nd-row', timeout=15000)
            after = page.inner_text('#nd-pick')
            check('reload keeps picks', before == after, f'{before!r} vs {after!r}')
            did_reload = True
    page.wait_for_timeout(300)
    txt = board_text()
    check('no NaN/undefined in page', not re.search(r'\bNaN\b|\bundefined\b', txt), re.findall(r'.{20}(?:NaN|undefined).{20}', txt)[:3])
    roster = page.inner_text('#nd-roster')
    report['roster'] = roster
    page.screenshot(path=f'{a.shots}/int-{a.tag}-final.png', full_page=False)
    # side panel on mobile may be hidden; scroll into view for a roster shot
    try:
        page.locator('#nd-roster').scroll_into_view_if_needed(); page.screenshot(path=f'{a.shots}/int-{a.tag}-roster.png')
    except Exception:
        pass
    # cheat sheet view
    try:
        page.click('#nd-views button[data-view=cheat]'); page.wait_for_timeout(300); page.screenshot(path=f'{a.shots}/int-{a.tag}-cheat.png')
    except Exception as e:
        errors.append('cheat view: ' + str(e))
    # Yahoo-only player visible + badge
    page.goto(a.base + '/nba/draft', wait_until='networkidle'); page.wait_for_selector('.nd-row')
    page.click('#nd-show-taken') if page.locator('#nd-show-taken').count() else None
    page.fill('#nd-search', 'Valan')
    page.wait_for_timeout(200)
    vrow = page.inner_text('#nd-list')
    check('yahoo-only row searchable with NO LOGS badge', 'Valan' in vrow and 'NO LOGS' in vrow, vrow[:160])
    page.screenshot(path=f'{a.shots}/int-{a.tag}-yahoo-only.png')
    hscroll = page.evaluate('() => document.documentElement.scrollWidth - window.innerWidth')
    check('no horizontal scroll', hscroll <= 1, hscroll)
    br.close()

timings.sort()
report['clickToRenderMs'] = {'p50': round(timings[len(timings) // 2]), 'p95': round(timings[int(len(timings) * .95)]), 'max': round(timings[-1])}
report['warnings'] = warn_log[-12:]
report['errors'] = errors
# The logged-out Yahoo status probe 401s by design (browser logs it as a resource error).
real_errors = [e for e in errors if not ('401' in e and 'Failed to load resource' in e)]
check('no console/page errors (beyond the logged-out Yahoo 401 probe)', not real_errors, real_errors[:5])
check('only logged-out Yahoo endpoints fail (401)', all(b.startswith('401 ') and '/api/nba/yahoo/' in b for b in report['httpErrors']), report['httpErrors'][:5])
check('all picks made', len(report['picks']) == total, len(report['picks']))
report['fails'] = fails
print(json.dumps(report, indent=1, ensure_ascii=False))
sys.exit(1 if fails else 0)
