// /api/projections/ros must 503 outside the regular season and on partial weekly
// fetches, and must start from the NEXT week once the current week's first game
// has kicked off (stubs Sleeper; no network). Run: node scripts/test-ros-guard.js
// Each scenario runs in its own child process because nfl:state and the scores
// feed are cached 5 min. Children run with NBA_MODEL_OFFLINE=1 and every
// non-loopback fetch stubbed, so nothing is written to data/nba/cache; any file
// that appears there anyway is removed in `finally` (a cache newer than the
// committed snapshot changes what the NBA suites read).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const NBA_CACHE = path.join(__dirname, '..', 'data', 'nba', 'cache');

if (process.argv[2] === 'child') {
  // args: season_type, week, failWeek ('' = none), scores ('' = no games,
  // 'fail' = feed 500, 'flag' = Sleeper says started, otherwise a signed hour
  // offset of the first kickoff relative to now, e.g. '-1' or '+48').
  const [, , , st, wk, failWeek, scores] = process.argv;
  process.env.CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || 'pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA';
  process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || 'sk_test_dummy';
  process.env.PORT = '7958';
  process.env.NBA_MODEL_OFFLINE = '1';
  const realFetch = global.fetch;
  const game = (home, away, kickoffMs, status) => ({ status, metadata: { home_team: home, away_team: away, date_time: new Date(kickoffMs).toISOString() } });
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)) return realFetch(url, opts);
    if (u.includes('/v1/state/nfl')) return new Response(JSON.stringify({ season: '2026', season_type: st, week: Number(wk) }));
    if (u.includes('/scores/nfl/regular/2026/')) {
      if (scores === 'fail') return new Response('x', { status: 500 });
      if (!scores) return new Response('[]');
      const now = Date.now();
      if (scores === 'flag') return new Response(JSON.stringify([game('KC', 'LAC', now + 3 * 3600e3, 'in_game'), game('SF', 'WAS', now + 72 * 3600e3, 'pre_game')]));
      const first = now + Number(scores) * 3600e3;
      // Thursday-night game first, Monday-night game last; all flagged pre_game
      // so only the clock vs kickoff decides.
      return new Response(JSON.stringify([game('SF', 'WAS', first + 96 * 3600e3, 'pre_game'), game('KC', 'LAC', first, 'pre_game'), game('DAL', 'NYG', first + 72 * 3600e3, 'pre_game')]));
    }
    const m = u.match(/projections\/nfl\/2026\/(\d+)/);
    if (m) return m[1] === failWeek ? new Response('x', { status: 500 }) : new Response(JSON.stringify([{ player_id: 'p1', stats: { pts_ppr: 10 } }]));
    return new Response('offline', { status: 503 });
  };
  require('../server.js');
  setTimeout(async () => {
    const r = await realFetch('http://localhost:7958/api/projections/ros');
    const r2 = await realFetch('http://localhost:7958/api/projections/ros');
    process.stdout.write('RESULT ' + JSON.stringify({ status: r.status, body: await r.json(), status2: r2.status, cc: r.headers.get('cache-control') }) + '\n');
    process.exit(0);
  }, 1500);
} else {
  const before = fs.existsSync(NBA_CACHE) ? new Set(fs.readdirSync(NBA_CACHE)) : null;
  let bad = 0;
  const check = (n, ok, d) => { console.log((ok ? '  ok   ' : '  FAIL ') + n + (ok ? '' : ' — ' + d)); if (!ok) bad++; };
  const run = (st, wk, failWeek = '', scores = '') => {
    const o = spawnSync(process.execPath, [__filename, 'child', st, wk, failWeek, scores], { encoding: 'utf8' }).stdout;
    return JSON.parse(o.split('\n').find(l => l.startsWith('RESULT ')).slice(7));
  };
  const weeks = r => JSON.stringify(r.body.weeks);
  try {
    let r = run('post', '19');
    check('postseason (week 19) → 503', r.status === 503, r.status);
    r = run('pre', '0');
    check('preseason → 503', r.status === 503, r.status);
    r = run('regular', '19');
    check('regular, week > 18 → 503', r.status === 503, r.status);
    r = run('regular', '17');
    check('regular week 17, no scores yet → 200, weeks [17,18]', r.status === 200 && weeks(r) === '[17,18]' && r.body.players.p1.pts_ppr === 20, JSON.stringify(r));
    check('no gp field', r.body.players && !('gp' in r.body.players.p1), JSON.stringify(r.body.players));
    check('envelope carries week, fromWeek, slateStarted; short browser cache', r.body.week === 17 && r.body.fromWeek === 17 && r.body.slateStarted === false && /max-age=300/.test(r.cc), JSON.stringify([r.body.week, r.body.fromWeek, r.body.slateStarted, r.cc]));
    r = run('regular', '12', '15');
    check('one weekly fetch fails → 503, no partial sum', r.status === 503, JSON.stringify(r));

    console.log('current-week rule (week 6)');
    r = run('regular', '6', '', '+48');
    check('first kickoff 48h away (Tue–Thu pre-kick) → from week 6, 13 weeks', r.status === 200 && r.body.fromWeek === 6 && r.body.weeks.length === 13 && r.body.slateStarted === false && r.body.players.p1.pts_ppr === 130, JSON.stringify(r.body.weeks));
    r = run('regular', '6', '', '+0.1');
    check('first kickoff 6 minutes away → still week 6', r.status === 200 && r.body.fromWeek === 6, JSON.stringify(r.body.weeks));
    r = run('regular', '6', '', '-1');
    check('first kickoff 1h ago, feed still says pre_game (Thu night, by clock) → from week 7, 12 weeks', r.status === 200 && r.body.week === 6 && r.body.fromWeek === 7 && weeks(r) === '[7,8,9,10,11,12,13,14,15,16,17,18]' && r.body.slateStarted === true && r.body.players.p1.pts_ppr === 120, JSON.stringify(r.body));
    r = run('regular', '6', '', '-72');
    check('Sunday / Monday night (only the MNF game left) → from week 7', r.status === 200 && r.body.fromWeek === 7 && r.body.weeks[0] === 7, JSON.stringify(r.body.weeks));
    r = run('regular', '6', '', 'flag');
    check('Sleeper flags a game in_game (kickoff time in the future) → from week 7', r.status === 200 && r.body.fromWeek === 7, JSON.stringify(r.body.weeks));
    r = run('regular', '7', '', '+72');
    check('Tuesday after Sleeper rolls to 7, week 7 not kicked off → from week 7', r.status === 200 && r.body.week === 7 && r.body.fromWeek === 7 && r.body.slateStarted === false, JSON.stringify(r.body.weeks));
    r = run('regular', '6', '', 'fail');
    check('scores feed down → keep week 6 (never 503 for this)', r.status === 200 && r.body.fromWeek === 6 && r.body.weeks.length === 13, JSON.stringify(r));
    r = run('regular', '18', '', '-1');
    check('week 18 has kicked off → 503 (nothing left to buy)', r.status === 503, JSON.stringify(r));
    r = run('regular', '18', '', '+48');
    check('week 18 before kickoff → 200, weeks [18]', r.status === 200 && weeks(r) === '[18]', JSON.stringify(r));
    r = run('regular', '6', '7', '-1');
    check('started + week 7 fetch fails → 503 (fromWeek 7 range is incomplete)', r.status === 503, JSON.stringify(r));
    r = run('regular', '6', '6', '-1');
    check('started + only week 6 fails → 200 (week 6 is no longer in the range)', r.status === 200 && r.body.fromWeek === 7, JSON.stringify(r));
  } finally {
    // Remove anything a child wrote to the NBA cache (nothing is expected).
    if (fs.existsSync(NBA_CACHE)) {
      const leaked = fs.readdirSync(NBA_CACHE).filter(f => !before || !before.has(f));
      for (const f of leaked) fs.rmSync(path.join(NBA_CACHE, f), { force: true });
      if (!before && !fs.readdirSync(NBA_CACHE).length) fs.rmdirSync(NBA_CACHE);
      if (leaked.length) check('no files written to data/nba/cache', false, 'removed ' + leaked.join(', '));
    }
  }
  console.log(bad ? `\n${bad} FAILED` : '\nall checks passed');
  process.exit(bad ? 1 : 0);
}
