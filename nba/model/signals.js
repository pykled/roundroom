// Shared layer (Stream A): per-player signals for the trade calculator (B) and
// the team page (C). Contract: docs/nba-trade-team-spec.md §3.3.
// Example output: docs/nba-spec/fixtures/signals.example.json.
//
//   playerSignals(player, ctx) → Signals
//   signalsFor(players, ctx)   → Map<id, Signals>
//   ctx = { profile, currentWeek, weeks: [{ week, weight, playoff }], logs, proj, market, eta, bio, replacement, today }
//
// Every number is finite or null (never NaN). Form/minutes are measured from
// the newest season with ≥ 5 logged games (statSeason) and carry `stale` when
// the last logged game is more than 21 days old. Form is shown, never
// multiplied into value (the model's recency weighting already prices it).
// `usage` stays null until Stream D adds fga/fta to the compact logs.
// market.impliedValue = hsValue of the board player at the market rank (board
// sorted by hsValue, linear between ranks, past the board → replacement); it
// needs the whole board, so signalsFor builds that curve from `players` (a lone
// playerSignals call can pass ctx.board). Per-ctx work (calendar, market index,
// league-average schedule) is memoised on the ctx object: build a new ctx
// rather than mutating one between calls.
'use strict';
const Sc = require('./score');
const Board = require('./board');
const ETA = require('./injury-eta');
const { epochDay, dayToDate } = require('./sleeper');
const { todayEt } = require('./league-sync');

const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';

// Thresholds shared with the NFL side (shared/factors.js) and nba/model/research.js.
const FORM_HOT = 1.20, FORM_COLD = 0.80, FORM_GAMES = 5, FORM_MIN_SEASON_GAMES = 10, FORM_MIN_MEAN = 10;
const MINUTES_TREND = 3;            // ± minutes per game, last 5 vs season
const STALE_DAYS = 21;
const HEAVY_WEEK = 4, LIGHT_WEEK = 2;
const MARKET_WEIGHT0 = 0.30, MARKET_DECAY_WEEKS = 10;   // weight = 0.30 · max(0, 1 − (week−1)/10)
const ROLE_MIN = 0.7, ROLE_MAX = 1.4;                   // the model's ρ clamp
const SCHEDULE_EDGE = 0.05;         // horizon games ≥ 5% above / below the league's average team → heavy / light
const THIN_SAMPLE = 20;
// Flag vocabulary ('out-until' is emitted as out-until-wk<N>).
const FLAGS = ['hot', 'cold', 'minutes-up', 'minutes-down', 'out-until', 'ofs', 'heavy-schedule', 'light-schedule', 'market-value', 'market-reach', 'rookie', 'new-team', 'thin-sample', 'stale-stats'];

const fin = x => typeof x === 'number' && Number.isFinite(x);
const num = x => (fin(x) ? x : 0);
const orNull = x => (fin(x) ? x : null);
const r1 = x => (fin(x) ? Math.round(x * 10) / 10 : null);
const r2 = x => (fin(x) ? Math.round(x * 100) / 100 : null);
const r3 = x => (fin(x) ? Math.round(x * 1000) / 1000 : null);
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function marketWeight(currentWeek) {
  const w = Number(currentWeek) || 1;
  return Math.max(0, MARKET_WEIGHT0 * (1 - (w - 1) / MARKET_DECAY_WEEKS));
}

const isoDay = v => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return todayEt();
};

