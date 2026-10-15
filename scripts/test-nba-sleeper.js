#!/usr/bin/env node
/* Sleeper-first NBA sync: unit tests for nba/sleeper/map.js (recorded real
   payloads in scripts/fixtures/nba/sleeper/*, captured 2026-10-15 from Dillon's
   league 1411447094215991296 / draft 1411447094215991297), the Sleeper client
   (timeouts, retries, 404 → null, 429), the /api/nba/sleeper/* routes with a
   stubbed client (error paths, caching, validation, name+team fallback),
   draft-logic's Sleeper settings / reversal / pick merge reconciliation
   (idempotent, out of order, duplicates, undo, traded picks, keepers) and the
   polling plan. Run: node scripts/test-nba-sleeper.js   (exit 0 = all pass) */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'nba', 'sleeper');
const fx = n => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const M = require('../nba/sleeper/map');
const { createSleeperClient, SleeperError, errorResponse } = require('../nba/sleeper/client');
const sleeperRoutes = require('../nba/routes/sleeper');
const L = require('../nba/pages/draft-logic.js');

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const eq = (a, b, msg) => (msg === undefined ? assert.deepStrictEqual(a, b) : assert.deepStrictEqual(a, b, msg));

const DRAFT = fx('draft.json'), PICKS = fx('picks.json'), LEAGUE = fx('league.json'), ROSTERS = fx('rosters.json'), USERS = fx('users.json'), STATE = fx('state.json');
const ME = '1044077615075872768';

