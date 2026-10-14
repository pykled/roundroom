# Draft strategy for HALIMSANITY 26-27 (Yahoo league 242808)

12 teams, snake, 16 rounds (192 picks). Starters: PG SG G SF PF F C UTIL UTIL; plus BN 5 and IL 2. High Score aggregation: each starter's single best game of the matchup week counts. Scoring: PTS 1, REB 1.2, AST 1.5, STL 3, BLK 3, TO −1, PF −1, TECH −1, DD +5, TD +3 (a TD game earns both). 22 matchup weeks, including two 14-day weeks (7 and 17); weeks 20–22 are playoffs.

Everything below comes from `scripts/nba-draft-sim.js` (code in `nba/sim/`, method and caveats in `docs/nba-handoff-s1.md`). Unless stated otherwise the numbers are from the main run: 80 drafts × 12 slots × 10 policies (9,600 drafts plus seasons, seed 1).

Each draft is followed by a simulated 22-week season, with injury spells, best-game draws from each player's own league-scored 2025 games, weekly optimal lineups, H2H round robin and a 6-team bracket. The opponents are 11 bots: 5 ADP-noise (σ 6–12 picks), 3 needs-aware, 2 reach-prone, 1 Yahoo-autopick. Their consensus board is half High Score default rank and half league-value rank (`--wHS 0.5`).

Metrics:
- **all-play** = share of opponents you outscore each regular-season week (50% = average team).
- **playoff** = top-6 finish.
- **teamValue** = expected best-lineup points per week.

Differences between policies are **paired**: same bot boards and same player seasons. 95% CIs are shown in brackets.

## 1. Best policy: VORP-per-need, at every draft slot
`vorp` = for each candidate, the exact gain in your best 9-slot lineup over all 22 weeks, minus 0.5 × the gain from the best player of the same position group likely still there at your next pick (value over next available). This is the `recommend()` the UI can use.

| policy (vs vorp) | all-play Δ | playoff Δ | teamValue Δ |
|---|---|---|---|
| vorp (absolute) | **65.1%** | **87.9%** | 408.4 |
| vorp-a0 (pure marginal lineup gain, no next-pick term) | +0.1pp [−0.3, 0.5] | +1.5pp [−0.5, 3.4] | −1.0 |
| safe (vorp − 0.3·sd) | −0.6pp [−1.1, −0.1] | +0.1pp [−2.0, 2.2] | −1.4 |
| c-round1 (C-eligible with first pick) | −1.7pp [−2.1, −1.3] | −1.8pp [−3.6, 0.0] | −3.1 |
| c-round3 | −2.7pp [−3.2, −2.1] | −2.4pp | −3.5 |
| stars (vorp + 0.3·sd) | −3.3pp [−3.8, −2.8] | −6.4pp | −1.6 |
| c-round5 (no big before R5) | −4.5pp [−5.2, −3.8] | −6.8pp | −6.4 |
| bpa-fill (best league value that fills an open starter) | −5.3pp [−5.8, −4.8] | −9.6pp [−12.1, −7.1] | −2.0 |
| hs-fill (Yahoo/High Score default ranks, fill starters) | **−13.0pp** [−13.7, −12.4] | **−30.5pp** | −17.7 |
| bpa (pure value, ignores positions) | −43.8pp (seed 2 run) | −81pp | −71 |

**Per draft slot (all-play %, ±95%)**:

| slot | vorp | vorp-a0 | bpa-fill | hs-fill | c-round1 | c-round3 |
|---|---|---|---|---|---|---|
| 1 | 69.0 ±1.8 | 70.6 ±1.7 | 65.7 | 56.7 | 69.0 | 65.7 |
| 2 | 69.5 ±1.8 | 69.9 | 64.4 | 57.1 | 69.5 | 64.7 |
| 3 | 70.0 ±1.8 | 70.3 | 64.7 | 58.2 | 69.0 | 65.3 |
| 4 | 70.0 ±1.7 | 69.6 | 63.6 | 55.3 | 67.8 | 64.4 |
| 5 | 65.7 ±2.2 | 66.7 | 60.2 | 54.5 | 63.9 | 61.3 |
| 6 | 64.9 ±2.2 | 65.0 | 59.1 | 50.8 | 61.8 | 62.0 |
| 7 | 63.9 ±2.0 | 63.6 | 58.3 | 50.4 | 61.2 | 62.4 |
| 8 | 63.3 ±2.4 | 63.8 | 58.5 | 50.9 | 60.2 | 61.0 |
| 9 | 63.8 ±2.3 | 63.0 | 56.9 | 49.1 | 61.0 | 61.5 |
| 10 | 61.3 ±2.6 | 61.9 | 57.6 | 49.0 | 59.3 | 62.7 |
| 11 | 60.5 ±2.3 | 59.7 | 55.1 | 47.8 | 59.5 | 59.6 |
| 12 | 59.0 ±1.9 | 58.2 | 53.0 | 44.4 | 58.3 | 58.0 |

- vorp or vorp-a0 is best or statistically tied for best at **every** slot. No policy beats it outside the CI anywhere: c-round3 at slot 10 is 62.7 vs 61.3 with ±2.6 overlap.
- Slots 1–4 are worth about 69–70% all-play and slot 12 about 59%. That's a ~10pp swing you can't control (order is randomized 30 min before the draft).
- **Sensitivity to how sharp the room is** (seeds 3/4, 50 drafts/slot):
  - Bots that know league values (`--wHS 0`): vorp still beats bpa-fill by +1.2pp [0.7, 1.6] all-play and +4.0pp playoff. hs-fill is −5.6pp.
  - Bots drafting purely off default ranks (`--wHS 1`): vorp is +6.2pp over bpa-fill and +10.1pp over hs-fill.

  So the edge is mostly market inefficiency (others draft off default ranks). It shrinks, but never reverses, when the room is sharp.

What vorp actually takes (30 drafts/slot):

| slot | round 1 | round 2 | round 3 |
|---|---|---|---|
| 1 | Jokić 100% | Clingan 40%, Kawhi 23%, Duren 10% | D. Mitchell 17%, Harden 17%, Kawhi 13% |
| 2 | Jokić 67%, Wembanyama 33% | Clingan 47%, Kawhi 27%, Bam 10% | Duren 30%, Tatum 17% |
| 3 | Jokić 43%, Wemby 40%, Dončić 17% | Kawhi 43%, Clingan 20%, Bam 17% | Duren 30%, Clingan 17% |
| 4 | Jokić 40%, Wemby 30%, Dončić 30% | Kawhi 40%, Clingan 17%, Murray 13% | Duren 37%, Clingan 17% |
| 5 | Wemby 43%, Dončić 20%, Jokić 13% | Kawhi 27%, Giddey 23%, Bam 17% | Duren 33%, Clingan 23% |
| 6 | Dončić 37%, Wemby 23%, Jalen Johnson 20% | Kawhi 37%, Bam 17%, Maxey 13% | Duren 30%, Mobley 23% |
| 7 | Jalen Johnson 40%, Dončić 20%, SGA 13% | Clingan 27%, Giddey 17%, Bam 17% | Duren 50%, Ware 30% |
| 8 | Cunningham 27%, Dončić 17%, SGA 17% | KAT 23%, Bam 23%, Barnes 13% | Duren 37%, Ware 33% |
| 9 | SGA 23%, J. Johnson 20%, Cunningham 17% | Bam 33%, KAT 23%, Şengün 17% | Ware 63%, Duren 20% |
| 10 | Cunningham 30%, Barnes 17% | Bam 37%, KAT 27% | Ware 77% |
| 11 | Flagg 27%, Barnes 23%, J. Johnson 13% | Bam 50%, KAT 20% | Ware 80% |
| 12 | Barnes 23%, Flagg 17%, SGA 17% | Bam 33%, Şengün 23%, Giddey 17% | Ware 83% |

