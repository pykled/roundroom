const { Pool } = require('pg');

// Railway Postgres requires SSL; set DATABASE_SSL=false for a local dev database.
const ssl = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl })
  : null;

async function migrate() {
  if (!pool) { console.log('No DATABASE_URL — skipping migrations'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      clerk_user_id TEXT UNIQUE NOT NULL,
      sleeper_username TEXT,
      sleeper_user_id TEXT,
      primary_league_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_leagues (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      league_id TEXT NOT NULL,
      league_name TEXT,
      season TEXT DEFAULT '2026',
      is_primary BOOLEAN DEFAULT FALSE,
      UNIQUE(user_id, league_id)
    );
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      share_token TEXT UNIQUE NOT NULL,
      payload_json JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB migrations applied');
}

module.exports = { pool, migrate };
