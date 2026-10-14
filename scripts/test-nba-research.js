#!/usr/bin/env node
/* Tests for the NBA research API (nba/model/research.js, nba/routes/research.js).
   Offline (NBA_MODEL_OFFLINE=1) against the committed data/nba snapshot; Sleeper
   context (bio, schedule, game context, news, trending) comes from fixtures.
   Run: node scripts/test-nba-research.js   (exit 0 = all pass) */
'use strict';
process.env.NBA_MODEL_OFFLINE = '1';
process.env.NBA_RESEARCH_RATE_MAX = '1000000'; // the rate-limit test builds its own tight limiter
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const express = require('express');
const ROOT = path.join(__dirname, '..');
const R = require(path.join(ROOT, 'nba/model/research'));
const Sc = require(path.join(ROOT, 'nba/model/score'));
const S = require(path.join(ROOT, 'nba/model/sleeper'));
const Data = require(path.join(ROOT, 'nba/model/data'));
const Board = require(path.join(ROOT, 'nba/model/board'));
const Model = require(path.join(ROOT, 'nba/model'));
const { enrichPlayers } = require(path.join(ROOT, 'nba/model/enrich'));
const LP = require(path.join(ROOT, 'nba/league-profile'));
const createNbaRouter = require(path.join(ROOT, 'nba/router'));
const researchRoutes = require(path.join(ROOT, 'nba/routes/research'));

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-research-'));

// Enriched board exactly as the router builds it (modelPlayers(null, '242808')).
let boardP = null;
const getBoard = () => (boardP ||= Model.getPlayers({ profile: '242808' }).then(enrichPlayers));
const PROFILE = LP.defaultProfile();

