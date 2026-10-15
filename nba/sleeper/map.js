// Pure mapping from Sleeper NBA payloads to the board's contract shapes. No I/O,
// so scripts/test-nba-sleeper.js exercises every branch with recorded payloads
// (docs/nba-sleeper.md has the shapes, captured 2026-10-15 from league
// 1411447094215991296 / draft 1411447094215991297).
//
// Vocabulary kept from the Yahoo-era board so nba/pages/draft.js changes stay
// small: a "team_key" is the Sleeper roster_id as a string ('1'..'12'); a
// "player_key" is the Sleeper player_id (the model's own id).
'use strict';

// Sleeper draft.status → board status. 'paused' keeps drafting (clock just stops).
const DRAFT_STATUS = { pre_draft: 'predraft', drafting: 'drafting', paused: 'drafting', complete: 'postdraft' };
function draftStatus(draft) {
  const s = draft && String(draft.status || '').toLowerCase();
  return DRAFT_STATUS[s] || 'predraft';
}

// Which slot picks in `round`: standard snake flips every round; with a
// reversal round n, round n repeats round n-1's direction, then alternates
// again (Sleeper's "3rd round reversal" is n = 3). Shared with draft-logic.js.
function roundForward(round, reversalRound) {
  const n = Number(reversalRound) || 0;
  if (n < 2 || round < n) return round % 2 === 1;
  const forwardBefore = (n - 1) % 2 === 1;
  return ((round - n) % 2 === 0) === forwardBefore;
}
function slotForPick(pick, teams, reversalRound, type) {
  const idx = (pick - 1) % teams;
  if (type === 'linear') return idx + 1;
  const round = Math.ceil(pick / teams);
  return roundForward(round, reversalRound) ? idx + 1 : teams - idx;
}

// Full pick list in Sleeper's own order: [{ pick, round, slot, team_key }].
// team_key comes from slot_to_roster_id (set once the draft order exists);
// traded picks (original roster_id → owner_id for a round) move ownership.
// Empty when the order isn't set yet (caller falls back to the snake + slot picker).
function pickOrder(draft, tradedPicks) {
  if (!draft || !draft.settings) return [];
  const teams = Number(draft.settings.teams) || 0;
  const rounds = Number(draft.settings.rounds) || 0;
  const s2r = draft.slot_to_roster_id;
  if (!teams || !rounds || !s2r || typeof s2r !== 'object' || !Object.keys(s2r).length) return [];
  const rr = Number(draft.settings.reversal_round) || 0;
  const type = String(draft.type || 'snake').toLowerCase();
  const traded = new Map(); // `${round}|${roster_id}` → owner_id
  for (const t of Array.isArray(tradedPicks) ? tradedPicks : []) {
    if (!t || t.round == null || t.roster_id == null || t.owner_id == null) continue;
    if (t.season != null && draft.season != null && String(t.season) !== String(draft.season)) continue;
    traded.set(`${t.round}|${t.roster_id}`, t.owner_id);
  }
  const out = [];
  for (let p = 1; p <= teams * rounds; p++) {
    const round = Math.ceil(p / teams);
    const slot = slotForPick(p, teams, rr, type);
    const orig = s2r[String(slot)];
    if (orig == null) return [];
    const owner = traded.has(`${round}|${orig}`) ? traded.get(`${round}|${orig}`) : orig;
    out.push({ pick: p, round, slot, team_key: String(owner), original_team_key: String(orig) });
  }
  return out;
}

