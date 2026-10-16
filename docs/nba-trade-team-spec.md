# Pocket NBA: Trade Calculator v2 + Team Page — build spec

Lead/architect doc, 2026-10-15. Base: `origin/main` @ `ce802d8` (c854287 + an injuries data commit). Branch `nba-spec` carries this doc, machine-readable contracts under `docs/nba-spec/`, and the shared-layer stubs + contract test so Streams A/B/C can start at the same time.

Dillon's asks:
1. "Make the NBA trade calculator better. Similar to the football version of the site. Take into account different points of real data, not just avg fpts."
2. "I need to see a team page where it ranks and shows stats for fantasy teams like positional weakness, etc."

Everything below was verified against code in this tree and live data from this machine on 2026-10-15 (preseason; NBA week 1 starts Tue 2026-10-20). Nothing is guessed; where a thing is unverified it says so.

---

## 0. Decisions (read this if nothing else)

| # | Decision | Why |
|---|---|---|
| D1 | **The league profile comes from Sleeper, not the stored Yahoo-era 242808 profile.** Stream A builds it live from `/v1/league/{id}` + `/v1/state/nba` (`profileFromSleeper`). | The stored profile is wrong for the Sleeper league on four counts (§1.3): 3 UTIL + 4 BN (10 starters), not 2 UTIL + 5 BN; plain Mon–Sun weeks (23 of them), not 22 weeks with two 14-day weeks; playoffs weeks 21–23, not 20–22; trade deadline week 17 (ends 2027-02-14), not 2027-03-04. Flagrant fouls score −1 and are missing from the profile. |
| D2 | **Aggregation stays High Score (E[best game of the week]).** Verified empirically on last season's Sleeper league (§1.2). | Sleeper `players_points` for a starter equals his single best league-scored game that week (58/99 exact; the rest are lower because of mid-week benching; 0 are the sum). |
| D3 | **Verdict = lineup impact (keep); add a league-neutral asset-value fairness axis.** Two numbers, clearly separated: *Fit* (Δ pts/wk to **your** lineup, the existing exact lineup DP) and *Value* (asset value in vs out, market-aware). | NFL verdict is value-for-value with a roster-fit overlay. The NBA engine already does the more exact thing (lineup delta with replacement level, drops, 2-for-1). What it lacks is a market-aware, league-neutral "is this fair" read and visible signals. |
| D4 | **Real data points added to value:** injury return dates (ESPN, verified), market consensus with a decaying in-season weight, recent form / minutes trend from game logs (shown, not double-counted), schedule (games, heavy/light weeks, playoff games), availability (games-played share), ceiling/volatility, age (keeper lens only). | Each is available today (§2). The model already recency-weights logs, so form is *explained* not *re-multiplied*. |
| D5 | **One shared layer (Stream A) feeds both features**: `profileFromSleeper`, `leagueContext`, `playerSignals`, `analyzeRoster` (positional tiers), ESPN injury ETA in the board's availability. B (trade) and C (team) consume it; they own disjoint files. | So positional need on the team page and roster fit in the trade calculator agree by construction (same mistake the NFL side had to fix). |
| D6 | **Team page is public per league id, like every NBA page** (Sleeper data is public; no Clerk gate). Manual mode degrades to "my team vs a typical league". | Consistent with the Sleeper-first NBA side (`docs/nba-sleeper.md`). |
| D7 | **Backtest the team-strength model on the real 2025 Sleeper league** (10 teams, 23 weeks of matchups with weekly rosters recoverable from `/matchups/{week}`). | It is the only ground truth we have for "does predicted weekly lineup value track actual weekly points". |

---

## 1. Ground truth (verified 2026-10-15)

### 1.1 Dillon's league on Sleeper

`GET https://api.sleeper.app/v1/league/1411447094215991296` (fixture: `docs/nba-spec/fixtures/sleeper-league.json`).

| Field | Value |
|---|---|
| name / status / season | HALIMSANITY 26-27 / `in_season` / `2026` (= 2026-27) |
| total_rosters | 12 (13 users: one co-owner/extra) |
| roster_positions | `PG, SG, G, SF, PF, F, C, UTIL, UTIL, UTIL, BN ×4` → **10 starters, 4 BN**, + `reserve_slots: 2` (IL) = 16 |
| scoring_settings | pts 1, reb 1.2, ast 1.5, stl 3, blk 3, to −1, pf −1, **tf −1, ff −1**, dd 5, td 3, tpm 0, bonus_pt_40p/50p 0 |
| playoff_week_start / playoff_teams / playoff_round_type | 21 / 6 / 0 (one week per round → **playoff weeks 21, 22, 23**) |
| trade_deadline | **17** (Sleeper week; week 17 = 2027-02-08..14) |
| type / max_keepers | 0 (redraft) / **1 keeper** |
| waiver_type / budget | 0 (rolling priority) / 100 (unused) |
| daily_waivers / waiver_clear_days | 0 / 2 |
| draft (1411447094215991297) | complete, snake, 13 rounds, reversal_round 3, 30 s picks, `slots_util: 2, slots_bn: 4` (the draft was 9+4; the league was then changed to 3 UTIL via `capacity_override: 1`) |
| rosters today | 12 rosters, 13–16 players each (two carry 2 IL players), `starters[]` has **10** entries in `/matchups/1` |
| my roster | roster_id 1, owner `1044077615075872768` (pykle), 13 players, 0 IL |

Last season's league is also on Sleeper: `1270568574406107137` (10 teams, same scoring, same slots, `last_scored_leg: 23`, playoffs from 21). That is the backtest set (D7).

### 1.2 Aggregation proof (Sleeper = High Score)

`GET /v1/league/1270568574406107137/matchups/10` vs per-game stats `api.sleeper.com/stats/nba/2025/10` re-scored with the league weights (fixture: `fixtures/sleeper-matchups-2025-wk10.json`):

| starters with ≥1 game | points == max single game (±0.6) | points < max (benched mid-week, banked score) | points == sum of games |
|---|---|---|---|
| 99 | **58** | 40 | **0** |

Bench players score 0 (5 of 56 bench rows were non-zero: moved out of the lineup mid-week). `matchup.points` = Σ `starters_points`. So the existing E[max] model (`docs/nba-model.md`) is the right value basis, and the "benching forfeits banked games" rule from the lineup page holds on Sleeper too.

### 1.3 Calendar (Sleeper weeks, 2026-27)

`GET https://api.sleeper.com/schedule/nba/regular/2026` (1,200 games listed, 25 weeks; fixture `fixtures/sleeper-schedule-weeks-2026.json`). Weeks are Mon–Sun; week 1 is Tue 10-20 → Sun 10-25. Games/team/week: 2.9 (wk1), 3.2–3.8 normally, **1.9 (wk7, Nov 30–Dec 6) and 0.9 (wk8, Dec 7–13)** because the NBA Cup knockout and each team's 2 unscheduled games fall in the Dec 4–11 gap (the model's `imputeUnscheduled` already places 2 games/team in that gap), **2.0 (wk18, Feb 15–21, All-Star)**, 2.1 (wk19, Feb 22–28: games resume Feb 25). The league plays weeks 1–23 (weeks 24–25 exist in the NBA schedule but are after the fantasy season).

