# NBA integration + adversarial Checker — 2026-10-14 (draft-critical)

Integrator/Checker: fresh agent, did not write the stream code. Branch `nba` in `~/projects/pocket-nba-wt/integration`. Nothing pushed or deployed.
Draft: Yahoo league 242808 "HALIMSANITY 26-27", **Wed 2026-10-14 8:00pm PT**, 12 teams, snake, 90s/pick.

## Verdict: **PASS after fixes** (draft-ready)

The board works end-to-end against the real server and real data, at 375×812 and 1280×800:
- full 12-team drafts at 14 rounds (168 picks) and 16 rounds (192 picks);
- recommendations, pick clock, undo, reload persistence, Yahoo-only players and the offline cheat sheet all checked.

Fixes were needed in recommendation logic, draft length, the cheat sheet's eligibility and phone layout. All are committed with regression tests. Remaining risks are listed below, ranked.

## Merges (in order, each followed by its own tests + `npm test`)
| stream | merge | stream tests | `npm test` |
|---|---|---|---|
| nba-h1-profile | b8e9c85 (clean) | `test-nba-profile.js` exit=0 (31 passed) | exit=0 |
| nba-h2-board | baaa412 (clean) | `test-nba-ui.js` exit=0 (73) | exit=1 first: the NFL `test-week-history` live Sleeper fetch got `fetch failed` (network flake). Rerun exit=0 |
| nba-m1-market (+s3-adp) | 73ea74f (clean) | `test-nba-market.js` exit=0 (67), `test-nba-adp.js` exit=0 (9) | exit=0 |
| nba-s2-cheat | f4f858a (clean) | `test-nba-cheatsheet.js` exit=0 (60) | exit=0 |
| nba-s1-sim (incl. fccb275 docs) | cb477dd (clean) | `test-nba-sim.js` exit=0 (14) | exit=0 |

`npm test` now runs the NFL suites (unchanged) plus test-nba-yahoo, model, ui, hardening, profile, market, adp, cheatsheet, integration (new) and sim.
- **Final run: exit=0.** Counts: ui 77, profile 31, hardening 31 (incl. the spawned real-server test, which ran with `.env.local`), market 67, adp 9, cheatsheet 63, integration 7, sim 14, yahoo 62, model 18.
- `.env.local` was missing from the integration worktree. It was copied from `g-harden` (gitignored, never printed).

