# Pocket NBA: Checker report for stream G (hardening, draft day, Yahoo live path), 2026-10-13

Checker: a separate agent from G's Maker. Branch `nba-g-harden`, reviewed at `d65a677`. Nothing was pushed, `main` was not touched, and nothing was deployed.

## Verdict: **PASS, after fixes**
Every earlier Checker finding (A2, A3, A4, C2, C3) and the in-memory nonce gap are genuinely fixed; I verified each with my own tests. The OAuth flow, token storage and parser hold up under attack and fuzzing. I found one process-crash path (latent; it is the same class as A1) and three draft-day defects. All four are fixed in 2 commits, each with regression tests.

## Test runs (re-run by the Checker)
| Suite | At `d65a677` | After fixes (`e8bba2c`) |
|---|---|---|
| `node scripts/test-nba-yahoo.js` | exit 0, 62 passed | exit 0, 62 passed |
| `node scripts/test-nba-hardening.js` | exit 0, 25 passed | exit 0, **31 passed** |
| `node scripts/test-nba-model.js` | exit 0, 18 checks | exit 0, 18 checks |
| `node scripts/test-nba-ui.js` | exit 0, 31 passed | exit 0, 31 passed |
| `npm test` | exit 0 | exit 0 |
| Checker probe (`/tmp/gck/probe.js`, not committed) | n/a | 16 passed, 0 failed |

- The spawned real-server test in `test-nba-hardening.js` actually ran (Clerk keys came from `.env.local`); it was not skipped.
- `test-nba-hardening.js` is **still not in `npm test`**. Per the contract the lead appends it at integration.

## Earlier findings, re-verified independently
| Finding | Result |
|---|---|
| **A2** `invalid_client` deleted tokens | **Fixed.** Tested through the real refresh path on `/league`, `/draft`, `/roster` and `/status`, with an expired user A and a healthy user B. `invalid_client` and a bare 401 give 503 `yahoo_misconfigured` and keep A's tokens. `invalid_grant`, in both string and object form, gives 409 `yahoo_reauth` (`/status` → `{connected:false, reauth:true}`), drops **only A's** tokens, and leaves B's untouched. |
| **A3** GET logout | **Fixed.** GET, HEAD, PUT, DELETE and OPTIONS all return 405 with `Allow: POST`. Every one of these POSTs returns 403 and the tokens survive: `Sec-Fetch-Site` cross-site, same-site or none; no headers at all; `Origin` set to evil.com, `pocketff.com.evil.com` or `null`; a Referer only. Same-origin POST (via `Sec-Fetch-Site` or a matching `Origin`) returns 200. **In real Chromium**, a cross-origin `fetch(no-cors, credentials)` and an auto-submitted cross-origin `<form method=POST>` both got 403 and the tokens stayed. The chip's Disconnect sent POST, got 200, and the page reloaded into manual mode. |
| Nonces in memory | **Fixed.** With a DB stub: an issue followed by a "restart" (a new store instance) still consumes correctly. An expired nonce is rejected and its row is deleted. Replay is rejected. A cross-user attempt is rejected **and burns the nonce**. Empty and object nonces are rejected. Without a DB, the memory fallback is single-use. A nonce-store outage returns 503 and never crashes. |
| **A4** health `modelAsOf` | **Fixed.** It reads `model.status().asOf` before any `/players` call. |
| **C2** empty `roster_positions` | **Fixed.** `[]`, `{}`, `undefined` and `null` all keep the current bench and slots. |
| **C3** `?yahoo=` messages | **Fixed.** All six keys are handled (code read plus the existing UI-wiring test). |

## Break attempts that held
- **OAuth state:**
  - tampered body or signature → rejected;
  - other user → `user_mismatch`;
  - issued more than 60s in the future → expired;
  - a different key → rejected;
  - a 5 KB garbage state → rejected.
  Extra `.x` segments are ignored, which is harmless because the signature is still checked.
- **Login CSRF and cross-user:** state is bound to the Clerk user, so an attacker can't mint a state for a victim.
- **`redirect_uri` behind the proxy:** I tried each of these against `/nba/auth/login`:
  - `Host: evil.com`;
  - `X-Forwarded-Host: evil.com` with `X-Forwarded-Proto: http`;
  - `Host: localhost.evil.com`;
  - `Host: localhost:3000@evil.com`.
  The redirect always went to `api.login.yahoo.com`, with `redirect_uri=https://pocketff.com/nba/auth/callback`. Every callback redirect is a fixed `/nba?yahoo=…` path, so there is no open redirect.
- **Token encryption:** AES-256-GCM with a fresh 12-byte IV per encryption (200/200 unique) and an HKDF key; the ciphertext never contains the plaintext.
- **Rate limits:** with `trust proxy 1`, as server.js sets it, a spoofed leftmost `X-Forwarded-For` doesn't get a new bucket; requests 4 and 5 return 429.
- **ETag and gzip:**
  - the gunzipped body is byte-identical to the identity body;
  - weak, strong and list `If-None-Match` all return 304 with an empty body;
  - the ETag differs per week, and a week-1 ETag on `?week=3` returns 200.
  - `?week=0x3` is accepted as week 3, which is harmless.
- **Parser fuzz** (my own harness): 400 rounds of randomly mutated fixtures, using:
  - deleted keys;
  - `null`, `""`, `[]`, `{}`, `[[]]`, `{count:3}` and `{"0":"str"}` substitutions;
  - array↔object swaps.

  Plus 14 malformed bodies (truncated JSON, XML, a 999 HTML page, `null`, `[]`, a scalar, error JSON echoing a Bearer), each at 200, 400 and 999, and 100 random truncations. That came to **3,794 client calls, 1,117 typed `YahooError`s and 0 untyped throws**. Each round also ran `runDiagnose` and `formatReport`, and the router, draft-page and `settingsFromYahoo` consumers handled the results. No token appeared in any report, and the captured router logs contained none of the client secret, access token or refresh token.
