# Handoff P4: NBA trade page rebuilt on nba-ui (2026-10-14)

Branch `nba-p4-trade` (worktree `~/projects/pocket-nba-wt/p4-trade`), off `nba-v2`, `nba-u0-design` merged (up to 7b6efdd). Not pushed.

## What changed (UI only; model, routes and API untouched)
Files: `nba/pages/trade.html`, `trade.js`, `trade-logic.js`, `scripts/test-nba-trade.js`.

- **Shell:** nba-ui page setup: `NbaUI.mountNav({active:'trade'})` (with a static fallback nav inside `[data-nu-nav]` so `test-nba-copy.js` still sees all tool links), court page head, bottom tab bar, `yahoo-chip.js`. The board comes from `/api/nba/players?profile=242808`.
- **Two-sided builder:** You give / You get cards. Each player is a rich row: headshot (`NbaUI.avatar`, team badge, injury dot, initials fallback), Yahoo position pills, team, injury badge, pts/wk (hsValue), ceiling, and after scoring ROS value plus lineup impact (±/wk). Desktop: inline autocomplete with headshots (keyboard: ↑/↓/Enter/Esc; ARIA combobox). Empty query shows your roster (give) or top values / the partner's roster (get). Phones: "Add a player" opens a bottom sheet for multi-add.
- **Manual mode:** a "Your roster" sheet (search to add, import from draft board, remove, clear with Undo). Giving a player who isn't on the roster adds him. "Try an example trade" on a first visit. **Yahoo mode:** league select plus a partner select in the Get card; get-search is limited to the partner's roster.
- **Verdict hero** (the one `nu-card--focus`): Accept / Counter / Decline word with an icon, a plain-English one-liner, You / Them per-week tiles with season totals, both uncertainty bands on one zero-centred axis, a fairness meter (Favors them · Even · Favors you, scaled by the fair band), partner likelihood, **Copy trade summary** (plain text to clipboard, with a textarea fallback), and Clear.
- **Why card:** server bullets with +/− tones, plus derived ones: fills a slot hole, short or long game week, playoff-week games, injured player's return week. 2-for-1 / drop notes and warnings appear as callouts.
- **Lineup before → after:** a 9-slot board with avatars. Changed slots are highlighted and show "was X" plus the delta. A bench row with avatars sits below. There is also a week-by-week bar strip with playoff marks.
- **League rules** sit in a quiet chip row: deadline + days left, commissioner review, 2-day protest window, no pick trades. A closed deadline turns red.
- **Explainer sheet** ("How it works") in beginner language. **Sticky action bar** (<1024px) appears when the verdict is off-screen.
- Mobile order: Give → Get → Verdict → Why → Lineup. Desktop: builder + lineup on the left, sticky verdict column on the right.

## Tests (real exit codes)
`test-nba-trade.js` 0 (30 passed: 2 new tests cover the new pure helpers and the page contract), `test-nba-copy.js` 0, `test-nba-ui-kit.js` 0, every `scripts/test-nba-*.js` (17 suites) 0, `npm test` 0.

## Browser check
Real server (`DATABASE_URL= PORT=7984 node --env-file=.env.local server.js`), python playwright at 375×812 and 1280×800, real 242808 players. My roster is the 6th slot of a 12-team snake. States:
- even: Banchero → Edwards (Counter)
- lopsided: Giannis → K. Porter (Decline)
- 2-for-1: J. Brown + Garland → Jokić (Accept)
- injured: J. Brown → Ingram, who is Out (Counter, return week shown)

Screenshots are `docs/nba-ui/p4-{empty,even,lopsided,2for1,injured}-{375,1280}.png`, `p4-even-375-{fold,actionbar}.png`, `p4-addsheet-375.png`, `p4-addsheet-empty-375.png`, `p4-autocomplete-1280.png`, `p4-explainer-*.png` and `p4-roster-*.png`. No page errors and no horizontal scroll. The only console error is one browser "Failed to load resource 401", from `GET /api/nba/yahoo/status` when signed out. The page now shares the chip's single status fetch, so it is one per load instead of two.

## Requests (not mine to edit)
1. **Router / A:** `/api/nba/yahoo/status` should answer 200 `{connected:false}` when signed out, not 401. It is the last console error on every NBA page.
2. **U0, `#app` clash:** `/shared/styles.css` caps `#app` at 900px, which beats `.nu-shell` max 1200. The design doc's `<main class="nu-shell" id="app">` therefore gets a 900px page. Trade uses `id="nt-app"`. Either drop the id in the doc or add `.nba-ui #app.nu-shell { max-width: var(--nu-max) }`.
3. **U0 components** worth promoting from the trade page's `<style>`: verdict word (`.nt-vword`), zero-centred dual range (`.nt-rrow`), fairness meter (`.nt-fair`), slot diff row (`.nt-slot.is-changed`), inline combobox (`.nt-combo`), dashed add row (`.nt-add`). Also hide the native search-cancel ✕ in `.nu-input[type=search]` (it renders blue); the trade page does this locally for now.
4. `.nu-card--flush` has `overflow:hidden`, which clips dropdowns. The trade page overrides it for its side cards.

## Open risks
- Yahoo mode was not driven in a browser (no connected account). The context flow is unchanged from stream E and covered by route tests.
- Clerk is still loaded to keep the session fresh, but the nba-ui nav has no sign-in or user button.
