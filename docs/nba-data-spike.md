# NBA / Yahoo High Score data spike (2026-10-13)

Read-only research. Value metric = expected max of a player's single-game `pts + reb + 2*ast + 3*stl + 3*blk` over the games in a Yahoo week (Mon-Sun). Yahoo High Score: 10-man rosters, 6 starters (G,G,F,F,F,UTIL), each starter's single best game of the week counts; benching a player mid-week forfeits earlier games (help.yahoo.com/kb/SLN37162).

## 1. Sleeper NBA (best source — all hits were real, HTTP 200, no auth)
Both hosts work: `api.sleeper.app/v1/...` (legacy, keyed-by-player-id maps) and `api.sleeper.com/...` (richer arrays, **per-game rows**).

| Endpoint | Shape |
|---|---|
| `https://api.sleeper.app/v1/state/nba` | `{week:3, season_type:"pre", season:"2026", season_start_date:"2026-10-20", display_week:3}` (preseason now; wk1 begins 2026-10-20) |
| `https://api.sleeper.app/v1/players/nba` (2.5 MB, 2165 players, ~650 active w/ team) | `{player_id:{full_name, team, position, fantasy_positions, injury_status, status, ...}}` (Jokic = `1658`) |
| `https://api.sleeper.com/stats/nba/2025/{week}?season_type=regular` | **Array of per-game rows**: `{player_id, team, opponent, game_id, date, week, stats:{pts,reb,ast,stl,blk,sp(seconds),...,q1_pts..}}`. Wk1 2025 = 1545 rows over 6 dates. Weeks 1-25 return data (45,835 rows total), wk26 empty. ~1-2 MB each. |
| `https://api.sleeper.com/stats/nba/2025?season_type=regular` | season totals row (`game_id:"season"`, `gp`, ...) |
| `https://api.sleeper.app/v1/stats/nba/regular/2025/1` | legacy: **weekly totals only**, keyed by player_id (no per-game) |
| `https://api.sleeper.com/projections/nba/2026/1?season_type=regular` | **Per-game projections** (964 rows for 2026 wk1): `{player_id, team, opponent, date, game_id, company:"rotowire", stats:{pts,reb,ast,stl,blk,sp,gp:1,...}}` — per-game per-stat MEANS (no variance). Doubles as the schedule: count rows per player per week. |
| `https://api.sleeper.com/projections/nba/2025?season_type=regular` | season projection per player |
| `https://api.sleeper.app/v1/projections/nba/regular/2025/1` | legacy weekly-aggregated projections keyed by player_id |

Notes: DNP-ish rows exist (521 rows in 2025 wk1 with `sp==0`) — filter `sp>0`. Stat keys may be missing instead of 0 (e.g. blk absent) — default 0. Sleeper weeks: wk1 2025 = Tue Oct 21 - Sun Oct 26 (Yahoo wk1 also opened Oct 21), later weeks Mon-Sun (wk2 = Oct 27-Nov 2), so Sleeper `week` ≈ Yahoo matchup week; verify against Yahoo `matchup_week` start/end dates when connected. Projection rows exist only for games already scheduled/projected (2026 wk1 has dates 10-20..10-25).

**Proof (Jokic, 2025 regular):** 82 per-game rows from weeks 1-25. Game 1 (2025-10-23 GSW): 21+13+2*10+3*1+3*1 = 60; game 2 (10-25 PHX): 14+14+30+9+0 = 67; mean 54.5/game; weekly max wk1..8 = 67, 73, 89, 85, 89, 65, 84, 70. (ESPN gamelog cross-check below gives a similar-order mean of 67.7 for the 66 games ESPN lists as regular season — different counts, see risks: Sleeper count of 82 looks high; needs dedupe / `sp>0` filter before use.)

