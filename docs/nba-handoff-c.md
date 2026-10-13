# Stream C handoff: NBA draft board UI

Branch `nba-c-ui`. Only stream-C files were touched: `nba/pages/*`, `scripts/test-nba-ui.js`, `scripts/nba-ui-mock.js`, `docs/nba-ui/*`, this doc. Nothing in A's files (router, yahoo, server.js, nav.js) or B's (`nba/model`).

## What exists
| File | Purpose |
|---|---|
| `nba/pages/draft.html` | Draft board page (`/nba`, `/nba/draft`). Shared chrome (`/shared/styles.css`, `/shared/nav.js`, footer). Page-only CSS is inline, following the NFL pages. |
| `nba/pages/draft.js` | Controller: state, rendering, Yahoo status/league/draft polling, sheets, settings, persistence. |
| `nba/pages/draft-logic.js` | Pure UMD module (`window.NbaDraft` / `require`). Covers snake order, slot assignment (G,G,F,F,F,UTIL with dual-eligibility swaps), best-available (VONA + ceiling bias + injury discount, with a one-line reason), balance and scarcity warnings, Yahoo/manual pick merge, Yahoo `roster_positions` → settings, localStorage serialisation, poll backoff. |
| `nba/pages/lineup.html` | An honest "weekly lineup picker, coming next" placeholder using the shared chrome. |
| `scripts/test-nba-ui.js` | 31 plain-node tests for draft-logic. `node scripts/test-nba-ui.js` → exit 0. |
| `scripts/nba-ui-mock.js` | Dev mock (express): serves pages and `/shared`, a 119-player fixture in the contract `Player` shape, and contract-shaped `/api/nba/yahoo/status|league|draft|roster` + `/api/nba/health`. |
| `docs/nba-ui/*.png` | Screenshots at 375 and 1280: `a-empty`, `b-mid-draft`, `c-live`, `d-degraded`, plus `b-player-sheet-375`, `c-live-team-sheet-375` (review drawer) and `lineup-375`. |

## Behaviour
- **Manual mode** (no Yahoo, or not signed in, because any status error is treated as not connected). Settings default to 10 teams, slot 1, 2G/3F/1UTIL, 4 bench. Changing them through the League dialog persists. Tapping **Draft** marks the player taken by the team on the clock; when you are on the clock the button reads **Take** and the pick is yours. The player sheet adds explicit **Mine** and **Other team** buttons. In Recent picks, ★ flips whether a pick is yours and ✕ removes it. Undo (button or ⌘/Ctrl-Z) drops the last locally marked pick. State lives in `localStorage['pocket-nba-draft:<league_key|manual>']` and syncs across tabs through the `storage` event.
- **Yahoo-first.** When `status.connected` is true, a league picker appears. The default is the remembered league, otherwise the first league that hasn't drafted; "Manual board" is also an option. Settings come from `/league` (`num_teams`, `roster_positions`, plus `teams[].draft_position` for my slot, or my first Yahoo pick as a fallback). The page polls `/draft` every 4s, pauses while the tab is hidden, and backs off 8/16/30s on errors. The pill reads "Live from Yahoo · updated Ns ago". After 2 failures, or a failure before any success, it switches to the degraded pill plus a banner with the error, a retry countdown and **Retry now**, and manual tracking keeps working.
- **Merge rule.** Yahoo picks are the truth, placed at their pick numbers. A local pick of a player Yahoo has since picked is confirmed and pruned. Other local picks are appended after Yahoo's last pick and flagged **PENDING**. Yahoo picks with `sleeperId:null` count as drafted (name only) and show in the purple **review drawer**. **Match** lets you tap the right board player, which saves an override (`player_key → id`).
- **Phones (≤900px).** The side panel becomes a bottom sheet behind a sticky mini-bar (6 slot pips, clock status, top warning, My team button). Player detail is a bottom sheet. On desktop it is a centred card. The clock drops its snake ticker once the header scrolls away. Tap targets are ≥44px, inputs are 16px, and there is no horizontal scroll at 375 (checked in the shot script). `prefers-reduced-motion` swaps slides for fades and removes the pulse and flash. `prefers-reduced-transparency` makes the blurred bars solid.

## Run it
```
node scripts/test-nba-ui.js                       # exit 0
node scripts/nba-ui-mock.js --port=4791 --yahoo=off   # http://127.0.0.1:4791/nba
#   --yahoo=on | live | degraded, --interval=3 (seconds per simulated pick)
curl -XPOST '127.0.0.1:4791/__mock/mode?yahoo=live&interval=2&reset=1'
curl -XPOST '127.0.0.1:4791/__mock/advance?n=9'   # every 9th pick is an unmatched name
```
The mock's `/nba/auth/login` simulates connecting (mode becomes `on`). The screenshots and browser assertions were driven with Playwright from a scratch script outside the repo. The assertions cover pick/undo, settings persistence, accent-insensitive search, the G filter, Yahoo settings load, the PENDING flag, degraded → retry recovery, the unmatched match flow, and no page errors.

## Notes for integration / known gaps
1. **Router (A):** the page loads `/nba/pages/draft-logic.js` and `/nba/pages/draft.js`, so A must serve `nba/pages/*` statically at `/nba/pages/`. The page has `PUBLISHABLE_KEY_PLACEHOLDER` like the NFL pages. If A's handler substitutes it, Clerk loads (user button / Sign In). If not, Clerk is skipped. `/api/nba/yahoo/*` relies on the Clerk session cookie (`credentials: same-origin`).
2. **Nav switch:** both pages have a static NFL | NBA switch, `#rr-sport-switch`, linking to `/nfl` and `/nba`. If A's nav helper injects its own, it should replace this element to avoid two switches.
3. **Shape assumptions** (the contract leaves them loose; the parsing is defensive):
   - `league.roster_positions` can be `[{position,count}]`, strings, or a map. `Util` and any other non-G/F starter position count as UTIL; `BN` is bench; `IL*` is ignored.
   - `teams[].draft_position` is used for my slot when present.
   - `unmatched[].name` can be `{full}` or a string.
4. **Model (B):** the board sorts by `rank`, then `hsValue`, and draws tier dividers from `tier`. The UI never computes value itself. It shows `games` (this-week chip), `ceiling`/`floor`, `injury` and `source` (rookie / projection-only note). Centers come in through `elig` as B defines it; the mock maps C → F.
5. **Gaps:**
   - No pick timer, because Yahoo's per-pick clock isn't in the contract.
   - Keepers and traded picks aren't modelled: on-the-clock assumes a pure snake, while Yahoo picks themselves still land by pick number.
   - Best-available assumes the other teams take the top-k by value before your next pick. There is no ADP feed.
   - The unmatched "Match" override is stored per device only.
   - `lineup.html` is a placeholder.
   - Tests aren't in `package.json` (the lead adds them at integration, per the contract).
