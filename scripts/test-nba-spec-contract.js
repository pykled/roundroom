#!/usr/bin/env node
/* Contract test for the NBA trade-v2 / team-page shared layer.
   Spec: docs/nba-trade-team-spec.md §3. Fixtures: docs/nba-spec/fixtures/.
   Offline (NBA_MODEL_OFFLINE=1), no framework. Run: node scripts/test-nba-spec-contract.js (exit 0 = pass).

   Two layers of checks:
   1. The fixtures themselves have the contract shape (so B and C can build against them).
   2. The live shared layer (Stream A): profileFromSleeper reproduces the pinned profile
      fixture, and leagueContext / signalsFor / analyzeRoster / injury-eta outputs pass the
      same shape validators. Nothing is skipped any more: a function that throws
      NOT_IMPLEMENTED (a stub coming back) fails. Behaviour tests: scripts/test-nba-shared.js. */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'docs', 'nba-spec', 'fixtures');
const LS = require(path.join(ROOT, 'nba', 'model', 'league-sync.js'));
const SIG = require(path.join(ROOT, 'nba', 'model', 'signals.js'));
const RA = require(path.join(ROOT, 'nba', 'model', 'roster-analysis.js'));
const ETA = require(path.join(ROOT, 'nba', 'model', 'injury-eta.js'));

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error((msg ? msg + ': ' : '') + 'expected ' + B + ', got ' + A); }
const fx = name => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v, msg) => ok(v === null || isNum(v), `${msg}: number or null, got ${JSON.stringify(v)}`);
const noNaN = (o, where = 'root') => {
  if (typeof o === 'number') { ok(Number.isFinite(o), `NaN/Infinity at ${where}`); return; }
  if (Array.isArray(o)) return o.forEach((x, i) => noNaN(x, `${where}[${i}]`));
  if (o && typeof o === 'object') for (const k of Object.keys(o)) noNaN(o[k], `${where}.${k}`);
};
// Stream A is in: a NOT_IMPLEMENTED stub is a failure, with a clear message.
function implemented(fn) {
  const stub = e => { if (e && e.code === 'NOT_IMPLEMENTED') throw new Error('shared layer stub is back: ' + e.message); throw e; };
  try { return Promise.resolve(fn()).catch(stub); } catch (e) { return stub(e); }
}

/* ------------------------------------------------------------ shape validators */
const SLOT_KEYS = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'FC', 'UTIL', 'BN', 'IL'];
function validateProfile(p) {
  ok(p && typeof p === 'object', 'profile object');
  ok(/^\d+$/.test(String(p.leagueId)), 'leagueId digits');
  eq(p.source, 'sleeper', 'source');
  ok(p.marketSnapshotId === '242808', 'marketSnapshotId');
  ok(['high-score', 'categories'].includes(p.aggregation), 'aggregation');
  for (const k of ['pts', 'reb', 'ast', 'stl', 'blk', 'to', 'pf', 'tech', 'ff', 'dd', 'td']) ok(isNum(p.scoring[k]), 'scoring.' + k);
  for (const k of SLOT_KEYS) ok(Number.isInteger(p.slots[k]) && p.slots[k] >= 0, 'slots.' + k);
  const starters = SLOT_KEYS.filter(k => k !== 'BN' && k !== 'IL').reduce((a, k) => a + p.slots[k], 0);
  eq(p.starters, starters, 'starters = Σ starting slots');
  eq(p.rosterSize, starters + p.slots.BN + p.slots.IL, 'rosterSize');
  ok(Array.isArray(p.weeks) && p.weeks.length >= 1, 'weeks');
  p.weeks.forEach((w, i) => {
    eq(w.week, i + 1, 'weeks are 1..N');
    ok(/^\d{4}-\d{2}-\d{2}$/.test(w.start) && /^\d{4}-\d{2}-\d{2}$/.test(w.end), 'week dates');
    ok(w.days >= 1 && w.days <= 7, 'Sleeper weeks are at most 7 days (no 14-day weeks)');
    if (i > 0) { const prev = new Date(p.weeks[i - 1].end + 'T00:00:00Z'); const cur = new Date(w.start + 'T00:00:00Z'); eq((cur - prev) / 86400000, 1, 'weeks are contiguous'); }
    ok(typeof w.playoffs === 'boolean' || w.playoffs === undefined, 'playoffs flag');
  });
  ok(p.tradeEnd === null || /^\d{4}-\d{2}-\d{2}$/.test(p.tradeEnd), 'tradeEnd');
  ok(p.tradeDeadlineWeek === null || Number.isInteger(p.tradeDeadlineWeek), 'tradeDeadlineWeek');
  ok(Number.isInteger(p.maxKeepers), 'maxKeepers');
  ok([0, 1, 2].includes(p.leagueType), 'leagueType');
  ok(p.waivers && ['rolling', 'faab'].includes(p.waivers.type), 'waivers.type');
  ok(p.trades && ['commissioner', 'league'].includes(p.trades.review), 'trades.review');
  ok(p.draft && typeof p.draft.type === 'string', 'draft.type');
}

