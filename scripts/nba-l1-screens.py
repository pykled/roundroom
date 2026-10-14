#!/usr/bin/env python3
"""Drive the NBA lineup / trade / waivers pages in a real browser (stream L1).

Manual mode against a real local server with the real /api/nba/players data:
a 14-man roster assembled from the top-60 board (+ one Out player on IL).
Saves docs/nba-ui/l1-*.png at 375x812 and 1280x800 and prints console errors.

  DATABASE_URL= PORT=7997 node --env-file=.env.local server.js &
  python3 scripts/nba-l1-screens.py [lineup|trade|waivers ...]
"""
import json, os, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:7997')
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'nba-ui')
SIZES = [(375, 812), (1280, 800)]

# Roster (Sleeper ids, all from the top-60 board) + Jimmy Butler (Out) on IL.
ROSTER = [
    ('1957', 'PG'), ('1830', 'SG'), ('1967', 'G'), ('2285', 'SF'), ('1535', 'PF'), ('2835', 'F'),
    ('2438', 'C'), ('1787', 'UTIL'), ('2161', 'UTIL'),
    ('1711', 'BN'), ('2733', 'BN'), ('1716', 'BN'), ('4748', 'BN'), ('1752', 'BN'), ('1000', 'IL'),
]
OPPONENT = ['1658', '4760', '2126', '2133', '2289', '1822', '2458', '2181', '1308', '1648', '2726', '1350', '2007', '4737']
PARTNER = ['2577', '2267', '2308', '1613', '2313', '1747', '2179', '1240', '1433', '2722', '1362', '2574', '1085', '1988']
BANKED = {'7': {'2438': 52, '1787': 38, '1535': 31}}

errors = []


def page_for(b, w, h, storage):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w < 500 else 1)
    pg = ctx.new_page()
    # 401 = /api/nba/yahoo/status while signed out (expected in manual mode).
    pg.on('console', lambda m: errors.append(f'{w}px console.{m.type}: {m.text}') if m.type == 'error' and '401' not in m.text else None)
    pg.on('pageerror', lambda e: errors.append(f'{w}px pageerror: {e}'))
    pg.goto(BASE + '/nba/lineup?blank=1')
    pg.evaluate('(s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }', storage)
    return ctx, pg


def shot(pg, name, full=True):
    path = os.path.join(OUT, name)
    pg.screenshot(path=path, full_page=full)
    print('saved', os.path.relpath(path))


def lineup(b):
    st = {'pocket-nba-lineup:manual': json.dumps({'v': 1, 'roster': [{'id': i, 'slot': s} for i, s in ROSTER], 'opponent': OPPONENT, 'banked': BANKED, 'updatedAt': 1})}
    for w, h in SIZES:
        ctx, pg = page_for(b, w, h, st)
        pg.goto(BASE + '/nba/lineup?week=7&day=5')
        pg.wait_for_selector('.ln-slot', timeout=15000)
        pg.wait_for_timeout(400)
        shot(pg, f'l1-lineup-wk7-{w}.png')
        if w < 500:
            pg.screenshot(path=os.path.join(OUT, 'l1-lineup-wk7-375-top.png'), full_page=False)
            pg.locator('.ln-top').scroll_into_view_if_needed()
            pg.screenshot(path=os.path.join(OUT, 'l1-lineup-wk7-375-result.png'), full_page=False)
        pg.goto(BASE + '/nba/lineup?week=1&day=0')
        pg.wait_for_selector('.ln-slot', timeout=15000)
        pg.wait_for_timeout(300)
        shot(pg, f'l1-lineup-wk1-{w}.png', full=False)
        ctx.close()


def trade(b):
    mine = [i for i, s in ROSTER]
    st = {'pocket-nba-trade:v1': json.dumps({'v': 1, 'mode': 'manual', 'myRoster': mine, 'give': ['2438', '1830'], 'get': ['2308']})}
    for w, h in SIZES:
        ctx, pg = page_for(b, w, h, st)
        pg.goto(BASE + '/nba/trade')
        pg.wait_for_selector('.nt-v-top', timeout=20000)
        pg.wait_for_timeout(400)
        shot(pg, f'l1-trade-{w}.png')
        ctx.close()


def waivers(b):
    import urllib.request
    mine = [i for i, s in ROSTER]
    board = json.load(urllib.request.urlopen(BASE + '/api/nba/players'))['players']
    # A 12-team, 14-round draft takes ~168 players: hide the top 170 others own.
    taken = [p['id'] for p in board[:185] if p['id'] not in mine][:170]
    free = [p for p in board[185:] if not p.get('injury')]
    w_ids = [free[0]['id'], free[3]['id']]  # two real free agents marked as on waivers (W)
    st = {'pocket-nba-waivers:manual': json.dumps({'v': 1, 'roster': mine, 'exclude': taken, 'priority': 2, 'addsUsed': 4, 'waivers': w_ids})}
    # Variant: three bench spots are late-round players (board ranks ~165-175).
    late = [p['id'] for p in board[164:180] if not p.get('injury')][:3]
    mine2 = mine[:11] + late + [mine[-1]]
    taken2 = [i for i in taken if i not in late] + [i for i in mine if i not in mine2]  # swapped-out players are rostered elsewhere
    w2 = [p['id'] for p in board[185:260] if not p.get('injury')][:6:2]
    st2 = {'pocket-nba-waivers:manual': json.dumps({'v': 1, 'roster': mine2, 'exclude': taken2, 'priority': 1, 'addsUsed': 7, 'waivers': w2})}
    for w, h in SIZES:
        for name, state in (('', st), ('-late', st2)):
            ctx, pg = page_for(b, w, h, state)
            pg.goto(BASE + '/nba/waivers')
            pg.wait_for_selector('.nw-row, .nw-best', timeout=20000)
            pg.wait_for_timeout(400)
            shot(pg, f'l1-waivers{name}-{w}.png')
            if w < 500 and name:
                pg.screenshot(path=os.path.join(OUT, 'l1-waivers-late-375-top.png'), full_page=False)
                pg.locator('#nw-list').scroll_into_view_if_needed()
                pg.screenshot(path=os.path.join(OUT, 'l1-waivers-late-375-list.png'), full_page=False)
            ctx.close()


if __name__ == '__main__':
    which = sys.argv[1:] or ['lineup', 'trade', 'waivers']
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name in which:
            globals()[name](b)
        b.close()
    print('console errors:', len(errors))
    for e in errors:
        print('  ', e)
    sys.exit(1 if errors else 0)
