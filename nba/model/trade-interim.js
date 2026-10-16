// Interim stand-ins for two Stream A shared-layer functions, used by the trade
// engine (Stream B) ONLY while nba/model/signals.js and roster-analysis.js still
// throw NOT_IMPLEMENTED. Same shapes as the contract (docs/nba-trade-team-spec.md
// §3.3 / §3.4; fixtures in docs/nba-spec/fixtures/), computed from what the board
// and the committed logs already carry.
//
//   signalsFor(players, ctx)  → Map<id, Signals>      (ctx.board = full board for the market curve)
//   analyzeRoster({ players, profile, weeks, replacement, leagueAvg?, strongCutoff?, currentWeek?, board? }) → RosterAnalysis
//
// Known gaps vs A (deliberate, so nothing is guessed): no ESPN return dates
// (availability.eta is null; an injured player's return week is read off the
// board's own hsByWeek ramp and flagged out-until-wkN), no back-to-backs, no bio
// (age/exp null), injured[].lostThisWeek and injuryExposure null. trade.js calls
// A's functions first and only lands here on NOT_IMPLEMENTED, so this file is
// dead code once A merges and can be deleted then.
'use strict';
const R = require('./roster-slots');
const Sc = require('./score');
const { logStats } = require('./research');
const { availability: weekAvailability } = require('./board');
const { dayToDate, epochDay } = require('./sleeper');
const SIG = require('./signals');
const RA = require('./roster-analysis');

const fin = x => typeof x === 'number' && Number.isFinite(x);
const num = x => (fin(x) ? x : 0);
const r1 = x => (fin(x) ? Math.round(x * 10) / 10 : null);
const r2 = x => (fin(x) ? Math.round(x * 100) / 100 : null);
const r3 = x => (fin(x) ? Math.round(x * 1000) / 1000 : null);
const SLOT_ORDER = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'FC', 'UTIL'];
const INJURED_RE = /^(OUT|O|IR|IL|INJ|SUS|OFS)$/i;
const SCHEDULE_FLAG_GAP = 0.25;  // games per week above/below the league mean → heavy/light schedule flag
const RETURN_SHARE = 0.6;        // back "near full value" at ≥ 60% of his healthy week value (trade-logic injuryReturn)

/* ------------------------------------------------------------ signals */

// Board sorted by hsValue → value at a (possibly fractional) market rank.
const curves = new WeakMap();
function valueCurve(board) {
  if (!Array.isArray(board) || !board.length) return null;
  let c = curves.get(board);
  if (!c) { c = board.map(p => num(p.hsValue)).sort((a, b) => b - a); curves.set(board, c); }
  return c;
}
function impliedValue(rank, curve, replacement) {
  if (!fin(rank) || rank < 1 || !curve || !curve.length) return null;
  if (rank > curve.length) return fin(replacement) ? replacement : curve[curve.length - 1];
  const lo = Math.floor(rank), hi = Math.min(curve.length, Math.ceil(rank));
  return curve[lo - 1] + (curve[hi - 1] - curve[lo - 1]) * (rank - lo);
}

// League mean games per week over the horizon, by team schedule (board teams).
const schedMeans = new WeakMap();
function leagueGamesPerWeek(board, weeks) {
  if (!Array.isArray(board) || !board.length || !weeks.length) return null;
  const key = weeks.map(w => w.week).join(',');
  let m = schedMeans.get(board);
  if (!m) { m = new Map(); schedMeans.set(board, m); }
  if (m.has(key)) return m.get(key);
  const byTeam = new Map();
  for (const p of board) {
    if (!p.team || byTeam.has(p.team) || !p.gamesByWeek) continue;
    byTeam.set(p.team, weeks.reduce((s, w) => s + num(p.gamesByWeek[w.week]), 0) / weeks.length);
  }
  const vals = [...byTeam.values()];
  const v = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  m.set(key, v);
  return v;
}

