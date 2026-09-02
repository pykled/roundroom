# RoundRoom Recommendation Algorithm v2 — Design Spec

Status: design handoff (2026-08-13). Target: replace/extend `scorePlayer()` in `index.html`.

## 0. What exists today (baseline)

```
scorePlayer(player, nextPickNum, available) =
  calcVOR(player)                        // lookupVorp() table (12-team PPR), else pts - replacement pts
  × getStrategyWeight(player)            // hardcoded multipliers per strategy profile
  × (0.3 + 0.7 × survival)               // survival = 1 - Φ((nextPick - adp)/stdev)
  × targetBonus (1.5 | 1.0)
```

Gaps this spec closes:
- `STATE.scoringType` and `STATE.totalTeams` are never used in scoring (VORP tables assume 12-team PPR).
- Tier breaks (`getTierBreak`) and position runs (danger alert only) don't affect the score.
- `getNextNextMyPick()` exists but is unused — no snake/back-to-back awareness.
- Positional need is only expressed through strategy profiles, not roster-state math.

## 1. Top-level scoring function

```
function scoreV2(player, STATE, available):
  if drafted or avoided: return -Infinity

  base      = adjustedVORP(player, STATE)          // §2: format + league-size adjusted value
  wStrategy = getStrategyWeight(player, STATE)     // §5: existing profiles, refined
  mNeed     = needMultiplier(player.position, STATE)   // §3: roster-state
  mUrgency  = urgencyMultiplier(player, STATE, available)  // §4: survival × tier × run
  mTarget   = targets.has(player) ? 1.5 : 1.0

  if survival(player, effectivePick(STATE)) < 0.03: return -Infinity
  return base × wStrategy × mNeed × mUrgency × mTarget
```

All multipliers are clamped: `wStrategy ∈ [0.05, 2.5]`, `mNeed ∈ [0.5, 1.6]`, `mUrgency ∈ [0.25, 1.5]`. Product of the three non-base terms clamped to `[0.02, 4.0]` to prevent stacking blowups.

## 2. adjustedVORP — format + league-size adjustment

`rawVorp = calcVOR(player, available)` (existing: live `/api/vorp` → hardcoded table → pts fallback). Tables are 12-team PPR, so adjust:

```
adjustedVORP = rawVorp × F_scoring[scoringType][pos] × F_size[totalTeams][pos]
```

### F_scoring (relative to PPR baseline)

| pos | ppr | half_ppr | standard |
|-----|-----|----------|----------|
| RB  | 1.00 | 1.04 | 1.08 |
| WR  | 1.00 | 0.90 | 0.80 |
| TE  | 1.00 | 0.92 | 0.84 |
| QB  | 1.00 | 1.00 | 1.00 |
| K/DST | 1.00 | 1.00 | 1.00 |

Rationale: WRs average ~85 rec/yr for top-24, RBs ~45; removing 0.5–1.0 pt/rec compresses WR/TE VORP ~10–20% while RB relative value rises. (If live projections carry a `rec` field, prefer exact recomputation: `pts_adj = pts - rec × (1 - pprFactor)`, pprFactor = 1/0.5/0 — the table is the fallback.)

### F_size (relative to 12-team baseline)

Replacement level shifts with league size (baseline index ≈ `round(base × teams/12)`; base: QB12/RB36/WR48/TE12, or QB24 SF):

| pos | 8-team | 10-team | 12-team | 14-team |
|-----|--------|---------|---------|---------|
| QB  | 0.70 | 0.85 | 1.00 | 1.15 |
| RB  | 0.80 | 0.90 | 1.00 | 1.12 |
| WR  | 0.82 | 0.92 | 1.00 | 1.10 |
| TE  | 0.75 | 0.88 | 1.00 | 1.18 |

Rationale: smaller leagues → waiver wire is deep → edges over replacement shrink; 14-team → TE and QB cliffs are brutal (TE gets the largest boost because the position is shallowest). QB row applies in 1-QB; in SuperFlex use the SF VORP table AND multiply QB by an extra 1.05 per 2 teams above 12.

## 3. needMultiplier — roster-state formula

Per position compute a **starter requirement including flex share**:

```
req = { QB: isSuperflex ? 2.0 : 1.0,
        RB: 2 + flexShare.RB,      // default flexShare RB 0.45, WR 0.45, TE 0.10
        WR: 2 + flexShare.WR,
        TE: 1 + flexShare.TE,
        K: 1, DST: 1 }             // derive starters from rosterSlots keys when available

have = count of pos on roster (rosterSlots values)
gap  = max(0, req[pos] - have)

mNeed = 0.6 + 0.5 × min(1, gap / req[pos])        // range 0.6 (pos full) .. 1.1 (pos empty)
```