// ---- HTTP harness: the real NBA router (offline engine) ----------------------
function apiCachedFactory() {
  const m = new Map();
  return async (key, ttl, fn) => {
    const h = m.get(key);
    if (h && Date.now() - h.at < ttl) return h.v;
    const v = await fn();
    m.set(key, { at: Date.now(), v });
    return v;
  };
}
function listen(app) {
  return new Promise(res => { const srv = app.listen(0, '127.0.0.1', () => res(srv)); });
}
let base, server;
async function boot() {
  const app = express();
  app.use(createNbaRouter({ auth: (q, r, n) => n(), getAuth: () => ({}), apiCached: apiCachedFactory(), log: { error() {}, warn() {}, log() {} } }));
  server = await listen(app);
  base = `http://127.0.0.1:${server.address().port}`;
}
async function get(p, headers) {
  const r = await fetch(base + p, { headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}
async function all(qs = '') {
  const out = [];
  for (let off = 0; ; off += 200) {
    const r = await get(`/api/nba/research?limit=200&offset=${off}${qs}`);
    assert.strictEqual(r.status, 200, r.text);
    out.push(...r.json.rows);
    if (off + 200 >= r.json.total) { assert.strictEqual(out.length, r.json.total); return out; }
  }
}

// Recursively assert no NaN / ±Infinity / undefined anywhere.
function noBadNumbers(obj, where) {
  const walk = (v, p) => {
    if (v === undefined) throw new Error(`${where}: undefined at ${p}`);
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${where}: ${v} at ${p}`);
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  walk(obj, '$');
}

// ---- fixtures for fetched context ---------------------------------------------
const FIX = {
  bio: { 1658: { full_name: 'Nikola Jokić', first_name: 'Nikola', last_name: 'Jokić', team: 'DEN', active: true, age: 31, birth_date: '1995-02-19', height: '83', weight: '284', college: null, years_exp: 11, number: 15, depth_chart_position: 'C', depth_chart_order: 1, sportradar_id: 'sr-1', rotowire_id: 3612, swish_id: 830650, espn_id: null, news_updated: 1791778517093 },
    1434: { first_name: 'Russell', last_name: 'Westbrook', team: null, active: false } },
  schedule: [
    { date: '2026-10-22', home: { team: 'OKC' }, away: { team: 'DEN' }, status: 'pre_game' },
    { date: '2026-10-23', home: { team: 'DEN' }, away: { team: 'NOP' }, status: 'pre_game' },
    { date: '2026-10-27', home: { team: 'DEN' }, away: { team: 'GSW' }, status: 'pre_game' },
  ],
  news: [{ metadata: { title: 'Nikola Jokic - <b>Triple-double</b>', description: 'Line.', analysis: 'Good.' }, source: 'rotowire', published: 1791778224000 }],
  trendAdd: [{ player_id: '1658', count: 10 }, { player_id: '1434', count: 5 }, { player_id: '00000', count: 1 }],
  trendDrop: [{ player_id: '4873', count: 3 }],
};
// Game context for Jokić: every logged 2025 date, alternating home/away.
function playerGamesFixture(id) {
  const lg = Data.load().logs.find(l => l.season === '2025');
  const rows = (lg.players[id] || { g: [] }).g;
  const out = {};
  rows.forEach((g, i) => { (out[g[1]] ||= []).push({ date: S.dayToDate(g[0]), team: 'DEN', opponent: 'T' + (i % 3), is_away_team: i % 2 === 1 }); });
  return out;
}
function fixtureFetch(calls, { failTrending = false } = {}) {
  return async url => {
    calls.push(url);
    if (url === R.URLS.bio()) return FIX.bio;
    if (url === R.URLS.schedule(2026)) return FIX.schedule;
    let m;
    if ((m = url.match(/stats\/nba\/player\/(\d+)/))) return playerGamesFixture(m[1]);
    if (/\/news$/.test(url)) return FIX.news;
    if (/trending\/add/.test(url)) { if (failTrending) throw new Error('boom'); return FIX.trendAdd; }
    if (/trending\/drop/.test(url)) { if (failTrending) throw new Error('boom'); return FIX.trendDrop; }
    throw new Error('unexpected url ' + url);
  };
}

// ================================ tests =========================================
test('default table: hsValue desc, first page = top of board, total counts every player', async () => {
  const r = await get('/api/nba/research');
  assert.strictEqual(r.status, 200);
  const j = r.json;
  assert.strictEqual(j.sort, 'hsValue'); assert.strictEqual(j.dir, 'desc'); assert.strictEqual(j.limit, 50); assert.strictEqual(j.offset, 0);
  const board = await getBoard();
  assert.strictEqual(j.total, board.players.length);
  assert.strictEqual(j.rows.length, 50);
  for (let i = 1; i < j.rows.length; i++) assert(j.rows[i - 1].hsValue >= j.rows[i].hsValue);
  assert.strictEqual(j.rows[0].id, String(board.players[0].id));
  assert.strictEqual(j.leagueId, '242808');
});

test('pagination: pages are disjoint, contiguous and equal one big page', async () => {
  const a = (await get('/api/nba/research?limit=25&offset=0')).json.rows;
  const b = (await get('/api/nba/research?limit=25&offset=25')).json.rows;
  const big = (await get('/api/nba/research?limit=50&offset=0')).json.rows;
  assert.deepStrictEqual(a.concat(b).map(r => r.id), big.map(r => r.id));
  assert.strictEqual(new Set(a.concat(b).map(r => r.id)).size, 50);
  const end = await get('/api/nba/research?limit=50&offset=5000');
  assert.strictEqual(end.status, 200); assert.deepStrictEqual(end.json.rows, []);
});

test('every sort key, both directions: ordered, nulls last, same set of players', async () => {
  const meta = (await get('/api/nba/research/meta')).json;
  const ids = (await all()).map(r => r.id).sort();
  for (const key of meta.sortKeys) {
    for (const dir of ['asc', 'desc']) {
      const rows = await all(`&sort=${key}&dir=${dir}`);
      assert.deepStrictEqual(rows.map(r => r.id).sort(), ids, `${key} ${dir} lost rows`);
      const vals = rows.map(r => (key === 'injury' ? r.injuryTag : r[key]));
      const firstNull = vals.findIndex(v => v == null);
      if (firstNull >= 0) assert(vals.slice(firstNull).every(v => v == null), `${key} ${dir}: null before non-null`);
      const nn = firstNull >= 0 ? vals.slice(0, firstNull) : vals;
      for (let i = 1; i < nn.length; i++) {
        const c = typeof nn[i] === 'string' ? nn[i - 1].localeCompare(nn[i]) : nn[i - 1] - nn[i];
        assert(dir === 'asc' ? c <= 0 : c >= 0, `${key} ${dir} out of order at ${i}: ${nn[i - 1]} / ${nn[i]}`);
      }
    }
  }
  // Natural default directions.
  assert.strictEqual((await get('/api/nba/research?sort=rank')).json.dir, 'asc');
  assert.strictEqual((await get('/api/nba/research?sort=pts')).json.dir, 'desc');
});

test('filters: pos, slot, team, inj, source, q (and combined)', async () => {
  const c = await all('&pos=C');
  assert(c.length > 20 && c.every(r => r.posList.includes('C')));
  const pg = await all('&slot=PG');
  assert(pg.length > 20 && pg.every(r => r.yahooElig.includes('PG')));
  const multi = await all('&pos=PG,C');
  assert(multi.every(r => r.posList.includes('PG') || r.posList.includes('C')));
  assert(multi.length >= c.length);
  const den = await all('&team=DEN');
  assert(den.length >= 8 && den.every(r => r.team === 'DEN'));
  const out = await all('&inj=out');
  assert(out.length > 0 && out.every(r => ['O', 'OFS', 'IL', 'SUSP'].includes(r.injuryTag)));
  const healthy = await all('&inj=healthy');
  assert(healthy.every(r => r.injuryTag == null));
  const injured = await all('&inj=injured');
  assert.strictEqual(healthy.length + injured.length, (await all()).length);
  const yo = await all('&source=yahoo-only');
  assert(yo.length > 50 && yo.every(r => r.source === 'yahoo-only'));
  const combo = await all('&team=DEN&pos=C');
  assert(combo.some(r => r.name === 'Nikola Jokić') && combo.every(r => r.team === 'DEN' && r.posList.includes('C')));
  const q = await all('&q=jokic');
  assert(q.length >= 1 && q[0].name === 'Nikola Jokić');
  assert((await all('&q=Joki%C4%87'))[0].name === 'Nikola Jokić'); // "Jokić" with the accent
  assert((await all('&q=DEN')).every(r => r.team === 'DEN' || r._ === undefined));
});

test('search: accent-insensitive, ranked, team/pos, empty, limit', async () => {
  for (const q of ['Jokic', 'jokić', 'JOKIC', 'nikola jok']) {
    const r = await get('/api/nba/search?q=' + encodeURIComponent(q));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.results[0].name, 'Nikola Jokić', q);
  }
  const v = (await get('/api/nba/search?q=vucevic')).json.results;
  assert(v.some(x => /Vu.evi/.test(x.name)), 'Vučević by plain ascii');
  const den = (await get('/api/nba/search?q=DEN&limit=25')).json.results;
  assert(den.length > 5 && den.every(x => x.team === 'DEN' || /den/i.test(x.name)));
  assert.deepStrictEqual((await get('/api/nba/search?q=')).json, { q: '', results: [] });
  assert.strictEqual((await get('/api/nba/search?q=a&limit=3')).json.results.length, 3);
  assert.strictEqual((await get('/api/nba/search?q=a&limit=99')).status, 400);
  const ranks = (await get('/api/nba/search?q=james&limit=25')).json.results;
  assert(ranks.length > 2);
});

test('scoring: a known Jokić game hand-checked under league 242808 weights', async () => {
  // 2025-10-23 (day 20384): 21 pts, 13 reb, 10 ast, 1 stl, 1 blk, 2 to, 3 pf, 0 tech
  // = 21 + 13*1.2 + 10*1.5 + 3 + 3 - 2 - 3 - 0 = 52.6, triple-double: +3 TD, +5 DD (tdAlsoCountsDD) = 60.6
  const lg = Data.load().logs.find(l => l.season === '2025');
  const row = lg.players['1658'].g.find(g => g[0] === 20384);
  assert.deepStrictEqual(row.slice(4), [21, 13, 10, 1, 1, 2, 3, 0]);
  assert.strictEqual(PROFILE.scoring.reb, 1.2); assert.strictEqual(PROFILE.scoring.dd, 5);
  const d = (await get('/api/nba/player/1658')).json;
  const g = d.gameLog.games.find(x => x.date === '2025-10-23');
  assert.strictEqual(g.score, 60.6);
  assert.strictEqual(g.td, true); assert.strictEqual(g.dd, true);
  assert.strictEqual(Sc.gameScore({ pts: 21, reb: 13, ast: 10, stl: 1, blk: 1, to: 2, pf: 3, tech: 0 }, PROFILE), 60.6);
});

test('detail: star (Jokić) — every section, histogram sums, weekly best = model weekly max', async () => {
  const r = await get('/api/nba/player/1658');
  assert.strictEqual(r.status, 200);
  const d = r.json;
  assert.strictEqual(d.resolvedBy, 'sleeperId'); assert.strictEqual(d.source, 'logs');
  for (const k of ['identity', 'images', 'bio', 'positions', 'injury', 'value', 'market', 'projection', 'lastSeason', 'gameLog', 'last10', 'histogram', 'weeklyBest', 'consistency', 'rates', 'form', 'nextWeek', 'schedule', 'similar', 'news', 'unavailable']) assert(k in d, k);
  assert.strictEqual(d.identity.yahooPid, '5352');
  assert.strictEqual(d.images.headshot, 'https://sleepercdn.com/content/nba/players/1658.jpg');
  assert.deepStrictEqual(d.positions.yahooElig, ['C', 'UTIL']);
  const gp = d.lastSeason.gp;
  assert.strictEqual(d.gameLog.games.length, gp);
  assert.strictEqual(d.last10.length, 10);
  assert.deepStrictEqual(d.last10, d.gameLog.games.slice(0, 10));
  assert(d.gameLog.games[0].date > d.gameLog.games[gp - 1].date, 'newest first');
  assert.strictEqual(d.histogram.bins.reduce((s, b) => s + b.count, 0), gp);
  assert.strictEqual(d.histogram.games, gp);
  for (const b of d.histogram.bins) assert.strictEqual(b.hi - b.lo, d.histogram.binWidth);
  // Weekly best recomputed independently from the raw log rows + score.rowScore.
  const rows = Data.load().logs.find(l => l.season === '2025').players['1658'].g;
  const maxBy = {};
  for (const g of rows) { const s = Sc.rowScore(g, PROFILE); maxBy[g[1]] = Math.max(maxBy[g[1]] ?? -Infinity, s); }
  assert.deepStrictEqual(d.weeklyBest.weeks.map(w => [w.week, w.best]), Object.entries(maxBy).map(([w, s]) => [Number(w), Math.round(s * 100) / 100]).sort((a, b) => a[0] - b[0]));
  const bests = d.weeklyBest.weeks.map(w => w.best);
  assert(Math.abs(d.weeklyBest.summary.mean - bests.reduce((a, b) => a + b, 0) / bests.length) < 0.06);
  assert(d.weeklyBest.summary.p90 >= d.weeklyBest.summary.median);
  for (const w of d.weeklyBest.weeks) assert(d.gameLog.games.some(g => g.date === w.bestDate && Math.abs(g.score - w.best) < 0.01));
  // Rates & probabilities.
  assert(d.rates.ddPct > 0.5 && d.rates.tdPct > 0.2);
  const p = d.nextWeek.pBestAtLeast;
  assert(p['40'] >= p['50'] && p['50'] >= p['60'] && p['60'] >= p['70'] && p['70'] >= 0 && p['40'] <= 1);
  assert.strictEqual(d.schedule.length, 4);
  assert.deepStrictEqual(d.schedule.map(w => w.week), [1, 2, 3, 4]);
  assert(d.schedule.every(w => w.modelGames != null));
  assert.strictEqual(d.similar.length, 6);
  assert(d.similar.every(s => s.id !== '1658' && s.reason && s.similarity > 0 && s.similarity <= 1));
  assert(d.similar.every(s => s.pos.split(',').includes('C')), 'similar players share a position');
  // Offline: game context + news are flagged, not invented.
  assert(d.unavailable.gameContext && d.unavailable.news);
  assert(d.gameLog.games.every(g => g.opp === null && g.home === null));
  assert.strictEqual(d.news.available, false);
  assert.strictEqual(d.projection.modelMean, d.value.mean);
});

test('detail: rookie (no logs) has projection, null log sections, reason in unavailable', async () => {
  const rk = (await all('&source=rookie')).filter(r => r.hsValue > 0)[0];
  assert(rk, 'a valued rookie exists');
  const d = (await get('/api/nba/player/' + rk.id)).json;
  assert.strictEqual(d.source, 'rookie'); assert.strictEqual(d.bio.rookie, true);
  assert(d.projection && d.projection.pts > 0 && d.projection.modelMean > 0);
  for (const k of ['lastSeason', 'gameLog', 'last10', 'histogram', 'weeklyBest', 'consistency', 'rates', 'form', 'splits']) assert.strictEqual(d[k], null, k);
  assert(/no NBA game logs/.test(d.unavailable.logs));
  assert(d.nextWeek && /normal/.test(d.nextWeek.method));
  assert.strictEqual(rk.gp, 0); assert.strictEqual(rk.scoredPg, null);
});

test('detail + row: Yahoo-only player resolves by y-prefix and bare yahooPid; null stats, no NaN', async () => {
  const yo = (await all('&source=yahoo-only'))[0];
  assert(/^y\d+$/.test(yo.id) && yo.sleeperId === null && yo.headshot === null);
  for (const k of ['mean', 'sd', 'ceiling', 'floor', 'gp', 'mpg', 'pts', 'scoredPg', 'bestGameAvg', 'ddPct', 'last5']) assert.strictEqual(yo[k], null, k);
  const a = (await get('/api/nba/player/' + yo.id)).json;
  assert.strictEqual(a.source, 'yahoo-only'); assert.strictEqual(a.resolvedBy, 'yahooPid');
  assert.strictEqual(a.lastSeason, null); assert.strictEqual(a.nextWeek, null); assert.deepStrictEqual(a.similar, []);
  assert(a.unavailable.logs && a.unavailable.bio && a.unavailable.news);
  const b = await get('/api/nba/player/' + yo.yahooPid);
  if (b.json.resolvedBy === 'yahooPid') assert.strictEqual(b.json.id, yo.id); // bare pid may collide with a Sleeper id
  noBadNumbers(a, 'yahoo-only detail');
});

test('detail: injured player (OUT) — injury block, next-week availability and probabilities 0', async () => {
  const r = (await all('&inj=out')).find(x => x.source !== 'yahoo-only' && x.injuryTag === 'O' && x.gp > 10);
  assert(r, 'an OUT player with logs');
  const d = (await get('/api/nba/player/' + r.id)).json;
  assert.strictEqual(d.injury.tag, 'O'); assert(d.injury.status);
  // The model's own week availability (board.availability): OUT → at most 0.1 this week.
  const sp = Data.load().players[r.id];
  const expect = Board.availability({ injury: sp.i, injuryNotes: sp.in, outForSeason: r.outForSeason }, d.nextWeek.baseAvailability, 0);
  assert.strictEqual(d.nextWeek.availability, Math.round(expect * 100) / 100);
  assert(d.nextWeek.availability <= 0.1 && d.nextWeek.baseAvailability > d.nextWeek.availability);
  assert(d.nextWeek.pBestAtLeast['40'] <= 0.3);
  // OUT after surgery (Jimmy Butler, knee): 0 this week, so every band is 0 and the model's week value is 0.
  const butler = (await get('/api/nba/player/1000')).json;
  assert.strictEqual(butler.injury.bodyPart, 'Knee'); assert.strictEqual(butler.injury.notes, 'Surgery');
  assert.strictEqual(butler.nextWeek.availability, 0);
  assert(Object.values(butler.nextWeek.pBestAtLeast).every(p => p === 0));
  assert.strictEqual(butler.nextWeek.expectedBest, 0);
});

test('detail: unknown id → 404 JSON; malformed id → 400 JSON', async () => {
  const a = await get('/api/nba/player/99999999');
  assert.strictEqual(a.status, 404); assert.deepStrictEqual(a.json, { error: 'Player not found', id: '99999999' });
  assert.strictEqual((await get('/api/nba/player/y99999999')).status, 404);
  for (const bad of ['abc', '1658;drop', '%00', '1'.repeat(13), 'y']) {
    const r = await get('/api/nba/player/' + bad);
    assert.strictEqual(r.status, 400, bad); assert(r.json && r.json.error);
  }
});

test('no NaN/undefined fuzz: every row and every player detail', async () => {
  const eng = R.createResearch({ getBoard, offline: true, cacheDir: tmp });
  const t = await eng.table({ q: '', pos: [], slot: [], team: [], inj: null, source: null, sort: 'hsValue', dir: null, limit: 5000, offset: 0 });
  noBadNumbers(t, 'table');
  const rows = await all();
  noBadNumbers(rows, 'rows');
  for (const r of rows) {
    const d = await eng.player(r.id);
    assert(d, r.id);
    noBadNumbers(d, `detail ${r.id}`);
    if (d.histogram) assert.strictEqual(d.histogram.bins.reduce((s, b) => s + b.count, 0), d.lastSeason.gp, `hist ${r.id}`);
    if (d.weeklyBest) assert(d.weeklyBest.weeks.every(w => w.best <= d.lastSeason.scored.max + 0.01));
  }
  assert(!/NaN|Infinity/.test(JSON.stringify(rows)));
});

test('meta: sort keys, filters, weeks from the profile', async () => {
  const m = (await get('/api/nba/research/meta')).json;
  assert.deepStrictEqual(m.defaultSort, { sort: 'hsValue', dir: 'desc' });
  assert(m.sortKeys.includes('hsValue') && m.sortKeys.includes('last5Delta') && m.sortKeys.includes('yahooPctRos'));
  assert.deepStrictEqual(m.filters.slot, ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL']);
  assert.strictEqual(m.filters.team.length, 30);
  assert.deepStrictEqual(m.weeks.filter(w => w.days === 14).map(w => w.week), [7, 17]);
  assert.deepStrictEqual(m.scoring, PROFILE.scoring);
  assert(m.players > 600 && m.withLogs > 300 && m.yahooOnly > 50);
  assert.strictEqual(m.context.offline, true);
});

test('input sanitisation: huge q, bad sort/dir/limit/offset/pos/team/inj/source', async () => {
  const cases = [
    ['q=' + 'a'.repeat(65), 400], ['q=' + 'a'.repeat(3000), 414], ['q=a&q=b', 400],
    ['sort=bogus', 400], ['sort=__proto__', 400], ['sort=constructor', 400], ['sort=toString', 400], ['sort=hsValue&sort=rank', 400],
    ['dir=up', 400], ['limit=0', 400], ['limit=201', 400], ['limit=abc', 400], ['limit=-1', 400], ['limit=1e2', 400],
    ['offset=5001', 400], ['offset=1.5', 400], ['pos=XX', 400], ['pos=C,<script>', 400], ['team=ZZZ', 400], ['slot=BN', 400],
    ['inj=maybe', 400], ['source=nope', 400], ['source=' + 'x'.repeat(30), 400],
  ];
  for (const [qs, status] of cases) {
    const r = await get('/api/nba/research?' + qs);
    assert.strictEqual(r.status, status, qs + ' → ' + r.status);
    if (status === 400) assert(r.json && typeof r.json.error === 'string', qs);
  }
  // Control characters are stripped, lowercase params accepted.
  const ok = await get('/api/nba/research?q=%01jokic%7f&pos=c&team=den&inj=HEALTHY&dir=ASC&sort=rank');
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.rows[0].name, 'Nikola Jokić');
  assert.strictEqual((await get('/api/nba/search?q=' + 'z'.repeat(65))).status, 400);
  assert.strictEqual((await get('/api/nba/trending?hours=0')).status, 400);
  assert.strictEqual((await get('/api/nba/trending?limit=51')).status, 400);
});

test('caching: ETag + 304, Cache-Control', async () => {
  const a = await get('/api/nba/research?limit=5');
  const etag = a.headers.get('etag');
  assert(etag && /max-age=/.test(a.headers.get('cache-control')));
  const b = await get('/api/nba/research?limit=5', { 'If-None-Match': etag });
  assert.strictEqual(b.status, 304);
});

test('rate limit: 429 + Retry-After past the per-IP budget', async () => {
  const eng = R.createResearch({ getBoard, offline: true, cacheDir: tmp });
  const app = express();
  app.use(researchRoutes({ research: eng, rate: { windowMs: 60000, max: 3 }, log: { error() {} } }));
  const srv = await listen(app);
  const u = `http://127.0.0.1:${srv.address().port}`;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(u + '/api/nba/search?q=jokic')).status);
  const last = await fetch(u + '/api/nba/player/1658');
  srv.close();
  assert.deepStrictEqual(codes, [200, 200, 200, 429, 429]);
  assert.strictEqual(last.status, 429); assert(Number(last.headers.get('retry-after')) >= 1);
});

test('perf: warm table/search/detail/meta under 150 ms', async () => {
  const qs = ['', '&sort=pts', '&sort=last5Delta&dir=asc', '&pos=PG&sort=ast', '&team=BOS', '&q=james', '&slot=C&inj=healthy&sort=ddPct', '&offset=600'];
  for (const q of qs) await get('/api/nba/research?limit=50' + q); // warm
  for (const q of qs) {
    const t0 = process.hrtime.bigint();
    const r = await get('/api/nba/research?limit=50' + q);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.strictEqual(r.status, 200);
    assert(ms < 150, `research${q} ${ms.toFixed(1)}ms`);
  }
  // Uncached query (fresh combination) on a warm index.
  let t0 = process.hrtime.bigint();
  await get('/api/nba/research?limit=200&sort=scoredP90&dir=asc&pos=SF,PF');
  let ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(ms < 150, `uncached research ${ms.toFixed(1)}ms`);
  for (const p of ['/api/nba/search?q=jok', '/api/nba/player/1658', '/api/nba/research/meta', '/api/nba/trending']) {
    await get(p);
    t0 = process.hrtime.bigint();
    const r = await get(p);
    ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.strictEqual(r.status, 200, p);
    assert(ms < 150, `${p} ${ms.toFixed(1)}ms`);
  }
});

test('trending offline → derived form lists, labelled', async () => {
  const t = (await get('/api/nba/trending?limit=5')).json;
  assert.strictEqual(t.derived, true); assert.strictEqual(t.source, 'derived-form');
  assert.strictEqual(t.adds.length, 5);
  assert(t.adds.every(a => a.count === null && a.player && typeof a.signal === 'number'));
  for (let i = 1; i < 5; i++) assert(t.adds[i - 1].signal >= t.adds[i].signal);
});

test('fetched context (fixtures): bio, schedule + b2b, game context + splits, news, trending join', async () => {
  const calls = [];
  const eng = R.createResearch({ getBoard, offline: false, fetchJson: fixtureFetch(calls), cacheDir: tmp });
  await eng.warm();
  const d = await eng.player('1658');
  assert.strictEqual(d.bio.age, 31); assert.strictEqual(d.bio.height, '6-11'); assert.strictEqual(d.bio.weightLb, 284);
  assert.strictEqual(d.bio.jersey, '15'); assert.strictEqual(d.identity.rotowireId, '3612');
  assert.strictEqual(d.unavailable.bio, undefined); assert.strictEqual(d.unavailable.gameContext, undefined);
  assert(d.gameLog.games.every(g => /^T\d$/.test(g.opp) && typeof g.home === 'boolean'));
  assert.strictEqual(d.splits.home.gp + d.splits.away.gp, d.lastSeason.gp);
  const w1 = d.schedule[0];
  assert.deepStrictEqual(w1.games.map(g => [g.date, g.opp, g.home, g.b2b]), [['2026-10-22', 'OKC', false, true], ['2026-10-23', 'NOP', true, true]]);
  assert.strictEqual(w1.b2bCount, 2);
  assert.deepStrictEqual(d.schedule[1].games.map(g => g.opp), ['GSW']);
  assert.strictEqual(d.news.available, true);
  assert.strictEqual(d.news.items[0].title, 'Nikola Jokic - Triple-double'); // HTML stripped
  assert.strictEqual(d.news.items[0].published, new Date(1791778224000).toISOString());
  const t = await eng.trending({ hours: 24, limit: 25 });
  assert.strictEqual(t.derived, false); assert.strictEqual(t.source, 'sleeper-trending');
  assert.strictEqual(t.adds[0].player.name, 'Nikola Jokić'); assert.strictEqual(t.adds[0].count, 10);
  assert.strictEqual(t.adds[1].name, 'Russell Westbrook'); // off-board in Sleeper → name from bio
  assert(t.adds[1].player === null || t.adds[1].player.source === 'yahoo-only');
  assert.strictEqual(t.adds[2].player, null);
  // Bio written to the disk cache and re-read by a fresh engine.
  assert(fs.existsSync(path.join(tmp, 'research-bio.json')));
  const eng2 = R.createResearch({ getBoard, offline: true, cacheDir: tmp });
  assert.strictEqual((await eng2.player('1658')).bio.age, 31);
  // Failing trending → derived fallback.
  const eng3 = R.createResearch({ getBoard, offline: false, fetchJson: fixtureFetch([], { failTrending: true }), cacheDir: tmp });
  assert.strictEqual((await eng3.trending()).derived, true);
});

test('unit: histogram, weekProbabilities, injuryTag, heightText', () => {
  const h = R.histogram([0, 4.9, 5, 12, 12, 33.3]);
  assert.deepStrictEqual(h.map(b => [b.lo, b.count]), [[0, 2], [5, 1], [10, 2], [15, 0], [20, 0], [25, 0], [30, 1]]);
  assert.deepStrictEqual(R.histogram([-3, 2]).map(b => [b.lo, b.count]), [[-5, 1], [0, 1]]);
  assert.deepStrictEqual(R.histogram([]), []);
  const scores = Array.from({ length: 40 }, (_, i) => 30 + i);
  const p2 = R.weekProbabilities({ scores, logMean: 49.5, modelMean: 49.5, modelSd: 11.7, n: 2, a: 1 });
  const p4 = R.weekProbabilities({ scores, logMean: 49.5, modelMean: 49.5, modelSd: 11.7, n: 4, a: 1 });
  for (const T of R.PROB_THRESHOLDS) assert(p4[T] >= p2[T]);
  assert(p2['40'] > p2['50'] && p2['50'] > p2['60'] && p2['60'] > p2['70']);
  // q(50) ≈ 0.5 for uniform 30..69 → P(max of 2 ≥ 50) ≈ 0.75
  assert(Math.abs(p2['50'] - 0.75) < 0.06, p2['50']);
  const pn = R.weekProbabilities({ scores: null, logMean: null, modelMean: 50, modelSd: 10, n: 1, a: 1 });
  assert(Math.abs(pn['50'] - 0.5) < 0.01 && Math.abs(pn['60'] - 0.1587) < 0.01);
  assert.strictEqual(R.weekProbabilities({ modelMean: 50, modelSd: 10, n: 0, a: 1 }), null);
  assert.deepStrictEqual(R.weekProbabilities({ modelMean: 50, modelSd: 10, n: 3, a: 0 }), { 40: 0, 50: 0, 60: 0, 70: 0 });
  assert.strictEqual(R.injuryTag('Out'), 'O'); assert.strictEqual(R.injuryTag('DTD'), 'DTD'); assert.strictEqual(R.injuryTag(null), null);
  assert.strictEqual(R.injuryTag('Out', true), 'OFS'); assert.strictEqual(R.injuryTag('Sus'), 'SUSP');
  assert.strictEqual(R.heightText('83'), '6-11'); assert.strictEqual(R.heightText(null), null);
});

(async () => {
  await boot();
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
  }
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
