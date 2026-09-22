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
// The rank→multiplier swing is damped by seasonWeight (0 at week 1, full from week 9),
// so the ranking is visible at week 1 but the multiplier stays 1.0.
m = W.matchupMultiplier('WR', 'A', fpa, 0);           // week 1: 100% historical → A is best
near(m.mult, 1); assert.strictEqual(m.rank, 1); assert.strictEqual(m.source, 'live');
m = W.matchupMultiplier('WR', 'D', fpa, 0);
near(m.mult, 1); assert.strictEqual(m.rank, 4);
m = W.matchupMultiplier('WR', 'A', fpa, 8);           // week 9+: 100% current → A is worst, full swing
near(m.mult, 0.8);
m = W.matchupMultiplier('WR', 'D', fpa, 8);
near(m.mult, 1.2);
m = W.matchupMultiplier('WR', 'B', fpa, 8);           // rank 2 of 4 at full weight → 1.2 − 1/3 × 0.4
near(m.mult, 1.2 - 0.4 / 3);
m = W.matchupMultiplier('WR', 'A', fpa, 4);           // 50/50 → A = 14, B = 16, C = 12, D = 14 → tie for 2nd/3rd
near(W.effectiveFPA(fpa, 'WR', 'A', 4), 14);
near(m.mult, 1 + (1.2 - (2.5 - 1) / 3 * 0.4 - 1) * 0.5);   // raw 1.0, half damped → 1.0
// team with current data but no history leans on the neutral baseline
const partial = { positions: { WR: 13 }, historical: { WR: {} }, current: { WR: { A: 21, B: 5 } } };
near(W.effectiveFPA(partial, 'WR', 'A', 1), 0.125 * 21 + 0.875 * 13);

// --- vegas
let v = W.vegasMultiplier('KC', null); near(v.mult, 1); assert.strictEqual(v.source, 'neutral');
v = W.vegasMultiplier('KC', { KC: 23.5 }); near(v.mult, 1); assert.strictEqual(v.source, 'live'); // fallback baseline 23.5
v = W.vegasMultiplier('KC', { KC: 30 }); near(v.mult, 1.2);      // capped
v = W.vegasMultiplier('KC', { KC: 14 }); near(v.mult, 0.85);     // capped
// dynamic per-week baseline: multiplier is relative to the supplied league mean
v = W.vegasMultiplier('KC', { KC: 24 }, 24); near(v.mult, 1);    // exactly at the week's mean → neutral
v = W.vegasMultiplier('KC', { KC: 26.4 }, 24); near(v.mult, 1.1); // 10% above the mean
v = W.vegasMultiplier('KC', { KC: 21.6 }, 24); near(v.mult, 0.9); // 10% below the mean
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
let ha = W.homeAwayMultiplier(true); near(ha.mult, 1.025); assert.strictEqual(ha.source, 'live');
ha = W.homeAwayMultiplier(false); near(ha.mult, 0.975);
// home + away average to exactly 1.0 → no net league-wide inflation
near((W.homeAwayMultiplier(true).mult + W.homeAwayMultiplier(false).mult) / 2, 1);
ha = W.homeAwayMultiplier(null); near(ha.mult, 1); assert.strictEqual(ha.source, 'neutral');
ha = W.homeAwayMultiplier(undefined); near(ha.mult, 1); assert.strictEqual(ha.source, 'neutral');

// --- short week (Sleeper dates are YYYY-MM-DD; 2026-09-17 is a Thursday)
let r0;
let sw =W.shortWeekMultiplier('2026-09-17'); near(sw.mult, 0.98); assert.strictEqual(sw.source, 'live'); assert.strictEqual(sw.label, 'TNF');
sw = W.shortWeekMultiplier('2026-09-20'); near(sw.mult, 1); assert.strictEqual(sw.source, 'neutral');   // Sunday
sw = W.shortWeekMultiplier('2026-09-21'); near(sw.mult, 1);                                             // Monday
sw = W.shortWeekMultiplier(null); near(sw.mult, 1); assert.strictEqual(sw.source, 'neutral');
sw = W.shortWeekMultiplier('not a date'); near(sw.mult, 1); assert.strictEqual(sw.source, 'neutral');
sw = W.shortWeekMultiplier('2026-09-10', 0); near(sw.mult, 1); assert.strictEqual(sw.source, 'neutral');   // Thursday opener, full offseason rest
sw = W.shortWeekMultiplier('2026-09-17', 1); near(sw.mult, 0.98);
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

