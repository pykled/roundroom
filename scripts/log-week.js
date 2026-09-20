#!/usr/bin/env node
// log-week.js — persist one completed NFL week to data/history/<season>-week-<N>.json
// so the lineup engine can learn from the season instead of restarting every
// Railway redeploy.
//
//   node scripts/log-week.js [--week=N] [--backtest=user1,user2] [--force] [--dry-run]
//
// Run every Tuesday by .github/workflows/log-week.yml (which commits the file —
// the durable path, since Railway's disk is wiped on deploy), and on demand via
// POST /api/log-week (which also upserts the record into Postgres).
//
// WHAT IS LOGGED (and why) — nothing Sleeper already keeps forever (raw stat
// lines, projections, rosters) is copied. Each file holds only what has to be
// captured *as it was known before the week* or is expensive to rebuild:
//
//   fpa       per player who played: the matchup rank / FPA the engine saw
//             BEFORE the week (built from weeks 1..N−1 only — no hindsight),
//             his half-PPR projection and his actual half-PPR points.
//             → shared/fpa-calibration.js regresses actual÷proj on rank to
//               learn how much high-FPA matchups really pay off, and rescales
//               the ±20% matchup swing once 3+ weeks are logged.
//   usage     per RB/WR/TE: running season averages of target share, carry
//             share and snap share through this week (+ this week's shares),
//             so week-over-week role trends survive without refetching 18
//             weeks of stat feeds.
//   backtest  per league: algo lineup pts vs perfect-hindsight optimal vs
//             what the user actually started, from scripts/backtest-lineup.js.
//             → the season-long accuracy trend of the optimizer.
//
// Schema:
//   { season, week, generatedAt, scoring: 'half_ppr', weeksPlayed,
//     fpa:      { "Player Name": { id, pos, team, opp, fpaRating, fpaRank, fpaTeams, proj, actualPoints } },
//     usage:    { playerId: { name, pos, team, targetShareAvg, carryShareAvg, snapPctAvg, weeks,
//                             last: { targetShare, carryShare, snapPct } | null } },
//     backtest: { leagueId: { username, league, algoScore, optimalScore, yourScore, accuracy, yourAccuracy } },
//     meta:     { statRows, fpaSamples, fpaRanked, usagePlayers, completeWeeks, notes } }
//
// Node 18+ built-ins only (native fetch) plus the shared engine modules.
'use strict';

const fs = require('fs');
const path = require('path');
const WeeklyScore = require('../shared/weekly-score.js');

const SEASON = '2026';
const HISTORY_DIR = path.join(__dirname, '..', 'data', 'history');
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K'];
const USAGE_POS = { RB: 1, WR: 1, TE: 1 };
const SCORING_KEY = 'pts_half_ppr';           // same scale as data/fpa-current.json
const MIN_TEAMS_FOR_COMPLETE_WEEK = 24;       // mirrors scripts/scrape-fpa.js
const MIN_POINTS = 1;                         // skip players with <1 projected AND <1 actual
const UA = 'Pocket/1.0 (week logger)';

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
function historyPath(week, season, dir) {
  return path.join(dir || HISTORY_DIR, `${season || SEASON}-week-${week}.json`);
}

function readWeekRecord(week, opts) {
  opts = opts || {};
  try { return JSON.parse(fs.readFileSync(historyPath(week, opts.season, opts.dir), 'utf8')); } catch (_) { return null; }
}

// Every logged week for the season, sorted ascending. Missing dir → [].
function loadHistory(opts) {
  opts = opts || {};
  const season = opts.season || SEASON;
  const dir = opts.dir || HISTORY_DIR;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const re = new RegExp(`^${season}-week-(\\d{1,2})\\.json$`);
  const out = [];
  for (const n of names) {
    const m = re.exec(n);
    if (!m) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (rec && Number(rec.week) === Number(m[1])) out.push(rec);
    } catch (_) { /* skip corrupt file */ }
  }
  return out.sort((a, b) => a.week - b.week);
}

