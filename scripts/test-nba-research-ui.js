// Plain node, no deps: node scripts/test-nba-research-ui.js (exit 0 = pass).
// NBA research page logic (nba/pages/research-logic.js) + static page checks.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const L = require('../nba/pages/research-logic.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message)); }
}
function noNaN(s, label) { assert.ok(!/NaN|undefined|Infinity/.test(String(s)), (label || 'value') + ' has NaN/undefined: ' + s); }

// ---- URL state ---------------------------------------------------------------
test('parseState defaults', () => {
  const s = L.parseState('');
  assert.deepStrictEqual(s, { q: '', pos: [], team: '', inj: '', src: '', sort: 'hsValue', dir: 'desc', page: 1, player: '' });
});
test('parseState reads every key and sanitises', () => {
  const s = L.parseState('?q=%20jokic%20&pos=c,pf,PF,XX&team=den&inj=dtd&src=yahoo-only&sort=ceiling&dir=asc&page=3&player=1658');
  assert.strictEqual(s.q, 'jokic');
  assert.deepStrictEqual(s.pos, ['PF', 'C']);
  assert.strictEqual(s.team, 'DEN');
  assert.strictEqual(s.inj, 'dtd');
  assert.strictEqual(s.src, 'yahoo-only');
  assert.strictEqual(s.sort, 'ceiling');
  assert.strictEqual(s.dir, 'asc');
  assert.strictEqual(s.page, 3);
  assert.strictEqual(s.player, '1658');
});
test('parseState drops junk', () => {
  const s = L.parseState('?sort=bogus&dir=up&page=-4&player=../etc&inj=dead&src=x&team=<b>&q=' + 'a'.repeat(200));
  assert.strictEqual(s.sort, 'hsValue');
  assert.strictEqual(s.dir, 'desc');
  assert.strictEqual(s.page, 1);
  assert.strictEqual(s.player, '');
  assert.strictEqual(s.inj, '');
  assert.strictEqual(s.src, '');
  assert.strictEqual(s.team, '');
  assert.strictEqual(s.q.length, 64);
});
test('parseState: Yahoo-only player ids', () => {
  assert.strictEqual(L.parseState('?player=y4390').player, 'y4390');
  assert.strictEqual(L.parseState('?player=y').player, '');
});
test('rank-like sort defaults to ascending', () => {
  assert.strictEqual(L.parseState('?sort=marketRank').dir, 'asc');
  assert.strictEqual(L.parseState('?sort=last5Delta').dir, 'desc');
});
test('serializeState omits defaults and round-trips', () => {
  assert.strictEqual(L.serializeState(L.parseState('')), '');
  const qs = '?q=jok%C4%87&pos=PG,C&team=DEN&inj=out&src=rookie&sort=ceiling&dir=asc&page=2&player=1658';
  const s = L.parseState(qs);
  assert.strictEqual(L.serializeState(s), qs);
  assert.deepStrictEqual(L.parseState(L.serializeState(s)), s);
  assert.strictEqual(L.serializeState(Object.assign(L.parseState(''), { sort: 'marketRank', dir: 'asc' })), '?sort=marketRank');
});