// --- usage (recent share vs season share)
const uWR = { recent: { tgtShare: 0.30, carryShare: 0, snapPct: 0.85, games: 2 }, season: { tgtShare: 0.20, carryShare: 0, snapPct: 0.85, games: 5 } };
let u = W.usageMultiplier(null, 'WR', 6); near(u.mult, 1); assert.strictEqual(u.source, 'neutral');
u = W.usageMultiplier(uWR, 'WR', 1); near(u.mult, 1); assert.strictEqual(u.source, 'neutral');   // ≤1 completed week → silent
u = W.usageMultiplier(uWR, 'WR', 6); near(u.mult, 1.08); assert.strictEqual(u.source, 'live');  // +10 pts share → full +8%
u = W.usageMultiplier(uWR, 'WR', 2); near(u.mult, 1 + 0.08 / 3);                                 // 1/3 strength at 2 completed weeks
u = W.usageMultiplier({ recent: { tgtShare: 0.27, snapPct: 0.8, games: 2 }, season: { tgtShare: 0.20, snapPct: 0.8, games: 5 } }, 'TE', 6);
near(u.mult, 1 + 0.08 * 0.4);                                                                    // +7 pts → 40% of the ramp
u = W.usageMultiplier({ recent: { tgtShare: 0.24, snapPct: 0.8, games: 2 }, season: { tgtShare: 0.20, snapPct: 0.8, games: 5 } }, 'WR', 6);
near(u.mult, 1); assert.strictEqual(u.source, 'neutral');                                        // +4 pts → inside the deadband
u = W.usageMultiplier({ recent: { tgtShare: 0.10, snapPct: 0.8, games: 2 }, season: { tgtShare: 0.20, snapPct: 0.8, games: 5 } }, 'WR', 6);
near(u.mult, 0.96);                                                                              // −10 pts → milder −4%
// snap-share drop: −20 pp → a third of the way from 15 to 30 → −2%
u = W.usageMultiplier({ recent: { tgtShare: 0.2, snapPct: 0.60, games: 2 }, season: { tgtShare: 0.2, snapPct: 0.80, games: 5 } }, 'WR', 6);
near(u.mult, 1 - 0.06 / 3); assert.strictEqual(u.source, 'live');
u = W.usageMultiplier({ recent: { tgtShare: 0.2, snapPct: 0.40, games: 2 }, season: { tgtShare: 0.2, snapPct: 0.80, games: 5 } }, 'WR', 6);
near(u.mult, 0.94);                                                                              // −40 pp → capped −6%
// RB reads carry share, ignores target share
u = W.usageMultiplier({ recent: { tgtShare: 0.30, carryShare: 0.55, snapPct: 0.7, games: 2 }, season: { tgtShare: 0.10, carryShare: 0.45, snapPct: 0.7, games: 5 } }, 'RB', 6);
near(u.mult, 1.08);
u = W.usageMultiplier({ recent: { tgtShare: 0.30, carryShare: 0.45, snapPct: 0.7, games: 2 }, season: { tgtShare: 0.10, carryShare: 0.45, snapPct: 0.7, games: 5 } }, 'RB', 6);
near(u.mult, 1);
// share loss + snap drop multiply (−4% × −6%), sitting just above the 0.90 floor
u = W.usageMultiplier({ recent: { carryShare: 0.30, snapPct: 0.30, games: 2 }, season: { carryShare: 0.45, snapPct: 0.80, games: 5 } }, 'RB', 6);
near(u.mult, 0.96 * 0.94);
// QB has no share rule but still gets the snap concern
u = W.usageMultiplier({ recent: { snapPct: 0.50, games: 2 }, season: { snapPct: 1.0, games: 5 } }, 'QB', 6);
near(u.mult, 0.94);
u = W.usageMultiplier({ recent: { games: 0 }, season: { tgtShare: 0.2, games: 5 } }, 'WR', 6); near(u.mult, 1);   // missed both recent games

// --- game script (own implied − opponent implied ≈ spread)
const lines = { KC: 28, DEN: 20, SF: 24, LAR: 22, NYJ: 18.5, MIA: 24.5 };
let g = W.gameScriptMultiplier('KC', 'DEN', lines, 'RB'); near(g.mult, 1.03); assert.strictEqual(g.source, 'live'); near(g.spread, 8);
g = W.gameScriptMultiplier('KC', 'DEN', lines, 'WR'); near(g.mult, 0.98);
g = W.gameScriptMultiplier('DEN', 'KC', lines, 'WR'); near(g.mult, 1.04);
g = W.gameScriptMultiplier('DEN', 'KC', lines, 'TE'); near(g.mult, 1.04);
g = W.gameScriptMultiplier('DEN', 'KC', lines, 'RB'); near(g.mult, 0.97);
g = W.gameScriptMultiplier('KC', 'DEN', lines, 'QB'); near(g.mult, 1); assert.strictEqual(g.source, 'neutral');
g = W.gameScriptMultiplier('SF', 'LAR', lines, 'RB'); near(g.mult, 1); assert.strictEqual(g.source, 'neutral');   // 2-pt line → no lean
g = W.gameScriptMultiplier('MIA', 'NYJ', lines, 'RB'); near(g.mult, 1 + 0.03 * (6 - 3.5) / 3.5);                   // 6-pt line → partial
g = W.gameScriptMultiplier('KC', null, lines, 'RB'); near(g.mult, 1); assert.strictEqual(g.source, 'neutral');
g = W.gameScriptMultiplier('KC', 'DEN', null, 'RB'); near(g.mult, 1); assert.strictEqual(g.source, 'neutral');
// a favourite's RB bump and its opponent's RB cut are symmetric around 1.0
near((W.gameScriptMultiplier('KC', 'DEN', lines, 'RB').mult + W.gameScriptMultiplier('DEN', 'KC', lines, 'RB').mult) / 2, 1);

