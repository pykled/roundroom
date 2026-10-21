# Trade-calc follow-ups — 2026-10-19 (NFL week 6, Monday before MNF)

Branch `trade-calc-followups` off `origin/main` 8065c34 (the shipped ROS fix),
worktree `~/projects/fantasy-draft-assistant-wt/trade-calc-followups`. Code
commit **794ca80**; this doc is the commit after it. Not pushed, not merged
(main is Railway-connected). Measured against a local server
(`PORT=7898 node --env-file=.env.local server.js`), live Sleeper and
FantasyCalc, between 11:45 and 12:30 PDT — Sleeper state week 6, the Monday
night game (SF @ WAS, 17:15 PT) not yet kicked off.

## Item 1 — /team still valued players on full-season totals

**Finding.** team.html built VORP on `/api/projections/season` while
trade.html had moved to `/api/projections/ros`, so the same player read
differently on the two pages. Quantified with the new
`node scripts/team-ros-diff.js [leagueId]` (rebuilds team.html's pipeline on
both dicts, runs `AnalysisEngine.analyzeLeague` on each) for Coast to Coast
(10 teams, 1QB, PPR, redraft):

| measure (season → ROS) | weeks 6–18 (before the item-2 fix) | weeks 7–18 (after) |
|---|---|---|
| rostered skill players moving > 10 % | 75 of 149 (36 up / 39 down), median \|Δ\| 10 % | 79 of 149 (33 / 46), median 13 % |
| roster power-rank changes | 8 of 10 | 8 of 10 |
| starter-VORP sum change range | −26 % … +44 % | similar |
| positional tier cells changed | 9 of 40 (5 flip need/neutral/surplus) | — |
| A.J. Brown (healthy, rostered by ClaytonBigsby21) | 986 (season, VORP 0) → 1,921 (ROS) | 1,737 |
| Starters pts/wk, top team | 114.7 → 98.5 (ROS sum ÷ fixed 17) | 130.9 (ROS sum ÷ 12 weeks left) |

Largest moves: Achane (IR) 5,070 → 0, Hampton 3,469 → 536, Hubbard 1,193 →
3,601, Barkley (Out) 4,049 → 1,839, Chase 6,834 → 4,675, Walker 5,497 → 7,233.
Largest team moves: JetsAreBack50 #10 → #4, pykle #6 → #9, One Love −26 %.

**Changed.**

- `team.html`: fetches `/api/projections/ros` alongside the season dict,
  `S.projRos` / `S.rosWeeks`, `valueProjections()` (ROS || season, same rule as
  trade.html) feeds `computeVORP`, `seasonPts()` and `analyzeLeague`;
  `weeksLeft()` (remaining weeks, 17 on fallback) replaces the fixed 17 in
  pts/wk; the "Proj pts/wk" tooltip says it is per remaining week. Injury /
  form / playoff factors stay Trade-only, as before (so /team shows 1,737 for
  Brown where /trade shows 1,694 = 1,737 × 0.975 playoff slate).
- `shared/analysis.js`: `analyzeLeague(..., opts)` / `analyzeTeam(..., opts)`
  accept `{ weeks }` for the `starterPts` divisor (default 17). This also fixes
  the R2 checker's latent item: trade.html already fed the ROS dict and its
  `starterPts` was silently ROS ÷ 17 (90.1 for the mock roster); it now passes
  `{ weeks: S.rosWeeks.length }` and reads 130.9, identical to /team.
- `scripts/analyze-league.js` (node mirror of /team): ROS with season fallback,
  prints which source it used.

**Consumers of the season-projection / VORP path, and what was done:**

