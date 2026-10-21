# Pocket NBA: Team Page (Stream C)

Route `/nba/team` (nav tab **Team**, between Trade and Waivers). Public, Sleeper-first. Spec: `docs/nba-trade-team-spec.md` §5. Files: `nba/model/team-analysis.js` (pure model), `nba/routes/team.js` (API + page), `nba/pages/team.{html,js,css}` + `team-logic.js` (UI), `scripts/test-nba-team.js`, `scripts/nba-team-backtest.js`, `scripts/nba-team-mock.js`, `scripts/nba-team-screens.py`. Screenshots: `docs/nba-team/`.

## What the page shows

- **Power rankings**: every team ranked by **strength** = projected weekly lineup points over the chosen horizon (Rest of Season with playoff weeks 1.5×, Next 4, Playoffs). Columns: rank, team, record, points, strength (with a bar), this week (value + rank), G / F / C / UTIL tier glyph + group rank, injuries (count + points lost this week), bench. Sort by any column; under 900 px the table becomes stacked cards with a sort select.
- **My team card**: rank, strength, this week, injury cost, bench, the four group tiers against the league average, lean chip (Preseason / Contender / Balanced).
- **Strengths and weaknesses** in plain English ("Thin at F: 3 starters at 127.6/wk, next up LaVine 24.2/wk. 6th of 12."), elite starters, weak starters (within 3 pts/wk of waiver level).
- **Injuries and schedule**: every injured player with status, body part, ESPN return date when Stream A's feed is live ("back ~wk 12 (Jan 2)"), and the points it costs this week; starter games this week vs the league; this week's opponent; boom-or-bust read.
- **Trade ideas**: teams that need what you have (partners) and up to 6 one-for-one **trade targets** scored by the trade calculator, each with **Open in Trade** (`/nba/trade?league_id=&partner=&give=&get=`, prefill is Stream B's).
- **Team detail** (tap any team): stats, group tiers, strength-by-week sparkline, roster by Starters / Bench / Injured List with ROS and this-week value, games this week, form (hot / cold / steady, last 5 vs season, "(2025-26)" while stale), minutes trend, ESPN return date, market rank.
- **Manual mode** (no Sleeper, or Sleeper down, categories league, no leagues): roster editor (search, remove, import the trade page's manual roster) → my team graded against a **typical 12-team league** ("Vs Typical League" badge, no power table).
- **View as**: a user who owns no team in the league picks a team to view as theirs.

## Model (`nba/model/team-analysis.js`)

| metric | definition |
|---|---|
| `weekValue(roster, w)` | **Identical to the trade engine's** `createEvaluator().weekValue` (asserted to 1e-9 on all 12 rosters × 23 weeks in `test-nba-team.js`): best lineup over the profile's starting slots on `hsByWeek[w]` (exact transversal-matroid assignment, `roster-slots.js`), open roster spots at waiver replacement, unfillable slots at replacement when a bench player can be cut, plus bench shares above replacement. Roster cap = active spots + IL slots holding IL-eligible players (IL players included, like the trade engine; they score 0 while out and count when back). |
| `strengthRos` | horizon-weighted mean of `weekValue` (playoff weeks 1.5×). Equals the trade calculator's `you.beforePerWeek` for the same roster (tested). |
| `strengthNow` / `strengthNext` | `weekValue` at the current / next week. `powerRank` by `strengthRos`, `nowRank` by `strengthNow`. |
| replacement | trade.js `replacementLevel`: 0.9 × 3rd-best unrostered player that week (league source when ≥ teams × 3 rostered). |
| groups | G (PG+SG+G slots, PG/SG-eligible), F (SF+PF+F, SF/PF-eligible), C, UTIL (anyone) + display PG/SG/SF/PF by primary position. Typical lineup on horizon-average values; `starterValue` = Σ value in the group's slots (waiver adds included); `rostered` = eligible players not on IL and not Out/IR/OFS/SUS. `leagueAvg[g]` = mean starterValue, `strongCutoff[g]` = starterValue of the last team inside the top 30%. Tier = the NFL matrix (`roster-analysis.js assessTier`): critical / upgrade / thin / solid / deep / loaded. |
| weaknesses / strengths | tiers critical → upgrade → thin (then worst rank first) / loaded, deep or a top-3 group rank. |
| injury exposure | Σ over the roster of max(0, healthy_w − hsByWeek[w]) for this week and this week + next. `healthy_w` = E[max of n_w games] at a = max(a0, 0.55) on the player's normal shape, calibrated to his own board value in weeks ≥ 8 ahead (where every injury ramp has expired), so opponent scale and fit shape cancel. |
| bench, schedule, volatility | bench shares above replacement (typical lineup); Σ games of this week's starters vs league mean; mean sd/mean of this week's starters. |
| lean | `preseason` until week > 4 with games played; then `contend` if win pct ≥ 0.55 or power rank ≤ playoff teams, else `balanced`. |
| partners | NFL rule: teams whose needs (G/F/C) overlap my surplus; score = 2·overlap + mutual; ties → more urgent need (critical 3 / upgrade 2 / thin 1, then their worse group rank), then power rank. Top 3. UTIL is never a need, surplus or weakness (everyone is UTIL-eligible, so its tier is always Solid; only G/F/C are graded as positions). |
| targets | for each partner: my players in the overlapping surplus groups except my best in that group (≤ 4) × their players eligible for my needs **nearest in value to what I give** (≤ 4 each; their stars are never on offer for my depth). Evaluated with `evaluateTrade` on both real rosters + league replacement; keep `you ≥ 0.5·band` and `them ≥ −band`; top 6 by you + them. Cap 48 evaluations (≈ 0.3–0.5 s), cached 5 min. |

Stream A layer: every shared function (`leagueContext`, `analyzeRoster`, `signalsFor`, `loadInjuryEta`/`matchEta`) is called first; while it throws `NOT_IMPLEMENTED` a contract-shaped local version runs (`leagueContextLocal`, `analyzeRosterLocal`, `signalsLocal`), and `analysis.source` reports which one ran. The local versions are validated against the same shape rules as `scripts/test-nba-spec-contract.js`.

Order invariance: shuffling teams, players and the board gives byte-identical output (tested with 3 seeds). No NaN anywhere (tested).

## API (`nba/routes/team.js`, mounted with one line in `nba/router.js`)

- `GET /api/nba/team?league_id=[&user_id=][&roster_id=][&horizon=ros|next4|playoffs]` → `{ league, analysis, players, myRosterId, ownRosterId, viewAs, unmatched, asOf }`. Profile built from the Sleeper league (`profileFromSleeper` + `/v1/state/nba`), board under that profile with the market fields joined. Analysis cached 60 s per league / horizon / team, targets 5 min (keyed by a roster fingerprint). Rate limit 240/min/IP.
- `GET /api/nba/team/detail?league_id=&roster_id=[&horizon=]` → `{ league, team, roster: [{ player, signals, slot, slotNow, group, tier, value, gamesThisWeek }], unmatched, weeks }`.
- `POST /api/nba/team/manual { roster: [ids ≤ 25], league_id?, horizon? }` → same shape, `estimated: true`, `unknown` ids, `warnings`. Without `league_id` the typical league uses this league's shape (12 teams, PG SG G SF PF F C UTIL×3, 4 BN, 2 IL, playoffs 21–23) and scoring.
- Errors: 400 bad ids / horizon / body, 400 `league_not_points` (categories), 404 `sleeper_not_found` / `team_not_found`, 413, 429 (+Retry-After, ours and Sleeper's), 502/504 Sleeper outages, 503 board unavailable. `/nba/model/*` and `/nba/routes/*` stay 404 (router deny-list, tested).

Response size: ≈ 108 KB JSON for 12 teams (per-team weekly values, groups, lineups, injured), gzip on the server.

## Backtest: 2025-26 Sleeper league (spec §5.4.8)

`node scripts/nba-team-backtest.js [--from=5] [--to=20] [--offline] [--md]`. League `1270568574406107137` (10 teams, same scoring and slots: PG SG G SF PF F C UTIL×3, 4 BN, 2 IL). Weekly rosters and points from `/v1/league/{id}/matchups/{w}` (cached under `data/nba/cache/backtest-2025/`, gitignored).

Protocol (no hindsight): for week w the board is `buildBoard(data, { now: Monday of w, profile })` on 2025-26 game logs only, logs before that Monday, team games-rostered counts before week w (availability prior), no projections (every 2025 projection row was revised after its games), injury proxy = rostered last week but played none of his team's games, each player's team as of that Monday inferred from his own last game days (catches trades the logs' final team would hide). Prediction = `weekValue` of the roster Sleeper shows for week w; actual = `matchup.points` (the manager's own lineup). The derived schedule matches the logged team games within 0.14 games per team-week; all 2,507 roster slots are on the board.

Result (2026-10-15, weeks 5–20):

| metric | value |
|---|---|
| team-weeks (weeks 5-20, 10 teams) | 160 |
| Spearman, predicted strengthNow vs actual points (pooled) | **0.492** (assert ≥ 0.5: **miss by 0.008**) |
| Pearson r | 0.511 |
| mean within-week Spearman | 0.505 |
| predicted weekly winner correct | **71.3%** of 80 (assert ≥ 60%: **pass**) |
| … when the projected margin is ≥ 30 / < 15 | 76.2% of 42 / 68.2% of 22 |
| baseline: season-to-date points/week picks the winner | 61.3% of 80 (Spearman 0.421) |
| baseline: last week's points picks the winner | 68.8% of 80 |
| power rank: predicted next-4 mean vs actual next-4 mean (mean weekly Spearman) | 0.545 |
| bias / MAE (optimal lineup vs the manager's actual lineup) | +91.4 / 102.4 (pred 428.1, actual 336.7) |
| diagnostic: Spearman, predicted vs the roster's realized optimal lineup | **0.647** (bias −22.9) |
| diagnostic: Spearman, realized optimal vs actual points | 0.714; managers banked **73.4%** of their optimal |
| diagnostic: team-weeks with all 10 starter slots filled | 144, Spearman 0.446 |

Reading: the model picks the weekly winner 71% of the time, 10 points better than season-to-date scoring and 2.5 better than last week's score, and it ranks rosters by what they could score well (0.65 against the realized optimal lineup). Against actual points the ceiling is set by lineup management: managers banked 73% of their roster's optimum on average (benching mid-week forfeits banked games, empty slots, late-season disengagement), and that alone correlates only 0.71 with what they scored. The pooled Spearman lands at 0.492, just under the spec's 0.5 bar. Nothing was tuned to the result; the team-as-of-date fix (a hindsight leak, not a tuning knob) moved it 0.493 → 0.492. The +91/wk bias is the same lineup-management gap and does not affect ranks.

## Verification

- `node scripts/test-nba-team.js`: 16 tests, spec §5.4 items 1–7 plus engine identity, contract shapes of the local stand-ins, 20-team league, no-C team, horizons, page route / deny-list / nav / sitemap, page logic.
- `python3 scripts/nba-team-screens.py` (starts `scripts/nba-team-mock.js`: real router + real offline model + recorded fixtures): 9 scenarios × 375 / 1280, 113 checks, no horizontal scroll, every tap target ≥ 44 px, no console or page errors. Real league: `node scripts/nba-sleeper-live-check.js --keep` (25/25) and `docs/nba-team/real-league-{375,1280}.png`.
- `npm test`: exit 0 without Clerk keys. With `.env.local` Clerk keys present, `test-nba-hardening.js`'s spawned-server test fails `/nba/auth/logout` 410 !== 405, which fails identically on the base commit `221f7f8` (Yahoo is disabled there, so logout answers 410); not caused by this stream.
