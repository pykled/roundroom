# Trade-calc balancing pass — 2026-11-10 (NFL week 10, Tuesday)

Request (Dillon): "Fix the NFL trade calc, feels like there needs to be some
balancing." No specifics given, so this pass measured first and changed only
what the measurements supported.

Branch `trade-calc-balance` off `origin/main` 37583cc, worktree
`~/projects/fantasy-draft-assistant-wt/trade-calc-balance`. Commits:
1c871d8 (backtest script), f6b0e42 (superflex replacement QB), 7ef18b2
(linear value curve), then this doc. Not pushed, not merged (main is
Railway-connected). Measured 2026-11-10 19:00–23:30 PST against a local
server on the branch (`PORT=7898 NBA_MODEL_OFFLINE=1 node --env-file=.env.local
server.js`): Sleeper state week 10, ROS weeks 10–18 (slate not started),
FantasyCalc live (196 redraft / 395 dynasty rows), injuries.json
2026-11-11T05:23Z, FPA through week 9. No `data/snapshots/trade` existed
(the 10-20 snapshot script was never wired to a cron), so the backtest
re-fetched Sleeper's stored 2025 (weeks 1–18) and 2026 (weeks 1–11
projections, 1–9 stats) and used FantasyCalc's `value − trend30Day` as the
one historical market point (≈ week 6).

## Verdict

Two things were measurably unbalanced and are changed; everything else that
*feels* off was measured and left alone, with the reason below.

| what | evidence | change |
|---|---|---|
| **Superflex QBs undervalued.** QB replacement at `teams × 2` (QB24) overstates what a replacement QB produces: 24 starters against 32 NFL starters leaves no margin for injuries/benchings. | 1,676 QB-for-skill 1-for-1 trades over 17 T0 weeks: the model picked the QB side **44.8 %** of the time against a realized **50.5–62.3 %** under every realized-VORP definition (lineup-aware 59.5 %). Same direction at the market-anchored T0 (34.5 % vs 45.2 %). | replacement QB one eighth deeper in SF/2QB only (QB27 in 12-team): `computeVORP(..., { qbDepth: TradeFit.SF_QB_DEPTH = 1.125 })`. Model now picks the QB side 60.1 %. |
| **Star-for-depth trades tilted to the star.** The `^1.25` power curve made every N-for-1 sum richer for the single-player side than it paid out. | 10,200 synthetic 2-for-1 / 3-for-1 trades: `^1.25` called the single side the winner **69.6 % / 75.0 %** of the time against a realized **53.8 % / 52.8 %** (lineup-aware), and its FAIR calls paid the two-player side **−7.4 % / −8.4 %**. Linear: 65.8 % / 69.2 %, FAIR calls −2.0 % / +0.4 %, sign accuracy equal or better. Three of four realized definitions agree; the one that doesn't charges a benched/injured player's missed game as a loss. | VORP exponent 1.25 → **1** on the trade page only (`TradeFit.VORP_EXPONENT`; draft/research/team keep 1.25). Player order is unchanged, only sums move. |
| Fresh injuries with no timeline (Puka Nacua WR10 market → 1,450) | Sleeper zeroes every remaining week the moment a player is hurt; the floor (0.3 × market) then prices him at ~25–30 % of healthy. Backtest of 164 such cases: they produced **23 % of their prior projection over the next 4 weeks, 32 % over 8** (Questionable-tagged 28 % / 46 %). The floor is about right on average. | none |
| Tail trades read extreme (Jalen Coker WR30 2,030 for Jadarian Price RB30 375 = LOSE −81 %; FantasyCalc FAIR) | 100 of the market's top 200 sit below replacement (value = 0.3 × market); one player with 20 VORP points next to one with 0 is a 5× gap. Realized VORP of below-replacement players is 3–5 % of a top-12 player's, so the floor is not wrong, only the contrast is. Deeper replacement lines fix this but break cross-position balance (below). | none (documented alternative) |
| Sleeper ROS vs the market (Nabers, Bijan RB2 → model 6,019, Jordan Love QB3 → 831) | class B of the 10-19 doc: a coin flip in every backtest, no new evidence. | none |
| 1-QB QB scaling | metric-dependent: calibrated under the truncated definitions (32.5 % vs 32.8 %), undervalued under lineup-aware/raw (vs 49.8–55 %). No consistent direction. | none |
| Deeper replacement for every position (`×1.25`, `×1.5`, `×2`) | fixes the N-for-1 tilt better than the exponent but swings RB-vs-WR 1-for-1s from 52.7 % to 64.6–70.3 % RB (realized 45.5–52.6 %) and TE-vs-skill down to 15–23 % (realized 28–47 %). Rejected. | none |
| hot ×0.95, injury residuals, age curve, playoff ±5 %, Roster Fit, FAIR band ±10 % | no new evidence beyond docs/trade-calc-blend-2026-10-20.md (hot: not supported, not excluded). 1-for-1 decisive calls are 55 % right over 4 weeks for every candidate — the band width is a product choice. | none |
| Picks | FantasyCalc's dynasty list carries `FP_2027_early_0`-style rows; trade.html has no pick values. Still unsupported. | none |

