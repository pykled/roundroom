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

- All endpoints are public GETs and return JSON. Each IP gets 240 requests per minute across these five endpoints (`429` + `Retry-After` past that). URLs over 2048 chars get `414` from the NBA router.
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
| `gp`, `mpg` | number / number\|null | |
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

`Brief = { id, sleeperId, yahooPid, name, team, pos, injuryTag, rank, hsValue, yahooPctRos, last5Delta, headshot, source }`. `player` is null when the trending player is not on the board (a free agent or inactive player). When the bio map knows the player, the entry carries `name` and `team`.

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
| `nextWeek` | `{ week, start, end, days, games, availability, expectedBest, pBestAtLeast: { "40", "50", "60", "70" }, method }` |
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
