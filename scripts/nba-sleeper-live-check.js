#!/usr/bin/env node
/* Read-only check of the Sleeper-first NBA API against the REAL Sleeper API
   (no mocks, no auth, nothing written anywhere). Boots the NBA router with the
   real model on an ephemeral port and walks the whole read path for one
   username. Prints the shapes it saw; exit 1 on any failed check.

     node scripts/nba-sleeper-live-check.js [--user=pykle] [--keep] [--port=0]

   --keep leaves the server running (prints the base URL) so a Playwright run
   can screenshot /nba against real data: scripts/nba-sleeper-screens.py --real. */
'use strict';
const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const USER = arg('user', 'pykle');
const KEEP = process.argv.includes('--keep');

const createNbaRouter = require('../nba/router');
const cache = new Map();
const apiCached = async (key, ttl, fn) => { const e = cache.get(key); if (e && e.exp > Date.now()) return e.v; const v = await fn(); cache.set(key, { v, exp: Date.now() + ttl }); return v; };
const getAuth = () => ({ userId: null });
const auth = (req, res) => res.status(401).json({ error: 'Sign in required' });

const app = express();
app.use(compression());
app.use('/', createNbaRouter({ auth, getAuth, db: null, apiCached, env: { ...process.env, NBA_YAHOO_ENABLED: '' }, log: console }));
app.get('/', (req, res) => res.send('HOME'));
app.use(express.static(ROOT));

let fails = 0, n = 0;
const check = (name, ok, detail) => { n++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); if (!ok) fails++; };
const sample = (o, keys) => JSON.stringify(Object.fromEntries(keys.filter(k => o && k in o).map(k => [k, o[k]])));

