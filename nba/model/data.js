// Data layer: committed snapshot (data/nba/*.json) → runtime Sleeper refresh
// written to data/nba/cache/ (gitignored, disk fallback across restarts).
//
// Cold start never blocks on the network: the committed snapshot is loaded
// synchronously (~60 ms) and a refresh runs in the background (stale-while-
// revalidate). If Sleeper is down, the last good cache/snapshot keeps serving.
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./sleeper');

const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'nba');
const CACHE_DIR = path.join(SNAP_DIR, 'cache');
const PROJ_SEASON = 2026;
const REFRESH_TTL_MS = 30 * 60 * 1000;

let data = null;
let version = 0;
let lastRefresh = 0;
let refreshing = null;
let lastError = null;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
// Prefer the runtime cache copy when it is newer than the committed snapshot
// and written in the same compact format (an older deploy's cache lacks the
// per-game stat lines that league-profile scoring needs).
// minFormat: ignore any copy written in an older format (game logs need the
// format-3 fga/fta/tpm/ff columns for usage and flagrant fouls).
function readBest(name, minFormat = 0) {
  let snap = readJson(path.join(SNAP_DIR, name));
  let cache = readJson(path.join(CACHE_DIR, name));
  if (cache && (cache.format || 0) < minFormat) cache = null;
  if (snap && (snap.format || 0) < minFormat && cache) snap = null;
  if (cache && snap && snap.format !== cache.format) return snap;
  if (cache && (!snap || (cache.generatedAt || '') > (snap.generatedAt || ''))) return cache;
  return snap;
}
function writeCache(name, obj) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = path.join(CACHE_DIR, name + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, path.join(CACHE_DIR, name));
  } catch (err) { lastError = `cache write ${name}: ${err.message}`; }
}

function load() {
  if (data) return data;
  const players = readBest('players.json');
  const proj = readBest(`proj-${PROJ_SEASON}.json`);
  if (!players || !proj) throw new Error('nba model: snapshot missing (run node scripts/nba-ingest.js)');
  const logs = [];
  for (const season of [PROJ_SEASON - 1, PROJ_SEASON]) {
    const l = readBest(`logs-${season}.json`, S.LOG_FORMAT);
    if (l) logs.push(l);
  }
  data = { players: players.players, state: players.state, logs, proj, asOf: newest([players, proj, ...logs]) };
  version++;
  return data;
}
function newest(files) {
  return files.map(f => f && f.generatedAt).filter(Boolean).sort().pop() || null;
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const cur = load();
    const state = await S.fetchJson(S.URLS.state());
    const playersFile = { state, ...S.compactPlayers(await S.fetchJson(S.URLS.players(), { timeoutMs: 30000 })) };
    writeCache('players.json', playersFile);

    const next = { ...cur, players: playersFile.players, state };
    const inSeason = String(state.season) === String(PROJ_SEASON) && state.season_type !== 'pre';
    if (inSeason) {
      // Current-season game logs (each week ~1-2 MB). With a cached log file only
      // the last two weeks are re-fetched (stat corrections, games in progress);
      // a cold container without one backfills weeks 1..current once.
      const last = state.season_type === 'post' ? 30 : Math.max(1, state.week);
      // An older-format log file is dropped so the whole season backfills in format 3.
      const prevAny = cur.logs.find(l => l.season === String(PROJ_SEASON));
      const prev = prevAny && prevAny.format === S.LOG_FORMAT ? prevAny : null;
      const first = prev ? Math.max(1, last - 1) : 1;
      const byWeek = {};
      const got = await Promise.all(Array.from({ length: last - first + 1 }, (_, i) =>
        S.fetchJson(S.URLS.stats(PROJ_SEASON, first + i), { timeoutMs: 30000 }).catch(() => null)));
      got.forEach((rows, i) => { if (Array.isArray(rows) && rows.length) byWeek[first + i] = rows; });
      if (Object.keys(byWeek).length) {
        const logs = S.mergeLogs(prev, S.compactLogs(PROJ_SEASON, byWeek));
        writeCache(`logs-${PROJ_SEASON}.json`, logs);
        next.logs = [...cur.logs.filter(l => l.season !== String(PROJ_SEASON)), logs];
      }
    }
    // Refresh projections for the current and next week only (injuries, rotations).
    const wk = inSeason ? state.week : 1;
    const fresh = {};
    for (const w of [wk, wk + 1]) {
      const rows = await S.fetchJson(S.URLS.proj(PROJ_SEASON, w), { timeoutMs: 30000 }).catch(() => null);
      if (Array.isArray(rows) && rows.length) fresh[w] = rows;
    }
    if (Object.keys(fresh).length) {
      const part = S.compactProjections(PROJ_SEASON, fresh, []);
      const proj = { ...cur.proj, format: part.format, generatedAt: part.generatedAt, weeks: { ...cur.proj.weeks, ...part.weeks }, weekly: { ...cur.proj.weekly }, teamGames: {}, teamDates: {} };
      // Team game dates: keep known dates outside the refreshed weeks' windows, add the fresh ones.
      const fresh0 = Math.min(...Object.values(part.weeks).map(([lo]) => S.epochDay(lo)));
      const fresh1 = Math.max(...Object.values(part.weeks).map(([, hi]) => S.epochDay(hi)));
      for (const [team, days] of Object.entries(cur.proj.teamDates || {})) proj.teamDates[team] = days.filter(d => d < fresh0 || d > fresh1);
      for (const [team, days] of Object.entries(part.teamDates || {})) proj.teamDates[team] = (proj.teamDates[team] || []).concat(days).sort((a, b) => a - b);
      for (const [team, byW] of Object.entries(cur.proj.teamGames)) proj.teamGames[team] = { ...byW };
      for (const [team, byW] of Object.entries(part.teamGames)) Object.assign(proj.teamGames[team] ||= {}, byW);
      for (const pid of Object.keys(proj.weekly)) {
        proj.weekly[pid] = { ...proj.weekly[pid] };
        for (const w of Object.keys(fresh)) delete proj.weekly[pid][w];
      }
      for (const [pid, byW] of Object.entries(part.weekly)) Object.assign(proj.weekly[pid] ||= {}, byW);
      writeCache(`proj-${PROJ_SEASON}.json`, proj);
      next.proj = proj;
    }
    next.asOf = newest([playersFile, next.proj, ...next.logs]);
    data = next;
    version++;
    lastRefresh = Date.now();
    lastError = null;
  })().catch(err => {
    lastError = err.message;
    lastRefresh = Date.now(); // back off a full TTL before retrying
  }).finally(() => { refreshing = null; });
  return refreshing;
}

function maybeRefresh() {
  if (process.env.NBA_MODEL_OFFLINE === '1') return null;
  if (Date.now() - lastRefresh < REFRESH_TTL_MS) return null;
  return refresh();
}

module.exports = {
  load, refresh, maybeRefresh,
  version: () => version,
  status: () => ({ asOf: data && data.asOf, version, lastRefresh, refreshing: !!refreshing, lastError }),
  _reset: () => { data = null; lastRefresh = 0; },
};
