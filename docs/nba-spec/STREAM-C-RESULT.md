# Stream C (Team Page): Maker result

Branch `nba-team-page` (from `nba-spec` @ 221f7f8), worktree `~/projects/pocket-nba-wt/nba-team-page`. Not pushed, not merged, no deploy, no prod DB. No NFL page changes. Full write-up: `docs/nba-team.md`. Screenshots: `docs/nba-team/` (24 PNGs).

## Built

| file | what |
|---|---|
| `nba/model/team-analysis.js` | `analyzeLeague` (power rank, now rank, G/F/C/UTIL + PG/SG/SF/PF tiers, weaknesses/strengths, bench, injury exposure, schedule, volatility, lean, partners), `targetsFor` (≤ 48 trade-engine evaluations), `teamDetail`, `typicalLeague` (manual mode), `weekValue` (identical to trade.js, tested to 1e-9), local contract-shaped stand-ins for Stream A (`leagueContextLocal`, `analyzeRosterLocal`, `signalsLocal`) used only while A's stubs throw `NOT_IMPLEMENTED` |
| `nba/routes/team.js` | `/nba/team` page, `GET /api/nba/team`, `GET /api/nba/team/detail`, `POST /api/nba/team/manual`; 60 s analysis cache, 5 min targets cache, 240/min/IP, 400/404/413/429/502/503 paths |
| `nba/pages/team.{html,js,css}`, `team-logic.js` | power table (cards < 900 px), my team card, strengths/weaknesses, injuries + ETA, trade partners + targets with Open in Trade deep links, team detail sheet, horizon control, view-as, manual roster editor, legend sheet |
| `scripts/test-nba-team.js` | 16 tests (spec §5.4 items 1-7 + engine identity, contract shapes, 20 teams, no-C team, page/deny/nav/sitemap, page logic) |
| `scripts/nba-team-backtest.js` | the 2025 league backtest (§5.4.8) |
| `scripts/nba-team-mock.js`, `scripts/nba-team-screens.py` | real router + real offline model + recorded Sleeper fixtures; 9 scenarios × 375/1280 |
| `docs/nba-team.md` | method, API, backtest table, verification |

Shared touch points: `nba/router.js` (one mount line), `nba/pages/nba-ui.js` (NAV entry + `activeFromPath` + a `team` icon), `shared/nav.js` (one NBA_LINKS entry), `server.js` (one SITEMAP entry). Outside the §3.5 C list, needed for the sixth tab: `nba/pages/nba-ui.css` tab bar `repeat(5, 1fr)` → auto columns (a sixth tab otherwise wraps to a second row), and two stale test expectations: `scripts/test-nba-ui-kit.js` (5 → 6 nav links, `/nba/team` active key) and `scripts/test-nba-home.js` (NBA link set gains `/nba/team`). `package.json` untouched (lead owns the test line): **add `node scripts/test-nba-team.js` to `npm test`**.

## Verification (run by me, exit codes checked)

| command | result |
|---|---|
| `node scripts/test-nba-team.js` | exit 0, 16 passed |
| `npm test` (no Clerk keys in env) | **exit 0** |
| `npm test` with `.env.local` Clerk keys | exit 1: `test-nba-hardening.js` spawned-server test, `/nba/auth/logout` 410 !== 405. **Pre-existing**: same failure on base `221f7f8` in a throwaway worktree with the same `.env.local` (Yahoo is disabled there, logout answers 410). Not touched by this stream. |
| `node scripts/test-nba-spec-contract.js` | exit 0, 15 passed, 4 skipped (A's stubs) |
| `node scripts/test-nba-copy.js` | exit 0 (no "Yahoo", no football terms in the new page) |
| `python3 scripts/nba-team-screens.py` | exit 0, 113 checks, 0 problems: no horizontal scroll at 375 or 1280, all page tap targets ≥ 44 px, no console/page errors, in: empty, manual, connected, detail, horizon, view-as, Sleeper 429, categories, zero leagues |
| `node scripts/nba-sleeper-live-check.js --keep` + real `/nba/team` | 25/25 live checks; real league `/api/nba/team` 200 in 0.55 s, 0 unmatched players; real-league screenshots at 375/1280 with 0 console errors, no h-scroll |
| `node scripts/nba-team-backtest.js` | **exit 1**: Spearman assert misses (see below); winner assert passes |

## Backtest (2025-26 Sleeper league 1270568574406107137, weeks 5-20, no hindsight)

160 team-weeks, 80 matchups. **Spearman (predicted strengthNow vs actual points) 0.492, spec bar ≥ 0.5, missed by 0.008.** **Predicted weekly winner correct 71.3%** (bar ≥ 60%, pass), vs 61.3% for season-to-date points and 68.8% for last week's points. Power-rank read (next-4 predicted vs next-4 actual) 0.545. Diagnostics: against each roster's realized optimal lineup the model's Spearman is 0.647; managers banked 73.4% of their optimal and that alone correlates only 0.714 with their actual points, so lineup management caps the metric. Nothing was tuned to the result (the one change after the first run was fixing a hindsight leak, each player's team as of each Monday, which moved Spearman 0.493 → 0.492). Decision for the lead/Dillon: accept 0.49 as the honest number, or change what the bar is measured against.

