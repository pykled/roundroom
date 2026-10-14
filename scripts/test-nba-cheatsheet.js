#!/usr/bin/env node
// Tests for the offline cheat sheet (plain node, exit 0 = pass). Builds into a temp dir.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const L = require('./lib/league-score');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('FAIL: ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const SCRIPT = path.join(__dirname, 'nba-cheatsheet.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-cheat-'));
const run = (out, extra = []) => execFileSync(process.execPath, [SCRIPT, '--out', out, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ---- unit: adapter math + eligibility ----
const W = L.LEAGUE_WEIGHTS;
// pts reb ast stl blk to dd td min pf
const sample = [20, 10, 5, 1, 1, 3, 0.5, 0.1, 30, 2];
// 20 + 12 + 7.5 + 3 + 3 - 3 - 2 - 0.02 + 2.5 + 0.3 = 43.28
ok(Math.abs(L.leaguePerGame(sample, W) - 43.28) < 1e-9, 'leaguePerGame arithmetic');
ok(L.leaguePerGame(sample, W, { tdAlsoCountsDD: false }) < L.leaguePerGame(sample, W), 'td-also-dd flag lowers value');
eq(L.hsPerGame(sample), 20 + 10 + 10 + 3 + 3, 'hsPerGame');
eq(L.eligibility(['C']), ['C', 'UTIL'], 'C-only eligibility (not F)');
eq(L.eligibility(['PG']), ['PG', 'G', 'UTIL'], 'PG-only eligibility');
eq(L.eligibility(['SG']), ['SG', 'G', 'UTIL'], 'SG-only eligibility');
eq(L.eligibility(['SF']), ['SF', 'F', 'UTIL'], 'SF-only eligibility');
eq(L.eligibility(['PF']), ['PF', 'F', 'UTIL'], 'PF-only eligibility');
eq(L.eligibility(['PF', 'C']), ['PF', 'F', 'C', 'UTIL'], 'F/C eligibility');
eq(L.eligibility([]), ['UTIL'], 'unknown position -> UTIL only');

// ---- build ----
const out1 = path.join(tmp, 'a'), out2 = path.join(tmp, 'b');
const log = run(out1);
ok(/values:/.test(log), 'CLI prints value source');
const htmlPath = path.join(out1, 'nba-cheatsheet.html');
ok(fs.existsSync(htmlPath), 'html exists');
const html = fs.readFileSync(htmlPath, 'utf8');
ok(Buffer.byteLength(html) < 1.5 * 1024 * 1024, `html < 1.5 MB (${Buffer.byteLength(html)})`);

// ---- offline: no remote resources ----
ok(!/\b(?:src|href|action|poster|data)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html), 'no src/href to remote hosts');
ok(!/url\(\s*["']?\s*(?:https?:)?\/\//i.test(html), 'no remote url()');
ok(!/@import/i.test(html), 'no @import');
ok(!/https?:\/\//i.test(html), 'no http(s) URL anywhere in the file');
ok(!/<link\b/i.test(html), 'no <link> tags');
ok(!/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/.test(html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '')), 'client code makes no network calls');
ok(!/<script[^>]+src=/i.test(html), 'no external script');

// ---- parses as HTML: tag balance outside script/style ----
function checkHtml(src) {
  const body = src.replace(/<script[\s\S]*?<\/script>/g, '<script></script>').replace(/<style[\s\S]*?<\/style>/g, '<style></style>');
  const VOID = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let m, errs = [];
  while ((m = re.exec(body))) {
    const [, close, tag, self] = m;
    const t = tag.toLowerCase();
    if (VOID.has(t) || self) continue;
    if (!close) stack.push(t);
    else { const top = stack.pop(); if (top !== t) errs.push(`</${t}> closes <${top}>`); }
  }
  if (stack.length) errs.push('unclosed: ' + stack.join(','));
  return errs;
}
eq(checkHtml(html), [], 'html tags balanced');
ok(/^<!doctype html>/i.test(html), 'doctype');
ok(/<html lang="en">/.test(html) && /<meta name="viewport"/.test(html), 'html lang + viewport');

// inline JS parses
const scripts = [...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok(scripts.length === 1, 'one inline script');
let parsed = true;
try { new vm.Script(scripts[0]); } catch (e) { parsed = false; console.error(e.message); }
ok(parsed, 'inline script is valid JS');

// ---- embedded data ----
const dm = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/);
ok(!!dm, 'embedded data block');
const data = JSON.parse(dm[1]);
ok(data.players.length >= 300, `>= 300 players (${data.players.length})`);
ok(data.players.every(p => ['v', 'm', 'sd', 'c', 'f', 'g', 'r', 'ti'].every(k => typeof p[k] === 'number' && Number.isFinite(p[k]))), 'no NaN/missing numerics');
ok(!/NaN|Infinity|undefined/.test(dm[1]), 'no NaN/Infinity/undefined text in data');
ok(data.players.every((p, i) => p.r === i + 1), 'ranks are 1..N in order');
ok(data.players.every((p, i) => i === 0 || p.v <= data.players[i - 1].v), 'sorted by value desc');
ok(data.players.every((p, i) => i === 0 || p.ti >= data.players[i - 1].ti), 'tiers non-decreasing');
ok(new Set(data.players.map(p => p.id)).size === data.players.length, 'unique ids');
ok(data.players.every(p => p.e.includes('UTIL')), 'everyone fits UTIL');
const cOnly = data.players.filter(p => p.p === 'C');
ok(cOnly.length > 10 && cOnly.every(p => p.e.includes('C') && !p.e.includes('F') && !p.e.includes('PF') && !p.e.includes('SF') && !p.e.includes('G')), 'C-only players fit C/UTIL only, never F');
const pgOnly = data.players.filter(p => p.p === 'PG');
ok(pgOnly.length > 10 && pgOnly.every(p => p.e.includes('PG') && p.e.includes('G') && !p.e.includes('SG') && !p.e.includes('C')), 'PG-only fit PG/G/UTIL');
ok(data.players.some(p => p.n === 'Nikola Jokić' && p.r <= 3), 'Jokic ranks top 3');
ok(data.players.some(p => p.nn.includes('jokic')), 'accent-folded search index has jokic');
ok(data.players.every(p => p.nn === p.nn.toLowerCase() && !/[^\x00-\x7f]/.test(p.nn)), 'search index is lowercase ASCII');
const meta = data.meta;
ok(meta.valueSource && /adapter|profile/.test(meta.valueSource), 'values source stamped');
ok(/242808/.test(meta.profile), 'profile id recorded');
eq([meta.weights.pts, meta.weights.reb, meta.weights.ast, meta.weights.stl, meta.weights.blk, meta.weights.to, meta.weights.pf, meta.weights.tech, meta.weights.dd, meta.weights.td], [1, 1.2, 1.5, 3, 3, -1, -1, -1, 5, 3], 'league weights');
ok(html.includes('DRAFT: Wed Oct 14 8pm PT, 12 teams, snake, 90s'), 'draft header present');
ok(/PTS 1 · REB 1\.2 · AST 1\.5/.test(html), 'scoring weights visible');
ok(/id="gen"/.test(html) && /values: /.test(html), 'footer stamps values + generated-at');

// injected fold() matches the generator's and folds accents
const foldSrc = html.match(/var fold = (function fold[\s\S]*?\n\});/);
ok(!!foldSrc, 'fold() injected into page');
if (foldSrc) {
  const f = vm.runInNewContext('(' + foldSrc[1] + ')');
  eq([f('Jokić'), f('Dončić'), f('Şengün'), f('Đ'), f('Peyton Watson')], ['jokic', 'doncic', 'sengun', 'd', 'peyton watson'], 'client fold');
}

// ---- csv / md ----
const csv = fs.readFileSync(path.join(out1, 'nba-board.csv'), 'utf8').trimEnd().split('\n');
eq(csv.length, data.players.length + 1, 'CSV rows = players + header');
ok(csv[0].startsWith('rank,tier,name,team'), 'CSV header');
ok(csv.slice(1).every(l => !/NaN/.test(l)), 'CSV has no NaN');
const md = fs.readFileSync(path.join(out1, 'nba-board.md'), 'utf8');
const mdRows = md.split('\n').filter(l => /^\| \d+ \|/.test(l));
eq(mdRows.length, 200, 'markdown lists top 200');
ok((md.match(/^### Tier/gm) || []).length >= 5, 'markdown has tier breaks');
ok(md.includes('DRAFT: Wed Oct 14 8pm PT'), 'markdown has draft header');

// ---- determinism + --from-json (fixed input => identical apart from timestamps) ----
(async () => {
  const model = require('../nba/model');
  const res = await model.getPlayers();
  const snap = path.join(tmp, 'players.json');
  fs.writeFileSync(snap, JSON.stringify({ asOf: res.asOf, players: res.players }));
  run(path.join(tmp, 'j1'), ['--from-json', snap]);
  run(path.join(tmp, 'j2'), ['--from-json', snap, '--top', '400']);
  const strip = t => t.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'TS');
  for (const f of ['nba-cheatsheet.html', 'nba-board.csv', 'nba-board.md']) {
    const a = strip(fs.readFileSync(path.join(tmp, 'j1', f), 'utf8'));
    const b = strip(fs.readFileSync(path.join(tmp, 'j2', f), 'utf8'));
    ok(a === b, `${f} deterministic`);
  }
  const j = fs.readFileSync(path.join(tmp, 'j1', 'nba-cheatsheet.html'), 'utf8');
  ok(/from-json|json:players\.json/.test(j), 'from-json provenance stamped');
  // --top limits rows
  run(path.join(tmp, 't50'), ['--from-json', snap, '--top', '50']);
  eq(fs.readFileSync(path.join(tmp, 't50', 'nba-board.csv'), 'utf8').trimEnd().split('\n').length, 51, '--top 50 -> 51 csv lines');
  // already profile-valued JSON is used as-is (no adapter ratio applied)
  const valued = res.players.slice(0, 350).map((p, i) => ({ ...p, hsValue: 100 - i * 0.1 }));
  fs.writeFileSync(path.join(tmp, 'valued.json'), JSON.stringify({ profile: '242808', asOf: res.asOf, players: valued }));
  run(path.join(tmp, 'v'), ['--from-json', path.join(tmp, 'valued.json')]);
  const v = JSON.parse(fs.readFileSync(path.join(tmp, 'v', 'nba-cheatsheet.html'), 'utf8').match(/id="data">([\s\S]*?)<\/script>/)[1]);
  ok(v.players[0].v === 100 && /^profile/.test(v.meta.valueSource), 'profile-valued JSON passes through untouched');
  // bad flag fails loudly
  let bad = false;
  try { execFileSync(process.execPath, [SCRIPT, '--nope'], { stdio: 'pipe' }); } catch { bad = true; }
  ok(bad, 'unknown flag exits non-zero');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`nba-cheatsheet tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