function marketRow(p, market) {
  if (p.marketRank != null) {
    return { rank: p.marketRank, adpDelta: p.adpDelta ?? null, label: p.label || null, contested: !!p.contested, thin: !!p.marketThin,
      confidence: fin(p.marketConfidence) ? p.marketConfidence : null, yahooPreRank: p.yahooPreRank ?? null, pctRos: p.yahooPctRos ?? null };
  }
  const rows = market && Array.isArray(market.rows) ? market.rows : null;
  if (!rows) return null;
  let idx = marketIndex.get(market);
  if (!idx) { idx = new Map(rows.filter(r => r && r.id != null).map(r => [String(r.id), r])); marketIndex.set(market, idx); }
  const r = idx.get(String(p.id));
  if (!r || r.marketRank == null) return null;
  return { rank: r.marketRank, adpDelta: r.adpDelta ?? null, label: r.label || null, contested: !!r.contested, thin: !!r.thin,
    confidence: fin(r.confidence) ? r.confidence : null, yahooPreRank: r.yahooPreRank ?? null, pctRos: r.yahooPctRos ?? null };
}
const marketIndex = new WeakMap();

// One season's compact rows for a player, ascending by day.
function seasonRows(logs, pid, season) {
  for (const f of logs || []) if (Number(f.season) === season && f.players && f.players[pid]) return (f.players[pid].g || []).filter(Sc.hasLine).slice().sort((a, b) => a[0] - b[0]);
  return [];
}
function statSeasonOf(logs, pid) {
  const seasons = (logs || []).map(f => Number(f.season)).filter(Number.isInteger).sort((a, b) => b - a);
  for (const s of seasons) if (seasonRows(logs, pid, s).length >= SIG.FORM_GAMES) return s;
  return null;
}

// First horizon week an injured player is back near full value on the board's own ramp.
function modelReturnWeek(p, weeks, cw) {
  const st = String(p.injury || '').trim();
  if (p.outForSeason || !INJURED_RE.test(st) || !p.hsByWeek) return null;
  const vals = weeks.map(w => num(p.hsByWeek[w.week]));
  const healthy = Math.max(0, ...vals);
  if (!(healthy > 0) || !(num(p.hsByWeek[cw]) < 0.3 * healthy)) return null;
  for (const w of weeks) if (w.week > cw && num(p.hsByWeek[w.week]) >= RETURN_SHARE * healthy) return w.week;
  return null;
}

