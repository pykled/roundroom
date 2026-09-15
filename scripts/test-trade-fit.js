#!/usr/bin/env node
// Node harness for shared/trade-fit.js.
//
//   node scripts/test-trade-fit.js                       # synthetic unit checks
//   node scripts/test-trade-fit.js --live [--base=URL]   # + superflex / injury audit
//                                                        #   on real data (default
//                                                        #   base http://localhost:7899)
//   node scripts/test-trade-fit.js --live --league=ID    # + roster-fit slot read for
//                                                        #   one Sleeper league (uses
//                                                        #   the first roster)
//
// The live audit answers the question the module exists for: are QBs valued
// ~2× in superflex vs 1-QB, on both the VORP half and the market half of the
// blend? Exits 1 on any failed check.
'use strict';

const Scoring = require('../shared/scoring.js');
const Lineup = require('../shared/lineup.js');
global.LineupOptimizer = Lineup;
const Fit = require('../shared/trade-fit.js');

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const baseArg = args.find(a => a.startsWith('--base='));
const BASE = baseArg ? baseArg.slice(7).replace(/\/$/, '') : 'http://localhost:7899';
const leagueArg = args.find(a => a.startsWith('--league='));
const LEAGUE = leagueArg ? leagueArg.slice(9) : null;

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) failed++;
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-9 : tol); }

// ---- 1. league format -----------------------------------------------------
console.log('leagueFormat');
{
  const oneQb = Fit.leagueFormat({ roster_positions: ['QB','RB','RB','WR','WR','TE','FLEX','K','DEF','BN'], scoring_settings: { rec: 1 }, settings: { type: 0, playoff_week_start: 15 }, total_rosters: 12 });
  check('1QB redraft detected', !oneQb.sf && !oneQb.dynasty && oneQb.qbStarters === 1 && oneQb.ppr === 1 && oneQb.teams === 12 && oneQb.regularSeasonWeeks === 14, JSON.stringify(oneQb));
  const sf = Fit.leagueFormat({ roster_positions: ['QB','RB','RB','WR','WR','TE','FLEX','SUPER_FLEX','K','DEF'], scoring_settings: { rec: 0.5 }, settings: { type: 2 }, total_rosters: 14 });
  check('SUPER_FLEX slot → sf, 2 QB starters, half PPR, dynasty', sf.sf && sf.qbStarters === 2 && sf.ppr === 0.5 && sf.dynasty && sf.teams === 14, JSON.stringify(sf));
  const twoQb = Fit.leagueFormat({ roster_positions: ['QB','QB','RB','WR','TE'], scoring_settings: { rec: 0 }, settings: { type: 1 } });
  check('two dedicated QB slots → sf (no SUPER_FLEX token), keeper, standard', twoQb.sf && twoQb.qbStarters === 2 && twoQb.keeper && !twoQb.dynasty && twoQb.ppr === 0, JSON.stringify(twoQb));
  const bare = Fit.leagueFormat(null);
  check('null league → 1QB PPR redraft 12-team defaults', !bare.sf && !bare.dynasty && bare.ppr === 1 && bare.teams === 12 && bare.regularSeasonWeeks === 14, JSON.stringify(bare));
  check('formatLabel', Fit.formatLabel(sf) === 'Superflex · Dynasty · Half PPR' && Fit.formatLabel(oneQb) === '1 QB · Redraft · PPR', Fit.formatLabel(sf) + ' / ' + Fit.formatLabel(oneQb));
}

// ---- 2. injury --------------------------------------------------------------
console.log('injuryMult / applyInjury');
{
  check('healthy → 1', Fit.injuryMult(null) === 1 && Fit.injuryMult('') === 1 && Fit.injuryMult('NA') === 1);
  check('Questionable mild, IR heavy (redraft)', Fit.injuryMult('Questionable') === 0.97 && Fit.injuryMult('IR') === 0.55 && Fit.injuryMult('Out') === 0.80);
  check('dynasty milder than redraft for every status', Object.keys(Fit.INJURY_MULT.redraft).every(s => Fit.injuryMult(s, { dynasty: true }) >= Fit.injuryMult(s)));
  check('trailing dot tolerated ("Sus.")', Fit.injuryMult('Sus.') === 0.85);
  check('unknown status → 1', Fit.injuryMult('Weird') === 1);
  const players = { a: ['A', 'RB', 'X', null], b: ['B', 'RB', 'X', 'Out'], c: ['C', 'WR', 'X', 'IR'] };
  const m = Fit.applyInjury(new Map([['a', 1000], ['b', 1000], ['c', 1000], ['zz', 500]]), players);
  check('applyInjury discounts by status, leaves unknown ids alone', m.get('a') === 1000 && m.get('b') === 800 && m.get('c') === 550 && m.get('zz') === 500, [...m.entries()].join(' '));
}

