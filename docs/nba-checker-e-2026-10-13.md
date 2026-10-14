# Checker report: stream E (trade calculator), 2026-10-13

Branch `nba-e-trade`, reviewed at 69bdaa7 (base `nba`). Checker is a fresh agent; every number below was re-run by the checker.

## Verdict: **PASS after fixes**
4 fix commits on this branch. Nothing pushed or deployed.

| sha | fix |
|---|---|
| 365d216 | Verdict: lopsided losses now read **Decline**, not Counter. `verdictFor()` extracted and boundary-tested. |
| 7a606b6 | CPU bound on the public evaluate endpoint: slots clamp to G≤4, F≤5, UTIL≤3, and the drop search tries 10 candidates instead of 20. Worst case went from 2.2 s to 0.46 s. |
| f00c8cd | Fixes for season end (`endWeek` respected, `meta.pastEnd` and a warning), a crash when there are no weeks, and ownership conflicts (`meta.notes` → `warnings`). |
| 09d7f37 | Wording: the playoff bullet and the unmatched-player banner grammar. |

## Evidence (exit codes, after fixes)
- `node scripts/test-nba-trade.js` → **0** (23 passed; was 21: 2 new tests plus new asserts in 2 existing ones)
- `node scripts/test-nba-model.js` → 0 · `test-nba-ui.js` → 0 · `test-nba-yahoo.js` → 0
- `npm test` → **0**
- Before the fixes, at 69bdaa7: every suite and `npm test` also exited 0.
- `git diff nba...HEAD -- nba/router.js`: exactly one added line, the trade mount.

## Break attempts (checker's own scripts, real offline board: 650 players, 25 weeks)
- **Symmetry**: 40 random 1–3-for-1–3 trades between snake-drafted teams. Swapping perspective gives max |Δ| error **0.000**. Reversing every equal-count trade gives a negated delta, max error **0.000**.
- **Determinism**: same output when the roster order is reversed or the board order is reversed.
- **Lineup DP**: exact; the maker's brute-force test passes and dual G/F players move correctly.
- **Injured star**: Ingram (Out, weeks 1–3) is valued at 0 now and 38.9/wk ROS, with the return ramp visible in `hsByWeek`.
- **Fuzz**: empty, unknown, duplicate, string or `null` lists; garbage settings; `currentWeek` of 0, −3, `'abc'`, 25 and 99; zero slots; partner = me. No NaN anywhere.
- **Defects found** (all fixed):
  1. **Decline almost never fired.** The rule "lose > band but they gain ≥ 2× band → Counter" holds for nearly every lopsided loss, because one side's loss is roughly the other's gain. SGA for a rank-200 waiver player, SGA for nothing, and Jokić for 3 role players all read *Counter* ("there is room to ask for more"). The maker's own test asserted this behaviour.
  2. **CPU DoS.** `settings.slots {6,6,6}` with a 25-man roster receiving 6 players blocked the event loop for about **2.2 s per request** (measured over HTTP), and the limit is 40 requests/min per IP.
  3. **`currentWeek` past `endWeek`.** It fell back to the board's last week (25) and ignored `endWeek`, with no flag.
  4. **Players without `hsByWeek` threw** (`weeks[0].week`), which the route turned into a 500.
  5. **"Getting" a player already on my roster scored as a gain.** SGA→me while giving Mitchell showed +8.3/wk, measured from a roster without SGA. Giving a player I don't own and putting the same id on both sides were silently accepted.
- **Routes**: malformed JSON → 400 `Invalid JSON`. Array body → 400. Body over 16 KB → 413, with Content-Length and chunked. Object ids → 400. More than 6 give → 400. Bad `league_key` → 400. Player keys without auth → 400 `player_keys_need_yahoo`. Context without auth → 401. `__proto__` keys are harmless. No stack traces or tokens in any response. 429 + Retry-After is covered by the maker's test. `trust proxy` is set in server.js, so the per-IP limit uses real client IPs.

## UI (real Chrome via Playwright, mock server, 375×812 and 1280×800)
Manual mode covered: an empty roster, a 10-player roster added via search, Decline (SGA→Steinbach), Accept (SGA→Jokić), a 2-for-1, get-only, empty both sides, and a reload (state persisted).

Yahoo mode covered: the unmatched-player banner, no partner (an estimated partner is used), picking a partner, and switching to manual.

Weird states covered:
- Evaluate returning 500 with an HTML body: shows "Couldn't score this trade · HTTP 500" with no stack.
- Evaluate taking 4 s: the busy state shows, and a stale response doesn't overwrite a newer one.
- Players API returning 503: shows a banner.
- Context returning 502: shows a banner and falls back to manual.

There was no horizontal scroll at either width in any state. There were no page errors. The only console errors were the browser's own "Failed to load resource" for the injected 500s. The sticky verdict bar shows when the verdict is off-screen and hides while an input has focus (by design). Screenshots: `docs/nba-ui/checker-e-*.png`.

## 30-trade verdict sanity table (after fixes)
Setup: real board, a 10-team snake draft, my team in slot 5 (SGA, Mitchell, Tatum, Curry, K. George, D. Sharpe, Knueppel, J. Hart, Sabonis, M. Turner). `leagueRostered` is set; "(est)" marks an estimated partner. The band is about 2.3/wk.

