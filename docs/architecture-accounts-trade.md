# RoundRoom — Accounts + Sleeper Sync + Trade Calculator

Architecture for the in-season expansion. Written 2026-09-06 as the last planning step before coding.
Scope: two systems (account/Sleeper sync, trade calculator) sized for 1,000+ concurrent users on one Railway instance.

Existing constraints honored: `index.html` (draft assistant) is untouched; new tools are separate static pages
sharing isomorphic modules under `shared/`; Railway auto-deploys `main`.

---

## 0. The four decisions everything else follows from

1. **Sleeper is the source of truth; Postgres stores only the link.** We persist the Clerk user → Sleeper user
   mapping and which leagues they picked. Rosters, settings, projections, market values are never written to the DB.
2. **All Sleeper traffic goes through one gated in-process cache** (`shared/sleeper.js`). Per-key TTL, in-flight
   de-duplication, LRU cap, global token bucket, serve-stale-on-error. Nothing in a route handler calls Sleeper directly.
3. **Trade values are a pure function of `(projections version, league fingerprint)`.** A fingerprint is a hash of
   the scoring settings + roster slots + team count. Thousands of leagues collapse into a few dozen fingerprints,
   so value tables are computed once per fingerprint per projection refresh and shared by every user in every
   league with that config. Manual mode (no account) is just a preset that produces a fingerprint.
4. **The trade engine is one dependency-free JS module that runs in both Node and the browser.** The browser runs
   it for instant verdicts as the user toggles players; the server runs the same code to persist and share a trade.
   No drift between what the user sees and what a share link shows.

