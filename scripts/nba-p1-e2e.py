#!/usr/bin/env python3
"""P1 draft board end-to-end check against the REAL server + real player data.

Drives a full 12-team snake draft through the page UI (Dillon = slot 5 takes
the page's recommendation via the one-tap Draft button; the other 11 teams pick
by market rank + noise via each row's Draft button), then a Yahoo-connected run
(Yahoo endpoints stubbed with page.route, players still real) including the
degraded state. Screenshots -> docs/nba-ui/p1-<tag>-*.png, JSON report on stdout.

  PORT=7981 node --env-file=.env.local server.js &
  python3 scripts/nba-p1-e2e.py --base http://localhost:7981 --w 375 --h 812 --tag 375
  python3 scripts/nba-p1-e2e.py --base http://localhost:7981 --w 1280 --h 800 --tag 1280

Exit 1 on any failed check (console errors other than the logged-out 401,
horizontal scroll, p95 tap latency >= 150ms, logic/persistence failures)."""
import argparse, json, random, re, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--base', default='http://localhost:7981')
ap.add_argument('--w', type=int, default=1280)
ap.add_argument('--h', type=int, default=800)
ap.add_argument('--tag', default='1280')
ap.add_argument('--slot', type=int, default=5)
ap.add_argument('--seed', type=int, default=11)
ap.add_argument('--shots', default='docs/nba-ui')
ap.add_argument('--skip-yahoo', action='store_true')
a = ap.parse_args()
rng = random.Random(a.seed)
TEAMS = 12
PHONE = a.w < 768

data = json.load(urllib.request.urlopen(a.base + '/api/nba/players?profile=242808'))
players = data['players']
def key(p): return 'y' + str(p['yahooPid']) if p.get('yahooPid') not in (None, '') else str(p['id'])
byKey = {key(p): p for p in players}
def mkt(p): return p.get('marketRank') if p.get('marketRank') is not None else (p.get('yahooPreRank') or p['rank'] + 40)
def slot_for(pick):
    r, i = (pick - 1) // TEAMS, (pick - 1) % TEAMS
    return i + 1 if r % 2 == 0 else TEAMS - i

EXPECT_503 = {'on': False}
LATS = []
report = {'tag': a.tag, 'checks': {}, 'mine': [], 'shots': []}
fails, errors = [], []
def check(name, ok, detail=''):
    report['checks'][name] = {'ok': bool(ok), 'detail': detail}
    if not ok: fails.append(f'{name}: {detail}')

LAT_JS = """() => { window.__lat = []; document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('.nd-draft,[data-act=mine],#nd-undo'); if (!b) return;
  const t0 = e.timeStamp || performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => window.__lat.push(performance.now() - t0))); }, true); }"""

def new_page(br):
    ctx = br.new_context(viewport={'width': a.w, 'height': a.h}, device_scale_factor=2 if PHONE else 1, is_mobile=PHONE, has_touch=PHONE)
    pg = ctx.new_page()
    def on_console(m):
        if m.type != 'error': return
        if '401' in m.text: return  # logged-out /api/nba/yahoo/status is expected
        if '503' in m.text and EXPECT_503['on']: return  # the stubbed Yahoo outage below
        errors.append(f'[{a.tag}] console: {m.text}')
    pg.on('console', on_console)
    pg.on('pageerror', lambda e: errors.append(f'[{a.tag}] pageerror: {e}'))
    return ctx, pg

def shot(pg, name, full=False):
    path = f'{a.shots}/p1-{a.tag}-{name}.png'
    pg.wait_for_timeout(350)
    pg.screenshot(path=path, full_page=full)
    report['shots'].append(path)
    sw = pg.evaluate('document.documentElement.scrollWidth')
    check(f'no-hscroll-{name}', sw <= a.w, f'scrollWidth {sw}')

def nav_draft(pg, pid):
    sel = f'.nd-draft[data-act=draft][data-id="{pid}"]'
    if not pg.locator(sel).count():
        pg.fill('#nd-search', byKey[pid]['name']); pg.wait_for_timeout(50)
    pg.locator(sel).first.click()
    if pg.input_value('#nd-search'): pg.fill('#nd-search', '')

