# Pocket NBA: High Score value model (stream B)

Code: `nba/model/` (`index.js` is the contract entry point). Data: `data/nba/`. Ingest: `scripts/nba-ingest.js`. Tests and backtest: `node scripts/test-nba-model.js` (offline, exits 0; `--tune` adds the parameter grid) and `node scripts/test-nba-profile.js` (league profiles, phase 3).

> **Phase 3 (H1): league profiles.** `getPlayers({ profile })` values every player under a league's own scoring, roster slots and matchup-week calendar. `/api/nba/players` defaults to league 242808. The sections below describe the shared method; [League profiles](#league-profiles-phase-3-h1) covers what changes under a profile. `getPlayers()` without a profile keeps the legacy High Score behaviour exactly.

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

## League profiles (phase 3, H1)
Source of truth: `nba/league-profile.js` (`getProfile(id)`, `defaultProfile()` = 242808, `highScoreDefaultProfile()`). Spec: docs/nba-contracts.md "Phase 3 addendum".

### Per-game score (`nba/model/score.js`)
`score = Σ scoring[k]·stat[k]` over pts, reb, ast, stl, blk, to, pf, tech, plus a DD bonus when 2+ of PTS/REB/AST/STL/BLK reach 10, and a TD bonus when 3+ do. No weight is hardcoded. Every call takes the profile, and calling without one throws.

**Stat availability (Sleeper `api.sleeper.com/stats/nba/{season}/{week}`, inspected 2025 week 10):**

| stat | Sleeper key | status |
|---|---|---|
| turnovers | `to` | present |
| personal fouls | `pf` | present |
| technical fouls | `tf` | present (sparse: 732 of 26,665 player-games in 2025 had one, ≈0.04 per game) |
| double/triple-double | `dd` / `td` | present, and matches our own count of 10+ categories on every row. We compute DD/TD ourselves from the line, so there's no dependence on the flags. |

Flagrant fouls (`ff`) are present too but are not scored by the league. Projections (`/projections/nba/2026/{w}`) have pts/reb/ast/stl/blk/to (plus Rotowire `dd`/`td`) but **no pf or tf**.

**DD/TD semantics: `flags.tdAlsoCountsDD = true` (UNVERIFIED against an official Yahoo help page).** Yahoo lists Double-Doubles and Triple-Doubles as two separate stat categories, and a triple-double line also satisfies the double-double definition. Sleeper's feed (sportradar) marks `dd=1` on every `td=1` row. Under this flag a triple-double earns +5 +3 = +8. I could not find a Yahoo help page stating this explicitly, so check one triple-double box score in the league once games start. If Yahoo shows only +3, set the flag to `false`. The impact is small: 0.5% of 2025 player-games were triple-doubles, so it changes values by about 0.05 points per game except for Jokić and a few others.

