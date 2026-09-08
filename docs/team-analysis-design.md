# Team Analysis — design recommendation

Date: 2026-09-07. Status: proposal, no code written. Companion to `architecture-accounts-trade.md`.

Goal: tell a connected user what their team needs, what it has too much of, who the elite players and liabilities are, and which other teams in the league need what they have (trade leverage). Decide whether this lives on the Trade page, a new page, or both, and whether an AI-written summary is worth adding.

---

## 1. Data availability

Everything needed for a full league-wide algorithmic analysis is **already in the browser on the Trade and Lineup pages**. No new upstream Sleeper call is required.

| Need | Source | Status |
|---|---|---|
| All teams' rosters | `GET /api/league/:id` → `rosters[]` (every team: `players`, `starters`, `reserve`, `taxi`, `owner_id`, `co_owners`, `roster_id`, `settings`) | ✅ Confirmed live. Server caches 60 s. Already loaded into `S.league` on trade.html and lineup.html. |
| Team / owner names | same payload → `users[]` (`user_id`, `display_name`, `avatar`, `metadata.team_name`) | ✅ but `team_name` is frequently unset (none of the 10 Coast to Coast owners have one). Fall back to `display_name`; `owner_id: null` = orphaned team. |
| Standings / record | `rosters[].settings` → `wins`, `losses`, `ties`, `fpts`, `fpts_decimal`, `waiver_position` | ✅ In the existing payload. All zeros until Week 1 completes. `fpts_against` appears once games are played. |
| League format | same payload → `roster_positions`, `scoring_settings`, `total_rosters` | ✅ Already used by both pages. |
| Player name / pos / NFL team | `GET /api/players/slim` → `{id: [name, pos, team]}`; `?def=1` adds DEF | ✅ Loaded on both pages. **Does not carry injury status.** |
| Projections (season) | `GET /api/projections/season` → flat stat dict per player; `ScoringEngine.scorePlayer` turns it into league-scored season points | ✅ Loaded on both pages. Weekly projections are still dead, so pts/wk = season ÷ 17. |
| Player values | `S.vorp` = `computeVORP → rescaleVORP → blendWithMarket` (70/30 with FantasyCalc) | ✅ Computed on both pages, league-specific. Analysis must use this same map so it agrees with trade verdicts. |
| Injuries | `GET /api/injuries` → keyed by **lowercase full name**: `{status, body_part, note, start_date, availabilityStatus}` | ✅ Exists (4 h live cache, 271 skill players currently flagged). Not loaded on trade/lineup yet. Join by name from the slim dict. Optional one-line server improvement: append `injury_status` as a 4th element in the slim array to avoid name joins. |
| Weekly matchups / opponent | Sleeper `/league/:id/matchups/:week` (`points`, `starters_points`, `players_points`) | ❌ Not proxied. Not needed for this feature. |
| Bye weeks | `data/bye-weeks.json` | Exists; not needed for MVP. |

Only two client-side additions are needed: load `shared/lineup.js` on the Trade page (currently only lineup.html loads it) and fetch `/api/injuries` once.

---

## 2. Team strength metrics (algorithmic)

All of this is a pure function over data the page already holds. Proposed home: `shared/analysis.js`, same pattern as `shared/lineup.js` (browser global + `module.exports`, so it can be exercised from node against a live league without a browser).

### Per team

```
analyzeTeam(roster, league, players, proj, vorp, injuries) →
{
  rosterId, ownerId, name, avatar, record: {wins, losses, ties, fpts},
  active: [ids]                     // players minus reserve/taxi
  lineup: LineupOptimizer.optimize(active → {id, position, value: vorp}, roster_positions)
  starterVorp: Σ vorp(starters)     // ranking metric (league-relative 0–10000 scale)
  starterPts:  Σ seasonPts(starters) / 17   // human-readable "proj pts/wk"
  benchVorp:   Σ vorp(bench)        // depth
  byPos: { QB|RB|WR|TE: { starterVorp, rostered, slots, status: need|neutral|surplus, nextUp } }
  elite:       starters with vorp ≥ ELITE_T  (or top-5 at position league-wide)
  liabilities: starters with vorp < LIAB_T   (near replacement level, e.g. < 1000)
  injured:     active players whose injury status ∈ {Out, Doubtful, Questionable, IR}
}
```

