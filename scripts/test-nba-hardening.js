#!/usr/bin/env node
// Stream G (hardening + draft day) checks: logout CSRF, persisted OAuth nonces
// across a "restart", per-IP rate limits, request size limits, players ETag +
// gzip, health modelAsOf, no secrets in logs, draft-day logic (Yahoo clock with
// keepers/traded picks, auction guard, pick timer), the Yahoo chip wiring and
// the yahoo-diagnose CLI.
// Run: node scripts/test-nba-hardening.js   (no network)
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const compression = require('compression');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'nba');
const fx = name => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

const SECRET = 'test-client-secret-DO-NOT-LOG';
const ENV = { YAHOO_CLIENT_ID: 'test-client-id', YAHOO_CLIENT_SECRET: SECRET };

const oauth = require('../nba/yahoo/oauth');
const { createClient, createLimiter } = require('../nba/yahoo/client');
const { createTokenStore } = require('../nba/yahoo/store');
const { createNonceStore } = require('../nba/yahoo/nonces');
const createNbaRouter = require('../nba/router');
const L = require('../nba/pages/draft-logic');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name); console.error(e); process.exitCode = 1; }
}

function resp(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: k => headers[k.toLowerCase()] ?? null }, text: async () => text, json: async () => JSON.parse(text) };
}
function yahooFixtureFor(url) {
  const p = decodeURIComponent(new URL(url).pathname.replace('/fantasy/v2/', ''));
  if (/^game\/nba$/.test(p)) return fx('game.json');
  if (/^users;use_login=1\/games;game_keys=466\/leagues$/.test(p)) return fx('user-leagues.json');
  if (/^league\/466\.l\.\d+\/settings$/.test(p)) return fx('league-settings.json');
  if (/^game\/466\/game_weeks$/.test(p)) return fx('game-weeks.json');
  if (/^league\/466\.l\.\d+\/draftresults$/.test(p)) return fx('draftresults.json');
  if (/^league\/466\.l\.\d+\/teams$/.test(p)) return fx('teams.json');
  if (/^team\/466\.l\.\d+\.t\.\d+\/roster/.test(p)) return fx('roster.json');
  if (/^league\/466\.l\.\d+\/players;/.test(p)) return fx('players.json');
  throw new Error('unmocked Yahoo path ' + p);
}
const noWait = createLimiter({ minIntervalMs: 0 });

const fakeGetAuth = req => ({ userId: req.get('x-test-user') || null });
const fakeAuth = (req, res, next) => (fakeGetAuth(req).userId ? next() : res.status(401).json({ error: 'Sign in required' }));
function memCache() {
  const cache = new Map();
  return async (key, ttl, fn) => { const e = cache.get(key); if (e && e.exp > Date.now()) return e.v; const v = await fn(); cache.set(key, { v, exp: Date.now() + ttl }); return v; };
}
const fakeModel = {
  async getPlayers({ week } = {}) { return { season: '2026', week: week || 1, asOf: '2026-10-13T00:00:00Z', players: Array.from({ length: 300 }, (_, i) => ({ id: String(1000 + i), name: 'Player Number ' + i, team: 'DEN', hsValue: 50 - i / 10 })) }; },
  matchYahooPlayer() { return null; },
  status() { return { asOf: '2026-10-12T09:00:00Z' }; },
};

async function listen(app) {
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}
function makeApp(opts, { gzip = false } = {}) {
  const app = express();
  if (gzip) app.use(compression()); // as server.js does, before the router hook
  // yahooEnabled: these are the legacy Yahoo module's own tests (off by default on the site).
  app.use('/', createNbaRouter({ auth: fakeAuth, getAuth: fakeGetAuth, db: null, apiCached: memCache(), env: ENV, loadModel: () => fakeModel, log: { error() {}, warn() {} }, yahooEnabled: true, ...opts }));
  app.use(express.static(ROOT));
  return app;
}
// Raw http request so we control every header (fetch adds/strips some).
function raw(base, p, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
}

