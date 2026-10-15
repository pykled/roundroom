# Pocket NBA — Sleeper-first league sync

As of 2026-10-15 the NBA side of Pocket (`/nba`, `/nba/research`, `/nba/lineup`,
`/nba/trade`, `/nba/waivers`) syncs with **Sleeper**, not Yahoo. Yahoo blocked
Pocket's Fantasy API access; Sleeper's API is public and unauthenticated, and
Dillon's league ("HALIMSANITY 26-27") now lives there. The NFL side already
synced Sleeper by username, and the NBA model was Sleeper-keyed all along, so
"connecting" is just remembering a Sleeper username on the device.

## What was verified against the live API (2026-10-15)

Probed with curl + `scripts/nba-sleeper-live-check.js` (read-only; the report
it writes is `docs/nba-sleeper/live-check.json`). Recorded payloads live in
`scripts/fixtures/nba/sleeper/` (league `1411447094215991296`, draft
`1411447094215991297`, user `pykle` = `1044077615075872768`).

| Endpoint | Finding |
| --- | --- |
| `GET /v1/state/nba` | `{"season":"2026","league_season":"2026","season_type":"pre","season_start_date":"2026-10-20"}`. **The 2026-27 NBA season is `2026`** — `/user/{id}/leagues/nba/2027` returns `[]`, `/2026` returns the current league. `nba/sleeper/map.js currentSeason()` reads `league_season`, cached 1 h. |
| `GET /v1/user/{username}` | 200 + full user for a known name, **200 + `null`** for an unknown name (not 404). The route maps `null` → 404 `sleeper_user_not_found`. Usernames are `[A-Za-z0-9_.-]{1,32}`; a leading `@` is stripped. |
| `GET /v1/user/{id}/leagues/nba/{season}` | Array of leagues: `league_id`, `name`, `status` (`pre_draft` / `drafting` / `in_season` / `complete`), `total_rosters`, `draft_id`, `roster_positions` (flat list, e.g. `["PG","SG","G","SF","PF","F","C","UTIL","UTIL","UTIL","BN",…]`), `scoring_settings`, `settings` (`num_teams`, `reserve_slots` = IR spots, `playoff_week_start`, `waiver_type` 0 rolling / 1 reverse standings / 2 FAAB, `waiver_budget`, `trade_deadline`, `type` 0 redraft / 1 keeper / 2 dynasty, `max_keepers`). |
| `GET /v1/draft/{id}` | `status` (`pre_draft` / `drafting` / `paused` / `complete`), `type` (`snake` / `linear` / `auction`), `start_time` (ms), `last_picked` (ms), `draft_order` (`{user_id: slot}`, `null` until the order is set), `slot_to_roster_id` (`{slot: roster_id}`), `settings.teams`, `settings.rounds`, `settings.pick_timer` (seconds; 30 in Dillon's league), **`settings.reversal_round`** (3 = third-round reversal, 0 = plain snake), `settings.slots_pg/…/slots_bn`, `metadata.scoring_type` (`std`), `metadata.is_autopaused`. |
| `GET /v1/draft/{id}/picks` | One row per pick: `pick_no`, `round`, `draft_slot`, `roster_id`, `picked_by` (user_id), `player_id`, `is_keeper`, `metadata` (`first_name`, `last_name`, `team`, `position`, `injury_status`). 156 rows for the real 12×13 draft. |
| `GET /v1/draft/{id}/traded_picks` | `[]` in the real league; shape `{season, round, roster_id (original), owner_id, previous_owner_id}`. `pickOrder()` moves ownership for that round only. |
| `GET /v1/league/{id}/rosters` | `roster_id`, `owner_id`, `co_owners`, `players` (Sleeper ids), `starters`, `reserve` (IR), `settings.waiver_position`, `settings.total_moves`. |
| `GET /v1/league/{id}/users` | `user_id`, `display_name`, `avatar`, `metadata.team_name`. |
| `GET /v1/league/{id}/matchups/{week}` | `roster_id`, `matchup_id`, `players`, `starters`; the opponent is the other roster with the same `matchup_id`. |
| `GET /v1/players/nba` | 2.5 MB map; 644 active players with a team (the model's `data/nba/players.json` is built from it). |
| Headers | `cache-control: public, s-maxage=30, stale-while-revalidate=300`; no rate-limit headers seen (Sleeper documents ~1000 req/min). The server caches draft views 3 s (pooled), league/users 60 s, rosters 30 s, usernames 10 min. |

**Reversal round.** `draft.settings.reversal_round = 3` reproduced Sleeper's own
`draft_slot` on all 156 real picks with `slotForPick(pick, teams, 3)` (0
mismatches; `scripts/test-nba-sleeper.js` pins this). The board's
`thirdRoundReversal` flag maps to 3; other values are carried as
`settings.reversalRound` and `roundForward()` generalises them.

**Id matching.** Sleeper pick `player_id`s are the model's own ids: **156/156
real picks (100%) resolve directly**, 0 unmatched; every roster player in the
league (13 × 12) resolves too. Picks whose id isn't on the board (deep bench /
two-way players the model trims) go through a name+team fallback
(`nba/model/names.js matchYahooPlayer`, reused) and, failing that, land in the
board's **Review** list with their name — a pick is never silently dropped.

**League classification.** `points` when `scoring_settings` exists and the draft
`metadata.scoring_type` isn't category-like; `categories` when it is (the board
then shows the existing "recommendations off / tracker" notice); `auction` from
`draft.type` (manual mode notice, as before). Dillon's league: snake, points,
3RR, 13 rounds, 30 s picks, 12 teams, 2 IR.