- **Optimal lineup**: `LineupOptimizer.optimize` already does dedicated slots then flex. Reuse as-is.
- **Positional depth (need / neutral / surplus)**: reuse the Roster Fit rule from trade.html (`starterSlots` + `assessDepth`: need = rostered ≤ starters, surplus = rostered ≥ 2× starters). Move both helpers into the shared module so trade.html and the analysis agree by construction.
- **Positional strength**: sum of VORP of the players the optimizer put into slots that position can fill (a WR in FLEX counts toward WR). Rank descending across teams → "3rd best WR corps of 10".
- **Next man up**: best bench VORP at the position. Distinguishes "3 RBs, all sub-replacement" (still thin) from "3 RBs, one is a top-12 back" (fine). Recommended as a secondary signal; the count rule stays primary for consistency with Roster Fit.
- **Injury risk**: count of active-roster players with a medical status. Players on `reserve` (IR slot) are already excluded from depth. Refinement: treat `Out`/`IR` players as unavailable when computing need, so a team whose RB1 is out for the year reads as RB-thin.

### Per league

```
analyzeLeague(league, players, proj, vorp, injuries) →
{ teams: [analyzeTeam...] sorted by starterVorp desc,
  ranks: { QB|RB|WR|TE: [rosterId in rank order] },
  partners(myRosterId): teams whose need positions ⊂ my surplus positions, scored by overlap }
```

### Cost and difficulty

- 10–32 rosters × ~15 players, one greedy optimize each: well under 5 ms. Runs synchronously inside `recompute()`.
- Effort: **small**. Roughly 120 lines of pure JS, most of it moving existing helpers and grouping results. Zero server changes required.
- Known trade-off inherited from the lineup page: VORP-ranked FLEX can prefer a lower pts/wk player. Acceptable for ranking; show pts/wk as the displayed number.
- K and DEF stay out of need/surplus (as in Roster Fit). DEF is not in the VORP engine and ranks on raw points in the optimizer, which is fine.

---

## 3. AI prose analysis (Claude API)

**Plumbing already exists.** `server.js` has `/api/chat` using `@anthropic-ai/sdk` with `claude-haiku-4-5-20251001`, a hardcoded system prompt, 20 req/IP/min limiting, and `ANTHROPIC_API_KEY` is set on Railway (production returns 400 for an empty body, not the 503 "not configured" path). A new `POST /api/analysis` would copy that shape.

**Proposed design if built**
- Client computes the full structured analysis (section 2) and POSTs a compact summary, roughly 1–2 KB: depth statuses, positional ranks, top 3 and bottom 3 starters with VORP, injured players, record, top 2 trade-partner matches. Never the raw roster or free text.
- Server validates shape and sizes, builds a fixed prompt, asks for exactly four bullets (needs, surplus, strengths, weaknesses), `max_tokens` ~300, system prompt says "use only the supplied data, do not add player facts or news."
- Cache the response by hash of the payload for 1 h (rosters change slowly; league payload is already cached 60 s). Tighter rate limit than chat, e.g. 6/IP/10 min. Require sign-in (only connected users have a roster anyway).
- Trigger with a button ("Explain my team") rather than auto-fire, so spend tracks intent. Render the numeric panel first; the prose loads after and never blocks.

**Tradeoffs**
| | |
|---|---|
| Cost | ~800 input + ~250 output tokens on Haiku 4.5 ≈ $0.002 per call. Negligible even at hundreds of calls/day. |
| Latency | 1–3 s. Fine as a secondary load, bad if it gates the panel. |
| Key management | Already solved; same env var and server-side proxy pattern. |
| Correctness risk | The real cost. Haiku will happily invent context ("coming off a strong 2025") for players it only sees as name + number. Mitigated by the "only supplied data" instruction and by keeping the payload numeric, but never fully eliminated. |
| Value | Honest read: the numbers already say "need RB, surplus WR, 3rd best WR corps, TE is a liability." Prose restates them more readably; it does not add information. The one thing prose does well, synthesizing into a recommendation ("offer a WR2 to Team X for their RB2"), can also be done algorithmically via partner matching. |

**Verdict:** feasible and cheap, but not MVP. Build it as a phase 3 polish behind a button once the structured panel exists. Effort: small (~2 hours including prompt tuning).

---

## 4. Where should this live?

**Recommendation: Option C, staged. Start with the Trade page panel (A), built on `shared/analysis.js`; add the dedicated page second.**