/* ------------------------------------------------------------ per-ctx prep */
const prepared = new WeakMap();
function prepare(ctx, players = null) {
  const hit = prepared.get(ctx);
  if (hit && (!players || hit.players === players)) return hit;
  const profile = ctx.profile || null;
  const cw = Number(ctx.currentWeek) || 1;
  const calendar = profile && Array.isArray(profile.weeks) ? profile.weeks : [];
  let weeks = Array.isArray(ctx.weeks) && ctx.weeks.length
    ? ctx.weeks.map(w => (fin(w) ? { week: w, weight: 1, playoff: false } : { week: Number(w.week), weight: fin(w.weight) ? w.weight : 1, playoff: !!w.playoff })).filter(w => Number.isInteger(w.week))
    : calendar.filter(w => w.week >= cw).map(w => ({ week: w.week, weight: 1, playoff: !!w.playoffs }));
  const wSum = weeks.reduce((s, w) => s + w.weight, 0);
  const today = isoDay(ctx.today);
  const todayDay = epochDay(today);
  const winOf = w => calendar.find(x => Number(x.week) === Number(w)) || null;

  // Market rows by Yahoo pid / board id (enrich.js join order).
  const mByPid = new Map(), mById = new Map();
  for (const r of (ctx.market && Array.isArray(ctx.market.rows)) ? ctx.market.rows : []) {
    if (r.yahooPid != null) mByPid.set(String(r.yahooPid), r);
    if (r.id != null) mById.set(String(r.id), r);
  }
  // Replacement level averaged over the horizon (past-the-board implied value).
  const pw = ctx.replacement && ctx.replacement.perWeek;
  const replAvg = pw && wSum ? weeks.reduce((s, w) => s + w.weight * num(pw[w.week]), 0) / wSum : null;
  // rank → value curve over the board.
  const boardList = players || (Array.isArray(ctx.board) ? ctx.board : null);
  const curve = boardList ? boardList.map(p => p.hsValue).filter(fin).sort((a, b) => b - a) : null;

  // Team games over the horizon (imputed dates, as the board counts them) → league average.
  const rawDates = ctx.proj && ctx.proj.teamDates ? ctx.proj.teamDates : null;
  let avgTeamGames = null;
  if (rawDates && calendar.length) {
    const imp = Board.imputeUnscheduled(rawDates).teamDates;
    const wins = weeks.map(w => winOf(w.week)).filter(Boolean).map(w => [epochDay(w.start), epochDay(w.end)]);
    const totals = Object.values(imp).map(days => days.filter(d => wins.some(([lo, hi]) => d >= lo && d <= hi)).length);
    avgTeamGames = totals.length ? mean(totals) : null;
  }
  const d = { players, profile, cw, calendar, weeks, wSum, today, todayDay, winOf, mByPid, mById, replAvg, curve, rawDates, avgTeamGames };
  prepared.set(ctx, d);
  return d;
}

// hsValue at a (possibly fractional) rank on the board curve.
function impliedAt(d, rank) {
  if (!d.curve || !d.curve.length || !fin(rank) || rank < 1) return null;
  if (rank > d.curve.length) return fin(d.replAvg) ? d.replAvg : d.curve[d.curve.length - 1];
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return d.curve[lo - 1] + (d.curve[hi - 1] - d.curve[lo - 1]) * (rank - lo);
}

// Logged games of one player, newest season first, before today.
function seasonsOf(logs, pid, todayDay) {
  const out = [];
  for (const f of Array.isArray(logs) ? logs : []) {
    const p = f && f.players && f.players[pid];
    if (!p || !Array.isArray(p.g)) continue;
    const rows = p.g.filter(g => Array.isArray(g) && g[0] < todayDay).sort((a, b) => a[0] - b[0]);
    if (rows.length) out.push({ season: Number(f.season), rows });
  }
  return out.sort((a, b) => b.season - a.season);
}

// Rotowire minutes for the current matchup week (Sleeper weeks inside it), else the season projection.
function projectedMinutes(d, proj, pid) {
  if (!proj) return null;
  const weekly = (proj.weekly && proj.weekly[pid]) || {};
  const win = d.winOf(d.cw);
  const sleeperWeeks = win && proj.weeks
    ? Object.keys(proj.weeks).filter(w => { const r = proj.weeks[w]; return Array.isArray(r) && epochDay(r[0]) >= epochDay(win.start) && epochDay(r[0]) <= epochDay(win.end); })
    : [String(d.cw)];
  for (const w of sleeperWeeks) { const row = weekly[w]; if (row && row[0] > 0 && fin(row[1])) return row[1]; }
  const sp = proj.seasonProj && proj.seasonProj[pid];
  return sp && sp[0] > 0 && fin(sp[1]) ? sp[1] : null;
}

// Back-to-backs (consecutive game days) in the current and next matchup week.
function backToBacks(d, team) {
  if (!d.rawDates || !team || !d.rawDates[team]) return null;
  const a = d.winOf(d.cw), b = d.winOf(d.cw + 1) || a;
  if (!a) return null;
  const lo = epochDay(a.start), hi = epochDay(b.end);
  const days = [...new Set(d.rawDates[team].filter(x => x >= lo && x <= hi))].sort((x, y) => x - y);
  let n = 0;
  for (let i = 1; i < days.length; i++) if (days[i] - days[i - 1] === 1) n++;
  return n;
}

