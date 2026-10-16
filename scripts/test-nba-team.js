#!/usr/bin/env node
/* Tests for the NBA team page (Stream C): nba/model/team-analysis.js,
   nba/routes/team.js, nba/pages/team-logic.js. Spec §5.4 items 1-7, plus:
   weekValue == trade engine on every roster and week, local stand-ins match the
   shared-layer contract shapes, 20-team league, a team with no C-eligible player,
   page route + static deny + nav entry.
   Offline (NBA_MODEL_OFFLINE=1), no framework: node scripts/test-nba-team.js (exit 0 = pass). */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const path = require('path');
const fs = require('fs');
const express = require('express');
const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'docs', 'nba-spec', 'fixtures');
const fx = n => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const model = require('../nba/model');
const TA = require('../nba/model/team-analysis');
const T = require('../nba/model/trade');
const R = require('../nba/model/roster-slots');
const RA = require('../nba/model/roster-analysis');
const TL = require('../nba/pages/team-logic');
const { SleeperError } = require('../nba/sleeper/client');
const createTeamRoutes = require('../nba/routes/team');

let pass = 0, fail = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error((msg ? msg + ': ' : '') + 'expected ' + B.slice(0, 300) + ', got ' + A.slice(0, 300)); }
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v, msg) => ok(v === null || isNum(v), `${msg}: number or null, got ${JSON.stringify(v)}`);
function noNaN(o, where = 'root') {
  if (typeof o === 'number') { ok(Number.isFinite(o), `NaN/Infinity at ${where}`); return; }
  if (Array.isArray(o)) return o.forEach((x, i) => noNaN(x, `${where}[${i}]`));
  if (o && typeof o === 'object') for (const k of Object.keys(o)) noNaN(o[k], `${where}.${k}`);
}
function shuffle(a, seed) { const x = a.slice(); let s = seed; for (let i = x.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) % 4294967296; const j = s % (i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; }

const PROFILE = fx('profile-from-sleeper.expected.json');
let BOARD = null, CW = 1;
async function board() { if (!BOARD) { const d = await model.getPlayers({ profile: PROFILE }); BOARD = d.players; CW = d.currentWeek; } return BOARD; }
function fixtureCtx(b, extra = {}) {
  return TA.leagueContextLocal({ league: fx('sleeper-league.json'), users: fx('sleeper-users.json'), rosters: fx('sleeper-rosters.json'), board: b, profile: PROFILE, userId: '1044077615075872768', currentWeek: CW, ...extra });
}
function analyze(ctx, b, opts = {}) { return TA.analyzeLeague({ ctx, board: b, options: { currentWeek: CW, today: '2026-10-15', ...opts } }); }

/* Contract validators (same rules as scripts/test-nba-spec-contract.js). */
function validateLeagueContext(c) {
  ok(/^\d+$/.test(String(c.leagueId)), 'leagueId');
  ok(Array.isArray(c.teams) && c.teams.length >= 2, 'teams');
  ok(c.myRosterId === null || typeof c.myRosterId === 'string', 'myRosterId');
  ok(Number.isInteger(c.currentWeek) && c.currentWeek >= 1, 'currentWeek');
  for (const tm of c.teams) {
    for (const k of ['wins', 'losses', 'ties', 'fpts', 'fptsAgainst']) ok(isNum(tm.record[k]), 'record.' + k);
    for (const p of tm.players) { ok(typeof p.id === 'string', 'player id'); ok(typeof p.onBoard === 'boolean', 'onBoard'); ok(['START', 'BN', 'IL'].includes(p.slot), 'slot'); }
    eq(tm.unmatched.length, tm.players.filter(p => !p.onBoard).length, 'unmatched = players off the board');
  }
}
function validateRosterAnalysis(r) {
  ok(r.lineup && isNum(r.lineup.total), 'lineup.total');
  for (const s of r.lineup.starters) ok(typeof s.id === 'string' && typeof s.slot === 'string' && isNum(s.value), 'starter row');
  for (const b of r.lineup.bench) ok(typeof b.id === 'string' && isNum(b.value) && isNum(b.share), 'bench row');
  ok(Number.isInteger(r.lineup.holes) && r.lineup.holes >= 0, 'holes');
  ok(isNum(r.strengthRos), 'strengthRos'); numOrNull(r.strengthNow, 'strengthNow'); ok(isNum(r.benchValue), 'benchValue');
  for (const g of RA.GROUPS) {
    const G = r.groups[g]; ok(G, 'group ' + g);
    ok(Number.isInteger(G.slots) && Number.isInteger(G.rostered), g + ' slots/rostered');
    ok(isNum(G.starterValue), g + ' starterValue'); numOrNull(G.nextUp, g + ' nextUp'); numOrNull(G.leagueAvg, g + ' leagueAvg'); numOrNull(G.rank, g + ' rank');
    ok(RA.TIERS.includes(G.tier), g + ' tier'); eq(G.status, RA.tierStatus(G.tier), g + ' status');
  }
  for (const g of RA.DISPLAY_GROUPS) ok(r.groups[g] && isNum(r.groups[g].starterValue), 'display group ' + g);
  eq(r.needs, RA.GROUPS.filter(g => r.groups[g].status === 'need'), 'needs derive from tiers');
  eq(r.surplus, RA.GROUPS.filter(g => r.groups[g].status === 'surplus'), 'surplus derive from tiers');
  ok(r.injuryExposure && 'thisWeek' in r.injuryExposure && 'next2' in r.injuryExposure, 'injuryExposure');
  noNaN(r, 'rosterAnalysis');
}

/* ------------------------------------------------------------ 1. shapes */
t('1 shapes: every team has every group, tiers are the 6 names, ranks are permutations, no NaN', async () => {
  const b = await board();
  const a = analyze(fixtureCtx(b), b);
  eq(a.teams.length, 12);
  const n = a.teams.length, perm = xs => eq(xs.slice().sort((x, y) => x - y), Array.from({ length: n }, (_, i) => i + 1));
  for (const tm of a.teams) {
    for (const g of RA.GROUPS.concat(RA.DISPLAY_GROUPS)) { ok(tm.groups[g], `${tm.rosterId} ${g}`); ok(RA.TIERS.includes(tm.groups[g].tier), 'tier name'); }
    ok(isNum(tm.strengthRos) && isNum(tm.strengthNow), 'strengths');
    ok(Array.isArray(tm.weaknesses) && Array.isArray(tm.strengths), 'weaknesses/strengths');
    for (const w of tm.weaknesses) ok(['critical', 'upgrade', 'thin'].includes(w.tier), 'weakness tiers');
    ok(['contend', 'balanced', 'preseason'].includes(tm.lean), 'lean');
  }
  perm(a.teams.map(x => x.powerRank)); perm(a.teams.map(x => x.nowRank)); perm(a.teams.map(x => x.benchRank));
  for (const g of RA.GROUPS) perm(a.teams.map(x => x.groupRank[g]));
  eq(a.teams.map(x => x.powerRank), Array.from({ length: n }, (_, i) => i + 1), 'teams sorted by power rank');
  for (let i = 1; i < n; i++) ok(a.teams[i - 1].strengthRos >= a.teams[i].strengthRos, 'power rank follows strength');
  eq(a.ranks.power, a.teams.map(x => x.rosterId), 'ranks.power');
  ok(a.ranks.points === null, 'preseason: no points rank'); ok(a.teams.every(x => x.pointsRank === null && x.lean === 'preseason'), 'preseason lean');
  noNaN(a, 'analysis');
});

t('strength = the trade engine\'s weekValue exactly (every roster, every remaining week)', async () => {
  const b = await board();
  const ctx = fixtureCtx(b);
  const idx = new Map(b.map(p => [String(p.id), p]));
  const rostered = ctx.teams.flatMap(x => x.players.map(p => p.id));
  const E = T.createEvaluator({ players: b, currentWeek: CW, settings: {}, leagueRostered: rostered, profile: PROFILE });
  const weeks = E.weeks.map(w => w.week);
  const repl = TA.replacementFor(b, PROFILE, weeks, rostered);
  eq(repl.perWeek, E.repl.perWeek, 'same replacement level');
  let maxd = 0, n = 0;
  for (const tm of ctx.teams) {
    const ro = tm.players.map(p => idx.get(p.id));
    const tv = E.teamValue(ro, E.capFor(ro));
    for (const w of weeks) { maxd = Math.max(maxd, Math.abs(TA.weekValue(ro, PROFILE, w, repl).total - tv.byWeek[w])); n++; }
  }
  ok(maxd < 1e-9, `max |Δ| ${maxd} over ${n} team-weeks`);
  // strengthRos = horizon-weighted mean (playoff weeks 1.5×) of those values.
  const a = analyze(ctx, b);
  const me = a.teams.find(x => x.rosterId === '1');
  const ro = ctx.teams[0].players.map(p => idx.get(p.id));
  const hw = TA.horizonWeeks(PROFILE, CW, 'ros');
  const m = hw.reduce((s, w) => s + w.weight * TA.weekValue(ro, PROFILE, w.week, repl).total, 0) / hw.reduce((s, w) => s + w.weight, 0);
  ok(Math.abs(me.strengthRos - m) <= 0.05, `strengthRos ${me.strengthRos} vs ${m}`);
  // The trade calculator's beforePerWeek for the same roster is the same number.
  const tr = T.evaluateTrade({ players: b, currentWeek: CW, myRoster: ctx.teams[0].players.map(p => p.id), partnerRoster: ctx.teams[1].players.map(p => p.id), give: [ctx.teams[0].players[0].id], get: [ctx.teams[1].players[0].id], leagueRostered: rostered, profile: PROFILE });
  ok(Math.abs(tr.you.beforePerWeek - me.strengthRos) <= 0.1, `trade beforePerWeek ${tr.you.beforePerWeek} vs ${me.strengthRos}`);
});

t('horizons: ros / next4 / playoffs pick the right weeks and change the ranking basis', async () => {
  const hw = h => TA.horizonWeeks(PROFILE, 1, h);
  eq(hw('ros').length, 23); eq(hw('next4').map(w => w.week), [1, 2, 3, 4]); eq(hw('playoffs').map(w => w.week), [21, 22, 23]);
  ok(hw('ros').filter(w => w.weight === 1.5).length === 3, 'playoff weeks 1.5×');
  eq(TA.horizonWeeks(PROFILE, 30, 'ros').map(w => w.week), [23], 'past the end → last week');
  eq(TA.horizonWeeks(PROFILE, 22, 'next4').map(w => w.week), [22, 23]);
  const b = await board();
  const p = analyze(fixtureCtx(b), b, { horizon: 'playoffs', targets: false });
  eq(p.horizon, 'playoffs'); eq(p.weeks.map(w => w.week), [21, 22, 23]);
  noNaN(p);
});

/* ------------------------------------------------------------ 2. order invariance */
t('2 order invariance: shuffling rosters and players does not change the output', async () => {
  const b = await board();
  const base = analyze(fixtureCtx(b), b, { targets: true });
  for (const seed of [7, 99, 12345]) {
    const ctx = fixtureCtx(b);
    ctx.teams = shuffle(ctx.teams, seed).map(tm => ({ ...tm, players: shuffle(tm.players, seed + 1) }));
    const a = analyze(ctx, shuffle(b, seed + 2), { targets: true });
    eq(JSON.stringify(a), JSON.stringify(base), 'seed ' + seed);
  }
});

/* ------------------------------------------------------------ 3. league context */
t('3 league context from the recorded fixtures: 12 teams, my roster 1, 10 starters each, 0 unmatched', async () => {
  const b = await board();
  const ctx = fixtureCtx(b);
  validateLeagueContext(ctx);
  eq(ctx.teams.length, 12); eq(ctx.myRosterId, '1');
  ok(ctx.teams.every(tm => tm.starters.length === 10), '10 starters per Sleeper roster');
  eq(ctx.teams.reduce((s, tm) => s + tm.unmatched.length, 0), 0, 'every rostered player is on the board');
  eq(ctx.teams.find(x => x.rosterId === '2').reserve.length, 2, 'roster 2 carries 2 IL players');
  ok(ctx.teams.find(x => x.rosterId === '2').players.filter(p => p.slot === 'IL').length === 2, 'IL slot');
  const a = analyze(ctx, b, { targets: false });
  ok(a.teams.every(x => x.lineup.now.starters.length === 10), '10 starting slots in every weekly lineup');
  ok(a.teams.find(x => x.rosterId === '2').il.length === 2, 'IL players tracked');
  // co-owner and stranger
  eq(fixtureCtx(b, { userId: '42' }).myRosterId, null, 'not in league → null');
});

/* ------------------------------------------------------------ local stand-ins = contract shapes */
t('local analyzeRoster / leagueContext / signals stand-ins have the contract shapes', async () => {
  const b = await board();
  const ctx = fixtureCtx(b);
  const idx = new Map(b.map(p => [String(p.id), p]));
  const weeks = TA.horizonWeeks(PROFILE, CW, 'ros');
  const repl = TA.replacementFor(b, PROFILE, weeks.map(w => w.week), ctx.teams.flatMap(x => x.players.map(p => p.id)));
  const players = ctx.teams[0].players.map(p => idx.get(p.id));
  const r = TA.analyzeRosterLocal({ players, profile: PROFILE, weeks, replacement: repl, currentWeek: CW });
  validateRosterAnalysis(r);
  eq(r.lineup.starters.length + r.lineup.waiver.length + r.lineup.holes, 10, '10 starting slots');
  const data = require('../nba/model/data').load();
  const sig = TA.signalsLocal(players, { profile: PROFILE, currentWeek: CW, weeks, logs: data.logs, today: '2026-10-15' });
  eq(sig.size, players.length);
  for (const s of sig.values()) {
    ok(typeof s.id === 'string' && isNum(s.value.ros) && isNum(s.value.blended), 'value');
    if (s.form) { ok([null, 'hot', 'cold'].includes(s.form.label), 'form.label'); ok(typeof s.form.stale === 'boolean', 'form.stale'); }
    ok([null, 'up', 'down', 'flat'].includes(s.minutes.trend), 'minutes.trend');
    ok(s.uncertainty >= 0.1 && s.uncertainty <= 0.35, 'uncertainty');
    ok(Array.isArray(s.flags), 'flags');
    noNaN(s, 'signals');
  }
  ok([...sig.values()].some(s => s.form && s.form.stale), 'preseason form is from last season (stale)');
});

/* ------------------------------------------------------------ 4. tiers */
t('4 tiers: one C-eligible player and no bench C → thin/critical; adding a top-24 C → not a need', async () => {
  const b = await board();
  const elig = p => R.eligFor(p, PROFILE);
  const cOnly = b.filter(p => elig(p).has('C') && !elig(p).has('PF') && !elig(p).has('SF') && !p.injury);
  const nonC = b.filter(p => !elig(p).has('C') && !p.injury);
  const ctx = fixtureCtx(b);
  const used = new Set(ctx.teams.flatMap(x => x.players.map(p => p.id)));
  // Replace roster 1 with: 1 C (mid-tier) + 12 non-C players.
  const c1 = cOnly.find(p => p.rank > 60 && !used.has(String(p.id)));
  const rest = nonC.filter(p => !used.has(String(p.id))).slice(10, 22);
  ctx.teams[0] = { ...ctx.teams[0], players: [c1].concat(rest).map(p => ({ id: String(p.id), onBoard: true, slot: 'BN' })), reserve: [], starters: [] };
  const a = analyze(ctx, b, { targets: false });
  const me = a.teams.find(x => x.rosterId === '1');
  ok(['thin', 'critical'].includes(me.groups.C.tier), 'C tier ' + me.groups.C.tier);
  ok(me.needs.includes('C') && me.weaknesses.some(w => w.group === 'C'), 'C named as a need');
  const top = cOnly.find(p => p.rank <= 24 && !used.has(String(p.id))) || b.filter(p => elig(p).has('C') && p.rank <= 24)[0];
  ctx.teams[0].players.push({ id: String(top.id), onBoard: true, slot: 'BN' });
  for (const tm of ctx.teams.slice(1)) tm.players = tm.players.filter(p => p.id !== String(top.id));
  const a2 = analyze(ctx, b, { targets: false });
  const me2 = a2.teams.find(x => x.rosterId === '1');
  ok(['solid', 'deep', 'loaded'].includes(me2.groups.C.tier), 'C tier after a top-24 C: ' + me2.groups.C.tier);
  ok(!me2.needs.includes('C'), 'C no longer a need');
});

t('a team with no C-eligible player: C is critical, the slot is filled at waiver level, no NaN', async () => {
  const b = await board();
  const elig = p => R.eligFor(p, PROFILE);
  const ctx = fixtureCtx(b);
  const used = new Set(ctx.teams.flatMap(x => x.players.map(p => p.id)));
  const guards = b.filter(p => !elig(p).has('C') && !used.has(String(p.id)) && !p.injury).slice(0, 14);
  ctx.teams[0] = { ...ctx.teams[0], players: guards.map(p => ({ id: String(p.id), onBoard: true, slot: 'BN' })), reserve: [], starters: [] };
  const a = analyze(ctx, b, { targets: false });
  const me = a.teams.find(x => x.rosterId === '1');
  eq(me.groups.C.rostered, 0); eq(me.groups.C.tier, 'critical');
  ok(me.lineup.now.starters.some(s => s.slot === 'C' && s.replacement), 'C filled by a waiver add');
  noNaN(a);
});

/* ------------------------------------------------------------ 5. partners + targets */
t('5 partners: a team that needs C while I have C depth is partner #1; targets include a C-for-G swap within the rules', async () => {
  const b = await board();
  const elig = p => R.eligFor(p, PROFILE);
  const healthy = b.filter(p => !p.injury && !p.outForSeason && p.source === 'logs');
  const isC = p => elig(p).has('C');
  const isG = p => (elig(p).has('PG') || elig(p).has('SG')) && !isC(p);
  const pureG = p => isG(p) && !elig(p).has('SF') && !elig(p).has('PF');
  const isF = p => (elig(p).has('SF') || elig(p).has('PF')) && !isC(p) && !isG(p);
  const take = new Set();
  const pick = (pred, n, from = 0) => { const out = []; for (const p of healthy.slice(from)) { if (out.length >= n) break; if (!take.has(p.id) && pred(p)) { take.add(p.id); out.push(String(p.id)); } } return out; };
  // Me: an elite center plus two good ones (C is my only surplus), four forwards, weak guards.
  // Them: no center, two weak forwards, deep good pure guards. Ten more teams snake-draft the rest (12-team league).
  const me = pick(isC, 1, 0).concat(pick(isC, 2, 40), pick(isF, 4, 10), pick(pureG, 6, 150));
  const them = pick(pureG, 11, 0).concat(pick(isF, 2, 220));
  const others = Array.from({ length: 10 }, () => []);
  const pool = b.filter(p => !take.has(p.id)); // the whole board, so the waiver pool is realistic
  for (let r = 0, k = 0; r < 13; r++) for (let i = 0; i < 10; i++) others[r % 2 ? 9 - i : i].push(String(pool[k++].id));
  const mk = (rid, name, ids) => ({ rosterId: rid, name, ownerId: rid === '1' ? 'me' : null, displayName: null, avatar: null, coOwners: [], record: { wins: 0, losses: 0, ties: 0, fpts: 0, fptsAgainst: 0 }, waiverPosition: null, totalMoves: 0,
    players: ids.map(id => ({ id, onBoard: true, slot: 'BN' })), starters: [], reserve: [], unmatched: [] });
  const ctx = { leagueId: '1', name: 'Test', season: '2026', teams: [mk('1', 'Me', me), mk('2', 'Guards R Us', them)].concat(others.map((ids, i) => mk(String(i + 3), 'Other ' + (i + 1), ids))),
    myRosterId: '1', currentWeek: CW, opponentByRoster: null, profile: PROFILE };
  const a = analyze(ctx, b, { targets: true });
  const mine = a.teams.find(x => x.rosterId === '1'), b2 = a.teams.find(x => x.rosterId === '2');
  ok(mine.surplus.includes('C'), 'I have C surplus: ' + JSON.stringify(mine.groups.C));
  ok(b2.needs.includes('C'), 'they need C: ' + JSON.stringify(b2.groups.C));
  ok(a.partners.length && a.partners[0].rosterId === '2', 'partner #1 is the C-needy team: ' + JSON.stringify(a.partners));
  ok(a.partners[0].theyNeed.includes('C') && a.partners[0].score >= 2, 'score = 2·overlap + mutual');
  const swap = a.targets.find(x => x.partner === '2' && isC(b.find(p => String(p.id) === x.give[0].id)) && isG(b.find(p => String(p.id) === x.get[0].id)));
  ok(swap, 'a C-for-G target: ' + JSON.stringify(a.targets.map(x => [x.partner, x.give[0].name, x.give[0].group, x.get[0].name, x.get[0].group, x.you, x.them])));
  ok(swap.you >= 0.5 * swap.band && swap.them >= -swap.band, 'Δ within rules');
  ok(/^\/nba\/trade\?league_id=1&partner=2&give=\d+&get=\d+$/.test(swap.href), 'deep link ' + swap.href);
  ok(a.targetsEvaluated <= TA.TARGET_EVALS, 'evaluation cap');
  for (let i = 1; i < a.targets.length; i++) ok(a.targets[i - 1].you + a.targets[i - 1].them >= a.targets[i].you + a.targets[i].them - 1e-9, 'targets sorted by combined gain');
});

t('20-team league: shapes hold, ranks 1..20', async () => {
  const b = await board();
  const prof = { ...PROFILE, teams: 20 };
  const ctx = TA.typicalLeague({ board: b, myIds: b.slice(0, 13).map(p => String(p.id)), profile: prof, currentWeek: CW });
  eq(ctx.teams.length, 20);
  ctx.myRosterId = '10';
  const a = analyze(ctx, b, { targets: false });
  eq(a.teams.map(x => x.powerRank).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
  noNaN(a);
});

/* ------------------------------------------------------------ 6 + 7. routes */
function fakeClient() {
  const calls = {};
  const mode = { fail: null };
  const hit = k => { calls[k] = (calls[k] || 0) + 1; if (mode.fail) throw mode.fail; };
  const LEAGUE = fx('sleeper-league.json');
  const CATS = { ...LEAGUE, league_id: '777', settings: { ...LEAGUE.settings, scoring_type: 'h2h_category' } };
  return { calls, mode, client: {
    async state() { hit('state'); return fx('sleeper-state.json'); },
    async league(id) { hit('league'); return id === LEAGUE.league_id ? LEAGUE : id === '777' ? CATS : null; },
    async leagueUsers() { hit('users'); return fx('sleeper-users.json'); },
    async leagueRosters() { hit('rosters'); return fx('sleeper-rosters.json'); },
    async leagueDrafts() { hit('drafts'); return []; },
    async leagueMatchups() { hit('matchups'); return []; },
    async draft() { hit('draft'); return null; },
  } };
}
async function server(opts = {}) {
  const cache = new Map();
  const apiCached = async (k, ttl, fn) => { const h = cache.get(k); if (h && Date.now() - h.t < ttl) return h.v; const v = await fn(); cache.set(k, { v, t: Date.now() }); return v; };
  const fc = fakeClient();
  const modelPlayers = () => model.getPlayers({});
  const sleeper = require('../nba/routes/sleeper')({ apiCached, modelPlayers, client: fc.client, log: { error() {} } });
  const app = express();
  app.use(createTeamRoutes({ apiCached, loadModel: opts.loadModel || (() => model), sleeper, log: { error() {} }, env: {}, rateLimit: opts.rateLimit }));
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p, init) => { const r = await fetch(base + p, init); let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j, headers: r.headers }; };
  return { srv, base, get, fc, close: () => new Promise(r => srv.close(r)) };
}
const LID = '1411447094215991296', UID = '1044077615075872768';

