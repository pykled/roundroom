# Pocket NBA: waivers and streaming (stream F)

## Yahoo add/drop rules (verified 2026-10-13)
| Rule | Source |
|---|---|
| High Score: a 10-player roster with 6 starters (G, G, Frontcourt ×3, Util). Scoring is pts 1, reb 1, ast 2, stl 3, blk 3. Each starter's single best game of the week counts. You can change the lineup daily. **Benching a player removes his earlier points, and they don't come back.** Default league size is 10; private leagues go up to 20. | https://help.yahoo.com/kb/SLN37162.html |
| SLN37162 says **nothing about waivers or add limits**. High Score therefore uses the standard basketball waiver settings below; this is an inference, not confirmed on a High Score league. | (absence on SLN37162) |
| Waiver rules: **Weekly** waivers place all unclaimed players on waivers at the start of each week and clear after 11:59pm PT Tuesday. The default is "Game Time – Tuesday". **Continuous** waivers keep everyone on waivers all the time; a claim starts a timer, default 2 days, commish-settable from none to 7. **None** means first come, first served, and a player must be added by 11:59pm PT Sunday to count for the current game week. Under continuous waivers, a player can never be added on the same day a claim is made. | https://help.yahoo.com/kb/fantasy-basketball/changing-waiver-settings-sln8828.html |
| Claim priority: Continual Rolling List (a successful claim moves you to the bottom; never reset), Reverse Order of Standings (reset weekly, not affected by claims), Weekly Rolling List, or **FAB**. FAB: the default budget is $100 (range $1–$999). Bids are blind, from $0 up to your remaining budget. The highest bid wins, ties go to the selected priority, and the budget never replenishes. | SLN8828 above; https://help.yahoo.com/kb/SLN6811.html |
| Standard waivers: a dropped player is frozen for the waiver period (default 2 days, 0–7). Unclaimed players then become free agents and can be added at once. A player dropped by the manager who added him the same day stays a free agent. The waiver window starts the day after the drop. | https://help.yahoo.com/kb/SLN6811.html |
| Acquisition limits are commissioner settings: maximum adds for the season, and **maximum adds per week (H2H only)**. They apply to free-agent and waiver adds. | https://help.yahoo.com/kb/SLN6981.html |
| Yahoo's own glossary: "Continual rolling list" and "FAB w/ Continual rolling list tiebreak". | https://basketball.fantasysports.yahoo.com/nba/details/waiver_type |

What the product does with these rules:
- The API returns the league's `waiver_type`, `waiver_rule`, `waiver_time`, `uses_faab`, `max_weekly_adds` and `max_adds` when Yahoo settings include them.
- Players on waivers (`status=W`) are tagged **W** on the page.
- FAB leagues get a banner.
- We don't suggest bid amounts, and we don't enforce add limits. Both are listed as gaps.

## Method (`nba/model/waivers.js`)
- **Player-week value** is B's `hsByWeek[w]`: E[best game] given that week's team games, availability and opponents.
- **Roster-week value** is the best legal G,G,F,F,F,UTIL lineup, found by an exact DP over slot counts and checked against brute force in tests. Stream D's `lineup.js` didn't exist yet, so this is a small internal assignment. On top of the lineup, the top two bench players earn a **depth credit** of 0.12× and 0.06× their value. Lineups are set daily, so the bench covers a starter who sits. Without this credit, every bench move would score exactly 0.
- **Horizon:** 1, 2 or 4 weeks starting at the current week. Week *k* is weighted 0.85^k.
- **Targets:**
  - `addGain` is the gain if you have an open spot.
  - `netGain` is the best swap: Σ_w [value(roster − drop + FA) − value(roster)].
  - Schedule comes in through `hsByWeek`, so a 4-game week beats a 2-game week for equal talent (tested).
  - Ceiling, mean and floor are shown. Ceiling is also a sort option and a tiebreak. Variance is already priced in, because E[max] rewards spread.
- **Keeper protection:** a drop is only suggested when the FA's rest-of-season weekly value is within 4 points of the dropped player's, or the dropped player is out for the season. Without this, an injured star would get streamed away for +0.1.
- **Drop candidate:** the roster player whose removal costs the least, skipping keepers. The list shows each player's cost, and keepers are badged.
- **Pairs (coming week):** the greedy best positive add/drop swaps for week 1 of the horizon. Each add and each drop is used at most once; top 5.
- **Mid-week** (checker fix 2026-10-13): when today is strictly inside the horizon's first model week, a free agent's value for that week only counts his team's games left. Games played come from this season's logs when they run through yesterday, otherwise from each team's week games × share of days gone. Today's games still count as addable. B's E[max] is rescaled to the remaining games, and a drop whose team already played this week is flagged (`bankedGames`, shown as "played N"). Roster players keep their whole week.
- **IL slots:** a Yahoo roster player whose `selected_position` starts with IL doesn't use a roster spot and is never the drop half of a swap, since dropping him frees no active spot.
- **Injury replacements:** a rostered player with Out/IR/SUS/Doubtful or out-for-season status whose missed value over the horizon is at least 1 point. "Healthy" value = normal E[max] at his usual availability. Replacements are the top positive swaps among FAs in his G/F group.
- **Role change:** compares minutes per game over the last 5 played games with the rest of that season. ROLE ↑ means at least +4 minutes and at least ×1.12. A signal whose last game is more than 21 days old is marked `stale` and gets no badge. That covers preseason now: all games are from last season.
- **Streamer calendar:** the next 3 weeks, listing free agents with 4+ games, ranked by that week's value.
- **Determinism:** no RNG, and every sort has an id tiebreak. Input order doesn't matter (tested with shuffles).

## API (`nba/routes/waivers.js`; one mount line in `nba/router.js`)
- `GET /api/nba/waivers?league_key=&team_key=&weeks=1|2|4[&week=]`
  - Requires Clerk auth, and the team must belong to the league.
  - Reads Yahoo `getRoster` plus `getPlayers` with `status=FA` (up to 4 pages = 100 players) and `status=W` (1 page), plus `getLeague`. The Yahoo result is cached per user for 60s.
  - Players are matched with B's `matchYahooPlayer`. Anything unmatched comes back in `unmatched.roster` / `unmatched.freeAgents` and is left out of the ranking.
  - Errors: 409 when Yahoo isn't connected, 503 when the model is missing.
- `POST /api/nba/waivers/manual {roster, pool?, exclude?, weeks?, week?, rosterSize?}`
  - Public. Rate limit is 30 requests/min per IP, and the body is capped at 16 KB (413 JSON). At most 20 roster ids and 400 pool ids; ids must match `[A-Za-z0-9_-]{1,16}`.
  - With no `pool`, the pool is every model player not on the roster, minus `exclude`. Unknown ids are reported in `unknown`.
- `GET /nba/waivers` serves the page.

## Page (`nba/pages/waivers.*`)
- Yahoo-first:
  - Calls status, then league (`myTeamKey`), then waivers.
  - A league picker includes "Manual roster".
  - Manual mode stores the roster in localStorage. It can import "mine" picks from the draft board's manual state, and other teams' picks become hidden.
- Layout: best move card with alternatives, a 4-game calendar strip (horizontally scrollable on phones), and G/F, Role ↑ and sort filters.
- Each row shows games-per-week chips (green 4+, red ≤2), the gain, and which player to drop. Tapping a row expands a per-week table and the reasons.
- Side cards: injury replacements, drop candidates, my best lineup, and unmatched players.
