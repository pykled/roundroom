#!/usr/bin/env node
/**
 * fetch-fantasypros.js — pull FantasyPros free consensus ADP/ECR.
 *
 * FantasyPros embeds its consensus draft rankings as a JS variable (`ecrData`)
 * in the cheatsheets page HTML. ecrData is the Expert Consensus Ranking across
 * many sources (Yahoo, ESPN, CBS, NFL.com, etc.) — `rank_ave` is the average
 * expert draft position, which is our cross-platform ADP signal. `rank_ecr` is
 * the consensus rank.
 *
 * Strategy (try in order, first success wins):
 *   1. Scrape ecrData from the cheatsheets HTML page (realistic User-Agent).
 *   2. Fall back to the ppr-cheatsheets.aspx page (task-specified URL).
 *   3. Fall back to the public consensus-rankings JSON API (often 403 without
 *      a key, but harmless to try).
 *
 * If every approach fails we log clearly and exit 0 so the pipeline continues.
 *
 * Output:
 *   data/fantasypros_adp.json
 *     { source, fetched_at, players: [{name, position, team, adp, rank}] }
 *
 * Node built-ins + native fetch only.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA_DIR, 'fantasypros_adp.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Pages that embed ecrData for the full-position PPR draft board.
const HTML_URLS = [
  'https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php',
  'https://www.fantasypros.com/nfl/adp/ppr-cheatsheets.aspx',
];
const API_URL =
  'https://api.fantasypros.com/v2/json/nfl/2026/consensus-rankings' +
  '?type=ppr&scoring=PPR&position=ALL&week=0&experts=available';

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Extract `var ecrData = {...};` from page HTML and return its player array.
function parseEcrData(html) {
  const m = html.match(/var\s+ecrData\s*=\s*(\{[\s\S]*?\});/);
  if (!m) throw new Error('ecrData variable not found in HTML');
  const obj = JSON.parse(m[1]);
  const players = obj.players || obj.data || [];
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error('ecrData had no players');
  }
  return players.map((p) => ({
    name: (p.player_name || '').trim(),
    position: (p.player_position_id || p.player_positions || '')
      .toString()
      .trim()
      .toUpperCase(),
    team: (p.player_team_id || '').toString().trim().toUpperCase() || null,
    // rank_ave is the average expert draft slot (our ADP); fall back to rank_ecr.
    adp: Number(p.rank_ave || p.rank_ecr) || null,
    rank: Number(p.rank_ecr) || null,
  }));
}

// Parse the JSON API shape (players[] with rank_ave/rank_ecr, same fields).
function parseApiJson(text) {
  const obj = JSON.parse(text);
  const players = obj.players || [];
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error('API returned no players');
  }
  return players.map((p) => ({
    name: (p.player_name || '').trim(),
    position: (p.player_position_id || '').toString().trim().toUpperCase(),
    team: (p.player_team_id || '').toString().trim().toUpperCase() || null,
    adp: Number(p.rank_ave || p.rank_ecr) || null,
    rank: Number(p.rank_ecr) || null,
  }));
}

async function main() {
  let players = null;
  let via = null;

  for (const url of HTML_URLS) {
    try {
      console.log(`Fetching FantasyPros HTML: ${url}`);
      const html = await fetchText(url);
      players = parseEcrData(html);
      via = url;
      break;
    } catch (err) {
      console.warn(`  ! ${err.message}`);
    }
  }

  if (!players) {
    try {
      console.log(`Fetching FantasyPros API: ${API_URL}`);
      const text = await fetchText(API_URL);
      players = parseApiJson(text);
      via = API_URL;
    } catch (err) {
      console.warn(`  ! ${err.message}`);
    }
  }

  if (!players || players.length === 0) {
    console.error(
      'FantasyPros fetch failed on all approaches (HTML scrape + API). ' +
      'Leaving any existing fantasypros_adp.json in place. Exiting 0 so the ' +
      'pipeline continues.'
    );
    // Write an empty-but-valid file only if none exists, so merge-sources can
    // still read a well-formed shape.
    if (!fs.existsSync(OUT)) {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        OUT,
        JSON.stringify(
          { source: 'fantasypros', fetched_at: new Date().toISOString(), players: [], error: 'all_fetch_approaches_failed' },
          null,
          2
        )
      );
    }
    process.exit(0);
  }

  // Keep only rows with a name + usable adp.
  players = players.filter((p) => p.name && p.adp != null);
  // Sort by adp ascending so the file is human-readable.
  players.sort((a, b) => a.adp - b.adp);

  const out = {
    source: 'fantasypros',
    fetched_at: new Date().toISOString(),
    via,
    players,
  };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${players.length} FantasyPros players -> ${OUT} (via ${via})`);
  players.slice(0, 5).forEach((p, i) =>
    console.log(`  ${i + 1}. ${p.name} (${p.position}, ${p.team}) adp=${p.adp} rank=${p.rank}`)
  );
}

main().catch((err) => {
  console.error('FantasyPros fetch fatal (non-blocking):', err.message);
  process.exit(0);
});
