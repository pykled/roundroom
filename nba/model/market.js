// Pocket NBA — market layer (stream M1). Yahoo-first consensus rank + model-vs-market reach/value label.
// Pure: no IO. Design + weights: docs/nba-market-blend.md.
//   buildMarket({ players, yahooSnapshot, adpSources }) → { asOf, weights, rows, byId, stats, unmatched, validation }
//     players       model players ({id,name,team,pos,rank,...}); p.yahooPid (H1) is honored when present
//     yahooSnapshot data/nba/yahoo-snapshot-242808.json ({players:[{pid,name,team,pos,tag,preRank,curRank,pctRos,fanPts}]})
//     adpSources    flat rows [{name,team,pos,adp,source}] from scripts/nba-adp-fetch.js (espn|sleeper|fantasypros-yahoo)
'use strict';
const { matchYahooPlayer } = require('./names');

// Weights over RANK sources. Yahoo preRank = this league's own ranking (primary); renormalized over sources present.
const WEIGHTS = { yahoo_pre: 0.40, fantasypros_yahoo: 0.25, espn: 0.20, sleeper: 0.15 };
const SOURCE_KEY = { 'fantasypros-yahoo': 'fantasypros_yahoo', espn: 'espn', sleeper: 'sleeper' };
const CONTEST_MIN = 20, CONTEST_FRAC = 0.25;    // contested if source-rank spread > max(20, 0.25·marketRank)
const BAND_MIN = 3, BAND_FRAC = 0.15;           // fair band = max(3, 0.15·modelRank); wider late
const CONTESTED_BAND_MULT = 1.5;
const LABEL_DEPTH = 250;                        // 192 picks in a 12-team/16-spot draft; deeper ranks are noise, not labeled

const fin = x => typeof x === 'number' && Number.isFinite(x);
const round1 = x => Math.round(x * 10) / 10;

// Weighted median over [{v,w}]. Lower weighted median; exactly-half cumulative weight → midpoint with next value.
function weightedMedian(items) {
  const it = items.filter(i => fin(i.v) && fin(i.w) && i.w > 0).sort((a, b) => a.v - b.v);
  if (!it.length) return null;
  const total = it.reduce((s, i) => s + i.w, 0);
  let acc = 0;
  for (let k = 0; k < it.length; k++) {
    acc += it[k].w;
    if (Math.abs(acc - total / 2) < 1e-9 && k + 1 < it.length) return (it[k].v + it[k + 1].v) / 2;
    if (acc > total / 2) return it[k].v;
  }
  return it[it.length - 1].v;
}

// Ordinal ranks (1..n) of a flat ADP list, ascending ADP, ties by name → stable.
function ordinalRanks(rows) {
  return rows.filter(r => r && fin(r.adp) && r.adp > 0)
    .sort((a, b) => a.adp - b.adp || String(a.name).localeCompare(String(b.name)))
    .map((r, i) => ({ row: r, rank: i + 1 }));
}

// Spearman rank correlation (average ranks for ties). Returns null for <3 pairs.
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const rk = a => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {
      let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const a = rk(xs), b = rk(ys), ma = (n + 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - ma); da += (a[i] - ma) ** 2; db += (b[i] - ma) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}

// consensus over {source: rank}. weights default WEIGHTS. → { raw, spread, contested, used, weightCovered } | null
function consensus(ranks, weights = WEIGHTS) {
  const items = [];
  for (const [k, v] of Object.entries(ranks)) if (fin(v) && weights[k] > 0) items.push({ k, v, w: weights[k] });
  if (!items.length) return null;
  const raw = weightedMedian(items);
  const vs = items.map(i => i.v);
  const spread = items.length > 1 ? Math.max(...vs) - Math.min(...vs) : 0;
  const contested = items.length > 1 && spread > Math.max(CONTEST_MIN, CONTEST_FRAC * raw);
  const wAll = Object.values(weights).reduce((s, w) => s + w, 0);
  return { raw, spread, contested, used: items.map(i => i.k), weightCovered: items.reduce((s, i) => s + i.w, 0) / wAll };
}

