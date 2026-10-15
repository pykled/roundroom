# Pocket NBA (High Score) — build contracts

> **2026-10-15: the NBA side is Sleeper-first.** Yahoo blocked the app's Fantasy API, so league sync now comes from Sleeper's public API by username (`docs/nba-sleeper.md`: endpoints, shapes, season param, reversal round, id matching, how to re-enable Yahoo). The Yahoo contracts below are kept for history; the OAuth/`/api/nba/yahoo/*` routes only mount with `NBA_YAHOO_ENABLED=1`.

Branch `nba` (integration, off `main`). Streams build on `nba-a-foundation`, `nba-b-model`, `nba-c-ui` and merge into `nba` after a Checker passes. NEVER push; NEVER touch NFL behaviour. `/` stays the NFL home. Read docs/nba-data-spike.md for data facts.

## Game rules (Yahoo High Score)
10-man roster, 6 starters: G, G, F, F, F, UTIL (+bench). Head-to-head weekly; each starter's single BEST game of the week counts. Per-game score = pts + reb + 2*ast + 3*stl + 3*blk. Benching mid-week forfeits earlier games. Weeks are Mon-Sun, dates come from Yahoo league settings (week_start/week_end) once connected; before that use Sleeper `week`.

## File ownership (no overlap — do not edit another stream's files)
- A (foundation): `nba/router.js`, `nba/yahoo/*`, `db/migrate.js` (add tables only), `server.js` (ONE small hook, see below), `shared/nav.js` + nav markup helper for the NFL/NBA switch, `scripts/test-nba-yahoo.js`.
- B (model): `nba/model/*`, `data/nba/` (cache dir, gitignore big caches), `scripts/test-nba-model.js`, `scripts/nba-ingest.js`, `docs/nba-model.md`.
- C (ui): `nba/pages/*.html`, `nba/pages/*.js`, `nba/pages/*.css` (may import `/shared/styles.css`), `scripts/test-nba-ui.js`.

## Routing (A owns)
`server.js` gets exactly one hook placed before the static-serving deny block and before the `*` catch-all: `app.use('/', require('./nba/router')({ auth, getAuth, db, apiCached }))`. Router serves: `/nba` and `/nba/draft` -> `nba/pages/draft.html`, `/nba/lineup` -> `nba/pages/lineup.html`, `/nba/auth/login`, `/nba/auth/callback`, `/nba/auth/logout`, `/api/nba/*`. If a page file does not exist yet, serve a plain "coming soon" page (never 500). `/nfl` serves exactly what `/` serves for the NFL home (same handler behaviour incl. query-param -> index.html rule; NO redirect). Nav gets an NFL | NBA switch on every NFL page and NBA page. Add `/nba` to the sitemap list. Deny-list: nothing under `nba/` except `nba/pages/*` assets may be served statically (ensure `/nba/yahoo/*`, `/nba/model/*`, `/nba/router.js` 404).

## Env (already in .env.local, gitignored): YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET. Redirect URI: `${origin}/nba/auth/callback` (prod https://pocketff.com/nba/auth/callback). Scope `fspt-r`. Never log secrets/tokens. Never commit .env*.

## API contracts (JSON)
### B exports `nba/model/index.js`
`getPlayers({ season, week }) -> Promise<{ season, week, asOf, players: Player[] }>`
Player = `{ id /*sleeper*/, name, team, pos: string[] /*PG,SG,SF,PF,C*/, elig: ('G'|'F'|'UTIL')[], injury: string|null, mean /*mean HS score per game*/, sd, games: number /*games this week*/, gamesByWeek: {[week]: number}, hsValue /*expected max of games this week; for pre-draft use typical week = season-avg expected max for avg games-per-week*/, hsByWeek: {[week]: number}, ceiling /*p90 single game*/, floor, rank, tier, posRank, sampleGames, source: 'logs'|'projection-only'|'rookie' }`
`normalizeName(s)`, `matchYahooPlayer(yahooPlayer, players) -> {player, confidence, reason}|null` where yahooPlayer = `{ player_key, player_id, name:{full}, editorial_team_abbr, display_position, eligible_positions }`.
`expectedMax(samples|{mean,sd}, n) -> number`.
### A exports `nba/yahoo/client.js`
`createClient({ getTokens, saveTokens })` with: `getGameKey('nba')`, `getUserLeagues(gameKey)`, `getLeague(leagueKey)` (settings: name, num_teams, roster_positions, scoring_type, stat_modifiers, start/end week, weeks[{week,start,end}], draft_status), `getDraftResults(leagueKey)`, `getTeams(leagueKey)`, `getRoster(teamKey, week?)`, `getPlayers(leagueKey, {start,count,status})`. All return normalized plain objects (parse Yahoo JSON; use `?format=json`). Token refresh automatic; Yahoo rate limits respected (queue, backoff).
### HTTP (A serves; auth = existing Clerk `auth` middleware for /api/nba/me* and /api/nba/yahoo/*)
- `GET /api/nba/players?week=` -> B.getPlayers (public, cached 10 min)
- `GET /api/nba/yahoo/status` -> `{ connected, yahooGuid?, leagues?: [{league_key,name,num_teams,draft_status}] }`
- `GET /nba/auth/login` -> redirect to Yahoo; `/nba/auth/callback?code&state` (state = signed, single-use, tied to Clerk user); tokens stored server-side only, encrypted at rest with key derived from `NBA_TOKEN_KEY` env (fallback: derive from YAHOO_CLIENT_SECRET) — never sent to browser.
- `GET /api/nba/yahoo/league?league_key=` -> `{ league, teams, myTeamKey }`
- `GET /api/nba/yahoo/draft?league_key=` -> `{ status:'predraft'|'drafting'|'postdraft', picks:[{pick,round,team_key,player_key,sleeperId|null,name,matchConfidence}], unmatched:[...] , polledAt }` (server caches 3s, uses B.matchYahooPlayer; polling interval for clients = 4s)
- `GET /api/nba/yahoo/roster?team_key=&week=` -> `{ players:[{player_key,sleeperId|null,name,selected_position}] }`
- `GET /api/nba/health` -> `{ ok, yahooConfigured, modelAsOf }`
### C consumes only the above + manual mode (works fully with no Yahoo connection: league settings form with defaults 10 teams/6 starters, tap players to mark drafted, "my pick" toggle, localStorage persistence).