## Part 1 — what the live calculator said before this branch

`node scripts/trade-calc-health.js [--sf=1] [--dynasty=1]` on origin/main
values (`^1.25`, SF QB24), week 10, 12 teams, PPR. Spearman vs FantasyCalc:
1QB 0.98 (QB .98 RB .98 WR .97 TE .99), SF 0.97 (QB .97), dynasty 1.00.
Median model/market ratio 1QB: QB 0.31, RB 0.35, WR 0.47, TE 0.31; SF QB
0.48 vs WR 0.52. Mean final value by market rank, as a share of the top-12
bucket (1QB): model 1.00 / 0.58 / 0.40 / 0.15 / 0.02 for ranks 1–12 /
13–24 / 25–48 / 49–96 / 97–200; the market 1.00 / 0.68 / 0.44 / 0.20 / 0.04.

The trades that would make it "feel" unbalanced (origin/main values; FC =
raw FantasyCalc sum on the same ±10 % band):

| trade | model | FantasyCalc | cause |
|---|---|---|---|
| Gibbs (RB1) for Cook (RB5) + Swift (RB12) | LOSE −20.4 % | WIN +11.9 % | power curve (consolidation premium) |
| Allen (QB1) for Daniels (QB8) + P. Washington (WR15) | LOSE −18.7 % | LOSE −12.3 % | power curve |
| Hubbard (RB9) + P. Washington (WR15) for Bijan (RB2) | LOSE −17.2 % | FAIR +4.2 % (+10.9 % with FC's roster-spot credit) | Bijan ROS RB5 per Sleeper (class B) + curve |
| SF: Dak (QB12) for DJ Moore (WR24) | WIN +19.6 % for the Moore side | LOSE −53.5 % | SF QB replacement too shallow (Dak VORP 24) |
| SF: Burrow (QB2) for Flowers (WR10) | — (Burrow 5,003 vs Flowers 2,580, −48 %) | −51 % | fine, but every QB below QB8 read cheap |
| SF: Stroud (QB10) for Chase Brown (RB15) | FAIR +5.1 % | LOSE −18 % | same |
| Puka Nacua (WR10 market, Q, knee) for Rashee Rice (WR20) | WIN +66.9 % for the Rice side | WIN +40.1 % | fresh injury: Sleeper ROS 0 for all 9 weeks |
| Jalen Coker (WR30) for Jadarian Price (RB30) | LOSE −81.5 % | FAIR +1.4 % | VORP floor tail (Coker VORP 28, Price 0) |
| Christian Watson (WR5) for Rice + Coker + Omar Cooper (WR20/30/40) | WIN +30.6 % | LOSE −13.5 % | class B (Watson ROS WR9, Rice WR14) + floor |

Agreement with the FantasyCalc-only verdict over the 10-20 fairness set
(`scripts/trade-fairness-compare.py`): 1QB 12/20, SF 14/25, dynasty 15/24
before; after this branch 11/20, 11/25, 15/24. The market is not the target
(see Part 2: on realized points the market tilts to the star side exactly
as the old curve did), so the agreement count was not optimised.

## Part 2 — backtest: what is actually unbalanced

`node scripts/backtest-trade-balance.js --dir=/tmp/balance/bt` (new; full
output in `docs/trade-calc-balance-2026-11-10-backtest.txt`). No hindsight:
at T0 = week k the model sees the week-k final pre-kickoff projection (week
k+1 for a bye), statuses from the `data/injuries.json` committed before that
Thursday, and — for the one market T0 — FantasyCalc `value − trend30Day`.
Realized = Sleeper actual PPR points over the next 4 weeks (8 on 2025),
12-team 1QB (QB12 / RB30 / WR42 / TE12) or SF (QB24). Pooled over 17 T0
weeks (2025 weeks 3–15, 2026 weeks 3–6). Four realized definitions, because
the answer depends on it:

- **trunc / realized-rank** (what the 10-20 study used): `max(0, total −
  realized rank-N total)`. Replacement is biased up by selection; bench
  players get option value.
- **trunc / projected-rank**: replacement = mean realized total of the players
  *projected* at ranks N−2…N+2 (unbiased).
- **raw / projected-rank**: negative allowed. Charges an injured starter's
  missed game as −replacement, which no manager experiences (you start
  someone else), and gives every bench player a negative value.
- **lineup-aware**: missed games = 0, projected starters raw, projected bench
  truncated at 0. Closest to what a lineup actually gets.

### A. Value curve by model-rank bucket (share of the top-12 bucket, 1QB, next 4 weeks)

| | 1–12 | 13–24 | 25–48 | 49–72 | 73–96 | 97–120 | 121–150 |
|---|---|---|---|---|---|---|---|
| `^1.25` (old) | 1.00 | 0.57 | 0.35 | 0.16 | 0.04 | 0 | 0 |
| `^1.0` (new) | 1.00 | 0.64 | 0.43 | 0.23 | 0.07 | 0 | 0 |
| repl ×1.5 `^1.25` | 1.00 | 0.64 | 0.45 | 0.28 | 0.16 | 0.01 | 0.01 |
| realized, trunc / realized-rank | 1.00 | 0.56 | 0.40 | 0.31 | 0.18 | 0.05 | 0.03 |
| realized, trunc / projected-rank | 1.00 | 0.58 | 0.43 | 0.33 | 0.20 | 0.06 | 0.04 |
| realized, raw / projected-rank | 1.00 | 0.54 | 0.34 | 0.22 | 0.06 | −0.39 | −0.49 |

Both truncated definitions say the old curve under-values ranks 49–96 by
2–4× relative to a top-12 player; raw says `^1.25` is about right there.
Below-replacement players in the projection top-200 (model value 0): n =
1,770, mean realized VORP 1.5 pts = 4 % of the top-12 mean. 8-week horizon:
same shape.

### B. Synthetic N-for-1 trades (single player = "recv"; pred>0 / real>0 = share of trades the single side wins)

1QB, next 4 weeks, 5,100 trades per shape:

| shape · definition | real>0 | `^1.25` pred>0 · FAIR→real · acc | `^1.0` pred>0 · FAIR→real · acc | repl×1.25 `^1.25` | repl×1.5 `^1.25` |
|---|---|---|---|---|---|
| 2-for-1 · trunc/realized-rank | 52.4 % | 69.6 % · −0.106 · 64.3 % | 65.8 % · −0.045 · 64.6 % | 64.3 % · −0.052 · 64.3 % | 60.0 % · −0.053 · 64.8 % |
| 2-for-1 · trunc/projected-rank | 50.6 % | 69.6 % · −0.110 · 62.9 % | 65.8 % · −0.065 · 63.4 % | 64.3 % · −0.064 · 63.0 % | 60.0 % · −0.077 · 63.6 % |
| 2-for-1 · raw/projected-rank | 62.2 % | 69.6 % · +0.133 · 69.7 % | 65.8 % · +0.193 · 69.8 % | 64.3 % · +0.197 · 68.8 % | 60.0 % · +0.159 · 69.0 % |
| 2-for-1 · lineup-aware | 53.8 % | 69.6 % · −0.074 · 66.3 % | 65.8 % · −0.020 · 66.8 % | 64.3 % · −0.008 · 65.9 % | 60.0 % · −0.004 · 66.1 % |
| 3-for-1 · trunc/realized-rank | 52.6 % | 75.0 % · −0.137 · 62.5 % | 69.2 % · −0.045 · 63.6 % | 67.4 % · −0.036 · 64.4 % | 60.8 % · −0.027 · 64.9 % |
| 3-for-1 · lineup-aware | 52.8 % | 75.0 % · −0.084 · 64.1 % | 69.2 % · +0.004 · 65.4 % | 67.4 % · +0.007 · 65.2 % | 60.8 % · +0.012 · 66.0 % |
| 2-for-1 · 8 weeks, lineup-aware | 52.5 % | 69.0 % · −0.087 · 68.3 % | 65.3 % · −0.025 · 68.9 % | 62.9 % · −0.009 · 67.1 % | 58.9 % · −0.028 · 67.4 % |

FAIR→real = mean realized delta on trades the candidate calls FAIR (negative
= the two-player side actually wins); acc = sign accuracy on decisive
(> 10 %) calls. The calibration slope (realized on predicted) is 0.57 for
`^1.25`, 0.60 for `^1.0`, 0.62–0.65 for deeper lines: every candidate is
over-confident in magnitude, which is what four weeks of noise does.
2-for-2 and 3-for-2 shapes: all candidates within ±1 point of each other.

The market itself (FantasyCalc at the week-6 T0, 300 trades/shape): picks
the single side 70.0 % (2-for-1) / 70.0 % (3-for-1) against a realized
52.7 % / 44.7–52.7 %; its own analyzer's +750-per-roster-spot credit pushes
that to 74.7 % / 81.0 %. So "closer to FantasyCalc" and "closer to realized
points" pull in opposite directions on consolidation; the calculator is a
points model (70 % projection) and follows the points.

### C. Position pairs (1-for-1, share of trades the named side wins: model / realized)

| pair | 1QB `^1.25` (= `^1.0`, order-invariant) | trunc/rr | trunc/pB | raw/pB | lineup-aware |
|---|---|---|---|---|---|
| QB vs skill (n 1,278) | 32.5 % | 32.8 % | 35.9 % | 49.8 % | 49.8 % |
| TE vs skill (n 1,010) | 34.6 % | 28.1 % | 34.6 % | 46.9 % | 42.8 % |
| RB vs WR (n 1,206) | 52.7 % | 45.5 % | 46.0 % | 52.6 % | 51.2 % |
| **SF** QB vs skill (n 1,676), QB24 | **44.8 %** | 62.3 % | 50.5 % | 56.6 % | 59.5 % |
| SF QB vs skill, QB27 (`×1.125`, new) | **60.1 %** | | | | |
| SF QB vs skill, QB30 (`×1.25`) | 82.5 % | | | | |
| SF QB vs skill, repl ×1.5 all positions | 100 % | | | | |

In SF every definition says the QB side wins more often than the model
picks it; QB27 lands inside the realized range, QB30 overshoots. In 1QB the
QB read is metric-dependent (calibrated under the truncated definitions,
under-valued under raw / lineup-aware), so 1QB is left alone. Deeper
replacement for all positions breaks RB-vs-WR (64.6–70.3 % RB vs realized
45–53 %) and TE (15–23 % vs 28–47 %) — that is why the N-for-1 fix is the
exponent, not the replacement line.

SF N-for-1 (lineup-aware): 2-for-1 real 48.9 %, old 66.6 % (FAIR→real
−0.108, acc 61.8 %), new (`QB×1.125 ^1.0`) 59.3 % (−0.069, 63.4 %); 3-for-1
real 46.7 %, old 70.9 % (−0.133, 60.6 %), new 60.4 % (−0.110, 63.8 %).

### D. Market-anchored T0 (2026 week 6, FantasyCalc value − trend30Day, realized weeks 6–9)

One T0, 300 trades per shape, so read for direction only. Per-player
Spearman vs realized: production 0.523, `^1.0` 0.526, market-only 0.492.
2-for-1 FAIR→real (lineup-aware): production −0.160, `^1.0` −0.221 (n = 20
FAIR calls — noise), market −0.220; 3-for-1: −0.243 / −0.192 / −0.209. SF
QB-for-skill (n = 84): production 34.5 %, QB27 38.1 %, market 54.8 %,
realized 45.2 %.

### E. Fresh injuries (played last week, zero/missing projection this week, not a bye)

| class | n | next 4 weeks: pts/wk ÷ prior projection (median) · games played | next 8 weeks |
|---|---|---|---|
| fresh zero | 164 | 0.23 (0.02) · 30 % | 0.32 · 43 % (n 121) |
| healthy (projection > 0) | 2,039 | 0.88 (0.88) · 93 % | 0.83 · 90 % |
| fresh, Questionable on Thursday (2026) | 16 | 0.28 (0.26) · 38 % | 0.46 (n 4) |
| fresh, Out | 6 | 0.13 · 13 % | 0.22 |
| fresh, Doubtful | 6 | 0.18 · 24 % | 0.45 |
| fresh, untagged | 15 | 0.15 (0.00) · 25 % | 0.11 |

43 % of fresh zeros play 0 of the next 4 games; the 75th percentile returns
41 % of the prior projection. Puka Nacua (MCL/PCL + turf toe, expected IR,
≥ 4 games), Josh Jacobs (fractured finger, "may miss no time") and Rhamondre
Stevenson (knee, 2+ weeks) are this week's cases: Sleeper has all three at
0 for every remaining week while tagged Questionable / Out. The floor
values Puka at 1,450 = 29 % of market (market itself −35 % in 30 days),
which is what the class produces on average. Jacobs will look wrong if he
plays Sunday; the feeds cannot tell him apart from Puka. Left alone.

## Part 3 — what changed (two commits, one knob each)

**f6b0e42 — superflex replacement QB one eighth deeper.** `ScoringEngine.
computeVORP(players, proj, scoring, positions, teams, opts)` reads
`opts.qbDepth` (> 1) and multiplies the QB replacement rank by it only when
the league starts ≥ 2 QBs; `TradeFit.SF_QB_DEPTH = 1.125`; trade.html passes
it; 1QB, draft, team and lineup pages do not. Live SF before → after
(week 10, 12 teams): every QB's VORP +16.6 pts (Allen 125 → 142, Love 35 →
52, Dak 24 → 41), QB order unchanged, RB/WR/TE untouched, model/market
median ratio QB 0.48 → 0.71 (WR 0.52). Dak for DJ Moore WIN +19.6 % → FAIR
−9.9 % (FC −53.5 %); Stroud for Chase Brown FAIR +5.1 % → LOSE −18.4 %;
Allen for Walker −18.2 % → −26.2 % (FC −22.7 %); Daniels for London
−18.4 % → −32.7 % (FC −7 %: Daniels' ROS is QB5 per Sleeper, class B).

**7ef18b2 — value linear in points over replacement.** `rescaleVORP(map,
exponent)` keeps its 1.25 default; `TradeFit.VORP_EXPONENT = 1` on the trade
page and in the health script. Live 1QB before → after: Gibbs for Cook +
Swift LOSE −20.4 % → FAIR −8.8 %; Allen for Daniels + Washington LOSE
−18.7 % → FAIR −8.4 %; Bowers for LaPorta + Tate −22.3 % → −11.9 %; JSN for
Nabers + London FAIR +0.9 % → FAIR +9.5 %; mean value by market rank as a
share of the top bucket 1.00 / 0.58 / 0.40 / 0.15 / 0.02 → 1.00 / 0.62 /
0.44 / 0.17 / 0.02 (market 1.00 / 0.68 / 0.44 / 0.20 / 0.04). Side effect:
the model half is less compressed, so it carries more of the 70/30 blend
below the top — Spearman vs market 0.98 → 0.97 (1QB), median model/market
ratio WR 0.47 → 0.64, RB 0.35 → 0.41 (QB/TE 0.31, floor-bound). The 10-20
study found blend weights 0.25–0.75 indistinguishable in accuracy, so this
is not re-weighted. Dynasty (50/50 blend) moves half as much.

Combined after state (`^1`, SF QB27): SF Spearman vs market 0.97 (QB 0.95),
QB median ratio 0.88, RB 0.46, WR 0.73, TE 0.31; dynasty 0.99 (all
positions 0.50 by construction); below-replacement count in the market
top-200: 1QB 100 (unchanged), SF 88 → 85.

## Part 4 — deliberately left alone, and why

1. **Fresh-injury zeros** (Part 2E): the floor is right on average; a
   "use the market when Sleeper is all zero" rule would double-count the
   market's own discount and reward the Jacobs case by luck.
2. **The VORP floor / tail contrast**: realized tail value is 3–5 % of a
   top-12 player's; the model's 2 % is low but the only lever (deeper
   replacement) breaks cross-position balance. A per-position cushion would
   be tuning without a backtest that can resolve it.
3. **1QB QB scaling**: metric-dependent, no consistent direction.
4. **Blend weight, hot ×0.95, residual injury table, age curve, playoff
   factor, Roster Fit multipliers, FAIR band**: no new evidence; the 10-20
   doc's findings stand.
5. **team.html** still uses `rescaleVORP`'s 1.25 default, so /team and /trade
   now differ in scale (not order) for the same player. The 10-19 follow-ups
   aligned the two pages on ROS; aligning the exponent is the same kind of
   follow-up and was kept out of this diff to keep it to the trade page.
6. **Picks** remain unsupported; the market feed's `FP_*` rows are skipped
   as "not in slim dict" by the health script.

## Tests / verification

- `node --check` OK: shared/scoring.js, shared/trade-fit.js, both scripts.
- `node scripts/test-trade-fit.js`: exit 0, 142 ok (13 new: computeVORP
  `qbDepth` in SF / 2QB / 1QB, bad inputs, QB-only effect; rescaleVORP
  exponent linear, default unchanged, bad inputs, order invariance, the
  50 + 50 for 100 = FAIR vs WIN +16 % case). `--live --base=
  http://localhost:7898`: live audit passes.
- `npm test` (NBA offline, `data/nba/cache` cleared) **does not exit 0 on
  this branch, and does not exit 0 on a pristine origin/main checkout
  either.** Every suite before `test-nba-trade` passes (530 ok lines:
  weekly-score, lineup, trade-fit, ros-guard, week-history, waivers and 14
  NBA suites). `scripts/test-nba-trade.js` fails 3 checks ("23 Sleeper
  weeks: expected 23, got 20" — §4.6 #5, v2 horizon, §4.6 #9), which stops
  the `&&` chain; the twelve suites after it were run one by one: 8 pass
  (waivers, copy, ui-kit, research-ui, slot-picker, league-picker, clock,
  ingest-format3), 4 fail (research 2 checks, spec-contract 1, shared 3,
  team 1). All five failing files were re-run on a fresh `git worktree` of
  origin/main 37583cc with the same env: **identical exit codes and
  failures.** They are NBA suites keyed to the live NBA week / fixture
  dates; nothing in this branch touches NBA code. Every NFL suite passes.
- `/trade` in headless Chromium 147 over CDP (`/tmp/balance/cdp-trade.js`,
  branch server :7898): boots with 3,201 players, 196 market rows, ROS
  weeks 10–18, `TradeFit.VORP_EXPONENT 1`, `SF_QB_DEPTH 1.125`; manual 1QB
  (Gibbs for Cook + Swift FAIR 8.8 %, Allen for Walker WIN 17.3 %, Watson
  3-for-1, Puka for Rice, 2-for-2), SF preset (Allen 6,427 → 9,633, Dak 385
  → 2,839, Dak for Moore FAIR 7.3 %), dynasty preset, back to 1QB, mocked
  connected mode (Coast to Coast, 10 teams: Roster Fit rows render,
  need-adjusted verdict renders). **0 console errors, 0 exceptions, 0
  NaN / Infinity / undefined in the DOM.**

## Repro

```
cd ~/projects/fantasy-draft-assistant-wt/trade-calc-balance
PORT=7898 NBA_MODEL_OFFLINE=1 node --env-file=.env.local server.js &
# live before/after (flags reproduce origin/main's scale)
node scripts/trade-calc-health.js --exp=1.25 --json=/tmp/b/1qb-before.json
node scripts/trade-calc-health.js --json=/tmp/b/1qb-after.json
node scripts/trade-calc-health.js --sf=1 --exp=1.25 --qbdepth=1 --json=/tmp/b/sf-before.json
node scripts/trade-calc-health.js --sf=1 --json=/tmp/b/sf-after.json
python3 scripts/trade-fairness-compare.py /tmp/b          # expects health-{1qb,sf,dyn}.json
# backtest inputs (Sleeper 2025 wk 1–18, 2026 proj 1–11 / stats 1–10; 4 FC lists; slim; inj-wkN.json from git)
mkdir -p /tmp/balance/bt && cd /tmp/balance/bt && POSQ='position[]=QB&position[]=RB&position[]=WR&position[]=TE'
for w in $(seq 1 18); do curl -s "https://api.sleeper.com/projections/nfl/2025/$w?season_type=regular&$POSQ" -o proj-2025-$w.json; curl -s "https://api.sleeper.com/stats/nfl/2025/$w?season_type=regular&$POSQ" -o stats-2025-$w.json; done
for w in $(seq 1 11); do curl -s "https://api.sleeper.com/projections/nfl/2026/$w?season_type=regular&$POSQ" -o proj-2026-$w.json; done
for w in $(seq 1 10); do curl -s "https://api.sleeper.com/stats/nfl/2026/$w?season_type=regular&$POSQ" -o stats-2026-$w.json; done
curl -s 'https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=1' -o fc_1qb.json   # + numQbs=2 → fc_sf.json, isDynasty=true → fc_dyn.json / fc_dyn_sf.json
curl -s localhost:7898/api/players/slim -o slim.json
cd ~/projects/fantasy-draft-assistant-wt/trade-calc-balance
for w in 1 2 3 4 5 6 7 8 9 10; do d=$(python3 -c "import datetime;print((datetime.date(2026,9,11)+datetime.timedelta(days=7*($w-1))).isoformat())"); c=$(git log --format='%h %ad' --date=iso-strict -- data/injuries.json | awk -v d="${d}T00:15:00+00:00" '$2<=d{print $1; exit}'); git show $c:data/injuries.json > /tmp/balance/bt/inj-wk$w.json; done
node scripts/backtest-trade-balance.js --dir=/tmp/balance/bt --json=/tmp/balance/balance-bt.json
node scripts/test-trade-fit.js && npm test
```
