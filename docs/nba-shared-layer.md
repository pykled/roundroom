# NBA shared layer (Stream A)

What the trade calculator (Stream B) and the team page (Stream C) build on. Spec: `docs/nba-trade-team-spec.md` §3–§4.3. Contract fixtures: `docs/nba-spec/fixtures/`. Tests: `node scripts/test-nba-spec-contract.js` (shapes, nothing skipped) and `node scripts/test-nba-shared.js` (behaviour).

## Modules

| Module | Exports | Notes |
|---|---|---|
| `nba/model/league-sync.js` | `profileFromSleeper`, `leagueContext`, `currentWeekFor`, `profileSummary`, `todayEt` | Pure. Profile from the league's own Sleeper settings (spec D1); pinned by `profile-from-sleeper.expected.json`. |
| `nba/model/injury-eta.js` | `fetchInjuryEta`, `loadInjuryEta`, `matchEta`, `applyEtaToAvailability`, `maybeRefresh`, `parseEspn` | ESPN return dates, hourly background refresh, disk cache `data/nba/cache/injury-eta.json`. |
| `nba/model/signals.js` | `playerSignals`, `signalsFor`, `marketWeight` | Per-player signals (§3.3). |
| `nba/model/roster-analysis.js` | `analyzeRoster`, `weekValue`, `assessTier`, `tierStatus`, `qualityTier` | Lineup, slot-group tiers, needs/surplus (§3.4). |
| `nba/model/board.js` | `weekAvailability` (new) | ETA-aware availability inside the board, so every consumer sees the same numbers. |
| `nba/routes/league-context.js` | `profileFor({ sleeperLeagueId })`, `sleeperRouteProfile`, `rememberSleeperProfile`, `sleeperProfile`, `NOT_POINTS` | Sleeper profile registry for the synchronous route helpers. |
| `nba/routes/sleeper.js` | `router.profileFor(leagueId)` | Fetches league + state + draft, builds the profile, caches 10 min, registers it. |

## Using the Sleeper profile in a route

```js
// Sleeper league id in hand (lineup / waivers do exactly this; trade is Stream B's to wire):
const lc = await LC.sleeperRouteProfile({ sleeper, leagueId: lid, profileParam: req.query.profile });
if (lc.profile.aggregation === 'categories') return res.status(400).json(LC.NOT_POINTS);
const board = await modelPlayers(week, lc.profileId);   // the Sleeper id resolves through the registry
// or, once sleeper.profileFor(lid) has run: LC.profileFor({ sleeperLeagueId: lid })
```

- `GET /api/nba/players?league_id=<sleeper id>` builds the board under that league's profile (23 Mon–Sun weeks, 10 starters, playoffs 21–23 for Dillon's league). `?profile=242808` still serves the stored profile. Category leagues → `400 league_not_points`; Sleeper errors map through `errorResponse` (404 / 429 / 502 / 504).
- `GET /api/nba/lineup?league_id=…` and `GET /api/nba/waivers?league_id=…` (Sleeper paths) now run on the league's own profile; `&profile=242808|hs` overrides. If Sleeper can't be reached for the profile, the stored default stands in and the route's own Sleeper call reports the outage.
- The Sleeper profile carries `marketSnapshotId: '242808'`, so the Yahoo snapshot (identity, pre-rank, % rostered) and `market.json` still join (`board.js applyYahoo`, `enrich.js`).

## ESPN injury ETA (§4.3)