t('7 routes: /api/nba/team 200 + one upstream fetch for two calls (cache), detail, view-as', async () => {
  const s = await server();
  try {
    const a = await s.get(`/api/nba/team?league_id=${LID}&user_id=${UID}`);
    eq(a.status, 200, JSON.stringify(a.json).slice(0, 200));
    eq(a.json.myRosterId, '1'); eq(a.json.analysis.teams.length, 12); eq(a.json.league.weeks, 23); eq(a.json.league.starters, 10);
    ok(a.json.players && Object.keys(a.json.players).length >= 150, 'player names for the page');
    eq(a.headers.get('cache-control'), 'private, no-store');
    const b2 = await s.get(`/api/nba/team?league_id=${LID}&user_id=${UID}`);
    eq(b2.status, 200);
    eq(s.fc.calls.rosters, 1, 'two calls → one upstream rosters fetch'); eq(s.fc.calls.league, 1, 'one league fetch');
    eq(JSON.stringify(b2.json.analysis.teams), JSON.stringify(a.json.analysis.teams), 'cached analysis');
    const d = await s.get(`/api/nba/team/detail?league_id=${LID}&roster_id=2`);
    eq(d.status, 200); eq(d.json.team.rosterId, '2'); ok(d.json.roster.length === 16 && d.json.roster.filter(r => r.slot === 'IL').length === 2, 'detail roster with 2 IL');
    ok(d.json.roster.every(r => r.signals && 'form' in r.signals && 'minutes' in r.signals), 'signals per player'); eq(d.json.weeks.length, 23);
    const v = await s.get(`/api/nba/team?league_id=${LID}&roster_id=5&horizon=next4`);
    eq(v.status, 200); eq(v.json.myRosterId, '5'); eq(v.json.ownRosterId, null); eq(v.json.viewAs, true); eq(v.json.analysis.horizon, 'next4');
    ok(Array.isArray(v.json.analysis.targets), 'targets for the viewed team');
  } finally { await s.close(); }
});

