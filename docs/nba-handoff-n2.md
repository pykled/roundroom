# Stream N2 handoff: NBA look and feel + basketball wording

Branch `nba-n2-theme` (off `nba` @56055d6). Nothing pushed or deployed. `shared/styles.css`, the NFL pages, `server.js`, `nba/model/*`, `nba/routes/*` and `nba/yahoo/*` are untouched.

## Per page
- **`/nba` (draft.html + 4 lines of draft.js).**
  - `body.sport-nba`, and the hard-coded orange/purple CSS moved onto the theme tokens.
  - Hero card: eyebrow "<league name> · Yahoo High Score", title **NBA Draft Board**, court lines behind it.
  - New **ⓘ How it works** button opens the **About this board** dialog: 5 bullets covering slot, tapping picks + Undo, Yahoo sync vs manual, the clock and the top pick card.
  - The nav now has 4 links (Draft board, Lineup, Trade, Waivers). The page-level sport-switch CSS is gone.
  - Guards are gold. Pressed tab/slot chip and your-pick Draft button are solid orange with an ink label. Focus rings are orange.
  - Every board ID, data-act and behaviour is unchanged. The dialog is wired by a separate 4-line inline script.
- **lineup / trade / waivers.**
  - Each page: theme-color, gold guards, orange pressed segments, orange info banners, and its local sport-switch CSS dropped.
  - Lineup and waivers: the eyebrow no longer hard-codes HALIMSANITY (lineup still shows the profile name from JS).
- **router.js `comingSoonHtml`.** Themed card with a basketball title, theme-color, the 4-link nav and a "tip-off" CTA back to the board.

## Copy fixes
- Lineup meta "best six starters" → "best starters". Static "Nine starters…" → "Each starter scores his single best game of the matchup week" (JS still fills the count from the profile).
- Trade/waivers sub: "best nine-man lineup (PG…2 UTIL)" → "best starting lineup … your league's roster slots and scoring".
- Draft: "Positions come from Sleeper…" → "Dashed position tags are estimates…". Player sheet "Sleeper PG" → "Est. PG". The yahoo-only note now says "our NBA data feed".
- Cheat sheet: "TD games … DD bonus" → "Triple-double games … double-double bonus". "Sleeper positions" → "NBA positions".
- No QB/RB/WR/TE, bye-week or kickoff wording was present.

## Verify
- `node scripts/test-nba-copy.js` (new, in `npm test`): forbidden football terms, sport-nba body, basketball title, theme-color and description on every NBA page, About sheet content. A planted "QB" was caught.
- `scripts/nba-n2-screens.py`: real server + real data, 375×812 and 1280×800 → `docs/nba-ui/n2-*.png`. It checks for overflow and console errors, and covers a 40-pick draft through the page UI, undo, reload persistence, slot filter, about open/close, and manual lineup/trade/waivers (L1 fixtures).
- `scripts/nba-int-draft.py --tag n2-375/n2-1280`: full scripted 12-team draft → `docs/nba-ui/int-n2-*.png`.
