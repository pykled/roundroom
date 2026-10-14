// Normalizers for Yahoo Fantasy ?format=json responses.
//
// Yahoo's JSON is a mechanical translation of its XML:
//   - collections are objects keyed "0","1",… plus a "count" field
//     ({"0":{"team":…},"1":{"team":…},"count":2}); an empty one may be [] or "".
//     A one-element collection is sometimes just {"team":…} with no index, and
//     "count" can disagree with the keys actually present.
//   - a resource is an array of fragments: [ {meta}, {"settings":[…]} ] for a
//     league, [[ {team_key}, {team_id}, [], {name}, … ], {"roster":…}] for a
//     team/player (first element is itself an array of one-key objects,
//     sometimes with empty [] placeholders).
// flat() merges those fragments into one plain object; list() turns a
// collection into an array. Everything returned here is plain, typed JSON.
//
// Parsers never throw on a missing optional piece; they record a warning
// instead. capture(fn, onWarn) runs a (synchronous) parse and hands each
// warning to onWarn — the diagnose report shows them.

let sink = null;
function warn(msg) { if (sink) sink(msg); }
function capture(fn, onWarn) {
  const prev = sink;
  sink = onWarn || null;
  try { return fn(); } finally { sink = prev; }
}

function flat(x) {
  const out = {};
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.assign(out, v);
  })(x);
  return out;
}

const RESOURCES = new Set(['game', 'user', 'league', 'team', 'player']);

function list(coll, key) {
  if (coll === undefined || coll === null || coll === '' || typeof coll !== 'object') return [];
  if (Array.isArray(coll)) return coll.map(e => (e && e[key] !== undefined ? e[key] : e)).filter(e => e !== undefined);
  const idx = Object.keys(coll).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
  if (!idx.length) {
    // No numeric wrapper: {"team": …} is one entry. Resources (team, player…)
    // are themselves fragment arrays, so wrap them; for simple entries an
    // array value ({"stat":[{…},{…}]}) is already the list.
    const v = coll[key];
    if (v !== undefined) return Array.isArray(v) && !RESOURCES.has(key) ? v : [v];
    if (Number(coll.count) > 0) warn(`${key} collection says count=${coll.count} but has no entries`);
    return [];
  }
  if (coll.count !== undefined && Number(coll.count) !== idx.length) warn(`${key} collection count=${coll.count} but ${idx.length} entries present`);
  const out = [];
  for (const i of idx) {
    const e = coll[String(i)];
    if (e && e[key] !== undefined) out.push(e[key]);
    else warn(`${key} collection entry ${i} has no "${key}"`);
  }
  return out;
}

const num = v => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const bool = v => v === 1 || v === '1' || v === true;
const isScalar = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);

class YahooParseError extends Error {
  constructor(message, code) { super(message); this.name = 'YahooParseError'; this.code = code || 'bad_response'; }
}

function root(json) {
  if (typeof json === 'string') {
    const d = /<description>([^<]{0,200})<\/description>/i.exec(json);
    throw new YahooParseError(`Yahoo returned XML instead of JSON${d ? `: ${d[1]}` : ''}`, 'xml_response');
  }
  if (json && json.error && !json.fantasy_content) {
    const d = typeof json.error === 'object' ? (json.error.description || json.error.message) : json.error;
    throw new YahooParseError(`Yahoo error${d ? `: ${String(d).slice(0, 200)}` : ''}`, 'yahoo_error');
  }
  if (!json || !json.fantasy_content) throw new YahooParseError('Unexpected Yahoo response (no fantasy_content)');
  return json.fantasy_content;
}

// Positions arrive as [{position:'PG'},…], {position:'PG'}, a numeric-keyed
// collection of either, or plain strings.
function positions(v) {
  if (v === undefined || v === null || v === '') return [];
  let arr;
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'object') {
    const idx = Object.keys(v).filter(k => /^\d+$/.test(k));
    arr = idx.length ? idx.sort((a, b) => a - b).map(k => v[k]) : [v];
  } else arr = [v];
  return arr.map(e => (e && typeof e === 'object' ? e.position : e)).filter(e => typeof e === 'string' && e);
}

