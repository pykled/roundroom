// Yahoo read-path diagnostic: runs every call the app makes against the
// signed-in user's real account and returns a sanitized report (no tokens, no
// Yahoo GUIDs, no emails) that is safe to paste into chat. Used by
// GET /api/nba/yahoo/diagnose and scripts/yahoo-diagnose.js.
//
//   const warnings = [];
//   const client = createClient({ getTokens, saveTokens, onWarning: w => warnings.push(w) });
//   const report = await runDiagnose({ client, warnings });
//
// Each step is timed and isolated: one failing league or call is recorded in
// steps[] and the rest still run.

const NBA_STAT = { 12: 'PTS', 15: 'REB', 16: 'AST', 17: 'ST', 18: 'BLK', 19: 'TO' };
const HS_MODIFIERS = { PTS: 1, REB: 1, AST: 2, ST: 3, BLK: 3 };
const HS_ROSTER = { G: 2, F: 3, UTIL: 1 };
const MAX_LEAGUES = 8;

// Unmodelled settings are shown verbatim minus anything link/identity-like
// (chat channel URLs, invite links, ids tied to a person).
const REDACT_KEY = /url|sendbird|token|secret|guid|email|password|invite/i;
function redactExtra(extra) {
  const out = {};
  for (const [k, v] of Object.entries(extra || {})) if (!REDACT_KEY.test(k) && !/^\s*https?:\/\//i.test(String(v))) out[k] = v;
  return out;
}

function errInfo(e) {
  return { message: String((e && e.message) || e).slice(0, 240), status: (e && e.status) || null, code: (e && e.code) || null };
}

// High Score heuristics. Every signal lists the exact field and value it used.
function highScoreCheck(league) {
  const signals = [];
  let score = 0;
  const add = (field, value, matches, weight, note) => { signals.push({ field, value, matches, weight, note }); if (matches) score += weight; };

  const st = league.scoring_type || null;
  add('scoring_type', st, st === 'headpoint' || st === 'point', 2,
    'High Score is a points format; "head"/"roto" are category leagues');

  const names = {};
  for (const c of league.stat_categories || []) if (c.stat_id != null) names[c.stat_id] = c.display_name || c.name;
  const mods = {};
  for (const m of league.stat_modifiers || []) {
    if (m.value == null || m.value === 0) continue;
    const n = String(NBA_STAT[m.stat_id] || names[m.stat_id] || `stat_${m.stat_id}`).toUpperCase().replace(/^STL$/, 'ST');
    mods[n] = m.value;
  }
  const modsMatch = Object.keys(HS_MODIFIERS).every(k => mods[k] === HS_MODIFIERS[k]) && Object.keys(mods).length === Object.keys(HS_MODIFIERS).length;
  add('settings.stat_modifiers', mods, modsMatch, 3, 'expects PTS 1, REB 1, AST 2, ST 3, BLK 3 and nothing else');

  const counts = {};
  for (const p of league.roster_positions || []) {
    const k = /^util$/i.test(p.position) ? 'UTIL' : p.position;
    counts[k] = (counts[k] || 0) + (p.count || 0);
  }
  const starters = Object.fromEntries(Object.entries(counts).filter(([k]) => !['BN', 'IL', 'IL+', 'IR'].includes(k)));
  const rosterMatch = Object.keys(HS_ROSTER).every(k => starters[k] === HS_ROSTER[k]) && Object.keys(starters).length === 3;
  add('settings.roster_positions', counts, rosterMatch, 2, 'expects starters G×2, F×3, Util×1');

  add('name', league.name, /high\s*score/i.test(league.name || ''), 1, 'league name mentions High Score');

  const extra = (league.settings && league.settings.extra) || {};
  const hsKeys = Object.keys(extra).filter(k => /high|best|max_?game|top_?score/i.test(k));
  add('settings.extra', hsKeys.length ? Object.fromEntries(hsKeys.map(k => [k, extra[k]])) : null, hsKeys.length > 0, 2,
    'any unmodelled setting whose name hints at best-game scoring');

  const verdict = score >= 5 ? 'likely' : score >= 3 ? 'possible' : 'unlikely';
  return { verdict, score, maxScore: 10, signals };
}

async function runDiagnose({ client, warnings = [], now = () => Date.now(), maxLeagues = MAX_LEAGUES } = {}) {
  const t0 = now();
  const steps = [];
  async function step(name, fn) {
    const w0 = warnings.length, s0 = now();
    try {
      const v = await fn();
      steps.push({ step: name, ok: true, ms: now() - s0, warnings: warnings.slice(w0) });
      return v;
    } catch (e) {
      steps.push({ step: name, ok: false, ms: now() - s0, error: errInfo(e), warnings: warnings.slice(w0) });
      return undefined;
    }
  }

  const report = { generatedAt: new Date(t0).toISOString(), ok: false, gameKey: null, leagues: [], steps, warnings };

  const gameKey = await step('game key (game/nba)', () => client.getGameKey('nba'));
  report.gameKey = gameKey || null;
  if (!gameKey) { report.durationMs = now() - t0; return report; }

  const leagues = await step('user leagues', () => client.getUserLeagues(gameKey));
  report.leagueCount = leagues ? leagues.length : null;
  if (!leagues) { report.durationMs = now() - t0; return report; }
  if (leagues.length > maxLeagues) report.leaguesTruncated = leagues.length - maxLeagues;

  for (const l of leagues.slice(0, maxLeagues)) {
    const lk = l.league_key;
    const out = { league_key: lk, name: l.name, num_teams: l.num_teams, draft_status: l.draft_status, season: l.season };
    report.leagues.push(out);
    if (!lk) { out.error = 'league has no league_key'; continue; }

    const league = await step(`league settings ${lk}`, () => client.getLeague(lk));
    if (league) {
      const s = league.settings || {};
      out.settings = {
        scoring_type: league.scoring_type, league_type: league.league_type, draft_type: league.draft_type,
        is_auction_draft: league.is_auction_draft, draft_pick_time: league.draft_pick_time, draft_time: s.draft_time ?? null,
        max_teams: s.max_teams ?? null, start_week: league.start_week, end_week: league.end_week, current_week: league.current_week,
        roster_positions: league.roster_positions,
        stat_categories: (league.stat_categories || []).filter(c => c.enabled).map(c => `${c.stat_id}:${c.display_name || c.name}`),
        stat_modifiers: league.stat_modifiers,
        weeks: { count: league.weeks.length, first: league.weeks[0] || null, last: league.weeks[league.weeks.length - 1] || null },
        extra: redactExtra(s.extra),
      };
      out.highScore = highScoreCheck(league);
    }

    const teams = await step(`teams ${lk}`, () => client.getTeams(lk));
    let mine = null;
    if (teams) {
      mine = teams.find(t => t.is_owned_by_current_login) || null;
      out.teams = {
        count: teams.length,
        myTeam: mine ? { team_key: mine.team_key, name: mine.name, draft_position: mine.draft_position } : null,
        draftPositionsSet: teams.filter(t => t.draft_position != null).length,
      };
    }

    const draft = await step(`draft results ${lk}`, () => client.getDraftResults(lk));
    if (draft) {
      const made = draft.picks.filter(p => p.player_key);
      const open = draft.picks.filter(p => !p.player_key);
      let names = {};
      const sample = made.slice(0, 3);
      if (sample.length) {
        const ps = await step(`draft pick names ${lk}`, () => client.getPlayersByKeys(lk, sample.map(p => p.player_key)));
        for (const p of ps || []) names[p.player_key] = p.name.full;
      }
      out.draft = {
        draft_status: draft.draft_status, results: draft.picks.length, made: made.length, openSlots: open.length,
        teamKeyOnEveryPick: draft.picks.length > 0 && draft.picks.every(p => !!p.team_key),
        pickNumbersContiguous: draft.picks.every((p, i) => p.pick === i + 1),
        hasCost: draft.picks.some(p => p.cost != null),
        firstPicks: sample.map(p => ({ ...p, name: names[p.player_key] || null })),
        firstOpenSlot: open[0] || null,
      };
    }

    if (mine) {
      const roster = await step(`roster ${mine.team_key}`, () => client.getRoster(mine.team_key));
      if (roster) {
        out.roster = {
          week: roster.week, coverage_type: roster.coverage_type, count: roster.players.length,
          sample: roster.players.slice(0, 3).map(p => ({
            player_key: p.player_key, name: p.name.full, team: p.editorial_team_abbr, display_position: p.display_position,
            eligible_positions: p.eligible_positions, selected_position: p.selected_position ?? null, status: p.status,
          })),
        };
      }
    }
  }

  report.ok = steps.every(s => s.ok);
  report.durationMs = now() - t0;
  return report;
}

// Plain-text rendering for the CLI.
function formatReport(r) {
  const L = [];
  L.push(`Yahoo diagnose — ${r.generatedAt} — ${r.ok ? 'ALL STEPS OK' : 'SOME STEPS FAILED'} (${r.durationMs} ms)`);
  L.push(`game key: ${r.gameKey || '(none)'}   leagues: ${r.leagueCount ?? '?'}${r.leaguesTruncated ? ` (+${r.leaguesTruncated} not shown)` : ''}`);
  for (const l of r.leagues) {
    L.push('', `== ${l.name} (${l.league_key}) · ${l.num_teams} teams · draft_status=${l.draft_status}`);
    if (l.settings) {
      const s = l.settings;
      L.push(`  scoring_type=${s.scoring_type} draft_type=${s.draft_type} auction=${s.is_auction_draft} pick_time=${s.draft_pick_time} weeks=${s.weeks.count} (${s.start_week}-${s.end_week})`);
      L.push(`  roster: ${s.roster_positions.map(p => `${p.position}×${p.count}`).join(' ')}`);
      L.push(`  modifiers: ${s.stat_modifiers.map(m => `${m.stat_id}=${m.value}`).join(' ') || '(none)'}`);
      if (Object.keys(s.extra).length) L.push(`  other settings: ${JSON.stringify(s.extra)}`);
    }
    if (l.highScore) {
      L.push(`  High Score? ${l.highScore.verdict.toUpperCase()} (${l.highScore.score}/${l.highScore.maxScore})`);
      for (const g of l.highScore.signals) L.push(`    ${g.matches ? '✓' : '✗'} ${g.field} = ${JSON.stringify(g.value)}`);
    }
    if (l.teams) L.push(`  teams: ${l.teams.count}, mine: ${l.teams.myTeam ? `${l.teams.myTeam.name} (${l.teams.myTeam.team_key}, draft slot ${l.teams.myTeam.draft_position ?? '?'})` : '(not found)'}`);
    if (l.draft) {
      const d = l.draft;
      L.push(`  draft: ${d.made}/${d.results} made, ${d.openSlots} open, team_key on every pick=${d.teamKeyOnEveryPick}, contiguous=${d.pickNumbersContiguous}, cost=${d.hasCost}`);
      for (const p of d.firstPicks) L.push(`    #${p.pick} r${p.round} ${p.team_key} → ${p.name || p.player_key}`);
    }
    if (l.roster) {
      L.push(`  roster (week ${l.roster.week}): ${l.roster.count} players`);
      for (const p of l.roster.sample) L.push(`    ${p.name} ${p.team || ''} [${p.eligible_positions.join(',')}] in ${p.selected_position}`);
    }
  }
  const failed = r.steps.filter(s => !s.ok);
  if (failed.length) { L.push('', 'FAILED STEPS:'); for (const s of failed) L.push(`  ${s.step}: ${s.error.message}`); }
  if (r.warnings.length) { L.push('', `PARSE WARNINGS (${r.warnings.length}):`); for (const w of [...new Set(r.warnings)]) L.push(`  ${w}`); }
  return L.join('\n');
}

module.exports = { runDiagnose, highScoreCheck, formatReport };
