// Shared layer (Stream A): injury return dates from ESPN's injuries feed.
// Contract: docs/nba-trade-team-spec.md §2.3 and §3.2 / §4.3.
// Sample payload: docs/nba-spec/fixtures/espn-injuries-sample.json.
//
//   fetchInjuryEta({ fetchImpl, cacheDir, now }) → Promise<EtaDoc>   (background only)
//   loadInjuryEta() → EtaDoc | null                                   (memory → disk cache → null)
//   matchEta(etaDoc, player, { logs, now?, weeks? }) → EtaMatch | null
//   applyEtaToAvailability(a0, injury, eta, weekDef, currentWeekDef, opts?) → number
//   maybeRefresh() → Promise | null   hourly background refresh, never awaited on a request path
//
// EtaDoc = { source, fetchedAt, rows: [{ name, norm, team, status, fantasyStatus, returnDate, bodyPart, detail, comment, date }] }
// EtaMatch = { status: 'OUT'|'GTD'|'OFS', returnDate, returnWeek, bodyPart, detail, comment, asOf, source: 'espn', stale, matchedBy }
//
// The feed is unofficial (no SLA): it is fetched hourly in the background,
// cached to data/nba/cache/injury-eta.json, and every failure (fetch error,
// odd payload, a document older than MAX_DOC_AGE_MS) degrades to "no ETA", so
// the board keeps its own injury ramps (board.js availability()).
// NBA_MODEL_OFFLINE=1 never fetches and never reads the disk cache (tests stay
// deterministic); callers can still pass a document in explicitly.
'use strict';
const fs = require('fs');
const path = require('path');
const { normalizeName, normalizeTeam } = require('./names');

const URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';
const TTL_MS = 60 * 60 * 1000;      // refresh hourly, in the background
const STALE_DAYS = 14;              // ignore a row older than this when the player has played since
const MAX_DOC_AGE_MS = 7 * 24 * 60 * 60 * 1000; // a report older than a week is not used at all
const RETURN_FACTOR = 0.85;         // the return week (pro rata) and the first full week back
const DTD_FACTOR = 0.75;            // board.js DTD rule: 0.75 × max(a0, HEALTHY_FLOOR)
const HEALTHY_FLOOR = 0.55;         // = board.js HEALTHY_FLOOR (test-nba-shared asserts they agree)
const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'nba', 'cache');
const CACHE_FILE = 'injury-eta.json';
const DAY_MS = 86400000;

// ESPN team display names → Sleeper abbreviations (the board's `team`).
const TEAM_BY_NAME = {
  'atlanta hawks': 'ATL', 'boston celtics': 'BOS', 'brooklyn nets': 'BKN', 'charlotte hornets': 'CHA',
  'chicago bulls': 'CHI', 'cleveland cavaliers': 'CLE', 'dallas mavericks': 'DAL', 'denver nuggets': 'DEN',
  'detroit pistons': 'DET', 'golden state warriors': 'GSW', 'houston rockets': 'HOU', 'indiana pacers': 'IND',
  'la clippers': 'LAC', 'los angeles clippers': 'LAC', 'los angeles lakers': 'LAL', 'memphis grizzlies': 'MEM',
  'miami heat': 'MIA', 'milwaukee bucks': 'MIL', 'minnesota timberwolves': 'MIN', 'new orleans pelicans': 'NOP',
  'new york knicks': 'NYK', 'oklahoma city thunder': 'OKC', 'orlando magic': 'ORL', 'philadelphia 76ers': 'PHI',
  'phoenix suns': 'PHX', 'portland trail blazers': 'POR', 'sacramento kings': 'SAC', 'san antonio spurs': 'SAS',
  'toronto raptors': 'TOR', 'utah jazz': 'UTA', 'washington wizards': 'WAS',
};
const SLEEPER_TEAMS = new Set(Object.values(TEAM_BY_NAME));
function teamAbbr(t) {
  if (!t) return null;
  const s = String(t).trim();
  const byName = TEAM_BY_NAME[s.toLowerCase()];
  if (byName) return byName;
  const ab = normalizeTeam(s);
  return ab && SLEEPER_TEAMS.has(ab) ? ab : null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;
const dayNum = s => Math.floor(Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') / DAY_MS);
const isDay = s => typeof s === 'string' && ISO_DAY.test(s) && Number.isFinite(dayNum(s));
const clamp01 = x => Math.max(0, Math.min(1, x));
const toMs = v => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : v ? Date.parse(v) : NaN);

// ESPN row → contract status. fantasyStatus wins (GTD / OUT / OFS).
function statusOf(row) {
  const fs0 = String(row.fantasyStatus || '').toUpperCase();
  if (fs0 === 'OFS' || fs0 === 'OUT' || fs0 === 'GTD') return fs0;
  const s = String(row.status || '').toLowerCase();
  if (/season/.test(s)) return 'OFS';
  if (/out|injured reserve|suspen/.test(s)) return 'OUT';
  if (/day|question|doubt|probable/.test(s)) return 'GTD';
  return null;
}

// Raw ESPN payload → EtaDoc. Rows without a name are dropped; a missing or
// malformed returnDate is kept as null (that row then has nothing to apply).
function parseEspn(payload, { now = new Date() } = {}) {
  const rows = [];
  for (const team of (payload && Array.isArray(payload.injuries)) ? payload.injuries : []) {
    const teamName = (team && (team.displayName || team.name)) || null;
    for (const inj of (team && Array.isArray(team.injuries)) ? team.injuries : []) {
      const a = (inj && inj.athlete) || {};
      const name = a.displayName || a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' ');
      if (!name) continue;
      const d = (inj && inj.details) || {};
      const fsAbbr = d.fantasyStatus ? d.fantasyStatus.abbreviation || null : null;
      const athleteTeam = a.team ? a.team.abbreviation || a.team.displayName : null;
      rows.push({
        name, norm: normalizeName(name),
        team: teamAbbr(teamName) || teamAbbr(athleteTeam),
        status: inj.status || null,
        fantasyStatus: fsAbbr ? String(fsAbbr).toUpperCase() : null,
        returnDate: isDay(d.returnDate) ? String(d.returnDate).slice(0, 10) : null,
        bodyPart: d.type || null,
        detail: d.detail || null,
        side: d.side || null,
        comment: inj.shortComment || null,
        date: inj.date || null,
      });
    }
  }
  return { source: URL, fetchedAt: new Date(toMs(now)).toISOString(), espnTimestamp: (payload && payload.timestamp) || null, rows };
}

