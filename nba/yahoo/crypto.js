// Pocket NBA — OAuth state signing + token encryption at rest.
//
// State: base64url(JSON{u,n,t}) + '.' + HMAC-SHA256. u = Clerk user id, n =
// random nonce, t = issue time. verifyState() checks the signature, age and
// that it belongs to the signed-in user; single-use is enforced by the nonce
// registry (createNonceRegistry) the router keeps.
//
// Tokens: AES-256-GCM, key derived (HKDF) from NBA_TOKEN_KEY, falling back to
// YAHOO_CLIENT_SECRET. Output = 'v1.' + base64url(iv | tag | ciphertext).
const crypto = require('crypto');

const STATE_TTL_MS = 10 * 60 * 1000;

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

function rootSecret(env = process.env) {
  const s = env.NBA_TOKEN_KEY || env.YAHOO_CLIENT_SECRET;
  if (!s) throw new Error('NBA_TOKEN_KEY or YAHOO_CLIENT_SECRET required');
  return s;
}

function deriveKey(purpose, env = process.env) {
  return Buffer.from(crypto.hkdfSync('sha256', rootSecret(env), 'pocket-nba', purpose, 32));
}

function signState({ userId, nonce, now = Date.now() }, env = process.env) {
  if (!userId) throw new Error('userId required');
  const body = b64u(JSON.stringify({ u: userId, n: nonce || crypto.randomBytes(16).toString('hex'), t: now }));
  const sig = b64u(crypto.createHmac('sha256', deriveKey('oauth-state', env)).update(body).digest());
  return body + '.' + sig;
}

// Returns { ok:true, userId, nonce } or { ok:false, reason }.
function verifyState(state, { userId, now = Date.now(), ttlMs = STATE_TTL_MS } = {}, env = process.env) {
  if (typeof state !== 'string' || !state.includes('.')) return { ok: false, reason: 'malformed' };
  const [body, sig] = state.split('.');
  const expect = crypto.createHmac('sha256', deriveKey('oauth-state', env)).update(body).digest();
  let got;
  try { got = Buffer.from(sig, 'base64url'); } catch { return { ok: false, reason: 'malformed' }; }
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return { ok: false, reason: 'bad_signature' };
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (!p || !p.u || !p.n || !Number.isFinite(p.t)) return { ok: false, reason: 'malformed' };
  if (now - p.t > ttlMs || p.t - now > 60 * 1000) return { ok: false, reason: 'expired' };
  if (userId && p.u !== userId) return { ok: false, reason: 'user_mismatch' };
  return { ok: true, userId: p.u, nonce: p.n };
}

// In-memory single-use registry: issue() remembers a nonce, consume() succeeds
// once per nonce and only before expiry. Single Railway instance, so memory is
// enough; a restart just invalidates in-flight logins (user retries).
function createNonceRegistry({ ttlMs = STATE_TTL_MS, max = 5000 } = {}) {
  const live = new Map(); // nonce -> { userId, expires }
  function sweep(now) {
    for (const [n, v] of live) if (v.expires <= now) live.delete(n);
    while (live.size > max) live.delete(live.keys().next().value);
  }
  return {
    issue(userId, now = Date.now()) {
      sweep(now);
      const nonce = crypto.randomBytes(16).toString('hex');
      live.set(nonce, { userId, expires: now + ttlMs });
      return nonce;
    },
    consume(nonce, userId, now = Date.now()) {
      const v = live.get(nonce);
      if (!v) return false;
      live.delete(nonce);
      return v.expires > now && v.userId === userId;
    },
    size() { return live.size; },
  };
}

function encryptTokens(obj, env = process.env) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey('token-enc', env), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'v1.' + b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
}

function decryptTokens(str, env = process.env) {
  if (typeof str !== 'string' || !str.startsWith('v1.')) throw new Error('bad token blob');
  const raw = Buffer.from(str.slice(3), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey('token-enc', env), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}

module.exports = { signState, verifyState, createNonceRegistry, encryptTokens, decryptTokens, STATE_TTL_MS };
