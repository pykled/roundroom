# NBA stream S1 handoff: mock-draft simulator + strategy analysis

Branch `nba-s1-sim` (off `nba` @ cff2be7). Files owned: `nba/sim/*`, `scripts/nba-draft-sim.js`, `scripts/test-nba-sim.js`, `docs/nba-draft-strategy.md`, this file. Nothing in `nba/model/*`, `nba/router.js` or `nba/pages/draft.*` was edited. `package.json` is unchanged: the lead adds `node scripts/test-nba-sim.js` to `npm test` at integration (per the contract).

## Run it
```
node scripts/test-nba-sim.js                     # 14 tests, offline, ~25 s (incl. 900-draft policy check)
node scripts/nba-draft-sim.js --sims 80 --my-slot all --policy vorp,bpa-fill,hs-fill
node scripts/nba-draft-sim.js --my-slot 7 --sims 200 --policy vorp,c-round1,c-round3
node scripts/nba-draft-sim.js --report rankings  # league vs High Score default ranks, DD/TD movers
node scripts/nba-draft-sim.js --report runs --sims 30
node nba/sim/build-lines.js [rawDir]             # rebuild nba/sim/data/lines-2025.json from raw Sleeper stats
```
Flags: `--seed`, `--wHS` (bot consensus weight on default ranks; 0 = bots know league values, 1 = bots draft off default High Score ranks; default 0.5), `--alpha` (VONA weight, default 0.5), `--json out.json`.

## Modules (all UMD except valuation/run/build-lines, which are node-only)
| file | role |
|---|---|
| `nba/sim/rng.js` | mulberry32 + FNV hash streams, gaussian |
| `nba/sim/lineup.js` | slot layout from `profile.slots`, Yahoo eligibility table, exact DP lineup assignment (7 positional slots × UTIL count; brute-force-verified in the tests) |
| `nba/sim/valuation.js` | **league-scoring adapter**: pool of sim players with per-week E[best game] |
| `nba/sim/bots.js` | opponent models `adp` (σ 6–12), `needs`, `reach` (σ 16, default-rank heavy), `auto` (Yahoo autopick-like) |
| `nba/sim/policies.js` | my-team policies + `recommend` (VORP-per-need / value over next available) |
| `nba/sim/engine.js` | draft state + UI API: `createDraft`, `pickPlayer`, `botPick`, `teamValue`, `recommend`, `runDraft`, `pickTeam` |
| `nba/sim/season.js` | 22-week season sim: injury spells, best-game draws, weekly lineup optimisation, H2H round robin, 6-team playoffs |
| `nba/sim/run.js` | paired Monte-Carlo driver (common random numbers) |
| `nba/sim/build-lines.js` + `nba/sim/data/lines-2025.json` | 2025 per-game stat lines (835 KB, 478 players, 24,472 games), same row layout as H1's "format 2" logs |

Browser use: load `rng.js, lineup.js, bots.js, policies.js, engine.js` (globals `NbaSimRng`, `NbaSimLineup`, `NbaSimBots`, `NbaSimPolicies`, `NbaSimEngine`). The pool has to be built server-side (valuation needs fs). The minimum per-player fields the engine needs are `value, weekEV[], mask, rank, hsRank, sd`. A future `/api/nba/sim-pool` route (not built; router is not mine) could serve it.

## Adapter (read this before merging with H1)
The model in this tree values players under **High Score default** scoring. `valuation.js` re-scores each 2025 game line under the league weights (PTS1 REB1.2 AST1.5 STL3 BLK3 TO-1 PF-1 TECH-1 DD+5 TD+3; a TD game also earns the DD bonus, i.e. `tdAlsoCountsDD` true, matching H1's profile). It then sets each player's league per-game mean = model HS mean × the player's own league/HS ratio over the same games, and uses the player's own league-scored games as the distribution shape. Players with fewer than 8 logged games (rookies) get a normal on the model mean × the group median ratio (G 0.84, F 0.88, C 0.89).
- **When H1 merges:** if `getPlayers()` returns `profile.leagueId === '242808'` (or players carry `scoringProfile`), the board `mean` is used directly as the league mean (ratio 1), so H1's values win. If H1 ships `data/nba/logs-2025.json` in format 2 (rows with ≥ 12 columns), `loadLines()` prefers it over `nba/sim/data/lines-2025.json`. Neither path has been exercised against H1's real output yet. A Checker should run `--report rankings` after the merge.
- Profile: `require('../league-profile').defaultProfile()` if present, else a local copy of the 242808 profile (`fallbackProfile`).
- Matchup weeks → Sleeper projection weeks by start date: league week 7 (Nov 30–Dec 13) = Sleeper 7+8, week 17 (Feb 15–28) = Sleeper 18+19.

## Known gaps / assumptions
- **Positions come from Sleeper, not Yahoo** (`posLowConfidence` on every player). Several bigs are C-only in Sleeper but may be PF/C in Yahoo, and vice versa. That changes how many bigs fit (1 C slot; C-only players fill only C + UTIL). Once Yahoo is connected, pass `yahooElig` (eligible_positions) and it is used literally.
- **Week 7 has only 2–4 games per team in the data** (14 days, but the NBA Cup knockout window Dec 4–11 is unscheduled; teams' 2 placeholder games aren't in Sleeper yet). The sim uses the data as-is, so week 7 is undervalued for everyone by about 1–2 games.
- **Bot consensus is an assumption.** Other managers are modelled as half default-rank, half league-value (`wHS 0.5`). The strategy doc reports sensitivity at 0 and 1.
- No waivers or streaming (10 adds/week exist in the league), no trades, no in-season re-optimisation beyond weekly lineups. Bench value is therefore a lower bound on schedule/injury depth and an upper bound on what drafted depth is worth vs the waiver wire.
- IL slots are drafted like bench. Any healthy rostered player may start (no IL/BN distinction in scoring).
- Injury spells are generic (3.5%/week start, 40%/week end), not player-specific. Current injuries come from the model's availability ramp.
- 2025-only logs (preseason). Rookies are normal-shaped.
- Win metric "all-play" = share of the 11 opponents beaten each regular-season week, averaged over 19 weeks. Playoff/title come from a 12-team round robin with a top-6 bracket.
