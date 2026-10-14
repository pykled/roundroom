#!/usr/bin/env node
/* Dev-only mock server for the NBA trade calculator (stream E). Uses the real
   offline model (data/nba snapshot) and the real nba/routes/trade.js; only
   Yahoo and Clerk are faked.

   Usage
     node scripts/nba-trade-mock.js [--port=0] [--yahoo=off|on]
       off  /api/nba/yahoo/status → { connected:false } (manual mode)
       on   connected; one 10-team league built by snake-drafting the board,
            one Yahoo player per team left unmatched
   Runtime switch: POST /__mock/mode?yahoo=on|off
   /nba/auth/login simulates connecting (mode → on) and redirects to /nba/trade. */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const path = require('path');
const express = require('express');
const model = require('../nba/model');
const createTradeRoutes = require('../nba/routes/trade');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
let mode = arg('yahoo', 'off');

const LK = '466.l.4242';
const TEAM_NAMES = ['Dunk Dynasty', 'Pick and Pop', 'Splash Zone', 'Glass Cleaners', 'The Hoopers', 'Fast Break FC', 'Board Men', 'And One', 'Triple Double', 'Bench Mob'];

let leagueCache = null;
async function league() {
  if (leagueCache) return leagueCache;
  const { players } = await model.getPlayers({});
  const pool = players.slice().sort((a, b) => a.rank - b.rank);
  const teams = TEAM_NAMES.map((name, i) => ({ team_key: `${LK}.t.${i + 1}`, name, is_owned_by_current_login: i === 2, players: [] }));
  for (let r = 1; r <= 10; r++) {
    for (let k = 0; k < 10; k++) {
      const slot = r % 2 ? k : 9 - k;
      const p = pool[(r - 1) * 10 + k];
      teams[slot].players.push({ player_key: `466.p.${p.id}`, name: { full: p.name }, selected_position: r <= 6 ? 'Util' : 'BN', status: p.injury || null });
    }
  }
  teams[4].players.push({ player_key: '466.p.99999', name: { full: 'Two-Way Guy' }, selected_position: 'IL', status: 'INJ' });
  leagueCache = { pool, teams };
  return leagueCache;
}

const fakeClient = () => ({
  async getLeague() {
    return { league_key: LK, name: 'Pocket High Score League', num_teams: 10, current_week: 1, start_week: 1, end_week: 24, scoring_type: 'headpoint',
      settings: { uses_playoff: true, playoff_start_week: 22 },
      roster_positions: [{ position: 'G', count: 2 }, { position: 'F', count: 3 }, { position: 'Util', count: 1 }, { position: 'BN', count: 4 }, { position: 'IL', count: 2 }] };
  },
  async getTeams() { return (await league()).teams.map(({ players, ...t }) => t); },
  async getRoster(tk) { const t = (await league()).teams.find(x => x.team_key === tk); return { team: {}, players: t ? t.players : [] }; },
  async getPlayersByKeys(lk, keys) { const all = (await league()).teams.flatMap(t => t.players); return keys.map(k => all.find(p => p.player_key === k)).filter(Boolean); },
});

const app = express();
const cache = new Map();
const apiCached = async (k, ttl, fn) => { const h = cache.get(k); if (h && Date.now() - h.t < ttl) return h.v; const v = await fn(); cache.set(k, { v, t: Date.now() }); return v; };
const modelPlayers = () => apiCached('players', 10 * 60 * 1000, () => model.getPlayers({}));

app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/nba/auth/login', (req, res) => { mode = 'on'; res.redirect('/nba/trade'); });
app.post('/__mock/mode', (req, res) => { mode = req.query.yahoo === 'on' ? 'on' : 'off'; res.json({ mode }); });
app.get('/api/nba/players', async (req, res) => res.json(await modelPlayers()));
app.get('/api/nba/yahoo/status', (req, res) => res.json(mode === 'on'
  ? { connected: true, leagues: [{ league_key: LK, name: 'Pocket High Score League', num_teams: 10, draft_status: 'postdraft' }] }
  : { connected: false }));
app.use(createTradeRoutes({
  auth: (req, res, next) => (mode === 'on' ? next() : res.status(401).json({ error: 'Unauthorized' })),
  getAuth: () => ({ userId: mode === 'on' ? 'mock-user' : null }),
  apiCached, modelPlayers,
  matcher: async () => {
    const { players } = await modelPlayers();
    const byName = new Map(players.map(p => [p.name, p]));
    return yp => { const p = byName.get(yp.name.full); return p ? { sleeperId: String(p.id), matchConfidence: 0.95 } : { sleeperId: null, matchConfidence: 0 }; };
  },
  clientFor: fakeClient,
  sendYahooError: (res, err) => res.status(502).json({ error: 'Yahoo request failed: ' + err.message }),
  env: {},
}));
app.use('/nba/pages', express.static(path.join(ROOT, 'nba/pages')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.get('/favicon.png', (req, res) => res.sendFile(path.join(ROOT, 'favicon.png')));
app.get(['/nba', '/nba/draft'], (req, res) => res.sendFile(path.join(ROOT, 'nba/pages/draft.html')));

const server = app.listen(Number(arg('port', 0)), '127.0.0.1', () => {
  console.log(`nba trade mock on http://127.0.0.1:${server.address().port}/nba/trade (yahoo=${mode})`);
});