| # | Trade (give → get) | You/wk [range] | Them/wk | Verdict | Partner | Checker view |
|---|---|---|---|---|---|---|
| 1 | Jokić → Bridges + Hartenstein + Queta | −32.9 [−40.3,−25.4] | +32.2 est | Decline | likely | ✅ (was Counter) |
| 2 | Jokić → Sarr + B. Miller + F. Wagner | −26.1 | +25.3 est | Decline | likely | ✅ (was Counter) |
| 3 | Hart + Sabonis + Turner → Jokić | +32.1 | −31.6 est | Accept | unlikely | ✅ |
| 4 | SGA → Jokić | +16.5 | −14.0 est | Accept | unlikely | ✅ |
| 5 | SGA → Wembanyama | +11.4 [−2.6,25.3] | −8.8 est | Accept | unlikely | ✅ (wide range) |
| 6 | SGA → Jalen Johnson (adjacent rank) | +0.6 | +1.9 est | Counter | likely | ✅ |
| 7 | Mitchell → Harden | +0.1 | −0.1 est | Counter | likely | ✅ |
| 8 | SGA → Steinbach (rank 200) | −16.5 | +18.1 est | Decline | likely | ✅ (was Counter) |
| 9 | Turner → Jokić (real partner) | +32.6 | −32.8 | Accept | unlikely | ✅ |
| 10 | SGA + Mitchell → Jokić | +5.7 [−5.1,16.5] | −4.9 | Accept | maybe | ⚠️ debatable; it hinges on a ~34/wk waiver replacement filling the freed spot |
| 11 | Mitchell + Tatum → Jokić | +16.1 | −15.1 | Accept | unlikely | ✅ (consolidation into a superstar) |
| 12 | Tatum → Jaylen Brown | −0.6 | +0.7 | Counter | likely | ✅ |
| 13 | D. Sharpe + Knueppel → LeBron | +1.8 | −2.3 | Counter | maybe | ✅ |
| 14 | Curry + Sharpe + Sabonis → A. Thompson + Holmgren | +1.6 | +0.1 | Counter | likely | ✅ |
| 15 | Curry → Ingram (Out wks 1–3) | +0.1 | +2.1 est | Counter | likely | ✅ |
| 16 | SGA → Jimmy Butler (Out) | −16.5 | +18.1 est | Decline | likely | ✅ (was Counter) |
| 17 | Turner → nothing | −0.1 | 0 est | Counter | likely | ✅ (10th man ≈ waiver level) |
| 18 | nothing → M. Williams + Ighodaro | 0.0 | 0 est | Counter | likely | ✅ (both would be dropped) |
| 19 | nothing → Wembanyama | +27.5 | −27.3 est | Accept | unlikely | ✅ |
| 20 | SGA → nothing | −16.5 | +18.1 est | Decline | likely | ✅ (was Counter) |
| 21 | SGA → Jamal Murray | −6.7 | +6.7 est | Counter | likely | ⚠️ borderline (just inside 3 bands) |
| 22 | Jokić → SGA | −16.5 | +14.0 est | Decline | likely | ✅ (was Counter) |
| 23 | Jokić → Dončić | −9.8 | +7.2 est | Decline | likely | ✅ (was Counter; Jokić's HS edge is real) |
| 24 | Jokić → Wembanyama | −5.1 | +5.1 est | Counter | likely | ✅ |
| 25 | Jokić → Wemby + Flagg | +8.7 | −7.6 est | Accept | unlikely | ✅ |
| 26 | SGA → Tatum (already mine, ignored) + Castle | −11.1 | +11.2 est | Decline | likely | ✅ (was −1.2 "Counter", inflated by defect 5) |
| 27 | Sabonis + Turner → Bridges | −0.5 | +0.4 est | Counter | likely | ✅ |
| 28 | Curry → Trae Young | +1.2 | −1.1 est | Counter | likely | ✅ |
| 29 | Tatum → Siakam | −3.4 | +3.5 est | Counter | likely | ✅ (was Decline under the old 2× rule) |
| 30 | K. George → Desmond Bane (real partner) | +0.1 | +0.7 | Counter | likely | ✅ |

## Unfixed issues (ranked)
1. **CPU per request is still about 0.46 s worst case**, and evaluation is synchronous on the main event loop. The per-IP limit of 40/min allows about 18 s of CPU per minute per IP. A global concurrency or CPU budget, or a worker, would close this; that is a call for the lead or G.
2. **Ranges dwarf the fair band.** Typical ±8–14/wk against a band of about 2.3, so many "Accept" verdicts have ranges crossing 0 (#5, #10, #25). The verdict ignores the range. This is documented, but the UI could soften "Accept" when the low end is under −band.
3. The headline uses an ASCII hyphen ("-14.0/wk") while the stat tiles use a real minus. Cosmetic.
4. Switching from a Yahoo league to "Manual (no league)" clears the manual roster. It was overwritten by the Yahoo roster anyway, but users may expect their old manual roster back.
5. Leftovers from the maker's own handoff: nav links from draft/lineup, the sitemap, `npm test` wiring, a D lineup optimiser dedupe, and no testing against real Yahoo.
