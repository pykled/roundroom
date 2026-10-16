#!/usr/bin/env node
// Pull Sleeper NBA game logs / projections / players and write the compact
// snapshot the model ships with (data/nba/*.json, committed, ~1 MB total).
// Raw API responses are cached under data/nba/raw/ (gitignored, ~60 MB).
//
//   node scripts/nba-ingest.js            # use raw cache where present
//   node scripts/nba-ingest.js --refresh  # re-download everything
//   node scripts/nba-ingest.js --no-espn  # skip the ESPN cross-check
//   node scripts/nba-ingest.js --logs-only # regenerate data/nba/logs-*.json only (format 3: fga/fta/tpm/ff)
//
// Also writes data/nba/espn-check.json: per-player game counts/dates from ESPN
// gamelogs (All-Star game excluded) and ESPN team schedules for a few teams,
// which scripts/test-nba-model.js asserts against offline.
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../nba/model/sleeper');

const DIR = path.join(__dirname, '..', 'data', 'nba');
const RAW = path.join(DIR, 'raw');
const REFRESH = process.argv.includes('--refresh');
const NO_ESPN = process.argv.includes('--no-espn');
const LOGS_ONLY = process.argv.includes('--logs-only');

const LOG_SEASONS = [2025, 2026];
const PROJ_SEASON = 2026;
const BACKTEST_PROJ_SEASON = 2025; // weekly projections, possibly revised post-game (see docs)
const MAX_WEEK = 30;

fs.mkdirSync(RAW, { recursive: true });

