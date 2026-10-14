// NBA player research data layer (stream R0). Backs /api/nba/research,
// /api/nba/player/:id, /api/nba/search, /api/nba/trending and
// /api/nba/research/meta (nba/routes/research.js). Contract: docs/nba-research-api.md.
//
// Inputs, never copied: the enriched board (router modelPlayers(): model
// getPlayers({ profile }) + market + Yahoo-only rows), the committed game logs
// (nba/model/data.js) and league scoring (nba/league-profile.js via
// nba/model/score.js — no stat weights here).
//
// Context the model doesn't keep is fetched from Sleeper in the background and
// cached in memory + data/nba/cache/research-*.json (gitignored): bios (players
// map), the 2026 schedule (opponents, home/away), per-player game context
// (opponent / home-away per logged game), news and trending. Every fetcher is
// injectable (tests) and NBA_MODEL_OFFLINE=1 disables the network: missing
// context is reported in `unavailable`, never invented.
'use strict';
const fs = require('fs');
const path = require('path');
const Data = require('./data');
const Sc = require('./score');
const St = require('./stats');
const S = require('./sleeper');
const Slots = require('./slots');
const { normalizeName } = require('./names');
const { getProfile, DEFAULT_LEAGUE_ID } = require('../league-profile');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'nba', 'cache');
const ESPN_FILE = path.join(__dirname, '..', '..', 'data', 'nba', 'espn-check.json');
const PROJ_SEASON = 2026;
const HOUR = 3600 * 1000;
const TTL = { bio: 12 * HOUR, schedule: 12 * HOUR, gameCtx: 6 * HOUR, news: 15 * 60 * 1000, trending: 10 * 60 * 1000, failure: 5 * 60 * 1000 };
const POSITIONS = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C'];
const INJ_FILTERS = ['healthy', 'injured', 'out', 'dtd'];
const PROB_THRESHOLDS = [40, 50, 60, 70];
const HIST_BIN = 5;
const BOOM = 1.3, BUST = 0.7; // boom: game ≥ 1.3× his own mean; bust: ≤ 0.7×

const URLS = {
  bio: () => 'https://api.sleeper.app/v1/players/nba',
  schedule: season => `https://api.sleeper.com/schedule/nba/regular/${season}`,
  playerGames: (id, season) => `https://api.sleeper.com/stats/nba/player/${encodeURIComponent(id)}?season_type=regular&season=${season}&grouping=week`,
  news: id => `https://api.sleeper.com/players/nba/${encodeURIComponent(id)}/news`,
  trending: (type, hours, limit) => `https://api.sleeper.app/v1/players/nba/trending/${type}?lookback_hours=${hours}&limit=${limit}`,
};
const IMG = {
  sleeper: id => `https://sleepercdn.com/content/nba/players/${id}.jpg`,
  sleeperThumb: id => `https://sleepercdn.com/content/nba/players/thumb/${id}.jpg`,
  teamLogo: t => `https://sleepercdn.com/images/team_logos/nba/${String(t).toLowerCase()}.png`,
};

// ---- small numeric helpers -------------------------------------------------
const fin = x => typeof x === 'number' && Number.isFinite(x);
const r1 = x => (fin(x) ? Math.round(x * 10) / 10 : null);
const r2 = x => (fin(x) ? Math.round(x * 100) / 100 : null);
const r3 = x => (fin(x) ? Math.round(x * 1000) / 1000 : null);
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function sdOf(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
// Linear-interpolated quantile of an ascending array.
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const dayToDate = S.dayToDate;
const epochDay = S.epochDay;
const todayDay = now => epochDay(now.toISOString().slice(0, 10));

function stripText(s, max = 2000) {
  if (s == null) return null;
  return String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
}
function heightText(inches) {
  const n = Number(inches);
  return n > 0 ? `${Math.floor(n / 12)}-${n % 12}` : null;
}
// Sleeper injury_status → short tag the UI can colour.
function injuryTag(status, outForSeason) {
  if (outForSeason) return 'OFS';
  const s = String(status || '').toUpperCase();
  if (!s) return null;
  if (s === 'OUT' || s === 'O') return 'O';
  if (s === 'DTD' || s === 'GTD' || s === 'QUESTIONABLE' || s === 'Q') return 'DTD';
  if (s === 'DOUBTFUL' || s === 'D') return 'D';
  if (s === 'IR' || s === 'INJ') return 'IL';
  if (s === 'SUS') return 'SUSP';
  return s.slice(0, 6);
}

// ---- JSON file cache in data/nba/cache --------------------------------------
function readCache(dir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; }
}
function writeCache(dir, name, obj) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, name + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, path.join(dir, name));
  } catch { /* cache is best effort */ }
}

// Bounded LRU map.
function lru(max) {
  const m = new Map();
  return {
    get(k) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
    set(k, v) { m.delete(k); m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); },
    clear() { m.clear(); },
    get size() { return m.size; },
  };
}

// ---- per-player log statistics (pure) ---------------------------------------
// rows: compact log rows (sleeper.js) of ONE season, ascending by day.
function logStats(rows, profile) {
  const games = rows.filter(Sc.hasLine);
  const n = games.length;
  if (!n) return null;
  const scores = games.map(g => Sc.rowScore(g, profile));
  const sorted = [...scores].sort((a, b) => a - b);
  const line = {};
  for (const [k, c] of Object.entries(Sc.COL)) line[k] = r1(mean(games.map(g => g[c])));
  const mins = games.map(g => g[3]);
  let dd = 0, td = 0;
  for (const g of games) { const d = Sc.doublesOf(Sc.rowLine(g)); if (d >= 2) dd++; if (d >= 3) td++; }
  const m = mean(scores), sd = sdOf(scores);
  const l5 = scores.slice(-5), l5min = mins.slice(-5);
  const mpg = mean(mins);
  // Weekly best (High Score view): max per Sleeper week of the season.
  const byWeek = new Map();
  games.forEach((g, i) => {
    const w = g[1];
    const cur = byWeek.get(w);
    if (!cur || scores[i] > cur.best) byWeek.set(w, { week: w, best: scores[i], bestDate: dayToDate(g[0]), games: (cur ? cur.games : 0) + 1 });
    else cur.games++;
  });
  const weekly = [...byWeek.values()].sort((a, b) => a.week - b.week);
  const bests = weekly.map(w => w.best);
  return {
    games, scores, sorted, gp: n, line, mpg: r1(mpg),
    mean: r1(m), sd: r1(sd), p10: r1(quantile(sorted, 0.1)), p90: r1(quantile(sorted, 0.9)),
    max: r1(sorted[n - 1]), min: r1(sorted[0]),
    ddPct: r3(dd / n), tdPct: r3(td / n), ddCount: dd, tdCount: td,
    last5: r1(mean(l5)), last5Delta: n >= 5 ? r1(mean(l5) - m) : null,
    last5Min: r1(mean(l5min)), minDelta: n >= 5 ? r1(mean(l5min) - mpg) : null,
    cv: m > 0 && sd != null ? r3(sd / m) : null,
    boomRate: m > 0 ? r3(scores.filter(s => s >= BOOM * m).length / n) : null,
    bustRate: m > 0 ? r3(scores.filter(s => s <= BUST * m).length / n) : null,
    weekly, bestGameAvg: r1(mean(bests)),
  };
}

