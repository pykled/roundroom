// Sleeper-first league sync for Pocket NBA. Mounted from nba/router.js:
//   router.use(require('./routes/sleeper')({ apiCached, modelPlayers, log, client }))
//
// Everything here is public data (Sleeper's API needs no auth), so no sign-in
// is required; the router rate-limits these paths per IP and apiCached pools
// identical requests (one upstream fetch per draft per 3 s however many tabs poll).
//
//   GET /api/nba/sleeper/user?username=            → { user_id, username, display_name, avatar }   404 sleeper_user_not_found
//   GET /api/nba/sleeper/leagues?user_id=|username= → { season, user, leagues: [leagueSummary] }   (current NBA season)
//   GET /api/nba/sleeper/league?league_id=[&user_id=] → { league, draft, teams, myTeamKey, mySlot }
//   GET /api/nba/sleeper/draft?draft_id=[&user_id=]   → { status, picks, unmatched, order, onClock, auction, draft, polledAt }
//   GET /api/nba/sleeper/rosters?league_id=[&user_id=] → { league, teams (players matched to the board), myTeamKey, unmatched }
//   GET /api/nba/sleeper/matchup?league_id=&roster_id=&week= → { week, opponent: team_key|null }
// Error codes: sleeper_bad_request 400, sleeper_user_not_found / sleeper_not_found 404,
// sleeper_rate_limited 429 (+Retry-After), sleeper_timeout 504, sleeper_upstream 502.
'use strict';
const express = require('express');
const { createSleeperClient, SleeperError, errorResponse } = require('../sleeper/client');
const M = require('../sleeper/map');
const { matchYahooPlayer } = require('../model/names');

const ID_RE = /^\d{1,24}$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const MAX_LEAGUES = 25;

// Name+team fallback for a pick whose player_id isn't on the board (deep bench
// / two-way players the model trims). Reuses the proven Yahoo-era matcher.
function createResolver(players) {
  const byId = new Map();
  for (const p of players || []) {
    byId.set(String(p.id), p);
    if (p.sleeperId != null) byId.set(String(p.sleeperId), p);
  }
  return function resolve(playerId, md) {
    if (playerId != null && byId.has(String(playerId))) return { id: String(byId.get(String(playerId)).id), confidence: 1, reason: 'sleeper-id' };
    const name = md && [md.first_name, md.last_name].filter(Boolean).join(' ');
    if (!name) return { id: null, confidence: 0, reason: 'no-name' };
    let m = null;
    try { m = matchYahooPlayer({ name: { full: name }, editorial_team_abbr: md.team || null, display_position: md.position || null }, players || []); } catch { m = null; }
    return m && m.player ? { id: String(m.player.id), confidence: m.confidence, reason: m.reason } : { id: null, confidence: 0, reason: 'unmatched' };
  };
}