// ---- 3. age -------------------------------------------------------------------
console.log('ageMult / applyAge');
{
  check('RB cliff: 23 > 26 > 28 > 30', Fit.ageMult('RB', 23) > Fit.ageMult('RB', 26) && Fit.ageMult('RB', 26) > Fit.ageMult('RB', 28) && Fit.ageMult('RB', 28) > Fit.ageMult('RB', 30));
  check('RB 30 discounted harder than WR 30 than QB 30', Fit.ageMult('RB', 30) < Fit.ageMult('WR', 30) && Fit.ageMult('WR', 30) < Fit.ageMult('QB', 30) && Fit.ageMult('QB', 30) === 1);
  check('under-25 RB/WR boost, prime = 1.0', Fit.ageMult('WR', 24) === 1.08 && Fit.ageMult('WR', 26) === 1 && Fit.ageMult('TE', 27) === 1);
  check('unknown age / position → 1', Fit.ageMult('RB', null) === 1 && Fit.ageMult('K', 40) === 1 && Fit.ageMult('RB', NaN) === 1);
  const players = { y: ['Y', 'RB', 'X', null, 23], o: ['O', 'RB', 'X', null, 31], n: ['N', 'WR', 'X', null, null] };
  const m = Fit.applyAge(new Map([['y', 1000], ['o', 1000], ['n', 1000]]), players);
  check('applyAge uses slim[4]', m.get('y') === 1080 && m.get('o') === 700 && m.get('n') === 1000, [...m.entries()].join(' '));
}