function roleTrend(st) {
  if (!st || st.minDelta == null) return null;
  if (st.minDelta >= 3) return 'up';
  if (st.minDelta <= -3) return 'down';
  return 'flat';
}

// Histogram of per-game scores in HIST_BIN-wide bins; counts sum to scores.length.
function histogram(scores, width = HIST_BIN) {
  if (!scores.length) return [];
  const lo = Math.floor(Math.min(...scores) / width) * width;
  const hi = Math.floor(Math.max(...scores) / width) * width;
  const bins = [];
  for (let x = lo; x <= hi; x += width) bins.push({ lo: x, hi: x + width, count: 0 });
  for (const s of scores) bins[Math.min(bins.length - 1, Math.floor((s - lo) / width))].count++;
  return bins;
}

// P(best game of the week ≥ T) with n scheduled games, each played with
// probability a: 1 − (1 − a·q)^n, q = P(single game ≥ T). q comes from the
// player's own game-score shape rescaled to the model's forward mean (Gaussian
// kernel smoothing, stats.mixtureGrid); with < 10 logged games, a normal with
// the model's mean/sd.
function weekProbabilities({ scores, logMean, modelMean, modelSd, n, a }) {
  if (!(n > 0) || !fin(modelMean) || !(modelMean > 0)) return null;
  let q;
  if (scores && scores.length >= 10 && logMean > 0) {
    const k = modelMean / logMean;
    const samples = scores.map(s => s * k);
    const sd = sdOf(samples) || modelSd || 1;
    const grid = St.mixtureGrid({ samples, bw: Math.max(1, 1.06 * sd * Math.pow(samples.length, -0.2)) });
    q = T => {
      const { xs, F } = grid;
      if (T <= xs[0]) return 1;
      if (T >= xs[xs.length - 1]) return 0;
      for (let g = 1; g < xs.length; g++) if (xs[g] >= T) {
        const f = F[g - 1] + (F[g] - F[g - 1]) * (T - xs[g - 1]) / (xs[g] - xs[g - 1]);
        return Math.max(0, 1 - f);
      }
      return 0;
    };
  } else {
    const sd = Math.max(modelSd || 0, 1);
    q = T => 1 - St.normCdf((T - modelMean) / sd);
  }
  const avail = fin(a) ? Math.max(0, Math.min(1, a)) : 1;
  const out = {};
  for (const T of PROB_THRESHOLDS) out[T] = r3(1 - Math.pow(1 - avail * q(T), n));
  return out;
}