The stored profile (`nba/league-profile.js` 242808) has 22 weeks with 14-day weeks 7 and 17 and playoffs 20–22: that is the Yahoo calendar and must not be used for Sleeper leagues. Spike (reproducible, §4.2): building the board under a Sleeper-derived profile takes 131 ms, yields 23 weeks of `hsByWeek`, 10 starting slots, replacement ≈ 25.4 at every slot (vs 26.5 under 9 starters), and the trade evaluator runs unchanged (`Lillard for Nurkić` → Counter, +1.2/wk, band 3.2, deadline 2027-02-14, 121 days left).

Caveat kept open: Sleeper's `settings.leg` is 1 today while `/v1/state/nba` says preseason week 3; week numbering of `/matchups/{week}` vs schedule weeks must be re-checked on 2026-10-21 (Stream A acceptance test, §4.6).

### 1.4 What the current NBA trade calculator does (so we build on it, not beside it)

`nba/model/trade.js` (pure, deterministic; `docs/nba-trade.md`): a player is worth the change in your best lineup over the remaining weeks, with an exact slot assignment (`roster-slots.js`, transversal-matroid greedy with augmenting paths, brute-force tested), bench shares 12/7/4/2/1% × starters/6, open spots filled at waiver replacement (0.9 × 3rd-best unrostered player that week), forced drops when over the cap, IL overflow tolerated, playoff weeks ×1.5, fair band = max(1, 0.75% of your weekly lineup total), verdict Accept / Counter / Decline, partner likelihood, ranges from per-player uncertainty combined in quadrature, per-week bars, typical-week lineup before/after with slot stabilisation, why-bullets, consolidation note, trade-rule chips. 30-trade validation table exists (`scripts/nba-trade-validate.js`). Partner roster and league replacement come from Sleeper (`/api/nba/trade/context?league_id=`); the route overrides slots from `roster_positions` (so it already sees 3 UTIL) but **not** the week calendar, playoffs or deadline (those still come from the 242808 profile).

What it does **not** use: injury return timelines (OUT ramps are guesses: 0.1 +0.25/week), market/ADP, form or minutes trend as visible signals, age, positional need as a named tier, any league-neutral fairness axis, a contend/rebuild lean, a horizon choice.

---

## 2. Data inventory

### 2.1 How the NFL side does it (what translates)

