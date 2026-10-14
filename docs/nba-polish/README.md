# NBA UI polish pass (2026-10-14)

Before/after screenshots of every NBA page at 375, 414, 768 and 1280 px.
`before/` = origin/main 457c09b, `after/` = branch nba-ui-polish. Full-page shots are cropped to 2400 px tall;
`vp-*` files are viewport-only (sticky draft clock while the board is scrolled).

Captured with Playwright against a local server (`PORT=7911 node --env-file=.env.local server.js`) using a
manual board, slot 3, five picks drafted, the research detail/filter sheets, a seeded 13-player lineup roster,
the trade example and a waivers roster imported from the draft board. No console errors and no horizontal
scroll at any width in either run.

## Copy
Title Case for nav items, page titles, headings, sheet titles, buttons and empty-state titles; body, hints and
toasts stay sentence case. E.g. "Player research" → "Player Research", "Draft board" → "Draft Board",
"Trade calculator" → "Trade Calculator", "Week 1 lineup" → "Week 1 Lineup", "How it works" → "How It Works".

## Layout
- Draft board, phones: the sticky clock sat at 56 px under a 52 px nav, leaving a strip where rows showed through.
  It now sticks flush to the nav.
- Draft board, desktop: the sticky filter bar covers the 3 px strip between it and the clock.
- Draft board, phones: the league/slot status line wraps to two lines instead of cutting off "14 ro…".
- Draft board: slot and filter chips go from 34 to 36 px, the kit's chip height (44 px hit area).
- Research list: a "Projection only" tag that doesn't fit is hidden whole instead of being cut to "Proje".
- Research, touch: the Adds/Drops toggle goes from 30 to 36 px.
- Lineup/Trade/Waivers, phones: action-bar helper text gets two lines instead of an ellipsis.
- Phones: a leading ghost "How It Works" button in a page header lines up with the title.