// ---- research engine ---------------------------------------------------------
function createResearch({
  getBoard,                       // async () => enriched board ({ players, currentWeek, asOf, profile, market })
  loadData = () => Data.load(),
  fetchJson = (url, o) => S.fetchJson(url, { retries: 1, ...o }),
  offline = process.env.NBA_MODEL_OFFLINE === '1',
  now = () => new Date(),
  cacheDir = CACHE_DIR,
  profileId = DEFAULT_LEAGUE_ID,
  log = console,
} = {}) {
  if (typeof getBoard !== 'function') throw new Error('nba research: getBoard required');
  const profile = getProfile(profileId);
  if (!profile) throw new Error(`nba research: unknown profile ${profileId}`);

  // --- background context (bio, schedule) ---
  const ctx = {
    bio: { data: null, at: 0, fail: 0, loading: null, error: null },
    schedule: { data: null, at: 0, fail: 0, loading: null, error: null },
  };
  const disk = name => readCache(cacheDir, name);
  {
    const b = disk('research-bio.json');
    if (b && b.players) { ctx.bio.data = b; ctx.bio.at = Date.parse(b.fetchedAt) || 0; }
    const s = disk(`research-schedule-${PROJ_SEASON}.json`);
    if (s && s.games) { ctx.schedule.data = s; ctx.schedule.at = Date.parse(s.fetchedAt) || 0; }
  }
  function ensure(key, ttl, loader) {
    const c = ctx[key];
    const t = Date.now();
    if (offline || c.loading) return c.loading;
    if (c.data && t - c.at < ttl) return null;
    if (c.fail && t - c.fail < TTL.failure) return null;
    c.loading = loader().then(d => { c.data = d; c.at = Date.now(); c.error = null; c.fail = 0; version++; })
      .catch(err => { c.error = err.message; c.fail = Date.now(); })
      .finally(() => { c.loading = null; });
    return c.loading;
  }
  async function loadBio() {
    const raw = await fetchJson(URLS.bio(), { timeoutMs: 30000 });
    const players = {};
    for (const [id, p] of Object.entries(raw || {})) {
      if (!p || !p.team || !p.active) continue;
      players[id] = {
        a: fin(p.age) ? p.age : null, bd: p.birth_date || null, h: p.height || null, w: p.weight || null,
        c: p.college || null, x: fin(p.years_exp) ? p.years_exp : null, j: p.number ?? null,
        dc: p.depth_chart_position || null, dco: p.depth_chart_order ?? null,
        sr: p.sportradar_id || null, rw: p.rotowire_id ?? null, sw: p.swish_id ?? null,
        es: p.espn_id ?? null, yh: p.yahoo_id ?? null, nu: p.news_updated ?? null, isd: p.injury_start_date || null,
        fn: p.first_name || null, ln: p.last_name || null,
      };
    }
    const doc = { fetchedAt: new Date().toISOString(), source: URLS.bio(), players };
    writeCache(cacheDir, 'research-bio.json', doc);
    return doc;
  }
  async function loadSchedule() {
    const raw = await fetchJson(URLS.schedule(PROJ_SEASON), { timeoutMs: 30000 });
    if (!Array.isArray(raw)) throw new Error('schedule: not an array');
    const games = [];
    for (const g of raw) {
      if (!g || !g.date || !g.home || !g.away) continue;
      games.push([g.date, g.home.team, g.away.team, g.status || null]);
    }
    const doc = { fetchedAt: new Date().toISOString(), season: String(PROJ_SEASON), games };
    writeCache(cacheDir, `research-schedule-${PROJ_SEASON}.json`, doc);
    return doc;
  }
  function warm() {
    return Promise.all([ensure('bio', TTL.bio, loadBio), ensure('schedule', TTL.schedule, loadSchedule)].filter(Boolean));
  }
  // Waits up to ms for in-flight context (detail requests), never throws.
  async function settle(ms) {
    const p = warm();
    let t;
    await Promise.race([p, new Promise(r => { t = setTimeout(r, ms); })]).catch(() => {});
    clearTimeout(t);
  }

  // Team → [{ date, opp, home }] for the 2026 schedule (Sleeper schedule
  // endpoint); null when not loaded.
  let schedIndex = { src: null, byTeam: null };
  function scheduleByTeam() {
    const d = ctx.schedule.data;
    if (!d) return null;
    if (schedIndex.src === d) return schedIndex.byTeam;
    const byTeam = {};
    for (const [date, home, away] of d.games) {
      (byTeam[home] ||= []).push({ date, opp: away, home: true });
      (byTeam[away] ||= []).push({ date, opp: home, home: false });
    }
    for (const l of Object.values(byTeam)) l.sort((a, b) => (a.date < b.date ? -1 : 1));
    schedIndex = { src: d, byTeam };
    return byTeam;
  }

  let espnIds = null;
  function espnIdOf(sid) {
    if (!espnIds) {
      espnIds = new Map();
      try { for (const p of JSON.parse(fs.readFileSync(ESPN_FILE, 'utf8')).players || []) if (p.sleeperId && p.espnId) espnIds.set(String(p.sleeperId), String(p.espnId)); } catch { /* optional */ }
    }
    return espnIds.get(String(sid)) || null;
  }

  // --- index: one research row per board player, rebuilt per board object ---
  let version = 0;
  let index = null; // { board, dataRef, version, rows, byId, byYahoo, ... }

  function seasonFiles(data) {
    return [...data.logs].sort((a, b) => Number(b.season) - Number(a.season));
  }
  // Newest season with logged games for this player → { season, rows }.
  function playerLogs(data, sid) {
    for (const f of seasonFiles(data)) {
      const p = f.players && f.players[sid];
      if (p && p.g && p.g.some(Sc.hasLine)) return { season: f.season, rows: p.g, file: f };
    }
    return null;
  }

  function buildIndex(board, data) {
    const t0 = Date.now();
    const cw = board.currentWeek || 1;
    const bio = ctx.bio.data && ctx.bio.data.players;
    const rows = [];
    const byId = new Map(), byYahoo = new Map(), stats = new Map();
    for (const p of board.players) {
      const yahooOnly = p.source === 'yahoo-only';
      const sid = yahooOnly ? null : String(p.id);
      const sp = sid ? data.players[sid] || null : null;
      const lg = sid ? playerLogs(data, sid) : null;
      const st = lg ? logStats(lg.rows, profile) : null;
      if (st) stats.set(String(p.id), { ...st, season: lg.season, file: lg.file });
      const b = sid && bio ? bio[sid] : null;
      const posList = p.yahooPos && p.yahooPos.length ? p.yahooPos : (p.pos || []);
      const injury = p.injury || null;
      const row = {
        id: String(p.id),
        sleeperId: sid,
        yahooPid: p.yahooPid != null ? String(p.yahooPid) : null,
        name: p.name,
        team: p.team || null,
        teamAbbr: p.team || null,
        pos: posList.join(','),
        posList,
        posSource: p.eligConfidence === 'yahoo' ? 'yahoo' : 'sleeper-mapped',
        yahooElig: p.yahooElig || [],
        injury,
        injuryTag: injuryTag(injury, p.outForSeason),
        injuryNotes: sp ? stripText(sp.in, 300) : null,
        outForSeason: !!p.outForSeason,
        headshot: sid ? IMG.sleeperThumb(sid) : null,
        teamLogo: p.team ? IMG.teamLogo(p.team) : null,
        imageHints: { sleeperId: sid, espnId: sid ? espnIdOf(sid) || (b && b.es != null ? String(b.es) : null) : null, nbaId: null, yahooPid: p.yahooPid != null ? String(p.yahooPid) : null, teamAbbr: p.team || null },
        age: b && fin(b.a) ? b.a : null,
        exp: b && fin(b.x) ? b.x : (sp && fin(sp.x) ? sp.x : null),
        rank: fin(p.rank) ? p.rank : null,
        modelRank: fin(p.modelRank) ? p.modelRank : null,
        tier: fin(p.tier) ? p.tier : null,
        posRank: fin(p.posRank) && p.posRank > 0 ? p.posRank : null,
        vorp: fin(p.vorp) ? p.vorp : null,
        vorpRank: fin(p.vorpRank) ? p.vorpRank : null,
        hsValue: fin(p.hsValue) ? p.hsValue : null,
        hsThisWeek: p.hsByWeek && fin(p.hsByWeek[cw]) ? p.hsByWeek[cw] : null,
        gamesThisWeek: p.gamesByWeek && fin(p.gamesByWeek[cw]) ? p.gamesByWeek[cw] : null,
        mean: yahooOnly ? null : (fin(p.mean) ? p.mean : null),
        sd: yahooOnly ? null : (fin(p.sd) ? p.sd : null),
        ceiling: yahooOnly ? null : (fin(p.ceiling) ? p.ceiling : null),
        floor: yahooOnly ? null : (fin(p.floor) ? p.floor : null),
        availability: fin(p.availability) ? p.availability : null,
        statSeason: st ? Number(lg.season) : null,
        gp: st ? st.gp : 0,
        mpg: st ? st.mpg : null,
        pts: st ? st.line.pts : null, reb: st ? st.line.reb : null, ast: st ? st.line.ast : null,
        stl: st ? st.line.stl : null, blk: st ? st.line.blk : null, to: st ? st.line.to : null, pf: st ? st.line.pf : null,
        scoredPg: st ? st.mean : null,
        scoredSd: st ? st.sd : null,
        scoredP90: st ? st.p90 : null,
        scoredP10: st ? st.p10 : null,
        bestGameAvg: st ? st.bestGameAvg : null,
        ddPct: st ? st.ddPct : null,
        tdPct: st ? st.tdPct : null,
        last5: st ? st.last5 : null,
        last5Delta: st ? st.last5Delta : null,
        last5Min: st ? st.last5Min : null,
        minDelta: st ? st.minDelta : null,
        roleTrend: roleTrend(st),
        marketRank: fin(p.marketRank) ? p.marketRank : null,
        adpDelta: fin(p.adpDelta) ? p.adpDelta : null,
        marketLabel: p.label || null,
        yahooPreRank: fin(p.yahooPreRank) ? p.yahooPreRank : null,
        yahooPctRos: fin(p.yahooPctRos) ? p.yahooPctRos : null,
        source: p.source || null,
      };
      Object.defineProperty(row, '_norm', { value: normalizeName(p.name), enumerable: false });
      Object.defineProperty(row, '_p', { value: p, enumerable: false });
      rows.push(row);
      byId.set(row.id, row);
      if (row.yahooPid) byYahoo.set(row.yahooPid, row);
    }
    const teams = [...new Set(rows.map(r => r.team).filter(Boolean))].sort();
    return { board, data, version, rows, byId, byYahoo, stats, teams, builtMs: Date.now() - t0, builtAt: new Date().toISOString(), queryCache: lru(500), detailCache: lru(300) };
  }

  async function getIndex() {
    warm(); // background; never awaited here
    const board = await getBoard();
    if (!board || !Array.isArray(board.players)) { const e = new Error('NBA player data unavailable'); e.status = 503; throw e; }
    const data = loadData();
    if (!index || index.board !== board || index.data !== data || index.version !== version) index = buildIndex(board, data);
    return index;
  }

  // --- table ---
  const SORT_KEYS = {
    hsValue: r => r.hsValue, rank: r => r.rank, tier: r => r.tier, name: r => r.name, team: r => r.team, pos: r => r.pos,
    age: r => r.age, exp: r => r.exp, posRank: r => r.posRank, vorp: r => r.vorp, hsThisWeek: r => r.hsThisWeek, gamesThisWeek: r => r.gamesThisWeek,
    mean: r => r.mean, sd: r => r.sd, ceiling: r => r.ceiling, floor: r => r.floor, availability: r => r.availability,
    gp: r => r.gp, mpg: r => r.mpg, pts: r => r.pts, reb: r => r.reb, ast: r => r.ast, stl: r => r.stl, blk: r => r.blk, to: r => r.to, pf: r => r.pf,
    scoredPg: r => r.scoredPg, scoredSd: r => r.scoredSd, scoredP90: r => r.scoredP90, scoredP10: r => r.scoredP10, bestGameAvg: r => r.bestGameAvg,
    ddPct: r => r.ddPct, tdPct: r => r.tdPct, last5: r => r.last5, last5Delta: r => r.last5Delta, last5Min: r => r.last5Min, minDelta: r => r.minDelta,
    marketRank: r => r.marketRank, adpDelta: r => r.adpDelta, yahooPreRank: r => r.yahooPreRank, yahooPctRos: r => r.yahooPctRos,
    injury: r => r.injuryTag,
  };
  // Natural direction when dir is omitted: ranks ascend, values descend.
  const ASC_DEFAULT = new Set(['rank', 'tier', 'name', 'team', 'pos', 'age', 'exp', 'posRank', 'marketRank', 'yahooPreRank', 'to', 'pf', 'sd', 'scoredSd', 'injury']);

  function matchesQ(r, nq, raw) {
    if (!nq) return true;
    if (r._norm.includes(nq)) return true;
    const up = raw.toUpperCase();
    return r.team === up || r.posList.includes(up);
  }
  function injuryMatch(r, inj) {
    if (!inj) return true;
    const t = r.injuryTag;
    if (inj === 'healthy') return !t;
    if (inj === 'injured') return !!t;
    if (inj === 'out') return t === 'O' || t === 'OFS' || t === 'IL' || t === 'SUSP';
    if (inj === 'dtd') return t === 'DTD' || t === 'D';
    return true;
  }

  // query: validated by the route ({ q, pos[], slot[], team[], inj, source, sort, dir, limit, offset }).
  async function table(query) {
    const ix = await getIndex();
    const key = JSON.stringify(query);
    const hit = ix.queryCache.get(key);
    if (hit) return hit;
    const nq = query.q ? normalizeName(query.q) : '';
    const pos = query.pos || [], slot = query.slot || [], team = query.team || [];
    let rows = ix.rows.filter(r =>
      matchesQ(r, nq, query.q || '') &&
      (!pos.length || pos.some(x => r.posList.includes(x))) &&
      (!slot.length || slot.some(x => r.yahooElig.includes(x))) &&
      (!team.length || team.includes(r.team)) &&
      injuryMatch(r, query.inj) &&
      (!query.source || r.source === query.source));
    const sort = query.sort || 'hsValue';
    const get = SORT_KEYS[sort];
    const asc = query.dir ? query.dir === 'asc' : ASC_DEFAULT.has(sort);
    rows = rows.slice().sort((a, b) => {
      const x = get(a), y = get(b);
      const xn = x == null, yn = y == null;
      if (xn || yn) return xn && yn ? (a.rank ?? 1e9) - (b.rank ?? 1e9) : xn ? 1 : -1; // nulls last in both directions
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return (asc ? c : -c) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.id.localeCompare(b.id);
    });
    const total = rows.length;
    const limit = query.limit ?? 50, offset = query.offset ?? 0;
    const out = {
      asOf: ix.board.asOf || null, currentWeek: ix.board.currentWeek || null, leagueId: profile.leagueId,
      total, limit, offset, sort, dir: asc ? 'asc' : 'desc',
      rows: rows.slice(offset, offset + limit),
    };
    ix.queryCache.set(key, out);
    return out;
  }

  // --- search (autocomplete) ---
  async function search(q, limit = 10) {
    const ix = await getIndex();
    const nq = normalizeName(q);
    if (!nq) return { q, results: [] };
    const up = String(q).trim().toUpperCase();
    const scored = [];
    for (const r of ix.rows) {
      let s = -1;
      if (r._norm === nq) s = 0;
      else if (r._norm.startsWith(nq)) s = 1;
      else if (r._norm.split(' ').some(w => w.startsWith(nq))) s = 2;
      else if (r._norm.includes(nq)) s = 3;
      else if (r.team === up) s = 4;
      else if (r.posList.includes(up)) s = 5;
      if (s >= 0) scored.push([s, r]);
    }
    scored.sort((a, b) => a[0] - b[0] || (a[1].rank ?? 1e9) - (b[1].rank ?? 1e9));
    return {
      q,
      results: scored.slice(0, limit).map(([, r]) => ({
        id: r.id, sleeperId: r.sleeperId, yahooPid: r.yahooPid, name: r.name, team: r.team, pos: r.pos,
        injuryTag: r.injuryTag, rank: r.rank, hsValue: r.hsValue, headshot: r.headshot, source: r.source,
      })),
    };
  }

  // --- per-player fetched context (game context, news) ---
  const gameCtxCache = lru(500), newsCache = lru(500);
  async function cachedFetch(cache, key, ttl, fn, timeoutMs) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < (hit.ok ? ttl : TTL.failure)) return hit;
    if (offline) return { ok: false, error: 'offline (NBA_MODEL_OFFLINE=1)', at: Date.now() };
    let entry;
    try { entry = { ok: true, value: await fn(timeoutMs), at: Date.now() }; } catch (err) { entry = { ok: false, error: err.message, at: Date.now() }; }
    cache.set(key, entry);
    return entry;
  }
  // date → { team, opp, home } for one player's season (Sleeper per-player stats rows).
  function gameContext(sid, season) {
    return cachedFetch(gameCtxCache, `${sid}|${season}`, TTL.gameCtx, async timeoutMs => {
      const raw = await fetchJson(URLS.playerGames(sid, season), { timeoutMs });
      const out = {};
      for (const rows of Object.values(raw || {})) {
        for (const r of Array.isArray(rows) ? rows : []) {
          if (!r || !r.date || !r.team) continue;
          out[r.date] = { team: r.team, opp: r.opponent || null, home: typeof r.is_away_team === 'boolean' ? !r.is_away_team : null };
        }
      }
      return out;
    }, 3000);
  }
  function news(sid) {
    return cachedFetch(newsCache, sid, TTL.news, async timeoutMs => {
      const raw = await fetchJson(URLS.news(sid), { timeoutMs });
      return (Array.isArray(raw) ? raw : []).slice(0, 10).map(n => {
        const md = n.metadata || {};
        return {
          title: stripText(md.title, 300), description: stripText(md.description), analysis: stripText(md.analysis),
          published: fin(n.published) ? new Date(n.published).toISOString() : null, source: n.source || null,
        };
      }).filter(n => n.title || n.description);
    }, 2500);
  }

  // --- trending ---
  let trendCache = null;
  async function trending({ hours = 24, limit = 25 } = {}) {
    const ix = await getIndex();
    const key = `${hours}|${limit}`;
    const t = Date.now();
    if (!(trendCache && trendCache.key === key && trendCache.ix === ix && t - trendCache.at < (trendCache.value.derived ? TTL.failure : TTL.trending))) {
      let value;
      try {
        if (offline) throw new Error('offline (NBA_MODEL_OFFLINE=1)');
        const [adds, drops] = await Promise.all(['add', 'drop'].map(k => fetchJson(URLS.trending(k, hours, limit), { timeoutMs: 4000 })));
        if (!Array.isArray(adds) || !Array.isArray(drops)) throw new Error('trending: unexpected response');
        const join = list => list.map(x => {
          const r = ix.byId.get(String(x.player_id));
          return { id: String(x.player_id), count: fin(x.count) ? x.count : null, player: r ? brief(r) : null };
        });
        value = { source: 'sleeper-trending', derived: false, lookbackHours: hours, adds: join(adds), drops: join(drops) };
      } catch (err) {
        // Derived fallback: biggest last-5 form swings among the top 200 by hsValue.
        const pool = ix.rows.filter(r => r.last5Delta != null && r.rank != null && r.rank <= 200);
        const up = [...pool].sort((a, b) => b.last5Delta - a.last5Delta).slice(0, limit);
        const down = [...pool].sort((a, b) => a.last5Delta - b.last5Delta).slice(0, limit);
        value = {
          source: 'derived-form', derived: true, lookbackHours: null, error: err.message,
          note: 'Sleeper trending unavailable: lists are last-5-game form vs season (league-scored), not add/drop counts',
          adds: up.map(r => ({ id: r.id, count: null, signal: r.last5Delta, player: brief(r) })),
          drops: down.map(r => ({ id: r.id, count: null, signal: r.last5Delta, player: brief(r) })),
        };
      }
      trendCache = { key, ix, at: t, value: { ...value, fetchedAt: new Date(t).toISOString() } };
    }
    return trendCache.value;
  }
  function brief(r) {
    return {
      id: r.id, sleeperId: r.sleeperId, yahooPid: r.yahooPid, name: r.name, team: r.team, pos: r.pos, injuryTag: r.injuryTag,
      rank: r.rank, hsValue: r.hsValue, yahooPctRos: r.yahooPctRos, last5Delta: r.last5Delta, headshot: r.headshot, source: r.source,
    };
  }

  // --- similar players ---
  const SIM_FEATURES = [['hsValue', 1.5], ['mean', 1], ['cv', 0.7], ['ceiling', 0.7], ['ddPct', 0.6], ['mpg', 0.5]];
  function simVector(r, ix) {
    const st = ix.stats.get(r.id);
    return { hsValue: r.hsValue, mean: r.mean, cv: st ? st.cv : (r.mean > 0 && r.sd != null ? r.sd / r.mean : null), ceiling: r.ceiling, ddPct: r.ddPct, mpg: r.mpg };
  }
  function similar(ix, target, k = 6) {
    if (target.source === 'yahoo-only' || !fin(target.hsValue)) return [];
    const pool = ix.rows.filter(r => r !== target && r.source !== 'yahoo-only' && fin(r.hsValue) && r.rank != null && r.rank <= 400);
    const vecs = new Map(pool.concat([target]).map(r => [r.id, simVector(r, ix)]));
    const scale = {};
    for (const [f] of SIM_FEATURES) {
      const xs = [...vecs.values()].map(v => v[f]).filter(fin);
      scale[f] = sdOf(xs) || 1;
    }
    const tv = vecs.get(target.id);
    const tPos = new Set(target.posList);
    const out = [];
    for (const r of pool) {
      if (!r.posList.some(p => tPos.has(p))) continue;
      const v = vecs.get(r.id);
      let d = 0, wsum = 0;
      for (const [f, w] of SIM_FEATURES) {
        if (!fin(tv[f]) || !fin(v[f])) continue;
        d += w * ((tv[f] - v[f]) / scale[f]) ** 2; wsum += w;
      }
      if (!wsum) continue;
      out.push([Math.sqrt(d / wsum), r, v]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out.slice(0, k).map(([d, r, v]) => {
      const shared = r.posList.filter(p => tPos.has(p));
      const parts = [`shares ${shared.join('/')}`, `HS value ${r.hsValue} vs ${target.hsValue}`];
      if (fin(v.mean) && fin(tv.mean)) parts.push(`${v.mean} vs ${tv.mean} pts/game`);
      if (fin(v.ddPct) && fin(tv.ddPct) && Math.abs(v.ddPct - tv.ddPct) < 0.1) parts.push(`similar DD rate (${Math.round(v.ddPct * 100)}% vs ${Math.round(tv.ddPct * 100)}%)`);
      if (fin(v.cv) && fin(tv.cv)) parts.push(Math.abs(v.cv - tv.cv) < 0.05 ? 'same consistency' : v.cv < tv.cv ? 'steadier' : 'more volatile');
      return { ...brief(r), similarity: r3(1 / (1 + d)), reason: parts.join(' · ') };
    });
  }

  // --- detail ---
  function resolve(ix, rawId) {
    const id = String(rawId);
    if (/^y\d+$/i.test(id)) {
      const r = ix.byYahoo.get(id.slice(1)) || ix.byId.get('y' + id.slice(1));
      return r ? { row: r, resolvedBy: 'yahooPid' } : null;
    }
    if (ix.byId.has(id)) return { row: ix.byId.get(id), resolvedBy: 'sleeperId' };
    const y = ix.byYahoo.get(id) || ix.byId.get('y' + id);
    return y ? { row: y, resolvedBy: 'yahooPid' } : null;
  }

  async function player(rawId) {
    const ix0 = await getIndex();
    if (!resolve(ix0, rawId)) return null;
    await settle(2500); // bio / schedule on a cold start (bounded)
    const ix = await getIndex();
    const hit = resolve(ix, rawId);
    if (!hit) return null;
    const { row, resolvedBy } = hit;
    const cached = ix.detailCache.get(row.id);
    if (cached && Date.now() - cached.at < TTL.news) return { ...cached.value, resolvedBy };
    const value = await buildDetail(ix, row);
    ix.detailCache.set(row.id, { at: Date.now(), value });
    return { ...value, resolvedBy };
  }

  async function buildDetail(ix, row) {
    const p = row._p;
    const unavailable = {};
    const sid = row.sleeperId;
    const sp = sid ? ix.data.players[sid] || null : null;
    const bio = sid && ctx.bio.data ? ctx.bio.data.players[sid] || null : null;
    const st = ix.stats.get(row.id) || null;
    const nowD = now();
    const cw = ix.board.currentWeek || 1;

    // Fetched context in parallel.
    const [gc, nw] = await Promise.all([
      sid && st ? gameContext(sid, st.season) : Promise.resolve(null),
      sid ? news(sid) : Promise.resolve(null),
    ]);
    const ctxByDate = gc && gc.ok ? gc.value : null;

    // Bio + identity.
    if (!bio) unavailable.bio = sid ? (offline ? 'offline: Sleeper players map not fetched' : (ctx.bio.error ? `Sleeper players map: ${ctx.bio.error}` : 'Sleeper players map not loaded yet')) : 'no Sleeper id (Yahoo-only player)';
    const out = {
      id: row.id,
      asOf: ix.board.asOf || null,
      leagueId: profile.leagueId,
      currentWeek: cw,
      source: row.source,
      identity: {
        name: row.name, firstName: bio ? bio.fn : null, lastName: bio ? bio.ln : null,
        sleeperId: sid, yahooPid: row.yahooPid, sportradarId: bio ? bio.sr : null,
        rotowireId: bio && bio.rw != null ? String(bio.rw) : null, swishId: bio && bio.sw != null ? String(bio.sw) : null,
        espnId: row.imageHints.espnId, nbaId: null,
      },
      images: {
        headshot: sid ? IMG.sleeper(sid) : null, headshotThumb: sid ? IMG.sleeperThumb(sid) : null,
        teamLogo: row.teamLogo, espn: row.imageHints.espnId ? `https://a.espncdn.com/i/headshots/nba/players/full/${row.imageHints.espnId}.png` : null,
        nba: null, yahoo: null,
        note: 'Sleeper CDN headshots exist for Sleeper ids (403 when missing, use teamLogo as fallback). Sleeper does not carry ESPN/NBA.com ids for NBA players; Yahoo image URLs need the Yahoo API.',
      },
      bio: {
        age: bio && fin(bio.a) ? bio.a : null, birthDate: bio ? bio.bd : null,
        height: bio ? heightText(bio.h) : null, heightIn: bio && Number(bio.h) > 0 ? Number(bio.h) : null,
        weightLb: bio && Number(bio.w) > 0 ? Number(bio.w) : null, college: bio ? bio.c : null,
        experience: bio && fin(bio.x) ? bio.x : (sp && fin(sp.x) ? sp.x : null),
        jersey: bio && bio.j != null && bio.j !== '' ? String(bio.j) : null,
        depthChart: bio && bio.dc ? { position: bio.dc, order: bio.dco ?? null } : null,
        rookie: !!(sp && sp.x === 0),
      },
      team: row.team, teamAbbr: row.teamAbbr,
      positions: { pos: row.pos, list: row.posList, source: row.posSource, yahooElig: row.yahooElig, legacyElig: p.elig || null },
      injury: {
        status: row.injury, tag: row.injuryTag, outForSeason: row.outForSeason,
        bodyPart: sp ? sp.ib || null : null, notes: sp ? stripText(sp.in, 500) : null,
        startDate: bio ? bio.isd : null, newsUpdated: bio && fin(bio.nu) ? new Date(bio.nu).toISOString() : null,
      },
      value: {
        rank: row.rank, modelRank: row.modelRank, tier: row.tier, posRank: row.posRank, posRanks: p.posRanks || null,
        hsValue: row.hsValue, mean: row.mean, sd: row.sd, ceiling: row.ceiling, floor: row.floor,
        vorp: row.vorp, vorpRank: row.vorpRank, vorpBySlot: p.vorpBySlot || null, availability: row.availability,
        hsByWeek: p.hsByWeek || null, gamesByWeek: p.gamesByWeek || null, newTeam: !!p.newTeam,
        valueNote: p.valueNote || null,
      },
      market: {
        marketRank: row.marketRank, adpDelta: row.adpDelta, label: row.marketLabel, strong: !!p.strong, contested: !!p.contested,
        marketConfidence: fin(p.marketConfidence) ? p.marketConfidence : null, marketThin: !!p.marketThin,
        yahooPreRank: row.yahooPreRank, yahooPctRos: row.yahooPctRos, yahooFanPts: fin(p.yahooFanPts) ? p.yahooFanPts : null,
      },
    };

    // Projection (current season, league scoring).
    const sProj = sid && ix.data.proj && ix.data.proj.seasonProj ? ix.data.proj.seasonProj[sid] : null;
    if (sProj && sProj.length >= 9) {
      const line = { pts: sProj[3], reb: sProj[4], ast: sProj[5], stl: sProj[6], blk: sProj[7], to: sProj[8] };
      out.projection = {
        season: Number(ix.data.proj.season), source: 'sleeper season projection (per game)',
        min: sProj[1], ...line, sleeperAdp: fin(sProj[2]) ? sProj[2] : null,
        linearScore: r1(Sc.gameScore(line, profile)),
        modelMean: row.mean, hsValue: row.hsValue,
        note: 'linearScore = projected line under league weights without PF/TECH/DD/TD; modelMean is the model\'s full league-scored per-game mean (incl. expected PF/TECH and DD/TD bonuses)',
      };
    } else if (row.source === 'yahoo-only') {
      out.projection = { season: PROJ_SEASON, source: 'yahoo projected fanPts (estimate)', modelMean: row.mean, hsValue: row.hsValue, yahooFanPts: out.market.yahooFanPts, note: p.valueNote || null };
      unavailable.projectionLine = 'Yahoo-only player: no Sleeper projection line';
    } else {
      out.projection = null;
      unavailable.projection = 'no Sleeper season projection for this player';
    }

    // Logs: last season averages, game log, distributions.
    if (st) {
      const games = st.games.map((g, i) => {
        const date = dayToDate(g[0]);
        const c = ctxByDate ? ctxByDate[date] : null;
        const line = Sc.rowLine(g);
        const d = Sc.doublesOf(line);
        return {
          date, sleeperWeek: g[1], team: c ? c.team : null, opp: c ? c.opp : null, home: c ? c.home : null,
          min: g[3], pts: line.pts, reb: line.reb, ast: line.ast, stl: line.stl, blk: line.blk, to: line.to, pf: line.pf, tech: line.tech,
          dd: d >= 2, td: d >= 3, score: st.scores[i],
        };
      });
      if (!ctxByDate) unavailable.gameContext = gc && gc.error ? `opponent/home-away not available: ${gc.error}` : 'opponent/home-away not available';
      const fileWeeks = (st.file && st.file.weeks) || {};
      const weekly = st.weekly.map(w => ({ ...w, best: r2(w.best), start: (fileWeeks[w.week] || [])[0] || null, end: (fileWeeks[w.week] || [])[1] || null }));
      const bests = weekly.map(w => w.best).sort((a, b) => a - b);
      out.lastSeason = {
        season: Number(st.season), gp: st.gp, mpg: st.mpg, perGame: st.line,
        scored: { mean: st.mean, sd: st.sd, p10: st.p10, p90: st.p90, min: st.min, max: st.max, median: r1(quantile(st.sorted, 0.5)) },
      };
      out.gameLog = { season: Number(st.season), games: games.slice().reverse() };
      out.last10 = games.slice(-10).reverse();
      out.histogram = { binWidth: HIST_BIN, games: st.gp, bins: histogram(st.scores) };
      out.weeklyBest = {
        season: Number(st.season), weekBasis: 'Sleeper Mon-Sun weeks of that season (the league calendar for last season is unknown)',
        weeks: weekly,
        summary: { weeks: weekly.length, mean: r1(mean(bests)), median: r1(quantile(bests, 0.5)), p90: r1(quantile(bests, 0.9)), max: r1(bests[bests.length - 1]) },
      };
      out.consistency = { cv: st.cv, boomRate: st.boomRate, bustRate: st.bustRate, boomDef: `game ≥ ${BOOM}× his mean`, bustDef: `game ≤ ${BUST}× his mean` };
      out.rates = { ddPct: st.ddPct, tdPct: st.tdPct, ddCount: st.ddCount, tdCount: st.tdCount, gp: st.gp };
      out.form = { last5: st.last5, last5Delta: st.last5Delta, last5Min: st.last5Min, minDelta: st.minDelta, roleTrend: row.roleTrend, seasonMean: st.mean, mpg: st.mpg };
      const split = side => {
        const xs = games.filter(g => g.home === side);
        return xs.length ? { gp: xs.length, mean: r1(mean(xs.map(g => g.score))), mpg: r1(mean(xs.map(g => g.min))) } : null;
      };
      out.splits = ctxByDate ? { home: split(true), away: split(false) } : null;
      if (!ctxByDate) unavailable.splits = 'home/away split needs per-game context';
    } else {
      for (const k of ['lastSeason', 'gameLog', 'last10', 'histogram', 'weeklyBest', 'consistency', 'rates', 'form', 'splits']) out[k] = null;
      unavailable.logs = row.source === 'yahoo-only' ? 'Yahoo-only player: not in Sleeper, no game logs' : 'no NBA game logs (rookie or did not play last season)';
    }

    // Next matchup week probabilities + 4-week schedule.
    const gbw = p.gamesByWeek || null;
    const nextWeek = profile.weeks.find(w => w.week === cw) || null;
    if (nextWeek && gbw && fin(gbw[cw]) && row.source !== 'yahoo-only') {
      const n = gbw[cw];
      out.nextWeek = {
        week: cw, start: nextWeek.start, end: nextWeek.end, days: nextWeek.days, games: n, availability: row.availability,
        expectedBest: p.hsByWeek ? p.hsByWeek[cw] ?? null : null,
        pBestAtLeast: weekProbabilities({ scores: st ? st.scores : null, logMean: st ? st.mean : null, modelMean: row.mean, modelSd: row.sd, n, a: row.availability }),
        method: st && st.gp >= 10 ? 'own game-score shape rescaled to model mean, kernel-smoothed; P = 1-(1-a·q)^games' : 'normal(model mean, sd); P = 1-(1-a·q)^games',
      };
    } else {
      out.nextWeek = null;
      unavailable.nextWeek = row.source === 'yahoo-only' ? 'Yahoo-only player: no schedule-based model' : 'no matchup week / game count';
    }
    const byTeam = scheduleByTeam();
    const upcoming = profile.weeks.filter(w => w.week >= cw).slice(0, 4);
    out.schedule = upcoming.map(w => {
      let games = null;
      if (byTeam && row.team) {
        games = (byTeam[row.team] || []).filter(g => g.date >= w.start && g.date <= w.end).map(g => ({ ...g }));
        games.forEach((g, i) => {
          const prev = games[i - 1], next = games[i + 1];
          g.b2b = !!((prev && epochDay(g.date) - epochDay(prev.date) === 1) || (next && epochDay(next.date) - epochDay(g.date) === 1));
        });
      }
      return {
        week: w.week, start: w.start, end: w.end, days: w.days, playoffs: !!w.playoffs,
        modelGames: gbw && fin(gbw[w.week]) ? gbw[w.week] : null,
        hsValue: p.hsByWeek && fin(p.hsByWeek[w.week]) ? p.hsByWeek[w.week] : null,
        games, gameCount: games ? games.length : null, b2bCount: games ? games.filter(g => g.b2b).length / 1 : null,
      };
    });
    if (!byTeam) unavailable.scheduleOpponents = offline ? 'offline: 2026 schedule not fetched (modelGames still present)' : (ctx.schedule.error ? `Sleeper schedule: ${ctx.schedule.error}` : 'Sleeper schedule not loaded yet (modelGames still present)');
    if (!row.team) unavailable.schedule = 'no NBA team';

    out.similar = similar(ix, row);
    if (nw && nw.ok) out.news = { available: true, source: 'sleeper (rotowire)', items: nw.value };
    else {
      out.news = { available: false, source: null, items: [] };
      unavailable.news = sid ? `Sleeper news feed: ${nw ? nw.error : 'unavailable'}; injury notes only` : 'Yahoo-only player: no Sleeper news feed';
    }
    out.unavailable = unavailable;
    out.generatedAt = nowD.toISOString();
    return out;
  }

  // --- meta ---
  async function meta() {
    const ix = await getIndex();
    return {
      leagueId: profile.leagueId, leagueName: profile.name, scoring: profile.scoring, flags: profile.flags,
      asOf: ix.board.asOf || null, builtAt: ix.builtAt, currentWeek: ix.board.currentWeek || null,
      players: ix.rows.length, withLogs: ix.stats.size, yahooOnly: ix.rows.filter(r => r.source === 'yahoo-only').length,
      sortKeys: Object.keys(SORT_KEYS), defaultSort: { sort: 'hsValue', dir: 'desc' }, ascByDefault: [...ASC_DEFAULT],
      filters: {
        q: 'free text: accent-insensitive name substring, or exact team / position',
        pos: POSITIONS, slot: Slots.startingSlots(profile), team: ix.teams, inj: INJ_FILTERS,
        source: [...new Set(ix.rows.map(r => r.source).filter(Boolean))].sort(),
      },
      limits: { limitDefault: 50, limitMax: 200, offsetMax: 5000, qMaxLength: 64 },
      weeks: profile.weeks.map(w => ({ week: w.week, start: w.start, end: w.end, days: w.days, playoffs: !!w.playoffs })),
      market: ix.board.market || null,
      context: {
        bio: { loaded: !!ctx.bio.data, fetchedAt: ctx.bio.data ? ctx.bio.data.fetchedAt : null, error: ctx.bio.error },
        schedule: { loaded: !!ctx.schedule.data, fetchedAt: ctx.schedule.data ? ctx.schedule.data.fetchedAt : null, error: ctx.schedule.error },
        offline,
      },
    };
  }

  return { table, search, player, trending, meta, warm, settle, SORT_KEYS, _index: getIndex, _ctx: ctx };
}

module.exports = {
  createResearch, logStats, histogram, weekProbabilities, injuryTag, heightText,
  POSITIONS, INJ_FILTERS, PROB_THRESHOLDS, URLS, IMG,
};