- Fetch: `site.api.espn.com/.../nba/injuries`, hourly in the background (`getPlayers` calls `maybeRefresh`; never awaited). Any failure keeps the previous document; a document older than 7 days is ignored; `NBA_MODEL_OFFLINE=1` never fetches and never reads the disk cache (tests pass a document explicitly: `getPlayers({ profile, eta })`).
- Match: normalised name (`names.js`, so "Jimmy Butler III" = "Jimmy Butler") + team when both are known. More than one candidate → no match. A name-only match is dropped when two board players share the name. Live 2026-10-15: 130 of 131 rows matched.
- Stale: a row dated more than 14 days ago for a player with a logged game after that date is shown (`eta.stale: true`) but not applied.
- Rule, per week w (`a0` here = the board's healthy availability, `max(a0, 0.55)`):
  - `OFS`, or a return date after the profile's last week → out for the season (value 0).
  - `OUT`: 0 for weeks ending before R; R's week = `a0 × 0.85 × (team games on/after R) / (team games that week)`; the first week starting after R ×0.85; then `a0`.
  - `GTD`: R before the current week → back now; R inside the current week → the DTD rule this week (`0.75 × max(a0, 0.55)`), healthy after; R later → treated as OUT until R.
  - Current week only: the more pessimistic of the ESPN rule and the board's own Sleeper-status rule (covers ESPN GTD vs Sleeper Out).
  - No row / stale row → the old ramps, unchanged.
- Board players gain `eta` (null when unmatched), `injuryNotes`, and, for injured / ETA players only, `availByWeek` and `healthyByWeek` (same week with no injury: the team page's "lost to injury"). `getPlayers` responses gain `injuryEta: { fetchedAt, rows, matched, applied }`. Use `Board.weekAvailability(p, w, currentWeek)` rather than reading `availByWeek` directly.

## Signals (§3.3) — decisions where the spec was open

- `form` / `minutes` come from the newest season with ≥ 5 logged games (`statSeason`); `form` is null without one. `form.label` needs ≥ 10 games and a season mean ≥ 10. Shown only, never multiplied into value.
- `market.impliedValue` = `hsValue` of the board player at the market rank (spec wording), linear between ranks, past the board → horizon replacement. `signalsFor` builds that curve from the players it is given; a lone `playerSignals` call passes `ctx.board`. Contested or thin market rows get half weight.
- `heavy-schedule` / `light-schedule`: the player's games over the horizon ≥ 5% above / below the league-average team's (imputed dates, as the board counts them).
- `stale-stats`: the last logged game (any season) is more than 21 days old. `thin-sample`: fewer than 20 logged games, not emitted for rookies (`rookie` covers them).
- `uncertainty`: 0.10, +0.10 not log-based, +0.04 injured with a live ETA / +0.08 injured without, +0.05 under 20 games, +0.05 stale log stats; cap 0.35. Preseason, every log-based player carries the stale +0.05.
- Per-ctx work is memoised on the ctx object: build a new ctx instead of mutating one.

## Roster analysis (§3.4) — decisions where the spec was open

- `weekValue` is the trade engine's week value verbatim (open roster spots at replacement, a no-eligible slot costs the worst bench player, bench shares above replacement). `test-nba-shared.js` checks it against `trade.js` `teamValue` week by week for all 12 real rosters, so team strength and trade deltas agree.
- `strengthRos` / `strengthNow` use `weekValue` (open spots priced at replacement). `lineup` is the typical lineup of the players actually rostered: open spots don't displace anyone there (`lineup.openSpots` counts them; a starter below replacement shows up in `liabilities`). Starting slots no rostered player can fill are listed in `lineup.open` at waiver level. So with an open spot, `strengthRos` can exceed `lineup.total + benchValue`.
- UTIL takes anyone, so it is never a need or surplus: its tier is always `solid` (its league rank still shows how good the flex starters are). The PG/SG/SF/PF display groups are single slots, so headcount says nothing about their depth: their tier is quality-only (`upgrade` below the league average, else `solid`). G/F/C use the NFL matrix unchanged.
- `nextUp` is null when no bench player is eligible for the group. `rank` is null here; the team page ranks groups across teams.
- Extra inputs: `currentWeek` (default `weeks[0].week`; pass it for a playoffs horizon) and `cap` (default active spots; pass the trade engine's `capFor(roster)` when IL players are included).

## League context

`leagueContext(...).profile` is the compact summary of the fixture (`leagueId, name, teams, starters, slots, weeks (count), playoffStartWeek, tradeDeadlineWeek`, plus `aggregation`). `currentWeek` is the profile week containing today (ET); before week 1 → 1. Unmatched players stay in `players` with `onBoard: false` and are listed in `unmatched` as `Player <id>` (Sleeper rosters carry no names).

## Scoring

`score.js` scores flagrant fouls from column 15 of format-3 log rows (Stream D). Format-2 rows have no `ff` column and score it 0; the Sleeper profile's `unverified` says so while `ff` is non-zero.

## Open items

- Sleeper `/matchups/{week}` numbering vs this Mon–Sun calendar: re-check once week 1 has scores (2026-10-21; spec §1.3).
- `usage` stays null until Stream D (format-3 logs).
