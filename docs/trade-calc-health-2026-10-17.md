# NFL trade calculator health check — 2026-10-17 (NFL week 6)

Branch `trade-calc-health` off `origin/main` (ee60dcf). Measured with
`node scripts/trade-calc-health.js` against a local server
(`PORT=7898 node --env-file=.env.local server.js`); the script rebuilds
trade.html's pipeline in node and scores it against FantasyCalc's live market
(~197 players redraft, ~420 dynasty). "Before" = `--proj=season --inj=table`
(the code on main), "after" = `--proj=ros --inj=ros` (this branch).

## Part 1 — why A.J. Brown was so low

**Root cause.** Brown (WR, NE, age 29) sprained an ankle in Week 1, sat on IR
for weeks 2–5 and was activated for Week 6 (listed Questionable). Sleeper's
full-season projection already deducts those lost games (165 pts, WR48), and
the trade page built the 70% VORP half of every value on that full-season
total. WR48 sits below the 12-team replacement line (WR42), so his VORP was
exactly 0 and his value collapsed to the 30% market share alone (0.3 × 3,422 =
1,027 → 971 after injury/playoff). Nothing else was wrong: one A.J. Brown in
the slim dict (id 5859), FantasyCalc joins on the same sleeperId, status/age
are current, no form signal (no stat line in weeks 3–5), playoff factor
0.975 (hard slate @KC, @NYJ, vs DEN).

Stage table, 1-QB PPR redraft, 12 teams (before → after):

