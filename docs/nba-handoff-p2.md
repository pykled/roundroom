# P2 handoff: NBA player research page (`/nba/research`)

Branch `nba-p2-research` (off `nba-v2`, `nba-u0-design` merged in). Page owner files:

| File | What |
|---|---|
| `nba/pages/research.html` | Shell: nav (`NbaUI.mountNav({active:'research'})`), page head, search combobox, chips, tools, trending strip, results, detail pane; sheets for detail / filters / "How it works" |
| `nba/pages/research.js` | Fetch + render + events (in-memory response cache, URL sync, autocomplete, detail pane/sheet, tabs) |
| `nba/pages/research-logic.js` | Pure logic (UMD): URL state parse/serialise, `/api/nba/research` query building, sort catalogue, formatting, probability chips, market reading, scouting sentences, schedule cards, weekly-best bar geometry |
| `nba/pages/research.css` | Page layout + widgets the design system lacks (see requests below). Every rule under `.nba-ui` |
| `nba/router.js` | one line: `router.get('/nba/research', page('research.html', 'Research'))` |
| `scripts/test-nba-research-ui.js` | 25 checks, plain node, in `npm test` |
| `scripts/nba-p2-screens.py` | Browser pass (playwright): every state at 375×812 and 1280×800, console errors, horizontal scroll, viewport headshot hit rate → `docs/nba-ui/p2-*.png` + `p2-browser-report.json` |

## Features

- **List**: hero search with accent-insensitive autocomplete (`/api/nba/search`, 150 ms debounce, ↑/↓/Enter/Esc, `role=combobox`/`listbox`); the same text filters the table (`q`). Position-slot chips PG SG G SF PF F C UTIL (multi-select, Yahoo slot eligibility → API `slot=`; UTIL = everyone). Team, health (healthy / injured / day-to-day / out), Yahoo-only switch, sort select (17 plain-English sorts) + direction toggle. Desktop: inline tools row. Phone: sticky search bar + "Filters" button → bottom sheet (thumb zone) with a count badge.
- **Trending strip** (Sleeper adds/drops, 24 h; falls back to "form swings" when the API says `derived`), segmented Adds/Drops, tap → detail. Players not in the league pool are shown dimmed, not linked.
- **Table** ≥768 px: sticky header (against the page), sortable headers with `aria-sort`, rank, headshot (+ injury dot), name link, Yahoo position pills, team logo, injury badge, source tag (Rookie / Yahoo only / Projection only), Best gm (hsValue), Avg, Ceil, Floor, Form (▲/▼ last-5 vs season), Market rank + Value/Reach badge, Yahoo pre-rank, %Ros. Columns drop by container width (container queries) so it fits beside the detail pane. **Phone card rows**: 56 px headshot, pills, team, injury, big Best-gm number, 6 mini stats (Avg, Ceil, Floor, Form, Mkt, Y!).
- Server-side pagination (50/page, ≤ 50 rows in the DOM), skeletons on first frame, empty state with "Clear search and filters", error callout with retry. Images lazy-load; first six trending headshots eager.
- **URL state**: `?q ?pos ?team ?inj ?src ?sort ?dir ?page ?player` (defaults omitted). `?player=<id>` deep-links the detail (pane on ≥1024, full-screen sheet on phones, wide modal 769–1023). Opening pushes history, so the phone Back gesture closes the sheet; deep links close with replaceState.
- **Detail** (pane or sheet, same markup): team-tinted hero (128/112 px headshot with team-logo badge, tier, board rank, position rank, source tag, name, Yahoo positions, team, jersey/height/weight/age/seasons/college, Yahoo slot eligibility), injury strip with body part + notes + "updated Xd ago". Tabs (`role=tablist`, arrow keys, sticky in the sheet):
  - **Overview**: 6 tiles (Best game, Avg game, Ceiling, Floor, Boom rate, DD rate + TD), floor–ceiling band with the mean, generated plain-English scouting report, next 4 matchup weeks (dates, games, opponents with home/away + logos, back-to-back flags, 14-day weeks 7 and 17 tagged), market vs model block with a sentence ("The model likes him more than the market…"), similar players (tap to switch).
  - **High Score**: the one focus card: next matchup week, expected best game, P(best game ≥ 40/50/60/70) chips (toned), injury availability warning; best game of every week last season (bar series, average line, bars at/above his best-game value highlighted) + summary tiles; histogram of every game (`NbaUI.histogram`) with mean marker; boom/bust/DD/TD counts.
  - **Games**: last 10 (date, opponent, MIN PTS REB AST [+STL BLK TO ≥421 px], league score with DD/TD tags), season line vs 2026-27 projection under league scoring, home/away splits.
  - **News**: Rotowire via Sleeper (title, time ago, description, expandable analysis); "No recent news" empty state; injury callout on top.
  - Footer: data freshness ("Model data 12m ago · page built …"). Header tag "Data Xm ago" from `/research/meta`.
