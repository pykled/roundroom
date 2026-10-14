# Stream P1 handoff: Draft Board UI rebuild (`/nba`)

Branch `nba-p1-board` (off `nba-v2`, `nba-u0-design` merged in). Nothing pushed or deployed.

## Files
- `nba/pages/draft.html`: rewritten on the design system (`nba-ui.css` + `NbaUI`, `NbaUI.mountNav({active:'board'})`, so the Research tab and the mobile tab bar are on the page).
- `nba/pages/draft.js`: render layer rewritten. State, Yahoo sync/poll/degraded/auction, clock, timer, persistence, undo, match flow and settings logic are carried over line for line.
- `nba/pages/draft-board.css` (new): board-only widgets, `--nu-*` tokens only, scoped under `body.nd-page`.
- `scripts/nba-p1-e2e.py` (new): full-draft browser check (details below).
- Not changed: `draft-logic.js`, `scripts/test-nba-ui.js` (no DOM assertions needed changing), `scripts/nba-ui-mock.js`, `nba-ui.css` / `nba-ui.js`.

## Critique → fix
| # | Before | After |
|---|---|---|
| 1 | The board sat under 4 stacked boxes | The board leads: a compact head, then a **one-line status** (sync pill · slot · rounds · pick time · Edit), the sticky clock, the reco card and the list. The full setup card shows only on a first visit (not connected, no picks, not dismissed) and has a ✕. |
| 2 | Connect Yahoo appeared 3 times | The nav chip is the control. A second Connect button appears only inside the first-visit setup card. The header button is gone. |
| 3 | Rows were text only | Every row has a headshot (`NbaUI.avatar`, Sleeper → initials fallback for Yahoo-only players), a team-logo badge, Yahoo position pills (dashed + `?` when not Yahoo-confirmed), injury badge and games per week. |
| 4 | 24 tiny pick boxes | "You pick in N · #x, then #y" plus a dot timeline from now to my following pick. Round turns are marked; my picks are labelled orange pills. Yahoo order is used when connected. |
| 5 | Roster panel cut off | **Desktop:** a sticky roster column with 9 starter slots (slot pill + avatar + value), dashed open slots, amber "Open · catch up", then BN/IL and recent picks. **Phones (<1024):** a thumb bar showing slot pips, on-the-clock state, the timer and a one-tap **Draft <name>**; tapping it opens a My team sheet. |
| 6 | Repeated "X is drying up" cards | One **Running low** strip. It shows only warn/danger items plus position runs; each chip filters the board to that slot. |
| 7 | Flat chips | Slot chips show live top-40 counts (amber = thin, red dot = run). Also: tier filter, search, Hide OUT, Show drafted, and a new **Sort** (board rank / value / ceiling / VORP / market / Yahoo rank, saved in `pocket-nba-board-sort`). |
| 8 | Hierarchy | The recommendation is the only `nu-card--focus`. On the clock, only the reco row's Take button is solid orange; the other rows are soft orange. Desktop is a dense grid table with a sticky header; phones get card rows. |
| 9 | Settings etc. | League settings, How it works, Cheat sheet (Board/Cheat segmented control, also `c`), Undo (clock bar, `⌘Z`), draft slot (League sheet + status "Edit") and the pick clock are each one tap away. Settings and How it works are now `NbaUI.sheet`s. |

**Player sheet** (`NbaUI.sheet`, wide modal on desktop, bottom sheet on phones) shows:
- the headshot, pills, team logo, tier and Yahoo position string;
- "Why now";
- tiles for value, ceiling, floor and VORP, plus a floor–ceiling range band;
- loaded lazily from `/api/nba/player/:id` (cached per player): last season's per-game line (PTS/REB/AST/STL/BLK/TO, GP, MPG; projection line for rookies), a best-game-per-week **sparkline**, a single-game histogram, and the injury status and notes;
- board, position, market and Yahoo rank, with % rostered;
- a **Full profile →** link to `/nba/research?player=<sleeperId|y<pid>>`.

**Performance.** Rows are keyed DOM nodes, built once per player. Each render only patches row state and reorders, so headshots never reload and a pick doesn't rebuild 400 rows.

