// Yahoo Fantasy API client (read-only, ?format=json), normalized output.
//
//   const client = createClient({ getTokens, saveTokens });
//   await client.getGameKey('nba')            -> '466'
//   await client.getUserLeagues(gameKey)      -> [{ league_key, name, num_teams, draft_status, … }]
//   await client.getLeague(leagueKey)         -> { …meta, roster_positions, stat_modifiers, weeks:[{week,start,end}], settings }
//   await client.getDraftResults(leagueKey)   -> { draft_status, picks:[{pick,round,team_key,player_key}] }
//   await client.getTeams(leagueKey)          -> [{ team_key, name, is_owned_by_current_login, managers }]
//   await client.getRoster(teamKey, week?)    -> { team, week, players:[{…, selected_position}] }
//   await client.getPlayers(leagueKey, {start,count,status}) -> [player]
//   await client.getPlayersByKeys(leagueKey, keys)           -> [player] (chunked by 25)
//
// getTokens() -> { access_token, refresh_token, expires_at } | null; saveTokens(t)
// persists a refreshed set. Expired/401 access tokens are refreshed once and
// the request retried. All requests go through a shared spacing queue with
// exponential backoff on 429/999 (Yahoo's throttle code) and 5xx.
const oauth = require('./oauth');
const P = require('./parse');

const BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';

// Body as parsed JSON, or the raw text when it isn't JSON (XML error pages,
// 999 HTML). Works with fetch Responses and test stubs that only have json().
async function readBody(res) {
  if (typeof res.text === 'function') {
    const t = await res.text().catch(() => '');
    try { return JSON.parse(t); } catch { return t; }
  }
  try { return await res.json(); } catch { return ''; }
}

// Short human description from a Yahoo error body (JSON or XML), capped.
function errorDescription(body) {
  let d = '';
  if (body && typeof body === 'object') {
    const e = body.error;
    d = (e && typeof e === 'object' ? e.description || e.message : e) || '';
  } else if (typeof body === 'string') {
    const m = /<description>([^<]*)<\/description>/i.exec(body);
    d = m ? m[1] : '';
  }
  return String(d).replace(/\s+/g, ' ').trim().slice(0, 200);
}

class YahooError extends Error {
  constructor(message, status, code) { super(message); this.name = 'YahooError'; this.status = status; this.code = code; }
}

