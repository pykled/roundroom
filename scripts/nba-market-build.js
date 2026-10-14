#!/usr/bin/env node
// Pocket NBA — build data/nba/market.json (Yahoo-first market consensus). docs/nba-market-blend.md.
//   node scripts/nba-market-build.js [--no-cache] [--offline] [--fantasypros] [--fantasypros-csv file.csv] [--out path]
// --offline        skip network, use whatever adp.json / cache exists (Yahoo snapshot is always local)
// --fantasypros    opt-in single polite request to fantasypros.com/nba/adp/overall.php (default OFF, see docs: ToS)
// --fantasypros-csv  manual import of a CSV Dillon exports/pastes himself (header: Player,Team,Yahoo[,ESPN,AVG]); no network
// Always exits 0 (failed sources are skipped and reported).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'data', 'nba', 'yahoo-snapshot-242808.json');
const OUT = path.join(ROOT, 'data', 'nba', 'market.json');

function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',' || ch === '\t') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// CSV/TSV → flat ADP rows (source 'fantasypros-yahoo'). Needs a Player column and a Yahoo (or ADP) column; Team optional.
// Player cell may be "Nikola Jokic" or "Nikola Jokic DEN-C" / "Nikola Jokic (DEN - C)" (team/pos suffix is peeled off).
function parseFantasyProsCsv(text, asOf = new Date().toISOString()) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const head = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const col = names => head.findIndex(h => names.includes(h));
  const iName = col(['player', 'name', 'player name']);
  const iTeam = col(['team']);
  let iAdp = col(['yahoo', 'yahoo adp']);
  if (iAdp < 0) iAdp = col(['adp', 'avg']);
  if (iName < 0 || iAdp < 0) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    let name = c[iName] || '', team = iTeam >= 0 ? c[iTeam] : null;
    const m = name.match(/^(.*?)\s*\(?\b([A-Z]{2,3})\s*-\s*([A-Z,\/]+)\)?\s*$/);
    if (m) { name = m[1]; team = team || m[2]; }
    const adp = parseFloat(c[iAdp]);
    if (!name || !(adp > 0)) continue;
    out.push({ name, team: team || null, pos: [], adp, source: 'fantasypros-yahoo', asOf });
  }
  return out;
}

async function main(argv) {
  const { buildMarket } = require('../nba/model/market');
  const arg = f => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
  const out = arg('--out') ? path.resolve(arg('--out')) : OUT;
  const offline = argv.includes('--offline');
  const useFp = argv.includes('--fantasypros') || process.env.ADP_FANTASYPROS === '1';
  const csv = arg('--fantasypros-csv');
  const status = {};

  let adp = [];
  if (!offline) {
    try {
      const F = require('./nba-adp-fetch');
      const r = await F.fetchAll({ sources: ['espn', 'sleeper'].concat(useFp ? ['fantasypros'] : []), useCache: !argv.includes('--no-cache'), log: m => console.error(m) });
      adp = r.rows; Object.assign(status, r.status);
    } catch (e) { console.error('adp fetch failed:', e.message); }
  } else {
    try { adp = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'nba', 'adp.json'), 'utf8')); status.offline = { rows: adp.length }; } catch (_) { status.offline = { rows: 0 }; }
  }
  if (csv) {
    try { const rows = parseFantasyProsCsv(fs.readFileSync(path.resolve(csv), 'utf8')); adp = adp.filter(r => r.source !== 'fantasypros-yahoo').concat(rows); status.fantasypros_csv = { ok: rows.length > 0, rows: rows.length }; }
    catch (e) { status.fantasypros_csv = { ok: false, error: e.message }; console.error('csv failed:', e.message); }
  }

  let snapshot = null;
  try { snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')); } catch (e) { console.error('yahoo snapshot unreadable:', e.message); }
  let players = [];
  try { players = (await require('../nba/model').getPlayers()).players; } catch (e) { console.error('model getPlayers failed:', e.message); }

  const m = buildMarket({ players, yahooSnapshot: snapshot, adpSources: adp });
  const doc = { builtAt: new Date().toISOString(), fetchStatus: status, asOf: m.asOf, weights: m.weights, params: m.params, stats: m.stats,
    validation: m.validation, unmatched: m.unmatched, rows: m.rows.filter(r => r.marketRank != null) };
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(doc)); } catch (e) { console.error('write failed:', e.message); }
  console.error(`market: ${doc.rows.length}/${players.length} players with market data; sources ${JSON.stringify(Object.fromEntries(Object.entries(m.stats.sources).map(([k, v]) => [k, `${v.matched}/${v.total} (${v.rate}%)`])))}`);
  console.error(`validation: ${JSON.stringify(m.validation)} -> ${out}`);
}

module.exports = { parseFantasyProsCsv, splitCsvLine };
if (require.main === module) main(process.argv.slice(2)).then(() => process.exit(0), e => { console.error(e); process.exit(0); });
