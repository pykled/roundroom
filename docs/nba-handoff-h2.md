# Stream H2 handoff: draft board for league 242808

Branch `nba-h2-board` (off `nba` @ `cff2be7`). Nothing was pushed or deployed. Files touched: `nba/pages/draft.html`, `nba/pages/draft.js`, `nba/pages/draft-logic.js`, `scripts/test-nba-ui.js`, `scripts/nba-ui-mock.js`, `docs/nba-ui/h2-*.png`, and this doc. Model, router and yahoo files are untouched.

## What the page consumes
- `GET /api/nba/league-profile`: `teams`, `slots{PG,SG,G,SF,PF,F,C,UTIL,BN,IL}`, `draft.pickSeconds`, `name`, `leagueId`. If it 404s or fails, a toast says so and the built-in 242808 shape is used (`L.DEFAULT_SETTINGS` in draft-logic.js, mirroring the contract).
- `GET /api/nba/players?profile=<leagueId>`: uses `yahooElig`, `eligConfidence`, `vorp` and `hsValue`/`rank`/`tier` when present. **It degrades when they're missing:**
  - Eligibility is derived from Sleeper `pos[]` using the contract legend. A pure C is never F-eligible. The pills are dashed and a note says the positions aren't confirmed by Yahoo.
  - With no `pos` either, it falls back to the model's `elig`, and then to UTIL only.
  - If `vorp` is missing it is simply not shown.

## What was built
- **Settings come from the profile.** Any league with a PG/SG/SF/PF/C/F-C slot is position-aware; leagues with only G/F/UTIL keep the old High Score behaviour (`L.HIGH_SCORE_SETTINGS`).
  - No 6-starter or 10-man assumptions remain in draft.js or draft-logic.js.
  - `rosterSize = starters + BN + IL`, which gives 16 rounds and 192 picks.
  - A Yahoo league's `roster_positions` overrides the profile. PG…C, Util, F/C, BN and IL/IL+ are all mapped.
  - Saved 10-team boards migrate to the profile, keeping their picks and draft slot. Settings edited in the League dialog stick (`settingsSource:'user'`), and "Use the league profile again" resets them.
- **Exact slot assignment.** The DP runs over used-slot counts (384 states for 242808), so dual-eligible players land wherever they help. Ties go to the narrowest slot. It is checked against brute force on random rosters.
  - IL takes OUT/SUS players first. Healthy overflow past the bench is flagged "NOT IL".
- **Recommendation.** The score is starter gain plus 0.6×VONA (against the best player for the same slot expected at my following pick), plus a scarcity bonus when the slot is open and its top-40 supply is below the picks before my turn, plus a ceiling bias. It is multiplied by an injury factor.
  - It returns a one-line reason, for example: `Fills open C slot; 1 C-eligible left in top 40 · +13.2 over the best C likely left at #44`. Upgrades read `Upgrades your C (+5.0)`.
  - It is deterministic: ties break by value, then id.
- **Board.**
  - Slot filter chips (All, PG…C, U), each showing how many eligible players are left in the top 40. A red dot means a run (≥3 of the last round of picks and ≥1.6× the slot's share); amber means the slot is thin.
  - Tier filter, Hide OUT, search, injury badges, games chips, ceiling/floor, VORP in the recommendation and player sheet.
  - The roster panel adds a "Top 40 left" strip.
- **Roster.** 9 starter slots plus 5 BN plus 2 IL. Open slots that need catching up turn amber.
  - Warnings include `Catch-up: no C yet · N picks left` (danger when open starters ≥ picks left) and "X is drying up" for open slots. Overlap-aware demand means G counts PG/SG starters and F counts SF/PF.
- **Clock.** 12-team snake with the reversal, "You pick in N · #x (Rk), then #y", and G's pick timer (90s from the profile unless the user or Yahoo's `draft_pick_time` overrides it).
  - When a Yahoo league is connected, G's Yahoo-order clock, merge, polling, degraded and auction logic are unchanged.
