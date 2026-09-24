**Fable — Trade algo role-change blind spot: design**

**1/5 · Diagnosis (it's worse than the Hot chip)**
`formMap` divides the last 2 games by `season_proj / 17` from `/api/projections/season`. Sleeper's season projection is effectively preseason — it never catches up. So a player who took over a backfield in week 3 reads "hot" **all season**, not just for a few days. And the Hot ×0.95 nudge is the small part: the VORP half of the blend (70%) is built from that same stale 8.7 pts/g, so Hubbard is undervalued by far more than 5%. Two bugs: (a) form label is inverted during a role change, (b) the value baseline itself never reprices a role change. Fix (a) surgically first, (b) next.

**What we already have (no new external source needed):**
- `/api/recent-stats` → per player `recent` (last 2 wks) + `season` avg of `carryShare / tgtShare / snapPct`. Lineup page uses it; **trade.html doesn't fetch it yet**.
- `/api/players/slim` → `[name, pos, team, injury_status, age]` — teammate IR/Out status is already client-side.
- `weekly-score.js` `stepUpMultiplier()` already encodes vacated-share + freshness (teammate had ≥15% season share, played in recent window). `lineup.html buildTeamOuts()` does the team/pos join. Reuse both.
- `fetchSleeperWeek('projections', w)` per-week projections, already cached by /api/trending. **Weekly projections are the contemporaneous expectation** — Sleeper refreshes them mid-week, so they lag a role change by ~3-4 days, not forever.
- Snap counts are already in the Sleeper stats feed (`off_snp/tm_off_snp`) — that's the fastest free usage signal there is (box score, Sunday night). Bonus corroborator already downloaded: `depth_chart_order` in `/v1/players/nfl` (not in slim yet). Beat-reporter tweets/X API: not free, skip. No verified public Sleeper news endpoint — don't build on it.

**2/5 · Logic: three layers, all pure functions in `shared/trade-fit.js`**

**Layer A — baseline swap (kills the permanent staleness).** `formSignal(games, projPerGame, opts)` gains an optional `opts.projGames` (per-game projections for the same weeks, most recent first). Baseline = `mean(projGames)` when ≥2 present, else `season/17` as today. Server: extend `/api/recent-points` to also return `proj: { week: { id: { pts_ppr, pts_half_ppr, pts_std } } }` for the same weeks (slimProj of the already-cached weekly projections) — one request, no new endpoint. Effect: once Sleeper's weekly proj reflects the new role, actual ≈ proj → no hot → chip clears on its own. Also decomposes "hot": actual ≫ this week's proj = true outperformance (legit sell-high); actual ≈ this week's proj but ≫ season/17 = projection catching up (role).

**Layer B — `roleSignal(usage, teammatesOut, pos, opts)`** → `{ label: 'up'|'down'|null, confidence, volRatio, share, sharePrev, snap, snapPrev, vacated, teammates, text }`. Two triggers, either fires:
- *Usage-confirmed (retrospective):* share key by pos (RB carryShare, WR/TE tgtShare). `up` when `recent - prior ≥ +8pp` AND `recent/prior ≥ 1.25`; `confidence: 'high'` if snapPct also +10pp, else `'med'`. `down` mirrored (−8pp, ≤0.75×, snap −10pp).
- *Injury-implied (prospective):* same-team same-pos teammate with `Out/IR/PUP/Doubtful`, season share ≥ 0.15 (STEP_UP_MIN_SHARE), fresh = played in recent window (his absence isn't in any projection yet). `vacated = Σ share×fresh`; `up` when vacated ≥ 0.15. This is the Hubbard-week-4 path: Brooks IR'd Wednesday, no box score shows it yet.
Server: add `prior` window to `/api/recent-stats` (all completed weeks except the recent 2). Today `season` includes `recent`, so at week 4 the delta is diluted to ~1/3 — `prior` gives the real before/after.

**Layer C — `gateForm(form, role, opts)`** returns the final entry `applyFactors` reads:
- hot + role up → `{ label: 'role-up', mult: 1.0, form, role }` — no sell-high discount, tag says buy/hold.
- cold + role down → `{ label: 'role-down', mult: 1.0 }` — symmetric: a benched RB is not a buy-low. Real false-buy-low guard we don't have today.
- hot + role up + `effRatio = ratio / volRatio ≥ 1.2` → still `role-up`, but tooltip adds "also running hot per touch — some per-touch regression possible". v1 keeps mult 1.0; don't stack.
- Dynasty: role up from a teammate's IR is temporary (he comes back next year) → label `role-up`, text says hold not buy, mult 1.0. Usage-confirmed up in dynasty: same.
- No usage data / week ≤ 2 → plain form as today (graceful).
`formMap(players, statsByWeek, weeks, proj, opts)` grows `opts.usage` (recent-stats players dict), `opts.teamOuts`, `opts.projByWeek`; signature stays backward-compatible. Move `buildTeamOuts` into trade-fit as `teamOuts(players, usage)` so lineup.html and trade.html share it.

**3/5 · False-positive guards (the "two big weeks vs soft D" case)**
Player with unchanged role: share Δ ≈ 0, no teammate out, volRatio ≈ 1, effRatio = ratio ≥ 1.2 → **stays 🔥 Hot**. Guards that keep it that way:
1. Absolute + relative share thresholds (8pp AND 1.25×) — a WR3 going 7%→10% is noise, not a role.
2. Share is primary, snaps corroborate only — garbage-time carries in a blowout move share without snaps → `med` confidence; `med` still gates (a wrong Hot is worse than a missed one) but the chip tooltip says "1 game of evidence".
3. Injury path requires *volume* teammate (≥15% share) and freshness — a depth piece on IR vacates nothing; a starter out 3+ weeks is already in the weekly proj (Layer A makes the hot ratio ~1 anyway).
4. Self-expiring: with Layer A the baseline catches up, so by week 8 Hubbard is just an RB1 whose two-week spike over his *new* normal is a real sell-high again. Without Layer A he'd be "role-up" forever — that's why A isn't optional.
5. Market corroborator (later, not a trigger): if `/api/trending` adds24h rank ≤ 10 for that player, bump confidence to high.

**4/5 · UI on trade.html**
- New pills next to 🔥 Hot / 📉 Cold: `⬆ Role up` (green — reuse `.pl-po.easy` palette: `rgba(16,185,129,.12)` / `var(--rb)`) and `⬇ Role down` (red — `.pl-inj` palette). Role pill **replaces** Hot/Cold when it gates (never both — two chips saying opposite things is the bug we're fixing). Same 0.6rem/999px pill style as `.pl-form`.
- Tooltip (role-up, injury path): "Role upgrade: Jonathon Brooks on IR (34% of carries, played last week). 19.0 pts/g vs 8.7 projected reflects the bigger role, not a hot streak — no sell-high discount. Projection hasn't caught up: lean buy." Usage path: "Carry share 38% → 61% over the last 2 weeks (snaps 55% → 78%) …".
- `valueTitle()` value chain gets a line: `× 1.000 (role up — hot signal suppressed)` so the number is never unexplained.
- Verdict/analysis text: wherever "sell high" copy is generated from `f.label === 'hot'`, treat `role-up` as its own branch ("X just got a bigger role — the market hasn't priced it yet").
- Data: trade.html adds `fetch('/api/recent-stats')` to the parallel load (it's the same call lineup.html makes, cached 1h server-side).

**5/5 · Build order**
1. **Server (30 min):** `/api/recent-points` returns `proj` per week; `/api/recent-stats` returns `prior` window. Both additive, no breaking change.
2. **trade-fit.js (2 h):** `formSignal` projGames baseline → `roleSignal` → `gateForm` → `teamOuts` → wire into `formMap`. Export all + thresholds.
3. **Tests (1 h) in `scripts/test-trade-fit.js`:** Hubbard fixture (games [19,19], season 8.7/g, teammate IR 34% fresh → `role-up`, mult 1); soft-D fixture (share flat → stays hot ×0.95); role-down (cold + share −20pp → mult 1); dynasty wording; no-usage fallback; weekly-proj baseline makes ratio ~1.
4. **trade.html (1 h):** fetch recent-stats, teamOuts, pills, tooltips, valueTitle line. Smoke on Hubbard + one clean sell-high.
5. **Phase 2 — the real cure (separate PR):** ROS baseline for VORP. For remaining weeks use `0.5 × season/17 + 0.5 × upcoming-week proj` per game × games left, so a role change reprices the 70% VORP half within days instead of never. Bigger blast radius (touches computeVORP/tiers) → needs its own Maker/Checker pass and a backtest on last year's week-history.
6. **Phase 3 (nice-to-have):** wire `roleSignal` into `trending-score.js` to close the `stepUp` TODO (same inputs already fetched there); add `depth_chart_order` to slim as a corroborator.

Steps 1-4 ship the Hubbard fix in an afternoon and are all additive. Step 5 is what stops the next one from happening.