- Missing data is never invented: sections the API marks `unavailable` show a quiet "Unavailable" tag + the API's reason (Westbrook: no logs / schedule model / news; rookies: no logs).
- "How it works" sheet: glossary in beginner basketball language (best-game value, High Score, ceiling/floor, form, boom, DD/TD, market, back-to-back, 14-day weeks, scoring weights).

## Verification (real server `PORT=7982`, real data, 2026-10-14)

- `python3 scripts/nba-p2-screens.py` → 31 PNGs `docs/nba-ui/p2-*.png` (list, search "jokic", filter C + sort ceiling, filter sheet, Jokić/Flagg/Butler (OUT, knee surgery)/Westbrook (Yahoo-only) detail + each tab, page 2 scrolled) at both sizes; click-open + Back closes the sheet.
- No horizontal scroll in any state. No JS errors. Only console noise: `401 /api/nba/yahoo/status` from `yahoo-chip.js` when signed out (not this page's code).
- **Headshot hit rate in the viewport: 169/177 avatars loaded (95.5%)**, 0 image errors; the 8 misses are all Russell Westbrook (Yahoo-only, no Sleeper/ESPN id) rendering team-tinted initials as designed.
- Tests: `node scripts/test-nba-research-ui.js` exit 0 (25/25); all `scripts/test-nba-*.js` exit 0; `npm test` exit 0.

## Design-system requests (for U0 / nba-ui)

1. **`#app` width bug**: `shared/styles.css` has `#app { max-width: 900px }`, which beats `.nba-ui .nu-shell` (id > class). Every page following the doc (`<main class="nu-shell" id="app">`) is capped at 900 px. research.css works around it with `.nba-ui #app.rs-shell`; fix centrally with `.nba-ui #app.nu-shell { max-width: var(--nu-max); padding: … }`.
2. **`.nu-sheet--full`**: full-screen variant for phones (top 0, 100dvh, no radius) with a sticky back bar. research.css `.rs-sheet-full` + `.rs-detail-bar` is the reference.
3. **Combobox/autocomplete list** (`.nu-ac` + `NbaUI.combobox(input, { fetch, render, onSelect })`): research.css `.rs-ac`.
4. **Probability chips** (`.nu-prob[data-tone=good|mid|low]`): `.rs-prob`. Also useful on Lineup.
5. **Bar series chart** `NbaUI.bars(values, { w, h, highlightFrom, avg, labels })`: research.js `weeklyChart` + `ResearchLogic.weeklyBars`.
6. **Schedule week card** (`.nu-week`: dates, game count, opponents with home/away + logo, B2B, long-week tag): `.rs-wk`. Lineup/Waivers could share it.
7. `.nu-table` sticky header only sticks inside `.nu-table-wrap` (it has `overflow-x:auto`); add `.nu-table-wrap--page` (overflow: clip, `th { top: var(--nu-nav-h) }`).
8. `NbaUI.statTile` sub text wraps to two lines at 120 px tiles; a `--compact` tile size would help 3-up grids in 400 px panes.
9. `posRanks` key in the API is the legacy slot (`F` for Jokić), so the hero shows "Pos #1" without a position name.

## API requests (for R0)

1. `value.posRanks` uses legacy eligibility (`{"F":1}` for a C-only Yahoo player). Please key it by the Yahoo position list.
2. Yahoo-only players: `headshot` (Yahoo `headshot.url`) and `espnId` would lift the remaining initials (Westbrook) to photos; CSP `img-src` must then allow `a.espncdn.com` / `s.yimg.com` (see design-system doc §6).
3. Injured stars: `hsValue` (availability-weighted) can be below `mean` (Butler 27.0 vs 31.2). The page labels it "lowered by injury"; a `value.hsValueHealthy` field would let us show both.
4. `similar[].reason` is model wording ("HS value … pts/game"); the page rewrites it client-side. Structured fields (`mean`, `cv`) on similar entries would be cleaner.
5. `/api/nba/research` row: `posRank` position label (e.g. `posRankPos`) for the table tooltip.

## Not done / follow-ups

- "Add to compare" mini-interaction (optional) skipped for the time box.
- Infinite scroll: chose server pagination (50/page) to keep DOM ≤ 50 rows without virtualisation.
- `docs/nba-design-system.md` §5 template B shows list | detail; this page puts the detail on the right (like the NFL page) because the table is the primary surface.
