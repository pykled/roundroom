# Pocket NBA: High Score trade calculator (stream E)

Code: `nba/model/trade.js` (pure, deterministic), `nba/routes/trade.js` (HTTP), `nba/pages/trade.*` (UI). Tests: `node scripts/test-nba-trade.js`.

## What a player is worth in a trade
A player is not worth his `hsValue`. He is worth what he changes in **your** best lineup, week by week, for the rest of the season.

For each remaining week `w` (board weeks ≥ `currentWeek`, capped at the Yahoo `end_week` when known):

1. **Week value of a roster** = the best G, G, F, F, F, UTIL lineup by `hsByWeek[w]`, plus a bench share.
   - `hsByWeek[w]` already contains that week's game count, opponents and injury availability (see `docs/nba-model.md`), so an OUT star is near 0 in the next weeks and ramps back later.
   - The lineup is solved exactly: a DP over (G used, F used, UTIL used) in which every player is benched or takes one slot. The test checks it against brute force on 150 random rosters. Dual G/F players move to whichever slot frees room.
   - **Bench share**: the 7th to 10th best non-starters add 12% / 7% / 4% / 2% of their value **above waiver replacement**. Depth counts, but only a little, and only when it beats the waiver wire.
   - **Open roster spots** (below the roster size) are filled by a replacement-level player who can play any slot.
