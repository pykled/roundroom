# Pocket NBA: High Score value model (stream B)

Code: `nba/model/` (`index.js` is the contract entry point). Data: `data/nba/`. Ingest: `scripts/nba-ingest.js`. Tests and backtest: `node scripts/test-nba-model.js` (offline, exits 0; `--tune` adds the parameter grid).

## What it values
In Yahoo High Score, each starter scores their **single best game** of the week, where game = `pts + reb + 2*ast + 3*stl + 3*blk`. A player's weekly value is therefore **E[max of their games this week]**. That depends on three things: the per-game distribution (mean *and* spread), the number of games their team plays that week, and the chance they actually play each game.

## Data (Sleeper; ESPN for cross-checks)
| file (committed, ~1 MB total) | source | contents |
|---|---|---|
| `players.json` | `api.sleeper.app/v1/players/nba` | 650 active rostered players: name, team, fantasy_positions, injury status/notes, years_exp |
| `logs-2025.json` | `api.sleeper.com/stats/nba/2025/{1..25}?season_type=regular` | per-player played games `[epochDay, week, hsScore, minutes]` + rostered-games per week |
| `logs-2026.json` | same, 2026 | written once the regular season has games (runtime cache until then) |
| `proj-2026.json` | `api.sleeper.com/projections/nba/2026/{1..25}` + season endpoint | per-player per-week projected HS mean/minutes/games; **team games per week** (the schedule); season per-game projection |
| `proj-2025.json` | 2025 weekly projections | backtest only (flagged variant, see below) |
| `espn-check.json` | ESPN gamelog + team schedule | cross-check fixtures asserted by the test |

Raw responses (~90 MB) are cached in `data/nba/raw/` and are gitignored.

### Dedupe finding (spike risk #2 resolved)
The spike counted **82 rows** for Jokic in 2025 against ESPN's **66** games. Cause: Sleeper's per-game stats endpoint emits **one row per rostered player per team game**. DNPs come back as rows with an empty `stats` object (16,690 of 45,835 rows in 2025). Jokic's 82 rows are DEN's 82 games, and 17 of them are DNPs with `{}`. There are **no** duplicate `(player, game_id)` rows, no season-type mixing (`season_type` is always `regular`), and weeks don't overlap. Trade days produce one empty row each for the old and new team (e.g. Porziņģis, 2025 week 16).

The ESPN figure of 66 is itself off by one: **ESPN files the All-Star game under the regular season** (opponent `STARS`, 2026-02-15). Sleeper leaks the All-Star game too, but only for some players (team `STP`/`STR`/null, 18 rows; Durant has one).

**Rule** (`nba/model/sleeper.js`):
1. Keep a row as a played game only if `stats.sp > 0`.
2. Drop rows whose team or opponent is not one of the 30 franchises (removes the All-Star game).
3. Dedupe on `(player_id, game_id)`. This is defensive: 0 hits in 2025.
4. Rows that pass rule 2, played or not, count as rostered games. These feed availability and the per-player schedule.

Verified against the ESPN gamelog, with ESPN's All-Star games excluded. Counts **and exact dates** match:

| player | Sleeper raw rows | after rule | ESPN regular (excl. All-Star) |
|---|---|---|---|
| Nikola Jokić | 82 | 65 | 65 (66 incl. ASG) |
| Luka Dončić | 82 | 64 | 64 (65 incl. ASG) |
| Shai Gilgeous-Alexander | 82 | 68 | 68 |
| Kevin Durant (HOU + leaked ASG row) | 83 | 78 | 78 (81 incl. 3 ASG-tournament games) |

**Schedule:** team dates from the 2026 projection rows match ESPN's 2026-27 team schedule date-for-date for DEN, LAL, BOS, GSW and SAS (80 games each; the 2 NBA Cup knockout games aren't scheduled yet). Sleeper weeks are Mon–Sun, except week 1 (Tue–Sun) and the All-Star week.