| consumer | before | now | why |
|---|---|---|---|
| trade.html recompute / analysis / pills | ROS (season fallback) | unchanged, + `{ weeks }` to analyzeLeague | — |
| team.html VORP, analysis, pts/wk | season | ROS (season fallback) | this item |
| shared/analysis.js starterPts ÷ 17 | fixed 17 | `opts.weeks` | this item |
| scripts/analyze-league.js | season | ROS (season fallback) | mirrors /team |
| lineup.html:795 computeVORP on season | season | **not changed** | rule: lineup path untouched; VORP there is only a 1e-7 tiebreak on the weekly score (`value = score + vorp / 1e7`), so the display is unaffected |
| index.html (Draft) / research.html `projPts / 17`, scripts/vorp.js → data/vorp.json | season | **not changed** | draft needs full-season value by design |
| shared/waiver-targets.js, trending.html, NBA | own paths | **not changed** | do not call computeVORP / the season dict |

Fallback verified in the browser (§Browser): with `S.projRos = null` /team
reverts to season values (Brown 986, pts/wk ÷ 17) with no errors.

## Item 2 — current week charged to bye / Out players from Thursday to Tuesday

**Finding.** `fromWeek = state.week` all week, and Sleeper's week stays 6 until
after MNF. Week 6 rows for players who already played still carry their
projection after the game (Brown 13.97, Allen 25.28, Mahomes 18.59 on Monday),
while bye teams (CIN, MIA, MIN, DET) have no row, so from Thursday 17:15 PT to
Tuesday the 13-week sum gave the field one more game than bye / ruled-out
players (Chase WR1 → WR5 vs market 3 was partly this). On Monday 11:45 PT the
live endpoint still returned `fromWeek 6, weeks 6–18`.

**Rule chosen.** Once the current week's first game has kicked off, the week
is spent for trade purposes and the sum starts at `week + 1`:

- Tue / Wed / Thu before kickoff → `week` (13 weeks in week 6).
- Thu 17:15 PT kickoff onward, through Sunday and Monday night → `week + 1`
  (12 weeks). Trades proposed during the slate effectively start next week; a
  player whose game is still to come has already banked nothing the receiver
  can get in most leagues (review periods run 1–2 days), and the bye/Out charge
  disappears for everyone at once instead of per player.
- Tuesday after Sleeper rolls to 7 (week 7 not kicked off) → 7: same fromWeek,
  so there is no double skip and the cache key does not change.
- Week 18 after kickoff → 19 → 503 (trade.html falls back to the season dict);
  week 18 before kickoff → `[18]`. Postseason / preseason → 503 as before.
- Scores feed down → keep `week` (the pre-kickoff answer), never a 503.
- "Started" = Sleeper's `started` flag on any game OR `now ≥ earliest kickoff`
  (the feed sometimes keeps `pre_game` for a few minutes after kickoff).

Rejected alternative: dropping the current-week row only for players whose
own game has started. More precise for a Sunday-morning snapshot but it makes
values flip player by player through the afternoon and still leaves bye
players charged against the late-game players until Monday night.

**Implementation.** `ScoringEngine.rosFromWeek(week, games, now)` in
`shared/scoring.js` (pure; `now` injectable) → `{ fromWeek, slateStarted }`.
`/api/projections/ros` reads the week's games from `fetchWeekGameState`
(Sleeper scores feed, cached 5 min, same source as `/api/schedule`), caches the
sum under `proj:2026:ros:${fromWeek}` (1 h) exactly as before, and returns
`{ season, week, fromWeek, slateStarted, weeks, players }` — `week` and
`slateStarted` are added outside the cached value because the same `fromWeek`
is served both after Thursday's kickoff (week 6, started) and after Tuesday's
roll (week 7, not started). Browser `Cache-Control` dropped 3600 → 300 s so the
flip at kickoff is not hidden by a page-level cache. Live after the change:
`week 6, fromWeek 7, slateStarted true, weeks 7–18, 3,306 players`.

