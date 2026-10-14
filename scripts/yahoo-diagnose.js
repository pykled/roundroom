#!/usr/bin/env node
// Print the Yahoo read-path diagnose report (same as GET /api/nba/yahoo/diagnose)
// for one stored token entry. Never prints tokens or GUIDs.
//
//   node --env-file=.env.local scripts/yahoo-diagnose.js --list
//       Clerk user ids that have a stored Yahoo connection (DATABASE_URL).
//   node --env-file=.env.local scripts/yahoo-diagnose.js --user user_abc [--json]
//       Decrypts that user's token row (NBA_TOKEN_KEY / YAHOO_CLIENT_SECRET),
//       runs the report; a refreshed access token is saved back to the row.
//   node --env-file=.env.local scripts/yahoo-diagnose.js --blob-file path [--json]
//       Same, from a token_blob ("v1.…") copied into a file. Refreshed tokens
//       are NOT saved anywhere.
//   node scripts/yahoo-diagnose.js --fixtures [--json]
//       Offline demo against scripts/fixtures/nba (no Yahoo, no DB).
const fs = require('fs');
const path = require('path');
const { createClient, createLimiter } = require('../nba/yahoo/client');
const { createTokenStore } = require('../nba/yahoo/store');
const { decryptTokens } = require('../nba/yahoo/crypto');
const { runDiagnose, formatReport } = require('../nba/yahoo/diagnose');

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: yahoo-diagnose.js --list | --user <clerk_user_id> | --blob-file <path> | --fixtures   [--json]');
  process.exit(2);
}

// Offline: route Yahoo API paths to the recorded-shape fixtures.
function fixtureFetch() {
  const dir = path.join(__dirname, 'fixtures', 'nba');
  const map = [
    [/^game\/nba$/, 'game.json'], [/^users;use_login=1\/games;game_keys=\d+\/leagues$/, 'user-leagues.json'],
    [/^league\/[^/]+\/settings$/, 'league-settings.json'], [/^game\/\d+\/game_weeks$/, 'game-weeks.json'],
    [/^league\/[^/]+\/draftresults$/, 'draftresults.json'], [/^league\/[^/]+\/teams$/, 'teams.json'],
    [/^team\/[^/]+\/roster/, 'roster.json'], [/^league\/[^/]+\/players;/, 'players.json'],
  ];
  return async url => {
    const p = decodeURIComponent(new URL(url).pathname.replace('/fantasy/v2/', ''));
    const hit = map.find(([re]) => re.test(p));
    const body = hit ? fs.readFileSync(path.join(dir, hit[1]), 'utf8') : '{"error":{"description":"not in fixtures"}}';
    return { status: hit ? 200 : 404, ok: !!hit, headers: { get: () => null }, text: async () => body };
  };
}

async function main() {
  const json = flag('--json');
  let getTokens, saveTokens = null, fetchImpl, done = async () => {};

  if (flag('--fixtures')) {
    let t = { access_token: 'fixture', refresh_token: 'fixture', expires_at: Date.now() + 3600e3 };
    getTokens = async () => t; saveTokens = async n => { t = n; };
    fetchImpl = fixtureFetch();
  } else if (flag('--list') || opt('--user')) {
    const { pool } = require('../db/migrate');
    if (!pool) usage('DATABASE_URL is not set (run with --env-file=.env.local, or use --blob-file).');
    done = () => pool.end();
    if (flag('--list')) {
      const r = await pool.query('SELECT clerk_user_id, updated_at FROM nba_yahoo_tokens ORDER BY updated_at DESC');
      for (const row of r.rows) console.log(`${row.clerk_user_id}\tupdated ${new Date(row.updated_at).toISOString()}`);
      if (!r.rows.length) console.log('(no stored Yahoo connections)');
      return done();
    }
    const store = createTokenStore({ db: pool });
    const uid = opt('--user');
    getTokens = () => store.get(uid);
    saveTokens = t => store.save(uid, t);
    if (!(await getTokens())) { await done(); usage(`No readable token row for ${uid} (not connected, or the key changed).`); }
  } else if (opt('--blob-file')) {
    let t;
    try { t = decryptTokens(fs.readFileSync(opt('--blob-file'), 'utf8').trim()); } catch (e) { usage('Could not decrypt the blob: ' + e.message); }
    getTokens = async () => t;
    saveTokens = async n => { t = n; console.error('(note: access token refreshed in memory only; the stored blob is unchanged)'); };
  } else usage();

  const warnings = [];
  const client = createClient({ getTokens, saveTokens, onWarning: w => warnings.push(w), ...(fetchImpl ? { fetchImpl, limiter: createLimiter({ minIntervalMs: 0 }) } : {}) });
  const report = await runDiagnose({ client, warnings });
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  await done();
  process.exitCode = report.ok ? 0 : 1;
}

main().catch(e => { console.error('yahoo-diagnose failed:', e.message); process.exit(1); });