## Method (per player, `nba/model/fit.js`)
1. **Sample.** All played games from 2025 plus 2026 to date.
2. **Recency weight.** `w = 0.5^(daysAgo / 45)`.
3. **Minutes-aware.** Typical minutes `M` = weighted median. A game under `0.5·M` (injury exit, return-from-injury ramp, blowout) has its weight × 0.5, so it can't drag the distribution. If a projection exists, the sample is rescaled by `ρ = clamp(projMinutes / M, 0.7, 1.4)` to reflect role changes.
4. **Shrink to projection.** `mean = (nEff·empMean·ρ + 12·projMean) / (nEff + 12)`, where `nEff` is the Kish effective sample size and `projMean` is the Sleeper/Rotowire per-game HS projection for that week. Samples are scaled multiplicatively to that mean, which keeps the player's coefficient of variation.
5. **Distribution.** Weighted Gaussian-kernel mixture over the scaled samples. Bandwidth = `0.25 × Silverman`, which slightly smooths the empirical tail.
6. **Expected max: exact order statistic, not simulation.** `E[max_k] = ∫ x d(F(x)^k)` is integrated on a 240-point grid for k = 1..7. Reasons for this choice:
   - It's deterministic by construction (no RNG, so values never jitter between requests).
   - It's about 50× cheaper than a 10k-draw simulation.
   - It's exact for the fitted distribution.

   The test cross-checks it against a **seeded** (mulberry32) Monte-Carlo run to within 0.25. `expectedMax(array, n)` uses the closed-form discrete order statistic. `expectedMax({mean, sd}, n)` uses the normal (`mean + sd·e_n`; e.g. e_2 = 0.564, e_4 = 1.029).
7. **Week value.** Each of the week's `N` team games is played with probability `a`:
   `hsByWeek[w] = Σ_k Binom(k; N, a) · E[max_k] · (mean_w / mean)`
   Here `mean_w` uses that week's projection (opponents). Zero games gives zero value.
8. **Availability `a`** (`board.js`):
   - `a0 = (played + 0.85·20) / (rostered + 20)`, clamped to [0.4, 0.98].
   - In the 2025 data, players who played the previous week went on to play ≈ a0 of their games (a0 bin 0.8 → 0.82, 0.9 → 0.91), and players who missed the previous week played about 0.2. So healthy = `max(a0, 0.55)`.
   - Current-week injury (Sleeper `injury_status`): DTD/GTD/Questionable ×0.75; Doubtful 0.3; Out 0.1, then +0.25 per week; Out with "Surgery" note: 0 for 3 weeks, then +0.15 per week; IR/Sus: 0.02 for 4 weeks, then ramps.
   - **Out for season** (status contains "season"/OFS, or surgery on Achilles/ACL) → `hsValue` 0 and `outForSeason: true`.
9. **No usable log** (< 5 games), **rookies**, or a **new team** with thin logs → `source: 'projection-only'` or `'rookie'`. These get a normal around `projMean` with sd = pooled CV × mean. The pooled CV is the median CV of well-sampled players (nEff ≥ 15) in the same position group (G/F/C) × projected-minutes tier (<18, 18–26, 26–32, 32+).
   - New-team players with enough data (nEff ≥ 10) take their **mean from the projection only** (`source: 'projection-only'`) but keep their own distribution shape.
10. **Pre-draft value** (`week` omitted): average of `hsByWeek` over the remaining weeks (all 25 pre-season). `games` = average games per week.
11. **Board.**
    - `rank` by hsValue.
    - `tier`: a new tier starts where the gap to the next player is in the top 15% of gaps among the top 200 (min 0.5 points). Currently 19 tiers.
    - `elig`: PG/SG→G, SF/PF/C→F (union over multi-position), plus UTIL.
    - `posRank` = best of `posRanks.G` / `posRanks.F`.
    - `ceiling`/`floor` = p90/p10 of the single-game distribution.
    - Extra fields: `posRanks`, `outForSeason`, `availability` (a0), `newTeam`.

### Parameters and how they were picked
`nba/model/fit.js` `PARAMS`. The values come from the `--tune` grid on the 2025 no-hindsight backtest (MAE given games played):

| param | value | grid result |
|---|---|---|
| halfLifeDays | 45 | 20–60 best (8.26–8.35); 120 → 8.37; no decay → 8.43 |
| shortWeight | 0.5 | 1.0 (no down-weighting) is 0.03 better in-season, but 0.5 kept so an injury-return ramp can't sink a star |
| bwFactor | 0.25 | 0 → bias −0.27, 0.5 → +0.15; 0.25 ≈ unbiased (−0.11) |
| priorGames | 12 | flagged projection-prior run: k = 0 / 6 / 12 / 25 / 50 → 8.22 / 8.08 / 8.05 / 8.06 / 8.10 |

## Backtest (2025, no hindsight): `node scripts/test-nba-model.js`
Fit on 2025 games strictly before week k; predict week k (k = 4..25). N = the player's team games that week. Injury proxy: whether the player played last week. No 2025 projections are used, because every 2025 projection row was last modified **after** its week ended, so they may contain hindsight.

| metric | n | bias | MAE | r |
|---|---|---|---|---|
| hsValue vs realized weekly max (all rostered player-weeks; 0 if no game played) | 10,733 | **+1.30** | 10.02 | **0.977** |
| E[max of games actually played] vs realized (distribution calibration) | 8,884 | **−0.11** | **8.31** | **0.986** |
| baseline: per-game mean as the weekly value | 8,884 | −7.79 | 10.89 | 0.984 |
| flagged: with 2025 projection prior (possible hindsight) | 8,884 | +1.05 | 7.72 | 0.988 |

