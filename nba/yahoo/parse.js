// Normalizers for Yahoo Fantasy ?format=json responses.
//
// Yahoo's JSON is a mechanical translation of its XML:
//   - collections are objects keyed "0","1",… plus a "count" field
//     ({"0":{"team":…},"1":{"team":…},"count":2}); an empty one may be [].
//   - a resource is an array of fragments: [ {meta}, {"settings":[…]} ] for a
//     league, [[ {team_key}, {team_id}, [], {name}, … ], {"roster":…}] for a
//     team/player (first element is itself an array of one-key objects,
//     sometimes with empty [] placeholders).
// flat() merges those fragments into one plain object; list() turns a
// collection into an array. Everything returned here is plain, typed JSON.

function flat(x) {
  const out = {};
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.assign(out, v);
  })(x);
  return out;
}

function list(coll, key) {
  if (!coll || typeof coll !== 'object') return [];
  if (Array.isArray(coll)) return coll.map(e => (e && e[key] !== undefined ? e[key] : e)).filter(e => e !== undefined);
  const n = Number.isFinite(Number(coll.count)) ? Number(coll.count) : Object.keys(coll).filter(k => /^\d+$/.test(k)).length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = coll[String(i)];
    if (e && e[key] !== undefined) out.push(e[key]);
  }
  return out;
}

const num = v => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const bool = v => v === 1 || v === '1' || v === true;

function root(json) {
  if (!json || !json.fantasy_content) throw new Error('Unexpected Yahoo response (no fantasy_content)');
  return json.fantasy_content;
}

function game(raw) {
  const g = flat(raw);
  return {
    game_key: String(g.game_key), game_id: num(g.game_id), code: g.code, name: g.name,
    season: g.season != null ? String(g.season) : null, is_game_over: bool(g.is_game_over),
  };
}

function leagueMeta(m) {
  return {
    league_key: m.league_key, league_id: m.league_id != null ? String(m.league_id) : null, name: m.name,
    url: m.url || null, num_teams: num(m.num_teams), scoring_type: m.scoring_type || null,
    league_type: m.league_type || null, draft_status: m.draft_status || null,
    current_week: num(m.current_week), start_week: num(m.start_week), end_week: num(m.end_week),
    start_date: m.start_date || null, end_date: m.end_date || null,
    season: m.season != null ? String(m.season) : null, game_code: m.game_code || null,
  };
}

function settings(raw) {
  const s = flat(raw);
  const statCats = list(s.stat_categories && s.stat_categories.stats, 'stat');
  const statMods = list(s.stat_modifiers && s.stat_modifiers.stats, 'stat');
  return {
    draft_type: s.draft_type || null, is_auction_draft: bool(s.is_auction_draft),
    scoring_type: s.scoring_type || null, max_teams: num(s.max_teams), uses_playoff: bool(s.uses_playoff),
    playoff_start_week: num(s.playoff_start_week), trade_end_date: s.trade_end_date || null,
    draft_time: num(s.draft_time),
    roster_positions: list(s.roster_positions, 'roster_position').map(p => ({
      position: p.position, position_type: p.position_type || null, count: num(p.count) || 0,
      is_starting_position: p.is_starting_position === undefined ? !['BN', 'IL', 'IL+'].includes(p.position) : bool(p.is_starting_position),
    })),
    stat_categories: statCats.map(c => ({
      stat_id: num(c.stat_id), name: c.name, display_name: c.display_name, enabled: c.enabled === undefined ? true : bool(c.enabled),
    })),
    stat_modifiers: statMods.map(m => ({ stat_id: num(m.stat_id), value: num(m.value) })),
  };
}

function weeks(gameWeeksColl) {
  return list(gameWeeksColl, 'game_week').map(w => ({ week: num(w.week), start: w.start, end: w.end }));
}

function team(raw) {
  const t = flat(raw);
  const managers = (Array.isArray(t.managers) ? t.managers : list(t.managers, 'manager'))
    .map(m => (m && m.manager) || m)
    .map(m => ({ manager_id: m.manager_id != null ? String(m.manager_id) : null, nickname: m.nickname || null, guid: m.guid || null, is_current_login: bool(m.is_current_login) }));
  return {
    team_key: t.team_key, team_id: t.team_id != null ? String(t.team_id) : null, name: t.name,
    url: t.url || null, is_owned_by_current_login: bool(t.is_owned_by_current_login) || managers.some(m => m.is_current_login),
    draft_position: num(t.draft_position), managers,
  };
}

function player(raw) {
  const p = flat(raw);
  const sel = p.selected_position ? flat(p.selected_position).position || null : null;
  const name = p.name || {};
  return {
    player_key: p.player_key, player_id: p.player_id != null ? String(p.player_id) : null,
    name: { full: name.full || [name.first, name.last].filter(Boolean).join(' '), first: name.first || null, last: name.last || null },
    editorial_team_abbr: p.editorial_team_abbr ? String(p.editorial_team_abbr).toUpperCase() : null,
    editorial_team_full_name: p.editorial_team_full_name || null,
    display_position: p.display_position || null, primary_position: p.primary_position || null,
    eligible_positions: (p.eligible_positions || []).map(e => (e && e.position) || e).filter(e => typeof e === 'string'),
    status: p.status || null, injury_note: p.injury_note || null,
    ...(p.selected_position ? { selected_position: sel } : {}),
  };
}

function draftResults(coll) {
  return list(coll, 'draft_result').map(d => ({
    pick: num(d.pick), round: num(d.round), team_key: d.team_key || null, player_key: d.player_key || null,
  }));
}

// ---- whole-response parsers -------------------------------------------------

function parseGame(json) { return game(root(json).game); }

function parseUserLeagues(json) {
  const users = list(root(json).users, 'user');
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
  const roster = f.roster || {};
  // roster = { coverage_type, week, "0": { players: {collection} } }
  const playersColl = (roster['0'] && roster['0'].players) || roster.players;
  return {
    team: team(Array.isArray(t) ? t[0] : t),
    week: num(roster.week), coverage_type: roster.coverage_type || null,
    players: list(playersColl, 'player').map(player),
  };
}

function parsePlayers(json) { return list(flat(root(json).league).players, 'player').map(player); }

module.exports = {
  flat, list, parseGame, parseUserLeagues, parseLeague, parseGameWeeks, parseDraftResults, parseTeams, parseRoster, parsePlayers,
};
