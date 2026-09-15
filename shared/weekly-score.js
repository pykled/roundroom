// Weekly lineup score — pure functions shared by lineup.html (browser) and
// scripts/test-weekly-score.js (node). Turns a single-week projection into a
// composite "how good is this player THIS week" number:
//
//   weekly_score = base_projection
//                × matchup_multiplier   (opponent fantasy points allowed to the position)
//                × vegas_multiplier     (implied team total from the betting line)
//                × form_multiplier      (recent actual vs projected, recency weighted)
//                × injury_modifier      (own status; opponent key defenders out)
//                × home_away_multiplier (home teams score ~3% more; no chip in the UI)
//                × short_week_multiplier (Thursday game = 4 days rest, −6%)
//                × weather_multiplier   (wind / rain at outdoor stadiums; passing positions)
//
// Every factor returns { mult, label, detail, source } so the UI can show WHY a
// player ranks where he does. `source` is 'live' when real data drove the
// number, 'neutral' when the factor had nothing to go on (mult 1.0), or
// 'placeholder' when it ran on static baseline data.
//
// DATA WIRING STATUS (what feeds each factor today — see docs/weekly-score.md):
//   base        LIVE   Sleeper weekly projection (api.sleeper.com), season/17 fallback
//   matchup     LIVE   data/fpa-current.json (`current`, rebuilt weekly by scripts/scrape-fpa.js
//                      via .github/workflows/update-fpa.yml) merged over data/fpa-baseline.json.
//                      `historical` (3-yr avg per team) still empty → neutral baseline fills in.
//   vegas       LIVE   /api/vegas → ctx.vegas = { TEAM: impliedPts } (The Odds API, ODDS_API_KEY)
//   form        LIVE   Sleeper weekly stats + past-week projections (api.sleeper.com)
//   injury      LIVE   own status from /api/players/slim; opponent defenders from /api/def-injuries
//   homeAway    LIVE   ctx.isHome from /api/schedule/:week (teams[TEAM].home)
//   shortWeek   LIVE   ctx.gameDate from /api/schedule/:week (teams[TEAM].date, YYYY-MM-DD)
//   weather     LIVE   ctx.weather = /api/weather teams[TEAM] → { windspeed (mph), precip (%), indoor }
var WeeklyScore = (function () {
  'use strict';

  // Neutral fantasy points allowed per game by position (league-average
  // defence). Used when no team-specific FPA is known so every matchup ties at
  // rank 16.5 → multiplier 1.0. NOT team data — do not tune per team here.
  var POS_BASELINE_FPA = { QB: 22, RB: 14, WR: 13, TE: 8, K: 8, DEF: 8 };

  var FORM_WEIGHTS = [0.5, 0.3, 0.2];   // 1 week ago, 2 weeks ago, 3 weeks ago
  var FORM_MIN = 0.8, FORM_MAX = 1.25;
  var VEGAS_MIN = 0.85, VEGAS_MAX = 1.2;
  var LEAGUE_AVG_IMPLIED = 22;
  var MATCHUP_BEST = 1.2, MATCHUP_WORST = 0.8;   // rank 1 → 1.2x, rank 32 → 0.8x
  var OPP_DEF_BOOST = 1.1;
  var HOME_MULT = 1.03, AWAY_MULT = 0.98;
  var SHORT_WEEK_MULT = 0.94;                  // Thursday game: 4 days' rest since Sunday
  var PASSING_POS = ['QB', 'WR', 'TE'];         // positions the wind/rain penalties apply to

  // Own-injury status → multiplier. Anything not listed (null, 'NA', 'COV' …) is 1.0.
  var STATUS_MULT = { Questionable: 0.85, Doubtful: 0.5, Out: 0, IR: 0, PUP: 0, Sus: 0, 'Sus.': 0 };
  // Which opponent defensive slot groups matter for each offensive position.
  var KEY_DEFENDERS = {
    WR: { groups: ['CB'], label: 'CB' },
    TE: { groups: ['LB', 'S'], label: 'LB/S' },
    RB: { groups: ['LB', 'S'], label: 'LB/S' },
  };
  // Sleeper depth_chart_position → coarse group.
  var DEF_SLOT_GROUP = {
    LCB: 'CB', RCB: 'CB', NB: 'CB', CB: 'CB',
    FS: 'S', SS: 'S', WS: 'S', S: 'S', DB: 'S',
    MLB: 'LB', LILB: 'LB', RILB: 'LB', ILB: 'LB', LOLB: 'LB', ROLB: 'LB', OLB: 'LB', SLB: 'LB', WLB: 'LB', LB: 'LB',
  };
  var OUT_STATUS = { Out: 1, IR: 1, Doubtful: 1, PUP: 1 };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function pct(mult) {
    var p = Math.round((mult - 1) * 100);
    return (p > 0 ? '+' : '') + p + '%';
  }

  // Sample-size weighting: current-season data is only 1/8 trusted at week 1
  // and fully trusted from week 8 on. weeksPlayed = completed weeks.
  function seasonWeight(weeksPlayed) {
    return clamp((weeksPlayed || 0) / 8, 0, 1);
  }

  // fpa: { positions: {QB: 22, …}, current: {WR: {KC: 21.3, …}}, historical: {WR: {KC: 19.8, …}} }
  // Returns the blended FPA a team allows to a position, or null when unknown.
  function effectiveFPA(fpa, pos, team, weeksPlayed) {
    if (!fpa || !team) return null;
    var cur = fpa.current && fpa.current[pos] ? fpa.current[pos][team] : null;
    var hist = fpa.historical && fpa.historical[pos] ? fpa.historical[pos][team] : null;
    if (cur == null && hist == null) return null;
    var w = seasonWeight(weeksPlayed);
    var base = (fpa.positions && fpa.positions[pos]) || POS_BASELINE_FPA[pos] || null;
    if (cur == null) return hist;
    if (hist == null) hist = base != null ? base : cur;   // no history → lean on neutral baseline
    return w * cur + (1 - w) * hist;
  }

  // Rank the opponent among all teams with data for this position (1 = allows
  // the most points = best matchup) and map rank → multiplier linearly.
  function matchupMultiplier(pos, opponent, fpa, weeksPlayed) {
    if (!opponent) return { mult: 1, label: 'MU', detail: 'No opponent this week', source: 'neutral' };
    var mine = effectiveFPA(fpa, pos, opponent, weeksPlayed);
    if (mine == null) {
      return { mult: 1, label: 'MU', detail: 'Matchup data not wired yet — neutral', source: 'placeholder' };
    }
    var teams = {};
    ['current', 'historical'].forEach(function (k) {
      var byPos = fpa[k] && fpa[k][pos];
      if (byPos) for (var t in byPos) teams[t] = true;
    });
    var values = [];
    for (var team in teams) {
      var v = effectiveFPA(fpa, pos, team, weeksPlayed);
      if (v != null) values.push(v);
    }
    var n = values.length;
    if (n < 2) return { mult: 1, label: 'MU', detail: 'Not enough teams with matchup data', source: 'placeholder' };
    var better = 0, equal = 0;
    values.forEach(function (v) { if (v > mine) better++; else if (v === mine) equal++; });
    var rank = better + 1 + (equal - 1) / 2;   // ties share the average rank
    var frac = (rank - 1) / (n - 1);            // 0 = best, 1 = worst
    var mult = MATCHUP_BEST - frac * (MATCHUP_BEST - MATCHUP_WORST);
    var shown = Math.round(rank);
    return {
      mult: mult, label: 'MU', rank: shown, fpa: mine,
      detail: 'vs ' + opponent + ': #' + shown + ' of ' + n + ' fantasy pts allowed to ' + pos + ' (' + mine.toFixed(1) + '/g, ' + Math.round(seasonWeight(weeksPlayed) * 100) + '% this season)',
      source: 'live',
    };
  }

  // vegas: { TEAM: impliedPoints } — pre-computed from spread + total:
  //   implied = total/2 − spread/2   (spread negative for the favourite)
  function vegasMultiplier(team, vegas) {
    var pts = vegas && team ? vegas[team] : null;
    if (pts == null || !isFinite(pts)) return { mult: 1, label: 'Vegas', detail: 'Vegas odds not wired yet — neutral', source: 'neutral' };
    var mult = clamp(pts / LEAGUE_AVG_IMPLIED, VEGAS_MIN, VEGAS_MAX);
    return { mult: mult, label: 'Vegas', implied: pts, detail: 'Implied team total ' + pts.toFixed(1) + ' pts (league avg ' + LEAGUE_AVG_IMPLIED + ')', source: 'live' };
  }

  // Implied team points for both sides of a game from a spread + total.
  // homeSpread is the home team's line (negative when favoured).
  function impliedPoints(total, homeSpread) {
    return { home: total / 2 - homeSpread / 2, away: total / 2 + homeSpread / 2 };
  }

  // history: [{ week, actual, projected }] most recent first, under the
  // league's own scoring. Entries with no game (bye/DNP → actual null) or no
  // projection are skipped and the weights renormalised. Strength ramps in:
  // 0 with ≤1 completed week, full from 4 completed weeks.
  function formMultiplier(history, weeksPlayed) {
    var strength = clamp(((weeksPlayed || 0) - 1) / 3, 0, 1);
    if (!history || !history.length || strength === 0) {
      return { mult: 1, label: 'Form', detail: strength === 0 ? 'Too early in the season to weigh form' : 'No recent games', source: 'neutral' };
    }
    var wa = 0, wp = 0, wsum = 0, used = 0;
    for (var i = 0; i < history.length && i < FORM_WEIGHTS.length; i++) {
      var h = history[i];
      if (!h || h.actual == null || !(h.projected > 0)) continue;
      wa += FORM_WEIGHTS[i] * h.actual;
      wp += FORM_WEIGHTS[i] * h.projected;
      wsum += FORM_WEIGHTS[i];
      used++;
    }
    if (!used || wp <= 0) return { mult: 1, label: 'Form', detail: 'No recent games', source: 'neutral' };
    var ratio = clamp(wa / wp, FORM_MIN, FORM_MAX);
    var mult = 1 + (ratio - 1) * strength;
    return {
      mult: mult, label: 'Form', ratio: ratio, games: used,
      detail: 'Last ' + used + ' game' + (used > 1 ? 's' : '') + ': ' + (wa / wsum).toFixed(1) + ' actual vs ' + (wp / wsum).toFixed(1) + ' projected (' + Math.round(ratio * 100) + '%)' + (strength < 1 ? ', ' + Math.round(strength * 100) + '% weight this early' : ''),
      source: 'live',
    };
  }

  // defInjuries: { TEAM: [{ name, pos, slot, order, status }] } from /api/def-injuries.
  // A starting (order 1) key defender who is Out/IR/Doubtful boosts the
  // opposing WR (CB) or RB/TE (LB/S) once — it does not stack.
  function injuryModifier(status, pos, opponent, defInjuries) {
    var own = STATUS_MULT.hasOwnProperty(status) ? STATUS_MULT[status] : 1;
    var parts = [];
    if (own < 1) parts.push(status);
    var boost = 1, hit = null, hitGroup = null;
    var key = KEY_DEFENDERS[pos];
    var list = opponent && defInjuries ? defInjuries[opponent] : null;
    if (own > 0 && key && list && list.length) {
      for (var i = 0; i < list.length; i++) {
        var d = list[i];
        var group = DEF_SLOT_GROUP[d.slot] || DEF_SLOT_GROUP[d.pos];
        if (OUT_STATUS[d.status] && d.order === 1 && key.groups.indexOf(group) >= 0) { hit = d; hitGroup = group; break; }
      }
      if (hit) { boost = OPP_DEF_BOOST; parts.push(opponent + ' starting ' + hitGroup + ' ' + hit.name + ' (' + hit.slot + ') ' + hit.status.toLowerCase()); }
    }
    var mult = own * boost;
    var source = (own < 1 || boost > 1) ? 'live' : 'neutral';
    return {
      mult: mult, label: own < 1 ? 'Inj' : 'Opp', own: own, boost: boost, defender: hit, group: hitGroup,
      detail: parts.length ? parts.join(' · ') : 'Healthy, no key opponent injuries',
      source: source,
    };
  }

  // isHome: true / false from the schedule; null or undefined when unknown (bye, no feed).
  // Home teams score ~3% more fantasy points on average. Deliberately not shown
  // as a chip — it's too small to explain to users, it just nudges the ranking.
  function homeAwayMultiplier(isHome) {
    if (isHome == null) return { mult: 1, label: 'HA', detail: 'Home/away unknown', source: 'neutral' };
    var mult = isHome ? HOME_MULT : AWAY_MULT;
    return { mult: mult, label: 'HA', detail: isHome ? 'Home game (' + pct(mult) + ')' : 'Away game (' + pct(mult) + ')', source: 'live' };
  }

  // gameDate: 'YYYY-MM-DD' (Sleeper schedule) or anything Date can parse.
  // A Thursday game means both teams had four days' rest since Sunday — about
  // a 6% efficiency drop. Date-only strings parse as UTC midnight, so the UTC
  // weekday is the calendar day printed in the schedule. The season opener is
  // also a Thursday but follows a full offseason, so weeksPlayed 0 is exempt.
  function shortWeekMultiplier(gameDate, weeksPlayed) {
    if (!gameDate) return { mult: 1, label: 'TNF', detail: 'Game date unknown', source: 'neutral' };
    if (weeksPlayed === 0) return { mult: 1, label: 'TNF', detail: 'Season opener — full rest', source: 'neutral' };
    var d = new Date(gameDate);
    if (isNaN(d.getTime()) || d.getUTCDay() !== 4) return { mult: 1, label: 'TNF', detail: 'Not a Thursday game', source: 'neutral' };
    return { mult: SHORT_WEEK_MULT, label: 'TNF', detail: 'Thursday night game — short rest (' + pct(SHORT_WEEK_MULT) + ')', source: 'live' };
  }

  // weather: { windspeed (mph), precip (% chance), indoor } for the player's game
  // (the home stadium's forecast, from /api/weather). Wind and heavy rain hurt
  // passing offences (QB/WR/TE); strong wind nudges RBs up since more runs get
  // called. Indoor / retractable stadiums are immune.
  function weatherMultiplier(weather, pos) {
    if (!weather || weather.indoor) return { mult: 1, label: 'WX', detail: weather && weather.indoor ? 'Indoor stadium' : 'No forecast', source: 'neutral' };
    var wind = Number(weather.windspeed) || 0;
    var precip = Number(weather.precip) || 0;
    var passing = PASSING_POS.indexOf(pos) >= 0;
    var mult = 1;
    if (passing) {
      if (wind > 25) mult *= 0.82;
      else if (wind > 20) mult *= 0.89;
      else if (wind > 15) mult *= 0.94;
      if (precip > 50) mult *= 0.95;
    }
    if (pos === 'RB' && wind > 20) mult *= 1.04;
    if (mult === 1) return { mult: 1, label: 'WX', detail: 'Wind ' + Math.round(wind) + 'mph, ' + Math.round(precip) + '% rain — no impact', source: 'neutral' };
    var detail = 'Wind ' + Math.round(wind) + 'mph' + (precip > 50 ? ', ' + Math.round(precip) + '% chance of rain' : '') + ' (' + pct(mult) + ')';
    return { mult: mult, label: 'WX', wind: wind, precip: precip, detail: detail, source: 'live' };
  }

  // player: { id, position, team, injuryStatus }
  // ctx: {
  //   week, weeksPlayed,
  //   base            number   this week's projected points under league scoring
  //   opponent        string|null|undefined  (null = bye, undefined = schedule unknown)
  //   isHome          boolean|null   from the schedule
  //   gameDate        'YYYY-MM-DD'   from the schedule
  //   weather         { windspeed, precip, indoor } for this game
  //   fpa, vegas, defInjuries, history   see the factor functions above
  // }
  function computeLineupScore(player, ctx) {
    ctx = ctx || {};
    var pos = player.position;
    var base = Number(ctx.base) || 0;
    var bye = ctx.opponent === null;
    var matchup = matchupMultiplier(pos, ctx.opponent, ctx.fpa, ctx.weeksPlayed);
    var vegas = vegasMultiplier(player.team, ctx.vegas);
    var form = formMultiplier(ctx.history, ctx.weeksPlayed);
    var injury = injuryModifier(player.injuryStatus, pos, ctx.opponent, ctx.defInjuries);
    var homeAway = homeAwayMultiplier(bye ? null : ctx.isHome);
    var shortWeek = shortWeekMultiplier(bye ? null : ctx.gameDate, ctx.weeksPlayed);
    var weather = weatherMultiplier(bye ? null : ctx.weather, pos);
    var mult = matchup.mult * vegas.mult * form.mult * injury.mult * homeAway.mult * shortWeek.mult * weather.mult;
    var score = bye ? 0 : base * mult;
    return {
      score: score, base: base, mult: mult, bye: bye,
      factors: { matchup: matchup, vegas: vegas, form: form, injury: injury, homeAway: homeAway, shortWeek: shortWeek, weather: weather },
    };
  }

  // Start / Consider / Sit for a bench player relative to the weakest starter
  // he could replace. `starterScores` = scores of starters in slots he's
  // eligible for. Within 10% → Consider.
  function recommend(isStarter, score, starterScores) {
    if (isStarter) return 'start';
    if (!starterScores || !starterScores.length || !(score > 0)) return 'sit';
    var floor = Math.min.apply(null, starterScores);
    return score >= floor * 0.9 ? 'consider' : 'sit';
  }

  return {
    computeLineupScore: computeLineupScore,
    matchupMultiplier: matchupMultiplier,
    vegasMultiplier: vegasMultiplier,
    formMultiplier: formMultiplier,
    injuryModifier: injuryModifier,
    homeAwayMultiplier: homeAwayMultiplier,
    shortWeekMultiplier: shortWeekMultiplier,
    weatherMultiplier: weatherMultiplier,
    seasonWeight: seasonWeight,
    effectiveFPA: effectiveFPA,
    impliedPoints: impliedPoints,
    recommend: recommend,
    pct: pct,
    POS_BASELINE_FPA: POS_BASELINE_FPA,
  };
})();

if (typeof module !== 'undefined') module.exports = WeeklyScore;
