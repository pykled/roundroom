#!/usr/bin/env node
/* Tests for the draft board's pick-clock Pause/Resume and Reset Clock / Reset
   Draft logic (nba/pages/draft-logic.js: pauseClock, resumeClock, resetClock,
   advanceClock, clockView, serializeClock/restoreClock, resetDraftState).
   Run: node scripts/test-nba-clock.js   (exit 0 = all pass) */
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

const T0 = 1760000000000, SECS = 90, FULL = 90000, LK = '466.l.242808';
const running = (pick, startedAt) => ({ pick, startedAt, pausedLeft: null });
// Round trip through storage, as a reload does.
const reload = (c, lk, pick, now) => L.restoreClock(L.serializeClock(c, lk), lk, pick, SECS, now);

console.log('pause / resume maths');
t('pause freezes the time left', () => {
  const p = L.pauseClock(running(5, T0), SECS, T0 + 42300);
  eq(p, { pick: 5, startedAt: 0, pausedLeft: 47700 });
  eq(L.clockView(p, SECS, T0 + 999999), { paused: true, running: false, left: 48, level: 'paused', text: '0:48' }, 'no time passes while paused');
});
t('resume continues from the paused time', () => {
  const p = L.pauseClock(running(5, T0), SECS, T0 + 42300);
  const r = L.resumeClock(p, SECS, T0 + 600000);
  eq(r.pausedLeft, null); eq(r.pick, 5);
  eq(L.clockLeftMs(r, SECS, T0 + 600000), 47700, 'same time left at the moment of resume');
  eq(L.clockView(r, SECS, T0 + 600000 + 10000).left, 38, 'then counts down again');
});
t('pause then resume repeatedly loses no time', () => {
  let c = running(1, T0), now = T0;
  for (let i = 0; i < 5; i++) { now += 3000; c = L.pauseClock(c, SECS, now); now += 60000; c = L.resumeClock(c, SECS, now); }
  eq(L.clockLeftMs(c, SECS, now), FULL - 15000);
});
t('pause is idempotent; resume of a running clock is a no-op', () => {
  const p = L.pauseClock(running(2, T0), SECS, T0 + 1000);
  eq(L.pauseClock(p, SECS, T0 + 50000), p);
  const r = running(2, T0); eq(L.resumeClock(r, SECS, T0 + 5), r);
});
t('pausing an idle clock holds the full time; resume starts it', () => {
  const p = L.pauseClock(L.newClock(1), SECS, T0);
  eq(p.pausedLeft, FULL); eq(L.clockView(p, SECS, T0).text, '1:30');
  eq(L.resumeClock(p, SECS, T0 + 5000), running(1, T0 + 5000));
});
t('pausing after expiry holds 0:00 (never negative)', () => {
  const p = L.pauseClock(running(3, T0), SECS, T0 + 200000);
  eq(p.pausedLeft, 0); eq(L.clockView(p, SECS, T0).text, '0:00');
  eq(L.clockView(L.resumeClock(p, SECS, T0 + 1), SECS, T0 + 1).level, 'expired');
});
t('running clockView matches timerState (+ paused:false)', () => {
  eq(L.clockView(running(1, T0), SECS, T0 + 5000), Object.assign({ paused: false }, L.timerState(T0, SECS, T0 + 5000)));
  eq(L.clockView(L.newClock(1), SECS, T0).level, 'idle');
});
t('timer off (0 s): paused clock reads off', () => eq(L.clockView({ pick: 1, startedAt: 0, pausedLeft: 5000 }, 0, T0).level, 'off'));

console.log('reset clock');
t('running: restarts at the full time from now', () => eq(L.resetClock(running(7, T0), SECS, T0 + 80000), running(7, T0 + 80000)));
t('paused: back to the full time, still paused', () => {
  const r = L.resetClock({ pick: 7, startedAt: 0, pausedLeft: 3000 }, SECS, T0);
  eq(r, { pick: 7, startedAt: 0, pausedLeft: FULL });
  eq(L.clockView(r, SECS, T0 + 100000).text, '1:30');
});
t('idle: reset starts it', () => eq(L.resetClock(L.newClock(1), SECS, T0), running(1, T0)));

