#!/usr/bin/env node
/* Dev-only mock server for the NBA trade calculator (v2). Mounts the REAL NBA
   router (nba/router.js: trade routes, /api/nba/players, Sleeper sync) on the
   offline model snapshot; only the Sleeper API is faked, with the recorded
   fixtures of Dillon's league (docs/nba-spec/fixtures: league 1411447094215991296,
   12 rosters, users, state). Nothing leaves the machine.

   Usage
     node scripts/nba-trade-mock.js [--port=0] [--sleeper=ok|down]
       ok    the fake Sleeper answers from the fixtures (user "pykle" owns roster 1)
       down  every Sleeper call fails with a 503 (outage path)
   Runtime switch: POST /__mock/mode?sleeper=ok|down
   Connected mode is client-side: set localStorage['pocket-nba-sleeper'] =
   {"username":"pykle","userId":"1044077615075872768"} (the screenshot script does). */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const path = require('path');
const fs = require('fs');
const express = require('express');
const createNbaRouter = require('../nba/router');
const { SleeperError } = require('../nba/sleeper/client');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'docs', 'nba-spec', 'fixtures');
const fx = n => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
let mode = arg('sleeper', 'ok');

const LEAGUE = fx('sleeper-league.json');
const USERS = fx('sleeper-users.json');
const ROSTERS = fx('sleeper-rosters.json');
const STATE = fx('sleeper-state.json');
const ME = { user_id: '1044077615075872768', username: 'pykle', display_name: 'pykle', avatar: null };
const DRAFT = { draft_id: String(LEAGUE.draft_id), league_id: LEAGUE.league_id, type: 'snake', status: 'complete', season: '2026', created: 1, start_time: 1,
  settings: { teams: 12, rounds: 13, pick_timer: 30, reversal_round: 3 }, metadata: { scoring_type: 'points' } };

const up = () => { if (mode === 'down') throw new SleeperError('Sleeper HTTP 503', { status: 503, code: 'sleeper_upstream' }); };
const sleeperClient = {
  state: async () => { up(); return STATE; },
  user: async u => { up(); return String(u).toLowerCase() === 'pykle' || String(u) === ME.user_id ? ME : null; },
  userLeagues: async uid => { up(); return String(uid) === ME.user_id ? [LEAGUE] : []; },
  league: async id => { up(); return String(id) === LEAGUE.league_id ? LEAGUE : null; },
  leagueUsers: async id => { up(); return String(id) === LEAGUE.league_id ? USERS : []; },
  leagueRosters: async id => { up(); return String(id) === LEAGUE.league_id ? ROSTERS : []; },
  leagueDrafts: async () => { up(); return [DRAFT]; },
  leagueMatchups: async () => { up(); return []; },
  draft: async id => { up(); return String(id) === DRAFT.draft_id ? DRAFT : null; },
  draftPicks: async () => { up(); return []; },
  draftTradedPicks: async () => { up(); return []; },
};

const app = express();
const cache = new Map();
const apiCached = async (k, ttl, fn) => { const h = cache.get(k); if (h && Date.now() - h.t < ttl) return h.v; const v = await fn(); cache.set(k, { v, t: Date.now() }); return v; };
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.post('/__mock/mode', (req, res) => { mode = req.query.sleeper === 'down' ? 'down' : 'ok'; cache.clear(); res.json({ mode }); });
app.use('/', createNbaRouter({
  auth: (req, res) => res.status(401).json({ error: 'Sign in required' }), getAuth: () => ({ userId: null }),
  apiCached, env: { NBA_YAHOO_ENABLED: '' }, sleeperClient, log: { error() {}, warn() {}, log() {} },
}));
app.use('/nba/pages', express.static(path.join(ROOT, 'nba/pages')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.get('/favicon.png', (req, res) => res.sendFile(path.join(ROOT, 'favicon.png')));

const server = app.listen(Number(arg('port', 0)), '127.0.0.1', () => {
  console.log(`nba trade mock on http://127.0.0.1:${server.address().port}/nba/trade (sleeper=${mode})`);
});