module.exports = function sleeperRoutes({ apiCached, modelPlayers, log = console, client = createSleeperClient({ log }), now = () => Date.now() } = {}) {
  if (typeof apiCached !== 'function') throw new Error('sleeper routes: apiCached required');
  const router = express.Router();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => sendError(res, err));

  function sendError(res, err) {
    const { status, body } = errorResponse(err);
    if (status >= 500 || status === 429) log.error('[nba] sleeper:', err && err.message);
    if (status === 429 && body.retryAfterS) res.setHeader('Retry-After', String(body.retryAfterS));
    res.status(status).json(body);
  }
  const bad = (res, msg) => res.status(400).json({ error: msg, code: 'sleeper_bad_request' });

  async function boardPlayers() {
    try { const d = await modelPlayers(null, undefined); return (d && d.players) || []; } catch { return []; }
  }
  async function resolver() { return createResolver(await boardPlayers()); }

  // ---- cached fetchers ---------------------------------------------------
  const season = () => apiCached('nba:sl:season', 60 * 60 * 1000, async () => M.currentSeason(await client.state()));
  const userByName = u => apiCached(`nba:sl:user:${u.toLowerCase()}`, 10 * 60 * 1000, () => client.user(u));
  const leagueRaw = id => apiCached(`nba:sl:league:${id}`, 60 * 1000, () => client.league(id));
  const usersRaw = id => apiCached(`nba:sl:users:${id}`, 60 * 1000, () => client.leagueUsers(id));
  const rostersRaw = id => apiCached(`nba:sl:rosters:${id}`, 30 * 1000, () => client.leagueRosters(id));
  const draftRaw = id => apiCached(`nba:sl:draft:${id}`, 3000, () => client.draft(id));
  const picksRaw = id => apiCached(`nba:sl:picks:${id}`, 3000, () => client.draftPicks(id));
  const tradedRaw = id => apiCached(`nba:sl:traded:${id}`, 60 * 1000, () => client.draftTradedPicks(id));
  const draftsOf = id => apiCached(`nba:sl:drafts:${id}`, 60 * 1000, () => client.leagueDrafts(id));
  const matchupsRaw = (id, w) => apiCached(`nba:sl:matchups:${id}:${w}`, 5 * 60 * 1000, () => client.leagueMatchups(id, w));

  // The league's current draft: league.draft_id, else the newest in /drafts.
  async function leagueDraft(league) {
    if (!league) return null;
    if (league.draft_id) { const d = await draftRaw(String(league.draft_id)); if (d) return d; }
    const list = await draftsOf(String(league.league_id));
    const sorted = (list || []).filter(Boolean).sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
    return sorted[0] || null;
  }

  // Shared by lineup / trade / waivers: league + teams (+ my team) in one call.
  async function leagueContext(leagueId, userId) {
    const league = await leagueRaw(leagueId);
    if (!league) throw new SleeperError('League not found on Sleeper', { status: 404, code: 'sleeper_not_found' });
    const [users, rosters, draft] = await Promise.all([usersRaw(leagueId), rostersRaw(leagueId), leagueDraft(league).catch(() => null)]);
    const teams = M.teamsFromLeague(users, rosters, draft);
    const mine = M.myTeamKey(teams, userId);
    const me = mine ? teams.find(t => t.team_key === mine) : null;
    return { league, users, rosters, draft, teams, myTeamKey: mine, mySlot: me && me.draft_position != null ? me.draft_position : null };
  }

  // ---- endpoints ---------------------------------------------------------
  router.get('/api/nba/sleeper/user', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const u = String(req.query.username || '').trim().replace(/^@/, '');
    if (!USERNAME_RE.test(u)) return bad(res, 'Enter a Sleeper username (letters, numbers, _ . -)');
    const user = await userByName(u);
    if (!user || !user.user_id) return res.status(404).json({ error: `No Sleeper user named “${u}” — check the spelling`, code: 'sleeper_user_not_found' });
    res.json({ user_id: String(user.user_id), username: user.username || u, display_name: user.display_name || user.username || u, avatar: user.avatar || null });
  }));

  router.get('/api/nba/sleeper/leagues', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    let uid = String(req.query.user_id || '').trim();
    let user = null;
    if (!uid) {
      const u = String(req.query.username || '').trim().replace(/^@/, '');
      if (!USERNAME_RE.test(u)) return bad(res, 'user_id or username required');
      user = await userByName(u);
      if (!user || !user.user_id) return res.status(404).json({ error: `No Sleeper user named “${u}”`, code: 'sleeper_user_not_found' });
      uid = String(user.user_id);
    }
    if (!ID_RE.test(uid)) return bad(res, 'Invalid user_id');
    const ssn = await season();
    const raw = await apiCached(`nba:sl:leagues:${uid}:${ssn}`, 60 * 1000, () => client.userLeagues(uid, ssn));
    const list = (raw || []).filter(l => l && l.league_id).slice(0, MAX_LEAGUES);
    // One draft lookup per league (status / start time / type for the picker); a
    // failed draft lookup still lists the league.
    const drafts = await Promise.all(list.map(l => leagueDraft(l).catch(() => null)));
    const leagues = list.map((l, i) => M.leagueSummary(l, drafts[i]));
    res.json({ season: ssn, user_id: uid, user: user ? { user_id: uid, username: user.username, display_name: user.display_name, avatar: user.avatar || null } : null, leagues });
  }));

  router.get('/api/nba/sleeper/league', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const lid = String(req.query.league_id || '').trim();
    if (!ID_RE.test(lid)) return bad(res, 'Invalid league_id');
    const uid = String(req.query.user_id || '').trim() || null;
    if (uid && !ID_RE.test(uid)) return bad(res, 'Invalid user_id');
    const ctx = await leagueContext(lid, uid);
    res.json({
      league: M.leagueMeta(ctx.league), draft: M.draftMeta(ctx.draft), support: M.classifyLeague(ctx.league, ctx.draft),
      teams: ctx.teams.map(t => ({ team_key: t.team_key, roster_id: t.roster_id, user_id: t.user_id, name: t.name, display_name: t.display_name, avatar: t.avatar, draft_position: t.draft_position, co_owners: t.co_owners })),
      myTeamKey: ctx.myTeamKey, mySlot: ctx.mySlot,
    });
  }));

  router.get('/api/nba/sleeper/draft', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const did = String(req.query.draft_id || '').trim();
    if (!ID_RE.test(did)) return bad(res, 'Invalid draft_id');
    const out = await apiCached(`nba:sl:draftview:${did}`, 3000, async () => {
      const draft = await draftRaw(did);
      if (!draft) throw new SleeperError('Draft not found on Sleeper', { status: 404, code: 'sleeper_not_found' });
      const [rawPicks, traded, resolve] = await Promise.all([picksRaw(did), tradedRaw(did).catch(() => []), resolver()]);
      const meta = M.draftMeta(draft);
      const { picks, unmatched } = M.normalizePicks(rawPicks, resolve);
      M.fixRounds(picks, meta.teams);
      const full = M.pickOrder(draft, traded);
      const made = new Set(picks.map(p => p.pick));
      const order = full.filter(o => !made.has(o.pick));
      const status = meta.status;
      return {
        status, paused: meta.raw_status === 'paused',
        picks, unmatched, order, onClock: status === 'drafting' && order[0] ? order[0] : null,
        auction: meta.type === 'auction', draft: meta, polledAt: new Date(now()).toISOString(),
      };
    });
    res.json(out);
  }));

  router.get('/api/nba/sleeper/rosters', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const lid = String(req.query.league_id || '').trim();
    if (!ID_RE.test(lid)) return bad(res, 'Invalid league_id');
    const uid = String(req.query.user_id || '').trim() || null;
    if (uid && !ID_RE.test(uid)) return bad(res, 'Invalid user_id');
    const [ctx, players] = await Promise.all([leagueContext(lid, uid), boardPlayers()]);
    const byId = new Map(players.map(p => [String(p.id), p]));
    const unmatched = [];
    const teams = ctx.teams.map(t => ({
      team_key: t.team_key, roster_id: t.roster_id, user_id: t.user_id, name: t.name, display_name: t.display_name, mine: t.team_key === ctx.myTeamKey,
      draft_position: t.draft_position, settings: t.settings,
      players: t.players.map(id => {
        const p = byId.get(id);
        const il = t.reserve.includes(id);
        if (!p) unmatched.push({ team_key: t.team_key, player_key: id, name: `Player ${id}` });
        return { player_key: id, sleeperId: p ? String(p.id) : null, name: p ? p.name : `Player ${id}`, selected_position: il ? 'IL' : t.starters.includes(id) ? 'START' : 'BN', status: p ? p.injury || null : null };
      }),
    }));
    res.json({ league: M.leagueMeta(ctx.league), draft: M.draftMeta(ctx.draft), support: M.classifyLeague(ctx.league, ctx.draft), teams, myTeamKey: ctx.myTeamKey, unmatched });
  }));

  router.get('/api/nba/sleeper/matchup', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const lid = String(req.query.league_id || '').trim();
    const rid = String(req.query.roster_id || '').trim();
    const week = Number(req.query.week);
    if (!ID_RE.test(lid)) return bad(res, 'Invalid league_id');
    if (!/^\d{1,3}$/.test(rid)) return bad(res, 'Invalid roster_id');
    if (!(Number.isInteger(week) && week >= 1 && week <= 30)) return bad(res, 'Invalid week');
    const ms = await matchupsRaw(lid, week);
    const mine = ms.find(m => m && String(m.roster_id) === rid);
    const opp = mine && mine.matchup_id != null ? ms.find(m => m && m.matchup_id === mine.matchup_id && String(m.roster_id) !== rid) : null;
    res.json({ week, roster_id: rid, matchup_id: mine ? mine.matchup_id : null, opponent: opp ? String(opp.roster_id) : null });
  }));

  router.leagueContext = leagueContext;
  router.client = client;
  router.createResolver = createResolver;
  return router;
};
module.exports.createResolver = createResolver;