/* ------------------------------------------------------------- map.js */
t('draftStatus: Sleeper states → board states', () => {
  eq(M.draftStatus({ status: 'pre_draft' }), 'predraft');
  eq(M.draftStatus({ status: 'drafting' }), 'drafting');
  eq(M.draftStatus({ status: 'paused' }), 'drafting');
  eq(M.draftStatus({ status: 'complete' }), 'postdraft');
  eq(M.draftStatus(null), 'predraft');
  eq(M.draftStatus({ status: 'weird' }), 'predraft');
});
t('roundForward / slotForPick: snake, 3RR (Sleeper reversal_round 3), linear, other reversal rounds', () => {
  eq([1, 2, 3, 4, 5].map(r => M.roundForward(r, 0)), [true, false, true, false, true]);
  eq([1, 2, 3, 4, 5].map(r => M.roundForward(r, 3)), [true, false, false, true, false]);
  eq([1, 2, 3, 4, 5].map(r => M.roundForward(r, 5)), [true, false, true, false, false]);
  eq([1, 2, 3].map(r => M.roundForward(r, 2)), [true, true, false]);
  eq(M.slotForPick(13, 12, 3), 12); eq(M.slotForPick(24, 12, 3), 1); eq(M.slotForPick(25, 12, 3), 12); eq(M.slotForPick(36, 12, 3), 1); eq(M.slotForPick(37, 12, 3), 1);
  eq(M.slotForPick(25, 12, 0), 1);
  eq(M.slotForPick(13, 12, 3, 'linear'), 1);
  // draft-logic mirrors it (true === 3)
  for (let p = 1; p <= 48; p++) { eq(L.slotForPick(p, 12, true), M.slotForPick(p, 12, 3), 'pick ' + p); eq(L.slotForPick(p, 12, 5), M.slotForPick(p, 12, 5)); }
});
t('real draft: slotForPick reproduces Sleeper draft_slot on all 156 picks (reversal_round 3)', () => {
  eq(DRAFT.settings.reversal_round, 3);
  for (const p of PICKS) eq(M.slotForPick(p.pick_no, DRAFT.settings.teams, DRAFT.settings.reversal_round, DRAFT.type), p.draft_slot, 'pick ' + p.pick_no);
});
t('pickOrder: full order from slot_to_roster_id; empty when the order is not set', () => {
  const o = M.pickOrder(DRAFT, []);
  eq(o.length, 156);
  eq(o[0], { pick: 1, round: 1, slot: 1, team_key: '12', original_team_key: '12' });
  eq(o[12].slot, 12); eq(o[12].team_key, '6');
  for (const p of PICKS) eq(o[p.pick_no - 1].team_key, String(p.roster_id), 'owner of pick ' + p.pick_no);
  eq(M.pickOrder({ ...DRAFT, slot_to_roster_id: null }, []), []);
  eq(M.pickOrder({ ...DRAFT, slot_to_roster_id: {} }, []), []);
  eq(M.pickOrder(null, []), []);
});
t('pickOrder: traded picks move ownership for that round only; other seasons ignored', () => {
  const traded = [{ season: '2026', round: 2, roster_id: 12, owner_id: 3, previous_owner_id: 12 }, { season: '2027', round: 1, roster_id: 12, owner_id: 5 }];
  const o = M.pickOrder(DRAFT, traded);
  const r2slot1 = o.find(x => x.round === 2 && x.slot === 1);
  eq(r2slot1.team_key, '3'); eq(r2slot1.original_team_key, '12');
  eq(o.find(x => x.round === 1 && x.slot === 1).team_key, '12', 'round 1 untouched');
  eq(o.find(x => x.round === 3 && x.slot === 1).team_key, '12', 'round 3 untouched');
});
t('normalizePicks: real picks → board picks, dedupe, keepers, resolver + unmatched never drops a pick', () => {
  const known = new Set(PICKS.map(p => p.player_id));
  const resolve = (pid) => known.has(pid) && pid !== '2281' ? { id: pid, confidence: 1 } : { id: null, confidence: 0 };
  const { picks, unmatched } = M.normalizePicks(PICKS.concat([PICKS[0], { pick_no: 0 }, null]), resolve);
  eq(picks.length, 156);
  eq(picks[0].pick, 1); eq(picks[0].team_key, '12'); eq(picks[0].player_key, '2577'); eq(picks[0].sleeperId, '2577'); eq(picks[0].name, 'Victor Wembanyama'); eq(picks[0].round, 1); eq(picks[0].draft_slot, 1);
  eq(unmatched.length, 1); eq(unmatched[0].pick, 156); eq(unmatched[0].name, 'Santi Aldama'); eq(unmatched[0].team_key, '12');
  eq(picks[155].sleeperId, null, 'unmatched pick is still in the pick list');
  const k = M.normalizePicks([{ pick_no: 1, round: 1, roster_id: 2, player_id: 'x', is_keeper: true, metadata: { first_name: 'A', last_name: 'B' } }], () => ({ id: 'x', confidence: 1 }));
  eq(k.picks[0].is_keeper, true);
  eq(M.normalizePicks([{ pick_no: 2, roster_id: 1, player_id: '9' }], null).picks[0].name, 'Player 9');
});
t('teamsFromLeague + myTeamKey: owner, co-owner, draft_position from slot_to_roster_id / draft_order', () => {
  const teams = M.teamsFromLeague(USERS, ROSTERS, DRAFT);
  eq(teams.length, 12);
  const me = teams.find(x => x.user_id === ME);
  eq(me.team_key, '1'); eq(me.draft_position, 8); eq(me.name, 'the unction 🛏️😴'); eq(me.display_name, 'pykle');
  eq(teams.every(x => x.draft_position >= 1 && x.draft_position <= 12), true);
  eq(new Set(teams.map(x => x.draft_position)).size, 12, 'permutation');
  eq(M.myTeamKey(teams, ME), '1');
  eq(M.myTeamKey(teams, '0'), null);
  eq(M.myTeamKey(teams, null), null);
  const co = M.teamsFromLeague(USERS, ROSTERS.map(r => r.roster_id === 4 ? { ...r, co_owners: ['42'] } : r), DRAFT);
  eq(M.myTeamKey(co, '42'), '4');
  const noOrder = M.teamsFromLeague(USERS, ROSTERS, { ...DRAFT, slot_to_roster_id: null, draft_order: null });
  eq(noOrder.every(x => x.draft_position == null), true);
  const byOrder = M.teamsFromLeague(USERS, ROSTERS, { ...DRAFT, slot_to_roster_id: null });
  eq(byOrder.find(x => x.user_id === ME).draft_position, 8, 'falls back to draft_order');
  eq(M.teamsFromLeague(USERS, [{ roster_id: 9, owner_id: 'nobody' }], null)[0].name, 'Team 9');
});
t('classifyLeague: points / categories / auction', () => {
  eq(M.classifyLeague(LEAGUE, DRAFT), { draft_type: 'snake', auction: false, scoring_type: 'points', scoring_raw: 'std', supported: true });
  eq(M.classifyLeague(LEAGUE, { ...DRAFT, type: 'auction' }).auction, true);
  eq(M.classifyLeague({ settings: { scoring_type: 'categories' } }, null).scoring_type, 'categories');
  eq(M.classifyLeague(LEAGUE, { ...DRAFT, metadata: { scoring_type: 'roto' } }).supported, false);
  eq(M.classifyLeague({}, null).scoring_type, null);
});
t('leagueSummary / draftMeta / leagueMeta: picker + board shapes', () => {
  const s = M.leagueSummary(LEAGUE, DRAFT);
  eq([s.league_key, s.name, s.num_teams, s.draft_status, s.draft_type, s.scoring_type, s.rounds, s.pick_timer, s.reversal_round, s.season], ['1411447094215991296', 'HALIMSANITY 26-27', 12, 'postdraft', 'snake', 'points', 13, 30, 3, '2026']);
  eq(s.draft_start, 1792034987798);
  const d = M.draftMeta(DRAFT);
  eq([d.draft_id, d.status, d.type, d.teams, d.rounds, d.pick_timer, d.reversal_round], ['1411447094215991297', 'postdraft', 'snake', 12, 13, 30, 3]);
  eq(d.slots, { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2, BN: 4 });
  eq(d.last_picked, 1792040302932);
  eq(d.draft_order[ME], 8);
  const lg = M.leagueMeta(LEAGUE);
  eq(lg.roster_counts, { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 3, BN: 4 });
  eq([lg.reserve_slots, lg.waiver_type, lg.waiver_budget, lg.playoff_week_start, lg.trade_deadline, lg.num_teams], [2, 0, 100, 21, 17, 12]);
  eq(M.rosterPositionCounts(['PG', 'IR', 'IL', 'UT', 'bn']), { PG: 1, IL: 2, UTIL: 1, BN: 1 });
  eq(M.draftMeta(null), null); eq(M.leagueMeta(null), null);
});
t('currentSeason: Sleeper state.league_season (2026 for 2026-27); date fallback', () => {
  eq(M.currentSeason(STATE), '2026');
  eq(M.currentSeason({ league_season: '2027' }), '2027');
  eq(M.currentSeason(null, new Date('2026-10-15T00:00:00Z')), '2026');
  eq(M.currentSeason(null, new Date('2027-03-01T00:00:00Z')), '2026');
  eq(M.currentSeason(null, new Date('2027-09-15T00:00:00Z')), '2027');
});

