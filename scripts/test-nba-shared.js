#!/usr/bin/env node
/* Stream A shared layer: ESPN injury ETA (§4.3 rule table, matching, cache),
   ETA-aware board availability, Sleeper profile/context, signals on fixture
   players, roster tiers (and agreement with the trade engine's week value),
   flagrant-foul scoring, and the route plumbing (/api/nba/players?league_id=,
   lineup / waivers under the league's Sleeper profile).
   Spec: docs/nba-trade-team-spec.md §3-§4.3. Offline (NBA_MODEL_OFFLINE=1).
   Run: node scripts/test-nba-shared.js   (exit 0 = pass) */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'docs', 'nba-spec', 'fixtures');
const SFIX = path.join(__dirname, 'fixtures', 'nba', 'sleeper');
const fx = n => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const sfx = n => JSON.parse(fs.readFileSync(path.join(SFIX, n), 'utf8'));
const model = require('../nba/model');
const Data = require('../nba/model/data');
const Board = require('../nba/model/board');
const ETA = require('../nba/model/injury-eta');
const LS = require('../nba/model/league-sync');
const SIG = require('../nba/model/signals');
const RA = require('../nba/model/roster-analysis');
const T = require('../nba/model/trade');
const Sc = require('../nba/model/score');
const LC = require('../nba/routes/league-context');
const { SleeperError } = require('../nba/sleeper/client');

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const ok = (v, msg) => (msg === undefined ? assert.ok(v) : assert.ok(v, msg));
const eq = (a, b, msg) => (msg === undefined ? assert.deepStrictEqual(a, b) : assert.deepStrictEqual(a, b, msg));
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ±${tol}, got ${a}`);
const noNaN = (o, where = 'root') => {
  if (typeof o === 'number') { ok(Number.isFinite(o), `NaN/Infinity at ${where}`); return; }
  if (Array.isArray(o)) return o.forEach((x, i) => noNaN(x, `${where}[${i}]`));
  if (o && typeof o === 'object') for (const k of Object.keys(o)) noNaN(o[k], `${where}.${k}`);
};

const PROF = fx('profile-from-sleeper.expected.json');
const LEAGUE = fx('sleeper-league.json'), USERS = fx('sleeper-users.json'), ROSTERS = fx('sleeper-rosters.json'), STATE = fx('sleeper-state.json');
const ME = '1044077615075872768';
const SAMPLE = fx('espn-injuries-sample.json');
const DOC = { source: ETA.URL, fetchedAt: SAMPLE.fetchedAt, rows: SAMPLE.rows.map(r => ({ ...r, norm: null })) };
const wk = n => PROF.weeks[n - 1];
const day = s => Math.floor(Date.parse(s + 'T00:00:00Z') / 86400000);
const horizon = (prof, cw, playoffW = 1.5) => prof.weeks.filter(w => w.week >= cw).map(w => ({ week: w.week, weight: w.playoffs ? playoffW : 1, playoff: !!w.playoffs }));

// Raw ESPN payload (the shape site.api.espn.com returns) from the flattened sample rows.
function espnPayload(rows) {
  const byTeam = new Map();
  for (const r of rows) {
    if (!byTeam.has(r.team)) byTeam.set(r.team, []);
    byTeam.get(r.team).push({ athlete: { displayName: r.name }, status: r.status, date: r.date, shortComment: r.shortComment, details: { fantasyStatus: { abbreviation: r.fantasyStatus }, type: r.type, detail: r.detail, returnDate: r.returnDate } });
  }
  return { timestamp: '2026-10-16T01:47:09Z', injuries: [...byTeam].map(([displayName, injuries]) => ({ displayName, injuries })) };
}

let boards = null;
async function getBoards() {
  if (!boards) {
    const [eta, none] = await Promise.all([model.getPlayers({ profile: PROF, eta: DOC }), model.getPlayers({ profile: PROF, eta: null })]);
    boards = { eta, none, byId: new Map(eta.players.map(p => [p.id, p])), byId0: new Map(none.players.map(p => [p.id, p])) };
  }
  return boards;
}

/* ------------------------------------------------------------ 1. ESPN ETA */
t('eta: parseEspn turns the raw feed into EtaDoc rows (Sleeper team abbrs, normalised names, statuses)', () => {
  const doc = ETA.parseEspn(espnPayload(SAMPLE.rows), { now: new Date('2026-10-16T02:00:00Z') });
  eq(doc.rows.length, SAMPLE.rows.length);
  eq(doc.source, ETA.URL); eq(doc.fetchedAt, '2026-10-16T02:00:00.000Z');
  for (const r of doc.rows) { ok(/^[A-Z]{3}$/.test(r.team), 'team abbr ' + r.team); ok(r.norm && r.norm === r.norm.toLowerCase(), 'norm'); ok(['GTD', 'OUT', 'OFS'].includes(r.fantasyStatus)); }
  const b = doc.rows.find(r => /Butler/.test(r.name));
  eq([b.norm, b.team, b.returnDate, b.bodyPart, b.detail], ['jimmy butler', 'GSW', '2027-01-02', 'Knee', 'Surgery']);
  eq(ETA.parseEspn({ injuries: 'nope' }).rows, [], 'garbage payload → no rows');
  eq(ETA.teamAbbr('LA Clippers'), 'LAC'); eq(ETA.teamAbbr('GS'), 'GSW'); eq(ETA.teamAbbr('Nowhere FC'), null);
});

t('eta: matchEta — name+team, suffixes (Butler III), team mismatch, name collisions → null', () => {
  const m = ETA.matchEta(DOC, { id: '1000', name: 'Jimmy Butler', team: 'GSW' }, { weeks: PROF.weeks });
  eq([m.status, m.returnDate, m.returnWeek, m.matchedBy, m.stale], ['OUT', '2027-01-02', 11, 'name+team', false]);
  eq(ETA.matchEta(DOC, { name: 'Jimmy Butler', team: 'MIA' }), null, 'wrong team → no match');
  eq(ETA.matchEta(DOC, { name: 'Nobody Atall', team: 'GSW' }), null);
  const row = { name: 'Jaylen Brown', status: 'Out', fantasyStatus: 'OUT', returnDate: '2026-11-01', date: '2026-10-10T00:00Z' };
  eq(ETA.matchEta({ rows: [{ ...row, team: 'Boston Celtics' }, { ...row, team: 'Boston Celtics' }] }, { name: 'Jaylen Brown', team: 'BOS' }), null, 'two rows on his team → ambiguous');
  eq(ETA.matchEta({ rows: [{ ...row, team: 'Boston Celtics' }, { ...row, team: 'Utah Jazz' }] }, { name: 'Jaylen Brown' }), null, 'no team on our side + two rows → ambiguous');
  eq(ETA.matchEta({ rows: [{ ...row, team: 'Boston Celtics' }, { ...row, team: 'Utah Jazz', returnDate: '2027-01-01' }] }, { name: 'Jaylen Brown', team: 'UTA' }).returnDate, '2027-01-01', 'team disambiguates');
  eq(ETA.matchEta({ rows: [{ ...row, team: null }] }, { name: 'Jaylen Brown', team: 'BOS' }).matchedBy, 'name', 'a lone row with no team');
  eq(ETA.matchEta(null, { name: 'x' }), null);
});

t('eta: §4.3 stale guard — an old row about a player who has played since is stale', () => {
  const row = { name: 'Some Guy', team: 'Denver Nuggets', status: 'Out', fantasyStatus: 'OUT', returnDate: '2026-11-20', date: '2026-09-20T00:00Z' };
  const p = { id: '9', name: 'Some Guy', team: 'DEN' };
  eq(ETA.matchEta({ rows: [row] }, p, { now: '2026-10-15', logs: day('2026-10-01') }).stale, true, '> 14 days old + played after');
  eq(ETA.matchEta({ rows: [row] }, p, { now: '2026-10-15', logs: day('2026-09-01') }).stale, false, 'no game since the report');
  eq(ETA.matchEta({ rows: [row] }, p, { now: '2026-09-30', logs: day('2026-09-25') }).stale, false, 'report only 10 days old');
  const stale = ETA.matchEta({ rows: [row] }, p, { now: '2026-10-15', logs: day('2026-10-01') });
  eq(ETA.applyEtaToAvailability(0.8, 'Out', stale, wk(2), wk(1), { legacy: 0.42 }), 0.42, 'stale → the board\'s own value');
});

t('eta: §4.3 rule table (OUT / return week pro rata / first full week ×0.85 / GTD / OFS / disagreement / past)', () => {
  const R = '2027-01-02'; // Saturday of week 11 (Dec 28 - Jan 3)
  const out = { status: 'OUT', returnDate: R, stale: false };
  const A = (a0, inj, e, w, cur, o) => ETA.applyEtaToAvailability(a0, inj, e, typeof w === 'number' ? wk(w) : w, wk(cur), o);
  eq(A(0.8, 'Out', out, 5, 1), 0, 'before R → 0');
  eq(A(0.8, 'Out', out, 10, 1), 0, 'week ending before R → 0');
  const games = [day('2026-12-29'), day('2026-12-31'), day('2027-01-02')];
  near(A(0.8, 'Out', out, { ...wk(11), gameDays: games }, 1), 0.8 * 0.85 / 3, 1e-9, 'return week: ×0.85 × games on/after R / games');
  near(A(0.8, 'Out', out, 11, 1), 0.8 * 0.85 * 2 / 7, 1e-9, 'no game days → calendar days on/after R');
  eq(A(0.8, 'Out', out, { ...wk(11), gameDays: [day('2026-12-29')] }, 1), 0, 'no games left after R that week');
  near(A(0.8, 'Out', out, 12, 1), 0.68, 1e-9, 'first full week back ×0.85 (7-day rule)');
  near(A(0.8, 'Out', out, 12, 1, { weeks: PROF.weeks }), 0.68, 1e-9, 'first full week back ×0.85 (calendar)');
  eq(A(0.8, 'Out', out, 13, 1, { weeks: PROF.weeks }), 0.8, 'then a0');
  // Return on a Monday: that week is the full week back; no second discount.
  const mon = { status: 'OUT', returnDate: wk(12).start, stale: false };
  near(A(0.8, 'Out', mon, 12, 1, { weeks: PROF.weeks }), 0.68, 1e-9);
  eq(A(0.8, 'Out', mon, 13, 1, { weeks: PROF.weeks }), 0.8);
  // GTD within the current week: DTD rule now, healthy after.
  const gtd = { status: 'GTD', returnDate: '2026-10-22', stale: false };
  near(A(0.5, 'DTD', gtd, 1, 1), 0.75 * 0.55, 1e-9, 'DTD rule uses max(a0, 0.55)');
  eq(A(0.8, 'DTD', gtd, 2, 1), 0.8);
  // GTD dated before the current week (preseason rest rows): back now; Sleeper's own status still caps this week.
  const gtdPast = { status: 'GTD', returnDate: '2026-10-16', stale: false };
  eq(A(0.8, null, gtdPast, 1, 1), 0.8, 'no discount from a return date that has passed');
  eq(A(0.8, 'DTD', gtdPast, 1, 1, { legacy: 0.6 }), 0.6, 'Sleeper still says DTD → its rule this week');
  eq(A(0.8, 'DTD', gtdPast, 2, 1, { legacy: 0.8 }), 0.8);
  // GTD with a date past the current week = OUT until then.
  const gtdLate = { status: 'GTD', returnDate: wk(3).start, stale: false };
  eq(A(0.8, null, gtdLate, 1, 1), 0); eq(A(0.8, null, gtdLate, 2, 1), 0); near(A(0.8, null, gtdLate, 3, 1, { weeks: PROF.weeks }), 0.68, 1e-9);
  // OFS → 0 every week.
  for (const w of [1, 12, 23]) eq(A(0.9, null, { status: 'OFS', returnDate: '2027-07-01', stale: false }, w, 1), 0);
  // ESPN GTD vs Sleeper Out: the more pessimistic this week, ESPN's date after.
  eq(A(0.8, 'Out', gtd, 1, 1, { legacy: 0.1 }), 0.1, 'legacy (board) is lower → it wins this week');
  eq(A(0.8, 'Out', gtd, 1, 1), 0.1, 'without opts.legacy the board rule is recomputed (OUT d=0 → min(a0, 0.1))');
  eq(A(0.8, 'Out', gtd, 2, 1, { legacy: 0.35 }), 0.8, 'later weeks follow the ESPN date');
  // No ETA / no return date / past weeks.
  eq(A(0.8, 'Out', null, 4, 1, { legacy: 0.6 }), 0.6);
  eq(A(0.8, 'Out', { status: 'OUT', returnDate: null, stale: false }, 4, 1, { legacy: 0.6 }), 0.6);
  eq(A(0.8, 'Out', out, 1, 3), 0.8, 'a past week is history');
  eq(ETA.HEALTHY_FLOOR, Board.HEALTHY_FLOOR, 'injury-eta HEALTHY_FLOOR = board.js');
});

t('eta: fetch → disk cache → load; failures keep the previous doc; offline never fetches; old docs ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-eta-'));
  const okFetch = async () => ({ ok: true, status: 200, json: async () => espnPayload(SAMPLE.rows) });
  try {
    ETA._reset();
    const doc = await ETA.fetchInjuryEta({ fetchImpl: okFetch, cacheDir: dir, now: new Date() });
    eq(doc.rows.length, 40);
    ok(fs.existsSync(path.join(dir, ETA.CACHE_FILE)), 'cache file written');
    ETA._reset();
    eq(ETA.loadInjuryEta({ cacheDir: dir, allowDisk: false }), null, 'offline: no disk read');
    eq(ETA.loadInjuryEta({ cacheDir: dir, allowDisk: true }).rows.length, 40, 'disk → memory');
    const v = ETA.version();
    await assert.rejects(ETA.fetchInjuryEta({ fetchImpl: async () => { throw new Error('ECONNRESET'); }, cacheDir: dir }), /ECONNRESET/);
    eq(ETA.status().lastError, 'ECONNRESET'); eq(ETA.version(), v, 'previous doc kept');
    eq(ETA.loadInjuryEta({ cacheDir: dir }).rows.length, 40);
    await assert.rejects(ETA.fetchInjuryEta({ fetchImpl: async () => ({ ok: false, status: 503 }), cacheDir: dir }), /503/);
    await assert.rejects(ETA.fetchInjuryEta({ fetchImpl: async () => ({ ok: true, json: async () => ({ hello: 1 }) }), cacheDir: dir }), /unexpected payload/);
    eq(ETA.maybeRefresh({ fetchImpl: okFetch, cacheDir: dir }), null, 'NBA_MODEL_OFFLINE=1 → never fetches');
    ETA._reset();
    eq(ETA.loadInjuryEta({ cacheDir: dir, allowDisk: true, now: Date.now() + 8 * 86400000 }), null, 'a week-old report is not used');
  } finally { ETA._reset(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------ 2. board */
t('board: ESPN ETA replaces the ramp (Butler 0 until wk 11, ×0.85 back, healthy after); healthy players unchanged', async () => {
  const { eta, byId, byId0 } = await getBoards();
  const b = byId.get('1000'), b0 = byId0.get('1000');
  eq(b.eta.returnDate, '2027-01-02'); eq(b.eta.returnWeek, 11); eq(b.eta.status, 'OUT');
  for (let w = 1; w <= 10; w++) eq(b.hsByWeek[w], 0, 'week ' + w);
  ok(b.hsByWeek[11] > 0 && b.hsByWeek[11] < b.healthyByWeek[11], 'return week partial');
  near(b.availByWeek[12], 0.85 * Math.max(b.availability, Board.HEALTHY_FLOOR), 0.002, 'first full week ×0.85');
  for (let w = 13; w <= 23; w++) { eq(b.hsByWeek[w], b.healthyByWeek[w], 'healthy from week 13: ' + w); ok(b.hsByWeek[w] > 0.6 * b.healthyByWeek[w]); }
  ok(b0.hsByWeek[5] > 0, 'without ESPN the old ramp guessed him back by week 5');
  eq(b0.eta, null);
  const j = byId.get('1658'), j0 = byId0.get('1658');
  eq(j.hsByWeek, j0.hsByWeek, 'Jokić identical with and without the ETA document'); eq(j.eta, null);
  eq(j.availByWeek, undefined, 'healthy players carry no per-week availability');
  ok(eta.injuryEta.matched >= 35 && eta.injuryEta.rows === 40, 'meta: ' + JSON.stringify(eta.injuryEta));
  noNaN(eta.players.slice(0, 200), 'board');
});

t('board: stale rows are shown not applied; OFS / return after the season → out for season', async () => {
  const doc = { fetchedAt: '2026-10-15T00:00:00Z', rows: [
    { name: 'Nikola Jokic', team: 'Denver Nuggets', status: 'Out', fantasyStatus: 'OUT', returnDate: '2027-01-01', date: '2025-12-01T00:00Z' },
    { name: 'Victor Wembanyama', team: 'San Antonio Spurs', status: 'Out', fantasyStatus: 'OFS', returnDate: '2027-10-01', date: '2026-10-10T00:00Z' },
    { name: 'Alperen Sengun', team: 'Houston Rockets', status: 'Out', fantasyStatus: 'OUT', returnDate: '2027-07-01', date: '2026-10-10T00:00Z' },
  ] };
  const d = await model.getPlayers({ profile: PROF, eta: doc });
  const { byId0 } = await getBoards();
  const by = new Map(d.players.map(p => [p.id, p]));
  const j = by.get('1658');
  eq(j.eta.stale, true); eq(j.hsByWeek, byId0.get('1658').hsByWeek, 'stale row ignored');
  for (const id of ['2577', '2308']) {
    const p = by.get(id);
    eq(p.outForSeason, true, p.name); eq(Object.values(p.hsByWeek).every(v => v === 0), true, p.name + ' worth 0');
  }
});

t('board: memo key covers the whole profile and the ETA document; Yahoo/market join via marketSnapshotId', async () => {
  const a = await model.getPlayers({ profile: PROF, eta: null });
  eq(await model.getPlayers({ profile: JSON.parse(JSON.stringify(PROF)), eta: null }) === a, true, 'same profile → memo hit');
  const b = await model.getPlayers({ profile: { ...PROF, marketSnapshotId: 'none' }, eta: null });
  ok(b !== a, 'marketSnapshotId change → new board');
  eq(b.profile.yahoo.matched, 0, 'no snapshot → no Yahoo identity');
  ok(a.profile.yahoo.matched > 400, 'Sleeper profile joins the 242808 snapshot: ' + a.profile.yahoo.matched);
  eq(a.profile.marketSnapshotId, '242808'); eq(a.profile.source, 'sleeper'); eq(a.profile.playoffStartWeek, 21); eq(a.profile.tradeDeadlineWeek, 17);
  ok((await model.getPlayers({ profile: PROF, eta: DOC })) !== a, 'ETA doc → new board');
  ok(model.profileKey(PROF) !== model.profileKey({ ...PROF, weeks: PROF.weeks.slice(0, 22) }));
  const enriched = require('../nba/model/enrich').enrichPlayers(a);
  ok(enriched.market.available && enriched.market.matched > 400, 'market layer joins under the Sleeper profile');
  ok(enriched.yahooOnly.count > 0, 'Yahoo-only rows come back');
});

/* ------------------------------------------------------------ 3. score */
t('score: flagrant fouls score from format-3 rows; format-2 rows and the 242808 profile are unchanged', () => {
  const row2 = [20000, 1, 40, 34, 25, 10, 8, 2, 1, 3, 2, 0];
  const row3 = row2.concat([18, 6, 3, 1]); // fga, fta, tpm, ff
  const base = Sc.rowScore(row2, PROF);
  eq(Sc.rowScore(row3, PROF), Math.round((base - 1) * 100) / 100, 'ff −1 under the Sleeper profile');
  const legacy = require('../nba/league-profile').getProfile('242808');
  eq(Sc.rowScore(row3, legacy), Sc.rowScore(row2, legacy), '242808 has no ff weight');
  eq(Sc.rowLine(row2).ff, 0);
});

/* ------------------------------------------------------------ 4. league sync */
t('profileFromSleeper: calendar agrees with the Sleeper schedule; hardening (other-season state, hostile weeks, categories, ff note)', () => {
  const sched = fx('sleeper-schedule-weeks-2026.json').weeks;
  const p = LS.profileFromSleeper({ league: LEAGUE, state: STATE, scheduleWeeks: sched });
  eq(p.unverified.filter(u => /falls outside/.test(u)), [], 'every schedule week sits inside its Mon-Sun week');
  eq(p.weeks, PROF.weeks);
  const bad = LS.profileFromSleeper({ league: LEAGUE, state: STATE, scheduleWeeks: [{ week: 2, first: '2026-10-25', last: '2026-11-01' }] });
  ok(bad.unverified.some(u => /week 2 .* outside/.test(u)), 'a schedule week straddling two profile weeks is reported');
  const old = LS.profileFromSleeper({ league: { ...LEAGUE, season: '2025' }, state: STATE });
  eq(old.weeks[0].start, '2025-10-20', 'state for another season is not used');
  const huge = LS.profileFromSleeper({ league: { ...LEAGUE, settings: { ...LEAGUE.settings, playoff_week_start: 500 } } });
  ok(huge.weeks.length <= LS.MAX_WEEKS, 'week count bounded');
  eq(LS.profileFromSleeper({ league: { ...LEAGUE, settings: { ...LEAGUE.settings, scoring_type: 'h2h_category' } } }).aggregation, 'categories');
  const noFF = LS.profileFromSleeper({ league: { ...LEAGUE, scoring_settings: { ...LEAGUE.scoring_settings, ff: 0 } } });
  ok(!noFF.unverified.some(u => /flagrant/.test(u)), 'ff note only when ff scores');
  eq(LS.currentWeekFor(PROF, '2026-10-15'), 1); eq(LS.currentWeekFor(PROF, '2026-10-26'), 2);
  eq(LS.currentWeekFor(PROF, '2027-02-14'), 17); eq(LS.currentWeekFor(PROF, '2027-12-01'), 23);
});

t('leagueContext: fixtures → 12 teams, my roster 1, 10 starters each, 0 unmatched, opponents from matchups, order-invariant', async () => {
  const { none } = await getBoards();
  const args = { league: LEAGUE, users: USERS, rosters: ROSTERS, board: none, profile: PROF, userId: ME, today: '2026-10-15', matchups: sfx('matchups-1.json') };
  const c = LS.leagueContext(args);
  eq(c.teams.length, 12); eq(c.myRosterId, '1'); eq(c.currentWeek, 1); eq(c.season, '2026');
  for (const tm of c.teams) { eq(tm.starters.length, 10, 'starters ' + tm.rosterId); eq(tm.unmatched, []); }
  eq(c.teams.reduce((s, tm) => s + tm.players.length, 0), ROSTERS.reduce((s, r) => s + r.players.length, 0), 'nothing dropped');
  eq(c.teams.find(tm => tm.rosterId === '2').reserve.length, 2);
  eq(c.teams.find(tm => tm.rosterId === '2').players.filter(p => p.slot === 'IL').length, 2);
  eq(c.opponentByRoster['1'], '5'); eq(c.opponentByRoster['5'], '1');
  for (const [a, b] of Object.entries(c.opponentByRoster)) eq(c.opponentByRoster[b], a);
  eq(c.profile.weeks, 23); eq(c.profile.playoffStartWeek, 21); eq(c.asOf, none.asOf);
  const shuffled = LS.leagueContext({ ...args, users: USERS.slice().reverse(), rosters: ROSTERS.slice().reverse() });
  eq(shuffled, c, 'order invariant');
  const off = LS.leagueContext({ ...args, board: none.players.filter(p => p.id !== '1658'), matchups: null, userId: 'nobody' });
  const owner = off.teams.find(tm => tm.players.some(p => p.id === '1658'));
  eq(owner.unmatched, [{ id: '1658', name: 'Player 1658' }]); eq(owner.players.find(p => p.id === '1658').onBoard, false);
  eq(off.myRosterId, null); eq(off.opponentByRoster, null);
});

/* ------------------------------------------------------------ 5. signals */
async function sigCtx(over = {}) {
  const { eta } = await getBoards();
  const data = Data.load();
  const weeks = horizon(PROF, 1);
  const repl = T.replacementLevel(eta.players, weeks, T.normSettings({}, PROF), new Set(ROSTERS.flatMap(r => r.players.map(String))));
  return { profile: PROF, currentWeek: 1, weeks, logs: data.logs, proj: data.proj, market: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'nba', 'market.json'), 'utf8')), eta: DOC, bio: { 1658: { a: 31, x: 11 } }, replacement: repl, today: '2026-10-15', ...over };
}

t('signals: formulas on fixture players (Jokić, Butler, Harper, a rookie, a thin sample)', async () => {
  const { eta } = await getBoards();
  const ctx = await sigCtx();
  const S = SIG.signalsFor(eta.players, ctx);
  eq(S.size, eta.players.length);
  const j = S.get('1658'), jp = eta.players.find(p => p.id === '1658');
  const wSum = ctx.weeks.reduce((s, w) => s + w.weight, 0);
  near(j.value.ros, ctx.weeks.reduce((s, w) => s + w.weight * jp.hsByWeek[w.week], 0) / wSum, 0.05, 'ros = weighted mean');
  eq(j.value.now, jp.hsByWeek[1]); eq(j.value.next, jp.hsByWeek[2]);
  near(j.value.cv, jp.sd / jp.mean, 0.001); near(j.value.ceilingShare, (jp.ceiling - jp.mean) / jp.mean, 0.001);
  eq(j.statSeason, 2025); eq(j.form.stale, true); eq(j.form.label, null); ok(j.flags.includes('stale-stats'));
  // Form recomputed from the raw logs with the league scoring.
  const rows = Data.load().logs.find(f => Number(f.season) === 2025).players['1658'].g.slice().sort((a, b) => a[0] - b[0]);
  const sc = rows.map(g => Sc.rowScore(g, PROF));
  near(j.form.seasonMean, sc.reduce((a, b) => a + b, 0) / sc.length, 0.05); near(j.form.last5, sc.slice(-5).reduce((a, b) => a + b, 0) / 5, 0.05);
  eq(j.form.games, sc.length);
  near(j.minutes.mpg, rows.reduce((a, g) => a + g[3], 0) / rows.length, 0.05);
  ok(j.minutes.roleShift >= 0.7 && j.minutes.roleShift <= 1.4);
  eq(j.usage, { fga: null, fta: null, usageRate: null, trend: null });
  eq(j.bio, { age: 31, exp: 11, rookie: false });
  // Market prior: weight 0.30 in week 1, blended = 0.7·ros + 0.3·implied.
  eq(j.market.rank, 1); eq(j.market.weight, 0.3); near(j.market.impliedValue, eta.players.map(p => p.hsValue).sort((a, b) => b - a)[0], 0.05);
  near(j.value.blended, 0.7 * j.value.ros + 0.3 * j.market.impliedValue, 0.06);
  near(j.availability.expectedGamesMissed, Object.entries(j.availability.byWeek).reduce((s, [w, a]) => s + jp.gamesByWeek[w] * (1 - a), 0), 0.06);
  eq(j.uncertainty, 0.15, '0.10 + stale logs 0.05');
  // Butler: ESPN OUT → out-until-wk11, contested market row → half weight, injured with ETA +0.04.
  const b = S.get('1000');
  eq(b.availability.eta.returnWeek, 11); ok(b.flags.includes('out-until-wk11')); eq(b.availability.byWeek['5'], 0);
  eq(b.market.contested, true); eq(b.market.weight, 0.15);
  eq(b.uncertainty, 0.19, '0.10 + ETA 0.04 + stale 0.05');
  // Harper: market reach.
  ok(S.get('4754').flags.includes('market-reach'));
  // Rookie: no logs → no form, rookie flag, projection uncertainty.
  const r = S.get('4873');
  eq([r.source, r.form, r.statSeason, r.flags.includes('rookie'), r.flags.includes('thin-sample'), r.flags.includes('stale-stats')], ['rookie', null, null, true, false, false]);
  ok(r.uncertainty >= 0.25);
  ok(S.get('1822').flags.includes('thin-sample'), 'Tatum 16 games');
  for (const s of S.values()) { noNaN(s, s.name); ok(s.uncertainty >= 0.1 && s.uncertainty <= 0.35); }
});

t('signals: market decay (0.30 → 0.15 → 0), null market → blended = ros, heavy-schedule horizon, deterministic', async () => {
  const { eta } = await getBoards();
  const base = await sigCtx();
  const at = (cw, over = {}) => SIG.signalsFor(eta.players, { ...base, currentWeek: cw, weeks: horizon(PROF, cw), ...over });
  const w6 = at(6).get('1658'), w11 = at(11).get('1658');
  eq(w6.market.weight, 0.15); eq(w11.market.weight, 0); eq(w11.value.blended, w11.value.ros);
  const nm = at(1, { market: null }).get('4754');
  eq(nm.market.rank, null); eq(nm.value.blended, nm.value.ros);
  const den13 = SIG.signalsFor(eta.players, { ...base, currentWeek: 13, weeks: [{ week: 13, weight: 1 }] }).get('1658');
  eq(den13.schedule.gamesThisWeek, 5); ok(den13.flags.includes('heavy-schedule'), 'Denver plays 5 in week 13');
  const again = SIG.signalsFor(eta.players, await sigCtx());
  eq(JSON.stringify([...again]), JSON.stringify([...SIG.signalsFor(eta.players, base)]), 'byte-identical runs');
  // A lone playerSignals call with ctx.board reproduces signalsFor.
  const lone = SIG.playerSignals(eta.players.find(p => p.id === '1658'), { ...(await sigCtx()), board: eta.players });
  eq(lone, again.get('1658'));
});

/* ------------------------------------------------------------ 6. roster analysis */
async function rosterCtx() {
  const { eta } = await getBoards();
  const weeks = horizon(PROF, 1);
  const st = T.normSettings({}, PROF);
  const rostered = ROSTERS.flatMap(r => r.players.map(String));
  return { eta, weeks, repl: T.replacementLevel(eta.players, weeks, st, new Set(rostered)), rostered, by: new Map(eta.players.map(p => [p.id, p])) };
}

t('analyzeRoster: roster 1 (10 starters, F need, G/C surplus, bench shares, liabilities, injuries)', async () => {
  const { weeks, repl, by } = await rosterCtx();
  const players = ROSTERS[0].players.map(id => by.get(String(id)));
  const r = RA.analyzeRoster({ players, profile: PROF, weeks, replacement: repl, currentWeek: 1 });
  eq(r.lineup.starters.length, 10); eq(r.lineup.holes, 0); eq(r.lineup.openSpots, 1);
  eq(r.lineup.starters.map(s => s.slot), ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'UTIL', 'UTIL']);
  near(r.lineup.total, r.lineup.starters.reduce((s, x) => s + x.value, 0), 0.05);
  eq(r.needs, ['F']); eq(r.surplus, ['G', 'C']);
  eq([r.groups.G.rostered, r.groups.F.rostered, r.groups.C.rostered, r.groups.UTIL.rostered], [7, 3, 4, 13]);
  eq(r.groups.UTIL.tier, 'solid', 'UTIL is quality-only');
  eq(r.lineup.bench.map(b => Math.round(b.share * 1000) / 1000), [0.2, 0.117, 0.067]);
  near(r.benchValue, r.lineup.bench.reduce((s, b) => s + b.share * Math.max(0, b.value - r.replacement), 0), 0.06);
  eq(r.liabilities.map(x => x.name), ['Zach LaVine']);
  ok(r.elite.every(e => e.value >= RA.ELITE_VALUE || by.get(e.id).rank <= RA.ELITE_RANK));
  ok(r.injured.some(i => i.eta && i.eta.status === 'GTD'), 'ESPN GTD rows reach the injured list');
  ok(r.injuryExposure.thisWeek > 0 && r.injuryExposure.next2 >= r.injuryExposure.thisWeek);
  eq(r.gamesThisWeek, r.lineup.starters.reduce((s, x) => s + by.get(x.id).gamesByWeek[1], 0));
  noNaN(r);
  const shuffled = RA.analyzeRoster({ players: players.slice().reverse(), profile: PROF, weeks, replacement: repl, currentWeek: 1 });
  eq(shuffled, r, 'order invariant');
});

t('weekValue / strengthRos agree with the trade engine week by week (all 12 rosters)', async () => {
  const { eta, weeks, rostered, by } = await rosterCtx();
  const E = T.createEvaluator({ players: eta.players, currentWeek: 1, leagueRostered: rostered, profile: PROF });
  for (const ro of ROSTERS) {
    const reserve = new Set((ro.reserve || []).map(String));
    const all = ro.players.map(id => by.get(String(id)));
    const cap = E.capFor(all);
    const tv = E.teamValue(all, cap);
    for (const w of E.weeks) near(RA.weekValue(all, PROF, w.week, E.repl, { cap }).total, tv.byWeek[w.week], 1e-9, `roster ${ro.roster_id} week ${w.week}`);
    const active = all.filter(p => !reserve.has(p.id));
    const r = RA.analyzeRoster({ players: all, profile: PROF, weeks, replacement: E.repl, currentWeek: 1, cap });
    near(r.strengthRos, tv.total / E.wSum, 0.051, 'strengthRos = trade engine per-week value');
    ok(active.length <= all.length);
  }
});

t('tiers: one C-eligible player → C need; add a top-24 C → surplus; no C at all → waiver add at C, critical vs the league', async () => {
  const { weeks, repl, by } = await rosterCtx();
  const base = ROSTERS[0].players.map(id => by.get(String(id))).filter(p => !p.pos.includes('C'));
  const oneC = base.concat([by.get('2728')]);
  const a = RA.analyzeRoster({ players: oneC, profile: PROF, weeks, replacement: repl });
  eq(a.groups.C.rostered, 1); eq(a.groups.C.tier, 'thin');
  const la = { C: 60, G: 1, F: 1, UTIL: 1 };
  eq(RA.analyzeRoster({ players: oneC, profile: PROF, weeks, replacement: repl, leagueAvg: la }).groups.C.tier, 'critical');
  const twoC = oneC.concat([by.get('2308')]);
  const b = RA.analyzeRoster({ players: twoC, profile: PROF, weeks, replacement: repl, leagueAvg: { C: 40 }, strongCutoff: { C: 45 } });
  eq(b.groups.C.status, 'surplus'); ok(['deep', 'loaded'].includes(b.groups.C.tier));
  const noC = RA.analyzeRoster({ players: base, profile: PROF, weeks, replacement: repl, leagueAvg: la });
  eq(noC.groups.C.rostered, 0); eq(noC.groups.C.tier, 'critical'); ok(noC.needs.includes('C'));
  const cHole = noC.lineup.open.find(o => o.slot === 'C');
  ok(cHole && cHole.value === noC.replacement, 'C filled at waiver level: ' + JSON.stringify(noC.lineup.open));
});

/* ------------------------------------------------------------ 7. spike §4.2 */
t('spike §4.2: board under the Sleeper profile + Lillard-for-Nurkić with real rosters 1 and 2', async () => {
  const { none } = await getBoards();
  eq(Object.keys(none.players[0].hsByWeek).length, 23);
  for (const s of ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL']) near(none.profile.replacement[s], 25.3, 1.5, 'replacement ' + s);
  const out = T.evaluateTrade({ players: none.players, currentWeek: none.currentWeek, myRoster: ROSTERS[0].players, partnerRoster: ROSTERS[1].players, give: ['1444'], get: ['1583'], leagueRostered: ROSTERS.flatMap(r => r.players), profile: PROF, today: '2026-10-15' });
  eq(out.verdict, 'Counter'); eq(out.meta.weeks, 23); eq(out.meta.settings.slotList, ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'UTIL', 'UTIL']);
  eq(out.meta.rules.tradeEnd, '2027-02-14');
  near(out.you.perWeek, 1.2, 0.5); near(out.meta.fairBand, 3.2, 0.3);
});

/* ------------------------------------------------------------ 8. routes */
function fakeSleeper(state = {}) {
  const calls = { league: 0, state: 0 };
  const CAT = { ...LEAGUE, league_id: '222', settings: { ...LEAGUE.settings, scoring_type: 'h2h_category' } };
  return {
    calls,
    async state() { calls.state++; if (state.stateDown) throw new SleeperError('x', { code: 'sleeper_upstream' }); return STATE; },
    async league(id) { calls.league++; if (state.down) throw new SleeperError('x', { status: 502, code: 'sleeper_upstream' }); return id === LEAGUE.league_id ? LEAGUE : id === '222' ? CAT : null; },
    async leagueUsers() { return USERS; },
    async leagueRosters() { return ROSTERS; },
    async leagueDrafts() { return [sfx('draft.json')]; },
    async draft() { return sfx('draft.json'); },
    async leagueMatchups(id, w) { return w === 1 ? sfx('matchups-1.json') : []; },
    async user() { return null; }, async userLeagues() { return []; }, async draftPicks() { return []; }, async draftTradedPicks() { return []; },
  };
}
function memCache() {
  const m = new Map();
  return async (key, ttl, f) => { const e = m.get(key); if (e && e.exp > Date.now()) return e.v; const v = await f(); m.set(key, { v, exp: Date.now() + ttl }); return v; };
}
async function serveRouter(client) {
  const createNbaRouter = require('../nba/router');
  const app = express();
  app.use('/', createNbaRouter({
    auth: (req, res) => res.status(401).end(), getAuth: () => ({}), apiCached: memCache(), env: {},
    store: { get: async () => null, save: async () => {}, remove: async () => {} }, log: { error() {}, warn() {}, log() {} },
    sleeperClient: client, rateLimits: { api: 1000, auth: 1000, sleeper: 1000 },
  }));
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async p => { const r = await fetch(base + p); return { status: r.status, json: await r.json().catch(() => null) }; };
  return { srv, get };
}

t('routes: /api/nba/players?league_id= builds (and caches) the Sleeper profile; LC.profileFor({ sleeperLeagueId }) returns it', async () => {
  const client = fakeSleeper();
  const { srv, get } = await serveRouter(client);
  try {
    const r = await get(`/api/nba/players?league_id=${LEAGUE.league_id}`);
    eq(r.status, 200);
    eq([r.json.profile.weeks, r.json.profile.starters, r.json.profile.source, r.json.profile.leagueId], [23, 10, 'sleeper', LEAGUE.league_id]);
    ok(r.json.profile.yahoo.matched > 400, 'market snapshot joined'); ok(r.json.market.available);
    eq(Object.keys(r.json.players.find(p => p.id === '1658').hsByWeek).length, 23);
    await get(`/api/nba/players?league_id=${LEAGUE.league_id}&week=3`);
    eq(client.calls.league, 1, 'profile cached (one league fetch)');
    const lc = LC.profileFor({ sleeperLeagueId: LEAGUE.league_id });
    eq([lc.source, lc.profileId, lc.profile.weeks.length, lc.profile.slots.UTIL], ['sleeper', LEAGUE.league_id, 23, 3]);
    lc.profile.weeks.length = 0;
    eq(LC.profileFor({ sleeperLeagueId: LEAGUE.league_id }).profile.weeks.length, 23, 'callers get copies');
    eq(LC.profileFor({ leagueId: '242808' }).source, 'stored');
    eq(LC.profileFor({ sleeperLeagueId: '999' }).profile.leagueId, '242808', 'unknown Sleeper league → stored default');
    eq((await get('/api/nba/players?league_id=222')).json.code, 'league_not_points');
    eq((await get('/api/nba/players?league_id=222')).status, 400);
    const nf = await get('/api/nba/players?league_id=123');
    eq([nf.status, nf.json.code], [404, 'sleeper_not_found']);
    eq((await get('/api/nba/players?league_id=abc')).status, 400);
    eq((await get('/api/nba/players?profile=242808')).json.profile.weeks, 22, 'stored profile path unchanged');
  } finally { srv.close(); }
  const down = await serveRouter(fakeSleeper({ down: true }));
  try { eq((await down.get(`/api/nba/players?league_id=${LEAGUE.league_id}`)).status, 502, 'Sleeper outage → 502'); } finally { down.srv.close(); }
  const noState = await serveRouter(fakeSleeper({ stateDown: true }));
  try {
    const r = await noState.get(`/api/nba/players?league_id=${LEAGUE.league_id}`);
    eq(r.status, 200, 'state outage → calendar from the league season'); eq(r.json.profile.weeks, 23);
  } finally { noState.srv.close(); }
});

t('routes: Sleeper lineup + waivers run under the league\'s own profile (23 Mon-Sun weeks, 10 starters); ?profile= overrides', async () => {
  const { srv, get } = await serveRouter(fakeSleeper());
  try {
    const l = await get(`/api/nba/lineup?league_id=${LEAGUE.league_id}&roster_id=1&week=2&opp=0`);
    eq(l.status, 200, JSON.stringify(l.json).slice(0, 200));
    eq([l.json.profile.weeks, l.json.profile.starters, l.json.profile.source, l.json.window.start, l.json.window.end], [23, 10, 'sleeper', '2026-10-26', '2026-11-01']);
    const w = await get(`/api/nba/waivers?league_id=${LEAGUE.league_id}&roster_id=1&weeks=2`);
    eq(w.status, 200, JSON.stringify(w.json).slice(0, 200));
    eq([w.json.profile.weeks, w.json.profile.starters], [23, 10]);
    const o = await get(`/api/nba/lineup?league_id=${LEAGUE.league_id}&roster_id=1&week=2&opp=0&profile=242808`);
    eq(o.status, 200); eq(o.json.profile.weeks, 22, 'explicit stored profile');
    eq((await get('/api/nba/lineup?league_id=222&roster_id=1&opp=0')).json.code, 'league_not_points');
    eq((await get('/api/nba/waivers?league_id=222&roster_id=1')).status, 400);
  } finally { srv.close(); }
});

/* ------------------------------------------------------------ runner */
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 12).join('\n      ') : e)); }
  }
  console.log(`\nnba-shared: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
