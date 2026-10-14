// Pocket NBA player research API (stream R0). Mounted with one line in nba/router.js:
//   router.use(require('./routes/research')({ modelPlayers, log }));
//
//   GET /api/nba/research?q=&pos=&slot=&team=&inj=&source=&sort=&dir=&limit=&offset=
//   GET /api/nba/research/meta
//   GET /api/nba/player/:id          (sleeper id, yahooPid, or y<yahooPid>)
//   GET /api/nba/search?q=&limit=
//   GET /api/nba/trending?hours=&limit=
// Public, per-IP rate limited. Contract: docs/nba-research-api.md. Engine: nba/model/research.js.
'use strict';
const crypto = require('crypto');
const express = require('express');
const R = require('../model/research');
const { DEFAULT_LEAGUE_ID } = require('../league-profile');

const RATE = { windowMs: 60 * 1000, max: 240 };
const Q_MAX = 64;
const ID_RE = /^y?\d{1,12}$/i;
const SOURCE_RE = /^[a-z-]{1,20}$/;

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function limited(key) {
    const t = Date.now();
    let h = hits.get(key);
    if (!h || t - h.start >= windowMs) { h = { start: t, n: 0 }; hits.set(key, h); }
    h.n++;
    if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    return h.n > max ? Math.max(1, Math.ceil((h.start + windowMs - t) / 1000)) : 0;
  };
}

class BadRequest extends Error {}
const bad = msg => { throw new BadRequest(msg); };

// Strip control characters; enforce max length.
function cleanQ(v) {
  if (v == null) return '';
  if (Array.isArray(v)) bad('q must be a single value');
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (s.length > Q_MAX) bad(`q longer than ${Q_MAX} characters`);
  return s;
}
function intParam(v, name, def, lo, hi) {
  if (v == null || v === '') return def;
  if (Array.isArray(v) || !/^\d{1,6}$/.test(String(v))) bad(`Invalid ${name}`);
  const n = Number(v);
  if (n < lo || n > hi) bad(`${name} must be ${lo}-${hi}`);
  return n;
}
// Comma list (or repeated param) restricted to an allowed set.
function listParam(v, name, allowed, upper = true) {
  if (v == null || v === '') return [];
  const raw = (Array.isArray(v) ? v : [v]).join(',');
  if (raw.length > 200) bad(`Invalid ${name}`);
  const out = [...new Set(raw.split(',').map(s => (upper ? s.trim().toUpperCase() : s.trim())).filter(Boolean))];
  for (const x of out) if (!allowed.includes(x)) bad(`Unknown ${name} '${x.slice(0, 20)}' (allowed: ${allowed.join(', ')})`);
  return out;
}

module.exports = function researchRoutes({ modelPlayers, log = console, rate = RATE, research } = {}) {
  if (!research && typeof modelPlayers !== 'function') throw new Error('nba research routes: modelPlayers required');
  const engine = research || R.createResearch({ getBoard: () => modelPlayers(null, DEFAULT_LEAGUE_ID), log });
  const limited = createRateLimiter(rate);
  const router = express.Router();

  router.use(['/api/nba/research', '/api/nba/player', '/api/nba/search', '/api/nba/trending'], (req, res, next) => {
    const wait = limited(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
    if (wait) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ error: 'Too many requests — slow down' }); }
    next();
  });

  // JSON body + weak ETag memoized per result object (results are cached by the engine).
  const encoded = new WeakMap();
  function send(req, res, obj, maxAge = 120) {
    let e = encoded.get(obj);
    if (!e) {
      const body = JSON.stringify(obj);
      e = { body, etag: `W/"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 27)}"` };
      encoded.set(obj, e);
    }
    res.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=600`);
    res.setHeader('ETag', e.etag);
    const inm = String(req.get('if-none-match') || '');
    if (inm && inm.split(/\s*,\s*/).some(t => t.replace(/^W\//, '') === e.etag.replace(/^W\//, ''))) return res.status(304).end();
    res.type('application/json').send(e.body);
  }
  function fail(res, err, where) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err && err.status === 503) return res.status(503).json({ error: 'NBA player data unavailable' });
    log.error(`[nba] ${where}:`, err && err.message);
    res.status(500).json({ error: 'Research data failed' });
  }

  let metaCache = null; // { at, value } — filter whitelists (teams) for validation
  async function getMeta() {
    if (!metaCache || Date.now() - metaCache.at > 60 * 1000) metaCache = { at: Date.now(), value: await engine.meta() };
    return metaCache.value;
  }

  router.get('/api/nba/research/meta', async (req, res) => {
    try { send(req, res, await getMeta(), 60); } catch (err) { fail(res, err, '/api/nba/research/meta'); }
  });

  router.get('/api/nba/research', async (req, res) => {
    try {
      const m = await getMeta();
      const sort = req.query.sort == null || req.query.sort === '' ? 'hsValue' : String(req.query.sort);
      if (Array.isArray(req.query.sort) || !Object.prototype.hasOwnProperty.call(engine.SORT_KEYS, sort)) bad(`Unknown sort key (allowed: ${Object.keys(engine.SORT_KEYS).join(', ')})`);
      const dir = req.query.dir == null || req.query.dir === '' ? null : String(req.query.dir).toLowerCase();
      if (dir && dir !== 'asc' && dir !== 'desc') bad('dir must be asc or desc');
      const inj = req.query.inj == null || req.query.inj === '' ? null : String(req.query.inj).toLowerCase();
      if (inj && !R.INJ_FILTERS.includes(inj)) bad(`inj must be one of ${R.INJ_FILTERS.join(', ')}`);
      const source = req.query.source == null || req.query.source === '' ? null : String(req.query.source);
      if (source && (!SOURCE_RE.test(source) || !m.filters.source.includes(source))) bad(`source must be one of ${m.filters.source.join(', ')}`);
      const query = {
        q: cleanQ(req.query.q),
        pos: listParam(req.query.pos, 'pos', m.filters.pos),
        slot: listParam(req.query.slot, 'slot', m.filters.slot),
        team: listParam(req.query.team, 'team', m.filters.team),
        inj, source, sort, dir,
        limit: intParam(req.query.limit, 'limit', 50, 1, 200),
        offset: intParam(req.query.offset, 'offset', 0, 0, 5000),
      };
      send(req, res, await engine.table(query));
    } catch (err) { fail(res, err, '/api/nba/research'); }
  });

  router.get('/api/nba/search', async (req, res) => {
    try {
      const q = cleanQ(req.query.q);
      const limit = intParam(req.query.limit, 'limit', 10, 1, 25);
      if (!q) return res.json({ q: '', results: [] });
      send(req, res, await engine.search(q, limit));
    } catch (err) { fail(res, err, '/api/nba/search'); }
  });

  router.get('/api/nba/trending', async (req, res) => {
    try {
      const hours = intParam(req.query.hours, 'hours', 24, 1, 168);
      const limit = intParam(req.query.limit, 'limit', 25, 1, 50);
      send(req, res, await engine.trending({ hours, limit }), 300);
    } catch (err) { fail(res, err, '/api/nba/trending'); }
  });

  router.get('/api/nba/player/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid player id' });
    try {
      const d = await engine.player(id);
      if (!d) return res.status(404).json({ error: 'Player not found', id });
      send(req, res, d, 120);
    } catch (err) { fail(res, err, '/api/nba/player'); }
  });

  return router;
};
module.exports.createRateLimiter = createRateLimiter;