// Write the record; backtest entries already on disk for leagues this run
// didn't cover are kept (the backtest cron and the Tuesday cron can each add
// their own). Returns the path.
function writeWeekRecord(record, opts) {
  opts = opts || {};
  const file = historyPath(record.week, record.season, opts.dir);
  const existing = readWeekRecord(record.week, { season: record.season, dir: opts.dir });
  if (existing && existing.backtest) {
    record.backtest = Object.assign({}, existing.backtest, record.backtest || {});
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  return file;
}

// ---------------------------------------------------------------------------
// Sleeper
// ---------------------------------------------------------------------------
async function getJson(url, timeoutMs) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs || 20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// Full stat feed for one week (every position — team totals for usage need
// QB carries too). Cached per process so a cron run fetches each week once.
const statsCache = new Map();
function fetchStatsWeek(week, season) {
  const key = `${season}-${week}`;
  if (!statsCache.has(key)) {
    statsCache.set(key, getJson(`https://api.sleeper.com/stats/nfl/${season}/${week}?season_type=regular`, 30000)
      .then(rows => Array.isArray(rows) ? rows : [])
      .catch(err => { statsCache.delete(key); throw err; }));
  }
  return statsCache.get(key);
}

async function fetchProjectionsWeek(week, season) {
  const q = POSITIONS.map(p => `position[]=${p}`).join('&');
  const rows = await getJson(`https://api.sleeper.com/projections/nfl/${season}/${week}?season_type=regular&${q}`, 30000);
  const out = {};
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r && r.player_id && r.stats && r.stats[SCORING_KEY] != null) out[String(r.player_id)] = Number(r.stats[SCORING_KEY]) || 0;
  }
  return out;
}

// Distinct defences that appeared as an opponent in the feed — a week counts
// as complete once (nearly) every game has stat lines.
function defencesPlayed(rows) {
  const s = new Set();
  for (const r of rows) if (r && r.opponent && r.player && POSITIONS.indexOf(r.player.position) >= 0) s.add(r.opponent);
  return s;
}
const isComplete = rows => defencesPlayed(rows).size >= MIN_TEAMS_FOR_COMPLETE_WEEK;

async function fetchState() {
  try { return await getJson('https://api.sleeper.app/v1/state/nfl', 8000); } catch (_) { return null; }
}

