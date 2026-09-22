#!/usr/bin/env node
// Backtest the lineup optimizer against a completed week.
//
//   node scripts/backtest-lineup.js <sleeper-username> [leagueId] [--week=N] [--injuries]
//   node scripts/backtest-lineup.js --all-teams [--week=N] [--user=pykle] [--league=ID] [--top=10] [--injuries]
//
// Single-team mode: for the chosen league it rebuilds what shared/weekly-score.js
// would have recommended BEFORE the week (projections + schedule only — no
// hindsight), pulls the roster the user actually started from the week's
// matchup, and computes the perfect-hindsight optimal lineup from real stat
// lines. All three are printed side by side, then an accuracy score:
// algo pts / optimal pts.
//
// --all-teams mode: runs the same backtest for EVERY roster in EVERY league the
// user is in (~70 teams instead of 1), then aggregates:
//   • summary table per team (algo / actual / optimal / proj-only, accuracy, edge)
//   • position accuracy — per slot, how often the algo's pick was an optimal
//     starter and how often it ranked the position's top scorer #1
//   • factor scorecard — for each live factor (matchup, home/away, TNF, form…),
//     did boosted players beat projection more often than penalized ones?
//   • top N biggest misses across all teams
//   • per-player pool: biggest busts (algo started, wrong) and sleepers (algo
//     benched, optimal started)
//   • verdict vs three baselines: what humans started, raw Sleeper projection
//     with no factors, and a random valid lineup
// --week defaults to the last completed NFL week (Sleeper state.week − 1).
//
// What the algo can and cannot see in a backtest (printed in the data note):
//   base        Sleeper's weekly projection for that week, scored under the league's settings
//   home/away   from the season schedule (live)
//   short week  from the schedule (exempt in week 1 by design)
//   matchup     data/fpa-baseline.json only, plus fpa-current.json when it stops
//               BEFORE the tested week (using this-week FPA would be hindsight)
//   form/usage  prior weeks' stats + projections (neutral for week 1 by design)
//   injury      OFF by default — Sleeper only exposes *today's* status, which
//               would zero out players who were healthy at kickoff. --injuries
//               applies today's statuses anyway (useful when testing the
//               current week).
//   vegas/wx    neutral — no historical odds or forecast feed is wired
//
// Actual points come from api.sleeper.com weekly stats scored under the
// league's scoring_settings (the same path lineup.html uses), cross-checked
// against Sleeper's own players_points from the matchup feed.
//
// Also importable: runBacktest({ username, leagueId, week, useInjuries, history })
// returns the same numbers as a plain object (scripts/log-week.js stores them
// in data/history/). `history` = prior weeks' history records, used only to
// build the FPA calibration the engine would have had before `week`.
// runAllTeams({ username, week, ... }) returns { week, leagues, teams, analysis }.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const WeeklyScore = require('../shared/weekly-score.js');
const ScoringEngine = require('../shared/scoring.js');
const LineupOptimizer = require('../shared/lineup.js');
const FPACalibration = require('../shared/fpa-calibration.js');

const SEASON = '2026';
const FORM_WEEKS = 3;                    // mirrors lineup.html
const POS_QUERY = 'position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF';
const PLAYERS_CACHE = path.join(os.tmpdir(), 'pocket-players-nfl.json');
const PLAYERS_TTL = 24 * 60 * 60 * 1000;
const RANDOM_LINEUPS = 200;              // random-baseline samples per team
const MIN_FACTOR_SAMPLES = 25;           // unique players a factor must touch before it gets a verdict
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
async function getJson(url, { timeout = 20000, optional = false } = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (err) {
    if (optional) return null;
    throw new Error(`${url} → ${err.message}`);
  }
}

// api.sleeper.com weekly feed → { player_id: stats } (same slimming as server.js fetchSleeperWeek)
async function fetchWeek(kind, wk) {
  const raw = await getJson(`https://api.sleeper.com/${kind}/nfl/${SEASON}/${wk}?season_type=regular&${POS_QUERY}`, { optional: true });
  const slim = {};
  for (const item of (Array.isArray(raw) ? raw : [])) {
    if (item && item.player_id && item.stats && Object.keys(item.stats).length) slim[item.player_id] = item.stats;
  }
  return slim;
}

// Full Sleeper player dict (~5 MB) — cached in the OS temp dir for 24h.
async function fetchPlayers() {
  try {
    const st = fs.statSync(PLAYERS_CACHE);
    if (Date.now() - st.mtimeMs < PLAYERS_TTL) return JSON.parse(fs.readFileSync(PLAYERS_CACHE, 'utf8'));
  } catch (_) { /* no cache */ }
  const dict = await getJson('https://api.sleeper.app/v1/players/nfl', { timeout: 30000 });
  try { fs.writeFileSync(PLAYERS_CACHE, JSON.stringify(dict)); } catch (_) { /* cache is best-effort */ }
  return dict;
}

// Last completed regular-season week per Sleeper's NFL state (week − 1, ≥ 1).
async function lastCompletedWeek() {
  const state = await getJson('https://api.sleeper.app/v1/state/nfl', { optional: true });
  if (!state || state.season_type !== 'regular' || String(state.season) !== SEASON) return 1;
  return Math.min(18, Math.max(1, (Number(state.week) || 1) - 1));
}

async function resolveUser(username) {
  const user = await getJson(`https://api.sleeper.app/v1/user/${encodeURIComponent(username)}`);
  if (!user || !user.user_id) throw new Error(`Sleeper user "${username}" not found`);
  const leagues = await getJson(`https://api.sleeper.app/v1/user/${user.user_id}/leagues/nfl/${SEASON}`);
  if (!Array.isArray(leagues) || !leagues.length) throw new Error(`${username} has no ${SEASON} leagues`);
  return { user, leagues };
}

