#!/usr/bin/env node
// Pocket NBA — market ADP fetcher (research prototype, docs/nba-adp-spike.md).
// Writes data/nba/adp.json: [{ name, team, pos:[..], adp, source, asOf }] (flat, one row per source per player).
//   node scripts/nba-adp-fetch.js [--fantasypros] [--no-cache] [--out path]
// Sources: espn (default), sleeper (default), fantasypros (opt-in: its Yahoo/ESPN ADP columns; ToS unverified).
// Never throws: any failure yields whatever other sources produced, or an empty array, and exit 0.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'nba', 'adp.json');
const CACHE_DIR = path.join(ROOT, 'data', 'nba', 'adp-cache');
const TTL_MS = 3 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; PocketNBA-adp/0.1; personal fantasy tool)';
const MIN_GAP_MS = 1100; // politeness: ~1 request/sec across all hosts

// ESPN proTeamId → abbr (verified against Jokic=7 DEN, SGA=25 OKC, Wemby=24 SAS, Giannis=14 MIA, Flagg=6 DAL).
const ESPN_TEAMS = { 1: 'ATL', 2: 'BOS', 3: 'NOP', 4: 'CHI', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GSW', 10: 'HOU',
  11: 'IND', 12: 'LAC', 13: 'LAL', 14: 'MIA', 15: 'MIL', 16: 'MIN', 17: 'BKN', 18: 'NYK', 19: 'ORL', 20: 'PHI',
  21: 'PHX', 22: 'POR', 23: 'SAC', 24: 'SAS', 25: 'OKC', 26: 'UTA', 27: 'WAS', 28: 'TOR', 29: 'MEM', 30: 'CHA' };
const ESPN_SLOT_POS = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C' };
// ESPN reports ~140 for players nobody drafts (a floor, not a real ADP); Sleeper uses 999.
const ESPN_FLOOR = 135;
const SLEEPER_FLOOR = 300;

const ESPN_URL = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/segments/0/leaguedefaults/3?view=kona_player_info';
const ESPN_FILTER = JSON.stringify({ players: { limit: 300, sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'STANDARD' },
  filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] } } });
const SLEEPER_URL = 'https://api.sleeper.com/projections/nba/2026?season_type=regular';
const FP_URL = 'https://www.fantasypros.com/nba/adp/overall.php';

// ---- parsers (pure; unit-tested offline against data/nba/adp-sample.json) ----
function round2(n) { return Math.round(n * 100) / 100; }

function parseEspn(json, asOf) {
  const out = [];
  for (const e of (json && json.players) || []) {
    const p = e.player || {};
    const adp = p.ownership && p.ownership.averageDraftPosition;
    if (!p.fullName || typeof adp !== 'number' || !(adp > 0) || adp >= ESPN_FLOOR) continue;
    const pos = (p.eligibleSlots || []).filter(s => ESPN_SLOT_POS[s]).map(s => ESPN_SLOT_POS[s]);
    out.push({ name: p.fullName, team: ESPN_TEAMS[p.proTeamId] || null, pos, adp: round2(adp), source: 'espn', asOf });
  }
  return out;
}

function parseSleeper(json, asOf) {
  const out = [];
  for (const r of Array.isArray(json) ? json : []) {
    const p = r.player || {};
    const adp = r.stats && r.stats.adp_std;
    const name = p.first_name ? `${p.first_name} ${p.last_name}` : null;
    if (!name || typeof adp !== 'number' || !(adp > 0) || adp >= SLEEPER_FLOOR) continue;
    const team = p.team_abbr || p.team || null;
    if (!team) continue; // Sleeper keeps stale ADP on retired/unsigned players; no team = not draftable
    out.push({ name, team, pos: p.fantasy_positions || (p.position ? [p.position] : []),
      adp: round2(adp), source: 'sleeper', asOf });
  }
  return out;
}

// FantasyPros table: Rank | Player (TEAM - POS,POS) | Yahoo | ESPN | AVG. `yahoo` column is the one that matters for Yahoo drafts.
function parseFantasyPros(html, asOf, column = 'yahoo') {
  const out = [];
  const re = /<tr><td>\d+<\/td>\s*<td class="player-label"><a [^>]*fp-player-name="([^"]+)"[^>]*>[^<]*<\/a>\s*<small>\(([^)]*)\)<\/small><\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const [, name, tp, y, e, avg] = m;
    const v = parseFloat({ yahoo: y, espn: e, avg }[column]);
    if (!(v > 0)) continue;
    const [team, pos] = tp.split(' - ');
    out.push({ name: name.replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&'), team: team || null, pos: pos ? pos.split(',') : [],
      adp: v, source: `fantasypros-${column}`, asOf });
  }
  return out;
}