## 2. How early to take a C
There is one C slot, and **C-only players fill only C and UTIL** (never F/PF). C/PF players (Bam, KAT, Şengün, Mobley, Ware, Holmgren in Sleeper's positions) also fill PF and F.
- Bigs are under-ranked by default ranks in this scoring (REB 1.2, DD +5, AST only 1.5). In this league Jokić and Wembanyama are the top 2 and are both C-only. Clingan #13 (default #32), Duren #19 (#35), Gobert #43 (#82) and Allen #59 (#102) are C-only too.
- vorp takes its first C-eligible player at round 1.8 on average. Median first-C round by slot: **round 1 at slots 1–5, round 2–3 at slots 6–12**. The first C-only comes in round 1 at slots 1–5, round 3 at slots 6–8, and rounds 5–6 at slots 9–12, where vorp gets a C/PF (Bam/KAT/Ware) in R2–R3 instead.
- Forcing a C with your first pick when Jokić/Wemby are gone costs 1.7pp all-play [1.3, 2.1]. Refusing any big until round 5 costs 4.5pp [3.8, 5.2]. Rounds 2–3 (c-round2/3) cost 2.7pp versus letting value decide. So **let value decide, but expect value to say "big by round 2–3."**
- C-only market (60 drafts): the 1st and 2nd C-only go at picks ~2 and ~4. The 3rd goes at ~21 (Clingan/Duren), the 5th at ~40, the 10th at ~75. After Clingan and Duren there is a gap to Sarr, Gobert, Embiid and Allen in rounds 4–5.
- vorp rosters carry many bigs: an average 7.0 C-only + 2.3 C/PF per 16. That's because late-round bigs are the best value left (bots avoid a 3rd C) and they win UTIL weeks on game count. It's not essential: `safe` drafts 4.5 C-eligible and is only −0.6pp. Two or three C-only players plus C/PF flex bigs is plenty.

## 3. Value of bench depth: small
- `vorp:waiver-bench` spends the last 5 picks on near-waiver players. It costs **−1.4pp all-play [−1.6, −1.2]** and −1.9pp playoff [−3.8, −0.1] (seed 2, 60 drafts/slot). teamValue changes by only −0.1.
- Picks 10–16 fill about 11% of starter-weeks (injuries, plus 2-game vs 4-game weeks).
- The sim has **no waivers**. The league allows 10 adds/week, so real bench value is lower still. Draft bench for upside and games, not safety.

## 4. Chase high-variance bigs? No more than their value already does
- Best-game scoring already rewards variance: value = E[best game of the week], which grows with the spread and with games played. Top-100 bigs are more volatile (CV 0.40 vs 0.33 for non-bigs). That is part of *why* they rank high here.
- Adding an extra variance bonus on top (`stars`, +0.3·sd) **loses 3.3pp all-play [2.8, 3.8]** and 6.4pp playoff. A small variance penalty (`safe`) is −0.6pp [−0.1, −1.1], i.e. close to neutral.
- Conclusion: use the E[best game] value as-is; don't add a "ceiling" bonus.

## 5. DD/TD and the custom weights: who moves
These ranks come from the same pipeline under High Score default scoring (1/1/2/3/3, no TO/PF/DD/TD) versus league scoring, over the top 150 league players (`--report rankings`).

Top 10 movers vs High Score defaults:

| player | league rank | default-scoring rank | Δ |
|---|---|---|---|
| Rudy Gobert (C) | 43 | 86 | +43 |
| Jarrett Allen (C) | 59 | 98 | +39 |
| Ivica Zubac (C) | 81 | 117 | +36 |
| Precious Achiuwa (C/PF) | 86 | 121 | +35 |
| Kel'el Ware (C/PF) | 24 | 58 | +34 |
| Neemias Queta (C) | 98 | 128 | +30 |
| Mark Williams (C) | 119 | 149 | +30 |
| Anthony Davis (C/PF) | 60 | 89 | +29 |
| Davion Mitchell (PG) | 135 | 107 | −28 |
| Chet Holmgren (C/PF) | 32 | 59 | +27 |

Also: Draymond Green −27, Keyonte George −21, Coby White −21, Zach Edey +21, Maluach +27.

- **DD/TD bonus alone** (league scoring vs the same with DD = TD = 0): Zubac +21, Gobert +18, Sabonis +15, Nurkić +15, Allen +14, A. Davis +14, Queta +13, Edey +11, Achiuwa +11. Only one guard (K. Porter Jr. +12) is among the 10 biggest movers.
- The other half of the shift is REB 1.2 vs AST 1.5 (instead of 2), plus TO/PF penalties, which hurt high-usage guards.
- Model-board sanity: the top 3 are unchanged (Jokić, Wemby, Dončić). Kawhi (#14, default #31), Bam (#11, #17) and KAT (#12, #21) rise. Maxey (#17, #11), LaMelo (#21, #12) and Murray (#20, #13) fall.

## 6. Position runs to expect
From the `--report runs` run (30 drafts/slot):
- **C-eligible players are 24–35% of picks in every round** (pool share of C-eligible among the top 100 is 33%).
- The 12th C-eligible player is gone by about **pick 41** (p10–p90: 38–44, end of round 4).
- Guard-only players are 39–46% of picks in rounds 1–3 and 7–8 (bots love PGs), then fall to 13–20% after round 11. Late rounds are forward/wing heavy (rounds 14–16: 50–60%).
- Practical reading: round 4 and round 9 are mini big-runs (C 35%). If you need a big and you're at the turn before round 4, take it.

## 7. Draft-day rules of thumb (12)
1. Use the vorp recommendation (value over next available, slot-aware). It's best or tied at every slot, +5.3pp all-play over BPA-that-fills and +13pp over drafting off Yahoo default ranks.
2. Don't trust Yahoo's default/O-ranks here: following them costs ~13pp all-play and ~30pp playoff odds in the sim.
3. Picks 1–4: Jokić > Wembanyama > Dončić; all three are fine (slots 1–4 ≈ 70% all-play).
4. Picks 5–12: take the best of Dončić / Jalen Johnson / SGA / Cunningham / Flagg / Barnes; don't force a C in round 1.
5. Have a big by the end of round 3: Clingan/Duren (C-only) or Bam/KAT/Şengün/Ware (C/PF). Waiting until round 5 costs ~4.5pp.
6. Prefer C/PF over C-only when values are close: they fill PF/F/C/UTIL, while C-only fill just C + 2 UTIL.
7. Never start more than 3 C-only bigs. Past that, a C-only big only helps as a schedule spot-start.
8. Kawhi (R2), Gobert/Allen (R4–5) and Ware (R3) are the clearest league-scoring bargains vs default ranks.
9. Fade the guards who drop under league scoring (AST 1.5, TO −1) relative to default ranks: Maxey, LaMelo, Murray, Keyonte George, Coby White, Davion Mitchell.
10. Don't add a ceiling/variance bonus: E[best game] already prices it, and chasing more costs ~3pp.
11. Bench picks matter little (~1.4pp for all five, and less with 10 adds/week). In rounds 12–16 take upside, injured stars for IL, and 4-game-week schedules.
12. Expect bigs to go 24–35% of every round, 12 C-eligible gone by ~pick 41, and guard-heavy rounds 1–3. Plan your big before the round-4 turn.

## Uncertainty and what could flip these
- **Positions are Sleeper-derived, not Yahoo.** If Yahoo lists some "C-only" bigs as PF/C (or the reverse), the C-only advice shifts. Re-run with Yahoo `eligible_positions` (the `yahooElig` field) once connected.
- **The room's sharpness is the biggest lever.** The vorp edge ranges from +1.2pp (bots know league values) to +6.2pp (bots use default ranks). The direction holds in both.
- League scoring is applied by an adapter over 2025 game lines until H1's profile-aware model lands. Rookies (Flagg, Boozer, Harper…) have normal-shaped distributions from projections.
- Week 7 (14 days) has only 2–4 scheduled games per team in the data (NBA Cup window unscheduled). It's undervalued for everyone, equally.
- No waivers, trades or streaming in the sim; injury spells are generic.
- Each CI is sampling uncertainty only (80 drafts/slot/policy). Model error (projections, injuries) is not in the CI.