- **Draft clock** (my own cases, with 4 teams and a snake):
  - t1 owns traded pick 4 and t2 has a keeper at pick 7 → the clock is at pick 4 with t1 on it and `gapNow=2` (the keeper is skipped);
  - a pending local pick moves the clock to pick 5 (t4);
  - the keeper slot is skipped for t2's next pick;
  - `mergePicks` assigns the pending pick to slot 4 with t1 as owner;
  - postdraft → done;
  - no order → snake fallback.
- **Browser** (Chromium; the real `nba/router.js` with a fake Yahoo client; 10 teams, I own pick 8 by trade, keeper at pick 15):
  - at 375×812 and 1280×800, `scrollWidth` ≤ viewport and there are no console errors;
  - the ticker shows YOU at 3 and 8, and round 2 skips the keeper slot;
  - the title countdown works;
  - the chip menu has the league picker, Reconnect (`/nba/auth/login`) and Disconnect (POST);
  - the auction league shows its banner, "Auction · manual mode", and no timer.

## Defects found and fixed
| # | Severity | Defect | Fix |
|---|---|---|---|
| G1 | **High (latent crash)** | `/api/nba/yahoo/diagnose` awaited `runDiagnose()`/`formatReport()` with no try/catch. Express 4 doesn't catch a rejected async handler and server.js has no `unhandledRejection` handler, so any unexpected throw would **exit Node and take NFL down** (the same class as A1). Fuzzing found no path to it through the real parser, but on the old code the handler never responds; my regression test hangs, and in production the process would exit. | `57f3a36`: returns 500 and logs. |
| G2 | Medium (draft day) | A keeper league before the draft: the router promoted an explicit Yahoo `predraft` with picks to `drafting`. The board then showed "Live from Yahoo" and set `onClock`, and the pick clock could start, with title countdown and beep, hours before the draft. Reproduced: the harness returned `"status":"drafting"` for a keeper-only league. | `57f3a36`: an explicit `predraft` is kept, while an unknown or missing status with picks still promotes. `e8bba2c`: the timer stays off during predraft unless picks are being marked by hand. Verified in the browser: "Yahoo · waiting for draft", no timer. |
| G3 | Medium (draft day) | **Polling stopped whenever the tab was hidden**, so a user sitting in Yahoo's draft room tab never got the "your pick" title countdown or the beep, which is the case those features exist for. | `e8bba2c`: `pollPlan()` keeps polling a hidden tab during a **live** draft only, every 10s or more. Browser: 2 polls in 23s while hidden, and the title kept counting down. |
| G4 | Low-medium | Reloading mid-pick restarted the clock at full time. My first fix was itself buggy: the transient manual-board render during reload overwrote the saved entry. Caught in the browser. | `e8bba2c`: a bounded sessionStorage list keyed by league and pick; stale entries are ignored. Browser: 0:18 before the reload, 0:13 about 5.7s after. |
| G5 | Low | `openSlots()` counted a duplicated Yahoo slot twice (`myAfter` was equal to `myNext`). | `e8bba2c` |
| G6 | Low | The diagnose report's "other settings" could include URL-valued entries whose key didn't match the redaction list (e.g. a logo or chat link). | `57f3a36`: values starting with `http(s)://` are dropped. |

All regression tests are in `scripts/test-nba-hardening.js`, which went from 25 to 31 tests. I confirmed that the G1 and G2 tests fail on the pre-fix router.

## Unfixed issues (ranked)
1. **Bare 401 from `get_token` is classified as `invalid_client`.** If Yahoo ever answers a dead refresh token with a bare or non-JSON 401 instead of `invalid_grant`, that user is never told to reconnect; they see "Yahoo unavailable" indefinitely. This is a deliberate trade-off. Confirm it on the first real login and revocation.
2. **`test-nba-hardening.js` is not in `npm test`.** The lead should add it at integration.
3. **The pick timer is still local.** It starts when a pick change is observed, which lags by up to a poll. In a hidden tab after 5 or more minutes, Chrome's intensive throttling can reduce the 10s poll to about once a minute. The real fix is a server-side deadline, which Yahoo doesn't expose.
4. **The token blob has no AAD binding to `clerk_user_id`.** Someone with DB write access could move a blob between rows. Low risk: DB write access already means compromise.
5. **`yahoo-diagnose.js --blob-file` refreshes in memory only.** If Yahoo rotates refresh tokens on refresh, the stored blob could go stale. Prefer `--user`.
6. **Auction mode still shows "Best for your pick #18".** A pick number means nothing in an auction. Cosmetic.
7. **Rate limiting depends on Railway being exactly one proxy hop (`trust proxy 1`).** Unverified against Railway's real edge. If there are two hops, all users would share one bucket of 120/min on `/api/nba/players`.
8. **Inherited from the earlier report, still open:** B's `expectedMax({mean:NaN})`, and team-mismatch name matches at 0.75–0.80 confidence.

## Not verified
- A real Yahoo account. Everything is fixture- or stub-based, and the FIRST REAL LOGIN RUNBOOK in `docs/nba-handoff-g.md` is the way to close that. I reviewed the runbook and it is sound: no step asks anyone to paste a token, a code or a state.
- A physical phone. I used a 375×812 emulation only.
- Real background-tab throttling. Hidden-tab polling was simulated by overriding `document.hidden` and dispatching `visibilitychange`.