// ---- API query building ----------------------------------------------------------
test('tableQuery default', () => {
  assert.strictEqual(L.tableQuery(L.parseState('')), '/api/nba/research?sort=hsValue&dir=desc&limit=50&offset=0');
});
test('tableQuery maps pos chips to Yahoo slot eligibility, paging, filters', () => {
  const q = L.tableQuery(L.parseState('?q=jokić&pos=C,UTIL&team=DEN&inj=healthy&src=yahoo-only&sort=ceiling&page=3'));
  assert.ok(q.startsWith('/api/nba/research?'));
  const p = new URLSearchParams(q.split('?')[1]);
  assert.strictEqual(p.get('slot'), 'C', 'UTIL is everyone: not sent');
  assert.strictEqual(p.get('q'), 'jokić');
  assert.strictEqual(p.get('team'), 'DEN');
  assert.strictEqual(p.get('inj'), 'healthy');
  assert.strictEqual(p.get('source'), 'yahoo-only');
  assert.strictEqual(p.get('sort'), 'ceiling');
  assert.strictEqual(p.get('dir'), 'desc');
  assert.strictEqual(p.get('offset'), '100');
  assert.strictEqual(p.get('limit'), '50');
});
test('every SORTS key is a server sort key', () => {
  const server = ['hsValue', 'rank', 'tier', 'name', 'team', 'pos', 'age', 'exp', 'posRank', 'vorp', 'hsThisWeek', 'gamesThisWeek', 'mean', 'sd', 'ceiling', 'floor', 'availability', 'gp', 'mpg', 'pts', 'reb', 'ast', 'stl', 'blk', 'to', 'pf', 'scoredPg', 'scoredSd', 'scoredP90', 'scoredP10', 'bestGameAvg', 'ddPct', 'tdPct', 'last5', 'last5Delta', 'last5Min', 'minDelta', 'marketRank', 'adpDelta', 'yahooPreRank', 'yahooPctRos', 'injury'];
  for (const s of L.SORTS) assert.ok(server.includes(s.key), s.key);
  for (const k of ['hsValue', 'mean', 'ceiling', 'floor', 'last5Delta', 'adpDelta', 'yahooPctRos', 'minDelta']) assert.ok(L.SORT_KEYS.includes(k), 'sort offered: ' + k);
});
test('nextSort flips same key, new key starts at its natural direction', () => {
  assert.deepStrictEqual(L.nextSort({ sort: 'hsValue', dir: 'desc' }, 'hsValue'), { sort: 'hsValue', dir: 'asc' });
  assert.deepStrictEqual(L.nextSort({ sort: 'hsValue', dir: 'desc' }, 'marketRank'), { sort: 'marketRank', dir: 'asc' });
  assert.deepStrictEqual(L.nextSort({ sort: 'hsValue', dir: 'desc' }, 'nope'), { sort: 'hsValue', dir: 'desc' });
});
test('togglePos + activeFilterCount + pageInfo', () => {
  assert.deepStrictEqual(L.togglePos([], 'C'), ['C']);
  assert.deepStrictEqual(L.togglePos(['C'], 'PG'), ['PG', 'C']);
  assert.deepStrictEqual(L.togglePos(['PG', 'C'], 'C'), ['PG']);
  assert.deepStrictEqual(L.togglePos(['PG'], 'ALL'), []);
  assert.strictEqual(L.activeFilterCount(L.parseState('?pos=C&team=DEN&q=x')), 2);
  assert.deepStrictEqual(L.pageInfo(771, 2), { page: 2, pages: 16, from: 51, to: 100, total: 771, hasPrev: true, hasNext: true });
  assert.deepStrictEqual(L.pageInfo(0, 5), { page: 1, pages: 1, from: 0, to: 0, total: 0, hasPrev: false, hasNext: false });
  assert.strictEqual(L.pageInfo(771, 99).page, 16);
  assert.strictEqual(L.pageInfo(NaN, NaN).page, 1);
});

// ---- formatting --------------------------------------------------------------------
test('dates', () => {
  assert.strictEqual(L.shortDate('2026-10-20'), 'Oct 20');
  assert.strictEqual(L.weekday('2026-10-22'), 'Thu');
  assert.strictEqual(L.dateRange('2026-10-20', '2026-10-25'), 'Oct 20–25');
  assert.strictEqual(L.dateRange('2026-11-30', '2026-12-13'), 'Nov 30–Dec 13', '14-day week 7 spans months');
  assert.strictEqual(L.shortDate(null), '—');
  assert.strictEqual(L.dateRange('x', '2026-01-01'), '—');
});
test('counts, signed, pct, form, height', () => {
  assert.strictEqual(L.count(6912), '6.9k');
  assert.strictEqual(L.count(1000), '1k');
  assert.strictEqual(L.count(776), '776');
  assert.strictEqual(L.count(12345), '12k');
  assert.strictEqual(L.count(null), '—');
  assert.strictEqual(L.signed(2.34), '+2.3');
  assert.strictEqual(L.signed(-0.04), '0.0');
  assert.strictEqual(L.signed(-19.4), '−19.4');
  assert.strictEqual(L.pct(0.846), '85%');
  assert.strictEqual(L.pct(NaN), '—');
  assert.strictEqual(L.form(16.1).dir, 'up');
  assert.strictEqual(L.form(-5.8).dir, 'down');
  assert.strictEqual(L.form(-0.7).dir, 'flat');
  assert.strictEqual(L.form(null).dir, 'none');
  assert.strictEqual(L.heightFt('6-11'), '6′11″');
  assert.strictEqual(L.heightFt(null), null);
});
test('timeAgo', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.strictEqual(L.timeAgo('2026-10-14T11:59:30Z', now), 'just now');
  assert.strictEqual(L.timeAgo('2026-10-14T11:15:00Z', now), '45m ago');
  assert.strictEqual(L.timeAgo('2026-10-14T03:00:00Z', now), '9h ago');
  assert.strictEqual(L.timeAgo('2026-10-12T04:10:24.000Z', now), '2d ago');
  assert.strictEqual(L.timeAgo('2026-01-02T00:00:00Z', now), 'Jan 2, 2026');
  assert.strictEqual(L.timeAgo('garbage', now), '');
  assert.strictEqual(L.timeAgo('2026-10-15T00:00:00Z', now), 'just now', 'future clamps');
});

