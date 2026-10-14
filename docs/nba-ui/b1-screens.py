"""B1 screenshot + DOM driver for the homepage NBA entry points.

  python3 docs/nba-ui/b1-screens.py <label> <port> [--stale-css FILE]

Writes docs/nba-ui/b1-<label>-*.png and prints one JSON line per viewport with
the banner CTA's textContent, computed styles, vertical alignment against the
banner text, horizontal overflow and console errors. --stale-css serves FILE in
place of /shared/styles.css (reproduces a browser holding a pre-NBA cached copy).
"""
import json, os, sys
from playwright.sync_api import sync_playwright

label, port = sys.argv[1], int(sys.argv[2])
stale = sys.argv[sys.argv.index('--stale-css') + 1] if '--stale-css' in sys.argv else None
base = f'http://localhost:{port}'
out = os.path.dirname(os.path.abspath(__file__))
VIEWPORTS = [(375, 812), (768, 1024), (1280, 800)]

PROBE = """() => {
  const q = s => document.querySelector(s);
  const cta = q('#nba-banner-cta'), txt = q('#nba-banner .nb-text'), sec = q('#nba-cta');
  const cs = cta && getComputedStyle(cta), r = cta && cta.getBoundingClientRect(), t = txt && txt.getBoundingClientRect();
  const sw = [...document.querySelectorAll('#rr-nav > .rr-sport .rr-sport-opt')].map(a => {
    const s = getComputedStyle(a); return { t: a.textContent, bg: s.backgroundColor, h: a.getBoundingClientRect().height, ev: a.dataset.umamiEvent };
  });
  return {
    text: cta && cta.textContent.replace(/\\s+/g, ' ').trim(),
    bg: cs && cs.backgroundImage.slice(0, 40), color: cs && cs.color, deco: cs && cs.textDecorationLine,
    display: cs && cs.display, h: r && Math.round(r.height), w: r && Math.round(r.width),
    centerDelta: r && t ? Math.round((r.top + r.height / 2) - (t.top + t.height / 2)) : null,
    secText: sec && sec.textContent.replace(/\\s+/g, ' ').trim(),
    secBg: sec && getComputedStyle(sec).backgroundImage.slice(0, 40), secH: sec && Math.round(sec.getBoundingClientRect().height),
    footColor: getComputedStyle(q('#nba-foot')).color,
    sw, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h in VIEWPORTS:
        ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2)
        pg = ctx.new_page()
        errs = []
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        if stale:
            css = open(stale).read()
            pg.route('**/shared/styles.css*', lambda r: r.fulfill(status=200, content_type='text/css', body=css))
        pg.goto(base + '/', wait_until='networkidle')
        pg.wait_for_timeout(900)
        info = pg.evaluate(PROBE)
        # Ignore third-party noise (umami/fonts blocked offline); report everything else.
        info['consoleErrors'] = [e for e in errs if 'umami' not in e and 'fonts.g' not in e]
        print(json.dumps({'label': label, 'vp': f'{w}x{h}', **info}))
        tag = f'{label}-{w}'
        nav_h = pg.evaluate("document.getElementById('nba-banner').getBoundingClientRect().bottom")
        pg.screenshot(path=f'{out}/b1-{tag}-banner.png', clip={'x': 0, 'y': 0, 'width': w, 'height': nav_h + 8})
        pg.locator('#nba').scroll_into_view_if_needed(); pg.wait_for_timeout(700)
        pg.locator('#nba .nba-panel').screenshot(path=f'{out}/b1-{tag}-section.png')
        pg.locator('footer.rr-footer').screenshot(path=f'{out}/b1-{tag}-footer.png')
        if label.startswith('after'):
            pg.evaluate('window.scrollTo(0, 0)'); pg.wait_for_timeout(200)
            pg.hover('#nba-banner-cta'); pg.wait_for_timeout(400)
            pg.locator('#nba-banner').screenshot(path=f'{out}/b1-{tag}-banner-hover.png')
            pg.mouse.move(1, h - 1); pg.wait_for_timeout(300)
            pg.focus('#nba-banner-cta')  # programmatic focus after no pointer use: matches :focus-visible
            pg.keyboard.press('Shift+Tab'); pg.keyboard.press('Tab'); pg.wait_for_timeout(300)
            pg.locator('#nba-banner').screenshot(path=f'{out}/b1-{tag}-banner-focus.png')
        ctx.close()
    b.close()
