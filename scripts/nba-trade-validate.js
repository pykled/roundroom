#!/usr/bin/env node
// Re-validates the trade verdict thresholds (Accept / Counter / Decline) and the
// v2 Value labels (Even / Leans / Favors / Lopsided) on 30 realistic trades from
// the real board. Default: Dillon's Sleeper league profile (docs/nba-spec fixtures:
// 12 teams, 10 starters with 3 UTIL, 4 BN, 2 IL, 23 Mon-Sun weeks, playoffs 21-23,
// 13-round draft). --profile=242808 re-runs the old stored-profile table.
// Rosters = a snake draft in market-consensus order (data/nba/market.json, the
// market's own draft), so every roster looks like a real one.
//   node scripts/nba-trade-validate.js [--md] [--profile=sleeper|242808]
// require()d by scripts/test-nba-trade.js: buildTable({ profile }) → { prof, board, players, rosters, context, cases, rows }.
'use strict';
process.env.NBA_MODEL_OFFLINE = process.env.NBA_MODEL_OFFLINE || '1';
const path = require('path');
const T = require('../nba/model/trade');
const { getPlayers } = require('../nba/model');
const LP = require('../nba/league-profile');
const LS = require('../nba/model/league-sync');
const Data = require('../nba/model/data');
const { enrichPlayers } = require('../nba/model/enrich');

const FIX = path.join(__dirname, '..', 'docs', 'nba-spec', 'fixtures');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };

async function buildTable({ profile: which = 'sleeper' } = {}) {
  const prof = which === 'sleeper'
    ? LS.profileFromSleeper({ league: require(path.join(FIX, 'sleeper-league.json')), state: require(path.join(FIX, 'sleeper-state.json')) })
    : LP.getProfile(which) || LP.defaultProfile();
  const board = enrichPlayers(await getPlayers({ profile: prof }));
  const players = board.players.filter(p => p.hsByWeek);
  const data = Data.load();
  let market = null; try { market = require('../nba/routes/market').load(); } catch { market = null; }
  const context = { logs: data.logs, proj: data.proj, market, eta: null, bio: null };
  const draftKey = p => p.marketRank || p.yahooPreRank || 9999;
  const order = players.filter(p => !p.outForSeason).slice().sort((a, b) => draftKey(a) - draftKey(b) || a.rank - b.rank);
  // Dillon's league drafted 13 rounds (spec §1.1; the league payload alone can't tell, so the profile says 10 + 4 BN = 14).
  const teams = prof.teams, rounds = which === 'sleeper' ? 13 : (prof.draft && prof.draft.rounds) || 14;
  const rosters = Array.from({ length: teams }, () => []);
  let k = 0;
  for (let r = 0; r < rounds; r++) for (let i = 0; i < teams; i++) rosters[r % 2 ? teams - 1 - i : i].push(order[k++]);
  const rostered = rosters.flat().map(p => p.id);
  const byRank = team => rosters[team].slice().sort((a, b) => b.hsValue - a.hsValue);
  const pick = (team, i) => byRank(team)[i];
  const elig = p => p.yahooElig || [];
  const C = p => elig(p).includes('C') && !elig(p).some(s => ['PG', 'SG', 'SF'].includes(s));
  const G = p => elig(p).some(s => s === 'PG' || s === 'SG');

  // [label, myTeam, partnerTeam, giveIdx[], getIdx[]] — indices into each team's hsValue order.
  const cases = [
    ['1-for-1 like-for-like (2nd best)', 0, 6, [1], [1]],
    ['1-for-1 like-for-like (5th best)', 3, 8, [4], [4]],
    ['1-for-1 like-for-like (8th best)', 5, 10, [7], [7]],
    ['1-for-1 small upgrade (my 6th for their 5th)', 2, 9, [5], [4]],
    ['1-for-1 small downgrade (my 3rd for their 4th)', 4, 7, [2], [3]],
    ['star for star (best for best)', 0, 11, [0], [0]],
    ['my best for their 3rd', 1, 6, [0], [2]],
    ['my 3rd for their best', 7, 0, [2], [0]],
    ['lopsided: my best for their 9th', 2, 5, [0], [8]],
    ['lopsided: my 12th for their 2nd', 9, 3, [11], [1]],
    ['bench for bench (13th for 13th)', 6, 1, [12], [12]],
    ['bench for bench (12th for 13th)', 10, 4, [11], [12]],
    ['2-for-1 consolidation: my 2nd+3rd for their best', 3, 0, [1, 2], [0]],
    ['2-for-1 consolidation: my 4th+5th for their 2nd', 8, 2, [3, 4], [1]],
    ['2-for-1 consolidation: my 6th+7th for their 3rd', 11, 5, [5, 6], [2]],
    ['1-for-2 depth: my best for their 2nd+3rd', 0, 7, [0], [1, 2]],
    ['1-for-2 depth: my 3rd for their 5th+6th', 4, 9, [2], [4, 5]],
    ['1-for-2 depth: my 6th for their 9th+10th', 6, 11, [5], [8, 9]],
    ['2-for-2 swap (2nd+6th for 3rd+5th)', 1, 8, [1, 5], [2, 4]],
    ['2-for-2 swap (4th+9th for 4th+8th)', 5, 2, [3, 8], [3, 7]],
    ['2-for-2 lopsided (1st+2nd for 7th+8th)', 7, 10, [0, 1], [6, 7]],
    ['3-for-1 (2nd,3rd,4th for their best)', 9, 1, [1, 2, 3], [0]],
    ['3-for-2 (5th,6th,7th for their 3rd+4th)', 10, 6, [4, 5, 6], [2, 3]],
    ['give 1 for nothing (my 10th)', 2, 3, [9], []],
    ['receive 1 for nothing (their 11th)', 3, 4, [], [10]],
    ['near-equal 1-for-1 (7th for 7th)', 8, 0, [6], [6]],
    ['near-equal 1-for-1 (10th for 10th)', 11, 7, [9], [9]],
  ];
  // Positional cases: a center for a guard from a C-heavy team, and the reverse.
  const cTeam = rosters.map((r, i) => [i, r.filter(C).length]).sort((a, b) => b[1] - a[1])[0][0];
  const gTeam = rosters.map((r, i) => [i, r.filter(p => G(p)).length]).sort((a, b) => b[1] - a[1])[0][0];
  const idxOf = (team, pred) => byRank(team).findIndex(pred);
  cases.push(['positional: my surplus C for their G', cTeam, gTeam, [idxOf(cTeam, (p, i) => i > 0 && C(p))], [idxOf(gTeam, (p, i) => i > 0 && G(p) && !C(p))]]);
  cases.push(['positional: their surplus C for my G', gTeam, cTeam, [idxOf(gTeam, (p, i) => i > 0 && G(p) && !C(p))], [idxOf(cTeam, (p, i) => i > 0 && C(p))]]);
  // Injured (Out) player for a healthy one of similar board value.
  const outP = players.find(p => !p.outForSeason && /^out$/i.test(p.injury || '') && rostered.includes(p.id));
  const outTeam = outP ? rosters.findIndex(r => r.includes(outP)) : 0;
  const partnerT = (outTeam + 4) % teams;
  const similar = outP ? byRank(partnerT).reduce((b, p, i) => (Math.abs(p.hsValue - outP.hsValue) < Math.abs(byRank(partnerT)[b].hsValue - outP.hsValue) ? i : b), 0) : 0;
  cases.push([`injured: my Out ${outP ? outP.name : '?'} for a healthy twin`, outTeam, partnerT, [byRank(outTeam).indexOf(outP)], [similar]]);

  const rows = [];
  const inputs = [];
  for (const [label, me, them, giveIdx, getIdx] of cases) {
    const give = giveIdx.map(i => pick(me, i)).filter(Boolean);
    const get = getIdx.map(i => pick(them, i)).filter(Boolean);
    const input = {
      players, currentWeek: board.currentWeek, profile: prof, today: '2026-10-20', context,
      myRoster: rosters[me].map(p => p.id), partnerRoster: rosters[them].map(p => p.id),
      give: give.map(p => p.id), get: get.map(p => p.id), leagueRostered: rostered, leagueRosters: rosters.map(x => x.map(p => p.id)),
    };
    inputs.push(input);
    const r = T.evaluateTrade(input);
    const raw = get.reduce((s, p) => s + p.hsValue, 0) - give.reduce((s, p) => s + p.hsValue, 0);
    rows.push({ label, give: give.map(p => `${p.name} (${p.hsValue})`).join(' + ') || '—', get: get.map(p => `${p.name} (${p.hsValue})`).join(' + ') || '—',
      raw: Math.round(raw * 10) / 10, you: r.you.perWeek, them: r.them.perWeek, band: r.meta.fairBand, verdict: r.verdict, likely: r.them.likely,
      value: r.value ? r.value.label : '—', vband: r.value ? r.value.band : '—', gapPct: r.value ? Math.round(r.value.gapPct * 100) : null,
      vin: r.value ? r.value.assetIn : null, vout: r.value ? r.value.assetOut : null, weeks: r.meta.weeks, slots: r.meta.settings.slotList.length });
  }
  return { prof, board, players, rosters, context, cases, inputs, rows, teams, rounds };
}