**Cache key / TTL.** Keyed by `fromWeek`, so the Thursday flip is a new key and
no sum for the old range can be served. The one-hour sum TTL cannot serve a
stale week because the range is in the key; the only lag is the scores feed's
5-minute cache. The `fromWeek 7` entry created Thursday night is reused all
week and on Tuesday. The 503 for an incomplete range is unchanged (a started
week 6 with week 7 failing → 503; only week 6 failing → 200, since 6 is no
longer in the range — both tested).

**Tests.** `scripts/test-trade-fit.js` "rosFromWeek": week 6 of 2026 with
injected clocks — Tue 10:00 PT → 6, Wed → 6, Thu 16:00 PT → 6, Thu 17:15 PT
(kickoff) → 7, Thu 19:00 → 7, Sun 10:00 → 7, Mon 11:45 (MNF pending) → 7, Mon
night during MNF → 7, Tue after roll (week 7 feed) → 7, started flag wins,
empty / null feed → 6, unparseable kickoff ignored, week 18 after kickoff → 19,
string week, bye-charge arithmetic (13-week vs 12-week sum). `scripts/
test-ros-guard.js` (stubbed Sleeper, one child server per scenario): the
original 503 / partial-sum cases plus kickoff +48 h → 6 (13 weeks, p1 = 130),
+6 min → 6, −1 h with feed still `pre_game` → 7 (12 weeks, p1 = 120, `week`
6, `slateStarted` true), −72 h (Sun/Mon) → 7, `in_game` flag → 7, week 7 after
roll → 7, feed 500 → 6, week 18 started → 503, week 18 pre-kick → `[18]`,
started + week 7 fails → 503, started + week 6 fails → 200. The live check in
test-trade-fit now asserts `fromWeek === slateStarted ? week + 1 : week` and
`weeks` ending at 18.

## Item 3 — test hygiene

- `scripts/test-ros-guard.js` is in the `npm test` chain (after
  test-trade-fit). 19 checks, ~25 s.
- **NBA cache pollution.** `data/nba/cache/` is gitignored
  (`data/nba/.gitignore`), so it never shows in `git status` but survives until
  `git clean -fdx`; `nba/model/data.js readBest()` prefers a cache file newer
  than the committed snapshot, which is why a polluted worktree fails
  `test-nba-model` (matchYahooPlayer) and `test-nba-profile` (players meta) —
  reproduced here by copying the trade-calc-health worktree's cache in: both
  suites fail, both pass again after removing it. Running each suite alone
  with the dir cleared between runs identified the writer: **not**
  test-ros-guard (its child exits after 1.5 s, before the refresh completes)
  but `scripts/test-nba-cheatsheet.js`, which calls `model.getPlayers()`
  without `NBA_MODEL_OFFLINE=1` and so kicks off the background refresh that
  writes `players.json` / `proj-2026.json`. Fixed by setting the flag at the
  top like the seven other NBA suites do. Defence in depth: test-ros-guard
  children run `NBA_MODEL_OFFLINE=1` with every non-loopback fetch stubbed
  (503), and the parent snapshots the cache dir and removes anything new in
  `finally` (reporting a failure if it had to); the spawned real servers in
  test-nba-hardening and test-nba-yahoo also run offline. Verified: full
  `npm test` from a clean dir leaves no `data/nba/cache`.
- **nba-hardening with `.env.local`.** The "real server" sub-test skips without
  Clerk keys and, with them, spawned `server.js` without `NBA_YAHOO_ENABLED=1`,
  so `GET /nba/auth/logout` answered 410 (Yahoo disabled) instead of the 405
  the test expects. Test-isolation only (the in-process router in the same
  file is built with `yahooEnabled: true`); the spawned env now sets
  `NBA_YAHOO_ENABLED=1` (plus the offline flag). `npm test` exits 0 with
  `.env.local` present (three full runs) — there is no documented env-only
  failure left.

## Item 4 — re-check with fresh live data (after the fix, ROS weeks 7–18)

`node scripts/trade-calc-health.js [--sf=1] --json=…` (now dumps
`out.players` with model vs market position rank per market player).

