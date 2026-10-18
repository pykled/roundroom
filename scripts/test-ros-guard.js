// /api/projections/ros must 503 outside the regular season and on partial weekly
// fetches (stubs Sleeper; no network). Run: node scripts/test-ros-guard.js
// Each scenario runs in its own child process because nfl:state is cached 5 min.
const { spawnSync } = require('child_process');
if (process.argv[2] === 'child') {
  const [, , , st, wk, failWeek] = process.argv;
  process.env.CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || 'pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA';
  process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || 'sk_test_dummy';
  process.env.PORT = '7958';
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/v1/state/nfl')) return new Response(JSON.stringify({ season: '2026', season_type: st, week: Number(wk) }));
    const m = u.match(/projections\/nfl\/2026\/(\d+)/);
    if (m) return m[1] === failWeek ? new Response('x', { status: 500 }) : new Response(JSON.stringify([{ player_id: 'p1', stats: { pts_ppr: 10 } }]));
    return realFetch(url, opts);
  };
  require('../server.js');
  setTimeout(async () => {
    const r = await realFetch('http://localhost:7958/api/projections/ros');
    process.stdout.write('RESULT ' + JSON.stringify({ status: r.status, body: await r.json() }) + '\n');
    process.exit(0);
  }, 1500);
} else {
  let bad = 0;
  const check = (n, ok, d) => { console.log((ok ? '  ok   ' : '  FAIL ') + n + (ok ? '' : ' — ' + d)); if (!ok) bad++; };
  const run = (...args) => {
    const o = spawnSync(process.execPath, [__filename, 'child', ...args], { encoding: 'utf8' }).stdout;
    return JSON.parse(o.split('\n').find(l => l.startsWith('RESULT ')).slice(7));
  };
  let r = run('post', '19');
  check('postseason (week 19) → 503', r.status === 503, r.status);
  r = run('pre', '0');
  check('preseason → 503', r.status === 503, r.status);
  r = run('regular', '19');
  check('regular, week > 18 → 503', r.status === 503, r.status);
  r = run('regular', '17');
  check('regular week 17 → 200, weeks [17,18]', r.status === 200 && JSON.stringify(r.body.weeks) === '[17,18]' && r.body.players.p1.pts_ppr === 20, JSON.stringify(r));
  check('no gp field', r.body.players && !('gp' in r.body.players.p1), JSON.stringify(r.body.players));
  r = run('regular', '12', '15');
  check('one weekly fetch fails → 503, no partial sum', r.status === 503, JSON.stringify(r));
  console.log(bad ? `\n${bad} FAILED` : '\nall checks passed');
  process.exit(bad ? 1 : 0);
}