Load budget that these decisions buy (Sleeper's published guideline is "stay under 1,000 calls/min or risk IP block"):

| Traffic source | Worst case at 1,000 concurrent users | Sleeper calls/min |
|---|---|---|
| Rosters, 5-min TTL, ~700 distinct leagues | every league re-fetched every 5 min | ~140 |
| League settings + users, 6-h TTL | negligible | <5 |
| Manual "Refresh rosters" (60-s floor per league) | every active league once/min | bounded by active leagues, realistically <100 |
| Projections (global, hourly, ~18 weekly calls) | — | <1 |
| Username lookups / league lists (new links) | — | <10 |
| **Total** | | **~250, budget 1,000** |

---

## 1. Database schema (Postgres, Railway managed)

Driver: `pg` with a 30-line migration runner (`db/index.js` applies `db/migrations/*.sql` in order, tracked in
`schema_migrations`). No ORM. Three tables.

```sql
-- 001_init.sql
CREATE TABLE users (
  id               TEXT PRIMARY KEY,            -- Clerk user id (user_2abc...)
  sleeper_user_id  TEXT,                        -- null until linked
  sleeper_username TEXT,
  sleeper_avatar   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_leagues (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  league_id   TEXT NOT NULL,                    -- Sleeper league id
  season      INT  NOT NULL,
  roster_id   INT  NOT NULL,                    -- this user's roster in the league (from /rosters owner_id match)
  league_name TEXT NOT NULL,                    -- denormalized so /api/me never calls Sleeper
  num_teams   INT  NOT NULL,
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, league_id)
);
CREATE UNIQUE INDEX user_leagues_one_primary ON user_leagues(user_id) WHERE is_primary;

CREATE TABLE trades (                           -- saved / shareable trade evaluations
  id          TEXT PRIMARY KEY,                 -- 10-char base62 nanoid
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,   -- null for anonymous manual-mode shares
  league_id   TEXT,
  fingerprint TEXT NOT NULL,                    -- so a re-open can recompute with fresh values
  input       JSONB NOT NULL,                   -- { preset|league, sideA:{roster_id?,players[]}, sideB:{...} }
  result      JSONB NOT NULL,                   -- snapshot of engine output at save time
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trades_user_idx ON trades(user_id, created_at DESC);
```

Why not store more:
- **Rosters / starters** change mid-week and Sleeper returns them in one ~10 KB call. Cache, don't persist.
- **Scoring settings / roster_positions** could be stored, but the fingerprint is derived from them and we need them
  live anyway to compute lineups. 6-h cache is enough.
- **Projections / FantasyCalc values** are global datasets that refresh on their own schedule. Memory cache + disk fallback.
- **Clerk profile fields** (email, name) live in Clerk. We store nothing PII beyond the Clerk id.

Why not skip the DB and use Clerk metadata: reading metadata on every request means a Clerk Backend API call per
request (rate-limited, ~100 ms), and share links need a table anyway. A 3-table Postgres is cheaper in every way.

---

## 2. Sleeper caching strategy

One module, `shared/sleeper.js` (server-only), with this shape:

```js
// cached(key, ttlMs, fetcher, { staleOk = true }) → Promise<value>
//  - hit & fresh      → return
//  - hit & stale      → return stale immediately, refresh in background (SWR) for "global" keys;
//                       for "league" keys, await the refresh (hard TTL) so rosters are ≤ TTL old
//  - miss             → dedupe on key (in-flight Map), fetch through the gate, store
//  - fetch error      → return stale if any, else throw → route returns 503 with Retry-After
// gate: token bucket 600 req/min + max 16 concurrent; on HTTP 429 → pause gate 30 s, serve stale
// store: Map with LRU eviction, cap 10,000 entries (~100 MB worst case)
```

| Key | Source | TTL | Policy | Size |
|---|---|---|---|---|
| `nfl:state` | `/v1/state/nfl` | 1 h | SWR | tiny |
| `players:dict` | `/v1/players/nfl` (already cached) | 24 h | SWR | 5 MB raw, kept in memory once |
| `players:slim` | derived from dict: `{id:[name,pos,team,injury_status]}` for QB/RB/WR/TE/K/DEF, active only | derived, same TTL | — | ~250 KB, gzip ~70 KB |
| `proj:ros:{season}:{week}` | Σ weekly `api.sleeper.com/projections/nfl/{season}/{w}` for w ≥ current week (and season-total for ADP fields) | 1 h | SWR + disk fallback `data/projections_ros.json` | ~1 MB in memory, never sent to client |
| `fc:{dynasty}:{qbs}:{teams}:{ppr}` | FantasyCalc `values/current` | 6 h | SWR + disk fallback `data/fantasycalc/*.json` | 199 rows, 30 KB |
| `values:{projVersion}:{fingerprint}` | computed (see §5 engine) | invalidated by projVersion | — | ~1,200 rows, 60 KB, gzip ~18 KB |
| `user:byname:{username}` | `/v1/user/{username}` | 24 h | SWR | tiny |
| `user:leagues:{uid}:{season}` | `/v1/user/{uid}/leagues/nfl/{season}` | 1 h | SWR; busted by "sync leagues" | small |
| `league:{id}` | `/v1/league/{id}` | 6 h | SWR; busted by refresh | 5 KB |
| `league:{id}:users` | `/v1/league/{id}/users` | 6 h | SWR; busted by refresh | 5 KB |
| `league:{id}:rosters` | `/v1/league/{id}/rosters` | **5 min** | **hard TTL**, stale on error only | 10 KB |

Notes:
- `projVersion` = ISO timestamp of the last successful projection refresh. It's part of the value-table key and of
  every ETag, so clients naturally re-fetch after each hourly refresh and never before.
- The projection refresh runs on a `setInterval` from boot (and once at boot, before `listen`). It is the only
  proactive background job. It also warms `players:dict` and `nfl:state`.
- Fingerprint collapse is what makes the value cache cheap: most Sleeper leagues use default scoring, so even
  700 leagues typically produce 20–50 fingerprints.
- Redis is deliberately not used. See §7 for when it becomes necessary.

---

## 3. Roster freshness: 5-minute hard TTL + rate-limited manual refresh

Chosen: **short hard TTL (5 min) on `league:{id}:rosters` + a "Refresh rosters" button that busts the key,
floored at one bust per league per 60 s, auth required.**

Rejected:
- **Background polling per league.** 1,000 leagues × poll interval costs Sleeper calls whether or not anyone is
  looking. Pull-on-demand with a TTL only spends calls on leagues that have a user on the page.
- **Sleeper webhooks.** None exist publicly. The `wss://broadcast.sleeper.app` Phoenix channel we already use only
  carries draft topics; there is no documented league/roster topic. Not worth reverse-engineering for a 5-min SLA.
- **SWR on rosters.** Would return up to 10-min-old data on a page load. Trades are time-sensitive; a 200 ms wait on
  cache expiry is the better trade-off. (SWR stays on for global datasets where staleness is harmless.)

Extras that make "within ~5 minutes" hold in practice:
- Every rosters response carries `fetched_at`; the UI shows "Rosters as of 2:41 PM · Refresh".
- On `POST /api/league/:id/refresh` the server also busts `league:{id}` and `league:{id}:users` (cheap, covers
  scoring-setting edits and commissioner swaps).
- On Sleeper error the stale copy is served with `stale: true` and the UI shows a yellow "showing cached rosters" pill.

---

## 4. Server endpoints

Auth: `@clerk/express` — `app.use(clerkMiddleware())` before all routes; `requireAuth()` on `/api/me/*`,
`/api/trades` (POST), `/api/league/:id/refresh`; `getAuth(req).userId` for identity. Same-origin cookie session,
so the browser sends nothing special. Route files under `routes/`, mounted in `server.js`.

Response conventions:
- Public, shared datasets: `Cache-Control: public, max-age=N, stale-while-revalidate=M` + `ETag` (`projVersion` +
  key). Railway has no CDN in front, so these mainly save browser round-trips on tab switches and back-nav; the
  server cache is what protects Sleeper.
- Anything behind `requireAuth`: `Cache-Control: private, no-store`.
- Errors: `{ error: "message", code: "SLEEPER_UNAVAILABLE" | "NOT_FOUND" | ... }`, 503 with `Retry-After: 30` when
  the Sleeper gate is paused.
- Per-IP rate limit on all `/api/*` via `express-rate-limit`: 120 req/min public, 300 req/min authenticated.
  (`trust proxy` is already set.)

### Public — config & global datasets

| Method | Path | Returns | Cache-Control |
|---|---|---|---|
| GET | `/api/config` | `{ clerkPublishableKey, season, week }` | `public, max-age=300` |
| GET | `/api/nfl/state` | `{ season, week, season_type, projVersion }` | `public, max-age=300` |
| GET | `/api/players/slim` | `{ version, players: { "4034": ["Christian McCaffrey","RB","SF",null], ... } }` | `public, max-age=3600` + ETag |
| GET | `/api/values?scoring=ppr\|half\|std&qb=1\|2&teams=10\|12\|14&te=0\|0.5\|1&flex=1\|2` | value table (shape below) for a **preset** fingerprint | `public, max-age=300, stale-while-revalidate=3600` + ETag |
| GET | `/api/league/:id/values` | same shape, fingerprint derived from the league's live settings | same |

Value table shape (sorted by `value` desc, all positions the fingerprint has slots for):
```json
{
  "projVersion": "2026-09-06T14:00:00Z",
  "fingerprint": "f3a9c1…",
  "week": 1,
  "config": { "num_teams": 12, "qbs": 1, "ppr": 1, "te_premium": 0, "slots": {"QB":1,"RB":2,"WR":2,"TE":1,"FLEX":1,"K":1,"DEF":1,"BN":6} },
  "baselines": { "QB": 14, "RB": 36, "WR": 48, "TE": 12 },
  "waiver_value": 610,
  "players": [
    { "id": "4034", "pos": "RB", "proj": 287.4, "vorp": 152.1, "pv": 9450, "mv": 9880, "value": 9579, "pos_rank": 1 }
  ]
}
```
`pv` = projection value, `mv` = market value (FantasyCalc, imputed when missing), `value` = 0.7·pv + 0.3·mv.

### Public — league data (Sleeper data is public; no auth needed, rate-limited)

| Method | Path | Returns | Cache-Control |
|---|---|---|---|
| GET | `/api/league/:id` | `{ league_id, name, season, num_teams, scoring_settings, roster_positions, fingerprint, users:[{user_id, display_name, avatar, roster_id, team_name}] }` | `public, max-age=300` |
| GET | `/api/league/:id/rosters` | `{ fetched_at, stale, rosters:[{roster_id, owner_id, players:[ids], starters:[ids], wins, losses}] }` | `public, max-age=60` |
| GET | `/api/trades/:id` | saved trade `{ id, input, result, fingerprint, created_at, league?:{name} }` | `public, max-age=3600` |

### Authenticated

| Method | Path | Body → Returns |
|---|---|---|
| GET | `/api/me` | → `{ id, sleeper: {user_id, username, avatar} \| null, leagues:[{league_id, season, roster_id, league_name, num_teams, is_primary}] }` (one DB query, zero Sleeper calls) |
| POST | `/api/me/sleeper` | `{ username }` → resolves user via cache, fetches leagues for current season, upserts `users`, inserts `user_leagues` for every league (first one `is_primary`, `roster_id` from a rosters call per league — capped at 12 leagues) → same shape as `/api/me` |
| DELETE | `/api/me/sleeper` | unlinks; deletes `user_leagues` |
| PUT | `/api/me/leagues` | `{ league_ids:[...], primary_league_id }` → filters/sets primary → `/api/me` shape |
| POST | `/api/me/leagues/sync` | re-pulls league list (busts `user:leagues:*`), adds new leagues, keeps selections; 1/min per user |
| POST | `/api/league/:id/refresh` | busts rosters/league/users for that league (60-s floor per league, 429 otherwise) → fresh `/rosters` payload |
| POST | `/api/trades` | `{ league_id? , preset?, sideA, sideB }` (≤ 15 players per side) → server runs the engine, stores, returns `{ id, url:"/trade?t=…", result }`. Anonymous allowed for manual mode (rate-limited 10/min per IP). |
| POST | `/api/webhooks/clerk` | Svix-verified `user.deleted` → `DELETE FROM users WHERE id=$1`. Raw body parser on this route only. |

### Static

- `GET /trade` → `trade.html`; `GET /account` → `account.html` (or an account modal inside trade.html — decided
  below). Register these **before** the `app.get('*')` index fallback.
- **Static-root deny list (do this in the same PR):** `express.static(__dirname)` currently serves everything,
  including `server.js`, `scripts/`, `node_modules/`, `package-lock.json`. Once `db/` and `routes/` exist that is
  server source exposed to the web. Add a middleware before static that 404s `/server.js`, `/routes/*`, `/db/*`,
  `/scripts/*`, `/node_modules/*`, `/.git*`, `/.env*`, `/package*.json`, `/*.csv`, `/*.txt`. (`shared/` must stay
  public — the browser loads the engine from there.)

### CSP additions (Clerk, per Clerk's CSP guide)

```
script-src  + https://clerk.pykled.com https://challenges.cloudflare.com https://*.protect.clerk.com
connect-src + https://clerk.pykled.com https://*.protect.clerk.com:*
img-src     + https://img.clerk.com
worker-src    'self' blob:
frame-src     'self' https://challenges.cloudflare.com https://*.protect.clerk.com
```
Dev instance uses `https://<slug>.clerk.accounts.dev` instead of `clerk.pykled.com`; drive it from an env var.
Also add `https://api.fantasycalc.com` nowhere — the browser never calls FantasyCalc or `api.sleeper.com`
projections; only the server does.

---

## 5. FantasyCalc dataset

**There is a free, unauthenticated JSON endpoint** (verified 2026-09-06):

```
GET https://api.fantasycalc.com/values/current?isDynasty=false&numQbs={1|2}&numTeams={10|12|14}&ppr={0|0.5|1}
```
199 rows, every row has `player.sleeperId`, `value` (0–~10k), `overallRank`, `positionRank`, `trend30Day`. Values are
solved from ~1M real trades and refresh several times a day. Only `isDynasty` and `numQbs` move values materially;
`ppr` shifts WRs ~2 %, `numTeams` < 2 %.

**Fetch & maintain:**
- Server fetches lazily per `(qbs, teams, ppr)` combo on first fingerprint that needs it, 6-h TTL, SWR. Max 18
  combos → ≤ 72 calls/day. Map fingerprint → FC params: `qbs = 2 if SUPER_FLEX slot else 1`; `ppr = nearest of
  {0, 0.5, 1}` to `scoring_settings.rec`; `teams = nearest of {10, 12, 14}`.
- **Disk fallback:** the existing `update-data.yml` GitHub Action gets a new step, `scripts/fetch-fantasycalc.js`,
  that writes the 18 combos to `data/fantasycalc/{qbs}-{teams}-{ppr}.json` twice daily. The server loads these at
  boot as the initial cache and falls back to them if the live call fails or the endpoint changes. Nothing user-
  facing breaks if FantasyCalc goes away; values just go stale until we fix the script.
- **Join:** on `player.sleeperId` → Sleeper `player_id`. Log unmatched ids at refresh so a schema change is visible.
- **Coverage gap:** FC only ranks the top ~199. For every other player the blend would silently drop to
  projection-only, creating a value cliff at rank 200. Instead, per fingerprint, fit `mv ≈ a + b·vorp` on the
  joined set (measured R² ≈ 0.95, slope ≈ 61/VORP point) and **impute** `mv` for unmatched players. Rows carry
  `mv_src: "fc" | "fit"` so the UI can show a small "market: est." marker.
- Rescale: `mv` is normalized so the top FC value = 10,000 for that combo, matching the `pv` scale.

---

## 6. Trade engine (`shared/trade-engine.js`, isomorphic)

Pure functions, no imports, ES module with a CommonJS shim. Runs in Node (values route, trades route, tests) and
in `trade.html`.

```
fingerprint(league)      → sha1 of { num_teams, slots (counted roster_positions minus BN/IR/TAXI), scoring (only
                            keys that exist in projection stat keys, rounded to 2dp, zeros dropped), te_premium }
score(stats, scoring)    → Σ scoring[k] · stats[k]      (weekly projections are summed to ROS first)
baselines(config)        → replacement rank per position:
                            QB  = teams·(QB + SUPER_FLEX)                  + 2
                            RB  = teams·(RB + 0.5·FLEX + 0.4·WRRB_FLEX)    + 0   (WRRB_FLEX = Sleeper "WRRB_FLEX")
                            WR  = teams·(WR + 0.4·FLEX + 0.6·WRRB_FLEX + 0.8·REC_FLEX)
                            TE  = teams·(TE + 0.1·FLEX + 0.2·REC_FLEX)     + 0
                            K/DEF = teams·slot (values ≈ 0, included only if the league has the slot)
                           → 12-team 1 FLEX reproduces QB14/RB36/WR48/TE12 already validated in scripts/vorp.js;
                             SUPER_FLEX gives QB26, matching the FC superflex QB premium.
vorp(p)                  → max(0, proj − proj_at_baseline_rank(pos))
projValue(vorp, maxVorp) → 10000 · (vorp / maxVorp)^1.25        (maxVorp = best player in this fingerprint)
marketValue(id)          → FC value rescaled, or imputed (see §5)
value                    → 0.7·pv + 0.3·mv
evaluate(input, table)   → {
    sideA: { players:[{id, value, …}], sum, credit },
    sideB: { … },
    credit rule: if |nA − nB| > 0, the side receiving FEWER players gets
        credit = (nA − nB) · waiver_value
        waiver_value = connected league → max(value) over players not on any roster in that league
                       manual mode     → value at overall rank (teams · total non-bench slots + teams · 3)
        (FantasyCalc uses a fixed ~750 for this; ours adapts to shallow vs deep leagues.)
    totalA = sumA + creditA, totalB = sumB + creditB
    delta_pct = (totalGet − totalGive) / max(totalGet, totalGive)     (from the user's perspective)
    verdict: |delta_pct| ≤ 0.10 → "Fair"; delta_pct > 0.10 → "Win"; < −0.10 → "Lose"
    confidence: "Slight" (10–20 %), "Clear" (20–35 %), "Lopsided" (> 35 %)
  }
```

Phase 2 (already decided, not in this build): when a league is connected, also compute optimal-lineup weekly
points before/after for both rosters and show "+3.2 pts/wk to your starters" as a secondary line. Same module.

---

## 7. Trade calculator UI flow (`trade.html`)

Static page, vanilla JS, same visual system as index.html (reuse its CSS variables by extracting them into
`shared/theme.css` — copy, don't edit index.html). Loads `shared/trade-engine.js` as a module.

**0. Boot (parallel):** `GET /api/config` → load ClerkJS from the FAPI domain with the publishable key →
`Clerk.load()`; `GET /api/players/slim` (ETag-cached); `GET /api/nfl/state`.

**1. Landing state — two paths, one page:**
- *Signed in, league linked:* header shows Clerk `UserButton` + league dropdown (from `/api/me`, primary selected).
  Fetch `/api/league/:id`, `/api/league/:id/rosters`, `/api/league/:id/values` in parallel. Left column = "You"
  (roster where `owner_id === sleeper_user_id`), right column = opponent dropdown listing the other teams by
  `team_name` / display name, defaulting to the first. Both columns render each roster grouped by position with the
  player's value chip.
- *Signed in, no Sleeper link:* inline card "Connect Sleeper — enter your username once" → `POST /api/me/sleeper`
  → league picker (checkbox list, radio for primary) → `PUT /api/me/leagues` → path above. No separate account page;
  the Clerk `UserButton` menu gets a custom "Sleeper leagues" item that reopens this card.
- *Signed out:* **Manual mode** is fully usable. Preset bar: Scoring [PPR|Half|Std], QBs [1|2], Teams [10|12|14],
  TE premium [0|+0.5|+1], Flex [1|2] → `GET /api/values?…`. A subtle "Sign in to load your leagues" button, not a wall.

**2. Build the trade:** clicking a player in either column moves it into the trade tray ("You give" / "You get").
In manual mode the columns are replaced by a typeahead search over `players/slim` (name, pos, team) for each side.
Deep links prefill: `/trade?league=…&opp=…&give=id,id&get=id,id` or `/trade?preset=ppr-1qb-12&give=…&get=…`.

**3. Live verdict panel (updates on every change, client-side engine, zero network):**
- Two stacked value bars scaled to the larger side, per-player rows (name · pos rank · proj pts · value ·
  "market est." marker when imputed).
- Roster-spot credit row appears only for uneven trades: "+610 waiver credit (1 open spot)".
- Verdict badge: **WIN / FAIR / LOSE** with delta % and confidence word. Tooltip explains the 10 % band.
- "Flip perspective" swaps sides; "Rosters as of 2:41 PM · Refresh" (connected only).

**4. Share:** `POST /api/trades` → copies `roundroom.pykled.com/trade?t=abc123` to clipboard. Opening a share link
loads the saved input + result, then silently recomputes with the current value table and shows "values updated
since this was shared" if the verdict changed.

**5. Errors:** Sleeper 503 → panel keeps last data with a yellow "cached" pill; value table unavailable → manual
entry still works with the disk-fallback projections; sign-in failure never blocks manual mode.

---

## 8. Infrastructure on Railway

| Component | Now (this build) | Why | When it changes |
|---|---|---|---|
| Web service (existing) | 1 replica, Node 20+, `node server.js`. Bump to 1 GB RAM. | Everything is cache hits; Node serves several thousand JSON req/s from memory. | Vertical first (2–4 GB) before any second replica. |
| Postgres (Railway managed plugin) | Add now. `pg.Pool` max 10. | Users, league picks, saved trades. Tiny: 1,000 users ≈ 1 MB. | Never for this workload. |
| Cache | In-process `Map` + LRU + token bucket (`shared/sleeper.js`) | Single replica → one cache → Sleeper sees ≤ 1 fetch per key per TTL. | **Redis becomes necessary the moment you run replica #2**: each replica would fetch independently (N× Sleeper load, inconsistent freshness), the SSE draft relay is per-process, and the refresh 60-s floor and rate limits would be per-replica. Realistic threshold: sustained >5,000 concurrent or CPU-bound engine work, neither expected this season. |
| Background jobs | `setInterval` in the web process (projections hourly, FC lazy, players 24 h) + existing GitHub Actions for disk fallbacks | No worker service needed; jobs are 1–20 HTTP calls. | A separate worker only if jobs ever exceed a few seconds of CPU. |
| Clerk | Production instance on `clerk.pykled.com` / `accounts.pykled.com` (CNAMEs via Namecheap) | Same-origin cookie sessions. | — |
| Env vars | `DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, `CLERK_FRONTEND_API` (for CSP/script src), existing `ANTHROPIC_API_KEY` | | |
| Health check | Keep `/`; add `/healthz` that returns `{ db:"ok", projVersion, sleeperGate:"open" }` for the Railway checker | | |

Deployment sequence (Railway auto-deploys `main`):
1. Provision Postgres, set env vars, set Clerk production DNS (remember `setHosts` on Namecheap **replaces all
   records** — pull current records first, see `memory/reference_pykled_dns.md`).
2. Deploy migrations runner + `shared/sleeper.js` + deny-list middleware with no new pages (safe no-op release).
3. Deploy values endpoints + `trade.html` in manual mode (no auth dependency; testable publicly).
4. Deploy Clerk + `/api/me` + connected mode.
5. Turn on the Clerk webhook last.

Concurrency proof points to check before step 3 ships: `autocannon -c 1000 -d 30 /api/values?scoring=ppr&qb=1&teams=12`
against a local build should show 0 Sleeper calls after warm-up and p99 < 50 ms; `GET /healthz` reports gate
usage so we can watch calls/min in Railway logs.

---

## 9. File layout added by this build

```
server.js                     mount clerkMiddleware, rate limiter, deny-list, routes/*, static pages
shared/
  sleeper.js                  gated cache + all Sleeper/FC fetchers (server-only, but lives here for locality)
  cache.js                    TTL/LRU/in-flight/token-bucket primitives
  trade-engine.js             fingerprint, baselines, VORP, blend, evaluate  (isomorphic)
  theme.css                   CSS variables lifted from index.html
routes/
  config.js  values.js  league.js  me.js  trades.js  webhooks.js
db/
  index.js                    pg pool + migration runner
  migrations/001_init.sql
scripts/fetch-fantasycalc.js  GH Action step → data/fantasycalc/*.json
data/fantasycalc/             18 fallback snapshots (committed)
trade.html
test/trade-engine.test.js     node:test — baselines table, SF QB premium, 3-for-2 credit, verdict band edges
```