(async () => {
  console.log('logout: POST only, same-origin');
  {
    const store = createTokenStore({ env: ENV });
    const { srv, base } = await listen(makeApp({ store }));
    const host = new URL(base).host;
    const seed = () => store.save('user_A', { access_token: 'A', refresh_token: 'R', expires_at: Date.now() + 3600e3 });
    try {
      await test('GET/HEAD/PUT logout → 405 Allow: POST, tokens untouched (img-tag CSRF is dead)', async () => {
        await seed();
        for (const m of ['GET', 'PUT', 'DELETE']) {
          const r = await raw(base, '/nba/auth/logout', { method: m, headers: { 'x-test-user': 'user_A', 'sec-fetch-site': 'cross-site' } });
          assert.strictEqual(r.status, 405, m); assert.strictEqual(r.headers.allow, 'POST');
        }
        assert.ok(await store.get('user_A'));
      });
      await test('cross-site / same-site / missing / foreign Origin / "null" origin POSTs → 403', async () => {
        const cases = [
          { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'none' }, {},
          { origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'not a url' },
          { 'sec-fetch-site': 'cross-site', origin: base }, // Sec-Fetch-Site wins
        ];
        for (const h of cases) {
          const r = await raw(base, '/nba/auth/logout', { method: 'POST', headers: { 'x-test-user': 'user_A', ...h } });
          assert.strictEqual(r.status, 403, JSON.stringify(h));
        }
        assert.ok(await store.get('user_A'), 'still connected');
      });
      await test('same-origin POST (Sec-Fetch-Site or matching Origin, or prod origin) disconnects', async () => {
        let r = await raw(base, '/nba/auth/logout', { method: 'POST', headers: { 'x-test-user': 'user_A', 'sec-fetch-site': 'same-origin' } });
        assert.strictEqual(r.status, 200); assert.strictEqual(await store.get('user_A'), null);
        await seed();
        r = await raw(base, '/nba/auth/logout', { method: 'POST', headers: { 'x-test-user': 'user_A', origin: `http://${host}` } });
        assert.strictEqual(r.status, 200); assert.strictEqual(await store.get('user_A'), null);
        await seed();
        r = await raw(base, '/nba/auth/logout', { method: 'POST', headers: { 'x-test-user': 'user_A', host: 'pocketff.com', origin: 'https://pocketff.com' } });
        assert.strictEqual(r.status, 200);
      });
      await test('signed-out POST → 401', async () => {
        const r = await raw(base, '/nba/auth/logout', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
        assert.strictEqual(r.status, 401);
      });
    } finally { srv.close(); }
  }

  console.log('OAuth nonces survive a restart / second instance');
  await test('login on instance 1, callback on instance 2 (shared nba_oauth_nonces) → connected; replay → 400', async () => {
    const rows = new Map();
    const db = { query: async (q, p = []) => {
      if (/^CREATE TABLE/.test(q)) return { rows: [] };
      if (/^INSERT INTO nba_oauth_nonces/.test(q)) { rows.set(p[0], { clerk_user_id: p[1], expires_at: p[2] }); return { rows: [] }; }
      if (/^DELETE FROM nba_oauth_nonces WHERE nonce/.test(q)) { const r = rows.get(p[0]); rows.delete(p[0]); return { rows: r ? [r] : [] }; }
      if (/^DELETE FROM nba_oauth_nonces WHERE expires_at/.test(q)) return { rows: [] };
      throw new Error('unexpected SQL: ' + q);
    } };
    const store = createTokenStore({ env: ENV });
    const exchange = async () => ({ access_token: 'A', refresh_token: 'R', expires_at: Date.now() + 3600e3 });
    const one = await listen(makeApp({ db, store, exchangeCode: exchange }));
    const loc = (await raw(one.base, '/nba/auth/login', { headers: { 'x-test-user': 'user_N' } })).headers.location;
    one.srv.close(); // "restart"
    const state = new URL(loc).searchParams.get('state');
    assert.strictEqual(rows.size, 1, 'nonce persisted in the table');
    const two = await listen(makeApp({ db, store, exchangeCode: exchange }));
    try {
      const cb = await raw(two.base, `/nba/auth/callback?code=C&state=${encodeURIComponent(state)}`, { headers: { 'x-test-user': 'user_N' } });
      assert.strictEqual(cb.status, 302); assert.strictEqual(cb.headers.location, '/nba?yahoo=connected');
      assert.ok(await store.get('user_N'));
      const replay = await raw(two.base, `/nba/auth/callback?code=C&state=${encodeURIComponent(state)}`, { headers: { 'x-test-user': 'user_N' } });
      assert.strictEqual(replay.status, 400);
    } finally { two.srv.close(); }
  });
  await test('nonce store outage → 503 on login/callback, never a crash', async () => {
    const broken = { persistent: true, issue: async () => { throw new Error('db down'); }, consume: async () => { throw new Error('db down'); } };
    const { srv, base } = await listen(makeApp({ nonces: broken }));
    try {
      assert.strictEqual((await raw(base, '/nba/auth/login', { headers: { 'x-test-user': 'u' } })).status, 503);
      const { signState } = require('../nba/yahoo/crypto');
      const st = signState({ userId: 'u', nonce: 'n' }, ENV);
      assert.strictEqual((await raw(base, `/nba/auth/callback?code=C&state=${encodeURIComponent(st)}`, { headers: { 'x-test-user': 'u' } })).status, 503);
    } finally { srv.close(); }
  });
  await test('callback with invalid_client from token endpoint → ?yahoo=misconfigured', async () => {
    const { srv, base } = await listen(makeApp({ exchangeCode: args => oauth.exchangeCode(args, { env: ENV, fetchImpl: async () => resp(401, { error: 'invalid_client' }) }) }));
    try {
      const loc = (await raw(base, '/nba/auth/login', { headers: { 'x-test-user': 'u' } })).headers.location;
      const st = new URL(loc).searchParams.get('state');
      const cb = await raw(base, `/nba/auth/callback?code=C&state=${encodeURIComponent(st)}`, { headers: { 'x-test-user': 'u' } });
      assert.strictEqual(cb.headers.location, '/nba?yahoo=misconfigured');
    } finally { srv.close(); }
  });

  console.log('rate + size limits');
  {
    const store = createTokenStore({ env: ENV });
    await store.save('user_L', { access_token: 'A', refresh_token: 'R', expires_at: Date.now() + 3600e3 });
    const { srv, base } = await listen(makeApp({ store, rateLimits: { api: 3, auth: 2 },
      makeClient: o => createClient({ ...o, limiter: noWait, fetchImpl: async url => resp(200, yahooFixtureFor(url)) }) }));
    try {
      await test('public API: 4th request in a minute from one IP → 429 + Retry-After', async () => {
        const codes = [];
        for (let i = 0; i < 4; i++) codes.push((await raw(base, i % 2 ? '/api/nba/health' : '/api/nba/players')).status);
        assert.deepStrictEqual(codes, [200, 200, 200, 429]);
        const r = await raw(base, '/api/nba/players');
        assert.ok(Number(r.headers['retry-after']) >= 1);
      });
      await test('auth endpoints have their own (tighter) bucket', async () => {
        const codes = [];
        for (let i = 0; i < 3; i++) codes.push((await raw(base, '/nba/auth/login')).status);
        assert.deepStrictEqual(codes, [302, 302, 429]);
      });
      await test('authenticated Yahoo endpoints are not throttled by the public bucket', async () => {
        for (let i = 0; i < 5; i++) assert.strictEqual((await raw(base, '/api/nba/yahoo/status', { headers: { 'x-test-user': 'user_L' } })).status, 200);
      });
      await test('oversized body → 413, oversized URL → 414 (before any handler runs)', async () => {
        const big = 'x'.repeat(20 * 1024);
        assert.strictEqual((await raw(base, '/api/nba/yahoo/status', { method: 'POST', headers: { 'x-test-user': 'user_L', 'content-type': 'application/json', 'content-length': String(big.length) }, body: big })).status, 413);
        assert.strictEqual((await raw(base, '/api/nba/yahoo/league?league_key=' + 'a'.repeat(3000), { headers: { 'x-test-user': 'user_L' } })).status, 414);
      });
      await test('createRateLimiter window resets', () => {
        const hit = createNbaRouter.createRateLimiter({ windowMs: 1000, max: 1 });
        assert.strictEqual(hit('ip', 0).ok, true); assert.strictEqual(hit('ip', 10).ok, false);
        assert.strictEqual(hit('ip', 1001).ok, true);
        assert.strictEqual(hit('other', 10).ok, true);
      });
    } finally { srv.close(); }
  }

  console.log('players: ETag, cache headers, gzip; health');
  {
    const { srv, base } = await listen(makeApp({}, { gzip: true }));
    try {
      await test('/api/nba/players gzip + weak ETag + Cache-Control; If-None-Match → 304 with no body', async () => {
        const a = await raw(base, '/api/nba/players', { headers: { 'accept-encoding': 'gzip' } });
        assert.strictEqual(a.status, 200);
        assert.strictEqual(a.headers['content-encoding'], 'gzip');
        assert.match(a.headers.etag, /^W\/"[A-Za-z0-9_-]+"$/);
        assert.match(a.headers['cache-control'], /public, max-age=300/);
        const j = JSON.parse(zlib.gunzipSync(a.body).toString('utf8'));
        assert.strictEqual(j.players.length, 300);
        const b = await raw(base, '/api/nba/players', { headers: { 'if-none-match': a.headers.etag } });
        assert.strictEqual(b.status, 304); assert.strictEqual(b.body.length, 0);
        const c = await raw(base, '/api/nba/players', { headers: { 'if-none-match': 'W/"stale"' } });
        assert.strictEqual(c.status, 200);
        const d = await raw(base, '/api/nba/players?week=3');
        assert.strictEqual(d.status, 200);
        assert.notStrictEqual(d.headers.etag, a.headers.etag, 'different payload, different ETag');
      });
      await test('health reports modelAsOf from model.status() before any players call (Checker A4)', async () => {
        const { srv: s2, base: b2 } = await listen(makeApp({}));
        try { assert.strictEqual(JSON.parse((await raw(b2, '/api/nba/health')).body).modelAsOf, '2026-10-12T09:00:00Z'); } finally { s2.close(); }
      });
    } finally { srv.close(); }
  }

  console.log('no secrets in logs');
  await test('full flow (login, callback errors, refresh failures, diagnose) never logs secret/token/code/state/blob', async () => {
    const out = [];
    const cap = (...a) => out.push(a.map(x => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const TOK = { access_token: 'ACCESS_tok_SECRET_1', refresh_token: 'REFRESH_tok_SECRET_1', expires_at: Date.now() - 1, xoauth_yahoo_guid: 'GUID_SECRET_1' };
    const store = createTokenStore({ env: ENV, log: { warn: cap, error: cap } });
    let tokenMode = 'exchange_fail';
    // Token endpoint that echoes everything it was sent back in its error body.
    const tokenFetch = async (url, init) => {
      const echo = `client ${init.headers.Authorization} body ${init.body}`;
      if (tokenMode === 'exchange_fail') return resp(401, { error: 'invalid_client', error_description: echo });
      if (tokenMode === 'exchange_ok') return resp(200, { access_token: TOK.access_token, refresh_token: TOK.refresh_token, expires_in: 3600, xoauth_yahoo_guid: TOK.xoauth_yahoo_guid });
      if (tokenMode === 'grant') return resp(400, { error: 'invalid_grant', error_description: echo });
      return resp(401, { error: { error: 'invalid_client', description: echo } });
    };
    console.log = console.error = console.warn = console.info = cap;
    let blob;
    try {
      const app = express();
      app.use('/', createNbaRouter({
        auth: fakeAuth, getAuth: fakeGetAuth, db: null, apiCached: memCache(), env: ENV, store, loadModel: () => fakeModel, diagnoseCooldownMs: 0, yahooEnabled: true,
        exchangeCode: args => oauth.exchangeCode(args, { env: ENV, fetchImpl: tokenFetch }),
        makeClient: o => createClient({ ...o, limiter: noWait, sleep: async () => {}, refresh: rt => oauth.refreshTokens(rt, { env: ENV, fetchImpl: tokenFetch }),
          fetchImpl: async (url, init) => resp(401, { error: { description: 'echo ' + init.headers.Authorization } }) }),
        // log defaults to console → captured
      }));
      const { srv, base } = await listen(app);
      const states = [];
      try {
        const login = async () => { const l = (await raw(base, '/nba/auth/login', { headers: { 'x-test-user': 'user_S' } })).headers.location; const s = new URL(l).searchParams.get('state'); states.push(s); return s; };
        let st = await login();
        await raw(base, `/nba/auth/callback?code=CODE_SECRET_1&state=${encodeURIComponent(st)}`, { headers: { 'x-test-user': 'user_S' } });
        await raw(base, `/nba/auth/callback?code=CODE_SECRET_2&state=${encodeURIComponent(st)}`, { headers: { 'x-test-user': 'user_S' } }); // replay
        tokenMode = 'exchange_ok'; st = await login();
        await raw(base, `/nba/auth/callback?code=CODE_SECRET_3&state=${encodeURIComponent(st)}`, { headers: { 'x-test-user': 'user_S' } });
        // stored token is expired → every Yahoo call refreshes → refresh fails
        await store.save('user_S', TOK);
        tokenMode = 'client_obj';
        await raw(base, '/api/nba/yahoo/status', { headers: { 'x-test-user': 'user_S' } });
        await raw(base, '/api/nba/yahoo/league?league_key=466.l.1', { headers: { 'x-test-user': 'user_S' } });
        await raw(base, '/api/nba/yahoo/diagnose', { headers: { 'x-test-user': 'user_S' } });
        tokenMode = 'grant';
        await raw(base, '/api/nba/yahoo/draft?league_key=466.l.1', { headers: { 'x-test-user': 'user_S' } });
        // token fetched OK but API itself 401s with an echo of the bearer
        await store.save('user_S', { ...TOK, expires_at: Date.now() + 3600e3 });
        tokenMode = 'exchange_ok';
        await raw(base, '/api/nba/yahoo/roster?team_key=466.l.1.t.1', { headers: { 'x-test-user': 'user_S' } });
        // undecryptable row
        blob = require('../nba/yahoo/crypto').encryptTokens(TOK, { YAHOO_CLIENT_SECRET: 'other-key' });
        const bad = createTokenStore({ env: ENV, log: { warn: cap, error: cap } });
        await bad.save('x', TOK);
        const store2 = createTokenStore({ db: { query: async () => ({ rows: [{ yahoo_guid: null, token_blob: blob }] }) }, env: ENV, log: { warn: cap, error: cap } });
        await store2.get('x');
      } finally { srv.close(); }
      const all = out.join('\n');
      assert.ok(out.length >= 4, 'scenario produced logs: ' + out.length);
      const forbidden = [SECRET, Buffer.from(`test-client-id:${SECRET}`).toString('base64'), TOK.access_token, TOK.refresh_token, TOK.xoauth_yahoo_guid, 'CODE_SECRET', blob, ...states];
      for (const f of forbidden) assert.ok(!all.includes(f), `log leaked ${String(f).slice(0, 12)}…:\n${all}`);
      assert.ok(/rejected the app credentials/.test(all), 'misconfiguration was logged');
    } finally { Object.assign(console, orig); }
  });

  await test('client error text redacts bearer/basic/token params and the live token values', () => {
    const { redact, errorDescription } = require('../nba/yahoo/client');
    const t = redact('Bearer abc.DEF-123 Basic Zm9vOmJhcg== access_token=xyz&code=CODE1 raw TOKENVALUE99', ['TOKENVALUE99']);
    assert.ok(!/abc\.DEF|Zm9vOmJhcg|xyz|CODE1|TOKENVALUE99/.test(t), t);
    assert.ok(!errorDescription('<error><description>bad Bearer SEKRET_ABC</description></error>').includes('SEKRET_ABC'));
  });

  console.log('draft-day logic (nba/pages/draft-logic.js)');
  const T = k => '466.l.1.t.' + k;
  await test('syncClock: keeper slot + traded picks → the league\'s owner on the clock, not the snake', () => {
    const y = {
      status: 'drafting',
      picks: [{ pick: 1, team_key: T(1) }, { pick: 2, team_key: T(2) }, { pick: 3, team_key: T(3) }, { pick: 7, team_key: T(2) }],
      order: [4, 5, 6, 8, 9, 10, 11, 12].map(p => ({ pick: p, round: Math.ceil(p / 4), team_key: T({ 4: 1, 5: 1, 6: 3, 8: 4, 9: 4, 10: 2, 11: 3, 12: 4 }[p]) })),
    };
    let c = L.syncClock(y, T(1), 0);
    assert.strictEqual(c.cur, 4); assert.strictEqual(c.teamKey, T(1)); assert.strictEqual(c.onMe, true);
    assert.strictEqual(L.slotForPick(4, 4), 4, 'the snake would have said slot 4');
    assert.strictEqual(c.myAfter, 5); assert.strictEqual(c.gapNow, 0, 'back-to-back');
    c = L.syncClock(y, T(4), 0);
    assert.strictEqual(c.onMe, false); assert.strictEqual(c.myNext, 8); assert.strictEqual(c.awayN, 3, 'picks 4,5,6 come first (7 is a keeper)');
    assert.strictEqual(c.myAfter, 9); assert.strictEqual(c.gapNext, 0);
    c = L.syncClock(y, T(1), 2); // two local picks pending
    assert.strictEqual(c.cur, 6); assert.strictEqual(c.teamKey, T(3));
    assert.strictEqual(L.syncClock({ status: 'drafting', picks: [{ pick: 1 }], order: [] }, T(1), 0), null, 'no order → snake fallback');
    assert.strictEqual(L.syncClock({ status: 'postdraft', picks: [{ pick: 1 }], order: [] }, T(1), 0).done, true);
    assert.strictEqual(L.syncClock(null, T(1), 0), null);
  });
  await test('mergePicks with the league order: pending manual picks fill the next open slots with their owner', () => {
    const y = { picks: [{ pick: 1, round: 1, team_key: T(1), player_key: 'a', sleeperId: '1' }, { pick: 3, round: 1, team_key: T(3), player_key: 'k', sleeperId: '3' }],
      order: [{ pick: 2, round: 1, team_key: T(1) }, { pick: 4, round: 1, team_key: T(2) }] };
    const m = L.mergePicks(y, [{ playerId: '9', mine: true }, { playerId: '8' }, { playerId: '7' }], { settings: { teams: 4 }, myTeamKey: T(1) });
    assert.deepStrictEqual(m.picks.map(p => [p.pick, p.source, p.team_key || null]), [[1, 'sync', T(1)], [2, 'manual', T(1)], [3, 'sync', T(3)], [4, 'manual', T(2)], [5, 'manual', null]]);
    const plain = L.mergePicks({ picks: [{ pick: 1, sleeperId: '1' }] }, [{ playerId: '2' }], { settings: { teams: 4 } });
    assert.deepStrictEqual(plain.picks.map(p => p.pick), [1, 2], 'no order → unchanged behaviour');
  });
  await test('isAuction: league flags, draft_type, or draft results with cost', () => {
    assert.strictEqual(L.isAuction({ is_auction_draft: true }), true);
    assert.strictEqual(L.isAuction({ settings: { is_auction_draft: true } }), true);
    assert.strictEqual(L.isAuction({ draft_type: 'auction' }), true);
    assert.strictEqual(L.isAuction(null, { picks: [{ pick: 1, cost: 12 }] }), true);
    assert.strictEqual(L.isAuction(null, { auction: true }), true);
    assert.strictEqual(L.isAuction({ is_auction_draft: false, draft_type: 'live' }, { picks: [{ pick: 1 }] }), false);
  });
  await test('timerState: idle, ok, warn, urgent, expired, off; seconds clamped', () => {
    const t0 = 1e12;
    assert.deepStrictEqual(L.timerState(0, 60, t0), { running: false, left: 60, level: 'idle', text: '1:00' });
    assert.strictEqual(L.timerState(t0, 60, t0 + 5000).level, 'ok');
    assert.strictEqual(L.timerState(t0, 60, t0 + 41000).level, 'warn');
    assert.strictEqual(L.timerState(t0, 60, t0 + 51000).text, '0:09');
    assert.strictEqual(L.timerState(t0, 60, t0 + 51000).level, 'urgent');
    assert.strictEqual(L.timerState(t0, 60, t0 + 61000).level, 'expired');
    assert.strictEqual(L.timerState(t0, 0, t0).level, 'off');
    assert.strictEqual(L.normalizeTimerSeconds('abc'), 60);
    assert.strictEqual(L.normalizeTimerSeconds(99999), 600);
    assert.strictEqual(L.timerState(t0, 90, t0).text, '1:30');
  });
  await test('settingsFromLeague: empty roster_positions keeps bench/slots (Checker C2)', () => {
    const prev = { teams: 12, mySlot: 3, slots: { G: 2, F: 3, UTIL: 1 }, bench: 4 };
    assert.deepStrictEqual(L.settingsFromLeague({ num_teams: 12, roster_positions: [] }, null, null, prev), L.normalizeSettings(prev));
    assert.deepStrictEqual(L.settingsFromLeague({ num_teams: 12, roster_positions: {} }, null, null, prev).bench, 4);
    assert.strictEqual(L.settingsFromLeague({ num_teams: 12, roster_positions: [{ position: 'G', count: 2 }, { position: 'BN', count: 3 }] }, null, null, prev).bench, 3);
  });

  console.log('UI wiring');
  await test('draft page: Sleeper chip loaded before draft.js; no Yahoo OAuth links; chip never calls Yahoo', () => {
    const html = fs.readFileSync(path.join(ROOT, 'nba/pages/draft.html'), 'utf8');
    assert.ok(html.indexOf('/nba/pages/sleeper-chip.js') > 0 && html.indexOf('/nba/pages/sleeper-chip.js') < html.indexOf('/nba/pages/draft.js'));
    assert.ok(!fs.existsSync(path.join(ROOT, 'nba/pages/yahoo-chip.js')), 'yahoo-chip.js removed');
    for (const f of ['draft.html', 'draft.js', 'sleeper-chip.js', 'lineup.html', 'trade.html', 'waivers.html', 'research.html']) assert.ok(!/\/nba\/auth\/(login|logout)/.test(fs.readFileSync(path.join(ROOT, 'nba/pages', f), 'utf8')), f + ' links Yahoo OAuth');
    const chip = fs.readFileSync(path.join(ROOT, 'nba/pages/sleeper-chip.js'), 'utf8');
    assert.match(chip, /\/api\/nba\/sleeper\/user\?username=/);
    assert.ok(!/api\/nba\/yahoo/.test(chip));
    assert.match(html, /id="nd-timer"/); assert.match(html, /id="nd-firstrun"/); assert.match(html, /name="timer"/); assert.match(html, /id="nd-fr-user"/);
    const js = fs.readFileSync(path.join(ROOT, 'nba/pages/draft.js'), 'utf8');
    assert.ok(/connect=sleeper/.test(js), 'handles ?connect=sleeper (old OAuth links land there)');
    assert.ok(!/api\/nba\/yahoo/.test(js), 'draft.js never calls the Yahoo API');
    new Function(js); new Function(chip); // parse
  });
  await test('sleeper-chip.js is served from /nba/pages (deny list blocks server files incl. nba/sleeper)', async () => {
    const { srv, base } = await listen(makeApp({}));
    try {
      assert.strictEqual((await raw(base, '/nba/pages/sleeper-chip.js')).status, 200);
      for (const p of ['/nba/yahoo/diagnose.js', '/nba/yahoo/nonces.js', '/nba/sleeper/client.js', '/nba/sleeper/map.js', '/nba/routes/sleeper.js']) assert.strictEqual((await raw(base, p)).status, 404, p);
    } finally { srv.close(); }
  });
  await test('Yahoo off (default): OAuth → /nba?connect=sleeper, API → 410 / disabled status', async () => {
    const { srv, base } = await listen(makeApp({ yahooEnabled: false }));
    try {
      const r = await raw(base, '/nba/auth/login', { headers: { 'x-test-user': 'user_A' } });
      assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/nba?connect=sleeper');
      assert.strictEqual((await raw(base, '/nba/auth/logout', { method: 'POST', headers: { 'x-test-user': 'user_A', 'sec-fetch-site': 'same-origin' } })).status, 410);
      const st = await raw(base, '/api/nba/yahoo/status', { headers: { 'x-test-user': 'user_A' } });
      assert.strictEqual(st.status, 200); assert.deepStrictEqual(JSON.parse(st.body), { connected: false, disabled: true, code: 'yahoo_disabled' });
      assert.strictEqual((await raw(base, '/api/nba/yahoo/draft?league_key=466.l.1', { headers: { 'x-test-user': 'user_A' } })).status, 410);
      const h = JSON.parse((await raw(base, '/api/nba/health')).body);
      assert.strictEqual(h.yahooEnabled, false); assert.strictEqual(h.sleeper, true);
    } finally { srv.close(); }
  });

  console.log('yahoo-diagnose CLI');
  await test('--fixtures prints a report and exits 0; usage error exits 2; no tokens printed', () => {
    const r = spawnSync(process.execPath, ['scripts/yahoo-diagnose.js', '--fixtures'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /High Score\? LIKELY/);
    assert.match(r.stdout, /#1 r1 466\.l\.12345\.t\.3 → Nikola Jokic/);
    assert.ok(!/FAKEGUID|access_token|fixture/.test(r.stdout));
    const j = spawnSync(process.execPath, ['scripts/yahoo-diagnose.js', '--fixtures', '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(JSON.parse(j.stdout).gameKey, '466');
    const u = spawnSync(process.execPath, ['scripts/yahoo-diagnose.js'], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(u.status, 2);
    const nodb = spawnSync(process.execPath, ['scripts/yahoo-diagnose.js', '--user', 'x'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' } });
    assert.strictEqual(nodb.status, 2); assert.match(nodb.stderr, /DATABASE_URL/);
  });

  console.log('Checker G regressions');
  await test('/draft: explicit Yahoo "predraft" with keeper picks stays predraft; unknown status + picks → drafting', async () => {
    const store = createTokenStore({ env: ENV });
    await store.save('user_K', { access_token: 'A', refresh_token: 'R', expires_at: Date.now() + 3600e3 });
    let draftStatus = 'predraft';
    const keeperDraft = () => ({ fantasy_content: { league: [{ league_key: '466.l.1', draft_status: draftStatus }, { draft_results: {
      0: { draft_result: { pick: 1, round: 1, team_key: '466.l.1.t.1' } },
      1: { draft_result: { pick: 2, round: 1, team_key: '466.l.1.t.2', player_key: '466.p.5' } }, count: 2 } }] } });
    const { srv, base } = await listen(makeApp({ store, apiCached: async (k, ttl, fn) => fn(),
      makeClient: o => createClient({ ...o, limiter: noWait, fetchImpl: async url => resp(200, /draftresults/.test(url) ? keeperDraft() : yahooFixtureFor(url)) }) }));
    try {
      let d = JSON.parse((await raw(base, '/api/nba/yahoo/draft?league_key=466.l.1', { headers: { 'x-test-user': 'user_K' } })).body);
      assert.strictEqual(d.status, 'predraft'); assert.strictEqual(d.onClock, null); assert.strictEqual(d.picks.length, 1);
      for (const s of ['draft', undefined, 'inprogress']) {
        draftStatus = s;
        d = JSON.parse((await raw(base, '/api/nba/yahoo/draft?league_key=466.l.1', { headers: { 'x-test-user': 'user_K' } })).body);
        assert.strictEqual(d.status, 'drafting', String(s)); assert.strictEqual(d.onClock.pick, 1);
      }
    } finally { srv.close(); }
  });
  await test('diagnose: an unexpected throw is a 500, not an unhandled rejection (would exit Node)', async () => {
    const store = createTokenStore({ env: ENV });
    await store.save('user_D', { access_token: 'A', refresh_token: 'R', expires_at: Date.now() + 3600e3 });
    const rejections = [];
    const onRej = e => rejections.push(e);
    process.on('unhandledRejection', onRej);
    // runDiagnose only guards client calls; a client whose results are malformed
    // in a way the parser can't produce still must not take the server down.
    const weird = { getGameKey: async () => '466', getUserLeagues: async () => ({ slice() { throw new TypeError('boom'); }, length: 1 }) };
    const { srv, base } = await listen(makeApp({ store, makeClient: () => weird }));
    try {
      const r = await Promise.race([raw(base, '/api/nba/yahoo/diagnose', { headers: { 'x-test-user': 'user_D' } }),
        new Promise(res => setTimeout(() => res({ status: 'no response (handler rejected)' }), 3000))]);
      assert.strictEqual(r.status, 500);
      await new Promise(r => setTimeout(r, 20));
      assert.strictEqual(rejections.length, 0);
    } finally { srv.close(); process.off('unhandledRejection', onRej); }
  });
  await test('diagnose: URL-valued "other settings" are dropped whatever the key', () => {
    const { runDiagnose } = require('../nba/yahoo/diagnose');
    return runDiagnose({ client: {
      getGameKey: async () => '466', getUserLeagues: async () => [{ league_key: '466.l.1', name: 'L' }],
      getLeague: async () => ({ weeks: [], roster_positions: [], stat_modifiers: [], settings: { extra: { chat_link: 'https://chat.example/inv/abc', logo: ' http://x', uses_faab: '1' } } }),
      getTeams: async () => [], getDraftResults: async () => ({ picks: [] }),
    } }).then(r => assert.deepStrictEqual(r.leagues[0].settings.extra, { uses_faab: '1' }));
  });
  await test('pollPlan: hidden tab keeps polling (≥10s) only during a live draft; idle visible tab polls gently', () => {
    assert.deepStrictEqual(L.pollPlan(false, 'drafting', 0), { run: true, delay: 4000 });
    assert.deepStrictEqual(L.pollPlan(false, 'predraft', 0), { run: true, delay: L.IDLE_POLL_MS }, 'scheduled draft: 20 s visible polling');
    assert.deepStrictEqual(L.pollPlan(false, 'postdraft', 0), { run: true, delay: L.IDLE_POLL_MS });
    const t0 = 1e12;
    assert.deepStrictEqual(L.pollPlan(false, 'predraft', 0, { startTime: t0 + 5 * 60 * 1000, now: t0 }), { run: true, delay: 4000 }, 'draft starts in 5 min: live rate');
    assert.deepStrictEqual(L.pollPlan(false, 'predraft', 0, { startTime: t0 + 60 * 60 * 1000, now: t0 }), { run: true, delay: L.IDLE_POLL_MS }, 'draft in an hour: idle rate');
    assert.deepStrictEqual(L.pollPlan(true, 'predraft', 0, { startTime: t0 - 1000, now: t0 }), { run: true, delay: L.HIDDEN_POLL_MS }, 'hidden tab, draft overdue: keep polling');
    assert.deepStrictEqual(L.pollPlan(true, 'drafting', 0), { run: true, delay: L.HIDDEN_POLL_MS });
    assert.deepStrictEqual(L.pollPlan(true, 'drafting', 3), { run: true, delay: 30000 });
    assert.strictEqual(L.pollPlan(true, 'predraft', 0).run, false);
    assert.strictEqual(L.pollPlan(true, 'postdraft', 0).run, false);
    assert.strictEqual(L.pollPlan(true, undefined, 0).run, false);
    const js = fs.readFileSync(path.join(ROOT, 'nba/pages/draft.js'), 'utf8');
    assert.match(js, /L\.pollPlan\(document\.hidden/);
    assert.ok(!/if \(document\.hidden\) stopPolling\(\)/.test(js), 'hiding the tab must not stop a live draft poll');
  });
  await test('restoreTimerStart: reload keeps the clock for the same league + pick only', () => {
    const now = 1e12, saved = { leagueKey: 'L1', pick: 7, startedAt: now - 20000 };
    assert.strictEqual(L.restoreTimerStart(saved, 'L1', 7, now, 60), now - 20000);
    assert.strictEqual(L.restoreTimerStart(saved, 'L1', 8, now, 60), null, 'other pick');
    assert.strictEqual(L.restoreTimerStart(saved, 'L2', 7, now, 60), null, 'other league');
    assert.strictEqual(L.restoreTimerStart({ ...saved, startedAt: now - 200000 }, 'L1', 7, now, 60), null, 'stale');
    assert.strictEqual(L.restoreTimerStart({ ...saved, startedAt: now + 5000 }, 'L1', 7, now, 60), null, 'future');
    assert.strictEqual(L.restoreTimerStart({ leagueKey: null, pick: 3, startedAt: now - 1 }, null, 3, now, 60), now - 1, 'manual board');
    assert.strictEqual(L.restoreTimerStart(null, 'L1', 7, now, 60), null);
    // A reload first renders the local board (another pick), then Yahoo's: the
    // transient entry must not erase the real one.
    let list = L.rememberTimerStart(null, 'L1', 7, now - 20000);
    list = L.rememberTimerStart(list, 'L1', 1, now - 5);
    assert.strictEqual(L.restoreTimerStart(list, 'L1', 7, now, 60), now - 20000);
    list = L.rememberTimerStart(list, 'L1', 7, now - 3000);
    assert.strictEqual(L.restoreTimerStart(list, 'L1', 7, now, 60), now - 3000, 'replaced');
    assert.strictEqual(L.rememberTimerStart(list, 'L1', 2, 0).length, 2, 'idle clocks are not stored');
    for (let p = 10; p < 20; p++) list = L.rememberTimerStart(list, 'L1', p, now);
    assert.strictEqual(list.length, 4, 'bounded');
  });
  await test('openSlots: a slot Yahoo lists twice counts once', () => {
    const y = { status: 'drafting', picks: [], order: [{ pick: 1, team_key: T(1) }, { pick: 1, team_key: T(1) }, { pick: 2, team_key: T(2) }] };
    assert.deepStrictEqual(L.openSlots(y).map(o => o.pick), [1, 2]);
    assert.strictEqual(L.syncClock(y, T(1), 0).myAfter, null);
  });

  console.log('server.js (spawned real server)');
  await test('real server: players gzip + ETag/304, GET logout 405, no secret in stdout', async () => {
    // Yahoo is off by default since the Sleeper-first switch; these checks cover the Yahoo-enabled server.
    const env = { ...process.env, ...ENV, DATABASE_URL: '', NBA_YAHOO_ENABLED: '1' };
    const envFile = path.join(ROOT, '.env.local');
    if (!env.CLERK_PUBLISHABLE_KEY && fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) { const m = line.match(/^(CLERK_[A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }
    }
    if (!env.CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) { console.log('       (skipped: no Clerk keys for clerkMiddleware)'); return; }
    const port = await freePort(); env.PORT = String(port);
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    try {
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100 && !/running on port/.test(out); i++) await new Promise(r => setTimeout(r, 100));
      assert.match(out, /running on port/, out);
      const a = await raw(base, '/api/nba/players', { headers: { 'accept-encoding': 'gzip' } });
      if (a.status === 200) {
        assert.strictEqual(a.headers['content-encoding'], 'gzip');
        assert.strictEqual((await raw(base, '/api/nba/players', { headers: { 'if-none-match': a.headers.etag } })).status, 304);
      } else console.log('       (players unavailable offline: ' + a.status + '; gzip/ETag covered in-process)');
      assert.strictEqual((await raw(base, '/nba/auth/logout')).status, 405);
      assert.strictEqual((await raw(base, '/nba/auth/logout', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
      assert.strictEqual((await raw(base, '/api/nba/yahoo/diagnose')).status, 401);
      assert.ok(!out.includes(SECRET), 'secret in server output');
    } finally { child.kill('SIGKILL'); }
  });

  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
})().catch(e => { console.error(e); process.exit(1); });