if (require.main === module) (async () => {
  const { prof, rows, teams, rounds } = await buildTable({ profile: arg('profile', 'sleeper') });
  if (process.argv.includes('--md')) {
    console.log(`Profile: ${prof.name} (${prof.source || 'stored'}), ${rows[0].slots} starters, ${rows[0].weeks} weeks, ${teams} teams × ${rounds} rounds.\n`);
    console.log('| # | trade | give | get | raw hsValue Δ | my Δ/wk | their Δ/wk | band | verdict | partner | value out → in | value gap | value label |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    rows.forEach((x, i) => console.log(`| ${i + 1} | ${x.label} | ${x.give} | ${x.get} | ${x.raw} | ${x.you} | ${x.them} | ${x.band} | ${x.verdict} | ${x.likely} | ${x.vout} → ${x.vin} | ${x.gapPct}% | ${x.value} |`));
  } else {
    for (const [i, x] of rows.entries()) console.log(`${String(i + 1).padStart(2)} ${x.verdict.padEnd(8)} you ${String(x.you).padStart(6)} them ${String(x.them).padStart(6)} band ${x.band} raw ${x.raw} value ${x.vband} ${x.gapPct}%  ${x.label}: ${x.give} → ${x.get}`);
  }
  const n = v => rows.filter(x => x.verdict === v).length;
  const nv = v => rows.filter(x => x.vband === v).length;
  console.log(`\n${rows.length} trades (${rows[0].slots} starters, ${rows[0].weeks} weeks): Accept ${n('Accept')}, Counter ${n('Counter')}, Decline ${n('Decline')} · Value: even ${nv('even')}, leans ${nv('leans')}, favors ${nv('favors')}, lopsided ${nv('lopsided')}`);
})().catch(e => { console.error(e); process.exit(1); });

module.exports = { buildTable };
