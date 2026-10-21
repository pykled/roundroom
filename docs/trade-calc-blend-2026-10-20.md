# Trade-calc blend study — 2026-10-20 (NFL week 7, Tuesday)

Question (Dillon): "idk if this new algorithm is better; look into how to make it
more accurate, perhaps weigh more on FantasyCalc?"

Branch `trade-calc-blend` off `origin/main` 446f585 (code commit 50a1496; this doc is the commit after it), worktree
`~/projects/fantasy-draft-assistant-wt/trade-calc-blend`. Not pushed, not
merged. Measured 18:00–18:20 PDT against a local server
(`PORT=7898 node --env-file=.env.local server.js`), live Sleeper (state week 7,
ROS weeks 7–18), live FantasyCalc, and Sleeper's stored 2025 + 2026 weekly
projections / stats.

## Verdict

- **The blend is not worse than FantasyCalc alone, and not measurably better.**
  Frozen at week 3 and scored on weeks 3–6 outcomes, every blend weight from
  0.25 to 0.75 market lands within ±0.01 Spearman of market-only, and the
  bootstrap intervals include zero in both redraft formats. Dynasty blends are
  significantly better than market-only, but by a hair (+0.01…+0.015 rho).
- **Weighting more on FantasyCalc does not help.** w = 0.75 market scores
  0.463 vs 0.470 at w = 0.25 (1QB), 0.463 vs 0.461 (SF), 0.529 vs 0.537
  (dynasty). The curve is flat; the production weights (0.3 redraft / 0.5
  dynasty) sit on the flat part. No weight change is justified by this data.
- **When market and model disagree about who is better, it is a coin flip:**
  1QB 51 % market / 49 % model over 624 decisive pairs, SF 55 / 45, dynasty
  47 / 53. The model's cross-position ordering is slightly better than the
  market's in every format (pair accuracy +0.01…+0.04), its superflex QB
  ordering slightly worse.
- **Components:** the Questionable residual (0.97) matches the data exactly;
  the hard-playoff-slate penalty has support, the easy-slate bonus does not;
  the **cold "buy low" +5 % bounce is contradicted** (cold players score 0.93×
  their next projection vs 0.96× for everyone else, 1,217 player-weeks) and
  was removed on this branch (label kept); the hot −5 % has no measured
  benefit but is not excluded. Age curve, IR/Out residuals and the ^1.25
  power curve could not be separated from alternatives.
- **What would settle it:** weekly snapshots of the four FantasyCalc lists +
  the ROS projection (`scripts/snapshot-trade-inputs.js`, added) so the same
  backtest can run over 8–12-week windows at season end instead of one
  reconstructed market point and a 4-game window.

## Part 1 — how the value is computed today

trade.html `recompute()` (unchanged on this branch):

```
raw VORP   = Sleeper ROS projection (weeks fromWeek…18, /api/projections/ros)
             scored with the league's scoring_settings, minus the replacement
             player at the position: teams × starters, FLEX split ½ RB ½ WR,
             SUPER_FLEX = +1 QB  (12 teams: QB12 / RB30 / WR42 / TE12;
             superflex QB24). Below replacement → 0.
scaled     = VORP ^ 1.25, rescaled to 0–10,000 (max = 10,000)
[dynasty]  scaled × age curve (RB 1.08 ≤24 … 0.70 ≥30; WR 1.08 … 0.78 ≥31;
             TE 1.06 … 0.82; QB 1.06 … 0.80)
base       = (1 − w) × scaled + w × FantasyCalc normalised to 0–10,000
             w = 0.30 redraft, 0.50 dynasty (list: isDynasty × numQbs 1/2)
             player not on the FC list → base = scaled (100 % model)
             market feed down → S.market = {} → 100 % model
final      = base × injury residual (ros table: Q 0.97, D 0.92, Out 0.95,
             IR/PUP 0.90, Sus 0.95, COV 0.97, DNR 0.60; dynasty milder)
                  × form (hot ×0.95; cold ×1.05 → now ×1; role-up/down ×1;
                          dynasty halves the nudge)
                  × playoff slate (avg opponent FPA rank over the league's
                          playoff weeks, rank 1 → ×1.05 … 32 → ×0.95; dynasty ½)
verdict    = FAIR within ±10 % of the larger side, else WIN / LOSE
Roster Fit (connected only, verdict text) = NEED_MULT 1.30/1.15/1.10/1.00/
             0.90/0.80 × slot factor (starter 1, bench 0.85/0.72/0.60), clamped
             0.5–1.5 — not part of the value and not studied here.
```