## Decisions taken (spec left open or in tension)

1. **Strength includes IL players**, exactly like the trade engine (cap = active spots + IL slots holding IL-eligible players; an injured star counts when he's back). Depth/tier counts exclude IL and Out/IR/OFS/SUS players. So the team page's strength for a roster equals the trade calculator's `beforePerWeek` (tested).
2. **UTIL never names a trade need or surplus** (everyone is UTIL-eligible, so UTIL depth is always "deep"); partners/targets match on G/F/C.
3. **Partner ties** (same 2·overlap + mutual score) go to the team with the more urgent need (critical > upgrade > thin, then worse group rank), then power rank.
4. **Target candidates on their side are the players nearest in value to what I give**, not their best players at the position: with "their top 4" no swap ever passed `them ≥ −band` (their stars are never fair value for my depth).
5. Manual mode without a league grades against a typical league with this league's shape and scoring (12 teams, 10 starters).
6. The Playoffs horizon is available any week on the team page (the trade page's "disabled before week 10" rule is B's).
7. Tier glyphs: the spec gives five; Upgrade uses ▴ (amber).
8. The page builds the Sleeper profile itself (`profileFromSleeper` + `/v1/state/nba`) and calls `getPlayers({ profile })` with its own 10 min cache key, because `modelPlayers` keys on a profile id. Swap to A's `LC.profileFor({ sleeperLeagueId })` when it lands.

## Contract notes for Stream A (no A files edited)

- `analyzeRoster`: team-analysis passes `currentWeek` (strengthNow, gamesThisWeek) beyond the contract signature, and `leagueAvg` / `strongCutoff` as **per-group maps** `{G, F, C, UTIL, PG, SG, SF, PF}`; please accept both. The page uses two extras per group if present: `starters: [{ id, slot, value, replacement }]` and `nextUpId` (names in "Thin at C: Nurkić 31/wk, next up X"); without them the copy falls back to values only (tested). The contract has no place for **waiver-add starters** (string ids required); the local version lists them separately as `lineup.waiver: [{ slot, value }]`. Please define it.
- `weekValue`: team-analysis uses its own `weekValue` (returns `{ total, starters (id null + replacement for waiver adds), bench, holes, games, benchValue }`), proven identical to trade.js. If A's `RA.weekValue` must match trade.js too, the two will agree by construction; adding `games` would let the page switch to it.
- `leagueContext`: needs a `currentWeek` input (the board's week under the profile); the contract signature has none. Local version: `fpts + fpts_decimal/100`, reserve players kept with `slot: 'IL'`, Sleeper's `'0'` empty starters dropped.
- `signalsFor`: called with `{ profile, currentWeek, weeks, logs, proj, market (market.json doc), eta: EtaDoc, today }`. The page reads `form`, `minutes.trend/delta/mpg`, `availability.eta.returnDate/returnWeek/status`, `market.rank`, `statSeason`.
- Injury exposure is computed in team-analysis over the **full** roster (IL included), not from `analyzeRoster.injured`, using a calibrated healthy value (`healthyByWeek`). A `healthyByWeek` (or the fit's `emax`) on board players would make it exact.
- `injury-eta`: `loadInjuryEta()` + `matchEta()` are called for injured players; `returnWeek` filled from the profile when missing.

## Commit

Single commit on `nba-team-page`. Not pushed.

MAKER_STATUS: DONE