Two overrides on top:

1. **Desperation clamp** — running out of picks to fill starters:
   ```
   totalGaps    = Σ ceil(gap) over QB/RB/WR/TE (+K/DST in last 2 rounds)
   picksLeft    = myPickNumbers.filter(p > lastPickCount).length
   if gap > 0 and picksLeft - totalGaps <= 1:  mNeed = max(mNeed, 1.45)
   ```
2. **Bench-depth taper** — once starters are full, depth value decays with count:
   `have >= req + 2 → mNeed = 0.5` for RB/WR; QB2 in 1-QB and TE2 always `0.5` (keeps current suppression behavior but roster-driven, not round-hardcoded). K/DST keep the existing round gates (0.05 until final 2–3 rounds).

## 4. urgencyMultiplier — survival × tier break × position run

```
mUrgency = expectedValue(survival) × tierFactor × runFactor
```

### 4a. Survival with snake awareness

Keep `calcSurvivalProbability` (normal CDF), but change **which pick** you measure against:

```
next1 = getNextMyPick(); next2 = getNextNextMyPick()
// Back-to-back turn (snake wrap, e.g. slot 5/12 → picks 29 & 32 gap 3; slot 12 → gap 1):
if next2 and (next2 - next1) <= 3:
    // You effectively get two picks "now" — score for the PAIR:
    // a player you can safely defer to next2 should be discounted less harshly
    effSurvival = max(survival(p, next1), 0.85 × survival(p, next2))
else:
    effSurvival = survival(p, next1)

expectedValue = 0.3 + 0.7 × effSurvival        // unchanged curve
```

Additionally expose a **wait-signal** for the UI: if `survival(p, next2) > 0.65`, tag "can wait one turn" — steer the user to the scarcer pick first when holding consecutive picks.

### 4b. Tier-break factor ("last of tier")

Cluster available players at the position by projected pts (desc). A tier boundary exists where the drop to the next player ≥ threshold:

| pos | tier gap threshold (pts) |
|-----|--------------------------|
| QB  | 18 |
| RB  | 15 |
| WR  | 12 |
| TE  | 20 |

(Replaces the flat 22 in `getTierBreak` — TE/QB tiers are lumpier than WR.)

```
tier(p) = contiguous group above the first boundary at/below p
expectedTierSurvivors = Σ survival(q, next1) for q in tier(p), q ≠ p

tierFactor = 1.30  if expectedTierSurvivors < 0.75   // you are effectively the tier's last chance
           = 1.15  if expectedTierSurvivors < 1.5
           = 1.00  otherwise
```

This converts "⚡ tier break" from display-only into score. Note it composes with survival: a last-of-tier player who will *also* be gone gets the 1.3 bonus but a low expectedValue — correct, because the alternative (next tier) is what you're really pricing.

### 4c. Position-run factor

```
recent = last 5 picks made (picks array)
runActive(pos) = count(recent at pos) >= 3
if runActive(pos):
    // runs accelerate the board at that position — shrink stdev 30% for that pos's survival calcs
    stdev_eff = stdev × 0.7
    runFactor = 1.10 if gap(pos) > 0 else 1.0   // only chase the run if you still need the position
else runFactor = 1.0
```

The stdev shrink matters more than the 1.10: it drops survival for that position's players, which raises urgency organically and feeds the danger alert.

## 5. Strategy profiles (refined weights)

Keep `getStrategyWeight`'s structure; changes: replace `myPicksMade` round-gates with the round derived from `lastPickCount / totalTeams` (robust when user joins mid-draft), and these weight tables:

| Situation | zero_rb | hero_rb | robust_rb | bpa | superflex |
|---|---|---|---|---|---|
| RB, rounds 1–3 | 0.10 | 2.5 if rank≤20 & no hero, else 0.2 | 2.0 (until 4 RBs) | 1.0 | 1.6 if elite & no QB yet |
| RB, rounds 4–6 | 1.7 (the pivot — was 1.0; the whole point of zero-RB is attacking RB here) | 0.5 (RB2), 0.2 after | 1.4 | 1.0 | 1.0 |
| WR, rounds 1–4 | 1.6 | 1.5 after hero | 1.4 after 2 RB | 1.0 | 1.2 after QB1 |
| TE early (no TE) | 1.5 rounds 2–4 | 1.0 | 1.3 round 4+ | 0.25 if have TE | 1.3 round 5+ |
| QB (1-QB, no QB) | 1.2 rounds 4–6 | 1.0 | 1.0 | 0.3 if have QB | — |
| QB (SF, 0 QBs) | — | — | — | — | 2.0 rounds 1–3, 1.8 after |
| QB (SF, 1 QB) | — | — | — | — | 2.2 until round 8 |
| QB (SF, 2 QBs) | — | — | — | — | 0.3 (was 0.08 — QB3 has real trade/bye value in SF) |

