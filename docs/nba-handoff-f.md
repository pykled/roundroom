# Stream F handoff: waivers and streaming

Branch `nba-f-waivers`, based on `nba` @ 4313300. Only stream-F files were touched, plus **one line** in `nba/router.js`, the mount before `return router`.

## Files
| File | Purpose |
|---|---|
| `nba/model/waivers.js` | Pure engine: `analyzeWaivers`, `bestLineup` (exact G,G,F,F,F,UTIL DP), `rosterWeekValue`, `roleSignal` / `roleSignalsFromData`, `longRun`. |
| `nba/routes/waivers.js` | `GET /api/nba/waivers` (auth, Yahoo-first), `POST /api/nba/waivers/manual` (rate and size limited), `GET /nba/waivers` (page). |
| `nba/pages/waivers.html`, `waivers.js`, `waivers-logic.js` | Mobile-first page. The logic module is UMD and tested. |
| `scripts/test-nba-waivers.js` | 19 tests: engine, keeper rule, role signal, NaN fuzz, determinism, page logic, routes with a mocked client, and a mount through the real `nba/router.js`. |
| `scripts/nba-waivers-mock.js` | Dev server: real model board plus real routes, with fake Yahoo and auth. Run `node scripts/nba-waivers-mock.js --port=4793 --yahoo=on`, then open `/nba/waivers`. |
| `docs/nba-waivers.md` | Verified Yahoo rules with URLs, plus the method. |
| `docs/nba-ui/waivers-*.png` | Screenshots at 375×812 and 1280×800: a manual-empty, b manual, c yahoo, d 4-week + F filter + expanded row. |

## Verify
- `node scripts/test-nba-waivers.js` → 19 passed, exit 0.
- `npm test` → exit 0.
- Browser checks (Playwright, scratch script outside the repo): no page errors, no horizontal scroll at 375, no NaN/undefined text, controls ≥34px, search finds players, Role ↑ filter shows only badged rows.

## For integration
- Add `node scripts/test-nba-waivers.js` to `package.json` `test`. I didn't touch the shared file, to avoid merge conflicts.
- The nav on other NBA pages (draft and lineup, owned by C/D/G) has no "Waivers" link yet. Only `waivers.html` has one.
- When D ships `nba/model/lineup.js`, `bestLineup` here can be swapped for it. The semantics are the same: slot caps 2/3/1 and UTIL takes anyone.

## Gaps
- **Mid-week adds:** fixed by the checker (a2616d8): adds count only their team's games left. There's still no per-day schedule, so the stale-log fallback is a days-gone estimate, and Yahoo's add timing (waiver period, W players not addable until claims clear) isn't modelled.
- No FAB bid suggestion, and no enforcement of weekly or season add limits (we return them when Yahoo provides them).
- Yahoo FA pull is the default-sorted first 100 FA plus 25 W, because the client has no `sort` parameter (G owns the client). Deep sleepers beyond that aren't seen.
- Role signal is stale in preseason (all games are from last season), so no badges until games are played. The mock injects demo logs for the screenshots.
- High Score waiver settings are inferred from the standard basketball help pages (SLN37162 is silent). The Yahoo `waiver_*` fields are unverified on a real High Score league.
- The depth credit (0.12/0.06) and keeper margin (4) are judgment calls and weren't backtested.
- The rate limiter is in memory and per instance.