function game(raw) {
  const g = flat(raw);
  if (g.game_key === undefined) warn('game without game_key');
  return {
    game_key: g.game_key != null ? String(g.game_key) : null, game_id: num(g.game_id), code: g.code || null, name: g.name || null,
    season: g.season != null ? String(g.season) : null, is_game_over: bool(g.is_game_over),
  };
}

function leagueMeta(m) {
  if (!m.league_key) warn('league without league_key');
  return {
    league_key: m.league_key || null, league_id: m.league_id != null ? String(m.league_id) : null, name: m.name || null,
    url: m.url || null, num_teams: num(m.num_teams), scoring_type: m.scoring_type || null,
    league_type: m.league_type || null, draft_status: m.draft_status || null,
    current_week: num(m.current_week), start_week: num(m.start_week), end_week: num(m.end_week),
    start_date: m.start_date || null, end_date: m.end_date || null,
    season: m.season != null ? String(m.season) : null, game_code: m.game_code || null,
  };
}

const SETTINGS_MAPPED = new Set(['draft_type', 'is_auction_draft', 'scoring_type', 'max_teams', 'uses_playoff', 'playoff_start_week',
  'trade_end_date', 'draft_time', 'draft_pick_time', 'roster_positions', 'stat_categories', 'stat_modifiers']);

function settings(raw) {
  const s = flat(raw);
  const statCats = list(s.stat_categories && s.stat_categories.stats, 'stat');
  const statMods = list(s.stat_modifiers && s.stat_modifiers.stats, 'stat');
  const rp = list(s.roster_positions, 'roster_position');
  if (!rp.length) warn('league settings have no roster_positions');
  // Every other scalar setting, verbatim: lets the diagnose report show fields
  // we don't model yet (e.g. whatever marks a league as "High Score").
  const extra = {};
  for (const [k, v] of Object.entries(s)) if (!SETTINGS_MAPPED.has(k) && isScalar(v)) extra[k] = v;
  return {
    draft_type: s.draft_type || null, is_auction_draft: bool(s.is_auction_draft),
    scoring_type: s.scoring_type || null, max_teams: num(s.max_teams), uses_playoff: bool(s.uses_playoff),
    playoff_start_week: num(s.playoff_start_week), trade_end_date: s.trade_end_date || null,
    draft_time: num(s.draft_time), draft_pick_time: num(s.draft_pick_time),
    roster_positions: rp.map(p => flat(p)).map(p => ({
      position: p.position, position_type: p.position_type || null, count: num(p.count) || 0,
      is_starting_position: p.is_starting_position === undefined ? !['BN', 'IL', 'IL+'].includes(p.position) : bool(p.is_starting_position),
    })).filter(p => p.position),
    stat_categories: statCats.map(c => flat(c)).map(c => ({
      stat_id: num(c.stat_id), name: c.name || null, display_name: c.display_name || null, enabled: c.enabled === undefined ? true : bool(c.enabled),
    })),
    stat_modifiers: statMods.map(m => flat(m)).map(m => ({ stat_id: num(m.stat_id), value: num(m.value) })),
    extra,
  };
}

function weeks(gameWeeksColl) {
  return list(gameWeeksColl, 'game_week').map(w => flat(w)).map(w => ({ week: num(w.week), start: w.start || null, end: w.end || null }));
}

function team(raw) {
  const t = flat(raw);
  if (!t.team_key) warn('team without team_key');
  let mgr = t.managers;
  mgr = Array.isArray(mgr) ? mgr : mgr && typeof mgr === 'object' && mgr.manager && !Object.keys(mgr).some(k => /^\d+$/.test(k)) ? [mgr] : list(mgr, 'manager');
  const managers = mgr
    .map(m => (m && m.manager) || m).filter(m => m && typeof m === 'object')
    .map(m => ({ manager_id: m.manager_id != null ? String(m.manager_id) : null, nickname: m.nickname || null, guid: m.guid || null, is_current_login: bool(m.is_current_login) }));
  return {
    team_key: t.team_key || null, team_id: t.team_id != null ? String(t.team_id) : null, name: t.name || null,
    url: t.url || null, is_owned_by_current_login: bool(t.is_owned_by_current_login) || managers.some(m => m.is_current_login),
    draft_position: num(t.draft_position), managers,
  };
}