Per format (12 teams, PPR): **1QB redraft** w 0.30, QB replacement 12, no
age; **superflex redraft** w 0.30, QB24, 2-QB FC list; **1QB dynasty** w 0.50,
age curve, dynasty FC list, injury/form/playoff halved; **SF dynasty** same with
QB24 + 2-QB dynasty list.

### How far the final value sits from the market (today's live values)

`node scripts/trade-calc-health.js [--sf=1] [--dynasty=1] --json=…`, market
players only (196 redraft, 394 dynasty):

| format | rho(final, market) | median \|final − FC\| (0–10k) | p90 | median final/FC | factor movement \|final − base\| median / p90 |
|---|---|---|---|---|---|
| 1QB redraft | 0.984 (QB .985 RB .985 WR .981 TE .974) | 342 | 1,373 | 0.32 | 8 / 119 |
| SF redraft | 0.975 (QB .970 RB .985 WR .979 TE .974) | 348 | 1,490 | 0.40 | 10 / 121 |
| 1QB dynasty | 0.997 (all ≥ .995) | 332 | 873 | 0.50 | 4 / 44 |

Two things move the number off the market, and they are not the factors:

1. **The VORP floor** (health doc finding #3): 101 of the top-200 market
   players sit below replacement, so their value is 0.3 × market by
   construction and the median final/FC ratio is 0.32. Ordering is preserved
   (rho ≥ 0.97), the scale is compressed at the tail. This is what makes
   "WR30 for RB30" read FAIR when FantasyCalc says −17 %.
2. **Sleeper's ROS projection vs the market** for players above replacement
   (class B in the 10-19 doc). The factors themselves move the median player
   by 8 points on a 10,000 scale and the 90th percentile by ~120 (one 5 %
   nudge on a 2,400 value): injury residual touches 39 of 196 (×0.90–0.97),
   form 81 (×0.95 / ×1.05), playoff 194 (×0.962–1.034).

Rank movement is symmetric by position, age and status (mean model rank −
market rank within ±1 for every bucket except IR, +2.3 ranks below market in
1QB, +2.5 SF, +2.3 dynasty — the known structural gap: ROS sum is 0 for a
season-ending IR).

**Top movers (1QB, |model rank − market rank| ≥ 6), with cause and whether the
backtest supports the direction:**

| player | mkt → model | cause | supported? |
|---|---|---|---|
| Wan'Dale Robinson WR | 47 → 36 | A floor tail (446 vs 493) | neutral — tail ordering is noise either way |
| Davante Adams WR (IR, 33) | 25 → 35 | C: ROS 0 → VORP 0, ×0.90 ×0.95 | direction yes: players inactive at T0 produced 1.1 games / 6 VORP over the next 4 weeks vs 11 for the sample; magnitude unknowable (depends on return week) |
| Malik Washington WR | 51 → 41 | A | neutral |
| RJ Harvey RB | 33 → 23 | B + cold ×1.05 | cold nudge removed on this branch (contradicted) |
| Ollie Gordon RB (Q) | 27 → 17 | B: ROS 158 pts vs market RB27 | B disagreements are 50/50 |
| Jakobi Meyers WR | 48 → 39 | A | neutral |
| David Montgomery RB (Out) | 30 → 22 | B + C (ROS zeros + ×0.95) | 50/50 |
| Tony Pollard RB | 35 → 27 | A + cold ×1.05 | cold nudge removed |
| Rashee Rice WR (Out) | 26 → 18 | B: ROS 176 pts = WR18 per Sleeper | 50/50 |
| Chris Godwin WR (30) | 54 → 47 | A + cold | cold nudge removed |
| Deebo Samuel WR (Out, 30) | 42 → 49 | C | direction yes |
| Travis Etienne RB (IR) | 23 → 30 | C | direction yes |
| George Pickens WR | 16 → 23 | B + hot ×0.95 | hot nudge: no measured benefit, kept |
| Keenan Allen WR (34) | 44 → 50 | A + hot | — |
| DeVonta Smith WR | 20 → 26 | B (1 of 3 games) | 50/50 |
| Bryce Young QB | 15 → 9 | B | 50/50 |
| Malik Nabers WR | 7 → 13 | B: ROS WR13 per Sleeper | at T0 the same disagreement (mkt 7 → model 17) resolved for the market (realized WR2) |
| Omarion Hampton RB | 22 → 28 | B (VORP 71) | at T0 (mkt 11 → model 17 → realized 42) the model was closer |
| Emeka Egbuka WR | 23 → 29 | B | at T0 (16 → 35 → realized 22) the market was closer |

Of the 15 largest T0 movers in 1QB, the model was closer to the realized rank
4 times, the market 3, tie 8; SF 6 / 4 / 5; SF dynasty 10 / 4 / 1. No mover
class is systematically wrong; none is a bug.

## Part 2 — backtest

### Study A: frozen at week 3, scored on weeks 3–6 (no hindsight)

`node scripts/backtest-trade-value.js --boot=1000 --json=…` (files under
`/tmp/blend`, see Repro).

- **Market at T0** = FantasyCalc `value − trend30Day` per list (the list's own
  30-day trend; 30 days before 2026-10-20 is Sunday 2026-09-20, week 2).
  Players with no value 30 days ago (26 of 196 redraft, 23 of 419 dynasty)
  are excluded. FantasyCalc exposes no history endpoint (probed
  `/values/history`, `/players/values`, per-player history → 404).
- **Model at T0** = `computeVORP` on the mean of Sleeper's week-2 and week-3
  weekly projections (per-game proxy for the ROS sum; stored rows are the
  final pre-kickoff versions, so the model sees up to a week more news than
  the market, including game-day scratches as zeros → those players drop out
  as "inactive"). Statuses from `data/injuries.json` as committed before the
  week-3 Thursday kickoff (688a52a). Ages = today's.
- **Realized** = Sleeper actual PPR points weeks 3–6 (0 for missed games),
  minus the realized replacement total at the same ranks → realized VORP.
- **Sample** = on the market 30 days ago ∩ skill ∩ has a week-2/3 projection:
  160 (1QB), 161 (SF), 302 (dynasty lists). 10 / 9 / 69 listed players had no
  projection (IR/Out/suspended at T0): reported separately.
- **Candidates**: market only (w = 1), blends 0.75 / 0.5 / 0.25, model only
  (w = 0), production (w × injury residual × form; no playoff factor — the
  FPA read needs ≥16 teams of data and was not available in week 3).
- **Metrics**: Spearman vs realized VORP (overall, by position), top-12-per-
  position hit rate, decisive-pair accuracy (pairs outside the ±10 % FAIR
  band: is the higher-valued player the higher realizer?), cross-position
  pairs, linear-calibration RMSE in points, 1,000-player bootstraps of Δ vs
  market-only.

**1QB redraft, n = 160 (QB 28, RB 51, WR 57, TE 24)**

| candidate | rho | QB | RB | WR | TE | top-12 | pairs | x-pos | rmse | Δrho vs market [95 %] | Δpairs [95 %] |
|---|---|---|---|---|---|---|---|---|---|---|---|
| market only (w = 1) | 0.459 | 0.10 | 0.52 | 0.50 | 0.52 | 0.67 | 0.704 | 0.703 | 12.3 | — | — |
| blend w = 0.75 | 0.463 | 0.12 | 0.52 | 0.50 | 0.49 | 0.65 | 0.707 | 0.706 | 12.1 | +0.004 [−0.005, +0.013] | +0.003 [−0.001, +0.007] |
| blend w = 0.5 | 0.469 | 0.10 | 0.54 | 0.50 | 0.50 | 0.65 | 0.708 | 0.707 | 12.0 | +0.010 [−0.007, +0.028] | +0.004 [−0.004, +0.013] |
| blend w = 0.25 | 0.470 | 0.09 | 0.55 | 0.50 | 0.49 | 0.65 | 0.708 | 0.708 | 11.9 | +0.010 [−0.016, +0.038] | +0.004 [−0.008, +0.018] |
| model only (w = 0) | 0.484 | 0.23 | 0.56 | 0.48 | 0.47 | 0.65 | 0.738 | 0.739 | 11.9 | +0.023 [−0.029, +0.082] | +0.033 [+0.004, +0.063] |
| **production** (0.3 × inj × form) | 0.469 | 0.08 | 0.54 | 0.50 | 0.49 | 0.62 | 0.709 | 0.708 | 11.9 | +0.009 [−0.015, +0.035] | +0.005 [−0.006, +0.018] |
| production w/o form | 0.471 | 0.09 | 0.54 | 0.49 | 0.50 | 0.65 | 0.708 | 0.708 | 11.9 | +0.011 [−0.014, +0.038] | +0.004 [−0.007, +0.016] |
| production w/o injury | 0.468 | 0.08 | 0.54 | 0.49 | 0.49 | 0.62 | 0.709 | 0.708 | 11.9 | +0.008 [−0.015, +0.033] | — |

**SF redraft, n = 161**

| candidate | rho | QB | RB | WR | TE | pairs | x-pos | Δrho [95 %] | Δpairs [95 %] |
|---|---|---|---|---|---|---|---|---|---|
| market only | 0.455 | 0.07 | 0.52 | 0.47 | 0.52 | 0.696 | 0.695 | — | — |
| w = 0.75 | 0.463 | 0.09 | 0.53 | 0.48 | 0.49 | 0.697 | 0.697 | +0.008 [−0.004, +0.020] | +0.002 [−0.003, +0.007] |
| w = 0.5 | 0.463 | 0.09 | 0.54 | 0.48 | 0.50 | 0.698 | 0.698 | +0.008 [−0.013, +0.028] | +0.002 [−0.007, +0.012] |
| w = 0.25 | 0.461 | 0.06 | 0.55 | 0.47 | 0.49 | 0.696 | 0.696 | +0.007 [−0.028, +0.039] | +0.001 [−0.014, +0.015] |
| model only | 0.447 | 0.10 | 0.56 | 0.46 | 0.47 | 0.707 | 0.705 | −0.007 [−0.069, +0.054] | +0.011 [−0.017, +0.041] |
| **production** | 0.463 | 0.11 | 0.54 | 0.48 | 0.49 | 0.698 | 0.697 | +0.009 [−0.024, +0.038] | +0.002 [−0.012, +0.015] |
| production w/o form | 0.464 | 0.08 | 0.55 | 0.47 | 0.49 | 0.697 | 0.697 | +0.009 [−0.023, +0.039] | — |

**1QB dynasty, n = 302 (QB 37, RB 81, WR 125, TE 59) — realized is this
season's next 4 games, which is the wrong horizon for a dynasty asset; read
as "does the blend hurt the short-term ordering", not as dynasty accuracy.**

| candidate | rho | QB | RB | WR | TE | pairs | x-pos | Δrho [95 %] | Δpairs [95 %] |
|---|---|---|---|---|---|---|---|---|---|
| market only | 0.521 | 0.24 | 0.49 | 0.55 | 0.60 | 0.801 | 0.800 | — | — |
| w = 0.75 | 0.529 | 0.24 | 0.51 | 0.56 | 0.59 | 0.804 | 0.803 | +0.007 [+0.001, +0.013] | +0.003 [−0.001, +0.006] |
| w = 0.5 | 0.533 | 0.23 | 0.53 | 0.56 | 0.59 | 0.806 | 0.805 | +0.011 [+0.001, +0.022] | +0.005 [−0.002, +0.011] |
| w = 0.25 | 0.537 | 0.22 | 0.55 | 0.57 | 0.59 | 0.805 | 0.805 | +0.015 [+0.000, +0.030] | +0.004 [−0.005, +0.013] |
| model only | 0.530 | 0.21 | 0.55 | 0.56 | 0.63 | 0.830 | 0.830 | +0.008 [−0.041, +0.061] | +0.028 [+0.002, +0.054] |
| **production** (0.5 × inj × form) | 0.534 | 0.24 | 0.53 | 0.56 | 0.59 | 0.806 | 0.806 | +0.012 [+0.001, +0.023] | +0.006 [−0.001, +0.011] |

**SF dynasty, n = 302**: market 0.550 · w 0.75 0.555 · w 0.5 0.559 · w 0.25
0.561 · model 0.534 · production 0.558 (Δ vs market +0.008 [−0.002, +0.019]) ·
production w/o form 0.561 [+0.000, +0.021]. Pairs 0.800 → 0.802 (blends),
0.813 model only.

**Disagreement pairs** (market and model order a pair oppositely, both
outside the FAIR band): 1QB 624 pairs, market right 318 (51 %); SF 913,
market 504 (55 %); 1QB dynasty 1,052, model 555 (53 %); SF dynasty 1,372,
687 / 685. Cross-position only: 1QB model right 231 of 474 (49 %); SF 331 of
743 (45 %); dynasty 403 of 773 (52 %).

**Buckets** (rho for market / w 0.5 / model / production):

| bucket | 1QB | SF | 1QB dynasty |
|---|---|---|---|
| healthy at T0 | n 135: .49 / .49 / .51 / .50 | n 136: .48 / .49 / .46 / .48 | n 254: .55 / .56 / .56 / .56 |
| Questionable at T0 | n 20: .30 / .37 / .34 / .37 | n 20: .31 / .37 / .35 / .38 | n 37: .37 / .46 / .45 / .47 |
| Out/IR/D/Sus at T0 (with a projection) | — | — | n 11: all realized 0 |
| age ≤ 24 | n 46: .56 / .57 / .58 / .60 | n 46: .59 / .60 / .58 / .60 | n 118: .53 / .53 / .59 / .53 |
| 25–27 | n 68: .48 / .48 / .51 / .48 | n 68: .49 / .49 / .47 / .49 | n 110: .57 / .58 / .55 / .58 |
| 28–29 | n 16: .03 / .04 / −.08 / .05 | n 17: −.01 / −.06 / −.06 / −.04 | n 27: .26 / .25 / .14 / .23 |
| 30+ | n 30: .38 / .39 / .46 / .39 | n 30: .37 / .40 / .32 / .40 | n 47: .49 / .53 / .52 / .53 |
| inactive at T0 (no projection; market only) | n 10: rho .70, 1.1 games, VORP 6.1 vs 10.9 sample mean | n 9: .73 | n 69: .29, 0.75 games, VORP 0.9 vs 6.1 |

The blend helps most where the market is weakest — Questionable players
(+0.07 rho in every format) — and the model alone is worst for 28–29-year-olds
and SF QBs. Injured-at-T0 players produced ~1 game in 4 and a fraction of the
sample's value; the market ranked them well among themselves (rho 0.70) but
that is 10 players.

**Sensitivities.** VORP exponent 1.0 / 1.25 / 1.5: model rho 0.484 / 0.484 /
0.484 (1QB), blend 0.468 / 0.470 / 0.471 — indistinguishable. Market-only
with the inactive group added back: unchanged to 2 decimals.

### Study B: component tests, weekly, 2025 weeks 3–18 + 2026 weeks 3–6

Each test uses only information available before the week's games.

**Form.** Last-2-games ratio to the weekly projections → this week's actual ÷
this week's Sleeper projection (players projected ≥ 5, conditional on
playing), and next-4-games PPG ÷ projection:

| label | n (week) | mean | median | n (next 4) | mean | median | 95 % CI of mean − on-pace (week / next 4) |
|---|---|---|---|---|---|---|---|
| hot (≥ 1.2) | 911 | 0.965 | 0.856 | 776 | 0.963 | 0.927 | [−0.053, +0.061] / [−0.030, +0.047] |
| cold (≤ 0.8) | 1,217 | 0.930 | 0.812 | 1,054 | 0.942 | 0.891 | [−0.081, +0.018] / [−0.050, +0.023] |
| on pace | 1,179 | 0.961 | 0.848 | 1,013 | 0.956 | 0.909 | — |

Spearman(last-2 ratio, this week's actual/proj) over 3,307 player-weeks:
+0.03. Sleeper's weekly projection already absorbs the streak: hot players do
not regress past it, cold players do not bounce past it (they score a touch
less). The production **cold ×1.05** claims +5 % over the projection and sits
outside both intervals → removed. The **hot ×0.95** claims −5 %; the data's
point estimate is +0.004 vs on-pace, but −0.05 is inside the week interval →
not supported, not excluded, left in place and flagged. On the market half
(Study A, n = 45 / 52): the market ranked hot players 1.2 positions *worse*
than they turned out and cold players 1.5 worse (on-pace −3.3), i.e. no sign
the market overprices hot players; mild sign it underprices cold ones — but
that half is 30 % of the value, so the most a cold nudge could justify is
~1.5 %. At the value level, production-without-form scored ≥ production in
4 of 4 formats (+0.002, +0.001, 0.000, +0.003 rho).

**Playoff / FPA matchup.** Opponent's rank in points allowed to the position
through week k−1 → week-k actual ÷ projection (1 = allows most):

| bucket | n | mean | median | QB | RB | WR | TE | 95 % CI vs mid |
|---|---|---|---|---|---|---|---|---|
| easy (rank ≤ 11) | 1,043 | 0.955 | 0.844 | 0.911 | 0.961 | 0.920 | 1.073 | [−0.053, +0.065] |
| mid | 930 | 0.951 | 0.839 | 0.888 | 0.961 | 0.937 | 1.023 | — |
| hard (≥ 22) | 1,024 | 0.893 | 0.782 | 0.820 | 0.948 | 0.867 | 0.936 | [−0.116, +0.001] |

A hard slate costs ~6 % per game beyond what Sleeper projects (borderline
significant, strongest for QB/WR/TE, nil for RB); an easy slate adds nothing.
Production maps rank 1 → +5 % and 32 → −5 % on the whole ROS value for 3 of
12 remaining weeks (a deliberate overweight of playoff weeks). Direction of
the hard side is supported; the easy bonus is not. Left unchanged (the ±5 %
symmetric map is a product choice; a one-sided 0…−5 % version is the
evidence-backed alternative).

**Questionable tag** (2026 weeks 2–6, Thursday injuries.json, baseline = last
week's projection ≥ 5 of a player who played last week, DNP = 0): Questionable
n = 107 played 71 %, actual ÷ baseline 0.605 (healthy n = 845: 95 %, 0.949);
Doubtful n = 9 played 0 %. If only the tagged week is at risk, the implied ROS
multiplier over 12 weeks is **0.970 — exactly the production 0.97**. Out
0.95 / IR 0.90 residuals: not testable here (needs the realized return week
for Out/IR-at-T0 players over a longer window; the 11 dynasty-list players
with a tag at T0 scored 0 over the next 4 weeks, so the direction holds).

**Not testable with this data:** the dynasty age curve (multi-year outcome),
the ^1.25 power curve vs alternatives (identical scores), the FC-missing
fallback (100 % model) — those players have no market value to compare.

### Limitations (read before acting on any number)

1. One market snapshot, reconstructed from `trend30Day`; the list is today's,
   so players who fell off it since September (busts, season-ending injuries)
   are invisible → survivorship toward players that held value. 26 players
   with no value 30 days ago excluded.
2. Four games of outcomes. Rho ~0.46 for *every* candidate says the window is
   mostly noise; the differences between candidates (±0.01) are an order of
   magnitude smaller than the sampling error of any one of them. Only
   differences whose bootstrap interval excludes zero are claims.
3. The model's T0 inputs are the stored pre-kickoff weekly projections — up
   to a week newer than the market point, and zero for game-day scratches
   (those players are excluded, 10 / 9 / 69).
4. Dynasty is scored on 4 weeks of this season; that measures short-term
   ordering, not dynasty value.
5. Study B's form and FPA tests measure the projection half only; the market
   half is covered by one T0 rank-bias read with n ≈ 50.
6. Realized VORP uses the sample-wide replacement at the production ranks;
   PPR only; 12 teams.

## Part 3 — trade fairness: model verdict vs FantasyCalc-only

`scripts/trade-fairness-compare.py` over today's values (`health-*.json`): 21 trades in
1QB, 26 in SF, 25 in dynasty — 1-for-1 across positions, injured-for-healthy,
2-for-1, 3-for-2, 3-for-1, SF QB deals, dynasty age deals. **Picks are not
supported by trade.html** (no pick values in the pipeline), so none were
scored. Verdicts: model = `evaluateTrade` on the final value (±10 % FAIR);
FC-sum = the same band on raw FantasyCalc values; FC+waiver = FC-sum plus
~750 per open roster spot to the side receiving fewer players (what
FantasyCalc's own analyzer does).

Agreement: 1QB 10 / 21 with FC-sum (10 / 21 with waiver), SF 12 / 26, dynasty
16 / 25. Disagreements by cause, and which side the evidence favors:

| trade (1QB unless noted) | model | FC-sum | cause | evidence favors |
|---|---|---|---|---|
| Bowers (TE1) for Jefferson (WR6) | WIN +28 % | FAIR +1 % | TE1's VORP over TE12 is small next to WR6 over WR42 (positional scaling) | model, weakly: cross-position pairs 0.739 vs 0.703; TE1 realized rank 1 either way. SF: FC says LOSE −11 %, model WIN +24 % — same cause |
| Metcalf (WR30) for Montgomery (RB30, Out) | FAIR | LOSE −17 % | A: both at the 0.3 × market floor | neither — tail ordering is noise in both |
| Etienne (IR) for Judkins (RB24, Out) | WIN +46 % | FAIR | C: Etienne ROS 0 → 420; Judkins zeros this week only | model direction (inactive-at-T0 players produced ~nothing in 4 weeks); magnitude depends on return week |
| Rice (WR26, Out) for M. Wilson (WR27) | LOSE −29 % | FAIR | B: Sleeper ROS has Rice WR18 | 50/50 |
| Adams (WR25, IR, 33) for Rice | WIN +78 % | FAIR | C + B | model direction for an IR player with no projected return |
| Nabers (WR7) for Olave (WR8) | WIN +29 % | FAIR | B: Sleeper ROS Nabers WR13; Olave cold ×1.05 (removed on branch → +24 %) | at T0 the identical Nabers disagreement resolved for the market (realized WR2) |
| Pickens (WR16) for A.J. Brown (WR17, Q) | WIN +22 % | FAIR | B + hot ×0.95 on Pickens | 50/50; hot nudge unsupported |
| Evans (WR21, Out, 33) for Coker (WR22) | LOSE −15 % | FAIR | B: Sleeper ROS Evans 16.3 pts/g | 50/50 |
| Jeanty + McMillan for Bijan (RB2) | WIN +22 % | FAIR +7 % (waiver: WIN +13.5 %) | ^1.25 consolidation premium | FC's own analyzer agrees with the model once the roster spot is priced |
| Nabers + Chase Brown for JSN (WR1) | WIN +17 % | FAIR −0.4 % (waiver +7 %) | consolidation + Nabers B | same |
| Olave + Irving + Kelce for Henry + G. Wilson (3-for-2) | LOSE −11 % | FAIR +5 % (waiver WIN +11 %) | three form nudges (×1.05, ×0.95, ×1.05) and the floor on Kelce/Irving | FC; form nudges are unsupported — with cold removed the model reads −9 % (FAIR) |
| SF: Burrow (QB3) for Flowers (WR10) | WIN +21 % | LOSE −31 % | SF QB scarcity: VORP over QB24 vs 2-QB market | market, weakly: SF disagreement pairs 55 % market, SF QB rho market .07 vs model .10 (both ≈ 0 over 4 games) |
| SF: Allen (QB1) for Walker (RB3) | WIN +13 % | LOSE −18 % | same | same — the blend tempers it (production SF rho 0.463 is the best SF candidate) |
| SF: K. Williams (RB8) for Olave (WR8) | LOSE −15 % | FAIR | B + cold nudge on both | 50/50 |
| SF: Stroud (QB16) for Chase Brown (RB12) | WIN +65 % | FAIR +9 % | SF QB floor (Stroud VORP ≈ 0 over QB24) | market, weakly |
| SF: Flowers + D. Smith for Chase (WR4) | FAIR +3 % | WIN +11 % | B: Chase ROS WR4-5 vs market | 50/50 |
| dyn: K. Williams (RB8) for London (WR8) | FAIR −8 % | WIN +11 % | B | 50/50 |
| dyn: G. Wilson (WR12) for Javonte (RB14) | WIN +19 % | LOSE −14 % | B (Javonte ROS high, 28 → age ×0.88 still) | 50/50 |
| dyn: Evans (33, Out) for Tyson (22, IR) | LOSE −34 % | WIN +31 % | dynasty IR gap: Tyson ROS 0 → 0.5 × market; Evans ROS 2,875 × age 0.78 | market — structural (single-season VORP cannot price a rookie's future); known gap #10 |
| dyn: Nabers for Jefferson (WR7) | WIN +22 % | FAIR | B | 50/50 |
| dyn: Pickens for Golden (WR17) | WIN +12 % | FAIR | B + hot | 50/50 |

Pattern: model-vs-market verdict disagreements come from (1) Sleeper's ROS
projection vs the market — a coin flip in the backtest; (2) positional scaling
(TE1, SF QBs) — model slightly better across positions in 1QB, market slightly
better on SF QBs; (3) injury timing — model direction right, magnitude
unverifiable; (4) the VORP-floor tail — noise; (5) form nudges — the cold half
now removed. None of the disagreements is a data or arithmetic error.

## Part 4 — recommendation

**Blend weight: keep 0.30 redraft / 0.50 dynasty, all positions.** No weight
between 0.25 and 0.75 is distinguishable from another or from market-only on
4 weeks of outcomes; the only significant readings are the dynasty blends
(+0.01 rho over market, every weight), the model's cross-position pair
accuracy (+0.03 in 1QB and dynasty), and nothing in favour of moving toward
the market. A per-position weight (e.g. more market on SF QBs, where the model
is weakest) is suggested by the SF QB bucket but n = 28 and rho ≈ 0 for both
sides — not actionable.

**Components:**

| component | verdict | action |
|---|---|---|
| ROS projection VORP (model half) | keeps up with the market; better across positions | keep |
| ^1.25 power curve | indistinguishable from 1.0 / 1.5 | keep |
| VORP floor (0.3 × market below replacement) | tail ordering is noise either way; it is what makes tail trades read FAIR | keep (product call, see health doc #3) |
| dynasty age curve | not testable here | keep |
| injury residual Q 0.97 | matches the implied 0.970 exactly | keep |
| injury residual Out 0.95 / IR 0.90 | direction supported, size untested | keep |
| form: cold ×1.05 | contradicted (CI excludes +0.05 in both windows; value-level removal ≥ equal in 4/4 formats) | **removed → ×1, label kept** |
| form: hot ×0.95 | no measured benefit, not excluded | keep, re-test at season end |
| role gate (×1) | consistent with "projection absorbs the streak" | keep |
| playoff slate ±5 % | hard side supported (−6 %/game), easy side not | keep; one-sided 0…−5 % is the evidence-backed alternative |
| Roster Fit | not studied | — |

**Changed on this branch (code):**

- `shared/factors.js`: `FORM_MULT.cold` 1.05 → 1 (header explains, cites this
  doc). `formSignal` still labels cold; `mult` is 1 (dynasty halving → 1).
  trade-fit, weekly-score (own momentum factor) and trending (formDeviation)
  are otherwise untouched; the lineup path does not read `FORM_MULT`.
- `trade.html`: cold pill tooltip now says "no value adjustment — cold players
  did not bounce past their projection in the 2025–26 backtest"; help row and
  pipeline comment updated. `valueTitle` skips the ×1 automatically.
- `scripts/test-trade-fit.js`: cold expectations → mult 1 (3 checks updated,
  2 added: `FORM_MULT` values, dynasty cold).
- `scripts/backtest-trade-value.js` (new): Studies A + B, `--fetch` pulls the
  Sleeper/FantasyCalc inputs, `--json` dumps everything.
- `scripts/snapshot-trade-inputs.js` (new): writes
  `data/snapshots/trade/YYYY-MM-DD.json` (UTC date) with the four FC lists,
  the ROS projection per skill player and current statuses (~230 KB). Not
  wired to anything; a weekly cron (Wednesday) is the recommended next step.

Fallbacks unchanged: market feed down → `S.market = {}` → 100 % model;
player missing from the FC list → 100 % model; ROS endpoint down → season
dict (existing behaviour). NBA code and lineup.html untouched.

**What would settle the weight question:** 8–12 weeks of outcomes scored
against *stored* inputs. With weekly snapshots from now, the 2026 season gives
~8 snapshot weeks × 6–10-week windows by January; rerun
`backtest-trade-value.js` against them (the script's Study A needs a loader
for the snapshot format — a 20-line change). Until then the honest answer to
"is the new algorithm better" is: it is as good as FantasyCalc, slightly
better across positions and for Questionable players, slightly worse on
superflex QBs, and none of that is outside noise.

## Tests / verification

- `node --check` OK: shared/factors.js, shared/trade-fit.js, both new
  scripts, scripts/test-trade-fit.js.
- `node scripts/test-trade-fit.js`: exit 0 (all `ok`, including the 5
  changed/added form checks and the live ROS envelope check against :7898).
- `npm test` (with `.env.local`, `data/nba/cache` removed first): **exit 0**,
  no `data/nba/cache` left behind.
- `/trade` in headless Chromium 147 over CDP (`/tmp/blend/cdp-trade.js`,
  manual mode, server :7898 serving this branch): 3,201 players, 196 market,
  ROS 12 weeks, 201 form entries (57 cold, 48 hot), 833 playoff reads; **0
  exceptions, 0 console errors, 0 "NaN"/"Infinity"** in the DOM. Cold sample
  (Travis Kelce): `mult 1`, tooltip "1,241 base × 0.976 (hard playoff slate,
  avg #24) = 1,211" (no form term), pill title carries the new copy. Hot
  sample (Keenan Allen): "152 base × 0.95 (hot: 12.9 vs 8.8 proj pts/g) ×
  1.01 (playoff slate) = 146". Kelce-for-Allen renders LOSE −87.9 %, verdict
  block visible.
- `node scripts/snapshot-trade-inputs.js --out=/tmp/blend/snap`: wrote
  2026-10-21.json, week 7, ROS 7–18, 3,045 projections, 196/196/419/419
  market rows, 285 statuses.

## Repro

```
cd ~/projects/fantasy-draft-assistant-wt/trade-calc-blend
PORT=7898 NBA_MODEL_OFFLINE=1 node --env-file=.env.local server.js &
# inputs (Sleeper 2025 wk 1–18, 2026 wk 1–7; 4 FantasyCalc lists; slim dict)
node scripts/backtest-trade-value.js --fetch --dir=/tmp/blend
# statuses before each Thursday kickoff (git history of data/injuries.json)
for w in 1 2 3 4 5 6; do c=$(git log --format='%h %ad' --date=iso-strict -- data/injuries.json \
  | awk -v d="$(python3 -c "import datetime;print((datetime.date(2026,9,11)+datetime.timedelta(days=7*($w-1))).isoformat())")T00:15:00+00:00" '$2<=d{print $1; exit}'); \
  git show $c:data/injuries.json > /tmp/blend/inj-wk$w.json; done
node scripts/backtest-trade-value.js --dir=/tmp/blend --boot=1000 --json=/tmp/blend/backtest.json
node scripts/trade-calc-health.js --json=/tmp/blend/health-1qb.json          # + --sf=1 / --dynasty=1
node scripts/test-trade-fit.js && npm test
node scripts/snapshot-trade-inputs.js                                          # data/snapshots/trade/<date>.json
```

Full backtest output: `docs/trade-calc-blend-2026-10-20-backtest.txt`;
fairness run: `docs/trade-calc-blend-2026-10-20-fairness.txt`.