function validateLeagueContext(c) {
  ok(/^\d+$/.test(String(c.leagueId)), 'leagueId');
  ok(Array.isArray(c.teams) && c.teams.length >= 2, 'teams');
  ok(c.myRosterId === null || typeof c.myRosterId === 'string', 'myRosterId string|null');
  ok(Number.isInteger(c.currentWeek) && c.currentWeek >= 1, 'currentWeek');
  const ids = new Set();
  for (const tm of c.teams) {
    ok(typeof tm.rosterId === 'string' && !ids.has(tm.rosterId), 'rosterId unique string'); ids.add(tm.rosterId);
    ok(typeof tm.name === 'string' && tm.name.length, 'team name');
    ok(tm.ownerId === null || typeof tm.ownerId === 'string', 'ownerId');
    for (const k of ['wins', 'losses', 'ties', 'fpts', 'fptsAgainst']) ok(isNum(tm.record[k]), 'record.' + k);
    ok(Array.isArray(tm.players) && tm.players.length, 'players');
    for (const p of tm.players) { ok(typeof p.id === 'string', 'player id'); ok(typeof p.onBoard === 'boolean', 'onBoard'); ok(['START', 'BN', 'IL'].includes(p.slot), 'slot'); }
    ok(Array.isArray(tm.starters) && Array.isArray(tm.reserve) && Array.isArray(tm.unmatched), 'starters/reserve/unmatched arrays');
    eq(tm.unmatched.length, tm.players.filter(p => !p.onBoard).length, 'unmatched = players off the board');
  }
  if (c.myRosterId !== null) ok(ids.has(c.myRosterId), 'myRosterId is a team');
}

