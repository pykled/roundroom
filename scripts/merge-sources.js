#!/usr/bin/env node
/**
 * merge-sources.js — blend Sleeper / FantasyPros / Underdog into a composite ADP.
 *
 * Inputs (any may be missing/empty; we use whatever is present):
 *   data/adp.json              — Sleeper empirical ADP (headline = weighted_adp)
 *   data/fantasypros_adp.json  — FantasyPros consensus ECR/ADP
 *   data/underdog_adp.json     — Underdog best-ball ADP (K/DST already dropped)
 *
 * Weights adapt to Sleeper sample health:
 *   Sleeper >= 20 quality drafts: Sleeper 0.50, FantasyPros 0.35, Underdog 0.15
 *   Sleeper <  20 quality drafts: Sleeper 0.20, FantasyPros 0.55, Underdog 0.25
 *   (thin crawl sample => empirical ADP is noisy, lean on consensus sources)
 * When a player is missing from a source, its weight is dropped and the
 * remaining weights are renormalized to sum to 1.0.
 *
 * Matching: fuzzy by normalized name (lowercase, strip periods/apostrophes,
 * collapse whitespace, drop common suffixes like Jr/Sr/II/III). Position is
 * used only to disambiguate identical names.
 *
 * Output:
 *   data/composite_adp.json — players sorted by composite_adp ascending.
 *
 * Node built-ins only.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Sleeper sample size below which its empirical ADP is too noisy to lead the
// composite — lean on FantasyPros/Underdog consensus instead.
const HEALTHY_SLEEPER_DRAFTS = 20;
const WEIGHTS_HEALTHY = { sleeper: 0.50, fantasypros: 0.35, underdog: 0.15 };
const WEIGHTS_THIN = { sleeper: 0.20, fantasypros: 0.55, underdog: 0.25 };

function loadJson(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`  ! could not parse ${file}: ${err.message}`);
    return null;
  }
}

// Normalize a name for fuzzy matching across sources.
function normName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.'’]/g, '')            // periods + apostrophes
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '') // generational suffixes
    .replace(/[^a-z0-9\s-]/g, ' ')    // any other punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

function main() {
  const sleeper = loadJson('adp.json');
  const fp = loadJson('fantasypros_adp.json');
  const ud = loadJson('underdog_adp.json');

  if (!sleeper || !Array.isArray(sleeper.players)) {
    console.error('data/adp.json missing or malformed — run aggregate.js first. Aborting.');
    process.exit(1);
  }

  const sleeperDrafts = Number(sleeper.total_drafts || 0);
  const WEIGHTS = sleeperDrafts >= HEALTHY_SLEEPER_DRAFTS ? WEIGHTS_HEALTHY : WEIGHTS_THIN;
  console.log(
    `Sleeper sample: ${sleeperDrafts} quality drafts (` +
    `${sleeperDrafts >= HEALTHY_SLEEPER_DRAFTS ? 'healthy' : 'thin'}) — ` +
    `weights sl=${WEIGHTS.sleeper} fp=${WEIGHTS.fantasypros} ud=${WEIGHTS.underdog}`
  );

  // Build a merged map keyed by normalized name. Value collects each source's adp.
  const map = new Map();

  const upsert = (key, base) => {
    if (!map.has(key)) {
      map.set(key, {
        name: base.name,
        position: base.position || null,
        team: base.team || null,
        sleeper_adp: null,
        fantasypros_adp: null,
        underdog_adp: null,
      });
    }
    const rec = map.get(key);
    // Prefer a non-null position/team if we didn't have one yet.
    if (!rec.position && base.position) rec.position = base.position;
    if (!rec.team && base.team) rec.team = base.team;
    return rec;
  };

  // Sleeper — headline number is weighted_adp; fall back to adp.
  for (const p of sleeper.players) {
    const key = normName(p.name);
    if (!key) continue;
    const rec = upsert(key, { name: p.name, position: p.position, team: p.team });
    rec.sleeper_adp = p.weighted_adp != null ? p.weighted_adp : (p.adp != null ? p.adp : null);
    // Sleeper name is canonical (real draft data) — prefer it for display.
    rec.name = p.name;
  }

  // FantasyPros
  if (fp && Array.isArray(fp.players)) {
    for (const p of fp.players) {
      const key = normName(p.name);
      if (!key) continue;
      const rec = upsert(key, { name: p.name, position: p.position, team: p.team });
      rec.fantasypros_adp = p.adp != null ? p.adp : null;
    }
  }

  // Underdog
  if (ud && Array.isArray(ud.players)) {
    for (const p of ud.players) {
      const key = normName(p.name);
      if (!key) continue;
      const rec = upsert(key, { name: p.name, position: p.position, team: p.team });
      rec.underdog_adp = p.adp != null ? p.adp : null;
    }
  }

  const players = [];
  for (const rec of map.values()) {
    const parts = [];
    if (rec.sleeper_adp != null) parts.push(['sleeper', rec.sleeper_adp]);
    if (rec.fantasypros_adp != null) parts.push(['fantasypros', rec.fantasypros_adp]);
    if (rec.underdog_adp != null) parts.push(['underdog', rec.underdog_adp]);
    if (parts.length === 0) continue;

    // Renormalize the present weights to sum to 1.0.
    const wSum = parts.reduce((a, [src]) => a + WEIGHTS[src], 0);
    const composite = parts.reduce((a, [src, adp]) => a + (WEIGHTS[src] / wSum) * adp, 0);

    players.push({
      name: rec.name,
      position: rec.position,
      team: rec.team,
      composite_adp: Math.round(composite * 100) / 100,
      sleeper_adp: rec.sleeper_adp,
      fantasypros_adp: rec.fantasypros_adp,
      underdog_adp: rec.underdog_adp,
      sources_count: parts.length,
    });
  }

  players.sort((a, b) => a.composite_adp - b.composite_adp);

  const out = {
    generated_at: new Date().toISOString(),
    weights: WEIGHTS,
    sources: {
      sleeper_drafts: sleeper.total_drafts || 0,
      fantasypros: !!(fp && Array.isArray(fp.players) && fp.players.length),
      underdog: !!(ud && Array.isArray(ud.players) && ud.players.length),
    },
    players,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'composite_adp.json'), JSON.stringify(out, null, 2));

  // Coverage report.
  const bySources = { 1: 0, 2: 0, 3: 0 };
  players.forEach((p) => { bySources[p.sources_count] = (bySources[p.sources_count] || 0) + 1; });
  console.log(`Wrote composite_adp.json: ${players.length} players.`);
  console.log(
    `  sources present: sleeper=${out.sources.sleeper_drafts} drafts, ` +
    `fantasypros=${out.sources.fantasypros}, underdog=${out.sources.underdog}`
  );
  console.log(`  players by source count: 3-src=${bySources[3]}, 2-src=${bySources[2]}, 1-src=${bySources[1]}`);
  console.log('  Top 5 by composite ADP:');
  players.slice(0, 5).forEach((p, i) =>
    console.log(
      `    ${i + 1}. ${p.name} (${p.position}) comp=${p.composite_adp} ` +
      `[sl=${p.sleeper_adp} fp=${p.fantasypros_adp} ud=${p.underdog_adp}] n=${p.sources_count}`
    )
  );
}

main();
