# Pocket NBA: weekly lineup picker (stream D)

Code: `nba/model/lineup.js` (optimiser), `nba/routes/lineup.js` (API), `nba/pages/lineup.*` (UI). Tests: `node scripts/test-nba-lineup.js`.

## Yahoo High Score rules this is built on
Checked 2026-10-13. ✅ = stated by the source. ⚠️ = not verified, so it's an assumption.

| Rule | Status | Source |
|---|---|---|
| 10-man roster. 6 starters: G, G, F (Frontcourt), F, F, UTIL. G = PG/SG eligibility; F = SF/PF/C eligibility; UTIL = anyone. | ✅ | [Yahoo SLN37162](https://help.yahoo.com/kb/SLN37162.html) |
| Each starter's **single highest-scoring game of the week** counts. Score per game = pts + reb + 2·ast + 3·stl + 3·blk. | ✅ | SLN37162 |
| You can set your lineup **every day**. Benching a player removes his points from your score and you can't get them back. If you reinsert him, only games from that point on count toward his high score. | ✅ | SLN37162 ("Lineup Changes"); [NBA.com in-season strategy](https://www.nba.com/news/in-season-strategy-yahoo-high-score) gives a worked example (35 Thursday, benched, re-inserted, 33 Sunday → only 33 counts) |
| Daily leagues lock lineup moves 5 minutes before **each player's own game**. A player whose game has started can't be moved, and nobody he'd swap with can be either. | ✅ for standard Yahoo NBA daily leagues; ⚠️ assumed identical for High Score | [Yahoo roster-changes details](https://basketball.fantasysports.yahoo.com/nba/details/weekly_deadline), [SLN22673](https://help.yahoo.com/kb/SLN22673.html) |
| Adds/drops take effect the next day by default (11:59pm PT deadline). Leagues can choose "Daily – Today" instead. | ✅ (standard leagues) | weekly_deadline page, [SLN6775](https://help.yahoo.com/kb/SLN6775.html) |
| Default transaction limit is 4 per week. | ✅ (strategy articles; commissioner can change it) | NBA.com article above; Yahoo Sports High Score in-season article (search snippet, 2026-10-01) |
| IL slots: **conflicting**. NBA.com (2025) says 3 IL; Yahoo Sports (2025 and 2026) says 2 IL/IL+. | ⚠️ | as above. The picker never starts IL players and doesn't depend on how many IL slots there are |
| Moving an active starter between active slots (e.g. G→UTIL) keeps his banked score, because it isn't a benching. | ⚠️ inferred; Yahoo only talks about *benching* | — |
| Weeks run Mon–Sun (week 1 Tue–Sun; All-Star week is short). | ✅ via Sleeper schedule; ⚠️ the Yahoo per-league dates aren't verified against a real league | docs/nba-model.md |

## How the picker is built around these rules
- **One decision per slot from today to Sunday.** The picker answers "who should be in the six slots *from now on*?" Re-run it each day: earlier days are locked in and passed as `day` plus each starter's `banked` best.
- **Banked floor.** A current starter with banked score B is worth `E[max(B, best remaining game)]`. With no games left that's exactly B. A strong banked score (say 80 against a 40-per-game player) adds almost nothing, and the card reports `pBeat`, the probability that any remaining game beats B.
- **Forfeiture.** A bench player who comes in is worth only `E[max(remaining games)]`; his past games don't count. A current starter who gets benched loses B. So the optimiser prices the forfeit in automatically. Every recommended move that benches a starter with B > 0 gets a `forfeit` warning (in `warnings[]` and on the diff row). `options.forbidForfeit` pins those starters instead.
- **Locks.** A `locked` player (his game today has started) can't move: a locked starter stays in his exact slot, and a locked bench player stays on the bench. A locked starter keeps his Yahoo slot even if our eligibility data disagrees (Yahoo already allowed him there). If locks alone overfill a slot (bad manual input), locks are ignored with a `lock-conflict` warning instead of returning an empty lineup.
- **Unmatched starters** (not in our player data) are left in their current slot unprojected, with an `unmatched-starter` warning, rather than benched: benching could forfeit a banked game we can't see.
- **IL** players are never started.

## Method (`nba/model/lineup.js`)
1. **Per-game distribution.** Normal(μ, σ). σ is the model's `sd`. μ is *calibrated* so that, with the full week ahead and no banked score, the value equals B's `hsByWeek[week]` exactly. It is solved in closed form from `hs = Σ_k Binom(k; N, a) · (μ + σ·e_k)`. That keeps the picker consistent with the draft board. μ is clamped to [0.7, 1.4] × mean in case our availability guess differs from the board's (we can't see injury notes).
2. **Availability** `a` comes from B's `availability()` (injury status, OUT/IR ramps, healthy floor).
3. **Games left.** In order of preference: explicit `gameDays` (exact back-to-back detection), then `gamesLeft`, then `gamesPlayed`, then pro-rata over the days left.
4. **Back-to-back rest risk** (heuristic, not backtested). The second leg of a back-to-back is played with probability `a × (1 − r)`, where r = 4%, +6% for players averaging ≥ 50/game (load management), +5% if a0 < 0.75 (fragile). Without dates, the minimum number of back-to-backs the calendar forces (`games − ceil(daysLeft/2)`) is used.
5. **Value.** The number of games played K follows a Poisson-binomial distribution, and value = `Σ_k P(K=k) · E[max(B, X_1..X_k)]`. This is integrated exactly on a 400-step grid, so it's deterministic.
6. **Assignment.** An exact DP over players with state (G used ≤ 2, F used ≤ 3, UTIL used ≤ 1), 24 states. Each player goes to bench, G, F or UTIL if eligible. Multi-position players are handled naturally. Ties prefer leaving current starters where they are. The test checks it against exhaustive search on 400 random rosters, with and without `forbidForfeit`.
7. **Uncertainty and head-to-head.** A seeded mulberry32 Monte Carlo with N = 2000 (Box–Muller normals floored at 0; each game played with its own probability). It reports p10/p50/p90 for the week total. When an opponent roster is given, their optimal six are simulated from the same seeded stream: `winProb = P(mine > theirs) + ½·P(tie)`. Same inputs give the same output.
8. **Streamability.** A free-agent proxy (the median per-game mean/sd of board ranks 121–160) is assumed to play about 3.5 games per 7 days left. If it beats the slot by more than 0.5, the card says "Streamable (+x, uses an add)". If the starter's banked score is unlikely to be beaten, it says "Done for the week: keep him".

## API
- `GET /api/nba/lineup?league_key=&team_key=&week=[&day=][&banked=id:score,…][&locked=id,…][&opp=0]`. Signed-in (Clerk) only. `team_key` must belong to `league_key`. The roster comes from `getRoster(team_key, week)`, with players mapped through `matchYahooPlayer`. The opponent is found with a thin local adapter (`team/{key}/matchups;weeks=N` via `client.request`, which picks out the other team_key in the same league) and their roster is loaded. Unmatched players come back in `unmatched[]` and are left out. If the opponent can't be loaded the response still succeeds, with `matchupError` set. Yahoo errors reuse the router's `sendYahooError` (409 not connected / reauth, 429, 502).
- `POST /api/nba/lineup/manual` with body `{ week, day?, roster: [{id, slot?, banked?, locked?, gamesLeft?}] | ids: [...], opponent?: [ids] }`. No auth. Limits: 30 requests/min per IP (429 + Retry-After), 8 KB body (413), at most 20 players per side, ids `[A-Za-z0-9_-]{1,24}`.
- Both endpoints default `day` from the week's dates (today in US/Eastern) and return `dates`, `weekLength`, `slots[]` (slot, player, expected, banked, gamesLeft, pBeat, rationale, alternatives, streamNote), `bench[]`, `total{expected,p10,p50,p90}`, `current`, `gain`, `diff[]` (out/in/gain/forfeits/warning), `moved[]`, `warnings[]`, `matchup?`, `unmatched[]`, `mc{n,seed}`.

## Known gaps
- **Banked scores aren't pulled from Yahoo.** That would need per-date player stats. The user types "best game so far" on each starter card; it's stored per league and week in localStorage and sent as `banked=`.
- **The plan is static, not a daily re-optimisation.** It doesn't model "start A Monday, swap to B Wednesday if A flops", the tactic NBA.com describes. Re-running each day approximates it.
- **No team game dates in the model**, so back-to-backs are estimated from counts unless a caller passes `gameDays`. The rest-risk rates are guesses.
- **The Yahoo matchups response shape is unverified**: the adapter scans for team_keys rather than parsing the nesting. Yahoo week = Sleeper week is assumed.
- The normal per-game shape is slightly thinner-tailed than B's kernel fit. It's calibrated on the mean of the max, not the tail.