- **Mobile.**
  - The bottom bar (thumb zone) has 9 slot pips. When it's your pick it shows a one-tap **Draft <name> → slot** button; otherwise it shows status and the top warning.
  - The top clock stays sticky, and the filters scroll away on phones.
  - No horizontal scroll at 375, and the browser script asserts that tap targets are ≥40px.
  - `prefers-reduced-motion` and reduced-transparency are kept.
- **Cheat sheet** (view toggle, or press `c`):
  - all 16 rounds with the pick number, done picks, and 5 targets around each pick (★ marks a player who fills a starter slot you still need);
  - catch-up warnings;
  - by-slot tiers of the best available;
  - `@media print` layout plus a Print button.

## Tests (each run separately with `; echo exit=$?`)
- `node scripts/test-nba-ui.js`: **66 passed, exit 0**, up from 31. New tests cover:
  - profile/Yahoo mapping;
  - the 12-team snake, including reversal and turn picks;
  - the eligibility legend (C-only is not F; F/C; G/F; generic G and F tokens; yahooElig precedence and confidence);
  - assignment edge cases, plus brute-force optimality on random rosters;
  - IL;
  - supply, pulse and run math;
  - recommendation and reason;
  - determinism under input reordering;
  - catch-up warnings and the G-demand regression;
  - perf (<250ms for 200 players);
  - the cheat sheet;
  - a 60-case junk-data no-NaN fuzz;
  - settingsSource persistence.

  Three existing assertions changed meaning, and none were dropped:
  - `DEF` is now explicitly the High Score preset;
  - the reason regex reads `Fills open F slot (your first F)`;
  - `settingsFromYahoo` now also returns `il: 2`.
- `test-nba-hardening.js` 31, `test-nba-yahoo.js` 62, `test-nba-model.js` 18 (all exit 0); `npm test` exit 0.
- Browser checks: Playwright against `node scripts/nba-ui-mock.js`, script at `/tmp/h2shots/shots.js` (outside the repo). The scenarios were empty, mid-draft R5 (on the clock), quick-draft plus undo, C filter, cheat sheet, late R12 with open PF/C slots, live Yahoo with picks arriving, my Yahoo pick, degraded with pending manual picks, and no-profile/lean fallback. They ran at 375×812 and 1280×800 with no page errors, no NaN and no horizontal scroll. The shots are in `docs/nba-ui/h2-*.png`.

## Mock
`node scripts/nba-ui-mock.js --port=4791 [--yahoo=off|on|live|degraded] [--profile=off] [--lean=1]`. It serves 206 players carrying `yahooElig`/`eligConfidence`/`vorp`/`vorpBySlot`, the 242808 profile, and a 12-team Yahoo league (my draft position is 5, 90s picks, `order` included). Runtime switch: `POST /__mock/mode?profile=off&lean=1`.

## Gaps and risks
1. **IL in draft rounds.** The contract says 192 picks including IL. Yahoo usually drafts only active spots, which would mean 14 rounds and 168 picks. Once connected, Yahoo's `order` is the truth. On the manual board, set IL to 0 in the League dialog if Yahoo shows 14 rounds; the dialog hint says so.
2. My draft slot defaults to 1. The order is randomized about 30 minutes before the draft: set **My draft slot** in League (manual), or let Yahoo supply it.
3. `vorp` and `vorpBySlot` are only displayed and used as a bench tiebreak. The core score works in `hsValue` units so that starter totals stay consistent. If H1's `vorpBySlot` turns out better calibrated, it can replace the replacement level used in the VONA reference.
4. Cheat-sheet targets use board rank as a stand-in for ADP, since there is no ADP feed.
5. This hasn't been run against H1's real endpoints, only the mock. The field names follow the brief.
6. Not checked on a physical phone; only Chromium device emulation.