| NFL signal (file) | Rule / threshold | NBA translation |
|---|---|---|
| Base value: VORP (`shared/scoring.js computeVORP`) = season proj − replacement at position (replacement rank = teams × starter slots, FLEX split 0.5/0.5), ^1.25 power, rescaled 0–10000 | position-based replacement | NBA has slot-level VORP already (`nba/model/slots.js applyVorp`, replacement = best player outside the top teams×active pool per slot). Finding from H1: replacement is flat across slots (~25.4), so positional scarcity is small at the *value* level; it matters at the *roster-fit* level. |
| Market blend (`blendWithMarket`) 70% VORP / 30% FantasyCalc (50/50 dynasty); missing from FC → pure VORP | fixed weight | FantasyCalc has **no NBA** (`?sport=nba` returns NFL rows; re-verified today). NBA market = preseason consensus (`data/nba/market.json`: Yahoo pre-rank 0.40, ESPN ADP 0.20, Sleeper ADP 0.15, FantasyPros CSV 0.25; ρ = 0.90 vs last season's league fanPts). It is a **prior**, so weight decays through the season (§4.4). |
| Injury multiplier (`TradeFit.injuryMult`): Q 0.97, D 0.90, Out 0.80, IR 0.55, Sus 0.85 (dynasty milder); TODO "scale by expected games missed" | status → season multiplier | NBA does better already (per-week availability `board.js availability()`), and we now have **ESPN return dates** (§2.3) to replace the OUT/IR ramps with a real ETA. |
| Age curve (`AGE_CURVE`) dynasty only | per-position breakpoints | League is redraft with **1 keeper**. Age only in an optional keeper lens (Q2 to Dillon). |
| Slot factor (`slotFactors`): starter 1.0, bench 0.85 / 0.72 / 0.60 by depth rank | depth-chart discount | Subsumed by the exact lineup DP + bench shares. Keep as a *display* label (Starts / Bench #n) via the typical lineup. |
| Form (`factors.js formSignal`): last 2 games vs season proj ÷ 17, hot ≥ 1.2 → ×0.95, cold ≤ 0.8 → ×1.05, baseline ≥ 5 pts | regression nudge | NBA: last 5 games vs season mean of league score (`research.js logStats`), same 1.2 / 0.8 labels, **no multiplier** (the model's 45-day half-life + projection shrink already prices recency; a second nudge double counts). Show the numbers. |
| Role signal (usage delta ≥ 8 pp / ×1.25, vacated share ≥ 15%) | NFL touch shares | NBA: minutes trend (last 5 mpg − season mpg, ±3 = up/down, `research.js roleTrend`), projected minutes vs season mpg (the model's ρ = projMin/M clamped 0.7–1.4), and **usage proxy** needs FGA/FTA which the compact logs don't carry (Stream D, §6). |
| Playoff SOS (`playoffSOS`): avg defence rank over playoff weeks → ±5% | opponent strength | NBA: opponents are in the weekly Rotowire projections already (week-specific mean). Expose **playoff games** (weeks 21–23) and games per week; no extra multiplier. |
| Season context (`seasonContext`): record + week → buy/sell/hold lean, fires after 3 games and week 4 | lean text | NBA: `lean` = contend / balanced from record + rank (team page), drives playoff weight 1.5 vs 1.0 and horizon default. |
| 2-for-1 note (`rosterImbalance`): text only | never changes value | NBA already prices it (open spot = replacement, forced drop). Keep the note. |
| Verdict: WIN / FAIR / LOSE, FAIR = sides within 10% | value-for-value | NBA: Fit verdict (Accept/Counter/Decline on Δ/wk, existing bands) + Value fairness (§4.5). |
| Team page (`shared/analysis.js`, `team.html`): optimal starters by VORP, strength = Σ starter VORP, per-position tier = depth (rostered ≤ slots → need; ≥ 2× → surplus) × quality (starter VORP vs league avg; strong = top 30%) → critical/upgrade/thin/solid/deep/loaded; elite ≥ 7500, liability < 1000; injured = Out/Doubtful/IR/PUP; partners = teams whose needs ⊂ my surplus, score = 2·overlap + mutual; Roster Fit multipliers critical ×1.30, upgrade ×1.15, thin ×1.10, solid 1, deep ×0.90, loaded ×0.80 | the whole model | Translate 1:1 to NBA slot groups (§5) with NBA values (pts/wk), NBA depth counts (eligible, healthy players vs group slots), and the trade calculator consuming the same tiers for its fit explanation. |

### 2.2 Per-player data points available today (NBA)

Sources: Sleeper (committed snapshot `data/nba/*.json` + 30-min background refresh `nba/model/data.js`), Rotowire via Sleeper projections, Yahoo snapshot (preseason, frozen 2026-10-14), ESPN (new).

| Data point | Where | Freshness | Reliability / notes |
|---|---|---|---|
| Identity, team, Sleeper positions (`fantasy_positions`), status, `years_exp`, **age / birth_date** (615/645 active), height/weight, depth-chart order | `api.sleeper.app/v1/players/nba` → `players.json` (654 active) / research bio cache | 30 min / 12 h | Reliable. `espn_id` is null for all NBA players (name match needed for ESPN joins; 130/131 ESPN injury names match Sleeper by normalised name). |
| Injury `injury_status` (Out / DTD / IR / Sus…), `injury_body_part`, `injury_notes` ("Surgery", "Rest"), `injury_start_date` (often null) | same | 30 min | Status is reliable; **no return date**. 131 active players tagged today (preseason rest days inflate DTD). |
| **Injury return date (`returnDate`), fantasy status (GTD/OUT/OFS), body part, detail, comment** | `site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries` | live (ESPN timestamp), unofficial API, 200 today | **131/131 rows have `returnDate`**; 108 Day-To-Day, 23 Out (e.g. Butler III → 2027-01-02 knee surgery; Porziņģis → 2026-11-09; Veesaar → 2027-07-01 = season). Names match Sleeper 130/131. New source, Stream A adds it with a 1 h cache + disk fallback + "ignore if stale" guard (§4.3). |
| Per-game logs 2025-26: date, week, minutes, pts/reb/ast/stl/blk/to/pf/tf (compact rows; format 2) | `api.sleeper.com/stats/nba/2025/{week}` → `logs-2025.json` (350 players with ≥5 games) | committed; 2026 logs are fetched weekly in-season (last 2 weeks re-pulled) | Verified vs ESPN game counts and dates. Raw rows also carry **fga, fta, tpm, oreb/dreb, plus_minus, quarter splits** (not compacted → Stream D). |
| Season per-game projection + weekly per-game projections with opponents (Rotowire): pts, reb, ast, stl, blk, to, **minutes (sp)**, dd/td, fga/fta/tpm, `adp_std`, `adp_dynasty` | `api.sleeper.com/projections/nba/2026[/{week}]` → `proj-2026.json` (967 rows wk1; 336 players have weekly rows) | current + next week refreshed every 30 min | Means only (no variance). No pf/tf. Weekly rows exist only for scheduled games. |
| Team schedule / games per week / dates (80 of 82 games/team dated) | projections rows + `api.sleeper.com/schedule/nba/regular/2026` (home/away, 25 weeks) | committed + 12 h | Verified vs ESPN team schedules for 5 teams. NBA Cup gap imputed. |
| Model outputs per player: `hsValue`, `hsByWeek`, `gamesByWeek`, `mean`, `sd`, `ceiling` (p90), `floor` (p10), `availability` (a0), `source` (logs 350 / projection-only 204 / rookie 100), `sampleGames`, `newTeam`, `vorp`, `vorpBySlot`, `yahooElig`, tiers | `nba/model` `getPlayers({profile})` (131 ms cold, <1 ms warm) | 10-min memo | Backtested (`docs/nba-model.md`): given games played, bias −0.1, MAE 8.3, r 0.98 (TEAM rows included; ≈0.75 player-only). Availability is the weak part (+1.3 weekly bias from unforeseen missed games). |
| Log-derived: `gp`, `mpg`, per-game line, `scoredPg/Sd/P90/P10`, `bestGameAvg`, `ddPct/tdPct`, `last5`, `last5Delta`, `last5Min`, `minDelta`, `roleTrend`, `cv`, boom/bust rates, weekly best per week, home/away splits | `nba/model/research.js logStats` (+ `/api/nba/research`, `/api/nba/player/:id`) | same as logs | Measured, not modelled. Preseason: all from 2025-26 (stale by definition until ~5 games of 2026-27 exist; signals must carry `statSeason` and `stale`). |
| Market: `marketRank`, `adpDelta`, `label` (value/reach/fair), `contested`, `confidence`, `yahooPreRank`, `yahooPctRos`, raw ESPN/Sleeper ADP | `data/nba/market.json` (602 rows), `enrich.js` | **frozen 2026-10-14** (pre-draft build) | Preseason-only. Good prior (ρ 0.90 vs last season's league points), useless as an in-season price. |
| Trending adds/drops (24 h counts) | `api.sleeper.app/v1/players/nba/trending/add|drop` | 10 min | Works (6,471 adds for Leonard Miller today). Hype, not value; display only. |
| News (Rotowire) | `api.sleeper.com/players/nba/{id}/news` | 15 min | Works; display only. |
| Headshots | `sleepercdn.com/content/nba/players/{id}.jpg` | — | 403 when missing → team logo fallback (existing `U.avatar`). |
| League: rosters (players / starters / reserve), users (team names, avatars), `settings` (wins/losses/fpts/fpts_against/waiver_position/total_moves), matchups per week (opponent, points, players_points) | `api.sleeper.app/v1/league/{id}/…` via `nba/routes/sleeper.js leagueContext` | 30–60 s cache | Public, no auth. Record and points are 0 until week 1 scores. |

**Not available / not worth it (verified from this machine today):** `cdn.nba.com` 403 (Akamai); `stats.nba.com` blocked; balldontlie 401 (key); FantasyCalc no NBA; Yahoo API blocked for the app; Hashtag Basketball returns 200 but is rankings HTML under ToS (skip); FantasyPros stays opt-in CSV import. There is no free in-season NBA trade-value feed; our model **is** the in-season value.

**Gaps that matter and how each is handled:**

| Gap | Handling |
|---|---|
| Availability is heuristic for OUT/IR (ramps) | ESPN `returnDate` overrides the ramp (A). Stays heuristic for DTD. |
| Form/minutes are last season's until ~Nov 1 | Signals carry `statSeason` + `stale: true` (last game > 21 days ago, same rule as waivers); UI greys them. |
| Market is preseason-only | Decaying weight (0.30 at week 1 → 0 at week 11) in the Value axis only; never on the board. |
| No usage (FGA/FTA) in compact logs | Stream D re-ingests format 3 with fga/fta/tpm; `usage` signal lands only when D merges (signals schema already has the key, null until then). |
| `yahooElig` eligibility is Sleeper `fantasy_positions` | Already the source of truth for this league (the league is on Sleeper). |
| The Yahoo market snapshot is keyed by 242808 | A's Sleeper profile carries `marketSnapshotId: '242808'` so `enrich.js`/`applyYahoo` keep working (spike showed `yahoo.matched: 0` without it). |

### 2.3 ESPN injuries endpoint (new, verified)

`GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries` → `{ timestamp, season, injuries: [{ displayName (team), injuries: [{ athlete: { displayName, … }, status: 'Day-To-Day'|'Out', type: { abbreviation }, date, details: { fantasyStatus: { abbreviation: 'GTD'|'OUT'|'OFS' }, type, detail, side, returnDate: 'YYYY-MM-DD' }, shortComment, longComment }] }] }`. Sample in `fixtures/espn-injuries-sample.json`. Unofficial, no SLA: fetch hourly in the background (never on the request path), cache to `data/nba/cache/injury-eta.json`, serve stale on failure, and treat a row as stale when `date` is older than 14 days **and** the player has a logged game after it.

---

## 3. Shared layer contract (Stream A) — what B and C code against

Module paths are fixed; shapes below are the contract. Stubs with these exports exist on `nba-spec` (`nba/model/league-sync.js`, `nba/model/signals.js`, `nba/model/roster-analysis.js`, `nba/model/injury-eta.js`); `scripts/test-nba-spec-contract.js` validates the fixtures and, once a function stops throwing `NOT_IMPLEMENTED`, validates its live output against the same shape checks. `profileFromSleeper` is already implemented (pure, 40 lines) because both B and C need the right calendar from day one; A hardens it and owns it from here.

### 3.1 `nba/model/league-sync.js`

```js
profileFromSleeper({ league, draft = null, state = null, scheduleWeeks = null, today = null })
  → Profile  // same shape nba/league-profile.js returns, plus the fields marked NEW
```
- `league` = raw `/v1/league/{id}`; `state` = raw `/v1/state/nba` (for `season_start_date`); `draft` optional (rounds, pick timer); `scheduleWeeks` optional `[{week, first, last}]` from `api.sleeper.com/schedule/nba/regular/{season}` (used only to assert the Mon–Sun calendar; the calendar itself is built from `season_start_date`: week 1 = start → next Sunday, then 7-day weeks).
- Output (fixture `docs/nba-spec/fixtures/profile-from-sleeper.expected.json`, pinned by the contract test):
  `{ leagueId: <sleeper league_id>, source: 'sleeper' (NEW), sleeperLeagueId, marketSnapshotId: '242808' (NEW; the Yahoo snapshot/market files to join for the market layer), name, teams, aggregation: 'high-score', positionSource: 'sleeper', scoring: { pts, reb, ast, stl, blk, to, pf, tech (= tf), ff (NEW), dd, td }, flags: { tdAlsoCountsDD: true }, slots: { PG, SG, G, SF, PF, F, C, FC: 0, UTIL, BN, IL (= reserve_slots) }, starters, rosterSize, weeks: [{ week, start, end, days, playoffs }] (1..lastWeek, lastWeek = playoff_week_start + ceil(log2(playoff_teams)) − 1 for round_type 0; +1 for type 1; ×2 for type 2), regularSeasonWeeks: playoff_week_start − 1, playoffTeams, tradeEnd: end date of week trade_deadline (null when 99/0), tradeDeadlineWeek (NEW), maxKeepers (NEW), leagueType (NEW: 0 redraft / 1 keeper / 2 dynasty), waivers: { type: 'rolling'|'faab', days: waiver_clear_days, daily: !!daily_waivers }, trades: { review: trade_review_days ? 'league' : 'commissioner', protestDays: trade_review_days, draftPickTrades: !!pick_trading }, draft: { type, rounds, pickSeconds } }`.
- Rules: unknown slot names → UTIL; `IR`/`IL`/`IL+` → IL; `ff` scored via `score.js` LINEAR list (A adds `ff` column handling: logs rows must gain `ff`; until the ingest carries it, `ff` contributes 0 and `profile.unverified` says so). `getPlayers({ profile: <object> })` already accepts an object; A also makes `/api/nba/players?league_id=<sleeperId>` build (and cache 10 min) that profile, and `LC.profileFor({ sleeperLeagueId })` return it so lineup/trade/waivers routes use it when `league_id`/`sleeper_league_id` is a Sleeper id.
- Classification: `aggregation` is `'high-score'` for Sleeper NBA points leagues (§1.2). Category leagues (`classifyLeague` → `categories`) get `aggregation: 'categories'` and every consumer must refuse with a clear notice (existing board behaviour) rather than value them.

```js
leagueContext({ league, users, rosters, draft, matchups = null, board, profile, userId = null })
  → LeagueContext
```
Pure normalisation of the Sleeper payloads the routes already fetch (`nba/routes/sleeper.js leagueContext`) into one shape both features use (fixture `fixtures/league-context.example.json`):
`{ leagueId, name, season, teams: [{ rosterId: '1', name, ownerId, displayName, avatar, coOwners: [], record: { wins, losses, ties, fpts, fptsAgainst }, waiverPosition, totalMoves, players: [{ id, onBoard: bool, slot: 'START'|'BN'|'IL' }], starters: [ids], reserve: [ids], unmatched: [{ id, name }] }], myRosterId: '1'|null, currentWeek, opponentByRoster: { '1': '7', … } | null (from matchups), profile }`. Ids are Sleeper player ids (= board ids). Nothing is dropped silently: players not on the board stay in `players` with `onBoard: false` and in `unmatched`.

### 3.2 `nba/model/injury-eta.js` (A)

```js
fetchInjuryEta({ fetchImpl, cacheDir, now }) → Promise<EtaDoc>   // background only; never awaited on a request path
loadInjuryEta() → EtaDoc | null                                   // memory → disk cache → null
matchEta(etaDoc, player, { logs }) → { status: 'OUT'|'GTD'|'OFS', returnDate, bodyPart, detail, comment, asOf, stale: bool } | null
applyEtaToAvailability(a0, injury, eta, weekDef, currentWeekDef) → number   // see §4.3 for the rule
```
`EtaDoc = { source, fetchedAt, rows: [{ name, norm, team, status, fantasyStatus, returnDate, bodyPart, detail, comment, date }] }`. Match = normalised name (`names.js normalizeName`) + team when both known; ambiguous → null. `board.js` consults it inside `availability()` so **every** consumer (board, lineup, trade, waivers, team) sees the same availability.

### 3.3 `nba/model/signals.js` (A)

```js
playerSignals(player, ctx) → Signals
signalsFor(players, ctx) → Map<id, Signals>
```
`ctx = { profile, currentWeek, weeks: [{week, weight, playoff}] (horizon from the caller), logs (data.logs), proj, market (market.json doc or null), eta (EtaDoc or null), bio (research bio map or null), replacement: { perWeek } | null, today }`.

`Signals` (fixture `fixtures/signals.example.json`; every number is a finite number or null, never NaN):

| key | formula |
|---|---|
| `id, name, team, pos, elig, source, sampleGames, statSeason` | from the board; `statSeason` = newest season with ≥ 5 logged games for this player (2026 once it has them, else 2025) |
| `value.ros` | Σ_w weight_w · hsByWeek[w] / Σ weight over `ctx.weeks` |
| `value.now`, `value.next` | hsByWeek[currentWeek], hsByWeek[currentWeek+1] |
| `value.mean, sd, ceiling, floor, cv` | model per-game; `cv = sd / mean` (null if mean ≤ 0) |
| `value.ceilingShare` | (ceiling − mean) / mean: how much of his week value is spike-driven (High Score rewards it) |
| `value.vorp, vorpRank, rank, tier` | from the board (profile slots) |
| `form.last5, seasonMean, ratio, delta, label, games, lastGameDate, stale` | league-scored logs of `statSeason`: last 5 played games mean vs season mean; `ratio = last5 / seasonMean`; `label` hot if ratio ≥ 1.20, cold if ≤ 0.80, else null; requires ≥ 10 season games and seasonMean ≥ 10 pts else null; `stale` = last game > 21 days before `today` |
| `minutes.mpg, last5, delta, trend, projected, roleShift` | mpg = season mean minutes; `trend` up/down/flat at ±3 min (research.js); `projected` = Rotowire minutes for the current week (or season proj); `roleShift = clamp(projected / mpg, 0.7, 1.4)` (the model's ρ) |
| `usage.fga, fta, usageRate, trend` | **null until Stream D** (needs fga/fta in logs) |
| `availability.a0, status, bodyPart, notes, eta: { returnDate, returnWeek, source: 'espn', asOf, stale } \| null, outForSeason, byWeek: { w: a_w }, expectedGamesMissed` | a0 = games played share with prior (board); `a_w` = the board's week availability (ETA-aware); `expectedGamesMissed = Σ_w games_w · (1 − a_w)` over the horizon |
| `schedule.gamesByWeek, gamesRemaining, gamesThisWeek, heavyWeeks (≥4), lightWeeks (≤2), playoffGames, b2bNext2` | from `gamesByWeek` and `proj.teamDates` (b2b = consecutive game days in the next 2 weeks) |
| `market.rank, adpDelta, label, contested, confidence, yahooPreRank, pctRos, impliedValue, weight` | from market.json; `impliedValue` = hsValue of the board player at `rank` (rank→value curve over the board sorted by hsValue, linear between ranks); `weight = 0.30 · max(0, 1 − (currentWeek − 1) / 10)` |
| `value.blended` | `(1 − market.weight) · value.ros + market.weight · market.impliedValue` when `market.rank` exists, else `value.ros` (this is the **Value axis** input; the board never uses it) |
| `bio.age, exp, rookie` | Sleeper bio (null when the bio map isn't loaded) |
| `uncertainty` | 0.10, +0.10 if source ≠ logs, +0.04 if injured with ETA / +0.08 injured without, +0.05 if sampleGames < 20, +0.05 if `form.stale` and source = logs; cap 0.35 |
| `flags[]` | strings from the above for the UI: `'hot'`, `'cold'`, `'minutes-up'`, `'minutes-down'`, `'out-until-wk12'`, `'ofs'`, `'heavy-schedule'`, `'light-schedule'`, `'market-value'`, `'market-reach'`, `'rookie'`, `'new-team'`, `'thin-sample'`, `'stale-stats'` |

### 3.4 `nba/model/roster-analysis.js` (A)

```js
analyzeRoster({ players /* board Player[] for this roster, IL excluded */, profile, weeks, replacement, leagueAvg = null, strongCutoff = null, eta = null })
  → RosterAnalysis
```
Output (fixture `fixtures/roster-analysis.example.json`):
`{ lineup: { total, starters: [{ id, slot, value }], bench: [{ id, value, share }], holes: n }, strengthRos, strengthNow, benchValue, groups: { G: Group, F: Group, C: Group, UTIL: Group, PG: Group, SG: Group, SF: Group, PF: Group }, needs: ['C', …], surplus: ['G', …], elite: [{ id, value }], liabilities: [{ id, value, slot }], injured: [{ id, status, eta, lostThisWeek }], injuryExposure: { thisWeek, next2 }, gamesThisWeek }`.

Group definition (the NBA analogue of NFL positions; slot groups, not positions, because that is what the lineup fills):

| Group | slots counted | eligible players |
|---|---|---|
| G | PG + SG + G | `elig` contains PG or SG |
| F | SF + PF + F | `elig` contains SF or PF |
| C | C | `elig` contains C |
| UTIL | UTIL ×n | anyone (depth group) |
| PG / SG / SF / PF (display only) | the single slot | players whose primary position (first of `pos`) matches |

`Group = { slots, rostered (eligible, healthy, not IL), starterValue (Σ value of starters the assignment put in this group's slots), nextUp (best bench value eligible), leagueAvg, rank, tier, status }`. Tier matrix = NFL's exactly: depth `need` if rostered ≤ slots, `surplus` if rostered ≥ 2·slots; quality `weak` if starterValue < leagueAvg, `strong` if ≥ strongCutoff (top 30% of teams); `critical / upgrade / thin / solid / deep / loaded`; `status` collapses to need / neutral / surplus. Without league context (`leagueAvg` null): tier from depth only (thin / solid / deep). `elite` = starter with value ≥ 45 pts/wk or top-24 on the board; `liabilities` = starters with value < replacement + 3. `lostThisWeek` = healthyValue − hsByWeek[current] where healthyValue = E[max] at a0 with no injury.

### 3.5 Who may edit what (shared files)

| File | Owner | Others |
|---|---|---|
| `nba/model/board.js`, `data.js`, `sleeper.js`, `score.js`, `slots.js`, `roster-slots.js`, `league-profile.js`, `routes/league-context.js`, `routes/sleeper.js`, `router.js` (profile plumbing), `nba/model/{league-sync,signals,roster-analysis,injury-eta}.js`, `scripts/nba-ingest.js` (format 3 only if D is folded in), `scripts/test-nba-shared.js`, `scripts/test-nba-spec-contract.js`, `docs/nba-shared-layer.md` | **A** | read-only |
| `nba/model/trade.js`, `routes/trade.js`, `pages/trade.{html,js}`, `pages/trade-logic.js`, `pages/trade.css` (new, optional), `scripts/test-nba-trade.js`, `scripts/nba-trade-validate.js`, `scripts/nba-trade-mock.js`, `docs/nba-trade.md` | **B** | read-only |
| `nba/model/team-analysis.js`, `routes/team.js`, `pages/team.{html,js}`, `pages/team-logic.js`, `pages/team.css`, `scripts/test-nba-team.js`, `scripts/nba-team-backtest.js`, `scripts/nba-team-mock.js`, `docs/nba-team.md`, **nav**: `nba/pages/nba-ui.js` NAV list (one entry) + `shared/nav.js` NBA_LINKS (one entry), `nba/router.js` (**one** mount line), `server.js` SITEMAP_PAGES (one entry) | **C** | read-only |
| `scripts/nba-ingest.js`, `nba/model/sleeper.js` compact format, `data/nba/logs-*.json` regen, `nba/model/signals.js` `usage` block | **D** (after A merges) | — |
| `package.json` test line, integration branch | lead | — |

Conflict points and the rule: `nba/router.js` is touched by A (profile plumbing inside `modelPlayers`) and C (one `router.use(require('./routes/team')(deps))` line before `return router`): C rebases onto A, trivial. `nba/pages/nba-ui.js` NAV and `shared/nav.js` only C. `shared/styles.css` nobody (NBA pages style via `nba-ui.css` + per-page CSS; new page CSS goes in `nba/pages/team.css`). Each page's hardcoded `<nav>` markup is replaced by `NbaUI.mountNav` at load, so adding the Team tab to the NAV list is enough; no edits to other pages.

---

## 4. NBA Trade Calculator v2 (Stream B)

### 4.1 Value model

Keep the engine (§1.4) and feed it better inputs; add a second axis; expose the signals.

**Inputs that change (from A):** profile (3 UTIL, 23 weeks, playoffs 21–23, deadline week 17), `hsByWeek` with ETA-aware availability, `Signals` per player, `RosterAnalysis` before/after.

**Horizon + lean (request `options`):**
- `horizon`: `'ros'` (default; weeks current..23), `'next4'` (current..current+3), `'playoffs'` (21..23 only; disabled before week 10).
- `lean`: `'contend'` → playoff weeks ×1.5 (current behaviour), `'balanced'` → ×1.0, `'rebuild'` → ×1.0 and the keeper lens on (Q2).
- Default lean for a connected team: `contend` if record pct ≥ 0.55 or rank ≤ playoff_teams after week 4, `balanced` otherwise; manual mode `contend`.

**Fit axis (existing, unchanged math):** `you.perWeek`, `them.perWeek`, ranges, verdict (Accept ≥ band; Counter within band or a 1–3 band loss while they gain ≥ band; Decline otherwise), partner likelihood. Band stays 0.75% of weekly lineup total (re-validated under the Sleeper profile by B, §4.6).

**Value axis (new, league-neutral):** `assetIn = Σ_get value.blended`, `assetOut = Σ_give value.blended` (blended = ROS lineup-free value with the decaying market prior, §3.3). `gap = assetIn − assetOut`; `gapPct = gap / max(assetIn, assetOut, 1)`. Fairness label: `|gapPct| ≤ 0.10` Even; `≤ 0.25` Leans (your way / their way); `≤ 0.40` Favors; else Lopsided. The fairness meter on the page is driven by this axis (today it is driven by the Δ/wk gap). Consolidation (2-for-1) correction so a fair 2-for-1 doesn't read lopsided: the side receiving fewer players adds `(n_out − n_in) × replacementRos` to its `assetIn` (a freed spot is worth a waiver add), where `replacementRos` = horizon-weighted replacement level; the side receiving more players subtracts the value of the player it must drop (already computed by `settle`).

**Per-player breakdown (`players[]`, superset of today's):** `rosValue`, `forYou`, `forThem`, `nowValue`, `games`, `heavyWeeks`, `playoffGames`, `uncertainty` (existing) + `signals` (the §3.3 object) + `slotBefore`/`slotAfter` (from the typical lineups; `'BN'` when benched) + `fit: { group, tierBefore, tierAfter }` (from `analyzeRoster`) + `why: [strings]` specific to this player (built from `signals.flags`: "Out until ~week 12 (ESPN: knee surgery, return Jan 2): worth 0 to you for 11 weeks, 41/wk after", "4-game weeks: 9 of 23", "Hot: 52.1 over the last 5 vs 44.0 season (stats from 2025-26)", "Market ranks him 38th; model 61st: you'd be buying at the market's price", …).

**Team-fit delta:** `fit: { before: RosterAnalysis, after: RosterAnalysis, deltaByGroup: { G: {tierBefore, tierAfter, starterValueDelta}, … }, notes: ["Fills your C hole (Waiver add 25.4 → Şengün 48.1)", "Leaves G thin: 3 eligible for 3 slots"] }` for **you**; `themFit` same for the partner when their roster is known.

**Explainable output additions (response v2 is a superset of v1; v1 fields keep their names so the current page keeps working during the build):**
```
{ …v1,
  version: 2,
  options: { horizon, lean, weights: { playoff } },
  value: { assetIn, assetOut, gap, gapPct, label, marketWeight, consolidationAdj },
  fit: {...}, themFit: {...} | null,
  players: [ …v1 + signals, slotBefore, slotAfter, fit, why[] ],
  summary: { headline, verdictLine, valueLine, fitLine, notes[] },   // plain English, ≤ 4 sentences total
  dataAsOf: { board, market, injuryEta, logsSeason } }
```

### 4.2 Reproducible spike (what proves the plumbing)

Run on this tree (A's first test should be a cleaned-up version of it):
```
NBA_MODEL_OFFLINE=1 node -e '…build profile from docs/nba-spec/fixtures/sleeper-league.json via league-profile.buildWeeks…; getPlayers({profile}); evaluateTrade({…, profile})'
```
Result 2026-10-15: 654 players, 23 weeks, 131 ms; Jokić 73.0 (vs 75.0 under the 9-starter/14-day-week profile), Wembanyama 71.1, Dončić 64.2; replacement 25.1–25.4 per slot; `Lillard for Nurkić` with real rosters 1 and 2 → Counter (+1.2 / −0.8 per week, band 3.2, 23 weeks, slot list `PG,SG,G,SF,PF,F,C,UTIL,UTIL,UTIL`, "Trade deadline 2027-02-14 (121 days left)"). `profile-from-sleeper.expected.json` is that profile.

### 4.3 Injury ETA rule (A implements in `board.js availability()`, B displays)

Given a matched ESPN row with `returnDate` R (ET date) and status:
- `OFS` → `outForSeason`, value 0 (existing).
- `OUT`: for week w with window [s_w, e_w]: `a_w = 0` if `e_w < R`; if `s_w ≤ R ≤ e_w`: `a_w = a0 × 0.85 × (games on/after R in the week) / (games in week)`; weeks after: first full week back ×0.85, then a0. No ramp guesses.
- `GTD` / Day-To-Day with R: current week `a = 0.75 × max(a0, 0.55)` (existing DTD rule) if R is within the week, else treat as OUT until R.
- Guard: if `eta.date` is older than 14 days and the player has a logged game after `eta.date`, ignore the row (`stale`). If ESPN and Sleeper disagree on direction (ESPN GTD, Sleeper Out), use the more pessimistic for this week and the ESPN date for later weeks.
- Without an ESPN row: existing ramps (unchanged), `eta: null`.

### 4.4 Market prior

`market.impliedValue(rank)` = hsValue of the board player ranked `rank` (board sorted by hsValue, linear interpolation; beyond the board → replacement). `weight = 0.30 × max(0, 1 − (currentWeek − 1)/10)`: 0.30 in week 1, 0.15 in week 6, 0 from week 11. Rationale: `market.json` is a preseason consensus whose information is in last season's logs + projections; as 2026-27 logs accumulate the model's own evidence supersedes it. Applied only to `value.blended` (Value axis); the Fit axis and the board are untouched. Contested or thin market rows get half weight.

### 4.5 Verdict copy (one screen, no jargon)

```
[ACCEPT]  +4.1 pts/wk for you · −3.8 for Team X (they should accept)
Value: even (you give 61.2, get 63.9 in season value)
Fit: fills your C hole; G stays solid; bench thinner by one
Why Şengün: 48/wk ROS · 3.6 games/wk · DD 71% · hot (last 5: 55 vs 48) · market #38 vs model #41
Why Lillard: out until ~wk 12 (ESPN: Achilles, return Jan 2) · 29 games left · 2025-26 stats
```
Rules: numbers are pts/wk; ETA shown as "~wk N (Mon D)"; stale stats carry "(2025-26)"; every bullet comes from a `signals.flags` entry (no free text invented in the UI).

### 4.6 Sanity + calibration tests (B's `scripts/test-nba-trade.js` additions, Checker re-runs)

1. **Symmetry**: swapping sides negates `you`/`them` and the value gap (exists; extend to v2 fields).
2. **Reversal**: give↔get reversed → `gap` negated, labels mirror.
3. **Monotonic**: adding any player with `value.ros > 0` to `get` never lowers `you.perWeek` by more than 0.05 (settle may drop him; never worse than not receiving him).
4. **Small input, small output**: scale one traded player's `hsByWeek` by ±2% → `you.perWeek` moves < 1 band, verdict unchanged on the 30-trade set.
5. **Lopsided flags**: the 30-trade table (`nba-trade-validate.js`, re-run under the Sleeper profile with 3 UTIL / 23 weeks): every ≥ 3-band loss is Decline, every ≥ 1-band gain is Accept; `value.label` is Lopsided for #6, #7, #9, #21 and Even/Leans for #1–#5, #11, #26, #27.
6. **ETA**: a player OUT with `returnDate` in week 12 has `hsByWeek[w] = 0` for w < 12, > 0.6·healthy from week 13; his `why` names week 12.
7. **Market decay**: `market.weight` = 0.30 at week 1, 0 at week 11; blended = ros when market is null.
8. **Determinism / no NaN**: two runs byte-identical; JSON contains no NaN/Infinity.
9. **Route**: v1 clients (no `options`) get `version: 2` with all v1 fields unchanged in meaning; `sleeper_league_id` builds the Sleeper profile (23 weeks in `meta.weeks`); categories league → 400 `league_not_points`.
10. **Performance**: 2-for-2 with both rosters known < 60 ms warm (today ~20 ms; signals add little).

---

## 5. NBA Team Page (Stream C)

Route `/nba/team` (nav tab "Team" between Lineup and Trade... place after Trade: Board · Research · Lineup · Trade · **Team** · Waivers). Public. League from the Sleeper chip (`window.PocketSleeper.status()` → leagues → `localStorage['pocket-nba-league']`), same pattern as `trade.js initSleeper/selectLeague`.

### 5.1 Metrics (all pure, in `nba/model/team-analysis.js`; `analyzeRoster` from A does the per-team part)

```js
analyzeLeague({ ctx /* LeagueContext */, board, signals, weeks, options }) → LeagueAnalysis
```
Per team `t` (IL players excluded from lineups; `onBoard: false` players ignored and counted in `unmatched`):

| Metric | Formula |
|---|---|
| `strengthRos` | horizon-weighted mean over weeks of `weekValue(roster, w)` = best lineup total over the profile slots on `hsByWeek[w]` + bench shares above replacement (identical function to the trade engine's `weekValue`; A exposes it from `roster-slots.js`/`roster-analysis.js` so both agree) |
| `strengthNow`, `strengthNext` | the same for `currentWeek`, `currentWeek+1` |
| `powerRank` | rank by `strengthRos` (1 = best); `nowRank` by `strengthNow` |
| `record` | wins/losses/ties/fpts/fptsAgainst from roster settings; `pointsRank` by fpts |
| `groups` | from `analyzeRoster` with `leagueAvg[g]` = mean `starterValue` across teams, `strongCutoff[g]` = starterValue of the last team inside the top 30% (≥ 1 team) → tiers; `groupRank[g]` |
| `weaknesses` | groups with tier ∈ {critical, upgrade, thin}, ordered critical → thin, then by rank desc; `strengths` = {loaded, deep} + top-3 group ranks |
| `benchValue`, `benchRank` | Σ bench shares above replacement (ROS) |
| `injuryExposure` | Σ over roster `max(0, healthyValue_w − hsByWeek[w])` for w = current (`thisWeek`) and current..+1 (`next2`); `injured[]` with ETA |
| `scheduleThisWeek` | Σ games of the 10 starters this week; `vsLeagueAvg` |
| `volatility` | mean `cv` of starters (High Score: higher spread = higher E[max], shown as "boom/bust lineup") |
| `elite`, `liabilities` | from `analyzeRoster` |
| `partners` (for `myRosterId`) | NFL rule: teams whose `needs` overlap my `surplus`; score = 2·overlap + mutual; top 3 |
| `targets` (for my team) | for each partner, candidate 1-for-1s: my players in a surplus group (bench or 2nd starter) × their players in a group I need; evaluate with `evaluateTrade` (A/B engine, real rosters, league replacement); keep swaps with `you.perWeek ≥ 0.5·band` and `them.perWeek ≥ −band`; top 6 by `you.perWeek + them.perWeek`; cap 48 evaluations, cached 5 min per league (≈ 1 s). Each target deep-links to `/nba/trade?league_id=&partner=&give=&get=` (B adds query-param prefill). |
| `lean` | `contend` / `balanced` from record + powerRank (after week 4; before: `preseason`) |

League-level: `teams[]` sorted by powerRank, `ranks: { groups: {G: [rosterIds…], …}, bench, points }`, `leagueAvg`, `strongCutoff`, `myRosterId`, `asOf`.

### 5.2 API (`nba/routes/team.js`, one mount line)

- `GET /api/nba/team?league_id=&user_id=[&roster_id=][&horizon=ros|next4|playoffs]` → `{ league: {…meta}, analysis: LeagueAnalysis, myRosterId, unmatched, asOf }`. Public, rate-limited like `/api/nba/sleeper` (240/min/IP), cached 60 s per league (rosters are cached 30 s upstream). 404 `sleeper_not_found`, 400 on bad ids, 400 `league_not_points` for categories leagues, 503 when the board is unavailable; Sleeper outages → `errorResponse` codes (429/502/504) and the page shows the manual card.
- `GET /api/nba/team/detail?league_id=&roster_id=` → `{ team: TeamAnalysis, roster: [{ player: Brief, signals: Signals, slot, group, tier }], weeks: [{ week, value, games }] }`.
- `POST /api/nba/team/manual { roster: [ids], league_id? }` → my-team analysis against a **typical league**: the other 11 rosters are estimated with the trade engine's `estimatePartner` approach generalised (snake by market rank over the board, my players removed, one roster per slot). Response is the same shape with `estimated: true` and ranks labelled "vs typical league".

### 5.3 Page (`nba/pages/team.html` + `team.js` + `team-logic.js` + `team.css`)

- Header: league name · week · "Power rankings" · horizon segmented control (ROS / Next 4 / Playoffs) · lean chip.
- **Power rankings table** (one row per team; my row highlighted; sort by any column; mobile → stacked cards): rank, team (avatar, name), record, pts, strength (pts/wk), this week, G / F / C / UTIL tier glyphs with rank (`▲ Critical`, `△ Thin`, `● Solid`, `▼ Deep`, `◆ Loaded`), injuries (count + lost pts/wk), bench.
- **My team card**: strengths / weaknesses callouts (plain English: "Thinnest at C: Nurkić 31/wk, nobody behind him. 9th of 12."), elite / liabilities, injured with ETA, schedule this week, "Teams that need what you have" (partners) and **trade targets** with one-tap "Open in Trade".
- **Team detail** (tap a row): roster table with slot, value ROS / now, games this week, form, minutes trend, injury/ETA, market; week-by-week strength sparkline.
- Legend (tooltip glossary, same wording as the trade page's fit chips).
- Manual mode: "Connect Sleeper" card + roster editor (reuse the trade page's roster sheet pattern) → my-team card only, with "vs typical league" badges; no power table.
- Empty/degraded: 0 leagues, not in league (pick a roster to view as), Sleeper 429/5xx (banner + manual still works), categories league (notice), preseason (records 0-0 shown as "—", "preseason" lean).

### 5.4 Tests (`scripts/test-nba-team.js`) and backtest (`scripts/nba-team-backtest.js`)

1. Shapes: every team has every group; tiers ∈ the 6 names; ranks are a permutation 1..N; no NaN.
2. Order invariance: shuffling rosters/players doesn't change output.
3. League context from the recorded fixtures (`fixtures/sleeper-*.json`) → 12 teams, my roster 1, 10 starters each, 0 unmatched on the board.
4. Tiers: a roster with one C-eligible player and 0 bench C → C tier thin/critical; adding a top-24 C → solid/deep.
5. Partners: constructed league where team B needs C and I have C surplus → B is partner #1; targets include a C-for-G swap with both Δ within rules.
6. Manual mode: `POST /manual` with 13 ids returns `estimated: true` and the same shape.
7. Routes: 400/404/429/503 paths; 60 s cache (two calls, one upstream fetch, via a counting fake client).
8. **Backtest** (D7): league `1270568574406107137`, weeks 5–20 of 2025-26: weekly rosters from `/matchups/{w}` (`players`, `starters`), board built as-of the Monday of week w (`buildBoard(data, { now })`, 2025 logs only, no projections = the model's no-hindsight protocol), predicted `strengthNow` per team-week vs actual `matchup.points`. Assert Spearman ≥ 0.5 over all team-weeks and that the predicted weekly winner matches the actual winner in ≥ 60% of matchups. Record the numbers in `docs/nba-team.md`. (Cache the matchup pulls under `data/nba/cache/backtest-2025/`, gitignored.)
9. Browser: 375 / 1280 screenshots of empty, manual, connected (real league via `nba-sleeper-live-check.js --keep`), detail; 0 console errors, no horizontal scroll (same harness as `scripts/nba-sleeper-screens.py`).

---

## 6. Stream D (optional data enrichment; starts after A merges)

Gap found: usage. Sleeper per-game rows carry `fga, fta, tpm, oreb, dreb, plus_minus` but the compact log format (2) stores only `pts, reb, ast, stl, blk, to, pf, tf`. D bumps `scripts/nba-ingest.js` / `nba/model/sleeper.js` to **format 3** (`[day, week, hs, min, pts, reb, ast, stl, blk, to, pf, tf, fga, fta, tpm, ff]`), regenerates `data/nba/logs-2025.json`, keeps `data.js` format-guarding, and fills `signals.usage`: `usageRate ≈ (fga + 0.44·fta + to) / min` per game, season vs last 5, trend at ±0.03. Also lets `ff` score (§3.1). No other consumer changes. Acceptance: `test-nba-model.js` and `test-nba-profile.js` unchanged results (hs column identical), new `scripts/test-nba-ingest-format3.js`, and the ingest cross-check vs ESPN still passes.

Nice-to-have, not in D: Sleeper trending counts as a "crowd interest" chip on both pages (already served by `/api/nba/trending`).

---

## 7. Parallelisation plan

Base for every stream: branch `nba-spec` (this doc + stubs + fixtures), which is `origin/main` ce802d8 + two commits. Worktrees under `~/projects/pocket-nba-wt/`.

| Stream | Branch / worktree | Model | Owns (disjoint) | Inputs | Outputs | Must pass |
|---|---|---|---|---|---|---|
| **A** shared layer | `nba-shared-layer` / `pocket-nba-wt/nba-shared-layer` | **Opus**, `thinking: xhigh`, `runTimeoutSeconds: 7200` | §3.5 row A | this doc §3–4.3, fixtures, stubs, contract test | `profileFromSleeper` hardened, `leagueContext`, `injury-eta`, `signals`, `roster-analysis`, board ETA availability, `/api/nba/players?league_id=`, `LC.profileFor` Sleeper path, `docs/nba-shared-layer.md` | `node scripts/test-nba-spec-contract.js` (all live-output checks on), `node scripts/test-nba-shared.js` (new: ETA rule table, signals on 5 fixture players, roster tiers, calendar vs `sleeper-schedule-weeks-2026.json`, 2025 league profile = 23 weeks), existing `test-nba-model/profile/trade/lineup/waivers/sleeper`, `npm test` exit 0, `node scripts/nba-sleeper-live-check.js` 25/25 |
| **B** trade v2 | `nba-trade-v2` / `pocket-nba-wt/nba-trade-v2` | **Opus**, xhigh, 7200 s | §3.5 row B | §4; codes against fixtures `signals.example.json`, `roster-analysis.example.json` until A merges, then rebases | engine v2, route v2 (+ `?league_id=&partner=&give=&get=` prefill), UI (value axis, fit panel, per-player why, horizon/lean controls), `docs/nba-trade.md` v2 section, validate table re-run | `node scripts/test-nba-trade.js` (§4.6 1–10), `node scripts/nba-trade-validate.js --md` under the Sleeper profile, `npm test`, 375/1280 screenshots (`scripts/nba-trade-mock.js` + Playwright) with 0 console errors |
| **C** team page | `nba-team-page` / `pocket-nba-wt/nba-team-page` | **Opus** for `team-analysis.js` + backtest, **Sonnet** acceptable for `team.html/js/css` if split into C1/C2 (C2 starts from C1's fixture `team-analysis.example.json`) | §3.5 row C | §5; fixtures `league-context.example.json`, `roster-analysis.example.json` | `team-analysis.js`, `routes/team.js`, page, nav entry, sitemap, backtest script + numbers in `docs/nba-team.md` | `node scripts/test-nba-team.js` (§5.4 1–7), `node scripts/nba-team-backtest.js` (8), `npm test`, screenshots (9) |
| **D** enrichment (optional) | `nba-data-enrich` / `pocket-nba-wt/nba-data-enrich` | **Sonnet** | §3.5 row D | A merged | format-3 logs, `usage` signal, `ff` scoring | `test-nba-model`, `test-nba-profile` unchanged results, new ingest test, `npm test` |

**Merge order:** A → (B, C rebased on A, in either order; the only overlap is one router line and the NAV list, both C's) → D → lead integration branch `nba-trade-team` → full `npm test` + Playwright pass on all five NBA pages + the new one → Checker → Dillon pushes `main` (Railway). Never push from a stream.

**What B and C can do before A merges (day 1):** everything except the real `signals`/`roster-analysis` calls: build against the example fixtures (they are the contract), write UI + tests with a local fake that returns the fixtures (`NBA_SPEC_FIXTURES=1` is reserved for that), and use `profileFromSleeper` (already real) for the calendar/slots. When A lands, swap the fake for the import; the contract test proves the shapes match.

**Maker brief must end with** (per AGENTS.md): the Discord delivery line for channel `1559698756960657524`, the verification commands above, "do not push, do not touch Railway", and the Co-Authored-By line.

### Checker plan (one fresh Checker per stream, then one integration Checker)

Each Checker re-runs the stream's commands itself (never trusts the Maker), then tries to break it:
- A: feed a categories league, a league with `IR` in `roster_positions`, `reserve_slots` 0, `playoff_round_type` 1/2, `trade_deadline` 99, an ESPN row with a name collision (two "Jaylen Brown"-style cases → must return null), ESPN offline (fetch throws) → board still builds; assert `getPlayers({ profile })` memo key changes when the profile changes; diff Jokić's `hsByWeek` with/without ETA for an OUT player.
- B: symmetry/reversal fuzz on 200 random trades from real rosters; NaN hunt; v1 client compatibility; 429/413; `partnerRoster` with ids not on the board; deadline passed; horizon `playoffs` before week 10 → 400; verify the 30-trade table rows by hand against the doc; screenshots by eye.
- C: order-invariance fuzz; 20-team league; team with 0 C-eligible players; a roster with 2 IL players (roster 2 and 5 today); 429 from Sleeper → manual card; backtest numbers reproduced within ±0.02 Spearman; nav shows "Team" on every NBA page; `/nba/team` 200 and `/nba/model/team-analysis.js` 404 (deny-list).
- Integration: `npm test`, all `scripts/test-nba-*.js`, live check, five+one pages at 375/1280 with 0 console errors and no horizontal scroll, and one real evaluation against league 1411447094215991296 (rosters 1 vs 2) whose numbers match a hand calculation of the typical lineup.

---

## 8. Risks and open questions for Dillon

1. **Keeper lens.** The league keeps 1 player (`max_keepers: 1`, redraft otherwise). Should the trade calculator and team page include a "keeper value" read (age ≤ 25, next-year market rank) as an optional toggle, or ignore keepers entirely? Default if no answer: ignore (no age factor), `lean: rebuild` removed.
2. **Verdict philosophy.** Plan keeps the verdict on *your lineup impact* (Accept/Counter/Decline) and adds a league-neutral *Value* fairness meter (market-aware). The NFL page does the reverse (value verdict WIN/FAIR/LOSE, fit as an overlay). OK to keep lineup impact as the headline on NBA, or do you want the NFL-style value verdict as the headline?
3. **ESPN injuries as a dependency.** Return dates come from an unofficial ESPN endpoint (works today, cached hourly, degrades to the current guesses when it fails). Fine to rely on it, or keep the calculator free of non-Sleeper sources?

Known risks (no answer needed): the Sleeper week numbering vs `/matchups/{week}` is re-checked on Oct 21 (A test); `game_mode: 1` is assumed to be the High Score mode (proven by data, not by docs); the market prior is preseason-only by design; `ff` can't score until logs carry it (D); preseason form/minutes are last season's and are labelled stale.
