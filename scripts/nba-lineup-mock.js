#!/usr/bin/env node
/* Dev-only mock server for the NBA lineup picker (stream D). Kept separate from
   scripts/nba-ui-mock.js (stream C) to avoid merge conflicts. Serves the pages
   and /shared, the REAL model (offline snapshot) at /api/nba/players, and the
   REAL lineup routes (nba/routes/lineup.js) wired to a fake signed-in user and
   a fake Yahoo client whose rosters are built from model player names.

   Usage
     node scripts/nba-lineup-mock.js [--port=0] [--yahoo=off|on]
   Runtime switch: POST /__mock/mode?yahoo=on|off
   /nba/auth/login simulates connecting Yahoo (mode → on) and redirects to /nba/lineup. */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const path = require('path');
const express = require('express');
const model = require('../nba/model');
const createLineupRoutes = require('../nba/routes/lineup');
const { YahooError } = require('../nba/yahoo/client');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
let mode = arg('yahoo', 'off');

const LEAGUE = '466.l.777', ME = LEAGUE + '.t.1', RIVAL = LEAGUE + '.t.2';
// [model player name, Yahoo selected_position]
const MY_ROSTER = [
  ['Luka Dončić', 'G'], ['Tyrese Maxey', 'G'], ['Victor Wembanyama', 'F'], ['Evan Mobley', 'F'], ['Paolo Banchero', 'F'],
  ['Stephen Curry', 'Util'], ['Cooper Flagg', 'BN'], ['Jalen Johnson', 'BN'], ['Josh Giddey', 'BN'], ['Zztop Notaplayer', 'BN'],
];
const RIVAL_ROSTER = [
  ['Nikola Jokić', 'F'], ['Cade Cunningham', 'G'], ['LaMelo Ball', 'G'], ['Scottie Barnes', 'F'], ['Alperen Şengün', 'F'],
  ['Donovan Mitchell', 'Util'], ['Karl-Anthony Towns', 'BN'], ['Jamal Murray', 'BN'], ['Deni Avdija', 'BN'], ['Bam Adebayo', 'BN'],
];
let boardCache = null;
// Mock Yahoo players are matched against the default-profile (242808) board.
async function board() { return boardCache || (boardCache = (await model.getPlayers({ profile: '242808' })).players); }
function yahooPlayer(name, sel, i, players) {
  const p = players.find(x => x.name === name);
  return {
    player_key: `466.p.${9000 + i}`, player_id: String(9000 + i), name: { full: name },
    editorial_team_abbr: p ? p.team : 'FA', display_position: p ? p.pos.join(',') : 'SF',
    eligible_positions: p ? p.pos : ['SF'], selected_position: sel,
  };
}
const fakeClient = () => ({
  async getRoster(tk) {
    if (mode !== 'on') throw new YahooError('Yahoo not connected', 401, 'not_connected');
    const players = await board();
    const src = tk === ME ? MY_ROSTER : RIVAL_ROSTER;
    return { team: { team_key: tk, name: tk === ME ? 'Dillon’s Dimes' : 'Sengun Sunday' }, players: src.map(([n, s], i) => yahooPlayer(n, s, i + (tk === ME ? 0 : 50), players)) };
  },
  async request() { return { matchup: { teams: [{ team_key: ME }, { team_key: RIVAL }] } }; },
});

const app = express();
app.set('trust proxy', false);
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/nba/lineup', (req, res) => res.sendFile(path.join(ROOT, 'nba/pages/lineup.html')));
app.get(['/nba', '/nba/draft'], (req, res) => res.sendFile(path.join(ROOT, 'nba/pages/draft.html')));
app.use('/nba/pages', express.static(path.join(ROOT, 'nba/pages')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.get('/favicon.png', (req, res) => res.sendFile(path.join(ROOT, 'favicon.png')));
app.get('/nba/auth/login', (req, res) => { mode = 'on'; res.redirect('/nba/lineup'); });

// L1: routes pass the league profile id (null → legacy High Score board).
const modelPlayers = (week, profile) => model.getPlayers({ week: week || undefined, profile: profile || undefined });
app.get('/api/nba/players', async (req, res) => res.json(await modelPlayers(Number(req.query.week) || null)));
app.get('/api/nba/yahoo/status', (req, res) => res.json(mode === 'on'
  ? { connected: true, leagues: [{ league_key: LEAGUE, name: 'High Score Homies', num_teams: 10, draft_status: 'postdraft' }] }
  : { connected: false }));
app.get('/api/nba/yahoo/league', (req, res) => {
  if (mode !== 'on') return res.status(409).json({ error: 'Yahoo not connected', code: 'yahoo_not_connected' });
  res.json({ league: { league_key: LEAGUE, name: 'High Score Homies', current_week: 2 }, teams: [{ team_key: ME, name: 'Dillon’s Dimes', is_owned_by_current_login: true }, { team_key: RIVAL, name: 'Sengun Sunday' }], myTeamKey: ME });
});
app.use(createLineupRoutes({
  auth: (req, res, next) => next(), getAuth: () => ({ userId: 'mock_user' }),
  apiCached: (k, ttl, fn) => fn(), loadModel: () => model, modelPlayers, clientFor: fakeClient,
  sendYahooError: (res, err) => res.status(err.code === 'not_connected' ? 409 : 502).json({ error: err.message, code: err.code === 'not_connected' ? 'yahoo_not_connected' : undefined }),
  rate: { windowMs: 60000, max: 1000 },
}));
app.post('/__mock/mode', (req, res) => { if (req.query.yahoo) mode = req.query.yahoo; res.json({ mode }); });

const server = app.listen(Number(arg('port', 0)), '127.0.0.1', () => {
  console.log(`nba-lineup-mock listening on http://127.0.0.1:${server.address().port}/nba/lineup  (yahoo=${mode})`);
});
