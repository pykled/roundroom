// Plain node, no deps: node scripts/test-nba-copy.js (exit 0 = pass).
// Basketball wording + NBA theme opt-in across the NBA side of the site:
// nba/pages/*, nba/router.js (incl. the coming-soon fallback), the homepage NBA
// banner/section and the cheat-sheet generator. Comments are stripped first so
// only shipped copy and markup are checked.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('FAIL ' + msg); } }

function stripComments(src, kind) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '');
  if (kind === 'html') s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Line comments: only when // starts the line or follows whitespace/;{}, so URLs survive.
  s = s.replace(/(^|[\s;{}(,])\/\/[^\n]*/g, '$1');
  return s;
}
// The NFL | NBA switch, back-to-NFL links and the /nfl route are the only allowed "NFL".
function dropAllowedNfl(s) {
  return s.replace(/<a href="\/nfl"[^>]*>NFL<\/a>/g, '')
    .replace(/NFL \| NBA/g, '')
    .replace(/(Back to|back to) NFL/g, '');
}

const FORBIDDEN = [
  [/\bQB\b/, 'QB'], [/\bRB\b/, 'RB'], [/\bWR\b/, 'WR'], [/\bTE\b/, 'TE'],
  [/touchdown/i, 'touchdown'], [/quarterback/i, 'quarterback'], [/kick-?off/i, 'kickoff'],
  [/gridiron/i, 'gridiron'], [/bye[- ]weeks?/i, 'bye week'],
  [/weeks? 1\s*[-–]\s*18\b/i, 'week 1-18'], [/\bNFL\b/, 'NFL'],
  // 2026-10-15: the NBA side is Sleeper-first; Yahoo must not appear in shipped NBA copy.
  [/\bYahoo\b/, 'Yahoo'],
];

const sources = [];
for (const f of fs.readdirSync(path.join(ROOT, 'nba/pages')).sort()) {
  if (!/\.(html|js)$/.test(f)) continue;
  sources.push({ name: 'nba/pages/' + f, text: stripComments(read('nba/pages/' + f), f.endsWith('.html') ? 'html' : 'js') });
}
sources.push({ name: 'nba/router.js', text: stripComments(read('nba/router.js'), 'js') });
sources.push({ name: 'scripts/nba-cheatsheet.js', text: stripComments(read('scripts/nba-cheatsheet.js'), 'js') });

const home = read('home.html');
const bannerAt = home.indexOf('id="nba-banner"');
const secAt = home.indexOf('<section id="nba"');
ok(bannerAt > 0 && secAt > 0, 'home.html has #nba-banner and #nba');
const secEnd = home.indexOf('<section', secAt + 10);
sources.push({ name: 'home.html #nba-banner', text: stripComments(home.slice(bannerAt, home.indexOf('</aside>', bannerAt)), 'html') });
sources.push({ name: 'home.html #nba', text: stripComments(home.slice(secAt, secEnd > 0 ? secEnd : undefined), 'html') });

for (const src of sources) {
  const t = dropAllowedNfl(src.text);
  for (const [re, label] of FORBIDDEN) {
    const m = re.exec(t);
    ok(!m, `${src.name}: football term "${label}"${m ? ' near "' + t.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ') + '"' : ''}`);
  }
}

// Every NBA page: <body class="sport-nba">, a basketball <title>, NBA theme-color.
const { comingSoonHtml } = require('../nba/router');
const pages = ['draft', 'lineup', 'trade', 'waivers'].map(n => ({ name: `nba/pages/${n}.html`, html: read(`nba/pages/${n}.html`) }));
pages.push({ name: 'router comingSoonHtml', html: comingSoonHtml('Playoffs') });
for (const p of pages) {
  ok(/<body[^>]*class="[^"]*\bsport-nba\b/.test(p.html), `${p.name}: <body> has class sport-nba`);
  const title = (/<title>([^<]*)<\/title>/.exec(p.html) || [])[1] || '';
  ok(/\bNBA\b|basketball/i.test(title) && !/\bNFL\b|football/i.test(title), `${p.name}: basketball <title> (${title})`);
  const tc = (/<meta name="theme-color" content="([^"]+)"/.exec(p.html) || [])[1];
  ok(tc === '#1a110b', `${p.name}: NBA theme-color meta (${tc})`);
  ok(/<meta name="description" content="[^"]*(NBA|basketball)/i.test(p.html), `${p.name}: basketball meta description`);
  ok(/href="\/nba\/trade"/.test(p.html) && /href="\/nba\/waivers"/.test(p.html) && /href="\/nba\/lineup"/.test(p.html), `${p.name}: nav links to all NBA tools`);
}

// Draft board specifics: hero title, About sheet with 5 steps, no hard-coded league size in static copy.
const draft = pages[0].html;
ok(/<h1 class="page-title">NBA Draft Board<\/h1>/.test(draft), 'draft: hero title "NBA Draft Board"');
const about = (/<ol class="nd-about-list">([\s\S]*?)<\/ol>/.exec(draft) || [])[1] || '';
ok((about.match(/<li>/g) || []).length === 5, 'draft: About this board has 5 bullets');
for (const w of ['draft slot', 'Undo', 'Sleeper', 'clock', 'best game']) ok(about.includes(w), `draft: About covers "${w}"`);
ok(/id="nd-fr-user"/.test(draft) && /Connect Sleeper/.test(draft), 'draft: setup card has the Sleeper username form');
for (const p of pages.slice(1, 4)) ok(!/nine-man|best six/.test(p.html), `${p.name}: no hard-coded lineup size in static copy`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
