// GET /api/nba/league-profile?league_id= → league profile (nba/league-profile.js).
// league_id defaults to Dillon's league (242808). Unknown league → 404.
'use strict';
const express = require('express');
const { getProfile, DEFAULT_LEAGUE_ID } = require('../league-profile');

module.exports = function profileRoutes() {
  const router = express.Router();
  router.get('/api/nba/league-profile', (req, res) => {
    const raw = req.query.league_id;
    const id = raw == null || raw === '' ? DEFAULT_LEAGUE_ID : String(raw).trim();
    if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ error: 'Invalid league_id' });
    const profile = getProfile(id);
    if (!profile) return res.status(404).json({ error: 'Unknown league profile', leagueId: id });
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(profile);
  });
  return router;
};
