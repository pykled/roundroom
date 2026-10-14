// League-profile plumbing shared by the lineup, trade and waivers routes (L1).
// A Yahoo league_key "466.l.242808" → profile 242808; a league without a stored
// profile gets Yahoo's High Score defaults (the board is then the legacy one).
'use strict';
const LP = require('../league-profile');
const R = require('../model/roster-slots');

function leagueIdFromKey(lk) {
  const m = /^\d+\.l\.(\d+)$/.exec(String(lk || ''));
  return m ? m[1] : null;
}

// { profile, profileId } — profileId is what /api/nba/players?profile= takes
// (null = legacy High Score board on Sleeper weeks).
function profileFor({ leagueKey, leagueId } = {}) {
  const id = leagueId != null && leagueId !== '' ? String(leagueId) : leagueKey ? leagueIdFromKey(leagueKey) : LP.DEFAULT_LEAGUE_ID;
  if (id === 'hs' || id === 'default') return { profile: LP.highScoreDefaultProfile(), profileId: null };
  const p = id ? LP.getProfile(id) : null;
  if (p) return { profile: p, profileId: p.leagueId };
  return { profile: LP.highScoreDefaultProfile(), profileId: null };
}

// "Today" in US/Eastern — NBA game days (and Yahoo's daily lineup) run on ET dates.
function todayEt(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Each team's game days (epoch days), with the NBA Cup TBD games imputed the
// same way the model counts them (so games-left agrees with gamesByWeek).
let tdCache = null;
function teamDates(loadData) {
  try {
    const data = loadData ? loadData() : require('../model/data').load();
    const raw = data && data.proj && data.proj.teamDates;
    if (!raw) return null;
    if (tdCache && tdCache.raw === raw) return tdCache.value;
    const value = require('../model/board').imputeUnscheduled(raw).teamDates;
    tdCache = { raw, value };
    return value;
  } catch { return null; }
}

// Matchup-week window: the profile's own weeks when the league has a profile;
// legacy boards fall back to the Sleeper week dates ({week: [start, end]}).
function windowFor(profile, profileId, week, legacyDates) {
  if (profileId) return R.weekWindow(profile, week);
  const r = (legacyDates || {})[week];
  if (!r || !r[0] || !r[1]) return null;
  const startDay = R.dayNum(r[0]), endDay = R.dayNum(r[1]);
  return { week: Number(week), start: r[0], end: r[1], days: endDay - startDay + 1, startDay, endDay };
}

// Compact profile summary for API responses / page headers.
function profileSummary(p, profileId) {
  return {
    leagueId: profileId || null, name: p.name, teams: p.teams, scoring: p.scoring,
    slots: p.slots, starters: R.starterCount(p), slotList: R.slotList(p), activeSpots: R.activeSpots(p), il: R.ilSlots(p),
    maxAddsPerWeek: p.maxAddsPerWeek ?? null, tradeEnd: p.tradeEnd ?? null,
    trades: p.trades || null, waivers: p.waivers || null,
    playoffStartWeek: ((p.weeks || []).find(w => w.playoffs) || {}).week ?? null,
    weeks: (p.weeks || []).length, longWeeks: (p.weeks || []).filter(w => w.days > 7).map(w => w.week),
  };
}

module.exports = { leagueIdFromKey, profileFor, todayEt, teamDates, windowFor, profileSummary };
