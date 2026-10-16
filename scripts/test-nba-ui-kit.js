// Plain node, no deps: node scripts/test-nba-ui-kit.js (exit 0 = pass).
// NBA design system (nba/pages/nba-ui.css + nba-ui.js, docs/nba-design-system.md):
//   1. CSS parses: balanced braces, no stray text.
//   2. Scope: every selector starts with .nba-ui / .sport-nba (or body./html.
//      carrying one), so the kit can never restyle an NFL page.
//   3. Contrast (WCAG 2.x) for the token pairs the doc allows: text >= 4.5:1,
//      UI strokes >= 3:1. Tokens are read from the CSS so the test tracks edits.
//   4. Helpers: escaping, avatar source chain + initials fallback, pills,
//      formatters, sparkline/histogram math (no NaN), nav markup.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'nba/pages/nba-ui.css'), 'utf8');
const UI = require('../nba/pages/nba-ui.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log('FAIL ' + name + ': ' + (e && e.message)); }
}

// ---- 1. CSS structure --------------------------------------------------------
const src = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
// strip strings / url() so braces inside data URIs don't count
const bare = src.replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, 'url()').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');

t('css braces balanced', () => {
  let depth = 0, min = 0;
  for (const ch of bare) { if (ch === '{') depth++; else if (ch === '}') { depth--; min = Math.min(min, depth); } }
  assert.strictEqual(depth, 0, 'unbalanced depth ' + depth);
  assert.strictEqual(min, 0, 'closing brace before opening');
});

