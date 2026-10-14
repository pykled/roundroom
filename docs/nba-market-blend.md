# NBA market blend (stream M1) — Yahoo-first consensus + reach/value layer

Built 2026-10-13 for league 242808 (Yahoo, 12-team snake, custom scoring, 9 starters). Code: `nba/model/market.js` (pure), `scripts/nba-market-build.js` (fetch + write), `nba/routes/market.js` (read-only HTTP, not mounted), `scripts/test-nba-market.js`, output `data/nba/market.json`.

## Read this first: what market rank is NOT
ADP/rank sources come from drafts under **different scoring and roster formats** (ESPN default, Sleeper mixed, FantasyPros' Yahoo column from Yahoo *default* drafts). Only Yahoo's pre-season rank is specific to this league, and even it is Yahoo's generic projection, not High Score. So `marketRank` is:
1. a **sanity / reach-value layer** (is the model far from the room?), and
2. a **model of how opponents will draft** (feed it to the simulator's bots).

It is **not** the board's primary value. The board's primary value stays the league-scored model (`hsValue`, `rank`). Never reorder the board by ADP; use `label`/`adpDelta` as context and as a tiebreaker.

## Sources, Yahoo first
| key | source | role | weight |
|---|---|---|---|
| `yahoo_pre` | `data/nba/yahoo-snapshot-242808.json` `preRank` (Yahoo's own pre-season rank for THIS league, 725 players, read from Dillon's session) | primary; also source of truth for identity, positions, injury tag | **0.40** |
| `fantasypros_yahoo` | FantasyPros ADP page, Yahoo column (opt-in / CSV only) | Yahoo-draft crowd | 0.25 |
| `espn` | ESPN fantasy API `averageDraftPosition` (top ~133) | crowd | 0.20 |
| `sleeper` | Sleeper projections `adp_std` (top ~281 with a team) | crowd | 0.15 |

`yahooCurRank`, `yahooPctRos`, `fanPts` are carried/used for validation but are not consensus inputs (curRank/pctRos reflect last-season results and roster churn, not draft price).

Each crowd source is converted to an **ordinal rank over its own full list** before matching (so ESPN's 1.43 and Sleeper's 2.5 land on the same 1..N scale as Yahoo's ranks; unmatched rows still occupy a slot). Yahoo `preRank` is already ordinal.

## Consensus
`marketRaw = weighted median` of the available source ranks using the weights above, **renormalized over the sources that list the player** (a missing source never drags a rank; weights only matter relatively). Exactly-half cumulative weight → midpoint of the two straddling values. Then `marketRank` = dense ordinal 1..k of `marketRaw` over the matched model players that have any signal (ties broken by Yahoo preRank, then name), so it sits on the same population/scale as `modelRank`. Players in no source get `marketRank: null` and no label — "not in any list" is never treated as "very late".

- `spread` = max − min of the source ranks. `contested` = ≥2 sources and `spread > max(20, 0.25·marketRaw)`.
- `thin` = exactly one source.
- `confidence` (0–1) = (0.5 + 0.5·weightCovered) × (0.4 + 0.6·agreement); thin capped at 0.5.
- `adpDelta = marketRank − modelRank`. **Positive = model likes him more than the room (value); negative = reach if drafted at market.**
- `label`: `band = max(3, 0.15·modelRank)` (×1.5 if contested). `adpDelta ≥ band` → `value`; `≤ −band` → `reach`; else `fair`. `strong` = beyond 2×band. Not labeled (`null`) when both ranks are deeper than 250 (192 picks in this draft; deeper is noise).

## Output (`data/nba/market.json`, rows only for players with a market rank)
`{builtAt, asOf, fetchStatus, weights, params, stats (per-source match rates), validation, unmatched, rows:[{id,name,yahooPid,yahooPreRank,yahooCurRank,yahooPctRos, adp:{espn,sleeper,fantasypros_yahoo,yahoo_derived}, sourceRanks, marketRaw,marketRank,modelRank,adpDelta,label,strong,band,contested,spread,sources,thin,confidence}]}`. `adp.yahoo_derived` is Yahoo's preRank (ordinal scale); `adp.espn/sleeper/fantasypros_yahoo` are the raw ADP numbers.

Matching: `yahooPid` on the model player (H1) if present, else `matchYahooPlayer` from `nba/model/names.js` (normalized name + team + position; diacritics, Jr./III suffixes, aliases). Test fixtures cover Jokić, Şengün, Porziņģis, Jaquez/Trent/Carter/Jackson/Porter Jr. and Yahoo's mixed-case teams ("Mil").

## Real run (2026-10-13)
| source | matched / total | rate |
|---|---|---|
| yahoo_pre | 602 / 725 | 83% |
| espn | 133 / 133 | 100% |
| sleeper | 281 / 281 | 100% |

The 123 unmatched Yahoo rows are all rank 260+ players absent from the model's player list (e.g. Westbrook, Valančiūnas, Batum, D'Angelo Russell, Kevin Love — unsigned/deep bench); none are in a 12-team draftable range. Full list in `market.json` → `unmatched`.

## Validation against reality
Spearman rank correlation, Yahoo `preRank` vs rank of last-season Yahoo-league `fanPts` (this league's scoring, snapshot data): **ρ = 0.902 over 507 players; ρ = 0.864 over the top 100.** The pre-season rank is therefore a strong, league-relevant prior, which justifies the highest weight. Model rank vs market rank: ρ = 0.902 over 602 players (broad agreement; the interesting part is the tails below). Asserted in `scripts/test-nba-market.js` (ρ > 0.7).

## Top 25 largest model-vs-market gaps (rank ≤ 200 on either side)
Model = `rank` from `nba/model` (default profile at build time; **re-run the build after H1's profile-aware model lands**, the gaps will move).

| Player | Model | Market | Δ | Label | Yahoo pre | ESPN ADP | Sleeper ADP |
|---|---|---|---|---|---|---|---|
| Bennedict Mathurin | 461 | 160 | -301 | reach (strong) | 160 | - | 137.8 |
| Dennis Schröder | 385 | 188 | -197 | reach (strong) | 188 | - | 189.3 |
| Jamaree Bouyea | 182 | 377 | +195 | value (strong) | 394 | - | - |
| Dereck Lively | 360 | 183 | -177 | reach (strong) · contested | 183 | - | 138.7 |
| Jordan Poole | 341 | 190 | -151 | reach · contested | 190 | - | 142.8 |
| Jeremiah Fears | 63 | 185 | +122 | value (strong) · contested | 185 | 125.01 | 162.4 |
| Isaiah Stewart | 291 | 174 | -117 | reach (strong) | 174 | - | 206.2 |
| De'Anthony Melton | 144 | 250 | +106 | value (strong) · contested | 250 | - | 181.7 |
| Robert Williams | 284 | 195 | -89 | reach (strong) | 195 | - | 151.6 |
| Jamal Shead | 143 | 225 | +82 | value (strong) | 225 | - | - |
| Kyle Filipowski | 124 | 204 | +80 | value (strong) | 204 | - | 194.3 |
| Precious Achiuwa | 130 | 210 | +80 | value (strong) | 210 | - | - |
| Rui Hachimura | 199 | 119 | -80 | reach · contested | 119 | - | 173.1 |
| Nikola Vučević | 244 | 167 | -77 | reach · contested | 167 | 117.06 | 85.7 |
| Max Christie | 178 | 253 | +75 | value (strong) | 253 | - | 297.5 |
| Jaylon Tyson | 157 | 231 | +74 | value (strong) | 231 | - | 243.3 |
| Daniss Jenkins | 113 | 184 | +71 | value (strong) · contested | 184 | - | 261.1 |
| Jarace Walker | 197 | 267 | +70 | value (strong) | 268 | - | - |
| Zach LaVine | 172 | 103 | -69 | reach (strong) | 103 | 125.22 | 89.8 |
| Jake LaRavia | 229 | 164 | -65 | reach · contested | 164 | - | 244.8 |
| Kris Dunn | 254 | 189 | -65 | reach | 189 | - | 221.2 |
| Noah Clowney | 169 | 232 | +63 | value (strong) | 232 | - | 292.6 |
| Khaman Maluach | 176 | 113 | -63 | reach · contested | 113 | - | 185 |
| Ivica Zubac | 116 | 54 | -62 | reach (strong) · contested | 54 | 89.02 | 41.8 |
| Grayson Allen | 239 | 177 | -62 | reach | 177 | - | 167.6 |

Patterns: (a) the model is much higher on **rookies/young guards** with little market signal (Fears, Queen, etc. — the model's projection vs a thin market) and (b) much lower on **veterans Yahoo/ESPN still price** (Mathurin, Schröder, Poole, Lively; several have model ranks 340–460, which may be a model-data gap — worth a manual look before trusting "reach"). Large `|Δ|` with `contested` is the weakest signal.

## FantasyPros: is automated access permitted?
Checked 2026-10-13:
- **Terms of Use** (`https://www.fantasypros.com/about/legal/`, © Marzen Media LLC): no sentence that mentions scraping/bots/crawlers, but §6 says all site content is copyrighted and "except for a single copy made for personal use only, you may not copy, reproduce, modify, republish, upload, post, transmit, or distribute any documents or information from this site in any form or by any means without prior written permission"; and "you agree not to sell, resell, reproduce, duplicate, copy or use for any commercial purposes any portion of this site". Automated bulk extraction is not expressly authorized and arguably falls under the copy/reproduce restriction; FantasyPros also offers an official API (free tier for personal non-commercial use, by request).
- **robots.txt**: `User-agent: *` disallows `/ajax/ /nfl/ranker/ /mlb/ranker/ /nba/ranker/ /api/ /json/ /xml/`; **`/nba/adp/overall.php` is not disallowed**; `Crawl-delay: 5`.

Verdict: robots.txt permits the path; the ToS does not clearly permit automated copying and has a personal-use-only copy clause. **Not clearly permitted → `--fantasypros` stays OFF by default** (and `ADP_FANTASYPROS=1` is the only other switch). If Dillon turns it on, it is one request to one page (the fetcher spaces requests ≥1.1 s and issues a single FP request, below any crawl-delay concern), cached 3 h, never polled during the draft. Dillon asked for FantasyPros, so the supported path is **manual import**:

```
# On fantasypros.com/nba/adp/overall.php, copy the table (or use their export) into a CSV with a header row:
#   Player,Team,Yahoo,ESPN,AVG      ("Nikola Jokic DEN-C" in Player is fine; blank Yahoo cells are skipped)
node scripts/nba-market-build.js --fantasypros-csv ~/Downloads/fp-nba-adp.csv
```
The CSV is read locally (no network), counted as source `fantasypros_yahoo` (weight 0.25), and reported in `fetchStatus.fantasypros_csv`. A column named `ADP` or `AVG` is used if there is no `Yahoo` column.

## Running
```
node scripts/nba-market-build.js            # fetch espn+sleeper (3 h cache), read Yahoo snapshot, write data/nba/market.json (exit 0 always)
node scripts/nba-market-build.js --offline  # no network (uses data/nba/adp.json if present)
node scripts/test-nba-market.js             # offline unit + real-snapshot validation
```
Run it as a pre-draft step, not from a request path. Rebuild once H1's profile-aware model is merged.

## Caveats
Yahoo preRank reflects Yahoo's pre-season rank at snapshot time (2026-10-14T03:31Z); injuries/news after that are not reflected. ESPN/Sleeper only list ~133/281 players, so deeper ranks lean on Yahoo alone (`thin`). `marketRank` re-ranks within matched model players, so it can differ by a few spots from Yahoo's raw `preRank` (players Yahoo ranks that the model lacks are dropped).
