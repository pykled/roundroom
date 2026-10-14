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