// ---- 4. slot scarcity ----------------------------------------------------------
console.log('slotFactors');
{
  const positions = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
  // My roster: 1 QB, 2 RB, 6 WR (values descending), 1 TE.
  const players = {
    qb1: ['QB1', 'QB', 'X', null], qb2: ['QB2', 'QB', 'X', null],
    rb1: ['RB1', 'RB', 'X', null], rb2: ['RB2', 'RB', 'X', null], rbN: ['RBnew', 'RB', 'X', null],
    wr1: ['WR1', 'WR', 'X', null], wr2: ['WR2', 'WR', 'X', null], wr3: ['WR3', 'WR', 'X', null],
    wr4: ['WR4', 'WR', 'X', null], wr5: ['WR5', 'WR', 'X', null], wr6: ['WR6', 'WR', 'X', null],
    wrN: ['WRnew', 'WR', 'X', null], te1: ['TE1', 'TE', 'X', null], k1: ['K1', 'K', 'X', null],
  };
  const vorp = new Map([
    ['qb1', 5000], ['qb2', 3500],
    ['rb1', 6000], ['rb2', 4000], ['rbN', 4500],
    ['wr1', 7000], ['wr2', 6500], ['wr3', 5000], ['wr4', 4200], ['wr5', 3000], ['wr6', 2000],
    ['wrN', 2500], ['te1', 3000], ['k1', 100],
  ]);
  const roster = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'wr4', 'wr5', 'wr6', 'te1', 'k1'];
  const base = { roster, players, vorp, rosterPositions: positions };

  // Receive a 7th WR worth 2500: WR1-3 start, WR4 takes FLEX (4200 > RB3 none), so he's 3rd bench WR (behind wr5 3000, ahead of wr6 2000 → 2nd bench)
  let r = Fit.slotFactors('recv', Object.assign({}, base, { give: [], recv: ['wrN'] }));
  check('7th WR (2500) sits as 2nd bench WR → ×0.72', r.wrN.slot === 'bench' && r.wrN.benchRank === 2 && r.wrN.factor === 0.72, JSON.stringify(r.wrN));
  // Receive an RB worth 4500: beats rb2 → starts
  r = Fit.slotFactors('recv', Object.assign({}, base, { give: [], recv: ['rbN'] }));
  check('RB (4500) starts over RB2 → ×1.00', r.rbN.slot === 'starter' && r.rbN.factor === 1, JSON.stringify(r.rbN));
  // Give WR6 (deepest bench: WR1-3 start, WR4 takes FLEX, WR5 is bench #1) → cheap; give WR1 (starter) → full
  r = Fit.slotFactors('give', Object.assign({}, base, { give: ['wr6', 'wr1'], recv: [] }));
  check('giving WR6 = 2nd bench WR → ×0.72; giving WR1 = starter → ×1.00', r.wr6.factor === 0.72 && r.wr6.benchRank === 2 && r.wr1.factor === 1, JSON.stringify([r.wr6, r.wr1]));
  // Three bench WRs: receiving wrN with wr5/wr6 already sitting → whoever is lowest is bench #3 → ×0.60
  r = Fit.slotFactors('give', Object.assign({}, base, { roster: roster.concat(['wrN']), give: ['wr6'], recv: [] }));
  check('with 7 WRs, giving the lowest = 3rd bench WR → ×0.60', r.wr6.factor === 0.60 && r.wr6.benchRank === 3, JSON.stringify(r.wr6));
  // Receive side accounts for what you give: give wr1+wr2, receive wrN → wrN now starts? WR3 5000, WR4 4200, WR5 3000 start; wrN 2500 → FLEX vs RB3 none → wrN gets FLEX → starter
  r = Fit.slotFactors('recv', Object.assign({}, base, { give: ['wr1', 'wr2'], recv: ['wrN'] }));
  check('after giving WR1+WR2, the new WR starts (FLEX) → ×1.00', r.wrN.slot === 'starter', JSON.stringify(r.wrN));
  // 1QB: 2nd QB is bench #1
  r = Fit.slotFactors('recv', Object.assign({}, base, { give: [], recv: ['qb2'] }));
  check('1-QB league: second QB sits → ×0.85', r.qb2.slot === 'bench' && r.qb2.benchRank === 1 && r.qb2.factor === 0.85, JSON.stringify(r.qb2));
  // Superflex: 2nd QB starts
  const sfPos = positions.concat(['SUPER_FLEX']);
  r = Fit.slotFactors('recv', Object.assign({}, base, { rosterPositions: sfPos, give: [], recv: ['qb2'] }));
  check('superflex: second QB starts (SUPER_FLEX) → ×1.00', r.qb2.slot === 'starter' && r.qb2.factor === 1, JSON.stringify(r.qb2));
  // Kicker / unknown player → neutral
  r = Fit.slotFactors('recv', Object.assign({}, base, { give: [], recv: ['k1', 'nobody'] }));
  check('K and unknown ids → factor 1', r.k1.factor === 1 && r.nobody.factor === 1);
  // Empty roster (manual mode) never throws
  r = Fit.slotFactors('recv', { roster: [], give: [], recv: ['wrN'], players, vorp, rosterPositions: positions });
  check('empty roster: received player starts', r.wrN.factor === 1);
}

// ---- 5. season context --------------------------------------------------------
console.log('seasonContext');
{
  check('too early (week 2) → null', Fit.seasonContext({ week: 2, record: { wins: 1, losses: 0 } }) === null);
  check('week 5 but <3 games → null', Fit.seasonContext({ week: 5, record: { wins: 1, losses: 1 } }) === null);
  const sell = Fit.seasonContext({ week: 6, record: { wins: 1, losses: 4 }, dynasty: true });
  check('dynasty 1-4 → sell', sell && sell.lean === 'sell', JSON.stringify(sell));
  const swing = Fit.seasonContext({ week: 6, record: { wins: 1, losses: 4 }, dynasty: false, regularSeasonWeeks: 14 });
  check('redraft 1-4 → buy upside ("Swing"), 9 weeks left', swing && swing.lean === 'buy' && /9 weeks left/.test(swing.text), JSON.stringify(swing));
  const buy = Fit.seasonContext({ week: 8, record: { wins: 6, losses: 1 }, dynasty: true });
  check('dynasty 6-1 → buy', buy && buy.lean === 'buy');
  const hold = Fit.seasonContext({ week: 8, record: { wins: 4, losses: 3 } });
  check('4-3 → hold', hold && hold.lean === 'hold');
}