## Quality bar
node >=18, no new deps unless essential (A may add none; XML fallback only if JSON insufficient). Tests run with plain `node scripts/test-nba-*.js` (no framework) and must exit 0; add them to package.json `test` script ONLY in the integration merge (the lead does that). Mock Yahoo with recorded-shape fixtures in `scripts/fixtures/nba/` (A owns). Commit on your own branch with clear messages (end with the Co-Authored-By line given by the harness). Do not run `git push`, do not deploy, do not touch Railway.

## Phase 2 addendum (streams D lineup, E trade, F waivers, G hardening) — base = `nba` @ 01b3f9e
Each stream adds its own files and exactly ONE mount line in `nba/router.js` (e.g. `router.use(require('./routes/lineup')(deps))`) — keep the diff there to that line to make merges trivial. Own: D `nba/model/lineup.js`, `nba/routes/lineup.js`, `nba/pages/lineup.*` (replaces placeholder), `scripts/test-nba-lineup.js`; E `nba/model/trade.js`, `nba/routes/trade.js`, `nba/pages/trade.*`, `scripts/test-nba-trade.js`; F `nba/model/waivers.js`, `nba/routes/waivers.js`, `nba/pages/waivers.*`, `scripts/test-nba-waivers.js`; G fixes in `nba/router.js`, `nba/yahoo/*`, `nba/pages/draft.*` (G is the only stream allowed to edit A's and C's files). Shared helpers you need from another stream's module: import, don't copy; if a function is missing, write a thin local adapter and note it in your handoff.

## Phase 3 addendum — league profile (draft is Wed 2026-10-14 11:00pm ET = 8:00pm PT; ship-critical)
Dillon's real league is Yahoo ID 242808 "HALIMSANITY 26-27", read from its Settings pages 2026-10-13 (and confirmed intentional by Dillon): High Score aggregation (each starter's single best game of the matchup week counts) BUT custom scoring and roster — NOT the High Score defaults.
- Teams 12. Live Standard Draft (snake), 90s per pick, draft order randomized ~30 min before.
- Scoring per stat: PTS 1, REB 1.2, AST 1.5, STL 3, BLK 3, TO -1, PF -1, TECH -1, DD +5, TD +3 (DD/TD semantics: verify whether a triple-double game also earns the DD bonus; make it a flag, default = Yahoo behaviour you can source, document the source).
- Roster: PG 1, SG 1, G 1, SF 1, PF 1, F 1, C 1, UTIL 2, BN 5, IL 2 (FC 0) => 9 starters, 14 active spots + 2 IL, 16 total. 12 teams => 192 picks incl IL.
- Slot eligibility (Yahoo legend): PG<-PG; SG<-SG,G(guard),G/F; G<-PG,SG,G,G/F; SF<-SF,F,G/F; PF<-PF,F,F/C; F<-SF,PF,F,G/F,F/C; C<-C,F/C; UTIL<-anyone. Yahoo positions per player come from Yahoo (display_position/eligible_positions); until Yahoo is connected derive from Sleeper positions with a documented mapping and flag low confidence.
- Matchup weeks: 1 = Oct 20-25 (6 days); 2-6, 8-16, 18-22 = 7 days; weeks 7 (Nov 30-Dec 13) and 17 (Feb 15-28) = 14 days; regular season weeks 1-19, playoffs (6 teams) weeks 20-22. Max 10 adds/week, trades allowed to Mar 4 2027.
- One source of truth: `nba/league-profile.js` exports `getProfile(leagueId='242808')` returning `{ leagueId, name, teams, draft:{type:'snake',pickSeconds:90}, scoring:{pts,reb,ast,stl,blk,to,pf,tech,dd,td}, flags:{tdAlsoCountsDD}, slots:{PG,SG,G,SF,PF,F,C,UTIL,BN,IL}, starters:9, rosterSize:16, weeks:[{week,start,end,days}], maxAddsPerWeek:10, tradeEnd:'2027-03-04' }`; `defaultProfile()` = the 242808 profile; also `highScoreDefaultProfile()` (1/1/2/3/3, 6 starters G,G,FC,FC,FC,UTIL, 10 players) for other leagues. Later Yahoo sync overrides fields from /api/nba/yahoo/league.
- HTTP: `GET /api/nba/league-profile?league_id=` -> profile. `GET /api/nba/players?profile=<leagueId>` values players under that profile (default 242808).
Streams: H1 `nba/league-profile.js`, `nba/model/*` (scoring-profile-aware per-game score, hsValue, ranks, tiers, VORP by slot), `nba/routes/profile.js` (+ one mount line in nba/router.js), `scripts/test-nba-profile.js`, docs/nba-model.md update. H2 `nba/pages/draft.*` (board for 12 teams / 9 starters / 16 spots with slot-aware recommendations, positional eligibility per above, 90s clock, snake order), `scripts/test-nba-ui.js` additions. H2 consumes only the HTTP contract above plus a local mock; do NOT edit model or router files. Branches nba-h1-profile, nba-h2-board off `nba`.
