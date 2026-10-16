// League-profile plumbing shared by the lineup, trade and waivers routes (L1).
// A Yahoo league_key "466.l.242808" → profile 242808; a league without a stored
// profile gets Yahoo's High Score defaults (the board is then the legacy one).
//
// Sleeper leagues (spec D1): the profile is built from the league's own Sleeper
// settings (nba/model/league-sync.js profileFromSleeper) by the Sleeper routes
// (routes/sleeper.js profileFor, cached 10 min) and remembered here, so the
// synchronous profileFor({ sleeperLeagueId }) returns it and modelPlayers(week,
// <sleeper league id>) builds the board under it:
//   await sleeper.profileFor(lid);                       // fetch + build + remember
//   const lc = LC.profileFor({ sleeperLeagueId: lid });  // { profile, profileId: lid, source: 'sleeper' }
'use strict';
const LP = require('../league-profile');
const R = require('../model/roster-slots');

const SLEEPER_PROFILE_TTL_MS = 10 * 60 * 1000;
const MAX_SLEEPER_PROFILES = 500;
const sleeperProfiles = new Map(); // sleeper league id → { profile, at }
const clone = o => JSON.parse(JSON.stringify(o));

// Remember a profileFromSleeper() result (bounded, least-recently-set eviction).
function rememberSleeperProfile(profile, now = Date.now()) {
  if (!profile || typeof profile !== 'object' || profile.source !== 'sleeper' || !profile.leagueId) return null;
  const id = String(profile.leagueId);
  sleeperProfiles.delete(id);
  sleeperProfiles.set(id, { profile, at: now });
  while (sleeperProfiles.size > MAX_SLEEPER_PROFILES) sleeperProfiles.delete(sleeperProfiles.keys().next().value);
  return profile;
}
// A fresh copy of a remembered Sleeper profile (null when unknown or older than maxAgeMs).
function sleeperProfile(id, { maxAgeMs = SLEEPER_PROFILE_TTL_MS, now = Date.now() } = {}) {
  const e = id != null ? sleeperProfiles.get(String(id)) : null;
  if (!e || now - e.at > maxAgeMs) return null;
  return clone(e.profile);
}

// Sleeper GET routes (lineup / waivers / trade): the league's own Sleeper
// profile unless `profileParam` (?profile=) names a stored one. When Sleeper
// can't be reached the stored default stands in (the route's own Sleeper call
// then reports the outage). Callers refuse lc.profile.aggregation === 'categories'.
async function sleeperRouteProfile({ sleeper, leagueId, profileParam } = {}) {
  if (profileParam != null && profileParam !== '') return profileFor({ leagueId: profileParam });
  if (!sleeper || typeof sleeper.profileFor !== 'function' || leagueId == null || leagueId === '') return profileFor({});
  try { await sleeper.profileFor(leagueId); } catch { return profileFor({}); }
  return profileFor({ sleeperLeagueId: leagueId });
}
const NOT_POINTS = { error: 'This is a category league; Pocket NBA values points leagues only.', code: 'league_not_points' };

function leagueIdFromKey(lk) {
  const m = /^\d+\.l\.(\d+)$/.exec(String(lk || ''));
  return m ? m[1] : null;
}

// { profile, profileId, source } — profileId is what /api/nba/players?profile= takes
// (null = legacy High Score board on Sleeper weeks). source: 'sleeper' | 'stored' | 'default'.
// sleeperLeagueId (or a leagueId that is a remembered Sleeper league) → the
// Sleeper-built profile; not built yet → the stored-profile behaviour below.
function profileFor({ leagueKey, leagueId, sleeperLeagueId } = {}) {
  for (const sid of [sleeperLeagueId, leagueId]) {
    if (sid == null || sid === '') continue;
    const sp = sleeperProfile(sid);
    if (sp) return { profile: sp, profileId: sp.leagueId, source: 'sleeper' };
  }
  const id = leagueId != null && leagueId !== '' ? String(leagueId) : leagueKey ? leagueIdFromKey(leagueKey) : LP.DEFAULT_LEAGUE_ID;
  if (id === 'hs' || id === 'default') return { profile: LP.highScoreDefaultProfile(), profileId: null, source: 'default' };
  const p = id ? LP.getProfile(id) : null;
  if (p) return { profile: p, profileId: p.leagueId, source: 'stored' };
  return { profile: LP.highScoreDefaultProfile(), profileId: null, source: 'default' };
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
    ...(p.source === 'sleeper' ? { source: 'sleeper', sleeperLeagueId: p.sleeperLeagueId || null, tradeDeadlineWeek: p.tradeDeadlineWeek ?? null, aggregation: p.aggregation || null } : {}),
  };
}

module.exports = {
  leagueIdFromKey, profileFor, todayEt, teamDates, windowFor, profileSummary,
  rememberSleeperProfile, sleeperProfile, sleeperRouteProfile, NOT_POINTS, SLEEPER_PROFILE_TTL_MS,
};
