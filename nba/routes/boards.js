// One NBA board per (week, profile) for every route. The model's own memo
// (nba/model getPlayers: keyed on the profile, the data version and the ESPN
// return dates, rebuilt every 10 min) is the only board cache; routes used to
// keep their own 10-minute copies, so right after a deploy or a data refresh
// the team page and the trade calculator valued the same trade on different
// boards (a trade target read +1.9/wk on the team page and -2.7/wk after
// Open in Trade).
//   boardFor(model, { week, profile }) → the getPlayers response; profiled boards carry the market layer
//   boardVersion(board)                → integer that changes exactly when the board does (for cache keys)
'use strict';
const { enrichPlayers } = require('../model/enrich');

const enriched = new WeakMap(); // model response → enriched response
const versions = new WeakMap(); // board → version
let seq = 0;

function boardVersion(board) {
  if (!board || typeof board !== 'object') return 0;
  let v = versions.get(board);
  if (!v) { v = ++seq; versions.set(board, v); }
  return v;
}

async function boardFor(model, { week, profile } = {}) {
  const d = await model.getPlayers({ week: week || undefined, profile: profile || undefined });
  // Profile responses also carry the market layer + Yahoo-only rows (nba/model/enrich.js).
  if (!profile || model.stub || !d || !d.profile) return d;
  let e = enriched.get(d);
  if (!e) {
    try { e = enrichPlayers(d); } catch { e = d; }
    enriched.set(d, e);
    versions.set(e, boardVersion(d));
  }
  return e;
}

module.exports = { boardFor, boardVersion };