function playerSignals(p, ctx) {
  const profile = ctx.profile;
  const weeks = Array.isArray(ctx.weeks) ? ctx.weeks : [];
  const cw = Number(ctx.currentWeek) || (weeks[0] && weeks[0].week) || 1;
  const pid = String(p.id);
  const hs = p.hsByWeek || {}, gb = p.gamesByWeek || {};
  const wSum = weeks.reduce((s, w) => s + num(w.weight), 0);
  const ros = wSum > 0 ? weeks.reduce((s, w) => s + num(w.weight) * num(hs[w.week]), 0) / wSum : num(p.hsValue);
  const todayDay = /^\d{4}-\d{2}-\d{2}/.test(String(ctx.today || '')) ? epochDay(String(ctx.today).slice(0, 10)) : null;
  const elig = profile ? [...R.eligFor(p, profile)].sort((a, b) => SLOT_ORDER.indexOf(a) - SLOT_ORDER.indexOf(b)) : (p.yahooElig || p.elig || []);

  // Form + minutes from one season of logs (the newest with ≥ 5 games).
  const statSeason = statSeasonOf(ctx.logs, pid);
  const rows = statSeason != null ? seasonRows(ctx.logs, pid, statSeason) : [];
  const st = rows.length && profile && profile.scoring ? logStats(rows, profile) : null;
  const lastDay = rows.length ? rows[rows.length - 1][0] : null;
  const stale = lastDay != null && todayDay != null ? todayDay - lastDay > SIG.STALE_DAYS : false;
  let form = null;
  if (st && st.gp >= SIG.FORM_MIN_SEASON_GAMES && st.mean >= SIG.FORM_MIN_MEAN) {
    const ratio = st.mean > 0 ? st.last5 / st.mean : null;
    form = {
      last5: r1(st.last5), seasonMean: r1(st.mean), ratio: r2(ratio), delta: r1(st.last5 - st.mean),
      label: ratio == null ? null : ratio >= SIG.FORM_HOT ? 'hot' : ratio <= SIG.FORM_COLD ? 'cold' : null,
      games: st.gp, lastGameDate: lastDay != null ? dayToDate(lastDay) : null, stale,
    };
  }
  const sp = ctx.proj && ctx.proj.seasonProj ? ctx.proj.seasonProj[pid] : null;
  const projected = sp && num(sp[1]) > 0 ? r1(sp[1]) : null;
  const mpg = st ? st.mpg : null;
  const minDelta = st ? st.minDelta : null;
  const minutes = {
    mpg: r1(mpg), last5: st ? r1(st.last5Min) : null, delta: r1(minDelta),
    trend: minDelta == null ? null : minDelta >= SIG.MINUTES_TREND ? 'up' : minDelta <= -SIG.MINUTES_TREND ? 'down' : 'flat',
    projected, roleShift: projected != null && mpg > 0 ? r3(Math.max(0.7, Math.min(1.4, projected / mpg))) : null,
  };

  // Availability: the board's per-week rule (no ESPN date in the interim layer).
  const a0 = fin(p.availability) ? p.availability : null;
  const byWeek = {};
  let missed = 0;
  for (const w of weeks) {
    const a = a0 == null ? (p.outForSeason ? 0 : 1) : weekAvailability({ injury: p.injury, injuryNotes: null, outForSeason: !!p.outForSeason }, a0, w.week - cw);
    byWeek[w.week] = r2(Math.max(0, Math.min(1, a)));
    missed += num(gb[w.week]) * (1 - byWeek[w.week]);
  }
  const injured = !!(p.injury && String(p.injury).trim());
  const availability = { a0, status: p.injury || null, bodyPart: p.injuryBody || null, notes: null, eta: null, outForSeason: !!p.outForSeason, byWeek, expectedGamesMissed: r1(missed) };

  const playoffWeeks = new Set(((profile && profile.weeks) || []).filter(w => w.playoffs).map(w => w.week));
  const inWeeks = weeks.map(w => num(gb[w.week]));
  const schedule = {
    gamesByWeek: { ...gb }, gamesRemaining: inWeeks.reduce((a, b) => a + b, 0), gamesThisWeek: num(gb[cw]),
    heavyWeeks: inWeeks.filter(n => n >= SIG.HEAVY_WEEK).length, lightWeeks: inWeeks.filter(n => n <= SIG.LIGHT_WEEK).length,
    playoffGames: [...playoffWeeks].reduce((s, w) => s + num(gb[w]), 0), b2bNext2: null,
  };

  const base = SIG.marketWeight(cw);
  const mk = marketRow(p, ctx.market);
  const repl = ctx.replacement && ctx.replacement.perWeek != null
    ? (typeof ctx.replacement.perWeek === 'object' ? (wSum > 0 ? weeks.reduce((s, w) => s + num(w.weight) * num(ctx.replacement.perWeek[w.week]), 0) / wSum : null) : num(ctx.replacement.perWeek))
    : null;
  const implied = mk ? impliedValue(mk.rank, valueCurve(ctx.board), repl) : null;
  const weight = mk ? base * (mk.contested || mk.thin ? 0.5 : 1) : base;
  const market = { rank: mk ? mk.rank : null, adpDelta: mk ? mk.adpDelta : null, label: mk ? mk.label : null, contested: !!(mk && mk.contested),
    confidence: mk ? mk.confidence : null, yahooPreRank: mk ? mk.yahooPreRank : null, pctRos: mk ? mk.pctRos : null, impliedValue: r1(implied), weight: r3(weight) };
  const blended = mk && implied != null ? (1 - weight) * ros + weight * implied : ros;

  const mean = num(p.mean);
  const value = {
    ros: r1(ros), now: r1(num(hs[cw])), next: hs[cw + 1] != null ? r1(num(hs[cw + 1])) : null,
    mean: r1(mean), sd: r1(num(p.sd)), ceiling: r1(num(p.ceiling)), floor: r1(num(p.floor)),
    cv: mean > 0 ? r3(num(p.sd) / mean) : null, ceilingShare: mean > 0 ? r3((num(p.ceiling) - mean) / mean) : null,
    vorp: fin(p.vorp) ? r1(p.vorp) : null, vorpRank: fin(p.vorpRank) ? p.vorpRank : null, rank: fin(p.rank) ? p.rank : null, tier: fin(p.tier) ? p.tier : null,
    blended: r1(blended),
  };
  const bioRow = ctx.bio && typeof ctx.bio.get === 'function' ? ctx.bio.get(pid) : ctx.bio && ctx.bio[pid];
  const bio = { age: bioRow && fin(bioRow.age) ? bioRow.age : null, exp: bioRow && fin(bioRow.exp) ? bioRow.exp : null, rookie: p.source === 'rookie' || !!(bioRow && bioRow.exp === 0) };

  let u = 0.1;
  if (p.source && p.source !== 'logs') u += 0.1;
  if (injured) u += availability.eta ? 0.04 : 0.08;
  if (num(p.sampleGames) < 20) u += 0.05;
  if (form && form.stale && p.source === 'logs') u += 0.05;

  const flags = [];
  if (form && form.label) flags.push(form.label);
  if (minutes.trend === 'up') flags.push('minutes-up');
  if (minutes.trend === 'down') flags.push('minutes-down');
  const back = modelReturnWeek(p, weeks, cw);
  if (back != null) flags.push(`out-until-wk${back}`);
  if (p.outForSeason) flags.push('ofs');
  const lg = leagueGamesPerWeek(ctx.board, weeks);
  if (lg != null && weeks.length) {
    const per = schedule.gamesRemaining / weeks.length;
    if (per >= lg + SCHEDULE_FLAG_GAP) flags.push('heavy-schedule');
    else if (per <= lg - SCHEDULE_FLAG_GAP) flags.push('light-schedule');
  }
  if (market.label === 'value') flags.push('market-value');
  if (market.label === 'reach') flags.push('market-reach');
  if (bio.rookie) flags.push('rookie');
  if (p.newTeam) flags.push('new-team');
  if (num(p.sampleGames) < 20 && p.source !== 'rookie') flags.push('thin-sample');
  if (stale) flags.push('stale-stats');

  return {
    id: pid, name: p.name || pid, team: p.team || null, pos: Array.isArray(p.pos) ? p.pos.slice() : [], elig,
    source: p.source || 'projection-only', sampleGames: Math.round(num(p.sampleGames)), statSeason,
    value, form, minutes, usage: { fga: null, fta: null, usageRate: null, trend: null },
    availability, schedule, market, bio, uncertainty: r2(Math.min(0.35, u)), flags,
  };
}

