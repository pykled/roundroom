# NBA player research API (stream R0)

The data contract for the NBA research page (`/nba/research`, built by the page stream). It mirrors the NFL research page (`research.html`): search with autocomplete, position/sort/filter controls, a table with headshots, and a detail pane with scouting numbers, the stat history, news and injuries. Everything is valued under Dillon's league 242808 (HALIMSANITY 26-27: PTS 1, REB 1.2, AST 1.5, STL 3, BLK 3, TO −1, PF −1, TECH −1, DD +5, TD +3; High Score aggregation, where each starter's single best game of the matchup week counts).

Files: `nba/model/research.js` (engine), `nba/routes/research.js` (HTTP), one mount line in `nba/router.js`, tests in `scripts/test-nba-research.js`.

## NFL research features → NBA equivalents

| NFL research.html | NBA endpoint / field |
|---|---|
| Search box (`oninput` filter) | `/api/nba/research?q=` (table) and `/api/nba/search?q=` (autocomplete) |
| Position pills (QB/RB/WR/TE/K) | `pos=PG,SG,G,SF,PF,F,C` (Yahoo positions); `slot=` (Yahoo slot eligibility) |
| Sort ADP / VORP / Proj / Value / Vol | `sort=marketRank / vorp / mean / adpDelta / sd` (plus 37 more keys) |
| Filters: Value picks / Trending / Targets | `adpDelta` + `marketLabel`; `/api/nba/trending`; targets remain client-side (localStorage / `/api/me/lists`) |
| Headshot (Sleeper CDN by player id) | `headshot` (thumb) on rows; `images.headshot` (full) on detail; `teamLogo` fallback |
| Injury dot + timeline | `injuryTag`, `injury`, `injuryNotes`; detail `injury{}` |
| Hero grid: ADP, Pos rank, VORP, Proj | `marketRank`, `posRank`, `vorp`, `hsValue` / `mean` |
| Scouting report (generated text) | the inputs: `value`, `market`, `consistency`, `form`, `rates`, `nextWeek` (the page writes the sentences) |
| Career stats by season (`/api/player-stats`) | `lastSeason`, `gameLog`, `last10`, `histogram`, `weeklyBest`, `splits` |
| News (`/api/player-news`) | detail `news` (Sleeper/Rotowire feed) |
| Trending page | `/api/nba/trending` (Sleeper NBA trending adds/drops) |

## Conventions