/* ------------------------------------------------------------ client */
function resp(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body };
}
t('client: 200 json, 404 → null (unknown user is 200 null too), retries one 5xx, 429 typed, timeout typed, bad ids rejected', async () => {
  const calls = [];
  let fails = 1;
  const c = createSleeperClient({ sleep: async () => {}, timeoutMs: 50, fetchImpl: async url => {
    calls.push(url);
    if (/user\/pykle$/.test(url)) return resp(200, { user_id: '1', username: 'pykle' });
    if (/user\/ghost$/.test(url)) return resp(200, null);
    if (/league\/404$/.test(url)) return resp(404, { error: 'nope' });
    if (/league\/flaky$/.test(url)) { if (fails-- > 0) return resp(502, {}); return resp(200, { league_id: 'flaky' }); }
    if (/league\/dead$/.test(url)) return resp(503, {});
    if (/league\/busy$/.test(url)) return resp(429, {}, { 'retry-after': '7' });
    if (/league\/slow$/.test(url)) { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }
    if (/league\/bad$/.test(url)) return resp(400, {});
    return resp(200, {});
  } });
  eq((await c.user('pykle')).username, 'pykle');
  eq(await c.user('ghost'), null);
  eq(await c.league('404'), null);
  eq((await c.league('flaky')).league_id, 'flaky'); eq(calls.filter(u => /flaky/.test(u)).length, 2, 'retried once');
  await assert.rejects(c.league('dead'), e => e instanceof SleeperError && e.code === 'sleeper_upstream' && e.status === 503);
  eq(calls.filter(u => /dead/.test(u)).length, 2, 'one retry on 5xx then give up');
  await assert.rejects(c.league('busy'), e => e.code === 'sleeper_rate_limited' && e.retryAfterS === 7);
  await assert.rejects(c.league('slow'), e => e.code === 'sleeper_timeout');
  await assert.rejects(c.league('bad'), e => e.code === 'sleeper_bad_request');
  await assert.rejects(c.user('<script>'), e => e.code === 'sleeper_bad_request');
  await assert.rejects(c.league('../x'), e => e.code === 'sleeper_bad_request');
  eq(calls.every(u => u.startsWith('https://api.sleeper.app/v1/')), true);
  eq(errorResponse(new SleeperError('x', { code: 'sleeper_rate_limited', retryAfterS: 3 })).status, 429);
  eq(errorResponse(new SleeperError('x', { code: 'sleeper_timeout' })).status, 504);
  eq(errorResponse(new Error('boom')).status, 502);
  eq(errorResponse(new SleeperError('x', { code: 'sleeper_not_found' })).status, 404);
});