2. **Team value** = Σ_w weight_w × week value. The weight is 1.0. Weeks from the league's `playoff_start_week` onward weigh **1.5** only when Yahoo settings provide that week; without it every week weighs 1.0.
3. **Trade delta for a side** = team value after − team value before.
   - After the trade the roster is `before − out + in`. If that is over the cap (`max(rosterSize, size before)`, so IL overflow isn't forced out), the side **drops the player whose loss costs the least**. It searches the whole roster, which can include an incoming player, because that is the truth of the deal.
   - A side that ends up with fewer players gets an open spot, filled at replacement level. That is how 2-for-1 and 3-for-2 deals pay for the drop or the freed spot.
4. **Marginal value per player** (shown in the "why" bullets) = team value with him − without him, per week. A 3rd great big when you already have two shows up as surplus: he adds only bench share plus whatever he beats in UTIL.

### Waiver replacement level
For each week, the replacement level is 0.9 × the **3rd best** `hsByWeek[w]` among players **not on any roster** in the league. Yahoo mode gets the league rosters from the context loader. Without rosters it uses a percentile: the 3rd player past `teams × rosterSize` on the board. Out-for-season players are excluded. The ×0.9 reflects that a waiver add costs a claim and carries role risk.

### Both sides, verdict, ranges
- The partner's delta is computed exactly the same way on their roster. Swapping sides swaps the numbers (tested), and reversing a trade negates them (tested).
- Partner roster unknown (manual mode): a **typical partner** stands in. The board is drafted in rank order (my players excluded), the middle snake slot takes its 10 picks, and the players I'd get replace its last rounds. This is flagged `them.estimated`.
- **Fair band** = max(1, 0.75% of my weekly lineup total), about 2.5 points/week for a typical team.
  - **Accept**: my Δ/wk ≥ band.
  - **Counter**: |my Δ| < band, or I lose between 1 and 3 bands while they gain ≥ 1 band (a small add can close the gap).
  - **Decline**: anything else, including any loss beyond 3 bands however much they gain (Checker E, 2026-10-13: the old "they gain ≥ 2× band → Counter" rule made almost every lopsided loss read Counter).
- Partner acceptance uses the band computed on their own team: `likely` if their Δ ≥ −band, `maybe` down to −3× band, `unlikely` below that.
- **Ranges**: each traded player's ROS value is perturbed by its uncertainty `u` on its own. `u` = 0.10, +0.10 if projection-only or rookie, +0.08 if injured, +0.05 if under 20 sample games, capped at 0.35. The resulting changes in the delta combine in quadrature (independent errors). The range is Δ ± that. It is deterministic; no simulation.
- Output per week (`weeks[]`): my Δ, their Δ, games in vs out, replacement level, weight. The UI draws heavy vs light weeks from this.
- "Typical week" lineup before and after (UI diff): the same DP on ROS-average values. Players who stay in the same slot group keep their row, so only real changes are highlighted.

## Market value layer: skipped (researched 2026-10-13)
Superseded by v2 below: the Value axis blends in the preseason consensus (`data/nba/market.json`) with a weight that fades to 0 by week 11. The verdict itself still uses no market data.
- **FantasyCalc**: `api.fantasycalc.com/values/current?sport=nba` ignores `sport` and returns NFL values. No NBA data.
- **Sleeper trending** (`/v1/players/nba/trending/add`): works, but it is an add/drop hype count, not a trade value. It belongs to waivers (stream F) if anywhere.
- **Yahoo ownership %**: the API has a `percent_owned` player subresource, but `nba/yahoo/client.js` doesn't request it and stream E may not edit A's client. It would only ever be a tie-break signal. Left as a follow-up for G.

So no market signal is blended into the numbers. The verdict is purely lineup-based.

## Known limits
- Yahoo week numbers are assumed equal to Sleeper week numbers (same caveat as the model).
- The lineup is set once per week on expected values. Mid-week swaps after an in-game injury are only reflected through the bench share.
- Per-week replacement assumes you can stream one top-3 free agent each week. The 0.9 factor tempers this, but in deep leagues it's optimistic.
- Uncertainties are hand-set, not backtested.
- The estimated partner is a mid-draft archetype. Real rosters are only used in Yahoo mode or when `partnerRoster` is sent.

## Performance
On the real board (650 players, 25 weeks), a 2-for-1 with both rosters known takes about 20 ms including ranges, and a 1-for-1 with an estimated partner about 5 ms.

## League profile (stream L1, 2026-10-13)
Slots, roster size, IL, teams, draft rounds, playoff weeks and trade rules come from the league profile (default 242808). `settings` and Yahoo `roster_positions` (now parsed into the full slot map by `rosterShape`) override it.
- **Lineup:** the shared exact assignment over the profile's slots (`nba/model/roster-slots.js`), with Yahoo eligibility.
- **Roster cap** = active spots (14) + IL slots actually holding IL-eligible (Out) players. Overflow the roster already had before the trade is tolerated, not forced out. So receiving an Out player who can go straight to IL doesn't force a drop (tested).
- **Bench share scales with starters:** the High Score curve 12/7/4/2% (6 starters) is multiplied by starters/6 and cut to the bench size. For 242808 that's 18/10.5/6/3/1.5% across 5 BN. More starters means more absences for the bench to cover each week.
- **Unfillable slots:** on a full roster, a starting slot nobody can play (e.g. no C) is filled at waiver replacement level, because you'd drop your worst bench player for a free agent. Before this fix a hole counted as 0, so a hole-filling 1-for-1 between two ~32/wk players scored +32/wk. The typical-lineup table shows that slot as "Waiver add".
- **Playoffs:** weeks 20-22 weigh 1.5× (from the profile's `playoffs` flags). The schedule runs through week 22.
- **Trade rules** (`meta.rules`, shown in the UI): deadline 2027-03-04 with days left, commissioner review, a 2-day protest window (players arrive about 2 days after acceptance), no draft-pick trades. After the deadline, `rules.open = false` and the route adds a warning.
- The after-trade typical lineup keeps players in their before slot when a pairwise swap allows it, so only real changes are highlighted.

### Verdict thresholds re-validated (242808, 30 realistic trades)
Run `node scripts/nba-trade-validate.js --md`. Rosters come from a 12-team, 14-round snake draft in Yahoo pre-rank order on the real board, with every roster known (league replacement level). Indices are each team's hsValue order. Fair band = 0.75% of my weekly lineup, about 2.8-3.2/wk with 9 starters.

| # | trade | give | get | raw hsValue Δ | my Δ/wk | their Δ/wk | band | verdict | partner |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1-for-1 like-for-like (2nd best) | Devin Booker (45.1) | Chet Holmgren (47.4) | 2.3 | 2.1 | -2.3 | 3 | Counter | likely |
| 2 | 1-for-1 like-for-like (5th best) | Austin Reaves (40.1) | Jaren Jackson (39.7) | -0.4 | -0.6 | 0.4 | 2.8 | Counter | likely |
| 3 | 1-for-1 like-for-like (8th best) | Jusuf Nurkić (36.8) | Neemias Queta (36.5) | -0.3 | -1.3 | 0.8 | 2.9 | Counter | likely |
| 4 | 1-for-1 small upgrade (my 6th for their 5th) | Keyonte George (39.9) | Domantas Sabonis (39.5) | -0.4 | -0.4 | -3.6 | 3.1 | Counter | maybe |
| 5 | 1-for-1 small downgrade (my 3rd for their 4th) | Jalen Brunson (46.4) | Alex Sarr (45.6) | -0.8 | -0.7 | 0.8 | 3 | Counter | likely |
| 6 | star for star (best for best) | Nikola Jokić (75) | Jalen Johnson (57.9) | -17.1 | -17.2 | 21.1 | 3 | Decline | likely |
| 7 | my best for their 3rd | Victor Wembanyama (72.4) | Deni Avdija (47.4) | -25 | -25.1 | 24.6 | 3.2 | Decline | likely |
| 8 | my 3rd for their best | Jalen Duren (49.8) | Nikola Jokić (75) | 25.2 | 25.2 | -25.2 | 2.8 | Accept | unlikely |
| 9 | lopsided: my best for their 9th | Luka Dončić (65.6) | Andrew Wiggins (35.6) | -30 | -30 | 30 | 3.1 | Decline | likely |
| 10 | lopsided: my 12th for their 2nd | Jaime Jaquez (27.4) | Derik Queen (43.9) | 16.5 | 8.6 | -12.3 | 2.8 | Accept | unlikely |
| 11 | bench for bench (13th for 13th) | Zach LaVine (25.3) | Rui Hachimura (24.8) | -0.5 | 0.2 | -0.3 | 2.9 | Counter | likely |
| 12 | bench for bench (12th for 14th) | Yves Missi (28.7) | Jake LaRavia (21.2) | -7.5 | 0 | 0 | 2.9 | Counter | likely |
| 13 | 2-for-1 consolidation: my 2nd+3rd for their best | Derik Queen (43.9) + Joel Embiid (42.8) | Nikola Jokić (75) | -11.7 | 20.1 | -21 | 2.8 | Accept | unlikely |
| 14 | 2-for-1 consolidation: my 4th+5th for their 2nd | Matas Buzelis (42.8) + Jaren Jackson (39.7) | Alperen Şengün (54.7) | -27.8 | 2.7 | -4.7 | 2.8 | Counter | maybe |
| 15 | 2-for-1 consolidation: my 6th+7th for their 3rd | Ryan Rollins (41.7) + Ayo Dosunmu (39.2) | LeBron James (45.6) | -35.3 | -1.2 | 0.9 | 2.9 | Counter | likely |
| 16 | 1-for-2 depth: my best for their 2nd+3rd | Nikola Jokić (75) | Jamal Murray (50.2) + Jalen Duren (49.8) | 25 | -7.5 | 11.7 | 3 | Counter | likely |
| 17 | 1-for-2 depth: my 3rd for their 5th+6th | Jalen Brunson (46.4) | Domantas Sabonis (39.5) + Kon Knueppel (39.3) | 32.4 | 6.9 | -6.4 | 3 | Accept | maybe |
| 18 | 1-for-2 depth: my 6th for their 9th+10th | Trae Young (41.5) | Dylan Harper (34.6) + Toumani Camara (32.1) | 25.2 | -6.5 | 4.9 | 2.9 | Counter | likely |
| 19 | 2-for-2 swap (2nd+6th for 3rd+5th) | Bam Adebayo (54.1) + Julius Randle (43.4) | James Harden (47.5) + Jaren Jackson (39.7) | -10.3 | -10.4 | 10.5 | 3.2 | Decline | likely |
| 20 | 2-for-2 swap (4th+9th for 4th+8th) | Rudy Gobert (43) + Andrew Wiggins (35.6) | Paolo Banchero (49.9) + De'Aaron Fox (36.3) | 7.6 | 7.7 | -7.7 | 2.9 | Accept | maybe |
| 21 | 2-for-2 lopsided (1st+2nd for 7th+8th) | Tyrese Maxey (51.6) + Jamal Murray (50.2) | Nic Claxton (40) + Neemias Queta (36.5) | -25.3 | -25.1 | 25 | 2.8 | Decline | likely |
| 22 | 3-for-1 (2nd,3rd,4th for their best) | Tyrese Haliburton (42.9) + Derrick White (40.7) + Caleb Wilson (40) | Victor Wembanyama (72.4) | -51.2 | 13.4 | -21.3 | 2.8 | Accept | unlikely |
| 23 | 3-for-2 (5th,6th,7th for their 3rd+4th) | Walker Kessler (41.5) + Brandon Miller (40) + Nic Claxton (40) | Deni Avdija (47.4) + Cameron Boozer (42.2) | -31.9 | 2.3 | -4.4 | 2.9 | Counter | maybe |
| 24 | give 1 for nothing (my 10th) | Ja Morant (31) | — | -31 | -0.6 | 0.5 | 3.1 | Counter | likely |
| 25 | receive 1 for nothing (their 11th) | — | Wendell Carter (30.7) | 30.7 | 0.2 | 1.3 | 2.8 | Counter | likely |
| 26 | near-equal 1-for-1 (7th for 7th) | Brandin Podziemski (36.3) | Ausar Thompson (38.6) | 2.3 | 2.4 | -2.4 | 2.8 | Counter | likely |
| 27 | near-equal 1-for-1 (10th for 10th) | Toumani Camara (32.1) | P.J. Washington (32.4) | 0.3 | 2.2 | -0.5 | 2.9 | Counter | likely |
| 28 | positional: my surplus C for their G | Jalen Duren (49.8) | Tyrese Haliburton (42.9) | -6.9 | -0.5 | 7.1 | 2.8 | Counter | likely |
| 29 | positional: their surplus C for my G | Tyrese Haliburton (42.9) | Jalen Duren (49.8) | 6.9 | 7.1 | -0.5 | 2.8 | Accept | likely |
| 30 | injured: my Out Jusuf Nurkić for a healthy twin | Jusuf Nurkić (36.8) | CJ McCollum (36.3) | -0.5 | -1.2 | 1.9 | 2.9 | Counter | likely |

30 trades: Accept 7, Counter 18, Decline 5

Reading: every loss beyond 3 bands is a Decline (#6, 7, 9, 19, 21). Every gain of at least 1 band is an Accept. Near-equal swaps and small losses where the partner gains are Counter. Consolidation deals are scored by lineup impact, not raw hsValue (#13 and #22 Accept despite a raw −12/−51; #14 and #23 Counter). The positional pair #28/#29 shows the same swap is a wash for the C-heavy team and a gain for the team short a C. Verdict: **thresholds kept unchanged** (FAIR_BAND 0.75%, COUNTER_BANDS 3). With 9 starters the band scales with the weekly total on its own, and no case looked mis-labelled once the waiver-filled-hole fix was in. The test suite asserts the Decline/Accept bounds on this run.

## v2: value axis, signals, team fit, horizon (Stream B, 2026-10-15)
Spec: `docs/nba-trade-team-spec.md` §4. The response is a superset of v1 (`version: 2`); every v1 field keeps its name and meaning, so old clients keep working.

### What the verdict is (unchanged) and what's new
- **Fit axis = the verdict.** Accept / Counter / Decline on *your* lineup Δ/wk, same bands (0.75% of your weekly lineup, Decline past 3 bands).
- **Value axis (new, league-neutral).** "Is this a fair swap of players, whoever's team they land on?" `value.assetIn/assetOut` = Σ `signals.value.blended` of the players you get / give (pts/wk, horizon-weighted, with the preseason market prior). `gap = assetIn − assetOut + consolidationAdj`.
  - **Market prior:** `blended = (1 − w)·ros + w·impliedValue(marketRank)`, `w = 0.30·max(0, 1 − (week − 1)/10)` (0.30 in week 1, 0.15 in week 6, 0 from week 11), half for contested/thin market rows. `impliedValue(rank)` = hsValue of the board's rank-th player (linear between ranks, replacement past the board). Only the Value axis uses it; the board and the Fit axis never do.
  - **Roster spots (consolidation):** counted by head count (IL moves are a lineup matter, already on the Fit axis). Each extra player takes a spot worth a waiver add (replacement); past the roster limit the side waives its cheapest player and loses his value above replacement; a side that frees spots gets waiver adds. Half of each side's spot effect goes into the gap so swapping perspectives negates it exactly.
  - **Label:** `|gapPct|` ≤ 10% Even, ≤ 25% Leans, ≤ 40% Favors, else Lopsided (your way / their way). **Deviation from the spec text, on purpose:** `gapPct` is measured on value *above a waiver add*, transformed like the NFL side's `computeVORP` (`max(0, blended − replacement)^1.25`), with the denominator floored at a top-25 player (20/wk above replacement). On raw pts/wk the spec's own calibration fails: Jokić 73 for Jalen Johnson 57 is only about 24% apart in pts/wk (reads "Leans") but 48% above replacement (Lopsided). With the floor, small swaps between role players don't read lopsided. `assetIn/assetOut/gap` stay in raw pts/wk (what the page shows); `surplusIn/surplusOut/surplusGap` carry the transformed numbers.
- **Per-player signals:** `players[].signals` (spec §3.3 shape), `slotBefore`/`slotAfter` (slot on his current team's typical lineup / on his new team's; `BN` when benched), `fit { group, tierBefore, tierAfter }` (your tier in the group he plays for you), `why[]` built only from signals fields and flags (numbers in pts/wk; ETA as "~wk N (Mon D)"; last season's stats tagged "2025-26").
- **Team fit:** `fit { before, after, deltaByGroup, notes, leagueRelative }` for you, `themFit` for the partner when their roster is real. Tiers use the NFL matrix (`roster-analysis.js assessTier`); with every league roster known (Sleeper mode) they are league-relative (group starter value vs the league average and the top-30% cutoff, the team page's rule), otherwise depth-only.
- **Horizon + lean** (`options`): `horizon` ros (default) / next4 / playoffs (playoff weeks only; the route answers 400 `horizon_unavailable` before week 10); `lean` contend (playoff weeks ×1.5, the v1 behaviour) / balanced (×1.0). Default lean: contend through week 4 and in manual mode; after week 4 a connected team is contend when its record is ≥ .550 or it sits inside the playoff line, else balanced (`options.leanSource` says which). The keeper lens (`rebuild`) is not built (spec Q2 default).
- **`summary`** `{ headline, verdictLine, valueLine, fitLine, notes }` and **`dataAsOf`** `{ board, market, injuryEta, logsSeason, signals }`.

### Shared layer (Stream A) and the interim stand-in
`trade.js` calls `signals.signalsFor` and `roster-analysis.analyzeRoster` first. While they throw `NOT_IMPLEMENTED`, it uses `nba/model/trade-interim.js`, which computes the same shapes from the board, the committed logs (`research.js logStats`), the projections and `market.json` (`dataAsOf.signals = 'interim'`). Gaps until A lands: no ESPN return dates (an injured player's return week is read off the board's own ramp and labelled "model estimate"), no back-to-backs, no bio/age, no injury exposure. When A merges, nothing in B changes; the interim file becomes dead code and can be deleted. B passes `ctx.board` (the whole board) to `signalsFor` for the market rank→value curve and calls it with the traded players only.

### Fit-axis change: waiver streaming for any slot below waiver level
v1 streamed a waiver add only into a starting slot nobody could fill. v2 offers the stream for every slot (one waiver add per player who has to sit, each costing the worst bench player), so a slot only playable below waiver level is valued at the waiver add. Found by the monotonicity test (spec §4.6 #3): Dillon's real roster (13 of 14 spots, F slot otherwise filled by LaVine at 24/wk vs a 28.7 waiver add) lost up to 4.4/wk by *receiving* an extra guard who used up the open spot. The typical-lineup table shows such a slot as "Waiver add". The 30-trade table moved by ≤ 0.9/wk.

### Route and page
- `POST /api/nba/trade/evaluate` with `sleeper_league_id` builds the league's own profile from Sleeper (`profileFromSleeper`: 3 UTIL, 23 Mon–Sun weeks, playoffs 21–23, deadline week 17, 2 IL) and values the board under it (cached 10 min per league); A's `LC.profileFor({ sleeperLeagueId })` takes over automatically once it returns a Sleeper profile. Categories leagues → 400 `league_not_points`; unknown league → 404; bad `options` → 400. Every roster (IL excluded) feeds the league-relative fit tiers.
- `GET /api/nba/trade/context` teams now carry `record` (for the lean); the raw Sleeper payload never leaves the server.
- Page: horizon + lean controls, the value meter (driven by the Value axis, captioned "you give X, get Y in season value"), Team Fit card, Player Signals card (value, games, last-5 form, minutes, market vs model, why lines, signal chips), signal chips on each traded player row. League mode loads the board with `/api/nba/players?league_id=` (served as the default board until A wires the Sleeper profile there).
- **Deep link** (team page "Open in Trade"): `/nba/trade?league_id=&partner=&give=&get=[&horizon=]` (ids comma-separated). Works without connecting (public league data): my team is the roster holding the `give` players; players no longer on those rosters are dropped with a banner; the URL is cleaned after it's applied.

### Tests (spec §4.6) — `node scripts/test-nba-trade.js`
1 symmetry (value gap negates exactly, 1-for-1 and n-for-m); 2 reversal (exact for equal counts; direction flips for n-for-m, whose waived player differs by side); 3 monotonic (60 random real-roster trades); 4 ±2% on each traded player of the 30 trades moves you.perWeek < 1 band, and a verdict may change only for a trade already within that move of an edge (3–4 of the 30 sit that close on any given day; they are listed in the output); 5 the table below (Fit bounds + Value calibration); 6 ETA why (model ramp and the ESPN shape from `signals.example.json`); 7 market decay; 8 byte-identical output, no NaN; 9 route (v1 body, Sleeper profile 23 weeks, categories 400, horizon 400, options 400, 404); 10 2-for-2 with both rosters, signals and league tiers ≈ 36–45 ms warm (budget 60). Browser: `python3 scripts/nba-trade-v2-screens.py` (spawns `scripts/nba-trade-mock.js`: real NBA router + offline model, Sleeper faked from the league fixtures) → `docs/nba-trade-v2/*.png` at 375 and 1280.

### 30-trade table under the Sleeper profile (`node scripts/nba-trade-validate.js --md`, run 2026-10-15 PT)
Rosters: 12-team, 13-round snake in market-consensus order on the real board under Dillon's league profile; every roster known. The board depends on the date (recency weights, injury ramps), so numbers drift a little day to day; the assertions are on the rules, not the digits.

Profile: HALIMSANITY 26-27 (sleeper), 10 starters, 23 weeks, 12 teams × 13 rounds.

| # | trade | give | get | raw hsValue Δ | my Δ/wk | their Δ/wk | band | verdict | partner | value out → in | value gap | value label |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1-for-1 like-for-like (2nd best) | Devin Booker (44.2) | Deni Avdija (46.4) | 2.2 | 2.1 | -2.1 | 3.1 | Counter | likely | 45 → 45.2 | 1% | Even |
| 2 | 1-for-1 like-for-like (5th best) | Austin Reaves (38.9) | Jaren Jackson (38.5) | -0.4 | -0.4 | 0.2 | 3 | Counter | likely | 41.4 → 39.1 | -12% | Leans their way |
| 3 | 1-for-1 like-for-like (8th best) | Jusuf Nurkić (35.5) | Neemias Queta (35.5) | 0 | -1 | 0.9 | 3.1 | Counter | likely | 35 → 35.1 | 0% | Even |
| 4 | 1-for-1 small upgrade (my 6th for their 5th) | Keyonte George (38.9) | Kon Knueppel (38.6) | -0.3 | -0.3 | -1.3 | 3.2 | Counter | likely | 39.3 → 38.7 | -3% | Even |
| 5 | 1-for-1 small downgrade (my 3rd for their 4th) | Jalen Brunson (45.8) | Alex Sarr (43.9) | -1.9 | -1.9 | 1.9 | 3.2 | Counter | likely | 45.8 → 43.4 | -14% | Leans their way |
| 6 | star for star (best for best) | Nikola Jokić (73) | Jalen Johnson (57) | -16 | -16.1 | 18.1 | 3.1 | Decline | likely | 73.1 → 55.4 | -48% | Lopsided for them |
| 7 | my best for their 3rd | Victor Wembanyama (71.4) | Chet Holmgren (46.3) | -25.1 | -25.1 | 25.1 | 3.3 | Decline | likely | 71.4 → 46.2 | -69% | Lopsided for them |
| 8 | my 3rd for their best | Jalen Duren (49) | Nikola Jokić (73) | 24 | 24.2 | -24.2 | 3 | Accept | unlikely | 47.7 → 73.1 | 67% | Lopsided for you |
| 9 | lopsided: my best for their 9th | Luka Dončić (64.2) | Andrew Wiggins (34.9) | -29.3 | -29.4 | 28.7 | 3.2 | Decline | likely | 64.2 → 35 | -91% | Lopsided for them |
| 10 | lopsided: my 12th for their 2nd | Jaime Jaquez (26.6) | Derik Queen (42.9) | 16.3 | 10.9 | -12.9 | 2.9 | Accept | unlikely | 27.4 → 40.3 | 45% | Lopsided for you |
| 11 | bench for bench (13th for 13th) | Zach LaVine (24.1) | Rui Hachimura (24.2) | 0.1 | 0.5 | -0.8 | 3 | Counter | likely | 26.9 → 25.2 | 0% | Even |
| 12 | bench for bench (12th for 13th) | Yves Missi (28.1) | Dillon Brooks (27.1) | -1 | 0 | 0 | 3.1 | Counter | likely | 28.3 → 27.6 | 0% | Even |
| 13 | 2-for-1 consolidation: my 2nd+3rd for their best | Derik Queen (42.9) + Trey Murphy (41.5) | Nikola Jokić (73) | -11.4 | 18.8 | -19.5 | 3 | Accept | unlikely | 82.5 → 73.1 | 62% | Lopsided for you |
| 14 | 2-for-1 consolidation: my 4th+5th for their 2nd | Matas Buzelis (41.8) + Jaren Jackson (38.5) | Alperen Şengün (53.5) | -26.8 | 3.1 | -3.8 | 3 | Accept | maybe | 80.5 → 51.6 | 20% | Leans your way |
| 15 | 2-for-1 consolidation: my 6th+7th for their 3rd | Ryan Rollins (40.6) + Ayo Dosunmu (37.8) | LeBron James (44.4) | -34 | -2.1 | 1.4 | 3.1 | Counter | likely | 76.6 → 43.9 | -5% | Even |
| 16 | 1-for-2 depth: my best for their 2nd+3rd | Nikola Jokić (73) | Jamal Murray (49) + Jalen Duren (49) | 25 | -5.8 | 5.3 | 3.1 | Counter | likely | 73.1 → 97 | -30% | Favors them |
| 17 | 1-for-2 depth: my 3rd for their 5th+6th | Jalen Brunson (45.8) | Kon Knueppel (38.6) + Nickeil Alexander-Walker (37.9) | 30.7 | -0.5 | -0.2 | 3.2 | Counter | likely | 45.8 → 77 | -5% | Even |
| 18 | 1-for-2 depth: my 6th for their 9th+10th | Trae Young (40) | Dylan Harper (34.1) + Toumani Camara (31.4) | 25.5 | -5.3 | 5.4 | 3 | Counter | likely | 42.7 → 66.2 | -36% | Favors them |
| 19 | 2-for-2 swap (2nd+6th for 3rd+5th) | Bam Adebayo (53) + Julius Randle (42.3) | James Harden (46.5) + Jaren Jackson (38.5) | -10.3 | -10.4 | 10.4 | 3.3 | Decline | likely | 92.2 → 85 | -27% | Favors them |
| 20 | 2-for-2 swap (4th+9th for 4th+8th) | Rudy Gobert (42) + Andrew Wiggins (34.9) | Paolo Banchero (48.7) + Myles Turner (35.3) | 7.1 | 6.6 | -7.2 | 3.1 | Accept | maybe | 75.6 → 82.3 | 37% | Favors you |
| 21 | 2-for-2 lopsided (1st+2nd for 7th+8th) | Tyrese Maxey (50.6) + Jamal Murray (49) | Nic Claxton (38.6) + Neemias Queta (35.5) | -25.5 | -25.6 | 25.6 | 3 | Decline | likely | 100.8 → 71.7 | -78% | Lopsided for them |
| 22 | 3-for-1 (2nd,3rd,4th for their best) | Tyrese Haliburton (41.2) + Derrick White (39.8) + Caleb Wilson (38.9) | Victor Wembanyama (71.4) | -48.5 | 11.9 | -16.8 | 2.9 | Accept | unlikely | 123.9 → 71.4 | 39% | Favors you |
| 23 | 3-for-2 (5th,6th,7th for their 3rd+4th) | Walker Kessler (39.8) + Brandon Miller (39.2) + Nic Claxton (38.6) | Chet Holmgren (46.3) + Cameron Boozer (41.5) | -29.8 | 0.3 | -2.2 | 3.1 | Counter | likely | 116.9 → 87.6 | 12% | Leans your way |
| 24 | give 1 for nothing (my 10th) | Ja Morant (30) | — | -30 | -0.8 | 0.6 | 3.2 | Counter | likely | 30.6 → 0 | -2% | Even |
| 25 | receive 1 for nothing (their 11th) | — | Wendell Carter (29.8) | 29.8 | 0.2 | -0.2 | 3 | Counter | likely | 0 → 29.9 | 0% | Even |
| 26 | near-equal 1-for-1 (7th for 7th) | Brandin Podziemski (37.3) | Ausar Thompson (37.8) | 0.5 | 0.5 | -0.5 | 3 | Counter | likely | 36.7 → 37.9 | 6% | Even |
| 27 | near-equal 1-for-1 (10th for 10th) | Toumani Camara (31.4) | Kyrie Irving (29) | -2.4 | -0.1 | 0.4 | 3.1 | Counter | likely | 31.6 → 31.3 | -1% | Even |
| 28 | positional: my surplus C for their G | Jalen Duren (49) | Donovan Mitchell (47) | -2 | -1.9 | 4 | 3 | Counter | likely | 47.7 → 48.2 | 3% | Even |
| 29 | positional: their surplus C for my G | Donovan Mitchell (47) | Jalen Duren (49) | 2 | 4 | -1.9 | 3.1 | Accept | likely | 48.2 → 47.7 | -3% | Even |
| 30 | injured: my Out Jusuf Nurkić for a healthy twin | Jusuf Nurkić (35.5) | CJ McCollum (35.7) | 0.2 | -0.9 | 0.7 | 3.1 | Counter | likely | 35 → 34.9 | 0% | Even |

30 trades (10 starters, 23 weeks): Accept 7, Counter 18, Decline 5 · Value: even 14, leans 4, favors 5, lopsided 7

Reading: every loss beyond 3 bands is a Decline and every gain of at least a band is an Accept (unchanged thresholds). The Value label agrees with the Fit verdict on the clear cases (#6, #7, #9, #21 Lopsided against you and Decline; #8, #13 Lopsided for you and Accept) and reads Even/Leans on the like-for-like swaps (#1–#5, #11, #26, #27). Where they disagree it is informative: #16/#18 (one good player for two lesser ones) are Favors them on value but only a Counter on your lineup, because your roster can't use the depth; #17 is Even on both.