// /draft/{id}/picks rows → board picks. `resolve(player_id, metadata)` maps a
// Sleeper player to the board id (null when the model doesn't carry him); the
// unmatched list keeps the pick (with its name) so nothing is silently dropped.
function normalizePicks(rawPicks, resolve) {
  const picks = [];
  const unmatched = [];
  const seen = new Set();
  for (const r of Array.isArray(rawPicks) ? rawPicks : []) {
    if (!r || !(Number(r.pick_no) > 0)) continue;
    const pick = Number(r.pick_no);
    if (seen.has(pick)) continue; // duplicate row from a flaky poll
    seen.add(pick);
    const md = r.metadata || {};
    const name = [md.first_name, md.last_name].filter(Boolean).join(' ') || (r.player_id != null ? `Player ${r.player_id}` : 'Unknown player');
    const pid = r.player_id != null && r.player_id !== '' ? String(r.player_id) : null;
    const m = resolve ? resolve(pid, md) : { id: pid, confidence: pid ? 1 : 0 };
    const row = {
      pick, round: Number(r.round) || Math.max(1, Math.ceil(pick / 1)), draft_slot: r.draft_slot != null ? Number(r.draft_slot) : null,
      team_key: r.roster_id != null ? String(r.roster_id) : null, picked_by: r.picked_by != null ? String(r.picked_by) : null,
      player_key: pid, sleeperId: m && m.id != null ? String(m.id) : null, name,
      team: md.team || null, position: md.position || null,
      is_keeper: !!r.is_keeper, matchConfidence: m && m.id != null ? (m.confidence == null ? 1 : m.confidence) : 0,
    };
    picks.push(row);
    if (!row.sleeperId) unmatched.push({ pick, player_key: pid, name, team: row.team, position: row.position, team_key: row.team_key });
  }
  picks.sort((a, b) => a.pick - b.pick);
  return { picks, unmatched };
}

// Fix `round` for picks whose row lacked it (Sleeper always sends it; defensive).
function fixRounds(picks, teams) {
  if (!(teams > 0)) return picks;
  for (const p of picks) if (!(p.round > 0)) p.round = Math.ceil(p.pick / teams);
  return picks;
}

// League users + rosters (+ draft order) → teams[] in the board's shape.
//   { team_key (roster_id), roster_id, user_id, name, display_name, avatar, draft_position|null, co_owners }
function teamsFromLeague(users, rosters, draft) {
  const byUser = new Map();
  for (const u of Array.isArray(users) ? users : []) if (u && u.user_id != null) byUser.set(String(u.user_id), u);
  const order = draft && draft.draft_order && typeof draft.draft_order === 'object' ? draft.draft_order : null;
  const s2r = draft && draft.slot_to_roster_id && typeof draft.slot_to_roster_id === 'object' ? draft.slot_to_roster_id : null;
  const slotOfRoster = new Map();
  if (s2r) for (const [slot, rid] of Object.entries(s2r)) slotOfRoster.set(String(rid), Number(slot));
  const out = [];
  for (const r of Array.isArray(rosters) ? rosters : []) {
    if (!r || r.roster_id == null) continue;
    const uid = r.owner_id != null ? String(r.owner_id) : null;
    const u = uid ? byUser.get(uid) : null;
    const md = (u && u.metadata) || {};
    let dp = slotOfRoster.has(String(r.roster_id)) ? slotOfRoster.get(String(r.roster_id)) : null;
    if (dp == null && order && uid && Number(order[uid]) > 0) dp = Number(order[uid]);
    out.push({
      team_key: String(r.roster_id), roster_id: Number(r.roster_id), user_id: uid,
      name: md.team_name || (u && u.display_name) || `Team ${r.roster_id}`,
      display_name: (u && u.display_name) || null, avatar: (u && u.avatar) || null,
      draft_position: dp, co_owners: Array.isArray(r.co_owners) ? r.co_owners.map(String) : [],
      players: Array.isArray(r.players) ? r.players.map(String) : [], reserve: Array.isArray(r.reserve) ? r.reserve.map(String) : [],
      starters: Array.isArray(r.starters) ? r.starters.map(String) : [],
      settings: r.settings || {},
    });
  }
  out.sort((a, b) => a.roster_id - b.roster_id);
  return out;
}

