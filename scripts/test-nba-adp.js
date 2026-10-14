// Offline test for scripts/nba-adp-fetch.js parsers + name matching. No network.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseEspn, parseSleeper, parseFantasyPros, matchReport } = require('./nba-adp-fetch');

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nba', 'adp-sample.json'), 'utf8'));
const asOf = '2026-10-13T00:00:00Z';
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const espn = parseEspn(fx.espn, asOf);
ok(espn.length === 30, `espn rows ${espn.length} (floor-ADP row must be dropped)`);
ok(espn[0].name === 'Nikola Jokic' && espn[0].team === 'DEN' && espn[0].source === 'espn' && espn[0].pos.includes('C'), 'espn shape');
ok(espn.every(r => r.adp > 0 && r.adp < 135 && r.asOf === asOf), 'espn adp range');

const sl = parseSleeper(fx.sleeper, asOf);
ok(sl.length === 30, `sleeper rows ${sl.length} (999 and team-less dropped)`);
ok(sl.every(r => r.team && r.adp < 300 && r.source === 'sleeper' && Array.isArray(r.pos)), 'sleeper shape');

const fp = parseFantasyPros(fx.fantasyprosHtml, asOf);
ok(fp.length >= 10 && fp[0].name === 'Nikola Jokic' && fp[0].adp === 1 && fp[0].source === 'fantasypros-yahoo', 'fp parse');
ok(fp.some(r => r.pos.length > 1), 'fp multi-position');

ok(parseEspn(null, asOf).length === 0 && parseSleeper('x', asOf).length === 0 && parseFantasyPros('<html>blocked</html>', asOf).length === 0, 'garbage -> empty, no throw');

const players = [{ name: 'Nikola Jokić', team: 'DEN' }, { name: 'Luka Dončić', team: 'LAL' }];
const m = matchReport([{ name: 'Nikola Jokic', team: 'DEN', adp: 1, source: 'espn' }, { name: 'Luka Doncic', team: 'LAL', adp: 3, source: 'espn' }, { name: 'Nobody Real', team: 'LAL', adp: 90, source: 'espn' }], players);
ok(m.espn.matched === 2 && m.espn.total === 3 && m.espn.unmatched.length === 1, 'diacritic matching + unmatched list');

console.log(`nba-adp: ${n} checks passed`);
