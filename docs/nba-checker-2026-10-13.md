# Pocket NBA: Checker report, 2026-10-13

Checker: a separate agent from the Makers. Base `50aabb4`, integration branch `nba`. Nothing was pushed, `main` was not touched, and nothing was deployed.

## Verdicts
| Stream | Branch (head) | Verdict |
|---|---|---|
| A foundation | `nba-a-foundation` (c671f66) | **PASS, after 1 integration fix.** As shipped, A had a process-crash path (see A1); it is fixed in `1150ab4`. |
| B model | `nba-b-model` (b7c2a19) | **PASS** |
| C ui | `nba-c-ui` (4ce40eb) | **PASS.** One cross-stream nav issue (C1) is fixed in `3f649fd`. |

## Test runs (re-run by the Checker, all exit 0)
| Suite | On branch | After A | After B | After C | Final |
|---|---|---|---|---|---|
| NFL `npm test` (weekly-score, lineup, trade-fit, week-history, waivers) | 0 | 0 | 0 | 0 | 0 |
| `test-nba-yahoo.js` | 35 passed | 35 | 35 | 35 | 35 |
| `test-nba-model.js` | 18 checks | n/a | 18 | 18 | 18 |
| `test-nba-ui.js` | 31 passed | n/a | n/a | 31 | 31 |

Final `npm test` now runs all eight suites (commit `d6845f3`) and exits 0.

Note: A's spawned real-server test prints `ok` even when it is **skipped** for lack of Clerk keys, which happens in the integration worktree because it has no `.env.local`. I re-ran it with the Clerk keys loaded from the main repo's env file (`DATABASE_URL` forced empty) and it genuinely passed after every merge.

## Merge
I merged A, then B, then C with `--no-ff`. There were **no conflicts**: file ownership held, and no stream edited `package.json`. Integration commits on `nba`:
- `e0efffa` merge A, `84b02ed` merge B, `a43cb0f` merge C
- `1150ab4` fix(nba): `/nba/auth/callback` returns 503 when the Yahoo env is missing, instead of crashing the process
- `3f649fd` fix(nav): skip the injected NFL|NBA switch when the page already has `#rr-sport-switch`
- `d6845f3` test: add the NBA suites to `npm test`

## Contract review (`git diff 50aabb4..<branch>`)
- **server.js:** exactly one hook, placed before the static deny block and the `*` catch-all, plus `/nba` in `SITEMAP_PAGES`. No other NFL route changed.
- **`/nfl`:** rewrites `req.url` in place with no redirect. The body is byte-identical to `/` (same md5) for both bare `/` and `?companion=1` (index.html rule). `/nfl/` behaves the same.
- **Env:** `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` are read from `env` only. Nothing is hardcoded, and the fixture token is fake. A grep of logs for the fake secret during the boot test found 0 hits. Error messages from the token endpoint never echo the body. `.env.local` is gitignored, untouched, and not in any diff.
- **Token store:** AES-256-GCM with an HKDF key from `NBA_TOKEN_KEY`, falling back to `YAHOO_CLIENT_SECRET`. The DB table holds ciphertext only, and tokens are never sent to the browser (`/status` checked for leaks).
- **OAuth state:** HMAC-signed `{u,n,t}` with `timingSafeEqual`, a 10-minute TTL, and a check that the state belongs to the Clerk user. Nonces are single-use from an in-memory registry.
- **API shapes:** match the contract for players, status, league, draft, roster and health. C consumes exactly these. A's `getLeague().roster_positions` (`[{position,count}]`) and `getTeams().draft_position` fit C's `settingsFromYahoo`.
- **Deny list:** `/nba/router.js`, `/nba/yahoo/*`, `/nba/model/*`, case variants, `%2F` and `..` tricks all return 404. `/nba/pages/*.js` returns 200.

## Break attempts
### A (router, OAuth)
All of these behave correctly:
- **Login:** signed-out → `/nba?yahoo=signin`; signed-in → Yahoo with the localhost `redirect_uri`.
- **Bad state:** tampered, other-user, expired (11 min), garbage, missing state and missing code all return 400. `error=access_denied` → `?yahoo=denied`.
- **Replay:** rejected, including after another user tried the same state first.
- **Expired or revoked refresh token:** `invalid_grant` returns 409 `yahoo_reauth`, the tokens are deleted, and `/status` then reports `connected:false`.
- **Yahoo errors:** 503 → 502, 429 → 429, not connected → 409.
- **Bad input:** a bad or injected `league_key` and `week=99` return 400.
- **Unauthenticated `/api/nba/yahoo/*`:** 401.