// ---- 6. live audit --------------------------------------------------------------
async function getJSON(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

function topByPos(vorp, players, pos, n) {
  return [...vorp.entries()].filter(([id]) => players[id] && players[id][1] === pos)
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, v]) => ({ id, name: players[id][0], v }));
}

async function live() {
  console.log('\nlive audit against ' + BASE);
  const [players, proj, m1, m2, d2] = await Promise.all([
    getJSON('/api/players/slim'), getJSON('/api/projections/season'),
    getJSON('/api/market-values?ppr=1&sf=0'), getJSON('/api/market-values?ppr=1&sf=1'),
    getJSON('/api/market-values?ppr=1&sf=1&dynasty=1'),
  ]);
  const withAge = Object.values(players).filter(p => typeof p[4] === 'number').length;
  check('slim dict carries age (5th element)', withAge > 1000, withAge + ' of ' + Object.keys(players).length);
  // FC redraft lists run ~200 players, dynasty ~420 (adds rookies / deep stashes).
  check('market lists non-empty (1QB, SF, SF dynasty)', Object.keys(m1).length > 150 && Object.keys(m2).length > 150 && Object.keys(d2).length > Object.keys(m2).length,
    `${Object.keys(m1).length} / ${Object.keys(m2).length} / ${Object.keys(d2).length}`);

  const pool = Object.keys(players).map(id => ({ player_id: id, position: players[id][1] }));
  const scoring = { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6, pass_yd: 0.04, pass_td: 4, pass_int: -2 };
  const pos1 = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K'];
  const posSF = pos1.concat(['SUPER_FLEX']);

  function build(positions, market, weight) {
    const raw = Scoring.computeVORP(pool, proj, scoring, positions, 12);
    return Scoring.blendWithMarket(Scoring.rescaleVORP(raw), market, weight);
  }
  function ratio(vorp, label) {
    const qb = topByPos(vorp, players, 'QB', 12), rb = topByPos(vorp, players, 'RB', 12), wr = topByPos(vorp, players, 'WR', 12);
    const qbTop = qb.slice(0, 3).reduce((s, x) => s + x.v, 0) / 3;
    const flexTop = rb.slice(0, 3).concat(wr.slice(0, 3)).reduce((s, x) => s + x.v, 0) / 6;
    console.log(`  ${label}: QB1-3 avg ${Math.round(qbTop)} vs RB/WR top-3 avg ${Math.round(flexTop)} → QB share ${(qbTop / flexTop).toFixed(2)}   (QB1 ${qb[0].name} ${qb[0].v}, QB12 ${qb[11].name} ${qb[11].v})`);
    return qbTop / flexTop;
  }
  // VORP only (weight 0) isolates the roster-slot effect from the market effect.
  const v1 = ratio(build(pos1, {}, 0), 'VORP-only 1QB   ');
  const vSF = ratio(build(posSF, {}, 0), 'VORP-only SF    ');
  check('VORP half: SF raises QB share vs 1QB by ≥1.5×', vSF / v1 >= 1.5, `${(vSF / v1).toFixed(2)}×`);
  const b1 = ratio(build(pos1, m1, 0.3), 'blended  1QB    ');
  const bSF = ratio(build(posSF, m2, 0.3), 'blended  SF     ');
  check('blended: SF raises QB share vs 1QB by ≥1.5×', bSF / b1 >= 1.5, `${(bSF / b1).toFixed(2)}×`);
  // FC's 2-QB market puts QB1 ≈ RB1; the 70% VORP half keeps QBs a bit under
  // that (QB24 still projects real points), so the blend lands ~0.75–0.8.
  check('blended SF: top QBs near top RB/WR (share ≥ 0.70)', bSF >= 0.70, bSF.toFixed(2));
  check('blended 1QB: top QBs clearly below top RB/WR (share ≤ 0.75)', b1 <= 0.75, b1.toFixed(2));

  // Injury: any Out/IR player should be discounted relative to the healthy map.
  const healthy = build(pos1, m1, 0.3);
  const hurt = Fit.applyInjury(healthy, players);
  const sample = [...healthy.entries()].filter(([id, v]) => v > 500 && players[id][3] && /^(Out|IR)$/.test(players[id][3])).slice(0, 5);
  check('injury discount applied to Out/IR players with value', sample.length > 0 && sample.every(([id, v]) => hurt.get(id) < v),
    sample.map(([id, v]) => `${players[id][0]} (${players[id][3]}) ${v}→${hurt.get(id)}`).join(', ') || 'no injured players with value>500 found');

  // Dynasty: young RB up, old RB down, on the VORP half.
  const aged = Fit.applyAge(Scoring.rescaleVORP(Scoring.computeVORP(pool, proj, scoring, posSF, 12)), players);
  const rbs = topByPos(Scoring.rescaleVORP(Scoring.computeVORP(pool, proj, scoring, posSF, 12)), players, 'RB', 40);
  const young = rbs.find(x => players[x.id][4] && players[x.id][4] <= 24), old = rbs.find(x => players[x.id][4] && players[x.id][4] >= 29);
  check('dynasty age curve: young RB up, 29+ RB down', young && old && aged.get(young.id) > young.v && aged.get(old.id) < old.v,
    young && old ? `${young.name} (${players[young.id][4]}) ${young.v}→${aged.get(young.id)}; ${old.name} (${players[old.id][4]}) ${old.v}→${aged.get(old.id)}` : 'sample missing');

  if (LEAGUE) {
    const league = await getJSON('/api/league/' + LEAGUE);
    const fmt = Fit.leagueFormat(league);
    console.log(`\n  league ${league.name}: ${Fit.formatLabel(fmt)} · ${fmt.teams} teams`);
    const market = await getJSON(`/api/market-values?ppr=${fmt.ppr === 1 ? 1 : 0}&sf=${fmt.sf ? 1 : 0}&dynasty=${fmt.dynasty ? 1 : 0}`);
    const raw = Scoring.computeVORP(pool, proj, league.scoring_settings, league.roster_positions, fmt.teams);
    let scaled = Scoring.rescaleVORP(raw);
    if (fmt.dynasty) scaled = Fit.applyAge(scaled, players);
    const vorp = Fit.applyInjury(Scoring.blendWithMarket(scaled, market, fmt.dynasty ? 0.5 : 0.3), players, { dynasty: fmt.dynasty });
    const roster = (league.rosters || [])[0];
    // Skill positions only: K/DEF never enter the depth chart (slot factor is always 1 for them).
    const active = (roster.players || []).filter(id => players[id] && /^(QB|RB|WR|TE)$/.test(players[id][1]));
    const chart = Fit.depthChart(active, players, vorp, league.roster_positions);
    const rows = active.map(id => ({ id, name: players[id][0], pos: players[id][1], v: vorp.get(id) || 0, slot: chart.starter[id] ? 'START' : 'bench #' + chart.benchRank[id] }))
      .sort((a, b) => a.pos.localeCompare(b.pos) || b.v - a.v);
    console.log('  roster ' + roster.roster_id + ' depth chart:');
    rows.forEach(r => console.log(`    ${r.pos.padEnd(3)} ${r.name.padEnd(22)} ${String(r.v).padStart(5)}  ${r.slot}`));
    const benchRanks = rows.filter(r => r.slot !== 'START').map(r => Number(r.slot.replace('bench #', '')));
    check('every rostered skill player is a starter or has a bench rank ≥ 1', rows.every(r => r.slot === 'START' || /bench #[1-9]/.test(r.slot)));
    if (fmt.sf) {
      const qbStarters = rows.filter(r => r.pos === 'QB' && r.slot === 'START').length;
      check('superflex roster starts 2 QBs when it has them', qbStarters === Math.min(2, rows.filter(r => r.pos === 'QB').length), qbStarters + ' QB starters');
    }
    void benchRanks;
  }
}

(async () => {
  if (LIVE) await live();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