Why the Trade page first:
- It already has every input loaded: league with all rosters, players, projections, blended VORP, market values, and the user's roster. Adding the panel is rendering, not plumbing.
- The user is in "should I do this trade" mode there. Need/surplus and partner intel are most valuable at that moment.
- **The combine that actually merges analysis with trading:** when a player added to "You Receive" is on another roster in the league, look up the owning team from `S.league.rosters` and show that team's needs inline ("Team X needs WR, surplus RB. This trade sends them a WR."). That is trade-partner intelligence exactly where it is used, and it costs about 20 lines once `analyzeLeague` exists. Roster Fit already shows the user's own side; this shows the counterparty's.

Why the dedicated page second, not instead:
- The full league table (teams × 4 positions + record + strength) is wide. It does not fit in the Trade page's narrow verdict column without becoming a scroll box.
- A standalone page costs ~200 lines of boilerplate (Clerk boot, league select, primary persistence) copied from lineup.html. Reasonable, but it is a second surface to keep in sync, so do it once the module is stable.
- Nav is currently Draft | Research | Trade | Lineup. A fifth "Team" tab is fine and matches the expansion plan of separate static pages over shared modules.

Concrete Trade page layout:
- Collapsible **"Your Team"** panel between the league settings strip and the trade grid. Default open on desktop, collapsed on mobile.
- Row 1: depth chips per position (same chips Roster Fit already renders) with rank appended: `WR 5 ▲ Need · 7th of 10`.
- Row 2: starter strength `112.4 proj pts/wk · 2nd of 10`, injured count.
- Row 3: "Strengths" (top 3 starters by VORP) and "Liabilities" (weakest starters at a need position).
- Row 4: "Teams that need what you have" — up to 3 partner rows, each with team name and their need/surplus chips. Clicking one could prefill nothing yet; it is intelligence, not automation.
- Keep Roster Fit under the verdict unchanged.

---

## 5. League comparison table

Easy once `analyzeLeague` exists; it is a render of the `teams` array.

Columns: Team (avatar via `sleepercdn.com`, already allowed in CSP `img-src`; `metadata.team_name || display_name`), Record (`W-L` from `roster.settings`, `0-0` until Week 1 posts), Proj pts/wk (optimal starters), Strength rank, then QB / RB / WR / TE cells each showing `▲ – ▼` status plus positional rank. Highlight the user's row. Sort by strength by default, click headers to re-sort.

Main complexities, none hard:
1. **Names**: `team_name` is often missing; orphaned rosters (`owner_id: null`) need an "Open team" label; co-owners exist.
2. **Width on mobile**: 7+ columns. Horizontal scroll container or collapse to stacked cards below ~600 px.
3. **32-team leagues** (Chaotic Evil): long table, still fine; maybe a "show my row + top/bottom 5" toggle later.
4. **Interpreting ranks in odd formats**: positional rank uses the league's own slots, so a 2-FLEX no-K/DEF league and a Superflex league each rank correctly without special cases.
5. **Privacy**: `/api/league/:id` is public and unauthenticated (Sleeper data is public anyway). The table only renders in connected mode, which matches the rest of the site.

---

## 6. MVP recommendation

**Build first (Phase 1, small-to-medium, about half a day):**
1. `shared/analysis.js`: `starterSlots`, `assessDepth` (moved from trade.html), `analyzeTeam`, `analyzeLeague`, `rankPositions`, `findPartners`. Pure functions, node-requirable, verified with a quick script against a live league id (Coast to Coast `1399457768158547968`).
2. Trade page: load `shared/lineup.js` + `/api/injuries`, run `analyzeLeague` inside `recompute()` in connected mode, render the "Your Team" panel described in section 4.
3. Counterparty hint: when a received player belongs to another roster in the league, show that team's needs next to the verdict.
4. Optional server tweak: add `injury_status` to `/api/players/slim` entries (one line) so the name join goes away.

**Phase 2 (medium, half a day):** `/team` page with the league comparison table, reusing the module and the lineup.html boilerplate. Add the nav tab.

**Phase 3 (small, ~2 hours):** `POST /api/analysis` + "Explain my team" button, Haiku, cached by payload hash, button-triggered.

Why this order: Phase 1 delivers all four user asks (needs, surplus, strengths/liabilities, other teams' needs) with zero server work and puts the counterparty intel exactly where trades are evaluated. The table and the prose are presentation layers over the same module and can follow without rework.

**Not recommended:** building the AI summary first. It would restate numbers the page does not yet show, and its hallucination risk is highest when there is no structured panel next to it to anchor the reader.
