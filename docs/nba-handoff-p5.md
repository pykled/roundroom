# Handoff: P5, NBA Waivers page rebuild (UI only)

Branch `nba-p5-waivers` (worktree `~/projects/pocket-nba-wt/p5-waivers`), off `nba-v2`, with `nba-u0-design` merged (7b6efdd). Not pushed.

## Scope
I touched only `nba/pages/waivers.html`, `waivers.js`, `waivers-logic.js` and `scripts/test-nba-waivers.js`. The model, routes, router, nba-ui.css/js and every other page are unchanged. The API contract is unchanged, and the page only calls existing endpoints: `/api/nba/waivers`, `/api/nba/waivers/manual`, `/api/nba/players?profile=242808`, `/api/nba/yahoo/status` and `/api/nba/yahoo/league`.

## What the page is now (built on `nba-ui`)
- **Shell:** `NbaUI.mountNav({active:'waivers'})` with a static link fallback inside `[data-nu-nav]`. Below it: a court page head, a "How it works" ghost button, and the controls (league select, rank-by segmented `This week | 2 wks | 4 wks`, and a matchup-week picker where 14-day weeks are labelled "· 14 days").
- **Hero:** three tiles.
  - **Add budget:** "N of 10 left", with pips.
  - **Waiver priority:** a calm tile, "#p of 12" or "—", with a Set button in manual mode.
  - **Best gain:** this week's number.
- **Best move:** the one `.nu-card--focus` on the page. It's an Add → Drop pair with lg headshots, game chips, the net gain, an FA/W status chip and **Copy claim**, which copies plain text such as "Add X (SAS · C), drop Y (HOU · PG,SG). Expected gain +25.5 pts this week. Free agent: add now." The remaining pairs show below as compact swap cards. On mobile a sticky `.nu-actionbar` repeats the best move with the primary Copy claim; on ≥769px it's hidden because the focus card is on screen.
- **Streamer calendar:** 3 matchup weeks × top 5 four-plus-game free agents, each with a headshot, position pills, a games chip and the expected best game. 14-day weeks get an accent border and a "14-day week · double the games" tag. On phones it's a snap-scroll strip.
- **Best adds:** rich cards, each with:
  - a lg avatar with team-logo badge and injury dot
  - Yahoo position pills, team, injury badge
  - "N this wk / N next" chips, green at 4+
  - an FA ("Free agent · add now") or W ("Waivers · clears in 1 day") chip, plus Role ↑ and Keep priority / No adds left badges
  - two gain columns, **This week** and **Next N wks**, each with a bar on a shared scale. The page requests the primary and secondary horizons in parallel.
  - the drop name, and the priority-cost line when a W claim costs priority
  - a plain-words note when he doesn't help yet

  Tapping a card expands it: a per-week table, typical/ceiling/floor, reasons, Copy claim, and the manual actions (Someone owns him with Undo toast / He's on waivers / I added him).
- **Filters:** chips All/G/F/C · 4-game week · Role ↑ · Hide injured. Sort is segmented: Best gain / Most games / Ceiling.
- **Side column** (sticky ≥1024px):
  - Drop candidates, with plain-English explanations (`dropReason`)
  - Injury cover
  - Your best lineup, with slot pills and avatars
  - Not matched
- **Manual mode:**
  - An empty state ("Add players") when there's no roster yet.
  - Once there is a roster: an avatar-stack summary and an "Edit roster" **sheet**. The sheet has adds used + waiver spot inputs, search with headshots, position, team, injury and board rank, a roster list with remove buttons, the "Hide players other teams likely own" switch, and Import from draft board.
  - Edits are batched and reload once when the sheet closes.
  - The switch is on by default. It excludes the top (teams − 1) × 14 board players other than yours (`likelyRostered`), which fixes checker-F issue #5 ("best move is add Jokić").
- **Explainer sheet:** beginner language covering best game, games, FA vs waivers, rolling priority, add budget and drops, plus the league's `waiverRules.notes`.

## Logic added (`waivers-logic.js`, all tested)
- New helpers: `likelyRostered`, `gainsById`, `barFrac`, `claimText`, `statusLabel`, `weekOptions`, `dropReason`, `posText`.
- `filterTargets` takes a `fourGame` flag.
- `prefs` gains `fourGame`, `hideInjured` and `week`.
- `manualRequest(st, h, week, extraExclude)`: the old call shape gives byte-identical output.
- `loadManual` keeps `assumeTaken:false`.

## Verification (2026-10-14)
- **Real server:** `DATABASE_URL= PORT=7985 node --env-file=.env.local server.js`.
  - Manual mode with real `/api/nba/players?profile=242808`.
  - A realistic 14-man roster from a 12-team pick-6 snake (ranks ~6–163, no Out players).
  - Python Playwright at 375×812 and 1280×800.
  - No horizontal scroll and no NaN/undefined in any state.
- **Yahoo mode:** checked against `scripts/nba-waivers-mock.js --yahoo=on`. 0 console errors and no horizontal scroll. It shows FAB callout, W chips, injury cover, Not matched, and initials fallback for players with no Sleeper id.
- **Console:** the only console errors are `401 /api/nba/yahoo/status` while signed out. Both the nav's Yahoo chip and this page hit that endpoint. This page now shares the chip's fetch (`PocketYahoo.status()`).
- **Tests** (real exit codes):
  - All 17 `scripts/test-nba-*.js` exit 0. That includes waivers 34 passed (2 new tests), copy 264 passed and ui-kit 108 passed.
  - `npm test` exit=0.

Screenshots `docs/nba-ui/`:
- `p5-empty-{375,1280}`
- `p5-top-{375,1280}`
- `p5-full-{375,1280}`
- `p5-pairs-{375,1280}`
- `p5-list-{375,1280}`
- `p5-expanded-{375,1280}`
- `p5-filters-{375,1280}` (G + 4-game week)
- `p5-calendar-wk7-{375,1280}`
- `p5-wk7-top-{375,1280}`
- `p5-roster-sheet-{375,1280}`
- `p5-how-{375,1280}`
- `p5-yahoo-mock-{375,1280}`

## Requests for the design system (U0)
1. **Signed-out status:** `/api/nba/yahoo/status` returns 401 when signed out, and every NBA page logs a console error for it through yahoo-chip. Ask whoever owns the route to return `200 {connected:false}`.
2. **Page-level CSS:** `.nba-ui .nu-card` padding and `.nba-ui [hidden]` beat plain page classes, so pages must prefix with `.nba-ui`. Add a note to the doc.
3. **Body-level `#app`:** `shared/styles.css` caps `#app` at 900px, which made the shell narrow. Rename the shell id in the doc's template, or have nba-ui.css reset `.nba-ui #app { max-width: var(--nu-max) }`.
4. **Possible kit components:** this page defines `.wv-gm` (games chip), `.wv-st` (FA/W status chip) and the swap card locally. Trade and Lineup could use them as kit components (`gamesChip(n, label)`, `statusChip`-like FA/W).
5. **Mobile page head:** on 375px the page head takes about 300px before any data. A compact `--sm` page-head variant would help the tool pages.

## Open notes
- On the real board in week 1 (preseason, a 6-day week, mostly 3-game teams), most free agents add 0.0 to a good roster. The UI says so plainly ("Doesn't beat your current players yet"); that's engine behaviour, not a UI bug.
- Yahoo mode was driven only through the mock, not against a real connected account.
