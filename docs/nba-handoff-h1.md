# NBA stream H1 handoff: league-profile-aware value model

Branch `nba-h1-profile` (off `nba` @ cff2be7). Spec: docs/nba-contracts.md "Phase 3 addendum". Method and backtest: docs/nba-model.md "League profiles".

## What changed
| file | change |
|---|---|
| `nba/league-profile.js` (new) | `getProfile(id='242808')` (unknown id → `null`), `defaultProfile()`, `highScoreDefaultProfile()`. Holds the 242808 scoring, slots, 22 matchup weeks (7 and 17 are 14 days; 20–22 playoffs), adds/trades limits. Returns deep copies. |
| `nba/model/score.js` (new) | `gameScore(line, profile)`, `rowScore`, DD/TD counting, `ddCurve` (league P(DD/TD) prior from historical games), `playerExtras`, `projectedMean`. Every function takes the profile; no hardcoded weights. |
| `nba/model/slots.js` (new) | Yahoo slot-eligibility legend, `slotsForPositions`, `applyVorp` (replacement = best player outside the top teams×(roster−IL) pool, per slot). |
| `nba/model/board.js` | `buildBoard(data, { profile })`: re-scores games, uses matchup weeks with games counted by date, imputes the 2 undated NBA Cup-window games per team, averages pre-draft value over 22 weeks with equal weight, adds `yahooElig`, `eligConfidence`, `vorp`, `vorpBySlot`, `vorpRank`. Without a profile the behaviour is unchanged. |
| `nba/model/fit.js` | `maxK` 7 → 10 (14-day weeks). |
| `nba/model/index.js` | `getPlayers({ week, profile })`. `profile` is an id or object, and the response carries a `profile` summary (scoring, slots, replacement levels). The cache key includes the profile. Also exports `gameScore` and `slotsForPositions`. |
| `nba/model/sleeper.js`, `data.js`, `data/nba/*.json` | Snapshot format 2: per-game stat lines (pts..blk, to, pf, tf), projection per-stat means, `teamDates`. A cache copy is preferred only when its `format` matches. Re-ingested 2026-10-13. |
| `nba/routes/profile.js` (new) + `nba/router.js` | `GET /api/nba/league-profile?league_id=` (400 on a bad id, 404 on an unknown one). `GET /api/nba/players?profile=` defaults to 242808 (400 bad / 404 unknown). The players route keeps ETag, gzip and caching. Router diff: one require, one mount line, and the players-route lines. |
| `scripts/test-nba-profile.js` (new) | 28 checks + top-15 board + 2025 backtest under league scoring. |

## Response additions (for H2)
Per player: `yahooElig` (subset of PG, SG, G, SF, PF, F, C, UTIL), `eligConfidence: 'yahoo' | 'sleeper-mapped'`, `vorp`, `vorpBySlot`, `vorpRank`, and from the Yahoo snapshot `yahooPid`, `yahooPos`, `yahooPreRank`, `yahooPctRos`, `yahooFanPts` (null when unmatched). `hsByWeek` and `gamesByWeek` are keyed by matchup week 1–22.

Top level: `profile.{leagueId, scoring, flags, slots, starters, rosterSize, teams, weeks, longWeeks, replacement, draftedPool, unverified, yahoo}`. `profile.yahoo` = match summary (602/725, 83.0%).

## Yahoo-first update (2026-10-13)
Positions/eligibility now come from `data/nba/yahoo-snapshot-242808.json` (`nba/model/yahoo.js`); Sleeper is only the flagged fallback. Every Yahoo top-200 player is matched; all 123 unmatched rows are absent from Sleeper. Yahoo fanPts are reproduced exactly (±0.1, top 200) by the league scoring with DD/TD/tech zeroed. The snapshot's stat columns turned out to be Yahoo's 2026-27 projections, not 2025-26 totals, so the per-game log-sum check was replaced by a projection cross-check (see docs/nba-model.md).

## Verified
`node scripts/test-nba-profile.js`, `test-nba-model.js`, `test-nba-yahoo.js`, `test-nba-ui.js`, `test-nba-hardening.js` and `npm test` all exit 0. The live Sleeper refresh path was exercised once and works with format 2.

## Gaps / unverified
1. **DD/TD bonus unverified** (surfaced in `profile.unverified`): Yahoo fanPts have no DD/TD/tech component and the list shows those stats blank. Confirm on the first league box scores. Separately, **`flags.tdAlsoCountsDD = true` is not verified on a Yahoo help page.** It's inferred from Yahoo's separate DD/TD stats and Sleeper's dd=1-on-td rows. Check one triple-double in the league after opening night. Impact is small (0.5% of games).
2. **Eligibility** is Yahoo's for 602 players; 52 deep players not in the Yahoo snapshot keep Sleeper-mapped positions. Yahoo players missing from Sleeper (Westbrook, Valančiūnas, Batum, ...) are not on the board at all.
3. **VORP replacement levels are nearly flat** (~26 for every slot), so vorpRank ≈ hsValue rank. That's an honest result for 9 starters with 3 flex slots and a 168-player pool. Positional need should drive H2's pick advice.
4. **NBA Cup TBD games:** the 2 undated games per team are imputed into Dec 3–11, so they land in week 7. Knockout games for the 8 qualifiers are not modelled.
5. **Projections have no pf/tf.** These come from player per-minute history, or the league rate for rookies.
6. **Technical fouls** are present in Sleeper (`tf`) and scored. They're rare (≈0.04 per game), so the impact is tiny.
7. **Pre-existing:** `scripts/test-nba-model.js` (stream B) backtests include Sleeper `TEAM_*` aggregate rows, inflating its r = 0.977. Player-only r is ≈0.73–0.80 (see docs). Not changed here.