// ---- probability chips -------------------------------------------------------------
test('probChips: sorted thresholds, tones, never NaN', () => {
  const c = L.probChips({ 70: 0.453, 40: 0.925, 50: 0.867, 60: 0.706 });
  assert.deepStrictEqual(c.map(x => x.t), [40, 50, 60, 70]);
  assert.deepStrictEqual(c.map(x => x.text), ['93%', '87%', '71%', '45%']);
  assert.deepStrictEqual(c.map(x => x.tone), ['good', 'good', 'good', 'mid']);
  const r = L.probChips({ 40: 0.66, 50: 0.228, 60: 0.033, 70: 0.002 });
  assert.deepStrictEqual(r.map(x => x.text), ['66%', '23%', '3%', '<1%']);
  assert.deepStrictEqual(r.map(x => x.tone), ['good', 'low', 'low', 'low']);
  const inj = L.probChips({ 40: 0, 50: 0, 60: 0, 70: 0 });
  assert.ok(inj.every(x => x.text === '0%'), 'injured: exact 0%');
  const bad = L.probChips({ 40: NaN, 50: null, x: 0.5 });
  assert.deepStrictEqual(bad.map(x => x.text), ['—', '—']);
  assert.ok(bad.every(x => x.tone === 'none'));
  assert.deepStrictEqual(L.probChips(null), []);
  for (const x of c.concat(r, inj, bad)) noNaN(x.label, 'chip label');
  assert.strictEqual(L.prob(0.996), '>99%');
  assert.strictEqual(L.prob(1), '100%');
});

