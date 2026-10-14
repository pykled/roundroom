#!/usr/bin/env node
// Pocket NBA — offline draft cheat sheet generator (stream S2).
//   node scripts/nba-cheatsheet.js [--profile 242808] [--out dist] [--top 400]
//        [--from-json file.json | --api https://host] [--refresh-stats] [--td-also-dd false]
// Writes <out>/nba-cheatsheet.html (single self-contained file), nba-board.csv, nba-board.md (top 200).
// Docs: docs/nba-cheatsheet.md
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib/league-score');

const ROOT = path.join(__dirname, '..');
const DRAFT_LINE = 'DRAFT: Wed Oct 14 8pm PT, 12 teams, snake, 90s';

function parseArgs(argv) {
  const o = { profile: '242808', out: path.join(ROOT, 'dist'), top: 400, fromJson: null, api: null, refreshStats: false, tdAlsoDD: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--profile') o.profile = val();
    else if (a === '--out') o.out = path.resolve(val());
    else if (a === '--top') o.top = Math.max(1, parseInt(val(), 10) || 400);
    else if (a === '--from-json') o.fromJson = val();
    else if (a === '--api') o.api = val().replace(/\/+$/, '');
    else if (a === '--refresh-stats') o.refreshStats = true;
    else if (a === '--td-also-dd') o.tdAlsoDD = val() !== 'false';
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 6).join('\n')); process.exit(0); }
    else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

// Accent-insensitive fold; the SAME source is injected into the page so search matches the index.
function fold(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/ł/g, 'l').replace(/Ł/g, 'L').replace(/ø/g, 'o').replace(/Ø/g, 'O')
    .replace(/ı/g, 'i').replace(/æ/g, 'ae').toLowerCase().trim();
}

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

// Resolve league-valued players + provenance. Order: saved/API JSON, then nba/league-profile, then adapter.
async function loadBoard(o) {
  let weights = { ...L.LEAGUE_WEIGHTS };
  const flags = { tdAlsoCountsDD: o.tdAlsoDD };
  let fixture = L.loadFixture();
  if (o.refreshStats) {
    const rows = await fetchJson('https://api.sleeper.com/projections/nba/2026?season_type=regular');
    fixture = L.compactStats(rows, new Date().toISOString());
    fs.writeFileSync(L.FIXTURE, JSON.stringify(fixture));
    console.log(`refreshed stats fixture: ${Object.keys(fixture.stats).length} players`);
  }
  let profile = null;
  try { profile = require('../nba/league-profile').getProfile(o.profile); } catch { /* H1 not in this tree */ }
  if (profile && profile.scoring) weights = { ...weights, ...profile.scoring };

  let raw = null, origin;
  if (o.fromJson) { raw = JSON.parse(fs.readFileSync(o.fromJson, 'utf8')); origin = `json:${path.basename(o.fromJson)}`; }
  else if (o.api) { raw = await fetchJson(`${o.api}/api/nba/players?profile=${encodeURIComponent(o.profile)}`); origin = 'api'; }
  if (raw) {
    const players = raw.players || raw;
    if (raw.profile) return { list: fromValued(players), valueSource: `profile (${origin}, profile ${o.profile})`, asOf: raw.asOf, weights, fixture };
    return { list: L.applyAdapter(players, { fixture, weights, flags }), valueSource: `adapter (${origin}; scoring weights applied locally, not the profile)`, asOf: raw.asOf, weights, fixture };
  }
  const model = require('../nba/model');
  if (profile) {
    const res = await model.getPlayers({ profile, leagueId: o.profile });
    if (res && res.profile && res.players && res.players.length) {
      return { list: fromValued(res.players), valueSource: `profile (nba/league-profile ${o.profile})`, asOf: res.asOf, weights, fixture };
    }
  }
  const res = await model.getPlayers();
  return { list: L.applyAdapter(res.players, { fixture, weights, flags }), valueSource: 'adapter (scripts/lib/league-score.js; nba/league-profile not wired to the model in this tree)', asOf: res.asOf, weights, fixture };
}

function fromValued(players) {
  const list = players.map(p => ({
    id: String(p.id), name: p.name, team: p.team, pos: p.pos || [],
    elig: p.elig && p.elig.includes('PG') ? p.elig : L.eligibility(p.pos || []),
    injury: p.injury || null, outForSeason: !!p.outForSeason,
    mean: p.mean, sd: p.sd, ceiling: p.ceiling, floor: p.floor, value: p.hsValue != null ? p.hsValue : p.value,
    games: p.games, source: p.source,
  }));
  return L.finish(list);
}