async function rawGet(name, url) {
  const file = path.join(RAW, name + '.json');
  if (!REFRESH && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = await S.fetchJson(url, { timeoutMs: 30000 });
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

// Weeks 1..MAX_WEEK in parallel; stop at the first empty week after data started.
async function pullWeeks(kind, season) {
  const urlFn = kind === 'stats' ? S.URLS.stats : S.URLS.proj;
  const all = await Promise.all(
    Array.from({ length: MAX_WEEK }, (_, i) => i + 1).map(w =>
      rawGet(`${kind}-${season}-${w}`, urlFn(season, w)).catch(err => { console.warn(`  ! ${kind} ${season} wk${w}: ${err.message}`); return []; })
    )
  );
  const byWeek = {};
  all.forEach((rows, i) => { if (Array.isArray(rows) && rows.length) byWeek[i + 1] = rows; });
  return byWeek;
}

function writeOut(name, obj) {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  console.log(`  wrote data/nba/${name} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}

const ESPN_SAMPLES = [
  { espnId: 3112335, sleeperId: '1658', name: 'Nikola Jokic' },
  { espnId: 3945274, sleeperId: '1970', name: 'Luka Doncic' },
  { espnId: 4278073, sleeperId: '1957', name: 'Shai Gilgeous-Alexander' },
  { espnId: 3202, sleeperId: '1433', name: 'Kevin Durant' }, // has a leaked All-Star row in Sleeper
];
const ESPN_TEAMS = [['den', 'DEN'], ['lal', 'LAL'], ['bos', 'BOS'], ['gs', 'GSW'], ['sa', 'SAS']];
// ESPN gameDate is UTC; US tip-offs are 12:00–22:30 local, so shifting −8h lands on the local date.
const espnLocalDate = iso => new Date(new Date(iso).getTime() - 8 * 3600e3).toISOString().slice(0, 10);

async function espnCheck(projByWeek) {
  const players = [];
  for (const s of ESPN_SAMPLES) {
    const base = `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${s.espnId}`;
    const [info, log] = await Promise.all([S.fetchJson(base), S.fetchJson(`${base}/gamelog?season=2026`)]);
    const reg = (log.seasonTypes || []).find(t => /Regular/.test(t.displayName));
    const dates = [];
    const excluded = [];
    for (const c of (reg && reg.categories) || []) {
      for (const ev of c.events || []) {
        const meta = log.events[ev.eventId] || {};
        const opp = meta.opponent && meta.opponent.abbreviation;
        const d = espnLocalDate(meta.gameDate);
        // All-Star game is listed under ESPN's regular season (opponent "STARS"/"STRIPES"/"WORLD"...)
        if (meta.eventNote && /all-star/i.test(meta.eventNote) || /^(STARS|STRIPES|WORLD|USA|TEAM)/i.test(opp || '')) excluded.push(`${d} vs ${opp}`);
        else dates.push(d);
      }
    }
    dates.sort();
    players.push({ ...s, espnName: info.athlete && info.athlete.displayName, regularGames: dates.length, dates, excluded });
    console.log(`  ESPN ${s.name}: ${dates.length} regular-season games (excluded ${excluded.join(', ') || 'none'})`);
  }
  // 2026-27 team schedule cross-check (ESPN season = ending year).
  const teamDates = {};
  for (const rows of Object.values(projByWeek)) {
    for (const r of rows) if (r.team && r.date) (teamDates[r.team] ||= new Set()).add(r.date);
  }
  const schedule = [];
  for (const [slug, team] of ESPN_TEAMS) {
    const sch = await S.fetchJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${slug}/schedule?season=2027&seasontype=2`);
    const espnDates = (sch.events || []).map(e => espnLocalDate(e.date)).sort();
    const sleeper = [...(teamDates[team] || [])].sort();
    const es = new Set(espnDates), ss = new Set(sleeper);
    const row = { team, espn: espnDates.length, sleeper: sleeper.length, onlyEspn: espnDates.filter(d => !ss.has(d)), onlySleeper: sleeper.filter(d => !es.has(d)) };
    schedule.push(row);
    console.log(`  schedule ${team}: ESPN ${row.espn} / Sleeper-proj ${row.sleeper}; only ESPN ${row.onlyEspn.length}, only Sleeper ${row.onlySleeper.length}`);
  }
  return { generatedAt: new Date().toISOString(), players, schedule };
}

(async () => {
  const t0 = Date.now();
  if (LOGS_ONLY) {
    for (const season of LOG_SEASONS) {
      console.log(`Stats ${season}…`);
      const byWeek = await pullWeeks('stats', season);
      if (!Object.keys(byWeek).length) continue;
      const logs = S.compactLogs(season, byWeek);
      console.log(`  ${Object.keys(byWeek).length} weeks, dedupe ${JSON.stringify(logs.dedupe)}`);
      writeOut(`logs-${season}.json`, logs);
    }
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }
  console.log('Sleeper state…');
  const state = await S.fetchJson(S.URLS.state());

  console.log('Players…');
  writeOut('players.json', { state, ...S.compactPlayers(await rawGet('players', S.URLS.players())) });

  for (const season of LOG_SEASONS) {
    console.log(`Stats ${season}…`);
    const byWeek = await pullWeeks('stats', season);
    const logs = S.compactLogs(season, byWeek);
    console.log(`  ${Object.keys(byWeek).length} weeks, dedupe ${JSON.stringify(logs.dedupe)}`);
    if (Object.keys(byWeek).length) writeOut(`logs-${season}.json`, logs);
  }

  console.log(`Projections ${PROJ_SEASON}…`);
  const projByWeek = await pullWeeks('proj', PROJ_SEASON);
  const seasonRows = await rawGet(`proj-${PROJ_SEASON}-season`, S.URLS.seasonProj(PROJ_SEASON));
  const proj = S.compactProjections(PROJ_SEASON, projByWeek, seasonRows);
  console.log(`  ${Object.keys(projByWeek).length} weeks, ${Object.keys(proj.weekly).length} players with weekly rows`);
  writeOut(`proj-${PROJ_SEASON}.json`, proj);

  console.log(`Backtest projections ${BACKTEST_PROJ_SEASON}…`);
  const btByWeek = await pullWeeks('proj', BACKTEST_PROJ_SEASON);
  const bt = S.compactProjections(BACKTEST_PROJ_SEASON, btByWeek, []);
  writeOut(`proj-${BACKTEST_PROJ_SEASON}.json`, { season: bt.season, generatedAt: bt.generatedAt, weekly: bt.weekly });

  if (!NO_ESPN) {
    console.log('ESPN cross-check…');
    try { writeOut('espn-check.json', await espnCheck(projByWeek)); }
    catch (err) { console.warn(`  ! ESPN check failed: ${err.message}`); process.exitCode = 1; }
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(err => { console.error(err); process.exit(1); });
