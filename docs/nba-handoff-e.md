# Stream E handoff: NBA trade calculator

Branch `nba-e-trade` (base `nba` @ 4313300). Method: `docs/nba-trade.md`.

## Files (all new except one line in the router)
| File | Purpose |
|---|---|
| `nba/model/trade.js` | `evaluateTrade(...)`. Pure and deterministic. Includes its own exact lineup DP `bestLineup(items, slots)`. |
| `nba/routes/trade.js` | `GET /nba/trade` (page), `POST /api/nba/trade/evaluate`, `GET /api/nba/trade/context`. |
| `nba/router.js` | **one line**, just before `return router`: `router.use(require('./routes/trade')({ auth, getAuth, apiCached, modelPlayers, matcher, clientFor, sendYahooError, env, log }));` |
| `nba/pages/trade.html`, `trade.js`, `trade-logic.js` | UI. `trade-logic.js` is the pure UMD helper (`window.NbaTrade`). |
| `scripts/test-nba-trade.js` | 21 checks, exit 0. Covers the model, the UI logic and the routes (mocked client, plus the real router mount). |
| `scripts/nba-trade-mock.js` | Dev server: real offline model and real routes, fake Yahoo (10-team league, one unmatched player). `--yahoo=on|off`. |
| `docs/nba-ui/trade-*.png` | 375 and 1280 shots: `a-empty`, `b-manual` (2-for-1), `c-yahoo` (partner picked). Also `d-vbar-375` (sticky verdict bar) and `e-search-375`. |

## API
- `POST /api/nba/trade/evaluate`. Public. Limits: 40 requests/min per IP (429 + Retry-After), body ≤ 16 KB (413), give/get ≤ 6, rosters ≤ 25, `leagueRostered` ≤ 400.
  - Body: `{ give[], get[], myRoster[], partnerRoster?, leagueRostered?, settings?: {teams, rosterSize, slots, playoffStartWeek, endWeek, playoffWeight}, league_key? }`.
  - Ids are Sleeper ids or Yahoo `player_key`s. Keys need a signed-in user plus `league_key`, otherwise 400 `player_keys_need_yahoo`.
  - With `league_key` and a signed-in user, league settings (roster shape, playoff start, end week) and league rosters (replacement level) are filled in automatically. If Yahoo fails, it still answers with a warning.
  - Response: `{ verdict: 'Accept'|'Counter'|'Decline'|null, headline, you:{perWeek, perWeekRange, ros, rosRange, …}, them:{…, estimated, likely}, weeks[], lineup:{before, after, changed}, players[], roster:{you, them}, consolidation, why[], replacement, meta, warnings[], asOf }`.
- `GET /api/nba/trade/context?league_key=&team_key=`. Behind Clerk `auth`, cached 60 s per user and league. It makes `getLeague` + `getTeams` + one `getRoster` per team, which is about 2.5 s cold for 12 teams because of the 200 ms limiter.
  - Returns `{ league:{…, playoff_start_week, settings:{teams, slots, rosterSize}}, myTeamKey, teams:[{team_key, name, mine, players:[{player_key, sleeperId, name, selected_position, status}]}], unmatched[] }`.
  - Yahoo errors go through the router's `sendYahooError` (409 / 429 / 502).

## Merge notes / dedupe
1. **Lineup optimiser:** stream D's `nba/model/lineup.js` was not in this tree. `trade.js` has its own `bestLineup` (exact DP, about 30 lines). If D exports an exact G/F/UTIL optimiser with per-week values, swap it in at merge. The tests compare against brute force, so they will catch a non-exact replacement.
2. **Nav:** the trade page's nav has Draft · Lineup · Trade. `draft.html` and `lineup.html` (C's files, which only G may edit) don't link to `/nba/trade` yet. G or the lead should add the link.
3. **`npm test`:** `scripts/test-nba-trade.js` is not added to `package.json` (that is the lead's file at integration). `npm test` exits 0 as is.
4. **Sitemap:** `/nba/trade` is not in `server.js` `SITEMAP_PAGES` (A's file).
5. The router's `matcher`, `clientFor`, `modelPlayers` and `sendYahooError` are passed into the routes as dependencies, so a rename in G's router hardening must update the mount line.

## Gaps
- Never run against real Yahoo. The context shape follows A's parsers and fixtures; `uses_playoff`/`playoff_start_week` come from `parse.js` `settings()`.
- No market-value layer: FantasyCalc has no NBA, and Yahoo `percent_owned` isn't in the client. See `docs/nba-trade.md`.
- Manual mode has no partner-roster editor (a typical partner is estimated). The API accepts `partnerRoster` if the UI gets one later.
- Manual "Import from draft" reads only `pocket-nba-draft:manual` (picks marked as mine).
- Range uncertainties are hand-set, not backtested.
- Yahoo week numbers are assumed to match Sleeper weeks.