function player(raw) {
  const p = flat(raw);
  if (!p.player_key) warn('player without player_key');
  const sel = p.selected_position ? flat(p.selected_position).position || null : null;
  const name = p.name && typeof p.name === 'object' ? p.name : { full: typeof p.name === 'string' ? p.name : null };
  const full = name.full || [name.first, name.last].filter(Boolean).join(' ') || null;
  if (!full) warn(`player ${p.player_key || '?'} has no name`);
  return {
    player_key: p.player_key || null, player_id: p.player_id != null ? String(p.player_id) : null,
    name: { full, first: name.first || null, last: name.last || null },
    editorial_team_abbr: p.editorial_team_abbr ? String(p.editorial_team_abbr).toUpperCase() : null,
    editorial_team_full_name: p.editorial_team_full_name || null,
    display_position: p.display_position || null, primary_position: p.primary_position || null,
    eligible_positions: positions(p.eligible_positions),
    status: p.status || null, injury_note: p.injury_note || null,
    ...(p.selected_position ? { selected_position: sel } : {}),
  };
}

function draftResults(coll) {
  return list(coll, 'draft_result').map(d => flat(d)).map(d => {
    if (num(d.pick) == null) warn('draft_result without pick number');
    return {
      pick: num(d.pick), round: num(d.round), team_key: d.team_key || null, player_key: d.player_key || null,
      ...(d.cost !== undefined ? { cost: num(d.cost) } : {}),
    };
  });
}

// ---- whole-response parsers -------------------------------------------------

function parseGame(json) {
  const r = root(json);
  const g = r.game !== undefined ? r.game : list(r.games, 'game')[0];
  return game(g);
}

function parseUserLeagues(json) {
  const users = list(root(json).users, 'user');
  if (!users.length) warn('users collection is empty');
  const u = users[0] || [];
  const guid = flat(u).guid || null;
  const out = [];
  for (const g of list(flat(u).games, 'game')) {
    const gm = game(g);
    for (const l of list(flat(g).leagues, 'league')) out.push({ ...leagueMeta(flat(l)), game_key: gm.game_key });
  }
  return { guid, leagues: out };
}

function parseLeague(json) {
  const l = root(json).league;
  const f = flat(l);
  if (!f.settings) warn('league response has no settings block');
  return { ...leagueMeta(f), settings: f.settings ? settings(f.settings) : null };
}

function parseGameWeeks(json) { return weeks(flat(root(json).game).game_weeks); }

function parseDraftResults(json) {
  const f = flat(root(json).league);
  return { ...leagueMeta(f), picks: draftResults(f.draft_results) };
}

function parseTeams(json) { return list(flat(root(json).league).teams, 'team').map(team); }

function parseRoster(json) {
  const t = root(json).team;
  const f = flat(t);
  const roster = flat(f.roster);
  // roster = { coverage_type, week, "0": { players: {collection} } }
  const playersColl = (roster['0'] && roster['0'].players) || roster.players;
  if (playersColl === undefined) warn('roster has no players collection');
  return {
    team: team(Array.isArray(t) ? t[0] : t),
    week: num(roster.week), coverage_type: roster.coverage_type || null,
    players: list(playersColl, 'player').map(player),
  };
}

function parsePlayers(json) { return list(flat(root(json).league).players, 'player').map(player); }

module.exports = {
  flat, list, positions, capture, YahooParseError,
  parseGame, parseUserLeagues, parseLeague, parseGameWeeks, parseDraftResults, parseTeams, parseRoster, parsePlayers,
};
