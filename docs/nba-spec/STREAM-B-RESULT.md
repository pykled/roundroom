# Stream B result: NBA Trade Calculator v2

Branch `nba-trade-v2` (worktree `~/projects/pocket-nba-wt/nba-trade-v2`), based on `nba-spec` @ 221f7f8. Code commit **a727621**. Not pushed, not merged, no deploy, no production DB touched.

## What was built (spec §4)
| Spec item | Where | Status |
|---|---|---|
| Verdict stays your lineup Δ/wk (Accept / Counter / Decline) | `nba/model/trade.js` | Kept; bands unchanged (0.75% / 3 bands) |
| League-neutral Value fairness meter, market-aware, market weight 0.30 → 0 by week 11 | `trade.js` `v2Layer`, page meter | Done. Label measured above a waiver add (see Deviation 1) |
| Per-player signals with plain-English why | `players[].signals / slotBefore / slotAfter / fit / why` | Done (interim signals until A lands) |
| Team fit before/after | `fit`, `themFit`, Team Fit card | Done; league-relative tiers when every roster is known, depth-only otherwise |
| Horizon ROS / Next 4 / Playoffs + contend/balanced lean | `options`, lens controls | Done; Playoffs → 400 `horizon_unavailable` before week 10; default lean per §4.1 |
| Deep link from team-page trade targets | `/nba/trade?league_id=&partner=&give=&get=[&horizon=]` | Done; works without connecting (my team = roster holding `give`), URL cleaned after use |
| Route v2: `sleeper_league_id` builds the Sleeper profile; categories → 400 | `nba/routes/trade.js` | Done (23 weeks, 3 UTIL, playoffs 21–23, deadline 2027-02-14) |
| Validate table re-run under the Sleeper profile | `scripts/nba-trade-validate.js`, `docs/nba-trade.md` | Done (table + reading in the doc) |
| Tests §4.6 #1–10 | `scripts/test-nba-trade.js` | 46 pass |
| Playwright 375 / 1280, no h-scroll, 44 px taps, 0 console errors | `scripts/nba-trade-v2-screens.py` → `docs/nba-trade-v2/*.png` | All checks pass (12 screenshots, 7 scenarios × 2 widths incl. Sleeper outage) |