## What was wired / fixed (commits, trailer Co-Authored-By: Claude Sonnet 5.5)
| sha | change | regression test |
|---|---|---|
| 131c421, 9fb940d | `npm test` runs every NBA suite | — |
| bd244f4 | **`nba/model/enrich.js`**, a field-level adapter over H1's `getPlayers({profile})`; H1 code is untouched. It adds `marketRank/adpDelta/label/strong/contested/marketConfidence` (joined by yahooPid, then id) and **117 Yahoo-only rows** (`source:'yahoo-only'`, `noLogData`, Yahoo pos/elig, `yahooPreRank`). It never mutates the cached model response. Router: enrich runs inside the `apiCached` closure for profile responses, plus `router.use('/api/nba/market', rateLimit, routes/market)` | `test-nba-integration.js` (7) |
| e661950 | `scripts/nba-market-build.js` now values against `getPlayers({profile:'242808'})` (it used the legacy High Score model). Rebuilt `data/nba/market.json`: ESPN 133/133, Sleeper 281/281, Yahoo 602/725, model-vs-market Spearman 0.90. FantasyPros stays OFF. `data/nba/adp-cache/` is gitignored | market tests |
| 587e0b6, 8b9a80d | **Recommendation fixes** (details below): market-aware "likely gone before my next pick", position-aware bench, score = 0.5·gain + VONA, **draft rounds as a profile field** (`draft.rounds: 14`) | ui tests: market-aware VONA, bench depth, rounds |
| 6146b95 | Board: compact **Mkt #** column (`M44` with a ▲value/▼reach delta, underlined when strong, dimmed when low confidence; empty when absent), **NO LOGS** badge and a sheet note for Yahoo-only rows, market line in the player sheet, **Rounds** field in the League dialog. With Yahoo connected, Yahoo's pick list sets the draft length (it was `max(yahoo, settings)`) | ui tests |
| 3a908a7 | **Cheat sheet bugs.** (a) It used Sleeper-mapped eligibility even with the profile model (the model's `elig` is the legacy HS field) → now Yahoo `yahooElig/yahooPos`. (b) Hard-coded 16 rounds → profile rounds. (c) Yahoo-only players now included. The footer states the eligibility source | cheatsheet tests +3 |
| b34e1b3 | Reason text for reshuffles. Banchero (PF-only) was shown as "Fills C" because Barnes slides PF→C; it now reads "Starts at PF; Scottie Barnes slides to your open C". Phone toast moved above the thumb bar; it covered the sticky clock's "on the clock" line | ui test (reshuffle) |
| `scripts/nba-int-draft.py` | Real-server Playwright draft driver, reusable | — |

## Evidence
### Real server (PORT=7994, real `.env.local`, no DATABASE_URL)
- `/api/nba/players?profile=242808`: 200, **771 players** (654 model + 117 Yahoo-only), market on 602.
  - Timing: cold 158–169 ms; **warm 1.7–2.5 ms** (target <300 ms).
  - Size: 767 KB raw / **100 KB gzip**.
- `/api/nba/league-profile` 200 (`draft.rounds:14`); `/api/nba/market` 200.
- Top 15 (rank, Yahoo #, Mkt #):

  | # | player | Y | M |
  |---|---|---|---|
  | 1 | Jokić | 1 | 1 |
  | 2 | Wembanyama | 2 | 2 |
  | 3 | Dončić | 3 | 3 |
  | 4 | Jalen Johnson | 12 | 12 |
  | 5 | SGA | 4 | 4 |
  | 6 | Giannis | 6 | 6 |
  | 7 | Cunningham | 5 | 5 |
  | 8 | Flagg | 11 | 11 |
  | 9 | Şengün | 22 | 22 |
  | 10 | Adebayo | 26 | 26 |
  | 11 | Barnes | 15 | 15 |
  | 12 | Clingan | 44 | 44 |
  | 13 | KAT | 16 | 16 |
  | 14 | Tatum | 7 | 7 |
  | 15 | Maxey | 8 | 8 |

  This matches the expected shape (Jokić, Wemby, Dončić, SGA, Giannis, Cunningham, Flagg, Şengün…). Jalen Johnson and Clingan are the model's strongest disagreements with the market.

### Browser: full manual drafts against the real endpoints (`scripts/nba-int-draft.py`, team 5 takes the page's recommendation, 11 teams pick by market rank + noise)
| run | picks | load | click→render p50/p95/max | checks |
|---|---|---|---|---|
| 1280×800 | 168/168 | 1.2 s, 22 req, 0.94 MB decoded | 63 / 96 / 117 ms | all pass |
| 375×812 (mobile emulation) | 168/168 | 1.3 s | 67 / 148 / 203 ms | all pass |
| 1280, Rounds=16 via dialog | 192/192 | — | 69 / 94 / 108 ms | all pass |

Checks run in each:
- the pick clock counts down (1:30 → 1:29);
- undo at pick 30 restores the player;
- a reload at pick 100 keeps the pick number;
- no `NaN`/`undefined` anywhere in the page;
- no horizontal scroll;
- Valančiūnas (Yahoo-only) is searchable with the NO LOGS badge;
- the only failed requests are the logged-out `/api/nba/yahoo/status` 401s, which are by design. They show up as browser "Failed to load resource" console lines; there are no JS errors.

Slot sanity:
- C-only players never landed in F/PF.
- UTIL took bigs (Ware, Sharpe) only after C was filled.
- In the 16-round run the overflow went to IL, flagged "NOT IL", with the warning "1 healthy player past the bench". That is correct, and it's why 14 rounds is the right default.
- Catch-up warnings fired, e.g. `Catch-up: no G yet · 6 picks left` + `G is drying up` around pick 97.

Screenshots (inspected): `docs/nba-ui/int-{1280,375,1280-r16}-{empty,p24,p60,p120,p167,final,roster,cheat,yahoo-only}.png`, `int-cheatsheet-375.png`, `int-cheatsheet-rounds-375.png`.

### Adversarial scoring review (task 5)
- **Hand recompute:** I recomputed 522 game rows for 10 players (Jokić, Wembanyama, Dončić, SGA, Giannis, Cunningham, Şengün, Giddey, Trae Young, Sabonis) from the raw log columns with an independent formula (PTS 1, REB 1.2, AST 1.5, STL 3, BLK 3, TO −1, PF −1, TECH −1, DD +5, TD +3). That gave **0 mismatches** against `rowScore`.
  - **TD game:** Cunningham 46/12/11/5/2, 2 TO, 4 PF → 99.9, which equals the hand total of 91.9 + 5 + 3. The no-DD variant would be 94.9.
  - **Turnover-heavy game:** Cunningham 23/7/14/5/0, 9 TO, 4 PF → 59.4, matching the hand total.
- **DD/TD flag:** `flags.tdAlsoCountsDD = true`, so a TD earns +8. `profile.unverified` surfaces "DD/TD bonus unverified" in the API. The impact is ≈5 pts on ~0.5% of games.
- **14-day weeks:** value follows games-in-week, not week length. Jokić week 7 (5 g) = 79.5 vs a 75.3 average 7-day week; Giddey 55.3 vs 51.0. Week 17 (Feb 15–28, All-Star break) has only 3–4 games per team in the schedule data, so it isn't uniformly higher. That's correct given the data; S1 also notes the NBA Cup window is under-scheduled.
- **Replacement level ~26 at every slot (H1 caveat):** the board's recommendation does not use `vorp`. It uses exact slot-DP starter gain plus VONA, so the flat replacement isn't degenerate for picks.
  - I did find two real degeneracies and fixed both, instead of re-deriving replacement per slot group.
  - **(1) Bench overdraft of C.** Bench picks were "best ceiling" regardless of position: the first real-data draft ended with **7 of 14 C-eligible** players. Bench score is now scaled by depth need, i.e. eligible roster players beyond each slot's count. Result: 5.8/14 C-eligible on average over 12 sim drafts, against 4.2 for the bots. That's a mild big-man lean, which is the model's genuine view of High Score rebounds/blocks/DD.
  - **(2) "Likely left at my next pick" assumed the other teams draft by *our* value.** Clingan (model #12, market #44) was taken at #20 "because the best C at #29 is worse", but the market would leave him. The other teams' picks are now the top-k by **market rank**, with P(gone) from a logistic on market position (sd = 2 + 12% of rank), and VONA is scaled by P(gone). The reason text says "market #44: likely still there next pick".
  - **Weight retune.** score = 0.5·gain + VONA (was gain + 0.6·VONA). In an offline 96-draft harness (24 seeds × slots 1/5/8/12, same draft-logic as the page, market+noise bots) our starter value rose from 471.4 (no market) → 472.9 (market-aware) → **475.6** (re-weighted). Bots averaged 416.4.
  - Independent check: S1's season simulator found "VORP-per-need with value-over-next-available" to be the best policy at every slot (docs/nba-draft-strategy.md).
  - Caveat: both harnesses score with our own model values.

### Draft rounds (task 6)
**Default 14 rounds (168 picks); IL spots are not drafted.**
- Evidence: Yahoo's own Basketball 101 guide says the default roster (PG, SG, G, SF, PF, F, 2 C, 2 Util, 2 IL + 3 BN) "go[es] through 13 rounds". 10 active + 3 BN = 13, so IL is excluded. Yahoo's football guide uses the same rule ("15 rounds" = 9 starters + 6 BN).
- Sources: https://aol.com/sports/yahoo-fantasy-basketball-101-guide-225349157.html, https://help.yahoo.com/kb/SLN6919.html, https://ca.sports.yahoo.com/news/how-to-draft-in-fantasy-football-210920586.html.
- Confidence is about 85%: no Yahoo help page says "IL is not drafted" verbatim.
- Implementation: `profile.draft.rounds = 14`, and the board's `settings.rounds` (League dialog → Rounds) can override it. With Yahoo connected, **Yahoo's own pick list sets the draft length and order** (keepers and traded picks included). The 16-round path was verified with a 192-pick run.

### Boot smoke (task 8)
- 200: `/`, `/nfl` (same bytes as `/`), `/nba`, `/nba/draft`, `/nba/lineup`, `/api/nba/health`, `/api/nba/league-profile`, `/api/nba/players` (warm 1.7 ms), `/api/nba/market`.
- 401 when logged out: `/api/nba/yahoo/{status,league,draft,diagnose}`.
- 404 (deny-list): `/nba/model/enrich.js`, `/nba/router.js`, `/nba/league-profile.js`, `/server.js`, `/.env.local`, `/package.json`.
- NFL files are untouched since 612cb5c. The only non-nba/scripts/docs/data changes are `.gitignore` and `package.json`.

## Remaining risks (ranked)
1. **Live Yahoo sync was not exercised against a real running draft.** The integration ran logged out, in manual mode. H2/G tested the Yahoo paths against mocks. Mitigation: the manual board works without Yahoo, the offline sheet is the fallback, and `/api/nba/yahoo/diagnose` should be run once while signed in, before 7:30pm.
2. **Rounds 14 vs 16** is inferred (~85%). If the Yahoo draft room shows 16 rounds, set League → Rounds 16. Connected, it follows Yahoo automatically.
3. **Model-vs-market disagreements are large at the top** (Jalen Johnson #4 vs market #12, Clingan #12 vs #44, Şengün #9 vs #22, Adebayo #10 vs #26). The board now defers players the market will leave, but its round-1 pick at slot 5 was Jalen Johnson (GTD tag) over SGA. Treat ▼reach/▲value as a sanity check and use judgment.
4. **Injury tags come from Sleeper** (Dončić Q, Giannis Q, Jalen Johnson GTD at build time). Refresh before the draft by reloading the page; the server re-pulls injuries.
5. **DD/TD semantics unverified** (`tdAlsoCountsDD`): small effect.
6. **Yahoo-only rows (117)** are valued from Yahoo projected fanPts/GP × 0.844 + 5.36, then × 0.9. That's a conservative estimate with no measured spread, and it has no market rank. Westbrook lands at #238 (Yahoo #264).
7. Late-round recommendations sometimes take a player the market would leave (e.g. Fears at #101, market #185) when every candidate's VONA is small. This is harmless, but glance at the M column.
8. Week 7/17 game counts in Sleeper's schedule are low (NBA Cup TBD games, All-Star break). This is uniform across players, so the effect on ranking is small.
9. `/data/*.json` (market, snapshot, logs) is served publicly. This was already the case (the NFL static design); it's all public sports data with no personal fields.

## DRAFT-DAY RUNBOOK (Dillon)
1. **Before 7:00pm (optional): refresh the Yahoo player snapshot.** Use the OpenClaw browser logged into Yahoo, then from the repo run:
   `python3 scripts/yahoo-player-snapshot.py data/nba/yahoo-snapshot-242808.json` (read-only and paced)
   then `node scripts/nba-market-build.js` and `node scripts/nba-cheatsheet.js`. Restart the server (or wait out the 10-minute cache).
2. **Open the board:** `/nba/draft` on the deployed site (or locally: `PORT=7994 node server.js` with `.env.local`, then http://localhost:7994/nba/draft). On first run, tap **Use manual board**, or **Connect Yahoo** if signed in.
3. **~7:30pm, when Yahoo randomizes the order:** tap **League** (top right; a sliders icon on phones) → **My draft slot** = your Yahoo slot → Save.
   - Rounds should read **14**. If Yahoo's draft room shows 16 rounds, set Rounds = 16.
   - With Yahoo connected, slot and order come from Yahoo automatically.
4. **During the draft:** the sticky clock shows who's on the clock and your next two picks. Mark other teams' picks with **Draft** on each row (search by name; accents are optional). When it's your turn, the thumb bar shows **Draft <name> → slot**: one tap.
   - **Mkt column:** `M44` is the market (Yahoo-first consensus) rank.
   - Green **▲n** means we rank him n spots higher than the market (value: he may come back to you).
   - Red **▼n** means the market will take him before our rank (reach).
   - **NO LOGS** = Yahoo-only player with an estimated value.
   - **Undo** reverts the last pick. The board persists in this browser across reloads.
5. **Backup, offline:** `dist/nba-cheatsheet.html` (regenerate with `node scripts/nba-cheatsheet.js`; `dist/` is gitignored, so it's never committed).
   - AirDrop it to the phone and open it in **Safari** (Files → Share → Open in Safari) so localStorage and taps work. Airplane mode is fine; it makes zero network requests (verified at 375px).
   - Set "My draft slot", tap rows taken by others, and ★ your picks. The Rounds tab shows 14 rounds.
   - Print/paste copies: `dist/nba-board.md`, `dist/nba-board.csv`.
6. **If the page misbehaves mid-draft:** reload (picks persist). If it's still broken, switch to the offline sheet. Yahoo's own draft room is the source of truth for what was actually drafted.
