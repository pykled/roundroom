// Shared layer (Stream A): league profile + league context from Sleeper payloads.
// Contract: docs/nba-trade-team-spec.md §3.1. Fixtures: docs/nba-spec/fixtures/.
//
//   profileFromSleeper({ league, draft?, state?, scheduleWeeks?, today? }) → Profile
//   leagueContext({ league, users, rosters, draft?, matchups?, board, profile, userId?, today? }) → LeagueContext
//   currentWeekFor(profile, today?) → matchup week containing today (ET); before week 1 → 1
//
// Both are pure (no I/O): the routes fetch the Sleeper payloads
// (nba/routes/sleeper.js profileFor / leagueContext) and hand them in.
'use strict';
const LP = require('../league-profile');
const M = require('../sleeper/map');

const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';

const MARKET_SNAPSHOT_ID = '242808'; // Yahoo snapshot + market.json are keyed by the old league id
const CATEGORY_RE = /cat|roto|rotisserie/i; // same rule as nba/sleeper/map.js classifyLeague
const SLOT_KEYS = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'FC', 'UTIL', 'BN', 'IL'];
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Sleeper roster_positions + reserve_slots → slot map. Unknown names → UTIL; IR/IL/IL+ → IL.
function slotsFromRosterPositions(positions, reserveSlots) {
  const slots = {};
  for (const k of SLOT_KEYS) slots[k] = 0;
  for (const raw of Array.isArray(positions) ? positions : []) {
    const p = String(raw || '').toUpperCase();
    if (!p) continue;
    if (p === 'IR' || p === 'IL' || p === 'IL+') slots.IL += 1;
    else if (p === 'BN') slots.BN += 1;
    else if (p === 'UT' || p === 'UTIL' || p === 'UTILITY') slots.UTIL += 1;
    else if (p in slots) slots[p] += 1;
    else slots.UTIL += 1;
  }
  if (num(reserveSlots) > 0) slots.IL = num(reserveSlots);
  // A High Score style frontcourt slot shows as F with no SF/PF/C: FC.
  if (slots.F && !slots.SF && !slots.PF && !slots.C) { slots.FC = slots.F; slots.F = 0; }
  return slots;
}

// Sleeper scoring_settings → profile scoring (tf → tech; ff kept; others as is).
function scoringFromSleeper(sc) {
  const s = sc && typeof sc === 'object' ? sc : {};
  return {
    pts: num(s.pts), reb: num(s.reb), ast: num(s.ast), stl: num(s.stl), blk: num(s.blk),
    to: num(s.to), pf: num(s.pf), tech: num(s.tf), ff: num(s.ff), dd: num(s.dd), td: num(s.td),
  };
}

// Number of playoff weeks from Sleeper settings (round_type 0: one week per
// round; 1: two-week final; 2: two weeks per round).
function playoffWeekCount(settings) {
  const teams = num(settings.playoff_teams, 0);
  if (!(teams > 1) || !(num(settings.playoff_week_start) > 1)) return 0;
  const rounds = Math.max(1, Math.ceil(Math.log(teams) / Math.LN2));
  const type = num(settings.playoff_round_type, 0);
  return type === 2 ? rounds * 2 : type === 1 ? rounds + 1 : rounds;
}

// First Sunday on/after a YYYY-MM-DD date (week 1 runs start → that Sunday).
function daysToSunday(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0 = Sunday
  return dow === 0 ? 0 : 7 - dow;
}

