#!/usr/bin/env node
/* Dev-only mock server for the NBA team page (Stream C). Boots the REAL NBA
   router (nba/router.js, incl. nba/routes/team.js and the real offline model)
   with a fake Sleeper client that serves the recorded fixtures of Dillon's league
   (docs/nba-spec/fixtures/sleeper-*.json). Nothing touches the network.

   Usage
     node scripts/nba-team-mock.js [--port=0]
   Runtime switch (handy for screenshots; resets the cache):
     POST /__mock/mode?api=ok|ratelimit|down&leagues=one|zero|cats&user=pykle|stranger
       api       ok | ratelimit (league endpoints 429) | down (every Sleeper call 502)
       leagues   one (HALIMSANITY 26-27) | zero (user has no NBA leagues) | cats (plus a categories league, listed first)
       user      pykle (owns roster 1) | stranger (resolves, but owns no team in the league)
   Usernames: "nobody" → 404. Everything else resolves to the chosen mode's user. */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const path = require('path');
const express = require('express');
const { SleeperError } = require('../nba/sleeper/client');
const createNbaRouter = require('../nba/router');

const ROOT = path.join(__dirname, '..');
const FX = path.join(ROOT, 'docs', 'nba-spec', 'fixtures');
const fx = n => JSON.parse(require('fs').readFileSync(path.join(FX, n), 'utf8'));
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };

const LEAGUE = fx('sleeper-league.json'), USERS = fx('sleeper-users.json'), ROSTERS = fx('sleeper-rosters.json'), STATE = fx('sleeper-state.json');
const CATS = { ...LEAGUE, league_id: '1411447094215990001', name: 'Category Crew', settings: { ...LEAGUE.settings, scoring_type: 'h2h_category' }, draft_id: null };
const USER = { pykle: { user_id: '1044077615075872768', username: 'pykle', display_name: 'pykle', avatar: '660f972bc0a83a4d810ff349114d8bc1' },
  stranger: { user_id: '999000111222333444', username: 'stranger', display_name: 'stranger', avatar: null } };

const mode = { api: 'ok', leagues: 'one', user: 'pykle' };
const cache = new Map();
const calls = {};

function gate(kind) {
  calls[kind] = (calls[kind] || 0) + 1;
  if (mode.api === 'down') throw new SleeperError('Sleeper unreachable', { status: null, code: 'sleeper_upstream' });
  if (mode.api === 'ratelimit' && !['user', 'userLeagues', 'state'].includes(kind)) throw new SleeperError('Sleeper rate limit', { status: 429, code: 'sleeper_rate_limited', retryAfterS: 5 });
}
const fake = {
  async state() { gate('state'); return STATE; },
  async user(u) { gate('user'); return String(u).toLowerCase() === 'nobody' ? null : USER[mode.user]; },
  async userLeagues() { gate('userLeagues'); return mode.leagues === 'zero' ? [] : mode.leagues === 'cats' ? [CATS, LEAGUE] : [LEAGUE]; },
  async league(id) { gate('league'); return id === LEAGUE.league_id ? LEAGUE : id === CATS.league_id ? CATS : null; },
  async leagueUsers() { gate('users'); return USERS; },
  async leagueRosters() { gate('rosters'); return ROSTERS; },
  async leagueDrafts() { gate('drafts'); return []; },
  async leagueMatchups() { gate('matchups'); return []; },
  async draft() { gate('draft'); return null; },
  async draftPicks() { gate('picks'); return []; },
  async draftTradedPicks() { gate('traded'); return []; },
};

const apiCached = async (k, ttl, fn) => { const h = cache.get(k); if (h && Date.now() - h.t < ttl) return h.v; const v = await fn(); cache.set(k, { v, t: Date.now() }); return v; };
const app = express();
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.post('/__mock/mode', (req, res) => {
  for (const k of ['api', 'leagues', 'user']) if (req.query[k]) mode[k] = String(req.query[k]);
  for (const k of [...cache.keys()]) if (!k.startsWith('nba:players') && !k.startsWith('nba:team:board')) cache.delete(k);
  res.json({ mode, calls });
});
app.get('/__mock/calls', (req, res) => res.json(calls));
app.use('/', createNbaRouter({
  auth: (req, res) => res.status(401).json({ error: 'Sign in required' }), getAuth: () => ({ userId: null }), db: null, apiCached,
  env: { NBA_YAHOO_ENABLED: '' }, log: { error: () => {}, warn: () => {}, info: () => {}, log: () => {} }, sleeperClient: fake,
}));
app.get('/favicon.png', (req, res) => res.sendFile(path.join(ROOT, 'favicon.png')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use('/nba/pages', express.static(path.join(ROOT, 'nba', 'pages')));

const server = app.listen(Number(arg('port', 0)), '127.0.0.1', () => {
  console.log(`nba team mock on http://127.0.0.1:${server.address().port}/nba/team`);
});
