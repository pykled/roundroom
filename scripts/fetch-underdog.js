#!/usr/bin/env node
/**
 * fetch-underdog.js — pull Underdog Fantasy public best-ball ADP.
 *
 * Underdog publishes best-ball draft ADP at a public endpoint. Best-ball is
 * full-PPR with no K/DST, so it's a useful cross-platform signal for the top of
 * the board but differs from redraft — we skip K and DST here and let
 * merge-sources.js weight it lightly (0.10).
 *
 * The public JSON shape has varied over time, so we parse defensively: accept a
 * top-level array or an object exposing players / data / adp / adp_rankings, and
 * pull name/position/team/adp from whatever field names are present.
 *
 * If the endpoint is unreachable (Underdog fronts with bot protection that can
 * block datacenter/CI IPs), we log clearly and exit 0 so the pipeline continues.
 *
 * Output:
 *   data/underdog_adp.json
 *     { source, fetched_at, players: [{name, position, team, adp, rank}] }
 *
 * Node built-ins + native fetch only.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA_DIR, 'underdog_adp.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Try the documented public endpoint first, then a couple of known variants.
const URLS = [
  'https://drafts.underdogfantasy.com/public/adp',
  'https://api.underdogfantasy.com/v1/adp',
];

const SKIP_POSITIONS = new Set(['K', 'DST', 'DEF', 'D/ST']);

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Pull the player array out of whatever wrapper Underdog uses.
function extractPlayerArray(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['players', 'data', 'adp', 'adp_rankings', 'rankings']) {
    if (Array.isArray(json[key])) return json[key];
  }
  // Some responses nest under { adp: { players: [] } }
  if (json.adp && Array.isArray(json.adp.players)) return json.adp.players;
  throw new Error('no player array in Underdog response');
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

function normalize(raw) {
  return raw
    .map((p) => {
      // Name may be a single field or first/last split.
      let name = pick(p, ['name', 'full_name', 'player_name', 'displayName']);
      if (!name) {
        const first = pick(p, ['first_name', 'firstName']);
        const last = pick(p, ['last_name', 'lastName']);
        if (first || last) name = `${first || ''} ${last || ''}`.trim();
      }
      // Position / team can live under a few names or a nested slot object.
      let position = pick(p, ['position', 'slotName', 'positionName', 'pos']);
      if (!position && p.slot && p.slot.name) position = p.slot.name;
      let team = pick(p, ['team', 'teamName', 'team_abbr', 'teamAbbreviation']);

      const adp = Number(pick(p, ['adp', 'averageDraftPosition', 'average_pick', 'projectedAdp']));
      const rank = Number(pick(p, ['rank', 'adpRank', 'overallRank']));

      return {
        name: name ? String(name).trim() : null,
        position: position ? String(position).trim().toUpperCase() : null,
        team: team ? String(team).trim().toUpperCase() : null,
        adp: Number.isFinite(adp) ? adp : null,
        rank: Number.isFinite(rank) ? rank : null,
      };
    })
    .filter((p) => p.name && p.adp != null)
    .filter((p) => !p.position || !SKIP_POSITIONS.has(p.position)); // best-ball: no K/DST
}

function writeEmpty(errMsg) {
  if (fs.existsSync(OUT)) return; // don't clobber a prior good file
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      { source: 'underdog', fetched_at: new Date().toISOString(), players: [], error: errMsg },
      null,
      2
    )
  );
}

async function main() {
  let players = null;
  let via = null;

  for (const url of URLS) {
    try {
      console.log(`Fetching Underdog ADP: ${url}`);
      const json = await fetchJson(url);
      players = normalize(extractPlayerArray(json));
      if (players.length) {
        via = url;
        break;
      }
      console.warn('  ! response parsed but yielded 0 players');
    } catch (err) {
      console.warn(`  ! ${err.message}`);
    }
  }

  if (!players || players.length === 0) {
    console.error(
      'Underdog fetch failed / empty on all endpoints (endpoint may block CI ' +
      'IPs). Exiting 0 so the pipeline continues.'
    );
    writeEmpty('all_fetch_approaches_failed_or_empty');
    process.exit(0);
  }

  // Rank by adp; (re)assign a dense rank so downstream has a clean ordering.
  players.sort((a, b) => a.adp - b.adp);
  players.forEach((p, i) => { if (p.rank == null) p.rank = i + 1; });

  const out = {
    source: 'underdog',
    format: 'best_ball_ppr',
    fetched_at: new Date().toISOString(),
    via,
    players,
  };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${players.length} Underdog players (K/DST skipped) -> ${OUT} (via ${via})`);
  players.slice(0, 5).forEach((p, i) =>
    console.log(`  ${i + 1}. ${p.name} (${p.position}, ${p.team}) adp=${p.adp}`)
  );
}

main().catch((err) => {
  console.error('Underdog fetch fatal (non-blocking):', err.message);
  writeEmpty(err.message);
  process.exit(0);
});
