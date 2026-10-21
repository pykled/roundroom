/* Pocket NBA — team page logic (Stream C). Pure helpers shared by team.js and
   scripts/test-nba-team.js: tier glyphs, sorting, plain-English strengths and
   weaknesses, ETA text, saved state. UMD: window.NbaTeam / require(). */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NbaTeam = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var STORAGE_KEY = 'pocket-nba-team:v1';
  var TRADE_KEY = 'pocket-nba-trade:v1';
  var LEAGUE_KEY = 'pocket-nba-league';
  var MAX_ROSTER = 25;
  var GROUPS = ['G', 'F', 'C', 'UTIL'];
  var GROUP_NAME = { G: 'Guard', F: 'Forward', C: 'Center', UTIL: 'Utility', PG: 'Point Guard', SG: 'Shooting Guard', SF: 'Small Forward', PF: 'Power Forward' };
  var GROUP_SHORT = { G: 'G', F: 'F', C: 'C', UTIL: 'UTIL' };
  // Same wording as the trade page's fit chips (spec §5.3 legend).
  var TIER = {
    critical: { glyph: '▲', label: 'Critical', tone: 'bad', rank: 0, help: 'Short on bodies and below the league average here. Your biggest need.' },
    upgrade: { glyph: '▴', label: 'Upgrade', tone: 'warn', rank: 1, help: 'Enough players, but they score below the league average. Look for an upgrade.' },
    thin: { glyph: '△', label: 'Thin', tone: 'warn', rank: 2, help: 'Good starters, nobody healthy behind them. One injury exposes you.' },
    solid: { glyph: '●', label: 'Solid', tone: 'flat', rank: 3, help: 'Average or better with some depth. No action needed.' },
    deep: { glyph: '▼', label: 'Deep', tone: 'good', rank: 4, help: 'More healthy players than slots. You can trade from here.' },
    loaded: { glyph: '◆', label: 'Loaded', tone: 'good', rank: 5, help: 'Deep and among the top 30% of the league. Your best trade chip.' }
  };
  var HORIZON = { ros: 'Rest of Season', next4: 'Next 4 Weeks', playoffs: 'Playoffs' };
  var LEAN = { contend: 'Contender', balanced: 'Balanced', preseason: 'Preseason' };
  var DASH = '—';

  function num(x) { return typeof x === 'number' && isFinite(x); }
  function f1(x) { return num(x) ? x.toFixed(1) : DASH; }
  function signed(x, dp) { if (!num(x)) return DASH; var s = x.toFixed(dp == null ? 1 : dp); return x > 0 ? '+' + s : (Number(s) === 0 ? s.replace('-', '') : s); }
  function ordinal(n) {
    if (!num(n)) return DASH;
    n = Math.round(n); var v = n % 100, s = ['th', 'st', 'nd', 'rd'];
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function lastName(name) {
    var parts = String(name || '').replace(/\s+(Jr|Sr|II|III|IV)\.?$/i, '').trim().split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(' ') : parts[0] || '';
  }
  function tierMeta(t) { return TIER[t] || TIER.solid; }
  function tierText(t) { var m = tierMeta(t); return m.glyph + ' ' + m.label; }

  /* ------------------------------------------------------------ record + sort */
  function recordText(team, gamesPlayed) {
    var r = team && team.record;
    if (!r || !gamesPlayed) return DASH;
    return r.wins + '-' + r.losses + (r.ties ? '-' + r.ties : '');
  }
  // Sort keys for the power table. dir: 1 asc, -1 desc. Ties → power rank.
  var SORTS = {
    rank: function (t) { return t.powerRank; },
    team: function (t) { return String(t.name || '').toLowerCase(); },
    record: function (t) { return num(t.record && t.record.pct) ? t.record.pct : -1; },
    pts: function (t) { return t.record ? t.record.fpts : 0; },
    strength: function (t) { return t.strengthRos; },
    now: function (t) { return t.strengthNow; },
    G: function (t) { return -t.groupRank.G; }, F: function (t) { return -t.groupRank.F; }, C: function (t) { return -t.groupRank.C; }, UTIL: function (t) { return -t.groupRank.UTIL; },
    inj: function (t) { return t.injuryExposure ? t.injuryExposure.thisWeek : 0; },
    cover: function (t) { return t.benchCover ? t.benchCover.vsWaiver : -1e9; }
  };
  var DEFAULT_DIR = { rank: 1, team: 1, record: -1, pts: -1, strength: -1, now: -1, G: -1, F: -1, C: -1, UTIL: -1, inj: -1, cover: -1 };
  function sortTeams(teams, key, dir) {
    var f = SORTS[key] || SORTS.rank, d = dir || DEFAULT_DIR[key] || 1;
    return (teams || []).slice().sort(function (a, b) {
      var x = f(a), y = f(b);
      if (x < y) return -d; if (x > y) return d;
      return a.powerRank - b.powerRank;
    });
  }

  /* ------------------------------------------------------------ plain English */
  function nameOf(byId, id, fallback) { var p = byId && byId[id]; return p ? p.name : (fallback || 'Waiver add'); }
  function startersText(g, byId) {
    // g.starters / g.nextUpId are team-analysis extras; a bare contract group has only starterValue.
    if (!Array.isArray(g.starters)) return f1(g.starterValue) + '/wk from ' + g.slots + ' slot' + (g.slots === 1 ? '' : 's');
    var rows = g.starters;
    if (!rows.length) return 'nobody to start';
    if (rows.length === 1) { var s = rows[0]; return (s.replacement || !s.id ? 'a waiver add' : lastName(nameOf(byId, s.id))) + ' ' + f1(s.value) + '/wk'; }
    return rows.length + ' starters at ' + f1(g.starterValue) + '/wk';
  }
  // "Thin at C: Nurkić 31.0/wk, nobody healthy behind him. 9th of 12."
  function weaknessText(team, w, n, byId, leagueAvg) {
    var g = team.groups[w.group] || {};
    var prefix = { critical: 'Weakest', upgrade: 'Below average', thin: 'Thin' }[w.tier] || 'Watch';
    var where = w.group === 'UTIL' ? 'your Utility spots' : w.group;
    var s = prefix + ' at ' + where + ': ' + startersText(g, byId);
    if (w.tier === 'upgrade' && num(leagueAvg)) s += ' vs ' + f1(leagueAvg) + ' league average';
    if (w.tier === 'thin' || w.tier === 'critical') {
      var one = Array.isArray(g.starters) ? g.starters.length === 1 : g.slots === 1;
      s += g.nextUpId ? ', next up ' + lastName(nameOf(byId, g.nextUpId)) + ' ' + f1(g.nextUp) + '/wk'
        : num(g.nextUp) ? ', next up at ' + f1(g.nextUp) + '/wk' : ', nobody healthy behind ' + (one ? 'him' : 'them');
    }
    return s + '. ' + ordinal(w.rank) + ' of ' + n + '.';
  }
  // "Loaded at C: 4 healthy players for 1 slot, 2nd of 12."
  function strengthText(team, s, n, byId) {
    var g = team.groups[s.group] || {};
    var where = s.group === 'UTIL' ? 'Utility' : s.group;
    var label = s.tier === 'loaded' ? 'Loaded' : s.tier === 'deep' ? 'Deep' : 'Strong';
    var body = (s.tier === 'loaded' || s.tier === 'deep') && s.group !== 'UTIL'
      ? g.rostered + ' healthy players for ' + g.slots + ' slot' + (g.slots === 1 ? '' : 's')
      : startersText(g, byId);
    return label + ' at ' + where + ': ' + body + ', ' + ordinal(s.rank) + ' of ' + n + '.';
  }
  function list(xs) { return xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }
  function partnerText(p) {
    var s = 'Needs ' + list(p.theyNeed) + ', where you have depth.';
    if (p.theyHave && p.theyHave.length) s += ' Has the ' + list(p.theyHave) + ' depth you need.';
    return s;
  }
  // "Duren 32.9/wk, 4.4 above a waiver add" (best healthy bench player vs the waiver level)
  function coverText(c) {
    if (!c) return 'No healthy bench player';
    var d = num(c.vsWaiver) ? c.vsWaiver : 0;
    return lastName(c.name) + ' ' + f1(c.value) + '/wk, ' + (Math.abs(d) < 0.05 ? 'level with' : Math.abs(d).toFixed(1) + (d > 0 ? ' above' : ' below')) + ' a waiver add';
  }
  function targetText(t) {
    return 'You ' + signed(t.you) + '/wk · ' + t.partnerName + ' ' + signed(t.them) + '/wk';
  }

  /* ------------------------------------------------------------ injuries */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) : '';
  }
  // ETA as "~wk 12 (Jan 2)"; null without an ESPN date.
  function etaText(eta) {
    if (!eta || !eta.returnDate) return null;
    if (eta.status === 'OFS') return 'Out for season';
    return (num(eta.returnWeek) ? '~wk ' + eta.returnWeek + ' ' : '') + '(' + shortDate(eta.returnDate) + ')';
  }
  function injuryLine(x) {
    var eta = etaText(x.eta);
    var what = x.outForSeason ? 'Out for season' : (x.status || 'Injured') + (x.bodyPart ? ' (' + x.bodyPart + ')' : '');
    return what + (eta && !x.outForSeason ? ', back ' + eta : '');
  }

  /* ------------------------------------------------------------ form + minutes */
  function formText(s) {
    if (!s || !s.form) return null;
    var f = s.form, base = f1(f.last5) + ' last 5 vs ' + f1(f.seasonMean);
    var season = s.statSeason ? ' (' + s.statSeason + '-' + String((s.statSeason + 1) % 100).padStart(2, '0') + ')' : '';
    return { label: f.label === 'hot' ? 'Hot' : f.label === 'cold' ? 'Cold' : 'Steady', tone: f.label === 'hot' ? 'good' : f.label === 'cold' ? 'bad' : 'flat', text: base + (f.stale ? season : ''), stale: !!f.stale };
  }
  function minutesText(s) {
    if (!s || !s.minutes || !num(s.minutes.mpg)) return null;
    var m = s.minutes;
    return { label: m.trend === 'up' ? 'Minutes Up' : m.trend === 'down' ? 'Minutes Down' : 'Minutes Flat', tone: m.trend === 'up' ? 'good' : m.trend === 'down' ? 'bad' : 'flat', text: f1(m.mpg) + ' mpg' + (num(m.delta) ? ' (' + signed(m.delta) + ' last 5)' : '') };
  }

  /* ------------------------------------------------------------ headline */
  function teamHeadline(team, analysis) {
    var n = analysis.teams.length;
    var vs = analysis.estimated ? ' vs a typical league' : ' of ' + n;
    return ordinal(team.powerRank) + vs + ' at ' + f1(team.strengthRos) + ' pts/wk';
  }
  function scheduleText(team) {
    var s = team.scheduleThisWeek || {};
    if (!num(s.games)) return null;
    return s.games + ' starter games this week' + (num(s.vsLeagueAvg) && Math.abs(s.vsLeagueAvg) >= 0.5 ? ' (' + signed(s.vsLeagueAvg) + ' vs league)' : '');
  }

  /* ------------------------------------------------------------ state */
  function uniq(a) { var s = {}, out = []; (a || []).forEach(function (x) { x = String(x); if (!s[x] && /^[A-Za-z0-9_]{1,16}$/.test(x)) { s[x] = 1; out.push(x); } }); return out; }
  function emptyState() { return { v: 1, horizon: 'ros', roster: [], viewAs: {} }; }
  function parseState(raw) {
    var st = emptyState(), o;
    try { o = JSON.parse(raw); } catch (e) { return st; }
    if (!o || typeof o !== 'object' || o.v !== 1) return st;
    st.horizon = HORIZON[o.horizon] ? o.horizon : 'ros';
    st.roster = uniq(o.roster).slice(0, MAX_ROSTER);
    st.viewAs = o.viewAs && typeof o.viewAs === 'object' ? o.viewAs : {};
    return st;
  }
  function serialize(st) { return JSON.stringify({ v: 1, horizon: st.horizon, roster: st.roster, viewAs: st.viewAs || {} }); }
  // The trade page's manual roster, if the user built one there.
  function tradeRoster(raw) {
    var o; try { o = JSON.parse(raw); } catch (e) { return []; }
    return o && Array.isArray(o.myRoster) ? uniq(o.myRoster).slice(0, MAX_ROSTER) : [];
  }
  function teamUrl(o) {
    var q = [];
    if (o.leagueId) q.push('league_id=' + encodeURIComponent(o.leagueId));
    if (o.userId) q.push('user_id=' + encodeURIComponent(o.userId));
    if (o.rosterId) q.push('roster_id=' + encodeURIComponent(o.rosterId));
    if (o.horizon && o.horizon !== 'ros') q.push('horizon=' + encodeURIComponent(o.horizon));
    return '/api/nba/team?' + q.join('&');
  }
  function fold(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ''); }
  function search(players, q, limit) {
    var f = fold(q).trim(); if (!f) return [];
    var out = [];
    for (var i = 0; i < players.length && out.length < (limit || 12); i++) if (fold(players[i].name).indexOf(f) >= 0) out.push(players[i]);
    return out;
  }
  function avatarUrl(id) { return id && /^[A-Za-z0-9]{1,64}$/.test(String(id)) ? 'https://sleepercdn.com/avatars/thumbs/' + id : null; }

  return {
    STORAGE_KEY: STORAGE_KEY, TRADE_KEY: TRADE_KEY, LEAGUE_KEY: LEAGUE_KEY, MAX_ROSTER: MAX_ROSTER,
    GROUPS: GROUPS, GROUP_NAME: GROUP_NAME, GROUP_SHORT: GROUP_SHORT, TIER: TIER, HORIZON: HORIZON, LEAN: LEAN,
    f1: f1, signed: signed, ordinal: ordinal, lastName: lastName, tierMeta: tierMeta, tierText: tierText,
    recordText: recordText, sortTeams: sortTeams, SORTS: SORTS, DEFAULT_DIR: DEFAULT_DIR,
    weaknessText: weaknessText, strengthText: strengthText, partnerText: partnerText, targetText: targetText, coverText: coverText,
    shortDate: shortDate, etaText: etaText, injuryLine: injuryLine, formText: formText, minutesText: minutesText,
    teamHeadline: teamHeadline, scheduleText: scheduleText,
    emptyState: emptyState, parseState: parseState, serialize: serialize, tradeRoster: tradeRoster, teamUrl: teamUrl,
    fold: fold, search: search, avatarUrl: avatarUrl
  };
});
