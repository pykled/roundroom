#!/usr/bin/env node
// Checks for stream A (Pocket NBA foundation): OAuth state, token crypto,
// Yahoo JSON parsing, 401→refresh→retry, rate-limit backoff, router wiring.
// Run: node scripts/test-nba-yahoo.js   (no network; Yahoo is mocked with
// recorded-shape fixtures in scripts/fixtures/nba/)
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'nba');
const fx = name => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

const ENV = { YAHOO_CLIENT_ID: 'test-client-id', YAHOO_CLIENT_SECRET: 'test-client-secret' };

const C = require('../nba/yahoo/crypto');
const P = require('../nba/yahoo/parse');
const oauth = require('../nba/yahoo/oauth');
const { createClient, createLimiter } = require('../nba/yahoo/client');
const { createTokenStore } = require('../nba/yahoo/store');
const createNbaRouter = require('../nba/router');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name); console.error(e); process.exitCode = 1; }
}

// Minimal fetch Response stand-in.
function resp(status, body, headers = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

// Route a Yahoo API URL to a fixture.
function yahooFixtureFor(url) {
  const u = new URL(url);
  assert.strictEqual(u.searchParams.get('format'), 'json', 'every Yahoo call uses ?format=json');
  const p = decodeURIComponent(u.pathname.replace('/fantasy/v2/', ''));
  if (/^game\/nba$/.test(p)) return fx('game.json');
  if (/^users;use_login=1\/games;game_keys=466\/leagues$/.test(p)) return fx('user-leagues.json');
  if (/^league\/466\.l\.12345\/settings$/.test(p)) return fx('league-settings.json');
  if (/^game\/466\/game_weeks$/.test(p)) return fx('game-weeks.json');
  if (/^league\/466\.l\.12345\/draftresults$/.test(p)) return fx('draftresults.json');
  if (/^league\/466\.l\.12345\/teams$/.test(p)) return fx('teams.json');
  if (/^team\/466\.l\.12345\.t\.1\/roster(;week=1)?$/.test(p)) return fx('roster.json');
  if (/^league\/466\.l\.12345\/players;/.test(p)) return fx('players.json');
  throw new Error('unmocked Yahoo path ' + p);
}

const noWait = createLimiter({ minIntervalMs: 0 });
const fastSleep = () => Promise.resolve();

function memTokens(initial) {
  let t = initial;
  return { getTokens: async () => t, saveTokens: async n => { t = n; }, peek: () => t };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

(async () => {
  console.log('crypto: OAuth state');
  await test('sign/verify round trip bound to the user', () => {
    const s = C.signState({ userId: 'user_A', nonce: 'n1' }, ENV);
    const v = C.verifyState(s, { userId: 'user_A' }, ENV);
    assert.deepStrictEqual(v, { ok: true, userId: 'user_A', nonce: 'n1' });
  });
  await test('rejects other user, tampering, wrong key, expiry, garbage', () => {
    const s = C.signState({ userId: 'user_A', nonce: 'n1' }, ENV);
    assert.strictEqual(C.verifyState(s, { userId: 'user_B' }, ENV).reason, 'user_mismatch');
    const [body, sig] = s.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'user_B', n: 'n1', t: Date.now() })).toString('base64url');
    assert.strictEqual(C.verifyState(forged + '.' + sig, { userId: 'user_B' }, ENV).reason, 'bad_signature');
    assert.strictEqual(C.verifyState(s, { userId: 'user_A' }, { YAHOO_CLIENT_SECRET: 'other' }).reason, 'bad_signature');
    const old = C.signState({ userId: 'user_A', nonce: 'n1', now: Date.now() - 11 * 60 * 1000 }, ENV);
    assert.strictEqual(C.verifyState(old, { userId: 'user_A' }, ENV).reason, 'expired');
    assert.strictEqual(C.verifyState('nope', {}, ENV).ok, false);
    assert.strictEqual(C.verifyState(body + '.', {}, ENV).ok, false);
    assert.strictEqual(C.verifyState(undefined, {}, ENV).ok, false);
  });
  await test('nonce registry is single-use and user-bound (replay rejected)', () => {
    const reg = C.createNonceRegistry();
    const n = reg.issue('user_A');
    assert.strictEqual(reg.consume(n, 'user_B'), false, 'wrong user burns it');
    const n2 = reg.issue('user_A');
    assert.strictEqual(reg.consume(n2, 'user_A'), true);
    assert.strictEqual(reg.consume(n2, 'user_A'), false, 'replay');
    const n3 = reg.issue('user_A', Date.now() - 11 * 60 * 1000);
    assert.strictEqual(reg.consume(n3, 'user_A'), false, 'expired');
  });

  console.log('crypto: tokens at rest');
  await test('encrypt/decrypt round trip; ciphertext hides tokens; tamper + wrong key fail', () => {
    const tok = { access_token: 'AAA-secret', refresh_token: 'RRR-secret', expires_at: 123 };
    const blob = C.encryptTokens(tok, ENV);
    assert.ok(blob.startsWith('v1.'));
    assert.ok(!blob.includes('AAA') && !blob.includes('RRR'));
    assert.notStrictEqual(blob, C.encryptTokens(tok, ENV), 'random IV');
    assert.deepStrictEqual(C.decryptTokens(blob, ENV), tok);
    assert.deepStrictEqual(C.decryptTokens(C.encryptTokens(tok, { NBA_TOKEN_KEY: 'k2' }), { NBA_TOKEN_KEY: 'k2', YAHOO_CLIENT_SECRET: 'x' }), tok, 'NBA_TOKEN_KEY preferred');
    assert.throws(() => C.decryptTokens(blob, { YAHOO_CLIENT_SECRET: 'other' }));
    const raw = Buffer.from(blob.slice(3), 'base64url'); raw[raw.length - 1] ^= 1;
    assert.throws(() => C.decryptTokens('v1.' + raw.toString('base64url'), ENV));
  });
  await test('token store (memory + db SQL) only ever persists ciphertext', async () => {
    const mem = createTokenStore({ env: ENV });
    await mem.save('u1', { access_token: 'AAA', refresh_token: 'RRR', xoauth_yahoo_guid: 'G' });
    assert.strictEqual((await mem.get('u1')).access_token, 'AAA');
    await mem.remove('u1');
    assert.strictEqual(await mem.get('u1'), null);
    const rows = new Map(); const seen = [];
    const db = { query: async (sql, params) => {
      seen.push(params.join('|'));
      if (/^INSERT/.test(sql)) { rows.set(params[0], { yahoo_guid: params[1], token_blob: params[2] }); return { rows: [] }; }
      if (/^SELECT/.test(sql)) return { rows: rows.has(params[0]) ? [rows.get(params[0])] : [] };
      if (/^DELETE/.test(sql)) { rows.delete(params[0]); return { rows: [] }; }
    } };
    const s = createTokenStore({ db, env: ENV });
    await s.save('u2', { access_token: 'AAA', refresh_token: 'RRR', xoauth_yahoo_guid: 'G' });
    assert.ok(seen.every(x => !x.includes('AAA') && !x.includes('RRR')), 'no plaintext in SQL params');
    assert.strictEqual((await s.get('u2')).refresh_token, 'RRR');
  });
  await test('migration declares nba_yahoo_tokens', () => {
    assert.ok(/CREATE TABLE IF NOT EXISTS nba_yahoo_tokens/.test(fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8')));
  });

  console.log('oauth');
  await test('authorize URL has client_id, redirect_uri, scope fspt-r, state', () => {
    const u = new URL(oauth.authorizeUrl({ redirectUri: 'https://pocketff.com/nba/auth/callback', state: 'S' }, ENV));
    assert.strictEqual(u.origin + u.pathname, 'https://api.login.yahoo.com/oauth2/request_auth');
    assert.strictEqual(u.searchParams.get('client_id'), 'test-client-id');
    assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://pocketff.com/nba/auth/callback');
    assert.strictEqual(u.searchParams.get('scope'), 'fspt-r');
    assert.strictEqual(u.searchParams.get('response_type'), 'code');
    assert.strictEqual(u.searchParams.get('state'), 'S');
  });
  await test('code exchange POSTs get_token with Basic auth; errors do not echo body', async () => {
    let call;
    const t = await oauth.exchangeCode({ code: 'CODE1', redirectUri: 'https://x/cb' }, {
      env: ENV, fetchImpl: async (url, init) => { call = { url, init }; return resp(200, fx('token.json')); },
    });
    assert.strictEqual(call.url, 'https://api.login.yahoo.com/oauth2/get_token');
    assert.strictEqual(call.init.method, 'POST');
    assert.strictEqual(call.init.headers.Authorization, 'Basic ' + Buffer.from('test-client-id:test-client-secret').toString('base64'));
    const body = new URLSearchParams(call.init.body);
    assert.strictEqual(body.get('grant_type'), 'authorization_code');
    assert.strictEqual(body.get('code'), 'CODE1');
    assert.strictEqual(body.get('redirect_uri'), 'https://x/cb');
    assert.strictEqual(t.access_token, 'FAKE_ACCESS_TOKEN_1');
    assert.strictEqual(t.xoauth_yahoo_guid, 'FAKEGUID123');
    assert.ok(t.expires_at > Date.now() + 3500 * 1000);
    await assert.rejects(
      oauth.refreshTokens('RT', { env: ENV, fetchImpl: async () => resp(400, { error: 'invalid_grant', error_description: 'token RT revoked' }) }),
      e => e.code === 'invalid_grant' && !e.message.includes('RT revoked'));
  });

  console.log('parse');
  await test('game key + user leagues (numeric-keyed collections, count)', () => {
    assert.strictEqual(P.parseGame(fx('game.json')).game_key, '466');
    const { guid, leagues } = P.parseUserLeagues(fx('user-leagues.json'));
    assert.strictEqual(guid, 'FAKEGUID123');
    assert.deepStrictEqual(leagues.map(l => [l.league_key, l.name, l.num_teams, l.draft_status, l.game_key]), [
      ['466.l.12345', 'Pocket High Score', 10, 'predraft', '466'],
      ['466.l.67890', 'Office Hoops', 12, 'postdraft', '466'],
    ]);
  });
  await test('league settings: roster positions, stat modifiers, weeks', () => {
    const l = P.parseLeague(fx('league-settings.json'));
    assert.strictEqual(l.scoring_type, 'headpoint');
    assert.strictEqual(l.start_week, 1); assert.strictEqual(l.end_week, 24);
    assert.deepStrictEqual(l.settings.roster_positions.map(p => [p.position, p.count, p.is_starting_position]),
      [['G', 2, true], ['F', 3, true], ['Util', 1, true], ['BN', 4, false]]);
    assert.deepStrictEqual(l.settings.stat_modifiers, [12, 15, 16, 17, 18].map((id, i) => ({ stat_id: id, value: [1, 1, 2, 3, 3][i] })));
    assert.strictEqual(l.settings.stat_categories.find(c => c.stat_id === 16).display_name, 'AST');
    assert.deepStrictEqual(P.parseGameWeeks(fx('game-weeks.json'))[1], { week: 2, start: '2026-10-26', end: '2026-11-01' });
  });
  await test('draft results include empty future picks without player_key', () => {
    const d = P.parseDraftResults(fx('draftresults.json'));
    assert.strictEqual(d.draft_status, 'draft');
    assert.strictEqual(d.picks.length, 4);
    assert.deepStrictEqual(d.picks[0], { pick: 1, round: 1, team_key: '466.l.12345.t.3', player_key: '466.p.5352' });
    assert.strictEqual(d.picks[3].player_key, null);
  });
  await test('teams (array-of-fragments with [] placeholders) + current-login owner', () => {
    const teams = P.parseTeams(fx('teams.json'));
    assert.deepStrictEqual(teams.map(t => [t.team_key, t.name, t.is_owned_by_current_login]),
      [['466.l.12345.t.1', "Dillon's Dimes", true], ['466.l.12345.t.3', 'Glass Cleaners', false]]);
    assert.strictEqual(teams[0].managers[0].nickname, 'Dillon');
  });
  await test('roster players: name, team abbr, eligibility, selected_position, injury', () => {
    const r = P.parseRoster(fx('roster.json'));
    assert.strictEqual(r.week, 1);
    assert.strictEqual(r.team.team_key, '466.l.12345.t.1');
    const [jokic, sga] = r.players;
    assert.deepStrictEqual(jokic.name, { full: 'Nikola Jokic', first: 'Nikola', last: 'Jokic' });
    assert.strictEqual(jokic.editorial_team_abbr, 'DEN');
    assert.deepStrictEqual(jokic.eligible_positions, ['C', 'F', 'Util']);
    assert.strictEqual(jokic.selected_position, 'F');
    assert.strictEqual(sga.selected_position, 'BN');
    assert.strictEqual(sga.status, 'GTD');
    assert.strictEqual(sga.display_position, 'PG,SG');
    assert.strictEqual(P.parsePlayers(fx('players.json')).length, 2);
    assert.deepStrictEqual(P.parsePlayers({ fantasy_content: { league: [{ league_key: 'x' }, { players: [] }] } }), []);
  });

  console.log('client');
  await test('normalized getters through mocked fetch', async () => {
    const tk = memTokens({ access_token: 'A1', refresh_token: 'R1', expires_at: Date.now() + 3600e3 });
    const auths = [];
    const c = createClient({ ...tk, limiter: noWait, fetchImpl: async (url, init) => { auths.push(init.headers.Authorization); return resp(200, yahooFixtureFor(url)); } });
    assert.strictEqual(await c.getGameKey('nba'), '466');
    assert.strictEqual((await c.getUserLeagues('466')).length, 2);
    const lg = await c.getLeague('466.l.12345');
    assert.strictEqual(lg.num_teams, 10);
    assert.strictEqual(lg.roster_positions.length, 4);
    assert.strictEqual(lg.stat_modifiers.length, 5);
    assert.deepStrictEqual(lg.weeks.map(w => w.week), [1, 2, 3]);
    assert.strictEqual(lg.draft_status, 'predraft');
    assert.strictEqual((await c.getDraftResults('466.l.12345')).picks.length, 4);
    assert.strictEqual((await c.getTeams('466.l.12345')).length, 2);
    assert.strictEqual((await c.getRoster('466.l.12345.t.1', 1)).players.length, 2);
    assert.strictEqual((await c.getPlayers('466.l.12345', { status: 'A' })).length, 2);
    assert.ok(auths.every(a => a === 'Bearer A1'));
  });
  await test('401 -> refresh -> saveTokens -> retry with new token', async () => {
    const tk = memTokens({ access_token: 'OLD', refresh_token: 'R1', expires_at: Date.now() + 3600e3, xoauth_yahoo_guid: 'G' });
    const seen = []; let refreshes = 0;
    const c = createClient({
      ...tk, limiter: noWait,
      refresh: async rt => { refreshes++; assert.strictEqual(rt, 'R1'); return { access_token: 'NEW', refresh_token: 'R2', expires_at: Date.now() + 3600e3 }; },
      fetchImpl: async (url, init) => { seen.push(init.headers.Authorization); return init.headers.Authorization === 'Bearer OLD' ? resp(401, { error: { description: 'token_expired' } }) : resp(200, fx('game.json')); },
    });
    assert.strictEqual(await c.getGameKey('nba'), '466');
    assert.deepStrictEqual(seen, ['Bearer OLD', 'Bearer NEW']);
    assert.strictEqual(refreshes, 1);
    assert.strictEqual(tk.peek().access_token, 'NEW');
    assert.strictEqual(tk.peek().refresh_token, 'R2');
    assert.strictEqual(tk.peek().xoauth_yahoo_guid, 'G', 'guid survives refresh');
  });
  await test('persistent 401 after refresh surfaces an error (no loop)', async () => {
    const tk = memTokens({ access_token: 'OLD', refresh_token: 'R1', expires_at: Date.now() + 3600e3 });
    let calls = 0;
    const c = createClient({ ...tk, limiter: noWait, refresh: async () => ({ access_token: 'NEW', refresh_token: 'R2', expires_at: Date.now() + 3600e3 }),
      fetchImpl: async () => { calls++; return resp(401, {}); } });
    await assert.rejects(c.getGameKey('nba'), e => e.status === 401);
    assert.strictEqual(calls, 2);
  });
  await test('expired token refreshes proactively; concurrent calls share one refresh', async () => {
    const tk = memTokens({ access_token: 'OLD', refresh_token: 'R1', expires_at: Date.now() - 1000 });
    let refreshes = 0;
    const c = createClient({ ...tk, limiter: noWait,
      refresh: async () => { refreshes++; await new Promise(r => setTimeout(r, 10)); return { access_token: 'NEW', refresh_token: 'R2', expires_at: Date.now() + 3600e3 }; },
      fetchImpl: async (url, init) => { assert.strictEqual(init.headers.Authorization, 'Bearer NEW'); return resp(200, yahooFixtureFor(url)); } });
    await Promise.all([c.getTeams('466.l.12345'), c.getDraftResults('466.l.12345')]);
    assert.strictEqual(refreshes, 1);
  });
  await test('429/999 backoff honours Retry-After, then succeeds; gives up after maxRetries', async () => {
    const tk = memTokens({ access_token: 'A', refresh_token: 'R', expires_at: Date.now() + 3600e3 });
    const sleeps = []; let n = 0;
    const c = createClient({ ...tk, limiter: noWait, sleep: async ms => { sleeps.push(ms); }, backoffMs: 100,
      fetchImpl: async () => (++n === 1 ? resp(999, {}) : n === 2 ? resp(429, {}, { 'retry-after': '2' }) : resp(200, fx('game.json'))) });
    assert.strictEqual(await c.getGameKey('nba'), '466');
    assert.deepStrictEqual(sleeps, [100, 2000]);
    const c2 = createClient({ ...tk, limiter: noWait, sleep: fastSleep, maxRetries: 2, fetchImpl: async () => resp(503, {}) });
    await assert.rejects(c2.getGameKey('nba'), e => e.status === 503);
  });
  await test('limiter spaces requests', async () => {
    const lim = createLimiter({ minIntervalMs: 30 });
    const t0 = Date.now(); const at = [];
    await Promise.all([1, 2, 3].map(() => lim(async () => at.push(Date.now() - t0))));
    assert.ok(at[2] >= 55, 'third request waited ~60ms, got ' + at[2]);
  });
  await test('not connected -> not_connected error', async () => {
    const c = createClient({ getTokens: async () => null, limiter: noWait, fetchImpl: async () => { throw new Error('should not fetch'); } });
    await assert.rejects(c.getGameKey('nba'), e => e.code === 'not_connected');
  });

  console.log('router (in-process app, fake Clerk auth, mocked Yahoo)');
  const fakeGetAuth = req => ({ userId: req.get('x-test-user') || null });
  const fakeAuth = (req, res, next) => (fakeGetAuth(req).userId ? next() : res.status(401).json({ error: 'Sign in required' }));
  const cache = new Map();
  const apiCached = async (key, ttl, fn) => { const e = cache.get(key); if (e && e.exp > Date.now()) return e.v; const v = await fn(); cache.set(key, { v, exp: Date.now() + ttl }); return v; };
  const store = createTokenStore({ env: ENV });
  let exchangeArgs = null;
  const fakeModel = {
    async getPlayers() { return { season: '2026', week: 1, asOf: '2026-10-13T00:00:00Z', players: [{ id: '1658', name: 'Nikola Jokic', team: 'DEN' }] }; },
    matchYahooPlayer(yp, players) { const p = players.find(x => x.name === yp.name.full); return p ? { player: p, confidence: 0.99, reason: 'name' } : null; },
  };
  const app = express();
  app.use('/', createNbaRouter({
    auth: fakeAuth, getAuth: fakeGetAuth, db: null, apiCached, env: ENV, store,
    loadModel: () => fakeModel,
    makeClient: opts => createClient({ ...opts, limiter: noWait, fetchImpl: async url => resp(200, yahooFixtureFor(url)) }),
    exchangeCode: async args => { exchangeArgs = args; return { ...fx('token.json'), expires_at: Date.now() + 3600e3 }; },
    log: { error() {}, warn() {} },
  }));
  app.get('/', (req, res) => res.send(Object.keys(req.query).length ? 'INDEX:' + JSON.stringify(req.query) : 'HOME'));
  app.use(express.static(ROOT));
  app.get('*', (req, res) => res.status(404).send('CATCHALL'));
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  // fetch() won't send a custom Host header; use http for those checks.
  const locationWithHost = (p, user, host) => new Promise((resolve, reject) => {
    http.get(base + p, { headers: { host, 'x-test-user': user } }, r => { r.resume(); resolve(r.headers.location); }).on('error', reject);
  });
  const get = (p, user, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts, headers: { ...(user ? { 'x-test-user': user } : {}), ...(opts.headers || {}) } });

  try {
    await test('/nfl rewrites to / (no redirect), incl. query-param rule', async () => {
      const a = await get('/nfl'); assert.strictEqual(a.status, 200); assert.strictEqual(await a.text(), 'HOME');
      const b = await get('/nfl?league_id=9'); assert.strictEqual(await b.text(), 'INDEX:{"league_id":"9"}');
      const c = await get('/nfl/'); assert.strictEqual(await c.text(), 'HOME');
    });
    await test('/nba, /nba/draft, /nba/lineup serve a page (coming-soon fallback, never 500)', async () => {
      for (const p of ['/nba', '/nba/draft', '/nba/lineup']) {
        const r = await get(p); assert.strictEqual(r.status, 200, p);
        assert.match(r.headers.get('content-type'), /text\/html/);
        assert.match(await r.text(), /rr-nav/);
      }
    });
    await test('deny list: server-side nba files 404; nba/pages assets allowed', async () => {
      for (const p of ['/nba/router.js', '/nba/yahoo/client.js', '/nba/yahoo/crypto.js', '/nba/model/index.js', '/nba/model/', '/nba/yahoo', '/NBA/Router.js']) {
        assert.strictEqual((await get(p)).status, 404, p);
      }
      assert.notStrictEqual((await get('/nba/router.js')).status, 200);
    });
    await test('/api/nba/health', async () => {
      const r = await get('/api/nba/health');
      assert.deepStrictEqual(await r.json(), { ok: true, yahooConfigured: true, modelAsOf: null });
    });
    await test('/api/nba/players proxies model; bad week 400', async () => {
      const j = await (await get('/api/nba/players?week=1')).json();
      assert.strictEqual(j.players[0].id, '1658');
      assert.strictEqual((await get('/api/nba/players?week=abc')).status, 400);
      assert.strictEqual((await (await get('/api/nba/health')).json()).modelAsOf, '2026-10-13T00:00:00Z');
    });
    await test('yahoo endpoints require Clerk auth', async () => {
      for (const p of ['/api/nba/yahoo/status', '/api/nba/yahoo/league?league_key=466.l.12345', '/api/nba/yahoo/draft?league_key=466.l.12345', '/api/nba/yahoo/roster?team_key=466.l.12345.t.1']) {
        assert.strictEqual((await get(p)).status, 401, p);
      }
    });
    await test('login: signed-out -> /nba?yahoo=signin; signed-in -> 302 Yahoo with state', async () => {
      const a = await get('/nba/auth/login');
      assert.strictEqual(a.status, 302); assert.strictEqual(a.headers.get('location'), '/nba?yahoo=signin');
      const b = await get('/nba/auth/login', 'user_A');
      assert.strictEqual(b.status, 302);
      const u = new URL(b.headers.get('location'));
      assert.strictEqual(u.host, 'api.login.yahoo.com');
      assert.strictEqual(u.searchParams.get('redirect_uri'), base + '/nba/auth/callback', 'local dev origin');
      const l = await locationWithHost('/nba/auth/login', 'user_A', 'localhost:7991');
      assert.strictEqual(new URL(l).searchParams.get('redirect_uri'), 'http://localhost:7991/nba/auth/callback');
      const c = await locationWithHost('/nba/auth/login', 'user_A', 'evil.example');
      assert.strictEqual(new URL(c).searchParams.get('redirect_uri'), 'https://pocketff.com/nba/auth/callback', 'untrusted Host falls back to prod origin');
    });
    let state;
    await test('callback: state for other user rejected; valid once; replay rejected', async () => {
      const b = await get('/nba/auth/login', 'user_A');
      state = new URL(b.headers.get('location')).searchParams.get('state');
      const evil = await get(`/nba/auth/callback?code=C&state=${encodeURIComponent(state)}`, 'user_B');
      assert.strictEqual(evil.status, 400);
      const good = await get(`/nba/auth/callback?code=CODE1&state=${encodeURIComponent(state)}`, 'user_A');
      assert.strictEqual(good.status, 302); assert.strictEqual(good.headers.get('location'), '/nba?yahoo=connected');
      assert.strictEqual(exchangeArgs.code, 'CODE1');
      assert.strictEqual(exchangeArgs.redirectUri, base + '/nba/auth/callback', 'same redirect_uri as login');
      const replay = await get(`/nba/auth/callback?code=CODE1&state=${encodeURIComponent(state)}`, 'user_A');
      assert.strictEqual(replay.status, 400);
      const denied = await get('/nba/auth/callback?error=access_denied&state=x', 'user_A');
      assert.strictEqual(denied.headers.get('location'), '/nba?yahoo=denied');
    });
    await test('status: connected with leagues, never leaks tokens', async () => {
      const r = await get('/api/nba/yahoo/status', 'user_A');
      const txt = await r.text();
      assert.ok(!/FAKE_ACCESS_TOKEN|FAKE_REFRESH_TOKEN/.test(txt));
      const j = JSON.parse(txt);
      assert.strictEqual(j.connected, true); assert.strictEqual(j.yahooGuid, 'FAKEGUID123');
      assert.deepStrictEqual(j.leagues[0], { league_key: '466.l.12345', name: 'Pocket High Score', num_teams: 10, draft_status: 'predraft' });
      assert.deepStrictEqual(await (await get('/api/nba/yahoo/status', 'user_C')).json(), { connected: false });
    });
    await test('league: settings + teams + myTeamKey', async () => {
      const j = await (await get('/api/nba/yahoo/league?league_key=466.l.12345', 'user_A')).json();
      assert.strictEqual(j.myTeamKey, '466.l.12345.t.1');
      assert.strictEqual(j.league.roster_positions.length, 4);
      assert.strictEqual(j.teams.length, 2);
      assert.strictEqual((await get('/api/nba/yahoo/league?league_key=bad', 'user_A')).status, 400);
      assert.strictEqual((await get('/api/nba/yahoo/league?league_key=466.l.12345', 'user_C')).status, 409, 'not connected');
    });
    await test('draft: status mapping, picks matched to Sleeper ids, unmatched listed', async () => {
      const j = await (await get('/api/nba/yahoo/draft?league_key=466.l.12345', 'user_A')).json();
      assert.strictEqual(j.status, 'drafting');
      assert.strictEqual(j.picks.length, 2);
      assert.deepStrictEqual(j.picks[0], { pick: 1, round: 1, team_key: '466.l.12345.t.3', player_key: '466.p.5352', sleeperId: '1658', name: 'Nikola Jokic', matchConfidence: 0.99 });
      assert.deepStrictEqual(j.unmatched, [{ pick: 2, player_key: '466.p.6014', name: 'Shai Gilgeous-Alexander' }]);
      assert.ok(!Number.isNaN(Date.parse(j.polledAt)));
    });
    await test('roster: players with selected_position + sleeperId', async () => {
      const j = await (await get('/api/nba/yahoo/roster?team_key=466.l.12345.t.1&week=1', 'user_A')).json();
      assert.deepStrictEqual(j.players[0], { player_key: '466.p.5352', sleeperId: '1658', name: 'Nikola Jokic', selected_position: 'F' });
      assert.strictEqual(j.players[1].sleeperId, null);
      assert.strictEqual((await get('/api/nba/yahoo/roster?team_key=466.l.12345', 'user_A')).status, 400);
    });
    await test('logout removes tokens', async () => {
      const r = await get('/nba/auth/logout', 'user_A');
      assert.strictEqual(r.headers.get('location'), '/nba?yahoo=disconnected');
      assert.deepStrictEqual(await (await get('/api/nba/yahoo/status', 'user_A')).json(), { connected: false });
    });
    await test('default model loader never throws (stub when nba/model absent)', () => {
      const m = createNbaRouter.MODEL_STUB;
      assert.strictEqual(m.matchYahooPlayer({}, []), null);
      const r = createNbaRouter({ auth: fakeAuth, getAuth: fakeGetAuth, apiCached, env: ENV });
      assert.strictEqual(typeof r, 'function');
    });
  } finally { srv.close(); }

  console.log('server.js integration (spawned real server)');
  await test('server.js: / and /nfl identical, /nba, health, deny list, sitemap', async () => {
    const env = { ...process.env, ...ENV, DATABASE_URL: '' };
    const envFile = path.join(ROOT, '.env.local');
    if (!env.CLERK_PUBLISHABLE_KEY && fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^(CLERK_[A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2];
      }
    }
    if (!env.CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) { console.log('       (skipped: no Clerk keys for clerkMiddleware)'); return; }
    const port = await freePort();
    env.PORT = String(port);
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    try {
      const sbase = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100 && !/running on port/.test(out); i++) await new Promise(r => setTimeout(r, 100));
      assert.match(out, /running on port/, 'server did not start:\n' + out);
      const body = async p => { const r = await fetch(sbase + p, { redirect: 'manual' }); return [r.status, await r.text()]; };
      const [s1, home] = await body('/');
      const [s2, nfl] = await body('/nfl');
      assert.strictEqual(s1, 200); assert.strictEqual(s2, 200);
      assert.strictEqual(nfl, home, '/nfl body === / body');
      const [, homeQ] = await body('/?companion=1');
      const [, nflQ] = await body('/nfl?companion=1');
      assert.strictEqual(nflQ, homeQ, 'query-param rule identical');
      assert.notStrictEqual(homeQ, home, 'query param switches to index.html');
      assert.strictEqual((await body('/nba'))[0], 200);
      const [hs, health] = await body('/api/nba/health');
      assert.strictEqual(hs, 200); assert.strictEqual(JSON.parse(health).ok, true);
      for (const p of ['/nba/router.js', '/nba/yahoo/client.js', '/nba/yahoo/oauth.js', '/server.js', '/scripts/fixtures/nba/token.json']) {
        assert.strictEqual((await body(p))[0], 404, p);
      }
      assert.match((await body('/sitemap.xml'))[1], /<loc>https:\/\/pocketff\.com\/nba<\/loc>/);
      assert.strictEqual((await body('/api/nba/yahoo/status'))[0], 401);
    } finally { child.kill('SIGKILL'); }
  });

  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
})().catch(e => { console.error(e); process.exit(1); });