/* ------------------------------------------------------------ cache + refresh */
let memDoc = null;
let docVersion = 0;
let lastAttempt = 0;
let lastError = null;
let refreshing = null;

function readDisk(cacheDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(cacheDir, CACHE_FILE), 'utf8'));
    return doc && Array.isArray(doc.rows) ? doc : null;
  } catch { return null; }
}
function writeDisk(cacheDir, doc) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = path.join(cacheDir, CACHE_FILE + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, path.join(cacheDir, CACHE_FILE));
}
const tooOld = (doc, now) => !(toMs(now) - toMs(doc.fetchedAt) <= MAX_DOC_AGE_MS);

function setDoc(doc) {
  if (doc !== memDoc) { memDoc = doc; docVersion++; }
  return doc;
}

// Background fetch. Resolves to the fresh document; on any failure the previous
// document stays in place, lastError is recorded and the promise rejects.
async function fetchInjuryEta({ fetchImpl = globalThis.fetch, cacheDir = CACHE_DIR, now = new Date(), timeoutMs = 10000 } = {}) {
  lastAttempt = toMs(now) || Date.now();
  try {
    if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation');
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try { res = await fetchImpl(URL, { headers: { accept: 'application/json' }, ...(ctl ? { signal: ctl.signal } : {}) }); } finally { if (timer) clearTimeout(timer); }
    if (!res || !res.ok) throw new Error(`ESPN injuries HTTP ${res ? res.status : 'no response'}`);
    const payload = await res.json();
    if (!payload || !Array.isArray(payload.injuries)) throw new Error('ESPN injuries: unexpected payload (no injuries array)');
    const doc = parseEspn(payload, { now });
    try { writeDisk(cacheDir, doc); } catch (err) { lastError = `cache write: ${err.message}`; }
    setDoc(doc);
    if (!/^cache write/.test(lastError || '')) lastError = null;
    return doc;
  } catch (err) {
    lastError = err && err.message ? err.message : String(err);
    throw err;
  }
}

// memory → disk cache → null. A document older than MAX_DOC_AGE_MS is ignored.
function loadInjuryEta({ cacheDir = CACHE_DIR, now = Date.now(), allowDisk = process.env.NBA_MODEL_OFFLINE !== '1' } = {}) {
  if (memDoc) return tooOld(memDoc, now) ? null : memDoc;
  if (!allowDisk) return null;
  const doc = readDisk(cacheDir);
  if (!doc) return null;
  setDoc(doc);
  return tooOld(doc, now) ? null : doc;
}

// Hourly background refresh (data.js pattern). Never awaited on a request path.
function maybeRefresh({ fetchImpl, cacheDir, now = Date.now() } = {}) {
  if (process.env.NBA_MODEL_OFFLINE === '1') return null;
  if (refreshing) return refreshing;
  if (now - lastAttempt < TTL_MS) return null;
  refreshing = fetchInjuryEta({ fetchImpl, cacheDir, now: new Date(now) })
    .catch(() => null)
    .finally(() => { refreshing = null; });
  return refreshing;
}