Problems found:
- **A1 (fixed, was a blocker):** with no `YAHOO_CLIENT_SECRET`/`NBA_TOKEN_KEY`, any signed-in request to `/nba/auth/callback?state=a.b` threw inside an async handler. Express 4 doesn't catch that, and server.js has no `unhandledRejection` handler, so **Node exited and took the NFL site down with it**. Reproduced, fixed with a guard that returns 503, and verified.
- **A2 (minor, not fixed):** `sendYahooError` also deletes the user's tokens on `invalid_client`. A server-side credential misconfiguration would silently disconnect every user who makes a request. Suggest deleting tokens only on `invalid_grant`.
- **A3 (minor):** logout accepts GET, so it is CSRF-able (A already disclosed this).
- **A4 (minor):** `/api/nba/health` returns `modelAsOf: null` until the first `/api/nba/players` call. B exports `status()`, not `asOf`.

### B (model)
These hold up:
- **Board:** 650 players, every contract key present, no non-finite values, no duplicate ids, no duplicate normalized names.
- **Weeks:** weeks 1/25/26/30 build. Weeks -1, 1.5 and `abc`, and season 2019, throw.
- **Matching** handles diacritics (Jokić, Dončić, Porziņģis, Şengün, Schröder), suffixes (Jr./III), P.J./PJ, aliases (Nicolas→Nic, Moe→Moritz, Bones), and Jalen vs Jaylin Williams on the same team. Null, empty or nameless inputs return null, and an empty players list returns null.
- **Sleeper empty-stat rows** (DNPs) are handled by the `sp>0` rule. This is documented and tested against ESPN counts.

Minor findings:
- A unique-name match with a team mismatch is still accepted at 0.75–0.80 confidence (intended for traded players). It could mis-assign a same-name player if Sleeper lacks the right one.
- `expectedMax({mean:NaN})` returns a number instead of NaN or 0.
- The background Sleeper refresh runs on the request path (it is not awaited) and writes only to the gitignored `data/nba/cache/`. The test run left the tree clean.

### C (draft logic)
These hold up:
- **Snake order:** correct for 2, 3, 10 and 12 teams; `picksForSlot` agrees with `snakeOrder` for every slot.
- **Zero-starter/zero-bench settings:** 0 picks, no next pick, `bestAvailable` returns `[]`.
- **Garbage settings:** clamped.
- **Slot assignment:** dual G/F players flex correctly, and a 7-player case reaches the optimal 310. Players with no `elig` or a NaN value go to the bench without turning the total into NaN.
- **`mergePicks`:** handles duplicate pick numbers, the same player picked twice, unmatched picks, pending manual picks, and null input.
- **Persistence:** corrupt localStorage deserializes safely.
- **Degraded mode:** backoff goes 4/8/16/30s. Any `/status` error falls back to manual mode.
- **XSS:** Yahoo names are `esc()`-escaped everywhere I checked.

Problems found:
- **C1 (fixed):** C's static switch uses `#rr-sport-switch` without the `.rr-sport` class, so A's nav.js injected a second switch on `/nba`. nav.js now skips injection when that element is present.
- **C2 (minor):** an empty `roster_positions` array resets bench to 0.
- **C3 (minor UX):** the page ignores `?yahoo=signin|denied|error|connected`, so a signed-out user who clicks Connect lands back on the page with no message.

## Live boot (integrated `nba`, port 7993, fake Yahoo env, no DB, model offline)
- **NFL pages:** `/`, `/nfl`, `/nfl?companion=1`, `/draft`, `/trade`, `/research`, `/team` and `/lineup` all return 200.
- **NBA pages:** `/nba`, `/nba/draft` and `/nba/lineup` return 200, with one switch on the page.
- **Players:** `/api/nba/players` returns 200 with 650 players (top: Jokić). `?week=3` returns 200; `?week=abc` returns 400.
- **Health:** `/api/nba/health` → `{ok:true, yahooConfigured:true}`.
- **Unauthenticated:** `/api/nba/yahoo/status` and `/api/nba/yahoo/draft` return 401 JSON. `/nba/auth/login` and `/nba/auth/callback` redirect 302 to `/nba?yahoo=signin`. Logout redirects 302 to `?yahoo=disconnected`.
- **Sitemap:** includes `/nba`.
- **Deny list:** `/nba/router.js`, `/nba/yahoo/crypto.js` and `/nba/model/index.js` return 404.
- **Note:** `data/nba/*.json` is served statically. It is public Sleeper data, so this is acceptable, but it is visible.

## Not verified
- No real Yahoo account was used: the OAuth round-trip and live draft shapes are fixture-based only.
- Nav switch styling was not checked in a browser.
- Prod `https://pocketff.com/nba/auth/callback` must be registered on the Yahoo app before go-live.