// --- composite
let r = W.computeLineupScore({ id: '1', position: 'WR', team: 'KC', injuryStatus: null },
  { week: 5, weeksPlayed: 4, base: 12, opponent: 'DEN', fpa: placeholder, vegas: null, defInjuries: defInj, history: hist });
near(r.score, 12 * 1.25 * 1.1); assert.strictEqual(r.bye, false);
// new factors stack multiplicatively after injury
r = W.computeLineupScore({ id: '1', position: 'WR', team: 'KC', injuryStatus: null },
  { week: 5, weeksPlayed: 4, base: 12, opponent: 'DEN', fpa: placeholder, vegas: null, defInjuries: defInj, history: hist,
    isHome: false, gameDate: '2026-10-01', weather: { windspeed: 22, precip: 10, indoor: false } });
near(r.score, 12 * 1.25 * 1.1 * 0.975 * 0.98 * 0.89);   // away = 0.975 since the home/away recentering
assert.strictEqual(r.factors.homeAway.source, 'live'); assert.strictEqual(r.factors.shortWeek.source, 'live'); assert.strictEqual(r.factors.weather.source, 'live');
assert.strictEqual(r.factors.usage.source, 'neutral'); assert.strictEqual(r.factors.gameScript.source, 'neutral');
// usage + game script stack in too (WR on a 7-pt underdog with a +10 pt target-share bump)
r = W.computeLineupScore({ id: '1', position: 'WR', team: 'DEN', injuryStatus: null },
  { weeksPlayed: 6, base: 12, opponent: 'KC', vegas: { KC: 28, DEN: 20 }, vegasAvg: 24, usage: uWR });
near(r.score, 12 * 0.85 * 1.08 * 1.04);   // vegas 20/24 clamps to 0.85; isHome not supplied → HA neutral
assert.strictEqual(r.factors.usage.source, 'live'); assert.strictEqual(r.factors.gameScript.source, 'live');
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