/* ------------------------------------------------------------ matching */
const indexCache = new WeakMap();
function indexDoc(doc) {
  let idx = indexCache.get(doc);
  if (idx) return idx;
  idx = new Map();
  for (const r of doc.rows || []) {
    const n = r.norm || normalizeName(r.name);
    if (!n) continue;
    if (!idx.has(n)) idx.set(n, []);
    idx.get(n).push(r);
  }
  indexCache.set(doc, idx);
  return idx;
}

// Last logged game (epoch day) for a player. logs: data.logs (season files),
// a Map / object pid → last day, or a number.
function lastGameDay(logs, pid) {
  if (logs == null) return null;
  if (typeof logs === 'number') return Number.isFinite(logs) ? logs : null;
  if (pid == null) return null;
  if (logs instanceof Map) { const v = logs.get(String(pid)); return Number.isFinite(v) ? v : null; }
  if (Array.isArray(logs)) {
    let last = null;
    for (const f of logs) {
      const p = f && f.players && f.players[pid];
      for (const g of (p && p.g) || []) if (last == null || g[0] > last) last = g[0];
    }
    return last;
  }
  if (typeof logs === 'object') { const v = logs[pid]; return Number.isFinite(v) ? v : null; }
  return null;
}

// Matchup week containing a date ([{ week, start, end }]); before week 1 → week 1,
// after the last week → null (the player is back after the fantasy season).
function weekOfDate(weeks, date) {
  if (!Array.isArray(weeks) || !weeks.length || !isDay(date)) return null;
  const d = dayNum(date);
  for (const w of weeks) if (d >= dayNum(w.start) && d <= dayNum(w.end)) return Number(w.week);
  return d < dayNum(weeks[0].start) ? Number(weeks[0].week) : null;
}

// player: board Player ({ id, name, team }) or a Sleeper slim row ({ n, t }).
// Match = normalised name + team when both are known; more than one candidate
// left → null (ambiguous). opts: { logs, now, weeks (profile weeks → returnWeek) }.
function matchEta(etaDoc, player, opts = {}) {
  if (!etaDoc || !Array.isArray(etaDoc.rows) || !player) return null;
  const norm = player._norm || normalizeName(player.name || player.n || '');
  if (!norm) return null;
  const cands = indexDoc(etaDoc).get(norm) || [];
  if (!cands.length) return null;
  const team = normalizeTeam(player.team || player.t || null);
  let pick = null, matchedBy = null;
  if (team) {
    const same = cands.filter(r => teamAbbr(r.team) === team);
    if (same.length > 1) return null;
    if (same.length === 1) { pick = same[0]; matchedBy = 'name+team'; }
    // No row on his team: only a lone row with no team can still be him.
    else if (cands.length === 1 && !teamAbbr(cands[0].team)) { pick = cands[0]; matchedBy = 'name'; }
  } else if (cands.length === 1) { pick = cands[0]; matchedBy = 'name'; }
  if (!pick) return null;
  const status = statusOf(pick);
  if (!status) return null;
  const now = toMs(opts.now != null ? opts.now : etaDoc.fetchedAt) || Date.now();
  const rowDay = isDay(pick.date) ? dayNum(pick.date) : null;
  const last = lastGameDay(opts.logs, player.id != null ? String(player.id) : null);
  // §4.3 guard: an old report about a player who has played since then is stale.
  const stale = rowDay != null && Math.floor(now / DAY_MS) - rowDay > STALE_DAYS && last != null && last > rowDay;
  const returnDate = isDay(pick.returnDate) ? String(pick.returnDate).slice(0, 10) : null;
  return {
    status, returnDate, returnWeek: returnDate ? weekOfDate(opts.weeks, returnDate) : null,
    bodyPart: pick.bodyPart || pick.type || null, detail: pick.detail || null,
    comment: pick.comment || pick.shortComment || null,
    asOf: pick.date || etaDoc.fetchedAt || null, source: 'espn', stale, matchedBy,
  };
}

/* ------------------------------------------------------------ the §4.3 rule */
// The board's own rule for the current week (d = 0), used for the "ESPN and
// Sleeper disagree" case when the caller doesn't pass it in (opts.legacy).
function legacyNow(a0, injury) {
  const st = String(injury || '').toUpperCase();
  if (st === 'OUT') return Math.min(a0, 0.1);
  if (st === 'IR' || st === 'SUS') return 0.02;
  if (st === 'DOUBTFUL') return 0.3;
  if (st === 'DTD' || st === 'GTD' || st === 'QUESTIONABLE') return DTD_FACTOR * Math.max(a0, HEALTHY_FLOOR);
  return Math.max(a0, HEALTHY_FLOOR);
}

