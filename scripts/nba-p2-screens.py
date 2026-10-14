"""P2 research page browser checks: python3 scripts/nba-p2-screens.py [base] [outdir]
Screens every state at 375x812 and 1280x800, records console errors, horizontal
scroll, and the headshot hit rate for avatars inside the viewport."""
import json, sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:7982'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'docs/nba-ui'
report = {'states': [], 'errors': []}

VIEWPORT_IMG = """() => {
  const vh = innerHeight, vw = innerWidth; let total = 0, loaded = 0, noSrc = 0;
  document.querySelectorAll('.nu-avatar').forEach(a => {
    const r = a.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw || r.width === 0) return;
    if (a.closest('[hidden]')) return;
    total++;
    const img = a.querySelector('img');
    if (img && img.classList.contains('is-loaded')) loaded++; else if (!img) noSrc++;
  });
  return { total, loaded, initials: noSrc, counters: window.__rsImg || null,
           hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
}"""

def settle(pg, ms=900):
    pg.wait_for_load_state('networkidle'); pg.wait_for_timeout(ms)

def shot(pg, name, tag):
    info = pg.evaluate(VIEWPORT_IMG)
    path = f'{OUT}/p2-{name}-{tag}.png'
    pg.screenshot(path=path)
    info.update({'state': name, 'vp': tag, 'png': path})
    report['states'].append(info)
    print(json.dumps(info))

with sync_playwright() as p:
    b = p.chromium.launch()
    for (w, h, tag) in [(1280, 800, '1280'), (375, 812, '375')]:
        ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w < 500 else 1)
        pg = ctx.new_page()
        pg.on('console', lambda m, tag=tag: m.type == 'error' and report['errors'].append(f'[{tag}] {m.text}'))
        pg.on('pageerror', lambda e, tag=tag: report['errors'].append(f'[{tag}] pageerror {e}'))
        mobile = w < 768
        # 1 list default
        pg.goto(BASE + '/nba/research'); settle(pg, 1500); shot(pg, 'list', tag)
        # 2 search jokic (accent-insensitive) with autocomplete open
        pg.fill('#rs-q', ''); pg.type('#rs-q', 'jokic', delay=40); pg.wait_for_timeout(900); shot(pg, 'search-jokic', tag)
        assert 'Joki' in pg.inner_text('#rs-ac'), 'autocomplete finds Jokic'
        pg.keyboard.press('Escape'); pg.fill('#rs-q', ''); pg.wait_for_timeout(600)
        # 3 filter C + sort by ceiling via URL state (also proves deep links)
        pg.goto(BASE + '/nba/research?pos=C&sort=ceiling'); settle(pg, 1200); shot(pg, 'filter-c-ceiling', tag)
        if mobile:
            pg.click('#rs-filter-btn'); pg.wait_for_timeout(700); shot(pg, 'filters-sheet', tag); pg.keyboard.press('Escape'); pg.wait_for_timeout(500)
        # 4 details
        for name, pid in [('jokic', '1658'), ('flagg', '4760'), ('injured', '1000'), ('westbrook', 'y4390')]:
            pg.goto(BASE + '/nba/research?player=' + pid); settle(pg, 1600); shot(pg, 'detail-' + name, tag)
            scope = '#rs-detail-sheet' if w < 1024 else '#rs-pane'
            for tab in ['hs', 'gm', 'nw']:
                sel = f'{scope} [role="tab"][data-value="{tab}"]'
                if pg.locator(sel).count():
                    pg.click(sel); pg.wait_for_timeout(350)
                    if name in ('jokic', 'westbrook') or (name == 'flagg' and tab == 'hs'):
                        shot(pg, f'detail-{name}-{tab}', tag)
        # 5 open from list click and back closes
        pg.goto(BASE + '/nba/research'); settle(pg, 1200)
        pg.locator('[data-open]').nth(3 if not mobile else 0).click(); pg.wait_for_timeout(1200)
        report['states'].append({'state': 'click-open', 'vp': tag, 'url': pg.url})
        if mobile:
            pg.go_back(); pg.wait_for_timeout(700)
            report['states'].append({'state': 'back-closes', 'vp': tag, 'url': pg.url, 'sheetOpen': pg.evaluate('NbaUI.sheet.isOpen()')})
        # 6 scrolled list (more headshots)
        pg.goto(BASE + '/nba/research?page=2'); settle(pg, 1200); pg.mouse.wheel(0, 900); pg.wait_for_timeout(1200); shot(pg, 'list-page2-scrolled', tag)
        ctx.close()
    b.close()

json.dump(report, open(f'{OUT}/p2-browser-report.json', 'w'), indent=1)
print('ERRORS', len(report['errors'])); [print(e) for e in report['errors'][:20]]
