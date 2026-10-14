# Checker report: stream F (waivers / streaming), 2026-10-13

Branch `nba-f-waivers`. I reviewed the Maker's work at 7e008e2 and made the fixes below on top of it. Nothing was pushed or deployed.

**Verdict: PASS-after-fixes**

## Evidence (re-run by the checker)
| Check | Result |
|---|---|
| `node scripts/test-nba-waivers.js` at 7e008e2 | exit 0, 19 passed |
| `node scripts/test-nba-waivers.js` after fixes | exit 0, 24 passed. The 5 new regression tests fail on the old engine and route (checked by restoring the 7e008e2 files: 19 passed, 5 failed). |
| `npm test` (before and after) | exit 0, both times |
| `test-nba-yahoo.js` / `test-nba-model.js` / `test-nba-ui.js` | exit 0 each (35 passed / 18 checks / 31 passed) |
| `git diff nba...HEAD -- nba/router.js` | one line, the mount before `return router` |
| Browser (Playwright Chromium, mock `--yahoo=on` :4793 and `--yahoo=off` :4794) at 375×812 and 1280×800 | 9 scenarios × 2 widths: Yahoo, manual, manual-empty, API 500 JSON, API 500 HTML, 6 s slow API, empty pool, all unmatched, mid-week flags. No horizontal scroll, no NaN/undefined text, no page errors. The only console errors are the browser's own "Failed to load resource" lines for the 500s I injected on purpose. Screenshots were inspected by eye. |

### Break tests I wrote (scratch, then promoted to regression tests where they failed)
- **Schedule, numerically:** for equal talent (mean 25, sd 9, availability 0.85), E[max] is 28.1 over 2 games and 33.1 over 4. The ranking follows the schedule at horizons 1/2/4 (Maker test confirmed).
- **Season end:** startWeek = last week with horizon 4 gives `weeks=[last]`. A startWeek past the end gives `weeks=[start]`, all values 0, finite.
- **Garbage, empty, duplicate and unknown inputs:** `{}`, null roster/pool, null ids, NaN `hsByWeek`, string games, horizon 'abc', startWeek −5, and garbage `midWeek` all stay finite. **Duplicate pool rows produced duplicate targets: fixed.**
- **Determinism:** 20 shuffles of roster and pool on the real board (with `midWeek` and `ilIds`) give byte-identical JSON. A 4-week horizon on the full board runs in 23 ms.
- **Routes:** malformed JSON gives 400 JSON. A 1200-id body gives 413 JSON. `__proto__`/`toString` ids are reported as unknown (200). An array body, object ids, or `week: "2.5"` gives 400. `text/plain` gives 400. Requests 31+ in a minute get 429 with `Retry-After: 60`. The Yahoo route returns 401 with no auth. A duplicated `league_key` query param gives 400. No stacks or tokens appear in any body. `trust proxy` is set in server.js, so the per-IP limit isn't shared behind Railway.

## Fixes (commits on this branch)
| sha | Defect | Fix |
|---|---|---|
| a2616d8 | **Mid-week adds counted the full week's games.** Real board, Thursday of week 3 (3 of 7 days gone): the old #1 target showed **+9.1**, but with games-left accounting it is **+0.1** (rank 4). A 4-game free agent with 1 game left is worth 22–26 instead of 40–44 (Turner 39.6 → 24.4, Nurkić 43.5 → 21.6). This misleads every add made after Monday. | The route's `midWeekFrom(data, now)` gets each team's games already played in the current model week. It uses this season's logs when they run through yesterday, otherwise the week's games × share of days gone (with logs as a floor). The engine rescales a free agent's week value to the games left, keeping B's calibration via an E[max] ratio. Roster players keep their whole week. Drops whose team already played are flagged `bankedGames`, and the page shows "played N" / ⚠. |
| a2616d8 | **IL slots ignored.** The Yahoo roster's `selected_position` was never read. With 9 active + 1 IL and roster size 10, the engine said "no open spot" and suggested a needless drop. It could also suggest dropping the IL-slot player as the swap, which frees no active spot in Yahoo. | IL-slot players don't count toward `openSpots`, are never the drop half of a swap or pair, and are badged **IL** in drop candidates. They still get injury-replacement suggestions. |
| a2616d8 | Engine didn't dedupe pool rows. The route already did, so this was engine-only. | Pool deduped by id. |
| 0365c58 | With an empty pool or an all-unmatched roster, the best-move card said "Your bench already covers the free-agent pool". | It now says "No free agents to rank", plus a pointer to Not matched when roster players are unmatched. Docs updated (method + handoff gap). |

