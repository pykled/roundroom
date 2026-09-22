# Waiver Targets — design (2026-09-22)

Status: design → handed to Maker. Adds a personalized "Waiver Targets" section to
`/trending` (trending.html): trending-up players who are free agents in the
signed-in user's Sleeper leagues.

## What already exists (verified in code)

| Piece | Where | Notes |
|---|---|---|
| Trending feed | `GET /api/trending` (server.js ~L1074) | `{week, lastCompleted, scoring, up[], down[], byId{}}`; each player has `market: { adds24h, addRank, drops24h }` already — addRank is 1-based rank in Sleeper's 24h add feed |
| Cached compute | `apiCached(key, ttl, fn)` (server.js L54) | trending result cached 15 min under `trending:${pos}:${scoring}:${week}` |
| Connected mode | Clerk sign-in → `GET /api/me` → `{sleeperUsername, sleeperUserId, primaryLeagueId}` | **There is no bare "enter username" flow anywhere.** Sleeper is linked once via `POST /api/me/sleeper {sleeperUsername}` and stored in Postgres `users` |
| User's leagues | `GET /api/me/leagues` (auth) → `[{league_id, name, roster_positions, scoring_settings, total_rosters}]` | uses `fetchSleeperLeagues(sleeperUserId)` |
| League rosters | `GET /api/league/:id` → `{...league, rosters[], users[]}` | cached 60s; `rosters[i].players` = array of player ids, `rosters[i].owner_id` = Sleeper user id |
| Gate UI | lineup.html `#auth-card` / `#sleeper-card` (`.setup-card.gate`, `.form-row`, `.btn-primary`, `.error-msg` in shared/styles.css) | three states: signed out → signed in w/o Sleeper → connected |
| trending.html | loads Clerk already (mounts user button / sign-in), fetches `/api/trending?n=25`, pos filter, 2-col up/down grid | no per-user code yet; `T = {data, activePos}` |

No waiver-related code or CSS exists anywhere.

## Decisions

1. **Connected mode = the existing Clerk + linked-Sleeper pattern, not a username input.**
   Consistent with Lineup/Team, no new unauthenticated Sleeper proxy surface, and the
   user id is already in the DB. Three states below the movers grid:
   - signed out → compact gate card: "Sign in to see which movers are free agents in your leagues" (`clerk.openSignIn({redirectUrl:'/trending'})`)
   - signed in, no Sleeper → same mini form as lineup.html (`POST /api/me/sleeper`), then load
   - connected → Waiver Targets section

2. **Server-side endpoint: `GET /api/me/waivers?scoring=half_ppr` (auth).**
   Why server, not client:
   - all inputs are already cached server-side (trending 15 min, league 60 s, leagues) — the server can compose them with zero extra Sleeper calls; the client would need 1 + N round trips
   - the user's `sleeper_user_id` lives in the DB; the client would have to re-fetch `/api/me/leagues` first
   - the cross-reference is reusable later (Discord/email "your waiver targets" digest, FAAB suggestions) and testable in isolation
   - server sees the full `up` list (25), not the client's sliced `n`
   Refactor: extract the trending compute from the `/api/trending` handler into
   `getTrendingResult(pos, scoring, week)` (same cache key) and the league fetch into
   `getLeagueData(id)` (same cache key) so both routes share caches.

3. **Cross-reference logic** (per user):
   - leagues = `fetchSleeperLeagues(uid)`; for each, `getLeagueData(id)` (fail-soft per league — skip and report in `leaguesFailed[]`)
   - per league: `rostered = Set(rosters.flatMap(r => r.players))`; `mine = roster where owner_id === uid || co_owners includes uid`
   - for each `p` in `trending.up` (direction up only): `faIn = leagues where !rostered.has(p.id)`; skip if `faIn` empty
   - `onMyTeamIn` = leagues where `mine.players.includes(p.id)` (informational; such leagues are never in `faIn`)
   - `highDemand = market.addRank != null && market.addRank <= 10`
   - sort: `faCount desc, trend desc`
   - cache 60 s under `waivers:${uid}:${scoring}`

   Response:
   ```json
   { "week": 3, "lastCompleted": 2, "scoring": "half_ppr",
     "leagues": [{"league_id":"…","name":"…"}], "leaguesFailed": [],
     "targets": [ { ...trendingPlayer, "faIn": ["lid"], "faCount": 2, "onMyTeamIn": [], "highDemand": true } ] }
   ```

4. **Badges**: `FA in 2/3 leagues` (title attr = league names) — when FA in all, still `FA in 3/3`.
   `🔥 High demand` when `highDemand` (addRank ≤ 10 → likely contested FAAB bid).
   Keep the existing `⚡ Leading` / `Strong` badges and `why[]` chips.

5. **UI placement: full-width section BELOW the movers grid.** Not a third column
   (2-col grid is already tight, breaks to 1-col at 640px) and not a tab (hides the
   core public content, hurts the SEO landing). Below keeps the public page unchanged
   for anonymous visitors and adds the personalized layer where connected users scroll.
   The position pill filter applies to the section too.

6. **Deploy safety**: branch `feat/waiver-targets`, PR to `main`, no merge by the Maker
   (main is Railway-connected; Checker + Dillon sign-off required).
