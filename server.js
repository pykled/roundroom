const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 7890;

// Cache for Sleeper player data (large payload, changes rarely)
let playerCache = null;
let playerCacheTime = 0;
const PLAYER_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Proxy + cache Sleeper's large player endpoint
app.get('/api/players', async (req, res) => {
  const now = Date.now();
  if (playerCache && now - playerCacheTime < PLAYER_CACHE_TTL) {
    return res.json(playerCache);
  }
  try {
    const r = await fetch('https://api.sleeper.app/v1/players/nfl');
    if (!r.ok) throw new Error(`Sleeper returned ${r.status}`);
    playerCache = await r.json();
    playerCacheTime = now;
    res.json(playerCache);
  } catch (err) {
    console.error('Player fetch error:', err.message);
    if (playerCache) return res.json(playerCache); // stale cache on error
    res.status(502).json({ error: 'Failed to fetch player data' });
  }
});

// Serve live ADP data (updated nightly by GitHub Actions)
app.get('/api/adp', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/adp.json'), 'utf8'));
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: 'ADP data not yet generated' });
  }
});

app.get('/api/vorp', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/vorp.json'), 'utf8'));
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: 'VORP data not yet generated' });
  }
});

// Serve the app
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Fantasy Draft Assistant running on port ${PORT}`);
});