// Spacing queue: one request starts at most every minIntervalMs.
function createLimiter({ minIntervalMs = 200, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let chain = Promise.resolve();
  let last = 0;
  return function schedule(fn) {
    const run = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    chain = run.catch(() => {});
    return run.then(fn);
  };
}

const sharedLimiter = createLimiter();

function createClient({
  getTokens, saveTokens,
  fetchImpl = (...a) => fetch(...a),
  refresh = rt => oauth.refreshTokens(rt),
  limiter = sharedLimiter,
  maxRetries = 3,
  backoffMs = 1000,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  onWarning = null, // (msg) => void — parse warnings (missing keys, odd shapes)
} = {}) {
  if (typeof getTokens !== 'function') throw new Error('createClient: getTokens required');
  let refreshing = null;

  async function doRefresh(tokens) {
    if (!refreshing) {
      refreshing = (async () => {
        if (!tokens || !tokens.refresh_token) throw new YahooError('Yahoo not connected', 401, 'not_connected');
        const next = await refresh(tokens.refresh_token);
        const merged = { ...tokens, ...next, xoauth_yahoo_guid: next.xoauth_yahoo_guid || tokens.xoauth_yahoo_guid || null };
        if (saveTokens) await saveTokens(merged);
        return merged;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function currentTokens() {
    const t = await getTokens();
    if (!t || !t.access_token) throw new YahooError('Yahoo not connected', 401, 'not_connected');
    if (t.expires_at && t.expires_at - 60 * 1000 < Date.now()) return doRefresh(t);
    return t;
  }

  async function request(path) {
    const url = `${BASE}/${path}${path.includes('?') ? '&' : '?'}format=json`;
    let tokens = await currentTokens();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await limiter(() => fetchImpl(url, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
      }));
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        tokens = await doRefresh(tokens);
        attempt--; // the refresh retry doesn't count against backoff budget
        continue;
      }
      if ((res.status === 429 || res.status === 999 || res.status >= 500) && attempt < maxRetries) {
        const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs * 2 ** attempt);
        continue;
      }
      const body = await readBody(res);
      if (!res.ok) {
        const desc = errorDescription(body);
        throw new YahooError(`Yahoo API ${res.status}${desc ? `: ${desc}` : ''}`, res.status === 999 ? 429 : res.status);
      }
      if (typeof body === 'string') {
        // 200 with a non-JSON body: Yahoo ignored ?format=json, or a proxy page.
        const desc = errorDescription(body);
        throw new YahooError(`Yahoo returned a non-JSON body${desc ? `: ${desc}` : ''}`, 502, 'bad_format');
      }
      return body;
    }
  }

  // Run a parser, routing its warnings to onWarning; a parse failure becomes a
  // YahooError (502) instead of a TypeError deep in the router.
  function parse(fn, json) {
    try { return P.capture(() => fn(json), onWarning); } catch (e) {
      throw new YahooError(`Yahoo response not understood: ${e.message}`, 502, e.code || 'bad_response');
    }
  }

  const gameKeyCache = new Map(); // code -> { key, expires }

  async function getGameKey(code = 'nba') {
    const c = gameKeyCache.get(code);
    if (c && c.expires > Date.now()) return c.key;
    const g = parse(P.parseGame, await request(`game/${encodeURIComponent(code)}`));
    if (!g.game_key) throw new YahooError(`Yahoo returned no game key for "${code}"`, 502, 'bad_response');
    gameKeyCache.set(code, { key: g.game_key, expires: Date.now() + 6 * 60 * 60 * 1000 });
    return g.game_key;
  }

  async function getUserLeagues(gameKey) {
    const gk = gameKey || await getGameKey('nba');
    return parse(P.parseUserLeagues, await request(`users;use_login=1/games;game_keys=${encodeURIComponent(gk)}/leagues`)).leagues;
  }

  async function getGameWeeks(gameKey) {
    return parse(P.parseGameWeeks, await request(`game/${encodeURIComponent(gameKey)}/game_weeks`));
  }

  async function getLeague(leagueKey) {
    const league = parse(P.parseLeague, await request(`league/${encodeURIComponent(leagueKey)}/settings`));
    const gameKey = String(leagueKey).split('.l.')[0];
    let weeks = [];
    try {
      weeks = (await getGameWeeks(gameKey)).filter(w =>
        (league.start_week == null || w.week >= league.start_week) && (league.end_week == null || w.week <= league.end_week));
    } catch (e) {
      if (e.status === 401) throw e; // other failures: settings are still useful without dates
    }
    const s = league.settings || {};
    return {
      ...league,
      scoring_type: league.scoring_type || s.scoring_type || null,
      draft_type: s.draft_type || null,
      is_auction_draft: !!s.is_auction_draft,
      draft_pick_time: s.draft_pick_time ?? null,
      roster_positions: s.roster_positions || [],
      stat_categories: s.stat_categories || [],
      stat_modifiers: s.stat_modifiers || [],
      weeks,
    };
  }

  async function getDraftResults(leagueKey) {
    const d = parse(P.parseDraftResults, await request(`league/${encodeURIComponent(leagueKey)}/draftresults`));
    return { league_key: d.league_key, draft_status: d.draft_status, picks: d.picks };
  }

  async function getTeams(leagueKey) {
    return parse(P.parseTeams, await request(`league/${encodeURIComponent(leagueKey)}/teams`));
  }

  async function getRoster(teamKey, week) {
    const w = week != null && week !== '' ? `;week=${encodeURIComponent(week)}` : '';
    return parse(P.parseRoster, await request(`team/${encodeURIComponent(teamKey)}/roster${w}`));
  }

  async function getPlayers(leagueKey, { start = 0, count = 25, status } = {}) {
    let m = `;start=${Number(start) || 0};count=${Math.min(Number(count) || 25, 25)}`;
    if (status) m += `;status=${encodeURIComponent(status)}`;
    return parse(P.parsePlayers, await request(`league/${encodeURIComponent(leagueKey)}/players${m}`));
  }

  async function getPlayersByKeys(leagueKey, keys) {
    const out = [];
    const uniq = [...new Set(keys.filter(Boolean))];
    for (let i = 0; i < uniq.length; i += 25) {
      const chunk = uniq.slice(i, i + 25).map(encodeURIComponent).join(',');
      out.push(...parse(P.parsePlayers, await request(`league/${encodeURIComponent(leagueKey)}/players;player_keys=${chunk}`)));
    }
    return out;
  }

  return { request, getGameKey, getUserLeagues, getGameWeeks, getLeague, getDraftResults, getTeams, getRoster, getPlayers, getPlayersByKeys };
}

module.exports = { createClient, createLimiter, YahooError, BASE, readBody, errorDescription };
