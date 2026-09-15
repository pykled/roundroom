#!/usr/bin/env node
/**
 * scrape-fpa.js — fantasy points allowed (FPA) per team per position for the
 * current season, written to data/fpa-current.json for the lineup optimizer's
 * matchup factor (shared/weekly-score.js → matchupMultiplier reads
 * fpa.current[pos][TEAM]). Run weekly by .github/workflows/update-fpa.yml.
 *
 * Where the numbers come from
 * ---------------------------
 * FantasyPros publishes the canonical FPA table at
 * https://www.fantasypros.com/nfl/points-allowed.php, but the public page
 * server-renders only 10 of 32 teams — the rest sit behind a free account.
 * The per-position matchup pages (https://www.fantasypros.com/nfl/matchups/
 * {qb,rb,wr,te}.php) are fully public but carry only each opponent's
 * matchup rank (#1–#32 against the position), never points — and that rank
 * is FantasyPros' own blended rating, not this season's points allowed
 * (week 1 2026: ARI ranked #22 on the points-allowed page but #14 on the
 * QB matchup page).
 *
 * Sleeper's weekly stat feed (api.sleeper.com/stats/nfl/{season}/{week})
 * tags every stat line with `opponent`, and summing pts_half_ppr by opponent
 * and position reproduces FantasyPros' half-PPR FPA to the decimal
 * (verified week 1 2026: ARI QB 14.3 / RB 9.2 / WR 22.9 / TE 12.5 match, and
 * the derived ranks match the points-allowed page's RK column). So:
 *   current[pos][TEAM]        = Σ half-PPR points scored against TEAM by players
 *                               at pos over completed weeks ÷ games TEAM played
 *   fpMatchupRanks[pos][TEAM] = FantasyPros' matchup-page rank, kept for
 *                               reference only (best effort; the engine
 *                               ignores it)
 *
 * Output: data/fpa-current.json
 *   {
 *     week: 3,             // upcoming week the file is meant for
 *     throughWeek: 2,      // last completed week included in the averages
 *     season: "2026",
 *     scoring: "half_ppr",
 *     updatedAt: ISO timestamp,
 *     source: { points: "sleeper", fpMatchupRanks: "fantasypros" | null },
 *     games:   { KC: 2, … },                 // games played per defence
 *     current: { QB: { KC: 21.3, … }, RB: {…}, WR: {…}, TE: {…}, K: {…} },
 *     fpMatchupRanks: { QB: { KC: 7, … }, … } // FantasyPros, 1 = easiest matchup
 *   }
 *
 * Exits 0 without writing when no week has finished yet (pre-season), so the
 * previous file — or its absence — stands. Exits 1 when Sleeper is unreachable
 * so the Actions run goes red instead of committing thin data.
 *
 * Node 18+ built-ins only (native fetch).
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'fpa-current.json');
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K'];
const SCORING_KEY = 'pts_half_ppr';   // matches FantasyPros' published FPA
const MIN_TEAMS_FOR_COMPLETE_WEEK = 24; // a week counts once (nearly) every game has stats

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// FantasyPros → Sleeper team codes. Everything else already matches.
const FP_TO_SLEEPER = { JAC: 'JAX', WSH: 'WAS', LA: 'LAR', OAK: 'LV', SD: 'LAC', STL: 'LAR' };

async function getJson(url, timeoutMs = 20000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function getText(url, timeoutMs = 30000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// One completed week of Sleeper stats → { [TEAM]: { [pos]: points } } plus the
// set of defences that played (appeared as an opponent).
async function fetchWeekAllowed(season, week) {
  const url = `https://api.sleeper.com/stats/nfl/${season}/${week}?season_type=regular&` +
    POSITIONS.map((p) => `position[]=${p}`).join('&');
  const rows = await getJson(url);
  if (!Array.isArray(rows)) throw new Error(`unexpected stats payload for week ${week}`);
  const allowed = {};
  const played = new Set();
  for (const r of rows) {
    const pos = r && r.player && r.player.position;
    const opp = r && r.opponent;
    if (!opp || POSITIONS.indexOf(pos) < 0) continue;
    played.add(opp);
    const pts = Number(r.stats && r.stats[SCORING_KEY]) || 0;
    (allowed[opp] = allowed[opp] || {})[pos] = (allowed[opp][pos] || 0) + pts;
  }
  return { allowed, played };
}

// FantasyPros matchup page → { [TEAM]: rank } for one position. Every matchup
// cell carries the opponent's *current* rank against the position, so any
// cell that mentions a team gives its rank; we take the first and verify the
// rest agree.
function parseMatchupRanks(html) {
  const ranks = {};
  const conflicts = new Set();
  const re = /<td class="matchup-cell[^"]*"[^>]*data-sort="(\d+)"[^>]*>[\s\S]*?opponents-text[^>]*>\s*(?:vs\.|at)\s+([A-Z]{2,3})<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const rank = Number(m[1]);
    const team = FP_TO_SLEEPER[m[2]] || m[2];
    if (!(rank >= 1 && rank <= 32)) continue;
    if (ranks[team] == null) ranks[team] = rank;
    else if (ranks[team] !== rank) conflicts.add(team);
  }
  return { ranks, conflicts: [...conflicts] };
}

async function fetchFantasyProsRanks() {
  const out = {};
  for (const pos of POSITIONS) {
    if (pos === 'K') continue; // FantasyPros has no public matchup page for kickers
    const url = `https://www.fantasypros.com/nfl/matchups/${pos.toLowerCase()}.php`;
    try {
      const { ranks, conflicts } = parseMatchupRanks(await getText(url));
      const n = Object.keys(ranks).length;
      if (n < 20) throw new Error(`only ${n} teams parsed`);
      if (conflicts.length) console.warn(`  ! ${pos}: inconsistent ranks for ${conflicts.join(', ')} (kept first seen)`);
      out[pos] = ranks;
      console.log(`  FantasyPros ${pos}: ${n} teams ranked`);
    } catch (err) {
      console.warn(`  ! FantasyPros ${pos} ranks unavailable: ${err.message}`);
    }
  }
  return Object.keys(out).length ? out : null;
}

function rankByValue(values) {
  // 1 = allows the most points; ties share the lower rank number
  const sorted = Object.keys(values).sort((a, b) => values[b] - values[a]);
  const rank = {};
  sorted.forEach((t, i) => { rank[t] = i > 0 && values[t] === values[sorted[i - 1]] ? rank[sorted[i - 1]] : i + 1; });
  return rank;
}

function sortedObject(obj, digits) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = digits == null ? obj[k] : Number(obj[k].toFixed(digits));
  return out;
}

async function main() {
  const state = await getJson('https://api.sleeper.app/v1/state/nfl');
  const season = String(state.season || new Date().getFullYear());
  // state.week is the week Sleeper considers current; the week before it is
  // the latest that can be complete. Actual completeness is checked per week.
  const lastCandidate = Math.min(18, Math.max(0, Number(state.week) || 0));
  console.log(`Season ${season}, Sleeper week ${state.week} (display ${state.display_week}). Checking weeks 1-${lastCandidate} …`);

  const totals = {};   // TEAM → pos → summed points
  const games = {};    // TEAM → games played
  let throughWeek = 0;
  for (let w = 1; w <= lastCandidate; w++) {
    const { allowed, played } = await fetchWeekAllowed(season, w);
    if (played.size < MIN_TEAMS_FOR_COMPLETE_WEEK) {
      console.log(`  week ${w}: ${played.size} defences with stats — not complete, stopping here`);
      break;
    }
    for (const team of played) {
      games[team] = (games[team] || 0) + 1;
      totals[team] = totals[team] || {};
      for (const pos of POSITIONS) totals[team][pos] = (totals[team][pos] || 0) + ((allowed[team] && allowed[team][pos]) || 0);
    }
    throughWeek = w;
    console.log(`  week ${w}: ${played.size} defences, complete`);
  }

  if (!throughWeek) {
    console.log('No completed week yet — leaving data/fpa-current.json untouched.');
    return;
  }

  const current = {};
  for (const pos of POSITIONS) {
    const byTeam = {};
    for (const team of Object.keys(totals)) byTeam[team] = totals[team][pos] / games[team];
    current[pos] = sortedObject(byTeam, 1);
  }

  console.log('Fetching FantasyPros matchup-page ranks (reference only) …');
  const ranks = await fetchFantasyProsRanks();
  if (ranks) {
    for (const pos of Object.keys(ranks)) {
      // Informational: FantasyPros blends prior seasons into its matchup rating,
      // so early-season divergence from the pure FPA rank is expected.
      const mine = rankByValue(current[pos]);
      const off = Object.keys(ranks[pos]).filter((t) => mine[t] != null && Math.abs(mine[t] - ranks[pos][t]) > 3);
      console.log(`  ${pos}: ${off.length}/${Object.keys(ranks[pos]).length} teams sit >3 places from FantasyPros' matchup rank`);
      ranks[pos] = sortedObject(ranks[pos]);
    }
  }

  const out = {
    week: throughWeek + 1,
    throughWeek,
    season,
    scoring: 'half_ppr',
    updatedAt: new Date().toISOString(),
    source: { points: 'sleeper', fpMatchupRanks: ranks ? 'fantasypros' : null },
    games: sortedObject(games),
    current,
    fpMatchupRanks: ranks || {},
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${Object.keys(games).length} teams through week ${throughWeek} (for week ${out.week}).`);
}

main().catch((err) => {
  console.error(`scrape-fpa failed: ${err.message}`);
  process.exit(1);
});
