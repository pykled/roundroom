# Pocket NBA — stream A handoff (foundation + Yahoo)

Branch `nba-a-foundation`. Contract: docs/nba-contracts.md.

## What exists
- `nba/router.js`: factory mounted once from `server.js` (`app.use('/', require('./nba/router')({ auth, getAuth, db, apiCached }))`, placed just before the static deny block).
  - `/nfl` rewrites `req.url` to `/` and falls through to the existing `/` handler, so it is byte-identical to `/` (query param → index.html included). No redirect.
  - `/nba`, `/nba/draft` → `nba/pages/draft.html`; `/nba/lineup` → `nba/pages/lineup.html`. `PUBLISHABLE_KEY_PLACEHOLDER` is replaced like the NFL pages. If the file is missing you get a "coming soon" page (200).
  - Deny: `/nba/yahoo*`, `/nba/model*`, `/nba/<file>` (e.g. router.js), and any other file under `/nba/` outside `/nba/pages/` → 404.
  - `/nba/auth/login|callback|logout` and every `/api/nba/*` endpoint in the contract. `/api/nba/me*` and `/api/nba/yahoo/*` sit behind Clerk `auth`.
  - Draft: 3s per-user cache. Yahoo `draft` status maps to `drafting`. Player names come from `players;player_keys=` and are cached in memory. Matching uses B's `require('./model').matchYahooPlayer`, loaded lazily. If `nba/model` is missing, a stub takes over: players returns 503 and every sleeperId is null.
  - Error codes: Yahoo not connected → 409 `yahoo_not_connected`. Refresh token revoked → tokens deleted, 409 `yahoo_reauth` (status endpoint returns `{connected:false, reauth:true}`). Yahoo throttled → 429. Anything else → 502.
- `nba/yahoo/oauth.js`: authorize URL (scope `fspt-r`), code exchange and refresh against `api.login.yahoo.com/oauth2/get_token` with Basic auth. Error messages never echo the response body.
- `nba/yahoo/crypto.js`: HMAC-signed state `{clerkUserId, nonce, ts}` with a 10-minute TTL, plus an in-memory single-use nonce registry. AES-256-GCM token encryption with an HKDF key from `NBA_TOKEN_KEY` (falls back to `YAHOO_CLIENT_SECRET`).
- `nba/yahoo/store.js` + `db/migrate.js`: new table `nba_yahoo_tokens(clerk_user_id PK, yahoo_guid, token_blob, updated_at)`, which holds ciphertext only. With no DB it falls back to memory (local dev).
- `nba/yahoo/client.js`: `createClient({getTokens, saveTokens})` provides getGameKey, getUserLeagues, getLeague (settings, roster_positions, stat_categories, stat_modifiers, weeks from `game/{key}/game_weeks`), getDraftResults, getTeams, getRoster, getPlayers, getPlayersByKeys. Uses `?format=json`. A shared spacing queue (200ms) handles rate limits, with backoff on 429/999/5xx (honours Retry-After). Expired tokens are refreshed before the call; a 401 triggers one refresh and a retry; concurrent refreshes share one request.
- `nba/yahoo/parse.js`: flattens Yahoo's numeric-keyed/`count` collections and array-of-fragments resources.
- `shared/nav.js`: injects an NFL | NBA switch after the logo on every page with `#rr-nav`. `window.PocketNav.sportSwitchHtml()` is available for C. It skips injection if the page already has `.rr-sport`.
- `server.js`: the one hook, plus `/nba` added to `SITEMAP_PAGES`.

## How to run
- `node scripts/test-nba-yahoo.js`: 35 checks with no network, using fixtures in `scripts/fixtures/nba/`. It includes a spawned real `server.js` (needs Clerk keys from env or `.env.local`; skipped otherwise).
- Local: `PORT=7991 node --env-file=.env.local server.js`, then `/nba`, `/nfl`, `/api/nba/health`.

## Known gaps
- Never run against a real Yahoo account. Fixtures follow the documented and library-observed JSON shape. High Score `scoring_type` (fixture uses `headpoint`) and stat-modifier details are unverified.
- Yahoo needs HTTPS redirect URIs registered on the app. Local `http://localhost` callbacks only work if registered. Prod is `https://pocketff.com/nba/auth/callback` (override with `NBA_PUBLIC_ORIGIN`). Host headers other than localhost fall back to the prod origin.
- Nonces and the player-meta cache live in memory, so a restart cancels in-flight logins and the app assumes a single instance.
- The nav switch has not been checked visually in a browser.
- `test-nba-yahoo.js` is not in `npm test` yet; the lead adds it at integration, per the contract.
- Logout also accepts GET (contract lists the path), which makes it CSRF-able. Harmless (it only disconnects), but C should prefer POST.
