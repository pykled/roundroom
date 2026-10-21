// Pocket NBA — team page model (Stream C). Pure: same inputs → same output.
// Contract: docs/nba-trade-team-spec.md §5.1. Method + backtest: docs/nba-team.md.
//
//   analyzeLeague({ ctx, board, signals?, weeks?, options? }) → LeagueAnalysis
//     ctx      LeagueContext (league-sync.js leagueContext, §3.1)
//     board    board Player[] built under ctx.profile (needs hsByWeek / gamesByWeek)
//     signals  Map<id, Signals> (optional; ETA + flags for the injured list)
//     weeks    horizon [{ week, weight, playoff }] (default: horizonWeeks(options.horizon))
//     options  { horizon: 'ros'|'next4'|'playoffs', currentWeek, today, targets: bool, maxEvals }
//   teamDetail(analysis, { ctx, board, signals }, rosterId) → { team, roster, weeks }
//   typicalLeague({ board, myIds, profile, currentWeek }) → LeagueContext (manual mode, estimated rosters)
//   horizonWeeks(profile, currentWeek, horizon), weekValue(players, profile, week, replacement, opts)
//
// Team strength is the trade engine's weekly value, exactly: best lineup over the
// profile's starting slots on hsByWeek[w], open roster spots at waiver replacement,
// plus bench shares above replacement (trade.js weekValue; the test asserts the
// two agree to 1e-9 on every roster and week). Tiers are the NFL matrix on slot
// groups (roster-analysis.js). Every Stream A function is called first; while it
// still throws NOT_IMPLEMENTED a contract-shaped local version stands in, and
// `analysis.source` says which one ran.
'use strict';
const R = require('./roster-slots');
const T = require('./trade');
const RA = require('./roster-analysis');
const LS = require('./league-sync');
const SIG = require('./signals');
const ETA = require('./injury-eta');
const St = require('./stats');
const Board = require('./board');
const Research = require('./research');
const { epochDay, dayToDate } = require('./sleeper');

const GROUPS = RA.GROUPS;                    // G, F, C, UTIL (tiers, needs, surplus)
const DISPLAY = RA.DISPLAY_GROUPS;           // PG, SG, SF, PF (detail only)
const MATCH_GROUPS = ['G', 'F', 'C'];        // UTIL takes anyone, so it never names a trade need
const HORIZONS = ['ros', 'next4', 'playoffs'];
const PLAYOFF_WEIGHT = 1.5;                  // same as the trade engine
const NEED_ORDER = { critical: 0, upgrade: 1, thin: 2 };
const PARTNERS_TOP = 3, TARGETS_TOP = 6, TARGET_EVALS = 48, PER_SIDE = 4;
const LEAN_AFTER_WEEK = 4, CONTEND_PCT = 0.55;
const HEALTHY_RATIO_D = 8;                   // weeks ahead where every injury ramp is back to a0