## Kept / no-regress
- Every logic call in `draft-logic.js` is unchanged, as are the storage keys (`pocket-nba-draft:*`, league, timer, firstrun prefs), so saved boards still load.
- Exported APIs are unchanged.
- These IDs and hooks still exist for the existing scripts: `#nd-timer`, `#nd-firstrun`, `name=timer`, `#nd-settings-btn`, `#nd-settings-form button[value=save]`, `#nd-reco button[data-act=mine]`, `.nd-reco-why`, `.nd-fill`, `.nd-draft[data-act=draft][data-id]`, `#nd-search`, `#nd-undo`, `#nd-pick`, `#nd-of`, `#nd-picks .nd-pick`, `#nd-warns`.
- Static copy hooks are kept: `h1.page-title`, `ol.nd-about-list` (5 items), and a static nav fallback inside `[data-nu-nav]` (`#rr-nav` with the tool links, swapped by `mountNav`).
- Clerk's sign-in and user button are injected into the NbaUI nav's `.rr-auth`.

## Verification (real server `PORT=7981`, `.env.local`, real `/api/nba/players?profile=242808`)
- `python3 scripts/nba-p1-e2e.py --w 1280 --h 800 --tag 1280`: exit 0, 46 checks. `--w 375 --h 812 --tag 375`: exit 0, 47 checks.
  - The script runs a full 12-team, 14-round, 168-pick draft through the UI. I'm slot 5, taking the reco via the one-tap button; the other teams draft by market rank plus noise via row taps.
  - It checks: the countdown, the "You pick in N · #x, then #y" text, the timeline, undo, filters (C, Hide OUT, sort, search, tier), sheet detail and link, the phone team sheet, reload persistence, the cheat sheet, draft completion and 14 roster slots filled.
  - It also covers Yahoo-connected (stubbed `/api/nba/yahoo/*`, real players): live sync of 40 picks, then on the clock for my Yahoo pick, then degraded (503) with a manual pick flagged PENDING.
  - No console errors besides the expected logged-out 401 (and the stubbed 503s). No horizontal scroll in any shot.
  - **Tap→next-frame p95: 80.9 ms (1280), 65.9 ms (375)** over 170 taps.
- Unit tests (`; echo exit=$?`), all exit 0:
  - `test-nba-ui.js`: 77
  - `test-nba-copy.js`: 264
  - `test-nba-ui-kit.js`: 108
  - `test-nba-hardening.js`: 31
  - `test-nba-yahoo.js`: 62
  - `test-nba-cheatsheet.js`: 63
  - `test-nba-integration.js`: 7
  - `npm test`: exit 0
- Screenshots in `docs/nba-ui/p1-{1280,375}-{first,settings,empty,clock,filters,mid,sheet,late,cheat,done,yahoo,yahoo-clock,degraded}.png`, plus `p1-375-team.png`.

## Risks / notes
- `scripts/nba-int-draft.py` (not mine) clicks `#nd-reco button[data-act=mine]`. On phones (<1024) that button is hidden on purpose, because the thumb bar carries the one-tap Draft (`#nd-mb-act button[data-act=mine]`). At 1280 the script works unchanged.
- The status-row league `<select>` is hidden on phones; the nav chip's league picker is used there.
- The roster column shows at ≥1024px; 769–1023px uses the thumb bar and sheet, like phones.
- Toasts: only one shows at a time. Other teams' picks have no Undo action (Undo stays in the clock bar).
- Not checked on a physical phone: Chromium device emulation only.

## Design-system requests (for U0)
1. `NbaUI.toast` could return the active toast, or offer a `replace: true` option, so pages don't have to track and dismiss their own "one at a time" toasts.
2. A `.nu-pos--est` (dashed, unconfirmed eligibility) variant. The board defines `.nu-pos.is-est` locally.
3. `sparkline` / `histogram` could take a `responsive: true` option (width 100%). The sheet currently sets `svg { width:100%; height:auto }`.
4. `.nu-chip-row--scroll` with a `display:contents` child group works, but a documented "chip group with live count + run dot" pattern (slot filter) would let Waivers and Research reuse it.
