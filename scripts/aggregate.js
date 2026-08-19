#!/usr/bin/env node
/**
 * aggregate.js — compute recency-weighted ADP from raw picks.
 *
 * Pipeline:
 *   1. Load data/raw_picks.json (denormalized draft fields per pick).
 *   2. Rebuild per-draft records and apply draft-level quality filters:
 *        - too_old            (start_time older than 14-day window)
 *        - autopick_heavy     (>40% of picks are is_autopick)
 *        - too_fast           (duration < 8 min — not a real human draft)
 *        - wrong_format       (only 10/12/14-team leagues)
 *        - too_small          (<100 picks — partial/abandoned)
 *        - duplicate_owners   (a user_id controls >2 teams — test league)
 *   3. Group surviving picks by player. Recency-weight each pick by its
 *      draft age: weight = exp(-daysSinceDraft / 7).
 *   4. Per player, drop pick positions >2.5 stdev from the median (single
 *      outlier reaches/steals) before computing ADP.
 *   5. Keep players drafted in >= MIN_DRAFTS qualifying drafts (5 during
 *      Aug 1 – Sep 15 draft season, 10 otherwise).
 *
 * Output:
 *   data/adp.json            — players with adp + weighted_adp
 *   data/data_quality.json   — filter counts / data-health dashboard
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
// During draft season (Aug 1 – Sep 15) the crawl sample is thin relative to
// player pool churn — requiring 10 drafts per player dropped 200+ real players
// when only ~16 quality drafts passed filters. 5 keeps coverage while the
// recency weighting + outlier clamp still protect ADP quality. Off-season we
// go back to 10 for confidence.
function inDraftSeason(d = new Date()) {
  const m = d.getUTCMonth() + 1; // 1-12
  const day = d.getUTCDate();
  return (m === 8) || (m === 9 && day <= 15);
}
const MIN_DRAFTS = inDraftSeason() ? 5 : 10;
const DATE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const AUTOPICK_MAX_FRAC = 0.40;              // >40% autopick => suspect
const MIN_DURATION_MS = 8 * 60 * 1000;       // < 8 min => too fast
const VALID_LEAGUE_SIZES = new Set([10, 12, 14]);
const MIN_PICKS_PER_DRAFT = 100;             // < 100 => partial/abandoned
const MAX_TEAMS_PER_OWNER = 2;               // > 2 => duplicate-owner test league
const OUTLIER_SIGMA = 2.5;                   // per-player pick-position clamp
const RECENCY_HALFLIFE_DIVISOR = 7;          // exp(-days/7)

const DAY_MS = 24 * 60 * 60 * 1000;

function median(nums) {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stdev(nums, mean) {
  if (nums.length === 0) return 0;
  const m = mean == null ? nums.reduce((a, b) => a + b, 0) / nums.length : mean;
  const v = nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length;
  return Math.sqrt(v);
}

function main() {
  const rawPath = path.join(DATA_DIR, 'raw_picks.json');
  if (!fs.existsSync(rawPath)) {
    console.error('data/raw_picks.json not found. Run crawl.js first.');
    process.exit(1);
  }

  const picks = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  console.log(`Loaded ${picks.length} picks.`);

  // Crawl-level counts (drafts the crawler already discarded before storing).
  let crawlMeta = {};
  const metaPath = path.join(DATA_DIR, 'crawl_meta.json');
  if (fs.existsSync(metaPath)) {
    try { crawlMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
  }

  const now = Date.now();
  const cutoff = now - DATE_WINDOW_MS;

  // ---- 1. Rebuild per-draft records from denormalized pick fields ----
  const drafts = new Map(); // draft_id -> { start_time, type, league_size, duration, picks:[], autopick, owners: Map(user->Set(slot)) }
  for (const p of picks) {
    if (!p.draft_id) continue;
    let d = drafts.get(p.draft_id);
    if (!d) {
      d = {
        draft_id: p.draft_id,
        start_time: p.draft_start_time || null,
        type: p.draft_type || null,
        league_size: p.league_size || null,
        duration_ms: (typeof p.draft_duration_ms === 'number') ? p.draft_duration_ms : null,
        total_picks: 0,
        autopicks: 0,
        owners: new Map(),
      };
      drafts.set(p.draft_id, d);
    }
    d.total_picks++;
    if (p.is_autopick === true) d.autopicks++;
    if (p.picked_by) {
      if (!d.owners.has(p.picked_by)) d.owners.set(p.picked_by, new Set());
      d.owners.get(p.picked_by).add(p.roster_slot);
    }
  }

  // ---- 2. Draft-level quality filters ----
  const reasons = {
    too_old: 0,
    autopick_heavy: 0,
    too_fast: 0,
    wrong_format: 0,
    too_small: 0,
    duplicate_owners: 0,
  };
  const qualifyingDrafts = new Set();
  let afterDateFilter = 0;

  for (const d of drafts.values()) {
    // Defensive date re-filter (data may be re-aggregated hours/days later).
    if (!d.start_time || d.start_time < cutoff) { reasons.too_old++; continue; }
    afterDateFilter++;

    // Wrong format — only 10/12/14-team snake leagues.
    if (!VALID_LEAGUE_SIZES.has(Number(d.league_size))) { reasons.wrong_format++; continue; }

    // Too small — partial/abandoned draft.
    if (d.total_picks < MIN_PICKS_PER_DRAFT) { reasons.too_small++; continue; }

    // Too fast — sub-8-minute drafts aren't real human drafts.
    if (d.duration_ms != null && d.duration_ms > 0 && d.duration_ms < MIN_DURATION_MS) {
      reasons.too_fast++; continue;
    }

    // Autopick-heavy — owner wasn't really drafting.
    if (d.total_picks > 0 && (d.autopicks / d.total_picks) > AUTOPICK_MAX_FRAC) {
      reasons.autopick_heavy++; continue;
    }

    // Duplicate owners — same user controls >2 teams => test league.
    let dupe = false;
    for (const slots of d.owners.values()) {
      if (slots.size > MAX_TEAMS_PER_OWNER) { dupe = true; break; }
    }
    if (dupe) { reasons.duplicate_owners++; continue; }

    qualifyingDrafts.add(d.draft_id);
  }

  // Fold in crawl-time skips so the report reflects the full funnel.
  const crawlTooOld = Number(crawlMeta.skipped_too_old || 0);
  const crawlAuction = Number(crawlMeta.skipped_auction || 0);
  reasons.too_old += crawlTooOld;
  reasons.wrong_format += crawlAuction; // auction == wrong format for ADP

  const totalRawDrafts = Number(
    crawlMeta.completed_drafts_seen || (drafts.size + crawlTooOld + crawlAuction)
  );
  // Drafts that passed the date gate (crawl already excluded too-old ones).
  const draftsAfterDateFilterTotal = totalRawDrafts - reasons.too_old;

  console.log(
    `Draft filters: ${totalRawDrafts} raw -> ${draftsAfterDateFilterTotal} after date -> ` +
    `${qualifyingDrafts.size} after quality.`
  );
  console.log(`  removed: ${JSON.stringify(reasons)}`);

  // ---- 3 + 4. Group qualifying picks by player, weight, remove outliers ----
  const groups = new Map(); // key -> { name, position, team, picks: [{pick_no, weight}] }
  for (const p of picks) {
    if (!qualifyingDrafts.has(p.draft_id)) continue;
    const name = (p.player_name || '').trim();
    const pos = (p.position || '').trim().toUpperCase();
    if (!name || !pos) continue;
    if (typeof p.pick_no !== 'number' || p.pick_no <= 0) continue;

    const daysSince = p.draft_start_time ? (now - p.draft_start_time) / DAY_MS : 999;
    const weight = Math.exp(-Math.max(0, daysSince) / RECENCY_HALFLIFE_DIVISOR);

    const key = `${name.toLowerCase()}|${pos}`;
    if (!groups.has(key)) {
      groups.set(key, { name, position: pos, team: p.team || null, picks: [] });
    }
    const g = groups.get(key);
    g.picks.push({ pick_no: p.pick_no, weight });
    if (!g.team && p.team) g.team = p.team;
  }

  const players = [];
  let droppedLowSample = 0;

  for (const g of groups.values()) {
    // Minimum sample quality — drafted in >= 10 qualifying drafts.
    if (g.picks.length < MIN_DRAFTS) { droppedLowSample++; continue; }

    // Per-player outlier removal: drop picks >2.5 stdev from the median.
    const positions = g.picks.map((x) => x.pick_no);
    const med = median(positions);
    const sd = stdev(positions);
    const kept = sd > 0
      ? g.picks.filter((x) => Math.abs(x.pick_no - med) <= OUTLIER_SIGMA * sd)
      : g.picks;
    // If outlier removal drops us below threshold, still keep (drafted enough
    // times); but if everything somehow got removed, fall back to originals.
    const use = kept.length > 0 ? kept : g.picks;

    const n = use.length;
    const posList = use.map((x) => x.pick_no);

    // Plain (unweighted) ADP.
    const mean = posList.reduce((a, b) => a + b, 0) / n;
    const sdPlain = stdev(posList, mean);

    // Recency-weighted ADP + weighted stdev.
    const wSum = use.reduce((a, x) => a + x.weight, 0);
    const wMean = wSum > 0
      ? use.reduce((a, x) => a + x.weight * x.pick_no, 0) / wSum
      : mean;
    const wVar = wSum > 0
      ? use.reduce((a, x) => a + x.weight * (x.pick_no - wMean) ** 2, 0) / wSum
      : sdPlain ** 2;
    const wStdev = Math.sqrt(wVar);

    players.push({
      name: g.name,
      position: g.position,
      team: g.team,
      adp: Math.round(mean * 100) / 100,
      weighted_adp: Math.round(wMean * 100) / 100,
      stdev: Math.round(sdPlain * 100) / 100,
      weighted_stdev: Math.round(wStdev * 100) / 100,
      high: Math.min(...posList),
      low: Math.max(...posList),
      times_drafted: n,
      outliers_removed: g.picks.length - n,
    });
  }

  // Sort by the recency-weighted ADP — that's the headline number now.
  players.sort((a, b) => a.weighted_adp - b.weighted_adp);

  const generatedAt = new Date().toISOString();

  const out = {
    generated_at: generatedAt,
    total_drafts: qualifyingDrafts.size,
    min_drafts: MIN_DRAFTS,
    players,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'adp.json'), JSON.stringify(out, null, 2));

  const quality = {
    generated_at: generatedAt,
    total_raw_drafts: totalRawDrafts,
    drafts_after_date_filter: draftsAfterDateFilterTotal,
    drafts_after_quality_filter: qualifyingDrafts.size,
    filtered_reasons: reasons,
    players_in_output: players.length,
    players_dropped_low_sample: droppedLowSample,
  };
  fs.writeFileSync(
    path.join(DATA_DIR, 'data_quality.json'),
    JSON.stringify(quality, null, 2)
  );

  console.log(
    `Wrote adp.json: ${players.length} players (>=${MIN_DRAFTS} drafts) ` +
    `from ${qualifyingDrafts.size} qualifying drafts.`
  );
  console.log(`Dropped ${droppedLowSample} players for low sample (<${MIN_DRAFTS}).`);
  console.log('Wrote data_quality.json:');
  console.log(JSON.stringify(quality, null, 2));
  if (players.length) {
    console.log('Top 5 by weighted ADP:');
    players.slice(0, 5).forEach((p, i) =>
      console.log(`  ${i + 1}. ${p.name} (${p.position}) wadp=${p.weighted_adp} adp=${p.adp} n=${p.times_drafted}`)
    );
  }
}

main();