// Latest week whose stat feed is complete (0 when none). Checks downward from
// Sleeper's current week so a mid-week run never logs a half-played week.
async function latestCompleteWeek(season) {
  season = season || SEASON;
  const state = await fetchState();
  let w = Math.min(18, Math.max(0, Number(state && state.week) || 0));
  for (; w >= 1; w--) {
    const rows = await fetchStatsWeek(w, season);
    if (isComplete(rows)) return w;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------
// Points allowed per game by defence and position over the given weeks —
// identical arithmetic to scripts/scrape-fpa.js so the engine sees the same
// numbers it would have had on that Tuesday.
function fpaCurrentFrom(weekRows) {
  const totals = {}, games = {};
  for (const rows of weekRows) {
    const played = defencesPlayed(rows);
    for (const team of played) games[team] = (games[team] || 0) + 1;
    for (const r of rows) {
      const pos = r && r.player && r.player.position, opp = r && r.opponent;
      if (!opp || POSITIONS.indexOf(pos) < 0) continue;
      (totals[opp] = totals[opp] || {})[pos] = (totals[opp][pos] || 0) + (Number(r.stats && r.stats[SCORING_KEY]) || 0);
    }
  }
  const current = {};
  for (const pos of POSITIONS) {
    current[pos] = {};
    for (const team of Object.keys(totals)) current[pos][team] = +(((totals[team][pos] || 0) / games[team]).toFixed(2));
  }
  return { current, games };
}

// One week's stat feed → { id: { name, pos, team, tgtShare, carryShare, snapPct } }
// for RB/WR/TE who logged a snap. Same rules as server.js fetchUsageWeek.
function usageFrom(rows) {
  const team = {};
  const players = {};
  const kept = [];
  for (const r of rows) {
    const st = r && r.stats, pos = r && r.player && r.player.position;
    if (!st || !r.team || !pos || pos === 'TEAM' || pos === 'DEF') continue;
    const t = team[r.team] || (team[r.team] = { tgt: 0, rush: 0 });
    t.tgt += Number(st.rec_tgt) || 0;
    t.rush += Number(st.rush_att) || 0;
    if (USAGE_POS[pos] && Number(st.off_snp) > 0) kept.push(r);
  }
  for (const r of kept) {
    const t = team[r.team], st = r.stats;
    players[String(r.player_id)] = {
      name: playerName(r), pos: r.player.position, team: r.team,
      tgtShare: t.tgt > 0 ? (Number(st.rec_tgt) || 0) / t.tgt : null,
      carryShare: t.rush > 0 ? (Number(st.rush_att) || 0) / t.rush : null,
      snapPct: Number(st.tm_off_snp) > 0 ? Number(st.off_snp) / Number(st.tm_off_snp) : null,
    };
  }
  return players;
}

function playerName(r) {
  const p = r.player || {};
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || String(r.player_id);
}

const round = (v, d) => v == null ? null : +Number(v).toFixed(d == null ? 4 : d);

function loadJsonFile(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
// opts: { week, season?, backtestUsers?: [username], backtest?: { leagueId: {...} },
//         history?: prior records (default: loadHistory()), force?, log? }
async function buildWeekRecord(opts) {
  opts = opts || {};
  const season = String(opts.season || SEASON);
  const week = parseInt(opts.week, 10);
  const log = opts.log || (() => {});
  if (!(week >= 1 && week <= 18)) throw new Error('week must be 1–18');

  // Stats for weeks 1..week (usage running averages + no-hindsight FPA).
  const all = await Promise.all(Array.from({ length: week }, (_, i) => fetchStatsWeek(i + 1, season)));
  const thisRows = all[week - 1];
  if (!isComplete(thisRows) && !opts.force) {
    throw new Error(`week ${week} is not complete on Sleeper (${defencesPlayed(thisRows).size} defences with stats, need ${MIN_TEAMS_FOR_COMPLETE_WEEK})`);
  }
  const priorRows = all.slice(0, week - 1).filter(isComplete);
  const weeksPlayed = priorRows.length;
  log(`week ${week}: ${thisRows.length} stat rows, ${defencesPlayed(thisRows).size} defences; ${weeksPlayed} complete prior week(s)`);

  // FPA as the engine saw it BEFORE this week: baseline file + per-team
  // points allowed through week−1. Week 1 has no season data → ranks null.
  const baseline = loadJsonFile('data/fpa-baseline.json') || {};
  const fpaObj = {
    positions: baseline.positions || WeeklyScore.POS_BASELINE_FPA,
    historical: baseline.historical || {},
    current: weeksPlayed ? fpaCurrentFrom(priorRows).current : {},
  };

  const proj = await fetchProjectionsWeek(week, season);

  // fpa entries — every skill player who played, keyed by name (id kept inside).
  const fpa = {};
  const byName = {};
  let ranked = 0, dnp = 0;
  const rankMemo = {};
  for (const r of thisRows) {
    const pos = r && r.player && r.player.position;
    if (POSITIONS.indexOf(pos) < 0 || !r.player_id || !r.opponent) continue;
    const st = r.stats || {};
    const played = st.gp == null ? (Number(st.off_snp) > 0 || st[SCORING_KEY] != null) : Number(st.gp) > 0;
    if (!played) { dnp++; continue; }
    const id = String(r.player_id);
    const p = proj[id] != null ? proj[id] : 0;
    const actual = Number(st[SCORING_KEY]) || 0;
    if (p < MIN_POINTS && actual < MIN_POINTS) continue;
    const mk = pos + ':' + r.opponent;
    const mu = rankMemo[mk] || (rankMemo[mk] = WeeklyScore.matchupMultiplier(pos, r.opponent, fpaObj, weeksPlayed));
    const live = mu.source === 'live' && mu.rank != null;
    if (live) ranked++;
    let name = playerName(r);
    if (byName[name] && byName[name] !== id) name = `${name} (${r.team || id})`;
    byName[name] = id;
    fpa[name] = {
      id, pos, team: r.team || null, opp: r.opponent,
      fpaRating: live ? round(mu.fpa, 2) : null,
      fpaRank: live ? mu.rank : null,
      fpaTeams: live ? mu.n : null,
      proj: round(p, 2),
      actualPoints: round(actual, 2),
    };
  }

  // usage — running season averages through this week.
  const perWeek = all.map((rows, i) => (i === week - 1 || isComplete(rows)) ? usageFrom(rows) : null);
  const acc = {};
  perWeek.forEach((map, i) => {
    if (!map) return;
    for (const id in map) {
      const u = map[id];
      const a = acc[id] || (acc[id] = { name: u.name, pos: u.pos, team: u.team, tgt: [0, 0], carry: [0, 0], snap: [0, 0], weeks: 0, last: null });
      a.name = u.name; a.pos = u.pos; a.team = u.team;   // latest team wins (trades)
      a.weeks++;
      if (u.tgtShare != null) { a.tgt[0] += u.tgtShare; a.tgt[1]++; }
      if (u.carryShare != null) { a.carry[0] += u.carryShare; a.carry[1]++; }
      if (u.snapPct != null) { a.snap[0] += u.snapPct; a.snap[1]++; }
      if (i === week - 1) a.last = { targetShare: round(u.tgtShare), carryShare: round(u.carryShare), snapPct: round(u.snapPct) };
    }
  });
  const usage = {};
  for (const id of Object.keys(acc).sort()) {
    const a = acc[id];
    usage[id] = {
      name: a.name, pos: a.pos, team: a.team,
      targetShareAvg: a.tgt[1] ? round(a.tgt[0] / a.tgt[1]) : null,
      carryShareAvg: a.carry[1] ? round(a.carry[0] / a.carry[1]) : null,
      snapPctAvg: a.snap[1] ? round(a.snap[0] / a.snap[1]) : null,
      weeks: a.weeks,
      last: a.last,
    };
  }

  // backtest — supplied results and/or run now for each user's leagues.
  const backtest = {};
  const notes = [];
  if (opts.backtest && typeof opts.backtest === 'object') {
    for (const [leagueId, b] of Object.entries(opts.backtest)) {
      const clean = cleanBacktest(b);
      if (clean && /^\d{1,32}$/.test(leagueId)) backtest[leagueId] = clean;
    }
  }
  const users = Array.isArray(opts.backtestUsers) ? opts.backtestUsers.filter(u => typeof u === 'string' && /^[\w.-]{1,60}$/.test(u)) : [];
  if (users.length) {
    const { runBacktest } = require('./backtest-lineup.js');
    const history = (opts.history || loadHistory({ season })).filter(h => Number(h.week) < week);
    for (const username of users) {
      let leagues = [];
      try {
        const user = await getJson(`https://api.sleeper.app/v1/user/${encodeURIComponent(username)}`, 8000);
        leagues = user && user.user_id ? await getJson(`https://api.sleeper.app/v1/user/${user.user_id}/leagues/nfl/${season}`, 8000) : [];
      } catch (err) {
        notes.push(`backtest ${username}: ${err.message}`);
        continue;
      }
      for (const l of (Array.isArray(leagues) ? leagues : [])) {
        try {
          const r = await runBacktest({ username, leagueId: l.league_id, week, history });
          if (!r.complete) { notes.push(`backtest ${l.name}: week ${week} stats incomplete on Sleeper`); continue; }
          backtest[String(l.league_id)] = {
            username, league: l.name || null,
            algoScore: round(r.algoPts, 2), optimalScore: round(r.optPts, 2), yourScore: round(r.actualPts, 2),
            accuracy: round(r.accuracy, 4), yourAccuracy: round(r.yourAccuracy, 4),
          };
          log(`backtest ${l.name}: algo ${r.algoPts.toFixed(1)} / optimal ${r.optPts.toFixed(1)} / you ${r.actualPts.toFixed(1)}`);
        } catch (err) {
          notes.push(`backtest ${l.name || l.league_id}: ${err.message}`);
        }
      }
    }
  }

  return {
    season, week,
    generatedAt: new Date().toISOString(),
    scoring: 'half_ppr',
    weeksPlayed,
    fpa, usage, backtest,
    meta: {
      statRows: thisRows.length,
      dnp,
      fpaSamples: Object.keys(fpa).length,
      fpaRanked: ranked,
      usagePlayers: Object.keys(usage).length,
      completeWeeks: all.map((rows, i) => i + 1).filter((w, i) => isComplete(all[i])),
      notes,
    },
  };
}

// Validate a caller-supplied backtest entry (POST body) → clean object or null.
function cleanBacktest(b) {
  if (!b || typeof b !== 'object') return null;
  const num = v => (typeof v === 'number' && isFinite(v)) ? round(v, 4) : null;
  const out = {
    username: typeof b.username === 'string' ? b.username.slice(0, 60) : null,
    league: typeof b.league === 'string' ? b.league.slice(0, 80) : null,
    algoScore: num(b.algoScore), optimalScore: num(b.optimalScore), yourScore: num(b.yourScore),
    accuracy: num(b.accuracy), yourAccuracy: num(b.yourAccuracy),
  };
  if (out.algoScore == null || out.optimalScore == null) return null;
  if (out.accuracy == null && out.optimalScore > 0) out.accuracy = round(out.algoScore / out.optimalScore, 4);
  if (out.yourAccuracy == null && out.yourScore != null && out.optimalScore > 0) out.yourAccuracy = round(out.yourScore / out.optimalScore, 4);
  return out;
}

module.exports = {
  SEASON, HISTORY_DIR,
  historyPath, readWeekRecord, loadHistory, writeWeekRecord,
  buildWeekRecord, latestCompleteWeek, cleanBacktest,
  fpaCurrentFrom, usageFrom, fetchStatsWeek, isComplete,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const flags = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] == null ? true : m[2];
  }
  if (flags.help) {
    console.log('Usage: node scripts/log-week.js [--week=N] [--backtest=user1,user2] [--force] [--dry-run]');
    process.exit(0);
  }
  (async () => {
    const season = SEASON;
    let week = parseInt(flags.week, 10);
    if (!week) {
      week = await latestCompleteWeek(season);
      if (!week) { console.log('No completed week yet — nothing to log.'); return; }
    }
    const usersArg = flags.backtest != null && flags.backtest !== true ? String(flags.backtest) : (process.env.POCKET_BACKTEST_USERS || '');
    const backtestUsers = usersArg.split(',').map(s => s.trim()).filter(Boolean);
    const record = await buildWeekRecord({ week, season, backtestUsers, force: !!flags.force, log: m => console.log('  ' + m) });
    const summary = `${season} week ${week}: ${record.meta.fpaSamples} fpa samples (${record.meta.fpaRanked} ranked), ${record.meta.usagePlayers} usage players, ${Object.keys(record.backtest).length} backtest leagues`;
    for (const n of record.meta.notes) console.warn('  ! ' + n);
    if (flags['dry-run']) { console.log(`[dry-run] ${summary}`); return; }
    const file = writeWeekRecord(record);
    console.log(`Wrote ${path.relative(process.cwd(), file)} — ${summary}`);
  })().catch(err => { console.error(`log-week failed: ${err.message}`); process.exit(1); });
}
