/* Pocket NBA — draft board logic (Yahoo High Score).
   Pure functions only: no DOM, no fetch, no storage access. Loaded as a plain
   <script> in the browser (exposes window.NbaDraft) and via require() in node
   (scripts/test-nba-ui.js).

   Conventions
     pick     1-based overall pick number
     slot     1-based draft slot (team position in round 1)
     settings { teams, mySlot, slots: { G, F, UTIL }, bench }
     player   contract Player: { id, name, team, elig: ['G'|'F'|'UTIL'], hsValue,
              ceiling, floor, injury, tier, ... } */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NbaDraft = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORAGE_PREFIX = 'pocket-nba-draft:';
  var STATE_VERSION = 1;
  var SLOT_ORDER = ['G', 'F', 'UTIL'];

  var DEFAULT_SETTINGS = { teams: 10, mySlot: 1, slots: { G: 2, F: 3, UTIL: 1 }, bench: 4 };

  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  function normalizeSettings(s) {
    s = s || {};
    var slots = s.slots || {};
    var out = {
      teams: clampInt(s.teams, 2, 20, DEFAULT_SETTINGS.teams),
      mySlot: 1,
      slots: {
        G: clampInt(slots.G, 0, 6, DEFAULT_SETTINGS.slots.G),
        F: clampInt(slots.F, 0, 6, DEFAULT_SETTINGS.slots.F),
        UTIL: clampInt(slots.UTIL, 0, 6, DEFAULT_SETTINGS.slots.UTIL)
      },
      bench: clampInt(s.bench, 0, 15, DEFAULT_SETTINGS.bench)
    };
    out.mySlot = clampInt(s.mySlot, 1, out.teams, DEFAULT_SETTINGS.mySlot);
    return out;
  }

  function starterCount(settings) { return settings.slots.G + settings.slots.F + settings.slots.UTIL; }
  function rosterSize(settings) { return starterCount(settings) + settings.bench; }
  function totalPicks(settings) { return settings.teams * rosterSize(settings); }

  /* ---------------------------------------------------------------- snake */

  function roundOf(pick, teams) { return Math.ceil(pick / teams); }

  function slotForPick(pick, teams) {
    var r = roundOf(pick, teams);
    var idx = (pick - 1) % teams;
    return r % 2 === 1 ? idx + 1 : teams - idx;
  }

  function snakeOrder(teams, rounds) {
    var out = [];
    for (var p = 1; p <= teams * rounds; p++) {
      out.push({ pick: p, round: roundOf(p, teams), pickInRound: ((p - 1) % teams) + 1, slot: slotForPick(p, teams) });
    }
    return out;
  }

  // Overall pick numbers belonging to `slot`, at or after `fromPick`.
  function picksForSlot(slot, teams, rounds, fromPick) {
    var out = [];
    for (var r = 1; r <= rounds; r++) {
      var p = r % 2 === 1 ? (r - 1) * teams + slot : r * teams - slot + 1;
      if (p >= (fromPick || 1)) out.push(p);
    }
    return out;
  }

  // Next pick number >= currentPick owned by mySlot, or null when the draft is over for us.
  function nextPickFor(slot, currentPick, settings) {
    var list = picksForSlot(slot, settings.teams, rosterSize(settings), currentPick);
    return list.length ? list[0] : null;
  }

  /* ------------------------------------------------------- slot assignment */

  function eligFor(p) {
    var e = (p && p.elig) || [];
    return { G: e.indexOf('G') >= 0, F: e.indexOf('F') >= 0, UTIL: e.indexOf('UTIL') >= 0 || e.indexOf('G') >= 0 || e.indexOf('F') >= 0 };
  }

  function val(p) { return (p && typeof p.hsValue === 'number' && isFinite(p.hsValue)) ? p.hsValue : 0; }

  /* Assign roster players to starter slots to maximise starter hsValue.
     Greedy by value with one-step augmenting swaps: a dual G/F player sitting in
     G moves to an open F (or UTIL) so a pure G can start. Exact for the slot
     shapes Yahoo High Score uses (G/F/UTIL, dual eligibility).
     Returns { starters: [{slot, player|null}], bench: [player], open: {G,F,UTIL}, total } */
  function assignSlots(roster, settings) {
    settings = normalizeSettings(settings);
    var slots = [];
    SLOT_ORDER.forEach(function (s) { for (var i = 0; i < settings.slots[s]; i++) slots.push({ slot: s, player: null }); });
    var sorted = (roster || []).slice().sort(function (a, b) { return val(b) - val(a); });
    var bench = [];

    function freeIdx(type) {
      for (var i = 0; i < slots.length; i++) if (slots[i].slot === type && !slots[i].player) return i;
      return -1;
    }

    sorted.forEach(function (p) {
      var e = eligFor(p);
      var i = -1;
      // Positional slot first (G before F only when not dual — dual players take the scarcer open one).
      if (e.G && e.F) {
        var g = freeIdx('G'), f = freeIdx('F');
        i = f >= 0 ? f : g; // F is the 3-slot position; leaves G open for pure guards
      } else if (e.G) i = freeIdx('G');
      else if (e.F) i = freeIdx('F');
      if (i < 0 && e.UTIL) i = freeIdx('UTIL');
      if (i < 0) {
        // Augment: move a dual starter from a slot p can use into another open slot.
        for (var k = 0; k < slots.length && i < 0; k++) {
          var s = slots[k];
          if (!s.player || s.slot === 'UTIL' || !e[s.slot]) continue;
          var se = eligFor(s.player);
          var alt = -1;
          ['G', 'F', 'UTIL'].forEach(function (t) { if (alt < 0 && t !== s.slot && se[t]) alt = freeIdx(t); });
          if (alt >= 0) { slots[alt].player = s.player; s.player = null; i = k; }
        }
      }
      if (i >= 0) slots[i].player = p; else bench.push(p);
    });

    // Swap pass: a bench player beats a weaker starter if eligible for that slot.
    var changed = true, guard = 0;
    while (changed && guard++ < 20) {
      changed = false;
      for (var b = 0; b < bench.length; b++) {
        var bp = bench[b], be = eligFor(bp);
        for (var j = 0; j < slots.length; j++) {
          var sp = slots[j].player;
          if (sp && be[slots[j].slot] && val(bp) > val(sp)) { slots[j].player = bp; bench[b] = sp; changed = true; break; }
        }
      }
    }

    var open = { G: 0, F: 0, UTIL: 0 }, total = 0;
    slots.forEach(function (s) { if (!s.player) open[s.slot]++; else total += val(s.player); });
    bench.sort(function (a, b) { return val(b) - val(a); });
    return { starters: slots, bench: bench, open: open, total: total };
  }

  function starterTotal(roster, settings) { return assignSlots(roster, settings).total; }

  /* -------------------------------------------------- best available (VONA) */

  var INJ_FACTOR = { OUT: 0.55, O: 0.55, IR: 0.5, INJ: 0.6, SUS: 0.6, D: 0.8, DTD: 0.9, GTD: 0.9, Q: 0.92, QUESTIONABLE: 0.92, P: 0.97, PROBABLE: 0.97 };
  function injuryFactor(inj) {
    if (!inj) return 1;
    var k = String(inj).toUpperCase().replace(/[^A-Z]/g, '');
    if (INJ_FACTOR[k] != null) return INJ_FACTOR[k];
    if (k.indexOf('OUT') === 0) return INJ_FACTOR.OUT;
    if (k.indexOf('DAY') >= 0) return INJ_FACTOR.DTD;
    return 0.9;
  }
  function injuryShort(inj) {
    if (!inj) return '';
    var k = String(inj).toUpperCase();
    if (/OUT|^O$|IR/.test(k)) return 'OUT';
    if (/SUS/.test(k)) return 'SUS';
    if (/DAY|DTD|GTD/.test(k)) return 'GTD';
    if (/^Q|QUEST/.test(k)) return 'Q';
    if (/^P|PROB/.test(k)) return 'P';
    if (/^D|DOUBT/.test(k)) return 'D';
    return k.slice(0, 3);
  }

  // Which slot type p would occupy if added to roster ('G'|'F'|'UTIL'|'BENCH').
  function filledSlot(roster, p, settings) {
    var a = assignSlots(roster.concat([p]), settings);
    for (var i = 0; i < a.starters.length; i++) if (a.starters[i].player === p) return a.starters[i].slot;
    return 'BENCH';
  }

  function ordinal(n) { return ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth'][n] || (n + 'th'); }
  function fmt1(n) { return (Math.round(n * 10) / 10).toFixed(1); }

  /* Rank available players for my next pick.
     score = starter gain now + 0.6 x (gain now − gain from the best same-slot
     player still expected at my following pick) + ceiling bias, x injury factor.
     opts: { picksUntilNext: number of other picks before my following turn,
             nextPick: overall number of that pick (for the reason text),
             ceilingBias: 0..1 (default 0.35), limit } */
  function bestAvailable(available, myRoster, settings, opts) {
    settings = normalizeSettings(settings);
    opts = opts || {};
    var bias = opts.ceilingBias == null ? 0.35 : opts.ceilingBias;
    var k = Math.max(0, opts.picksUntilNext == null ? settings.teams - 1 : opts.picksUntilNext);
    var roster = myRoster || [];
    if (roster.length >= rosterSize(settings)) return [];
    var base = starterTotal(roster, settings);
    var pool = (available || []).slice().sort(function (a, b) { return val(b) - val(a); });
    // Candidates: the top of the board is enough (and keeps this O(60·roster)).
    var cands = pool.slice(0, Math.max(60, (opts.limit || 3) * 4));
    var later = pool.slice(k); // assume others take the top-k by value before we pick again

    var bestLater = {}; // slot type -> top-2 [{gain, player}] (2nd is used when the candidate is the 1st)
    later.slice(0, 80).forEach(function (q) {
      var s = filledSlot(roster, q, settings);
      var g = starterTotal(roster.concat([q]), settings) - base;
      var top = bestLater[s] || (bestLater[s] = []);
      top.push({ gain: g, player: q });
      top.sort(function (x, y) { return y.gain - x.gain; });
      if (top.length > 2) top.length = 2;
    });

    var benchLine = later.length ? val(later[0]) : 0;
    var out = cands.map(function (p) {
      var slot = filledSlot(roster, p, settings);
      var gain = starterTotal(roster.concat([p]), settings) - base;
      var top = bestLater[slot] || [];
      var ref = top[0] && top[0].player === p ? top[1] : top[0];
      var refGain = ref ? ref.gain : 0;
      var vona = gain - refGain;
      var ceil = typeof p.ceiling === 'number' ? p.ceiling : val(p);
      var upside = Math.max(0, ceil - val(p)) * 0.1 * bias;
      var score;
      if (slot === 'BENCH') score = 0.35 * Math.max(0, val(p) - benchLine * 0.9) + upside + val(p) * 0.01;
      else score = gain + 0.6 * vona + upside;
      score *= injuryFactor(p.injury);
      return { player: p, slot: slot, gain: gain, vona: vona, score: score };
    });
    out.sort(function (a, b) { return b.score - a.score || val(b.player) - val(a.player); });
    out = out.slice(0, opts.limit || 3);
    out.forEach(function (r) { r.reason = reasonFor(r, roster, settings, opts); });
    return out;
  }

  function reasonFor(r, roster, settings, opts) {
    var p = r.player;
    var ceil = typeof p.ceiling === 'number' ? Math.round(p.ceiling) : null;
    var inj = injuryShort(p.injury);
    var parts;
    if (r.slot === 'BENCH') {
      parts = ['Starters set — best bench upside' + (ceil != null ? ' (ceiling ' + ceil + ')' : '')];
    } else {
      var filled = 0;
      assignSlots(roster, settings).starters.forEach(function (s) { if (s.slot === r.slot && s.player) filled++; });
      var head = r.slot === 'UTIL' ? 'Fills UTIL' : 'Your ' + ordinal(filled + 1) + ' ' + r.slot;
      var tail = r.vona > 0.05
        ? '+' + fmt1(r.vona) + ' over the best ' + r.slot + ' likely left at ' + (opts.nextPick ? '#' + opts.nextPick : 'your next pick')
        : 'value holds — ' + r.slot + ' depth is deep';
      parts = [head, tail];
      if (ceil != null && ceil - val(p) >= 12) parts.push('ceiling ' + ceil);
    }
    if (inj) parts.push(inj === 'OUT' ? 'currently OUT' : inj + ' tag');
    return parts.join(' · ');
  }

  /* ------------------------------------------------------ balance warnings */

  /* players: full player list (drafted + available) for starter-grade lines.
     ctx: { available, picksUntilNext }
     Returns [{ level: 'danger'|'warn'|'info', text }] most severe first. */
  function balanceWarnings(myRoster, settings, ctx) {
    settings = normalizeSettings(settings);
    ctx = ctx || {};
    var roster = myRoster || [];
    var a = assignSlots(roster, settings);
    var picksLeft = rosterSize(settings) - roster.length;
    var openTotal = a.open.G + a.open.F + a.open.UTIL;
    var out = [];
    if (picksLeft <= 0) return out;

    if (openTotal > picksLeft) {
      out.push({ level: 'danger', text: picksLeft + ' pick' + (picksLeft === 1 ? '' : 's') + ' left for ' + openTotal + ' open starter slots' });
    }

    ['F', 'G'].forEach(function (pos) {
      var open = a.open[pos];
      if (!open) return;
      var filled = settings.slots[pos] - open;
      var urgent = picksLeft - openTotal <= 1 || roster.length >= Math.ceil(rosterSize(settings) / 2);
      if (urgent) out.push({ level: 'warn', text: 'Needs a ' + ordinal(filled + 1) + ' ' + pos + (open > 1 ? ' (' + open + ' ' + pos + ' slots open)' : '') });
    });

    // Positional scarcity: starter-grade = top (teams x starter slots for pos) eligible by value.
    var avail = ctx.available || [];
    var all = ctx.players || avail;
    var k = ctx.picksUntilNext == null ? settings.teams - 1 : ctx.picksUntilNext;
    ['F', 'G'].forEach(function (pos) {
      if (!a.open[pos]) return;
      var eligAll = all.filter(function (p) { return eligFor(p)[pos]; }).sort(function (x, y) { return val(y) - val(x); });
      var line = eligAll[Math.min(eligAll.length - 1, settings.teams * settings.slots[pos] - 1)];
      if (!line) return;
      var grade = avail.filter(function (p) { return eligFor(p)[pos] && val(p) >= val(line); }).length;
      if (grade <= k + a.open[pos]) {
        out.push({ level: grade <= k ? 'warn' : 'info', text: pos + ' is drying up: ' + grade + ' starter-grade ' + pos + ' left, ' + k + ' picks before your turn' });
      }
    });

    // One-position-heavy bench: more single-position players than they can start.
    ['G', 'F'].forEach(function (pos) {
      var other = pos === 'G' ? 'F' : 'G';
      var only = roster.filter(function (p) { var e = eligFor(p); return e[pos] && !e[other]; }).length;
      var cap = settings.slots[pos] + settings.slots.UTIL;
      if (only > cap + 1) out.push({ level: 'info', text: (pos === 'G' ? 'Guard' : 'Forward') + '-heavy: ' + only + ' ' + pos + '-only players for ' + cap + ' startable ' + pos + '/UTIL slots' });
    });

    var rank = { danger: 0, warn: 1, info: 2 };
    out.sort(function (x, y) { return rank[x.level] - rank[y.level]; });
    return out;
  }

  /* ------------------------------------------------------ Yahoo pick merge */

  /* Merge Yahoo draft results (truth) with locally tracked manual picks.
     yahoo:    { picks: [{pick, round, team_key, player_key, sleeperId|null, name, matchConfidence}], unmatched: [...] } | null
     manual:   [{ playerId, mine, at }] in the order they were marked
     ctx:      { settings, myTeamKey, overrides: {player_key: sleeperId}, playersById }
     Returns {
       picks: [{ pick, round, slot, playerId|null, name, mine, source: 'yahoo'|'manual', confirmed, player_key?, team_key? }],
       unmatched: [{ pick, player_key, name, team_key }],
       confirmedManual: [playerId]   // manual picks Yahoo has now confirmed (caller prunes)
     } */
  function mergePicks(yahoo, manual, ctx) {
    ctx = ctx || {};
    var settings = normalizeSettings(ctx.settings);
    var overrides = ctx.overrides || {};
    var byId = ctx.playersById || {};
    var out = [], unmatched = [], seen = {}, confirmed = [];

    var ypicks = (yahoo && yahoo.picks ? yahoo.picks : []).filter(function (p) { return p && p.pick > 0; })
      .slice().sort(function (a, b) { return a.pick - b.pick; });
    var lastPick = 0;
    ypicks.forEach(function (yp) {
      if (seen['#' + yp.pick]) return; // duplicate pick number from a flaky poll
      seen['#' + yp.pick] = 1;
      var id = yp.sleeperId != null && yp.sleeperId !== '' ? String(yp.sleeperId) : (overrides[yp.player_key] != null ? String(overrides[yp.player_key]) : null);
      if (id && seen[id]) id = null; // same player twice → treat the later one as unmatched
      if (id) seen[id] = 1;
      var row = {
        pick: yp.pick, round: yp.round || roundOf(yp.pick, settings.teams), slot: slotForPick(yp.pick, settings.teams),
        playerId: id, name: (id && byId[id] && byId[id].name) || yp.name || 'Unknown player',
        mine: !!(ctx.myTeamKey && yp.team_key === ctx.myTeamKey), source: 'yahoo', confirmed: true,
        player_key: yp.player_key, team_key: yp.team_key
      };
      if (!id) unmatched.push({ pick: yp.pick, player_key: yp.player_key, name: row.name, team_key: yp.team_key });
      out.push(row);
      lastPick = Math.max(lastPick, yp.pick);
    });

    // Server-reported unmatched entries not already represented by a pick.
    (yahoo && yahoo.unmatched ? yahoo.unmatched : []).forEach(function (u) {
      if (!u || !u.player_key || overrides[u.player_key] != null) return;
      if (unmatched.some(function (x) { return x.player_key === u.player_key; })) return;
      if (out.some(function (x) { return x.player_key === u.player_key && x.playerId; })) return;
      unmatched.push({ pick: u.pick || null, player_key: u.player_key, name: (u.name && u.name.full) || u.name || 'Unknown player', team_key: u.team_key || null });
    });

    // With Yahoo's remaining order (keepers / traded picks), pending manual
    // picks fill the next open Yahoo slots, owner included; otherwise they
    // follow Yahoo's last pick on the snake.
    var open = openSlots(yahoo);
    var n = lastPick, oi = 0;
    open.forEach(function (o) { n = Math.max(n, o.pick); });
    if (!open.length) n = lastPick;
    (manual || []).forEach(function (m) {
      if (!m || m.playerId == null) return;
      var id = String(m.playerId);
      if (seen[id]) { if (yahoo) confirmed.push(id); return; }
      seen[id] = 1;
      var o = open[oi++], pk;
      if (o) pk = o.pick; else { n++; pk = n; }
      var row = {
        pick: pk, round: (o && o.round) || roundOf(pk, settings.teams), slot: slotForPick(pk, settings.teams),
        playerId: id, name: (byId[id] && byId[id].name) || m.name || id,
        mine: !!m.mine, source: 'manual', confirmed: !yahoo
      };
      if (o && o.team_key) row.team_key = o.team_key;
      out.push(row);
    });

    out.sort(function (a, b) { return a.pick - b.pick; });
    return { picks: out, unmatched: unmatched, confirmedManual: confirmed };
  }

  // Yahoo's unfilled pick slots in pick order: [{pick, round, team_key}].
  function openSlots(yahoo) {
    if (!yahoo || !Array.isArray(yahoo.order)) return [];
    var seenPick = {};
    (yahoo.picks || []).forEach(function (p) { if (p && p.pick) seenPick[p.pick] = 1; });
    return yahoo.order.filter(function (o) { return o && o.pick > 0 && !seenPick[o.pick]; })
      .slice().sort(function (a, b) { return a.pick - b.pick; });
  }

  /* Who is on the clock according to Yahoo (draft order with team_key per
     pick), so keepers and traded picks are right. pending = local picks not
     yet confirmed by Yahoo (they occupy the next open slots).
     Returns null when Yahoo gave no order (caller falls back to the snake), else
     { cur, round, teamKey, total, done, onMe, myNext, myAfter, myNextRound,
       awayN (picks before my next), gapNow (others' picks between now and my
       following pick when I'm up), gapNext (others' picks between my next two) } */
  function yahooClock(yahoo, myTeamKey, pending) {
    var open = openSlots(yahoo);
    var picks = (yahoo && yahoo.picks) || [];
    // No open slots listed: only trust that as "draft over" when Yahoo says
    // postdraft; otherwise Yahoo just didn't send future slots → snake fallback.
    if (!open.length && !(yahoo && yahoo.status === 'postdraft' && picks.length)) return null;
    var total = 0;
    picks.forEach(function (p) { if (p && p.pick > total) total = p.pick; });
    open.forEach(function (o) { if (o.pick > total) total = o.pick; });
    var k = Math.max(0, pending || 0);
    var rest = open.slice(k);
    if (!rest.length) return { cur: total + 1, round: null, teamKey: null, total: total, done: true, onMe: false, myNext: null, myAfter: null, myNextRound: null, awayN: null, gapNow: 0, gapNext: 0 };
    var now = rest[0];
    var mineIdx = [];
    rest.forEach(function (o, i) { if (myTeamKey && o.team_key === myTeamKey) mineIdx.push(i); });
    var i0 = mineIdx.length ? mineIdx[0] : -1, i1 = mineIdx.length > 1 ? mineIdx[1] : -1;
    return {
      cur: now.pick, round: now.round || null, teamKey: now.team_key || null, total: total, done: false,
      onMe: !!myTeamKey && now.team_key === myTeamKey,
      myNext: i0 >= 0 ? rest[i0].pick : null, myAfter: i1 >= 0 ? rest[i1].pick : null,
      myNextRound: i0 >= 0 ? rest[i0].round || null : null,
      awayN: i0 >= 0 ? i0 : null,
      gapNow: i0 === 0 ? (i1 >= 0 ? i1 - 1 : 0) : 0,
      gapNext: i0 >= 0 && i1 >= 0 ? i1 - i0 - 1 : 0
    };
  }

  /* Auction leagues: Yahoo settings or draft results say so. The board has no
     nomination/bidding model yet, so the page drops to manual mode. */
  function isAuction(league, yahoo) {
    if (league && (league.is_auction_draft === true || league.is_auction_draft === 1 || league.is_auction_draft === '1' ||
        /auction/i.test(String(league.draft_type || '')) || (league.settings && (league.settings.is_auction_draft === true || /auction/i.test(String(league.settings.draft_type || '')))))) return true;
    return !!(yahoo && (yahoo.auction === true || (yahoo.picks || []).some(function (p) { return p && p.cost != null; })));
  }

  /* ---------------------------------------------------------- pick timer */
  var DEFAULT_PICK_SECONDS = 60;
  function normalizeTimerSeconds(v) {
    var n = parseInt(v, 10);
    if (!isFinite(n) || n < 0) return DEFAULT_PICK_SECONDS;
    return Math.min(600, n); // 0 = off
  }
  // { running, left (whole seconds), level: 'off'|'idle'|'ok'|'warn'|'urgent'|'expired', text }
  function timerState(startedAt, seconds, now) {
    seconds = normalizeTimerSeconds(seconds);
    if (!seconds) return { running: false, left: 0, level: 'off', text: '' };
    if (!startedAt) return { running: false, left: seconds, level: 'idle', text: fmtClock(seconds) };
    var left = Math.ceil((startedAt + seconds * 1000 - now) / 1000);
    if (left <= 0) return { running: true, left: 0, level: 'expired', text: '0:00' };
    var level = left <= 10 ? 'urgent' : left <= Math.max(15, Math.round(seconds / 3)) ? 'warn' : 'ok';
    return { running: true, left: left, level: level, text: fmtClock(left) };
  }
  function fmtClock(s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  /* ----------------------------------------------------- yahoo league map */

  // Yahoo roster_positions → settings.slots/bench. Accepts [{position,count}],
  // ['G','G',...] or {G:2,...}. Unknown starter positions (C, PG...) count as UTIL.
  function settingsFromYahoo(league, myTeamKey, teams, prev) {
    var s = normalizeSettings(prev);
    if (!league) return s;
    var num = parseInt(league.num_teams, 10);
    if (num > 1) s.teams = Math.min(20, num);
    var rp = league.roster_positions;
    // An empty list ([] or {}) means Yahoo didn't send positions: keep current settings.
    if (rp && (Array.isArray(rp) ? rp.length : Object.keys(rp).length)) {
      var counts = {};
      if (Array.isArray(rp)) rp.forEach(function (x) {
        var pos = typeof x === 'string' ? x : (x.position || x.roster_position && x.roster_position.position);
        var c = typeof x === 'string' ? 1 : parseInt(x.count || (x.roster_position && x.roster_position.count) || 1, 10);
        if (pos) counts[pos] = (counts[pos] || 0) + c;
      });
      else Object.keys(rp).forEach(function (k) { counts[k] = parseInt(rp[k], 10) || 0; });
      var g = counts.G || 0, f = counts.F || 0, u = 0, bench = 0;
      Object.keys(counts).forEach(function (k) {
        if (k === 'G' || k === 'F') return;
        if (k === 'BN' || k === 'IL' || k === 'IL+' || k === 'IR') { if (k === 'BN') bench += counts[k]; return; }
        u += counts[k];
      });
      if (g + f + u > 0) s.slots = { G: Math.min(6, g), F: Math.min(6, f), UTIL: Math.min(6, u) };
      s.bench = Math.min(15, bench);
    }
    if (myTeamKey && Array.isArray(teams)) {
      var mine = teams.filter(function (t) { return t.team_key === myTeamKey; })[0];
      var dp = mine && parseInt(mine.draft_position, 10);
      if (dp >= 1 && dp <= s.teams) s.mySlot = dp;
    }
    return normalizeSettings(s);
  }

  /* --------------------------------------------------------- persistence */

  function storageKey(leagueKey) { return STORAGE_PREFIX + (leagueKey || 'manual'); }

  function emptyState(leagueKey, settings) {
    return { v: STATE_VERSION, leagueKey: leagueKey || null, settings: normalizeSettings(settings), manual: [], overrides: {}, yahoo: null, updatedAt: 0 };
  }

  function serializeState(st) {
    return JSON.stringify({
      v: STATE_VERSION,
      leagueKey: st.leagueKey || null,
      settings: normalizeSettings(st.settings),
      manual: (st.manual || []).filter(function (m) { return m && m.playerId != null; })
        .map(function (m) { return { playerId: String(m.playerId), mine: !!m.mine, at: m.at || 0, name: m.name || undefined }; }),
      overrides: st.overrides || {},
      yahoo: st.yahoo ? { status: st.yahoo.status, picks: st.yahoo.picks || [], unmatched: st.yahoo.unmatched || [], polledAt: st.yahoo.polledAt || null } : null,
      updatedAt: st.updatedAt || Date.now()
    });
  }

  // Never throws: corrupt / foreign / older data yields a fresh state.
  function deserializeState(raw, leagueKey, defaults) {
    var fresh = emptyState(leagueKey, defaults);
    if (!raw) return fresh;
    var o;
    try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return fresh; }
    if (!o || typeof o !== 'object' || o.v !== STATE_VERSION) return fresh;
    if ((o.leagueKey || null) !== (leagueKey || null)) return fresh;
    return {
      v: STATE_VERSION,
      leagueKey: leagueKey || null,
      settings: normalizeSettings(o.settings || defaults),
      manual: Array.isArray(o.manual) ? o.manual.filter(function (m) { return m && m.playerId != null; }).map(function (m) { return { playerId: String(m.playerId), mine: !!m.mine, at: m.at || 0, name: m.name }; }) : [],
      overrides: o.overrides && typeof o.overrides === 'object' ? o.overrides : {},
      yahoo: o.yahoo && Array.isArray(o.yahoo.picks) ? o.yahoo : null,
      updatedAt: o.updatedAt || 0
    };
  }

  /* ---------------------------------------------------------- polling */

  var POLL_MS = 4000;
  // Delay before the next poll after `failures` consecutive errors (0 = healthy).
  function pollDelay(failures) {
    if (!failures) return POLL_MS;
    return Math.min(30000, POLL_MS * Math.pow(2, failures));
  }

  function agoText(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return 'just now';
    var s = Math.floor(ms / 1000);
    if (s < 2) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
  }

  /* ------------------------------------------------------------ search */

  function normName(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }

  function matchesQuery(p, q) {
    q = normName(q);
    if (!q) return true;
    var hay = normName(p.name) + ' ' + normName(p.team);
    return q.split(' ').every(function (t) { return hay.indexOf(t) >= 0; });
  }

  // Board filter: 'ALL' | 'G' | 'F' | 'UTIL' (UTIL = everyone eligible for UTIL, i.e. all).
  function matchesPos(p, pos) {
    if (!pos || pos === 'ALL') return true;
    return !!eligFor(p)[pos];
  }

  return {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS, STORAGE_PREFIX: STORAGE_PREFIX, POLL_MS: POLL_MS,
    normalizeSettings: normalizeSettings, starterCount: starterCount, rosterSize: rosterSize, totalPicks: totalPicks,
    roundOf: roundOf, slotForPick: slotForPick, snakeOrder: snakeOrder, picksForSlot: picksForSlot, nextPickFor: nextPickFor,
    eligFor: eligFor, assignSlots: assignSlots, starterTotal: starterTotal,
    injuryFactor: injuryFactor, injuryShort: injuryShort,
    bestAvailable: bestAvailable, balanceWarnings: balanceWarnings,
    mergePicks: mergePicks, settingsFromYahoo: settingsFromYahoo,
    openSlots: openSlots, yahooClock: yahooClock, isAuction: isAuction,
    DEFAULT_PICK_SECONDS: DEFAULT_PICK_SECONDS, normalizeTimerSeconds: normalizeTimerSeconds, timerState: timerState,
    storageKey: storageKey, emptyState: emptyState, serializeState: serializeState, deserializeState: deserializeState,
    pollDelay: pollDelay, agoText: agoText, normName: normName, matchesQuery: matchesQuery, matchesPos: matchesPos
  };
});