By scheduled games, predicted / realized mean weekly max: N=1 30.1/31.1, N=2 36.6/35.6, N=3 40.2/39.0, N=4 42.9/41.3, N=5 43.6/40.7.

For the same player, 4-game weeks are valued **+5.6** above 2-game weeks, against a realized gap of **+4.5** (505 players; the prediction is higher for 475). An otherwise-identical 4-game player always beats a 2-game player; the test asserts this synthetically and on the live board.

Sanity on the 2026 pre-draft board: Jokić 74.9, Wembanyama 69.7, Dončić 66.5, Cunningham 61.2, SGA 60.9. No NaN. Every week with 0 team games gets value 0.

## Yahoo matching (`nba/model/names.js`)
**`normalizeName`:**
- Lowercase, map ı/ø/đ/ł/ß, NFD-strip accents.
- Drop `.`/`'` (P.J. → pj, De'Aaron → deaaron); other punctuation and hyphens become spaces.
- Strip trailing Jr/Sr/II/III/IV/V. Sleeper already drops these, so "Jaren Jackson Jr." → "jaren jackson".
- Canonical first-name aliases: Nicolas↔Nic, Herbert↔Herb, Moritz↔Moe, Cameron↔Cam, Sviatoslav↔Svi, Alexandre↔Alex, Ronald↔Ron, Mohamed↔Mo, Patrick↔Pat (except Patrick Williams).
- Full-name aliases: Nah'Shon→Bones Hyland, Carlton→Bub Carrington, Kenyon Martin→KJ Martin, Gregory→GG Jackson, Pöltl→Poeltl.

**`matchYahooPlayer`:**
- Team abbreviations are mapped first: GS/NO/SA/NY/PHO/UTAH/WSH/BRK/CHO → Sleeper.
- Exact normalized-name match: with team → 0.95 (+0.05 if positions overlap). Unique name with no team (FA) → 0.85. Unique name with a different team (stale/traded) → 0.75, reason `name-unique-team-mismatch(...)`. Several players with the same name and no team match → null.
- Fuzzy fallback: same surname + compatible first name (prefix 0.15 / initial 0.10) + team 0.30 + position 0.05, on a 0.45 base.
- Anything below **0.75** or tied returns **null**: it never guesses.
- Tested on 29 Yahoo-shaped players.

## Runtime and performance
- `getPlayers` loads the committed snapshot synchronously (5 ms JSON parse; Railway cold start needs no network). It builds the board in **~60–80 ms**, then memoizes per (week, data version) for 10 min. **Warm calls take < 1 ms** (the requirement is < 300 ms).
- A background refresh (TTL 30 min, never awaited on the request path) re-pulls:
  - players/injuries (2.5 MB),
  - the current and next week of projections,
  - in-season, the last two weeks of 2026 stats (a cold container backfills weeks 1..current once, ~1–2 MB/week).

  Results are written atomically to `data/nba/cache/` (gitignored), which is preferred over the snapshot when newer. On failure the last good data keeps serving (`status().lastError`). Measured refresh: ~0.3 s preseason.
- `NBA_MODEL_OFFLINE=1` disables network (tests).
- Full board JSON is 478 KB, or 69 KB gzipped. A's 10-min HTTP cache and compression apply.
- `nba/model/*` must never be served statically (A's deny-list); `data/nba/` contains no secrets.

## Limits / known gaps
- **Availability is heuristic.** Sleeper has no return dates, so the ramps above are guesses. Overall weekly bias of +1.3 (vs −0.1 conditional on playing) is mostly missed games we don't foresee. N=5 weeks are overvalued by ~3.
- **2025 projections can't be backtested cleanly** (revised post-game). The projection prior's live weight (k=12) is tuned on the flagged run.
- **Preseason (now):** 2025 logs only. Recency + projection shrink handle role changes, but the new-team/rookie values are only as good as the Rotowire projections. Only 336 players have weekly projection rows; the rest use the season projection.
- **Yahoo weeks vs Sleeper weeks:** Values are per Sleeper week (Mon–Sun; week 1 Tue–Sun). If a league's Yahoo week dates differ (e.g. a combined All-Star week), the caller should re-bucket. `gamesByWeek` comes from `proj-2026.teamGames`. Re-bucketing by date would need team dates, which aren't stored yet.
- No back-to-back / rest-day modeling; no opponent-pace adjustment beyond what Rotowire's per-game projection includes.
- Name aliases cover known cases only. Unmatched players come back as null (A surfaces them in `unmatched`).
- `api.sleeper.com` is undocumented and may change. ESPN is used only by the ingest cross-check.
