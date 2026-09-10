#!/usr/bin/env node
// Node harness for shared/analysis.js against a live league.
//
//   node scripts/analyze-league.js [leagueId] [--base=https://pocketff.com]
//
// Pulls the same five payloads the Trade/Team pages use, builds blended VORP
// exactly like the browser (computeVORP → rescaleVORP → blendWithMarket), runs
// AnalysisEngine.analyzeLeague, and prints one row per team with the
// positional tier at QB/RB/WR/TE. Exits non-zero if a tier is missing or the
// engine throws, so it doubles as a smoke test before pushing.
'use strict';

const Scoring = require('../shared/scoring.js');
const Analysis = require('../shared/analysis.js');

const args = process.argv.slice(2);
const leagueId = args.find(a => /^\d+$/.test(a)) || '1399457768158547968';
const baseArg = args.find(a => a.startsWith('--base='));
const BASE = baseArg ? baseArg.slice(7).replace(/\/$/, '') : 'https://pocketff.com';
const VERBOSE = args.includes('-v') || args.includes('--verbose');

async function getJSON(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

function pad(s, n, right) {
  s = String(s == null ? '' : s);
  if (s.length >= n) return s.slice(0, n);
  return right ? ' '.repeat(n - s.length) + s : s + ' '.repeat(n - s.length);
}

(async () => {
  const league = await getJSON(`/api/league/${leagueId}`);
  const sc = league.scoring_settings || {};
  const ppr = sc.rec != null && parseFloat(sc.rec) >= 0.9 ? 1 : 0;
  const sf = (league.roster_positions || []).includes('SUPER_FLEX') ? 1 : 0;
  const [players, proj, injuriesRes, market] = await Promise.all([
    getJSON('/api/players/slim'),
    getJSON('/api/projections/season'),
    getJSON('/api/injuries').catch(() => ({ players: {} })),
    getJSON(`/api/market-values?ppr=${ppr}&sf=${sf}`).catch(() => ({})),
  ]);
  const injuries = injuriesRes && injuriesRes.players ? injuriesRes.players : {};

  const teams = league.total_rosters || (league.rosters || []).length;
  const pool = Object.keys(players).map(id => ({ player_id: id, position: players[id][1] }));
  const raw = Scoring.computeVORP(pool, proj, sc, league.roster_positions || [], teams);
  const vorp = Scoring.blendWithMarket(Scoring.rescaleVORP(raw), market || {});

  const out = Analysis.analyzeLeague(league, players, proj, vorp, injuries);
  const POS = Analysis.NEED_POSITIONS;

  console.log(`${league.name || leagueId} · ${out.teams.length} teams · ${ppr ? 'PPR' : 'non-PPR'}${sf ? ' · Superflex' : ''}`);
  console.log('slots  ' + POS.map(p => `${p} ${Analysis.starterSlots(league.roster_positions)[p]}`).join('  '));
  console.log('league avg starter VORP  ' + POS.map(p => `${p} ${Math.round(out.leagueAvg[p]).toLocaleString()}`).join('  '));
  console.log('strong cutoff (top ' + out.strongCount + ')  ' + POS.map(p => `${p} ${Math.round(out.strongCutoff[p]).toLocaleString()}`).join('  '));
  console.log('');

  const hdr = pad('#', 3, true) + ' ' + pad('team', 22) + ' ' + pad('strength', 9, true) + '  ' +
    POS.map(p => pad(p, 22)).join('');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  let bad = 0;
  const tally = {};
  out.teams.forEach(t => {
    const cells = POS.map(p => {
      const c = t.byPos[p];
      if (!c || !c.tier) { bad++; return pad('MISSING', 22); }
      tally[c.tier] = (tally[c.tier] || 0) + 1;
      const detail = `${c.rostered}/${Number.isInteger(c.slots) ? c.slots : c.slots.toFixed(1)} #${c.rank} ${Math.round(c.starterVorp).toLocaleString()}`;
      return pad(`${c.tier} (${detail})`, 22);
    });
    console.log(pad(t.rank, 3, true) + ' ' + pad(t.name, 22) + ' ' + pad(Math.round(t.starterVorp).toLocaleString(), 9, true) + '  ' + cells.join(''));
    if (VERBOSE) {
      console.log('    needs ' + (t.needs.join(',') || '—') + ' · surplus ' + (t.surplus.join(',') || '—') +
        ' · elite ' + t.elite.map(e => e.name).join(', ') + ' · liab ' + t.liabilities.map(e => e.name).join(', '));
    }
  });

  console.log('');
  console.log('tier counts: ' + Object.keys(tally).sort().map(k => `${k}=${tally[k]}`).join('  '));

  // Sanity checks that would indicate a broken classifier.
  const top = out.teams[0];
  const topCritical = POS.filter(p => top.byPos[p].tier === 'critical');
  if (topCritical.length === POS.length) { console.error('FAIL: #1 team is critical at every position'); bad++; }
  const legacy = Analysis.tierStatus;
  POS.forEach(p => out.teams.forEach(t => {
    if (!Analysis.TIERS.includes(t.byPos[p].tier)) { console.error(`FAIL: unknown tier ${t.byPos[p].tier}`); bad++; }
    if (!['need', 'neutral', 'surplus'].includes(legacy(t.byPos[p].tier))) { console.error('FAIL: tierStatus mapping'); bad++; }
  }));
  if (bad) { console.error(`\n${bad} problem(s)`); process.exit(1); }
  console.log('OK');
})().catch(err => { console.error(err); process.exit(1); });