// Walk rules: returns [{ selector, body, atrule }] for style rules.
function rules(text) {
  const out = []; let i = 0;
  function block(end) {
    while (i < text.length) {
      const open = text.indexOf('{', i), close = text.indexOf('}', i);
      if (close !== -1 && (open === -1 || close < open)) {
        const tail = text.slice(i, close).trim();
        if (tail && !/;\s*$/.test(tail) && !/^[^{]*:[^{]*$/.test(tail)) throw new Error('stray text before }: ' + tail.slice(0, 60));
        i = close + 1; if (end) return; continue;
      }
      if (open === -1) { const rest = text.slice(i).trim(); if (rest) throw new Error('trailing text: ' + rest.slice(0, 60)); i = text.length; return; }
      const head = text.slice(i, open).trim();
      i = open + 1;
      if (/^@(media|supports|layer|container)\b/.test(head)) { block(true); continue; }
      if (/^@(-webkit-)?keyframes\b|^@font-face\b|^@page\b/.test(head)) {
        let d = 1; while (d && i < text.length) { if (text[i] === '{') d++; else if (text[i] === '}') d--; i++; }
        continue;
      }
      const bodyEnd = text.indexOf('}', i);
      out.push({ selector: head, body: text.slice(i, bodyEnd) });
      i = bodyEnd + 1;
    }
  }
  block(false);
  return out;
}
let RULES = [];
t('css parses into rules', () => { RULES = rules(bare); assert.ok(RULES.length > 150, 'only ' + RULES.length + ' rules'); });

function splitSelectors(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
t('every selector scoped to .nba-ui / .sport-nba', () => {
  const bad = [];
  for (const r of RULES) for (const sel of splitSelectors(r.selector)) {
    const first = sel.split(/\s+|>|\+|~/)[0];
    if (!/^(html|body)?(\.[\w-]+)*\.(nba-ui|sport-nba)(\.[\w-]+|\[[^\]]+\]|:[\w-]+(\([^)]*\))?)*$/.test(first)) bad.push(sel);
  }
  assert.deepStrictEqual(bad, []);
});
t('no !important outside reduced-motion / [hidden] / .nu-sr', () => {
  const bad = RULES.filter(r => /!important/.test(r.body) && !/\[hidden\]|nu-sr|\*/.test(r.selector)).map(r => r.selector);
  assert.deepStrictEqual(bad, []);
});
t('tokens declared on .nba-ui (self-contained, no :root)', () => {
  assert.ok(!/:root/.test(src), ':root found');
  const tok = RULES.find(r => r.selector === '.nba-ui');
  assert.ok(tok && /--nba-400:/.test(tok.body) && /--nu-bg:/.test(tok.body));
});
t('every var(--x) used is declared (or has a fallback, or is env-provided)', () => {
  const declared = new Set((src.match(/--[\w-]+(?=\s*:)/g) || []));
  const missing = new Set();
  const re = /var\((--[\w-]+)\s*(,)?/g; let m;
  while ((m = re.exec(src))) if (!declared.has(m[1]) && !m[2] && !/^--(i|sz|c|bg|team)$/.test(m[1])) missing.add(m[1]);
  assert.deepStrictEqual([...missing], []);
});

// ---- 3. contrast ---------------------------------------------------------------
const tokBody = (RULES.find(r => r.selector === '.nba-ui') || { body: '' }).body;
const TOK = {};
tokBody.replace(/(--[\w-]+)\s*:\s*([^;]+);/g, (_, k, v) => { TOK[k] = v.trim(); });
function resolve(v, depth) {
  depth = depth || 0;
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  return m && depth < 8 ? resolve(TOK[m[1]], depth + 1) : v;
}
function parseColor(v) {
  v = resolve(String(v).trim());
  let m;
  if ((m = /^#([0-9a-f]{6})$/i.exec(v))) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4), 16), 1];
  if ((m = /^#([0-9a-f]{3})$/i.exec(v))) return m[1].split('').map(c => parseInt(c + c, 16)).concat(1);
  if ((m = /^rgba?\(([^)]+)\)$/.exec(v))) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
  throw new Error('cannot parse colour ' + v);
}
function over(fg, bg) { const a = fg[3]; return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1); }
function lum(c) { const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
function ratio(fgV, bgV, baseV) {
  const base = parseColor(baseV || TOK['--nu-bg']);
  const bg = over(parseColor(bgV), base), fg = over(parseColor(fgV), bg);
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function mix(colorV, pct, baseV) { // color-mix(in srgb, color pct%, transparent) over base
  const c = parseColor(colorV), b = parseColor(baseV);
  return 'rgb(' + [0, 1, 2].map(i => Math.round(c[i] * pct + b[i] * (1 - pct))).join(',') + ')';
}
const SURF = ['--nu-bg', '--nu-s1', '--nu-s2', '--nu-s3'].map(k => [k, TOK[k]]);
const TEXT = ['--nu-text', '--nu-text-2', '--nu-text-3', '--nba-300', '--nba-400', '--nu-good', '--nu-bad', '--nu-warn', '--nu-info', '--nu-pos-g', '--nu-pos-f', '--nu-pos-c', '--nu-pos-u'];
const contrastRows = [];
for (const fk of TEXT) for (const [sk, sv] of SURF) {
  t(`text ${fk} on ${sk} >= 4.5`, () => { const r = ratio(TOK[fk], sv); contrastRows.push([fk, sk, r]); assert.ok(r >= 4.5, r.toFixed(2)); });
}
const PAIRS = [
  // [fg, bg, min, what]
  ['--nu-accent-ink', '--nba-400', 4.5, 'primary button label / T1 tier / active sport'],
  ['--nu-accent-ink', '--nba-500', 4.5, 'primary button pressed'],
  ['--nu-accent-ink', '--nba-300', 4.5, 'primary button hover'],
  ['--nu-text', '--nu-accent-soft', 4.5, 'selected chip / row (over s1)', '--nu-s1'],
  ['--nba-300', '--nu-accent-soft', 4.5, 'T2 tier text (over s1)', '--nu-s1'],
  ['--nu-good', '--nu-good-soft', 4.5, 'value badge (over s1)', '--nu-s1'],
  ['--nu-bad', '--nu-bad-soft', 4.5, 'reach badge (over s1)', '--nu-s1'],
  ['#fecaca', '--nu-bad-soft', 4.5, 'injury out (over s1)', '--nu-s1'],
  ['#fde68a', '--nu-warn-soft', 4.5, 'injury dtd (over s1)', '--nu-s1'],
  ['#e7c39b', 'rgba(200,145,90,0.14)', 4.5, 'T3 tier (over s1)', '--nu-s1'],
  ['#ddd6fe', 'rgba(124,58,237,0.16)', 4.5, 'Yahoo button (over bg)'],
  ['--nu-text-2', 'rgba(255,255,255,0.06)', 4.5, 'neutral tag / tier 4+ (over s1)', '--nu-s1'],
  ['--nu-text', 'rgba(28,32,38,0.94)', 4.5, 'toast'],
  ['--nba-400', '--nu-bg', 3, 'focus ring vs page (UI)'],
  ['--nba-400', '--nu-s2', 3, 'focus ring vs raised (UI)'],
  ['--nba-400', '--nu-s3', 3, 'focus ring vs sheet (UI)'],
];
for (const [fg, bg, min, what, base] of PAIRS) {
  t(`contrast ${what} >= ${min}`, () => {
    const r = ratio(TOK[fg] || fg, TOK[bg] || bg, base ? TOK[base] : undefined);
    contrastRows.push([fg, bg + (base ? ' on ' + base : ''), r]);
    assert.ok(r >= min, r.toFixed(2));
  });
}
// position pills: text colour on its own 14% tint over s1 and s2
for (const k of ['--nu-pos-g', '--nu-pos-f', '--nu-pos-c', '--nu-pos-u']) for (const s of ['--nu-s1', '--nu-s2']) {
  t(`pos pill ${k} on 14% tint over ${s} >= 4.5`, () => {
    const bg = mix(TOK[k], 0.14, TOK[s]);
    const r = ratio(TOK[k], bg, TOK[s]); contrastRows.push([k, '14% tint/' + s, r]);
    assert.ok(r >= 4.5, r.toFixed(2));
  });
}

// ---- 4. helpers ------------------------------------------------------------------
t('esc escapes all five', () => assert.strictEqual(UI.esc(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;'));
t('esc null/undefined -> empty', () => { assert.strictEqual(UI.esc(null), ''); assert.strictEqual(UI.esc(undefined), ''); });

t('fmt.score', () => {
  assert.strictEqual(UI.fmt.score(62.94), '62.9');
  assert.strictEqual(UI.fmt.score(0), '0.0');
  assert.strictEqual(UI.fmt.score(NaN), '\u2014');
  assert.strictEqual(UI.fmt.score(null), '\u2014');
  assert.strictEqual(UI.fmt.score(Infinity), '\u2014');
  assert.strictEqual(UI.fmt.score(3.14159, 2), '3.14');
});
t('fmt.rank / ordinal / pct / signed', () => {
  assert.strictEqual(UI.fmt.rank(3), '#3');
  assert.strictEqual(UI.fmt.rank(0), '\u2014');
  assert.deepStrictEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(UI.fmt.ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  assert.strictEqual(UI.fmt.pct(0.634), '63%');
  assert.strictEqual(UI.fmt.signed(2.34), '+2.3');
  assert.strictEqual(UI.fmt.signed(-0.01), '0.0');
  assert.strictEqual(UI.fmt.signed(-1.25), '-1.3');
});
t('fmt.delta up/down/flat/none', () => {
  assert.deepStrictEqual(UI.fmt.delta(2.34), { text: '\u25B2 2.3', dir: 'up', cls: 'is-up' });
  assert.deepStrictEqual(UI.fmt.delta(-1.05), { text: '\u25BC 1.1', dir: 'down', cls: 'is-down' });
  assert.strictEqual(UI.fmt.delta(0.01).dir, 'flat');
  assert.strictEqual(UI.fmt.delta(undefined).dir, 'none');
  assert.ok(/is-up/.test(UI.delta(1)) && /aria-label="up 1.0"/.test(UI.delta(1)));
});
t('fmt.initials', () => {
  assert.strictEqual(UI.fmt.initials('Nikola Jokić'), 'NJ');
  assert.strictEqual(UI.fmt.initials('Shai Gilgeous-Alexander'), 'SG');
  assert.strictEqual(UI.fmt.initials('Vince Williams Jr.'), 'VW');
  assert.strictEqual(UI.fmt.initials('Nenê'), 'N');
  assert.strictEqual(UI.fmt.initials(''), '?');
});

const JOKIC = { id: '1658', name: 'Nikola Jokić', team: 'DEN', pos: ['C'] };
t('avatar: sleeper player -> thumb img, lazy+async, initials underneath, team tint', () => {
  const h = UI.avatar(JOKIC, { size: 'md' });
  assert.ok(/<img src="https:\/\/sleepercdn\.com\/content\/nba\/players\/thumb\/1658\.jpg"/.test(h), h);
  assert.ok(/loading="lazy"/.test(h) && /decoding="async"/.test(h));
  assert.ok(/alt=""/.test(h) && /role="img" aria-label="Nikola Jokić"/.test(h));
  assert.ok(/<span aria-hidden="true">NJ<\/span>/.test(h));
  assert.ok(/--team:#0e2240/.test(h));
  assert.ok(/nu-avatar--md/.test(h) && /width="40" height="40"/.test(h));
});
t('avatar: xl uses the full-size Sleeper image', () => {
  assert.ok(/players\/1658\.jpg/.test(UI.avatar(JOKIC, { size: 'xl' })));
});
t('avatar: chain sleeper -> espn -> yahoo in data-srcs', () => {
  const srcs = UI.headshotSrcs({ id: '1658', espnId: '3112335', headshot: 'https://s.yimg.com/x/5352.png' }, { size: 'md' });
  assert.strictEqual(srcs.length, 3);
  assert.ok(/sleepercdn/.test(srcs[0]) && /espncdn.*3112335\.png&w=\d+&h=\d+/.test(srcs[1]) && /yimg/.test(srcs[2]));
  const h = UI.avatar({ id: '1658', espnId: '3112335', name: 'N J' });
  assert.ok(/data-srcs="https:\/\/sleepercdn[^"]+\|https:\/\/a\.espncdn[^"]+"/.test(h), h);
});
t('avatar: Yahoo-only id (y4390) skips Sleeper; espnId used first', () => {
  const srcs = UI.headshotSrcs({ id: 'y4390', espnId: '3468', name: 'Russell Westbrook' });
  assert.strictEqual(srcs.length, 1); assert.ok(/espncdn/.test(srcs[0]));
  assert.ok(/data-src-kind="espn"/.test(UI.avatar({ id: 'y4390', espnId: '3468', name: 'Russell Westbrook' })));
});
t('avatar: no sources -> initials only, no <img>', () => {
  const h = UI.avatar({ id: 'y4390', name: 'Russell Westbrook', team: 'SAC' });
  assert.ok(!/<img/.test(h)); assert.ok(/>RW</.test(h));
  assert.ok(!/<img/.test(UI.avatar(JOKIC, { noImage: true })));
  assert.ok(/>\?</.test(UI.avatar(null)));
});
t('avatar: rejects non-https headshot + non-numeric espnId; escapes name', () => {
  const srcs = UI.headshotSrcs({ id: 'y1', espnId: '12"x', headshot: 'javascript:alert(1)' });
  assert.deepStrictEqual(srcs, []);
  const h = UI.avatar({ name: '<img onerror=x>' });
  assert.ok(!/<img onerror/.test(h) && /&lt;img onerror=x&gt;/.test(h));
});
t('avatar: teamBadge + injuryDot wrapper', () => {
  const h = UI.avatar(Object.assign({ injury: 'DTD' }, JOKIC), { teamBadge: true, injuryDot: true });
  assert.ok(/nu-avatar-wrap/.test(h) && /nu-team-logo/.test(h) && /nu-inj-dot" data-status="dtd"/.test(h));
});
t('teamLogo: sleeper then espn with NOP/UTA slugs; unknown -> text only', () => {
  assert.deepStrictEqual(UI.teamLogoSrcs('NOP'), ['https://sleepercdn.com/images/team_logos/nba/nop.png', 'https://a.espncdn.com/i/teamlogos/nba/500/no.png']);
  assert.ok(/500\/utah\.png/.test(UI.teamLogoSrcs('uta')[1]));
  assert.strictEqual(Object.keys(UI.TEAM_COLORS).length, 30);
  const h = UI.teamLogo('XYZ'); assert.ok(!/<img/.test(h) && />XYZ</.test(h));
  assert.ok(/aria-label="Free agent"/.test(UI.teamLogo(null)));
});
t('posPill / tierBadge / injuryBadge / valueBadge', () => {
  assert.strictEqual(UI.posPill('PG'), '<span class="nu-pos" data-pos="PG">PG</span>');
  assert.ok(/nu-pos-group/.test(UI.posPill(['PG', 'SG'])));
  assert.ok(/>UTL</.test(UI.posPill('UTIL')));
  assert.strictEqual(UI.posPill([]), '');
  assert.ok(/data-tier="1"[^>]*>T1</.test(UI.tierBadge(1)));
  assert.strictEqual(UI.tierBadge(null), '');
  const map = { DTD: 'dtd', GTD: 'gtd', Out: 'out', OUT: 'out', Q: 'q', IR: 'out' };
  for (const k in map) assert.strictEqual(UI.injuryKey(k), map[k], k);
  assert.strictEqual(UI.injuryBadge(null), '');
  assert.ok(/>IR</.test(UI.injuryBadge('IR')));
  assert.ok(/>OFS</.test(UI.injuryBadge(null, { outForSeason: true })));
  assert.ok(/data-label="value" data-strong="true">Value/.test(UI.valueBadge('value', true)));
  assert.strictEqual(UI.valueBadge(null), '');
});
t('statTile / rangeBand / meter', () => {
  const s = UI.statTile({ label: 'Value', value: 75, delta: 2.3, sub: 'vs ADP', tone: 'accent' });
  assert.ok(/nu-stat--accent/.test(s) && />75\.0</.test(s) && /is-up/.test(s) && /vs ADP/.test(s));
  assert.ok(/>\u2014</.test(UI.statTile({ label: 'X', value: NaN })));
  assert.ok(/>C1</.test(UI.statTile({ label: 'Pos rank', value: 'C1' })));
  const r = UI.rangeBand({ min: 0, max: 100, lo: 39.3, hi: 84.8, mark: 62.9, labels: ['39', '85'] });
  assert.ok(/left:39\.30%/.test(r) && /left:62\.90%/.test(r) && !/NaN/.test(r));
  assert.strictEqual(UI.rangeBand({ min: 5, max: 5 }), '');
  assert.ok(/width:100\.0%/.test(UI.meter(1.7)) && /width:0\.0%/.test(UI.meter(NaN)));
});
t('sparkPoints math', () => {
  assert.deepStrictEqual(UI.sparkPoints([0, 10], 100, 20, 0), [[0, 20], [100, 0]]);
  assert.deepStrictEqual(UI.sparkPoints([5, 5, 5], 100, 20, 0).map(p => p[1]), [10, 10, 10]);
  assert.deepStrictEqual(UI.sparkPoints([7], 100, 20, 0), [[50, 10]]);
  assert.deepStrictEqual(UI.sparkPoints([], 100, 20), []);
  assert.strictEqual(UI.sparkPoints([1, NaN, null, 3, undefined, Infinity], 10, 10, 0).length, 2);
});
t('sparkline svg: no NaN, empty state, tone', () => {
  const hs = { 1: 66.4, 2: 73.1, 3: 73.4, 4: 73.4, 5: 76.1 };
  const s = UI.sparkline(Object.values(hs), { tone: 'good', label: 'Weekly value' });
  assert.ok(/^<svg class="nu-spark nu-spark--good"/.test(s) && /<path class="nu-spark__line" d="M/.test(s) && !/NaN|undefined|Infinity/.test(s));
  assert.ok(/no data/.test(UI.sparkline([])));
  assert.ok(!/NaN/.test(UI.sparkline([3])) && !/NaN/.test(UI.sparkline([2, 2, 2])));
});
t('binCounts math', () => {
  const r = UI.binCounts([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  assert.deepStrictEqual(r.counts, [2, 2, 2, 2, 3]); // max lands in last bin
  assert.strictEqual(r.counts.reduce((a, b) => a + b, 0), 11);
  assert.deepStrictEqual(r.edges, [0, 2, 4, 6, 8, 10]);
  assert.deepStrictEqual(UI.binCounts([5, 5, 5], 3).counts, [3, 0, 0]);
  assert.deepStrictEqual(UI.binCounts([], 4).counts, [0, 0, 0, 0]);
  assert.deepStrictEqual(UI.binCounts([-5, 1, 50], 2, [0, 10]).counts, [1, 0]); // out of range dropped
  assert.strictEqual(UI.binCounts([1, NaN, 2], 2).counts.reduce((a, b) => a + b, 0), 2);
});
t('histogram svg: bars = bins, no NaN, mark + highlight', () => {
  const vals = []; for (let i = 0; i < 2000; i++) vals.push(40 + 30 * Math.sin(i) * Math.cos(i / 7));
  const h = UI.histogram(vals, { bins: 20, mark: 62.9, highlightFrom: 55 });
  assert.strictEqual((h.match(/<rect /g) || []).length, 20);
  assert.ok(/nu-hist__mark/.test(h) && /is-hi/.test(h) && !/NaN|undefined|Infinity/.test(h));
  assert.ok(!/NaN/.test(UI.histogram([])) && !/NaN/.test(UI.histogram([3, 3])));
});
t('playerCell / pageHeader / skeleton / emptyState / callout escape + structure', () => {
  const c = UI.playerCell(Object.assign({ injury: 'Out' }, JOKIC));
  assert.ok(/nu-player__name">Nikola Jokić</.test(c) && /data-pos="C"/.test(c) && />DEN</.test(c) && /nu-inj/.test(c));
  assert.ok(/<a class="nu-player__name" href="\/nba\/research\?p=1658"/.test(UI.playerCell(JOKIC, { href: '/nba/research?p=1658' })));
  const ph = UI.pageHeader({ eyebrow: 'League', title: 'Week <1>', sub: 's', actions: '<button>x</button>' });
  assert.ok(/nu-page-head--court/.test(ph) && /Week &lt;1&gt;/.test(ph) && /<button>x<\/button>/.test(ph));
  assert.ok(!/--court/.test(UI.pageHeader({ title: 'x', court: false })));
  assert.strictEqual((UI.skeleton(4).match(/nu-skel-row"/g) || []).length, 4);
  assert.strictEqual(UI.skeleton(0), '');
  assert.ok(/nu-stat/.test(UI.skeleton(2, { kind: 'tile' })) && /nu-card/.test(UI.skeleton(1, { kind: 'card' })));
  assert.ok(/aria-hidden="true"/.test(UI.skeleton(1)));
  assert.ok(/nu-empty__title">No &lt;players&gt;/.test(UI.emptyState({ title: 'No <players>' })));
  assert.ok(/role="alert"/.test(UI.callout('error', 'x')) && /role="status"/.test(UI.callout('info', 'x')));
});
t('nav markup keeps shared/nav.js contract', () => {
  const n = UI.navHtml({ active: 'lineup' });
  assert.ok(/<nav id="rr-nav"/.test(n.nav) && /class="rr-logo"/.test(n.nav) && /class="rr-links"/.test(n.nav) && /class="nav-hamburger"/.test(n.nav));
  assert.ok(/class="rr-sport"/.test(n.nav) && /data-umami-event="nba-nav-switch"/.test(n.nav) && /data-umami-event="nfl-nav-switch"/.test(n.nav));
  assert.strictEqual((n.nav.match(/class="rr-link[ "]/g) || []).length, 6);
  assert.strictEqual((n.nav.match(/aria-current="page"/g) || []).length, 2); // NBA switch + Lineup
  assert.ok(/href="\/nba\/lineup" class="rr-link active"/.test(n.nav));
  assert.strictEqual((n.tabbar.match(/<a /g) || []).length, 6);
  assert.ok(/data-nba-sleeper-chip/.test(n.nav));
  // shared/nav.js treats every link as NBA (no NFL link-set swap)
  const PN = require('../shared/nav.js');
  assert.strictEqual(PN.sportFor('/nba/research'), 'nba');
});
t('activeFromPath', () => {
  assert.strictEqual(UI.activeFromPath('/nba'), 'board');
  assert.strictEqual(UI.activeFromPath('/nba/draft/'), 'board');
  assert.strictEqual(UI.activeFromPath('/nba/research'), 'research');
  assert.strictEqual(UI.activeFromPath('/nba/waivers'), 'waivers');
  assert.strictEqual(UI.activeFromPath('/nba/team'), 'team');
  assert.strictEqual(UI.activeFromPath('/lineup'), null);
});
t('browser-only helpers are inert in node', () => {
  assert.strictEqual(UI.mountNav({ active: 'board' }), null);
  assert.strictEqual(UI.toast('x'), null);
  UI.sheet.open('x'); assert.strictEqual(UI.sheet.isOpen(), false);
});
t('doc lists every exported helper', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/nba-design-system.md'), 'utf8');
  const missing = Object.keys(UI).filter(k => typeof UI[k] === 'function' && !new RegExp('\\b' + k + '\\b').test(doc));
  assert.deepStrictEqual(missing, []);
});
t('doc documents every .nu- class used in the CSS', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/nba-design-system.md'), 'utf8') + fs.readFileSync(path.join(ROOT, 'nba/pages/nba-ui.js'), 'utf8');
  const classes = new Set((src.match(/\.nu-[\w-]+/g) || []).map(c => c.slice(1)));
  const missing = [...classes].filter(c => !doc.includes(c) && !doc.includes(c.replace(/--[\w-]+$/, '')) && !doc.includes(c.replace(/__[\w-]+$/, '')));
  assert.deepStrictEqual(missing, []);
});

if (process.argv.includes('--table')) for (const [a, b, r] of contrastRows) console.log(`${a.padEnd(18)} on ${b.padEnd(28)} ${r.toFixed(2)}`);
console.log(`nba-ui kit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
