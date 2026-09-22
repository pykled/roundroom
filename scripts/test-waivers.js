#!/usr/bin/env node
// Offline checks for shared/waiver-targets.js — the pure cross-reference step
// behind GET /api/me/waivers. Feeds synthetic leagues/players, no network.
// Run: node scripts/test-waivers.js
'use strict';
const WaiverTargets = require('../shared/waiver-targets.js');

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) failed++;
}

const UID = '111';

// 5 trending-up players, sorted by trend desc as scoreTrending would return.
const trendingUp = [
  { id: '1', name: 'Player One',   pos: 'WR', trend: 0.80, market: { addRank: 3 } },
  { id: '2', name: 'Player Two',   pos: 'RB', trend: 0.70, market: { addRank: 40 } },
  { id: '3', name: 'Player Three', pos: 'WR', trend: 0.60, market: { addRank: null } }, // rostered in every league -> skipped
  { id: '4', name: 'Player Four',  pos: 'TE', trend: 0.50, market: { addRank: 10 } },
  { id: '5', name: 'Player Five',  pos: 'QB', trend: 0.40, market: { addRank: 11 } },
];

const leagues = [
  { league_id: 'A', name: 'League A' },
  { league_id: 'B', name: 'League B' },
  { league_id: 'C', name: 'League C' },
];

// League A: I own player 4. Players 2 and 3 are rostered by someone else; 1 and 5 are free agents.
// League B: only player 3 is rostered (by someone else); 1, 2, 4, 5 are free agents; my own roster is empty.
// League C: I co-own a roster that has players 2, 3, 4, 5 — only player 1 is a free agent.
const leagueDataById = {
  A: { rosters: [
    { owner_id: UID, players: ['4'] },
    { owner_id: '222', players: ['2', '3'] },
  ] },
  B: { rosters: [
    { owner_id: UID, players: [] },
    { owner_id: '333', players: ['3'] },
  ] },
  C: { rosters: [
    { owner_id: '444', co_owners: [UID], players: ['2', '3', '4', '5'] },
  ] },
};

const targets = WaiverTargets.buildWaiverTargets(trendingUp, leagues, leagueDataById, UID);

console.log('buildWaiverTargets');

check('skips player rostered in every loaded league', !targets.some(t => t.id === '3'));
check('returns 4 targets (5 trending minus 1 fully-rostered)', targets.length === 4, JSON.stringify(targets.map(t => t.id)));

const p1 = targets.find(t => t.id === '1');
check('player 1 (free everywhere) is FA in all 3 leagues', p1 && p1.faCount === 3 && p1.faIn.slice().sort().join(',') === 'A,B,C', JSON.stringify(p1 && p1.faIn));
check('player 1 is high demand (addRank 3 <= 10)', p1 && p1.highDemand === true);
check('player 1 not on my team anywhere', p1 && p1.onMyTeamIn.length === 0);

const p2 = targets.find(t => t.id === '2');
check('player 2 is rostered in A and C, FA only in B', p2 && p2.faCount === 1 && p2.faIn[0] === 'B', JSON.stringify(p2 && p2.faIn));
check('player 2 is not high demand (addRank 40 > 10)', p2 && p2.highDemand === false);
check('player 2 is on my co-owned team in C (informational, not a FA league)', p2 && p2.onMyTeamIn.length === 1 && p2.onMyTeamIn[0] === 'C');

const p4 = targets.find(t => t.id === '4');
check('player 4 is FA only in B (I own it in A, my co-owned team has it in C)', p4 && p4.faCount === 1 && p4.faIn[0] === 'B', JSON.stringify(p4 && p4.faIn));
check('player 4 shows on my team in both A and C', p4 && p4.onMyTeamIn.slice().sort().join(',') === 'A,C', JSON.stringify(p4 && p4.onMyTeamIn));

const p5 = targets.find(t => t.id === '5');
check('player 5 is FA in A and B (only rostered in C, by my co-owned team)', p5 && p5.faCount === 2 && p5.faIn.slice().sort().join(',') === 'A,B', JSON.stringify(p5 && p5.faIn));
check('player 5 shows on my team in C even though not a FA league there', p5 && p5.onMyTeamIn.length === 1 && p5.onMyTeamIn[0] === 'C');
check('player 5 is not high demand (addRank 11 > 10)', p5 && p5.highDemand === false);

check('sorted by faCount desc, then trend desc: 1 (3), 5 (2), 2 (1, trend .70), 4 (1, trend .50)',
  targets.map(t => t.id).join(',') === '1,5,2,4',
  targets.map(t => t.id).join(','));

// A league that failed to load (absent from leagueDataById) is simply excluded
// from every player's faIn/faCount — never causes a throw.
const leaguesWithGap = leagues.concat([{ league_id: 'D', name: 'League D (failed)' }]);
const targetsWithGap = WaiverTargets.buildWaiverTargets(trendingUp, leaguesWithGap, leagueDataById, UID);
check('missing league data does not throw and does not count toward faIn', targetsWithGap.find(t => t.id === '1').faCount === 3);

// Player who is a free agent nowhere (rostered in the only league) is skipped.
const soleLeague = [{ league_id: 'A', name: 'League A' }];
const soleData = { A: { rosters: [{ owner_id: '999', players: ['1'] }] } };
const soleTargets = WaiverTargets.buildWaiverTargets(trendingUp.slice(0, 1), soleLeague, soleData, UID);
check('skip-when-rostered-everywhere holds for a single league too', soleTargets.length === 0);

console.log(failed === 0 ? '\nAll waiver-targets checks passed.' : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
