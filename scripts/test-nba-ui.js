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
// The original suite targets the Yahoo High Score shape (G,G,F,F,F,UTIL); the page default is now league 242808.
const DEF = L.normalizeSettings(L.HIGH_SCORE_SETTINGS);

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
  ok(/Fills open F slot \(your first F\)/.test(b[0].reason), b[0].reason);
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
  eq(s, { teams: 12, mySlot: 7, slots: { G: 2, F: 3, UTIL: 1 }, bench: 4, il: 2 });
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

/* ===================== Phase 3 (H2): league 242808 board ===================== */
const LP = L.normalizeSettings({}); // league 242808 profile defaults
// Position-aware player: pos like 'PG,SG' (Sleeper) and optional yahooElig.
const Q = (id, pos, hsValue, extra) => Object.assign({ id: String(id), name: 'Q' + id, team: 'XXX', pos: pos.split(','), hsValue, ceiling: hsValue + 12, floor: hsValue - 12, injury: null, tier: 1 }, extra || {});
const PROFILE = {
  leagueId: '242808', name: 'HALIMSANITY 26-27', teams: 12, draft: { type: 'snake', pickSeconds: 90 },
  slots: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2, BN: 5, IL: 2 }, starters: 9, rosterSize: 16
};

console.log('league profile (242808)');
t('defaults are the 242808 profile: 12 teams, 9 starters, 16 spots, 192 picks', () => {
  eq(LP.teams, 12); eq(L.starterCount(LP), 9); eq(L.rosterSize(LP), 16); eq(L.totalPicks(LP), 192);
  eq(L.slotTypes(LP), ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL']);
  eq(L.isLegacy(LP), false); eq(L.isLegacy(DEF), true);
});
t('settingsFromProfile maps slots/BN/IL/teams and keeps my slot', () => {
  const s = L.settingsFromProfile(PROFILE, { mySlot: 7 });
  eq(s, { teams: 12, mySlot: 7, slots: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2 }, bench: 5, il: 2 });
  eq(L.profilePickSeconds(PROFILE), 90); eq(L.profilePickSeconds(null), 90); eq(L.profilePickSeconds({ draft: { pickSeconds: 'x' } }), 90);
  eq(L.settingsFromProfile(null, { mySlot: 3 }).mySlot, 3, 'no profile → defaults, slot kept');
  const hs = L.settingsFromProfile({ teams: 10, slots: { G: 2, F: 3, UTIL: 1, BN: 4 } }, null);
  eq(L.isLegacy(hs), true); eq(L.rosterSize(hs), 10);
});
t('settingsFromYahoo: 242808 roster_positions → position-aware slots', () => {
  const rp = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C'].map(p => ({ position: p, count: 1 }))
    .concat([{ position: 'Util', count: 2 }, { position: 'BN', count: 5 }, { position: 'IL', count: 2 }]);
  const s = L.settingsFromYahoo({ num_teams: 12, roster_positions: rp }, 't.3', [{ team_key: 't.3', draft_position: 3 }], LP);
  eq(s, { teams: 12, mySlot: 3, slots: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 2 }, bench: 5, il: 2 });
  const fc = L.settingsFromYahoo({ num_teams: 10, roster_positions: [{ position: 'G', count: 2 }, { position: 'F/C', count: 3 }, { position: 'Util', count: 1 }] }, null, null, LP);
  eq(fc.slots, { G: 2, FC: 3, UTIL: 1 });
});
t('normalizeSettings: position mode clamps; zeroed types drop out', () => {
  const s = L.normalizeSettings({ teams: 12, slots: { PG: 9, C: -1, UTIL: 'x', SG: '2' }, bench: 99, il: 9 });
  eq(s.slots, { PG: 6, SG: 2 }); eq(s.bench, 15); eq(s.il, 5);
});

