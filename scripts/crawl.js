#!/usr/bin/env node
/**
 * crawl.js — Sleeper snowball crawler
 *
 * There is no "list all drafts" endpoint on Sleeper, so we snowball outward
 * from a seed username: user -> leagues -> drafts -> picks, and league users
 * feed the frontier for more users to explore.
 *
 * Efficiency features:
 *   - Persistent frontier: seenUsers, seenLeagues, userFrontier saved between
 *     runs so we don't re-walk 10k+ users every time.
 *   - Known leagues: leagues that produced snake/linear drafts are saved and
 *     checked directly at the start of each run (Phase 1) before the snowball.
 *   - Time budget is 75 minutes — more headroom for the frontier to explore
 *     genuinely new territory instead of re-walking known ground.
 *
 * Output:
 *   data/raw_picks.json        — array of pick objects
 *   data/crawl_meta.json       — run stats
 *   data/crawl_frontier.json   — persisted user graph state (seenUsers etc.)
 *   data/known_leagues.json    — leagues confirmed to have snake/linear drafts
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SEASON = '2026';

const SEED_USERNAMES = [
  // Core / existing
  'pykle',
  'scott_fish',           // Scott Fish Bowl organizer — massive SF tournament
  'jasonmoore',           // FantasyPros analyst
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
  'ralphweetamoe',
  'thefantasyfootballers',
  'theringer',
  'rotoballer',
  'pfref',
  'dynastyleaguefootball',

  // SF / 2QB community — added to grow SF draft pool
  'superflexdude',        // John Hogue, @SuperFlexDude — dedicated SF/2QB analyst
  'jjzachariason',        // JJ Zachariason — dynasty/SF analyst
  'dynastynerds',         // Dynasty Nerds — SF-heavy dynasty community
  '4for4football',        // 4for4.com analysts
  'footballguys',         // FootballGuys — SFB OG participants
  'fantasylife',          // FantasyLife / Adam Aizer
  'bestballers',          // Best Ball Network — SF best ball heavy
  'superflex_show',       // The SuperFlex Show podcast
  'aaronpiersol',         // SFB regular
  'kdickey',              // Known SFB/SF community participant
  'glennweiss',           // Glen Weiss — longtime SFB participant
  'joe_pisapia',          // Joe Pisapia — analyst, SFB player
  'sharpfootball',        // Sharp Football Analysis
  'mikeclayff',           // Mike Clay ESPN — known SF/2QB ranker
  'nateabrams',           // Nate Abrams — SF analyst
];

const MAX_DRAFTS = 3000;
const TIME_BUDGET_MS = 75 * 60 * 1000; // 75 minutes
const RATE_LIMIT_MS = 500;              // 2 req/sec

// Frontier persistence: saved user-graph state reused across runs.
// Cleared automatically if older than this threshold (user graphs shift).
const FRONTIER_PATH = path.join(DATA_DIR, 'crawl_frontier.json');
const KNOWN_LEAGUES_PATH = path.join(DATA_DIR, 'known_leagues.json');
const FRONTIER_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// --resume: reload prior picks from raw_picks.json and skip those draft_ids.
const RESUME = process.argv.includes('--resume');

// Only keep drafts from the last 14 days. Draft meta shifts fast in Aug–Sep.
// We still explore LEAGUE MEMBERS of old drafts — graph is the valuable part.
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

// Fetch and process all picks from a single draft. Returns the number of picks
// added, or 0 if the draft was skipped. Mutates picks[], completedDrafts, and
// the filter counters passed in.
async function processDraft(draft, { picks, completedDrafts, league, cutoff, counters }) {
  if (!draft || !draft.draft_id) return 0;
  if (draft.status !== 'complete') return 0;
  counters.completedSeen++;

  if (draft.type !== 'snake' && draft.type !== 'linear') {
    counters.skippedAuction++;
    return 0;
  }
  const startTs = draft.start_time || draft.last_picked || 0;
  if (!startTs || startTs < cutoff) {
    counters.skippedTooOld++;
    return 0;
  }

  // SuperFlex detection: league roster (when available) or draft settings.
  const rosterPositions = draft.settings?.roster_positions ||
                          (league?.roster_positions) || [];
  const isSf = rosterPositions.includes('SUPER_FLEX');

  const draftPicks = await throttledFetch(`${API}/draft/${draft.draft_id}/picks`);
  if (!Array.isArray(draftPicks) || draftPicks.length === 0) return 0;

  const teams = (draft.settings && draft.settings.teams) || (league && league.total_rosters) || 12;
  const draftEndTs = draft.last_picked || 0;
  const draftDurationMs = startTs && draftEndTs && draftEndTs > startTs ? draftEndTs - startTs : null;

  for (const p of draftPicks) {
    const meta = p.metadata || {};
    const name = (meta.first_name && meta.last_name)
      ? `${meta.first_name} ${meta.last_name}`.trim()
      : (meta.first_name || meta.last_name || null);
    const isAutopick = p.is_autopick === true || meta.is_autopick === true || meta.is_autopick === 'true';
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
      draft_start_time: startTs,
      draft_type: draft.type,
      draft_duration_ms: draftDurationMs,
      picked_by: p.picked_by || null,
      is_autopick: isAutopick,
      is_sf: isSf,
      metadata: meta,
    });
  }
  completedDrafts.add(draft.draft_id);
  return draftPicks.length;
}

async function main() {
  const startTime = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - startTime);

  // ── Initialize graph state ──────────────────────────────────────────────
  const seenUsers = new Set();
  SEED_USERNAMES.forEach(u => seenUsers.add(String(u).toLowerCase()));
  const userFrontier = [...SEED_USERNAMES];
  const seenLeagues = new Set();    // leagues we've already expanded members for
  const seenDrafts = new Set();     // draft_ids already processed this or prior runs
  const completedDrafts = new Set();
  const knownLeagues = new Set();   // leagues confirmed to have snake/linear drafts
  let picks = [];

  const cutoff = Date.now() - DATE_WINDOW_MS;

  // ── Load persistent frontier ────────────────────────────────────────────
  if (fs.existsSync(FRONTIER_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(FRONTIER_PATH, 'utf8'));
      const age = Date.now() - new Date(saved.saved_at).getTime();
      if (age < FRONTIER_MAX_AGE_MS) {
        let restoredUsers = 0, restoredLeagues = 0, restoredDrafts = 0, restoredFrontier = 0;
        (saved.seenUsers || []).forEach(u => { seenUsers.add(u); restoredUsers++; });
        (saved.seenLeagues || []).forEach(l => { seenLeagues.add(l); restoredLeagues++; });
        (saved.seenDrafts || []).forEach(d => { seenDrafts.add(d); restoredDrafts++; });
        // Prepend saved frontier (unexplored users from last run) but skip any now-seen
        const pending = (saved.userFrontier || []).filter(u => !seenUsers.has(String(u).toLowerCase()));
        userFrontier.unshift(...pending);
        restoredFrontier = pending.length;
        console.log(`[frontier] Restored: ${restoredUsers} seen users, ${restoredLeagues} seen leagues, ${restoredDrafts} seen drafts, +${restoredFrontier} pending users`);
      } else {
        console.log(`[frontier] ${Math.round(age / 86400000 * 10) / 10}d old — starting fresh`);
        try { fs.unlinkSync(FRONTIER_PATH); } catch (_) {}
      }
    } catch (e) {
      console.warn(`[frontier] Load failed: ${e.message} — starting fresh`);
    }
  } else {
    console.log('[frontier] No saved frontier — starting fresh snowball');
  }

  // ── Load known leagues ──────────────────────────────────────────────────
  let knownLeaguesList = [];
  if (fs.existsSync(KNOWN_LEAGUES_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(KNOWN_LEAGUES_PATH, 'utf8'));
      knownLeaguesList = saved.leagues || [];
      knownLeaguesList.forEach(l => knownLeagues.add(l));
      console.log(`[known-leagues] Loaded ${knownLeaguesList.length} leagues — checking these first`);
    } catch (e) {
      console.warn(`[known-leagues] Load failed: ${e.message}`);
    }
  }

  // ── Resume: reload prior picks ──────────────────────────────────────────
  if (RESUME) {
    // Standard and SF picks are stored in separate files — reload both.
    let priorTotal = 0;
    for (const file of ['raw_picks.json', 'raw_picks_sf.json']) {
      const rawPath = path.join(DATA_DIR, file);
      if (!fs.existsSync(rawPath)) continue;
      try {
        const prior = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
        if (Array.isArray(prior) && prior.length) {
          priorTotal += prior.length;
          const fresh = prior.filter(p => p && p.draft_id && p.draft_start_time && p.draft_start_time >= cutoff);
          picks.push(...fresh);
          for (const p of fresh) { seenDrafts.add(p.draft_id); completedDrafts.add(p.draft_id); }
        }
      } catch (e) {
        console.warn(`[resume] Could not parse ${file}: ${e.message} — skipping`);
      }
    }
    if (priorTotal > 0) {
      console.log(`[resume] Loaded ${priorTotal} prior picks; kept ${picks.length} within ${DATE_WINDOW_DAYS}d from ${completedDrafts.size} drafts`);
    } else {
      console.log('[resume] No existing raw picks — starting fresh');
    }
  }

  // Filter counters
  const counters = { completedSeen: 0, skippedTooOld: 0, skippedAuction: 0 };

  // Checkpoint: save picks + meta + frontier to disk
  const checkpoint = (reason) => {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Split standard vs SuperFlex picks into separate files so the two ADP
    // populations never mix.
    const sfPicks = picks.filter(p => p.is_sf);
    const stdPicks = picks.filter(p => !p.is_sf);
    fs.writeFileSync(path.join(DATA_DIR, 'raw_picks.json'), JSON.stringify(stdPicks));
    fs.writeFileSync(path.join(DATA_DIR, 'raw_picks_sf.json'), JSON.stringify(sfPicks));
    fs.writeFileSync(path.join(DATA_DIR, 'crawl_meta.json'), JSON.stringify({
      total_drafts: completedDrafts.size,
      total_picks: picks.length,
      picks_standard: stdPicks.length,
      picks_sf: sfPicks.length,
      crawled_at: new Date().toISOString(),
      seeds_used: SEED_USERNAMES,
      users_explored: seenUsers.size,
      leagues_seen: seenLeagues.size,
      known_leagues: knownLeagues.size,
      completed_drafts_seen: counters.completedSeen,
      skipped_too_old: counters.skippedTooOld,
      skipped_auction: counters.skippedAuction,
      date_window_days: DATE_WINDOW_DAYS,
      elapsed_seconds: Math.round((Date.now() - startTime) / 1000),
      stop_reason: reason,
    }, null, 2));
    // Save frontier state for the next run
    fs.writeFileSync(FRONTIER_PATH, JSON.stringify({
      saved_at: new Date().toISOString(),
      seenUsers: [...seenUsers],
      seenLeagues: [...seenLeagues],
      seenDrafts: [...seenDrafts],
      userFrontier: [...userFrontier],
    }));
    // Save known leagues
    fs.writeFileSync(KNOWN_LEAGUES_PATH, JSON.stringify({
      saved_at: new Date().toISOString(),
      leagues: [...knownLeagues],
    }, null, 2));
  };

  console.log(`\nStarting crawl. Seeds: ${SEED_USERNAMES.length} usernames`);
  console.log(`Targets: ${MAX_DRAFTS} drafts or ${TIME_BUDGET_MS / 60000}min\n`);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // ── Phase 1: Check known productive leagues directly ────────────────────
  // Skip the user graph entirely for leagues we already know are active.
  // This catches new drafts that completed since the last run without any
  // user traversal overhead.
  if (knownLeaguesList.length > 0 && timeLeft() > 0) {
    console.log(`[phase 1] Checking ${knownLeaguesList.length} known leagues for new drafts...`);
    let phase1New = 0;
    for (const leagueId of knownLeaguesList) {
      if (completedDrafts.size >= MAX_DRAFTS || timeLeft() <= 0) break;

      const drafts = await throttledFetch(`${API}/league/${leagueId}/drafts`);
      if (!Array.isArray(drafts)) continue;

      // Mark as seen so Phase 2 skips member expansion (already in seenUsers from prior runs)
      seenLeagues.add(leagueId);

      for (const draft of drafts) {
        if (!draft || !draft.draft_id || seenDrafts.has(draft.draft_id)) continue;
        seenDrafts.add(draft.draft_id);
        if (completedDrafts.size >= MAX_DRAFTS) break;
        const added = await processDraft(draft, { picks, completedDrafts, league: null, cutoff, counters });
        if (added > 0) phase1New++;
      }
    }
    console.log(`[phase 1] ${phase1New} new drafts from known leagues. Starting snowball...\n`);
  }

  // ── Phase 2: Snowball crawl ─────────────────────────────────────────────
  // Walk the user frontier. Thanks to the persisted frontier, we skip users
  // and leagues already explored in prior runs and only traverse new territory.
  while (userFrontier.length > 0 && completedDrafts.size < MAX_DRAFTS && timeLeft() > 0) {
    const userRef = userFrontier.shift();

    let user;
    if (/^\d+$/.test(String(userRef))) {
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

      const drafts = await throttledFetch(`${API}/league/${league.league_id}/drafts`);
      if (Array.isArray(drafts)) {
        for (const draft of drafts) {
          if (!draft || !draft.draft_id || seenDrafts.has(draft.draft_id)) continue;
          seenDrafts.add(draft.draft_id);

          // Track any league with a snake/linear draft (even old ones) for Phase 1 next run
          if (draft.type === 'snake' || draft.type === 'linear') {
            knownLeagues.add(league.league_id);
          }

          if (completedDrafts.size >= MAX_DRAFTS) break;
          await processDraft(draft, { picks, completedDrafts, league, cutoff, counters });
        }
      }

      if (completedDrafts.size % 10 === 0 && completedDrafts.size > 0) {
        console.log(
          `[${completedDrafts.size} drafts / ${picks.length} picks] ` +
          `frontier=${userFrontier.length} leagues=${seenLeagues.size} known=${knownLeagues.size} ` +
          `t=${Math.round((Date.now() - startTime) / 1000)}s`
        );
      }
      if (completedDrafts.size % 25 === 0 && completedDrafts.size > 0) checkpoint('in_progress');

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

  const stopReason =
    completedDrafts.size >= MAX_DRAFTS ? 'max_drafts'
    : timeLeft() <= 0 ? 'time_budget'
    : 'frontier_exhausted';

  checkpoint(stopReason);

  console.log('\n=== Crawl complete ===');
  console.log(`Stop reason: ${stopReason}`);
  console.log(`Drafts: ${completedDrafts.size} | Picks: ${picks.length} | Known leagues saved: ${knownLeagues.size}`);
  console.log(
    `Filter: ${counters.completedSeen} completed → ${counters.skippedAuction} auction + ` +
    `${counters.skippedTooOld} too-old skipped → ${completedDrafts.size} kept`
  );
  console.log(`Time: ${Math.round((Date.now() - startTime) / 1000)}s | Users seen: ${seenUsers.size} | Leagues seen: ${seenLeagues.size}`);
}

main().catch((err) => {
  console.error('Fatal crawl error:', err);
  process.exit(1);
});
