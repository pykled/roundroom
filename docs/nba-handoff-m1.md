# M1 handoff — market blend (Yahoo-first)

Branch `nba-m1-market`. New files only: `nba/model/market.js`, `nba/routes/market.js`, `scripts/nba-market-build.js`, `scripts/test-nba-market.js`, `docs/nba-market-blend.md`, `data/nba/market.json`. No edits to model/router/pages/package.json.

## Wire into the board
1. Static file (simplest, no router edit): `require('./data/nba/market.json')` / HTTP route below; join rows to board players by `id` (model player id) — or by `yahooPid` once H1 attaches it (market.js honors `player.yahooPid` before name matching).
2. Route: in `nba/router.js` add `router.use('/market', require('./routes/market'));` → `GET /api/nba/market` (`{available, asOf, weights, sources, rows}`; returns `{available:false,rows:[]}` if the file is missing).
3. Pure function (to rebuild live with the profile-aware model): `require('./model/market').buildMarket({players, yahooSnapshot, adpSources})` — players need `{id,name,team,pos,rank}`.
4. UI: show `marketRank`, `adpDelta`, `label` (value/reach/fair, `strong`), `contested` (show range from `sourceRanks`), grey out when `confidence < 0.4` or `thin`. Label "market (Yahoo-first)". Never sort the board by it.
5. Simulator bots: draft by `marketRaw` (noisy) instead of the model.
6. Add `node scripts/test-nba-market.js` to the `npm test` chain (not done: package.json not mine).
7. After H1 merges: `node scripts/nba-market-build.js` again, commit `data/nba/market.json`.

## Notes
- FantasyPros automated fetch stays OFF (ToS: personal-use-only copy clause; see docs). Manual path: `--fantasypros-csv`.
- `data/nba/adp-cache/` is generated; don't commit.