function validateSignals(s) {
  ok(typeof s.id === 'string' && typeof s.name === 'string', 'id/name');
  ok(Array.isArray(s.pos) && Array.isArray(s.elig), 'pos/elig arrays');
  ok(['logs', 'projection-only', 'rookie', 'yahoo-only'].includes(s.source), 'source');
  ok(Number.isInteger(s.sampleGames), 'sampleGames');
  ok(s.statSeason === null || Number.isInteger(s.statSeason), 'statSeason');
  for (const k of ['ros', 'now', 'next', 'mean', 'sd', 'ceiling', 'floor', 'cv', 'ceilingShare', 'vorp', 'vorpRank', 'rank', 'tier', 'blended']) numOrNull(s.value[k], 'value.' + k);
  ok(isNum(s.value.ros) && isNum(s.value.blended), 'ros/blended are numbers');
  if (s.form) { for (const k of ['last5', 'seasonMean', 'ratio', 'delta', 'games']) numOrNull(s.form[k], 'form.' + k); ok([null, 'hot', 'cold'].includes(s.form.label), 'form.label'); ok(typeof s.form.stale === 'boolean', 'form.stale'); }
  for (const k of ['mpg', 'last5', 'delta', 'projected', 'roleShift']) numOrNull(s.minutes[k], 'minutes.' + k);
  ok([null, 'up', 'down', 'flat'].includes(s.minutes.trend), 'minutes.trend');
  for (const k of ['fga', 'fta', 'usageRate']) numOrNull(s.usage[k], 'usage.' + k);
  numOrNull(s.availability.a0, 'availability.a0');
  ok(typeof s.availability.outForSeason === 'boolean', 'outForSeason');
  ok(s.availability.byWeek && typeof s.availability.byWeek === 'object', 'availability.byWeek');
  for (const [w, a] of Object.entries(s.availability.byWeek)) { ok(/^\d+$/.test(w), 'byWeek key'); ok(isNum(a) && a >= 0 && a <= 1, 'availability in [0,1]'); }
  numOrNull(s.availability.expectedGamesMissed, 'expectedGamesMissed');
  if (s.availability.eta) { const e = s.availability.eta; ok(['OUT', 'GTD', 'OFS'].includes(e.status), 'eta.status'); ok(/^\d{4}-\d{2}-\d{2}$/.test(e.returnDate), 'eta.returnDate'); ok(e.returnWeek === null || Number.isInteger(e.returnWeek), 'eta.returnWeek'); ok(typeof e.stale === 'boolean', 'eta.stale'); }
  ok(s.schedule && typeof s.schedule.gamesByWeek === 'object', 'schedule.gamesByWeek');
  for (const k of ['gamesRemaining', 'gamesThisWeek', 'heavyWeeks', 'lightWeeks', 'playoffGames', 'b2bNext2']) numOrNull(s.schedule[k], 'schedule.' + k);
  for (const k of ['rank', 'adpDelta', 'confidence', 'yahooPreRank', 'pctRos', 'impliedValue', 'weight']) numOrNull(s.market[k], 'market.' + k);
  ok(isNum(s.market.weight) && s.market.weight >= 0 && s.market.weight <= 0.3, 'market.weight in [0, 0.3]');
  if (s.market.rank === null) ok(Math.abs(s.value.blended - s.value.ros) < 1e-9, 'no market → blended = ros');
  for (const k of ['age', 'exp']) numOrNull(s.bio[k], 'bio.' + k);
  ok(isNum(s.uncertainty) && s.uncertainty >= 0.1 && s.uncertainty <= 0.35, 'uncertainty in [0.1, 0.35]');
  ok(Array.isArray(s.flags) && s.flags.every(f => typeof f === 'string'), 'flags');
  noNaN(s, 'signals');
}

function validateRosterAnalysis(r) {
  ok(r.lineup && isNum(r.lineup.total), 'lineup.total');
  ok(Array.isArray(r.lineup.starters) && Array.isArray(r.lineup.bench), 'lineup arrays');
  for (const s of r.lineup.starters) { ok(typeof s.id === 'string' && typeof s.slot === 'string' && isNum(s.value), 'starter row'); }
  for (const b of r.lineup.bench) { ok(typeof b.id === 'string' && isNum(b.value) && isNum(b.share), 'bench row'); }
  ok(Number.isInteger(r.lineup.holes) && r.lineup.holes >= 0, 'holes');
  ok(isNum(r.strengthRos), 'strengthRos'); numOrNull(r.strengthNow, 'strengthNow'); ok(isNum(r.benchValue), 'benchValue');
  for (const g of RA.GROUPS) {
    const G = r.groups[g]; ok(G, 'group ' + g);
    ok(Number.isInteger(G.slots) && Number.isInteger(G.rostered), g + ' slots/rostered');
    ok(isNum(G.starterValue), g + ' starterValue'); numOrNull(G.nextUp, g + ' nextUp'); numOrNull(G.leagueAvg, g + ' leagueAvg'); numOrNull(G.rank, g + ' rank');
    ok(RA.TIERS.includes(G.tier), g + ' tier'); eq(G.status, RA.tierStatus(G.tier), g + ' status = tierStatus(tier)');
  }
  for (const g of RA.DISPLAY_GROUPS) ok(r.groups[g] && isNum(r.groups[g].starterValue), 'display group ' + g);
  eq(r.needs, RA.GROUPS.filter(g => r.groups[g].status === 'need'), 'needs derive from tiers');
  eq(r.surplus, RA.GROUPS.filter(g => r.groups[g].status === 'surplus'), 'surplus derive from tiers');
  ok(Array.isArray(r.elite) && Array.isArray(r.liabilities) && Array.isArray(r.injured), 'elite/liabilities/injured');
  ok(r.injuryExposure && 'thisWeek' in r.injuryExposure && 'next2' in r.injuryExposure, 'injuryExposure');
  numOrNull(r.gamesThisWeek, 'gamesThisWeek');
  noNaN(r, 'rosterAnalysis');
}