// --- step-up (vacated volume from an injured same-position teammate)
const hallOut = { id: 'hall', name: 'Breece Hall', status: 'Out', usage: { recent: { games: 2, carryShare: 0.6, snapPct: 0.7 }, season: { games: 2, carryShare: 0.6, snapPct: 0.7 } } };
let su = W.stepUpMultiplier([hallOut], 'RB', 2);
near(su.mult, 1.14); assert.strictEqual(su.source, 'live');            // 60% share → capped at +14% (0.35 × 0.4)
su = W.stepUpMultiplier([{ ...hallOut, usage: { recent: { games: 2 }, season: { games: 2, carryShare: 0.25, snapPct: 0.3 } } }], 'RB', 2);
near(su.mult, 1.10);                                                   // 25% of carries → +10%
assert.ok(/Breece Hall out/.test(su.detail));
// WR/TE read target share; RB share is ignored for a WR
su = W.stepUpMultiplier([{ id: 'w', name: 'X', status: 'IR', usage: { recent: { games: 1 }, season: { games: 3, tgtShare: 0.2, carryShare: 0.9, snapPct: 0.3 } } }], 'WR', 1);
near(su.mult, 1.08);
// freshness: played only 1 of the 2 recent weeks → half weight; 0 of 2 → neutral (already re-projected)
su = W.stepUpMultiplier([{ ...hallOut, usage: { recent: { games: 1 }, season: { games: 4, carryShare: 0.25, snapPct: 0.4 } } }], 'RB', 2);
near(su.mult, 1.05); assert.ok(/50% weight/.test(su.detail));
// snap share never inflates the vacated volume: 25% carries at 70% snaps is still +10%
su = W.stepUpMultiplier([{ ...hallOut, usage: { recent: { games: 2 }, season: { games: 4, carryShare: 0.25, snapPct: 0.7 } } }], 'RB', 2);
near(su.mult, 1.10);
su = W.stepUpMultiplier([{ ...hallOut, usage: { recent: { games: 0 }, season: { games: 4, carryShare: 0.25, snapPct: 0.6 } } }], 'RB', 2);
near(su.mult, 1); assert.strictEqual(su.source, 'neutral');
// depth piece (low share, low snaps) vacates nothing; Questionable teammate is not out
su = W.stepUpMultiplier([{ ...hallOut, usage: { recent: { games: 2 }, season: { games: 2, carryShare: 0.08, snapPct: 0.2 } } }], 'RB', 2);
near(su.mult, 1);
su = W.stepUpMultiplier([{ ...hallOut, status: 'Questionable' }], 'RB', 2);
near(su.mult, 1);
// snaps alone never qualify: 88% of snaps but 8% of targets (live PIT WR case) → nothing vacated
su = W.stepUpMultiplier([{ id: 'p', name: 'P', status: 'Out', usage: { recent: { games: 1 }, season: { games: 1, tgtShare: 0.08, snapPct: 0.88 } } }], 'WR', 1);
near(su.mult, 1); assert.strictEqual(su.source, 'neutral');
// every-down player with a moderate share (12% targets, 70% snaps) qualifies, and only his touch share is vacated: +4.8%
su = W.stepUpMultiplier([{ id: 't', name: 'T', status: 'Out', usage: { recent: { games: 2 }, season: { games: 2, tgtShare: 0.12, snapPct: 0.7 } } }], 'TE', 2);
near(su.mult, 1.048);
// same share on a part-time player (12% targets, 40% snaps) does not
su = W.stepUpMultiplier([{ id: 't', name: 'T', status: 'Out', usage: { recent: { games: 2 }, season: { games: 2, tgtShare: 0.12, snapPct: 0.4 } } }], 'TE', 2);
near(su.mult, 1);
// two injured backs stack but stay capped
su = W.stepUpMultiplier([hallOut, { ...hallOut, id: 'b', name: 'B', usage: { recent: { games: 2 }, season: { games: 2, carryShare: 0.2, snapPct: 0.3 } } }], 'RB', 2);
near(su.mult, 1.14); assert.strictEqual(su.teammates.length, 2);
// no usage record → neutral; QB/K/DEF have no rule; missing list → neutral
su = W.stepUpMultiplier([{ id: 'n', name: 'N', status: 'Out', usage: null }], 'RB', 2); near(su.mult, 1);
su = W.stepUpMultiplier([hallOut], 'QB', 2); near(su.mult, 1); assert.strictEqual(su.source, 'neutral');
su = W.stepUpMultiplier(null, 'RB', 2); near(su.mult, 1);
// composite: step-up multiplies in, and is skipped on a bye like everything else
r = W.computeLineupScore({ id: '2', position: 'RB', team: 'NYJ', injuryStatus: null },
  { weeksPlayed: 2, base: 10, opponent: 'MIA', teammatesOut: [hallOut], recentWindow: 2 });
near(r.score, 10 * 1.14); assert.strictEqual(r.factors.stepUp.source, 'live');
r = W.computeLineupScore({ id: '2', position: 'RB', team: 'NYJ', injuryStatus: null },
  { weeksPlayed: 2, base: 10, opponent: null, teammatesOut: [hallOut], recentWindow: 2 });
near(r.score, 0);

// --- game lock (kickoff passed or Sleeper says started)
const t0 = Date.parse('2026-09-20T17:00:00+00:00');
assert.strictEqual(W.isGameLocked(null, t0), false);                                   // bye / unknown
assert.strictEqual(W.isGameLocked({ kickoff: '2026-09-20T17:00:00+00:00', started: false, status: 'pre_game' }, t0 - 1000), false);
assert.strictEqual(W.isGameLocked({ kickoff: '2026-09-20T17:00:00+00:00', started: false, status: 'pre_game' }, t0), true);
assert.strictEqual(W.isGameLocked({ kickoff: '2026-09-20T17:00:00+00:00', started: true, status: 'pre_game' }, t0 - 1e6), true);   // Sleeper flag wins
assert.strictEqual(W.isGameLocked({ kickoff: null, started: false, status: 'complete' }, t0), true);
assert.strictEqual(W.isGameLocked({ kickoff: null, started: false, status: 'in_game' }, t0), true);
assert.strictEqual(W.isGameLocked({ kickoff: null, started: false, status: 'pre_game' }, t0), false);
assert.strictEqual(W.isGameLocked({ kickoff: 'garbage', status: 'pre_game' }, t0), false);
assert.strictEqual(W.isGameLocked({ date: '2026-09-20', status: 'pre_game' }, t0), false);   // old schedule shape (no kickoff) never locks

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