// League-level feeds: settings, rosters, owners, the week's matchups.
async function fetchLeague(leagueId, week) {
  const [league, rosters, users, matchups] = await Promise.all([
    getJson(`https://api.sleeper.app/v1/league/${leagueId}`),
    getJson(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
    getJson(`https://api.sleeper.app/v1/league/${leagueId}/users`, { optional: true }),
    getJson(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`, { optional: true }),
  ]);
  if (!league || !league.league_id) throw new Error(`League ${leagueId} not found`);
  return { league, rosters: rosters || [], users: users || [], matchups: matchups || [] };
}

// League-independent feeds for the week: player dict, projections, stats,
// schedule, the prior FORM_WEEKS weeks (for the form factor), and today's
// defensive injuries when --injuries is on. Fetched once, shared by every team.
async function fetchFeeds(week, useInjuries) {
  const pastWeeks = [];
  for (let w = week - 1; w >= Math.max(1, week - FORM_WEEKS); w--) pastWeeks.push(w);
  const [players, proj, stats, schedule, past, defInj] = await Promise.all([
    fetchPlayers(),
    fetchWeek('projections', week),
    fetchWeek('stats', week),
    getJson(`https://api.sleeper.app/schedule/nfl/regular/${SEASON}`, { optional: true }),
    Promise.all(pastWeeks.map(w => Promise.all([fetchWeek('stats', w), fetchWeek('projections', w)]).then(r => ({ week: w, stats: r[0], proj: r[1] })))),
    useInjuries ? buildDefInjuries() : Promise.resolve({}),
  ]);
  // Schedule for the week: TEAM → { opp, home, date }
  let games;
  if (Array.isArray(schedule) && schedule.length) {
    games = {};
    for (const g of schedule) {
      if (Number(g.week) !== week || !g.home || !g.away) continue;
      games[g.home] = { opp: g.away, home: true, date: g.date || null };
      games[g.away] = { opp: g.home, home: false, date: g.date || null };
    }
  }
  return { week, players, proj, stats, games, past, pastWeeks, defInj, useInjuries };
}

function loadJsonFile(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')); } catch (_) { return null; }
}

// Same merge rule as lineup.html mergeFPA, plus a no-hindsight guard: this
// season's per-team FPA only counts if it was built from weeks BEFORE `week`,
// and the calibration only from history records for weeks BEFORE `week`.
function loadFPA(wk, history) {
  const baseline = loadJsonFile('data/fpa-baseline.json');
  const current = loadJsonFile('data/fpa-current.json');
  if (!baseline && !current) return { fpa: null, note: 'no FPA files' };
  const out = Object.assign({}, baseline || {});
  const through = current && Number(current.throughWeek);
  const usable = current && current.current && String(current.season) === SEASON && through > 0 && through < wk;
  const prior = (history || []).filter(h => h && Number(h.week) < wk);
  if (prior.length) out.calibration = FPACalibration.build(prior);
  const calNote = out.calibration && out.calibration.active
    ? `; FPA calibration from ${prior.length} logged wks`
    : prior.length ? `; ${prior.length} logged wk${prior.length > 1 ? 's' : ''} (calibration needs ${FPACalibration.MIN_WEEKS})` : '';
  if (usable) {
    out.current = Object.assign({}, out.current || {}, current.current);
    return { fpa: out, note: `baseline + current FPA through week ${through}${calNote}` };
  }
  return { fpa: out, note: (current ? `baseline only (fpa-current.json is through week ${through || '?'} — hindsight for week ${wk})` : 'baseline only') + calNote };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const fmt = n => (n == null || !isFinite(n)) ? '—' : n.toFixed(1);
const signed = n => (n == null || !isFinite(n)) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1);
const pctOf = (a, b) => b > 0 ? (100 * a / b).toFixed(1) + '%' : '—';
const pct0 = (a, b) => b > 0 ? Math.round(100 * a / b) + '%' : '—';
const pad = (s, n, right) => { s = String(s == null ? '' : s); if (s.length > n) s = s.slice(0, n - 1) + '…'; return right ? s.padStart(n) : s.padEnd(n); };

function table(headers, rows, aligns) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map(r => String(r[i] == null ? '' : r[i]).length)));
  const line = cells => cells.map((c, i) => pad(c, widths[i], aligns && aligns[i] === 'r')).join('  ');
  const out = [line(headers), widths.map(w => '─'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

// Deterministic PRNG (mulberry32) so the random baseline is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Backtest one roster (pure: all feeds already fetched)
// ---------------------------------------------------------------------------
// Resolves to { league, leagueId, teamName, ownerId, rosterId, week, slots, rows,
//   byId, algo, optimal, projOnly, actualBySlot, algoPts, actualPts, optPts,
//   projPts, randomPts, accuracy, yourAccuracy, projAccuracy, randomAccuracy,
//   complete, stats: {...}, notes, warnings, misses }.
function backtestRoster({ league, roster, users, matchups, feeds, fpaInfo, warnings }) {
  const { week, players, proj, stats, games, past, pastWeeks, defInj, useInjuries } = feeds;
  const weeksPlayed = week - 1;
  const scoring = league.scoring_settings || {};
  const rosterPositions = league.roster_positions || [];
  const owner = (users || []).find(u => u.user_id === roster.owner_id);
  const teamName = (owner && owner.metadata && owner.metadata.team_name) || (owner && owner.display_name) || `Roster ${roster.roster_id}`;
  const username = (owner && owner.display_name) || null;

  // Week-specific roster + starters come from the matchup feed (roster.starters is
  // whatever is set *now*). Fall back to the current roster if the week has no matchup.
  const matchup = (matchups || []).find(m => m.roster_id === roster.roster_id) || null;
  const weekPlayers = (matchup && matchup.players) || roster.players || [];
  const actualStarters = (matchup && matchup.starters) || roster.starters || [];
  const sleeperPts = (matchup && matchup.players_points) || {};
  const reserve = new Set((roster.reserve || []).concat(roster.taxi || []));
  const ids = weekPlayers.filter(id => id && id !== '0' && !reserve.has(id));

  const info = id => {
    const p = players[id];
    if (!p) return { name: id, pos: '?', team: null, status: null };
    const isDef = p.position === 'DEF';
    return {
      name: isDef ? ([p.first_name, p.last_name].filter(Boolean).join(' ') || id) : (p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || id),
      pos: p.position || (p.fantasy_positions && p.fantasy_positions[0]) || '?',
      team: isDef ? (p.team || id) : (p.team && p.team !== 'FA' ? p.team : null),
      status: p.injury_status || null,
    };
  };

  const formHistory = id => past.map(p => {
    const st = p.stats[id];
    const played = st && (st.gp == null || st.gp > 0);
    return {
      week: p.week,
      actual: played ? ScoringEngine.scorePlayer({ player_id: id }, p.stats, scoring) : null,
      projected: p.proj[id] ? ScoringEngine.scorePlayer({ player_id: id }, p.proj, scoring) : 0,
    };
  });

  let mismatches = 0, noProj = 0;
  const rows = ids.map(id => {
    const meta = info(id);
    const game = meta.team && games ? games[meta.team] || null : null;
    const opponent = games === undefined ? undefined : (game ? game.opp : null);
    const base = ScoringEngine.scorePlayer({ player_id: id }, proj, scoring);
    if (!proj[id]) noProj++;
    const r = WeeklyScore.computeLineupScore(
      { id, position: meta.pos, team: meta.team, injuryStatus: useInjuries ? meta.status : null },
      {
        week, weeksPlayed, base, opponent,
        isHome: game ? game.home : null,
        gameDate: game ? game.date : null,
        fpa: fpaInfo.fpa, defInjuries: defInj,
        history: formHistory(id),
        // vegas / vegasAvg / weather / usage: not reconstructable for a past week → neutral
      }
    );
    const st = stats[id];
    const played = !!st && (st.gp == null || st.gp > 0);
    let actual = played ? ScoringEngine.scorePlayer({ player_id: id }, stats, scoring) : (st ? 0 : null);
    const sp = sleeperPts[id];
    if (actual == null && sp != null) actual = Number(sp);
    if (actual != null && sp != null && Math.abs(actual - Number(sp)) > 0.5) mismatches++;
    return { id, ...meta, base, score: r.score, mult: r.mult, factors: r.factors, opponent, actual: actual == null ? 0 : actual, hasStats: actual != null || sp != null };
  });
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));

  // Lineups: algo (proj × factors), proj-only (no factors), optimal (hindsight), actual (what was set)
  const pool = key => rows.map(r => ({ id: r.id, position: r.pos, value: r[key] }));
  const algo = LineupOptimizer.optimize(pool('score'), rosterPositions);
  const projOnly = LineupOptimizer.optimize(pool('base'), rosterPositions);
  const optimal = LineupOptimizer.optimize(pool('actual'), rosterPositions);
  const slots = LineupOptimizer.starterSlots(rosterPositions);
  // Sleeper's starters array lines up index-for-index with roster_positions' starter slots.
  const actualBySlot = slots.map((s, i) => ({ slot: s.slot, id: actualStarters[i] && actualStarters[i] !== '0' ? actualStarters[i] : null }));

  const sum = lineup => lineup.reduce((t, s) => t + (s.id && byId[s.id] ? byId[s.id].actual : 0), 0);
  const algoPts = sum(algo.starters), actualPts = sum(actualBySlot), optPts = sum(optimal.starters), projPts = sum(projOnly.starters);

  // Random baseline: mean actual pts over RANDOM_LINEUPS random valid lineups.
  const rand = rng(Number(String(roster.roster_id) + String(week)) * 7919 + 17);
  let randomTotal = 0;
  for (let i = 0; i < RANDOM_LINEUPS; i++) {
    randomTotal += sum(LineupOptimizer.optimize(rows.map(r => ({ id: r.id, position: r.pos, value: rand() })), rosterPositions).starters);
  }
  const randomPts = randomTotal / RANDOM_LINEUPS;
  const statCount = Object.keys(stats).length;

  const notes = [];
  notes.push(`projections: Sleeper week ${week} (${Object.keys(proj).length} players; ${noProj} rostered with none → 0)`);
  notes.push(`stats: Sleeper week ${week} (${statCount} players)${mismatches ? `; ${mismatches} differ >0.5 from Sleeper's players_points` : matchup && statCount ? '; matches Sleeper players_points' : ''}`);
  notes.push(`schedule: ${games ? 'live (home/away' + (weeksPlayed === 0 ? ', TNF exempt in week 1' : ', TNF') + ')' : 'unavailable → neutral'}`);
  notes.push(`matchup FPA: ${fpaInfo.note}${weeksPlayed === 0 ? ' (weight 0% at week 1 → neutral)' : ''}`);
  notes.push(`form/usage: ${weeksPlayed <= 1 ? 'neutral (≤1 completed week)' : `form from weeks ${pastWeeks.join(',')}; usage not wired in backtest`}`);
  notes.push(`injuries: ${useInjuries ? "TODAY's statuses applied (--injuries)" : 'off — Sleeper has no historical status'}`);
  notes.push('vegas / weather: neutral (no historical feed)');
  notes.push(`actual lineup: ${matchup ? `week ${week} matchup feed` : 'current roster.starters (no matchup for this week)'}`);

  const result = {
    username, leagueId: league.league_id, league, teamName, ownerId: roster.owner_id, rosterId: roster.roster_id,
    week, weeksPlayed, slots,
    rows, byId, algo, optimal, projOnly, actualBySlot,
    algoPts, actualPts, optPts, projPts, randomPts,
    accuracy: optPts > 0 ? algoPts / optPts : null,
    yourAccuracy: optPts > 0 ? actualPts / optPts : null,
    projAccuracy: optPts > 0 ? projPts / optPts : null,
    randomAccuracy: optPts > 0 ? randomPts / optPts : null,
    complete: statCount >= 100,
    stats: { statCount, noProj, mismatches, projCount: Object.keys(proj).length },
    notes, warnings: warnings || [],
  };
  result.misses = pairMisses(result);
  return result;
}

// Pair each optimal starter the algo benched with the algo starter it should
// have replaced: the lowest-scoring wrong starter whose slot the missed player
// is eligible for (a TE can't displace a QB). Returns
// [{ missedId, slot (in optimal), wrongId, wrongSlot, cost }] sorted by cost desc.
function pairMisses(r) {
  const { byId, algo, optimal } = r;
  const algoSet = new Set(algo.starters.map(s => s.id).filter(Boolean));
  const optSlot = {};
  for (const s of optimal.starters) if (s.id) optSlot[s.id] = s.slot;
  const missed = Object.keys(optSlot).filter(id => !algoSet.has(id)).sort((a, b) => byId[b].actual - byId[a].actual);
  const wrong = algo.starters.filter(s => s.id && !(s.id in optSlot)).sort((a, b) => byId[a.id].actual - byId[b.id].actual);
  const used = new Set();
  const pairs = missed.map(id => {
    const m = byId[id];
    let w = wrong.find(s => !used.has(s.id) && (LineupOptimizer.eligible(s.slot) || []).includes(m.pos));
    if (!w) w = wrong.find(s => !used.has(s.id)) || null;
    if (w) used.add(w.id);
    return { missedId: id, slot: optSlot[id], wrongId: w ? w.id : null, wrongSlot: w ? w.slot : null, cost: m.actual - (w ? byId[w.id].actual : 0) };
  });
  return pairs.sort((a, b) => b.cost - a.cost);
}

// ---------------------------------------------------------------------------
// Single-team backtest (importable; used by scripts/log-week.js)
// ---------------------------------------------------------------------------
// opts: { username, leagueId?, week, useInjuries?, history? }
async function runBacktest(opts) {
  const username = opts.username;
  const leagueArg = opts.leagueId || null;
  const week = parseInt(opts.week, 10) || 1;
  const useInjuries = !!opts.useInjuries;
  if (!username) throw new Error('username required');
  if (week < 1 || week > 18) throw new Error('week must be 1–18');
  const warnings = [];

  const { user, leagues } = await resolveUser(username);
  const leagueId = leagueArg || leagues[0].league_id;
  if (leagueArg && !leagues.some(l => l.league_id === leagueArg)) {
    warnings.push(`${username} is not in league ${leagueArg} per Sleeper — continuing anyway`);
  }
  const [lg, feeds] = await Promise.all([fetchLeague(leagueId, week), fetchFeeds(week, useInjuries)]);
  const roster = lg.rosters.find(r => r.owner_id === user.user_id || (Array.isArray(r.co_owners) && r.co_owners.includes(user.user_id)));
  if (!roster) throw new Error(`${username} has no roster in "${lg.league.name}"`);

  const fpaInfo = loadFPA(week, opts.history);
  const r = backtestRoster({ league: lg.league, roster, users: lg.users, matchups: lg.matchups, feeds, fpaInfo, warnings });
  r.username = username;
  const me = lg.users.find(u => u.user_id === user.user_id);
  r.teamName = (me && me.metadata && me.metadata.team_name) || (me && me.display_name) || username;
  return r;
}

// ---------------------------------------------------------------------------
// All teams in all of a user's leagues
// ---------------------------------------------------------------------------
// opts: { username, week, useInjuries?, history?, leagueIds?: [..] }
// Resolves to { username, week, feeds, fpaInfo, leagues: [{ league, teams: [result] }],
//   teams: [result], analysis: analyzeTeams(teams) }.
async function runAllTeams(opts) {
  const username = opts.username;
  const week = parseInt(opts.week, 10) || 1;
  const useInjuries = !!opts.useInjuries;
  if (!username) throw new Error('username required');
  if (week < 1 || week > 18) throw new Error('week must be 1–18');

  const { user, leagues: all } = await resolveUser(username);
  const only = Array.isArray(opts.leagueIds) && opts.leagueIds.length ? new Set(opts.leagueIds.map(String)) : null;
  const leagues = only ? all.filter(l => only.has(String(l.league_id))) : all;
  if (!leagues.length) throw new Error(`none of ${username}'s leagues match --league`);

  const [feeds, ...lgs] = await Promise.all([fetchFeeds(week, useInjuries), ...leagues.map(l => fetchLeague(l.league_id, week))]);
  const fpaInfo = loadFPA(week, opts.history);

  const out = [];
  for (const lg of lgs) {
    const teams = [];
    for (const roster of lg.rosters) {
      const ids = (roster.players || []).filter(id => id && id !== '0');
      if (!ids.length) continue;
      const r = backtestRoster({ league: lg.league, roster, users: lg.users, matchups: lg.matchups, feeds, fpaInfo, warnings: [] });
      r.isUser = roster.owner_id === user.user_id || (Array.isArray(roster.co_owners) && roster.co_owners.includes(user.user_id));
      teams.push(r);
    }
    out.push({ league: lg.league, teams });
  }
  const teams = out.flatMap(l => l.teams);
  return { username, week, feeds, fpaInfo, leagues: out, teams, analysis: analyzeTeams(teams) };
}

// Aggregate accuracy, per-slot accuracy, factor scorecard, cross-team misses,
// and the pooled per-player table.
function analyzeTeams(teams) {
  const tot = { algo: 0, actual: 0, opt: 0, proj: 0, random: 0, teams: teams.length, slots: 0 };
  let algoBeatsActual = 0, algoTiesActual = 0, algoBeatsProj = 0, projBeatsAlgo = 0, algoDiffersProj = 0, meanAcc = 0, meanYour = 0, meanProj = 0, meanRand = 0;
  let biggestSwing = null;   // team where the factors moved the most points vs raw projection
  for (const t of teams) {
    tot.algo += t.algoPts; tot.actual += t.actualPts; tot.opt += t.optPts; tot.proj += t.projPts; tot.random += t.randomPts;
    tot.slots += t.slots.length;
    if (t.algoPts > t.actualPts + 1e-9) algoBeatsActual++; else if (Math.abs(t.algoPts - t.actualPts) <= 1e-9) algoTiesActual++;
    const swing = t.algoPts - t.projPts;
    if (Math.abs(swing) > 1e-9) {
      algoDiffersProj++; if (swing > 0) algoBeatsProj++; else projBeatsAlgo++;
      if (!biggestSwing || Math.abs(swing) > Math.abs(biggestSwing.swing)) biggestSwing = { team: t, swing };
    }
    meanAcc += t.accuracy || 0; meanYour += t.yourAccuracy || 0; meanProj += t.projAccuracy || 0; meanRand += t.randomAccuracy || 0;
  }
  const n = teams.length || 1;

  // --- per-slot accuracy -------------------------------------------------
  // slotHit: algo's pick at this slot was an optimal starter (any slot).
  // top1:    the algo's highest-scored player at this position was the position's
  //          top actual scorer on the roster (only counted with ≥2 candidates).
  // lost:    cost of optimal starters the algo benched, attributed to the slot
  //          they occupy in the optimal lineup.
  const bySlot = {};
  const slotRec = s => (bySlot[s] = bySlot[s] || { slot: s, n: 0, hit: 0, top1n: 0, top1: 0, lost: 0, misses: 0 });
  for (const t of teams) {
    const optSet = new Set(t.optimal.starters.map(s => s.id).filter(Boolean));
    for (const s of t.algo.starters) {
      const rec = slotRec(s.slot);
      rec.n++;
      if (s.id && optSet.has(s.id)) rec.hit++;
    }
    for (const pos of POSITIONS) {
      if (!bySlot[pos]) continue;
      const cands = t.rows.filter(r => r.pos === pos);
      if (cands.length < 2) continue;
      const topAlgo = cands.slice().sort((a, b) => b.score - a.score)[0];
      const topActual = cands.slice().sort((a, b) => b.actual - a.actual)[0];
      const rec = slotRec(pos);
      rec.top1n++;
      // ties on actual (e.g. two 0.0 scorers) count as correct
      if (topAlgo.actual >= topActual.actual - 1e-9) rec.top1++;
    }
    for (const m of t.misses) { const rec = slotRec(m.slot); rec.lost += m.cost; rec.misses++; }
  }
  const slotOrder = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'WRRB_FLEX', 'REC_FLEX', 'SUPER_FLEX', 'K', 'DEF'];
  const slotsOut = Object.values(bySlot).sort((a, b) => slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot));

  // --- unique player pool (a player in 4 leagues is one sample for factors) --
  const pool = {};
  for (const t of teams) {
    const algoSet = new Set(t.algo.starters.map(s => s.id).filter(Boolean));
    const optSet = new Set(t.optimal.starters.map(s => s.id).filter(Boolean));
    for (const r of t.rows) {
      const p = pool[r.id] || (pool[r.id] = {
        id: r.id, name: r.name, pos: r.pos, team: r.team, n: 0, base: 0, score: 0, actual: 0, mult: 0,
        hasStats: r.hasStats, factors: r.factors, firstBase: r.base, firstActual: r.actual,
        algoStart: 0, algoStartWrong: 0, algoBench: 0, algoBenchWrong: 0, leagues: new Set(),
      });
      p.n++; p.base += r.base; p.score += r.score; p.actual += r.actual; p.mult += r.mult; p.leagues.add(t.leagueId);
      if (algoSet.has(r.id)) { p.algoStart++; if (!optSet.has(r.id)) p.algoStartWrong++; }
      else { p.algoBench++; if (optSet.has(r.id)) p.algoBenchWrong++; }
    }
  }
  const players = Object.values(pool).map(p => ({
    ...p, baseAvg: p.base / p.n, scoreAvg: p.score / p.n, actualAvg: p.actual / p.n, multAvg: p.mult / p.n, leagues: p.leagues.size,
  }));

  // --- factor scorecard ---------------------------------------------------
  // Sample = unique player with a projection and a stat line. For each factor,
  // split into boosted (mult > 1) and penalized (mult < 1) and compare the share
  // that beat projection with the pool-wide share (the noise expectation).
  const scored = players.filter(p => p.firstBase > 0 && p.hasStats);
  const beat = p => p.firstActual > p.firstBase;
  const ratio = p => Math.min(3, p.firstActual / p.firstBase);
  const baseBeat = scored.length ? scored.filter(beat).length / scored.length : 0;
  const baseRatio = scored.length ? scored.reduce((s, p) => s + ratio(p), 0) / scored.length : 0;
  const factorKeys = {};
  for (const p of scored) for (const k of Object.keys(p.factors || {})) factorKeys[k] = p.factors[k].label || k;
  const factors = Object.keys(factorKeys).map(key => {
    const samples = scored.filter(p => p.factors[key] && p.factors[key].source === 'live' && Math.abs(p.factors[key].mult - 1) > 1e-9);
    const boost = samples.filter(p => p.factors[key].mult > 1);
    const pen = samples.filter(p => p.factors[key].mult < 1);
    const hit = boost.filter(beat).length + pen.filter(p => !beat(p)).length;
    const expected = boost.length * baseBeat + pen.length * (1 - baseBeat);
    const avgRatio = arr => arr.length ? arr.reduce((s, p) => s + ratio(p), 0) / arr.length : null;
    // Pearson corr between log(mult) and log(actual/proj) — direction + strength
    let corr = null;
    if (samples.length >= 5) {
      const xs = samples.map(p => Math.log(p.factors[key].mult)), ys = samples.map(p => Math.log(Math.max(0.05, ratio(p))));
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
      corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
    }
    const hitRate = samples.length ? hit / samples.length : null, expRate = samples.length ? expected / samples.length : null;
    const edge = hitRate != null ? hitRate - expRate : null;
    let verdict;
    if (!samples.length) verdict = 'inactive';
    else if (samples.length < MIN_FACTOR_SAMPLES) verdict = 'too few samples';
    else if (edge > 0.05 && (corr == null || corr > 0.03)) verdict = 'helping';
    else if (edge < -0.05 || (corr != null && corr < -0.1)) verdict = 'hurting';
    else verdict = 'noise';
    return { key, label: factorKeys[key], n: samples.length, boost: boost.length, pen: pen.length, boostRatio: avgRatio(boost), penRatio: avgRatio(pen), hitRate, expRate, edge, corr, verdict };
  }).sort((a, b) => b.n - a.n);

  // --- misses across all teams -------------------------------------------
  const misses = [];
  for (const t of teams) for (const m of t.misses) misses.push({ team: t, ...m });
  misses.sort((a, b) => b.cost - a.cost);

  const busts = players.filter(p => p.algoStartWrong > 0).sort((a, b) => (b.scoreAvg - b.actualAvg) - (a.scoreAvg - a.actualAvg));
  const sleepers = players.filter(p => p.algoBenchWrong > 0).sort((a, b) => (b.actualAvg - b.scoreAvg) - (a.actualAvg - a.scoreAvg));

  return {
    totals: tot,
    accuracy: tot.opt > 0 ? tot.algo / tot.opt : null,
    yourAccuracy: tot.opt > 0 ? tot.actual / tot.opt : null,
    projAccuracy: tot.opt > 0 ? tot.proj / tot.opt : null,
    randomAccuracy: tot.opt > 0 ? tot.random / tot.opt : null,
    meanAccuracy: meanAcc / n, meanYourAccuracy: meanYour / n, meanProjAccuracy: meanProj / n, meanRandomAccuracy: meanRand / n,
    algoBeatsActual, algoTiesActual, algoLosesActual: teams.length - algoBeatsActual - algoTiesActual,
    algoDiffersProj, algoBeatsProj, projBeatsAlgo, biggestSwing,
    slots: slotsOut, factors, misses, players, busts, sleepers,
    scoredPlayers: scored.length, baseBeat, baseRatio,
  };
}

