# Stream A (shared layer): result

Branch `nba-shared-layer` (worktree `~/projects/pocket-nba-wt/nba-shared-layer`), based on `nba-spec` @ 221f7f8. Not pushed, not merged, nothing deployed, no NFL page touched, no database touched.

## What was built

| Spec | Where | Status |
|---|---|---|
| §3.1 `profileFromSleeper` (hardened) | `nba/model/league-sync.js` | Done. The pinned fixture still matches byte for byte. Fixes: Sleeper state is only used when it is for the league's own season; schedule weeks are checked against the Mon–Sun calendar; week count is capped at 30; a league is treated as categories if either the draft or the league settings say so; the ff note only appears when ff scores. |
| §3.1 `leagueContext` | same | Done. 12 teams, my roster 1, 10 starters each, 0 unmatched on the recorded fixtures; opponents come from matchups; output doesn't depend on input order. |
| §3.1 `/api/nba/players?league_id=`, `LC.profileFor({ sleeperLeagueId })` | `nba/router.js`, `nba/routes/sleeper.js` (`profileFor`, 10 min cache), `nba/routes/league-context.js` (registry) | Done. Category leagues → `400 league_not_points`. The Sleeper lineup and waivers paths now run on the league's own 23 Mon–Sun weeks and 10 starters (`?profile=` still overrides). |
| §3.2 / §4.3 ESPN injury ETA | `nba/model/injury-eta.js`, applied in `board.js` | Done. Fetched hourly in the background with a disk cache. If the fetch fails, the old ramps are used. Live: 131 rows, **130 matched**, 130 applied. |
| §3.3 signals | `nba/model/signals.js` | Done. All 654 players in about 28 ms. |
| §3.4 roster analysis | `nba/model/roster-analysis.js` | Done. `weekValue` equals the trade engine's `teamValue` for every week and all 12 real rosters (to within 1e-9). |
| ff (flagrant fouls) | `nba/model/score.js` | Scores from format-3 rows (column 15). Format-2 rows score 0, so no existing value changes. |
| Tests | `scripts/test-nba-shared.js` (new, 19 tests), `scripts/test-nba-spec-contract.js` (the 4 skipped checks now always run; a stub coming back fails) | Pass. |
| Docs | `docs/nba-shared-layer.md` | How B and C use the layer, plus every decision listed below. |

## Verification (re-run on the final commit, exit codes checked)

| Command | Result |
|---|---|
| `node scripts/test-nba-spec-contract.js` | 19 passed, 0 failed, 0 skipped (exit 0) |
| `node scripts/test-nba-shared.js` | 19 passed, 0 failed (exit 0) |
| `npm test` | exit 0 (includes test-nba-model / profile / trade / lineup / waivers / sleeper unchanged) |
| `node scripts/nba-sleeper-live-check.js` | 25/25 against real Sleeper (read-only). The report file it rewrites was restored, not committed. |

Both test files also pass with a refreshed `data/nba/cache` present, not only on the committed snapshot.

## Decisions where the spec was open (details in docs/nba-shared-layer.md)

1. **Typical lineup vs strength.** `lineup.starters` lists only players actually on the roster. Open roster spots don't push anyone out of that lineup (it reports them in `lineup.openSpots`). `strengthRos` / `strengthNow` value open spots at replacement, the same way the trade engine does. So with an open spot, strength can be higher than `lineup.total + benchValue` (roster 1: 421.0 vs 415.7). This keeps the fixture's "10 starters", and LaVine shows as a liability.
2. **UTIL and the PG/SG/SF/PF display groups have quality-only tiers** (upgrade / solid). Any player can fill UTIL, so headcount can't measure its depth. Matches the fixture (UTIL = solid).
3. **ETA `a0` is the board's healthy availability**, `max(a0, 0.55)`. A **GTD row whose return date falls before the current week counts as healthy**: this covers about 100 preseason "rest" rows dated Oct 16, which otherwise would take a 15% week-1 cut. A return date after the profile's last week means out for the season.
4. **Matching:** a name-only match is dropped when two board players share that name. ESPN reports older than 7 days are ignored. `NBA_MODEL_OFFLINE=1` never reads the ESPN disk cache, so tests stay deterministic.
5. **Signals:** `impliedValue` uses the board's hsValue curve (as the spec says). heavy/light-schedule means at least 5% more / fewer games than the league-average team over the horizon. `thin-sample` isn't emitted for rookies (the `rookie` flag covers them). `nextUp` is null when nobody on the bench is eligible.
6. Defaults from the brief: keeper lens ignored; the headline verdict stays lineup impact, with Value as a meter (B's work); the unofficial ESPN feed is used.

## Notes for B, C and the lead

- **B (trade route is B-owned, not touched):** call `const lc = await LC.sleeperRouteProfile({ sleeper, leagueId: slid })`, refuse `lc.profile.aggregation === 'categories'`, then `modelPlayers(undefined, lc.profileId)` and `profile: lc.profile`. That gives `meta.weeks` = 23. The live check's `sleeper_league_id` evaluate passes today, but it still uses the 242808 calendar until B wires this.
- **C:** pass `currentWeek` to `analyzeRoster` for the playoffs horizon. Pass the trade engine's `capFor(roster)` as `cap` if IL players are included. Use `Board.weekAvailability` and `healthyByWeek` for "lost to injury".
- **Lead:** `package.json` (lead-owned) doesn't run `test-nba-spec-contract.js` or `test-nba-shared.js` yet; add both to the `test` line at integration. I changed one line in `scripts/test-nba-hardening.js` (outside A's file list): its spawned-server check expected Yahoo-enabled responses but ran with Yahoo off, so it failed whenever `.env.local` supplied Clerk keys (it did here). That spawned server also runs online, so it writes `data/nba/cache/*`. That was already true; it now writes `injury-eta.json` too.
- Board players gain `eta`, `injuryNotes`, and (injured only) `availByWeek` / `healthyByWeek`. `getPlayers` gains `injuryEta`. All additions; nothing removed or renamed.

## Open items

- Sleeper `/matchups/{week}` numbering vs the Mon–Sun calendar can only be checked once week 1 has scores (on or after 2026-10-21, spec §1.3).
- `usage` stays null until Stream D.

## Commits

75af213 score ff · 866557e ESPN ETA + board · b0f93da Sleeper profile plumbing + leagueContext · d3a76dc signals + roster analysis · 00ab6ca tests · a986302 hardening test env · a378eda docs · (this file)

MAKER_STATUS: DONE