const MAX_WEEKS = 30;                  // hostile settings can't make a 1,000-week board
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const dayNum = s => Math.floor(Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') / DAY_MS);

// Season start (week 1's first day): Sleeper state's season_start_date when it
// is for this league's season, else the schedule's first game day, else Oct 20.
function seasonStart(league, state, scheduleWeeks, season) {
  const stSeason = state && String(state.league_season || state.season || '');
  const stStart = state && ISO_DAY.test(String(state.season_start_date || '')) ? String(state.season_start_date) : null;
  if (stStart && (!season || !stSeason || stSeason === season)) return stStart;
  const first = Array.isArray(scheduleWeeks) && scheduleWeeks[0] && ISO_DAY.test(String(scheduleWeeks[0].first || '')) ? String(scheduleWeeks[0].first) : null;
  return first || `${season || '2026'}-10-20`;
}

// Points vs categories from the signals map.js classifyLeague reads; either
// one saying categories wins (refusing beats valuing a category league).
function isCategories(league, draft) {
  const md = (draft && draft.metadata) || {};
  const ls = league.settings || {};
  return CATEGORY_RE.test(String(md.scoring_type || '')) || CATEGORY_RE.test(String(ls.scoring_type || ''))
    || !league.scoring_settings || typeof league.scoring_settings !== 'object';
}

// today is accepted for signature stability; the calendar doesn't depend on it
// (currentWeekFor(profile, today) does).
function profileFromSleeper({ league, draft = null, state = null, scheduleWeeks = null, today = null } = {}) { // eslint-disable-line no-unused-vars
  if (!league || typeof league !== 'object' || league.league_id == null) throw new Error('profileFromSleeper: league payload required');
  const st = league.settings || {};
  const slots = slotsFromRosterPositions(league.roster_positions, st.reserve_slots);
  const starters = SLOT_KEYS.filter(k => k !== 'BN' && k !== 'IL').reduce((a, k) => a + slots[k], 0);
  const rosterSize = starters + slots.BN + slots.IL;
  const playoffStart = num(st.playoff_week_start, 0) > 1 && num(st.playoff_week_start) <= MAX_WEEKS ? num(st.playoff_week_start) : null;
  const playoffWeeks = playoffStart ? playoffWeekCount(st) : 0;
  const season = String(league.season || (state && state.league_season) || (state && state.season) || '');
  const start = seasonStart(league, state, scheduleWeeks, season);
  const lastWeek = Math.min(MAX_WEEKS, playoffStart ? playoffStart + playoffWeeks - 1 : 25);
  const week1Days = daysToSunday(start) + 1;
  const weeks = LP.buildWeeks(start, [week1Days, ...Array.from({ length: Math.max(0, lastWeek - 1) }, () => 7)], playoffStart || undefined);
  const deadlineWeek = num(st.trade_deadline, 0);
  const tradeEnd = deadlineWeek > 0 && deadlineWeek < 99 && weeks[deadlineWeek - 1] ? weeks[deadlineWeek - 1].end : null;
  const ds = (draft && draft.settings) || {};
  const draftType = draft && draft.type ? String(draft.type).toLowerCase() : 'snake';
  const scoring = scoringFromSleeper(league.scoring_settings);
  const unverified = [];
  if (scoring.ff) unverified.push('ff (flagrant fouls) scores -1 on Sleeper but the compact game logs carry no ff column until Stream D (format 3); contributes 0 until then.');
  unverified.push('Sleeper matchup week numbering vs this Mon-Sun calendar is re-checked once week 1 has scores (2026-10-21).');
  // The Sleeper schedule (when given) must fall inside the Mon-Sun calendar.
  for (const sw of Array.isArray(scheduleWeeks) ? scheduleWeeks : []) {
    const pw = weeks[Number(sw.week) - 1];
    if (!pw || !ISO_DAY.test(String(sw.first || '')) || !ISO_DAY.test(String(sw.last || ''))) continue;
    if (dayNum(sw.first) < dayNum(pw.start) || dayNum(sw.last) > dayNum(pw.end)) unverified.push(`Sleeper schedule week ${sw.week} (${sw.first}..${sw.last}) falls outside profile week ${pw.week} (${pw.start}..${pw.end}).`);
  }
  return {
    leagueId: String(league.league_id),
    source: 'sleeper',
    sleeperLeagueId: String(league.league_id),
    marketSnapshotId: MARKET_SNAPSHOT_ID,
    name: league.name || `League ${league.league_id}`,
    season: season || null,
    teams: num(league.total_rosters) || num(st.num_teams) || 12,
    aggregation: isCategories(league, draft) ? 'categories' : 'high-score',
    positionSource: 'sleeper',
    scoring,
    flags: { tdAlsoCountsDD: true },
    slots,
    starters,
    rosterSize,
    weeks,
    regularSeasonWeeks: playoffStart ? playoffStart - 1 : lastWeek,
    playoffTeams: playoffStart ? num(st.playoff_teams) : 0,
    tradeEnd,
    tradeDeadlineWeek: deadlineWeek > 0 && deadlineWeek < 99 ? deadlineWeek : null,
    maxKeepers: num(st.max_keepers, 0),
    leagueType: [0, 1, 2].includes(num(st.type, 0)) ? num(st.type, 0) : 0,
    maxAddsPerWeek: null,
    maxAddsPerSeason: null,
    waivers: { type: num(st.waiver_type) === 2 ? 'faab' : 'rolling', days: num(st.waiver_clear_days, 2), daily: !!num(st.daily_waivers), budget: num(st.waiver_type) === 2 ? num(st.waiver_budget) : null },
    trades: { review: num(st.trade_review_days) > 0 ? 'league' : 'commissioner', protestDays: num(st.trade_review_days, 0), draftPickTrades: !!num(st.pick_trading), maxTrades: null },
    draft: { type: draftType, rounds: num(ds.rounds) || starters + slots.BN, pickSeconds: num(ds.pick_timer) || null, reversalRound: num(ds.reversal_round, 0) },
    unverified,
  };
}

// "Today" in US/Eastern (NBA game days run on ET dates).
function todayEt(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Matchup week containing `today` (YYYY-MM-DD, default today ET): before week 1
// → week 1, after the last week → the last week.
function currentWeekFor(profile, today = null) {
  const weeks = (profile && profile.weeks) || [];
  if (!weeks.length) return 1;
  const d = dayNum(today && ISO_DAY.test(String(today).slice(0, 10)) ? String(today).slice(0, 10) : todayEt());
  for (const w of weeks) if (d >= dayNum(w.start) && d <= dayNum(w.end)) return Number(w.week);
  return d < dayNum(weeks[0].start) ? Number(weeks[0].week) : Number(weeks[weeks.length - 1].week);
}

// Compact profile echoed in LeagueContext (fixture league-context.example.json).
function profileSummary(p) {
  if (!p) return null;
  const weeks = Array.isArray(p.weeks) ? p.weeks : [];
  return {
    leagueId: p.leagueId != null ? String(p.leagueId) : null, name: p.name || null, teams: p.teams ?? null, starters: p.starters ?? null,
    slots: p.slots || null, weeks: weeks.length, playoffStartWeek: (weeks.find(w => w.playoffs) || {}).week ?? null,
    tradeDeadlineWeek: p.tradeDeadlineWeek ?? null, aggregation: p.aggregation || null,
  };
}

const fpts = (whole, dec) => Math.round((num(whole) + num(dec) / 100) * 100) / 100;

// Pure normalisation of Sleeper league/users/rosters(/matchups) into the shape
// the trade calculator and team page share. Nothing is dropped: players not on
// the board stay in `players` (onBoard: false) and are listed in `unmatched`.
// board: board Player[] (or { players, asOf }). matchups: /matchups/{week} rows.
function leagueContext({ league, users = [], rosters = [], draft = null, matchups = null, board = [], profile = null, userId = null, today = null } = {}) {
  if (!league || typeof league !== 'object' || league.league_id == null) throw new Error('leagueContext: league payload required');
  const boardPlayers = Array.isArray(board) ? board : (board && Array.isArray(board.players) ? board.players : []);
  const onBoard = new Set(boardPlayers.map(p => String(p.id)));
  const teams = M.teamsFromLeague(users, rosters, draft).map(t => {
    const reserve = t.reserve.filter(id => id && id !== '0');
    const starters = t.starters.filter(id => id && id !== '0');
    const ids = [...new Set([...t.players, ...reserve].filter(id => id && id !== '0'))];
    const players = ids.map(id => ({ id, onBoard: onBoard.has(id), slot: reserve.includes(id) ? 'IL' : starters.includes(id) ? 'START' : 'BN' }));
    const s = t.settings || {};
    return {
      rosterId: t.team_key, name: t.name, ownerId: t.user_id, displayName: t.display_name, avatar: t.avatar, coOwners: t.co_owners,
      record: { wins: num(s.wins), losses: num(s.losses), ties: num(s.ties), fpts: fpts(s.fpts, s.fpts_decimal), fptsAgainst: fpts(s.fpts_against, s.fpts_against_decimal) },
      waiverPosition: s.waiver_position != null && Number.isFinite(Number(s.waiver_position)) ? Number(s.waiver_position) : null,
      totalMoves: num(s.total_moves),
      players, starters, reserve,
      unmatched: players.filter(p => !p.onBoard).map(p => ({ id: p.id, name: `Player ${p.id}` })),
    };
  });
  let opponentByRoster = null;
  if (Array.isArray(matchups)) {
    opponentByRoster = {};
    const byMatch = new Map();
    for (const m of matchups) {
      if (!m || m.roster_id == null || m.matchup_id == null) continue;
      if (!byMatch.has(m.matchup_id)) byMatch.set(m.matchup_id, []);
      byMatch.get(m.matchup_id).push(String(m.roster_id));
    }
    for (const ids of byMatch.values()) if (ids.length === 2) { opponentByRoster[ids[0]] = ids[1]; opponentByRoster[ids[1]] = ids[0]; }
  }
  return {
    leagueId: String(league.league_id), name: league.name || `League ${league.league_id}`, season: league.season != null ? String(league.season) : null,
    teams,
    myRosterId: M.myTeamKey(teams.map(t => ({ team_key: t.rosterId, user_id: t.ownerId, co_owners: t.coOwners })), userId),
    currentWeek: currentWeekFor(profile, today),
    opponentByRoster,
    profile: profileSummary(profile),
    asOf: (board && !Array.isArray(board) && board.asOf) || null,
  };
}

module.exports = {
  profileFromSleeper, leagueContext, currentWeekFor, todayEt, profileSummary,
  slotsFromRosterPositions, scoringFromSleeper, playoffWeekCount, MARKET_SNAPSHOT_ID, MAX_WEEKS, NOT_IMPLEMENTED,
};
