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
             × home_away_multiplier(is_home)
             × short_week_multiplier(game_date)
             × weather_multiplier(home stadium forecast, position)
             × usage_multiplier(recent target/carry share + snap share vs season)
             × game_script_multiplier(vegas spread proxy, position)
```

A player on bye (no opponent in `/api/schedule/:week`) scores 0. Blended VORP
only breaks ties. Bench players within 10% of the weakest starter they could
replace are tagged **Consider**; the rest **Sit**.

## Factors

| Factor | Range | Status (2026-09-15) | Data |
|---|---|---|---|
| base | – | **live** | `/api/projections/:week` (api.sleeper.com, includes DEF). Falls back to `/api/projections/season` ÷ 17 when the week isn't published. |
| matchup | 0.8 – 1.2 | **live** | `data/fpa-current.json` (`current[pos][TEAM]`, half-PPR points allowed per game, rebuilt every Tuesday by `scripts/scrape-fpa.js` via `.github/workflows/update-fpa.yml`) merged over `data/fpa-baseline.json`. `historical` is still empty, so early weeks blend against the neutral position baseline. |
| vegas | 0.85 – 1.2 | **live** | `/api/vegas` (The Odds API, `ODDS_API_KEY`) → `S.vegas = { TEAM: impliedPts }`. Chip hidden. |
| form | 0.8 – 1.25, ramped | **live** from week 3 | `/api/stats/:w` + `/api/projections/:w` for the last 3 completed weeks, scored under the league's own settings. |
| injury | 0 – 1.1 | **live** | own status from `/api/players/slim` (Q 0.85, D 0.5, Out/IR/PUP/Sus 0); opponent starters from `/api/def-injuries`. |
| homeAway | 0.98 / 1.03 | **live** | `teams[TEAM].home` from `/api/schedule/:week`. Never shown as a chip. |
| shortWeek | 0.94 | **live** | `teams[TEAM].date` from `/api/schedule/:week`; Thursday (UTC weekday of the date-only string) → 0.94, chip **TNF**. |
| weather | 0.78 – 1.04 | **live** | `/api/weather?week=N` → `S.weather[TEAM] = { windspeed (mph), precip (%), indoor }` — the home stadium's Open-Meteo forecast, shared by both teams. Chip **WX** only when mult < 0.95 or > 1.03. |
| usage | 0.90 – 1.08, ramped | **live** from week 3 | `/api/recent-stats?week=N` → `S.usage[id] = { recent, season }` share-of-team averages (api.sleeper.com weekly stats: `rec_tgt`, `rush_att`, `off_snp`, `tm_off_snp`). Chip **Usage**. |
| gameScript | 0.97 – 1.04 | **live** | Derived from `S.vegas` (own implied − opponent implied ≈ spread). No extra fetch. Chip **Script**. |

### Usage (recent role)

`/api/recent-stats` computes, per completed week, each RB/WR/TE's target share
(`rec_tgt` ÷ team targets), carry share (`rush_att` ÷ team carries) and snap
share (`off_snp` ÷ `tm_off_snp`). Team sums skip Sleeper's `TEAM` aggregate row
and DEF rows so targets aren't double counted. A week counts as complete once
24+ teams have stat lines. `recent` averages the last two completed weeks,
`season` all of them; `games` = weeks with an offensive snap.

```
share_delta = recent_share − season_share        // WR/TE: target share, RB: carry share
share_mult  = +8% max once delta > +5 pts (full at +10), −4% max once delta < −5 pts
snap_mult   = −6% max once snap share fell > 15 pp (full at −30 pp), any position
usage_mult  = 1 + (clamp(share_mult × snap_mult, 0.90, 1.08) − 1) × strength
strength    = clamp((weeks_played − 1) / 3, 0, 1)   // same ramp as form
```

Because `recent` and `season` are identical with ≤2 completed weeks, the deltas
are zero until week 4 regardless of the ramp.

### Game script

```
spread = implied[team] − implied[opponent]       // > 0 = favoured
|spread| ≤ 3.5 → 1.0; linear ramp to full at 7+
favoured:  RB 1.03, WR/TE 0.98
underdog:  RB 0.97, WR/TE 1.04
```

QB, K and DEF are untouched. Because both sides of a game are scored, the RB
bump on one side and the RB cut on the other average to exactly 1.0.

### QB/WR stack tip (UI only)

`stackTips()` in lineup.html: for each starting QB, the highest-projected WR on
the same NFL team (across the whole player pool, under the league's scoring). If
that WR is on this roster's bench, the swap-note shows "Consider stacking X with
Y". No score change.

### Matchup FPA source

`scripts/scrape-fpa.js` sums Sleeper's weekly stat lines (`api.sleeper.com/stats/nfl/{season}/{week}`,
`pts_half_ppr` grouped by `opponent` × position) over every completed week and divides by games
played. That reproduces FantasyPros' published points-allowed table exactly; the public
FantasyPros pages could not be used directly because `points-allowed.php` server-renders only
10 of 32 teams without an account and the `matchups/{pos}.php` pages expose only FantasyPros'
blended matchup rank, which the file keeps as `fpMatchupRanks` for reference. A week counts as
complete once 24+ defences have stat lines, so a Tuesday run never picks up a half-played week.

### Weather

`/api/weather` reads the week's games from the cached Sleeper schedule, looks up the home
stadium in `STADIUMS` (server.js; indoor/retractable stadiums skip the forecast), and makes one
Open-Meteo request for all outdoor stadiums (comma-separated coordinates). Kickoff times aren't
in the schedule, so Sunday games average the 1pm and 4pm ET hours and Thu/Sat/Mon games use 8pm
ET. Cached 6 h per week. International games use the listed home team's stadium.

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

### 1. Matchup FPA — historical baseline (current season is wired)

- **Historical baseline:** one-time export of the last three seasons' FPA per
  team per position, averaged, into `historical[pos][TEAM]` in
  `data/fpa-baseline.json`. `scripts/scrape-fpa.js` can produce it by running
  its Sleeper aggregation for seasons 2023–2025. Until real numbers exist the
  engine falls back to the neutral baseline. Do not hand-type team values.

### 2. Vegas implied totals — done (`/api/vegas`, 2026-09-15)

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
