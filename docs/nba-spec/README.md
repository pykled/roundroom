# docs/nba-spec — machine-readable contracts for NBA Trade v2 + Team Page

Spec: `../nba-trade-team-spec.md`. Test: `node scripts/test-nba-spec-contract.js`.

| File | What | Source |
|---|---|---|
| `fixtures/sleeper-league.json` | Dillon's league `1411447094215991296` (`/v1/league/{id}`) | live 2026-10-15 |
| `fixtures/sleeper-rosters.json`, `sleeper-users.json`, `sleeper-state.json` | rosters / users / `/v1/state/nba` | live 2026-10-15 |
| `fixtures/sleeper-schedule-weeks-2026.json` | per-week first/last game date + game count from `api.sleeper.com/schedule/nba/regular/2026` | live 2026-10-15 |
| `fixtures/sleeper-matchups-2025-wk10.json` | 4 matchups from last season's league `1270568574406107137`, week 10: proof that `players_points` = best single game (High Score) | live 2026-10-15 |
| `fixtures/espn-injuries-sample.json` | 40 rows of ESPN's injuries feed (status, fantasyStatus, **returnDate**) | live 2026-10-15 |
| `fixtures/profile-from-sleeper.expected.json` | **pinned** output of `nba/model/league-sync.js profileFromSleeper()` for the league above (3 UTIL / 4 BN / 2 IL, 23 Mon–Sun weeks, playoffs 21–23, deadline week 17) | generated |
| `fixtures/league-context.example.json` | example `leagueContext()` output (12 teams, my roster 1) | generated from fixtures + board |
| `fixtures/signals.example.json` | two `Signals` objects: Jokić (healthy, stale 2025-26 form) and Jimmy Butler (OUT, ESPN ETA 2027-01-02 → week 11) | generated from the real board |
| `fixtures/roster-analysis.example.json` | `analyzeRoster()` example for roster 1 (10 starters, groups G/F/C/UTIL + display PG/SG/SF/PF) | generated |
| `fixtures/trade-evaluate-v2.example.json` | real v1 `evaluateTrade` output under the Sleeper profile + the v2 fields as placeholders | generated |

Stubs on this branch: `nba/model/league-sync.js` (`profileFromSleeper` real; `leagueContext` stub), `nba/model/signals.js`, `nba/model/roster-analysis.js`, `nba/model/injury-eta.js`. A stub throws an error with `code: 'NOT_IMPLEMENTED'`; the contract test skips those checks until Stream A implements them, then validates the live output against the same shape rules as the fixtures.

Regenerating `*.expected.json` / `*.example.json` is a deliberate act (the contract test pins the profile byte-for-byte); the generator one-liners are in the spec's §4.2 and in the nba-spec branch history.
