#!/usr/bin/env node
/* Tests for the "Which pick are you?" draft-slot chooser (nba/pages/draft-logic.js:
   yahooSlotKnown, slotPickerView, slotChosen persistence) + snake order per slot.
   Run: node scripts/test-nba-slot-picker.js   (exit 0 = all pass) */
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

const S12 = L.normalizeSettings(L.DEFAULT_SETTINGS); // 12 teams, league 242808 shape
const range = n => Array.from({ length: n }, (_, i) => i + 1);

console.log('picker view');
t('manual board, nothing chosen: chips 1..teams', () => {
  const v = L.slotPickerView(S12, { yahooKnown: false, chosen: false });
  eq(v.mode, 'pick'); eq(v.chips, range(12)); eq(v.teams, 12);
});
[8, 10, 12].forEach(n => t(n + ' teams: one chip per team', () => {
  const st = L.normalizeSettings(Object.assign({}, S12, { teams: n }));
  eq(L.slotPickerView(st, {}).chips, range(n));
}));
t('chosen: collapsed (no chips) with the slot', () => {
  const v = L.slotPickerView(Object.assign({}, S12, { mySlot: 7 }), { chosen: true });
  eq(v.mode, 'chosen'); eq(v.slot, 7); eq(v.chips, []);
});
t('chosen + Change tapped: chips again', () => eq(L.slotPickerView(S12, { chosen: true, open: true }).mode, 'pick'));
t('Yahoo-synced: no chips, shows synced slot', () => {
  const v = L.slotPickerView(Object.assign({}, S12, { mySlot: 4 }), { yahooKnown: true, chosen: false, open: true });
  eq(v.mode, 'yahoo'); eq(v.slot, 4); eq(v.chips, []);
});

console.log('yahoo slot-known signal');
const teams = [{ team_key: 'a', draft_position: '' }, { team_key: 'me', draft_position: '' }];
t('not connected: never known', () => eq(L.yahooSlotKnown({ live: false, myTeamKey: 'me', teams: [{ team_key: 'me', draft_position: 3 }], settings: S12 }), false));
t('live, no draft_position/order/picks: unknown -> picker shows', () => eq(L.yahooSlotKnown({ live: true, myTeamKey: 'me', teams, settings: S12, yahoo: { picks: [] }, picks: [] }), false));
t('live, my draft_position: known', () => eq(L.yahooSlotKnown({ live: true, myTeamKey: 'me', teams: [{ team_key: 'me', draft_position: '5' }], settings: S12 }), true));
t('draft_position out of range ignored', () => eq(L.yahooSlotKnown({ live: true, myTeamKey: 'me', teams: [{ team_key: 'me', draft_position: '15' }], settings: S12 }), false));
t('live, my team in Yahoo pick order: known', () => eq(L.yahooSlotKnown({ live: true, myTeamKey: 'me', teams, settings: S12, yahoo: { order: [{ pick: 1, team_key: 'a' }, { pick: 2, team_key: 'me' }] } }), true));
t('order slot = my round-1 pick in Yahoo order', () => eq(L.yahooOrderSlot({ order: [{ pick: 1, team_key: 'a' }, { pick: 2, team_key: 'me' }, { pick: 3, team_key: 'me' }] }, 'me', 2), 2));
t('order with only later-round (traded) picks of mine: unknown', () => {
  const y = { order: [{ pick: 1, team_key: 'a' }, { pick: 2, team_key: 'a' }, { pick: 3, team_key: 'me' }] };
  eq(L.yahooOrderSlot(y, 'me', 2), null);
  eq(L.yahooSlotKnown({ live: true, myTeamKey: 'me', teams, settings: L.normalizeSettings({ teams: 2 }), yahoo: y }), false);
});
t('live, Yahoo pick credited to me: known', () => eq(L.yahooSlotKnown({ live: true, myTeamKey: 'me', teams, settings: S12, picks: [{ source: 'yahoo', mine: true, slot: 2 }] }), true));
t('manual pick of mine does not count', () => eq(L.yahooSlotKnown({ live: true, myTeamKey: 'me', teams, settings: S12, picks: [{ source: 'manual', mine: true }] }), false));
t('settingsFromYahoo keeps a chosen slot when Yahoo has no draft_position', () => {
  const base = Object.assign({}, S12, { mySlot: 9 });
  eq(L.settingsFromYahoo({ num_teams: 12 }, 'me', teams, base).mySlot, 9);
});

console.log('persistence');
t('slotChosen + mySlot survive serialize/deserialize', () => {
  const st = L.emptyState(null, S12);
  eq(st.slotChosen, false);
  st.settings = L.normalizeSettings(Object.assign({}, S12, { mySlot: 11 })); st.slotChosen = true;
  const back = L.deserializeState(L.serializeState(st), null, L.DEFAULT_SETTINGS);
  eq(back.slotChosen, true); eq(back.settings.mySlot, 11);
});
t('older saved board (no slotChosen): picker shows', () => {
  const raw = JSON.parse(L.serializeState(L.emptyState(null, S12))); delete raw.slotChosen;
  eq(L.deserializeState(JSON.stringify(raw), null, L.DEFAULT_SETTINGS).slotChosen, false);
});
t('league profile keeps the chosen slot', () => {
  eq(L.settingsFromProfile({ teams: 12, slots: { PG: 1, C: 1, UTIL: 2, BN: 5 } }, Object.assign({}, S12, { mySlot: 6 })).mySlot, 6);
});

console.log('snake order per slot');
[8, 10, 12].forEach(n => {
  const st = L.normalizeSettings(Object.assign({}, S12, { teams: n, rounds: 4 }));
  t(n + ' teams, first slot', () => eq(L.picksForSlot(1, n, 4), [1, 2 * n, 2 * n + 1, 4 * n]));
  t(n + ' teams, last slot', () => eq(L.picksForSlot(n, n, 4), [n, n + 1, 3 * n, 3 * n + 1]));
  const mid = n / 2;
  t(n + ' teams, middle slot ' + mid, () => eq(L.picksForSlot(mid, n, 4), [mid, 2 * n - mid + 1, 2 * n + mid, 4 * n - mid + 1]));
  t(n + ' teams: every pick in snakeOrder owned by exactly its slot', () => {
    L.snakeOrder(n, 4).forEach(o => { if (L.picksForSlot(o.slot, n, 4).indexOf(o.pick) < 0) throw new Error('pick ' + o.pick); });
  });
  t(n + ' teams: next pick after choosing slot ' + mid + ' from pick 1', () => eq(L.nextPickFor(mid, 1, st), mid));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
