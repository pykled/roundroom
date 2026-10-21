// Sleeper API client for Pocket NBA (server side). Sleeper's API is public and
// unauthenticated (https://docs.sleeper.com): no tokens, no OAuth. Every call
// has an explicit timeout, one retry on 5xx / network errors, and a typed error
// so routes can map outages, rate limits and bad usernames to clear messages.
//
//   const c = createSleeperClient({ fetchImpl, timeoutMs, log });
//   c.state()                         → GET /v1/state/nba
//   c.user(username | user_id)        → GET /v1/user/{id}            (null when unknown)
//   c.userLeagues(userId, season)     → GET /v1/user/{id}/leagues/nba/{season}
//   c.league(leagueId)                → GET /v1/league/{id}
//   c.leagueUsers(leagueId)           → GET /v1/league/{id}/users
//   c.leagueRosters(leagueId)         → GET /v1/league/{id}/rosters
//   c.leagueDrafts(leagueId)          → GET /v1/league/{id}/drafts
//   c.leagueMatchups(leagueId, week)  → GET /v1/league/{id}/matchups/{week}
//   c.draft(draftId)                  → GET /v1/draft/{id}
//   c.draftPicks(draftId)             → GET /v1/draft/{id}/picks
//   c.draftTradedPicks(draftId)       → GET /v1/draft/{id}/traded_picks
'use strict';

const BASE = 'https://api.sleeper.app/v1';
const SPORT = 'nba';

class SleeperError extends Error {
  constructor(message, { status = null, code = 'sleeper_upstream', retryAfterS = null } = {}) {
    super(message);
    this.name = 'SleeperError';
    this.status = status;
    this.code = code; // sleeper_not_found | sleeper_rate_limited | sleeper_timeout | sleeper_upstream | sleeper_bad_request | not_an_nba_league
    this.retryAfterS = retryAfterS;
  }
}

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function assertId(x, what) {
  const s = String(x == null ? '' : x).trim();
  if (!ID_RE.test(s)) throw new SleeperError(`Invalid ${what}`, { status: 400, code: 'sleeper_bad_request' });
  return s;
}

function createSleeperClient({ fetchImpl = globalThis.fetch, timeoutMs = 8000, retries = 1, log = console, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('sleeper client: fetch not available');

  async function get(path) {
    const url = BASE + path;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let r;
      try {
        r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json', 'User-Agent': 'pocketff.com NBA (+https://pocketff.com)' } });
      } catch (err) {
        const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        lastErr = new SleeperError(timeout ? 'Sleeper timed out' : 'Sleeper unreachable', { status: null, code: timeout ? 'sleeper_timeout' : 'sleeper_upstream' });
        if (attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
        throw lastErr;
      }
      if (r.status === 404) return null;
      if (r.status === 429) {
        const ra = Number(r.headers && r.headers.get ? r.headers.get('retry-after') : null);
        throw new SleeperError('Sleeper rate limit', { status: 429, code: 'sleeper_rate_limited', retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : 5 });
      }
      if (r.status >= 500) {
        lastErr = new SleeperError(`Sleeper HTTP ${r.status}`, { status: r.status, code: 'sleeper_upstream' });
        if (attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
        throw lastErr;
      }
      if (!r.ok) throw new SleeperError(`Sleeper HTTP ${r.status}`, { status: r.status, code: r.status === 400 ? 'sleeper_bad_request' : 'sleeper_upstream' });
      try { return await r.json(); } catch { throw new SleeperError('Sleeper sent an unreadable response', { status: 502, code: 'sleeper_upstream' }); }
    }
    throw lastErr || new SleeperError('Sleeper unreachable');
  }

  // async wrappers: a bad id rejects (never throws synchronously into a route).
  return {
    state: async () => get(`/state/${SPORT}`),
    // Sleeper answers 200 + null for an unknown username (not 404); both → null.
    user: async u => get(`/user/${encodeURIComponent(assertId(u, 'username'))}`),
    userLeagues: async (userId, season) => (await get(`/user/${encodeURIComponent(assertId(userId, 'user id'))}/leagues/${SPORT}/${encodeURIComponent(assertId(season, 'season'))}`)) || [],
    league: async id => get(`/league/${encodeURIComponent(assertId(id, 'league id'))}`),
    leagueUsers: async id => (await get(`/league/${encodeURIComponent(assertId(id, 'league id'))}/users`)) || [],
    leagueRosters: async id => (await get(`/league/${encodeURIComponent(assertId(id, 'league id'))}/rosters`)) || [],
    leagueDrafts: async id => (await get(`/league/${encodeURIComponent(assertId(id, 'league id'))}/drafts`)) || [],
    leagueMatchups: async (id, week) => (await get(`/league/${encodeURIComponent(assertId(id, 'league id'))}/matchups/${encodeURIComponent(assertId(week, 'week'))}`)) || [],
    draft: async id => get(`/draft/${encodeURIComponent(assertId(id, 'draft id'))}`),
    draftPicks: async id => (await get(`/draft/${encodeURIComponent(assertId(id, 'draft id'))}/picks`)) || [],
    draftTradedPicks: async id => (await get(`/draft/${encodeURIComponent(assertId(id, 'draft id'))}/traded_picks`)) || [],
    _get: get,
    log,
  };
}

// Route helper: a SleeperError (or anything else) → { status, body } for res.
function errorResponse(err) {
  const code = err && err.code;
  if (code === 'sleeper_bad_request' || code === 'not_an_nba_league') return { status: 400, body: { error: err.message || 'Bad request', code } };
  if (code === 'sleeper_not_found') return { status: 404, body: { error: err.message || 'Not found on Sleeper', code } };
  if (code === 'sleeper_rate_limited') return { status: 429, body: { error: 'Sleeper is rate-limiting us — retry in a few seconds', code, retryAfterS: err.retryAfterS || 5 } };
  if (code === 'sleeper_timeout') return { status: 504, body: { error: 'Sleeper timed out — try again in a moment', code } };
  return { status: 502, body: { error: 'Sleeper is having trouble — try again in a minute', code: 'sleeper_upstream' } };
}

module.exports = { createSleeperClient, SleeperError, errorResponse, BASE, SPORT };