// label from adpDelta = marketRank − modelRank (+ = model likes more = value).
function labelFor(adpDelta, modelRank, contested, marketRank) {
  if (!fin(adpDelta) || !fin(modelRank)) return { label: null, strong: false, band: null };
  if (Math.min(modelRank, fin(marketRank) ? marketRank : Infinity) > LABEL_DEPTH) return { label: null, strong: false, band: null };
  const band = Math.max(BAND_MIN, BAND_FRAC * modelRank) * (contested ? CONTESTED_BAND_MULT : 1);
  if (adpDelta >= band) return { label: 'value', strong: adpDelta >= 2 * band, band: round1(band) };
  if (adpDelta <= -band) return { label: 'reach', strong: adpDelta <= -2 * band, band: round1(band) };
  return { label: 'fair', strong: false, band: round1(band) };
}

// confidence 0..1: how much weight is covered × how tightly sources agree. thin (1 source) capped at 0.5.
function confidenceFor(c) {
  if (!c) return 0;
  const tight = c.used.length > 1 ? 1 - Math.min(1, c.spread / Math.max(40, 1.5 * c.raw)) : 0.6;
  let v = (0.5 + 0.5 * c.weightCovered) * (0.4 + 0.6 * tight);
  if (c.used.length === 1) v = Math.min(v, 0.5);
  return Math.round(v * 100) / 100;
}

function yahooLike(r) {
  return { name: r.name, editorial_team_abbr: r.team, display_position: Array.isArray(r.pos) ? r.pos.join(',') : r.pos };
}

function makeMatcher(players) {
  const byPid = new Map();
  for (const p of players) if (p.yahooPid != null) byPid.set(String(p.yahooPid), p);
  return (row, pid) => {
    if (pid != null && byPid.has(String(pid))) return { player: byPid.get(String(pid)), confidence: 1, reason: 'yahooPid' };
    return matchYahooPlayer(yahooLike(row), players);
  };
}