console.log('picks recorded while paused');
t('next pick starts paused at the full time', () => {
  const p = L.pauseClock(running(4, T0), SECS, T0 + 30000);
  eq(L.advanceClock(p, 5, SECS, T0 + 90000), { pick: 5, startedAt: 0, pausedLeft: FULL });
});
t('several picks while paused: still paused', () => {
  let c = L.pauseClock(running(4, T0), SECS, T0 + 1000);
  [5, 6, 7].forEach(n => { c = L.advanceClock(c, n, SECS, T0 + n * 1000); });
  eq(L.isPaused(c), true); eq(c.pick, 7); eq(c.pausedLeft, FULL);
});
t('undo while paused (pick goes back): still paused', () => {
  const c = L.advanceClock({ pick: 6, startedAt: 0, pausedLeft: 1000 }, 5, SECS, T0);
  eq(c, { pick: 5, startedAt: 0, pausedLeft: FULL });
});
t('running: the next pick starts now (unchanged behaviour)', () => eq(L.advanceClock(running(4, T0), 5, SECS, T0 + 7000), running(5, T0 + 7000)));
t('same pick: unchanged', () => { const c = running(4, T0); eq(L.advanceClock(c, 4, SECS, T0 + 7000), c); });

console.log('reload persistence');
t('paused survives a reload with the same time left, hours later', () => {
  const p = L.pauseClock(running(9, T0), SECS, T0 + 20000);
  eq(reload(p, LK, 9, T0 + 3 * 3600e3), { pick: 9, startedAt: 0, pausedLeft: 70000 });
});
t('paused + the board moved on (other tab / reload): paused at full time for the new pick', () => {
  const p = L.pauseClock(running(9, T0), SECS, T0 + 20000);
  eq(reload(p, LK, 10, T0 + 5000), { pick: 10, startedAt: 0, pausedLeft: FULL });
});
t('running survives a reload for the same pick', () => eq(reload(running(9, T0), LK, 9, T0 + 30000), running(9, T0)));
t('running, stale (pick time + 60 s ago): null → caller restarts', () => eq(reload(running(9, T0), LK, 9, T0 + (SECS + 61) * 1000), null));
t('running, different pick: null', () => eq(reload(running(9, T0), LK, 10, T0 + 1000), null));
t('idle record restores idle', () => eq(reload(L.newClock(1), null, 1, T0), L.newClock(1)));
t('resumed after a reload counts on from the paused time', () => {
  const p = reload(L.pauseClock(running(2, T0), SECS, T0 + 10000), LK, 2, T0 + 999999);
  eq(L.clockLeftMs(L.resumeClock(p, SECS, T0 + 999999), SECS, T0 + 999999 + 5000), 75000);
});
t('corrupt / foreign / wrong version: null, never throws', () => {
  eq(L.restoreClock('{oops', LK, 1, SECS, T0), null);
  eq(L.restoreClock(null, LK, 1, SECS, T0), null);
  eq(L.restoreClock(JSON.stringify({ v: 2, leagueKey: LK, pick: 1, pausedLeft: 5 }), LK, 1, SECS, T0), null);
  eq(L.restoreClock({ v: 1, leagueKey: LK, pick: 1, startedAt: T0 + 5000, pausedLeft: null }, LK, 1, SECS, T0), null, 'future start');
});
t('paused time is clamped to the (possibly shortened) pick time', () => {
  const raw = L.serializeClock({ pick: 3, startedAt: 0, pausedLeft: 80000 }, LK);
  eq(L.restoreClock(raw, LK, 3, 30, T0).pausedLeft, 30000);
});