## 2. Schedule
- ESPN works, no auth: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD` (one date; **range `dates=a-b` returned 400/garbled** in my test; 30 rapid calls all 200). 2026-10-20 returns BOS@DET, PHI@NY, OKC@SA...
- ESPN team schedule: `https://site.api.espn.com/apis/site/v2/sports/basketball/teams/lal/schedule?season=2027&seasontype=2` (season = ending year) -> 80 regular-season events listed so far for LAL 2026-27 (first 2026-10-22 GSW@LAL), 82 for 2025-26.
- cdn.nba.com schedule/boxscore JSON: **403 Access Denied** (Akamai) even with UA + Referer. stats.nba.com: connection fails (000). balldontlie: **401** (needs API key).
- Recommended: derive games-per-week from Sleeper projections rows (team, date) — already week-bucketed — and use ESPN scoreboard/team schedule as a cross-check. Map to Yahoo weeks by Mon-Sun date windows (Yahoo wk1 is a longer/shorter opener; take dates from Yahoo `scoreboard`/`matchup` week_start/week_end when connected).

## 3. Per-game log fallback
- ESPN gamelog works, no auth: `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{espnId}/gamelog?season=2026` (season = ending year; 2025-26 fetched now, 724 KB). Shape: `names:[minutes,...,totalRebounds,assists,blocks,steals,fouls,turnovers,points]`, `seasonTypes[].categories[].events[{eventId, stats:[strings]}]`, `events{eventId:{gameDate,opponent,atVs,...}}`. Jokic 2025-26: Regular 66 games mean 67.7; Postseason 6 games mean 63.5. Example event 401811002 = 96.
- ESPN player search for id: `https://site.web.api.espn.com/apis/common/v3/search?query=nikola%20jokic&type=player&sport=basketball&league=nba` (Jokic = 3112335). Needs Sleeper->ESPN id mapping (name+team match; Sleeper players have `espn_id` field on many records — verify).
- ESPN box scores: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={id}` 200.
- One request per player (~500 players) — no rate-limit hit in 30 rapid scoreboard calls; unofficial API, no SLA.

## 4. Yahoo Fantasy API (docs/search only; did not log in)
- OAuth 2.0 required. Authorize `https://api.login.yahoo.com/oauth2/request_auth`, token `https://api.login.yahoo.com/oauth2/get_token`. Base `https://fantasysports.yahooapis.com/fantasy/v2` (XML default; `?format=json` supported by wrappers). Confidential client, HTTPS redirect URI. App registration at developer.yahoo.com/apps/create with Fantasy Sports Read permission.
- Scope string used by libraries is `fspt-r` (read-only), not "fantasy-sports-r". Read-only is enough for league/roster/draftresults reads.
- Access: sports.yahoo.com/developer says developers must **apply for access** (org, product, use case), Yahoo reviews, and approves — so a NEW app may need approval/lead time (couldn't confirm current turnaround or whether self-serve key creation still works). Terms: attribution "Fantasy data provided by Yahoo Fantasy", throttling for excess use, no multiple accounts.
- Endpoints: `users;use_login=1/games;game_codes=nba/leagues`, `league/{game_key}.l.{id}/settings|standings|scoreboard|draftresults`, `players`, etc. nba game_code works; the 2026-27 numeric game_key must be discovered via `game/nba` (not hit). **Unverified:** whether High Score leagues expose a distinct `scoring_type` / stat modifiers in `league/settings`, and how weekly High Score is reported; needs a real league + token to test.
- Refresh tokens last long but can be invalidated by password change/revoke.

## 5. Recommendation + risks
- Per-game logs: **Sleeper `api.sleeper.com/stats/nba/{season}/{week}`** primary (single host Pocket already uses, 26 calls = full season, includes opponent/date, `sp` minutes). ESPN gamelog as fallback/cross-check (need id map). Skip cdn.nba.com (403), stats.nba.com (blocked), balldontlie (key).
- Model: per player, expected max of N games where N = games in Yahoo week (from Sleeper projection rows). Use player's per-game HS-score distribution from last season + recent games (empirical bootstrap / normal fit), shifted to the projection mean.
- Risks: (1) api.sleeper.com is undocumented and could change; (2) Sleeper 2025 Jokic count of 82 vs ESPN 66 reg-season games needs reconciling (dupe rows/DNP/other season types) before trusting; (3) projections are means only — variance must come from logs; rookies/new teams have no log; (4) Yahoo access approval is unconfirmed and High Score API fields untested; (5) week-boundary mapping (opener week, All-Star break, playoffs) is per-league; (6) ESPN date-range scoreboard fails, endpoints unofficial; (7) preseason now — week-1 projections already out but rosters/injuries will churn; (8) 1-2 MB per weekly pull, cache to disk.
