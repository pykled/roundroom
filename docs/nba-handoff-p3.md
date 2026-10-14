# Handoff: P3, NBA Lineup page UI rebuild

Branch `nba-p3-lineup` (worktree `~/projects/pocket-nba-wt/p3-lineup`), off `nba-v2`, with `nba-u0-design` merged (be073b9; re-checked before verification, nothing new). Not pushed.

## What changed (UI only; model, routes and router are untouched)
| File | Change |
|---|---|
| `nba/pages/lineup.html` | Rebuilt on the U0 contract: `nba-ui.css` + `NbaUI.mountNav({active:'lineup'})` (bottom tab bar on phones), `.nu-page-head--court`, five sheets (slot detail/swap, matchup week, roster, opponent, "How the lineup works"). Inline CSS covers only lineup-specific layout: week stepper, day strip, hero, moves card, slot board. A static fallback nav lives inside `[data-nu-nav]` (it keeps test-nba-copy's link checks happy and gets replaced on mount). |
| `nba/pages/lineup.js` | New controller. Same data flow as before: Yahoo GET `/api/nba/lineup`, manual POST `/api/nba/lineup/manual`, banked scores per week in localStorage. Players now come from `/api/nba/players?profile=242808`. The Yahoo status fetch is shared with `yahoo-chip.js` (`PocketYahoo.status()`), so the page makes one request instead of two. |
| `nba/pages/lineup-logic.js` | New pure helpers: `suggestions()` (diff → up to 3 plain-English moves, biggest gain first), `applyMoves()` (one-tap apply of one move or the whole lineup; falls back to the full lineup if a single move would over-fill a slot), `slotsFit`, `weekOptions`, `fmtRange`, `freshness`, `yahooTeamUrl`. All earlier exports are unchanged. |
| `scripts/test-nba-lineup.js` | +1 test covering the helpers above (35 pass). |
| `scripts/nba-lineup-mock.js` | The mock league is now `466.l.242808`: 9 starters + 5 BN + IL (Butler) + an unmatched player, a 14-man rival, current_week 7. It mounts the real `/api/nba/league-profile` route and passes `?profile` through. |

## Page anatomy
- **Hero** (calm `.nu-card`): expected week total (48px mono), "best lineup · now X ▲gain", a p10–p90 `rangeBand`, a win-probability split bar (orange you / graphite them) or an "Add opponent" button, then a footer line: day N of M · data freshness ("Updated 13m ago") · **What is this?** sheet.
- **Moves** (the page's one `.nu-card--focus`): 1–3 moves like "Start Nikola Jokić over Stephen Curry · C · +24.4 expected", each with a one-tap **Apply** (manual mode). Forfeit warnings sit in a small amber note, never a red wall. Slot shuffles and "+N smaller moves" are one hint line each. In Yahoo mode the card says to make the moves in Yahoo. When nothing beats the current lineup the card shows "Lineup is set".
- **Slot board**: 9 starters, then Bench n/5, then Injured list n/2. Each row has a slot pill, headshot (`NbaUI.avatar` + injury dot; initials fallback), name + injury badge + "Start" tag, team logo, Yahoo position pills, games left (pips on desktop), banked score ("B 58.0", or "+ banked" mid-week), expected best game, and a swap button. On ≥768px the board turns into a table with columns. Tapping a row opens the slot sheet: lg player cell, Exp/Left/Banked tiles with % to beat, the rationale, a banked-score input, and Swap in (alternatives with deltas plus a calm forfeit note).
- **Week selector**: ‹ [Week 7 · 14 days / Nov 30 – Dec 13] ›. The middle button opens a sheet listing all 22 matchup weeks with date ranges and 14 days / Playoffs / Now tags. The day strip ("today"; earlier days count as played) scrolls with edge fades on phones.
- **Manual mode**: an inline "Build your roster" focus card when empty (search with headshots, Add, paste) next to a 3-step how-it-works card. Once a roster exists the builder moves into the roster sheet (slot select + remove per player). The opponent gets its own sheet.
- **Sticky action bar**: "N moves · +X expected" + **Apply all** (manual) / **Set in Yahoo** (links to the Yahoo team page). Other states: "Lineup is set · X expected" + Edit roster, and an empty state with Add players. Apply shows a toast with **Undo**.

## Verification (2026-10-14)
- Real server: `DATABASE_URL= PORT=7983 node --env-file=.env.local server.js`, manual mode, real `/api/nba/players?profile=242808`. Roster: 14 top-60 players + Jimmy Butler (Out) on IL, banked scores for week 7, a 14-man opponent. Yahoo path: `node scripts/nba-lineup-mock.js --port=7984 --yahoo=on`.
- Playwright at 375×812 (2x) and 1280×800. States: empty, search, built wk1 (day 0), wk7 day 5 with banked + forfeit warning + IL, slot sheet, week sheet, switch to wk8 and back, about sheet, Apply all → optimal, roster sheet, Yahoo mock with an unmatched player.
- **No horizontal scroll in any state; no console errors** apart from one `401` per load from `/api/nba/yahoo/status` when signed out. That is the server's signed-out response and every NBA page gets it via yahoo-chip.js; I cut it from 2 to 1 by sharing the fetch.
- Exit codes: test-nba-lineup 0 (35 passed), test-nba-copy 0, test-nba-ui-kit 0, all 17 `scripts/test-nba-*.js` 0, `npm test` 0.
- Screenshots: `docs/nba-ui/p3-*.png` (empty, search, built-wk1, wk7-forfeit(-top), slot-sheet, week-sheet, week8, about, applied, roster-sheet, yahoo(-top), each at 375 and 1280).

## Requests for U0 (design system; I did not edit nba-ui.css/js)
1. **`.nu-row`/slot-board primitive**: lineup rows need slot pill · avatar · two-line text · N numeric columns · trailing icon button, with columns that collapse into the meta line under 768px. I built it as `.ln-srow`/`.ln-colhead` in the page. Please consider a `.nu-board` component (Trade/Waivers could use it).
2. **`posPill('BN'|'IL')`** falls through to the UTIL colour. A neutral `data-pos="BN"` and a muted red `data-pos="IL"` would read better.
3. **Split meter colours**: the doc says good/bad (green/red) for win probability. I used orange (you) / graphite (them) to keep it calm and stay on-brand. Please bless or adjust that in the doc.
4. **`statTile` label truncation**: "GAMES LEFT" ellipsizes in a 3-up grid at 375px. Either a smaller label size in `.nu-stats--3` or allow 2-line labels.
5. **`.nu-note`** (inline amber "heads-up" inside a card, lighter than `.nu-callout--warn`) is used for forfeit warnings here (`.ln-note`). Worth promoting.
6. **Day/date strip** (`.ln-day`): Waivers and Trade both have day-of-week concepts. Candidate for the kit.
7. `NbaUI.icon` has no up/down chevron; I rotate `chevron`. An `arrows`/`swap` icon distinct from the Trade tab icon would help (the swap button reuses `icon.trade`).

## Open risks
- Apply/swap edits the **manual** current lineup only. Yahoo mode can't write lineups (no API), so it links to Yahoo instead.
- A single-move Apply can depend on slot shuffles from other moves. `applyMoves` detects an over-filled slot and then applies the whole lineup (the toast says "Best lineup applied"). That path is tested.
- The swap sheet lists only the API's `alternatives` (top 3 per slot), not every eligible roster player.
- Banked scores are still typed by hand (known gap, docs/nba-lineup.md).