// ---- readings -----------------------------------------------------------------------
test('marketReading in plain English', () => {
  assert.strictEqual(L.marketReading(1, { marketRank: 1, adpDelta: 0, label: 'fair' }).tone, 'fair');
  const v = L.marketReading(40, { marketRank: 60, adpDelta: 20, label: 'value' });
  assert.strictEqual(v.tone, 'value');
  assert.ok(/model likes him more than the market/i.test(v.text) && /20 spots higher/.test(v.text), v.text);
  const r = L.marketReading(60, { marketRank: 40, adpDelta: -20, label: 'reach' });
  assert.strictEqual(r.tone, 'reach');
  assert.ok(/market likes him more/i.test(r.text), r.text);
  assert.ok(/Preseason rank #264/.test(L.marketReading(238, { marketRank: null, yahooPreRank: 264 }).text));
  assert.strictEqual(L.marketReading(null, null).tone, 'none');
});
const jokic = {
  source: 'logs', identity: { name: 'Nikola Jokić', lastName: 'Jokić' },
  value: { rank: 1, hsValue: 75, mean: 62.9 }, consistency: { cv: 0.246, boomRate: 0.123 },
  rates: { ddPct: 0.846, tdPct: 0.523 }, form: { last5Delta: -0.7, roleTrend: 'flat', minDelta: -0.9 }, injury: { status: null },
};
test('scouting report: sentences, no football words, no NaN', () => {
  const lines = L.scouting(jokic);
  assert.ok(lines.length >= 3, lines.join(' '));
  assert.ok(/#1/.test(lines[0]) && /75\.0/.test(lines[0]));
  const all = lines.join(' ');
  noNaN(all, 'scouting');
  assert.ok(!/\b(QB|RB|WR|TE|touchdown|NFL|yards?)\b/i.test(all));
  const west = L.scouting({ source: 'yahoo-only', identity: { name: 'Russell Westbrook' }, value: { rank: 238, hsValue: 20.2 }, consistency: null, rates: null, form: null, injury: { status: null } });
  assert.ok(/no game logs/i.test(west.join(' ')));
  noNaN(west.join(' '));
  const butler = L.scouting({ source: 'logs', identity: { lastName: 'Butler' }, value: { rank: 164, hsValue: 27 }, injury: { status: 'Out', bodyPart: 'Knee', notes: 'Surgery' } });
  assert.ok(/Out \(Knee, surgery\)/.test(butler.join(' ')), butler.join(' '));
  assert.deepStrictEqual(L.scouting(null), []);
});
test('scheduleCard: 14-day weeks, b2b, missing games', () => {
  const c = L.scheduleCard({ week: 7, start: '2026-11-30', end: '2026-12-13', days: 14, modelGames: 7, hsValue: 80, games: [{ date: '2026-12-01', opp: 'OKC', home: false, b2b: true }], gameCount: 7, b2bCount: 2 });
  assert.strictEqual(c.long, true);
  assert.strictEqual(c.count, 7);
  assert.strictEqual(c.b2b, 2);
  assert.strictEqual(c.range, 'Nov 30–Dec 13');
  const m = L.scheduleCard({ week: 1, start: '2026-10-20', end: '2026-10-25', days: 6, modelGames: 3, games: null });
  assert.strictEqual(m.long, false);
  assert.strictEqual(m.count, 3);
  assert.strictEqual(m.games, null);
  const e = L.scheduleCard(null);
  assert.strictEqual(e.count, null);
});
test('weeklyBars geometry, nulls leave gaps', () => {
  const g = L.weeklyBars([{ week: 1, best: 62.3 }, { week: 2, best: null }, { week: 3, best: 104.7 }], 300, 100);
  assert.strictEqual(g.top, 110);
  assert.strictEqual(g.max, 104.7);
  assert.strictEqual(g.bars.length, 3);
  assert.strictEqual(g.bars[1].h, 0);
  assert.ok(g.bars[2].h > g.bars[0].h);
  for (const b of g.bars) for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(b[k]), k);
  const empty = L.weeklyBars([], 300, 100);
  assert.strictEqual(empty.max, null);
  assert.strictEqual(empty.bars.length, 0);
});
test('scoresOf / mean / norm / unavailable', () => {
  assert.deepStrictEqual(L.scoresOf([{ score: 1 }, { score: null }, null, { score: 3 }]), [1, 3]);
  assert.strictEqual(L.mean([1, 3, NaN]), 2);
  assert.strictEqual(L.mean([]), null);
  assert.strictEqual(L.norm('Nikola Jokić'), 'nikola jokic');
  assert.strictEqual(L.norm('Luka Dončić'), 'luka doncic');
  assert.strictEqual(L.unavailable({ unavailable: { news: 'none' } }, 'news'), 'none');
  assert.strictEqual(L.unavailable({}, 'news'), null);
});

// ---- static page checks ----------------------------------------------------------------
const html = fs.readFileSync(path.join(ROOT, 'nba/pages/research.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'nba/pages/research.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'nba/pages/research.css'), 'utf8');
test('page uses the design system contract', () => {
  assert.ok(/<body[^>]*class="[^"]*\bsport-nba\b[^"]*\bnba-ui\b/.test(html));
  assert.ok(/<meta name="theme-color" content="#1a110b">/.test(html));
  assert.ok(/NbaUI\.mountNav\(\{ active: 'research' \}\)/.test(html));
  assert.ok(html.indexOf('/nba/pages/nba-ui.js') < html.indexOf('/shared/nav.js'), 'nba-ui.js before nav.js');
  assert.ok(!/<script defer src="\/nba\/pages\/nba-ui\.js"/.test(html), 'nba-ui.js not deferred');
  assert.ok(html.indexOf('research-logic.js') < html.indexOf('research.js"'), 'logic before page script');
  assert.ok(/<meta name="description" content="[^"]*(NBA|basketball)/i.test(html));
});
test('a11y basics present', () => {
  assert.ok(/role="combobox"/.test(html) && /aria-controls="rs-ac"/.test(html) && /role="listbox"/.test(html));
  assert.ok(/aria-labelledby="rs-detail-t"/.test(html) && /aria-modal="true"/.test(html));
  assert.ok(/role="tablist"/.test(js) && /role="tabpanel"/.test(js) && /aria-sort=/.test(js));
  assert.ok(/aria-pressed/.test(js) && /role="switch"/.test(js));
});
test('every CSS rule is scoped to .nba-ui (or the page ids)', () => {
  const sels = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '')
    .split('}').map(s => s.split('{')[0].trim()).filter(s => s && !s.startsWith('@') && !/^(from|to|\d+%)$/.test(s));
  for (const s of sels) for (const one of s.split(',')) {
    const t = one.trim().replace(/^@media[^{]*$/, '');
    if (!t) continue;
    assert.ok(/^\.nba-ui\b|^#rs-/.test(t), 'unscoped selector: ' + t);
  }
});
test('page escapes API strings (no raw p.name concatenation)', () => {
  assert.ok(!/\+ p\.name \+/.test(js) && !/\+ it\.title \+/.test(js));
  assert.ok(!/innerHTML = [^;]*\bd\.identity\.name\b/.test(js));
});
test('router serves /nba/research', () => {
  const router = fs.readFileSync(path.join(ROOT, 'nba/router.js'), 'utf8');
  assert.ok(/router\.get\('\/nba\/research', page\('research\.html', 'Research'\)\)/.test(router));
});

console.log(`research UI: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