/* ------------------------------------------------------------ routes */
function fakeClient(state) {
  const n = { user: 0, leagues: 0, league: 0, draft: 0, picks: 0 };
  const client = {
    calls: n,
    async state() { return STATE; },
    async user(u) { n.user++; if (state.mode === 'down') throw new SleeperError('x', { status: 502, code: 'sleeper_upstream' }); if (state.mode === 'timeout') throw new SleeperError('x', { code: 'sleeper_timeout' }); if (state.mode === 'busy') throw new SleeperError('x', { status: 429, code: 'sleeper_rate_limited', retryAfterS: 9 }); return u === 'pykle' || u === ME ? { user_id: ME, username: 'pykle', display_name: 'pykle', avatar: 'a' } : null; },
    async userLeagues(uid, season) { n.leagues++; state.season = season; return uid === ME ? [LEAGUE] : []; },
    async league(id) { n.league++; return id === LEAGUE.league_id ? LEAGUE : null; },
    async leagueUsers() { return USERS; },
    async leagueRosters() { return ROSTERS; },
    async leagueDrafts() { return [DRAFT]; },
    async leagueMatchups(id, w) { return w === 1 ? fx('matchups-1.json') : []; },
    async draft(id) { n.draft++; if (state.mode === 'draftdown') throw new SleeperError('x', { status: 500, code: 'sleeper_upstream' }); return id === DRAFT.draft_id ? (state.draft || DRAFT) : null; },
    async draftPicks(id) { n.picks++; return id === DRAFT.draft_id ? (state.picks || PICKS) : []; },
    async draftTradedPicks() { return state.traded || []; },
  };
  return client;
}
function memCache() {
  const cache = new Map();
  const fn = async (key, ttl, f) => { const e = cache.get(key); if (e && e.exp > Date.now()) return e.v; const v = await f(); cache.set(key, { v, exp: Date.now() + ttl }); return v; };
  fn.clear = () => cache.clear();
  return fn;
}
const BOARD = PICKS.filter(p => p.player_id !== '2281').map(p => ({ id: p.player_id, name: `${p.metadata.first_name} ${p.metadata.last_name}`, team: p.metadata.team, pos: [p.metadata.position] }))
  .concat([{ id: '7777', name: 'Santi Aldama', team: 'DAL', pos: ['PF'] }]); // Aldama under a different id → name+team fallback
