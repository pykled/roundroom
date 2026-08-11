#!/usr/bin/env node
/**
 * aggregate.js — compute ADP (average draft position) from raw picks.
 *
 * Reads data/raw_picks.json, groups by player (name + position), and computes
 * mean pick, stdev, high, low, and times_drafted. Only players drafted in
 * >= 5 drafts are included.
 *
 * Output: data/adp.json
 *   { generated_at, total_drafts, players: [ { name, position, team, adp,
 *     stdev, high, low, times_drafted } ] } sorted by adp ascending.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MIN_DRAFTS = 5;

function main() {
  const rawPath = path.join(DATA_DIR, 'raw_picks.json');
  if (!fs.existsSync(rawPath)) {
    console.error('data/raw_picks.json not found. Run crawl.js first.');
    process.exit(1);
  }

  const picks = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  console.log(`Loaded ${picks.length} picks.`);

  const draftIds = new Set();
  const groups = new Map(); // key -> { name, position, team, picks: [pick_no...] }

  for (const p of picks) {
    if (p.draft_id) draftIds.add(p.draft_id);
    const name = (p.player_name || '').trim();
    const pos = (p.position || '').trim().toUpperCase();
    if (!name || !pos) continue;
    if (typeof p.pick_no !== 'number' || p.pick_no <= 0) continue;

    const key = `${name.toLowerCase()}|${pos}`;
    if (!groups.has(key)) {
      groups.set(key, { name, position: pos, team: p.team || null, picks: [] });
    }
    const g = groups.get(key);
    g.picks.push(p.pick_no);
    // Keep a team if we didn't have one
    if (!g.team && p.team) g.team = p.team;
  }

  const players = [];
  for (const g of groups.values()) {
    const n = g.picks.length;
    if (n < MIN_DRAFTS) continue;
    const sum = g.picks.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const variance = g.picks.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const stdev = Math.sqrt(variance);
    players.push({
      name: g.name,
      position: g.position,
      team: g.team,
      adp: Math.round(mean * 100) / 100,
      stdev: Math.round(stdev * 100) / 100,
      high: Math.min(...g.picks),
      low: Math.max(...g.picks),
      times_drafted: n,
    });
  }

  players.sort((a, b) => a.adp - b.adp);

  const out = {
    generated_at: new Date().toISOString(),
    total_drafts: draftIds.size,
    players,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'adp.json'), JSON.stringify(out, null, 2));
  console.log(
    `Wrote adp.json: ${players.length} players (>=${MIN_DRAFTS} drafts) ` +
    `from ${draftIds.size} drafts.`
  );
  if (players.length) {
    console.log('Top 5 by ADP:');
    players.slice(0, 5).forEach((p, i) =>
      console.log(`  ${i + 1}. ${p.name} (${p.position}) adp=${p.adp} n=${p.times_drafted}`)
    );
  }
}

main();
