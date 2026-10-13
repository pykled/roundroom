// Name normalization + Yahoo → Sleeper player matching.
'use strict';

// Letters NFD can't decompose.
const SPECIAL = { 'ı': 'i', 'ø': 'o', 'đ': 'd', 'ł': 'l', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'þ': 'th' };
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// First-name variants collapsed to one canonical form (applied to both sides,
// so direction doesn't matter). Only names with no ambiguity on NBA rosters.
const FIRST_ALIASES = {
  nicolas: 'nic', herbert: 'herb', moritz: 'moe', cameron: 'cam', sviatoslav: 'svi',
  alexandre: 'alex', ronald: 'ron', mohamed: 'mo', mohammed: 'mo', patrick: 'pat',
};
// Whole-name variants (after suffix stripping + first-name aliasing).
const FULL_ALIASES = {
  'nahshon hyland': 'bones hyland',
  'carlton carrington': 'bub carrington',
  'kenyon martin': 'kj martin',
  'gregory jackson': 'gg jackson',
  'jakob poltl': 'jakob poeltl',
  'pat williams': 'patrick williams', // undo the pat alias: Patrick Williams is never "Pat"
};

function normalizeName(s) {
  let t = String(s == null ? '' : s).toLowerCase();
  t = t.replace(/[ıøđłßæœþ]/g, c => SPECIAL[c]);
  t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/[.'’‘`]/g, '');          // P.J. → pj, De'Aaron → deaaron
  t = t.replace(/[^a-z0-9]+/g, ' ').trim(); // hyphens/commas → space
  let parts = t.split(' ').filter(Boolean);
  while (parts.length > 2 && SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  if (parts.length && FIRST_ALIASES[parts[0]]) parts[0] = FIRST_ALIASES[parts[0]];
  const joined = parts.join(' ');
  return FULL_ALIASES[joined] || joined;
}

// Yahoo editorial_team_abbr (mixed case, e.g. "GS", "Pho", "NO") → Sleeper abbr.
const TEAM_MAP = {
  GS: 'GSW', NO: 'NOP', NOR: 'NOP', SA: 'SAS', NY: 'NYK', PHO: 'PHX', UTAH: 'UTA', UTH: 'UTA',
  WSH: 'WAS', BRK: 'BKN', BK: 'BKN', CHO: 'CHA', CHH: 'CHA', OKL: 'OKC', NOH: 'NOP',
};
function normalizeTeam(abbr) {
  if (!abbr) return null;
  const u = String(abbr).toUpperCase().trim();
  if (!u || u === 'FA' || u === 'NA') return null;
  return TEAM_MAP[u] || u;
}

function yahooPositions(yp) {
  const out = new Set();
  const add = p => { for (const x of String(p || '').split(/[,\s/]+/)) if (/^(PG|SG|SF|PF|C|G|F)$/.test(x)) out.add(x); };
  add(yp.display_position);
  for (const p of yp.eligible_positions || []) add(typeof p === 'object' ? p.position : p);
  return out;
}
function posOverlap(ypos, pos) {
  if (!ypos.size || !pos || !pos.length) return false;
  for (const p of pos) {
    if (ypos.has(p)) return true;
    if ((p === 'PG' || p === 'SG') && ypos.has('G')) return true;
    if ((p === 'SF' || p === 'PF') && ypos.has('F')) return true;
  }
  return false;
}

const indexCache = new WeakMap();
function indexPlayers(players) {
  let idx = indexCache.get(players);
  if (idx) return idx;
  idx = { byName: new Map(), byLast: new Map() };
  for (const p of players) {
    const n = p._norm || normalizeName(p.name);
    if (!idx.byName.has(n)) idx.byName.set(n, []);
    idx.byName.get(n).push(p);
    const last = n.split(' ').slice(1).join(' ');
    if (!idx.byLast.has(last)) idx.byLast.set(last, []);
    idx.byLast.get(last).push(p);
  }
  indexCache.set(players, idx);
  return idx;
}

const MATCH_THRESHOLD = 0.75;
const round2 = x => Math.round(x * 100) / 100;

// yahooPlayer = { player_key, player_id, name: { full } | string, editorial_team_abbr, display_position, eligible_positions }
// → { player, confidence, reason } | null (null when best candidate < MATCH_THRESHOLD)
function matchYahooPlayer(yahooPlayer, players) {
  if (!yahooPlayer || !Array.isArray(players) || !players.length) return null;
  const full = typeof yahooPlayer.name === 'string' ? yahooPlayer.name : yahooPlayer.name && (yahooPlayer.name.full || [yahooPlayer.name.first, yahooPlayer.name.last].filter(Boolean).join(' '));
  const norm = normalizeName(full);
  if (!norm) return null;
  const team = normalizeTeam(yahooPlayer.editorial_team_abbr);
  const ypos = yahooPositions(yahooPlayer);
  const idx = indexPlayers(players);

  const exact = idx.byName.get(norm) || [];
  if (exact.length) {
    const scored = exact.map(p => {
      const teamOk = team && p.team === team;
      const posOk = posOverlap(ypos, p.pos);
      let c, reason;
      if (teamOk) { c = 0.95 + (posOk ? 0.05 : 0); reason = 'name+team' + (posOk ? '+pos' : ''); }
      else if (exact.length === 1 && !team) { c = 0.85 + (posOk ? 0.05 : 0); reason = 'name-unique-no-team'; }
      else if (exact.length === 1) { c = 0.75 + (posOk ? 0.05 : 0); reason = `name-unique-team-mismatch(${team}≠${p.team})`; }
      else { c = 0.4; reason = 'name-ambiguous'; }
      return { player: p, confidence: round2(c), reason };
    }).sort((a, b) => b.confidence - a.confidence);
    if (scored[0].confidence >= MATCH_THRESHOLD && !(scored[1] && scored[1].confidence === scored[0].confidence)) return scored[0];
    return null;
  }

  // Fuzzy: same last name (multi-token surnames included), first names compatible.
  const parts = norm.split(' ');
  const first = parts[0];
  const last = parts.slice(1).join(' ');
  const cands = idx.byLast.get(last) || [];
  let best = null, second = null;
  for (const p of cands) {
    const pf = (p._norm || normalizeName(p.name)).split(' ')[0];
    let c = 0.45, why = ['last'];
    if (pf.startsWith(first) || first.startsWith(pf)) { c += 0.15; why.push('first-prefix'); }
    else if (pf[0] === first[0]) { c += 0.1; why.push('first-initial'); }
    else continue;
    if (team && p.team === team) { c += 0.3; why.push('team'); }
    if (posOverlap(ypos, p.pos)) { c += 0.05; why.push('pos'); }
    const cand = { player: p, confidence: round2(Math.min(c, 0.95)), reason: 'fuzzy:' + why.join('+') };
    if (!best || cand.confidence > best.confidence) { second = best; best = cand; }
    else if (!second || cand.confidence > second.confidence) second = cand;
  }
  if (!best || best.confidence < MATCH_THRESHOLD) return null;
  if (second && second.confidence === best.confidence) return null;
  return best;
}

module.exports = { normalizeName, normalizeTeam, matchYahooPlayer, MATCH_THRESHOLD, TEAM_MAP };
