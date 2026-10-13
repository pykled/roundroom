#!/usr/bin/env node
/* Tests for nba/pages/draft-logic.js (pure draft-board logic).
   Run: node scripts/test-nba-ui.js   (exit 0 = all pass) */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'nba', 'pages', 'draft-logic.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error((msg ? msg + ': ' : '') + 'expected ' + B + ', got ' + A);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

const P = (id, elig, hsValue, extra) => Object.assign({ id: String(id), name: 'P' + id, team: 'XXX', elig: elig.concat(['UTIL']), hsValue, ceiling: hsValue + 15, floor: hsValue - 15, injury: null }, extra || {});
const DEF = L.normalizeSettings({});

console.log('snake order');
t('10 teams: round 1 ascends, round 2 descends', () => {
  const o = L.snakeOrder(10, 3);
  eq(o.length, 30);
  eq(o.slice(0, 10).map(x => x.slot), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  eq(o.slice(10, 20).map(x => x.slot), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  eq(o[20].slot, 1);
  eq(o[19], { pick: 20, round: 2, pickInRound: 10, slot: 1 });
});
t('picksForSlot + nextPickFor', () => {
  eq(L.picksForSlot(1, 10, 4), [1, 20, 21, 40]);
  eq(L.picksForSlot(10, 10, 3), [10, 11, 30]);
  eq(L.picksForSlot(4, 10, 10, 15), [17, 24, 37, 44, 57, 64, 77, 84, 97]);
});
t('nextPickFor: from pick 5 for slot 4 is 17', () => eq(L.nextPickFor(4, 5, DEF), 17));
t('nextPickFor returns null after last round', () => eq(L.nextPickFor(1, 101, DEF), null));
t('defaults: 10 teams, 6 starters, 10-man roster', () => {
  eq(L.starterCount(DEF), 6); eq(L.rosterSize(DEF), 10); eq(L.totalPicks(DEF), 100);
});
t('normalizeSettings clamps garbage', () => {
  const s = L.normalizeSettings({ teams: '99', mySlot: 40, slots: { G: -2, F: 'x' }, bench: 3 });
  eq(s.teams, 20); eq(s.mySlot, 20); eq(s.slots, { G: 0, F: 3, UTIL: 1 }); eq(s.bench, 3);
});

console.log('slot assignment');
t('fills G,G,F,F,F,UTIL by value; extra goes to bench', () => {
  const r = [P(1, ['G'], 60), P(2, ['G'], 55), P(3, ['G'], 50), P(4, ['F'], 58), P(5, ['F'], 40), P(6, ['G'], 30)];
  const a = L.assignSlots(r, DEF);
  eq(a.starters.map(s => s.slot + ':' + (s.player ? s.player.id : '-')), ['G:1', 'G:2', 'F:4', 'F:5', 'F:-', 'UTIL:3']);
  eq(a.bench.map(p => p.id), ['6']);
  eq(a.open, { G: 0, F: 1, UTIL: 0 });
  eq(a.total, 60 + 55 + 58 + 40 + 50);
});
t('dual G/F moves aside so a pure G can start', () => {
  // dual takes F first; but with F full, a dual in G must slide to UTIL for a pure G
  const s = L.normalizeSettings({ slots: { G: 1, F: 0, UTIL: 1 }, bench: 2 });
  const r = [P(1, ['G', 'F'], 70), P(2, ['G'], 50)];
  const a = L.assignSlots(r, s);
  eq(a.open, { G: 0, F: 0, UTIL: 0 });
  eq(a.total, 120);
});
t('bench player swaps in over a weaker eligible starter', () => {
  const s = L.normalizeSettings({ slots: { G: 1, F: 1, UTIL: 0 }, bench: 3 });
  const r = [P(1, ['F'], 40), P(2, ['G', 'F'], 45), P(3, ['G'], 44)];
  const a = L.assignSlots(r, s);
  eq(a.total, 89, 'best is dual at F (45) + pure G (44)');
});
t('empty roster: all slots open', () => eq(L.assignSlots([], DEF).open, { G: 2, F: 3, UTIL: 1 }));

console.log('balance warnings');
t('needs a third F late in the draft', () => {
  const r = [P(1, ['G'], 60), P(2, ['G'], 58), P(3, ['F'], 57), P(4, ['F'], 56), P(5, ['G'], 50), P(6, ['G'], 40), P(7, ['G'], 39)];
  const w = L.balanceWarnings(r, DEF, { available: [], picksUntilNext: 9 });
  ok(w.some(x => /Needs a third F/.test(x.text)), JSON.stringify(w));
  ok(w.some(x => /Guard-heavy/.test(x.text)), 'guard heavy flagged');
});
t('more open starter slots than picks left is danger', () => {
  const r = [P(1, ['G'], 60), P(2, ['G'], 58), P(3, ['G'], 50), P(4, ['G'], 49), P(5, ['G'], 48), P(6, ['G'], 47), P(7, ['G'], 46), P(8, ['G'], 45)];
  const w = L.balanceWarnings(r, DEF, { available: [] });
  eq(w[0].level, 'danger'); ok(/2 picks left for 3 open starter slots/.test(w[0].text), w[0].text);
});
t('F scarcity when starter-grade F nearly gone', () => {
  const all = []; for (let i = 0; i < 40; i++) all.push(P(100 + i, [i % 2 ? 'F' : 'G'], 80 - i));
  const avail = all.filter(p => !(p.elig[0] === 'F' && +p.id < 135)); // only 3 F left: 135,137,139
  const w = L.balanceWarnings([P(1, ['G'], 60)], DEF, { available: avail, players: all, picksUntilNext: 9 });
  ok(w.some(x => /F is drying up/.test(x.text)), JSON.stringify(w));
});
t('no warnings for a fresh roster early on', () => eq(L.balanceWarnings([], DEF, { available: [] }), []));

console.log('best available');
t('recommends F when both G slots + UTIL are full', () => {
  const roster = [P(1, ['G'], 60), P(2, ['G'], 58), P(3, ['G'], 55)];
  const avail = [P(10, ['G'], 57), P(11, ['F'], 52), P(12, ['F'], 50), P(13, ['G'], 49)];
  const b = L.bestAvailable(avail, roster, DEF, { picksUntilNext: 1, nextPick: 18 });
  eq(b[0].player.id, '11'); eq(b[0].slot, 'F');
  ok(/Your first F/.test(b[0].reason), b[0].reason);
  ok(/#18/.test(b[0].reason), b[0].reason);
});
t('value over next pick favours the scarce position', () => {
  // Empty roster. Lots of Gs ~ 60, one elite F 59 then a cliff to 30.
  const avail = [P(1, ['G'], 61), P(2, ['G'], 60), P(3, ['G'], 60), P(4, ['G'], 59), P(5, ['F'], 59), P(6, ['F'], 30)];
  const b = L.bestAvailable(avail, [], DEF, { picksUntilNext: 2 });
  eq(b[0].player.id, '5', 'take the F before the cliff');
});
t('injured OUT player is discounted', () => {
  const avail = [P(1, ['F'], 62, { injury: 'Out' }), P(2, ['F'], 58)];
  const b = L.bestAvailable(avail, [], DEF, { picksUntilNext: 9 });
  eq(b[0].player.id, '2'); ok(/OUT/.test(b.find(x => x.player.id === '1').reason));
});
t('full roster → no recommendation', () => {
  const r = []; for (let i = 0; i < 10; i++) r.push(P(i, ['G'], 50));
  eq(L.bestAvailable([P(99, ['F'], 70)], r, DEF), []);
});
t('starters full → bench reason', () => {
  const r = [P(1, ['G'], 60), P(2, ['G'], 58), P(3, ['F'], 57), P(4, ['F'], 56), P(5, ['F'], 50), P(6, ['G'], 40)];
  const b = L.bestAvailable([P(9, ['F'], 35)], r, DEF);
  eq(b[0].slot, 'BENCH'); ok(/bench/.test(b[0].reason));
});

console.log('yahoo merge');
const yahoo = {
  status: 'drafting',
  picks: [
    { pick: 1, round: 1, team_key: 't.1', player_key: 'nba.p.1', sleeperId: '100', name: 'A' },
    { pick: 2, round: 1, team_key: 't.2', player_key: 'nba.p.2', sleeperId: null, name: 'Rookie X' },
    { pick: 3, round: 1, team_key: 't.3', player_key: 'nba.p.3', sleeperId: '300', name: 'C' }
  ],
  unmatched: [{ player_key: 'nba.p.2', name: { full: 'Rookie X' } }, { player_key: 'nba.p.9', name: { full: 'Ghost' } }]
};
t('yahoo is truth; manual duplicates confirmed and pruned', () => {
  const m = L.mergePicks(yahoo, [{ playerId: '300', mine: false }, { playerId: '400', mine: true }], { settings: DEF, myTeamKey: 't.3' });
  eq(m.picks.map(p => [p.pick, p.playerId, p.source, p.confirmed, p.mine]), [
    [1, '100', 'yahoo', true, false], [2, null, 'yahoo', true, false], [3, '300', 'yahoo', true, true], [4, '400', 'manual', false, true]
  ]);
  eq(m.confirmedManual, ['300']);
  eq(m.unmatched.map(u => u.player_key), ['nba.p.2', 'nba.p.9']);
});
t('override resolves an unmatched pick', () => {
  const m = L.mergePicks(yahoo, [], { settings: DEF, overrides: { 'nba.p.2': '200' } });
  eq(m.picks[1].playerId, '200');
  eq(m.unmatched.map(u => u.player_key), ['nba.p.9']);
});
t('manual mode: sequential numbering, snake slots, all confirmed', () => {
  const m = L.mergePicks(null, [{ playerId: 'a' }, { playerId: 'b' }, { playerId: 'a' }], { settings: L.normalizeSettings({ teams: 2 }) });
  eq(m.picks.map(p => [p.pick, p.slot, p.confirmed]), [[1, 1, true], [2, 2, true]]);
  eq(m.confirmedManual, []);
});
t('duplicate pick numbers / players from a flaky poll are ignored', () => {
  const y = { picks: [{ pick: 1, sleeperId: '1', team_key: 'a' }, { pick: 1, sleeperId: '1', team_key: 'a' }, { pick: 2, sleeperId: '1', team_key: 'b', player_key: 'k' }] };
  const m = L.mergePicks(y, [], { settings: DEF });
  eq(m.picks.length, 2); eq(m.picks[1].playerId, null); eq(m.unmatched.length, 1);
});
t('settingsFromYahoo maps roster_positions + draft position', () => {
  const s = L.settingsFromYahoo({ num_teams: 12, roster_positions: [{ position: 'G', count: 2 }, { position: 'F', count: 3 }, { position: 'Util', count: 1 }, { position: 'BN', count: 4 }, { position: 'IL', count: 2 }] },
    't.7', [{ team_key: 't.7', draft_position: 7 }]);
  eq(s, { teams: 12, mySlot: 7, slots: { G: 2, F: 3, UTIL: 1 }, bench: 4 });
});

console.log('persistence');
t('serialize → deserialize round-trips', () => {
  const st = L.emptyState('nba.l.1', { teams: 12, mySlot: 5 });
  st.manual.push({ playerId: 7, mine: true, at: 1 }); st.overrides['k'] = '9';
  const back = L.deserializeState(L.serializeState(st), 'nba.l.1');
  eq(back.settings.teams, 12); eq(back.settings.mySlot, 5);
  eq(back.manual, [{ playerId: '7', mine: true, at: 1, name: undefined }]); eq(back.overrides, { k: '9' });
});
t('corrupt / wrong league / wrong version → fresh state', () => {
  eq(L.deserializeState('{not json', null).manual, []);
  eq(L.deserializeState(L.serializeState(L.emptyState('a')), 'b').leagueKey, 'b');
  eq(L.deserializeState(JSON.stringify({ v: 0, manual: [{ playerId: 1 }] }), null).manual, []);
});
t('storage key is per league', () => {
  eq(L.storageKey(null), 'pocket-nba-draft:manual'); eq(L.storageKey('nba.l.9'), 'pocket-nba-draft:nba.l.9');
});

console.log('polling + misc');
t('pollDelay backs off to 30s', () => eq([0, 1, 2, 3, 9].map(L.pollDelay), [4000, 8000, 16000, 30000, 30000]));
t('agoText', () => eq([0, 5000, 90000, 7200000].map(L.agoText), ['just now', '5s ago', '1m ago', '2h ago']));
t('search ignores accents + punctuation', () => {
  ok(L.matchesQuery({ name: 'Nikola Jokić', team: 'DEN' }, 'jokic'));
  ok(L.matchesQuery({ name: "De'Aaron Fox", team: 'SAS' }, 'deaaron sas'));
  ok(!L.matchesQuery({ name: 'Luka Doncic', team: 'LAL' }, 'jokic'));
});
t('injuryShort normalises tags', () => eq(['Out', 'Questionable', 'GTD', 'Day-To-Day', null].map(L.injuryShort), ['OUT', 'Q', 'GTD', 'GTD', '']));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