// ---------------------------------------------------------------------------
// CLI output — single team
// ---------------------------------------------------------------------------
function printBacktest(r) {
  const { league, week, teamName, username, slots, byId, algo, optimal, actualBySlot, algoPts, actualPts, optPts, rows, notes, warnings } = r;
  const weeksPlayed = week - 1;
  const statCount = r.stats.statCount;
  const label = id => { const p = id && byId[id]; return p ? `${p.name} ${p.pos}${p.team ? '/' + p.team : ''}` : '(empty)'; };
  const pts = id => { const p = id && byId[id]; return p ? fmt(p.actual) : '—'; };

  for (const w of warnings) console.error(`note: ${w}`);
  console.log(`\nPocket lineup backtest — ${league.name} · Week ${week} · ${teamName} (${username})`);
  console.log(`League ${league.league_id} · ${league.total_rosters} teams · starters: ${slots.map(s => s.slot).join(' ')}`);
  if (statCount < 100) {
    console.log(`\n⚠  Week ${week} has ${statCount ? 'only ' + statCount : 'no'} stat lines on Sleeper — games not played yet. "Pts" and "Optimal" below are meaningless until the week completes.`);
  }
  console.log();

  console.log(table(
    ['Slot', 'Algo pick', 'Proj', 'Pts', 'Actual lineup', 'Pts', 'Optimal', 'Pts'],
    slots.map((s, i) => {
      const a = algo.starters[i], u = actualBySlot[i], o = optimal.starters[i];
      const ap = a.id && byId[a.id];
      return [s.slot, label(a.id), ap ? fmt(ap.score) : '—', pts(a.id), label(u.id), pts(u.id), label(o.id), pts(o.id)];
    }).concat([[
      'TOTAL', '', '', fmt(algoPts), '', fmt(actualPts), '', fmt(optPts),
    ]]),
    ['l', 'l', 'r', 'r', 'l', 'r', 'l', 'r']
  ));

  console.log(`\nAccuracy (pts captured vs optimal):   algo ${pctOf(algoPts, optPts)}   actual lineup ${pctOf(actualPts, optPts)}   proj-only ${pctOf(r.projPts, optPts)}   random ${pctOf(r.randomPts, optPts)}`);
  console.log(`Points left on bench:                 algo ${fmt(optPts - algoPts)}   actual lineup ${fmt(optPts - actualPts)}`);
  console.log(`Algo vs what you started:             ${signed(algoPts - actualPts)} pts`);

  // Where the algo differed from optimal — the "bad recommendations"
  if (r.misses.length) {
    console.log('\nMisses — algo benched these, optimal started them:');
    console.log(table(
      ['Should have started', 'Proj', 'Pts', 'Instead started', 'Proj', 'Pts', 'Cost'],
      r.misses.map(m => {
        const a = byId[m.missedId], w = m.wrongId ? byId[m.wrongId] : null;
        return [label(m.missedId), fmt(a.score), fmt(a.actual), w ? label(w.id) : '—', w ? fmt(w.score) : '—', w ? fmt(w.actual) : '—', fmt(m.cost)];
      }),
      ['l', 'r', 'r', 'l', 'r', 'r', 'r']
    ));
  } else {
    console.log('\nAlgo matched the optimal lineup exactly.');
  }

  // Full roster with factor breakdown
  console.log('\nRoster (algo score = proj × factors; live factors only):');
  console.log(table(
    ['Player', 'Opp', 'Proj', 'Mult', 'Score', 'Actual', 'Δ', 'Live factors'],
    rows.slice().sort((a, b) => b.score - a.score).map(r => {
      const live = Object.values(r.factors).filter(f => f.source === 'live' && Math.abs(f.mult - 1) > 1e-9).map(f => `${f.label} ${WeeklyScore.pct(f.mult)}`);
      const opp = r.opponent === undefined ? '?' : r.opponent === null ? 'BYE' : (r.factors.homeAway.mult > 1 ? 'vs ' : '@ ') + r.opponent;
      return [`${r.name} ${r.pos}${r.team ? '/' + r.team : ''}`, opp, fmt(r.base), r.mult.toFixed(3), fmt(r.score), r.hasStats ? fmt(r.actual) : 'DNP', fmt(r.actual - r.score), live.join(', ') || '—'];
    }),
    ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'l']
  ));

  console.log('\nData: ' + notes.join('\n      '));
  console.log();
}

