# Weekly lineup score

`/lineup` ranks players by a composite weekly score instead of season VORP.
Engine: `shared/weekly-score.js` (pure, node-testable: `node scripts/test-weekly-score.js`).
Page wiring: `lineup.html` → `loadWeeklyContext()`, `scoreFor()`, `factorChips()`.

```
weekly_score = base_projection
             × matchup_multiplier(position, opponent, weeks_played)
             × vegas_multiplier(team)
             × form_multiplier(player, last 3 weeks)
             × injury_modifier(player status, opponent key defenders)
```

A player on bye (no opponent in `/api/schedule/:week`) scores 0. Blended VORP
only breaks ties. Bench players within 10% of the weakest starter they could
replace are tagged **Consider**; the rest **Sit**.

## Factors

| Factor | Range | Status (2026-09-14) | Data |
|---|---|---|---|
| base | – | **live** | `/api/projections/:week` (api.sleeper.com, includes DEF). Falls back to `/api/projections/season` ÷ 17 when the week isn't published. |
| matchup | 0.8 – 1.2 | **placeholder** (always 1.0) | `data/fpa-baseline.json` — neutral per-position FPA only; `current` / `historical` team maps are empty. |
| vegas | 0.85 – 1.2 | **neutral** (always 1.0) | none. `S.vegas = { TEAM: impliedPts }` is the hook. |
| form | 0.8 – 1.25, ramped | **live** from week 3 | `/api/stats/:w` + `/api/projections/:w` for the last 3 completed weeks, scored under the league's own settings. |
| injury | 0 – 1.1 | **live** | own status from `/api/players/slim` (Q 0.85, D 0.5, Out/IR/PUP/Sus 0); opponent starters from `/api/def-injuries`. |

### Sample-size weighting (matchup)

```
season_weight = min(1, weeks_played / 8)          // 0.125 at week 2, 1.0 from week 9
effective_fpa = season_weight * current_fpa + (1 - season_weight) * historical_fpa
```

Teams are ranked by effective FPA for the position (1 = allows the most = best
matchup); rank maps linearly to 1.2× … 0.8×. Ties share the average rank, so a
league where every team sits on the neutral baseline yields exactly 1.0×.
A team with current data but no history blends against the neutral position
baseline rather than trusting a small sample.

### Form

Weighted actual ÷ weighted projected over the last three completed weeks
(0.5 / 0.3 / 0.2). Weeks with no stat line (bye, DNP) are skipped and the
weights renormalised. Clamped 0.8–1.25, then scaled by
`strength = clamp((weeks_played − 1) / 3, 0, 1)` so it is silent with ≤1
completed week and fully on from 4.

### Injury

Own status multiplies directly. If the opposing team's depth-chart-1 CB
(LCB/RCB/NB) is Out/IR/Doubtful a WR gets 1.1×; a depth-chart-1 LB or S out
gives RB/TE 1.1×. One boost max, never applied to a player who is himself out.
`Questionable` defenders do not count.

## Phase 2 — to wire for full accuracy

### 1. Matchup FPA (biggest missing signal)

- **Current season:** scrape `https://www.fantasypros.com/nfl/matchups/{qb|rb|wr|te|k}.php`
  weekly (public HTML, ~1.9 MB, table of team → fantasy points allowed per game).
  Do it server-side in a `scripts/fetch-fpa.js` run by the existing GitHub
  Actions data job, writing `data/fpa-baseline.json → current[pos][TEAM]`.
  Map FantasyPros team names to Sleeper abbreviations (`WAS`, `JAX`, `LAR`, `LV`).
- **Historical baseline:** one-time export of the last three seasons' FPA per
  team per position, averaged, into `historical[pos][TEAM]`. Until real
  numbers exist leave it empty; the engine falls back to the neutral baseline.
  Do not hand-type team values.
- **Serving:** keep it a static JSON under `data/` (already served by
  `express.static`, browser-cacheable). No new endpoint needed. Set `source`
  to `"fantasypros"` and `updated` to the fetch date so the UI note can show
  freshness.

### 2. Vegas implied totals

- The Odds API free tier: `GET https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds?regions=us&markets=spreads,totals&oddsFormat=american&apiKey=…`
  (500 req/month; one call per hour is plenty). Key goes in Railway env
  `ODDS_API_KEY`, never in the client.
- Add `/api/vegas` in server.js behind `apiCached('vegas', 1 h)`: for each game
  take the consensus (median across books) home spread + total, then
  `WeeklyScore.impliedPoints(total, homeSpread)` → `{ HOME: pts, AWAY: pts }`.
  Map bookmaker team names to Sleeper abbreviations.
- Client: `S.vegas = await jsonOr('/api/vegas', null)` in `loadWeeklyContext()`.
  Everything downstream already handles it (chip, note, cap 0.85–1.2).
- Without the key the endpoint should return `{}` so the factor stays neutral.

### 3. Server-side caching / freshness

- `/api/stats/:week` and `/api/projections/:week` are cached 1 h in-process;
  past weeks never change, so bump completed weeks to 24 h once
  `nfl-state.week > week`.
- `/api/def-injuries` reuses the 24 h players cache; injuries move faster than
  that on game day. Reuse `refreshInjuryCache()`'s 30-min cycle instead of
  the players cache when it runs.

### 4. Known gaps

- Sleeper's `display_week` lags `week` until Tuesday, so Monday-night visitors
  see the finished week. Consider switching to `week` once every game in
  `display_week` reports `status: complete`.
- DEF rows get base projection only (no matchup/form/injury rules yet).
- K matchup FPA exists on FantasyPros but the engine treats K like any position;
  fine, just low signal.
