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