- All endpoints are public GETs and return JSON. Each IP gets 240 requests per minute across these five endpoints (`429` + `Retry-After` past that; `NBA_RESEARCH_RATE_MAX` overrides the limit for tests). URLs over 2048 chars get `414` from the NBA router.
- Errors are JSON: `{ "error": "..." }`. `400` = bad input (message names the parameter), `404` = unknown player, `503` = model data unavailable. Responses never contain `NaN`; a missing number is `null`.
- Responses carry `Cache-Control: public, max-age=60..300`, a weak `ETag`, and answer `304` to a matching `If-None-Match`.
- **Player ids.** `id` is the Sleeper player id (`"1658"`). Yahoo-only players (in Yahoo's league pool but not in Sleeper, so they have no game logs) have `id = "y" + yahooPid` (`"y6014"`). `/api/nba/player/:id` accepts a Sleeper id, a bare yahooPid, or `y<yahooPid>`. Sleeper ids are tried first, so for a Yahoo id use the `y` prefix (the two id spaces overlap). Always link with the row's `id`.
- **"Model" vs "log" numbers.** `mean / sd / ceiling / floor / hsValue` come from the value model (`/api/nba/players`): they look forward, shrunk toward the 2026-27 projection. `scored*`, `bestGameAvg`, `dd/tdPct` and `last5*` are measured from the player's actual games in `statSeason`, the newest season with logged games (2025-26 until the 2026-27 season starts), scored with the league weights.
- **Matchup weeks** come from the league profile (`/api/nba/research/meta` `weeks`). Weeks 7 and 17 are 14 days long. `currentWeek` is the profile week containing today (week 1 before the season).
- Context fetched from Sleeper in the background is cached in memory and in `data/nba/cache/research-*.json`. That covers bios, the 2026-27 schedule, per-game opponents, news and trending. On a cold start the first table request may have `age: null` until the bio map loads (a few seconds). Detail requests wait up to 2.5 s for it. Anything missing is named in the detail's `unavailable` object. Nothing is invented.

## Data sources: what exists and what doesn't (checked 2026-10-13)

| Want | Source | Status |
|---|---|---|
| Headshots | `https://sleepercdn.com/content/nba/players/{sleeperId}.jpg` and `/thumb/{id}.jpg` | ✅ 200 for Sleeper ids. Returns 403 when no photo exists, so add an `onerror` fallback to `teamLogo`. |
| Team logos | `https://sleepercdn.com/images/team_logos/nba/{abbr}.png` | ✅ |
| ESPN id | Sleeper `espn_id` | ❌ null for every active NBA player. `data/nba/espn-check.json` has 4 ids (Jokić etc.), which are used when present. |
| NBA.com id | not in Sleeper | ❌ `nbaId` is always `null` |
| Yahoo headshot | needs Yahoo API `headshot.url` | ❌ not in the league snapshot (`images.yahoo` is null) |
| Bio | `api.sleeper.app/v1/players/nba`: age, birth_date, height (in), weight, college, years_exp, number, depth chart, sportradar/rotowire/swish ids | ✅ (`college` is often null for international players) |
| News | `https://api.sleeper.com/players/nba/{id}/news` (Rotowire: title, description, analysis, published) | ✅ (`api.sleeper.app/v1/players/nba/{id}/news` returns 404, so use the `.com` host) |
| Opponent / home-away of past games | `https://api.sleeper.com/stats/nba/player/{id}?season=2025&grouping=week` (`team`, `opponent`, `is_away_team`) | ✅ fetched per player on detail |
| 2026-27 schedule with opponents | `https://api.sleeper.com/schedule/nba/regular/2026` (home/away teams per game) | ✅ |
| Trending adds/drops | `https://api.sleeper.app/v1/players/nba/trending/{add,drop}?lookback_hours=24&limit=25` | ✅ Real Sleeper counts. If the call fails, the endpoint falls back to last-5 form and sets `derived: true`. |
| %rostered | Yahoo snapshot `pctRos` | ✅ `yahooPctRos` |

---

## `GET /api/nba/research`

Paginated, filtered, sorted research table rows.

| Param | Values | Default |
|---|---|---|
| `q` | Free text, at most 64 chars. Matches an accent-insensitive name substring (`jokic` finds Jokić), or an exact team (`DEN`) or position (`PG`). | – |
| `pos` | Comma list of `PG,SG,G,SF,PF,F,C`. Matches the Yahoo position string. | all |
| `slot` | Comma list of `PG,SG,G,SF,PF,F,C,UTIL`. Matches `yahooElig`. | all |
| `team` | Comma list of NBA abbreviations (the list is in meta) | all |
| `inj` | `healthy` \| `injured` \| `out` (O/OFS/IL/SUSP) \| `dtd` (DTD/D) | all |
| `source` | `logs` \| `projection-only` \| `rookie` \| `yahoo-only` | all |
| `sort` | any key in meta `sortKeys` | `hsValue` |
| `dir` | `asc` \| `desc` | `desc` for value keys; `asc` for rank-like keys (meta `ascByDefault`) |
| `limit` | 1–200 | 50 |
| `offset` | 0–5000 | 0 |

Unknown sort/pos/slot/team/inj/source, or a non-integer limit/offset, returns `400`. Null values sort last in both directions. Ties break by `rank`.

Response:

```jsonc
{
  "asOf": "2026-10-14T03:15:30.579Z",   // model data timestamp
  "currentWeek": 1, "leagueId": "242808",
  "total": 771, "limit": 50, "offset": 0, "sort": "hsValue", "dir": "desc",
  "rows": [ Row, ... ]
}
```

### Row

| Field | Type | Notes |
|---|---|---|
| `id` | string | Sleeper id, or `y<yahooPid>` for Yahoo-only players |
| `sleeperId` | string \| null | null for Yahoo-only |
| `yahooPid` | string \| null | |
| `name`, `team`, `teamAbbr` | string / string\|null | `teamAbbr` is the Sleeper abbreviation (GSW, NOP, …) |
| `pos` | string | Yahoo position string, `"PG,SG"`. Falls back to Sleeper positions when unmatched. |
| `posList` | string[] | |
| `posSource` | `"yahoo"` \| `"sleeper-mapped"` | |
| `yahooElig` | string[] | starting slots the player can fill (`["PG","G","UTIL"]`) |
| `injury` | string \| null | Sleeper status (`Out`, `DTD`, …) |
| `injuryTag` | `"O"\|"DTD"\|"D"\|"IL"\|"SUSP"\|"OFS"` \| null | OFS = out for season |
| `injuryNotes` | string \| null | |
| `outForSeason` | boolean | |
| `headshot` | url \| null | Sleeper thumb. null for Yahoo-only. |
| `teamLogo` | url \| null | |
| `imageHints` | `{ sleeperId, espnId, nbaId, yahooPid, teamAbbr }` | espnId is rare. nbaId is always null. |
| `age`, `exp` | number \| null | age comes from the Sleeper bio map |
| `rank`, `modelRank`, `tier`, `posRank` | number \| null | rank = position on the merged board (by hsValue) |
| `vorp`, `vorpRank` | number \| null | value over replacement at the best eligible slot |
| `hsValue` | number \| null | Expected weekly best game, averaged over the remaining matchup weeks. This is the main value. |
| `hsThisWeek`, `gamesThisWeek` | number \| null | for `currentWeek` |
| `mean`, `sd`, `ceiling`, `floor` | number \| null | Model per-game league score (ceiling p90, floor p10). null for Yahoo-only. |
| `availability` | number \| null | model share of games played |
| `statSeason` | number \| null | season of the log stats below |
| `gp`, `mpg` | number\|null / number\|null | `gp` is 0 for players with no logs (rookies). It is null for Yahoo-only players, whose stats are all null. |
| `pts reb ast stl blk to pf` | number \| null | per-game stat line, `statSeason` |
| `scoredPg`, `scoredSd`, `scoredP90`, `scoredP10` | number \| null | per-game league score from the logs |
| `bestGameAvg` | number \| null | mean of the player's weekly best game (Sleeper weeks) |
| `ddPct`, `tdPct` | number \| null | 0–1 |
| `last5`, `last5Delta` | number \| null | mean league score over the last 5 games, and that minus the season mean |
| `last5Min`, `minDelta`, `roleTrend` | number\|null, number\|null, `"up"\|"down"\|"flat"`\|null | role trend: minutes over the last 5 vs the season (±3 min) |
| `marketRank`, `adpDelta`, `marketLabel` | number\|null, number\|null, string\|null | market layer (`market.json`). Positive `adpDelta` = market drafts him later than the model ranks him. |
| `yahooPreRank`, `yahooPctRos` | number \| null | |
| `source` | `"logs"\|"projection-only"\|"rookie"\|"yahoo-only"` | |

Example row (real, trimmed to one):

```json
{"id":"1658","sleeperId":"1658","yahooPid":"5352","name":"Nikola Jokić","team":"DEN","teamAbbr":"DEN","pos":"C","posList":["C"],"posSource":"yahoo","yahooElig":["C","UTIL"],"injury":null,"injuryTag":null,"injuryNotes":null,"outForSeason":false,"headshot":"https://sleepercdn.com/content/nba/players/thumb/1658.jpg","teamLogo":"https://sleepercdn.com/images/team_logos/nba/den.png","imageHints":{"sleeperId":"1658","espnId":"3112335","nbaId":null,"yahooPid":"5352","teamAbbr":"DEN"},"age":31,"exp":11,"rank":1,"modelRank":1,"tier":1,"posRank":1,"vorp":48.8,"vorpRank":1,"hsValue":75,"hsThisWeek":66.4,"gamesThisWeek":2,"mean":62.9,"sd":16.4,"ceiling":84.8,"floor":39.3,"availability":0.8,"statSeason":2025,"gp":65,"mpg":34.8,"pts":27.7,"reb":12.9,"ast":10.7,"stl":1.4,"blk":0.8,"to":3.7,"pf":2.7,"scoredPg":65.3,"scoredSd":16.1,"scoredP90":86,"scoredP10":46,"bestGameAvg":76.9,"ddPct":0.846,"tdPct":0.523,"last5":64.6,"last5Delta":-0.7,"last5Min":33.9,"minDelta":-0.9,"roleTrend":"flat","marketRank":1,"adpDelta":0,"marketLabel":"fair","yahooPreRank":1,"yahooPctRos":100,"source":"logs"}
```

## `GET /api/nba/research/meta`

```jsonc
{
  "leagueId": "242808", "leagueName": "HALIMSANITY 26-27",
  "scoring": { "pts":1,"reb":1.2,"ast":1.5,"stl":3,"blk":3,"to":-1,"pf":-1,"tech":-1,"dd":5,"td":3 }, "flags": { "tdAlsoCountsDD": true },
  "asOf": "...", "builtAt": "...", "currentWeek": 1,
  "players": 771, "withLogs": 478, "yahooOnly": 117,
  "sortKeys": ["hsValue","rank","tier","name","team","pos","age","exp","posRank","vorp","hsThisWeek","gamesThisWeek","mean","sd","ceiling","floor","availability","gp","mpg","pts","reb","ast","stl","blk","to","pf","scoredPg","scoredSd","scoredP90","scoredP10","bestGameAvg","ddPct","tdPct","last5","last5Delta","last5Min","minDelta","marketRank","adpDelta","yahooPreRank","yahooPctRos","injury"],
  "defaultSort": { "sort": "hsValue", "dir": "desc" }, "ascByDefault": ["rank", "..."],
  "filters": { "q": "...", "pos": ["PG","SG","G","SF","PF","F","C"], "slot": ["PG","SG","G","SF","PF","F","C","UTIL"], "team": ["ATL", "..."], "inj": ["healthy","injured","out","dtd"], "source": ["logs","projection-only","rookie","yahoo-only"] },
  "limits": { "limitDefault": 50, "limitMax": 200, "offsetMax": 5000, "qMaxLength": 64 },
  "weeks": [ { "week": 1, "start": "2026-10-20", "end": "2026-10-25", "days": 6, "playoffs": false }, "..." ],
  "market": { "available": true, "asOf": "...", "label": "market (Yahoo-first)", "matched": 425 },
  "context": { "bio": { "loaded": true, "fetchedAt": "...", "error": null }, "schedule": { "loaded": true, "fetchedAt": "...", "error": null }, "offline": false }
}
```

## `GET /api/nba/search?q=&limit=`

Fast autocomplete. Matching is accent-insensitive and uses the same normalizer as the model's Yahoo↔Sleeper matching. Results are ordered: exact name, then name prefix, then word prefix, then substring, then exact team, then exact position. Ties break by rank. `limit` is 1–25 (default 10). An empty `q` returns `{ q: "", results: [] }`.

```json
{"q":"Jokic","results":[{"id":"1658","sleeperId":"1658","yahooPid":"5352","name":"Nikola Jokić","team":"DEN","pos":"C","injuryTag":null,"rank":1,"hsValue":75,"headshot":"https://sleepercdn.com/content/nba/players/thumb/1658.jpg","source":"logs"}]}
```

## `GET /api/nba/trending?hours=&limit=`

`hours` is 1–168 (default 24). `limit` is 1–50 (default 25). The result is cached for 10 minutes.

```jsonc
{
  "source": "sleeper-trending",      // or "derived-form" when Sleeper is unreachable
  "derived": false,                  // true → lists are last-5 form swings, count:null, signal = last5Delta
  "lookbackHours": 24,
  "adds":  [ { "id": "2621", "count": 6885, "player": Brief | null } ],
  "drops": [ { "id": "2278", "count": 1410, "player": null, "name": "..." } ],
  "fetchedAt": "..."
}
```

`Brief = { id, sleeperId, yahooPid, name, team, pos, injuryTag, rank, hsValue, yahooPctRos, last5Delta, headshot, source }`. `player` is null when the trending player is not on the board, for example a free agent or an inactive Sleeper player. For those players the entry carries `name` and `team` from the Sleeper bio map when it knows them. If the name matches a Yahoo-only board row (Westbrook is inactive in Sleeper but in Yahoo's pool), `player` is that row's Brief.

## `GET /api/nba/player/:id`

Full detail. `404 { error, id }` for an unknown id. `400` when the id is not `y?\d{1,12}`. Each section is either an object or `null`. When a section is null or partial, `unavailable[section]` says why.

| Section | Shape |
|---|---|
| `id`, `asOf`, `leagueId`, `currentWeek`, `source`, `resolvedBy` (`sleeperId`\|`yahooPid`), `generatedAt` | scalars |
| `identity` | `{ name, firstName, lastName, sleeperId, yahooPid, sportradarId, rotowireId, swishId, espnId, nbaId }` |
| `images` | `{ headshot, headshotThumb, teamLogo, espn, nba:null, yahoo:null, note }` |
| `bio` | `{ age, birthDate, height:"6-11", heightIn, weightLb, college, experience, jersey, depthChart:{position,order}\|null, rookie }` |
| `team`, `teamAbbr` | string \| null |
| `positions` | `{ pos, list, source, yahooElig, legacyElig }` |
| `injury` | `{ status, tag, outForSeason, bodyPart, notes, startDate, newsUpdated }` |
| `value` | `{ rank, modelRank, tier, posRank, posRanks, hsValue, mean, sd, ceiling, floor, vorp, vorpRank, vorpBySlot, availability, hsByWeek{week:n}, gamesByWeek{week:n}, newTeam, valueNote }` |
| `market` | `{ marketRank, adpDelta, label, strong, contested, marketConfidence, marketThin, yahooPreRank, yahooPctRos, yahooFanPts }` |
| `projection` | Sleeper season projection, per game: `{ season, source, min, pts, reb, ast, stl, blk, to, sleeperAdp, linearScore, modelMean, hsValue, note }`. `linearScore` = the line under league weights without PF/TECH/DD/TD. `modelMean` = the full league-scored mean. For Yahoo-only players: `{ season, source, modelMean, hsValue, yahooFanPts, note }`. |
| `lastSeason` | `{ season, gp, mpg, perGame{pts,reb,ast,stl,blk,to,pf,tech}, scored{mean,sd,p10,p90,min,max,median} }` |
| `gameLog` | `{ season, games: Game[] }`, newest first |
| `last10` | `Game[]`, newest first |
| `histogram` | `{ binWidth: 5, games, bins: [{ lo, hi, count }] }`. Counts sum to `games`. |
| `weeklyBest` | `{ season, weekBasis, weeks: [{ week, start, end, games, best, bestDate }], summary: { weeks, mean, median, p90, max } }`. This is the High Score view: the score that would have counted each week. |
| `consistency` | `{ cv, boomRate, bustRate, boomDef, bustDef }`. A boom is a game ≥ 1.3× his mean; a bust is ≤ 0.7×. |
| `rates` | `{ ddPct, tdPct, ddCount, tdCount, gp }` |
| `form` | `{ last5, last5Delta, last5Min, minDelta, roleTrend, seasonMean, mpg }` |
| `splits` | `{ home: {gp, mean, mpg} \| null, away: … }`, or null when game context is unavailable |
| `nextWeek` | `{ week, start, end, days, games, availability, baseAvailability, expectedBest, pBestAtLeast: { "40", "50", "60", "70" }, method }`. `availability` is the model's figure for this week and accounts for injuries (OUT ≤ 0.1; OUT after surgery or IL = 0). `baseAvailability` is the season share of games played. `expectedBest` = model `hsByWeek[week]`. |
| `schedule` | next 4 matchup weeks: `[{ week, start, end, days, playoffs, modelGames, hsValue, games: [{ date, opp, home, b2b }] \| null, gameCount, b2bCount }]` |
| `similar` | up to 6 × `Brief + { similarity: 0–1, reason }` |
| `news` | `{ available, source: "sleeper (rotowire)", items: [{ title, description, analysis, published, source }] }` |
| `unavailable` | `{ [section]: reason }`. Possible keys: `bio`, `logs`, `gameContext`, `splits`, `projection`, `projectionLine`, `nextWeek`, `scheduleOpponents`, `schedule`, `news`. |

`Game = { date, sleeperWeek, team, opp, home, min, pts, reb, ast, stl, blk, to, pf, tech, dd, td, score }`. `score` is the league score under profile 242808, including the DD +5 / TD +3 bonuses; a triple-double also earns the DD bonus. `team/opp/home` are null when game context is unavailable.

**Probability bands.** `pBestAtLeast[T]` = P(his best game of the next matchup week ≥ T), computed as `1 − (1 − a·q(T))^games`. Here `a` is the model availability and `q(T)` is P(single game ≥ T). With 10 or more logged games, q comes from his own game-score shape rescaled to the model's forward mean and kernel-smoothed. With fewer games, q comes from a normal with the model mean and sd. These are model estimates, not betting odds.

**Similar players.** The pool is non-Yahoo-only players ranked 1–400 who share at least one Yahoo position. Distance is a weighted standardized Euclidean distance over hsValue (×1.5), mean, cv, ceiling, ddPct and mpg. `similarity = 1/(1+d)`. `reason` lists the shared position, the value and pts/game comparison, the DD rate when close, and steadier/volatile.

Example detail sections are in the next section ("Sample payloads").

## Sample payloads

Real responses from `PORT=7991`. Arrays are trimmed.

### research?limit=2&sort=last5Delta (1 row shown)
```json
{"asOf":"2026-10-14T06:52:38.656Z","currentWeek":1,"leagueId":"242808","total":771,"limit":2,"offset":0,"sort":"last5Delta","dir":"desc","rows":[{"id":"2615","sleeperId":"2615","yahooPid":"10064","name":"Rayan Rupert","team":"PHI","teamAbbr":"PHI","pos":"SG,SF","posList":["SG","SF"],"posSource":"yahoo","yahooElig":["SG","G","SF","F","UTIL"],"injury":null,"injuryTag":null,"injuryNotes":null,"outForSeason":false,"headshot":"https://sleepercdn.com/content/nba/players/thumb/2615.jpg","teamLogo":"https://sleepercdn.com/images/team_logos/nba/phi.png","imageHints":{"sleeperId":"2615","espnId":null,"nbaId":null,"yahooPid":"10064","teamAbbr":"PHI"},"age":22,"exp":3,"rank":265,"modelRank":264,"tier":21,"posRank":139,"vorp":-7.9,"vorpRank":271,"hsValue":18.5,"hsThisWeek":19.7,"gamesThisWeek":4,"mean":10.7,"sd":10.6,"ceiling":26.1,"floor":0.8,"availability":0.77,"statSeason":2025,"gp":64,"mpg":16.8,"pts":5.2,"reb":2.9,"ast":1.1,"stl":0.9,"blk":0.1,"to":0.9,"pf":1.9,"scoredPg":10.8,"scoredSd":13.9,"scoredP90":25.4,"scoredP10":-0.7,"bestGameAvg":18.4,"ddPct":0.047,"tdPct":0.016,"last5":39.3,"last5Delta":28.5,"last5Min":35.2,"minDelta":18.4,"roleTrend":"up","marketRank":343,"adpDelta":79,"marketLabel":null,"yahooPreRank":348,"yahooPctRos":0,"source":"projection-only"}]}
```
### research?source=yahoo-only&limit=1
```json
{"asOf":"2026-10-14T06:52:38.656Z","currentWeek":1,"leagueId":"242808","total":117,"limit":1,"offset":0,"sort":"hsValue","dir":"desc","rows":[{"id":"y4390","sleeperId":null,"yahooPid":"4390","name":"Russell Westbrook","team":"SAC","teamAbbr":"SAC","pos":"PG,SG","posList":["PG","SG"],"posSource":"yahoo","yahooElig":["PG","SG","G","UTIL"],"injury":null,"injuryTag":null,"injuryNotes":null,"outForSeason":false,"headshot":null,"teamLogo":"https://sleepercdn.com/images/team_logos/nba/sac.png","imageHints":{"sleeperId":null,"espnId":null,"nbaId":null,"yahooPid":"4390","teamAbbr":"SAC"},"age":null,"exp":null,"rank":238,"modelRank":null,"tier":21,"posRank":null,"vorp":-5.6,"vorpRank":null,"hsValue":20.2,"hsThisWeek":null,"gamesThisWeek":null,"mean":null,"sd":null,"ceiling":null,"floor":null,"availability":null,"statSeason":null,"gp":null,"mpg":null,"pts":null,"reb":null,"ast":null,"stl":null,"blk":null,"to":null,"pf":null,"scoredPg":null,"scoredSd":null,"scoredP90":null,"scoredP10":null,"bestGameAvg":null,"ddPct":null,"tdPct":null,"last5":null,"last5Delta":null,"last5Min":null,"minDelta":null,"roleTrend":null,"marketRank":null,"adpDelta":null,"marketLabel":null,"yahooPreRank":264,"yahooPctRos":1,"source":"yahoo-only"}]}
```
### search?q=doncic&limit=2
```json
{"q":"doncic","results":[{"id":"1970","sleeperId":"1970","yahooPid":"6014","name":"Luka Dončić","team":"LAL","pos":"PG,SG","injuryTag":"DTD","rank":3,"hsValue":65.6,"headshot":"https://sleepercdn.com/content/nba/players/thumb/1970.jpg","source":"logs"}]}
```
### trending?limit=3
```json
{"source":"sleeper-trending","derived":false,"lookbackHours":24,"adds":[{"id":"2621","count":6885,"player":{"id":"2621","sleeperId":"2621","yahooPid":"10050","name":"Leonard Miller","team":"CHI","pos":"SF,PF","injuryTag":null,"rank":266,"hsValue":18.4,"yahooPctRos":2,"last5Delta":19.6,"headshot":"https://sleepercdn.com/content/nba/players/thumb/2621.jpg","source":"logs"}},{"id":"4761","count":1827,"player":{"id":"4761","sleeperId":"4761","yahooPid":"10447","name":"Khaman Maluach","team":"PHX","pos":"C","injuryTag":null,"rank":140,"hsValue":29.5,"yahooPctRos":61,"last5Delta":8.2,"headshot":"https://sleepercdn.com/content/nba/players/thumb/4761.jpg","source":"logs"}},{"id":"2020","count":1456,"player":{"id":"2020","sleeperId":"2020","yahooPid":"6171","name":"Rui Hachimura","team":"LAC","pos":"SF,PF","injuryTag":null,"rank":184,"hsValue":24.8,"yahooPctRos":50,"last5Delta":9.4,"headshot":"https://sleepercdn.com/content/nba/players/thumb/2020.jpg","source":"projection-only"}}],"drops":[{"id":"2278","count":1410,"player":{"id":"y6569","sleeperId":null,"yahooPid":"6569","name":"Cam Thomas","team":"MIL","pos":"PG,SG","injuryTag":null,"rank":358,"hsValue":14.2,"yahooPctRos":0,"last5Delta":null,"headshot":null,"source":"yahoo-only"},"name":"Cam Thomas","team":null},{"id":"1434","count":1350,"player":{"id":"y4390","sleeperId":null,"yahooPid":"4390","name":"Russell Westbrook","team":"SAC","pos":"PG,SG","injuryTag":null,"rank":238,"hsValue":20.2,"yahooPctRos":1,"last5Delta":null,"headshot":null,"source":"yahoo-only"},"name":"Russell Westbrook","team":null},{"id":"1486","count":776,"player":{"id":"1486","sleeperId":"1486","yahooPid":"4897","name":"Nikola Vučević","team":"ORL","pos":"C","injuryTag":"DTD","rank":213,"hsValue":22.7,"yahooPctRos":27,"last5Delta":-19.4,"headshot":"https://sleepercdn.com/content/nba/players/thumb/1486.jpg","source":"projection-only"}}],"fetchedAt":"2026-10-14T06:54:02.702Z"}
```
### player/1658 (star; arrays trimmed)
```json
{
 "id": "1658",
 "asOf": "2026-10-14T06:52:38.656Z",
 "leagueId": "242808",
 "currentWeek": 1,
 "source": "logs",
 "identity": {
  "name": "Nikola Jokić",
  "firstName": "Nikola",
  "lastName": "Jokić",
  "sleeperId": "1658",
  "yahooPid": "5352",
  "sportradarId": "f2625432-3903-4f90-9b0b-2e4f63856bb0",
  "rotowireId": "3612",
  "swishId": "830650",
  "espnId": "3112335",
  "nbaId": null
 },
 "images": {
  "headshot": "https://sleepercdn.com/content/nba/players/1658.jpg",
  "headshotThumb": "https://sleepercdn.com/content/nba/players/thumb/1658.jpg",
  "teamLogo": "https://sleepercdn.com/images/team_logos/nba/den.png",
  "espn": "https://a.espncdn.com/i/headshots/nba/players/full/3112335.png",
  "nba": null,
  "yahoo": null,
  "note": "Sleeper CDN headshots exist for Sleeper ids (403 when missing, use teamLogo as fallback). Sleeper does not carry ESPN/NBA.com ids for NBA players; Yahoo image URLs need the Yahoo API."
 },
 "bio": {
  "age": 31,
  "birthDate": "1995-02-19",
  "height": "6-11",
  "heightIn": 83,
  "weightLb": 284,
  "college": null,
  "experience": 11,
  "jersey": "15",
  "depthChart": {
   "position": "C",
   "order": 1
  },
  "rookie": false
 },
 "team": "DEN",
 "teamAbbr": "DEN",
 "positions": {
  "pos": "C",
  "list": [
   "C"
  ],
  "source": "yahoo",
  "yahooElig": [
   "C",
   "UTIL"
  ],
  "legacyElig": [
   "F",
   "UTIL"
  ]
 },
 "injury": {
  "status": null,
  "tag": null,
  "outForSeason": false,
  "bodyPart": null,
  "notes": null,
  "startDate": null,
  "newsUpdated": "2026-10-12T04:15:17.093Z"
 },
 "value": {
  "rank": 1,
  "modelRank": 1,
  "tier": 1,
  "posRank": 1,
  "posRanks": {
   "F": 1
  },
  "hsValue": 75,
  "mean": 62.9,
  "sd": 16.4,
  "ceiling": 84.8,
  "floor": 39.3,
  "vorp": 48.8,
  "vorpRank": 1,
  "vorpBySlot": {
   "C": 48.8,
   "UTIL": 48.5
  },
  "availability": 0.8,
  "hsByWeek": {
   "1": 66.4,
   "2": 73.1,
   "…": "22 weeks"
  },
  "gamesByWeek": {
   "1": 2,
   "2": 3,
   "…": "22 weeks"
  },
  "newTeam": false,
  "valueNote": null
 },
 "market": {
  "marketRank": 1,
  "adpDelta": 0,
  "label": "fair",
  "strong": false,
  "contested": false,
  "marketConfidence": 0.86,
  "marketThin": false,
  "yahooPreRank": 1,
  "yahooPctRos": 100,
  "yahooFanPts": 4215.9
 },
 "projection": {
  "season": 2026,
  "source": "sleeper season projection (per game)",
  "min": 35.4,
  "pts": 27.86,
  "reb": 13.06,
  "ast": 10.1,
  "stl": 1.52,
  "blk": 0.76,
  "to": 3.41,
  "sleeperAdp": 2.5,
  "linearScore": 70.1,
  "modelMean": 62.9,
  "hsValue": 75,
  "note": "linearScore = projected line under league weights without PF/TECH/DD/TD; modelMean is the model's full league-scored per-game mean (incl. expected PF/TECH and DD/TD bonuses)"
 },
 "lastSeason": {
  "season": 2025,
  "gp": 65,
  "mpg": 34.8,
  "perGame": {
   "pts": 27.7,
   "reb": 12.9,
   "ast": 10.7,
   "stl": 1.4,
   "blk": 0.8,
   "to": 3.7,
   "pf": 2.7,
   "tech": 0
  },
  "scored": {
   "mean": 65.3,
   "sd": 16.1,
   "p10": 46,
   "p90": 86,
   "min": 27.4,
   "max": 104.7,
   "median": 65.3
  }
 },
 "gameLog": {
  "season": 2025,
  "games": [
   {
    "date": "2026-04-12",
    "sleeperWeek": 25,
    "team": "DEN",
    "opp": "SAS",
    "home": false,
    "min": 18.3,
    "pts": 23,
    "reb": 8,
    "ast": 1,
    "stl": 0,
    "blk": 1,
    "to": 0,
    "pf": 1,
    "tech": 0,
    "dd": false,
    "td": false,
    "score": 36.1
   },
   {
    "date": "2026-04-08",
    "sleeperWeek": 25,
    "team": "DEN",
    "opp": "MEM",
    "home": true,
    "min": 31,
    "pts": 14,
    "reb": 16,
    "ast": 10,
    "stl": 2,
    "blk": 0,
    "to": 2,
    "pf": 0,
    "tech": 0,
    "dd": true,
    "td": true,
    "score": 60.2
   }
  ]
 },
 "last10": [
  {
   "date": "2026-04-12",
   "sleeperWeek": 25,
   "team": "DEN",
   "opp": "SAS",
   "home": false,
   "min": 18.3,
   "pts": 23,
   "reb": 8,
   "ast": 1,
   "stl": 0,
   "blk": 1,
   "to": 0,
   "pf": 1,
   "tech": 0,
   "dd": false,
   "td": false,
   "score": 36.1
  }
 ],
 "histogram": {
  "binWidth": 5,
  "games": 65,
  "bins": [
   {
    "lo": 25,
    "hi": 30,
    "count": 1
   },
   {
    "lo": 30,
    "hi": 35,
    "count": 2
   },
   {
    "lo": 35,
    "hi": 40,
    "count": 2
   }
  ]
 },
 "weeklyBest": {
  "season": 2025,
  "weekBasis": "Sleeper Mon-Sun weeks of that season (the league calendar for last season is unknown)",
  "weeks": [
   {
    "week": 1,
    "best": 62.3,
    "bestDate": "2025-10-25",
    "games": 2,
    "start": "2025-10-21",
    "end": "2025-10-26"
   },
   {
    "week": 2,
    "best": 72.8,
    "bestDate": "2025-10-27",
    "games": 3,
    "start": "2025-10-27",
    "end": "2025-11-02"
   }
  ],
  "summary": {
   "weeks": 22,
   "mean": 76.9,
   "median": 80.4,
   "p90": 92.1,
   "max": 104.7
  }
 },
 "consistency": {
  "cv": 0.246,
  "boomRate": 0.123,
  "bustRate": 0.108,
  "boomDef": "game ≥ 1.3× his mean",
  "bustDef": "game ≤ 0.7× his mean"
 },
 "rates": {
  "ddPct": 0.846,
  "tdPct": 0.523,
  "ddCount": 55,
  "tdCount": 34,
  "gp": 65
 },
 "form": {
  "last5": 64.6,
  "last5Delta": -0.7,
  "last5Min": 33.9,
  "minDelta": -0.9,
  "roleTrend": "flat",
  "seasonMean": 65.3,
  "mpg": 34.8
 },
 "splits": {
  "home": {
   "gp": 33,
   "mean": 65.8,
   "mpg": 34.5
  },
  "away": {
   "gp": 32,
   "mean": 64.8,
   "mpg": 35.2
  }
 },
 "nextWeek": {
  "week": 1,
  "start": "2026-10-20",
  "end": "2026-10-25",
  "days": 6,
  "games": 2,
  "availability": 0.8,
  "baseAvailability": 0.8,
  "expectedBest": 66.4,
  "pBestAtLeast": {
   "40": 0.925,
   "50": 0.867,
   "60": 0.706,
   "70": 0.453
  },
  "method": "own game-score shape rescaled to model mean, kernel-smoothed; P = 1-(1-a·q)^games"
 },
 "schedule": [
  {
   "week": 1,
   "start": "2026-10-20",
   "end": "2026-10-25",
   "days": 6,
   "playoffs": false,
   "modelGames": 2,
   "hsValue": 66.4,
   "games": [
    {
     "date": "2026-10-22",
     "opp": "OKC",
     "home": false,
     "b2b": false
    },
    {
     "date": "2026-10-24",
     "opp": "NOP",
     "home": true,
     "b2b": false
    }
   ],
   "gameCount": 2,
   "b2bCount": 0
  }
 ],
 "similar": [
  {
   "id": "2577",
   "sleeperId": "2577",
   "yahooPid": "10094",
   "name": "Victor Wembanyama",
   "team": "SAS",
   "pos": "C",
   "injuryTag": "DTD",
   "rank": 2,
   "hsValue": 72.4,
   "yahooPctRos": 100,
   "last5Delta": 16.1,
   "headshot": "https://sleepercdn.com/content/nba/players/thumb/2577.jpg",
   "source": "logs",
   "similarity": 0.633,
   "reason": "shares C · HS value 72.4 vs 75 · 59.9 vs 62.9 pts/game · more volatile"
  }
 ],
 "news": {
  "available": true,
  "source": "sleeper (rotowire)",
  "items": [
   {
    "title": "Nikola Jokic - Triple-doubles in preseason win",
    "description": "Jokic recorded 22 points (8-12, 1-2 3Pt, 5-7 FT), 11 rebounds, 10 assists and a block in 26 minutes during Sunday's 133-128 preseason win over the Bulls.",
    "analysis": "Denver elected to play its starters into the second half for the first time this preseason, leading to Jokic producing a highly efficient triple-double while playing three quarters. The star big man led the game in rebounds and assists. Jokic is coming off six straight seasons in which he finished in the top two in MVP voting, and he seems poised for another dominant campaign.",
    "published": "2026-10-12T04:10:24.000Z",
    "source": "rotowire"
   }
  ]
 },
 "unavailable": {},
 "generatedAt": "2026-10-14T06:54:02.762Z",
 "resolvedBy": "sleeperId"
}
```
### player/4873 (rookie Cameron Boozer; trimmed, hsByWeek/gamesByWeek omitted)
```json
{"id":"4873","asOf":"2026-10-14T06:52:38.656Z","leagueId":"242808","currentWeek":1,"source":"rookie","identity":{"name":"Cameron Boozer","firstName":"Cameron","lastName":"Boozer","sleeperId":"4873","yahooPid":"10592","sportradarId":"a4f80f47-7419-461e-84a0-ecd7fc0241bf","rotowireId":"6923","swishId":null,"espnId":null,"nbaId":null},"images":{"headshot":"https://sleepercdn.com/content/nba/players/4873.jpg","headshotThumb":"https://sleepercdn.com/content/nba/players/thumb/4873.jpg","teamLogo":"https://sleepercdn.com/images/team_logos/nba/mem.png","espn":null,"nba":null,"yahoo":null,"note":"Sleeper CDN headshots exist for Sleeper ids (403 when missing, use teamLogo as fallback). Sleeper does not carry ESPN/NBA.com ids for NBA players; Yahoo image URLs need the Yahoo API."},"bio":{"age":19,"birthDate":"2007-07-18","height":"6-10","heightIn":82,"weightLb":250,"college":"Duke","experience":0,"jersey":"27","depthChart":{"position":"PF","order":1},"rookie":true},"team":"MEM","teamAbbr":"MEM","positions":{"pos":"PF","list":["PF"],"source":"yahoo","yahooElig":["PF","F","UTIL"],"legacyElig":["F","UTIL"]},"injury":{"status":null,"tag":null,"outForSeason":false,"bodyPart":null,"notes":null,"startDate":null,"newsUpdated":"2026-10-10T05:00:59.076Z"},"value":{"rank":52,"modelRank":52,"tier":14,"posRank":35,"posRanks":{"F":35},"hsValue":42.2,"mean":36,"sd":10.8,"ceiling":49.9,"floor":22.1,"vorp":16.4,"vorpRank":52,"vorpBySlot":{"PF":16.4,"F":15.8,"UTIL":15.7},"availability":0.85,"newTeam":false,"valueNote":null},"market":{"marketRank":55,"adpDelta":3,"label":"fair","strong":false,"contested":true,"marketConfidence":0.61,"marketThin":false,"yahooPreRank":55,"yahooPctRos":95,"yahooFanPts":2465},"projection":{"season":2026,"source":"sleeper season projection (per game)","min":33.5,"pts":17.28,"reb":8.53,"ast":3.44,"stl":0.93,"blk":0.6,"to":2.4,"sleeperAdp":25.1,"linearScore":34.9,"modelMean":36,"hsValue":42.2,"note":"linearScore = projected line under league weights without PF/TECH/DD/TD; modelMean is the model's full league-scored per-game mean (incl. expected PF/TECH and DD/TD bonuses)"},"lastSeason":null,"gameLog":null,"last10":null,"histogram":null,"weeklyBest":null,"consistency":null,"rates":null,"form":null,"splits":null,"nextWeek":{"week":1,"start":"2026-10-20","end":"2026-10-25","days":6,"games":3,"availability":0.85,"baseAvailability":0.85,"expectedBest":43.5,"pBestAtLeast":{"40":0.66,"50":0.228,"60":0.033,"70":0.002},"method":"normal(model mean, sd); P = 1-(1-a·q)^games"},"schedule":[{"week":1,"start":"2026-10-20","end":"2026-10-25","days":6,"playoffs":false,"modelGames":3,"hsValue":43.5,"games":[{"date":"2026-10-21","opp":"UTA","home":true,"b2b":false},{"date":"2026-10-23","opp":"GSW","home":false,"b2b":false},{"date":"2026-10-25","opp":"SAC","home":false,"b2b":false}],"gameCount":3,"b2bCount":0}],"similar":[{"id":"1535","sleeperId":"1535","yahooPid":"5318","name":"Julius Randle","team":"BKN","pos":"PF","injuryTag":null,"rank":42,"hsValue":43.4,"yahooPctRos":94,"last5Delta":-3.4,"headshot":"https://sleepercdn.com/content/nba/players/thumb/1535.jpg","source":"projection-only","similarity":0.883,"reason":"shares PF · HS value 43.4 vs 42.2 · 34.1 vs 36 pts/game · same consistency"}],"news":{"available":true,"source":"sleeper (rotowire)","items":[{"title":"Cameron Boozer - Tallies 10 points vs. Chicago","description":"Boozer logged 10 points (3-5 FG, 0-1 3Pt, 4-4 FT), four rebounds and three assists during Friday's 104-100 preseason win over the Bulls.","analysis":"All of Boozer's production came in the first half, with the third-overall pick of the 2026 NBA Draft observing the final two quarters of Friday's game from the bench. With Ja Morant in Portland, Boozer figures to be a center piece to Memphis' game plan on a night-to-night basis, with the Duke product forming a starting frontcourt with Zach Edey and Jaylen Wells, with veteran Jerami Grant also in the mix for heavy playing time.","published":"2026-10-10T04:59:37.000Z","source":"rotowire"}]},"unavailable":{"logs":"no NBA game logs (rookie or did not play last season)"},"generatedAt":"2026-10-14T06:54:02.941Z","resolvedBy":"sleeperId"}
```
### player/y4390 (Yahoo-only Russell Westbrook; schedule trimmed)
```json
{"id":"y4390","asOf":"2026-10-14T06:52:38.656Z","leagueId":"242808","currentWeek":1,"source":"yahoo-only","identity":{"name":"Russell Westbrook","firstName":null,"lastName":null,"sleeperId":null,"yahooPid":"4390","sportradarId":null,"rotowireId":null,"swishId":null,"espnId":null,"nbaId":null},"images":{"headshot":null,"headshotThumb":null,"teamLogo":"https://sleepercdn.com/images/team_logos/nba/sac.png","espn":null,"nba":null,"yahoo":null,"note":"Sleeper CDN headshots exist for Sleeper ids (403 when missing, use teamLogo as fallback). Sleeper does not carry ESPN/NBA.com ids for NBA players; Yahoo image URLs need the Yahoo API."},"bio":{"age":null,"birthDate":null,"height":null,"heightIn":null,"weightLb":null,"college":null,"experience":null,"jersey":null,"depthChart":null,"rookie":false},"team":"SAC","teamAbbr":"SAC","positions":{"pos":"PG,SG","list":["PG","SG"],"source":"yahoo","yahooElig":["PG","SG","G","UTIL"],"legacyElig":["PG","SG","G","UTIL"]},"injury":{"status":null,"tag":null,"outForSeason":false,"bodyPart":null,"notes":null,"startDate":null,"newsUpdated":null},"value":{"rank":238,"modelRank":null,"tier":21,"posRank":null,"posRanks":null,"hsValue":20.2,"mean":null,"sd":null,"ceiling":null,"floor":null,"vorp":-5.6,"vorpRank":null,"vorpBySlot":{"PG":-5.6,"SG":-6.3,"G":-6.3,"UTIL":-6.3},"availability":null,"hsByWeek":null,"gamesByWeek":null,"newTeam":false,"valueNote":"No game-log data (not in Sleeper): value estimated from Yahoo projected fantasy points per game"},"market":{"marketRank":null,"adpDelta":null,"label":null,"strong":false,"contested":false,"marketConfidence":null,"marketThin":false,"yahooPreRank":264,"yahooPctRos":1,"yahooFanPts":1312.9},"projection":{"season":2026,"source":"yahoo projected fanPts (estimate)","modelMean":null,"hsValue":20.2,"yahooFanPts":1312.9,"note":"No game-log data (not in Sleeper): value estimated from Yahoo projected fantasy points per game"},"lastSeason":null,"gameLog":null,"last10":null,"histogram":null,"weeklyBest":null,"consistency":null,"rates":null,"form":null,"splits":null,"nextWeek":null,"schedule":[{"week":1,"start":"2026-10-20","end":"2026-10-25","days":6,"playoffs":false,"modelGames":null,"hsValue":null,"games":[{"date":"2026-10-21","opp":"LAC","home":false,"b2b":false},{"date":"2026-10-23","opp":"POR","home":true,"b2b":false},{"date":"2026-10-25","opp":"MEM","home":true,"b2b":false}],"gameCount":3,"b2bCount":0}],"similar":[],"news":{"available":false,"source":null,"items":[]},"unavailable":{"bio":"no Sleeper id (Yahoo-only player)","projectionLine":"Yahoo-only player: no Sleeper projection line","logs":"Yahoo-only player: not in Sleeper, no game logs","nextWeek":"Yahoo-only player: no schedule-based model","news":"Yahoo-only player: no Sleeper news feed"},"generatedAt":"2026-10-14T06:54:02.975Z","resolvedBy":"yahooPid"}
```
### player/1000 (injured Jimmy Butler, OUT/knee surgery: selected sections)
```json
{"injury":{"status":"Out","tag":"O","outForSeason":false,"bodyPart":"Knee","notes":"Surgery","startDate":null,"newsUpdated":"2026-10-05T21:15:29.001Z"},"nextWeek":{"week":1,"start":"2026-10-20","end":"2026-10-25","days":6,"games":3,"availability":0,"baseAvailability":0.54,"expectedBest":0,"pBestAtLeast":{"40":0,"50":0,"60":0,"70":0},"method":"own game-score shape rescaled to model mean, kernel-smoothed; P = 1-(1-a·q)^games"},"schedule0":{"week":1,"start":"2026-10-20","end":"2026-10-25","days":6,"playoffs":false,"modelGames":3,"hsValue":0,"games":[{"date":"2026-10-21","opp":"LAL","home":false,"b2b":false},{"date":"2026-10-23","opp":"MEM","home":true,"b2b":true},{"date":"2026-10-24","opp":"PHX","home":false,"b2b":true}],"gameCount":3,"b2bCount":2},"unavailable":{}}
```
### errors
```json
// GET /api/nba/player/99999999 → 404
{"error":"Player not found","id":"99999999"}
// GET /api/nba/research?sort=bogus → 400
{"error":"Unknown sort key (allowed: hsValue, rank, tier, name, team, pos, age, exp, posRank, vorp, hsThisWeek, gamesThisWeek, mean, sd, ceiling, floor, availability, gp, mpg, pts, reb, ast, stl, blk, to, pf, scoredPg, scoredSd, scoredP90, scoredP10, bestGameAvg, ddPct, tdPct, last5, last5Delta, last5Min, minDelta, marketRank, adpDelta, yahooPreRank, yahooPctRos, injury)"}
// GET /api/nba/research?q=<73 chars> → 400
{"error":"q longer than 64 characters"}
```

## Performance and tests

- Measured on the real server (`DATABASE_URL= PORT=7991 node --env-file=.env.local server.js`, 2026-10-14):
  - First request after boot (builds the index over 771 players): about 55 ms for `/research` and 163 ms for `/player/1658`. The detail time includes the Sleeper game-context and news fetches.
  - Warm requests: `/research?limit=50` 1.0 ms, `/player/1658` 0.7 ms, `/search` 1.0 ms, `/research/meta` 0.5 ms, `/trending` 16 ms.
  - The engine caches 500 table queries and 300 player details per index. The index is rebuilt whenever the router's 10-minute `modelPlayers` cache hands back a new board, or when context loads.
- `node scripts/test-nba-research.js` has 20 checks and is part of `npm test`. It runs offline against the committed snapshot, with fixtures standing in for Sleeper context. It covers:
  - Pagination, and every sort key in both directions with nulls last.
  - Every filter, including combined filters.
  - Accent-insensitive search (`Jokic` and `jokić` both find Nikola Jokić).
  - A hand-checked Jokić game: 21/13/10/1/1, 2 TO, 3 PF scores 60.6 with the TD +3 and DD +5 bonuses.
  - Detail for a star, a rookie, a Yahoo-only player (`y` prefix and bare pid) and an injured player (OUT and OUT after surgery).
  - Unknown id → 404 JSON, and malformed id → 400.
  - A NaN/undefined sweep over every row and every player's detail. Histogram counts must equal games played, and the weekly-best series must equal the per-week max of `score.rowScore` over the raw log rows.
  - Input sanitisation (huge `q` → 400/414, bad sort/dir/limit/offset/pos/team/inj/source → 400) and the rate limit (429 + Retry-After).
  - ETag/304, the derived trending fallback, and fetched context (bio, schedule with back-to-backs, opponent/home-away, splits, news HTML stripped, trending join).
  - Warm latency under 150 ms.
