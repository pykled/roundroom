// Single-use OAuth state nonces, persisted so a login survives a restart or
// lands on another instance. Table nba_oauth_nonces (db/migrate.js; also
// created here on first use in case migrations haven't run):
//   nonce TEXT PK, clerk_user_id TEXT, expires_at TIMESTAMPTZ
// consume() is one atomic DELETE … RETURNING, so two concurrent callbacks with
// the same state can't both win. Expired rows are swept at most once a minute
// on issue(). Without a DB it falls back to crypto.createNonceRegistry (memory).
const crypto = require('crypto');
const { createNonceRegistry, STATE_TTL_MS } = require('./crypto');

const SWEEP_EVERY_MS = 60 * 1000;

function createNonceStore({ db = null, ttlMs = STATE_TTL_MS } = {}) {
  if (!db) {
    const mem = createNonceRegistry({ ttlMs });
    return {
      persistent: false,
      async issue(userId, now = Date.now()) { return mem.issue(userId, now); },
      async consume(nonce, userId, now = Date.now()) { return mem.consume(nonce, userId, now); },
    };
  }

  let ready = null;
  let lastSweep = 0;
  function ensure() {
    if (!ready) {
      ready = db.query(`CREATE TABLE IF NOT EXISTS nba_oauth_nonces (
          nonce TEXT PRIMARY KEY,
          clerk_user_id TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL
        )`).catch(e => { ready = null; throw e; });
    }
    return ready;
  }

  return {
    persistent: true,
    async issue(userId, now = Date.now()) {
      await ensure();
      if (now - lastSweep > SWEEP_EVERY_MS) {
        lastSweep = now;
        await db.query('DELETE FROM nba_oauth_nonces WHERE expires_at < $1', [new Date(now)]);
      }
      const nonce = crypto.randomBytes(16).toString('hex');
      await db.query('INSERT INTO nba_oauth_nonces (nonce, clerk_user_id, expires_at) VALUES ($1, $2, $3)',
        [nonce, userId, new Date(now + ttlMs)]);
      return nonce;
    },
    // Burned on first use even when the user doesn't match (same as memory).
    async consume(nonce, userId, now = Date.now()) {
      if (typeof nonce !== 'string' || !nonce) return false;
      await ensure();
      const r = await db.query('DELETE FROM nba_oauth_nonces WHERE nonce = $1 RETURNING clerk_user_id, expires_at', [nonce]);
      const row = r.rows[0];
      if (!row) return false;
      return new Date(row.expires_at).getTime() > now && row.clerk_user_id === userId;
    },
  };
}

module.exports = { createNonceStore };