| stage | before (season proj) | WR rank | after (ROS proj) | WR rank |
|---|---|---|---|---|
| projection pts | 165.0 (season) | 48 | 173.2 (weeks 6–18) | 20 |
| VORP pts over WR42 | 0.0 | 43 | 56.4 | 20 |
| rescaled ^1.25 | 0 | 43 | 2,163 | 20 |
| FantasyCalc raw / normalised | 3,640 / 3,422 | 17 | 3,502 / 3,320 | 18 |
| blend 70/30 (base) | 1,027 | 30 | 2,510 | 19 |
| × injury (Questionable 0.97) | 996 | 29 | 2,435 | 19 |
| × form | 1 (no signal) | | 1 | |
| × playoff (avg #24.2) | 0.975 | | 0.975 | |
| **final** | **971** | **29** | **2,374** | **19** |

Superflex: 800 (WR29) → 2,232 (WR19, market 18). Dynasty: 1,262 (WR34) →
2,257 (WR23, market 24).

**Systemic, not AJ-specific.** Every player who missed games this season was
hit the same way. Among the 197 market players, the 16 with no stat line in
weeks 3–5 were ranked 3.3 positions below the market on average; players
with lines in all three weeks were within 0.2. Superflex QBs were the worst
position (Spearman 0.89): Hurts (IR), Dart (IR) and Lamar (Out) carried full
season totals while the market had already moved. Kenneth Walker (RB3 on the
market, breakout) was valued 5,353 because his season projection (244) had
not caught up to his remaining-weeks projection (271).

Top-20 WRs, market rank → model rank: before, 9 of 20 were ≥3 ranks off
(Watson 9→16, Brown 17→29, Adams 18→26); after, 3 of 20 (Nabers 12→17 and
Pickens 17→24 are genuine projection-vs-market disagreements, Evans 19→13).

## Part 2 — health check findings (ranked by impact)

1. **BUG — full-season projections mid-season** (fixed). The VORP half of the
   blend used `/api/projections/season`, a static 18-game total (`gp` is 18
   for all 606 rows) that is slow to shed missed games and never zeroes
   season-ending injuries (Achane and Dart, both IR with no weekly projection
   left, still carried 257 / 297 pts). A trade only buys the remaining weeks.
   Evidence: Spearman vs market ALL 0.972 → 0.987 (1QB), 0.955 → 0.978
   (SF; QB 0.89 → 0.97), dynasty 0.996 → 0.997; "0 of 3 games" rank bias
   3.31 → 0.75; outlier list (model ≥ 8 ranks below market) 119 → 1.
2. **BUG — fixed Out/IR multipliers double-count under ROS** (fixed). Sleeper's
   weekly rows are already 0 for every week a player is expected to sit
   (audited all 26 Out/IR/PUP market players: Saquon 0 in week 6, 15/g from
   week 7; Etienne first points week 9; Reed/Achane/Dart 0 all season).
   Keeping the season table (Out 0.80, IR 0.55) on top of ROS pushed IR
   players 4.2 ranks below market and Out players 2.0. Residual table in ROS
   mode (Out 0.95, IR/PUP 0.90, Sus 0.95, Q 0.97 unchanged; dynasty milder):
   Out 0.79, IR 0.90. With no multiplier at all: Out 0.29, IR 0.60 — within
   noise of the residual (n = 14 / 10); the residual is kept for setback risk.
3. **TUNING (not changed) — VORP floor compresses the scale.** 101 of the
   top-200 market players sit below their position's replacement line, so
   their value is 0.30 × market by construction (0.50 in dynasty). This is why
   the median model/market ratio reads 0.31 at every position and why 1-QB
   QBs 10–20 (Purdy, Burrow, Mahomes) look "cheap" next to WRs with the same
   market value. Ordering is right (rho ≥ 0.98) and VORP is the design; a
   softer floor would be a product decision.
4. **TUNING (not changed) — consolidation.** On 7 synthetic 2-for-1 / 3-for-1
   trades the model and a plain FantasyCalc sum agree in direction 7/7 after
   the fix (before, "RB3 for WR10 + RB18" flipped WIN vs LOSE because of
   Walker's stale season total). The ^1.25 power curve gives the one-player
   side a premium; FantasyCalc's analyzer instead adds ~750 per open roster
   spot. The 1-for-2 note already flags the roster-spot cost. No change.
5. **TUNING (not changed) — Roster Fit.** NEED_MULT 1.30/1.15/1.10/1.00/0.90/
   0.80 × bench factors 0.85/0.72/0.60, clamped 0.5–1.5, symmetric on give and
   receive. Verified in mock-connected mode (Coast to Coast, 10-team): RB room
   "Upgrade" applied ×1.15 to Henry out and Taylor + Jeanty in, need-adjusted
   verdict matched the raw verdict's direction. Sane; untouched.
6. **DATA — ids / coverage.** 0 market players missing from the slim dict; 0
   players with rescaled VORP ≥ 800 absent from the market feed; 1 market
   player with no projection (Jalon Daniels, market 64); 1 valued 0 (Jaylin
   Noel, market 1); Tyreek Hill (FA) has no ROS rows (market 124). None
   material.
7. **Format detection** — `TradeFit.leagueFormat` picks SF from SUPER_FLEX or
   2 QB slots, dynasty from `settings.type === 2`, PPR from `rec`, and the
   market list / blend weight / injury table follow it. Verified on the live
   league payload (1 QB · Redraft · PPR · 10 teams) and the manual presets
   (SF → 2-QB list, dynasty → 421-row dynasty list, chip updates).
8. **Form / playoff factors** — sane. Nabers 🔥 ×0.95 (26.2 vs 14 proj) ×
   1.032 easy slate; Brown ×0.975 hard slate; swings capped at ±5% each.
   Form uses the contemporaneous weekly baseline from /api/recent-points, so
   it does not depend on the season projection.
9. **Age** — no systematic bias in redraft after the fix (all buckets within
   ±0.4 ranks of market). Dynasty 30+ runs 1.1 ranks above market (n = 57):
   the age curve could be a touch steeper past 30, left alone.
10. **Dynasty IR** still 2.0 ranks below market after the fix (n = 46):
    structural — the VORP half is single-season by construction and the ROS
    sum is 0 for a season-ending IR. Not changed; would need a multi-year
    projection to do better.
11. **Freshness** — nfl state week 6; market cached 1h; season projection 6h;
    ROS 1h (weekly rows shared with /api/projections/:week); recent points
    weeks 5/4/3; usage weeks 4/5; FPA through week 5 (updated 2026-10-13);
    injuries.json 2h cron (2026-10-18T06:51Z), slim dict live from Sleeper.
    Nothing stale.
12. **UI** (headless Chromium over CDP, manual + mock-connected): values,
    tooltip chains, pills, verdict text/colour and 1-for-2 note render; no
    NaN; search dedupes; partner select switches rosters; Roster Fit numbers
    and need multipliers render. Brown for Higgins → FAIR within 6.5%.

Pre-existing, out of scope: `npm test` fails on
`scripts/test-nba-hardening.js` ("real server: GET logout 405" gets 410)
identically on pristine origin/main because the spawned server runs without
`NBA_YAHOO_ENABLED=1`. Every other suite passes; test-trade-fit passes with
the new checks.

## Part 3 — what changed

- `server.js`: `GET /api/projections/ros` → `{ season, fromWeek, weeks,
  players }`, Sleeper weekly projections summed from the current week through
  18 (`ScoringEngine.sumProjections`), cached 1h.
- `shared/scoring.js`: `sumProjections(weekDicts)` — additive stats only,
  `gp` = weeks with a line, ADP/rank fields dropped.
- `shared/trade-fit.js`: `injuryMult(status, { ros })` picks the residual
  tables `rosRedraft` / `rosDynasty`.
- `trade.html`: fetches ROS alongside the season dict; `valueProjections()`
  feeds computeVORP and AnalysisEngine; `injuryOpts()` is the single source
  for recompute() and the pills; season projection kept for the form baseline;
  falls back to the season dict if ROS is unavailable.
- `scripts/test-trade-fit.js`: ros-mode injury checks, sumProjections checks,
  a VORP season-vs-ROS regression, and a live check of the ROS envelope.
- `scripts/trade-calc-health.js`: this health check (re-runnable).

Not changed, and why: `team.html` / `lineup.html` still build VORP on the
season dict (lineup was explicitly out of scope; team.html should follow in a
separate change so /team and /trade agree mid-season). NBA code untouched.

## Before / after summary

| metric | before | after |
|---|---|---|
| A.J. Brown value / WR rank (1QB) | 971 / 29 (market 17) | 2,374 / 19 (market 18) |
| A.J. Brown (SF) | 800 / 29 | 2,232 / 19 (market 18) |
| A.J. Brown (dynasty) | 1,262 / 34 | 2,257 / 23 (market 24) |
| Spearman ALL, 1QB | 0.972 | 0.987 |
| Spearman by pos, 1QB (QB/RB/WR/TE) | 0.99 / 0.97 / 0.97 / 0.95 | 0.98 / 0.99 / 0.99 / 0.98 |
| Spearman ALL, SF (QB) | 0.955 (0.89) | 0.978 (0.97) |
| Spearman ALL, dynasty | 0.996 | 0.997 |
| mean rank bias, no line in weeks 3–5 | +3.31 | +0.75 |
| mean rank bias, Out / IR (1QB) | +1.07 / +1.40 | +0.79 / +0.90 |
| top-200 outliers (≥8 ranks below market or 0) | 119 | 1 |
| Brown for Tee Higgins | WIN +58.5% (FC says −18%) | FAIR +6.5% |

Repro: `node scripts/trade-calc-health.js --proj=season --inj=table` vs
`node scripts/trade-calc-health.js` (defaults = ROS); add `--sf=1`,
`--dynasty=1`, `--player="Name"`, `--json=out.json`.