function clean(list, top) {
  return list.slice(0, top).map(p => {
    const num = x => (Number.isFinite(x) ? x : 0);
    return {
      id: p.id, n: p.name, nn: fold(p.name + ' ' + p.team), t: p.team, p: p.pos.join('/'), e: p.elig,
      r: p.rank, ti: p.tier, v: num(p.value), m: num(p.mean), sd: num(p.sd), c: num(p.ceiling), f: num(p.floor),
      g: num(p.games), inj: p.injury || '', o: p.outForSeason ? 1 : 0,
    };
  });
}

function csvCell(s) { s = String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function toCsv(rows) {
  const head = ['rank', 'tier', 'name', 'team', 'pos', 'fits', 'value', 'mean', 'sd', 'floor', 'ceiling', 'games_per_week', 'injury'];
  const lines = [head.join(',')];
  for (const p of rows) {
    lines.push([p.r, p.ti, p.n, p.t, p.p, p.e.filter(x => x !== 'UTIL').join(' '), p.v, p.m, p.sd, p.f, p.c, p.g, p.inj].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
function toMd(rows, meta) {
  const out = [`# Pocket NBA cheat sheet — top ${rows.length}`, '', `**${DRAFT_LINE}**`, '',
    `Scoring: ${meta.scoringText}`, '', `Values: ${meta.valueSource}. Data as-of ${meta.asOf || 'unknown'}. Generated ${meta.generatedAt}.`, ''];
  let tier = 0;
  for (const p of rows) {
    if (p.ti !== tier) {
      tier = p.ti;
      out.push('', `### Tier ${tier}`, '', '| # | Player | Tm | Pos | Fits | Val | Fl-Ce | G/wk | Inj |', '|--:|---|---|---|---|--:|---|--:|---|');
    }
    out.push(`| ${p.r} | ${p.n} | ${p.t} | ${p.p} | ${p.e.filter(x => x !== 'UTIL').join(' ')} | ${p.v.toFixed(1)} | ${p.f.toFixed(0)}-${p.c.toFixed(0)} | ${p.g.toFixed(1)} | ${p.inj} |`);
  }
  return out.join('\n') + '\n';
}

function scoringText(w) {
  return `PTS ${w.pts} · REB ${w.reb} · AST ${w.ast} · STL ${w.stl} · BLK ${w.blk} · TO ${w.to} · PF ${w.pf} · TECH ${w.tech} · DD +${w.dd} · TD +${w.td}`;
}

function render(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return TEMPLATE
    .replace('/*FOLD*/', () => fold.toString())
    .replace('__DRAFT_LINE__', () => DRAFT_LINE)
    .replace('__SCORING__', () => scoringText(data.meta.weights))
    .replace('__DATA__', () => json);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const b = await loadBoard(o);
  const list = b.list.filter(p => Number.isFinite(p.value));
  const players = clean(list, o.top);
  const meta = {
    profile: o.profile, weights: b.weights, valueSource: b.valueSource, asOf: b.asOf || null,
    generatedAt: new Date().toISOString(), count: players.length, tdAlsoCountsDD: o.tdAlsoDD,
  };
  meta.scoringText = scoringText(b.weights);
  fs.mkdirSync(o.out, { recursive: true });
  const htmlPath = path.join(o.out, 'nba-cheatsheet.html');
  fs.writeFileSync(htmlPath, render({ meta, players }));
  const top200 = players.slice(0, 200);
  fs.writeFileSync(path.join(o.out, 'nba-board.csv'), toCsv(players));
  fs.writeFileSync(path.join(o.out, 'nba-board.md'), toMd(top200, meta));
  const kb = Math.round(fs.statSync(htmlPath).size / 1024);
  console.log(`cheat sheet: ${htmlPath} (${kb} KB, ${players.length} players)`);
  console.log(`values: ${b.valueSource}`);
}

const TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>Pocket NBA cheat sheet</title>
<style>
:root{--bg:#0e1116;--panel:#171c24;--panel2:#1e2530;--line:#2a3340;--tx:#e8edf3;--mut:#8b97a7;--acc:#4cc9a0;--acc2:#f5b942;--bad:#ef6b6b;--me:#4c8dff;--tap:44px}
@media (prefers-color-scheme:light){:root{--bg:#f4f6f9;--panel:#fff;--panel2:#eef1f5;--line:#d5dce6;--tx:#161b22;--mut:#5b6675;--acc:#0b8f69;--acc2:#a96d00;--bad:#c93a3a;--me:#1f63d6}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding-bottom:env(safe-area-inset-bottom)}
button,input,select{font:inherit;color:inherit}
button{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:0 10px;min-height:36px;cursor:pointer}
button:active{filter:brightness(1.2)}
button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,.row:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
header.top{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 10px 6px;padding-top:max(8px,env(safe-area-inset-top))}
.banner{font-weight:700;font-size:13px;color:var(--acc2);letter-spacing:.01em}
.scoring{color:var(--mut);font-size:11px;margin-top:2px}
.status{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}
.status .pick{font-weight:600}
.status .sp{flex:1}
nav.tabs{display:flex;gap:4px;margin-top:6px}
nav.tabs button{flex:1;min-height:var(--tap);font-weight:600}
nav.tabs button[aria-selected=true]{background:var(--acc);color:#04130d;border-color:var(--acc)}
main{display:block;max-width:1280px;margin:0 auto;padding:8px 10px 60px}
.layout{display:block}
.pane[hidden]{display:none}
.controls{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.controls input[type=search]{width:100%;min-height:var(--tap);padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel)}
.chips{display:flex;gap:4px;flex-wrap:wrap}
.chips button{min-width:40px;min-height:36px;padding:0 8px;font-weight:600}
.chips button[aria-pressed=true]{background:var(--acc);color:#04130d;border-color:var(--acc)}
.opt{display:flex;gap:10px;align-items:center;color:var(--mut);font-size:12px}
.opt label{display:flex;gap:6px;align-items:center;min-height:32px}
.hdr,.row{display:grid;grid-template-columns:26px minmax(0,1fr) 40px 34px 34px 26px;gap:4px;align-items:center;padding:0 6px}
.hdr{position:sticky;top:var(--hh,120px);z-index:10;background:var(--bg);font-size:11px;color:var(--mut);border-bottom:1px solid var(--line);min-height:30px}
.hdr button{background:none;border:0;min-height:28px;padding:0;color:var(--mut);text-align:right;font-size:11px;font-weight:600}
.hdr button:first-child,.hdr button.l{text-align:left}
.hdr button[data-on]{color:var(--acc)}
.mean,.hdr .mean{display:none}
.row{min-height:var(--tap);background:var(--panel);border-bottom:1px solid var(--line);cursor:pointer;user-select:none;-webkit-user-select:none}
.row.d{opacity:.38}
.row.d .nm{text-decoration:line-through}
.row.mine{border-left:3px solid var(--me);opacity:.8}
.row .rk{color:var(--mut);font-size:12px;text-align:left}
.row .nm{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .sub{color:var(--mut);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .num{text-align:right;font-variant-numeric:tabular-nums}
.row .val{font-weight:700}
.row .st{display:none}
.badge{display:inline-block;font-size:10px;font-weight:700;padding:0 4px;border-radius:4px;margin-left:4px;vertical-align:1px;background:var(--acc2);color:#1a1200}
.badge.bad{background:var(--bad);color:#fff}
.tierbrk{display:flex;align-items:center;gap:8px;padding:6px 6px 3px;font-size:11px;font-weight:700;color:var(--acc);letter-spacing:.06em;background:var(--bg);border-top:2px solid var(--acc)}
.tierbrk span.c{color:var(--mut);font-weight:500;letter-spacing:0}
.empty{padding:24px;text-align:center;color:var(--mut)}
.starbtn{min-height:36px;min-width:36px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:10px}
.card h2{margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.slotrow{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;gap:6px;align-items:center;min-height:38px;border-bottom:1px solid var(--line)}
.slotrow:last-child{border-bottom:0}
.slotrow .sl{font-weight:700;color:var(--mut)}
.slotrow.open{background:rgba(245,185,66,.12);border-radius:6px;outline:1px dashed var(--acc2);margin:2px 0}
.slotrow.open .sl{color:var(--acc2)}
.slotrow .who{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slotrow.open .who{color:var(--acc2);font-weight:600}
.slotrow .num{text-align:right;font-variant-numeric:tabular-nums}
.sug{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;min-height:var(--tap);border-bottom:1px solid var(--line)}
.sug:last-child{border-bottom:0}
.sug .nm{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sug .fit{color:var(--acc2);font-size:11px}
.muted{color:var(--mut)}
.small{font-size:12px}
details.slotlist{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:8px}
details.slotlist summary{min-height:var(--tap);display:flex;align-items:center;gap:8px;padding:0 10px;font-weight:700;cursor:pointer}
details.slotlist summary .o{color:var(--acc2);font-size:11px}
.sl30{display:grid;grid-template-columns:28px minmax(0,1fr) 30px 44px;gap:6px;align-items:center;min-height:36px;padding:0 10px;border-top:1px solid var(--line);cursor:pointer}
.tag{display:inline-block;min-width:22px;text-align:center;font-size:11px;font-weight:700;border-radius:4px;padding:0 4px}
.t1{background:#e5b800;color:#2b2100}.t2{background:#c0c7d1;color:#1d232b}.t3{background:#d08a4f;color:#2a1700}
.t4{background:#4cc9a0;color:#04130d}.t5{background:#4c8dff;color:#fff}.t6{background:#8e6bf0;color:#fff}.t7{background:#e060b0;color:#fff}.t8{background:#5b6675;color:#fff}
.gridwrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
table.rg{border-collapse:separate;border-spacing:0;min-width:640px;width:100%;font-size:11px}
table.rg th,table.rg td{padding:4px 5px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);vertical-align:top;text-align:left;min-width:74px}
table.rg th{position:sticky;top:0;background:var(--panel2);z-index:2}
table.rg td:first-child,table.rg th:first-child{position:sticky;left:0;background:var(--panel2);z-index:1;min-width:40px;font-weight:700;text-align:center}
table.rg tr.cur td{background:rgba(76,201,160,.10)}
table.rg tr.cur td:first-child{background:var(--acc);color:#04130d}
table.rg .c1{font-weight:600;white-space:nowrap}
table.rg .c2{color:var(--mut);white-space:nowrap}
.stale{font-style:italic}
footer{color:var(--mut);font-size:11px;padding:12px 10px 30px;max-width:1280px;margin:0 auto;border-top:1px solid var(--line)}
footer b{color:var(--tx)}
select{min-height:36px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);padding:0 6px}
@media (min-width:600px){
  .hdr,.row{grid-template-columns:30px minmax(0,1fr) 46px 42px 42px 42px 30px}
  .mean,.hdr .mean{display:block}
}
@media (min-width:900px){
  main{padding:10px 14px 60px}
  .layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:14px;align-items:start}
  #mine{position:sticky;top:var(--hh,120px);max-height:calc(100vh - var(--hh,120px) - 10px);overflow:auto}
  nav.tabs button[data-tab=mine]{display:none}
  .row .st{display:block;text-align:right;font-size:11px;color:var(--mut)}
  .hdr,.row{grid-template-columns:34px minmax(0,1fr) 54px 48px 48px 48px 34px 90px}
  .hdr .st{display:block}
  .controls{flex-direction:row;align-items:center;flex-wrap:wrap}
  .controls input[type=search]{width:260px}
}
@media (prefers-reduced-motion:no-preference){.row,button{transition:background-color .12s ease,filter .12s ease}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media print{header.top nav,.controls,#mine{display:none}.row{break-inside:avoid}}
</style>
</head>
<body>
<header class="top" id="top">
  <div class="banner">__DRAFT_LINE__</div>
  <div class="scoring" id="scoring">__SCORING__</div>
  <div class="status">
    <span class="pick" id="pickinfo"></span>
    <span class="sp"></span>
    <label class="small muted">My draft slot <select id="mypos" aria-label="My draft slot"></select></label>
    <button id="undo" type="button">Undo</button>
  </div>
  <nav class="tabs" role="tablist" aria-label="Sections">
    <button role="tab" data-tab="board" aria-selected="true" type="button">Board</button>
    <button role="tab" data-tab="mine" aria-selected="false" type="button">My team</button>
    <button role="tab" data-tab="slots" aria-selected="false" type="button">By slot</button>
    <button role="tab" data-tab="rounds" aria-selected="false" type="button">Rounds</button>
  </nav>
</header>
<main>
  <div class="layout">
    <div>
      <section class="pane" id="p-board" data-pane="board">
        <div class="controls">
          <input type="search" id="q" placeholder="Search player or team" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search players">
          <div class="chips" id="chips" role="group" aria-label="Filter by slot"></div>
          <div class="opt"><label><input type="checkbox" id="hide"> Hide drafted</label><span id="count"></span></div>
        </div>
        <div class="hdr" id="hdr">
          <button data-s="rank" type="button">#</button>
          <button data-s="name" class="l" type="button">Player</button>
          <button data-s="value" type="button">Value</button>
          <button data-s="floor" type="button">Floor</button>
          <button data-s="ceil" type="button">Ceil</button>
          <button data-s="games" type="button" title="Games per week">G/wk</button>
          <span></span>
        </div>
        <div id="board"></div>
      </section>
      <section class="pane" id="p-slots" data-pane="slots" hidden><div id="slotlists"></div></section>
      <section class="pane" id="p-rounds" data-pane="rounds" hidden>
        <p class="small muted">Best two still-available players per slot starting at each round's first pick (12-team board order). Italic = a reach beyond that round's range. Highlighted row = your current round.</p>
        <div class="gridwrap"><table class="rg" id="rg"></table></div>
      </section>
    </div>
    <aside class="pane" id="mine" data-pane="mine" hidden></aside>
  </div>
</main>
<footer id="foot"></footer>
<script type="application/json" id="data">__DATA__</script>
<script>
(function(){
"use strict";
var fold = /*FOLD*/;
var D = JSON.parse(document.getElementById("data").textContent);
var P = D.players, M = D.meta;
var TEAMS = 12, PICKS_PER = TEAMS;
var SLOTS = ["PG","SG","G","SF","PF","F","C","UTIL"];
var STARTERS = ["PG","SG","G","SF","PF","F","C","UTIL","UTIL"];
var byId = {};
P.forEach(function(p){ byId[p.id] = p; });
var KEY = "pocket-nba-s2-" + M.profile;
var S = { log: [], mypos: 0, hide: true, slot: "ALL", sort: "rank", dir: 1, q: "", tab: "board", openSlots: {} };
try { var sv = JSON.parse(localStorage.getItem(KEY) || "null"); if (sv) { S.log = (sv.log || []).filter(function(e){ return byId[e.id]; }); S.mypos = sv.mypos | 0; if (sv.hide === false) S.hide = false; } } catch (e) {}
function save(){ try { localStorage.setItem(KEY, JSON.stringify({ log: S.log, mypos: S.mypos, hide: S.hide })); } catch (e) {} }
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
function f1(x){ return (Math.round(x * 10) / 10).toFixed(1); }
function lastName(n){ var i = n.indexOf(" "); return i < 0 ? n : n.slice(i + 1); }
function tierCls(t){ return "t" + (t > 8 ? 8 : t); }

var drafted = {};
function recompute(){ drafted = {}; S.log.forEach(function(e){ drafted[e.id] = e.w; }); }

function mark(id, who){
  var i = -1;
  S.log.forEach(function(e, k){ if (e.id === id) i = k; });
  if (i >= 0) S.log.splice(i, 1); else S.log.push({ id: id, w: who });
  save(); render();
}
function undo(){ if (S.log.length) { S.log.pop(); save(); render(); } }

/* ---------- board ---------- */
function visible(){
  var q = fold(S.q);
  var list = P.filter(function(p){
    if (S.hide && drafted[p.id]) return false;
    if (S.slot !== "ALL" && p.e.indexOf(S.slot) < 0) return false;
    if (q && p.nn.indexOf(q) < 0 && fold(p.p).indexOf(q) < 0) return false;
    return true;
  });
  var key = { rank: function(p){ return p.r; }, value: function(p){ return -p.v; }, floor: function(p){ return -p.f; }, ceil: function(p){ return -p.c; }, games: function(p){ return -p.g; }, name: function(p){ return fold(p.n); } }[S.sort];
  list.sort(function(a, b){ var x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : a.r - b.r) * S.dir; });
  return list;
}
function badge(p){
  if (p.o) return '<span class="badge bad">OUT-SZN</span>';
  if (!p.inj) return "";
  var bad = /^(out|ir|sus|o)$/i.test(p.inj);
  return '<span class="badge' + (bad ? " bad" : "") + '">' + esc(p.inj.toUpperCase()) + "</span>";
}
function rowHtml(p){
  var d = drafted[p.id];
  var fits = p.e.filter(function(x){ return x !== "UTIL"; }).join(" ");
  return '<div class="row' + (d ? " d" : "") + (d === "me" ? " mine" : "") + '" role="button" tabindex="0" data-id="' + p.id + '" aria-label="' + esc(p.n) + ', rank ' + p.r + (d ? ", drafted" : "") + '">' +
    '<span class="rk">' + p.r + "</span>" +
    '<span><div class="nm">' + esc(p.n) + badge(p) + '</div><div class="sub">' + esc(p.t) + " · " + esc(p.p) + " · fits " + esc(fits) + "</div></span>" +
    '<span class="num val">' + f1(p.v) + "</span>" +
    '<span class="num">' + Math.round(p.f) + "</span>" +
    '<span class="num">' + Math.round(p.c) + "</span>" +
    '<span class="num">' + f1(p.g) + "</span>" +
    '<button class="starbtn" type="button" data-me="' + p.id + '" aria-label="Draft ' + esc(p.n) + ' to my team">' + (d === "me" ? "★" : "☆") + "</button>" +
    '<span class="st">' + (d === "me" ? "mine" : d ? "taken" : "T" + p.ti) + "</span></div>";
}
function renderBoard(){
  var list = visible();
  var useBrk = S.sort === "rank" || S.sort === "value";
  var html = [], lastT = null;
  var left = {};
  P.forEach(function(p){ if (!drafted[p.id]) left[p.ti] = (left[p.ti] || 0) + 1; });
  list.forEach(function(p){
    if (useBrk && p.ti !== lastT) { html.push('<div class="tierbrk">TIER ' + p.ti + ' <span class="c">' + (left[p.ti] || 0) + " left</span></div>"); lastT = p.ti; }
    html.push(rowHtml(p));
  });
  $("board").innerHTML = html.length ? html.join("") : '<div class="empty">No players match.</div>';
  $("count").textContent = list.length + " shown · " + (P.length - S.log.length) + " available";
}

/* ---------- my team ---------- */
function assign(my){
  var owner = [];
  STARTERS.forEach(function(){ owner.push(-1); });
  function tryP(pi, seen){
    for (var s = 0; s < STARTERS.length; s++) {
      if (seen[s] || my[pi].e.indexOf(STARTERS[s]) < 0) continue;
      seen[s] = true;
      if (owner[s] < 0 || tryP(owner[s], seen)) { owner[s] = pi; return true; }
    }
    return false;
  }
  var placed = {};
  my.forEach(function(p, pi){ tryP(pi, []); });
  owner.forEach(function(pi){ if (pi >= 0) placed[pi] = true; });
  return { owner: owner, bench: my.filter(function(p, pi){ return !placed[pi]; }) };
}
function myPlayers(){
  return S.log.filter(function(e){ return e.w === "me"; }).map(function(e){ return byId[e.id]; }).sort(function(a, b){ return a.r - b.r; });
}
function openSlotsList(a){
  var o = [];
  a.owner.forEach(function(pi, s){ if (pi < 0) o.push(STARTERS[s]); });
  return o;
}
function nextPicks(count){
  var out = [];
  if (!S.mypos) return out;
  for (var n = S.log.length + 1; out.length < count && n <= 16 * TEAMS; n++) {
    var round = Math.ceil(n / TEAMS), idx = (n - 1) % TEAMS + 1;
    var pos = round % 2 ? idx : TEAMS + 1 - idx;
    if (pos === S.mypos) out.push(n);
  }
  return out;
}
function renderMine(){
  var my = myPlayers(), a = assign(my), open = openSlotsList(a);
  var h = ['<div class="card"><h2>Starters (' + (STARTERS.length - open.length) + "/" + STARTERS.length + ")</h2>"];
  a.owner.forEach(function(pi, s){
    var p = pi >= 0 ? my[pi] : null;
    h.push('<div class="slotrow' + (p ? "" : " open") + '"><span class="sl">' + STARTERS[s] + '</span><span class="who">' + (p ? esc(p.n) + " " + badge(p) : "OPEN") + '</span><span class="num">' + (p ? f1(p.v) : "") + "</span></div>");
  });
  h.push("</div>");
  h.push('<div class="card"><h2>Bench (' + Math.min(a.bench.length, 5) + "/5) · IL 2</h2>");
  for (var i = 0; i < 5; i++) {
    var b = a.bench[i];
    h.push('<div class="slotrow"><span class="sl">BN</span><span class="who ' + (b ? "" : "muted") + '">' + (b ? esc(b.n) : "—") + '</span><span class="num">' + (b ? f1(b.v) : "") + "</span></div>");
  }
  if (a.bench.length > 5) h.push('<div class="small muted">+' + (a.bench.length - 5) + " over bench limit (use IL / drop)</div>");
  h.push("</div>");
  // suggestion
  var cand = [], want = open.length ? open : null;
  for (var k = 0; k < P.length && cand.length < 6; k++) {
    var p2 = P[k];
    if (drafted[p2.id]) continue;
    var fit = want ? p2.e.filter(function(x){ return want.indexOf(x) >= 0 && x !== "UTIL"; }) : [];
    if (want && !fit.length && want.indexOf("UTIL") < 0) continue;
    cand.push({ p: p2, fit: fit });
  }
  h.push('<div class="card"><h2>' + (want ? "Best available for open slots: " + esc(Array.from(new Set(open)).join(" ")) : "Starters full: best available (bench)") + "</h2>");
  cand.forEach(function(c){
    var fitTxt = want ? (c.fit.length ? "fills " + c.fit.join("/") : "fills UTIL") : "bench";
    h.push('<div class="sug" data-id="' + c.p.id + '"><span><div class="nm">' + esc(c.p.n) + badge(c.p) + '</div><div class="fit">' + fitTxt + " · T" + c.p.ti + " · #" + c.p.r + '</div></span><span class="num">' + f1(c.p.v) + '</span><button type="button" data-me="' + c.p.id + '" aria-label="Draft ' + esc(c.p.n) + ' to my team">★ Mine</button></div>');
  });
  h.push("</div>");
  var np = nextPicks(4);
  h.push('<div class="card"><h2>My picks</h2><div class="small">' + (S.mypos ? "Slot " + S.mypos + " · next picks: " + (np.length ? np.map(function(n){ return "#" + n + " (R" + Math.ceil(n / TEAMS) + ")"; }).join(", ") : "none left") : "Set \"My draft slot\" above once the order is drawn.") + "</div></div>");
  $("mine").innerHTML = h.join("");
}

/* ---------- by slot ---------- */
function renderSlots(){
  var my = myPlayers(), open = openSlotsList(assign(my));
  var h = [];
  SLOTS.forEach(function(s){
    var items = P.filter(function(p){ return !drafted[p.id] && p.e.indexOf(s) >= 0; }).slice(0, 30);
    var isOpen = open.indexOf(s) >= 0;
    var openState = S.openSlots[s] !== undefined ? S.openSlots[s] : isOpen;
    h.push('<details class="slotlist" data-slot="' + s + '"' + (openState ? " open" : "") + "><summary>" + s + (isOpen ? ' <span class="o">OPEN</span>' : "") + ' <span class="muted small">top ' + items.length + " available</span></summary>");
    items.forEach(function(p, i){
      h.push('<div class="sl30" data-id="' + p.id + '"><span class="muted">' + (i + 1) + '</span><span class="nm">' + esc(p.n) + badge(p) + '<div class="sub muted small">' + esc(p.t) + " · " + esc(p.p) + '</div></span><span class="tag ' + tierCls(p.ti) + '">' + p.ti + '</span><span class="num val">' + f1(p.v) + "</span></div>");
    });
    h.push("</details>");
  });
  $("slotlists").innerHTML = h.join("");
}

/* ---------- rounds ---------- */
function renderRounds(){
  var round = Math.floor(S.log.length / PICKS_PER) + 1;
  var h = ["<thead><tr><th>Rd</th>" + SLOTS.map(function(s){ return "<th>" + s + "</th>"; }).join("") + "</tr></thead><tbody>"];
  for (var r = 1; r <= 16; r++) {
    var lo = (r - 1) * PICKS_PER + 1, hi = r * PICKS_PER;
    h.push('<tr class="' + (r === round ? "cur" : "") + '"><td>' + r + "</td>");
    SLOTS.forEach(function(s){
      var got = [];
      for (var i = 0; i < P.length && got.length < 2; i++) {
        var p = P[i];
        if (p.r < lo || drafted[p.id] || p.e.indexOf(s) < 0) continue;
        got.push(p);
      }
      h.push("<td>" + got.map(function(p, k){
        var reach = p.r > hi + 6 ? " stale" : "";
        return '<div class="' + (k ? "c2" : "c1") + reach + '">' + esc(lastName(p.n)) + ' <span class="tag ' + tierCls(p.ti) + '">' + p.ti + "</span></div>";
      }).join("") + "</td>");
    });
    h.push("</tr>");
  }
  h.push("</tbody>");
  $("rg").innerHTML = h.join("");
}

/* ---------- chrome ---------- */
function renderStatus(){
  var n = S.log.length + 1;
  var round = Math.ceil(n / PICKS_PER);
  $("pickinfo").textContent = n > 16 * PICKS_PER ? "Draft complete" : "Pick " + n + " · Round " + round;
  $("undo").disabled = !S.log.length;
  $("undo").textContent = S.log.length ? "Undo (" + S.log.length + ")" : "Undo";
}
function render(){
  recompute();
  renderStatus();
  renderBoard();
  renderMine();
  renderSlots();
  renderRounds();
  syncHeaderHeight();
}
function syncHeaderHeight(){ document.documentElement.style.setProperty("--hh", $("top").offsetHeight + "px"); }
function setTab(t){
  S.tab = t;
  document.querySelectorAll("nav.tabs button").forEach(function(b){ b.setAttribute("aria-selected", b.dataset.tab === t ? "true" : "false"); });
  var wide = window.matchMedia("(min-width:900px)").matches;
  document.querySelectorAll(".pane").forEach(function(el){
    var k = el.dataset.pane;
    el.hidden = k === "mine" ? !(wide || t === "mine") : k !== t && !(wide && k === "board" && t === "mine");
  });
  if (wide && t === "mine") { $("p-board").hidden = false; }
  syncHeaderHeight();
}

/* ---------- wiring ---------- */
(function init(){
  var chips = ["ALL"].concat(SLOTS);
  $("chips").innerHTML = chips.map(function(s){ return '<button type="button" data-slot="' + s + '" aria-pressed="' + (s === S.slot) + '">' + s + "</button>"; }).join("");
  var opt = '<option value="0">—</option>';
  for (var i = 1; i <= TEAMS; i++) opt += '<option value="' + i + '">' + i + "</option>";
  $("mypos").innerHTML = opt; $("mypos").value = String(S.mypos);
  $("hide").checked = S.hide;
  $("chips").addEventListener("click", function(e){
    var b = e.target.closest("button"); if (!b) return;
    S.slot = b.dataset.slot;
    document.querySelectorAll("#chips button").forEach(function(x){ x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    renderBoard();
  });
  $("q").addEventListener("input", function(){ S.q = this.value; renderBoard(); });
  $("hide").addEventListener("change", function(){ S.hide = this.checked; save(); renderBoard(); });
  $("mypos").addEventListener("change", function(){ S.mypos = +this.value; save(); renderMine(); });
  $("undo").addEventListener("click", undo);
  $("hdr").addEventListener("click", function(e){
    var b = e.target.closest("button"); if (!b || !b.dataset.s) return;
    if (S.sort === b.dataset.s) S.dir = -S.dir; else { S.sort = b.dataset.s; S.dir = 1; }
    document.querySelectorAll("#hdr button").forEach(function(x){ if (x === b) x.setAttribute("data-on", ""); else x.removeAttribute("data-on"); });
    renderBoard();
  });
  function onPick(e){
    var me = e.target.closest("[data-me]");
    if (me) { e.stopPropagation(); mark(me.dataset.me, "me"); return; }
    var el = e.target.closest("[data-id]");
    if (el) mark(el.dataset.id, "x");
  }
  $("board").addEventListener("click", onPick);
  $("board").addEventListener("keydown", function(e){ if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("row")) { e.preventDefault(); mark(e.target.dataset.id, "x"); } });
  $("slotlists").addEventListener("click", function(e){ if (e.target.closest("summary")) return; onPick(e); });
  $("slotlists").addEventListener("toggle", function(e){ var d = e.target; if (d.dataset && d.dataset.slot) S.openSlots[d.dataset.slot] = d.open; }, true);
  $("mine").addEventListener("click", function(e){ var me = e.target.closest("[data-me]"); if (me) mark(me.dataset.me, "me"); });
  document.querySelector("nav.tabs").addEventListener("click", function(e){ var b = e.target.closest("button"); if (b) setTab(b.dataset.tab); });
  window.addEventListener("resize", function(){ setTab(S.tab); });
  window.addEventListener("storage", function(e){
    if (e.key !== KEY) return;
    try { var sv = JSON.parse(e.newValue || "null"); if (sv) { S.log = sv.log || []; S.mypos = sv.mypos | 0; $("mypos").value = String(S.mypos); render(); } } catch (x) {}
  });
  var foot = '<b>' + esc(document.querySelector(".banner").textContent) + '</b><br>Scoring: ' + esc(M.scoringText) +
    '<br>values: ' + esc(M.valueSource) + '<br>generated <span id="gen">' + esc(M.generatedAt) + '</span> · data as-of ' + esc(M.asOf || "unknown") + " · " + P.length + " players" +
    '<br>Scoring-weight values are projections, not guarantees. Eligibility derived from Sleeper positions (low confidence) until Yahoo positions are known; check the Yahoo draft room for exact slots. TD games ' + (M.tdAlsoCountsDD ? "also" : "do not also") + " earn the DD bonus (unverified assumption).";
  $("foot").innerHTML = foot;
  recompute();
  setTab("board");
  render();
})();
})();
</script>
</body>
</html>
`;

main().catch(err => { console.error('nba-cheatsheet: ' + err.message); process.exit(1); });
