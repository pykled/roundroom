# Pocket NBA: stream G handoff (hardening, draft day, Yahoo live path)

Branch `nba-g-harden`, based on `nba` @ `4313300`. Nothing was pushed or deployed. Contract: `docs/nba-contracts.md` (Phase 2 addendum: G owns `nba/router.js`, `nba/yahoo/*`, `nba/pages/draft.*`).

## What changed

### Checker findings
| Finding | Fix |
|---|---|
| **A2** Tokens deleted on `invalid_client` | `oauth.classifyError()` sorts every failure into one of four kinds. `invalid_grant` means this user is **revoked**: their tokens are deleted and they get 409 `yahoo_reauth`. `invalid_client`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope` and a bare 401 from `get_token` mean the app is **misconfigured**: tokens are kept, the response is 503 `{code:'yahoo_misconfigured'}`, and a log line goes out at most once a minute without secrets. The callback redirects to `?yahoo=misconfigured`. Error codes are taken only when they match `/^[a-z_]{3,40}$/`, so free text in an error never counts as a code. Yahoo's object-form `{"error":{"error":…}}` is handled. |
| **A3** GET logout was CSRF-able | `POST /nba/auth/logout` only. Every other method gets 405 with `Allow: POST`. The request must be same-origin: `Sec-Fetch-Site: same-origin` wins when present; otherwise `Origin` must match the Host or the public origin; with neither header it is rejected (403). The UI disconnects with `fetch(POST)` from the Yahoo chip. |
| **A4** `/api/nba/health` showed `modelAsOf: null` until the first players call | It now reads `model.status().asOf`. |
| In-memory OAuth nonces (A handoff gap) | New `nba/yahoo/nonces.js` backed by the `nba_oauth_nonces` table. The table is added in `db/migrate.js` and also created lazily on first use. Consuming a nonce is an atomic `DELETE … RETURNING`, so it is single-use even across instances. Expired rows are swept at most once a minute. Without a DB it falls back to memory. A nonce-store outage returns 503 and never crashes. |
| Unbounded player-name cache | Now an LRU capped at 5000 entries. It is a pure cache, so keeping it per instance is fine. |
| **C2** Empty `roster_positions` reset bench to 0 | An empty array or map now keeps the current settings. |
| **C3** The page ignored `?yahoo=` | `signin`, `denied`, `error`, `connected`, `disconnected` and `misconfigured` each show a toast, and the param is then removed from the URL. `signin` opens Clerk sign-in, which redirects back to `/nba/auth/login`. |
| Undecryptable token row (key changed) | Still reported as disconnected, but the row is kept and a one-time warning is logged without secrets. |

### Yahoo hardening
- **Parser** (`nba/yahoo/parse.js`) tolerates:
  - single-entry collections with no `"0"` key;
  - `count` disagreeing with the entries actually present (logged as a warning);
  - `""`, `[]` and `{count:0}` for empty collections;
  - `eligible_positions` as an array, a single object, a numeric-keyed collection or mixed strings;
  - a player with no name;
  - `[]` and `[[]]` placeholders;
  - draft `cost` (auction);
  - `draft_pick_time`.

  Every unmodelled scalar setting goes to `settings.extra`. A missing `fantasy_content`, a JSON `{error}` or an XML body becomes a typed `YahooParseError`, never a `TypeError`. `P.capture(fn, onWarn)` collects warnings.
- **Client:**
  - reads bodies as text, so XML or HTML error pages (999, 4xx) become a `YahooError` carrying the `<description>`;
  - a 200 with an XML body becomes 502 `bad_format`;
  - a parse failure becomes 502 `bad_response`;
  - `onWarning` is passed through;
  - `getLeague` now exposes `draft_type`, `is_auction_draft` and `draft_pick_time`.
- **Redaction:** Yahoo error text is stripped of the live access/refresh token values, `Bearer`/`Basic` credentials and `access_token=`/`code=` params before it reaches logs or reports. The secrets-in-logs test found this leak, and it is fixed.
- **`GET /api/nba/yahoo/diagnose`:** requires sign-in, runs at most once every 20s per user, and supports `?format=text`. It runs the whole read path against the signed-in user's account:
  - game key and leagues (up to 8);
  - per-league settings: scoring_type, draft type, auction, pick time, roster positions, enabled stat categories, stat modifiers, weeks, plus `extra` settings minus anything URL- or identity-like;
  - a `highScore` verdict (likely/possible/unlikely) listing each signal's field, value and whether it matched: scoring_type points, modifiers PTS1/REB1/AST2/ST3/BLK3, roster G2/F3/Util1, name, any `extra` key hinting at best-game scoring;
  - teams with mine and how many have a draft_position;
  - draft-results shape: made/open counts, team_key on every pick, contiguous numbering, cost, first 3 picks with names, first open slot;
  - my roster sample (3 players);
  - per-step timing, errors and parse warnings.

  It contains no tokens and no GUIDs. A revoked token is dropped as usual; an app-credential failure sets `appMisconfigured: true`.
- **`scripts/yahoo-diagnose.js`:** CLI that prints the same report. Modes: `--list`, `--user <clerkId>` (DB row; a refreshed token is saved back), `--blob-file <path>` (refresh kept in memory only), `--fixtures` (offline), plus `--json`.
- **`/api/nba/yahoo/draft`** adds `order` (remaining slots `[{pick,round,team_key}]`), `onClock`, `auction`, and `cost` on picks. All of these are additive, so existing consumers are unaffected.

### Draft day (`nba/pages/draft.*`)
- **On the clock from Yahoo.** When `/draft` returns `order`, `NbaDraft.yahooClock()` decides who is up, my next picks, and the gaps between them. Keepers (filled slots ahead of the clock) and traded picks (one team owning several slots) come out right. Pending local picks fill the next open Yahoo slots, owner included (`mergePicks`). The ticker shows each slot's real owner. The snake is used only in manual mode, or if Yahoo sends no future slots.
- **Pick timer.**
  - Duration: the user setting (League dialog, "Pick timer", 0 = off), else the league's `draft_pick_time`, else 60s.
  - It restarts whenever the pick changes. On the manual board it stays idle until the first pick, or until you tap it.
  - For other teams it is quiet. For my pick it is loud: orange, larger, a red pulse under 10s, the tab title counts down, and it vibrates and beeps twice at 10s (the beep only after a user gesture).
- **Auction guard.** If league settings (`is_auction_draft` / `draft_type`) or draft results (`cost`) indicate an auction, the page shows the banner "Auction drafts aren't supported yet — manual mode", stops Yahoo pick polling, hides the clock and timer, and keeps manual tracking working.
- **Yahoo chip.** `nba/pages/yahoo-chip.js` is a self-contained script with its own CSS and only uses `/status`. It goes in the nav: connected state, league picker synced both ways with the board's selector through the `pocket-nba:league` event, Reconnect, Disconnect (POST), and states for signed-out, reauth and Yahoo-unavailable. It exposes `window.PocketYahoo.status()`, and the board reuses that same `/status` fetch.
- **First run.** A "Two ways to run your draft" card explains Connect Yahoo versus the manual board. It appears only when the user is not connected, has no picks, and hasn't dismissed it.

### Performance and safety
- **`/api/nba/players`** returns a weak ETag (sha1 of the JSON, memoized per cached object), `Cache-Control: public, max-age=300, stale-while-revalidate=600`, `Vary: Accept-Encoding`, and 304 on `If-None-Match`. Gzip comes from server.js's existing `compression()`, verified in-process and on the spawned real server.
- **Per-IP fixed-window rate limits:** `/api/nba/players` and `/api/nba/health` share a bucket of 120/min; `/nba/auth/*` gets 30/min. Over the limit returns 429 with `Retry-After`. Authenticated Yahoo endpoints are not throttled. The limits are in memory per instance.
- **Size limits** on `/api/nba/*` and `/nba/auth/*`: a URL over 2 KB returns 414; a `Content-Length` over 8 KB returns 413.
- **No secrets in logs:** a test drives login, failed and replayed callbacks, invalid_client, invalid_grant, an API 401 that echoes the bearer, diagnose, and an undecryptable row. It captures `console.*` and the router log, then greps for the client secret, the Basic header, access/refresh tokens, GUID, auth codes, OAuth states and the token blob. None appear.

## Commits (on `nba-g-harden`)
`532645d` error classification + DB nonces · `3029141` tolerant parsing + diagnose module · `8faa1ff` router (logout, ETag, limits, diagnose, draft order) · `05e188e` quirk fixtures + tests + CLI · `298804d` error-text redaction · `901965a` draft-day UI + chip · `3654ee4` hardening tests · (this doc).

## Tests (all exit 0 on this branch)
- `node scripts/test-nba-yahoo.js`: **62 passed**, up from 35. Includes 15 quirk fixtures in `scripts/fixtures/nba/quirks/`.
- `node scripts/test-nba-hardening.js`: **25 passed** (new). Spawned real server ran; it was not skipped, because Clerk keys come from `.env.local`.
- `node scripts/test-nba-model.js`: 18. `node scripts/test-nba-ui.js`: 31.
- `npm test`: exit 0.
- `test-nba-hardening.js` is **not** in `package.json`'s `test` script yet. Per the contract, the lead adds suites at integration: append `&& node scripts/test-nba-hardening.js`.

## Notes for the other streams
- D, E and F pages can get the chip with `<script src="/nba/pages/yahoo-chip.js"></script>`, placed after `/shared/nav.js`. It mounts into `#rr-nav .rr-auth` or `[data-nba-yahoo-chip]`. Use `PocketYahoo.league()` for the chosen league and listen for `pocket-nba:league`.
- `/draft` now has `order`, `onClock` and `auction`. `getLeague()` has `draft_type`, `is_auction_draft` and `draft_pick_time`.
- I did not touch B's files. B's minor findings are still open: `expectedMax({mean:NaN})`, and team-mismatch matches at 0.75–0.80 confidence.

## FIRST REAL LOGIN RUNBOOK
Goal: on the first real Yahoo connect, see exactly what Yahoo sends, and confirm the High Score detection, draft order and roster shapes, **without anyone ever handling a token.**

**Before (one time, owner):**
1. In the Yahoo developer app, the redirect URI must be exactly `https://pocketff.com/nba/auth/callback`, with Fantasy Sports **Read** permission. Leave the app settings as they are otherwise.
2. Railway env has `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET`. **Set `NBA_TOKEN_KEY` now**, to any long random string. Without it, tokens are encrypted with a key derived from the client secret, and rotating that secret would silently disconnect everyone. Never paste any of these values in chat.
3. Deploy a build that includes this branch, which is a merge decision for the lead/Dillon. On boot, `migrate()` creates `nba_oauth_nonces`. Check `https://pocketff.com/api/nba/health`, which should return `{"ok":true,"yahooConfigured":true,…}`.

**Connect (Dillon, in a normal browser):**
4. Go to `https://pocketff.com/nba` and sign in to Pocket (top right).
5. Click **Connect Yahoo**, either on the card or in the "Yahoo" chip in the nav. Yahoo asks you to approve read access; approve it.
6. You land back on `/nba` with the toast "Yahoo connected". The chip shows a green dot, and the league selector lists your NBA leagues. If you see something else instead:
   - "Sign in to Pocket first…" means you weren't signed in. Sign in, then repeat step 5.
   - "Yahoo access was not granted" means you clicked Deny.
   - "Couldn't finish connecting Yahoo" usually means a redirect-URI mismatch. Check step 1.
   - "Yahoo is unavailable on our side" means the client id/secret are wrong. Fix the env; nobody's tokens were touched.
   - "Invalid or expired login link" means more than 10 minutes passed, or the page was reloaded. Click Connect again.

**Diagnose (same browser, same tab session):**
7. Open `https://pocketff.com/api/nba/yahoo/diagnose?format=text`. It takes a few seconds and makes about 6 Yahoo calls per league. Reloading within 20s gives "Diagnose runs at most every 20s".
8. What you'll see:
   - a header: `ALL STEPS OK`, or `SOME STEPS FAILED`;
   - `game key: 4xx`, then one block per NBA league;
   - scoring_type, draft_type, auction, pick_time, weeks; `roster: G×2 F×3 Util×1 BN×…`; `modifiers: 12=1 15=1 16=2 17=3 18=3`;
   - `High Score? LIKELY|POSSIBLE|UNLIKELY (n/10)` with ✓/✗ against each field it checked;
   - teams with yours and your draft slot;
   - `draft: made/total, open slots, team_key on every pick=…, contiguous=…, cost=…`, with the first 3 picks if any;
   - your first 3 roster players with their positions;
   - at the end, `FAILED STEPS` and `PARSE WARNINGS` if there are any.
9. **Paste back** the whole text page into the NBA channel. It contains league, team and player names and settings only. It has no tokens and no Yahoo GUID: both are stripped, and the test suite enforces that. If the page is long, paste at least the block for the High Score league, plus FAILED STEPS and PARSE WARNINGS.
10. **Never paste:**
    - the Yahoo redirect URL or anything from the address bar during login (it contains `code=` and `state=`);
    - cookies or DevTools storage;
    - `.env`, `.env.local` or Railway variables;
    - any `nba_yahoo_tokens` row or `token_blob`;
    - screenshots of the Yahoo consent page's URL.

**What we look for in the paste:**
- **High Score detection.** If your real High Score league says UNLIKELY or POSSIBLE, look at its `scoring_type` and the `other settings` line, which reveals Yahoo's real flag. We then update `highScoreCheck` in `nba/yahoo/diagnose.js`, and the UI if needed.
- **Draft order.** `open slots > 0` with `team_key on every pick=true` before or during the draft means the board's Yahoo clock is live. `open slots = 0` before the draft means Yahoo doesn't publish future slots yet, so the board uses the snake until it does.
- **Auction.** `auction=true` or `cost=true` means the board will show the manual-mode banner.
- **Parse warnings.** Any warning names the exact field Yahoo shaped differently from our fixtures. We add a fixture for it in `scripts/fixtures/nba/quirks/`.

**CLI alternative (operator, no browser):** use this only with read access to the prod DB. That access is a read-only action, but the `DATABASE_URL` itself must never be pasted.
`node --env-file=.env.local scripts/yahoo-diagnose.js --list`, then `… --user <clerk_user_id>` prints the same report. A refreshed access token is saved back to that user's row.

## Known gaps
- **Still never run against a real Yahoo account.** Everything above is fixture-based. The runbook exists to close this.
- **High Score markers are unknown.** The `scoring_type` value and any explicit flag are unverified, so the heuristic may need retuning after the first diagnose.
- **Future draft slots are unverified.** Whether Yahoo lists future slots in `draftresults` before or during the draft is unknown; the board falls back to the snake.
- **The pick timer is local.** Yahoo's API exposes `draft_pick_time` but not the per-pick deadline, so the countdown starts when a pick change is observed. That lags by up to the 4s poll plus the 3s server cache.
- **Auction drafts:** banner and manual mode only. There is no nomination or bid model.
- **Per-instance memory:** rate limits, the diagnose cooldown and the player-name cache. That is fine for one Railway instance and harmless with several. Nonces are the part that had to be shared, and they now are.
- **Size limit is header-based.** It relies on `Content-Length`; chunked bodies aren't counted. The NBA router has no body parsers, so nothing reads a body anyway.
- **Chip placement.** The chip is on the draft page only. D owns `lineup.html` and should add the script tag.
- **Visual check.** The draft page was checked in a real browser (Chromium via the UI mock): manual first-run card, live mode with the timer, the chip menu, a simulated auction league, and a simulated traded pick (back-to-back "YOU"), with no console errors. It was not checked on a physical phone.
