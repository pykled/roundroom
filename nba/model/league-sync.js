// Shared layer (Stream A): league profile + league context from Sleeper payloads.
// Contract: docs/nba-trade-team-spec.md §3.1. Fixtures: docs/nba-spec/fixtures/.
//
//   profileFromSleeper({ league, draft?, state?, scheduleWeeks?, today? }) → Profile
//   leagueContext({ league, users, rosters, draft?, matchups?, board, profile, userId? }) → LeagueContext
//
// profileFromSleeper is implemented here (pure, no I/O) because Streams B and C
// need the right calendar/slots from day one; Stream A hardens it and owns it.
// leagueContext is a stub until Stream A lands (throws NOT_IMPLEMENTED).
'use strict';
const LP = require('../league-profile');

const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';
function notImplemented(name) {
  const e = new Error(`nba shared layer: ${name} not implemented yet (Stream A)`);
  e.code = NOT_IMPLEMENTED;
  throw e;
}

const MARKET_SNAPSHOT_ID = '242808'; // Yahoo snapshot + market.json are keyed by the old league id
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

function profileFromSleeper({ league, draft = null, state = null, scheduleWeeks = null, today = null } = {}) {
  if (!league || typeof league !== 'object' || league.league_id == null) throw new Error('profileFromSleeper: league payload required');
  const st = league.settings || {};
  const slots = slotsFromRosterPositions(league.roster_positions, st.reserve_slots);
  const starters = SLOT_KEYS.filter(k => k !== 'BN' && k !== 'IL').reduce((a, k) => a + slots[k], 0);
  const rosterSize = starters + slots.BN + slots.IL;
  const playoffStart = num(st.playoff_week_start, 0) > 1 ? num(st.playoff_week_start) : null;
  const playoffWeeks = playoffStart ? playoffWeekCount(st) : 0;
  // Season start: Sleeper state (season_start_date), else the schedule's first week, else Oct 20 of the league season.
  const season = String(league.season || (state && state.league_season) || (state && state.season) || '');
  const start = (state && state.season_start_date) || (Array.isArray(scheduleWeeks) && scheduleWeeks[0] && scheduleWeeks[0].first) || `${season || '2026'}-10-20`;
  const lastWeek = playoffStart ? playoffStart + playoffWeeks - 1 : 25;
  const week1Days = daysToSunday(start) + 1;
  const weeks = LP.buildWeeks(start, [week1Days, ...Array.from({ length: Math.max(0, lastWeek - 1) }, () => 7)], playoffStart || undefined);
  const deadlineWeek = num(st.trade_deadline, 0);
  const tradeEnd = deadlineWeek > 0 && deadlineWeek < 99 && weeks[deadlineWeek - 1] ? weeks[deadlineWeek - 1].end : null;
  const ds = (draft && draft.settings) || {};
  const draftType = draft && draft.type ? String(draft.type).toLowerCase() : 'snake';
  const scoringType = draft && draft.metadata && draft.metadata.scoring_type != null ? String(draft.metadata.scoring_type) : null;
  const categories = /cat|roto/i.test(scoringType || '') || !league.scoring_settings;
  return {
    leagueId: String(league.league_id),
    source: 'sleeper',
    sleeperLeagueId: String(league.league_id),
    marketSnapshotId: MARKET_SNAPSHOT_ID,
    name: league.name || `League ${league.league_id}`,
    season: season || null,
    teams: num(league.total_rosters) || num(st.num_teams) || 12,
    aggregation: categories ? 'categories' : 'high-score',
    positionSource: 'sleeper',
    scoring: scoringFromSleeper(league.scoring_settings),
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
    leagueType: num(st.type, 0),
    maxAddsPerWeek: null,
    maxAddsPerSeason: null,
    waivers: { type: num(st.waiver_type) === 2 ? 'faab' : 'rolling', days: num(st.waiver_clear_days, 2), daily: !!num(st.daily_waivers), budget: num(st.waiver_type) === 2 ? num(st.waiver_budget) : null },
    trades: { review: num(st.trade_review_days) > 0 ? 'league' : 'commissioner', protestDays: num(st.trade_review_days, 0), draftPickTrades: !!num(st.pick_trading), maxTrades: null },
    draft: { type: draftType, rounds: num(ds.rounds) || starters + slots.BN, pickSeconds: num(ds.pick_timer) || null, reversalRound: num(ds.reversal_round, 0) },
    unverified: [
      'ff (flagrant fouls) scores -1 on Sleeper but the compact game logs carry no ff column until Stream D (format 3); contributes 0 until then.',
      'Sleeper matchup week numbering vs this Mon-Sun calendar is re-checked once week 1 has scores (2026-10-21).',
    ],
  };
}

function leagueContext() { notImplemented('leagueContext'); }

module.exports = { profileFromSleeper, leagueContext, slotsFromRosterPositions, scoringFromSleeper, playoffWeekCount, MARKET_SNAPSHOT_ID, NOT_IMPLEMENTED };