**Snapshot format 2.** Log rows are now `[day, week, hs, min, pts, reb, ast, stl, blk, to, pf, tf]`, and projection rows carry per-stat means. The projection file also stores `teamDates` (each team's game days). `data.js` only prefers a runtime cache copy written in the same `format`, so a cache left by an older deploy can't feed rows without stat lines.

### Expected per-game mean under a profile
- **Logs:** each historical game is re-scored, then the same fit as above runs (recency, minutes, kernel, exact E[max]).
- **Projection prior:** the profile score of the projected stat line, plus three adjustments:
  - pf and tech come from the player's own recency-weighted per-minute rates × projected minutes. With no logs, the league rate is used (0.082 pf/min, 0.0013 tech/min).
  - Expected DD/TD bonus comes from the **distribution of historical games**, not from the means. Each player's recency-weighted share of games with 2+ (3+) doubles is shrunk with 10 pseudo-games toward a league prior.
  - The league prior is `ddCurve`: well-sampled 2025 players (15+ games) binned by their 2nd (3rd) largest category mean, with the share of DD (TD) games averaged per bin and forced monotone. For example, a 2nd-largest mean of 8–9 gives P(DD) ≈ 0.36, and 10–11 gives ≈ 0.53.
- Players without logs use the prior at their projected means.

### Matchup weeks
- Weeks are the profile's matchup weeks, not Sleeper weeks.
- Each team's games per week are counted **by date** from `proj.teamDates`. In 242808, weeks 7 (Nov 30–Dec 13) and 17 (Feb 15–28) are 14-day matchups, so a starter's best game is the max over up to ~5–8 games. `E[max_k]` is now precomputed for k ≤ 10.
- **NBA Cup TBD games:** Sleeper's 2026-27 schedule has 80 games per team, and every team has a league-wide gap from 2026-12-03 to 12-11. Each team's 82 − 80 = 2 undated games are placed in the middle of that gap (`imputeUnscheduled`), so they fall in week 7. DEN week 7 = 3 scheduled + 2 imputed = 5.
- Week 17 contains the All-Star break, so most teams play only ~3–4 games in it despite the 14 days.
- Weekly projection means are games-weighted over the Sleeper weeks inside the matchup window.
- `currentWeek` is the matchup week containing today (week 1 before Oct 20).
- **Pre-draft `hsValue`** = equal-weight average of `hsByWeek` over **all 22 matchup weeks**, playoffs included. Each matchup week counts once in the standings, so the two long weeks lift everyone's average and don't reorder players beyond their real schedules. `games` = average games per matchup week.
- `hsByWeek`, `gamesByWeek` and `?week=` are keyed by matchup week (1–22) under a profile.

### Slots and VORP (`nba/model/slots.js`)
- **`yahooElig`:** the profile's starting slots the player can fill, using the Yahoo legend (PG←PG; SG←SG,G,G/F; G←PG,SG,G,G/F; SF←SF,F,G/F; PF←PF,F,F/C; F←SF,PF,F,G/F,F/C; C←C,F/C; UTIL←anyone). A C-only player is **not** F-eligible.
  - **Yahoo is the source of truth** (`nba/model/yahoo.js`): positions come from `data/nba/yahoo-snapshot-242808.json` (Yahoo player list of league 242808) and set `eligConfidence: 'yahoo'`. Only players missing from that snapshot fall back to Sleeper `fantasy_positions` used token-for-token, with `eligConfidence: 'sleeper-mapped'` (52 deep players on 2026-10-14).
  - Sleeper lists differ from Yahoo's for many wings (Sleeper had Cooper Flagg PG/SF/SG; Yahoo has SG,SF,PF), which is why the fallback is flagged.
- **Replacement level (assumption: "realistic draft"):**
  - The drafted pool is the top `teams × (rosterSize − IL)` = 12 × 14 = 168 players by hsValue, skipping out-for-season players (they sit in IL spots).
  - `replacement[slot]` = hsValue of the best player **outside** that pool who is eligible for the slot, i.e. the free agent you'd stream in.
  - `vorpBySlot[slot] = hsValue − replacement[slot]`, `vorp` = max over eligible slots, and `vorpRank` orders by vorp. Ranks don't use ADP.
- **Finding:** under Yahoo eligibility, replacement levels are nearly flat (≈25.8–26.5 across slots, 2026-10-14), so VORP rank ≈ hsValue rank. With 9 starters and 3 flex slots (G, F, 2 UTIL) and a deep 168-player pool, positional scarcity at the waiver level is small. Positional need is a roster-construction question for the draft board (H2), not a value question.
- `getPlayers` returns `profile: { leagueId, name, teams, scoring, flags, slots, starters, rosterSize, weeks, longWeeks, replacement, draftedPool, unverified, yahoo }`.

### Yahoo snapshot: identity, market fields, validation
- **Identity:** each snapshot row is matched to a Sleeper player by normalized name + team (`matchYahooPlayer`, names.js); a Sleeper player claimed by two rows keeps the higher-confidence match. 602/725 rows match (83.0%). All 123 unmatched rows are players **absent from Sleeper's player list** (best: Westbrook #264, Konchar #275, Valančiūnas #277, Batum #288), so nobody Sleeper knows is left unmatched, and every Yahoo top-200 player is matched. 22 snapshot rows have no Yahoo pid (deep two-way players); they still give positions, with `yahooPid: null`.
- **Per player:** `yahooPid`, `yahooPos`, `yahooPreRank` (Yahoo's pre-season rank for this league), `yahooPctRos`, `yahooFanPts`. Match summary in `profile.yahoo` (matched, total, matchRate, unmatchedTop ≤ preRank 300).
- **Ground truth for the scoring weights:** league scoring (`gameScore` with the 242808 profile, DD/TD/tech weights set to 0 in a copy of the profile) of Yahoo's stat totals equals Yahoo `fanPts` within 0.1 for the top 200 by fanPts (test-nba-profile.js).
- **Finding: the snapshot's stat columns are Yahoo's 2026-27 *projections*, not last season.** Haliburton and Lillard missed all of 2025-26 yet show 68 and 62 GP; Jokić's 1978/71 = 27.86 pts per game is exactly Sleeper's 2026 projection. So summing our 2025-26 per-game log scores cannot reproduce fanPts (483 matched players: only 6 within 0.5 points, mostly due to games played). Instead the test checks the projection inputs: for Yahoo's top 200, 145 have per-game pts/reb/ast/stl/blk/to identical to Sleeper's projection, and our per-game projected mean under linear scoring vs Yahoo fanPts/gp has bias −0.04 and MAE 1.14 (largest gaps: Hachimura −10.0, Kuminga −6.5, Raynaud +6.1, where Sleeper's projection differs from Yahoo's). Part of the MAE is fouls: Sleeper projections carry no pf, ours come from per-minute history (MAE 0.68 pf per game vs Yahoo).
- **DD/TD bonus unverified:** Yahoo's fanPts contain no DD/TD (or tech) component and its list shows those stats blank, so whether +5/+3 actually score in this league is not confirmed by data. The profile keeps them per contract (`tdAlsoCountsDD = true`) and `profile.unverified` (both `/api/nba/players` and `/api/nba/league-profile`) says so.

### Backtest under 242808 scoring (`node scripts/test-nba-profile.js`)
Same no-hindsight protocol (fit on 2025 games before week k, predict week k, k ≥ 4, no projections), with every game re-scored under the league profile. Sleeper's team-total rows (`TEAM_*`) are excluded.

| run | n | bias | MAE | r |
|---|---|---|---|---|
| 7-day weeks, all rostered player-weeks | 10,073 | +1.23 | 9.08 | 0.730 |
| 7-day weeks, given games played (calibration) | 8,224 | −0.16 | 7.53 | 0.796 |
| 14-day (two merged Sleeper weeks), all | 5,000 | +1.34 | 9.52 | 0.723 |
| 14-day, given games played | 4,416 | −0.43 | 7.59 | 0.809 |

The long-week calibration holds (−0.43 given played).

**Note on the older table above:** `scripts/test-nba-model.js` iterates every key in the logs file, including Sleeper's `TEAM_*` aggregate rows (82 per team, scores of 150+). These inflate its r (0.977) and MAE base. Player-only correlation is ≈0.73–0.80. That file belongs to stream B and is left unchanged here; filter `/^\d+$/` ids there.

Pre-draft board (2026-10-14, 242808): Jokić 75.0, Wembanyama 72.4, Dončić 65.6, Jalen Johnson 57.9, Giannis 56.0, SGA 56.6. Cold build ~130 ms, warm < 1 ms; response 547 KB / 75 KB gzipped.