/* ------------------------------------------------------------ 1. fixtures */
t('fixture: sleeper-league.json is Dillon\'s league with 10 starters', () => {
  const lg = fx('sleeper-league.json');
  eq(lg.league_id, '1411447094215991296');
  eq(lg.roster_positions.filter(p => p === 'UTIL').length, 3, '3 UTIL');
  eq(lg.roster_positions.filter(p => p === 'BN').length, 4, '4 BN');
  eq(lg.settings.reserve_slots, 2); eq(lg.settings.playoff_week_start, 21); eq(lg.settings.trade_deadline, 17);
  eq(lg.scoring_settings.ff, -1, 'flagrant fouls score');
});
t('fixture: profile-from-sleeper.expected.json has the contract shape and the verified calendar', () => {
  const p = fx('profile-from-sleeper.expected.json');
  validateProfile(p);
  eq(p.starters, 10); eq(p.slots.UTIL, 3); eq(p.slots.BN, 4); eq(p.slots.IL, 2); eq(p.rosterSize, 16);
  eq(p.weeks.length, 23); eq(p.weeks[0].start, '2026-10-20'); eq(p.weeks[0].end, '2026-10-25'); eq(p.weeks[0].days, 6);
  eq(p.weeks.filter(w => w.playoffs).map(w => w.week), [21, 22, 23]);
  eq(p.tradeDeadlineWeek, 17); eq(p.tradeEnd, '2027-02-14'); eq(p.aggregation, 'high-score'); eq(p.maxKeepers, 1);
  eq(p.scoring, { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, pf: -1, tech: -1, ff: -1, dd: 5, td: 3 });
});
t('fixture: Sleeper schedule weeks agree with the Mon-Sun calendar', () => {
  const p = fx('profile-from-sleeper.expected.json');
  const sched = fx('sleeper-schedule-weeks-2026.json').weeks;
  for (const w of sched) {
    const pw = p.weeks[w.week - 1];
    if (!pw) continue; // weeks 24-25 are after the fantasy season
    ok(w.first >= pw.start && w.last <= pw.end, `schedule week ${w.week} (${w.first}..${w.last}) inside profile week (${pw.start}..${pw.end})`);
  }
});
t('fixture: matchups prove High Score aggregation (points == best game, never the sum)', () => {
  const m = fx('sleeper-matchups-2025-wk10.json');
  ok(/max single-game/.test(m.note), 'note records the proof');
  for (const mu of m.matchups) {
    const sum = mu.starters_points.reduce((a, b) => a + b, 0);
    ok(Math.abs(sum - mu.points) < 0.05, 'matchup points = Σ starters_points');
    for (const id of mu.players) if (!mu.starters.includes(id)) ok(mu.players_points[id] === 0 || mu.players_points[id] < 60, 'bench players score 0 (or a partial banked game)');
  }
});
t('fixture: league-context.example.json', () => { const c = fx('league-context.example.json'); validateLeagueContext(c); eq(c.teams.length, 12); eq(c.myRosterId, '1'); });
t('fixture: signals.example.json (healthy star + OUT player with ESPN ETA)', () => {
  const s = fx('signals.example.json');
  eq(s.players.length, 2);
  s.players.forEach(validateSignals);
  const [jok, butler] = s.players;
  eq(jok.name, 'Nikola Jokić'); ok(jok.value.ros > 60, 'Jokić ROS > 60'); ok(jok.form && jok.form.stale === true, 'preseason form is stale');
  ok(/Butler/.test(butler.name)); ok(butler.availability.eta && butler.availability.eta.status === 'OUT', 'Butler OUT with ETA');
  ok(butler.availability.eta.returnWeek >= 10, 'ETA week from ESPN return date');
  ok(butler.flags.some(f => /^out-until-wk\d+$/.test(f)), 'out-until flag');
});
t('fixture: roster-analysis.example.json', () => { const r = fx('roster-analysis.example.json'); validateRosterAnalysis(r); eq(r.lineup.starters.length, 10, '10 starters under the Sleeper profile'); });
t('fixture: trade-evaluate-v2.example.json is a superset of v1', () => {
  const v = fx('trade-evaluate-v2.example.json');
  eq(v.version, 2);
  for (const k of ['verdict', 'headline', 'you', 'them', 'weeks', 'lineup', 'players', 'roster', 'why', 'replacement', 'meta']) ok(k in v, 'v1 field ' + k);
  for (const k of ['options', 'value', 'fit', 'themFit', 'summary', 'dataAsOf']) ok(k in v, 'v2 field ' + k);
  eq(v.meta.weeks, 23, '23 weeks under the Sleeper profile');
  eq(v.meta.settings.slotList, ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'UTIL', 'UTIL']);
  for (const p of v.players) for (const k of ['signals', 'slotBefore', 'slotAfter', 'fit', 'why']) ok(k in p, 'player v2 field ' + k);
});
t('fixture: espn-injuries-sample.json rows carry returnDate', () => {
  const e = fx('espn-injuries-sample.json');
  ok(e.rows.length >= 20 && e.withReturnDate === e.count, 'every row has a returnDate');
  for (const r of e.rows) { ok(/^\d{4}-\d{2}-\d{2}$/.test(r.returnDate), 'returnDate'); ok(['Day-To-Day', 'Out'].includes(r.status), 'status'); }
});

