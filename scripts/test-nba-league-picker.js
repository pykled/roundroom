#!/usr/bin/env node
/* Tests for Yahoo league selection + league support flags + /status problem
   mapping (nba/pages/draft-logic.js: leagueChoice, leagueSupport, leagueSummary,
   yahooProblem) and the slot picker sized from the chosen league.
   Run: node scripts/test-nba-league-picker.js   (exit 0 = all pass) */
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

const HS = { league_key: '466.l.1', name: 'High Score', num_teams: 10, draft_status: 'predraft', scoring_type: 'headpoint' };
const CAT = { league_key: '466.l.2', name: 'Office Cats', num_teams: 12, draft_status: 'predraft', scoring_type: 'head' };
const ROTO = { league_key: '466.l.3', name: 'Roto', num_teams: 8, draft_status: 'postdraft', scoring_type: 'roto' };

console.log('leagueChoice');
t('zero leagues: none', () => eq(L.leagueChoice([], null), { mode: 'none', key: null }));
t('zero leagues ignores a stale pref', () => eq(L.leagueChoice([], '466.l.9'), { mode: 'none', key: null }));
t('one league: auto-select', () => eq(L.leagueChoice([HS], null), { mode: 'auto', key: '466.l.1' }));
t('several, nothing saved: ask', () => eq(L.leagueChoice([HS, CAT], null), { mode: 'pick', key: null }));
t('several, saved choice still on the account: use it', () => eq(L.leagueChoice([HS, CAT], '466.l.2'), { mode: 'saved', key: '466.l.2' }));
t('saved choice no longer on the account: ask again', () => eq(L.leagueChoice([HS, CAT], '466.l.9'), { mode: 'pick', key: null }));
t('saved stale + one league: auto', () => eq(L.leagueChoice([HS], '466.l.9'), { mode: 'auto', key: '466.l.1' }));
t('manual board chosen before: respected', () => eq(L.leagueChoice([HS, CAT], ''), { mode: 'manual', key: null }));
t('entries without league_key are ignored', () => eq(L.leagueChoice([{ name: 'x' }, HS], null), { mode: 'auto', key: '466.l.1' }));

console.log('leagueSupport');
t('H2H points (High Score): recos on', () => eq(L.leagueSupport(HS), { recos: true, kind: null, label: 'H2H points' }));
t('season points: recos on', () => eq(L.leagueSupport({ scoring_type: 'point' }).recos, true));
t('H2H categories: recos off, flagged', () => eq(L.leagueSupport(CAT), { recos: false, kind: 'categories', label: 'H2H categories' }));
t('roto: recos off', () => eq(L.leagueSupport(ROTO).kind, 'categories'));
t('scoring_type in settings block also read', () => eq(L.leagueSupport({ settings: { scoring_type: 'roto' } }).kind, 'categories'));
t('auction wins over scoring', () => eq(L.leagueSupport(Object.assign({ is_auction_draft: 1 }, CAT)).kind, 'auction'));
t('auction from draft results', () => eq(L.leagueSupport(HS, { picks: [{ pick: 1, cost: 12 }] }).kind, 'auction'));
t('unknown scoring: recos on (no guess)', () => eq(L.leagueSupport({}).recos, true));
t('no league (manual board): recos on', () => eq(L.leagueSupport(null).recos, true));

console.log('leagueSummary');
t('teams · status · scoring', () => eq(L.leagueSummary(CAT), '12 teams · Draft not started · H2H categories'));
t('drafted roto', () => eq(L.leagueSummary(ROTO), '8 teams · Drafted · Rotisserie'));
t('missing fields are skipped', () => eq(L.leagueSummary({ name: 'x' }), ''));

console.log('yahooProblem');
t('connected: none', () => eq(L.yahooProblem({ connected: true, leagues: [] }), null));
t('not connected, no error: none', () => eq(L.yahooProblem({ connected: false }), null));
t('Yahoo refuses the app: blocked', () => eq(L.yahooProblem({ connected: false, httpStatus: 503, code: 'yahoo_app_blocked' }), 'blocked'));
t('upstream 5xx: down', () => eq(L.yahooProblem({ connected: false, httpStatus: 502, code: 'yahoo_upstream' }), 'down'));
t('legacy bare 502: down', () => eq(L.yahooProblem({ connected: false, httpStatus: 502 }), 'down'));
t('network failure: down', () => eq(L.yahooProblem({ connected: false, httpStatus: 0 }), 'down'));
t('expired token: reauth', () => eq(L.yahooProblem({ connected: false, reauth: true }), 'reauth'));
t('signed out: signin', () => eq(L.yahooProblem({ connected: false, httpStatus: 401 }), 'signin'));

console.log('slot picker follows the chosen league');
[[HS, 10], [CAT, 12], [ROTO, 8]].forEach(([lg, n]) => t(lg.name + ': ' + n + ' slot chips', () => {
  const st = L.settingsFromYahoo(lg, null, [], L.DEFAULT_SETTINGS);
  eq(st.teams, n);
  eq(L.slotPickerView(st, {}).chips.length, n);
}));
t('draft_position from THIS league sets the slot', () => {
  const teams = [{ team_key: '466.l.2.t.1', draft_position: 3 }, { team_key: '466.l.2.t.7', draft_position: 11 }];
  const st = L.settingsFromYahoo(CAT, '466.l.2.t.7', teams, L.DEFAULT_SETTINGS);
  eq(st.mySlot, 11);
  eq(L.yahooSlotKnown({ live: true, myTeamKey: '466.l.2.t.7', teams, settings: st }), true);
});
t('different roster slots per league', () => {
  const a = L.settingsFromYahoo(Object.assign({ roster_positions: [{ position: 'PG', count: 1 }, { position: 'SG', count: 1 }, { position: 'C', count: 2 }, { position: 'Util', count: 2 }, { position: 'BN', count: 3 }] }, CAT), null, [], L.DEFAULT_SETTINGS);
  eq(a.slots, { PG: 1, SG: 1, C: 2, UTIL: 2 }); eq(a.bench, 3);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