Universal gates stay: K 0.05 until round 13, DST 0.05 until round 12, TE/QB ADP>25 suppression in rounds 1–2 (non-SF).

**League-size interaction with strategy:** in 14-team leagues shift every "rounds N–M" window **one round earlier** (scarcity hits sooner); in 8-team, one round later. Implement as `roundShift = (totalTeams - 12) / 2`, applied to the gate constants.

## 6. Situational override rules (applied after scoring, as re-rank nudges + UI copy)

Fire at most 2; each is a final multiplier on the affected players plus a "why" string:

1. **14-team TE cliff**: `totalTeams >= 14 && round >= 4 && teCount == 0 && availableTEsAboveReplacement <= 3` → TE ×1.25, copy: "TE cliff — only N startable TEs left in a 14-team".
2. **SF QB emergency**: `isSuperflex && qbCount == 0 && round >= 3` → QB ×1.4 (stacks with strategy weight, hits the 4.0 product clamp — intended).
3. **Back-to-back plan**: `next2 - next1 <= 3` → surface both picks: recommend scarcest pick now, tag deferable player "likely there at your next pick (N%)".
4. **Standard-scoring RB lean**: `scoringType == 'standard' && rounds 1–3` → already handled by F_scoring; UI copy only ("RBs gain value in standard").
5. **Bye-week stack guard** (cheap, optional v2.1): 3+ starters sharing a bye → ×0.92 for a 4th.

## 7. Worked example — "12-team PPR, slot 5, round 3, roster = 2 WR / 0 RB"

Pick 29 on the clock (my picks: 5, 20, 29, 44, 53…). next1=29 is now; next2=44 → for players I'm scoring for THIS pick, survival vs next pick after taking one = compare at 44. Strategy: none/`bpa`. Candidates:

**RB option — Kenneth Walker III** (RB, adp 28, rawVorp ≈ 95):
- adjustedVORP = 95 × 1.00 (PPR) × 1.00 (12tm) = **95**
- mNeed(RB): req 2.45, have 0, gap 2.45 → 0.6 + 0.5×1 = **1.10**; desperation not triggered (13 picks left ≫ gaps)
- Survival at pick 29 (on the clock) = 1.0 → expectedValue = 1.0. Tier: 2 other RBs in his tier, expectedTierSurvivors at pick 44 ≈ 0.4 → tierFactor **1.30** (last realistic shot at this RB tier before round 4). No run → 1.0. mUrgency = 1.30
- **score = 95 × 1.0 × 1.10 × 1.30 = 135.9**

**WR option — Tee Higgins** (WR, adp 31, rawVorp ≈ 88):
- adjustedVORP = 88 × 1.00 × 1.00 = **88**
- mNeed(WR): req 2.45, have 2, gap 0.45 → 0.6 + 0.5×(0.45/2.45) = **0.69**
- Tier: 4 WRs in tier, expectedTierSurvivors at 44 ≈ 1.8 → tierFactor 1.0; mUrgency = 1.0
- **score = 88 × 1.0 × 0.69 × 1.0 = 60.7**

RB wins 136 to 61 — the algorithm pivots hard to RB even though the WR's raw VORP is close, driven by need (1.10 vs 0.69) and tier urgency (1.30 vs 1.0). Under **standard scoring** the gap widens (88 × 0.80 = 70 base for Higgins → 48). Under **zero_rb strategy** the RB is suppressed in round 3 (×0.10 → 13.6) and Higgins still wins — strategy profiles intentionally dominate need in their defined windows.

Same scenario, **14-team**: Walker's adjustedVORP = 95 × 1.12 = 106, round windows shift a round earlier, and the RB pivot gets even louder (152 vs 58).

## 8. Implementation notes

- `effectivePick`: in mock mode use `MOCK.currentPick/myPickNumbers`, live use `STATE` — mirror the existing ternaries in `renderRecommendations`.
- Precompute per-render: available pool, per-position sorted lists + tiers, run state, next1/next2. Cost is O(n log n) once, not per player.
- `gradeDraft()` should reuse F_scoring/F_size on its VORP component and shift its "elite TE/WR" scarcity thresholds by league size — otherwise grades disagree with in-draft advice.
- Keep every multiplier's contribution in the returned object (`{base, wStrategy, mNeed, mUrgency}`) so `generateWhyText` can cite the dominant factor instead of guessing.