## Verification (run by the Maker; Checker should re-run)
| Command | Result |
|---|---|
| `npm test` (worktree without `.env.local`, as on `nba-spec`) | **exit 0** |
| `npm test` with `.env.local` (Clerk keys present) | exit 1, only `test-nba-hardening.js` "real server … GET logout 405" (gets 410). **Pre-existing:** reproduced on a clean checkout of 221f7f8 with the same `.env.local` (exit 1, same assertion) and passes there without it. Not a B file; one-line fix for the lead: that test should expect 410 when `NBA_YAHOO_ENABLED` is off, or set it to `1` for the spawned server. |
| every `npm test` file run individually (with `.env.local`) | 28/29 pass; the 1 failure is the hardening check above |
| `node scripts/test-nba-trade.js` | 46 passed, 0 failed |
| `node scripts/test-nba-spec-contract.js` | 15 passed, 0 failed, 4 skipped (A's) |
| `node scripts/test-nba-copy.js` | 301 passed (no "Yahoo", no football copy) |
| `node scripts/nba-trade-validate.js --md` | 30 trades, 10 starters, 23 weeks: Accept 7 / Counter 18 / Decline 5; Value Lopsided #6 #7 #9 #21, Even/Leans #1–#5 #11 #26 #27 |
| `python3 scripts/nba-trade-v2-screens.py` | all checks passed |
| Perf (§4.6 #10): 2-for-2, both rosters, signals + league tiers | median 36–45 ms warm (budget 60) |

## Deviations from the spec text (deliberate, documented in `docs/nba-trade.md` v2)
1. **Value label basis.** The spec's raw `gapPct = gap / max(assetIn, assetOut, 1)` fails its own calibration (§4.6 #5): Jokić 73 for Jalen Johnson 57 is ~24% apart in pts/wk ("Leans"), and #7/#21 also miss Lopsided. The label now uses value above a waiver add with the NFL `computeVORP` transform (`max(0, blended − replacement)^1.25`), denominator floored at a top-25 player (20/wk above replacement). `assetIn/assetOut/gap` remain raw pts/wk per spec (shown on the page); `surplusIn/Out/Gap` carry the transformed values. All calibration rows pass.
2. **Consolidation adjustment** follows §4.1 (freed spot = waiver add; extra player = waived cheapest) but counts roster spots by head count, not via the Fit engine's IL-aware `settle` (IL moves gave a 1-for-1 a ±25/wk swing), and splits each side's spot effect in half so swapping perspectives negates the gap exactly (§4.6 #1).
3. **§4.6 #4 "verdict unchanged on the 30-trade set" cannot hold literally**: on any given day 3–4 of the 30 trades sit within ~1/wk of a verdict edge, and ±2% of one 40–50/wk player moves you.perWeek by up to 1/wk. The test enforces the meaningful property instead: every ±2% move is < 1 band, and a verdict may change only when the trade was already within that move of an edge; the boundary trades are printed (today #14, #19, #29).
4. **§4.6 #2 reversal** is exact for equal counts; for n-for-m only the direction is guaranteed, because the player waived to make room differs by side (undoing a 2-for-1 isn't a true inverse).
5. **Fit-axis change (found by §4.6 #3 monotonicity):** v1 streamed a waiver add only into an unfillable slot. Dillon's actual roster (13/14, F slot otherwise filled by LaVine 24/wk vs a 28.7 waiver add) lost up to 4.4/wk by *receiving* an extra player who used the open spot. A slot playable only below waiver level is now streamed the same way (one waiver add per player who has to sit, each costing the worst bench player). Validate table moved ≤ 0.9/wk; thresholds unchanged.
6. **Settle** always considers incoming players as drop candidates (strictly better choice; needed for monotonicity).

## Notes for Stream A / the lead (contract)
- B calls `SIG.signalsFor(tradedAndDroppedPlayers, ctx)` and `RA.analyzeRoster({...})` first and falls back to `nba/model/trade-interim.js` **only on `NOT_IMPLEMENTED`** (`dataAsOf.signals` reports `shared` or `interim`). When A lands nothing in B changes; delete `trade-interim.js` afterwards. Interim gaps: no ESPN return dates (return week read off the board's ramp, labelled "model estimate"), no b2b, no bio/age, `injured[].lostThisWeek` and `injuryExposure` null.
- **Contract clarification needed (A):** B calls `signalsFor` with only the traded players, so the market rank→value curve can't come from `players`. B passes the whole board as `ctx.board`; A's `impliedValue` should use `ctx.board` when present.
- B also passes `currentWeek` and `board` to `analyzeRoster` (extra keys; harmless if ignored). League-relative tiers use the team page rule (§5.1: mean group starter value, top-30% cutoff), computed in B from per-team `analyzeRoster` calls; C should get the same numbers.
- The route builds the Sleeper profile itself (`profileFromSleeper` + cached `/v1/state/nba`) until `LC.profileFor({ sleeperLeagueId })` returns a `source: 'sleeper'` profile, then uses A's automatically. The page loads `/api/nba/players?league_id=` in league mode (serves the default board until A wires it).
- `sleeperContext` teams now carry `record` (for the default lean); the raw league payload is non-enumerable and never serialized.
- One new B-only file outside the §3.5 list: `nba/model/trade-interim.js` (dead once A merges). Also new: `nba/pages/trade.css` (listed), `scripts/nba-trade-v2-screens.py`, `docs/nba-trade-v2/`.
- `scripts/nba-trade-mock.js` now mounts the real NBA router with a fake Sleeper client built from the fixtures (the old Yahoo mock was dead since Yahoo is off).
- The board is date-dependent (recency weights, injury ramps keyed to "today"), so the validate table drifts a little day to day (it moved when UTC rolled to Oct 16 during this run); tests assert rules, not digits.

## Open questions carried from the spec (defaults applied)
Q1 keeper lens: not built, `lean: rebuild` rejected (400). Q2 verdict philosophy: lineup impact stays the headline, value is the second axis. Q3 ESPN dependency: consumed through A's `injury-eta` when it lands; nothing ESPN-specific in B.

MAKER_STATUS: DONE