// The roster that belongs to a Sleeper user (owner or co-owner), or null.
function myTeamKey(teams, userId) {
  if (!userId) return null;
  const uid = String(userId);
  const t = (teams || []).find(x => x.user_id === uid) || (teams || []).find(x => (x.co_owners || []).includes(uid));
  return t ? t.team_key : null;
}

// Draft type / scoring classification for the league picker and the board.
//   { draft_type: 'snake'|'linear'|'auction'|null, auction, scoring_type: 'points'|'categories'|null, supported }
const CATEGORY_RE = /cat|roto|rotisserie/i;
function classifyLeague(league, draft) {
  const type = draft && draft.type ? String(draft.type).toLowerCase() : null;
  const auction = type === 'auction';
  const md = (draft && draft.metadata) || {};
  const ls = (league && league.settings) || {};
  const raw = md.scoring_type != null ? String(md.scoring_type) : ls.scoring_type != null ? String(ls.scoring_type) : null;
  let scoring = null;
  if (raw && CATEGORY_RE.test(raw)) scoring = 'categories';
  else if (league && league.scoring_settings && typeof league.scoring_settings === 'object') scoring = 'points';
  else if (raw) scoring = 'points';
  return { draft_type: type, auction, scoring_type: scoring, scoring_raw: raw, supported: !auction && scoring !== 'categories' };
}

// League row for /api/nba/sleeper/leagues (the picker): name, size, draft state + time, scoring.
function leagueSummary(league, draft) {
  const cls = classifyLeague(league, draft);
  const settings = (league && league.settings) || {};
  const ds = draft && draft.settings ? draft.settings : {};
  return {
    league_key: String(league.league_id), league_id: String(league.league_id), name: league.name || `League ${league.league_id}`,
    season: league.season != null ? String(league.season) : null, status: league.status || null,
    num_teams: Number(league.total_rosters) || Number(settings.num_teams) || null,
    draft_id: draft && draft.draft_id != null ? String(draft.draft_id) : league.draft_id != null ? String(league.draft_id) : null,
    draft_status: draftStatus(draft), draft_raw_status: draft && draft.status ? String(draft.status) : null,
    draft_start: draft && Number(draft.start_time) > 0 ? Number(draft.start_time) : null,
    draft_type: cls.draft_type, auction: cls.auction, scoring_type: cls.scoring_type,
    rounds: Number(ds.rounds) || null, pick_timer: Number(ds.pick_timer) || null, reversal_round: Number(ds.reversal_round) || 0,
    avatar: league.avatar || null,
  };
}

// Compact draft meta for the board (/api/nba/sleeper/draft + /league).
function draftMeta(draft) {
  if (!draft) return null;
  const s = draft.settings || {};
  return {
    draft_id: draft.draft_id != null ? String(draft.draft_id) : null, league_id: draft.league_id != null ? String(draft.league_id) : null,
    type: draft.type ? String(draft.type).toLowerCase() : null, status: draftStatus(draft), raw_status: draft.status || null,
    start_time: Number(draft.start_time) > 0 ? Number(draft.start_time) : null, last_picked: Number(draft.last_picked) > 0 ? Number(draft.last_picked) : null,
    teams: Number(s.teams) || null, rounds: Number(s.rounds) || null, pick_timer: Number(s.pick_timer) || null,
    reversal_round: Number(s.reversal_round) || 0, cpu_autopick: s.cpu_autopick != null ? !!Number(s.cpu_autopick) : null,
    slots: slotsFromDraftSettings(s),
    draft_order: draft.draft_order && typeof draft.draft_order === 'object' ? draft.draft_order : null,
    slot_to_roster_id: draft.slot_to_roster_id && typeof draft.slot_to_roster_id === 'object' ? draft.slot_to_roster_id : null,
    scoring_type: draft.metadata && draft.metadata.scoring_type != null ? String(draft.metadata.scoring_type) : null,
    elapsed_pick_timer: draft.metadata && draft.metadata.elapsed_pick_timer != null ? Number(draft.metadata.elapsed_pick_timer) : null,
    autopaused: draft.metadata && draft.metadata.is_autopaused != null ? String(draft.metadata.is_autopaused) === 'true' : null,
  };
}
// draft.settings.slots_pg/slots_sg/... → { PG, SG, G, SF, PF, F, C, UTIL, BN, IL }
const SLOT_KEYS = { slots_pg: 'PG', slots_sg: 'SG', slots_g: 'G', slots_sf: 'SF', slots_pf: 'PF', slots_f: 'F', slots_c: 'C', slots_util: 'UTIL', slots_bn: 'BN', slots_ir: 'IL' };
function slotsFromDraftSettings(s) {
  const out = {};
  let any = false;
  for (const [k, slot] of Object.entries(SLOT_KEYS)) { if (s && s[k] != null) { out[slot] = Number(s[k]) || 0; any = true; } }
  return any ? out : null;
}