Regression tests added to `scripts/test-nba-waivers.js`: mid-week games-left ranking flip and `bankedGames`; `midWeekFrom` logs/estimate/null; IL slot (open spot, never the drop, still gets injury replacements); pool dedupe; Yahoo route reading `selected_position: 'IL'`.

## Yahoo rules re-verified (all 5 URLs fetched 2026-10-13, all 200)
- SLN37162: 10 players / 6 starters (G, G, F, F, F, Util), scoring 1/1/2/3/3, best single game, and benching forfeits earlier games. All stated. It says **nothing about waivers or IL slots**, so High Score using standard waivers and IL slots is an inference (the doc already says so for waivers).
- SLN8828: weekly/continuous/none rules, Tuesday 11:59 PT, default "Game Time – Tuesday", continuous default 2 days with no same-day add, FAB $100 / $1–$999 / blind / no replenish. All stated. Caveat: the page's title reads "Overview of Waivers in Fantasy Football", and the "None" rule says a player "needs to be added by 11:59 p.m. PT Sunday" to play for the current game week. If that applies literally to basketball, a mid-week FA add earns **nothing** that week. The games-left model sits between "full week" and that reading. It needs confirming on a real High Score league.
- SLN6811: dropped-player freeze 0–7 days (default 2), same-day add/drop stays FA, window starts the next day. All stated. Caveat: SLN6811 says the FAB range is $1–$999,999,999 with ties broken by the Continual Rolling List. SLN8828 says $1–$999 with the tiebreak chosen by the commissioner. The two Yahoo pages disagree; the doc cites SLN8828.
- SLN6981: season and weekly (H2H only) acquisition limits. Stated.
- `/nba/details/waiver_type`: "Continual rolling list", "FAB w/ Continual rolling list tiebreak". Stated.

## Unfixed issues (ranked)
1. **The Yahoo FA pool is the first 100 FA + 25 W in Yahoo's default sort.** The client has no `sort` param, and the client is owned by A/G. Bias: the pool tracks Yahoo's overall/preseason rank, so schedule streamers and fresh role breakouts ranked below ~100 are invisible, and those are exactly the players this page exists to find. The W list is capped at 25. This is documented in the handoff gaps but not shown in the UI. Recommend that G add `sort=AR` / `sort_type=lastweek` support and pull a second sorted slice.
2. **`is_undroppable` isn't parsed** (`nba/yahoo/parse.js`, A/G). Yahoo marks some players undroppable (the fixture has Jokic `is_undroppable: "1"`), and the engine can suggest dropping one.
3. **Week numbering:** hsByWeek and the mid-week detection use Sleeper model weeks, but `weekDates` is overwritten with Yahoo `league.weeks` when present. If Yahoo's week N differs from Sleeper's (Sleeper week 7/8 around the NBA Cup look irregular: 11-30..12-03, then 12-12..12-13), labels and the values behind them can describe different date ranges. This is B/A territory and needs a Yahoo→model week map.
4. **Mid-week precision:** with no per-day schedule, the stale-log fallback is a days-gone estimate. Today's games are treated as still addable (no lock-time check). W-status players under weekly waivers lose more days than an FA, and this isn't modelled.
5. **Manual mode's default pool is every non-roster player**, so the best move is often "add Jokić". The banner tells the user to hide rostered players, but the first impression is misleading.
6. The depth credit (0.12/0.06) and keeper margin (4) aren't backtested. The rate limiter is in memory and per instance. Both are already listed by the Maker.
