// Sleeper NBA fetch + compaction. Shared by scripts/nba-ingest.js (writes the
// committed snapshot in data/nba/) and nba/model/data.js (runtime refresh), so
// both paths apply the exact same dedupe rule.
//
// DEDUPE RULE (see docs/nba-model.md §Data): api.sleeper.com/stats/nba/{season}/{week}
// emits one row per (player, TEAM game) for every rostered player — DNPs come
// back as rows with an empty `stats` object. A per-player game log is:
//   1. keep rows with stats.sp > 0 (seconds played; drops DNP placeholders),
//   2. keep rows where team AND opponent are one of the 30 franchises (drops the
//      All-Star game, which leaks in as team STP/STR/null on 2026-02-15),
//   3. dedupe on (player_id, game_id) — defensive; trade days produce one empty
//      row per old AND new team, which rule 1 already removes.
// Rows that pass rule 2 (played or not) count as "rostered games" — the team
// games the player was on a roster for, used for availability and schedule.
'use strict';

const FRANCHISES = new Set([
  'ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW',
  'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK',
  'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS',
]);

// Yahoo High Score per-game score.
function hsScore(st) {
  if (!st) return 0;
  return (st.pts || 0) + (st.reb || 0) + 2 * (st.ast || 0) + 3 * (st.stl || 0) + 3 * (st.blk || 0);
}

// 'YYYY-MM-DD' → integer days since 1970-01-01 (UTC); dates are compared as days.
function epochDay(date) {
  return Math.round(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86400000);
}
function dayToDate(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

async function fetchJson(url, { timeoutMs = 20000, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise(res => setTimeout(res, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

const URLS = {
  state: () => 'https://api.sleeper.app/v1/state/nba',
  players: () => 'https://api.sleeper.app/v1/players/nba',
  stats: (season, week) => `https://api.sleeper.com/stats/nba/${season}/${week}?season_type=regular`,
  proj: (season, week) => `https://api.sleeper.com/projections/nba/${season}/${week}?season_type=regular`,
  seasonProj: season => `https://api.sleeper.com/projections/nba/${season}?season_type=regular`,
};

// Week date ranges + team games per week from any array of per-game rows.
function weekMeta(rowsByWeek) {
  const weeks = {};
  const teamGames = {};
  for (const [w, rows] of Object.entries(rowsByWeek)) {
    const seen = new Set();
    let lo = null, hi = null;
    for (const r of rows) {
      if (!r || !r.date) continue;
      if (!lo || r.date < lo) lo = r.date;
      if (!hi || r.date > hi) hi = r.date;
      if (!FRANCHISES.has(r.team) || !FRANCHISES.has(r.opponent)) continue;
      // game_id identifies a game; a team plays at most once per date.
      const k = r.team + '|' + r.date;
      if (seen.has(k)) continue;
      seen.add(k);
      (teamGames[r.team] ||= {})[w] = (teamGames[r.team][w] || 0) + 1;
    }
    if (lo) weeks[w] = [lo, hi];
  }
  return { weeks, teamGames };
}

// Per-game stat rows for one season → compact log file.
// players[pid] = { t: team of latest row, rw: {week: rostered games}, g: [[epochDay, week, hs, minutes]] }
function compactLogs(season, rowsByWeek) {
  const { weeks, teamGames } = weekMeta(rowsByWeek);
  const players = {};
  const seen = new Set();
  const counts = { rows: 0, dnp: 0, nonFranchise: 0, dupes: 0, played: 0 };
  const latest = {};
  for (const [w, rows] of Object.entries(rowsByWeek)) {
    for (const r of rows) {
      counts.rows++;
      if (!r || !r.player_id) continue;
      if (!FRANCHISES.has(r.team) || !FRANCHISES.has(r.opponent)) { counts.nonFranchise++; continue; }
      const key = r.player_id + '|' + r.game_id;
      if (seen.has(key)) { counts.dupes++; continue; }
      seen.add(key);
      const p = (players[r.player_id] ||= { t: r.team, rw: {}, g: [] });
      if (!latest[r.player_id] || r.date >= latest[r.player_id]) { latest[r.player_id] = r.date; p.t = r.team; }
      p.rw[w] = (p.rw[w] || 0) + 1;
      const st = r.stats || {};
      if (!(st.sp > 0)) { counts.dnp++; continue; }
      counts.played++;
      p.g.push([epochDay(r.date), +w, hsScore(st), Math.round(st.sp / 6) / 10]);
    }
  }
  for (const p of Object.values(players)) p.g.sort((a, b) => a[0] - b[0]);
  return { season: String(season), generatedAt: new Date().toISOString(), weeks, teamGames, dedupe: counts, players };
}

// Per-game projection rows → per-player per-week [mean HS per projected game, mean minutes, projected games].
// Rows projected at 0 minutes (expected DNP) are excluded from the mean and count.
function compactProjections(season, rowsByWeek, seasonRows) {
  const { weeks, teamGames } = weekMeta(rowsByWeek);
  const weekly = {};
  for (const [w, rows] of Object.entries(rowsByWeek)) {
    const acc = {};
    for (const r of rows) {
      if (!r || !r.player_id || !r.stats || !(r.stats.sp > 0)) continue;
      const a = (acc[r.player_id] ||= [0, 0, 0]);
      a[0] += hsScore(r.stats); a[1] += r.stats.sp / 60; a[2]++;
    }
    for (const [pid, [hs, min, n]] of Object.entries(acc)) {
      (weekly[pid] ||= {})[w] = [Math.round(hs / n * 10) / 10, Math.round(min / n * 10) / 10, n];
    }
  }
  const seasonProj = {};
  for (const r of seasonRows || []) {
    if (!r || !r.player_id || !r.stats) continue;
    const gp = r.stats.gp || 1;
    const per = {};
    for (const k of ['pts', 'reb', 'ast', 'stl', 'blk']) per[k] = (r.stats[k] || 0) / gp;
    seasonProj[r.player_id] = [Math.round(hsScore(per) * 10) / 10, Math.round((r.stats.sp || 0) / gp / 6) / 10, r.stats.adp_std ?? null];
  }
  return { season: String(season), generatedAt: new Date().toISOString(), weeks, teamGames, seasonProj, weekly };
}

// Sleeper players map → slim active-roster list.
function compactPlayers(raw) {
  const out = {};
  for (const [id, p] of Object.entries(raw || {})) {
    if (!p || !p.team || !p.active || !FRANCHISES.has(p.team)) continue;
    out[id] = {
      n: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
      t: p.team,
      p: (p.fantasy_positions && p.fantasy_positions.length ? p.fantasy_positions : [p.position]).filter(Boolean),
      i: p.injury_status || null,
      ib: p.injury_body_part || null,
      in: p.injury_notes || null,
      x: p.years_exp ?? null,
      s: p.status || null,
      tc: p.team_changed_at || null,
    };
  }
  return { generatedAt: new Date().toISOString(), players: out };
}

module.exports = {
  FRANCHISES, URLS, hsScore, epochDay, dayToDate, fetchJson,
  weekMeta, compactLogs, compactProjections, compactPlayers,
};
