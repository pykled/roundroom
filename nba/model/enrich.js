// Integration adapter on top of getPlayers({ profile }) (H1) — field-level
// merge only, never rewrites the model's numbers for matched players:
//   1. market layer (M1, data/nba/market.json): marketRank, adpDelta, label,
//      strong, contested, marketConfidence, marketThin — joined by yahooPid,
//      then model id. Never used for sorting.
//   2. Yahoo-only rows: players in Yahoo's pool (league snapshot) that Sleeper
//      doesn't list, so they have no game logs (Westbrook, Valančiūnas, ...).
//      source:'yahoo-only', noLogData:true, Yahoo positions, and a conservative
//      hsValue estimated from Yahoo's projected fanPts/GP (see VALUE_FIT).
// Ranks are renumbered over the merged list by hsValue (the model's own order
// is preserved; `modelRank` keeps H1's rank). Returns a new object; the cached
// model response is never mutated.
'use strict';
const Yahoo = require('./yahoo');
const Slots = require('./slots');

// hsValue ≈ a·(Yahoo fanPts per game) + b, least squares over 265 matched
// players with Yahoo preRank 151–449 (2026-10-14 snapshot), then a 0.9
// haircut: no logs → no measured spread or availability, so stay conservative.
// Yahoo fanPts also omit the DD/TD/tech bonuses (≈ neutral for deep players).
const VALUE_FIT = { a: 0.844, b: 5.36, haircut: 0.9 };
const r1 = x => Math.round(x * 10) / 10;
const fin = x => typeof x === 'number' && Number.isFinite(x);

let marketCache = { at: 0, doc: null };
function loadMarket() {
  if (Date.now() - marketCache.at < 60 * 1000) return marketCache.doc;
  let doc = null;
  try { doc = require('../routes/market').load(); } catch { doc = null; }
  marketCache = { at: Date.now(), doc };
  return doc;
}

function marketFields(row) {
  if (!row || row.marketRank == null) return null;
  return {
    marketRank: row.marketRank, adpDelta: row.adpDelta ?? null, label: row.label || null, strong: !!row.strong,
    contested: !!row.contested, marketConfidence: fin(row.confidence) ? row.confidence : null, marketThin: !!row.thin,
  };
}

function estimateValue(y) {
  const pg = y.gp > 0 && fin(y.fanPts) ? y.fanPts / y.gp : 0;
  const hs = Math.max(0, (VALUE_FIT.a * pg + VALUE_FIT.b) * VALUE_FIT.haircut);
  const mean = Math.max(0, pg * VALUE_FIT.haircut);
  const sd = 0.3 * mean + 4;
  return { hsValue: r1(hs), mean: r1(mean), sd: r1(sd), ceiling: r1(hs + 0.8 * sd), floor: r1(Math.max(0, mean - sd)) };
}

function yahooOnlyRow(y, { profileSlots, replacement }) {
  const pos = Slots.normPositions(y.pos);
  let elig = Slots.slotsForPositions(pos);
  if (profileSlots) elig = elig.filter(s => profileSlots.has(s));
  if (!elig.length) elig = ['UTIL'];
  const v = estimateValue(y);
  const vorpBySlot = {};
  for (const s of elig) if (replacement && fin(replacement[s])) vorpBySlot[s] = r1(v.hsValue - replacement[s]);
  const vs = Object.values(vorpBySlot);
  const injury = y.tag === 'O' ? 'OUT' : y.tag === 'Q' ? 'Q' : null;
  return {
    id: 'y' + y.pid, sleeperId: null, name: y.name, team: y.team || null, pos, elig,
    yahooElig: elig, eligConfidence: 'yahoo', injury, outForSeason: false,
    ...v, games: 3.5, gamesByWeek: null, hsByWeek: null,
    rank: null, tier: null, posRank: null, sampleGames: 0, source: 'yahoo-only', noLogData: true,
    valueNote: 'No game-log data (not in Sleeper): value estimated from Yahoo projected fantasy points per game',
    availability: null, newTeam: false,
    yahooPid: String(y.pid), yahooPreRank: fin(y.preRank) ? y.preRank : null, yahooPctRos: fin(y.pctRos) ? y.pctRos : null,
    yahooFanPts: fin(y.fanPts) ? y.fanPts : null, yahooPos: pos,
    vorpBySlot, vorp: vs.length ? Math.max(...vs) : null, vorpRank: null,
  };
}

// data: getPlayers({ profile }) response. opts.market / opts.snapshot override
// the files (tests). Every Yahoo pool player is added so any of them can be
// drafted manually; ones with no projection sink to the bottom.
function enrichPlayers(data, opts = {}) {
  if (!data || !Array.isArray(data.players)) return data;
  const leagueId = (data.profile && data.profile.leagueId) || Yahoo.DEFAULT_LEAGUE;
  const market = opts.market !== undefined ? opts.market : loadMarket();
  const snap = opts.snapshot !== undefined ? opts.snapshot : Yahoo.loadSnapshot(leagueId);

  const byPid = new Map(), byId = new Map();
  for (const r of (market && Array.isArray(market.rows)) ? market.rows : []) {
    if (r.yahooPid != null) byPid.set(String(r.yahooPid), r);
    if (r.id != null) byId.set(String(r.id), r);
  }
  const players = data.players.map(p => {
    const row = (p.yahooPid != null && byPid.get(String(p.yahooPid))) || byId.get(String(p.id));
    const mf = marketFields(row);
    return { ...p, modelRank: p.rank, ...(mf || {}) };
  });

  const known = new Set(players.filter(p => p.yahooPid != null).map(p => String(p.yahooPid)));
  const profileSlots = data.profile && data.profile.slots ? new Set(Object.keys(data.profile.slots).filter(s => data.profile.slots[s] > 0)) : null;
  const replacement = data.profile && data.profile.replacement;
  const extra = [];
  for (const y of (snap && Array.isArray(snap.players)) ? snap.players : []) {
    if (y.pid == null || y.pid === '' || known.has(String(y.pid))) continue;
    known.add(String(y.pid));
    extra.push(yahooOnlyRow(y, { profileSlots, replacement }));
  }

  const all = players.concat(extra);
  // Stable merge by hsValue: model players keep their relative order.
  all.sort((a, b) => (b.hsValue || 0) - (a.hsValue || 0) || (a.modelRank ?? 1e9) - (b.modelRank ?? 1e9) || String(a.id).localeCompare(String(b.id)));
  all.forEach((p, i) => { p.rank = i + 1; });
  // Yahoo-only rows take the tier of the model player just above them.
  let lastTier = 1;
  for (const p of all) { if (p.source === 'yahoo-only') p.tier = lastTier; else if (p.tier != null) lastTier = p.tier; }

  return {
    ...data, players: all,
    market: market ? { available: true, asOf: market.asOf || null, builtAt: market.builtAt || null, label: 'market (consensus)', matched: players.filter(p => p.marketRank != null).length } : { available: false },
    yahooOnly: { count: extra.length, fit: VALUE_FIT },
  };
}

module.exports = { enrichPlayers, estimateValue, VALUE_FIT };
