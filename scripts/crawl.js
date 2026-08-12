#!/usr/bin/env node
/**
 * crawl.js — Sleeper snowball crawler
 *
 * There is no "list all drafts" endpoint on Sleeper, so we snowball outward
 * from a seed username: user -> leagues -> drafts -> picks, and league users
 * feed the frontier for more users to explore.
 *
 * Output:
 *   data/raw_picks.json  — array of pick objects
 *   data/crawl_meta.json — { total_drafts, total_picks, crawled_at, seeds_used }
 *
 * Node built-ins + native fetch only.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SEASON = '2026';
// Seed frontier: pykle plus a hardcoded list of well-known public Sleeper
// usernames so the snowball reaches many independent league graphs immediately
// instead of walking outward from a single account.
const SEED_USERNAMES = [
  'pykle',
  'scott_fish',    // Scott Fish Bowl organizer
  'jasonmoore',    // FantasyPros analyst
  'fullhousefantasy',
  'rotounderworld',
  'dynastydaddy',
  'fantasyfootballers',
  'underdog_fantasy',
  'mattharmon_bri',
  'papabeargetsw1',
  'kwikstats',
  'sickos_committee',
  'establish_the_run',
];
const MAX_DRAFTS = 3000;               // volume target (raised from 500)
const TIME_BUDGET_MS = 25 * 60 * 1000; // 25 minutes (raised from 8)
const RATE_LIMIT_MS = 500;     // 2 req/sec max

// --resume: if data/raw_picks.json already exists, load prior picks and skip
// draft_ids we've already collected, only fetching new drafts. Makes reruns fast.
const RESUME = process.argv.includes('--resume');

// Data-quality window: only keep drafts from the last 14 days. During Aug-Sep
// draft season the meta shifts fast (injuries, depth charts), so an old draft
// reflects a stale picture. We still explore the LEAGUE MEMBERS of old drafts —
// the user graph is the valuable part; a stale draft shouldn't stop the crawl.
const DATE_WINDOW_DAYS = 14;
const DATE_WINDOW_MS = DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const API = 'https://api.sleeper.app/v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastReq = 0;
async function throttledFetch(url) {
  const wait = RATE_LIMIT_MS - (Date.now() - lastReq);
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'RoundRoom/1.0' } });
    if (res.status === 429) {
      console.warn('  ! 429 rate limited, backing off 2s');
      await sleep(2000);
      return throttledFetch(url);
    }
    if (!res.ok) {
      console.warn(`  ! ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`  ! fetch error for ${url}: ${err.message}`);
    return null;
  }
}

async function main() {
  const startTime = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - startTime);

  const userFrontier = [...SEED_USERNAMES];   // usernames or user_ids to explore
  const seenUsers = new Set();                // usernames + user_ids we've queued/visited
  SEED_USERNAMES.forEach((u) => seenUsers.add(String(u).toLowerCase()));

  const seenLeagues = new Set();
  const seenDrafts = new Set();
  const completedDrafts = new Set();
  let picks = [];

  // --resume: reload previously collected picks and mark their draft_ids as
  // already-seen/completed so we skip re-fetching them. New drafts still append.
  if (RESUME) {
    const rawPath = path.join(DATA_DIR, 'raw_picks.json');
    if (fs.existsSync(rawPath)) {
      try {
        const prior = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
        if (Array.isArray(prior) && prior.length) {
          picks = prior;
          for (const p of prior) {
            if (p && p.draft_id) {
              seenDrafts.add(p.draft_id);
              completedDrafts.add(p.draft_id);
            }
          }
          console.log(
            `[resume] Loaded ${picks.length} prior picks from ` +
            `${completedDrafts.size} drafts — these will be skipped.`
          );
        }
      } catch (err) {
        console.warn(`[resume] Could not parse existing raw_picks.json: ${err.message}. Starting fresh.`);
      }
    } else {
      console.log('[resume] No existing raw_picks.json — starting fresh.');
    }
  }

  // Draft-level filter counters (feed data_quality.json downstream).
  let completedSeen = 0;    // all completed drafts encountered (pre-filter)
  let skippedTooOld = 0;    // completed but start_time older than the window
  let skippedAuction = 0;   // completed but non-snake (auction) — corrupts ADP
  const cutoff = Date.now() - DATE_WINDOW_MS;

  console.log(`Starting snowball crawl. Seeds: ${SEED_USERNAMES.join(', ')}`);
  console.log(`Targets: ${MAX_DRAFTS} completed drafts or ${TIME_BUDGET_MS / 60000}min\n`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const checkpoint = (reason) => {
    fs.writeFileSync(path.join(DATA_DIR, 'raw_picks.json'), JSON.stringify(picks));
    fs.writeFileSync(path.join(DATA_DIR, 'crawl_meta.json'), JSON.stringify({
      total_drafts: completedDrafts.size,
      total_picks: picks.length,
      crawled_at: new Date().toISOString(),
      seeds_used: SEED_USERNAMES,
      users_explored: seenUsers.size,
      leagues_seen: seenLeagues.size,
      // Draft-level filtering applied during the crawl (used by aggregate.js).
      completed_drafts_seen: completedSeen,
      skipped_too_old: skippedTooOld,
      skipped_auction: skippedAuction,
      date_window_days: DATE_WINDOW_DAYS,
      elapsed_seconds: Math.round((Date.now() - startTime) / 1000),
      stop_reason: reason,
    }, null, 2));
  };

  while (userFrontier.length > 0 && completedDrafts.size < MAX_DRAFTS && timeLeft() > 0) {
    const userRef = userFrontier.shift();

    // Resolve to a user object. userRef may be a username or a numeric user_id.
    let user;
    if (/^\d+$/.test(String(userRef))) {
      // numeric user_id — we can query leagues directly, no need to re-resolve
      user = { user_id: String(userRef), username: null };
    } else {
      const u = await throttledFetch(`${API}/user/${encodeURIComponent(userRef)}`);
      if (!u || !u.user_id) continue;
      user = u;
    }

    const leagues = await throttledFetch(`${API}/user/${user.user_id}/leagues/nfl/${SEASON}`);
    if (!Array.isArray(leagues)) continue;

    for (const league of leagues) {
      if (completedDrafts.size >= MAX_DRAFTS || timeLeft() <= 0) break;
      if (!league || !league.league_id || seenLeagues.has(league.league_id)) continue;
      seenLeagues.add(league.league_id);

      // Drafts for this league
      const drafts = await throttledFetch(`${API}/league/${league.league_id}/drafts`);
      if (Array.isArray(drafts)) {
        for (const draft of drafts) {
          if (!draft || !draft.draft_id || seenDrafts.has(draft.draft_id)) continue;
          seenDrafts.add(draft.draft_id);
          if (draft.status !== 'complete') continue;
          completedSeen++;
          if (completedDrafts.size >= MAX_DRAFTS) break;

          // --- Draft-level quality gates (still explore members below) ---
          // Skip AUCTION (and any non-ordered) drafts: their pick logic (dollar
          // values, not pick order) corrupts ADP. Keep both 'snake' and 'linear'
          // — a linear draft still has meaningful overall pick numbers (pick N =
          // overall pick N), exactly like snake, so its ADP is valid. Filtering
          // to snake-only would needlessly discard ~15% of real ordered drafts.
          if (draft.type !== 'snake' && draft.type !== 'linear') {
            skippedAuction++;
            continue;
          }
          // Recency window: skip drafts older than 14 days. start_time is unix
          // ms; fall back to last_picked if start_time is missing.
          const startTs = draft.start_time || draft.last_picked || 0;
          if (!startTs || startTs < cutoff) {
            skippedTooOld++;
            continue;
          }

          const draftPicks = await throttledFetch(`${API}/draft/${draft.draft_id}/picks`);
          if (!Array.isArray(draftPicks) || draftPicks.length === 0) continue;

          // league size for bucketing — teams count from draft settings or league
          const teams =
            (draft.settings && draft.settings.teams) ||
            league.total_rosters ||
            12;

          // Denormalized draft-level fields so aggregate.js can filter without
          // re-fetching the draft object. end_time proxy = last_picked.
          const draftEndTs = draft.last_picked || 0;
          const draftDurationMs =
            startTs && draftEndTs && draftEndTs > startTs ? draftEndTs - startTs : null;

          for (const p of draftPicks) {
            const meta = p.metadata || {};
            const name =
              (meta.first_name && meta.last_name)
                ? `${meta.first_name} ${meta.last_name}`.trim()
                : (meta.first_name || meta.last_name || null);
            // Autopick flag can appear top-level or in metadata depending on the
            // draft — capture either so aggregate.js can spot autopick-heavy drafts.
            const isAutopick = p.is_autopick === true || meta.is_autopick === true ||
              meta.is_autopick === 'true';
            picks.push({
              draft_id: draft.draft_id,
              pick_no: p.pick_no,
              player_id: p.player_id,
              player_name: name,
              position: meta.position || null,
              team: meta.team || null,
              round: p.round,
              roster_slot: p.draft_slot,
              league_size: teams,
              // Denormalized draft metadata for downstream filtering.
              draft_start_time: startTs,
              draft_type: draft.type,
              draft_duration_ms: draftDurationMs,
              // Owner of this pick — used to detect duplicate-owner test leagues.
              picked_by: p.picked_by || null,
              is_autopick: isAutopick,
              metadata: meta,
            });
          }
          completedDrafts.add(draft.draft_id);
          if (completedDrafts.size % 10 === 0 || completedDrafts.size <= 5) {
            console.log(
              `[${completedDrafts.size} drafts / ${picks.length} picks] ` +
              `frontier=${userFrontier.length} leagues=${seenLeagues.size} ` +
              `t=${Math.round((Date.now() - startTime) / 1000)}s`
            );
          }
          // Periodic checkpoint so partial progress survives interruption.
          if (completedDrafts.size % 25 === 0) checkpoint('in_progress');
        }
      }

      // Expand frontier with league members
      const members = await throttledFetch(`${API}/league/${league.league_id}/users`);
      if (Array.isArray(members)) {
        for (const m of members) {
          if (!m || !m.user_id) continue;
          const key = String(m.user_id).toLowerCase();
          if (seenUsers.has(key)) continue;
          seenUsers.add(key);
          userFrontier.push(m.user_id);
        }
      }
    }
  }

  const meta = {
    total_drafts: completedDrafts.size,
    total_picks: picks.length,
    crawled_at: new Date().toISOString(),
    seeds_used: SEED_USERNAMES,
    users_explored: seenUsers.size,
    leagues_seen: seenLeagues.size,
    completed_drafts_seen: completedSeen,
    skipped_too_old: skippedTooOld,
    skipped_auction: skippedAuction,
    date_window_days: DATE_WINDOW_DAYS,
    elapsed_seconds: Math.round((Date.now() - startTime) / 1000),
    stop_reason:
      completedDrafts.size >= MAX_DRAFTS ? 'max_drafts'
      : timeLeft() <= 0 ? 'time_budget'
      : 'frontier_exhausted',
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'raw_picks.json'), JSON.stringify(picks));
  fs.writeFileSync(path.join(DATA_DIR, 'crawl_meta.json'), JSON.stringify(meta, null, 2));

  console.log('\n=== Crawl complete ===');
  console.log(JSON.stringify(meta, null, 2));
  console.log(
    `Draft filtering: ${completedSeen} completed seen -> ` +
    `${skippedAuction} auction skipped, ${skippedTooOld} too-old skipped -> ` +
    `${completedDrafts.size} kept.`
  );
  console.log(`Wrote ${picks.length} picks from ${completedDrafts.size} drafts.`);
}

main().catch((err) => {
  console.error('Fatal crawl error:', err);
  process.exit(1);
});