## Server

- `nba/sleeper/client.js` — fetch with an 8 s timeout, one retry on 5xx / network
  errors, typed `SleeperError` (`sleeper_not_found` 404, `sleeper_rate_limited`
  429 + `Retry-After`, `sleeper_timeout` 504, `sleeper_upstream` 502,
  `sleeper_bad_request` 400).
- `nba/sleeper/map.js` — pure mapping (status, `pickOrder` with traded picks,
  `normalizePicks`, `teamsFromLeague`, `myTeamKey`, `classifyLeague`,
  `leagueSummary`, `draftMeta`, `leagueMeta`, `currentSeason`).
- `nba/routes/sleeper.js` — `/api/nba/sleeper/user|leagues|league|draft|rosters|matchup`
  (public, per-IP rate limited 240/min, pooled through `apiCached`). Shapes keep
  the board's vocabulary: `team_key` = roster_id as a string, `player_key` =
  Sleeper player_id, `sleeperId` = board id.
- Lineup / Trade / Waivers accept `league_id` (+ `roster_id`) and read Sleeper
  rosters; their Yahoo `league_key` paths answer 410 unless `NBA_YAHOO_ENABLED=1`.

## Board behaviour

- Connect = enter a Sleeper username (setup card or the nav chip). Remembered in
  `localStorage['pocket-nba-sleeper']`; the NFL side's `rr_username` pre-fills
  the field. "Switch account" / "Disconnect" live in the chip menu.
- Leagues for the current season are listed with team count, draft state or
  scheduled time, scoring and 3RR; one league auto-selects; the choice is saved.
- From Sleeper, winning over manual settings and locking the matching fields:
  teams, roster slots (`roster_positions` + `reserve_slots` → IL), rounds, the
  reversal round, pick timer, my slot (`slot_to_roster_id` → `draft_position`;
  falls back to the published pick order or my first synced pick), every pick,
  who's on the clock (Sleeper's full pick order, so keepers and traded picks are
  right). The pick clock is anchored to `draft.last_picked`.
- Draft order not set yet → the slot picker shows (chips) until Sleeper has it.
- Polling: 4 s while drafting (and when a scheduled draft is within 15 min), 12 s
  idle, 10 s in a hidden tab during the draft, exponential backoff to 30 s on
  errors, paused in a hidden tab otherwise.
- Errors: unknown username (inline), 0 leagues, not in league (manual slot),
  categories/auction (existing notices), 5xx / timeout / 429 (degraded banner +
  Retry Now, manual picks marked PENDING until Sleeper confirms).

## What was not converted / known risks

- **Matchup-week calendar.** Values, lineups and waivers still use the stored
  242808 profile (Yahoo-era weeks: 14-day weeks 7 and 17). Sleeper's NBA week
  numbering (`settings.leg`, `/matchups/{week}`) may differ; verify once the
  season starts (2026-10-20).
- **Positions.** The model now uses Sleeper `fantasy_positions` for slot
  eligibility (`positionSource: 'sleeper'`, `eligConfidence: 'sleeper'`); the
  Yahoo snapshot only feeds preseason rank / % rostered. Cooper Flagg is
  PG-eligible on Sleeper (Yahoo had him SG/SF/PF).
- **Waivers.** Sleeper exposes no "adds used this week" and no waiver-wire list
  (players on waivers vs free agents); the page shows "not reported" and the
  pool is every model player on no roster. FAAB leagues are detected
  (`waiver_type` 2).
- **Lineup slots.** Sleeper has no daily slot assignments for NBA; every active
  player enters as bench and the optimizer assigns; `reserve` = IL.
- Sleeper outages degrade to manual mode everywhere; nothing is written to
  Sleeper.

## Re-enabling Yahoo later

Set `NBA_YAHOO_ENABLED=1` (Railway var) and restart. `nba/router.js` then mounts
`nba/yahoo/routes.js` (OAuth under `/nba/auth/*`, `/api/nba/yahoo/*`,
diagnose) and the legacy Yahoo paths of the lineup/trade/waivers routes
(`league_key` + `team_key`). Stored tokens (`nba_yahoo_tokens`), nonces and the
`YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` / `NBA_TOKEN_KEY` vars were left
untouched. The UI no longer has a Yahoo connect flow; the old chip
(`nba/pages/yahoo-chip.js`) was removed in this change and would need to come
back from git history (`git show 0f49fe9:nba/pages/yahoo-chip.js`), and
`data/nba/yahoo-snapshot-242808.json` still powers the market layer.

## Tests

- `node scripts/test-nba-sleeper.js` — map/client/routes/draft-logic (recorded payloads).
- `node scripts/nba-sleeper-live-check.js` — read-only run against the real API (24/25 → 25/25 after a test fix; `--keep` leaves it up for the real Playwright pass).
- `node scripts/nba-ui-mock.js --port=4795 & BASE=http://127.0.0.1:4795 python3 scripts/nba-sleeper-screens.py` — 375/1280 scenarios, screenshots in `docs/nba-sleeper/`.
- `REAL=http://127.0.0.1:4796 python3 scripts/nba-sleeper-screens.py --real` (with `node scripts/nba-sleeper-live-check.js --keep --port=4796`) — board/lineup/trade/waivers against real data.