Spearman(final, market), 197 market players: 1QB ALL 0.99 (QB 0.98, RB 0.99,
WR 0.99, TE 0.97); SF ALL 0.98 (QB 0.95, RB 0.99, WR 0.99, TE 0.97). Outlier
list (≥ 8 ranks under market or zero): Nabers and Pickens only, both formats.

**A.J. Brown, 1QB PPR 12 teams (SF in brackets):** season 165.0 pts (WR48) →
ROS 168.2 over weeks 7–18 (WR20) → VORP 55.7 over WR42 (WR20) → rescaled 2,097
(WR20) → FantasyCalc 3,533 / normalised 3,287 (WR18) [3,221 / 2,912] → blend
70/30 2,454 (WR18) [2,342] → × injury 1 (now listed healthy) → × form 1 (no
line in weeks 3–5) → × playoff 0.975 (avg opponent #24.2) → **2,393, WR18 =
market WR18** [2,283, WR18]. In the mock league on /trade: 1,694; on /team:
1,737 (no playoff factor there).

**Top 25 |model rank − market rank|, 1QB** (Δ = model − market; SF list is the
same names with Malik Willis QB (32 → 22), Aaron Rodgers QB (18 → 23) and Tony
Pollard RB (31 → 27) replacing Strange, Rice and Daniels):

| player | mkt → model | Δ | class |
|---|---|---|---|
| Jakobi Meyers WR | 57 → 43 | −14 | A |
| Wan'Dale Robinson WR | 44 → 35 | −9 | A |
| George Pickens WR | 16 → 25 | +9 | B (ROS 140.8 = 11.7/g; form ×0.95) |
| Malik Nabers WR | 10 → 19 | +9 | B (ROS 150.8 = 12.6/g; form ×0.95) |
| Mike Evans WR (Q, 33) | 21 → 13 | −8 | B (ROS 195.4 = 16.3/g) |
| Malik Washington WR | 48 → 41 | −7 | A |
| Ollie Gordon RB (Q) | 27 → 20 | −7 | B (season proj 23 was stale; ROS 158) |
| T.J. Hockenson TE (Out) | 22 → 16 | −6 | A + C |
| Kyler Murray QB | 22 → 16 | −6 | A (1QB floor) |
| DeVonta Smith WR | 20 → 26 | +6 | B (1 of 3 games; ROS 140.7) |
| Jalen Coker WR | 27 → 21 | −6 | B (ROS 168 > market) |
| Emeka Egbuka WR | 26 → 32 | +6 | B |
| David Montgomery RB (Out) | 28 → 23 | −5 | C (ROS zeros + ×0.95) |
| Tee Higgins WR | 19 → 14 | −5 | B |
| Trevor Lawrence QB | 9 → 4 | −5 | B (ROS 234 = 19.5/g) |
| Bryce Young QB | 14 → 9 | −5 | B |
| Zay Flowers WR | 12 → 7 | −5 | B |
| Jared Goff QB | 12 → 8 | −4 | B (form ×0.95) |
| Aaron Jones RB (Q, 31) | 24 → 28 | +4 | A (VORP 0.4) |
| Terry McLaurin WR (31) | 30 → 34 | +4 | B + form ×0.95 |
| Jaylen Waddle WR (Q) | 32 → 28 | −4 | B + form ×1.05 |
| Travis Etienne RB (IR) | 26 → 30 | +4 | C (ROS 112.5, first pts week 9, ×0.90) |
| Brenton Strange TE | 14 → 10 | −4 | A |
| Rashee Rice WR (Out) | 24 → 20 | −4 | C (ROS 176, ×0.95) |
| Jayden Daniels QB | 8 → 12 | +4 | B (1 of 3 games; ROS 184.6, VORP 0 in 1QB) |

Classes: **A — VORP floor (deliberate tuning).** Below the position's
replacement line the value is 0.30 × market by construction, so rank among the
tail (values 120–600) is set by a few VORP points plus market noise; Meyers'
−14 is 223 vs 263 on the 0–10,000 scale. Same as finding #3 in the 10-17
health doc. **B — Sleeper weekly projection vs market (deliberate: the VORP
half is the projection).** Nabers / Pickens / Smith / Egbuka / McLaurin /
Daniels are projected below their market rank per remaining game; Evans /
Coker / Gordon / Lawrence / Young / Flowers / Higgins / Willis above. The form
nudge (±5 %) adds one or two ranks on Nabers, Pickens, Goff, McLaurin, Waddle.
**C — injury return timing (deliberate).** Weekly zeros carry the missed games
and the residual ROS table (Out 0.95, IR 0.90) sits on top; all within 4–6
ranks of market, direction matches the 10-17 audit. Nothing in either list is
a summation, id, format or factor bug; no fix made. Two observations, not
bugs: SF QB rho fell 0.97 → 0.95 on the day because Sleeper now projects
Malik Willis as a starter (QB22 vs market 32) and Rodgers (42) sits below the
SF replacement line; and the ROS per-week level runs ~12–14 % above the season
total ÷ 17 (Sleeper's season totals are conservative and already bake in
missed games), which is why "Starters pts/wk" on /team rises with this branch.

## Browser (headless Chromium 147 over CDP :9333, branch server :7898 with `--env-file=.env.local`)

- `/team`, connected mode mocked (owner 1044077615075872768, league
  1399457768158547968 Coast to Coast): `S.rosWeeks` 7–18, `weeksLeft()` 12,
  table renders 10 rows (Levia96 #1 23,842 · 130.9 pts/wk … One Love #10),
  Your Team tile "116.1 pts/wk", A.J. Brown 1,737 (5.7 pts remaining-week avg
  shown via seasonPts), no "NaN"/"Infinity" in the DOM, zero exceptions /
  console errors (Clerk dev-key warning filtered). Fallback (`S.projRos =
  null; recompute()`): weeksLeft 17, Brown 986, pts/wk 114.7 / 110.9 / 110.3,
  no errors.
- `/trade`, connected mock, Brown → Higgins: 1,694 vs 2,051 WIN 17.4 %, Roster
  Fit renders ("Need-adjusted: 1,948 → 2,359 WIN"), chip, `injuryOpts()`
  `{ dynasty: false, ros: true }`, `S.leagueAnalysis.teams[i].starterPts`
  130.9 / 121.7 / 121.4 … (= /team), Chase 4,850, no NaN, zero errors.
- Both inline `<script>` blocks of team.html and the two JS blocks of
  trade.html parse (`new Function`); trade.html's first block is JSON-LD.

## Tests / verification

- `node --check` OK: server.js, shared/scoring.js, shared/analysis.js, every
  touched script.
- `npm test` exit 0, three full runs (681 "ok" lines; with `.env.local`
  present), no `data/nba/cache` left behind.
- Not changed, and why: lineup.html (rule; tiebreak only), Draft / Research
  (full-season by design), NBA code (rule — only `scripts/test-nba-*.js` env
  flags touched), the VORP floor, dynasty IR gap, R1's "sum to the league's
  last fantasy week" (still 18; product call), per-player current-week
  exclusion (rejected above).

## Repro

```
cd ~/projects/fantasy-draft-assistant-wt/trade-calc-followups
PORT=7898 node --env-file=.env.local server.js
node scripts/team-ros-diff.js [leagueId] [--player="Name"]      # item 1 numbers
curl -s localhost:7898/api/projections/ros | head -c 200        # week / fromWeek / slateStarted
node scripts/test-trade-fit.js | sed -n '/rosFromWeek/,/ageMult/p'
node scripts/test-ros-guard.js
node scripts/trade-calc-health.js --json=/tmp/1qb.json          # item 4; --sf=1 for superflex
npm test
```