function playerSignals(player, ctx = {}) {
  const d = prepare(ctx);
  const id = String(player.id);
  const hs = player.hsByWeek || null;
  const gbw = player.gamesByWeek || {};
  const cw = d.cw;

  /* value */
  const ros = hs && d.wSum ? d.weeks.reduce((s, w) => s + w.weight * num(hs[w.week]), 0) / d.wSum : num(player.hsValue);
  const m = orNull(player.mean), sd = orNull(player.sd), ceil = orNull(player.ceiling);
  const value = {
    ros: r1(ros), now: hs ? r1(hs[cw]) : null, next: hs ? r1(hs[cw + 1]) : null,
    mean: m, sd, ceiling: ceil, floor: orNull(player.floor),
    cv: m > 0 && sd != null ? r3(sd / m) : null,
    ceilingShare: m > 0 && ceil != null ? r3((ceil - m) / m) : null,
    vorp: orNull(player.vorp), vorpRank: orNull(player.vorpRank), rank: orNull(player.rank), tier: orNull(player.tier),
    blended: null,
  };

  /* form + minutes (statSeason = newest season with ≥ 5 games) */
  const seasons = seasonsOf(ctx.logs, id, d.todayDay);
  const stat = seasons.find(s => s.rows.length >= FORM_GAMES) || null;
  const lastLogged = seasons.length ? Math.max(...seasons.map(s => s.rows[s.rows.length - 1][0])) : null;
  const staleStats = lastLogged != null && d.todayDay - lastLogged > STALE_DAYS;
  let form = null;
  const minutes = { mpg: null, last5: null, delta: null, trend: null, projected: null, roleShift: null };
  if (stat) {
    const rows = stat.rows;
    const scores = rows.map(g => (d.profile && Sc.hasLine(g) ? Sc.rowScore(g, d.profile) : num(g[2])));
    const n = scores.length;
    const seasonMean = mean(scores), last5 = mean(scores.slice(-FORM_GAMES));
    const ratio = seasonMean > 0 ? last5 / seasonMean : null;
    const qualifies = n >= FORM_MIN_SEASON_GAMES && seasonMean >= FORM_MIN_MEAN && ratio != null;
    const lastDay = rows[n - 1][0];
    form = {
      last5: r1(last5), seasonMean: r1(seasonMean), ratio: r2(ratio), delta: r1(last5 - seasonMean),
      label: qualifies ? (ratio >= FORM_HOT ? 'hot' : ratio <= FORM_COLD ? 'cold' : null) : null,
      games: n, lastGameDate: dayToDate(lastDay), stale: d.todayDay - lastDay > STALE_DAYS,
    };
    const mins = rows.map(g => num(g[3]));
    const mpg = mean(mins), l5 = mean(mins.slice(-FORM_GAMES));
    minutes.mpg = r1(mpg); minutes.last5 = r1(l5); minutes.delta = r1(l5 - mpg);
    minutes.trend = l5 - mpg >= MINUTES_TREND ? 'up' : l5 - mpg <= -MINUTES_TREND ? 'down' : 'flat';
  }
  minutes.projected = r1(projectedMinutes(d, ctx.proj, id));
  if (minutes.projected > 0 && minutes.mpg > 0) minutes.roleShift = r3(clamp(minutes.projected / minutes.mpg, ROLE_MIN, ROLE_MAX));

  /* availability (the board's ETA-aware week availability) */
  const e0 = player.eta || (ctx.eta ? ETA.matchEta(ctx.eta, player, { logs: ctx.logs, now: d.today, weeks: d.calendar }) : null);
  const eta = e0 && e0.returnDate ? {
    returnDate: e0.returnDate, returnWeek: e0.returnWeek ?? ETA.weekOfDate(d.calendar, e0.returnDate), status: e0.status,
    bodyPart: e0.bodyPart || null, detail: e0.detail || null, comment: e0.comment || null, source: 'espn', asOf: e0.asOf || null, stale: !!e0.stale,
  } : null;
  const byWeek = {};
  let missed = 0;
  for (const w of d.weeks) {
    const a = clamp(num(Board.weekAvailability(player, w.week, cw)), 0, 1);
    byWeek[w.week] = r3(a);
    missed += num(gbw[w.week]) * (1 - a);
  }
  const availability = {
    a0: orNull(player.availability), status: player.injury || null, bodyPart: player.injuryBody || (eta && eta.bodyPart) || null,
    notes: player.injuryNotes || null, eta, outForSeason: !!player.outForSeason, byWeek, expectedGamesMissed: r1(missed),
  };

  /* schedule */
  const horizonGames = d.weeks.reduce((s, w) => s + num(gbw[w.week]), 0);
  const schedule = {
    gamesByWeek: Object.fromEntries(d.weeks.map(w => [w.week, num(gbw[w.week])])),
    gamesRemaining: Object.keys(gbw).filter(w => Number(w) >= cw).reduce((s, w) => s + num(gbw[w]), 0),
    gamesThisWeek: gbw[cw] != null ? num(gbw[cw]) : null,
    heavyWeeks: d.weeks.filter(w => num(gbw[w.week]) >= HEAVY_WEEK).length,
    lightWeeks: d.weeks.filter(w => num(gbw[w.week]) <= LIGHT_WEEK).length,
    playoffGames: d.calendar.length
      ? d.calendar.filter(w => w.playoffs && w.week >= cw).reduce((s, w) => s + num(gbw[w.week]), 0)
      : d.weeks.filter(w => w.playoff).reduce((s, w) => s + num(gbw[w.week]), 0),
    b2bNext2: backToBacks(d, player.team),
  };

  /* market (preseason prior; decaying weight; Value axis only) */
  const row = (player.yahooPid != null && d.mByPid.get(String(player.yahooPid))) || d.mById.get(id)
    || (player.marketRank != null ? { marketRank: player.marketRank, adpDelta: player.adpDelta, label: player.label, contested: player.contested, confidence: player.marketConfidence, thin: player.marketThin } : null);
  const rank = row ? orNull(row.marketRank) : null;
  const weight = marketWeight(cw) * (row && (row.contested || row.thin) ? 0.5 : 1);
  const implied = rank != null ? impliedAt(d, rank) : null;
  const market = {
    rank, adpDelta: row ? orNull(row.adpDelta) : null, label: row && row.label ? String(row.label) : null, contested: !!(row && row.contested),
    confidence: row ? orNull(row.confidence) : null,
    yahooPreRank: orNull(player.yahooPreRank != null ? player.yahooPreRank : row && row.yahooPreRank),
    pctRos: orNull(player.yahooPctRos != null ? player.yahooPctRos : row && row.yahooPctRos),
    impliedValue: r1(implied), weight: r3(weight),
  };
  value.blended = rank != null && implied != null ? r1((1 - weight) * ros + weight * implied) : value.ros;

  /* bio */
  const b = ctx.bio ? (ctx.bio instanceof Map ? ctx.bio.get(id) : ctx.bio[id]) : null;
  const age = b ? orNull(b.a != null ? b.a : b.age) : null;
  const exp = b ? orNull(b.x != null ? b.x : b.exp != null ? b.exp : b.years_exp) : null;
  const bio = { age, exp, rookie: exp === 0 || player.source === 'rookie' };

  /* uncertainty (trade.js uncertainty, ETA- and staleness-aware) */
  const injured = !!(player.injury || player.outForSeason || (eta && !eta.stale));
  let u = 0.10;
  if (player.source !== 'logs') u += 0.10;
  if (injured) u += eta && !eta.stale ? 0.04 : 0.08;
  if (num(player.sampleGames) < THIN_SAMPLE) u += 0.05;
  if (form && form.stale && player.source === 'logs') u += 0.05;

  /* flags */
  const flags = [];
  if (form && form.label) flags.push(form.label);
  if (minutes.trend === 'up') flags.push('minutes-up');
  if (minutes.trend === 'down') flags.push('minutes-down');
  if (eta && !eta.stale && eta.status !== 'OFS' && !player.outForSeason && eta.returnWeek != null && eta.returnWeek > cw) flags.push(`out-until-wk${eta.returnWeek}`);
  if (player.outForSeason || (eta && !eta.stale && eta.status === 'OFS')) flags.push('ofs');
  if (fin(d.avgTeamGames) && d.avgTeamGames > 0 && hs) {
    if (horizonGames >= (1 + SCHEDULE_EDGE) * d.avgTeamGames) flags.push('heavy-schedule');
    else if (horizonGames <= (1 - SCHEDULE_EDGE) * d.avgTeamGames) flags.push('light-schedule');
  }
  if (market.label === 'value') flags.push('market-value');
  if (market.label === 'reach') flags.push('market-reach');
  if (bio.rookie) flags.push('rookie');
  if (player.newTeam) flags.push('new-team');
  if (num(player.sampleGames) < THIN_SAMPLE && player.source !== 'rookie') flags.push('thin-sample');
  if (staleStats) flags.push('stale-stats');

  return {
    id, name: player.name, team: player.team || null,
    pos: Array.isArray(player.pos) ? player.pos : [],
    elig: Array.isArray(player.yahooElig) ? player.yahooElig : Array.isArray(player.elig) ? player.elig : [],
    source: player.source, sampleGames: Number.isInteger(player.sampleGames) ? player.sampleGames : 0,
    statSeason: stat ? stat.season : null,
    value, form, minutes,
    usage: { fga: null, fta: null, usageRate: null, trend: null },
    availability, schedule, market, bio,
    uncertainty: r2(Math.min(0.35, u)),
    flags,
  };
}

function signalsFor(players, ctx = {}) {
  const list = Array.isArray(players) ? players : [];
  prepare(ctx, list);
  const out = new Map();
  for (const p of list) if (p && p.id != null) out.set(String(p.id), playerSignals(p, ctx));
  return out;
}

module.exports = {
  playerSignals, signalsFor, marketWeight,
  FORM_HOT, FORM_COLD, FORM_GAMES, FORM_MIN_SEASON_GAMES, FORM_MIN_MEAN, MINUTES_TREND, STALE_DAYS, HEAVY_WEEK, LIGHT_WEEK,
  MARKET_WEIGHT0, MARKET_DECAY_WEEKS, SCHEDULE_EDGE, FLAGS, NOT_IMPLEMENTED,
};