console.log('per-league isolation');
t('clock keys are per league, manual board has its own', () => {
  eq(L.clockKey(LK), 'pocket-nba-clock:' + LK); eq(L.clockKey(null), 'pocket-nba-clock:manual');
  eq(L.clockKey('466.l.1') === L.clockKey(LK), false);
  eq(L.clockKey(LK) === L.storageKey(LK), false, 'clock never overwrites board state');
});
t("another league's paused clock is ignored", () => {
  const raw = L.serializeClock({ pick: 4, startedAt: 0, pausedLeft: 5000 }, '466.l.1');
  eq(L.restoreClock(raw, LK, 4, SECS, T0), null);
  eq(L.restoreClock(raw, null, 4, SECS, T0), null, 'manual board');
});

console.log('reset draft');
const S12 = L.normalizeSettings(Object.assign({}, L.DEFAULT_SETTINGS, { mySlot: 7 }));
function board(lk) {
  const st = L.emptyState(lk, S12);
  st.slotChosen = true; st.settingsSource = 'user';
  st.manual = [{ playerId: '1', mine: false, at: 1 }, { playerId: '2', mine: false, at: 2 }, { playerId: '3', mine: true, at: 3 }];
  st.overrides = { 'y.p.9': '44' };
  st.yahoo = { status: 'drafting', picks: [{ pick: 1 }], unmatched: [] };
  return st;
}
t('count = picks recorded on this device', () => { eq(L.resetDraftCount(board(LK)), 3); eq(L.resetDraftCount(L.emptyState(null)), 0); eq(L.resetDraftCount(null), 0); });
t('clears picks + overrides, keeps slot, settings, league, Yahoo data', () => {
  const before = board(LK), r = L.resetDraftState(before, T0);
  eq(r.cleared, 3); eq(r.state.manual, []); eq(r.state.overrides, {});
  eq(r.state.settings, S12); eq(r.state.settings.mySlot, 7); eq(r.state.slotChosen, true); eq(r.state.settingsSource, 'user');
  eq(r.state.leagueKey, LK); eq(r.state.yahoo, before.yahoo);
  eq(before.manual.length, 3, 'input not mutated');
});
t('after reset the board is back at pick 1 (manual)', () => {
  const r = L.resetDraftState(board(null), T0);
  eq(L.mergePicks(r.state.yahoo, r.state.manual, { settings: r.state.settings }).picks.filter(p => p.source === 'manual').length, 0);
});
t('undo restores exactly the cleared picks', () => {
  const before = board(LK), r = L.resetDraftState(before, T0);
  const u = L.undoResetDraft(r.state, r.undo, T0 + 1);
  eq(u.manual, before.manual); eq(u.overrides, before.overrides); eq(u.settings, before.settings);
});
t('reset state round-trips through storage', () => {
  const r = L.resetDraftState(board(LK), T0);
  const back = L.deserializeState(L.serializeState(r.state), LK, L.DEFAULT_SETTINGS);
  eq(back.manual, []); eq(back.settings.mySlot, 7); eq(back.slotChosen, true);
});
t("resetting one league leaves other leagues' saved boards and clocks alone", () => {
  const store = {};
  [LK, '466.l.1', null].forEach(k => { store[L.storageKey(k)] = L.serializeState(board(k)); store[L.clockKey(k)] = L.serializeClock({ pick: 4, startedAt: 0, pausedLeft: 5000 }, k); });
  const snap = Object.assign({}, store);
  // what draft.js does: reset this league's state + clock only
  const cur = L.deserializeState(store[L.storageKey(LK)], LK, L.DEFAULT_SETTINGS);
  store[L.storageKey(LK)] = L.serializeState(L.resetDraftState(cur, T0).state);
  store[L.clockKey(LK)] = L.serializeClock(L.newClock(1), LK);
  Object.keys(snap).forEach(k => { if (k !== L.storageKey(LK) && k !== L.clockKey(LK)) eq(store[k], snap[k], k); });
  eq(L.deserializeState(store[L.storageKey(LK)], LK, L.DEFAULT_SETTINGS).manual, []);
  eq(L.deserializeState(store[L.storageKey('466.l.1')], '466.l.1', L.DEFAULT_SETTINGS).manual.length, 3);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
