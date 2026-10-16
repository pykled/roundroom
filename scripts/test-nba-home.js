// N1: homepage NBA entry, shared/nav.js sport switch, NBA theme tokens.
// Plain node, no deps: node scripts/test-nba-home.js (exit 0 = pass).
//   1. home.html links to /nba (banner, section, footer) and keeps the NFL
//      page's key elements, compared against `git show nba:home.html`.
//   2. No new external origins in home.html.
//   3. nav.js sport detection + enhance() on a minimal DOM stub.
//   4. shared/styles.css brace balance + NBA theme tokens + WCAG contrast.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let fails = 0, passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; } else { fails++; console.error('FAIL', msg); }
}

// ---------- 1. home.html ----------
const home = fs.readFileSync(path.join(ROOT, 'home.html'), 'utf8');
let base = null;
for (const ref of ['nba', 'refs/heads/nba', 'main']) {
  try { base = execSync(`git show ${ref}:home.html`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); break; } catch (_) {}
}
ok(base, 'baseline home.html from git (nba or main)');

ok(/<a[^>]+href="\/nba"[^>]*id="nba-banner-cta"|id="nba-banner-cta"[^>]+href="\/nba"/.test(home.replace(/\n/g, ' ')) || /class="nba-btn" id="nba-banner-cta" href="\/nba"/.test(home), 'banner CTA links to /nba');
ok(/id="nba-cta" href="\/nba"/.test(home), 'NBA section CTA links to /nba');
ok(/href="\/nba" class="nba-foot"/.test(home), 'footer links to /nba');
ok((home.match(/href="\/nba"/g) || []).length >= 3, 'at least 3 links to /nba');
ok(/<section id="nba" class="sport-nba"/.test(home), 'NBA section opts into .sport-nba');
ok(/track\(p\[1\]/.test(home) && /'nba-banner-click'/.test(home) && /'nba-section-click'/.test(home) && /'nba-footer-click'/.test(home), 'Umami nba-* events wired');

// Stable NFL selectors/strings that must survive (every one exists in the baseline).
const KEEP = [
  'id="hero-form"', 'id="hero-user"', 'id="hero-go"', 'Open my draft board →', 'id="cta-primary"', 'id="cta-secondary"',
  'id="frame-trade"', 'id="frame-leagues"', 'id="draft-banner"', '<section id="tools">', '<section id="method">',
  '<section id="faq"', 'href="/draft"', 'href="/trade"', 'href="/lineup"', 'Fantasy football tools, scored to your Sleeper league.',
  "track('hero-username-submit')", "track('hero-secondary-click'", '<script defer src="/shared/nav.js"></script>',
  'Built for Sleeper leagues', 'class="rr-footer"', 'rel="canonical" href="https://pocketff.com/"',
];
for (const k of KEEP) {
  if (base) ok(base.includes(k), `baseline contains ${k}`);
  ok(home.includes(k), `home.html still contains ${k}`);
}
// Every id in the baseline survives.
if (base) {
  const ids = [...base.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  for (const id of ids) ok(home.includes(`id="${id}"`), `baseline id #${id} kept`);
  // The NFL sections stay in the same order, NBA section after #tools.
  const order = s => ['id="hero"', 'id="tools"', 'id="method"', 'id="faq"'].map(x => s.indexOf(x));
  const o = order(home);
  ok(o.every((v, i) => v > 0 && (i === 0 || v > o[i - 1])), 'NFL section order kept');
  ok(home.indexOf('id="nba"') > o[1] && home.indexOf('id="nba"') < o[2], '#nba sits between #tools and #method');
  // Outside the NBA blocks (their CSS, banner, section) and the stylesheet
  // cache-buster, every baseline line survives verbatim.
  const nbaRegions = s => [
    [s.indexOf('/* ---- NBA entry'), s.indexOf('/* ---- Footer:')],
    [s.indexOf('<aside id="nba-banner"'), s.indexOf('</aside>', s.indexOf('<aside id="nba-banner"'))],
    [s.indexOf('<section id="nba"'), s.indexOf('</section>', s.indexOf('<section id="nba"'))],
  ].filter(([a, b]) => a >= 0 && b > a);
  const outside = s => { let t = s; for (const [a, b] of nbaRegions(s).sort((x, y) => y[0] - x[0])) t = t.slice(0, a) + t.slice(b); return t; };
  const homeSet = new Set(home.split('\n'));
  const removed = outside(base).split('\n').filter(l => l.trim() && !homeSet.has(l) && !/href="\/shared\/styles\.css"/.test(l));
  ok(removed.length === 0, `no non-NBA baseline lines removed or edited (got ${removed.length}: ${removed.slice(0, 3).join(' | ')})`);
}

// ---------- 1b. NBA CTA renders without .sport-nba or a fresh shared CSS ----------
// Live bug (2026-10-13): a browser holding a cached pre-NBA /shared/styles.css
// rendered the banner CTA as a bare underlined "OpenNBA board→" link.
const bannerHtml = (home.match(/<aside id="nba-banner"[\s\S]*?<\/aside>/) || [''])[0];
const ctaHtml = (bannerHtml.match(/<a [^>]*id="nba-banner-cta"[\s\S]*?<\/a>/) || [''])[0];
const ctaText = ctaHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
ok(/(^|\s)Open NBA board(\s|$)/.test(ctaText), `banner CTA label is "Open NBA board" (got "${ctaText}")`);
ok(/>Open NBA board\s/.test(ctaHtml), 'banner CTA text node keeps the spaces (not split across spans)');
ok(/class="nba-arrow"[^>]*aria-hidden="true"/.test(ctaHtml), 'banner CTA arrow is decorative (aria-hidden)');
ok(/<a [^>]*id="nba-cta"[^>]*>Open the NBA draft board\s/.test(home), 'section CTA label intact');
ok(/<link rel="stylesheet" href="\/shared\/styles\.css\?v=[\w.-]+">/.test(home), 'home.html cache-busts /shared/styles.css');

const homeStyle = (home.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1].replace(/\/\*[\s\S]*?\*\//g, '');
// All top-level rules (media blocks flattened) as [selectorList, body].
const rules = src => [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim().replace(/^@media[^{]*\{/, '').trim(), m[2]]);
const homeRules = rules(homeStyle);
const sels = r => r[0].split(',').map(s => s.trim().replace(/\s+/g, ' '));
const ruleFor = (sel, prop) => homeRules.find(r => sels(r).includes(sel) && (!prop || new RegExp(`(^|;|\\s)${prop}\\s*:`).test(r[1])));
const tokRule = homeRules.find(r => sels(r).includes('#nba-banner') && /--nba-ink\s*:/.test(r[1]));
ok(tokRule && ['--nba-300', '--nba-400', '--nba-500', '--nba-600', '--nba-ink'].every(t => new RegExp(t + '\\s*:\\s*#').test(tokRule[1])),
  'home.html defines the NBA tokens on #nba-banner itself (no .sport-nba dependency)');
ok(tokRule && sels(tokRule).every(s => !/sport-nba|body|:root|^html/.test(s)), 'token rule is scoped to the NBA blocks only (no orange leak onto NFL elements)');
const btn = ruleFor('#nba-banner .nba-btn', 'background');
ok(btn, 'banner .nba-btn rule exists with an unscoped selector (#nba-banner .nba-btn, no .sport-nba)');
if (btn) {
  ok(/display:\s*inline-flex/.test(btn[1]) && /align-items:\s*center/.test(btn[1]), 'banner CTA is an inline-flex, vertically centred button');
  ok(/min-height:\s*44px/.test(btn[1]), 'banner CTA tap target >= 44px');
  ok(/text-decoration:\s*none/.test(btn[1]), 'banner CTA has no underline');
  ok(/color:\s*var\(--nba-ink\)/.test(btn[1]) && /linear-gradient\([^;]*var\(--nba-400\)/.test(btn[1]), 'banner CTA: ink label on an orange fill');
  ok(/border-radius:\s*999px/.test(btn[1]), 'banner CTA is a pill');
  ok(sels(btn).includes('#nba .nba-btn'), 'section CTA shares the same button rule');
}
ok(ruleFor('#nba-banner .nba-btn:focus-visible', 'outline'), 'banner CTA has a visible :focus-visible ring');
ok(ruleFor('#nba-banner .nba-btn:hover', 'background'), 'banner CTA has a hover state');
ok(ruleFor('#nba-banner .nba-btn:active', 'transform'), 'banner CTA has an active (pressed) state');
ok(ruleFor('#nba-banner .nba-btn:hover .nba-arrow', 'transform'), 'arrow nudges on hover');
const rm = (homeStyle.match(/@media \(prefers-reduced-motion: reduce\) \{\s*#nba-banner[\s\S]*?\}\s*\}/) || [''])[0];
ok(/#nba-banner \.nba-btn:hover \.nba-arrow[\s\S]*transform:\s*none/.test(rm), 'reduced motion: arrow nudge and press scale disabled');
// shared/styles.css still carries an unscoped .nba-btn (for /nba pages and other callers).
ok(/(^|\})\s*(?:[^{}]*,\s*)?\.nba-btn\s*[,{]/m.test(css0()) , 'shared/styles.css has a .nba-btn selector not scoped under .sport-nba');
function css0() { return fs.readFileSync(path.join(ROOT, 'shared', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); }

// ---------- 2. external resources ----------
const origins = s => new Set([...s.matchAll(/(?:src|href)="(https?:\/\/[^/"]+)/g)].map(m => m[1]));
if (base) {
  const extra = [...origins(home)].filter(o => !origins(base).has(o));
  ok(extra.length === 0, `no new external origins (${extra.join(', ')})`);
}
// NBA copy: no football language leaking into the NBA blocks.
const nbaBlock = (home.match(/<aside id="nba-banner"[\s\S]*?<\/aside>/) || [''])[0] +
  (home.match(/<section id="nba"[\s\S]*?<\/section>/) || [''])[0];
ok(nbaBlock.length > 500, 'NBA blocks found');
const nbaText = nbaBlock.replace(/<[^>]+>/g, ' ');
for (const w of ['Yahoo', 'football', 'QB', 'RB', 'WR', 'TE', 'touchdown', 'PPR', 'superflex', 'FLEX', 'NFL', 'VORP']) {
  ok(!new RegExp(`\\b${w}\\b`, 'i').test(nbaText), `NBA copy free of "${w}"`);
}
ok(/High Score/.test(nbaText) && /best game/i.test(nbaText) && /Sleeper/.test(nbaText), 'NBA copy names High Score, best game, Sleeper');

// ---------- 3. nav.js ----------
// Minimal DOM stub: enough of Element for enhance() (class/id/attr selectors,
// insertBefore/appendChild, innerHTML of <a> lists).
function el(tag, attrs = {}, kids = []) {
  const e = {
    tagName: tag.toUpperCase(), attrs: { ...attrs }, children: [], parent: null, text: '',
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    get className() { return this.attrs.class || ''; }, set className(v) { this.attrs.class = v; },
    set textContent(v) { this.text = v; }, get textContent() { return this.text + this.children.map(c => c.textContent).join(''); },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    insertBefore(c, ref) { c.parent = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
    get nextSibling() { const s = this.parent ? this.parent.children : []; return s[s.indexOf(this) + 1] || null; },
    get firstChild() { return this.children[0] || null; },
    set innerHTML(html) {
      this.children = [];
      for (const m of html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)) {
        const a = el('a'); for (const am of m[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) a.attrs[am[1]] = am[2] == null ? '' : am[2];
        a.text = m[2]; this.appendChild(a);
      }
    },
    all() { return this.children.flatMap(c => [c, ...c.all()]); },
    querySelectorAll(sel) { return this.all().filter(n => sel.split(',').some(s => match(n, s.trim()))); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
  kids.forEach(k => e.appendChild(k));
  return e;
}
function match(n, s) {
  const m = s.match(/^([a-z]*)(#[\w-]+)?((?:\.[\w-]+)*)(\[([\w-]+)\])?$/);
  if (!m) throw new Error('stub selector ' + s);
  if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
  if (m[2] && n.attrs.id !== m[2].slice(1)) return false;
  const cls = (n.attrs.class || '').split(/\s+/);
  if (m[3] && !m[3].split('.').filter(Boolean).every(c => cls.includes(c))) return false;
  if (m[5] && !(m[5] in n.attrs)) return false;
  return true;
}
const doc = { createElement: t => el(t) };
const PocketNav = require(path.join(ROOT, 'shared', 'nav.js'));

ok(PocketNav.sportFor('/') === 'nfl', '/ → nfl');
ok(PocketNav.sportFor('/nfl') === 'nfl', '/nfl → nfl');
ok(PocketNav.sportFor('/draft') === 'nfl', '/draft → nfl');
ok(PocketNav.sportFor('/nba') === 'nba', '/nba → nba');
ok(PocketNav.sportFor('/nba/') === 'nba', '/nba/ → nba');
ok(PocketNav.sportFor('/nba/lineup') === 'nba', '/nba/lineup → nba');
ok(PocketNav.sportFor('/NBA') === 'nba', '/NBA → nba');
ok(PocketNav.sportFor('/nbamock') === 'nfl', '/nbamock → nfl (prefix only)');
ok(PocketNav.sportFor('/research/nba') === 'nfl', '/research/nba → nfl');

function nflNav() {
  return el('nav', { id: 'rr-nav' }, [
    el('a', { href: '/', class: 'rr-logo' }),
    el('div', { class: 'rr-links' }, [el('a', { href: '/draft', class: 'rr-link' }), el('a', { href: '/trade', class: 'rr-link' })]),
    el('div', { class: 'rr-auth' }),
    el('button', { class: 'nav-hamburger' }),
  ]);
}
const active = n => n.querySelector('a.rr-sport-opt.active');

let nav = nflNav();
PocketNav.enhance(nav, '/', doc);
let bar = nav.children[1];
ok(bar.className === 'rr-sport', 'NFL page: pill inserted right after the logo');
ok(active(bar) && active(bar).getAttribute('data-sport') === 'nfl', 'NFL page: NFL active on bar');
ok(active(bar).getAttribute('aria-current') === 'page', 'active option has aria-current');
ok(bar.querySelector('a.rr-sport-opt[data-umami-event]'), 'switch options carry data-umami-event');
ok(nav.querySelectorAll('a.rr-link').map(a => a.getAttribute('href')).join() === '/draft,/trade', 'NFL page: links untouched');
let menu = nav.querySelector('.rr-sport-menu');
ok(menu && active(menu).getAttribute('data-sport') === 'nfl', 'NFL page: menu copy present with NFL active');
ok(nav.getAttribute('data-sport') === 'nfl', 'data-sport=nfl on nav');
PocketNav.enhance(nav, '/', doc);
ok(nav.querySelectorAll('.rr-sport-menu').length === 1 && nav.querySelectorAll('.rr-sport').length === 2, 'enhance is idempotent');

nav = nflNav();
PocketNav.enhance(nav, '/nba/lineup', doc);
ok(active(nav.children[1]).getAttribute('data-sport') === 'nba', 'NBA page with NFL markup: NBA active');
const links = nav.querySelectorAll('a.rr-link');
ok(links.map(a => a.getAttribute('href')).join() === '/nba,/nba/lineup,/nba/trade,/nba/team,/nba/waivers', 'NBA page: links rewritten to the NBA set');
ok(links[1].getAttribute('aria-current') === 'page' && !links[0].getAttribute('aria-current'), 'NBA page: Lineup marked current');
ok(nav.querySelector('a.rr-logo').getAttribute('href') === '/nba', 'NBA page: logo points to /nba');
ok(!/Research|Movers/.test(nav.textContent) && !links.some(a => /^\/(trade|lineup|research|team|trending|draft)$/.test(a.getAttribute('href'))), 'NBA page: no NFL link labels or NFL paths (NBA Trade is /nba/trade)');

// Real NBA page markup: static #rr-sport-switch + /nba links → keep both, add menu copy only.
nav = el('nav', { id: 'rr-nav' }, [
  el('a', { href: '/nba', class: 'rr-logo' }),
  el('div', { id: 'rr-sport-switch', class: 'sport-switch' }),
  el('div', { class: 'rr-links' }, [el('a', { href: '/nba/draft', class: 'rr-link active' }), el('a', { href: '/nba/lineup', class: 'rr-link' })]),
  el('button', { class: 'nav-hamburger' }),
]);
PocketNav.enhance(nav, '/nba', doc);
ok(nav.querySelectorAll('.rr-sport').length === 1 && nav.querySelector('.rr-sport-menu').querySelector('.rr-sport'), 'static switch kept; only the menu copy added');
ok(nav.querySelectorAll('a.rr-link').map(a => a.getAttribute('href')).join() === '/nba/draft,/nba/lineup', 'existing NBA links kept');
ok(active(nav.querySelector('.rr-sport-menu')).getAttribute('data-sport') === 'nba', 'menu copy: NBA active');

// No hamburger (index.html draft tool may hide it): no menu copy.
nav = el('nav', { id: 'rr-nav' }, [el('a', { href: '/', class: 'rr-logo' })]);
PocketNav.enhance(nav, '/', doc);
ok(!nav.querySelector('.rr-sport-menu') && nav.querySelector('.rr-sport'), 'no hamburger → bar pill only');
ok(/a\.rr-sport-opt/.test(fs.readFileSync(path.join(ROOT, 'shared', 'nav.js'), 'utf8')), 'menu closes on sport tap');

// ---------- 4. CSS ----------
const css = fs.readFileSync(path.join(ROOT, 'shared', 'styles.css'), 'utf8');
function braceCheck(src) {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  let d = 0;
  for (const ch of s) { if (ch === '{') d++; else if (ch === '}') { d--; if (d < 0) return false; } }
  return d === 0 && !/\/\*/.test(s);
}
ok(braceCheck(css), 'shared/styles.css braces balanced, comments closed');
const homeCss = (home.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
ok(braceCheck(homeCss), 'home.html <style> braces balanced');
const theme = (css.match(/\/\* === NBA theme === [\s\S]*\/\* === end NBA theme === \*\//) || [''])[0];
ok(theme.length > 2000, 'delimited NBA theme section present');
ok(base === null || css.startsWith(execSync('git show nba:shared/styles.css', { cwd: ROOT }).toString().trimEnd()), 'styles.css change is append-only');
const tok = {};
for (const m of theme.matchAll(/(--nba-[\w-]+):\s*(#[0-9a-f]{6})/gi)) tok[m[1]] = m[2];
for (const t of ['--nba-300', '--nba-400', '--nba-500', '--nba-600', '--nba-ink']) ok(tok[t], `token ${t} defined`);
ok(/\.sport-nba\s*\{[^}]*--accent:\s*var\(--nba-400\)/.test(theme), '.sport-nba remaps --accent');
for (const k of ['--nba-glow', '--nba-ring', '--nba-line', '--nba-border']) ok(theme.includes(k + ':'), `token ${k} defined`);
ok(/prefers-reduced-motion/.test(theme), 'theme respects reduced motion');

function lum(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
const pairs = [
  ['--nba-400 on #111111', tok['--nba-400'], '#111111'],
  ['--nba-400 on #0a0a0a', tok['--nba-400'], '#0a0a0a'],
  ['--nba-300 on #111111', tok['--nba-300'], '#111111'],
  ['--nba-400 on surface-2 #1a110b', tok['--nba-400'], '#1a110b'],
  ['ink on --nba-500', tok['--nba-ink'], tok['--nba-500']],
  ['ink on --nba-400', tok['--nba-ink'], tok['--nba-400']],
  ['ink on --nba-300 (hover)', tok['--nba-ink'], tok['--nba-300']],
  ['ink on --nba-600 (active)', tok['--nba-ink'], tok['--nba-600']],
];
for (const [name, a, b] of pairs) {
  const r = contrast(a, b);
  console.log(`  contrast ${name}: ${r.toFixed(2)}:1`);
  ok(r >= 4.5, `contrast ${name} >= 4.5 (got ${r.toFixed(2)})`);
}
ok(contrast('#ffffff', tok['--nba-500']) < 4.5, 'sanity: white on orange fails (why buttons use ink)');

console.log(`${fails ? 'FAIL' : 'ok'} test-nba-home: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
