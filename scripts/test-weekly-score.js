#!/usr/bin/env node
// Unit checks for shared/weekly-score.js. Run: node scripts/test-weekly-score.js
const assert = require('assert');
const W = require('../shared/weekly-score.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// --- sample-size weighting
near(W.seasonWeight(0), 0);
near(W.seasonWeight(1), 0.125);
near(W.seasonWeight(4), 0.5);
near(W.seasonWeight(8), 1);
near(W.seasonWeight(12), 1);

// --- matchup: neutral placeholder (no team data) → 1.0, flagged placeholder
const placeholder = { positions: { WR: 13 }, current: { WR: {} }, historical: { WR: {} } };
let m = W.matchupMultiplier('WR', 'KC', placeholder, 1);
near(m.mult, 1); assert.strictEqual(m.source, 'placeholder');
m = W.matchupMultiplier('WR', null, placeholder, 1);
near(m.mult, 1); assert.strictEqual(m.source, 'neutral');

// --- matchup: 4 teams with data, rank 1 → 1.2, rank 4 → 0.8, middle linear
const fpa = {
  positions: { WR: 13 },
  historical: { WR: { A: 20, B: 16, C: 12, D: 8 } },
  current: { WR: { A: 8, B: 16, C: 12, D: 20 } },   // this season flips A and D
};
m = W.matchupMultiplier('WR', 'A', fpa, 0);           // week 1: 100% historical → A is best
near(m.mult, 1.2); assert.strictEqual(m.rank, 1); assert.strictEqual(m.source, 'live');
m = W.matchupMultiplier('WR', 'D', fpa, 0);
near(m.mult, 0.8); assert.strictEqual(m.rank, 4);
m = W.matchupMultiplier('WR', 'A', fpa, 8);           // week 9+: 100% current → A is worst
near(m.mult, 0.8);
m = W.matchupMultiplier('WR', 'A', fpa, 4);           // 50/50 → A = 14, B = 16, C = 12, D = 14 → tie for 2nd/3rd
near(W.effectiveFPA(fpa, 'WR', 'A', 4), 14);
near(m.mult, 1.2 - (2.5 - 1) / 3 * 0.4);
// team with current data but no history leans on the neutral baseline
const partial = { positions: { WR: 13 }, historical: { WR: {} }, current: { WR: { A: 21, B: 5 } } };
near(W.effectiveFPA(partial, 'WR', 'A', 1), 0.125 * 21 + 0.875 * 13);

// --- vegas
let v = W.vegasMultiplier('KC', null); near(v.mult, 1); assert.strictEqual(v.source, 'neutral');
v = W.vegasMultiplier('KC', { KC: 22 }); near(v.mult, 1); assert.strictEqual(v.source, 'live');
v = W.vegasMultiplier('KC', { KC: 30 }); near(v.mult, 1.2);      // capped
v = W.vegasMultiplier('KC', { KC: 14 }); near(v.mult, 0.85);     // capped
const ip = W.impliedPoints(47, -3);                              // home favoured by 3
near(ip.home, 25); near(ip.away, 22);

// --- form
const hist = [
  { week: 3, actual: 20, projected: 10 },  // 2.0x
  { week: 2, actual: 10, projected: 10 },  // 1.0x
  { week: 1, actual: 5, projected: 10 },   // 0.5x
];
let f = W.formMultiplier(hist, 0); near(f.mult, 1); assert.strictEqual(f.source, 'neutral');
f = W.formMultiplier(hist, 1); near(f.mult, 1);                  // one completed week → still 0 strength
f = W.formMultiplier(hist, 4);                                   // full strength
// weighted actual = .5*20+.3*10+.2*5 = 14, projected = 10 → 1.4 capped to 1.25
near(f.ratio, 1.25); near(f.mult, 1.25); assert.strictEqual(f.games, 3);
f = W.formMultiplier(hist, 2);                                   // 1/3 strength → 1 + 0.25/3
near(f.mult, 1 + 0.25 / 3);
// bye/DNP weeks are skipped and the weights renormalised
f = W.formMultiplier([{ week: 3, actual: null, projected: 10 }, { week: 2, actual: 9, projected: 10 }], 4);
near(f.ratio, 0.9); assert.strictEqual(f.games, 1);
f = W.formMultiplier([{ week: 3, actual: 2, projected: 10 }], 4);
near(f.mult, 0.8);                                               // floor
f = W.formMultiplier([], 6); near(f.mult, 1);

// --- injury
const defInj = { DEN: [
  { name: 'Pat Surtain', pos: 'CB', slot: 'LCB', order: 1, status: 'Out' },
  { name: 'Backup LB', pos: 'LB', slot: 'MLB', order: 2, status: 'Out' },
  { name: 'Safety Q', pos: 'DB', slot: 'FS', order: 1, status: 'Questionable' },
] };
let i = W.injuryModifier(null, 'WR', 'DEN', defInj); near(i.mult, 1.1); assert.strictEqual(i.defender.name, 'Pat Surtain');
i = W.injuryModifier(null, 'TE', 'DEN', defInj); near(i.mult, 1);        // LB is order 2, S only questionable
i = W.injuryModifier(null, 'QB', 'DEN', defInj); near(i.mult, 1);        // QB has no key-defender rule
i = W.injuryModifier('Questionable', 'WR', 'DEN', defInj); near(i.mult, 0.85 * 1.1);
i = W.injuryModifier('Doubtful', 'WR', 'KC', {}); near(i.mult, 0.5);
i = W.injuryModifier('Out', 'WR', 'DEN', defInj); near(i.mult, 0); assert.strictEqual(i.boost, 1);
i = W.injuryModifier('IR', 'RB', null, null); near(i.mult, 0);
i = W.injuryModifier('NA', 'RB', null, null); near(i.mult, 1);            // non-medical status ignored

// --- home / away
let ha = W.homeAwayMultiplier(true); near(ha.mult, 1.03); assert.strictEqual(ha.source, 'live');
ha = W.homeAwayMultiplier(false); near(ha.mult, 0.98);
ha = W.homeAwayMultiplier(null); near(ha.mult, 1); assert.strictEqual(ha.source, 'neutral');
ha = W.homeAwayMultiplier(undefined); near(ha.mult, 1); assert.strictEqual(ha.source, 'neutral');

// --- short week (Sleeper dates are YYYY-MM-DD; 2026-09-17 is a Thursday)
let r0;
let sw =W.shortWeekMultiplier('2026-09-17'); near(sw.mult, 0.94); assert.strictEqual(sw.source, 'live'); assert.strictEqual(sw.label, 'TNF');
sw = W.shortWeekMultiplier('2026-09-20'); near(sw.mult, 1); assert.strictEqual(sw.source, 'neutral');   // Sunday
sw = W.shortWeekMultiplier('2026-09-21'); near(sw.mult, 1);                                             // Monday
sw = W.shortWeekMultiplier(null); near(sw.mult, 1); assert.strictEqual(sw.source, 'neutral');
sw = W.shortWeekMultiplier('not a date'); near(sw.mult, 1); assert.strictEqual(sw.source, 'neutral');
sw = W.shortWeekMultiplier('2026-09-10', 0); near(sw.mult, 1); assert.strictEqual(sw.source, 'neutral');   // Thursday opener, full offseason rest
sw = W.shortWeekMultiplier('2026-09-17', 1); near(sw.mult, 0.94);
r0 = W.computeLineupScore({ id: '1', position: 'WR', team: 'SF', injuryStatus: null }, { weeksPlayed: 0, base: 10, opponent: 'LAR', gameDate: '2026-09-10' });
near(r0.score, 10); assert.strictEqual(r0.factors.shortWeek.source, 'neutral');

// --- weather
let wx = W.weatherMultiplier(null, 'WR'); near(wx.mult, 1); assert.strictEqual(wx.source, 'neutral');
wx = W.weatherMultiplier({ windspeed: 30, precip: 90, indoor: true }, 'WR'); near(wx.mult, 1);          // dome
wx = W.weatherMultiplier({ windspeed: 10, precip: 20, indoor: false }, 'WR'); near(wx.mult, 1); assert.strictEqual(wx.source, 'neutral');
wx = W.weatherMultiplier({ windspeed: 16, precip: 0, indoor: false }, 'WR'); near(wx.mult, 0.94); assert.strictEqual(wx.source, 'live'); assert.strictEqual(wx.label, 'WX');
wx = W.weatherMultiplier({ windspeed: 21, precip: 0, indoor: false }, 'QB'); near(wx.mult, 0.89);
wx = W.weatherMultiplier({ windspeed: 26, precip: 0, indoor: false }, 'TE'); near(wx.mult, 0.82);
wx = W.weatherMultiplier({ windspeed: 26, precip: 60, indoor: false }, 'TE'); near(wx.mult, 0.82 * 0.95);
wx = W.weatherMultiplier({ windspeed: 5, precip: 60, indoor: false }, 'WR'); near(wx.mult, 0.95);       // rain only
wx = W.weatherMultiplier({ windspeed: 21, precip: 60, indoor: false }, 'RB'); near(wx.mult, 1.04);      // RBs: wind bump, no rain penalty
wx = W.weatherMultiplier({ windspeed: 18, precip: 0, indoor: false }, 'RB'); near(wx.mult, 1);
wx = W.weatherMultiplier({ windspeed: 30, precip: 90, indoor: false }, 'K'); near(wx.mult, 1);          // no rule for K/DEF

// --- composite
let r = W.computeLineupScore({ id: '1', position: 'WR', team: 'KC', injuryStatus: null },
  { week: 5, weeksPlayed: 4, base: 12, opponent: 'DEN', fpa: placeholder, vegas: null, defInjuries: defInj, history: hist });
near(r.score, 12 * 1.25 * 1.1); assert.strictEqual(r.bye, false);
// new factors stack multiplicatively after injury
r = W.computeLineupScore({ id: '1', position: 'WR', team: 'KC', injuryStatus: null },
  { week: 5, weeksPlayed: 4, base: 12, opponent: 'DEN', fpa: placeholder, vegas: null, defInjuries: defInj, history: hist,
    isHome: false, gameDate: '2026-10-01', weather: { windspeed: 22, precip: 10, indoor: false } });
near(r.score, 12 * 1.25 * 1.1 * 0.98 * 0.94 * 0.89);
assert.strictEqual(r.factors.homeAway.source, 'live'); assert.strictEqual(r.factors.shortWeek.source, 'live'); assert.strictEqual(r.factors.weather.source, 'live');
// bye week: new factors stay neutral even if stale context is passed
r = W.computeLineupScore({ id: '1', position: 'WR', team: 'KC', injuryStatus: null },
  { weeksPlayed: 4, base: 12, opponent: null, isHome: true, gameDate: '2026-10-01', weather: { windspeed: 30, indoor: false } });
near(r.score, 0); assert.strictEqual(r.factors.homeAway.source, 'neutral'); assert.strictEqual(r.factors.weather.source, 'neutral');
r = W.computeLineupScore({ id: '1', position: 'WR', team: 'KC', injuryStatus: null }, { weeksPlayed: 4, base: 12, opponent: null });
near(r.score, 0); assert.strictEqual(r.bye, true);
r = W.computeLineupScore({ id: '1', position: 'WR', team: 'KC', injuryStatus: null }, { weeksPlayed: 0, base: 12 });
near(r.score, 12); assert.strictEqual(r.bye, false);              // schedule unknown → no bye handling
r = W.computeLineupScore({ id: '1', position: 'DEF', team: 'KC', injuryStatus: null }, { weeksPlayed: 4, base: 7, opponent: 'DEN', defInjuries: defInj });
near(r.score, 7);

// --- recommend
assert.strictEqual(W.recommend(true, 1, []), 'start');
assert.strictEqual(W.recommend(false, 9.5, [10, 14]), 'consider');
assert.strictEqual(W.recommend(false, 8.9, [10, 14]), 'sit');
assert.strictEqual(W.recommend(false, 0, [10]), 'sit');
assert.strictEqual(W.recommend(false, 12, []), 'sit');

assert.strictEqual(W.pct(1.1), '+10%');
assert.strictEqual(W.pct(0.85), '-15%');
assert.strictEqual(W.pct(1), '0%');

console.log('weekly-score: all checks passed');
