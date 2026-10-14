# Handoff: stream L1 (lineup / trade / waivers fitted to league 242808)

Branch `nba-l1-tools` (worktree `~/projects/pocket-nba-wt/l1-tools`), off `nba` @ 6146b95. Not pushed.

## Merges
`nba-d-lineup`, `nba-e-trade` and `nba-f-waivers` are merged in that order. The only conflict each time was `nba/router.js`, and every resolution kept both sides: the integration branch's diagnose route + profile/market mounts, plus the lineup, trade and waivers mount lines (`nba/router.js:506-508`). `lineup.html` took D's real picker. `package.json` keeps every script and adds the three suites to `npm test`.

## What changed
Every scoring, slot, week and limit input comes from `nba/league-profile.js` (`getProfile`). The default is 242808; leagues without a stored profile get `highScoreDefaultProfile()`, which still works and is tested in every suite.

| Tool | Changes | Docs |
|---|---|---|
| Shared | **New** `nba/model/roster-slots.js`: exact 9-slot assignment (matroid greedy + augmenting paths, checked against brute force), Yahoo eligibility (C-only not F-eligible; G/F wing fills SG/G/SF/F; 2 UTIL), Yahoo slot names → profile slots, starter-scaled bench shares, IL eligibility, matchup-week windows, game days. **New** `nba/routes/league-context.js`: league_key/league_id → profile, ET today, imputed team dates, profile summary. | — |
| Lineup | 9 slots, profile matchup windows (6-day week 1, 14-day weeks 7/17), games left from the real schedule (exact back-to-backs), IL spots + "move to IL" suggestions + healthy-in-IL / roster-over warnings. Banked score and forfeit warnings unchanged. Page: profile slot picker incl. IL, week labels with dates, a day strip that scrolls on phones, roster-spot card, league scoring text. | `docs/nba-lineup.md` § League profile |
| Trade | Profile slots/roster (14 active + IL in use), bench share ×starters/6 (18/10.5/6/3/1.5%), empty slots on full rosters filled at waiver level (fixed a +32/wk artifact), playoffs 20-22 ×1.5, deadline/commissioner/protest/no-pick rules in `meta.rules` and on the page. Accept/Counter/Decline re-validated on 30 real-board trades; thresholds unchanged. | `docs/nba-trade.md` § League profile + table |
| Waivers | Profile slots/IL (auto IL in manual mode), 10 adds/week budget (`adds`), waiver-priority cost (rolling list, tunable `PRIORITY_MODEL`), `claimNet` + advice (add / claim / save-priority / no-adds-left), FA vs W status, W claims miss today's game, profile matchup weeks mid-week, shared bench curve. Page: budget card, priority input, FA/W badges, C filter, rules notes. | `docs/nba-waivers.md` § League profile |
| All pages | `<body class="sport-nba">`, the static NBA link set (Draft board, Lineup, Trade, Waivers), basketball wording. | — |

## Edits outside my tools (small, additive)
- `nba/league-profile.js`: new profile fields `maxAddsPerSeason`, `waivers {type, days, postDraft, freeAgentAdds, ilTakesInjuredDirectly}` and `trades {review, protestDays, draftPickTrades, maxTrades}` on both profiles. Nothing else changed; `test-nba-profile.js` passes.
- `nba/model/roster-slots.js` is new. No existing B/H1 model file was edited (`slots.js`, `board.js` and `data.js` are only imported).
- Mocks `scripts/nba-{lineup,trade,waivers}-mock.js` now pass the profile id through to `getPlayers`.
- No edits to `shared/nav.js`, `shared/styles.css`, `server.js` or `nba/pages/draft.*`.

## For the lead: nav entries to add (`shared/nav.js` on `nba-n1-home`, `NBA_LINKS`)
```js
{ href: '/nba/trade',   label: 'Trade',   match: /^\/nba\/trade\/?$/ },
{ href: '/nba/waivers', label: 'Waivers', match: /^\/nba\/waivers\/?$/ },
```
These go after the existing Draft board and Lineup entries. The three pages already ship this exact link set statically, so N1's `enhance()` keeps them (it only rewrites links when none point at `/nba`).

## Tests (real exit codes, 2026-10-13)
lineup 34 ✓, trade 28 ✓, waivers 32 ✓, ui 76, profile 31, model 18, market 67, adp 9, cheatsheet 60, hardening 31, integration 7, yahoo 62. Every suite exits 0, and so does `npm test`.

New coverage: 9-slot assignment vs brute force (300 rosters), C/F eligibility, IL (in IL / move to IL / healthy in IL / over cap), 14-day windows + schedule game counts = board `gamesByWeek` (weeks 1/7/17), banked/forfeit under 9 slots, profile swap (HS defaults vs 242808) in all three engines, priority-cost monotonicity/zero/tuning, add-limit budget (10 / 1 left / 0 left), W claim misses today, trade IL cap, waiver-filled holes, trade rules/deadline, 30-trade threshold run.

## Browser check
`DATABASE_URL= PORT=7997 node --env-file=.env.local server.js`, then `python3 scripts/nba-l1-screens.py`. Manual mode, real `/api/nba/players`, a 14-man roster from the top-60 board plus Jimmy Butler (Out) on IL; 0 console errors.
Screenshots (`docs/nba-ui/`):
- `l1-lineup-wk7-{375,1280}.png` (14-day week, day 5, banked scores)
- `l1-lineup-wk7-375-{top,result}.png`
- `l1-lineup-wk1-{375,1280}.png`
- `l1-trade-{375,1280}.png`
- `l1-waivers-{375,1280}.png`
- `l1-waivers-late-{375,1280}.png` + `-375-{top,list}.png`

Defects found and fixed while driving the pages: the week label was clipped; the after-trade table struck through players who only changed slots; waiver chips showed Sleeper positions; three bench spots earned no depth credit (every bench move read 0.0); "drop X" was shown on 0.0 rows.

## Open risks
- **Yahoo mode not driven in a browser** (no connected account here); it's covered by route tests with mocked clients only. `teamWaiverState` (waiver_priority, roster_adds) is a raw-scan adapter that hasn't been checked against a real response. A's parser could expose both fields.
- **IL eligibility** (Out/IR/INJ/NA, not DTD/GTD) is an assumption. Yahoo's own IL check wins.
- **Priority-cost constants** (1 breakout per 2 weeks, lift 6/wk, 35% rival claim rate) and the bench curve scaling are heuristics, not backtested.
- A High Score Yahoo league's frontcourt slot arriving as `F` is mapped to FC when the league has no SF/PF/C slots (inferred).
- Inherited: DD/TD bonus semantics unverified (`profile.unverified`); lineup lock timing per D's notes.
