#!/usr/bin/env node
/* Dev-only mock server for the NBA waivers page (stream F). Serves nba/pages/*
   and /shared/*, the REAL model board (offline snapshot) and the REAL waivers
   routes, with a fake Yahoo client and fake auth.

   Usage
     node scripts/nba-waivers-mock.js [--port=0] [--yahoo=off|on]
       off  status.connected = false → manual mode
       on   connected, one league; my roster has an injured star; ~150 free agents
   Runtime switch: POST /__mock/mode?yahoo=on|off
   Demo only: a few free agents get synthetic "minutes up" logs so the ROLE ↑
   badge shows (preseason data has no fresh games). */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const path = require('path');
const express = require('express');
const ROOT = path.join(__dirname, '..');
const Model = require(path.join(ROOT, 'nba/model'));
const Data = require(path.join(ROOT, 'nba/model/data'));
const waiversRoutes = require(path.join(ROOT, 'nba/routes/waivers'));

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
let mode = arg('yahoo', 'off');
const LK = '466.l.777';
const TK = LK + '.t.3';
const ROSTER_RANKS = [3, 14, 22, 31, 47, 58, 66, 130, 170, 210];
const INJURED_RANK = 14;

const boardP = {};
// L1: routes pass the league profile id (null → legacy High Score board).
function board(profile) {
  const k = profile || '-';
  if (!boardP[k]) boardP[k] = Model.getPlayers({ profile: profile || undefined }).then(b => {
    const players = b.players.map(p => ({ ...p }));
    const star = players[INJURED_RANK];
    star.injury = 'Out';
    star.hsByWeek = { ...star.hsByWeek, 1: 0, 2: 0 };
    return { ...b, players };
  });
  return boardP[k];
}
const yahooShape = (p, i) => ({
  player_key: '466.p.' + (5000 + i), player_id: String(5000 + i), name: { full: p.name },
  editorial_team_abbr: p.team, display_position: (p.pos || []).join(','), eligible_positions: p.pos || [],
});

async function fakeClient() {
  const b = await board();
  const roster = ROSTER_RANKS.map(i => b.players[i]);
  const rosterSet = new Set(roster);
  const fas = b.players.slice(100, 260).filter(p => !rosterSet.has(p));
  const faY = fas.map((p, i) => yahooShape(p, i));
  faY.splice(7, 0, { player_key: '466.p.9001', name: { full: 'Two-Way Prospect' }, editorial_team_abbr: 'SAC', display_position: 'SG', eligible_positions: ['SG'] });
  return {
    async getRoster() { return { players: roster.map((p, i) => yahooShape(p, 900 + i)) }; },
    async getPlayers(lk, { start = 0, status }) {
      if (status === 'W') return faY.slice(0, 3);
      return faY.slice(3 + start, 3 + start + 25);
    },
    async getLeague() {
      return {
        roster_positions: [{ position: 'G', count: 2 }, { position: 'F', count: 3 }, { position: 'Util', count: 1 }, { position: 'BN', count: 4 }],
        settings: { waiver_type: 'R', waiver_rule: 'all', uses_faab: '1', waiver_time: '2' },
        weeks: [],
      };
    },
  };
}

// Synthetic recent logs for a handful of free agents (ROLE ↑ demo).
let demoData = null;
async function loadData() {
  if (demoData) return demoData;
  const real = Data.load();
  const b = await board();
  const today = Math.floor(Date.now() / 86400000);
  const players = {};
  for (const i of [104, 117, 131, 150, 176]) {
    const g = [];
    for (let k = 0; k < 30; k++) g.push([today - 62 + k * 2, 1, k < 25 ? 24 : 33, k < 25 ? 21 : 30.5]);
    players[b.players[i].id] = { t: b.players[i].team, rw: {}, g };
  }
  demoData = { ...real, logs: [...real.logs, { season: 'demo', players }] };
  return demoData;
}

const app = express();
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use('/nba/pages', express.static(path.join(ROOT, 'nba/pages')));
app.get('/favicon.png', (req, res) => res.status(204).end());
app.post('/__mock/mode', (req, res) => { if (req.query.yahoo) mode = String(req.query.yahoo); res.json({ mode }); });
app.get('/api/nba/players', async (req, res) => res.json(await board('242808')));
app.get('/api/nba/yahoo/status', (req, res) => res.json(mode === 'on'
  ? { connected: true, leagues: [{ league_key: LK, name: 'Pocket High Score', num_teams: 10, draft_status: 'postdraft' }] }
  : { connected: false }));
app.get('/api/nba/yahoo/league', (req, res) => res.json({ league: { name: 'Pocket High Score' }, teams: [], myTeamKey: TK }));
app.get('/nba/auth/login', (req, res) => { mode = 'on'; res.redirect('/nba/waivers'); });

let cachedData = null;
app.use(async (req, res, next) => { if (!cachedData) cachedData = await loadData(); next(); });
app.use(waiversRoutes({
  auth: (req, res, next) => (mode === 'on' ? next() : res.status(401).json({ error: 'Sign in' })),
  getAuth: () => ({ userId: 'mock-user' }),
  apiCached: async (k, t, fn) => fn(),
  loadModel: () => Model,
  modelPlayers: (week, profile) => board(profile),
  clientFor: () => {
    const p = fakeClient();
    return new Proxy({}, { get: (_, k) => async (...a) => (await p)[k](...a) });
  },
  sendYahooError: (res, err) => res.status(502).json({ error: String(err && err.message) }),
  loadData: () => cachedData,
  env: {},
}));

const port = Number(arg('port', 0));
const srv = app.listen(port, '127.0.0.1', () => console.log(`nba waivers mock on http://127.0.0.1:${srv.address().port}/nba/waivers (yahoo=${mode})`));
