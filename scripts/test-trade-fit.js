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

// ---- 6. recent form (sell high / buy low) --------------------------------------
console.log('formSignal / formMap');
{
  check('one game → null (needs 2)', Fit.formSignal([30], 15) === null);
  check('tiny projection (<5/g) → null', Fit.formSignal([8, 9], 3) === null);
  const hot = Fit.formSignal([24, 20], 15);
  check('22 vs 15 proj → hot ×0.95', hot && hot.label === 'hot' && hot.mult === 0.95 && near(hot.ratio, 1.47, 0.01) && hot.games === 2, JSON.stringify(hot));
  const cold = Fit.formSignal([8, 10, 40], 15);
  check('9 vs 15 proj → cold ×1.05 (3rd game ignored)', cold && cold.label === 'cold' && cold.mult === 1.05 && cold.games === 2, JSON.stringify(cold));
  const flat = Fit.formSignal([16, 15], 15);
  check('on pace → label null, mult 1', flat && flat.label === null && flat.mult === 1, JSON.stringify(flat));
  check('boundary: exactly 1.2 → hot, exactly 0.8 → cold', Fit.formSignal([18, 18], 15).label === 'hot' && Fit.formSignal([12, 12], 15).label === 'cold');
  const dyn = Fit.formSignal([24, 20], 15, { dynasty: true });
  check('dynasty halves the nudge (×0.975)', dyn && dyn.mult === 0.975, JSON.stringify(dyn));
  check('pointsKey by PPR', Fit.pointsKey(1) === 'pts_ppr' && Fit.pointsKey(0.5) === 'pts_half_ppr' && Fit.pointsKey(0) === 'pts_std' && Fit.pointsKey(undefined) === 'pts_ppr');

  const players = { h: ['Hot', 'WR', 'KC', null], c: ['Cold', 'RB', 'DEN', null], b: ['Bye', 'WR', 'SF', null], k: ['Kick', 'K', 'SF', null], z: ['Zero', 'RB', 'X', null] };
  // 17-game season projections: h 255 (15/g), c 255, b 255, k 170, z 255
  const proj = { h: { pts_ppr: 255, pts_half_ppr: 255, pts_std: 255 }, c: { pts_ppr: 255 }, b: { pts_ppr: 255 }, k: { pts_ppr: 170 }, z: { pts_ppr: 255 } };
  const stats = {
    3: { h: { gp: 1, pts_ppr: 24 }, c: { gp: 1, pts_ppr: 8 }, z: { gp: 1 } },            // z: played, no points → 0
    2: { h: { gp: 1, pts_ppr: 20 }, c: { gp: 1, pts_ppr: 10 }, b: { gp: 1, pts_ppr: 30 }, z: { gp: 1 } },
    1: { h: { gp: 1, pts_ppr: 5 }, c: { gp: 1, pts_ppr: 40 }, b: { gp: 1, pts_ppr: 30 }, k: { gp: 1, pts_ppr: 20 } },
  };
  const fm = Fit.formMap(players, stats, [3, 2, 1], proj, { ppr: 1 });
  check('formMap: hot WR ×0.95, cold RB ×1.05', fm.get('h') && fm.get('h').label === 'hot' && fm.get('c') && fm.get('c').label === 'cold', JSON.stringify([fm.get('h'), fm.get('c')]));
  check('formMap: bye in week 3 → uses weeks 2+1 (30, 30 → hot)', fm.get('b') && fm.get('b').label === 'hot' && fm.get('b').avg === 30, JSON.stringify(fm.get('b')));
  check('formMap: kicker skipped; gp without points counts as 0 (cold)', !fm.has('k') && fm.get('z') && fm.get('z').label === 'cold' && fm.get('z').avg === 0, JSON.stringify(fm.get('z')));
  check('formMap: empty inputs → empty map', Fit.formMap(players, null, [1], proj, {}).size === 0 && Fit.formMap(players, stats, [], proj, {}).size === 0);
  const applied = Fit.applyFactors(new Map([['h', 1000], ['c', 1000], ['q', 1000]]), [fm]);
  check('applyFactors: hot 950, cold 1050, unknown untouched', applied.get('h') === 950 && applied.get('c') === 1050 && applied.get('q') === 1000, [...applied.entries()].join(' '));
}

