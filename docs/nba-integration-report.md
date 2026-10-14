# NBA page integration — 2026-10-14

Branch `nba` (worktree `~/projects/pocket-nba-wt/integration`), starting HEAD `68d384c`. Not pushed or deployed. master/main not touched.

## Merges (in order, all `--no-ff`)

| Branch | Tip | Merge commit | Conflicts |
|---|---|---|---|
| nba-u0-design | 7b6efdd | ddd9cee | none (it was not merged yet) |
| nba-p1-board | a398a94 | 560dff6 | none |
| nba-p2-research | da82f9c | cc9d2e6 | none |
| nba-p3-lineup | 67955ee | e6f9e85 | none |
| nba-p4-trade | 3e93c7b | ecb227a | none |
| nba-p5-waivers | f373390 | 5cbc8fd | none |

There were no textual conflicts. Every P branch merged the same U0 tip (7b6efdd) and the same nba-v2 research API (7583180). None of them edited `nba-ui.css`, `nba-ui.js`, `styleguide.html` or `docs/nba-design-system.md`, so those files match U0 byte for byte (`git diff nba-u0-design HEAD` on them is empty). Each branch's additions to the shared files merged in automatically: one route line each in `nba/router.js`, and the `package.json` test chain, which now includes `test-nba-ui-kit` and `test-nba-research-ui`. Every `scripts/test-nba-*.js` is part of `npm test`.

## Server fixes

1. **`GET /api/nba/yahoo/status` when signed out** now returns `200 {connected:false, signedIn:false}` with `Cache-Control: private, no-store`. Before, it returned a 401, which showed up as a console error on every NBA page load. The handler is a guard placed ahead of the `auth` gate (`nba/router.js`). All other `/api/nba/yahoo/*` routes still return 401 when signed out.
2. **Cache and versioning:**
   - Static `.css`/`.js` responses switch from `public, max-age=3600` to `no-cache`. The ETag still applies, so a repeat load costs a 304 and never shows stale content (`server.js`).
   - New `nba/asset-version.js` rewrites `/nba/pages/*.css|js` and `/shared/*.css|js` refs in NBA page HTML to `?v=<sha1-8>` of the file on disk. The hash is memoised per mtime and size. It is applied in `page()` (draft, lineup, research) and in the trade and waivers page routes, which also send `Cache-Control: no-cache`.
3. **CSP:** `img-src` now includes `https://a.espncdn.com`.

Tests: `scripts/test-nba-yahoo.js` changes in two places to match the new contract. The signed-out status check now expects 200. The real-server boot test now also asserts:
- `no-cache` and an ETag on the shared and kit assets
- `?v=` hashes on all five pages, with no unversioned page scripts
- the ESPN host in the CSP

## Verification (run by the integrator)

- `npm test`: exit 0
- `node scripts/test-nba-*.js`: all 18 exit 0 (adp, cheatsheet, copy, hardening, home, integration, lineup, market, model, profile, research-ui, research, sim, trade, ui-kit, ui, waivers, yahoo)
- Browser check: server started on port 7999 with `.env.local`, signed out. Headless Chromium (Playwright) loaded `/nba`, `/nba/research`, `/nba/lineup`, `/nba/trade` and `/nba/waivers` at 375 (mobile/touch) and 1280.
  - Result: 0 console errors, 0 page errors, 0 HTTP ≥400 responses, and no horizontal scroll (`scrollWidth == clientWidth`) on all 10 loads.
  - The screenshots were checked by eye.