console.log('12-team snake');
t('12 teams: R1 ascends, R2 reverses, R3 ascends again', () => {
  const o = L.snakeOrder(12, 16);
  eq(o.length, 192);
  eq(o.slice(0, 12).map(x => x.slot), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  eq(o.slice(12, 24).map(x => x.slot), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  eq(o[24].slot, 1); eq(o[191], { pick: 192, round: 16, pickInRound: 12, slot: 1 });
});
t('12 teams: turn picks are back-to-back at the ends', () => {
  eq(L.picksForSlot(12, 12, 4), [12, 13, 36, 37]);
  eq(L.picksForSlot(1, 12, 4), [1, 24, 25, 48]);
  eq(L.picksForSlot(5, 12, 16).length, 16);
  eq(L.picksForSlot(5, 12, 3), [5, 20, 29]);
});
t('myPicksSnake: 16 rounds for slot 5, numbered and rounded', () => {
  const m = L.myPicksSnake(Object.assign({}, LP, { mySlot: 5 }), 1);
  eq(m.length, 16); eq(m[0], { pick: 5, round: 1 }); eq(m[1], { pick: 20, round: 2 }); eq(m[15], { pick: 188, round: 16 });
  eq(L.myPicksSnake(Object.assign({}, LP, { mySlot: 5 }), 21)[0], { pick: 29, round: 3 });
  eq(L.nextPickFor(5, 193, Object.assign({}, LP, { mySlot: 5 })), null);
});

console.log('slot eligibility (contract legend)');
const E = p => L.SLOT_TYPES.filter(t => L.canFill(p, t, LP));
t('C-only is C/UTIL — NOT F or PF', () => eq(E(Q(1, 'C', 50)), ['FC', 'C', 'UTIL']));
t('PF,C (F/C) fills PF, F, C', () => eq(E(Q(1, 'PF,C', 50)), ['PF', 'F', 'FC', 'C', 'UTIL']));
t('PG fills PG and G only; SG fills SG and G', () => {
  eq(E(Q(1, 'PG', 50)), ['PG', 'G', 'UTIL']); eq(E(Q(2, 'SG', 50)), ['SG', 'G', 'UTIL']);
});
t('SG,SF (G/F) fills SG, G, SF, F; not PG/PF/C', () => eq(E(Q(1, 'SG,SF', 50)), ['SG', 'G', 'SF', 'F', 'FC', 'UTIL']));
t('generic Yahoo tokens: G → SG,G (not PG); F → SF,PF,F; G/F and F/C strings', () => {
  eq(E(Q(1, 'G', 50)), ['SG', 'G', 'UTIL']);
  eq(E(Q(2, 'F', 50)), ['SF', 'PF', 'F', 'FC', 'UTIL']);
  eq(E(Object.assign(Q(3, 'X', 50), { pos: 'F/C' })), ['PF', 'F', 'FC', 'C', 'UTIL']);
  eq(L.posTokens('G/F, c'), ['GF', 'C']);
});
t('yahooElig wins over pos; derived eligibility is low confidence', () => {
  const y = Q(1, 'C', 50, { yahooElig: ['PF', 'F', 'C', 'UTIL'], eligConfidence: 0.95 });
  eq(E(y), ['PF', 'F', 'C', 'UTIL']); eq(L.slotElig(y).source, 'yahoo'); eq(L.slotElig(y).low, false);
  const d = Q(2, 'PG', 50);
  eq(L.slotElig(d).source, 'derived'); eq(L.slotElig(d).low, true);
  eq(L.slotElig(Q(3, 'PG', 50, { yahooElig: ['PG'], eligConfidence: 'low' })).low, true);
});
t('no pos/yahooElig: falls back to model elig, else UTIL only', () => {
  eq(E({ id: 'a', elig: ['G', 'UTIL'], hsValue: 1 }), ['G', 'UTIL']);
  eq(E({ id: 'b', hsValue: 1 }), ['UTIL']);
});
t('displayPositions: base Yahoo positions', () => {
  eq(L.displayPositions(Q(1, 'PF,C', 1)), ['PF', 'C']); eq(L.displayPositions(Q(2, 'G', 1)), ['SG']);
});
t('matchesPos with league settings uses slot eligibility', () => {
  const c = Q(1, 'C', 50), pf = Q(2, 'PF', 50);
  eq([L.matchesPos(c, 'C', LP), L.matchesPos(c, 'F', LP), L.matchesPos(pf, 'C', LP), L.matchesPos(pf, 'F', LP), L.matchesPos(c, 'UTIL', LP), L.matchesPos(c, 'ALL', LP)],
    [true, false, false, true, true, true]);
});

console.log('slot assignment (242808)');
const lineup = a => a.starters.map(s => s.slot + ':' + (s.player ? s.player.id : '-')).join(' ');
t('two C-only: one at C, one at UTIL; F stays open', () => {
  const a = L.assignSlots([Q(1, 'C', 60), Q(2, 'C', 55)], LP);
  eq(lineup(a), 'PG:- SG:- G:- SF:- PF:- F:- C:1 UTIL:2 UTIL:-');
  eq(a.open.F, 1); eq(a.open.C, 0); eq(a.open.UTIL, 1);
});
t('four C-only: C, UTIL, UTIL, then bench (never F)', () => {
  const a = L.assignSlots([Q(1, 'C', 60), Q(2, 'C', 55), Q(3, 'C', 50), Q(4, 'C', 45)], LP);
  eq(a.bench.map(p => p.id), ['4']); eq(a.open.F, 1); eq(a.open.PF, 1);
});
t('dual-eligible guard moves to G so both pure guards start', () => {
  // A (PG,SG) 70, B (PG) 65, C (SG) 60 → B at PG, C at SG, A at G: all start.
  const a = L.assignSlots([Q('A', 'PG,SG', 70), Q('B', 'PG', 65), Q('C', 'SG', 60)], LP);
  eq(lineup(a).split(' ')[0], 'PG:B'); // the pure PG must take PG; A and C split SG/G
  eq(a.open.PG + a.open.SG + a.open.G, 0); eq(a.bench.length, 0);
  eq(a.total, 195);
});
t('G/F wing fills where it helps (F) when SF is taken', () => {
  const a = L.assignSlots([Q(1, 'SF', 60), Q(2, 'SG,SF', 58), Q(3, 'SG', 57), Q(4, 'PG', 50), Q(5, 'PG', 49)], LP);
  // SF→SF, SG→SG, wing→G or F, PGs → PG + (G or UTIL); all five start.
  eq(a.bench.length, 0); eq(a.total, 60 + 58 + 57 + 50 + 49);
});
t('narrow slots preferred: a lone PG sits at PG, not G/UTIL', () => {
  eq(lineup(L.assignSlots([Q(1, 'PG', 50)], LP)).split(' ')[0], 'PG:1');
});
t('assignment is optimal: matches brute force on random rosters', () => {
  let seed = 7; const r = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const POS = ['PG', 'SG', 'SF', 'PF', 'C', 'PG,SG', 'SG,SF', 'SF,PF', 'PF,C', 'C'];
  const types = []; Object.keys(LP.slots).forEach(t => { for (let i = 0; i < LP.slots[t]; i++) types.push(t); });
  for (let n = 0; n < 25; n++) {
    const roster = []; for (let i = 0; i < 6; i++) roster.push(Q(n * 10 + i, POS[Math.floor(r() * POS.length)], Math.round(r() * 60)));
    let best = 0; const used = types.map(() => false);
    (function go(i, sum) {
      if (i === roster.length) { best = Math.max(best, sum); return; }
      go(i + 1, sum);
      for (let k = 0; k < types.length; k++) if (!used[k] && L.canFill(roster[i], types[k], LP)) { used[k] = true; go(i + 1, sum + roster[i].hsValue); used[k] = false; }
    })(0, 0);
    eq(L.assignSlots(roster, LP).total, best, 'roster ' + n);
  }
});
t('IL: OUT non-starter goes to IL; healthy overflow past the bench is flagged', () => {
  const r = []; for (let i = 0; i < 9; i++) r.push(Q(i, 'PG,SG,SF,PF,C', 60 - i));
  r.push(Q(20, 'C', 10, { injury: 'Out' }));
  for (let i = 0; i < 6; i++) r.push(Q(30 + i, 'PG', 5 - i * 0.1));
  const a = L.assignSlots(r, LP);
  eq(a.starters.filter(s => s.player).length, 9);
  eq(a.il.map(p => p.id), ['20', '35']); eq(a.bench.length, 5); eq(a.ilHealthy, 1);
  ok(L.balanceWarnings(r.slice(0, 15), LP, { available: [] }).every(w => !/NaN/.test(w.text)));
});

console.log('scarcity + runs');
t('slotSupply counts eligibles in the top N', () => {
  const av = [Q(1, 'C', 60), Q(2, 'PG', 59), Q(3, 'PF,C', 58), Q(4, 'SF', 57), Q(5, 'PG,SG', 56)];
  const s = L.slotSupply(av, LP, 4);
  eq(s.left, { PG: 1, SG: 0, G: 1, SF: 1, PF: 1, F: 2, C: 2, UTIL: 4 });
});
t('slotPulse flags a run on C and C scarcity', () => {
  const all = []; for (let i = 0; i < 100; i++) all.push(Q(i, i % 10 === 0 ? 'C' : ['PG', 'SG', 'SF', 'PF'][i % 4], 100 - i));
  const recent = [Q(900, 'C', 1), Q(901, 'C', 1), Q(902, 'C', 1), Q(903, 'C', 1), Q(904, 'PG', 1), Q(905, 'SG', 1), Q(906, 'SF', 1), Q(907, 'PF', 1), Q(908, 'PG', 1), Q(909, 'SG', 1), Q(910, 'SF', 1), Q(911, 'PF', 1)];
  const avail = all.filter(p => p.pos[0] !== 'C' || +p.id > 80); // only ~2 C left near the top
  const pulse = L.slotPulse(avail, recent, all, LP, 40);
  const c = pulse.find(x => x.slot === 'C'), pg = pulse.find(x => x.slot === 'PG');
  eq(c.recent, 4); eq(c.run, true); eq(c.left, 0); eq(c.scarce, true);
  eq(pg.run, false); eq(pg.scarce, false);
  eq(pulse.map(x => x.slot), ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C']);
});

console.log('recommendation (242808)');
function boardFixture() {
  const POS = ['PG', 'SG', 'SF', 'PF', 'C', 'PG,SG', 'SG,SF', 'SF,PF', 'PF,C'];
  const out = []; for (let i = 0; i < 120; i++) out.push(Q(i, POS[i % POS.length], 70 - i * 0.4, { tier: 1 + Math.floor(i / 12), ceiling: 80 - i * 0.4 + (i % 5) }));
  return out;
}
t('open C slot + thin C pool → recommends a C with the scarcity reason', () => {
  const roster = [Q('r1', 'PG', 60), Q('r2', 'SG', 59), Q('r3', 'PG,SG', 58), Q('r4', 'SF', 57), Q('r5', 'PF', 56), Q('r6', 'SF,PF', 55), Q('r7', 'PG', 54), Q('r8', 'SF', 53)];
  const avail = [Q(1, 'SG', 52), Q(2, 'SF', 51.8), Q(3, 'C', 50), Q(4, 'PG', 49.5)].concat(boardFixture().filter(p => p.pos.indexOf('C') < 0).map(p => Object.assign({}, p, { hsValue: p.hsValue - 30 })));
  const b = L.bestAvailable(avail, roster, LP, { picksUntilNext: 11, nextPick: 44, limit: 3 });
  eq(b[0].player.id, '3'); eq(b[0].slot, 'C');
  ok(/^Fills open C slot; 1 C-eligible left in top 40/.test(b[0].reason), b[0].reason);
  ok(/#44/.test(b[0].reason), b[0].reason);
});
t('all starters full → upgrade or bench, never NaN', () => {
  const roster = []; ['PG', 'SG', 'PG,SG', 'SF', 'PF', 'SF,PF', 'C', 'C', 'PF,C'].forEach((p, i) => roster.push(Q('s' + i, p, 40)));
  const b = L.bestAvailable([Q(1, 'C', 45), Q(2, 'PG', 20)], roster, LP, { picksUntilNext: 5 });
  eq(b[0].player.id, '1'); eq(b[0].upgrade, true); ok(/^Upgrades your (C|UTIL) \(\+5\.0\)/.test(b[0].reason), b[0].reason);
  eq(b[1].slot, 'BENCH');
});
t('recommendation is deterministic regardless of input order', () => {
  const av = boardFixture(), roster = [Q('r1', 'C', 60), Q('r2', 'PG', 58)];
  const a = L.bestAvailable(av, roster, LP, { picksUntilNext: 11, limit: 5 });
  const shuffled = av.slice().reverse();
  const b = L.bestAvailable(shuffled, roster.slice().reverse(), LP, { picksUntilNext: 11, limit: 5 });
  eq(a.map(x => x.player.id + '|' + x.reason), b.map(x => x.player.id + '|' + x.reason));
  // value ties break by id
  const tie = L.bestAvailable([Q('b', 'PG', 50), Q('a', 'PG', 50)], [], LP, { picksUntilNext: 0 });
  eq(tie[0].player.id, 'a');
});
t('catch-up warning: no C with 4 picks left', () => {
  const roster = []; ['PG', 'SG', 'PG,SG', 'SF', 'PF', 'SF,PF', 'PG', 'SG', 'SF', 'PF', 'PG', 'SG'].forEach((p, i) => roster.push(Q('c' + i, p, 50 - i)));
  const w = L.balanceWarnings(roster, LP, { available: [] });
  ok(w.some(x => x.level === 'warn' && /^Catch-up: no C yet · 4 picks left$/.test(x.text)), JSON.stringify(w));
  // 1 pick left, still 1 open starter slot... and 2 open → danger
  const r2 = roster.concat([Q('x1', 'PG', 1), Q('x2', 'PG', 1), Q('x3', 'PG', 1)]);
  const w2 = L.balanceWarnings(r2, LP, { available: [] });
  ok(w2.some(x => x.level === 'danger' && /no C yet · 1 pick left/.test(x.text)), JSON.stringify(w2));
});
t('performance: 200-player board, 15-man roster, recommendation < 250ms', () => {
  const av = []; const POS = ['PG', 'SG', 'SF', 'PF', 'C', 'PG,SG', 'SG,SF', 'SF,PF', 'PF,C'];
  for (let i = 0; i < 200; i++) av.push(Q(i, POS[i % 9], 80 - i * 0.3));
  const roster = av.splice(0, 15);
  const t0 = Date.now();
  L.bestAvailable(av, roster, LP, { picksUntilNext: 11, limit: 3 }); L.balanceWarnings(roster, LP, { available: av, players: av });
  ok(Date.now() - t0 < 250, 'took ' + (Date.now() - t0) + 'ms');
});

console.log('cheat sheet');
t('rounds 1-16 for slot 5 at pick 1, with targets near each pick + by-slot tiers', () => {
  const av = boardFixture();
  const st = Object.assign({}, LP, { mySlot: 5 });
  const cs = L.cheatSheet({ available: av, settings: st, cur: 1, myPicks: L.myPicksSnake(st, 1), roster: [], perRound: 5 });
  eq(cs.rounds.length, 16); eq(cs.rounds[0].pick, 5); eq(cs.rounds[1].pick, 20);
  eq(cs.rounds[0].targets.map(x => x.player.id), ['2', '3', '4', '5', '6']);
  ok(cs.rounds[0].targets.every(x => x.need.length > 0), 'empty roster: everyone fills a need');
  eq(cs.bySlot.map(s => s.slot), ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C']);
  ok(cs.bySlot.find(s => s.slot === 'C').tiers[0].players.every(p => L.canFill(p, 'C', st)));
  ok(cs.bySlot.find(s => s.slot === 'F').tiers.every(t => t.players.every(p => p.pos.join() !== 'C')), 'C-only never listed under F');
});
t('cheat sheet mixes made picks (done) with remaining ones in pick order', () => {
  const av = boardFixture(), st = Object.assign({}, LP, { mySlot: 1 });
  const cs = L.cheatSheet({ available: av.slice(30), settings: st, cur: 26, myPicks: L.myPicksSnake(st, 26), made: [{ pick: 1, round: 1, player: av[0] }, { pick: 24, round: 2, player: av[1] }, { pick: 25, round: 3, player: av[2] }], roster: av.slice(0, 3) });
  eq(cs.rounds.length, 16); eq(cs.rounds.slice(0, 4).map(r => [r.pick, r.done]), [[1, true], [24, true], [25, true], [48, false]]);
});

console.log('fuzz');
t('no NaN / no throw on junk players, rosters and settings', () => {
  let seed = 99; const r = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const junkPos = [undefined, null, '', 'PG', ['C'], 'F/C', 'XX', ['SG', 'SF'], 42, 'G,F'];
  const junkVal = [undefined, null, NaN, Infinity, -5, 0, 33.3, '40', 55];
  const settingsList = [LP, DEF, {}, { slots: { PG: 2, C: 2 }, bench: 0, il: 0, teams: 3 }, { slots: { G: 0, F: 0, UTIL: 0 } }, { teams: 'x', slots: null }];
  for (let n = 0; n < 60; n++) {
    const players = [];
    for (let i = 0; i < 40; i++) {
      const p = { id: 'f' + n + '_' + i, name: 'F' + i, pos: junkPos[Math.floor(r() * junkPos.length)], hsValue: junkVal[Math.floor(r() * junkVal.length)], ceiling: junkVal[Math.floor(r() * junkVal.length)], tier: r() < 0.5 ? undefined : 2, injury: r() < 0.2 ? 'Out' : null };
      if (r() < 0.3) p.yahooElig = r() < 0.5 ? ['C', 'junk', 'UTIL'] : [];
      if (r() < 0.3) p.vorp = junkVal[Math.floor(r() * junkVal.length)];
      players.push(p);
    }
    const st = settingsList[n % settingsList.length];
    const roster = players.slice(0, Math.floor(r() * 18)), avail = players.slice(roster.length);
    const a = L.assignSlots(roster, st);
    ok(isFinite(a.total), 'total ' + a.total);
    const b = L.bestAvailable(avail, roster, st, { picksUntilNext: Math.floor(r() * 20), limit: 5 });
    b.forEach(x => { ok(isFinite(x.score) && isFinite(x.gain) && isFinite(x.vona), 'score ' + JSON.stringify(x)); ok(!/NaN|undefined/.test(x.reason), x.reason); });
    L.balanceWarnings(roster, st, { available: avail, players }).forEach(w => ok(!/NaN|undefined/.test(w.text), w.text));
    L.slotPulse(avail, roster.slice(0, 12), players, st, 40).forEach(x => ok(isFinite(x.left) && isFinite(x.recent), JSON.stringify(x)));
    const ns = L.normalizeSettings(st);
    const cs = L.cheatSheet({ available: avail, settings: st, cur: 1 + Math.floor(r() * 50), myPicks: L.myPicksSnake(ns, 1), roster });
    ok(cs.rounds.length === L.rosterSize(ns), 'rounds ' + cs.rounds.length);
  }
});
t('settingsSource survives a round trip; anything else resets to null', () => {
  const st = L.emptyState(null, LP); st.settingsSource = 'user';
  eq(L.deserializeState(L.serializeState(st), null).settingsSource, 'user');
  st.settingsSource = 'bogus';
  eq(L.deserializeState(L.serializeState(st), null).settingsSource, null);
  eq(L.deserializeState(L.serializeState(st), null).settings.il, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