// ---- 7. playoff schedule --------------------------------------------------------
console.log('playoffWeeks / playoffSOS');
{
  check('null league → 15,16,17', Fit.playoffWeeks(null).join() === '15,16,17');
  check('6 teams from 15 → 15,16,17', Fit.playoffWeeks({ settings: { playoff_week_start: 15, playoff_teams: 6 } }).join() === '15,16,17');
  check('4 teams from 16 → 16,17', Fit.playoffWeeks({ settings: { playoff_week_start: 16, playoff_teams: 4 } }).join() === '16,17');
  check('12 teams from 14 → 14–17 (4 rounds)', Fit.playoffWeeks({ settings: { playoff_week_start: 14, playoff_teams: 12 } }).join() === '14,15,16,17');
  check('two-week final adds a week', Fit.playoffWeeks({ settings: { playoff_week_start: 15, playoff_teams: 4, playoff_round_type: 1 } }).join() === '15,16,17');
  check('two weeks per round, capped at 18', Fit.playoffWeeks({ settings: { playoff_week_start: 15, playoff_teams: 6, playoff_round_type: 2 } }).join() === '15,16,17,18');

  // 32-team FPA table for WR: AAA allows the most (rank 1) … ZZZ the least (rank 32)
  const teams = []; for (let i = 0; i < 32; i++) teams.push('T' + String(i + 1).padStart(2, '0'));
  const cur = {}; teams.forEach((t, i) => { cur[t] = 40 - i; });
  const fpa = { current: { WR: cur }, fpMatchupRanks: { WR: { T01: 3 } } };
  check('defenseRank: Sleeper-only rank 1 and 32', Fit.defenseRank({ current: { WR: cur } }, 'WR', 'T01') === 1 && Fit.defenseRank({ current: { WR: cur } }, 'WR', 'T32') === 32);
  check('defenseRank: averages with the FP rank when present (1 + 3 → 2)', Fit.defenseRank(fpa, 'WR', 'T01') === 2);
  check('defenseRank: unknown team / no data → null', Fit.defenseRank(fpa, 'WR', 'NOPE') === null && Fit.defenseRank(null, 'WR', 'T01') === null && Fit.defenseRank(fpa, 'QB', 'T01') === null);

  const sched = {
    15: { KC: { opp: 'T02', home: true }, T02: { opp: 'KC', home: false }, SF: { opp: 'T31', home: false } },
    16: { KC: { opp: 'T03', home: false }, SF: { opp: 'T32', home: true } },
    17: { KC: { opp: 'T04', home: true } },   // SF has no game → bye → rank 32
  };
  const easy = Fit.playoffSOS('KC', 'WR', [15, 16, 17], sched, fpa);
  check('easy slate (ranks 2,3,4 → avg 3) → +4.4%, label easy', easy && easy.label === 'easy' && easy.avgRank === 3 && near(easy.mult, 1.044, 0.001) && easy.opps.length === 3, JSON.stringify(easy));
  const hard = Fit.playoffSOS('SF', 'WR', [15, 16, 17], sched, fpa);
  check('hard slate incl. bye (31,32,32 → 31.7) → −4.9%, label hard', hard && hard.label === 'hard' && hard.opps[2].opp === null && near(hard.mult, 0.951, 0.001), JSON.stringify(hard));
  // Middle of the table (16 teams allow more → rank 17) sits a hair under neutral
  check('rank 17 (mid-table) → 0.998, i.e. neutral', Fit.playoffSOS('X', 'WR', [15], { 15: { X: { opp: 'T17' } } }, { current: { WR: cur } }).mult === 0.998 && Fit.playoffSOS('X', 'WR', [15], { 15: { X: { opp: 'T17' } } }, { current: { WR: cur } }).label === null);
  check('dynasty halves the swing', near(Fit.playoffSOS('KC', 'WR', [15, 16, 17], sched, fpa, { dynasty: true }).mult, 1.022, 0.001));
  check('FA / K / no schedule → null', Fit.playoffSOS('FA', 'WR', [15], sched, fpa) === null && Fit.playoffSOS('KC', 'K', [15], sched, fpa) === null && Fit.playoffSOS('KC', 'WR', [15], {}, fpa) === null);
  check('week loaded, opponent unranked → skipped, not a bye', Fit.playoffSOS('KC', 'WR', [15], { 15: { KC: { opp: 'NOPE' } } }, fpa) === null);
  const pm = Fit.playoffMap({ a: ['A', 'WR', 'KC', null], b: ['B', 'WR', 'KC', null], c: ['C', 'K', 'KC', null], d: ['D', 'WR', 'FA', null] }, [15, 16, 17], sched, fpa);
  check('playoffMap: both KC WRs share the memoised read; K and FA absent', pm.get('a') === pm.get('b') && pm.get('a').label === 'easy' && !pm.has('c') && !pm.has('d'));
}