with sync_playwright() as pw:
    br = pw.chromium.launch()
    # ------------------------------------------------------------ manual
    ctx, pg = new_page(br)
    pg.add_init_script("(" + LAT_JS + ")()")
    t0 = time.time()
    pg.goto(a.base + '/nba', wait_until='networkidle')
    pg.wait_for_selector('.nd-row', timeout=20000)
    report['loadMs'] = int((time.time() - t0) * 1000)
    pg.wait_for_timeout(600)
    check('first-visit setup card shows', pg.locator('#nd-firstrun').is_visible())
    check('board rows have headshots', pg.locator('.nd-row .nu-avatar img').count() > 20)
    check('board rows have team logos', pg.locator('.nd-row .nu-team-logo').count() > 20)
    check('board rows have Yahoo position pills', pg.locator('.nd-row .nu-pos').count() > 20)
    shot(pg, 'first')
    pg.click('#nd-fr-manual'); pg.wait_for_timeout(200)
    check('setup collapses to one line after manual', not pg.locator('#nd-firstrun').is_visible() and pg.locator('#nd-status').is_visible())
    pg.click('#nd-settings-btn'); pg.wait_for_selector('#nd-settings.is-open')
    pg.fill('input[name=mySlot]', str(a.slot))
    shot(pg, 'settings')
    pg.click('#nd-settings-form button[value=save]'); pg.wait_for_timeout(450)
    check('settings sheet closed', not pg.locator('#nd-settings.is-open').count())
    total = int(re.search(r'(\d+)', pg.inner_text('#nd-of')).group(1))
    report['total'] = total
    check('14 rounds x 12 = 168 picks', total == 168, total)
    shot(pg, 'empty')
    pg.click('#nd-timer')  # start the pick clock
    taken = set(); did = {}
    for pick in range(1, total + 1):
        s = slot_for(pick)
        if s == a.slot:
            if not did.get('clock'):
                check('on-the-clock text', "on the clock" in pg.inner_text('#nd-otc-who'), pg.inner_text('#nd-otc-who'))
                check('reco card on my pick', pg.locator('#nd-reco button[data-act=mine]').count() == 1)
                pg.evaluate('window.scrollTo(0,0)'); shot(pg, 'clock'); did['clock'] = 1
            btn = pg.locator('#nd-mb-act button[data-act=mine]' if PHONE else '#nd-reco button[data-act=mine]')
            if not btn.count():
                check(f'one-tap draft present at {pick}', False, 'missing'); break
            pid = btn.first.get_attribute('data-id')
            why = pg.inner_text('#nd-reco .nd-reco-why') if pg.locator('#nd-reco .nd-reco-why').count() else ''
            p = byKey.get(pid, {})
            report['mine'].append({'pick': pick, 'name': p.get('name'), 'pos': p.get('yahooPos'), 'rank': p.get('rank'), 'hs': p.get('hsValue'), 'why': why})
            btn.first.click()
        else:
            avail = [p for p in players if key(p) not in taken]
            avail.sort(key=lambda p: mkt(p) + rng.gauss(0, 2 + 0.12 * mkt(p)))
            pid = key(avail[0])
            nav_draft(pg, pid)
        taken.add(pid)
        pg.wait_for_function(f"() => !document.querySelector('.nd-draft[data-act=draft][data-id=\"{pid}\"]')", timeout=5000)
        if pick == 2:
            v1 = pg.inner_text('#nd-timer .t'); pg.wait_for_timeout(2100); v2 = pg.inner_text('#nd-timer .t')
            check('pick clock counts down', v1 != v2, f'{v1!r} -> {v2!r}')
        if pick == 9:
            sub = pg.inner_text('#nd-otc-sub')
            check('countdown text "You pick in N · #x, then #y"', re.search(r'You pick in \d+ · #\d+, then #\d+', sub) is not None, sub)
            check('timeline has my picks', pg.locator('#nd-ticker .nd-tl__me').count() >= 1)
        if pick == 30:
            pg.click('#nd-undo'); pg.wait_for_timeout(150)
            back = pg.locator(f'.nd-draft[data-act=draft][data-id="{pid}"]').count() > 0
            check('undo restores last pick', back, pid)
            nav_draft(pg, pid)
            pg.wait_for_function(f"() => !document.querySelector('.nd-draft[data-act=draft][data-id=\"{pid}\"]')", timeout=5000)
        if pick == 40:
            # filters: slot chip, search, tier, hide OUT, sort
            pg.click('#nd-seg [data-pos="C"]'); pg.wait_for_timeout(120)
            rows = pg.locator('#nd-list .nd-row').count()
            nonc = pg.evaluate("() => [...document.querySelectorAll('#nd-list .nd-row')].filter(r => !r.querySelector('.nu-pos[data-pos=C]')).length")
            check('C filter shows only C-eligible', rows > 0 and nonc == 0, f'{rows} rows, {nonc} non-C')
            pg.click('#nd-hide-out'); pg.select_option('#nd-sort', 'value'); pg.wait_for_timeout(120)
            vals = pg.evaluate("() => [...document.querySelectorAll('#nd-list .nd-row .nd-c-val b')].slice(0,30).map(b => parseFloat(b.textContent))")
            check('sort by value is descending', vals == sorted(vals, reverse=True), vals[:6])
            outs = pg.locator('#nd-list .nd-row .nu-inj[data-status=out]').count()
            check('Hide OUT hides OUT players', outs == 0, outs)
            shot(pg, 'filters')
            pg.select_option('#nd-sort', 'rank'); pg.click('#nd-hide-out'); pg.click('#nd-seg [data-pos="ALL"]'); pg.wait_for_timeout(100)
            first = pg.locator('#nd-list .nd-row .nd-name').first.inner_text()
            pg.fill('#nd-search', first.split(' ')[-1]); pg.wait_for_timeout(120)
            check('search narrows the board', 0 < pg.locator('#nd-list .nd-row').count() <= 6, pg.locator('#nd-list .nd-row').count())
            tier = pg.locator('#nd-list .nd-row .nu-tier').first.inner_text().strip('T')
            pg.fill('#nd-search', ''); pg.select_option('#nd-tier', tier); pg.wait_for_timeout(100)
            check('tier filter', pg.locator('#nd-list .nd-row').count() > 0)
            pg.select_option('#nd-tier', '0')
            pg.evaluate('window.scrollTo(0,0)')
        if pick == 66:
            shot(pg, 'mid')
        if pick == 70:
            pg.locator('#nd-list .nd-row-main').first.click()
            pg.wait_for_selector('#nd-sheet.is-open')
            try: pg.wait_for_selector('#nd-p-detail .nd-line b', timeout=6000)
            except Exception: check('sheet detail loads', False, 'no stat line')
            check('sheet has headshot + full-profile link', pg.locator('#nd-sheet .nu-avatar').count() > 0 and pg.locator('#nd-sheet a.nd-full[href^="/nba/research?player="]').count() == 1)
            check('sheet has sparkline', pg.locator('#nd-sheet .nu-spark').count() == 1)
            shot(pg, 'sheet')
            pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
            check('sheet closes on Escape', not pg.locator('#nd-sheet.is-open').count())
        if pick == 80 and PHONE:
            pg.click('#nd-mb-btn'); pg.wait_for_selector('#nd-team-sheet.is-open')
            check('team sheet lists 9 starter slots', pg.locator('#nd-ts-body .nd-slots .nd-slot').count() == 9)
            shot(pg, 'team')
            pg.click('#nd-team-sheet [data-nu-close]'); pg.wait_for_timeout(400)
        if pick == 100:
            before = pg.inner_text('#nd-pick')
            LATS.extend(pg.evaluate('window.__lat') or [])
            pg.reload(wait_until='networkidle'); pg.wait_for_selector('.nd-row', timeout=20000); pg.wait_for_timeout(300)
            check('reload keeps picks', pg.inner_text('#nd-pick') == before, f'{before} vs {pg.inner_text("#nd-pick")}')
        if pick == 139:
            shot(pg, 'late')
            pg.click('#nd-views [data-view=cheat]'); pg.wait_for_timeout(300)
            check('cheat sheet renders', pg.locator('#nd-cheat .nd-cs-rounds li').count() >= 14)
            shot(pg, 'cheat')
            pg.click('#nd-views [data-view=board]'); pg.wait_for_timeout(200)
    pg.wait_for_timeout(300)
    check('draft complete', 'Draft complete' in pg.inner_text('#nd-otc-who'), pg.inner_text('#nd-otc-who'))
    mine_n = pg.evaluate("() => document.querySelectorAll('#nd-roster .nd-slot.is-filled').length") if not PHONE else None
    if mine_n is not None: check('my 14 picks on the roster', mine_n == 14, mine_n)
    shot(pg, 'done')
    lat = sorted(LATS + (pg.evaluate('window.__lat') or []))
    if lat:
        p95 = lat[int(len(lat) * 0.95) - 1]
        report['tapLatency'] = {'n': len(lat), 'p50': round(lat[len(lat) // 2], 1), 'p95': round(p95, 1), 'max': round(lat[-1], 1)}
        check('p95 tap latency < 150ms', p95 < 150, report['tapLatency'])
    ctx.close()

    # ------------------------------------------------------------ yahoo
    if not a.skip_yahoo:
        LK = '466.l.242808'; MY = 5
        names = ['Splash Bros', 'Glass Cleaners', 'Paint Protectors', 'Euro Steps', 'Dillon', 'Fast Breakers', 'Bench Mob', 'Lob City', 'Triple Doubles', 'Corner Threes', 'Iso Joes', 'Pick & Pop']
        teams = [{'team_key': f'{LK}.t.{i+1}', 'name': n, 'draft_position': i + 1} for i, n in enumerate(names)]
        league = {'league_key': LK, 'name': 'HALIMSANITY 26-27', 'num_teams': 12, 'draft_type': 'live', 'is_auction_draft': 0, 'draft_pick_time': 90,
                  'roster_positions': [{'position': p, 'count': 1} for p in ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C']] + [{'position': 'Util', 'count': 2}, {'position': 'BN', 'count': 5}, {'position': 'IL', 'count': 2}]}
        order_players = sorted([p for p in players if p.get('yahooPid')], key=mkt)
        Y = {'n': 0, 'down': False}
        def draft_payload():
            picks = []
            for i in range(Y['n']):
                p = order_players[i]; pk = i + 1
                picks.append({'pick': pk, 'round': (pk - 1) // 12 + 1, 'team_key': f"{LK}.t.{slot_for(pk)}", 'player_key': f"466.p.{p['yahooPid']}", 'sleeperId': p['id'] if not str(p['id']).startswith('y') else None, 'name': p['name']})
            order = [{'pick': pk, 'round': (pk - 1) // 12 + 1, 'team_key': f"{LK}.t.{slot_for(pk)}"} for pk in range(Y['n'] + 1, 169)]
            return {'status': 'drafting' if Y['n'] else 'predraft', 'picks': picks, 'unmatched': [], 'order': order, 'onClock': order[0] if order else None, 'polledAt': time.strftime('%Y-%m-%dT%H:%M:%SZ')}
        def route(r):
            u = r.request.url
            if '/api/nba/yahoo/status' in u:
                return r.fulfill(json={'connected': True, 'leagues': [{'league_key': LK, 'name': 'HALIMSANITY 26-27', 'num_teams': 12, 'draft_status': 'drafting'}]})
            if '/api/nba/yahoo/league' in u:
                return r.fulfill(json={'league': league, 'teams': teams, 'myTeamKey': f'{LK}.t.{MY}'})
            if '/api/nba/yahoo/draft' in u:
                if Y['down']: return r.fulfill(status=503, json={'error': 'yahoo_unavailable'})
                return r.fulfill(json=draft_payload())
            return r.continue_()
        ctx, pg = new_page(br)
        pg.route('**/api/nba/yahoo/**', route)
        Y['n'] = 40
        pg.goto(a.base + '/nba', wait_until='networkidle'); pg.wait_for_selector('.nd-row', timeout=20000)
        pg.wait_for_function("() => /Live from Yahoo/.test(document.getElementById('nd-sync').textContent)", timeout=10000)
        check('yahoo: no setup card when connected', not pg.locator('#nd-firstrun').is_visible())
        check('yahoo: 40 picks synced', pg.inner_text('#nd-pick') == '41', pg.inner_text('#nd-pick'))
        check('yahoo: clock names the Yahoo team', 'on the clock' in pg.inner_text('#nd-otc-who') and 'Team' not in pg.inner_text('#nd-otc-who'), pg.inner_text('#nd-otc-who'))
        shot(pg, 'yahoo')
        Y['n'] = 43  # pick 44 is mine (slot 5, round 4)
        pg.wait_for_function("() => document.getElementById('nd-pick').textContent === '44'", timeout=15000)
        check('yahoo: on the clock for my Yahoo pick', "You're on the clock" in pg.inner_text('#nd-otc-who'))
        shot(pg, 'yahoo-clock')
        Y['down'] = True; EXPECT_503['on'] = True
        pg.wait_for_selector('#nd-banner .nd-degraded', timeout=40000)
        check('degraded: banner + paused pill', 'paused' in pg.inner_text('#nd-sync'))
        btn = pg.locator('#nd-mb-act button[data-act=mine]' if PHONE else '#nd-reco button[data-act=mine]').first
        pid = btn.get_attribute('data-id'); btn.click(); pg.wait_for_timeout(300)
        pend = pg.evaluate("() => document.querySelectorAll('#nd-picks .nd-flag').length")
        check('degraded: manual pick flagged pending', pend >= 1, pend)
        shot(pg, 'degraded')
        ctx.close()
    br.close()

report['consoleErrors'] = errors
check('no console errors', not errors, errors[:5])
report['fails'] = fails
print(json.dumps(report, indent=1))
sys.exit(1 if fails else 0)