async function serve(state) {
  const app = express();
  const apiCached = memCache();
  const client = fakeClient(state);
  app.use(sleeperRoutes({ apiCached, modelPlayers: async () => ({ players: BOARD }), log: { error() {} }, client }));
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async p => { const r = await fetch(base + p); return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) }; };
  return { srv, get, client, apiCached };
}
t('routes: user lookup (ok / unknown / invalid), leagues for the current season, league + draft + rosters + matchup', async () => {
  const state = { mode: 'ok' };
  const { srv, get, client } = await serve(state);
  try {
    const u = await get('/api/nba/sleeper/user?username=@pykle');
    eq(u.status, 200); eq(u.json.user_id, ME); eq(u.json.username, 'pykle');
    const nf = await get('/api/nba/sleeper/user?username=ghost');
    eq(nf.status, 404); eq(nf.json.code, 'sleeper_user_not_found'); assert.match(nf.json.error, /ghost/);
    eq((await get('/api/nba/sleeper/user?username=')).status, 400);
    eq((await get('/api/nba/sleeper/user?username=' + encodeURIComponent('a b'))).status, 400);
    eq((await get('/api/nba/sleeper/user?username=' + 'x'.repeat(40))).status, 400);
    const ls = await get('/api/nba/sleeper/leagues?user_id=' + ME);
    eq(ls.status, 200); eq(ls.json.season, '2026'); eq(state.season, '2026'); eq(ls.json.leagues.length, 1);
    eq(ls.json.leagues[0].draft_status, 'postdraft'); eq(ls.json.leagues[0].reversal_round, 3); eq(ls.json.leagues[0].scoring_type, 'points');
    const byName = await get('/api/nba/sleeper/leagues?username=pykle');
    eq(byName.json.user.username, 'pykle');
    eq((await get('/api/nba/sleeper/leagues?user_id=0')).json.leagues, []);
    eq((await get('/api/nba/sleeper/leagues?user_id=abc')).status, 400);
    eq((await get('/api/nba/sleeper/leagues')).status, 400);
    const lg = await get(`/api/nba/sleeper/league?league_id=${LEAGUE.league_id}&user_id=${ME}`);
    eq(lg.status, 200); eq(lg.json.myTeamKey, '1'); eq(lg.json.mySlot, 8); eq(lg.json.teams.length, 12); eq(lg.json.draft.reversal_round, 3); eq(lg.json.league.reserve_slots, 2); eq(lg.json.support.supported, true);
    eq((await get(`/api/nba/sleeper/league?league_id=${LEAGUE.league_id}`)).json.myTeamKey, null, 'no user → no my team');
    eq((await get('/api/nba/sleeper/league?league_id=1')).status, 404);
    eq((await get('/api/nba/sleeper/league?league_id=x')).status, 400);
    const d = await get(`/api/nba/sleeper/draft?draft_id=${DRAFT.draft_id}`);
    eq(d.status, 200); eq(d.json.status, 'postdraft'); eq(d.json.picks.length, 156); eq(d.json.order, []); eq(d.json.onClock, null); eq(d.json.auction, false);
    eq(d.json.unmatched, [], 'Aldama resolved by name+team to the other id');
    eq(d.json.picks[155].sleeperId, '7777'); eq(typeof d.json.picks[155].matchConfidence, 'number');
    eq(d.json.picks[0].team_key, '12'); eq(d.json.picks[0].round, 1);
    eq((await get('/api/nba/sleeper/draft?draft_id=5')).status, 404);
    const r = await get(`/api/nba/sleeper/rosters?league_id=${LEAGUE.league_id}&user_id=${ME}`);
    eq(r.status, 200); eq(r.json.teams.find(x => x.mine).team_key, '1'); eq(r.json.teams[0].players.length, 13);
    const mu = await get(`/api/nba/sleeper/matchup?league_id=${LEAGUE.league_id}&roster_id=1&week=1`);
    eq(mu.json.opponent, '5');
    eq((await get(`/api/nba/sleeper/matchup?league_id=${LEAGUE.league_id}&roster_id=1&week=2`)).json.opponent, null);
    eq((await get(`/api/nba/sleeper/matchup?league_id=${LEAGUE.league_id}&roster_id=1&week=99`)).status, 400);
    eq(client.calls.user, 2, 'user lookups cached per username (pykle once, ghost once)');
  } finally { srv.close(); }
});
t('routes: live draft view — picks + remaining order, on the clock, cached 3 s so concurrent polls share one upstream call', async () => {
  const live = { ...DRAFT, status: 'drafting', last_picked: 1792040000000 };
  const state = { mode: 'ok', draft: live, picks: PICKS.slice(0, 20) };
  const { srv, get, client } = await serve(state);
  try {
    const [a, b, c] = await Promise.all([get(`/api/nba/sleeper/draft?draft_id=${DRAFT.draft_id}`), get(`/api/nba/sleeper/draft?draft_id=${DRAFT.draft_id}`), get(`/api/nba/sleeper/draft?draft_id=${DRAFT.draft_id}`)]);
    eq(a.json.status, 'drafting'); eq(a.json.picks.length, 20); eq(a.json.order.length, 136); eq(a.json.onClock.pick, 21); eq(a.json.onClock.team_key, String(DRAFT.slot_to_roster_id[String(M.slotForPick(21, 12, 3))]));
    eq(a.json.draft.last_picked, 1792040000000);
    eq(client.calls.picks, 1, 'pooled'); eq(b.json.polledAt, a.json.polledAt); eq(c.json.picks.length, 20);
    const pausedState = { ...live, status: 'paused' };
    state.draft = pausedState;
  } finally { srv.close(); }
});
t('routes: Sleeper outages → typed errors (502 / 504 / 429 + Retry-After), never a 500 stack', async () => {
  for (const [mode, status, code] of [['down', 502, 'sleeper_upstream'], ['timeout', 504, 'sleeper_timeout'], ['busy', 429, 'sleeper_rate_limited']]) {
    const { srv, get } = await serve({ mode });
    try {
      const r = await get('/api/nba/sleeper/user?username=pykle');
      eq(r.status, status, mode); eq(r.json.code, code);
      if (mode === 'busy') eq(r.headers.get('retry-after'), '9');
    } finally { srv.close(); }
  }
  const { srv, get } = await serve({ mode: 'draftdown' });
  try {
    const r = await get(`/api/nba/sleeper/draft?draft_id=${DRAFT.draft_id}`);
    eq(r.status, 502); eq(r.json.code, 'sleeper_upstream');
  } finally { srv.close(); }
});
t('createResolver: id first, then name+team, else null (pick kept as unmatched by the caller)', () => {
  const resolve = sleeperRoutes.createResolver(BOARD);
  eq(resolve('2577', {}).id, '2577');
  eq(resolve('2281', { first_name: 'Santi', last_name: 'Aldama', team: 'DAL', position: 'PF' }).id, '7777');
  eq(resolve('0', { first_name: 'Nobody', last_name: 'Here', team: 'ZZZ' }).id, null);
  eq(resolve(null, null).id, null);
});

