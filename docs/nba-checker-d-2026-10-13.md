# Checker report: stream D (weekly lineup picker), 2026-10-13

Fresh adversarial checker. Branch `nba-d-lineup`, reviewed at dc983d9 (base `nba`).

## Verdict: PASS after fixes

Three real defects were found and fixed on the branch, each with a regression test that fails on the old code and passes on the new. Nothing is pushed.

## Evidence (re-run by the checker)
| Check | Result |
|---|---|
| `node scripts/test-nba-lineup.js` at dc983d9 | exit 0, 25 passed |
| `npm test` at dc983d9 | exit 0 (lineup suite not included, per handoff) |
| `node scripts/test-nba-lineup.js` after fixes | exit 0, 28 passed |
| `npm test` after fixes | exit 0 |
| New tests against the old code | old model: brute-force and lock regression tests FAIL. Old route: the process crashes with an unhandled rejection (`Error: boom`), exit 1 |
| Independent brute force (checker's own exhaustive search over real board players, seeds 1/2/3/42/2026/777, 1–11 players, random slots, banked, locks, IL, unknown ids, gamesLeft, day 0–7, with and without forbidForfeit) | 1800 runs, 0 mismatches, 0 throws, 0 NaN. Caps, no duplicate starters, IL never started, locked starters never benched |
| Edge inputs to `recommend()` | empty roster, duplicate ids, NaN/negative/Infinity/1e9 banked, day −3/7/100/NaN, gamesLeft −1/99/NaN/2.5, junk gameDays, 400-player roster (9 ms), week 99, empty opponent: all finite, no throw. week 0 throws `lineup: bad week` (the routes reject it first with 400) |
| `nba/router.js` diff vs `nba` | exactly the one mount line |
| Route fuzz (live mock) | bad JSON → 400 `Invalid JSON`; `null` → 400; `[1,2]` → 400; 300-id body → 413; text/plain → 400; `<script>`, `x;DROP TABLE`, object ids → 400 `Invalid player id`; banked `1e400` → 400; week 31 → 400; `__proto__`/`constructor` ids → 200, treated as unmatched. GET: bad team/league/week → 400; array query params → 400. Error bodies are `{error}` only, with no stack traces or tokens. Auth: GET returns 401 when signed out (suite, through the real router). Rate limit 429 + Retry-After (suite). `trust proxy` is 1 in server.js, so the per-IP limit isn't shared across users |
| UI (Playwright, mock) at 375×812 and 1280×800: Yahoo midweek, API 500 JSON, 502 HTML, 6 s slow API, unmatched locked starter, manual empty, manual search + paste (with an `<img onerror>` line), manual 1280, corrupt localStorage, week=999&day=-4 | 0 page errors (the only console errors are the injected 500/502). No horizontal scroll in any state. After the fix, every visible control has an accessible name. I checked the screenshots myself |

## Fixes
| Commit | Defect | Severity |
|---|---|---|
| c1737f3 | **Empty lineup from locks.** A locked starter not in our data, a locked starter in a Yahoo slot the model's eligibility disagrees with (Yahoo and Sleeper eligibility differ), or more locked starters than a slot holds made the DP infeasible. `recommend()` then returned **0 starters and a diff benching all six** (reproduced over HTTP: `POST /manual` with Jokić locked at G). Pinned starters now keep their Yahoo slot, and infeasible pins are relaxed with a `lock-conflict` warning. The Maker's brute-force test hid this with `if (want === -Infinity) continue`. | High |
| c1737f3 | **Unmatched current starters were benched**, with a forfeit warning if banked, just because they're missing from the model. They now stay in their slot with an `unmatched-starter` warning. Opponent rosters are deduped too (duplicate ids previously doubled the opponent's starters and skewed winProb). | Medium |
| c77da80 | **Silent forfeits mid-week.** With day > 0 and no "best game so far" entered (the normal Yahoo-mode state, since banked isn't fetched), the picker recommended benching starters with no warning, treating the unknown banked score as 0. Those diff rows now carry a `forfeit-unknown` warning. | Medium |
| c77da80 | **Manual route could crash the server.** `POST /api/nba/lineup/manual` had no try/catch around `recommend()`. On Node 26 an unhandled rejection kills the process, and server.js has no `unhandledRejection` handler. It now returns JSON 500 with a generic message. Also: the paste textarea gets an aria-label, and the unmatched starter card shows "Not in our data" instead of "null left". | Medium (robustness) |

## Source check (fetched 2026-10-13)
- SLN37162 ✅ supports: draft 10 and start 6 (G, G, Frontcourt ×3, Util); G = PG/SG; Frontcourt = SF/PF/C; each starter's single highest game; pts 1, reb 1, ast 2, stl 3, blk 3; daily lineup changes; benching removes points and only games after reinsertion count.
- NBA.com in-season article ✅ supports: 4 bench spots, 3 IL, default 4 transactions per week, the 35 → 33 LeBron example.
- weekly_deadline ✅ supports: 11:59pm PT next-day default; daily lock 5 minutes before each player's game; none of the players in a move can have started. **But** SLN6775 and SLN22673 say the lock is at "the start of the player's game". The docs row is now annotated. The code takes `locked` as an input, so it isn't affected.
- **Inferred, not stated anywhere:** a G→UTIL move between active slots keeps the banked score. The docs mark this ⚠️, but the UI states it as fact ("no forfeit: he stays active"). Also inferred: High Score uses the same lock rules as standard leagues, and Yahoo weeks = Sleeper weeks (both flagged in the docs).

## Unfixed issues (ranked)
1. **Banked scores aren't fetched from Yahoo** (known gap). Mid-week advice depends on user entry. It's now warned, but still the biggest source of wrong advice.
2. UI presents the inferred "active-slot move keeps banked" rule as fact. Soften the wording, or verify it in a real league.
3. No `process.on('unhandledRejection')` in server.js (not stream D's file). Any other async route that throws can take down the server.
4. Leagues with weekly lineup settings: daily-forfeit modelling doesn't apply there, and the picker doesn't detect this.
5. GET route: a throw inside `recommend()` is reported as 502 "Yahoo request failed" (safe, but the message is wrong).
6. Opponent matchups adapter and the live OAuth path are unverified against a real High Score league (known gap).
7. `lock-conflict` relaxes every pin, not just the overflowing ones. This only happens with impossible manual input.
8. The lineup suite still isn't in `npm test` (lead's integration task, per contract).
