// Turn loaded data (players + game logs + projections/schedule) into the
// ranked High Score board. Pure: same inputs → same output.
'use strict';
const St = require('./stats');
const Fit = require('./fit');
const Sc = require('./score');
const Slots = require('./slots');
const Yahoo = require('./yahoo');
const { normalizeName } = require('./names');
const { epochDay } = require('./sleeper');

const MIN_LOG_GAMES = 5;       // fewer played games than this → projection-only
const MIN_SHAPE_NEFF = 10;     // new-team players keep their own shape only with this much data
const AVAIL_PRIOR = 0.85;      // league-typical share of team games a rostered player plays
const AVAIL_PRIOR_GAMES = 20;
const TIER_POOL = 200;
const HEALTHY_FLOOR = 0.55;      // 2025: active players with a0 0.2-0.4 still played ~55% of games         // players tiered by gap; everyone beyond is the last tier

// Probability the player suits up for a given game in week w (d = w − current week).
function availability(p, a0, d) {
  if (p.outForSeason) return 0;
  const st = (p.injury || '').toUpperCase();
  const surgery = /surgery/i.test(p.injuryNotes || '');
  if (d < 0) return a0;
  if (st === 'OUT') {
    if (surgery) return d < 3 ? 0 : Math.min(a0, 0.15 * (d - 2));
    return Math.min(a0, 0.1 + 0.25 * d);
  }
  if (st === 'IR' || st === 'SUS') return d < 4 ? 0.02 : Math.min(a0, 0.25 * (d - 3));
  if (st === 'DOUBTFUL') return d === 0 ? 0.3 : a0;
  if (st === 'DTD' || st === 'GTD' || st === 'QUESTIONABLE') return d === 0 ? 0.75 * Math.max(a0, HEALTHY_FLOOR) : a0;
  // 2025 calibration: players who played last week then played a share of games ≈ a0.
  return Math.max(a0, HEALTHY_FLOOR);
}

function isOutForSeason(sp) {
  if (/season|OFS/i.test(sp.i || '')) return true;
  return /surgery/i.test(sp.in || '') && /achilles|acl/i.test(sp.ib || '');
}

function elig(pos) {
  const out = [];
  if (pos.some(p => p === 'PG' || p === 'SG')) out.push('G');
  if (pos.some(p => p === 'SF' || p === 'PF' || p === 'C')) out.push('F');
  out.push('UTIL');
  return out;
}

const r1 = x => Math.round(x * 10) / 10;

// Count of sorted epoch days in [lo, hi].
function countIn(days, lo, hi) {
  let n = 0;
  for (const d of days || []) if (d >= lo && d <= hi) n++;
  return n;
}

// Sleeper's 2026-27 schedule has 80 games per team: the 2 games the NBA fills
// in after the NBA Cup group stage aren't dated yet, and every team has a
// league-wide gap (2026-12-03..12-11) where they will land. For matchup-week
// game counts we place each team's missing games (82 − scheduled, at most 4)
// in the middle of the longest league-wide no-game run in the first 75 days.
const SEASON_GAMES = 82;
function imputeUnscheduled(teamDates) {
  const all = new Set();
  let first = Infinity;
  for (const days of Object.values(teamDates)) for (const d of days) { all.add(d); if (d < first) first = d; }
  if (!Number.isFinite(first)) return { teamDates, window: null };
  let best = null, runStart = null;
  for (let d = first; d <= first + 75; d++) {
    if (!all.has(d)) { if (runStart == null) runStart = d; }
    else if (runStart != null) {
      if (!best || d - runStart > best[1] - best[0] + 1) best = [runStart, d - 1];
      runStart = null;
    }
  }
  if (!best || best[1] - best[0] + 1 < 3) return { teamDates, window: null };
  const mid = best[0] + Math.floor((best[1] - best[0]) / 2);
  const out = {};
  for (const [team, days] of Object.entries(teamDates)) {
    const missing = SEASON_GAMES - days.length;
    out[team] = missing > 0 && missing <= 4
      ? days.concat(Array.from({ length: missing }, (_, i) => mid + i)).sort((a, b) => a - b)
      : days;
  }
  return { teamDates: out, window: best };
}