// ---- 8. roster imbalance ----------------------------------------------------------
console.log('rosterImbalance');
{
  check('1-for-1 and empty sides → null', Fit.rosterImbalance(1, 1) === null && Fit.rosterImbalance(0, 2) === null && Fit.rosterImbalance(2, 0) === null);
  const two = Fit.rosterImbalance(2, 1);
  check('2-for-1 → warn, thinner bench, 1 open spot', two && two.tone === 'warn' && two.net === -1 && /thinner/.test(two.text) && /1 open roster spot to/.test(two.text), two && two.text);
  const gain = Fit.rosterImbalance(1, 3);
  check('1-for-3 → good, +2 bodies, drop 2', gain && gain.tone === 'good' && gain.net === 2 && /2 roster bodies/.test(gain.text) && /drop 2 players/.test(gain.text), gain && gain.text);
}

// ---- 8b. role signal (offline) ---------------------------------------------------
console.log('role signal');
{
  const players = { hub: ['Chuba Hubbard', 'RB', 'CAR', null, 26], brooks: ['Jonathon Brooks', 'RB', 'CAR', 'IR', 22] };
  const statsByWeek = { 4: { hub: { gp: 1, pts_ppr: 19 } }, 3: { hub: { gp: 1, pts_ppr: 19 } } };
  const weeks = [4, 3];
  const proj = { hub: { pts_ppr: 8.7 * 17 } };
  const mkUsage = (hubRecent, hubPrior, brooksRecentGames) => ({
    hub: { recent: hubRecent, season: { carryShare: 0.5, snapPct: 0.68, games: 3 }, prior: hubPrior },
    brooks: { season: { carryShare: 0.34, snapPct: 0.6, games: 3 }, recent: { carryShare: 0.34, games: brooksRecentGames } },
  });
  const flatUsage = mkUsage({ carryShare: 0.55, snapPct: 0.7, games: 2 }, { carryShare: 0.52, snapPct: 0.66, games: 1 }, 1);

  // 1. Hubbard — flat share, teammate on IR → injury path
  {
    const outs = Fit.teamOuts(players, flatUsage);
    check('Hubbard: teamOuts groups the IR teammate by team/pos', outs.CAR && outs.CAR.RB.length === 1 && outs.CAR.RB[0].id === 'brooks');
    const map = Fit.formMap(players, statsByWeek, weeks, proj, { ppr: 1, usage: flatUsage, teamOuts: outs, recentWindow: 2 });
    const e = map.get('hub');
    check('Hubbard: role-up, mult 1, injury source', e && e.label === 'role-up' && e.mult === 1 && e.role.source === 'injury', JSON.stringify(e && e.role));
    check('Hubbard: vacated ≈ 0.17, underlying form hot', e && near(e.role.vacated, 0.17, 1e-6) && e.form.label === 'hot');
    check('Hubbard: applyFactors applies no discount', Fit.applyFactors(new Map([['hub', 1000]]), [map]).get('hub') === 1000);
    const r = Fit.roleSignal(flatUsage.hub, outs.CAR.RB, 'RB', { recentWindow: 2 });
    check('Hubbard: roleSignal direct → up', r && r.label === 'up' && r.source === 'injury' && r.teammates[0].name === 'Jonathon Brooks');
    const g = Fit.gateForm(Fit.formSignal([19, 19], 8.7), r);
    check('Hubbard: gateForm(hot, up) → role-up mult 1', g.label === 'role-up' && g.mult === 1);
  }

  // 2. Soft-D — hot, flat usage, nobody out → stays hot
  {
    const healthy = Object.assign({}, players, { brooks: ['Jonathon Brooks', 'RB', 'CAR', null, 22] });
    const u = mkUsage({ carryShare: 0.5, snapPct: 0.68, games: 2 }, { carryShare: 0.5, snapPct: 0.68, games: 1 }, 1);
    const outs = Fit.teamOuts(healthy, u);
    const e = Fit.formMap(healthy, statsByWeek, weeks, proj, { ppr: 1, usage: u, teamOuts: outs, recentWindow: 2 }).get('hub');
    check('Soft-D: no teammate out → teamOuts empty', Object.keys(outs).length === 0);
    check('Soft-D: stays hot ×0.95', e && e.label === 'hot' && e.mult === 0.95, JSON.stringify(e));
  }

  // 3. Role-down — cold + share collapse → not a buy-low
  {
    const cold = { 4: { hub: { gp: 1, pts_ppr: 4 } }, 3: { hub: { gp: 1, pts_ppr: 4 } } };
    const p12 = { hub: { pts_ppr: 12 * 17 } };
    const u = { hub: { recent: { carryShare: 0.30, snapPct: 0.45, games: 2 }, season: { carryShare: 0.5, snapPct: 0.6, games: 3 }, prior: { carryShare: 0.55, snapPct: 0.60, games: 1 } } };
    const r = Fit.roleSignal(u.hub, [], 'RB', { recentWindow: 2 });
    check('Role-down: roleSignal down/high', r && r.label === 'down' && r.confidence === 'high', JSON.stringify(r));
    const map = Fit.formMap(players, cold, weeks, p12, { ppr: 1, usage: u, teamOuts: {}, recentWindow: 2 });
    const e = map.get('hub');
    check('Role-down: entry role-down mult 1', e && e.label === 'role-down' && e.mult === 1, JSON.stringify(e));
    check('Role-down: applyFactors leaves value unchanged', Fit.applyFactors(new Map([['hub', 1000]]), [map]).get('hub') === 1000);
    const plain = Fit.formMap(players, cold, weeks, p12, { ppr: 1 }).get('hub');
    check('Role-down: without usage the plain cold ×1.05 remains', plain.label === 'cold' && plain.mult === 1.05);
  }

  // 4. Usage-confirmed thresholds
  {
    const u = (a, b, sa, sb) => ({ recent: { carryShare: b, snapPct: sb == null ? 0.6 : sb, games: 2 }, season: { carryShare: a, snapPct: sa == null ? 0.6 : sa, games: 3 }, prior: { carryShare: a, snapPct: sa == null ? 0.6 : sa, games: 1 } });
    const hi = Fit.roleSignal(u(0.38, 0.61, 0.55, 0.78), [], 'RB');
    check('Usage up: 0.38 → 0.61 fires up/high', hi && hi.label === 'up' && hi.confidence === 'high' && hi.source === 'usage', hi && hi.text);
    check('Usage up: text quotes shares and snaps', hi && /Carry share 38% → 61%/.test(hi.text) && /snaps 55% → 78%/.test(hi.text));
    check('Usage up: 0.07 → 0.10 does NOT fire', Fit.roleSignal(u(0.07, 0.10), [], 'RB') === null);
    check('Usage up: 0.30 → 0.37 (+7pp) does NOT fire', Fit.roleSignal(u(0.30, 0.37), [], 'RB') === null);
    const med = Fit.roleSignal(u(0.20, 0.30), [], 'RB');
    check('Usage up: 0.20 → 0.30 fires med when snaps flat', med && med.label === 'up' && med.confidence === 'med');
    const wu = { recent: { tgtShare: 0.25, snapPct: 0.6, games: 2 }, season: { tgtShare: 0.15, games: 3 }, prior: { tgtShare: 0.15, snapPct: 0.6, games: 1 } };
    const wr = Fit.roleSignal(wu, [], 'WR');
    check('Usage up: WR reads target share', wr && wr.label === 'up' && /Target share/.test(wr.text));
    const one = u(0.2, 0.3); one.recent.games = 1;
    check('Usage up: 1 game flagged as thin evidence', /1 game of evidence/.test(Fit.roleSignal(one, [], 'RB').text));
  }

  // 5. Weekly-projection baseline
  {
    const s = Fit.formSignal([19, 19], 8.7, { projGames: [18.5, 19.2] });
    check('Weekly proj: label null, baseline weekly, ratio ≈ 1', s.label === null && s.baseline === 'weekly' && near(s.ratio, 1, 0.05), JSON.stringify(s));
    const both = { 4: { hub: { pts_ppr: 18.5 } }, 3: { hub: { pts_ppr: 19.2 } } };
    const e = Fit.formMap(players, statsByWeek, weeks, proj, { ppr: 1, projByWeek: both }).get('hub');
    check('Weekly proj via formMap: no hot entry', !e || e.label === null, JSON.stringify(e));
    const one = Fit.formMap(players, statsByWeek, weeks, proj, { ppr: 1, projByWeek: { 4: { hub: { pts_ppr: 18.5 } } } }).get('hub');
    check('Weekly proj: one week only → season baseline → hot', one && one.label === 'hot' && one.baseline === 'season', JSON.stringify(one));
  }

  // 6. No-usage fallback
  {
    const e = Fit.formMap(players, statsByWeek, weeks, proj, { ppr: 1, dynasty: false }).get('hub');
    check('No-usage fallback: hot ×0.95, plain shape', e && e.label === 'hot' && e.mult === 0.95 && e.avg === 19 && e.proj === 8.7 && e.games === 2 && e.ratio === 2.18 && !('role' in e), JSON.stringify(e));
  }

  // 7. Dynasty
  {
    const outs = Fit.teamOuts(players, flatUsage);
    const e = Fit.formMap(players, statsByWeek, weeks, proj, { ppr: 1, dynasty: true, usage: flatUsage, teamOuts: outs, recentWindow: 2 }).get('hub');
    check('Dynasty: role-up mult 1, hold wording', e && e.label === 'role-up' && e.mult === 1 && e.role.hold === true && /hold/.test(e.text), e && e.text);
  }

  // 8. QB
  check('QB: no role signal', Fit.roleSignal(flatUsage.hub, [], 'QB') === null);

  // 9. Stale injury — teammate out 2+ weeks (no recent games) → role already projected
  {
    const u = mkUsage({ carryShare: 0.55, snapPct: 0.7, games: 2 }, { carryShare: 0.52, snapPct: 0.66, games: 1 }, 0);
    const outs = Fit.teamOuts(players, u);
    const e = Fit.formMap(players, statsByWeek, weeks, proj, { ppr: 1, usage: u, teamOuts: outs, recentWindow: 2 }).get('hub');
    check('Stale injury: does not fire, stays hot', e && e.label === 'hot' && e.mult === 0.95, JSON.stringify(e && e.label));
  }
}

// ---- 9. live audit --------------------------------------------------------------
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