// league.roster_positions (['PG','SG','G',...,'UTIL','BN','BN','IR']) → counts.
function rosterPositionCounts(positions) {
  const counts = {};
  for (const p of Array.isArray(positions) ? positions : []) {
    const k = String(p || '').toUpperCase();
    if (!k) continue;
    const slot = k === 'IR' || k === 'IL' || k === 'IL+' ? 'IL' : k === 'UT' || k === 'UTILITY' ? 'UTIL' : k;
    counts[slot] = (counts[slot] || 0) + 1;
  }
  return counts;
}

// Compact league meta for the board / lineup / trade / waivers.
function leagueMeta(league) {
  if (!league) return null;
  const s = league.settings || {};
  return {
    league_id: String(league.league_id), league_key: String(league.league_id), name: league.name || null, season: league.season != null ? String(league.season) : null,
    status: league.status || null, num_teams: Number(league.total_rosters) || Number(s.num_teams) || null,
    roster_positions: Array.isArray(league.roster_positions) ? league.roster_positions.slice() : [],
    roster_counts: rosterPositionCounts(league.roster_positions),
    reserve_slots: Number(s.reserve_slots) || 0, taxi_slots: Number(s.taxi_slots) || 0,
    playoff_week_start: Number(s.playoff_week_start) || null, playoff_teams: Number(s.playoff_teams) || null,
    trade_deadline: s.trade_deadline != null ? Number(s.trade_deadline) : null, start_week: Number(s.start_week) || 1, leg: Number(s.leg) || null,
    waiver_type: s.waiver_type != null ? Number(s.waiver_type) : null, waiver_budget: s.waiver_budget != null ? Number(s.waiver_budget) : null,
    waiver_clear_days: s.waiver_clear_days != null ? Number(s.waiver_clear_days) : null, daily_waivers: s.daily_waivers != null ? !!Number(s.daily_waivers) : null,
    max_keepers: s.max_keepers != null ? Number(s.max_keepers) : null, league_type: s.type != null ? Number(s.type) : null,
    scoring_settings: league.scoring_settings && typeof league.scoring_settings === 'object' ? league.scoring_settings : null,
    draft_id: league.draft_id != null ? String(league.draft_id) : null, avatar: league.avatar || null,
  };
}

// The current NBA league season for /user/{id}/leagues/nba/{season}: Sleeper's
// state.league_season ('2026' for 2026-27; probed 2026-10-15: /2027 → []).
function currentSeason(state, now = new Date()) {
  const s = state && (state.league_season || state.season);
  if (s && /^\d{4}$/.test(String(s))) return String(s);
  // Fallback: NBA seasons are labelled by the year they start (Oct).
  return String(now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);
}

module.exports = {
  DRAFT_STATUS, draftStatus, roundForward, slotForPick, pickOrder, normalizePicks, fixRounds, teamsFromLeague, myTeamKey,
  classifyLeague, leagueSummary, draftMeta, slotsFromDraftSettings, rosterPositionCounts, leagueMeta, currentSeason,
};