const fin = x => typeof x === 'number' && Number.isFinite(x);
const num = x => (fin(x) ? x : 0);
const r1 = x => (fin(x) ? Math.round(x * 10) / 10 : null);
const r3 = x => (fin(x) ? Math.round(x * 1000) / 1000 : null);
// Sleeper ids are digit strings: shorter first, then lexical (= numeric order).
function cmpId(a, b) {
  const x = String(a), y = String(b);
  if (/^\d+$/.test(x) && /^\d+$/.test(y) && x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}
const median = xs => { const s = xs.slice().sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

// Stream A first; contract-shaped local fallback while A's stub throws NOT_IMPLEMENTED.
function viaShared(src, name, fn, local) {
  try { const v = fn(); src[name] = 'shared'; return v; } catch (e) {
    if (e && e.code === 'NOT_IMPLEMENTED') { src[name] = 'local'; return local(); }
    throw e;
  }
}

/* ------------------------------------------------------------------ weeks */
// Horizon weeks with weights: playoff weeks count 1.5× (trade engine rule).
function horizonWeeks(profile, currentWeek, horizon = 'ros') {
  const all = ((profile && profile.weeks) || []).map(w => ({ week: Number(w.week), playoff: !!w.playoffs })).filter(w => fin(w.week));
  if (!all.length) return [];
  const cw = Number(currentWeek) || all[0].week;
  let rest = all.filter(w => w.week >= cw);
  if (!rest.length) rest = all.slice(-1);
  let out = horizon === 'next4' ? rest.slice(0, 4) : horizon === 'playoffs' ? rest.filter(w => w.playoff) : rest;
  if (!out.length) out = rest.slice(-1);
  return out.map(w => ({ week: w.week, weight: w.playoff ? PLAYOFF_WEIGHT : 1, playoff: w.playoff }));
}
const wMean = (weeks, f) => { let s = 0, ws = 0; for (const w of weeks) { s += w.weight * f(w.week); ws += w.weight; } return ws ? s / ws : 0; };

/* ------------------------------------------------------------------ lineup value */
// Roster cap: active spots + IL slots actually holding IL-eligible players (trade.js capFor).
function capFor(players, profile) {
  return R.activeSpots(profile) + Math.min(R.ilSlots(profile), players.filter(R.ilEligible).length);
}

// One week's team value, identical to trade.js createEvaluator().weekValue:
// best lineup (open spots at replacement), unfillable slots at replacement when a
// bench player can be cut for a waiver add, bench shares above replacement.
//   replacement: { perWeek: { w: value } } or a number. opts: { cap, values: Map(id → v) }
// → { total, starters: [{ id|null, slot, value, replacement? }], bench: [{ id, value, share }], holes, games }
function weekValue(players, profile, week, replacement, opts = {}) {
  const slots = R.slotList(profile);
  const ALL = new Set(slots);
  const shares = R.benchShares(profile);
  const cap = opts.cap != null ? opts.cap : capFor(players, profile);
  const rv = fin(replacement) ? replacement : num(replacement && replacement.perWeek ? replacement.perWeek[week] : 0);
  const vals = opts.values || null;
  const byId = new Map(players.map(p => [String(p.id), p]));
  const items = players.map(p => ({ id: String(p.id), elig: R.eligFor(p, profile), v: vals ? num(vals.get(String(p.id))) : num((p.hsByWeek || {})[week]) }));
  const open = Math.max(0, cap - players.length);
  for (let i = 0; i < Math.min(open, slots.length); i++) items.push({ id: `~repl${i}`, elig: ALL, v: rv });
  // Trade v2 stream rule: one waiver add per player who has to sit, so a slot only playable below waiver level is streamed.
  const spare = Math.min(slots.length, Math.max(0, players.length - slots.length));
  for (let i = 0; i < spare; i++) items.push({ id: `~swap${i}`, elig: ALL, v: rv });
  items.sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
  const lu = R.bestAssignment(items, slots);
  const vOf = new Map(items.map(it => [it.id, it.v]));
  const bench = items.filter(it => !lu.slotOf.has(it.id) && !it.id.startsWith('~'));
  let swaps = 0;
  for (const id of lu.slotOf.keys()) if (id.startsWith('~swap')) swaps++;
  const holes = Math.min(slots.length - lu.slotOf.size, Math.max(0, bench.length - swaps));
  let benchVal = 0;
  const benchOut = [];
  bench.slice(0, Math.max(0, bench.length - swaps - holes)).forEach((it, i) => {
    const share = i < shares.length ? shares[i] : 0;
    benchVal += share * Math.max(0, it.v - rv);
    benchOut.push({ id: it.id, value: it.v, share });
  });
  const starters = lu.starters.map(s => (s.id.startsWith('~') ? { id: null, slot: s.slot, value: rv, replacement: true, ...(s.id.startsWith('~swap') ? { hole: true } : {}) } : { id: s.id, slot: s.slot, value: vOf.get(s.id) }));
  const left = slots.slice();
  for (const s of lu.starters) { const i = left.indexOf(s.slot); if (i >= 0) left.splice(i, 1); }
  for (let i = 0; i < holes; i++) starters.push({ id: null, slot: left[i] || 'UTIL', value: rv, replacement: true, hole: true });
  const games = lu.starters.filter(s => !s.id.startsWith('~')).reduce((a, s) => a + num(((byId.get(s.id) || {}).gamesByWeek || {})[week]), 0);
  return { total: lu.total + holes * rv + benchVal, starters, bench: benchOut, holes, games, benchValue: benchVal };
}

function replacementFor(board, profile, weekNums, rosteredIds) {
  const st = T.normSettings({}, profile);
  return T.replacementLevel(board, weekNums.map(w => ({ week: w })), st, rosteredIds ? new Set(rosteredIds) : null);
}

/* ------------------------------------------------------------------ groups */
const isHealthy = p => !R.ilEligible(p);
const rankOf = p => (p && fin(p.modelRank) ? p.modelRank : p && fin(p.rank) ? p.rank : null);
function groupOfSlot(slot) {
  const s = String(slot || '').replace(/\d+$/, '');
  for (const g of GROUPS) if (RA.GROUP_SLOTS[g].includes(s)) return g;
  return null;
}
function eligibleFor(group, elig) {
  if (group === 'UTIL') return true;
  return RA.GROUP_ELIG[group].some(s => elig.has(s));
}
const primaryPos = p => String(((p.pos && p.pos[0]) || '')).toUpperCase();

// Local stand-in for roster-analysis.js analyzeRoster (contract §3.4). players are
// the roster's board players with IL excluded. Extra (non-contract) inputs:
// currentWeek (strengthNow / gamesThisWeek) and cap.
function analyzeRosterLocal({ players, profile, weeks, replacement, leagueAvg = null, strongCutoff = null, currentWeek = null }) {
  const slots = R.slotList(profile);
  const roster = players.slice().sort((a, b) => cmpId(a.id, b.id));
  const value = new Map(roster.map(p => [String(p.id), wMean(weeks, w => num((p.hsByWeek || {})[w]))]));
  const rv = wMean(weeks, w => num(((replacement && replacement.perWeek) || {})[w]));
  const cap = R.activeSpots(profile);
  const lu = weekValue(roster, profile, null, rv, { cap, values: value });
  const byId = new Map(roster.map(p => [String(p.id), p]));
  const eligOf = new Map(roster.map(p => [String(p.id), R.eligFor(p, profile)]));
  const starters = lu.starters.filter(s => s.id);
  const benchRows = lu.bench;
  const weekly = weeks.map(w => ({ w, v: weekValue(roster, profile, w.week, replacement, { cap }).total }));
  const strengthRos = wMean(weeks, wk => (weekly.find(x => x.w.week === wk) || { v: 0 }).v);
  const cw = currentWeek != null ? Number(currentWeek) : null;
  const strengthNow = cw != null ? weekValue(roster, profile, cw, replacement, { cap }).total : null;

  const groups = {};
  for (const g of GROUPS.concat(DISPLAY)) {
    const display = DISPLAY.includes(g);
    const gSlots = display ? [g] : RA.GROUP_SLOTS[g];
    const n = slots.filter(s => gSlots.includes(s)).length;
    const members = roster.filter(p => isHealthy(p) && (display ? primaryPos(p) === g : eligibleFor(g, eligOf.get(String(p.id)))));
    const inGroup = lu.starters.filter(s => gSlots.includes(s.slot));
    const starterValue = inGroup.reduce((a, s) => a + num(s.value), 0);
    const nextUp = display ? null : benchRows.filter(b => eligibleFor(g, eligOf.get(b.id))).reduce((m, b) => (m == null || b.value > m ? b.value : m), null);
    const avg = leagueAvg && fin(leagueAvg[g]) ? leagueAvg[g] : null;
    const cut = strongCutoff && fin(strongCutoff[g]) ? strongCutoff[g] : null;
    const tier = RA.assessTier(members.length, n, starterValue, avg, cut);
    groups[g] = {
      slots: n, rostered: members.length, starterValue: r1(starterValue), nextUp: r1(nextUp), leagueAvg: r1(avg), rank: null, tier, status: RA.tierStatus(tier),
      starters: inGroup.map(s => ({ id: s.id, slot: s.slot, value: r1(s.value), replacement: !!s.replacement })),
      nextUpId: display ? null : ((benchRows.find(b => eligibleFor(g, eligOf.get(b.id))) || {}).id || null),
    };
    if (display) groups[g]._displayOnly = true;
  }
  const elite = starters.filter(s => num(s.value) >= RA.ELITE_VALUE || (rankOf(byId.get(s.id)) || 1e9) <= 24)
    .map(s => ({ id: s.id, name: byId.get(s.id).name, value: r1(s.value) })).sort((a, b) => b.value - a.value || cmpId(a.id, b.id));
  const liabilities = starters.filter(s => num(s.value) < rv + RA.LIABILITY_MARGIN)
    .map(s => ({ id: s.id, name: byId.get(s.id).name, slot: s.slot, value: r1(s.value) })).sort((a, b) => a.value - b.value || cmpId(a.id, b.id));
  const inj = injuriesOf(roster, cw, weeks.map(w => w.week), null);
  return {
    lineup: {
      total: r1(lu.total), holes: lu.holes,
      starters: starters.map(s => ({ id: s.id, name: byId.get(s.id).name, slot: s.slot, value: r1(s.value) })),
      waiver: lu.starters.filter(s => !s.id).map(s => ({ slot: s.slot, value: r1(s.value) })),
      bench: benchRows.map(b => ({ id: b.id, name: byId.get(b.id).name, value: r1(b.value), share: r3(b.share) })),
    },
    strengthRos: r1(strengthRos), strengthNow: r1(strengthNow), benchValue: r1(lu.benchValue), replacement: r1(rv),
    groups,
    needs: GROUPS.filter(g => groups[g].status === 'need'),
    surplus: GROUPS.filter(g => groups[g].status === 'surplus'),
    elite, liabilities,
    injured: inj.list.map(x => ({ id: x.id, name: x.name, status: x.status, eta: x.eta, lostThisWeek: x.lostThisWeek })),
    injuryExposure: { thisWeek: inj.thisWeek, next2: inj.next2 },
    gamesThisWeek: cw != null ? starters.reduce((a, s) => a + num(((byId.get(s.id) || {}).gamesByWeek || {})[cw]), 0) : null,
  };
}

/* ------------------------------------------------------------------ injuries */
// Healthy weekly value of an injured player: E[max] at a = max(a0, 0.55) on the
// normal shape (mean, sd), calibrated to his own board value in weeks far enough
// ahead that every injury ramp has expired (d ≥ 8), so the week scale and the
// fit-vs-normal gap cancel. Healthy players: their board value.
function healthyByWeek(p, weekNums, currentWeek) {
  const hs = p.hsByWeek || {}, gb = p.gamesByWeek || {};
  if (!(p.injury || p.outForSeason)) { const o = {}; for (const w of weekNums) o[w] = num(hs[w]); return o; }
  const mean = num(p.mean), sd = num(p.sd);
  const out = {};
  if (!(mean > 0)) { for (const w of weekNums) out[w] = num(hs[w]); return out; }
  const aH = Math.max(fin(p.availability) ? p.availability : Board.HEALTHY_FLOOR, Board.HEALTHY_FLOOR);
  const f = k => St.expectedMax({ mean, sd }, k);
  const ema = n => St.expectedMaxAvail(f, n, aH);
  const cw = Number(currentWeek) || 0;
  const ratioAt = w => { const n = num(gb[w]), h = num(hs[w]); return n > 0 && h > 0 ? h / ema(n) : null; };
  const ws = Object.keys(hs).map(Number).filter(fin).sort((a, b) => a - b);
  let ratios = ws.filter(w => w - cw >= HEALTHY_RATIO_D).map(ratioAt).filter(fin);
  if (!ratios.length) ratios = ws.filter(w => w > cw).slice(-3).map(ratioAt).filter(fin);
  const k = ratios.length ? median(ratios) : 1;
  for (const w of weekNums) out[w] = k * ema(num(gb[w]));
  return out;
}

function etaOf(p, signals) {
  const s = signals && signals.get ? signals.get(String(p.id)) : null;
  return s && s.availability && s.availability.eta ? s.availability.eta : null;
}

// Σ max(0, healthy_w − hsByWeek[w]) over the roster: this week and this week + next.
function injuriesOf(roster, currentWeek, weekNums, signals) {
  const cw = Number(currentWeek);
  const list = [];
  let thisWeek = 0, next2 = 0;
  for (const p of roster) {
    if (!(p.injury || p.outForSeason)) continue;
    const span = fin(cw) ? [cw, cw + 1] : weekNums.slice(0, 2);
    const h = healthyByWeek(p, span, cw);
    const lost = w => Math.max(0, num(h[w]) - num((p.hsByWeek || {})[w]));
    const a = fin(cw) ? lost(cw) : 0, b = span.reduce((s, w) => s + lost(w), 0);
    thisWeek += a; next2 += b;
    list.push({ id: String(p.id), name: p.name, team: p.team || null, status: p.outForSeason ? 'OFS' : p.injury, outForSeason: !!p.outForSeason, bodyPart: p.injuryBody || null,
      eta: etaOf(p, signals), lostThisWeek: r1(a), lostNext2: r1(b), healthyValue: r1(h[span[0]]) });
  }
  list.sort((x, y) => num(y.lostNext2) - num(x.lostNext2) || cmpId(x.id, y.id));
  return { list, thisWeek: r1(thisWeek), next2: r1(next2) };
}

/* ------------------------------------------------------------------ league context */
// Local stand-in for league-sync.js leagueContext (contract §3.1).
function leagueContextLocal({ league, users, rosters, draft = null, matchups = null, board, profile, userId = null, currentWeek = null }) {
  const onBoard = new Set((board || []).map(p => String(p.id)));
  const byUser = new Map((Array.isArray(users) ? users : []).filter(u => u && u.user_id != null).map(u => [String(u.user_id), u]));
  const decimal = (a, b) => num(Number(a)) + num(Number(b)) / 100;
  const teams = (Array.isArray(rosters) ? rosters : []).filter(r => r && r.roster_id != null).map(r => {
    const owner = r.owner_id != null ? String(r.owner_id) : null;
    const u = owner ? byUser.get(owner) : null;
    const md = (u && u.metadata) || {};
    const st = r.settings || {};
    const reserve = (r.reserve || []).map(String);
    const starters = (r.starters || []).map(String).filter(id => id && id !== '0');
    const ids = [...new Set((r.players || []).map(String).concat(reserve))].sort(cmpId);
    const players = ids.map(id => ({ id, onBoard: onBoard.has(id), slot: reserve.includes(id) ? 'IL' : starters.includes(id) ? 'START' : 'BN' }));
    return {
      rosterId: String(r.roster_id), name: md.team_name || (u && u.display_name) || `Team ${r.roster_id}`, ownerId: owner,
      displayName: (u && u.display_name) || null, avatar: (u && u.avatar) || null, coOwners: (r.co_owners || []).map(String),
      record: { wins: num(Number(st.wins)), losses: num(Number(st.losses)), ties: num(Number(st.ties)), fpts: decimal(st.fpts, st.fpts_decimal), fptsAgainst: decimal(st.fpts_against, st.fpts_against_decimal) },
      waiverPosition: st.waiver_position != null ? Number(st.waiver_position) : null, totalMoves: num(Number(st.total_moves)),
      players, starters, reserve,
      unmatched: players.filter(p => !p.onBoard).map(p => ({ id: p.id, name: `Player ${p.id}` })),
    };
  }).sort((a, b) => cmpId(a.rosterId, b.rosterId));
  const uid = userId != null ? String(userId) : null;
  const mine = uid ? (teams.find(t => t.ownerId === uid) || teams.find(t => t.coOwners.includes(uid))) : null;
  let opp = null;
  if (Array.isArray(matchups) && matchups.length) {
    opp = {};
    const byM = new Map();
    for (const m of matchups) if (m && m.matchup_id != null) { const k = String(m.matchup_id); (byM.get(k) || byM.set(k, []).get(k)).push(String(m.roster_id)); }
    for (const ids of byM.values()) if (ids.length === 2) { opp[ids[0]] = ids[1]; opp[ids[1]] = ids[0]; }
  }
  return {
    leagueId: String(league.league_id), name: league.name || `League ${league.league_id}`, season: league.season != null ? String(league.season) : null,
    teams, myRosterId: mine ? mine.rosterId : null, currentWeek: Number(currentWeek) || 1, opponentByRoster: opp, profile,
  };
}

/* ------------------------------------------------------------------ signals */
// Local stand-in for signals.js signalsFor (§3.3): the subset the team page shows
// (value, form, minutes, availability, schedule, market, flags), same key names,
// every number finite or null. ctx: { profile, currentWeek, weeks, logs, today, eta }.
function signalsLocal(players, ctx) {
  const out = new Map();
  const today = ctx.today || new Date().toISOString().slice(0, 10);
  const todayDay = epochDay(today);
  const cw = Number(ctx.currentWeek) || 1;
  const weeks = ctx.weeks && ctx.weeks.length ? ctx.weeks : horizonWeeks(ctx.profile, cw, 'ros');
  const files = (ctx.logs || []).slice().sort((a, b) => Number(b.season) - Number(a.season));
  const mw = SIG.marketWeight(cw);
  for (const p of players) {
    const id = String(p.id);
    const hs = p.hsByWeek || {}, gb = p.gamesByWeek || {};
    let st = null, statSeason = null;
    for (const f of files) {
      const rows = ((f.players || {})[id] || {}).g;
      const prior = Array.isArray(rows) ? rows.filter(g => g[0] < todayDay) : [];
      if (prior.length >= 5) { st = Research.logStats(prior, ctx.profile); statSeason = Number(f.season); break; }
    }
    const lastDay = st && st.games.length ? st.games[st.games.length - 1][0] : null;
    const stale = lastDay != null ? todayDay - lastDay > SIG.STALE_DAYS : true;
    let form = null;
    if (st && st.gp >= SIG.FORM_MIN_SEASON_GAMES && num(st.mean) >= SIG.FORM_MIN_MEAN) {
      const ratio = st.last5 / st.mean;
      form = { last5: r1(st.last5), seasonMean: r1(st.mean), ratio: r3(ratio), delta: r1(st.last5 - st.mean),
        label: ratio >= SIG.FORM_HOT ? 'hot' : ratio <= SIG.FORM_COLD ? 'cold' : null, games: st.gp, lastGameDate: lastDay != null ? dayToDate(lastDay) : null, stale };
    }
    const minDelta = st && fin(st.minDelta) ? st.minDelta : null;
    const trend = minDelta == null ? null : minDelta >= SIG.MINUTES_TREND ? 'up' : minDelta <= -SIG.MINUTES_TREND ? 'down' : 'flat';
    const rest = weeks.map(w => w.week);
    const games = rest.reduce((a, w) => a + num(gb[w]), 0);
    const eta = ctx.eta && ctx.eta.get ? ctx.eta.get(id) || null : null;
    const ros = wMean(weeks, w => num(hs[w]));
    const mean = num(p.mean);
    const flags = [];
    if (form && form.label) flags.push(form.label);
    if (trend === 'up') flags.push('minutes-up'); else if (trend === 'down') flags.push('minutes-down');
    if (p.outForSeason) flags.push('ofs');
    else if (eta && eta.returnWeek) flags.push('out-until-wk' + eta.returnWeek);
    if (num(gb[cw]) >= SIG.HEAVY_WEEK) flags.push('heavy-schedule'); else if (num(gb[cw]) > 0 && num(gb[cw]) <= SIG.LIGHT_WEEK) flags.push('light-schedule');
    if (p.label === 'value') flags.push('market-value'); else if (p.label === 'reach') flags.push('market-reach');
    if (p.source === 'rookie') flags.push('rookie');
    if (p.newTeam) flags.push('new-team');
    if (num(p.sampleGames) < 20) flags.push('thin-sample');
    if (stale && p.source === 'logs') flags.push('stale-stats');
    let u = 0.1;
    if (p.source && p.source !== 'logs') u += 0.1;
    if (p.injury || p.outForSeason) u += eta ? 0.04 : 0.08;
    if (num(p.sampleGames) < 20) u += 0.05;
    if (stale && p.source === 'logs') u += 0.05;
    out.set(id, {
      id, name: p.name, team: p.team || null, pos: p.pos || [], elig: [...R.eligFor(p, ctx.profile)], source: p.source || 'logs', sampleGames: num(p.sampleGames), statSeason,
      value: { ros: r1(ros), now: r1(num(hs[cw])), next: hs[cw + 1] != null ? r1(num(hs[cw + 1])) : null, mean: r1(mean), sd: r1(p.sd), ceiling: r1(p.ceiling), floor: r1(p.floor),
        cv: mean > 0 ? r3(num(p.sd) / mean) : null, ceilingShare: mean > 0 && fin(p.ceiling) ? r3((p.ceiling - mean) / mean) : null,
        vorp: fin(p.vorp) ? p.vorp : null, vorpRank: fin(p.vorpRank) ? p.vorpRank : null, rank: fin(p.modelRank) ? p.modelRank : fin(p.rank) ? p.rank : null, tier: fin(p.tier) ? p.tier : null, blended: r1(ros) },
      form,
      minutes: { mpg: st ? st.mpg : null, last5: st ? st.last5Min : null, delta: minDelta, trend, projected: null, roleShift: null },
      usage: { fga: null, fta: null, usageRate: null, trend: null },
      availability: { a0: fin(p.availability) ? p.availability : null, status: p.injury || null, bodyPart: p.injuryBody || null, notes: null, eta, outForSeason: !!p.outForSeason, byWeek: {}, expectedGamesMissed: null },
      schedule: { gamesByWeek: gb, gamesRemaining: games, gamesThisWeek: num(gb[cw]), heavyWeeks: rest.filter(w => num(gb[w]) >= SIG.HEAVY_WEEK).length,
        lightWeeks: rest.filter(w => num(gb[w]) > 0 && num(gb[w]) <= SIG.LIGHT_WEEK).length, playoffGames: weeks.filter(w => w.playoff).reduce((a, w) => a + num(gb[w.week]), 0), b2bNext2: null },
      market: { rank: fin(p.marketRank) ? p.marketRank : null, adpDelta: fin(p.adpDelta) ? p.adpDelta : null, label: p.label || null, contested: !!p.contested,
        confidence: fin(p.marketConfidence) ? p.marketConfidence : null, yahooPreRank: null, pctRos: null, impliedValue: null, weight: mw },
      bio: { age: null, exp: null, rookie: p.source === 'rookie' },
      uncertainty: Math.min(0.35, u), flags,
    });
  }
  return out;
}

// ESPN injury doc when Stream A's injury-eta is live; null before that (or offline).
function etaDoc() {
  try { return ETA.loadInjuryEta() || null; } catch (e) { if (e && e.code === 'NOT_IMPLEMENTED') return null; throw e; }
}
// id → EtaMatch (+ returnWeek) for the injured players.
function etaMap(players, profile, logs, doc = etaDoc()) {
  const m = new Map();
  if (!doc) return m;
  for (const p of players) {
    if (!(p.injury || p.outForSeason)) continue;
    let e = null;
    try { e = ETA.matchEta(doc, p, { logs }); } catch (err) { e = null; }
    if (e && e.returnDate) m.set(String(p.id), { ...e, returnWeek: e.returnWeek != null ? e.returnWeek : R.weekForDate(profile, e.returnDate) });
  }
  return m;
}

// ctx: { profile, currentWeek, weeks, logs, proj?, market?, bio?, replacement?, today }.
// Stream A gets the EtaDoc (contract §3.3); the local version an id → match map.
function signalsFor(players, ctx, src = {}) {
  const doc = etaDoc();
  return viaShared(src, 'signals',
    () => SIG.signalsFor(players, { market: null, bio: null, proj: null, replacement: null, ...ctx, eta: doc }),
    () => signalsLocal(players, { ...ctx, eta: etaMap(players, ctx.profile, ctx.logs, doc) }));
}

/* ------------------------------------------------------------------ league */
function rankBy(teams, key, dir = -1) {
  const sorted = teams.slice().sort((a, b) => dir * (num(a[key]) - num(b[key])) || cmpId(a.rosterId, b.rosterId));
  const out = new Map();
  sorted.forEach((t, i) => out.set(t.rosterId, i + 1));
  return out;
}
// starterValue of the last team inside the top 30% (≥ 1 team).
function strongCutoffOf(values) {
  const s = values.slice().sort((a, b) => b - a);
  if (!s.length) return null;
  return s[Math.max(1, Math.floor(s.length * RA.STRONG_SHARE)) - 1];
}

function leanOf(team, currentWeek, playoffTeams, gamesPlayed) {
  if (!(currentWeek > LEAN_AFTER_WEEK) || !gamesPlayed) return 'preseason';
  const pct = team.record.gamesPlayed ? (team.record.wins + 0.5 * team.record.ties) / team.record.gamesPlayed : 0;
  return pct >= CONTEND_PCT || (playoffTeams > 0 && team.powerRank <= playoffTeams) ? 'contend' : 'balanced';
}

function analyzeLeague({ ctx, board, signals = null, weeks = null, options = {} } = {}) {
  if (!ctx || !Array.isArray(ctx.teams)) throw new Error('analyzeLeague: LeagueContext required');
  if (!Array.isArray(board)) throw new Error('analyzeLeague: board players required');
  const profile = ctx.profile;
  const horizon = HORIZONS.includes(options.horizon) ? options.horizon : 'ros';
  const cw = Number(options.currentWeek) || Number(ctx.currentWeek) || 1;
  const hWeeks = weeks && weeks.length ? weeks : horizonWeeks(profile, cw, horizon);
  const restWeeks = horizonWeeks(profile, cw, 'ros');
  const restNums = restWeeks.map(w => w.week);
  const src = { ...(options.source || {}) };
  const index = new Map(board.map(p => [String(p.id), p]));
  const ctxTeams = ctx.teams.slice().sort((a, b) => cmpId(a.rosterId, b.rosterId));
  const rosteredIds = ctxTeams.flatMap(t => t.players.filter(p => p.onBoard).map(p => p.id));
  const repl = replacementFor(board, profile, restNums, rosteredIds);
  const playoffTeams = num(profile.playoffTeams) || 0;

  // Pass 1: lineup value by week, typical lineup, groups without league context.
  const base = ctxTeams.map(t => {
    const all = t.players.filter(p => p.onBoard && index.has(p.id)).map(p => index.get(p.id)).sort((a, b) => cmpId(a.id, b.id));
    const ilIds = new Set(t.players.filter(p => p.slot === 'IL').map(p => p.id));
    const active = all.filter(p => !ilIds.has(String(p.id)));
    const cap = capFor(all, profile);
    const byWeek = {};
    const lineups = {};
    for (const w of restNums) { const v = weekValue(all, profile, w, repl, { cap }); byWeek[w] = v.total; lineups[w] = v; }
    const raArgs = { players: active, profile, weeks: hWeeks, replacement: repl, currentWeek: cw };
    const ra = viaShared(src, 'analyzeRoster', () => RA.analyzeRoster(raArgs), () => analyzeRosterLocal(raArgs));
    return { t, all, active, ilIds, cap, byWeek, lineups, ra };
  });
  const groupKeys = GROUPS.concat(DISPLAY);
  const leagueAvg = {}, strongCutoff = {};
  for (const g of groupKeys) {
    const vals = base.map(b => num(b.ra.groups[g] && b.ra.groups[g].starterValue));
    leagueAvg[g] = r1(vals.reduce((a, v) => a + v, 0) / (vals.length || 1));
    strongCutoff[g] = r1(strongCutoffOf(vals));
  }
  // Pass 2: tiers against the league.
  for (const b of base) {
    const raArgs = { players: b.active, profile, weeks: hWeeks, replacement: repl, currentWeek: cw, leagueAvg, strongCutoff };
    b.ra = viaShared(src, 'analyzeRoster', () => RA.analyzeRoster(raArgs), () => analyzeRosterLocal(raArgs));
  }

  const gamesPlayedAny = ctxTeams.some(t => num(t.record && t.record.wins) + num(t.record && t.record.losses) + num(t.record && t.record.ties) > 0);
  const teams = base.map(b => {
    const t = b.t, ra = b.ra;
    const rec = t.record || {};
    const gp = num(rec.wins) + num(rec.losses) + num(rec.ties);
    const inj = injuriesOf(b.all, cw, restNums, signals);
    const now = b.lineups[cw] || null;
    const realStarters = now ? now.starters.filter(s => s.id) : [];
    const cvs = realStarters.map(s => index.get(s.id)).filter(p => num(p.mean) > 0).map(p => num(p.sd) / p.mean);
    return {
      rosterId: t.rosterId, name: t.name, ownerId: t.ownerId || null, displayName: t.displayName || null, avatar: t.avatar || null,
      record: { wins: num(rec.wins), losses: num(rec.losses), ties: num(rec.ties), fpts: r1(num(rec.fpts)), fptsAgainst: r1(num(rec.fptsAgainst)), gamesPlayed: gp, pct: gp ? r3((num(rec.wins) + 0.5 * num(rec.ties)) / gp) : null },
      strengthRos: r1(wMean(hWeeks, w => num(b.byWeek[w]))),
      strengthNow: b.byWeek[cw] != null ? r1(b.byWeek[cw]) : null,
      strengthNext: b.byWeek[cw + 1] != null ? r1(b.byWeek[cw + 1]) : null,
      byWeek: restNums.map(w => ({ week: w, value: r1(b.byWeek[w]), games: b.lineups[w].games, playoff: !!(restWeeks.find(x => x.week === w) || {}).playoff })),
      groups: ra.groups,
      needs: ra.needs, surplus: ra.surplus,
      benchValue: r1(ra.benchValue),
      injuryExposure: { thisWeek: inj.thisWeek, next2: inj.next2, count: inj.list.length },
      injured: inj.list,
      scheduleThisWeek: { games: now ? now.games : 0, vsLeagueAvg: null },
      volatility: cvs.length ? r3(cvs.reduce((a, v) => a + v, 0) / cvs.length) : null,
      elite: ra.elite, liabilities: ra.liabilities,
      lineup: { ...ra.lineup, now: now ? { starters: now.starters.map(s => ({ ...s, value: r1(s.value) })), total: r1(now.total) } : null },
      il: [...b.ilIds].sort(cmpId),
      playerCount: b.all.length, unmatched: t.unmatched || [],
      opponent: ctx.opponentByRoster ? ctx.opponentByRoster[t.rosterId] || null : null,
    };
  });

  const power = rankBy(teams, 'strengthRos'), nowR = rankBy(teams, 'strengthNow'), bench = rankBy(teams, 'benchValue');
  const ptsR = gamesPlayedAny ? rankBy(teams.map(t => ({ rosterId: t.rosterId, fpts: t.record.fpts })), 'fpts') : null;
  const standing = gamesPlayedAny ? (() => {
    const s = teams.slice().sort((a, b) => num(b.record.pct) - num(a.record.pct) || num(b.record.fpts) - num(a.record.fpts) || cmpId(a.rosterId, b.rosterId));
    return new Map(s.map((t, i) => [t.rosterId, i + 1]));
  })() : null;
  const gRanks = {};
  for (const g of groupKeys) gRanks[g] = rankBy(teams.map(t => ({ rosterId: t.rosterId, v: num(t.groups[g] && t.groups[g].starterValue) })), 'v');
  const avgGames = teams.reduce((a, t) => a + t.scheduleThisWeek.games, 0) / (teams.length || 1);
  for (const t of teams) {
    t.powerRank = power.get(t.rosterId);
    t.nowRank = nowR.get(t.rosterId);
    t.benchRank = bench.get(t.rosterId);
    t.pointsRank = ptsR ? ptsR.get(t.rosterId) : null;
    t.standingsRank = standing ? standing.get(t.rosterId) : null;
    t.groupRank = {};
    for (const g of groupKeys) { t.groupRank[g] = gRanks[g].get(t.rosterId); if (t.groups[g]) t.groups[g].rank = t.groupRank[g]; }
    t.scheduleThisWeek.vsLeagueAvg = r1(t.scheduleThisWeek.games - avgGames);
    // Positional weaknesses only: UTIL takes anyone, so a low UTIL rank is a G/F/C problem (or none).
    t.weaknesses = MATCH_GROUPS.filter(g => NEED_ORDER[t.groups[g].tier] != null)
      .sort((a, b) => NEED_ORDER[t.groups[a].tier] - NEED_ORDER[t.groups[b].tier] || t.groupRank[b] - t.groupRank[a] || GROUPS.indexOf(a) - GROUPS.indexOf(b))
      .map(g => ({ group: g, tier: t.groups[g].tier, rank: t.groupRank[g] }));
    t.strengths = GROUPS.filter(g => ['loaded', 'deep'].includes(t.groups[g].tier) || t.groupRank[g] <= 3)
      .sort((a, b) => t.groupRank[a] - t.groupRank[b] || GROUPS.indexOf(a) - GROUPS.indexOf(b))
      .map(g => ({ group: g, tier: t.groups[g].tier, rank: t.groupRank[g] }));
    t.lean = leanOf(t, cw, playoffTeams, gamesPlayedAny);
  }
  teams.sort((a, b) => a.powerRank - b.powerRank);
  const order = m => [...m.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);
  const myRosterId = ctx.myRosterId != null && teams.some(t => t.rosterId === String(ctx.myRosterId)) ? String(ctx.myRosterId) : null;

  const analysis = {
    leagueId: ctx.leagueId || null, name: ctx.name || null, season: ctx.season || null, currentWeek: cw, horizon,
    weeks: hWeeks, estimated: !!options.estimated, teams,
    ranks: { power: order(power), now: order(nowR), groups: Object.fromEntries(groupKeys.map(g => [g, order(gRanks[g])])), bench: order(bench), points: ptsR ? order(ptsR) : null },
    leagueAvg, strongCutoff,
    replacement: { ros: r1(wMean(hWeeks, w => num(repl.perWeek[w]))), now: r1(num(repl.perWeek[cw])), source: repl.source },
    playoffTeams, gamesPlayed: gamesPlayedAny,
    myRosterId, partners: [], targets: [], targetsNote: null,
    asOf: options.asOf || null, source: src,
  };
  if (myRosterId) {
    analysis.partners = partnersFor(analysis, myRosterId);
    if (options.targets !== false) {
      const tg = targetsFor(analysis, { ctx, board, today: options.today, maxEvals: options.maxEvals });
      analysis.targets = tg.targets; analysis.targetsNote = tg.note; analysis.targetsEvaluated = tg.evaluated;
    }
  }
  return analysis;
}

// Trade targets for analysis.myRosterId (the expensive part: up to 48 trade
// evaluations, ≈ 0.3–1 s), separate so the route can cache it longer.
function targetsFor(analysis, { ctx, board, today = null, maxEvals = TARGET_EVALS } = {}) {
  if (!analysis || !analysis.myRosterId) return { targets: [], evaluated: 0, note: null };
  const index = new Map(board.map(p => [String(p.id), p]));
  const rosteredIds = ctx.teams.flatMap(t => t.players.filter(p => p.onBoard).map(p => p.id));
  return findTargets({ analysis, ctx, board, index, profile: ctx.profile, myRosterId: analysis.myRosterId, currentWeek: analysis.currentWeek, rosteredIds, maxEvals, today });
}

/* ------------------------------------------------------------------ partners + targets */
function matchSets(me) {
  const rankOf = g => num(me.groupRank[g]);
  let needs = me.needs.filter(g => MATCH_GROUPS.includes(g));
  let surplus = me.surplus.filter(g => MATCH_GROUPS.includes(g));
  // No named need/surplus: use the weakest / strongest group by rank.
  if (!needs.length) needs = [MATCH_GROUPS.slice().sort((a, b) => rankOf(b) - rankOf(a) || MATCH_GROUPS.indexOf(a) - MATCH_GROUPS.indexOf(b))[0]];
  if (!surplus.length) surplus = [MATCH_GROUPS.filter(g => !needs.includes(g)).sort((a, b) => rankOf(a) - rankOf(b) || MATCH_GROUPS.indexOf(a) - MATCH_GROUPS.indexOf(b))[0]].filter(Boolean);
  return { needs, surplus };
}

// NFL rule: teams whose needs overlap my surplus; score = 2·overlap + mutual (they
// have what I need). Ties: the more urgent need first (critical > upgrade > thin,
// then their worse rank in those groups), then power rank. Top 3.
const SEVERITY = { critical: 3, upgrade: 2, thin: 1 };
function partnersFor(analysis, myRosterId) {
  const me = analysis.teams.find(t => t.rosterId === myRosterId);
  if (!me) return [];
  const { needs, surplus } = matchSets(me);
  const out = [];
  for (const t of analysis.teams) {
    if (t.rosterId === myRosterId) continue;
    const overlap = t.needs.filter(g => surplus.includes(g));
    const mutual = t.surplus.filter(g => needs.includes(g));
    if (!overlap.length) continue;
    const urgency = overlap.reduce((s, g) => s + (SEVERITY[t.groups[g].tier] || 0), 0);
    const depth = overlap.reduce((s, g) => s + num(t.groupRank[g]), 0);
    out.push({ rosterId: t.rosterId, name: t.name, avatar: t.avatar || null, theyNeed: overlap, theyHave: mutual, score: 2 * overlap.length + mutual.length, urgency, needRank: depth, powerRank: t.powerRank });
  }
  out.sort((a, b) => b.score - a.score || b.urgency - a.urgency || b.needRank - a.needRank || a.powerRank - b.powerRank || cmpId(a.rosterId, b.rosterId));
  return out.slice(0, PARTNERS_TOP);
}

// 1-for-1 swaps: my surplus-group depth (not my best player in the group) × their
// players in a group I need, nearest in value to what I give (their stars are
// never on offer for my depth), scored by the trade engine on real rosters. Keep
// you ≥ 0.5 band and them ≥ −band; top 6 by combined gain.
function findTargets({ analysis, ctx, board, index, profile, myRosterId, currentWeek, rosteredIds, maxEvals = TARGET_EVALS, today = null }) {
  const me = analysis.teams.find(t => t.rosterId === myRosterId);
  const ctxOf = id => ctx.teams.find(t => t.rosterId === id);
  const idsOf = t => t.players.filter(p => p.onBoard && index.has(p.id)).map(p => p.id).sort(cmpId);
  const { needs, surplus } = matchSets(me);
  const ros = p => num(p.hsValue);
  let partners = analysis.partners.slice();
  let note = null;
  if (!partners.length) {
    partners = analysis.teams.filter(t => t.rosterId !== myRosterId)
      .map(t => ({ rosterId: t.rosterId, name: t.name, theyNeed: [], theyHave: t.surplus.filter(g => needs.includes(g)), score: 0, powerRank: t.powerRank }))
      .sort((a, b) => b.theyHave.length - a.theyHave.length || a.powerRank - b.powerRank || cmpId(a.rosterId, b.rosterId)).slice(0, PARTNERS_TOP);
    note = 'No team needs what you have in depth, so these come from teams with what you need.';
  }
  const myIds = idsOf(ctxOf(myRosterId));
  const mine = myIds.map(id => index.get(id));
  const eligOf = p => R.eligFor(p, profile);
  const giveFor = groups => {
    const pool = new Map();
    for (const g of groups) {
      const list = mine.filter(p => isHealthy(p) && eligibleFor(g, eligOf(p))).sort((a, b) => ros(b) - ros(a) || cmpId(a.id, b.id));
      for (const p of list.slice(1)) pool.set(String(p.id), { p, group: g });
    }
    return [...pool.values()].sort((a, b) => ros(b.p) - ros(a.p) || cmpId(a.p.id, b.p.id)).slice(0, PER_SIDE);
  };
  // Their players closest in value to v, slightly-better first (a fair swap is a small step up for me).
  const nearest = (list, v) => list.slice().sort((a, b) => (ros(a.p) < v - 2) - (ros(b.p) < v - 2) || Math.abs(ros(a.p) - v) - Math.abs(ros(b.p) - v) || cmpId(a.p.id, b.p.id)).slice(0, PER_SIDE);
  const evals = [];
  let evaluated = 0;
  for (const partner of partners) {
    const theirIds = idsOf(ctxOf(partner.rosterId));
    const give = giveFor(partner.theyNeed.length ? partner.theyNeed : surplus);
    const getPool = new Map();
    for (const g of needs) for (const id of theirIds) { const p = index.get(id); if (isHealthy(p) && eligibleFor(g, eligOf(p)) && !getPool.has(id)) getPool.set(id, { p, group: g }); }
    const getAll = [...getPool.values()];
    for (const gv of give) for (const gt of nearest(getAll, ros(gv.p))) {
      if (evaluated >= maxEvals) break;
      evaluated++;
      const r = T.evaluateTrade({ players: board, currentWeek, myRoster: myIds, partnerRoster: theirIds, give: [String(gv.p.id)], get: [String(gt.p.id)], leagueRostered: rosteredIds, profile, today });
      const band = num(r.meta && r.meta.fairBand) || 1;
      if (!(r.you.perWeek >= 0.5 * band && r.them.perWeek >= -band)) continue;
      evals.push({
        partner: partner.rosterId, partnerName: partner.name,
        give: [{ id: String(gv.p.id), name: gv.p.name, team: gv.p.team || null, pos: gv.p.pos || [], value: r1(ros(gv.p)), group: gv.group }],
        get: [{ id: String(gt.p.id), name: gt.p.name, team: gt.p.team || null, pos: gt.p.pos || [], value: r1(ros(gt.p)), group: gt.group }],
        you: r.you.perWeek, them: r.them.perWeek, verdict: r.verdict, likely: r.them.likely, band: r1(band), fills: gt.group,
        href: `/nba/trade?league_id=${encodeURIComponent(analysis.leagueId || '')}&partner=${encodeURIComponent(partner.rosterId)}&give=${encodeURIComponent(gv.p.id)}&get=${encodeURIComponent(gt.p.id)}`,
      });
    }
  }
  evals.sort((a, b) => (b.you + b.them) - (a.you + a.them) || b.you - a.you || cmpId(a.give[0].id, b.give[0].id) || cmpId(a.get[0].id, b.get[0].id));
  if (!evals.length && !note) note = evaluated ? 'No 1-for-1 swap helps you without costing them too much. Try a 2-for-1 in the calculator.' : 'No swap candidates (no healthy depth to trade).';
  return { targets: evals.slice(0, TARGETS_TOP), evaluated, note };
}

/* ------------------------------------------------------------------ detail */
// One team's roster with slot, group, tier and signals, plus its weekly strength.
function teamDetail(analysis, { ctx, board, signals = null }, rosterId) {
  const team = analysis.teams.find(t => t.rosterId === String(rosterId));
  if (!team) return null;
  const index = new Map(board.map(p => [String(p.id), p]));
  const ct = ctx.teams.find(t => t.rosterId === team.rosterId);
  const slotOf = new Map();
  for (const s of team.lineup.starters || []) slotOf.set(s.id, s.slot);
  const nowSlot = new Map(((team.lineup.now && team.lineup.now.starters) || []).filter(s => s.id).map(s => [s.id, s.slot]));
  const ilSet = new Set(team.il || []);
  const rows = ct.players.filter(p => p.onBoard && index.has(p.id)).map(p => {
    const b = index.get(p.id);
    const slot = ilSet.has(p.id) ? 'IL' : slotOf.get(p.id) || 'BN';
    const elig = R.eligFor(b, ctx.profile);
    const group = groupOfSlot(slot) || MATCH_GROUPS.find(g => eligibleFor(g, elig)) || 'UTIL';
    const s = signals && signals.get ? signals.get(p.id) || null : null;
    return {
      player: { id: p.id, name: b.name, team: b.team || null, pos: b.pos || [], elig: [...elig].filter(x => x !== 'UTIL'), injury: b.injury || null, outForSeason: !!b.outForSeason, hsValue: b.hsValue, rank: rankOf(b), mean: b.mean, ceiling: b.ceiling },
      signals: s, slot, slotNow: nowSlot.get(p.id) || (ilSet.has(p.id) ? 'IL' : 'BN'), group, tier: team.groups[group] ? team.groups[group].tier : null,
      value: { ros: s && s.value ? s.value.ros : r1(wMean(analysis.weeks, w => num((b.hsByWeek || {})[w]))), now: r1(num((b.hsByWeek || {})[analysis.currentWeek])) },
      gamesThisWeek: num((b.gamesByWeek || {})[analysis.currentWeek]),
    };
  });
  const SLOT_ORDER = R.slotList(ctx.profile).concat(['BN', 'IL']);
  rows.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot) || num(b.value.ros) - num(a.value.ros) || cmpId(a.player.id, b.player.id));
  const unmatched = ct.players.filter(p => !p.onBoard || !index.has(p.id)).map(p => ({ id: p.id, name: `Player ${p.id}` }));
  return { team, roster: rows, unmatched, weeks: team.byWeek.map(w => ({ week: w.week, value: w.value, games: w.games, playoff: w.playoff })) };
}