// data = { players: {pid: slim}, logs: [logs-YYYY...], proj, state }
// opts = { week?: number, now?: Date, profile?: league profile (nba/league-profile.js) }
// Without a profile: legacy High Score board (1/1/2/3/3 `hs` column, Sleeper weeks).
// With a profile: every game is re-scored with profile.scoring, weeks are the
// profile's matchup weeks (team games counted by date, so 14-day weeks get ~2x
// games), and players get yahooElig / vorpBySlot / vorp / vorpRank.
function buildBoard(data, opts = {}) {
  const proj = data.proj;
  const season = proj.season;
  const profile = opts.profile || null;
  const weeks = Object.keys(proj.weeks).map(Number).sort((a, b) => a - b);
  const now = opts.now || new Date();
  const asOfDay = epochDay(now.toISOString().slice(0, 10));
  const st = data.state || {};
  const reqWeek = opts.week != null && opts.week !== '' ? Number(opts.week) : null;

  // Week definitions: { week, sleeperWeeks, lo, hi } (lo/hi epoch days, profile only).
  let weekDefs, currentWeek, teamDates = null;
  if (profile) {
    if (!profile.weeks || !profile.weeks.length) throw new Error('nba model: profile has no weeks');
    if (!proj.teamDates) throw new Error('nba model: projection snapshot has no team dates (re-run scripts/nba-ingest.js)');
    teamDates = imputeUnscheduled(proj.teamDates).teamDates;
    weekDefs = profile.weeks.map(pw => {
      const lo = epochDay(pw.start), hi = epochDay(pw.end);
      return { week: pw.week, lo, hi, sleeperWeeks: weeks.filter(w => { const d = epochDay(proj.weeks[w][0]); return d >= lo && d <= hi; }) };
    });
    const cur = weekDefs.find(d => asOfDay <= d.hi);
    currentWeek = cur ? (asOfDay < weekDefs[0].lo ? weekDefs[0].week : cur.week) : weekDefs[weekDefs.length - 1].week + 1;
  } else {
    weekDefs = weeks.map(w => ({ week: w, sleeperWeeks: [w] }));
    currentWeek = weeks[0];
    if (String(st.season) === season && st.season_type === 'regular') currentWeek = st.week;
    else if (String(st.season) === season && st.season_type === 'post') currentWeek = weeks[weeks.length - 1] + 1;
  }
  const weekDef = w => weekDefs.find(d => d.week === w) || null;
  const gamesIn = (team, wd) => (profile
    ? countIn(teamDates[team], wd.lo, wd.hi)
    : (proj.teamGames[team] || {})[wd.week] || 0);

  // Merge logs across seasons (older first so the newest season sets the team).
  // Under a profile each game's sample is its profile score; raw rows feed extras.
  const logs = {};
  for (const file of [...data.logs].sort((a, b) => a.season - b.season)) {
    for (const [pid, p] of Object.entries(file.players)) {
      const L = (logs[pid] ||= { g: [], raw: [], rostered: 0, team: null });
      for (const g of p.g) {
        if (g[0] >= asOfDay) continue;
        if (profile) { L.g.push([g[0], g[1], Sc.rowScore(g, profile), g[3]]); L.raw.push(g); }
        else L.g.push(g);
      }
      for (const n of Object.values(p.rw)) L.rostered += n;
      L.team = p.t;
    }
  }
  const curve = profile ? Sc.ddCurve(data.logs) : null;
  const profileSlots = new Set(profile ? Slots.startingSlots(profile) : []);

  const rows = [];
  for (const [pid, sp] of Object.entries(data.players)) {
    const L = logs[pid] || { g: [], raw: [], rostered: 0, team: null };
    const sProj = proj.seasonProj[pid];
    const wProj = proj.weekly[pid] || {};
    const rawProjAt = w => (wProj[w] && wProj[w][0] > 0 ? wProj[w] : sProj && sProj[0] > 0 ? sProj : null);
    const extras = profile ? Sc.playerExtras(L.raw, asOfDay) : null;
    // [mean per game, minutes, n]; under a profile the mean is the profile score of the projected line.
    const projAt = !profile ? rawProjAt : w => {
      const row = rawProjAt(w);
      if (!row || row.length < 9) return null;
      const means = { pts: row[3], reb: row[4], ast: row[5], stl: row[6], blk: row[7], to: row[8] };
      return [Sc.projectedMean(means, row[1], extras, curve, profile), row[1], row[2]];
    };
    // Projection for a matchup week: games-weighted over its Sleeper weeks.
    const projIn = wd => {
      if (!profile) return projAt(wd.week);
      let m = 0, mn = 0, n = 0;
      for (const w of wd.sleeperWeeks) {
        const k = (proj.teamGames[sp.t] || {})[w] || 0;
        const pr = k ? projAt(w) : null;
        if (pr) { m += pr[0] * k; mn += pr[1] * k; n += k; }
      }
      return n ? [m / n, mn / n, n] : projAt(wd.sleeperWeeks[0] ?? -1);
    };
    const nowDef = weekDef(reqWeek || currentWeek);
    const projNow = (nowDef && projIn(nowDef)) || projAt(-1);
    const newTeam = !!(L.team && L.team !== sp.t);
    rows.push({
      pid, sp, L, projAt, projIn, projNow, newTeam,
      pos: sp.p && sp.p.length ? sp.p : ['F'],
      a0: Math.min(0.98, Math.max(0.4, (L.g.length + AVAIL_PRIOR * AVAIL_PRIOR_GAMES) / (L.rostered + AVAIL_PRIOR_GAMES))),
    });
  }

  // Pass 1: log-based fits.
  for (const r of rows) {
    if (r.L.g.length < MIN_LOG_GAMES) continue;
    const projMean = r.projNow ? r.projNow[0] : 0;
    const projMin = r.projNow ? r.projNow[1] : 0;
    if (r.newTeam && projMean > 0) {
      const f = Fit.fitLogs(r.L.g, { asOfDay, projMin, meanOverride: projMean });
      if (f.nEff >= MIN_SHAPE_NEFF) { r.fit = f; r.source = 'projection-only'; }
    } else {
      r.fit = Fit.fitLogs(r.L.g, { asOfDay, projMean, projMin });
      r.source = 'logs';
    }
    if (r.fit) r.fit.pos = r.pos;
  }
  const pooled = Fit.pooledCv(rows.map(r => r.fit).filter(Boolean));
  // Pass 2: projection-only (rookies, thin logs, new team with thin logs).
  for (const r of rows) {
    if (r.fit) continue;
    if (r.projNow) {
      r.fit = Fit.fitProjection(r.projNow[0], Fit.cvFor(pooled, r.pos, r.projNow[1]));
      r.source = r.sp.x === 0 && !r.L.g.length ? 'rookie' : 'projection-only';
    } else {
      r.source = r.sp.x === 0 && !r.L.g.length ? 'rookie' : 'projection-only';
    }
  }

  const players = rows.map(r => {
    const f = r.fit;
    const outForSeason = isOutForSeason(r.sp);
    const info = { injury: r.sp.i, injuryNotes: r.sp.in, outForSeason };
    const gamesByWeek = {};
    const hsByWeek = {};
    for (const wd of weekDefs) {
      const w = wd.week;
      const n = gamesIn(r.sp.t, wd);
      gamesByWeek[w] = n;
      if (!f || !n) { hsByWeek[w] = 0; continue; }
      // Week-specific mean: the projection for that week's opponents, shrunk exactly like the base fit.
      let scale = 1;
      const pw = r.projIn(wd);
      if (pw && f.mean > 0) {
        let mw;
        if (f.kind === 'projection' || r.source === 'projection-only') mw = pw[0];
        else mw = (f.nEff * f.empMean * f.rho + Fit.PARAMS.priorGames * pw[0]) / (f.nEff + Fit.PARAMS.priorGames);
        scale = mw / f.mean;
      }
      const a = availability(info, r.a0, w - currentWeek);
      hsByWeek[w] = r1(St.expectedMaxAvail(k => f.emax[Math.min(k, f.emax.length - 1)] * scale, n, a));
    }
    let hsValue, games;
    if (reqWeek != null) {
      hsValue = hsByWeek[reqWeek] || 0;
      games = gamesByWeek[reqWeek] || 0;
    } else {
      // Pre-draft / rest-of-season: average over remaining weeks.
      // Each matchup week counts once (equal weight for standings): a 14-day
      // week's larger E[max] raises everyone's average, not just some players'.
      const all = weekDefs.map(d => d.week);
      const rest = all.filter(w => w >= currentWeek);
      const ws = rest.length ? rest : all;
      hsValue = r1(ws.reduce((s, w) => s + hsByWeek[w], 0) / ws.length);
      games = r1(ws.reduce((s, w) => s + gamesByWeek[w], 0) / ws.length);
    }
    return {
      id: r.pid,
      name: r.sp.n,
      team: r.sp.t,
      pos: r.pos,
      elig: elig(r.pos),
      yahooElig: profile ? Slots.slotsForPositions(r.pos).filter(s => profileSlots.has(s)) : Slots.slotsForPositions(r.pos),
      eligConfidence: 'sleeper-mapped',
      injury: outForSeason ? (r.sp.i || 'Out') : r.sp.i,
      outForSeason,
      mean: f ? r1(f.mean) : 0,
      sd: f ? r1(f.sd) : 0,
      games,
      gamesByWeek,
      hsValue,
      hsByWeek,
      ceiling: f ? r1(f.ceiling) : 0,
      floor: f ? r1(f.floor) : 0,
      rank: 0, tier: 0, posRank: 0, posRanks: {},
      sampleGames: r.L.g.length,
      source: r.source,
      availability: Math.round(r.a0 * 100) / 100,
      newTeam: r.newTeam,
      _norm: normalizeName(r.sp.n),
    };
  });

  players.sort((a, b) => b.hsValue - a.hsValue || b.mean - a.mean || a.name.localeCompare(b.name));
  players.forEach((p, i) => { p.rank = i + 1; });
  assignTiers(players);
  const counters = { G: 0, F: 0 };
  for (const p of players) {
    for (const g of ['G', 'F']) if (p.elig.includes(g)) p.posRanks[g] = ++counters[g];
    p.posRank = Math.min(p.posRanks.G || Infinity, p.posRanks.F || Infinity);
    if (!Number.isFinite(p.posRank)) p.posRank = 0;
  }
  // _norm is an internal match index; keep it non-enumerable so it never hits JSON.
  for (const p of players) Object.defineProperty(p, '_norm', { value: p._norm, enumerable: false });
  let vorpMeta = null, yahooMeta = null;
  if (profile) {
    // Yahoo positions/identity first: slot VORP reads yahooElig.
    yahooMeta = Yahoo.applyYahoo(players, { leagueId: profile.leagueId || Yahoo.DEFAULT_LEAGUE, profileSlots });
    vorpMeta = Slots.applyVorp(players, profile);
  }
  return { season: Number(season), week: reqWeek, currentWeek, players, vorpMeta, yahooMeta };
}

// Gap-based tiers: a new tier starts where the drop to the next player is in
// the top 15% of gaps among the top TIER_POOL (min 0.5 HS points).
function assignTiers(players) {
  const pool = players.slice(0, TIER_POOL);
  const gaps = [];
  for (let i = 0; i < pool.length - 1; i++) gaps.push(pool[i].hsValue - pool[i + 1].hsValue);
  const sorted = [...gaps].sort((a, b) => a - b);
  const thresh = Math.max(0.5, sorted[Math.floor(sorted.length * 0.85)] || 0);
  let tier = 1;
  for (let i = 0; i < players.length; i++) {
    if (i > 0 && i < pool.length && gaps[i - 1] >= thresh) tier++;
    if (i === pool.length) tier++;
    players[i].tier = tier;
  }
}

module.exports = { buildBoard, imputeUnscheduled, availability, HEALTHY_FLOOR, elig, isOutForSeason, MIN_LOG_GAMES };