/* ------------------------------------------------------ draft-logic */
const LG = { num_teams: 12, roster_positions: LEAGUE.roster_positions, reserve_slots: 2 };
const DM = M.draftMeta(DRAFT);
const TEAMS = M.teamsFromLeague(USERS, ROSTERS, DRAFT);
t('settingsFromSleeper: slots from roster_positions, IL from reserve_slots, teams/rounds/3RR from the draft, my slot from teams', () => {
  const s = L.settingsFromSleeper(LG, DM, '1', TEAMS, L.DEFAULT_SETTINGS);
  eq(s, { teams: 12, mySlot: 8, slots: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 3 }, bench: 4, il: 2, thirdRoundReversal: true, rounds: 13 });
  eq(L.totalPicks(s), 156);
  eq(L.sleeperPickSeconds(DM), 30); eq(L.sleeperPickSeconds({ pick_timer: 0 }), null); eq(L.sleeperPickSeconds(null), null);
  // plain snake + no draft order yet: keeps the user's chosen slot
  const noOrder = L.settingsFromSleeper(LG, { ...DM, reversal_round: 0, draft_order: null, slot_to_roster_id: null }, '1', TEAMS.map(x => ({ ...x, draft_position: null })), Object.assign({}, L.DEFAULT_SETTINGS, { mySlot: 7, thirdRoundReversal: true }));
  eq(noOrder.mySlot, 7); eq(noOrder.thirdRoundReversal, undefined, 'Sleeper reversal_round 0 wins over a manual 3RR');
  // unusual reversal round is kept numerically
  eq(L.settingsFromSleeper(LG, { ...DM, reversal_round: 5 }, '1', TEAMS, L.DEFAULT_SETTINGS).reversalRound, 5);
  eq(L.reversalOf({ thirdRoundReversal: true }), 3); eq(L.reversalOf({ reversalRound: 5 }), 5); eq(L.reversalOf({}), 0);
  // no roster_positions on the league → the draft's slots_* settings
  const fromDraft = L.settingsFromSleeper({ num_teams: 12, roster_positions: [], reserve_slots: 0 }, DM, null, [], L.DEFAULT_SETTINGS);
  eq(fromDraft.slots, { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2 }); eq(fromDraft.bench, 4);
  // no league / no draft → previous settings normalised
  eq(L.settingsFromSleeper(null, null, null, [], L.DEFAULT_SETTINGS), L.normalizeSettings(L.DEFAULT_SETTINGS));
  // normalizeSettings accepts reversalRound 3 as the flag
  eq(L.normalizeSettings({ reversalRound: 3 }).thirdRoundReversal, true);
  eq(L.normalizeSettings({ reversalRound: '2' }).reversalRound, 2);
});
t('syncSlotKnown / syncOrderSlot: draft_position, published order, synced pick; numeric roster ids', () => {
  const st = L.settingsFromSleeper(LG, DM, '1', TEAMS, L.DEFAULT_SETTINGS);
  eq(L.syncSlotKnown({ live: true, myTeamKey: '1', teams: TEAMS, settings: st }), true);
  eq(L.syncSlotKnown({ live: true, myTeamKey: 1, teams: TEAMS, settings: st }), true);
  const noDp = TEAMS.map(x => ({ ...x, draft_position: null }));
  eq(L.syncSlotKnown({ live: true, myTeamKey: '1', teams: noDp, settings: st, sync: { picks: [], order: [] } }), false);
  const order = M.pickOrder(DRAFT, []);
  eq(L.syncOrderSlot({ order }, '1', 12), 8);
  eq(L.syncSlotKnown({ live: true, myTeamKey: '1', teams: noDp, settings: st, sync: { order } }), true);
  eq(L.syncSlotKnown({ live: false, myTeamKey: '1', teams: TEAMS, settings: st }), false);
});