/* ------------------------------------------------------------------ manual mode */
// "Typical league" for a manual roster: the other teams snake-draft the board by
// market rank (board rank when a player has none), my players removed, my team in
// the middle slot (trade.js estimatePartner, generalised to every roster).
function typicalLeague({ board, myIds, profile, currentWeek = 1 }) {
  const n = Math.max(2, Math.min(20, num(profile.teams) || 12));
  const rounds = Math.max(1, (profile.draft && profile.draft.rounds) || R.activeSpots(profile));
  const mine = new Set((myIds || []).map(String));
  const pool = board.filter(p => !mine.has(String(p.id)) && p.source !== 'yahoo-only' && p.hsByWeek)
    .sort((a, b) => (fin(a.marketRank) ? a.marketRank : 1e9) - (fin(b.marketRank) ? b.marketRank : 1e9) || num(a.modelRank || a.rank || 1e9) - num(b.modelRank || b.rank || 1e9) || cmpId(a.id, b.id));
  const mySlot = Math.ceil(n / 2);
  const rosters = Array.from({ length: n }, () => []);
  let k = 0;
  for (let r = 1; r <= rounds; r++) {
    for (let i = 0; i < n; i++) {
      const slot = r % 2 === 1 ? i + 1 : n - i;
      if (slot === mySlot) continue;
      if (pool[k]) rosters[slot - 1].push(String(pool[k++].id));
    }
  }
  rosters[mySlot - 1] = [...mine].filter(id => board.some(p => String(p.id) === id));
  const onBoard = new Set(board.map(p => String(p.id)));
  const teams = rosters.map((ids, i) => ({
    rosterId: String(i + 1), name: i + 1 === mySlot ? 'Your Team' : `Typical Team ${i + 1 < mySlot ? i + 1 : i}`, ownerId: null, displayName: null, avatar: null, coOwners: [],
    record: { wins: 0, losses: 0, ties: 0, fpts: 0, fptsAgainst: 0 }, waiverPosition: null, totalMoves: 0,
    players: ids.slice().sort(cmpId).map(id => ({ id, onBoard: onBoard.has(id), slot: 'BN' })), starters: [], reserve: [], unmatched: [],
  }));
  return { leagueId: null, name: 'Typical League', season: profile.season || null, teams, myRosterId: String(mySlot), currentWeek: Number(currentWeek) || 1, opponentByRoster: null, profile };
}

module.exports = {
  analyzeLeague, teamDetail, typicalLeague, horizonWeeks, weekValue, capFor, replacementFor, healthyByWeek, injuriesOf,
  analyzeRosterLocal, leagueContextLocal, signalsLocal, signalsFor, etaMap, etaDoc, partnersFor, findTargets, targetsFor, viaShared, cmpId,
  HORIZONS, GROUPS, DISPLAY, MATCH_GROUPS, PLAYOFF_WEIGHT, TARGET_EVALS, TARGETS_TOP, PARTNERS_TOP, LEAN_AFTER_WEEK, CONTEND_PCT,
};
