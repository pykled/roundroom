#!/usr/bin/env node
// Integration checks for the merged NBA streams: nba/model/enrich.js (market
// layer + Yahoo-only rows on /api/nba/players?profile=), the router mount, and
// the profile's draft rounds. Offline: uses the committed data files.
'use strict';
const assert = require('assert');
const express = require('express');
const http = require('http');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

(async () => {
  const model = require('../nba/model');
  const { enrichPlayers, estimateValue } = require('../nba/model/enrich');
  const base = await model.getPlayers({ profile: '242808' });
  const before = JSON.stringify(base.players.slice(0, 50));
  const e = enrichPlayers(base);

  console.log('enrich: market layer');
  await t('market fields joined onto model players (Yahoo-first), cached model response untouched', () => {
    const j = e.players.find(p => p.yahooPid === '5352');
    assert.ok(j && j.marketRank === 1 && j.label === 'fair', JSON.stringify(j && { m: j.marketRank, l: j.label }));
    assert.ok(e.market.available && e.market.matched > 500, JSON.stringify(e.market));
    assert.strictEqual(JSON.stringify(base.players.slice(0, 50)), before);
    assert.ok(base.players.every(p => p.modelRank === undefined));
  });
  await t('degrades with no market file: no market fields, market.available=false', () => {
    const x = enrichPlayers(base, { market: null });
    assert.strictEqual(x.market.available, false);
    assert.ok(x.players.every(p => p.marketRank === undefined));
  });

  console.log('enrich: Yahoo-only rows');
  const yo = e.players.filter(p => p.source === 'yahoo-only');
  await t('every Yahoo pool player with a pid is on the board exactly once', () => {
    const snap = require('../nba/model/yahoo').loadSnapshot('242808');
    const pids = new Set(e.players.filter(p => p.yahooPid != null).map(p => p.yahooPid));
    const missing = snap.players.filter(y => y.pid != null && y.pid !== '' && !pids.has(String(y.pid)));
    assert.deepStrictEqual(missing.map(y => y.name), []);
    const all = e.players.filter(p => p.yahooPid != null).map(p => p.yahooPid);
    assert.strictEqual(new Set(all).size, all.length, 'duplicate yahooPid');
    assert.ok(yo.length >= 100, 'yahoo-only ' + yo.length);
  });
  await t('Westbrook/Valančiūnas: yahoo-only, Yahoo positions, conservative value, no NaN', () => {
    const w = yo.find(p => /Westbrook/.test(p.name)), v = yo.find(p => /Valan/.test(p.name));
    assert.ok(w && v);
    assert.deepStrictEqual(w.yahooElig, ['PG', 'SG', 'G', 'UTIL']);
    assert.deepStrictEqual(v.yahooElig, ['C', 'UTIL']); // C-only never F
    assert.ok(w.noLogData && w.eligConfidence === 'yahoo' && w.id === 'y4390');
    // conservative: below the model's matched players with the same Yahoo fanPts/GP band
    assert.ok(w.hsValue > 15 && w.hsValue < 24, w.hsValue);
    for (const p of yo) for (const k of ['hsValue', 'mean', 'sd', 'ceiling', 'floor', 'rank', 'tier']) assert.ok(Number.isFinite(p[k]), p.name + ' ' + k);
    assert.strictEqual(estimateValue({ gp: 0, fanPts: 0 }).hsValue >= 0, true);
  });
  await t('ranks are 1..N unique; model order preserved; modelRank kept', () => {
    const ranks = e.players.map(p => p.rank);
    assert.deepStrictEqual(ranks, ranks.map((_, i) => i + 1));
    const m = e.players.filter(p => p.source !== 'yahoo-only').map(p => p.modelRank);
    for (let i = 1; i < m.length; i++) assert.ok(m[i] > m[i - 1], 'model order broken at ' + i);
    assert.strictEqual(e.players[0].name, 'Nikola Jokić');
  });

  console.log('router + profile');
  await t('GET /api/nba/market is mounted; /api/nba/players carries market + yahoo-only rows', async () => {
    const createNbaRouter = require('../nba/router');
    const cache = new Map();
    const apiCached = async (k, ttl, fn) => { if (!cache.has(k)) cache.set(k, await fn()); return cache.get(k); };
    const app = express();
    app.use('/', createNbaRouter({ auth: (q, r, n) => r.status(401).end(), getAuth: () => ({}), apiCached, env: {}, log: { error() {}, warn() {}, log() {} } }));
    const srv = http.createServer(app).listen(0);
    const port = srv.address().port;
    const get = u => new Promise((res, rej) => http.get(`http://127.0.0.1:${port}${u}`, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
    try {
      const m = await get('/api/nba/market');
      assert.strictEqual(m.status, 200);
      assert.ok(JSON.parse(m.body).available);
      const p = JSON.parse((await get('/api/nba/players?profile=242808')).body);
      assert.ok(p.players.some(x => x.source === 'yahoo-only') && p.players.some(x => x.marketRank != null));
      const lp = JSON.parse((await get('/api/nba/league-profile')).body);
      assert.strictEqual(lp.draft.rounds, 14);
    } finally { srv.close(); }
  });
  await t('profile: 14 draft rounds (IL not drafted) = teams x (rosterSize - IL)', () => {
    const P = require('../nba/league-profile').getProfile('242808');
    assert.strictEqual(P.draft.rounds, P.rosterSize - P.slots.IL);
    assert.strictEqual(base.profile.draftedPool, P.teams * P.draft.rounds);
  });

  console.log(`\nnba-integration: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