/* ------------------------------------------------------------ 2. live shared layer */
t('profileFromSleeper (real) reproduces the pinned fixture exactly', () => {
  const p = LS.profileFromSleeper({ league: fx('sleeper-league.json'), state: fx('sleeper-state.json') });
  validateProfile(p);
  eq(p, fx('profile-from-sleeper.expected.json'), 'profile == fixture (regenerate the fixture on purpose, never by accident)');
});
t('profileFromSleeper: edge cases (IR in roster_positions, no playoffs, deadline 99, categories, round types)', () => {
  const base = fx('sleeper-league.json');
  const mk = over => ({ ...base, settings: { ...base.settings, ...(over.settings || {}) }, ...(over.rest || {}) });
  let p = LS.profileFromSleeper({ league: mk({ rest: { roster_positions: ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UT', 'BN', 'IR'] }, settings: { reserve_slots: 0 } }) });
  eq(p.slots.IL, 1, 'IR in roster_positions counts as IL when reserve_slots is 0'); eq(p.slots.UTIL, 1, 'UT → UTIL');
  p = LS.profileFromSleeper({ league: mk({ settings: { playoff_week_start: 0, trade_deadline: 99 } }) });
  eq(p.weeks.length, 25, 'no playoffs → 25 Sleeper weeks'); eq(p.playoffTeams, 0); eq(p.tradeEnd, null); eq(p.tradeDeadlineWeek, null);
  p = LS.profileFromSleeper({ league: mk({ settings: { playoff_round_type: 1 } }) });
  eq(p.weeks.length, 24, 'two-week final → 4 playoff weeks'); eq(p.weeks.filter(w => w.playoffs).length, 4);
  p = LS.profileFromSleeper({ league: mk({ settings: { playoff_round_type: 2 } }) });
  eq(p.weeks.length, 26, 'two weeks per round → 6 playoff weeks');
  p = LS.profileFromSleeper({ league: mk({ settings: { waiver_type: 2, waiver_budget: 200, trade_review_days: 1, pick_trading: 1 } }) });
  eq(p.waivers.type, 'faab'); eq(p.waivers.budget, 200); eq(p.trades.review, 'league'); eq(p.trades.protestDays, 1); eq(p.trades.draftPickTrades, true);
  p = LS.profileFromSleeper({ league: mk({}), draft: { type: 'snake', metadata: { scoring_type: 'categories' }, settings: { rounds: 13, pick_timer: 30, reversal_round: 3 } } });
  eq(p.aggregation, 'categories', 'category leagues are classified, never valued'); eq(p.draft.rounds, 13); eq(p.draft.reversalRound, 3);
  let threw = false; try { LS.profileFromSleeper({ league: null }); } catch (e) { threw = true; } ok(threw, 'null league throws');
});
t('profileFromSleeper builds the 2025 league (10 teams, 23 weeks) the backtest uses', () => {
  const base = fx('sleeper-league.json');
  const p = LS.profileFromSleeper({ league: { ...base, league_id: '1270568574406107137', season: '2025', total_rosters: 10 }, state: { season_start_date: '2025-10-21', league_season: '2025' } });
  eq(p.teams, 10); eq(p.weeks.length, 23); eq(p.weeks[0].start, '2025-10-21'); eq(p.weeks[0].end, '2025-10-26'); eq(p.weeks[0].days, 6);
});
t('the model accepts the Sleeper profile object (board + trade evaluator run unchanged)', () => {
  const m = require(path.join(ROOT, 'nba', 'model'));
  const T = require(path.join(ROOT, 'nba', 'model', 'trade.js'));
  const prof = fx('profile-from-sleeper.expected.json');
  return m.getPlayers({ profile: prof }).then(d => {
    ok(d.players.length > 500, 'board builds');
    eq(Object.keys(d.players[0].hsByWeek).length, 23, '23 weeks of hsByWeek');
    eq(d.profile.starters, 10);
    for (const p of d.players.slice(0, 50)) for (const w of Object.keys(p.hsByWeek)) ok(isNum(p.hsByWeek[w]) && p.hsByWeek[w] >= 0, 'finite non-negative week values');
    const rosters = fx('sleeper-rosters.json');
    const me = rosters[0], them = rosters[1];
    const out = T.evaluateTrade({ players: d.players, currentWeek: d.currentWeek, myRoster: me.players, partnerRoster: them.players, give: [me.players[0]], get: [them.players[0]], leagueRostered: rosters.flatMap(r => r.players), profile: prof });
    ok(['Accept', 'Counter', 'Decline'].includes(out.verdict), 'verdict');
    eq(out.meta.weeks, 23); eq(out.meta.settings.slotList.length, 10); eq(out.meta.rules.tradeEnd, '2027-02-14');
    noNaN(out, 'trade');
  });
});
t('signals.marketWeight decays 0.30 → 0 over weeks 1..11', () => {
  eq(SIG.marketWeight(1), 0.3); ok(Math.abs(SIG.marketWeight(6) - 0.15) < 1e-9, 'week 6 = 0.15'); eq(SIG.marketWeight(11), 0); eq(SIG.marketWeight(20), 0);
});
t('roster-analysis tier matrix matches the NFL one', () => {
  eq(RA.assessTier(2, 3, 10, 20, 30), 'critical'); eq(RA.assessTier(2, 3, 25, 20, 30), 'thin');
  eq(RA.assessTier(6, 3, 10, 20, 30), 'upgrade'); eq(RA.assessTier(6, 3, 25, 20, 30), 'deep'); eq(RA.assessTier(6, 3, 35, 20, 30), 'loaded');
  eq(RA.assessTier(4, 3, 10, 20, 30), 'upgrade'); eq(RA.assessTier(4, 3, 25, 20, 30), 'solid');
  eq(RA.assessTier(4, 3, 25, null, null), 'solid', 'no league context → never weak/strong'); eq(RA.assessTier(2, 3, 25, null, null), 'thin');
  eq(RA.assessTier(5, 0, 0, 0, 0), 'solid', 'no slot → solid');
  eq(RA.tierStatus('critical'), 'need'); eq(RA.tierStatus('loaded'), 'surplus'); eq(RA.tierStatus('solid'), 'neutral');
});
t('[A] leagueContext (live) has the contract shape', () => implemented(() => {
  const m = require(path.join(ROOT, 'nba', 'model'));
  const prof = fx('profile-from-sleeper.expected.json');
  return m.getPlayers({ profile: prof }).then(d => {
    const c = LS.leagueContext({ league: fx('sleeper-league.json'), users: fx('sleeper-users.json'), rosters: fx('sleeper-rosters.json'), board: d.players, profile: prof, userId: '1044077615075872768' });
    validateLeagueContext(c); eq(c.teams.length, 12); eq(c.myRosterId, '1');
  });
}));
t('[A] signalsFor (live) has the contract shape for every board player', () => implemented(() => {
  const m = require(path.join(ROOT, 'nba', 'model'));
  const Data = require(path.join(ROOT, 'nba', 'model', 'data.js'));
  const prof = fx('profile-from-sleeper.expected.json');
  return m.getPlayers({ profile: prof }).then(d => {
    const data = Data.load();
    const weeks = prof.weeks.filter(w => w.week >= d.currentWeek).map(w => ({ week: w.week, weight: w.playoffs ? 1.5 : 1, playoff: !!w.playoffs }));
    const map = SIG.signalsFor(d.players, { profile: prof, currentWeek: d.currentWeek, weeks, logs: data.logs, proj: data.proj, market: null, eta: null, bio: null, replacement: null, today: '2026-10-15' });
    ok(map instanceof Map && map.size === d.players.length, 'one Signals per player');
    for (const s of map.values()) validateSignals(s);
    const jok = map.get('1658'); ok(jok && jok.value.ros > 60, 'Jokić');
  });
}));
t('[A] analyzeRoster (live) has the contract shape', () => implemented(() => {
  const m = require(path.join(ROOT, 'nba', 'model'));
  const T = require(path.join(ROOT, 'nba', 'model', 'trade.js'));
  const prof = fx('profile-from-sleeper.expected.json');
  return m.getPlayers({ profile: prof }).then(d => {
    const byId = new Map(d.players.map(p => [String(p.id), p]));
    const rosters = fx('sleeper-rosters.json');
    const weeks = prof.weeks.filter(w => w.week >= d.currentWeek).map(w => ({ week: w.week, weight: w.playoffs ? 1.5 : 1, playoff: !!w.playoffs }));
    const repl = T.replacementLevel(d.players, weeks, T.normSettings({}, prof), new Set(rosters.flatMap(r => r.players.map(String))));
    const r = RA.analyzeRoster({ players: rosters[0].players.map(id => byId.get(String(id))).filter(Boolean), profile: prof, weeks, replacement: repl });
    validateRosterAnalysis(r); eq(r.lineup.starters.length, 10);
  });
}));
t('[A] injury-eta: matchEta / applyEtaToAvailability (live) follow the §4.3 rule', () => implemented(() => {
  const doc = { source: ETA.URL, fetchedAt: '2026-10-15T00:00:00Z', rows: fx('espn-injuries-sample.json').rows.map(r => ({ ...r, norm: null })) };
  const prof = fx('profile-from-sleeper.expected.json');
  const butler = { id: 'x', name: 'Jimmy Butler', team: 'GSW', injury: 'Out' };
  const m = ETA.matchEta(doc, butler, { logs: null });
  ok(m && m.status === 'OUT' && m.returnDate === '2027-01-02', 'Butler matched (ESPN "Jimmy Butler III" → Sleeper "Jimmy Butler")');
  const wk = n => ({ ...prof.weeks[n - 1], startDay: 0, endDay: 0 });
  eq(ETA.applyEtaToAvailability(0.8, 'Out', m, wk(5), wk(1)), 0, 'OUT before the return date → 0');
  ok(ETA.applyEtaToAvailability(0.8, 'Out', m, wk(14), wk(1)) >= 0.8 - 1e-9, 'well after return → a0');
}));

/* ------------------------------------------------------------ runner */
(async () => {
  for (const [name, fn] of queue) {
    try {
      await fn();
      pass++; console.log('  ✓ ' + name);
    } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