// ---------------------------------------------------------------------------
// CLI output — all teams
// ---------------------------------------------------------------------------
function printAllTeams(all, { top = 10 } = {}) {
  const { username, week, leagues, teams, analysis: A } = all;
  const statCount = all.feeds.stats ? Object.keys(all.feeds.stats).length : 0;
  const label = p => p ? `${p.name} ${p.pos}${p.team ? '/' + p.team : ''}` : '(empty)';
  const short = s => String(s || '').replace(/[^\p{L}\p{N}\s'&.-]/gu, '').trim().slice(0, 22) || String(s);

  console.log(`\nPocket lineup backtest — ALL TEAMS · Week ${week} · ${username}'s ${leagues.length} league${leagues.length === 1 ? '' : 's'} · ${teams.length} teams · ${A.totals.slots} lineup slots`);
  console.log(leagues.map(l => `  ${l.league.name} — ${l.teams.length} teams · ${l.teams[0] ? l.teams[0].slots.map(s => s.slot).join(' ') : '?'}`).join('\n'));
  if (statCount < 100) {
    console.log(`\n⚠  Week ${week} has ${statCount ? 'only ' + statCount : 'no'} stat lines on Sleeper — games not played yet. Everything below is meaningless until the week completes.`);
  }

  // 1. Summary table --------------------------------------------------------
  console.log('\n1. SUMMARY — algo vs actual vs optimal (sorted by algo edge over what the team started)\n');
  const rows = [];
  for (const l of leagues) {
    const ts = l.teams.slice().sort((a, b) => (b.algoPts - b.actualPts) - (a.algoPts - a.actualPts));
    for (const t of ts) {
      rows.push([short(l.league.name), (t.isUser ? '★ ' : '') + short(t.teamName), fmt(t.algoPts), fmt(t.actualPts), fmt(t.optPts), fmt(t.projPts), pctOf(t.algoPts, t.optPts), pctOf(t.actualPts, t.optPts), signed(t.algoPts - t.actualPts)]);
    }
    const s = ts.reduce((acc, t) => ({ a: acc.a + t.algoPts, u: acc.u + t.actualPts, o: acc.o + t.optPts, p: acc.p + t.projPts }), { a: 0, u: 0, o: 0, p: 0 });
    rows.push([short(l.league.name), `— league total (${ts.length})`, fmt(s.a), fmt(s.u), fmt(s.o), fmt(s.p), pctOf(s.a, s.o), pctOf(s.u, s.o), signed(s.a - s.u)]);
  }
  rows.push(['ALL', `${teams.length} teams`, fmt(A.totals.algo), fmt(A.totals.actual), fmt(A.totals.opt), fmt(A.totals.proj), pctOf(A.totals.algo, A.totals.opt), pctOf(A.totals.actual, A.totals.opt), signed(A.totals.algo - A.totals.actual)]);
  console.log(table(['League', 'Team', 'Algo', 'Actual', 'Optimal', 'ProjOnly', 'Algo acc', 'Actual acc', 'Edge'], rows, ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r']));
  console.log(`\n★ = ${username}. Edge = algo pts − pts the team actually started. ProjOnly = raw Sleeper projection, no factors.`);

  // 2. Position accuracy ------------------------------------------------------
  console.log('\n2. POSITION ACCURACY — per starting slot across all teams\n');
  console.log(table(
    ['Slot', 'Slots', 'Pick was optimal', 'Ranked top scorer #1', 'Misses', 'Pts lost', 'Lost/team'],
    A.slots.map(s => [s.slot, s.n, pct0(s.hit, s.n), s.top1n ? `${pct0(s.top1, s.top1n)} (${s.top1}/${s.top1n})` : '—', s.misses, fmt(s.lost), fmt(s.lost / teams.length)]),
    ['l', 'r', 'r', 'r', 'r', 'r', 'r']
  ));
  console.log('\n"Pick was optimal": the algo\'s starter in this slot was in the hindsight-optimal lineup.');
  console.log('"Ranked top scorer #1": the algo\'s highest-scored player at this position was the roster\'s top actual scorer (rosters with ≥2 at the position).');
  console.log('"Pts lost": cost of optimal starters the algo benched, attributed to the slot they fill in the optimal lineup.');

  // 3. Factor scorecard -------------------------------------------------------
  console.log(`\n3. FACTOR SCORECARD — ${A.scoredPlayers} unique players with a projection and a stat line; ${pct0(A.baseBeat, 1)} beat their projection (avg actual/proj ${A.baseRatio.toFixed(2)})\n`);
  console.log(table(
    ['Factor', 'Players', 'Boosted', 'avg act/proj', 'Penalized', 'avg act/proj', 'Direction right', 'Expected', 'Edge', 'Corr', 'Verdict'],
    A.factors.map(f => [
      f.label, f.n, f.boost, f.boostRatio == null ? '—' : f.boostRatio.toFixed(2), f.pen, f.penRatio == null ? '—' : f.penRatio.toFixed(2),
      f.hitRate == null ? '—' : pct0(f.hitRate, 1), f.expRate == null ? '—' : pct0(f.expRate, 1),
      f.edge == null ? '—' : (f.edge >= 0 ? '+' : '') + Math.round(100 * f.edge) + 'pt', f.corr == null ? '—' : (f.corr >= 0 ? '+' : '') + f.corr.toFixed(2), f.verdict,
    ]),
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l']
  ));
  console.log(`\n"Direction right": boosted player beat projection, or penalized player fell short. "Expected" is what a coin-flip factor would score given how often anyone beats projection. Verdicts need ≥${MIN_FACTOR_SAMPLES} players.`);
  console.log('Corr = correlation between log(factor mult) and log(actual/proj). Inactive factors (vegas, weather, usage, injuries) have no historical feed in a backtest.');

  // 4. Top misses --------------------------------------------------------------
  console.log(`\n4. TOP ${top} ALGO MISSES — biggest single-slot costs across all ${teams.length} teams\n`);
  console.log(table(
    ['#', 'League', 'Team', 'Should have started', 'Proj', 'Algo', 'Pts', 'Instead started', 'Proj', 'Algo', 'Pts', 'Cost'],
    A.misses.slice(0, top).map((m, i) => {
      const t = m.team, a = t.byId[m.missedId], w = m.wrongId ? t.byId[m.wrongId] : null;
      return [i + 1, short(t.league.name), short(t.teamName), `${label(a)} (${m.slot})`, fmt(a.base), fmt(a.score), fmt(a.actual), w ? `${label(w)} (${m.wrongSlot})` : '—', w ? fmt(w.base) : '—', w ? fmt(w.score) : '—', w ? fmt(w.actual) : '—', fmt(m.cost)];
    }),
    ['r', 'l', 'l', 'l', 'r', 'r', 'r', 'l', 'r', 'r', 'r', 'r']
  ));

  // 5. Per-player pool ----------------------------------------------------------
  const playerRows = list => list.slice(0, top).map((p, i) => [
    i + 1, label(p), p.n, fmt(p.baseAvg), WeeklyScore.pct(p.multAvg), fmt(p.scoreAvg), p.hasStats ? fmt(p.actualAvg) : 'DNP', signed(p.actualAvg - p.scoreAvg),
    `${p.algoStart}/${p.n}`, `${p.algoStartWrong}`, `${p.algoBenchWrong}`,
    Object.values(p.factors).filter(f => f.source === 'live' && Math.abs(f.mult - 1) > 1e-9).map(f => `${f.label} ${WeeklyScore.pct(f.mult)}`).join(', ') || '—',
  ]);
  const playerHead = ['#', 'Player', 'Rosters', 'Proj', 'Factors', 'Algo', 'Actual', 'Δ', 'Algo started', 'Wrong starts', 'Wrong benches', 'Live factors'];
  const playerAlign = ['r', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'];
  console.log(`\n5a. BIGGEST BUSTS — algo said start, optimal lineup had them on the bench (${A.busts.length} players; ${A.players.length} rostered in total)\n`);
  console.log(table(playerHead, playerRows(A.busts), playerAlign));
  console.log(`\n5b. BIGGEST SLEEPERS — algo said sit, optimal lineup started them (${A.sleepers.length} players)\n`);
  console.log(table(playerHead, playerRows(A.sleepers), playerAlign));
  console.log('\nProj/Algo/Actual are averaged across the leagues the player was rostered in (scoring settings differ). Δ = actual − algo score.');

  // 6. Verdict ------------------------------------------------------------------
  console.log('\n6. VERDICT\n');
  const acc = (x, y) => `${pctOf(x, y)}`;
  console.log(table(
    ['Lineup', 'Total pts', 'Accuracy', 'Mean team acc', 'vs algo'],
    [
      ['Optimal (hindsight)', fmt(A.totals.opt), '100%', '100%', signed(A.totals.opt - A.totals.algo)],
      ['Algo (proj × factors)', fmt(A.totals.algo), acc(A.totals.algo, A.totals.opt), pct0(A.meanAccuracy, 1), '—'],
      ['Proj only (no factors)', fmt(A.totals.proj), acc(A.totals.proj, A.totals.opt), pct0(A.meanProjAccuracy, 1), signed(A.totals.proj - A.totals.algo)],
      ['What teams started', fmt(A.totals.actual), acc(A.totals.actual, A.totals.opt), pct0(A.meanYourAccuracy, 1), signed(A.totals.actual - A.totals.algo)],
      [`Random valid lineup (×${RANDOM_LINEUPS})`, fmt(A.totals.random), acc(A.totals.random, A.totals.opt), pct0(A.meanRandomAccuracy, 1), signed(A.totals.random - A.totals.algo)],
    ],
    ['l', 'r', 'r', 'r', 'r']
  ));
  const lines = [];
  const edgeVsHuman = A.totals.algo - A.totals.actual, edgeVsRandom = A.totals.algo - A.totals.random, edgeVsProj = A.totals.algo - A.totals.proj;
  lines.push(`• vs random: ${signed(edgeVsRandom)} pts across ${teams.length} teams (${signed(edgeVsRandom / teams.length)} per team) — ${edgeVsRandom > 0 ? 'the algo is clearly better than chance' : 'NOT better than chance'}.`);
  lines.push(`• vs humans: ${signed(edgeVsHuman)} pts total (${signed(edgeVsHuman / teams.length)} per team); algo beat the actual lineup on ${A.algoBeatsActual}, tied ${A.algoTiesActual}, lost ${A.algoLosesActual} of ${teams.length} teams.`);
  if (A.algoDiffersProj) {
    lines.push(`• factors vs raw projection: the factors changed the lineup on ${A.algoDiffersProj}/${teams.length} teams, helping ${A.algoBeatsProj}× and hurting ${A.projBeatsAlgo}×, net ${signed(edgeVsProj)} pts — ${edgeVsProj > 1 ? 'the factors add value' : edgeVsProj < -1 ? 'the factors are costing points; raw projection would have done better' : 'the factors are a wash this week'}.`);
    const bs = A.biggestSwing;
    if (bs && Math.abs(bs.swing) > Math.abs(edgeVsProj) * 0.5) {
      lines.push(`  ⚠ ${signed(bs.swing)} of that is one team (${short(bs.team.teamName)}, ${short(bs.team.league.name)}) — a ${A.algoDiffersProj}-lineup sample is dominated by single coin-flip swaps between near-equal projections; the direction test in section 3 is the more reliable read on the factors.`);
    }
  } else {
    lines.push('• factors vs raw projection: the factors never changed a lineup this week — the algo is effectively Sleeper projection.');
  }
  const worst = A.slots.filter(s => s.n >= 10).slice().sort((a, b) => a.hit / a.n - b.hit / b.n)[0];
  const costliest = A.slots.slice().sort((a, b) => b.lost - a.lost)[0];
  if (worst) lines.push(`• weakest slot: ${worst.slot} — the algo's pick was optimal only ${pct0(worst.hit, worst.n)} of the time (${worst.hit}/${worst.n}).`);
  if (costliest) lines.push(`• costliest slot: ${costliest.slot} — ${fmt(costliest.lost)} pts left on benches (${fmt(costliest.lost / teams.length)} per team), ${costliest.misses} misses.`);
  const helping = A.factors.filter(f => f.verdict === 'helping').map(f => f.label), hurting = A.factors.filter(f => f.verdict === 'hurting').map(f => f.label), noise = A.factors.filter(f => f.verdict === 'noise').map(f => f.label);
  lines.push(`• factors: helping [${helping.join(', ') || 'none'}] · hurting [${hurting.join(', ') || 'none'}] · noise [${noise.join(', ') || 'none'}].`);
  const unbeatable = A.totals.opt - A.totals.proj;
  lines.push(`• ceiling: even raw projection leaves ${fmt(unbeatable)} pts (${pctOf(unbeatable, A.totals.opt)}) on benches — that gap is projection error, and the factors can only claw back a slice of it. Improvement opportunities are where the algo's misses cluster (section 2/4), not in re-weighting factors marked noise.`);
  console.log('\n' + lines.join('\n'));

  const notes = teams[0] ? teams[0].notes : [];
  console.log('\nData: ' + notes.join('\n      '));
  console.log();
}

module.exports = { runBacktest, runAllTeams, analyzeTeams, printBacktest, printAllTeams, loadFPA, lastCompletedWeek };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (const a of args) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] == null ? true : m[2];
    else positional.push(a);
  }
  const allTeams = !!flags['all-teams'];
  const username = positional[0] || (allTeams ? (typeof flags.user === 'string' ? flags.user : 'pykle') : null);
  if (!username || flags.help) {
    console.error('Usage: node scripts/backtest-lineup.js <sleeper-username> [leagueId] [--week=N] [--injuries]');
    console.error('       node scripts/backtest-lineup.js --all-teams [--week=N] [--user=pykle] [--league=ID[,ID]] [--top=10] [--injuries]');
    console.error('--week defaults to the last completed NFL week.');
    process.exit(username ? 0 : 1);
  }
  // Prior weeks' history records feed the FPA calibration (no-hindsight guard in loadFPA).
  let history = [];
  try { history = require('./log-week.js').loadHistory(); } catch (_) { /* optional */ }

  (async () => {
    const week = flags.week != null ? parseInt(flags.week, 10) : await lastCompletedWeek();
    if (!(week >= 1 && week <= 18)) throw new Error('week must be 1–18');
    const useInjuries = !!flags.injuries;
    if (allTeams) {
      const leagueIds = typeof flags.league === 'string' ? flags.league.split(',').map(s => s.trim()).filter(Boolean) : null;
      const top = parseInt(flags.top, 10) || 10;
      const all = await runAllTeams({ username, week, useInjuries, history, leagueIds });
      printAllTeams(all, { top });
    } else {
      const r = await runBacktest({ username, leagueId: positional[1], week, useInjuries, history });
      printBacktest(r);
    }
  })().catch(err => { console.error('backtest failed:', err.message); process.exit(1); });
}

// Today's injured defenders by team (only used with --injuries). Mirrors /api/def-injuries.
async function buildDefInjuries() {
  const dict = await fetchPlayers();
  const DEF_POS = new Set(['CB', 'DB', 'S', 'SS', 'FS', 'LB', 'OLB', 'ILB', 'MLB']);
  const STATUSES = new Set(['Out', 'IR', 'Doubtful', 'PUP', 'Questionable']);
  const byTeam = {};
  for (const p of Object.values(dict)) {
    if (!p || !p.team || !DEF_POS.has(p.position) || !STATUSES.has(p.injury_status)) continue;
    const order = Number(p.depth_chart_order);
    if (!order || order > 2) continue;
    (byTeam[p.team] = byTeam[p.team] || []).push({
      name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' '),
      pos: p.position, slot: p.depth_chart_position || null, order, status: p.injury_status,
    });
  }
  return byTeam;
}
