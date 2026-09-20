#!/usr/bin/env node
// Backtest the lineup optimizer against a completed week.
//
//   node scripts/backtest-lineup.js <sleeper-username> [leagueId] [--week=1] [--injuries]
//
// For the chosen league it rebuilds what shared/weekly-score.js would have
// recommended BEFORE the week (projections + schedule only — no hindsight),
// pulls the roster the user actually started from the week's matchup, and
// computes the perfect-hindsight optimal lineup from real stat lines. All three
// are printed side by side, then an accuracy score: algo pts / optimal pts.
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
const pad = (s, n, right) => { s = String(s == null ? '' : s); if (s.length > n) s = s.slice(0, n - 1) + '…'; return right ? s.padStart(n) : s.padEnd(n); };

function table(headers, rows, aligns) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map(r => String(r[i] == null ? '' : r[i]).length)));
  const line = cells => cells.map((c, i) => pad(c, widths[i], aligns && aligns[i] === 'r')).join('  ');
  const out = [line(headers), widths.map(w => '─'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Backtest (importable)
// ---------------------------------------------------------------------------
// opts: { username, leagueId?, week, useInjuries?, history? }
// Resolves to { league, leagueId, teamName, username, week, slots, rows, byId,
//   algo, optimal, actualBySlot, algoPts, actualPts, optPts, accuracy,
//   yourAccuracy, stats: { statCount, noProj, mismatches }, notes: [...] }.
async function runBacktest(opts) {
  const username = opts.username;
  const leagueArg = opts.leagueId || null;
  const week = parseInt(opts.week, 10) || 1;
  const useInjuries = !!opts.useInjuries;
  if (!username) throw new Error('username required');
  if (week < 1 || week > 18) throw new Error('week must be 1–18');
  const weeksPlayed = week - 1;
  const warnings = [];

  // 1. user → league
  const user = await getJson(`https://api.sleeper.app/v1/user/${encodeURIComponent(username)}`);
  if (!user || !user.user_id) throw new Error(`Sleeper user "${username}" not found`);
  const leagues = await getJson(`https://api.sleeper.app/v1/user/${user.user_id}/leagues/nfl/${SEASON}`);
  if (!Array.isArray(leagues) || !leagues.length) throw new Error(`${username} has no ${SEASON} leagues`);
  const leagueId = leagueArg || leagues[0].league_id;
  if (leagueArg && !leagues.some(l => l.league_id === leagueArg)) {
    warnings.push(`${username} is not in league ${leagueArg} per Sleeper — continuing anyway`);
  }

  // 2. league + rosters + week matchups + reference feeds, in parallel
  const pastWeeks = [];
  for (let w = week - 1; w >= Math.max(1, week - FORM_WEEKS); w--) pastWeeks.push(w);

  const [league, rosters, users, matchups, players, proj, stats, schedule, past, defInj] = await Promise.all([
    getJson(`https://api.sleeper.app/v1/league/${leagueId}`),
    getJson(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
    getJson(`https://api.sleeper.app/v1/league/${leagueId}/users`, { optional: true }),
    getJson(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`, { optional: true }),
    fetchPlayers(),
    fetchWeek('projections', week),
    fetchWeek('stats', week),
    getJson(`https://api.sleeper.app/schedule/nfl/regular/${SEASON}`, { optional: true }),
    Promise.all(pastWeeks.map(w => Promise.all([fetchWeek('stats', w), fetchWeek('projections', w)]).then(r => ({ week: w, stats: r[0], proj: r[1] })))),
    useInjuries ? buildDefInjuries() : Promise.resolve({}),
  ]);
  if (!league || !league.league_id) throw new Error(`League ${leagueId} not found`);

  const scoring = league.scoring_settings || {};
  const rosterPositions = league.roster_positions || [];
  const roster = (rosters || []).find(r => r.owner_id === user.user_id || (Array.isArray(r.co_owners) && r.co_owners.includes(user.user_id)));
  if (!roster) throw new Error(`${username} has no roster in "${league.name}"`);
  const me = (users || []).find(u => u.user_id === user.user_id);
  const teamName = (me && me.metadata && me.metadata.team_name) || (me && me.display_name) || username;

  // Week-specific roster + starters come from the matchup feed (roster.starters is
  // whatever is set *now*). Fall back to the current roster if the week has no matchup.
  const matchup = (matchups || []).find(m => m.roster_id === roster.roster_id) || null;
  const weekPlayers = (matchup && matchup.players) || roster.players || [];
  const actualStarters = (matchup && matchup.starters) || roster.starters || [];
  const sleeperPts = (matchup && matchup.players_points) || {};
  const reserve = new Set((roster.reserve || []).concat(roster.taxi || []));
  const ids = weekPlayers.filter(id => id && id !== '0' && !reserve.has(id));

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

  const fpaInfo = loadFPA(week, opts.history);

  // 3. per-player data
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

  // 4. three lineups
  const algo = LineupOptimizer.optimize(rows.map(r => ({ id: r.id, position: r.pos, value: r.score })), rosterPositions);
  const optimal = LineupOptimizer.optimize(rows.map(r => ({ id: r.id, position: r.pos, value: r.actual })), rosterPositions);
  const slots = LineupOptimizer.starterSlots(rosterPositions);
  // Sleeper's starters array lines up index-for-index with roster_positions' starter slots.
  const actualBySlot = slots.map((s, i) => ({ slot: s.slot, id: actualStarters[i] && actualStarters[i] !== '0' ? actualStarters[i] : null }));

  const sum = lineup => lineup.reduce((t, s) => t + (s.id && byId[s.id] ? byId[s.id].actual : 0), 0);
  const algoPts = sum(algo.starters), actualPts = sum(actualBySlot), optPts = sum(optimal.starters);
  const statCount = Object.keys(stats).length;

  // Data note
  const notes = [];
  notes.push(`projections: Sleeper week ${week} (${Object.keys(proj).length} players; ${noProj} rostered with none → 0)`);
  notes.push(`stats: Sleeper week ${week} (${statCount} players)${mismatches ? `; ${mismatches} differ >0.5 from Sleeper's players_points` : matchup && statCount ? '; matches Sleeper players_points' : ''}`);
  notes.push(`schedule: ${games ? 'live (home/away' + (weeksPlayed === 0 ? ', TNF exempt in week 1' : ', TNF') + ')' : 'unavailable → neutral'}`);
  notes.push(`matchup FPA: ${fpaInfo.note}${weeksPlayed === 0 ? ' (weight 0% at week 1 → neutral)' : ''}`);
  notes.push(`form/usage: ${weeksPlayed <= 1 ? 'neutral (≤1 completed week)' : `form from weeks ${pastWeeks.join(',')}; usage not wired in backtest`}`);
  notes.push(`injuries: ${useInjuries ? "TODAY's statuses applied (--injuries)" : 'off — Sleeper has no historical status'}`);
  notes.push('vegas / weather: neutral (no historical feed)');
  notes.push(`actual lineup: ${matchup ? `week ${week} matchup feed` : 'current roster.starters (no matchup for this week)'}`);

  return {
    username, leagueId: league.league_id, league, teamName, week, weeksPlayed, slots,
    rows, byId, algo, optimal, actualBySlot,
    algoPts, actualPts, optPts,
    accuracy: optPts > 0 ? algoPts / optPts : null,
    yourAccuracy: optPts > 0 ? actualPts / optPts : null,
    complete: statCount >= 100,
    stats: { statCount, noProj, mismatches, projCount: Object.keys(proj).length },
    notes, warnings,
  };
}

// ---------------------------------------------------------------------------
// CLI output
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

  const pct = (a, b) => b > 0 ? (100 * a / b).toFixed(1) + '%' : '—';
  console.log(`\nAccuracy (pts captured vs optimal):   algo ${pct(algoPts, optPts)}   actual lineup ${pct(actualPts, optPts)}`);
  console.log(`Points left on bench:                 algo ${fmt(optPts - algoPts)}   actual lineup ${fmt(optPts - actualPts)}`);
  console.log(`Algo vs what you started:             ${algoPts - actualPts >= 0 ? '+' : ''}${fmt(algoPts - actualPts)} pts`);

  // Where the algo differed from optimal — the "bad recommendations"
  const algoSet = new Set(algo.starters.map(s => s.id).filter(Boolean));
  const optSet = new Set(optimal.starters.map(s => s.id).filter(Boolean));
  const missed = [...optSet].filter(id => !algoSet.has(id)).sort((a, b) => byId[b].actual - byId[a].actual);
  const wrong = [...algoSet].filter(id => !optSet.has(id)).sort((a, b) => byId[a].actual - byId[b].actual);
  if (missed.length) {
    console.log('\nMisses — algo benched these, optimal started them:');
    console.log(table(
      ['Should have started', 'Proj', 'Pts', 'Instead started', 'Proj', 'Pts', 'Cost'],
      missed.map((id, i) => {
        const m = byId[id], w = wrong[i] ? byId[wrong[i]] : null;
        return [label(id), fmt(m.score), fmt(m.actual), w ? label(w.id) : '—', w ? fmt(w.score) : '—', w ? fmt(w.actual) : '—', w ? fmt(m.actual - w.actual) : fmt(m.actual)];
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

module.exports = { runBacktest, printBacktest, loadFPA };

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
  const username = positional[0];
  const week = parseInt(flags.week, 10) || 1;
  if (!username || flags.help) {
    console.error('Usage: node scripts/backtest-lineup.js <sleeper-username> [leagueId] [--week=1] [--injuries]');
    process.exit(username ? 0 : 1);
  }
  if (week < 1 || week > 18) { console.error('week must be 1–18'); process.exit(1); }
  // Prior weeks' history records feed the FPA calibration (no-hindsight guard in loadFPA).
  let history = [];
  try { history = require('./log-week.js').loadHistory(); } catch (_) { /* optional */ }
  runBacktest({ username, leagueId: positional[1], week, useInjuries: !!flags.injuries, history })
    .then(printBacktest)
    .catch(err => { console.error('backtest failed:', err.message); process.exit(1); });
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