function signalsFor(players, ctx) {
  const out = new Map();
  for (const p of players || []) if (p && p.id != null) out.set(String(p.id), playerSignals(p, ctx || {}));
  return out;
}

/* ------------------------------------------------------------ roster analysis */

const GROUP_OF_SLOT = { PG: 'G', SG: 'G', G: 'G', SF: 'F', PF: 'F', F: 'F', C: 'C', FC: 'F', UTIL: 'UTIL' };

function analyzeRoster({ players, profile, weeks, replacement, leagueAvg = null, strongCutoff = null, currentWeek = null, board = null } = {}) {
  const list = (players || []).filter(Boolean);
  const wk = Array.isArray(weeks) && weeks.length ? weeks : [];
  const slotList = R.slotList(profile);
  const shares = R.benchShares(profile);
  const wSum = wk.reduce((s, w) => s + num(w.weight), 0) || 1;
  const rPer = (replacement && replacement.perWeek) || {};
  const rv = typeof rPer === 'object' ? wk.reduce((s, w) => s + num(w.weight) * num(rPer[w.week]), 0) / wSum : num(rPer);
  const avg = p => wk.reduce((s, w) => s + num(w.weight) * num((p.hsByWeek || {})[w.week]), 0) / wSum;
  const elig = new Map(list.map(p => [String(p.id), R.eligFor(p, profile)]));
  const byId = new Map(list.map(p => [String(p.id), p]));

  // Typical-week lineup on horizon-average values.
  const items = list.map(p => ({ id: String(p.id), elig: elig.get(String(p.id)), v: avg(p) })).sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
  const a = R.bestAssignment(items, slotList) || { slotOf: new Map(), starters: [] };
  const vOf = new Map(items.map(it => [it.id, it.v]));
  const starters = a.starters.map(s => ({ id: s.id, name: byId.get(s.id).name, slot: s.slot, value: r1(vOf.get(s.id)) }));
  const benchItems = items.filter(it => !a.slotOf.has(it.id));
  const bench = benchItems.map((it, i) => ({ id: it.id, name: byId.get(it.id).name, value: r1(it.v), share: i < shares.length ? shares[i] : 0 }));
  const holes = Math.max(0, slotList.length - starters.length);
  const benchValue = benchItems.reduce((s, it, i) => s + (i < shares.length ? shares[i] * Math.max(0, it.v - rv) : 0), 0);

  // Strength: horizon-weighted mean of the week value (lineup + open slots at replacement + bench shares).
  function weekValue(w) {
    const r = num(rPer[w]);
    const its = list.map(p => ({ id: String(p.id), elig: elig.get(String(p.id)), v: num((p.hsByWeek || {})[w]) })).sort((x, y) => y.v - x.v || (x.id < y.id ? -1 : 1));
    const lu = R.bestAssignment(its, slotList) || { slotOf: new Map(), total: 0 };
    const bn = its.filter(it => !lu.slotOf.has(it.id));
    const h = Math.max(0, slotList.length - lu.slotOf.size);
    let b = 0;
    bn.forEach((it, i) => { if (i < shares.length) b += shares[i] * Math.max(0, it.v - r); });
    return lu.total + h * r + b;
  }
  const strengthRos = wk.length ? wk.reduce((s, w) => s + num(w.weight) * weekValue(w.week), 0) / wSum : starters.reduce((s, x) => s + x.value, 0);
  const cw = currentWeek != null ? Number(currentWeek) : null;
  const strengthNow = cw != null && wk.some(w => w.week === cw) ? weekValue(cw) : null;

  const healthy = p => !R.ilEligible(p);
  const groups = {};
  for (const g of RA.GROUPS) {
    const gs = RA.GROUP_SLOTS[g];
    const slots = slotList.filter(s => gs.includes(s) || (g === 'F' && s === 'FC')).length;
    const isElig = p => { const e = elig.get(String(p.id)); return g === 'UTIL' ? true : gs.some(s => e.has(s)) || (g === 'F' && e.has('FC')); };
    const rostered = list.filter(p => healthy(p) && isElig(p)).length;
    const starterValue = starters.filter(s => GROUP_OF_SLOT[s.slot] === g).reduce((x, s) => x + s.value, 0);
    const nb = benchItems.filter(it => isElig(byId.get(it.id)));
    const la = leagueAvg && fin(leagueAvg[g]) ? leagueAvg[g] : null;
    const sc = strongCutoff && fin(strongCutoff[g]) ? strongCutoff[g] : null;
    // UTIL takes anyone, so its depth is never a need or a surplus by head count: quality decides.
    const tier = RA.assessTier(g === 'UTIL' ? slots + 1 : rostered, slots, starterValue, la, sc);
    groups[g] = { slots, rostered, starterValue: r1(starterValue), nextUp: nb.length ? r1(nb[0].v) : 0, leagueAvg: la, rank: null, tier, status: RA.tierStatus(tier) };
  }
  for (const g of RA.DISPLAY_GROUPS) {
    const slots = slotList.filter(s => s === g).length;
    const rostered = list.filter(p => healthy(p) && Array.isArray(p.pos) && p.pos[0] === g).length;
    const sv = starters.filter(s => s.slot === g).reduce((x, s) => x + s.value, 0);
    const tier = RA.assessTier(rostered, slots, sv, null, null);
    groups[g] = { slots, rostered, starterValue: r1(sv), nextUp: null, leagueAvg: null, rank: null, tier, status: RA.tierStatus(tier), _displayOnly: true };
  }
  const top24 = new Set((Array.isArray(board) ? board : []).filter(p => fin(p.rank) && p.rank <= 24).map(p => String(p.id)));
  return {
    lineup: { total: r1(starters.reduce((s, x) => s + x.value, 0)), starters, bench, holes },
    strengthRos: r1(strengthRos), strengthNow: r1(strengthNow), benchValue: r1(benchValue), replacement: r1(rv),
    groups,
    needs: RA.GROUPS.filter(g => groups[g].status === 'need'),
    surplus: RA.GROUPS.filter(g => groups[g].status === 'surplus'),
    elite: starters.filter(s => s.value >= RA.ELITE_VALUE || top24.has(s.id) || (fin(byId.get(s.id).rank) && byId.get(s.id).rank <= 24)).map(s => ({ id: s.id, name: s.name, value: s.value })),
    liabilities: starters.filter(s => s.value < rv + RA.LIABILITY_MARGIN).map(s => ({ id: s.id, name: s.name, slot: s.slot, value: s.value })),
    injured: list.filter(p => p.injury && String(p.injury).trim()).map(p => ({ id: String(p.id), name: p.name, status: p.injury, eta: null, lostThisWeek: null })),
    injuryExposure: { thisWeek: null, next2: null },
    gamesThisWeek: cw != null ? starters.reduce((s, x) => s + num((byId.get(x.id).gamesByWeek || {})[cw]), 0) : null,
  };
}

module.exports = { signalsFor, playerSignals, analyzeRoster, impliedValue, valueCurve, modelReturnWeek, GROUP_OF_SLOT };
