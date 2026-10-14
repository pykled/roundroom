# Stream N1 handoff: homepage NBA entry, sport switch, NBA theme

Branch `nba-n1-home`. Nothing was pushed or deployed. Files touched: `home.html`, `shared/nav.js`, `shared/styles.css` (append-only), `scripts/test-nba-home.js`, `docs/nba-theme.md`, this doc, and `docs/nba-ui/n1-*.png`. `server.js`, `nba/pages/*`, `nba/router.js` and `nba/model/*` are untouched.

## What changed
- **home.html (NFL `/`).**
  - **"NBA is live" banner** under the nav: "Yahoo High Score draft board, built for your league" with an **Open NBA board →** button linking to `/nba`. On phones the button shortens to **Open →**.
  - **`#nba` section** between Tools and Method, covering High Score's best-game rule, the slot-aware draft board, a read-only Yahoo live sync and the manual board, plus an "in progress" tile for lineups/trades/waivers. It includes a pick-card mock.
  - **Footer link** "NBA draft board".
  - **Umami events:** `nba-banner-click`, `nba-section-click`, `nba-footer-click` (via the page's `track()`). The nav switch uses `data-umami-event="nba-nav-switch"` / `"nfl-nav-switch"`.
  - **NFL content is unchanged.** It's a pure insert diff: the test checks that no baseline line was removed and every id survives. `/?anything` still serves index.html.
- **shared/nav.js.**
  - Sport comes from `location.pathname` (`/nba` and `/nba/*` are NBA). The NFL | NBA pill sits on the bar and stays visible on mobile, and a "Sport" row sits inside the hamburger.
  - On `/nba*` pages whose links still point at NFL tools, the links are rewritten to Draft board `/nba` and Lineup `/nba/lineup`, and the logo goes to `/nba`.
  - Existing NBA pages, which ship their own `#rr-sport-switch` and `/nba/*` links, are left alone except for the added menu row.
  - The hamburger behaviour is unchanged, except that tapping a sport option also closes the menu.
  - The pill CSS moved from a JS-injected `<style>` into styles.css. Every page that loads nav.js also loads styles.css.
  - `module.exports` is set for tests.
- **shared/styles.css.** The `/* === NBA theme === */` section. See `docs/nba-theme.md`.

## Verification
- `node scripts/test-nba-home.js; echo exit=$?` → 147 passed, exit=0. It covers the diff against `git show nba:home.html`, no new external origins, no football words in the NBA copy, a DOM-stub test of nav.js (sport detection, link rewrite, idempotence, menu copy), a CSS brace check, append-only styles.css, and contrast.
- `npm test; echo exit=$?` → exit=0.
- **Real browser.** Ran `PORT=7996 DATABASE_URL= node --env-file=.env.local server.js` and drove it with Playwright (Chromium, reduced motion) at 375×812 and 1280×800:
  - The banner CTA, the bar pill and the hamburger Sport row each navigate to `/nba` (200).
  - No page errors, and `scrollWidth` equals the viewport on `/` and on themed `/nba`.
  - Tap targets: the bar pill is 32px and the menu pill 40px.
  - `/?companion=1` still serves the draft tool.
- The driver script was kept out of the repo because it wasn't in N1's file list. To reproduce, start the server as above and run Playwright against `http://127.0.0.1:7996/`.

## For N2 (applying the theme to the NBA pages)
1. Add `class="sport-nba"` to `<body>` in `nba/pages/draft.html` and `nba/pages/lineup.html`. That's all that's required.
2. Optional cleanup in those pages:
   - drop the page-level `.sport-switch` rules (the shared section now styles `#rr-nav .sport-switch`);
   - swap hard-coded oranges (`--clock: #fb923c`) for `var(--nba-400)`;
   - use `.nba-badge`, `.nba-chip`, `.nba-tier-N`, and `.nba-court` on at most one panel.
3. Keep `--g` (guards) distinct from the accent if you can, for example by nudging guards toward amber. The pick card is fine as is.
4. Preview: `n1-nba-themed-*.png` shows the board with the class injected.

## Not done
- `npm test` doesn't include `test-nba-home.js` because package.json wasn't in N1's file list. Add `&& node scripts/test-nba-home.js` when integrating.
