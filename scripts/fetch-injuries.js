#!/usr/bin/env node
/**
 * fetch-injuries.js — pull current NFL injury statuses from the free Sleeper
 * players API and write a compact data/injuries.json for merge-sources.js.
 *
 * Source: https://api.sleeper.app/v1/players/nfl
 *   One large (~5MB) JSON object keyed by player_id. We keep only players with
 *   a non-null injury_status at a fantasy-relevant position (QB/RB/WR/TE/K).
 *
 * Output: data/injuries.json
 *   {
 *     "fetched_at": "ISO timestamp",
 *     "players": [
 *       { "name", "position", "team", "status", "body_part", "note"? }
 *     ]
 *   }
 *
 * Also writes data/bye-weeks.json — a team-level bye week map extracted from
 * the same response (all players on a team share the same bye_week):
 *   {
 *     "fetched_at": "ISO timestamp",
 *     "bye_weeks": { "LAR": 9, "KC": 14, ... }
 *   }
 * If the players payload carries no bye_week fields (Sleeper omits them at
 * times), byes are derived from the regular-season schedule instead: each
 * team's bye is the one week in 1-18 it does not play.
 *
 * Node 18+ built-ins only (native fetch).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const API_URL = 'https://api.sleeper.app/v1/players/nfl';
const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);

// Fallback: derive team bye weeks from the regular-season schedule when the
// players payload has no bye_week fields. A team's bye is the single week in
// 1-18 where it appears in no scheduled game.
async function fetchByeWeeksFromSchedule() {
  const stateRes = await fetch('https://api.sleeper.app/v1/state/nfl');
  if (!stateRes.ok) throw new Error(`Sleeper state API returned HTTP ${stateRes.status}`);
  const season = (await stateRes.json()).season || new Date().getFullYear();

  const schedRes = await fetch(`https://api.sleeper.app/schedule/nfl/regular/${season}`);
  if (!schedRes.ok) throw new Error(`Sleeper schedule API returned HTTP ${schedRes.status}`);
  const games = await schedRes.json();
  if (!Array.isArray(games) || games.length === 0) throw new Error('empty schedule response');

  const weeks = new Map(); // week -> Set(teams playing)
  const teams = new Set();
  for (const g of games) {
    const w = Number(g && g.week);
    if (!Number.isFinite(w) || w < 1 || w > 18) continue;
    if (!weeks.has(w)) weeks.set(w, new Set());
    for (const t of [g.home, g.away]) {
      if (t) { weeks.get(w).add(t); teams.add(t); }
    }
  }

  const byes = {};
  for (const t of teams) {
    const off = [];
    for (let w = 1; w <= 18; w++) {
      if (!weeks.get(w) || !weeks.get(w).has(t)) off.push(w);
    }
    // Exactly one off week => that's the bye. Anything else means the
    // schedule is incomplete for this team — skip rather than guess.
    if (off.length === 1) byes[t] = off[0];
  }
  return byes;
}

async function main() {
  console.log(`Fetching ${API_URL} ...`);
  const res = await fetch(API_URL);
  if (!res.ok) {
    throw new Error(`Sleeper players API returned HTTP ${res.status}`);
  }
  // Single large JSON body — read it fully, then parse.
  const all = await res.json();

  const players = [];
  const byeWeeks = {};
  for (const player of Object.values(all)) {
    if (!player || typeof player !== 'object') continue;

    // Team-level bye week map — every player on a team shares the same
    // bye_week, so first valid value per team wins.
    const bye = Number(player.bye_week);
    if (player.team && Number.isFinite(bye) && bye > 0 && byeWeeks[player.team] == null) {
      byeWeeks[player.team] = bye;
    }

    if (player.injury_status == null) continue;
    if (!POSITIONS.has(player.position)) continue;
    if (!player.full_name) continue;

    const rec = {
      name: player.full_name,
      position: player.position,
      team: player.team || null,
      status: player.injury_status,
      body_part: player.injury_body_part || null,
    };

    // Optional short note from the first news entry, if present.
    if (Array.isArray(player.news) && player.news.length > 0) {
      const first = player.news[0] || {};
      const text = first.analysis || first.content;
      if (text) rec.note = String(text).slice(0, 120);
    }

    players.push(rec);
  }

  // Stable ordering: by name for readable diffs in git.
  players.sort((a, b) => a.name.localeCompare(b.name));

  const out = {
    fetched_at: new Date().toISOString(),
    players,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'injuries.json'), JSON.stringify(out, null, 2));

  // Bye weeks — fall back to schedule derivation when the players payload
  // carried no bye_week fields.
  if (Object.keys(byeWeeks).length === 0) {
    console.log('No bye_week fields on players — deriving byes from schedule ...');
    try {
      Object.assign(byeWeeks, await fetchByeWeeksFromSchedule());
    } catch (err) {
      console.warn(`  ! schedule bye derivation failed: ${err.message}`);
    }
  }

  // Stable key order for readable git diffs.
  const byeOut = {
    fetched_at: out.fetched_at,
    bye_weeks: Object.fromEntries(
      Object.keys(byeWeeks).sort().map((t) => [t, byeWeeks[t]])
    ),
  };
  fs.writeFileSync(path.join(DATA_DIR, 'bye-weeks.json'), JSON.stringify(byeOut, null, 2));
  console.log(`Wrote bye-weeks.json: ${Object.keys(byeOut.bye_weeks).length} teams.`);

  const byStatus = {};
  players.forEach((p) => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
  console.log(`Wrote injuries.json: ${players.length} injured QB/RB/WR/TE/K players.`);
  Object.entries(byStatus).forEach(([s, n]) => console.log(`  ${s}: ${n}`));
}

main().catch((err) => {
  console.error(`fetch-injuries failed: ${err.message}`);
  process.exit(1);
});