t('7 routes: 400 / 404 / 429 / 503 paths', async () => {
  const s = await server({ rateLimit: createTeamRoutes.createRateLimit({ max: 12 }) });
  try {
    eq((await s.get('/api/nba/team?league_id=abc')).status, 400, 'bad league_id');
    eq((await s.get(`/api/nba/team?league_id=${LID}&horizon=forever`)).status, 400, 'bad horizon');
    eq((await s.get(`/api/nba/team?league_id=${LID}&roster_id=x1`)).status, 400, 'bad roster_id');
    eq((await s.get(`/api/nba/team/detail?league_id=${LID}`)).status, 400, 'detail needs roster_id');
    const cat = await s.get('/api/nba/team?league_id=777');
    eq(cat.status, 400); eq(cat.json.code, 'league_not_points');
    const nf = await s.get('/api/nba/team?league_id=123');
    eq(nf.status, 404); eq(nf.json.code, 'sleeper_not_found');
    const tnf = await s.get(`/api/nba/team?league_id=${LID}&roster_id=99`);
    eq(tnf.status, 404); eq(tnf.json.code, 'team_not_found');
    s.fc.mode.fail = new SleeperError('Sleeper rate limit', { status: 429, code: 'sleeper_rate_limited', retryAfterS: 7 });
    const rl = await s.get('/api/nba/team?league_id=1411447094215990000');
    eq(rl.status, 429); eq(rl.json.code, 'sleeper_rate_limited'); eq(rl.headers.get('retry-after'), '7');
    s.fc.mode.fail = new SleeperError('Sleeper unreachable', { status: null, code: 'sleeper_upstream' });
    eq((await s.get('/api/nba/team?league_id=1411447094215990001')).status, 502, 'Sleeper down → 502');
    s.fc.mode.fail = null;
    let last = null;
    for (let i = 0; i < 4; i++) last = await s.get('/api/nba/team?league_id=abc');
    eq(last.status, 429, 'our own per-IP limit'); ok(Number(last.headers.get('retry-after')) >= 1, 'Retry-After');
  } finally { await s.close(); }
  const s2 = await server({ loadModel: () => require('../nba/router').MODEL_STUB });
  try {
    const r = await s2.get(`/api/nba/team?league_id=${LID}`);
    eq(r.status, 503, 'board unavailable → 503');
    const m = await s2.get('/api/nba/team/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roster: ['1658'] }) });
    eq(m.status, 503, 'manual without a board → 503');
  } finally { await s2.close(); }
});

t('6 manual: POST /api/nba/team/manual with 13 ids → estimated, same shape; bad bodies 400', async () => {
  const s = await server();
  try {
    const b = await board();
    const ids = b.filter(p => !p.injury).slice(30, 43).map(p => String(p.id));
    const post = body => s.get('/api/nba/team/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const r = await post({ roster: ids });
    eq(r.status, 200, JSON.stringify(r.json).slice(0, 200));
    eq(r.json.estimated, true); eq(r.json.analysis.estimated, true);
    eq(r.json.analysis.teams.length, 12, 'typical 12-team league');
    const me = r.json.analysis.teams.find(x => x.rosterId === r.json.myRosterId);
    eq(me.playerCount, 13); eq(me.name, 'Your Team');
    for (const k of ['strengthRos', 'strengthNow', 'groups', 'weaknesses', 'strengths', 'injuryExposure', 'powerRank', 'groupRank', 'lineup']) ok(k in me, 'team field ' + k);
    eq(r.json.analysis.partners, []); eq(r.json.analysis.targets, []);
    const others = new Set(r.json.analysis.teams.filter(x => x.rosterId !== r.json.myRosterId).flatMap(x => x.lineup.starters.map(st => st.id)));
    ok(ids.every(id => !others.has(id)), 'my players are removed from the typical teams');
    const unk = await post({ roster: ids.concat(['99999999']) });
    eq(unk.status, 200); eq(unk.json.unknown, ['99999999']);
    eq((await post({ roster: [] })).status, 400, 'empty roster');
    eq((await post({ roster: ['<x>'] })).status, 400, 'bad id');
    eq((await post({ roster: Array.from({ length: 26 }, (_, i) => String(i + 1)) })).status, 400, 'too many');
    eq((await post('{nope')).status, 400, 'invalid JSON');
    eq((await post({ roster: ids, horizon: 'x' })).status, 400, 'bad horizon');
    const lg = await post({ roster: ids, league_id: LID, horizon: 'playoffs' });
    eq(lg.status, 200); eq(lg.json.league.name, 'HALIMSANITY 26-27', 'league_id → that league\'s profile'); eq(lg.json.analysis.horizon, 'playoffs');
  } finally { await s.close(); }
});

t('page route, static deny, nav entry and sitemap', async () => {
  const createNbaRouter = require('../nba/router');
  const fc = fakeClient();
  const cache = new Map();
  const apiCached = async (k, ttl, fn) => { const h = cache.get(k); if (h && Date.now() - h.t < ttl) return h.v; const v = await fn(); cache.set(k, { v, t: Date.now() }); return v; };
  const app = express();
  app.use('/', createNbaRouter({ auth: (q, r) => r.status(401).end(), getAuth: () => ({}), apiCached, env: { NBA_YAHOO_ENABLED: '' }, log: { error() {}, warn() {} }, sleeperClient: fc.client }));
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const page = await fetch(base + '/nba/team');
    eq(page.status, 200);
    const html = await page.text();
    ok(/<title>[^<]*NBA[^<]*<\/title>/.test(html) && /class="sport-nba nba-ui"/.test(html) && /NbaUI\.mountNav\(\{ active: 'team' \}\)/.test(html), 'NBA page shell');
    eq((await fetch(base + '/nba/model/team-analysis.js')).status, 404, 'model source is never served');
    eq((await fetch(base + '/nba/routes/team.js')).status, 404, 'route source is never served');
    eq((await fetch(`${base}/api/nba/team?league_id=${LID}&user_id=${UID}`)).status, 200, 'mounted in the NBA router');
  } finally { await new Promise(r => srv.close(r)); }
  const UI = require('../nba/pages/nba-ui.js');
  const nav = UI.navHtml({ active: 'team' });
  ok(/href="\/nba\/team" class="rr-link active"/.test(nav.nav) && /href="\/nba\/team"[^>]*aria-current="page"/.test(nav.tabbar), 'Team tab in the NBA nav + tab bar');
  eq(UI.NAV_TABS.map(x => x.key), ['board', 'research', 'lineup', 'trade', 'team', 'waivers'], 'Team sits between Trade and Waivers');
  ok(/\/nba\/team/.test(fs.readFileSync(path.join(ROOT, 'shared', 'nav.js'), 'utf8')), 'shared/nav.js NBA_LINKS');
  ok(/path: '\/nba\/team'/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')), 'sitemap entry');
  const src = ['team.html', 'team.js', 'team-logic.js', 'team.css'].map(f => fs.readFileSync(path.join(ROOT, 'nba', 'pages', f), 'utf8')).join('\n');
  ok(!/Yahoo/.test(src), 'no Yahoo strings on the team page');
});

/* ------------------------------------------------------------ page logic */
t('team-logic: tiers, sort, plain-English lines, ETA, saved state', () => {
  eq(Object.keys(TL.TIER), RA.TIERS, 'same six tiers in the same order');
  eq(TL.tierText('critical'), '▲ Critical'); eq(TL.tierText('thin'), '△ Thin'); eq(TL.tierText('solid'), '● Solid'); eq(TL.tierText('deep'), '▼ Deep'); eq(TL.tierText('loaded'), '◆ Loaded');
  const team = { name: 'X', groups: { C: { tier: 'thin', starters: [{ id: '1', slot: 'C', value: 31 }], starterValue: 31, nextUp: null, nextUpId: null, rostered: 1, slots: 1 },
    G: { tier: 'loaded', starters: [], starterValue: 150, rostered: 7, slots: 3 } }, groupRank: { C: 9, G: 1 } };
  eq(TL.weaknessText(team, { group: 'C', tier: 'thin', rank: 9 }, 12, { 1: { name: 'Jusuf Nurkić' } }), 'Thin at C: Nurkić 31.0/wk, nobody healthy behind him. 9th of 12.');
  eq(TL.strengthText(team, { group: 'G', tier: 'loaded', rank: 1 }, 12, {}), 'Loaded at G: 7 healthy players for 3 slots, 1st of 12.');
  const bare = { groups: { C: { tier: 'critical', starterValue: 25.4, nextUp: null, rostered: 0, slots: 1 } } };
  eq(TL.weaknessText(bare, { group: 'C', tier: 'critical', rank: 12 }, 12, {}), 'Weakest at C: 25.4/wk from 1 slot, nobody healthy behind him. 12th of 12.', 'contract-only group (no starters list)');
  eq(TL.etaText({ status: 'OUT', returnDate: '2027-01-02', returnWeek: 11 }), '~wk 11 (Jan 2)'); eq(TL.etaText(null), null);
  const ts = [{ powerRank: 2, name: 'b', strengthRos: 2, groupRank: { C: 1 } }, { powerRank: 1, name: 'a', strengthRos: 3, groupRank: { C: 2 } }];
  eq(TL.sortTeams(ts, 'rank').map(x => x.name), ['a', 'b']); eq(TL.sortTeams(ts, 'C').map(x => x.name), ['b', 'a']); eq(TL.sortTeams(ts, 'C', 1).map(x => x.name), ['a', 'b']);
  eq(TL.recordText({ record: { wins: 3, losses: 1, ties: 0 } }, true), '3-1'); eq(TL.recordText({ record: { wins: 0, losses: 0 } }, false), '—');
  const st = TL.parseState(TL.serialize({ horizon: 'next4', roster: ['1', '2', '<bad>', '1'], viewAs: { 9: '3' } }));
  eq(st.horizon, 'next4'); eq(st.roster, ['1', '2']); eq(TL.parseState('nope').horizon, 'ros');
  eq(TL.tradeRoster(JSON.stringify({ v: 1, myRoster: ['5', '6'] })), ['5', '6']);
  eq(TL.teamUrl({ leagueId: '1', userId: '2', rosterId: '3', horizon: 'playoffs' }), '/api/nba/team?league_id=1&user_id=2&roster_id=3&horizon=playoffs');
  for (const v of Object.values(TL.TIER)) ok(/^[A-Z]/.test(v.label), 'Title Case tier labels');
});

t('healthy value: an injured player loses value this week, a healthy one loses none', async () => {
  const b = await board();
  const dtd = b.find(p => /DTD/i.test(p.injury || '') && p.hsValue > 30);
  const fine = b.find(p => !p.injury && p.hsValue > 30);
  const inj = TA.injuriesOf([dtd, fine], CW, [CW, CW + 1], null);
  eq(inj.list.length, 1); eq(inj.list[0].id, String(dtd.id));
  ok(inj.list[0].lostThisWeek > 0 && inj.list[0].lostThisWeek < dtd.hsValue, `DTD lost ${inj.list[0].lostThisWeek}`);
  ok(inj.next2 >= inj.thisWeek, 'next2 ≥ this week');
  const h = TA.healthyByWeek(fine, [CW], CW);
  eq(h[CW], fine.hsByWeek[CW], 'healthy players: board value');
});

/* ------------------------------------------------------------ runner */
(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); }
  }
  console.log(`\nnba team: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
