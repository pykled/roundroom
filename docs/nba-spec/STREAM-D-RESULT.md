# Stream D result — data enrich (format 3 logs)

Branch `nba-data-enrich` (from `nba-spec` 221f7f8). No push, merge, deploy or prod DB.

## What changed
| File | Change |
|---|---|
| `nba/model/sleeper.js` | `LOG_FORMAT = 3`; rows are `[day, week, hs, min, pts, reb, ast, stl, blk, to, pf, tf, fga, fta, tpm, ff]` (`STAT_KEYS_EXT`). Projection `FORMAT` stays 2. `mergeLogs` refuses to splice files of different formats (takes the fresh file). |
| `nba/model/data.js` | `readBest(name, minFormat)`: logs ignore any runtime-cache/snapshot copy older than format 3 (when a newer one exists), and `refresh()` drops a non-format-3 current-season log so the season backfills whole. Format-2 snapshot alone still loads (graceful). |
| `scripts/nba-ingest.js` | new `--logs-only` flag (regenerates `logs-*.json` only, no players/proj/ESPN). |
| `data/nba/logs-2025.json` | regenerated, format 3 (1362 KB). Verified vs the old file: 29,127 played rows, first 12 columns identical for every row, `rw`/`teamGames` identical → `hs` column unchanged. 480 rows carry ff > 0 (incl. TEAM_* rows). |
| `nba/model/usage.js` (new) | pure `usageStats(rows)` → `{fga, fta, usageRate, last5, trend, games}`; usageRate = Σ(fga + 0.44·fta + to) / Σmin, last-5 vs season, trend ±0.03; nulls (never NaN) for format-2 rows / < 40 min. |
| `scripts/test-nba-ingest-format3.js` (new) | 10 tests: compaction, defaults, DNP/rw, merge guard, committed-file invariants, loader cache guards, usage formula/trend/nulls, real-data plausibility. |
| `scripts/test-nba-research.js` | one assertion widened (`row.slice(4, 12)`) + asserts the new columns; the old one pinned row length 12. |

## Left for A / lead (outside D's allowed files)
1. **`nba/model/score.js` (A)**: add `ff: 15` to `COL` and `'ff'` to `LINEAR` (`gameScore` already reads `line.ff`; `rowLine` iterates `COL`). `ROW_LEN` stays 12 so format-2 rows still score (ff = 0). Until then `ff` contributes 0, as league-sync's `unverified` note says.
2. **`nba/model/signals.js` (A)**: fill the `usage` block with `require('./usage').usageStats(logRows)` (`usage.fga/fta/usageRate`, `trend` ← `.trend`). Not edited per instructions.
3. **`package.json` test line (lead)**: append `&& node scripts/test-nba-ingest-format3.js`.

## Verification
- `node scripts/test-nba-ingest-format3.js` → exit 0, 10/10.
- `test-nba-model.js`, `test-nba-profile.js`, `test-nba-spec-contract.js` → exit 0 (unchanged results).
- `npm test` → **exit 1**, caused by `scripts/test-nba-hardening.js` ("GET logout 405": gets 410). **Pre-existing on the base**: same failure with my changes stashed (nba-spec 221f7f8); `nba/router.js:215` returns 410 since commit 24e1896 and the test still expects 405. A-owned; not touched.
- Every other script in the `npm test` chain, run individually → exit 0 (28/29 + hardening). `npm test` short-circuits at hardening, so run them individually as above to see the rest.
- ESPN cross-check data (`espn-check.json`) untouched; model test that asserts against it passes.

MAKER_STATUS: DONE
