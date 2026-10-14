# Stream D handoff: NBA weekly lineup picker

Branch `nba-d-lineup` (base `nba` @ 4313300). Rules, method and API are in [docs/nba-lineup.md](nba-lineup.md).

## Files (all stream-D owned except one line)
| File | Purpose |
|---|---|
| `nba/model/lineup.js` | Pure optimiser `recommend()`. Exact DP slot assignment, banked floors, forfeit warnings, locks, back-to-back rest risk, seeded MC band and win probability. |
| `nba/routes/lineup.js` | `GET /api/nba/lineup` (Clerk auth, Yahoo roster + opponent) and `POST /api/nba/lineup/manual` (no auth, rate- and size-limited). |
| `nba/router.js` | **One line**: `router.use(require('./routes/lineup')({ auth, getAuth, apiCached, loadModel, modelPlayers, clientFor, sendYahooError, log }));` |
| `nba/pages/lineup.html`, `lineup.js`, `lineup-logic.js` | Replace the placeholder. Mobile-first picker with Yahoo/manual modes. |
| `scripts/test-nba-lineup.js` | 25 tests, exit 0 (offline). |
| `scripts/nba-lineup-mock.js` | Dev mock. Uses the real model and real routes, with a fake Yahoo client and a signed-in user. |
| `docs/nba-ui/lineup-*.png` | `yahoo-midweek-375/1280`, `manual-375/1280`, `empty-375`, `search-375`. |

## Run
```
node scripts/test-nba-lineup.js                          # exit 0
node scripts/nba-lineup-mock.js --port=4879 --yahoo=on    # http://127.0.0.1:4879/nba/lineup?week=2&day=3
```
I took the screenshots with Playwright from a scratch script outside the repo. It checked for page errors and horizontal overflow at 375px and found none.

## Adapters / cross-stream notes
- **Thin adapter for A:** `getOpponentKey()` in `nba/routes/lineup.js` uses `client.request('team/{key}/matchups;weeks=N')`, because the client has no matchups method. G may want to move this into `nba/yahoo/client.js` with a fixture.
- **Imported from B:** `availability()` from `nba/model/board.js` and `normCdf`/`stdNormMax` from `stats.js`. The route also reads week date windows from `require('../model/data').load().proj.weeks`.
- `/nba/routes/*` is covered by A's static deny rule. The test asserts `/nba/routes/lineup.js` returns 404.
- **`package.json` is untouched.** Add `node scripts/test-nba-lineup.js` to `npm test` at integration (the lead does this, per contract). `npm test` currently exits 0.

## Gaps
- Banked scores are typed in by the user, not fetched from Yahoo per-day stats.
- The plan is static from today to Sunday. It doesn't do conditional daily swaps.
- Back-to-backs are estimated without team dates, and the rest-risk rates are heuristic.
- The Yahoo matchups shape is unverified, and the live OAuth path hasn't been run against a real High Score league.
- IL slot count is unverified (sources say 2 or 3). The picker never starts IL players either way.
