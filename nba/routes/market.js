// GET /api/nba/market — serves data/nba/market.json (built by scripts/nba-market-build.js). Not mounted here;
// the lead mounts it: `router.use('/market', require('./routes/market'))` (see docs/nba-handoff-m1.md).
'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');

const FILE = path.join(__dirname, '..', '..', 'data', 'nba', 'market.json');
let cache = { mtime: 0, doc: null };

function load() {
  try {
    const st = fs.statSync(FILE);
    if (st.mtimeMs !== cache.mtime) cache = { mtime: st.mtimeMs, doc: JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    return cache.doc;
  } catch (_) { return null; }
}

const router = express.Router();
router.get('/', (req, res) => {
  const doc = load();
  if (!doc) return res.json({ available: false, rows: [] });
  res.json({ available: true, asOf: doc.asOf, builtAt: doc.builtAt, weights: doc.weights, sources: doc.stats && doc.stats.sources, rows: doc.rows });
});
module.exports = router;
module.exports.load = load;
