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
 * Node 18+ built-ins only (native fetch).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const API_URL = 'https://api.sleeper.app/v1/players/nfl';
const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);

async function main() {
  console.log(`Fetching ${API_URL} ...`);
  const res = await fetch(API_URL);
  if (!res.ok) {
    throw new Error(`Sleeper players API returned HTTP ${res.status}`);
  }
  // Single large JSON body — read it fully, then parse.
  const all = await res.json();

  const players = [];
  for (const player of Object.values(all)) {
    if (!player || typeof player !== 'object') continue;
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

  const byStatus = {};
  players.forEach((p) => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
  console.log(`Wrote injuries.json: ${players.length} injured QB/RB/WR/TE/K players.`);
  Object.entries(byStatus).forEach(([s, n]) => console.log(`  ${s}: ${n}`));
}

main().catch((err) => {
  console.error(`fetch-injuries failed: ${err.message}`);
  process.exit(1);
});