function buildMarket({ players, yahooSnapshot, adpSources } = {}) {
  players = Array.isArray(players) ? players : [];
  const ysp = (yahooSnapshot && Array.isArray(yahooSnapshot.players)) ? yahooSnapshot.players : [];
  const match = makeMatcher(players);
  const stats = { sources: {}, modelPlayers: players.length };
  const unmatched = {};
  const per = new Map(); // model id → { ranks:{}, adp:{}, yahoo:{} }
  const slot = p => per.get(p.id) || per.set(p.id, { ranks: {}, adp: {}, yahoo: null }).get(p.id);

  // Yahoo (primary)
  const ys = (stats.sources.yahoo_pre = { total: ysp.length, matched: 0, dupes: 0 });
  unmatched.yahoo_pre = [];
  for (const y of ysp) {
    const m = match(y, y.pid);
    if (!m) { unmatched.yahoo_pre.push(`${y.name} (${y.team || '?'}) pre#${y.preRank}`); continue; }
    const s = slot(m.player);
    if (s.yahoo && fin(s.yahoo.preRank) && !(fin(y.preRank) && y.preRank < s.yahoo.preRank)) { ys.dupes++; continue; }
    if (s.yahoo) ys.dupes++; else ys.matched++;
    s.yahoo = { yahooPid: y.pid, preRank: fin(y.preRank) ? y.preRank : null, curRank: fin(y.curRank) ? y.curRank : null,
      pctRos: fin(y.pctRos) ? y.pctRos : null, tag: y.tag || '', pos: y.pos, matchConfidence: m.confidence };
    if (fin(y.preRank)) s.ranks.yahoo_pre = y.preRank;
  }

  // ADP sources: ordinal-rank each source over its own full list (before matching) so scales are comparable.
  const bySrc = {};
  for (const r of Array.isArray(adpSources) ? adpSources : []) {
    const key = SOURCE_KEY[r && r.source];
    if (key) (bySrc[key] = bySrc[key] || []).push(r);
  }
  for (const [key, rows] of Object.entries(bySrc)) {
    const st = (stats.sources[key] = { total: 0, matched: 0, dupes: 0 });
    unmatched[key] = [];
    const seen = new Set();
    for (const { row, rank } of ordinalRanks(rows)) {
      st.total++;
      const m = match(row, null);
      if (!m) { unmatched[key].push(`${row.name} (${row.team || '?'}) adp ${row.adp}`); continue; }
      if (seen.has(m.player.id)) { st.dupes++; continue; }
      seen.add(m.player.id);
      st.matched++;
      const s = slot(m.player);
      s.ranks[key] = rank;
      s.adp[key] = row.adp;
    }
  }
  for (const st of Object.values(stats.sources)) st.rate = st.total ? Math.round((1000 * st.matched) / st.total) / 10 : 0;

  // Consensus raw → ordinal marketRank over matched model players with any signal (same population as modelRank).
  const entries = [];
  for (const p of players) {
    const s = per.get(p.id);
    const c = s ? consensus(s.ranks) : null;
    if (c) entries.push({ p, s, c });
  }
  entries.sort((a, b) => a.c.raw - b.c.raw || (a.s.ranks.yahoo_pre ?? 1e9) - (b.s.ranks.yahoo_pre ?? 1e9) || String(a.p.name).localeCompare(String(b.p.name)));
  const mRank = new Map(entries.map((e, i) => [e.p.id, i + 1]));

  const byId = {};
  const rows = [];
  for (const p of players) {
    const s = per.get(p.id);
    const c = s ? consensus(s.ranks) : null;
    const modelRank = fin(p.rank) ? p.rank : null;
    const marketRank = c ? mRank.get(p.id) : null;
    const adpDelta = marketRank != null && modelRank != null ? marketRank - modelRank : null;
    const lb = labelFor(adpDelta, modelRank, c && c.contested, marketRank);
    const y = s && s.yahoo;
    const row = {
      id: p.id, name: p.name,
      yahooPid: y ? y.yahooPid : (p.yahooPid ?? null),
      yahooPreRank: y ? y.preRank : null, yahooCurRank: y ? y.curRank : null, yahooPctRos: y ? y.pctRos : null,
      adp: { espn: s && s.adp.espn != null ? s.adp.espn : null, sleeper: s && s.adp.sleeper != null ? s.adp.sleeper : null,
        fantasypros_yahoo: s && s.adp.fantasypros_yahoo != null ? s.adp.fantasypros_yahoo : null,
        yahoo_derived: s && s.ranks.yahoo_pre != null ? s.ranks.yahoo_pre : null }, // Yahoo preRank on the ordinal scale
      sourceRanks: s ? { ...s.ranks } : {},
      marketRaw: c ? round1(c.raw) : null,
      marketRank, modelRank, adpDelta,
      label: lb.label, strong: lb.strong, band: lb.band,
      contested: c ? c.contested : false,
      spread: c ? c.spread : null,
      sources: c ? c.used : [],
      thin: c ? c.used.length === 1 : false,
      confidence: confidenceFor(c),
    };
    rows.push(row);
    byId[p.id] = row;
  }

  const have = rows.filter(r => r.marketRank != null);
  stats.withMarket = have.length;
  stats.contested = have.filter(r => r.contested).length;
  stats.labels = have.reduce((a, r) => { a[r.label] = (a[r.label] || 0) + 1; return a; }, {});

  // Validation: Yahoo preRank vs last-season fanPts rank (reality check), model vs market.
  const withPts = ysp.filter(y => fin(y.preRank) && fin(y.fanPts) && y.fanPts > 0);
  const ptsRank = withPts.map(y => -y.fanPts);
  const validation = {
    yahooPreRank_vs_fanPts: { n: withPts.length, spearman: spearman(withPts.map(y => y.preRank), ptsRank) },
    yahooTop100PreRank_vs_fanPts: null,
    model_vs_market: (() => { const h = have.filter(r => r.modelRank != null); return { n: h.length, spearman: spearman(h.map(r => r.modelRank), h.map(r => r.marketRank)) }; })(),
  };
  const top = withPts.filter(y => y.preRank <= 100);
  validation.yahooTop100PreRank_vs_fanPts = { n: top.length, spearman: spearman(top.map(y => y.preRank), top.map(y => -y.fanPts)) };

  return { asOf: (yahooSnapshot && yahooSnapshot.fetchedAt) || null, weights: { ...WEIGHTS },
    params: { CONTEST_MIN, CONTEST_FRAC, BAND_MIN, BAND_FRAC, CONTESTED_BAND_MULT, LABEL_DEPTH }, rows, byId, stats, unmatched, validation };
}

module.exports = { buildMarket, weightedMedian, consensus, labelFor, confidenceFor, ordinalRanks, spearman, WEIGHTS };