(async () => {
  const srv = await new Promise(r => { const s = app.listen(Number(arg('port', 0)), '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async p => { const r = await fetch(base + p); let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j }; };
  const report = { base, user: USER, at: new Date().toISOString(), steps: {} };
  try {
    const health = await get('/api/nba/health');
    check('health: sleeper on, yahoo off', health.status === 200 && health.json.sleeper === true && health.json.yahooEnabled === false, JSON.stringify(health.json));
    check('yahoo status answers disabled (no 500)', (await get('/api/nba/yahoo/status')).json.code === 'yahoo_disabled');
    check('yahoo draft endpoint 410', (await get('/api/nba/yahoo/draft?league_key=466.l.1')).status === 410);
    check('old OAuth link redirects to /nba?connect=sleeper', (await fetch(base + '/nba/auth/login', { redirect: 'manual' })).headers.get('location') === '/nba?connect=sleeper');

    const bad = await get('/api/nba/sleeper/user?username=pocketnba_nouser_x9');
    check('unknown username → 404 sleeper_user_not_found', bad.status === 404 && bad.json.code === 'sleeper_user_not_found', JSON.stringify(bad.json));
    check('bad username chars → 400', (await get('/api/nba/sleeper/user?username=%3Cscript%3E')).status === 400);

    const u = await get('/api/nba/sleeper/user?username=' + encodeURIComponent(USER));
    check('user resolves', u.status === 200 && /^\d+$/.test(String(u.json && u.json.user_id)), sample(u.json, ['user_id', 'username', 'display_name']));
    report.steps.user = u.json;
    const uid = u.json.user_id;

    const ls = await get('/api/nba/sleeper/leagues?user_id=' + uid);
    check('leagues: current season + list', ls.status === 200 && /^\d{4}$/.test(ls.json.season) && Array.isArray(ls.json.leagues), 'season=' + ls.json.season + ' n=' + (ls.json.leagues || []).length);
    report.steps.leagues = ls.json;
    for (const l of ls.json.leagues || []) console.log('       league', sample(l, ['league_id', 'name', 'num_teams', 'draft_status', 'draft_type', 'scoring_type', 'rounds', 'pick_timer', 'reversal_round', 'draft_start']));
    const lg = (ls.json.leagues || [])[0];
    if (!lg) { check('a league to test with', false, 'user has no NBA leagues this season'); }
    else {
      const L = await get('/api/nba/sleeper/league?league_id=' + lg.league_id + '&user_id=' + uid);
      check('league: teams + myTeamKey + draft meta', L.status === 200 && Array.isArray(L.json.teams) && L.json.teams.length === lg.num_teams && L.json.draft && L.json.draft.draft_id,
        sample(L.json, ['myTeamKey', 'mySlot']) + ' draft=' + sample(L.json.draft, ['status', 'type', 'teams', 'rounds', 'pick_timer', 'reversal_round']));
      check('every team has a draft_position when the order is set', !L.json.draft.slot_to_roster_id || L.json.teams.every(t => t.draft_position >= 1));
      report.steps.league = L.json;

      const D = await get('/api/nba/sleeper/draft?draft_id=' + L.json.draft.draft_id);
      check('draft: status/picks/order', D.status === 200 && ['predraft', 'drafting', 'postdraft'].includes(D.json.status) && Array.isArray(D.json.picks) && Array.isArray(D.json.order),
        'status=' + D.json.status + ' picks=' + D.json.picks.length + ' unmatched=' + D.json.unmatched.length + ' order=' + D.json.order.length);
      const total = (L.json.draft.teams || 0) * (L.json.draft.rounds || 0);
      check('picks + remaining order cover every pick exactly once', D.json.picks.length + D.json.order.length === total && new Set(D.json.picks.map(p => p.pick).concat(D.json.order.map(o => o.pick))).size === total, `total=${total}`);
      const matched = D.json.picks.filter(p => p.sleeperId).length;
      check('pick ↔ model id coverage ≥ 95%', D.json.picks.length === 0 || matched / D.json.picks.length >= 0.95, `${matched}/${D.json.picks.length} matched; unmatched: ${D.json.unmatched.map(x => x.name + '(' + x.player_key + ')').join(', ') || 'none'}`);
      check('picks carry team_key (roster) + round + name', D.json.picks.every(p => p.team_key && p.round >= 1 && p.name));
      if (D.json.picks.length) console.log('       pick sample', JSON.stringify(D.json.picks[0]));
      report.steps.draft = { ...D.json, picks: D.json.picks.slice(0, 3), order: D.json.order.slice(0, 3) };
      // 3RR check against Sleeper's own draft_slot on real picks.
      const M = require('../nba/sleeper/map');
      const rr = L.json.draft.reversal_round, tm = L.json.draft.teams;
      const bad3 = D.json.picks.filter(p => p.draft_slot && M.slotForPick(p.pick, tm, rr, L.json.draft.type) !== p.draft_slot).length;
      check(`reversal_round=${rr}: slotForPick matches Sleeper draft_slot on every real pick`, bad3 === 0, 'mismatches=' + bad3);

      const R = await get('/api/nba/sleeper/rosters?league_id=' + lg.league_id + '&user_id=' + uid);
      check('rosters: players matched to the board', R.status === 200 && R.json.teams.length === lg.num_teams, 'unmatched=' + R.json.unmatched.length + (R.json.unmatched.length ? ' ' + R.json.unmatched.slice(0, 5).map(x => x.player_key).join(',') : ''));
      const me = R.json.teams.find(t => t.mine);
      check('my roster found', !!me, me && `${me.name}: ${me.players.length} players`);
      if (me) {
        const mu = await get(`/api/nba/sleeper/matchup?league_id=${lg.league_id}&roster_id=${me.team_key}&week=1`);
        check('matchup week 1 answers', mu.status === 200, JSON.stringify(mu.json));
        const ln = await get(`/api/nba/lineup?league_id=${lg.league_id}&roster_id=${me.team_key}&week=1&user_id=${uid}`);
        check('lineup (Sleeper roster) builds', ln.status === 200 && ln.json.source === 'sleeper' && Array.isArray(ln.json.slots) && ln.json.slots.length > 0, ln.status === 200 ? `slots=${ln.json.slots.length} bench=${ln.json.bench.length} opp=${ln.json.matchup ? ln.json.matchup.opponentName : 'none'} unmatched=${ln.json.unmatched.length}` : JSON.stringify(ln.json));
        const tc = await get(`/api/nba/trade/context?league_id=${lg.league_id}&user_id=${uid}`);
        check('trade context (Sleeper rosters)', tc.status === 200 && tc.json.source === 'sleeper' && tc.json.myTeamKey === me.team_key && tc.json.league.settings.slots, tc.status === 200 ? `teams=${tc.json.teams.length} slots=${JSON.stringify(tc.json.league.settings.slots)}` : JSON.stringify(tc.json));
        const mine = tc.json.teams.find(t => t.mine);
        const other = tc.json.teams.find(t => !t.mine);
        if (mine && other) {
          const ev = await fetch(base + '/api/nba/trade/evaluate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ give: [mine.players[0].sleeperId], get: [other.players[0].sleeperId], myRoster: mine.players.map(p => p.sleeperId).filter(Boolean), partnerRoster: other.players.map(p => p.sleeperId).filter(Boolean), sleeper_league_id: lg.league_id }) });
          const ej = await ev.json();
          check('trade evaluate with sleeper_league_id', ev.status === 200 && ej.verdict != null, ev.status === 200 ? `verdict=${JSON.stringify(ej.verdict).slice(0, 80)} warnings=${(ej.warnings || []).length}` : JSON.stringify(ej));
        }
        const wv = await get(`/api/nba/waivers?league_id=${lg.league_id}&roster_id=${me.team_key}&weeks=1&user_id=${uid}`);
        check('waivers (Sleeper roster + league pool)', wv.status === 200 && wv.json.mode === 'sleeper' && Array.isArray(wv.json.targets || wv.json.adds || wv.json.rows || []) , wv.status === 200 ? `fa=${wv.json.freeAgentCount} priority=${JSON.stringify(wv.json.priority)} rules=${JSON.stringify(wv.json.rules)}` : JSON.stringify(wv.json));
      }
      check('bad roster → 404', (await get(`/api/nba/lineup?league_id=${lg.league_id}&roster_id=999&week=1`)).status === 404);
      check('bad league id → 400', (await get('/api/nba/sleeper/league?league_id=abc')).status === 400);
      check('unknown league → 404', (await get('/api/nba/sleeper/league?league_id=1')).status === 404);
    }
    fs.mkdirSync(path.join(ROOT, 'docs', 'nba-sleeper'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'docs', 'nba-sleeper', 'live-check.json'), JSON.stringify(report, null, 2));
    console.log(`\n${n - fails}/${n} checks passed · report docs/nba-sleeper/live-check.json`);
  } catch (err) {
    console.error('live check crashed:', err);
    fails++;
  }
  if (KEEP) { console.log('KEEP ' + base); return; }
  srv.close();
  process.exit(fails ? 1 : 0);
})();