// Real-shaped sync payload from the recorded draft (first n picks).
function syncOf(n, extra) {
  const order = M.pickOrder(DRAFT, (extra && extra.traded) || []);
  const made = new Set();
  const { picks, unmatched } = M.normalizePicks(PICKS.slice(0, n), pid => ({ id: pid, confidence: 1 }));
  picks.forEach(p => made.add(p.pick));
  return { status: n >= 156 ? 'postdraft' : 'drafting', picks, unmatched, order: order.filter(o => !made.has(o.pick)), draft: DM, ...(extra || {}) };
}
const BY_ID = Object.fromEntries(PICKS.map(p => [p.player_id, { id: p.player_id, name: `${p.metadata.first_name} ${p.metadata.last_name}` }]));
const ST = L.settingsFromSleeper(LG, DM, '1', TEAMS, L.DEFAULT_SETTINGS);
const CTX = { settings: ST, myTeamKey: '1', playersById: BY_ID, overrides: {}, alias: {} };

t('mergePicks (Sleeper): picks resolve by Sleeper id, mine by roster id, slot/round from the real order; idempotent', () => {
  const s = syncOf(30);
  const m1 = L.mergePicks(s, [], CTX), m2 = L.mergePicks(s, [], CTX);
  eq(m1.picks.length, 30); eq(m1.unmatched, []);
  eq(m1.picks.filter(p => p.mine).map(p => p.pick), [8, 17, 29], 'slot 8 under 3RR: 8, 17 (R2 back), 29 (R3 back again)');
  eq(m1.picks[7].slot, 8); eq(m1.picks[16].slot, 8); eq(m1.picks[16].round, 2); eq(m1.picks[28].slot, 8);
  eq(m1.picks[0].source, 'sync'); eq(m1.picks[0].name, 'Victor Wembanyama'); eq(m1.picks[0].team_key, '12');
  eq(JSON.stringify(m1), JSON.stringify(m2), 'idempotent');
  const c1 = L.syncClock(s, '1', 0);
  eq([c1.cur, c1.teamKey, c1.onMe, c1.myNext, c1.myAfter, c1.total], [31, String(DRAFT.slot_to_roster_id[String(M.slotForPick(31, 12, 3))]), false, 44, 53, 156]);
  eq(c1.awayN, 13, 'picks 31..43 come first; 44 is mine (round 4 runs 1→12 again)');
  const c2 = L.syncClock(syncOf(28), '1', 0);
  eq([c2.cur, c2.onMe, c2.myNext, c2.awayN], [29, true, 29, 0], 'on the clock at 29');
});
t('mergePicks (Sleeper): out-of-order + duplicate rows, same player twice, server unmatched → review list, never silently dropped', () => {
  const s = syncOf(12);
  const shuffled = { ...s, picks: s.picks.slice().reverse().concat([s.picks[3], { ...s.picks[5], pick: 13, player_key: s.picks[5].player_key, sleeperId: s.picks[5].sleeperId }]) };
  const m = L.mergePicks(shuffled, [], CTX);
  eq(m.picks.map(p => p.pick), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  eq(m.picks[12].playerId, null, 'same player a second time is not double counted');
  eq(m.unmatched.map(u => u.pick), [13]);
  // a pick whose player is not on the board stays in the list and in review
  const deep = { ...s, picks: s.picks.concat([{ pick: 13, round: 2, team_key: '6', player_key: '999999', sleeperId: null, name: 'Deep Guy' }]), unmatched: [{ pick: 13, player_key: '999999', name: 'Deep Guy', team_key: '6' }] };
  const d = L.mergePicks(deep, [], CTX);
  eq(d.picks.length, 13); eq(d.picks[12].name, 'Deep Guy'); eq(d.unmatched, [{ pick: 13, player_key: '999999', name: 'Deep Guy', team_key: '6' }]);
  // a manual override maps him to a board player
  const o = L.mergePicks(deep, [], { ...CTX, overrides: { 999999: PICKS[20].player_id } });
  eq(o.picks[12].playerId, PICKS[20].player_id); eq(o.unmatched, []);
});
t('mergePicks (Sleeper): manual picks take the next open slots with their owner; confirmed ones are pruned; undo (pick vanishes upstream) returns to pending', () => {
  const s = syncOf(12);
  const manual = [{ playerId: PICKS[12].player_id, mine: false }, { playerId: PICKS[13].player_id, mine: true }];
  const m = L.mergePicks(s, manual, CTX);
  eq(m.picks.slice(12).map(p => [p.pick, p.source, p.confirmed, p.team_key, p.slot]), [[13, 'manual', false, '6', 12], [14, 'manual', false, '4', 11]]);
  eq(m.confirmedManual, []);
  // Sleeper now reports pick 13 with the same player → manual entry confirmed (caller prunes it)
  const s13 = syncOf(13);
  const m13 = L.mergePicks(s13, manual, CTX);
  eq(m13.confirmedManual, [PICKS[12].player_id]);
  eq(m13.picks[12].source, 'sync'); eq(m13.picks[13].source, 'manual');
  // "undo" on Sleeper: pick 13 disappears from the payload again → the manual entry is pending once more
  const back = L.mergePicks(syncOf(12), manual, CTX);
  eq(back.picks[12].source, 'manual'); eq(back.picks[12].confirmed, false);
  // no sync at all (manual board): sequential, all confirmed
  const plain = L.mergePicks(null, manual, CTX);
  eq(plain.picks.map(p => [p.pick, p.confirmed]), [[1, true], [2, true]]);
});
t('mergePicks (Sleeper): traded pick and keeper surface through the order / flags', () => {
  const traded = [{ season: '2026', round: 2, roster_id: 12, owner_id: 1 }]; // slot 1's round-2 pick now mine
  const s = syncOf(12, { traded });
  const m = L.mergePicks(s, [], CTX);
  const c = L.syncClock(s, '1', 0);
  eq(c.myNext, 17, 'my own round-2 pick (slot 8 → pick 17) comes first');
  eq(c.myAfter, 24, "then slot 1's traded round-2 pick (#24), not my round-3 pick");
  const k = L.mergePicks({ ...s, picks: s.picks.map((p, i) => (i === 0 ? { ...p, is_keeper: true } : p)) }, [], CTX);
  eq(k.picks[0].keeper, true); eq(m.picks[0].keeper, undefined);
});
t('legacy state: boards saved under `yahoo` load as `sync`; y<pid> ids alias onto Sleeper ids', () => {
  const raw = JSON.stringify({ v: 1, leagueKey: 'k', settings: ST, manual: [{ playerId: 'y5352', mine: true }], overrides: {}, yahoo: { status: 'drafting', picks: [{ pick: 1, player_key: '466.p.1' }], unmatched: [] }, updatedAt: 1 });
  const st = L.deserializeState(raw, 'k', ST);
  eq(st.sync.picks.length, 1); eq(st.yahoo, undefined);
  const ser = JSON.parse(L.serializeState(st));
  eq(ser.sync.picks.length, 1); eq('yahoo' in ser, false);
  const m = L.mergePicks(null, st.manual, { settings: ST, playersById: { 1658: { id: '1658', name: 'Nikola Jokić' } }, alias: { y5352: '1658' } });
  eq(m.picks[0].playerId, '1658');
});
t('pollPlan: 4 s live, 12 s idle (visible), live rate when the scheduled start is near, hidden tab only during the draft, backoff on failures', () => {
  const t0 = 1e12;
  eq(L.pollPlan(false, 'drafting', 0), { run: true, delay: 4000 });
  eq(L.pollPlan(false, 'predraft', 0), { run: true, delay: 12000 });
  eq(L.pollPlan(false, 'predraft', 0, { startTime: t0 + 10 * 60 * 1000, now: t0 }).delay, 4000);
  eq(L.pollPlan(false, 'predraft', 0, { startTime: t0 + 60 * 60 * 1000, now: t0 }).delay, 12000);
  eq(L.pollPlan(true, 'predraft', 0).run, false);
  eq(L.pollPlan(true, 'postdraft', 0).run, false);
  eq(L.pollPlan(true, 'drafting', 0), { run: true, delay: 10000 });
  eq(L.pollPlan(false, 'drafting', 1).delay, 8000); eq(L.pollPlan(false, 'drafting', 2).delay, 16000); eq(L.pollPlan(false, 'drafting', 5).delay, 30000);
});
t('leagueSupport / summary with the real Sleeper summary row', () => {
  const row = M.leagueSummary(LEAGUE, DRAFT);
  eq(L.leagueSupport(row), { recos: true, kind: null, label: 'Points' });
  eq(L.leagueSummary(row), '12 teams · Drafted · Points · 3RR');
  eq(L.leagueChoice([row], null), { mode: 'auto', key: '1411447094215991296' });
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); }
  }
  console.log(`\nnba-sleeper: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