// ---- IO ----
let lastReq = 0;
async function politeFetch(url, headers = {}) {
  const wait = lastReq + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastReq = Date.now();
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*', ...headers }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

function readCache(key, useCache) {
  if (!useCache) return null;
  try {
    const f = path.join(CACHE_DIR, key);
    if (Date.now() - fs.statSync(f).mtimeMs < TTL_MS) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) { /* miss */ }
  return null;
}
function writeCache(key, rows) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, key), JSON.stringify(rows)); } catch (_) { /* best effort */ }
}
function staleCache(key) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, key), 'utf8')); } catch (_) { return null; }
}

const SOURCES = {
  espn: async asOf => parseEspn(await (await politeFetch(ESPN_URL, { 'x-fantasy-filter': ESPN_FILTER })).json(), asOf),
  sleeper: async asOf => parseSleeper(await (await politeFetch(SLEEPER_URL)).json(), asOf),
  fantasypros: async asOf => parseFantasyPros(await (await politeFetch(FP_URL)).text(), asOf, 'yahoo'),
};

async function fetchAll({ sources = ['espn', 'sleeper'], useCache = true, log = () => {} } = {}) {
  const asOf = new Date().toISOString();
  const rows = [];
  const status = {};
  for (const s of sources) {
    const cached = readCache(`${s}.json`, useCache);
    if (cached) { rows.push(...cached); status[s] = { ok: true, rows: cached.length, cached: true }; continue; }
    try {
      const got = await SOURCES[s](asOf);
      if (!got.length) throw new Error('0 rows parsed (format change?)');
      writeCache(`${s}.json`, got);
      rows.push(...got);
      status[s] = { ok: true, rows: got.length };
    } catch (e) {
      const stale = staleCache(`${s}.json`);
      if (stale) rows.push(...stale);
      status[s] = { ok: false, error: String(e.message || e), rows: stale ? stale.length : 0, stale: !!stale };
    }
    log(`${s}: ${JSON.stringify(status[s])}`);
  }
  return { rows, status };
}

async function main(argv) {
  const useCache = !argv.includes('--no-cache');
  const oi = argv.indexOf('--out');
  const out = oi >= 0 && argv[oi + 1] ? path.resolve(argv[oi + 1]) : OUT;
  const sources = ['espn', 'sleeper'];
  if (argv.includes('--fantasypros') || process.env.ADP_FANTASYPROS === '1') sources.push('fantasypros');
  let rows = [];
  try { ({ rows } = await fetchAll({ sources, useCache, log: m => console.error(m) })); } catch (e) { console.error('adp fetch failed:', e.message); }
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rows)); } catch (e) { console.error('write failed:', e.message); }
  console.error(`wrote ${rows.length} rows -> ${out}`);
}

// Dry-run name matching against model players ({name,team,rank}); one-to-one on normalized name, team as tiebreak.
function matchReport(rows, players) {
  const { normalizeName, normalizeTeam } = require('../nba/model/names');
  const byName = new Map();
  for (const p of players) { const k = normalizeName(p.name); (byName.get(k) || byName.set(k, []).get(k)).push(p); }
  const res = {};
  for (const r of rows) {
    const s = (res[r.source] = res[r.source] || { total: 0, matched: 0, unmatched: [], ambiguous: 0 });
    s.total++;
    const c = byName.get(normalizeName(r.name));
    if (!c) { s.unmatched.push(`${r.name} (${r.team || '?'}) #${r.adp}`); continue; }
    if (c.length > 1) { s.ambiguous++; if (!c.some(p => p.team === normalizeTeam(r.team))) { s.unmatched.push(`${r.name} (ambiguous)`); continue; } }
    s.matched++;
  }
  for (const s of Object.values(res)) s.rate = s.total ? Math.round((1000 * s.matched) / s.total) / 10 : 0;
  return res;
}

module.exports = { matchReport, parseEspn, parseSleeper, parseFantasyPros, fetchAll, ESPN_TEAMS };

if (require.main === module) main(process.argv.slice(2)).then(() => process.exit(0), () => process.exit(0));