// Share of the week's games on/after day R: the team's game days when known
// (weekDef.gameDays, epoch days), else calendar days.
function shareFrom(R, s, e, gameDays) {
  if (Array.isArray(gameDays)) {
    const inWeek = gameDays.filter(d => d >= s && d <= e);
    if (!inWeek.length) return 0;
    return inWeek.filter(d => d >= R).length / inWeek.length;
  }
  return (e - R + 1) / (e - s + 1);
}

// First full week back = the first week that starts after R (a return on a
// week's first day makes that week the full week back). Exact with the full
// calendar (opts.weeks); without it, a week starting within 7 days after R.
function isFirstFullWeek(R, s, weeks) {
  if (Array.isArray(weeks) && weeks.length) {
    const holder = weeks.find(w => dayNum(w.start) <= R && R <= dayNum(w.end));
    if (holder && dayNum(holder.start) === R) return false;
    const first = weeks.map(w => dayNum(w.start)).filter(x => x > R).sort((a, b) => a - b)[0];
    return first === s;
  }
  return s > R && s - R <= 7;
}

// a0: the player's healthy availability (the board passes max(a0, HEALTHY_FLOOR)).
// injury: Sleeper injury_status. eta: matchEta() output. weekDef / currentWeekDef:
// { week, start, end, gameDays? } (dates YYYY-MM-DD). opts: { legacy (the board's
// own value for this week), weeks (full calendar) }. Per-game play probability.
function applyEtaToAvailability(a0, injury, eta, weekDef, currentWeekDef, opts = {}) {
  const base = clamp01(Number.isFinite(a0) ? a0 : 0);
  const legacy = Number.isFinite(opts.legacy) ? opts.legacy : null;
  const fallback = legacy != null ? legacy : base;
  if (!eta || eta.stale || !weekDef || !isDay(weekDef.start) || !isDay(weekDef.end)) return fallback;
  if (eta.status === 'OFS') return 0;
  const R = isDay(eta.returnDate) ? dayNum(eta.returnDate) : null;
  if (R == null) return fallback;
  const s = dayNum(weekDef.start), e = dayNum(weekDef.end);
  const cur = currentWeekDef && isDay(currentWeekDef.start) && isDay(currentWeekDef.end) ? { s: dayNum(currentWeekDef.start), e: dayNum(currentWeekDef.end) } : null;
  if (cur && e < cur.s) return base; // a past week is history, not a forecast
  const isCurrent = !!cur && s === cur.s;
  // ESPN vs Sleeper disagreement: the more pessimistic of the two this week.
  const thisWeek = a => (isCurrent ? Math.min(a, legacy != null ? legacy : legacyNow(base, injury)) : a);

  // GTD: a return date before this week = back (only Sleeper's own status can
  // still dock this week); within this week = the DTD rule now, healthy after.
  if (eta.status === 'GTD' && cur && R < cur.s) return clamp01(thisWeek(base));
  if (eta.status === 'GTD' && (!cur || R <= cur.e)) {
    return clamp01(isCurrent ? thisWeek(DTD_FACTOR * Math.max(base, HEALTHY_FLOOR)) : base);
  }
  // OUT (or GTD with a later date): 0 before R, pro rata ×0.85 in R's week,
  // ×0.85 the first full week back, then healthy.
  let a;
  if (e < R) a = 0;
  else if (s <= R) a = base * RETURN_FACTOR * shareFrom(R, s, e, weekDef.gameDays);
  else a = isFirstFullWeek(R, s, opts.weeks) ? base * RETURN_FACTOR : base;
  return clamp01(thisWeek(a));
}

module.exports = {
  fetchInjuryEta, loadInjuryEta, matchEta, applyEtaToAvailability, maybeRefresh, parseEspn,
  teamAbbr, lastGameDay, weekOfDate, statusOf,
  version: () => docVersion,
  status: () => ({ asOf: memDoc ? memDoc.fetchedAt : null, rows: memDoc ? memDoc.rows.length : 0, lastAttempt: lastAttempt || null, lastError, refreshing: !!refreshing }),
  _set: doc => setDoc(doc || null),
  _reset: () => { memDoc = null; lastAttempt = 0; lastError = null; refreshing = null; docVersion++; },
  URL, TTL_MS, STALE_DAYS, MAX_DOC_AGE_MS, RETURN_FACTOR, DTD_FACTOR, HEALTHY_FLOOR, CACHE_DIR, CACHE_FILE,
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
};
