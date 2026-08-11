#!/usr/bin/env node
/**
 * vorp.js — projection-based VORP (Value Over Replacement Player).
 *
 * Strategy:
 *   1. Fetch Sleeper season projections (week 1 used as a proxy, scaled x17).
 *   2. Join projection player_ids to names/positions using raw_picks.json.
 *   3. If projections are unavailable/insufficient, fall back to estimating
 *      points from ADP rank order using simple per-position decay curves.
 *   4. VORP = player_proj_pts - replacement_proj_pts, where the replacement is
 *      the Nth-ranked player at that position.
 *
 * Baselines:
 *   Standard : QB14, RB36, WR48, TE12
 *   SuperFlex: QB24, RB36, WR48, TE12
 *
 * Output: data/vorp.json
 *   { generated_at, players: [ { name, position, vorp_std, vorp_sf } ] }
 *   sorted by vorp_std descending.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SEASON = '2026';
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

const BASELINES_STD = { QB: 14, RB: 36, WR: 48, TE: 12 };
const BASELINES_SF = { QB: 24, RB: 36, WR: 48, TE: 12 };

// Per-position curves for the ADP fallback: approximate season points for the
// #1 player and a decay per rank. Rough but monotonic, good enough for VORP
// ordering when real projections are missing.
const CURVES = {
  QB: { top: 380, decay: 6.5 },
  RB: { top: 320, decay: 6.0 },
  WR: { top: 300, decay: 4.5 },
  TE: { top: 240, decay: 7.5 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchProjections() {
  // Week-1 projections as a season proxy; scaled to a full season below.
  const qs =
    'season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE';
  const url = `https://api.sleeper.app/v1/projections/nfl/${SEASON}/1?${qs}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'RoundRoom/1.0' } });
    if (!res.ok) {
      console.warn(`Projections HTTP ${res.status}; will fall back to ADP.`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`Projections fetch failed (${err.message}); fall back to ADP.`);
    return null;
  }
}

// Build player_id -> { name, position, team } from raw picks (free, local).
function buildIdIndex() {
  const idx = new Map();
  const rawPath = path.join(DATA_DIR, 'raw_picks.json');
  if (!fs.existsSync(rawPath)) return idx;
  const picks = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  for (const p of picks) {
    if (!p.player_id || idx.has(p.player_id)) continue;
    const name = (p.player_name || '').trim();
    const pos = (p.position || '').trim().toUpperCase();
    if (!name || !pos) continue;
    idx.set(String(p.player_id), { name, position: pos, team: p.team || null });
  }
  return idx;
}

function pickPoints(stats) {
  if (!stats) return null;
  // Prefer half-PPR, then PPR, then standard.
  for (const k of ['pts_half_ppr', 'pts_ppr', 'pts_std']) {
    if (typeof stats[k] === 'number') return stats[k];
  }
  return null;
}

function computeVorp(playerPts) {
  // playerPts: [ { name, position, team, pts } ]
  const byPos = {};
  for (const pos of POSITIONS) byPos[pos] = [];
  for (const p of playerPts) {
    if (byPos[p.position]) byPos[p.position].push(p);
  }

  const result = [];
  for (const pos of POSITIONS) {
    const list = byPos[pos].sort((a, b) => b.pts - a.pts);
    const baseStd = BASELINES_STD[pos];
    const baseSf = BASELINES_SF[pos];
    const replStd = list[baseStd - 1] ? list[baseStd - 1].pts : (list.length ? list[list.length - 1].pts : 0);
    const replSf = list[baseSf - 1] ? list[baseSf - 1].pts : (list.length ? list[list.length - 1].pts : 0);
    for (const p of list) {
      result.push({
        name: p.name,
        position: pos,
        team: p.team || null,
        vorp_std: Math.round((p.pts - replStd) * 100) / 100,
        vorp_sf: Math.round((p.pts - replSf) * 100) / 100,
      });
    }
  }
  result.sort((a, b) => b.vorp_std - a.vorp_std);
  return result;
}

// Normalize Sleeper projections into a list of { pid, stats, player } entries.
// Sleeper returns EITHER an array of entries OR an object keyed by player_id
// whose values are the stats blob directly.
function normalizeProjections(projections) {
  if (Array.isArray(projections)) {
    return projections.map((e) => ({
      pid: String(e.player_id ?? (e.player && e.player.player_id) ?? ''),
      stats: e.stats || e,
      player: e.player || null,
    }));
  }
  if (projections && typeof projections === 'object') {
    return Object.entries(projections).map(([pid, stats]) => ({
      pid: String(pid),
      stats: stats && stats.stats ? stats.stats : stats,
      player: stats && stats.player ? stats.player : null,
    }));
  }
  return [];
}

function fromProjections(projections, idIndex) {
  const entries = normalizeProjections(projections);
  if (entries.length === 0) return null;
  const playerPts = [];
  for (const entry of entries) {
    const pid = entry.pid;
    const stats = entry.stats;
    let pts = pickPoints(stats);
    if (pts == null) continue;
    // Week-1 proxy -> full season (17 games).
    pts = pts * 17;

    // Resolve name/position: prefer embedded player info, else id index.
    let name = null;
    let position = null;
    let team = null;
    if (entry.player && (entry.player.first_name || entry.player.last_name)) {
      name = `${entry.player.first_name || ''} ${entry.player.last_name || ''}`.trim();
      position = (entry.player.position || '').toUpperCase();
      team = entry.player.team || null;
    }
    if ((!name || !position) && idIndex.has(pid)) {
      const info = idIndex.get(pid);
      name = name || info.name;
      position = position || info.position;
      team = team || info.team;
    }
    if (!name || !POSITIONS.includes(position)) continue;
    playerPts.push({ name, position, team, pts: Math.round(pts * 100) / 100 });
  }
  return playerPts;
}

function fromAdpFallback() {
  const adpPath = path.join(DATA_DIR, 'adp.json');
  if (!fs.existsSync(adpPath)) {
    console.error('No projections and no adp.json for fallback. Run aggregate.js first.');
    return [];
  }
  const adp = JSON.parse(fs.readFileSync(adpPath, 'utf8'));
  const byPos = {};
  for (const pos of POSITIONS) byPos[pos] = [];
  for (const p of adp.players || []) {
    if (byPos[p.position]) byPos[p.position].push(p);
  }
  const playerPts = [];
  for (const pos of POSITIONS) {
    // Rank within position by ADP ascending (best first).
    const list = byPos[pos].sort((a, b) => a.adp - b.adp);
    const { top, decay } = CURVES[pos];
    list.forEach((p, i) => {
      const pts = Math.max(0, top - i * decay);
      playerPts.push({ name: p.name, position: pos, team: p.team || null, pts });
    });
  }
  return playerPts;
}

async function main() {
  const idIndex = buildIdIndex();
  console.log(`ID index: ${idIndex.size} players from raw picks.`);

  let source = 'projections';
  let playerPts = null;

  const projections = await fetchProjections();
  if (projections) {
    playerPts = fromProjections(projections, idIndex);
    const matched = playerPts ? playerPts.length : 0;
    console.log(`Projections matched ${matched} players.`);
    if (!playerPts || matched < 50) {
      console.log('Insufficient projection coverage; using ADP fallback.');
      source = 'adp_fallback';
      playerPts = fromAdpFallback();
    }
  } else {
    source = 'adp_fallback';
    playerPts = fromAdpFallback();
  }

  const players = computeVorp(playerPts);

  const out = {
    generated_at: new Date().toISOString(),
    source,
    players,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'vorp.json'), JSON.stringify(out, null, 2));
  console.log(`Wrote vorp.json: ${players.length} players (source=${source}).`);
  if (players.length) {
    console.log('Top 5 by VORP (std):');
    players.slice(0, 5).forEach((p, i) =>
      console.log(`  ${i + 1}. ${p.name} (${p.position}) vorp_std=${p.vorp_std}`)
    );
  }
}

main().catch((err) => {
  console.error('Fatal vorp error:', err);
  process.exit(1);
});
