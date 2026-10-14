// Yahoo token store, keyed by Clerk user id. Rows hold only the encrypted blob
// (see crypto.js) — plaintext tokens never touch the DB, the browser or logs.
// Without a DB (local dev) it falls back to process memory.
const { encryptTokens, decryptTokens } = require('./crypto');

function createTokenStore({ db, env = process.env, log = console } = {}) {
  const mem = new Map(); // clerkUserId -> { guid, blob }
  let warnedDecrypt = false;

  async function get(clerkUserId) {
    let row = null;
    if (db) {
      const r = await db.query('SELECT yahoo_guid, token_blob FROM nba_yahoo_tokens WHERE clerk_user_id = $1', [clerkUserId]);
      row = r.rows[0] ? { guid: r.rows[0].yahoo_guid, blob: r.rows[0].token_blob } : null;
    } else {
      row = mem.get(clerkUserId) || null;
    }
    if (!row) return null;
    // Key rotated / corrupt → treat as disconnected, but keep the row (a key
    // restored later makes it readable again; a reconnect overwrites it).
    try { return decryptTokens(row.blob, env); } catch {
      if (!warnedDecrypt) { warnedDecrypt = true; log.warn('[nba] token blob could not be decrypted (NBA_TOKEN_KEY / YAHOO_CLIENT_SECRET changed?)'); }
      return null;
    }
  }

  async function save(clerkUserId, tokens) {
    const blob = encryptTokens(tokens, env);
    const guid = tokens.xoauth_yahoo_guid || null;
    if (db) {
      await db.query(
        `INSERT INTO nba_yahoo_tokens (clerk_user_id, yahoo_guid, token_blob, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (clerk_user_id) DO UPDATE
           SET yahoo_guid = COALESCE(EXCLUDED.yahoo_guid, nba_yahoo_tokens.yahoo_guid),
               token_blob = EXCLUDED.token_blob, updated_at = NOW()`,
        [clerkUserId, guid, blob]
      );
    } else {
      const prev = mem.get(clerkUserId);
      mem.set(clerkUserId, { guid: guid || (prev && prev.guid) || null, blob });
    }
  }

  async function remove(clerkUserId) {
    if (db) await db.query('DELETE FROM nba_yahoo_tokens WHERE clerk_user_id = $1', [clerkUserId]);
    else mem.delete(clerkUserId);
  }

  return { get, save, remove };
}

module.exports = { createTokenStore };
