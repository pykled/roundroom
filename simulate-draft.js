#!/usr/bin/env node
// simulate-draft.js — 12-team PPR snake draft simulation for RoundRoom.
// Faithful port of the scoring engine in index.html (v2 algorithm):
//   score = adjustedVORP × W_strategy × M_need × M_urgency × M_target
// Outputs CSV to stdout:
//   pick_no,round,slot,team_strategy,player_name,position,nfl_team,adp,vorp,strategy_weight,final_score

const fs = require('fs');
const path = require('path');

// ===== League config (12-team, PPR, 1QB/2RB/3WR/1TE/1FLEX/1K/1DST, non-SF) =====
const TEAMS = 12;
const ROUNDS = 15;
const SCORING = 'ppr';
const IS_SF = false;
const LEAGUE_SETTINGS = {
  slots_qb: 1, slots_rb: 2, slots_wr: 3, slots_te: 1,
  slots_flex: 1, slots_super_flex: 0, slots_k: 1, slots_def: 1, slots_bn: 5,
};
const STRATEGY_BY_SLOT = { 3: 'hero_rb', 7: 'zero_rb', 11: 'robust_rb' };

// ===== Load data (same files served by /api/composite-adp and /api/vorp) =====
const DATA_DIR = path.join(__dirname, 'data');
const adpJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'composite_adp.json'), 'utf8'));
const vorpJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'vorp.json'), 'utf8'));

// Mirror of the mock-draft load path in index.html
const adpPlayers = (adpJson.players || []).map(p => ({
  name: p.name, position: p.position, team: p.team || '',
  adp: p.composite_adp || p.sleeper_adp || p.fantasypros_adp || 999,
  stdev: p.stdev || 2.0,
  composite_adp: p.composite_adp ?? null,
  composite_sf_adp: p.composite_sf_adp ?? null,
  player_id: p.player_id || null,
})).filter(p => p.position && ['QB','RB','WR','TE','K','DST','DEF','PK'].includes(p.position));

const mergedPlayers = adpPlayers.map((p, idx) => ({ ...p, rank: idx + 1, sleeper_id: p.player_id }));

// Live VORP map keyed by lowercase name (as built in index.html)
const vorpMap = {};
(vorpJson.players || []).forEach(p => {
  if (p && p.name) vorpMap[p.name.toLowerCase()] = { vorp_std: p.vorp_std, vorp_sf: p.vorp_sf };
});

// ===== Hardcoded tables from index.html (fallbacks) =====
const PROJ_PTS = {
  'Jahmyr Gibbs':372.6,'Bijan Robinson':372.0,'Christian McCaffrey':334.8,
  'Jonathan Taylor':312.4,"De'Von Achane":292.0,'Chase Brown':279.2,
  'Ashton Jeanty':276.8,'Derrick Henry':273.1,'James Cook III':270.2,'James Cook':270.2,
  'Saquon Barkley':266.1,'Omarion Hampton':258.0,'Jeremiyah Love':249.0,
  'Kenneth Walker III':245.0,'Breece Hall':226.0,'Josh Jacobs':218.0,
  'Cam Skattebo':238.0,'Kyren Williams':234.0,'Javonte Williams':228.0,
  'Travis Etienne Jr.':224.0,'Bucky Irving':218.0,"D'Andre Swift":215.0,
  'Quinshon Judkins':204.0,'Bhayshul Tuten':202.0,'TreVeyon Henderson':196.0,
  'Jaylen Warren':184.0,'David Montgomery':181.0,'Tony Pollard':178.0,
  'Jadarian Price':174.0,'Rico Dowdle':170.0,'Chuba Hubbard':163.0,
  'Rhamondre Stevenson':180.0,'RJ Harvey':172.0,'J.K. Dobbins':165.0,
  'Aaron Jones Sr.':162.0,'Kenny Gainwell':156.0,'Rachaad White':152.0,
  'Kyle Monangai':138.0,'Jonathon Brooks':130.0,
  'Puka Nacua':339.8,"Ja'Marr Chase":336.1,'Jaxon Smith-Njigba':324.0,
  'Amon-Ra St. Brown':319.6,'Drake London':289.1,'Rashee Rice':273.3,
  'CeeDee Lamb':272.8,'Justin Jefferson':269.6,'Chris Olave':257.8,
  'A.J. Brown':257.4,'George Pickens':210.0,'Nico Collins':206.0,
  'Zay Flowers':202.0,'Garrett Wilson':200.0,'DeVonta Smith':196.0,
  'Malik Nabers':192.0,'Emeka Egbuka':188.0,'Tetairoa McMillan':188.0,
  'Davante Adams':180.0,'Tee Higgins':183.0,'Jameson Williams':175.0,
  'Ladd McConkey':172.0,'Terry McLaurin':168.0,'Rome Odunze':165.0,
  'Jaylen Waddle':163.0,'DJ Moore':160.0,'Luther Burden III':157.0,
  'Alec Pierce':155.0,'Mike Evans':153.0,'Courtland Sutton':150.0,
  'Marvin Harrison Jr.':147.0,'DK Metcalf':143.0,'Christian Watson':138.0,
  'Michael Pittman Jr.':134.0,"Wan'Dale Robinson":128.0,'Jakobi Meyers':122.0,
  'Brian Thomas Jr.':122.0,'Carnell Tate':120.0,'Parker Washington':116.0,
  'Michael Wilson':114.0,'Jayden Reed':112.0,'Deebo Samuel Sr.':110.0,
  'Stefon Diggs':109.0,'Josh Downs':108.0,'Jordyn Tyson':107.0,
  'Khalil Shakir':105.0,'Quentin Johnston':103.0,'Jordan Addison':101.0,
  'Xavier Worthy':99.0,"De'Zhaun Stribling":95.0,'Tank Dell':90.0,
  'Makai Lemon':88.0,'Matthew Golden':85.0,
  'Josh Allen':372.2,'Drake Maye':326.9,'Jayden Daniels':325.5,
  'Lamar Jackson':325.0,'Jalen Hurts':320.6,'Jaxson Dart':311.8,
  'Joe Burrow':310.9,'Brock Purdy':307.4,'Dak Prescott':306.1,
  'Trevor Lawrence':304.0,'Patrick Mahomes':298.0,'Justin Herbert':291.7,
  'Tua Tagovailoa':282.0,'Bo Nix':275.0,'Jordan Love':268.0,
  'Caleb Williams':249.0,'Kyler Murray':265.0,
  'Cam Ward':240.0,'C.J. Stroud':245.0,'Baker Mayfield':238.0,
  'Trey McBride':254.3,'Brock Bowers':243.8,'Colston Loveland':209.3,
  'Tyler Warren':202.2,'Kyle Pitts Sr.':195.6,'Kyle Pitts':195.6,'Harold Fannin Jr.':188.5,
  'Sam LaPorta':183.5,'Travis Kelce':181.8,'Dallas Goedert':179.3,
  'Tucker Kraft':175.3,'George Kittle':168.0,'Mark Andrews':162.0,
  'Isaiah Likely':155.0,'Dalton Kincaid':150.0,'Pat Freiermuth':145.0,
  'Jake Ferguson':140.0,'Evan Engram':135.0,'Tyler Higbee':131.0,
};

const VORP_TABLE = {
  'Jahmyr Gibbs':240,'Bijan Robinson':240,'Christian McCaffrey':203,
  'Jonathan Taylor':180,"De'Von Achane":160,'Chase Brown':147,
  'Ashton Jeanty':145,'Derrick Henry':141,'James Cook III':138,'James Cook':138,
  'Saquon Barkley':134,'Omarion Hampton':126,'Jeremiyah Love':117,
  'Kenneth Walker III':113,'Breece Hall':94,'Josh Jacobs':86,
  'Cam Skattebo':106,'Kyren Williams':102,'Javonte Williams':96,
  'Travis Etienne Jr.':92,'Bucky Irving':86,"D'Andre Swift":83,
  'Quinshon Judkins':72,'Bhayshul Tuten':70,'TreVeyon Henderson':64,
  'Jaylen Warren':52,'David Montgomery':49,'Tony Pollard':46,
  'Jadarian Price':42,'Rico Dowdle':38,'Chuba Hubbard':31,
  'Rhamondre Stevenson':48,'RJ Harvey':40,'J.K. Dobbins':33,
  'Aaron Jones Sr.':30,'Kenny Gainwell':24,'Rachaad White':20,
  'Kyle Monangai':6,'Jonathon Brooks':0,
  'Puka Nacua':183,"Ja'Marr Chase":179,'Jaxon Smith-Njigba':167,
  'Amon-Ra St. Brown':163,'Drake London':132,'CeeDee Lamb':116,
  'Rashee Rice':117,'Justin Jefferson':113,'Chris Olave':101,
  'A.J. Brown':101,'George Pickens':53,'Nico Collins':49,
  'Zay Flowers':45,'Garrett Wilson':43,'DeVonta Smith':39,
  'Malik Nabers':35,'Emeka Egbuka':31,'Tetairoa McMillan':31,
  'Davante Adams':23,'Tee Higgins':26,'Jameson Williams':18,
  'Ladd McConkey':15,'Terry McLaurin':11,'Rome Odunze':8,
  'Jaylen Waddle':6,'DJ Moore':3,'Luther Burden III':0,
  'Alec Pierce':0,'Mike Evans':0,'Courtland Sutton':0,
  'Marvin Harrison Jr.':0,'DK Metcalf':0,'Christian Watson':0,
  'Michael Pittman Jr.':0,"Wan'Dale Robinson":0,'Jakobi Meyers':0,
  'Brian Thomas Jr.':0,'Carnell Tate':0,'Parker Washington':0,
  'Michael Wilson':0,'Jayden Reed':0,'Deebo Samuel Sr.':0,
  'Stefon Diggs':0,'Josh Downs':0,'Jordyn Tyson':0,
  'Khalil Shakir':0,'Quentin Johnston':0,'Jordan Addison':0,'Xavier Worthy':0,
  'Trey McBride':102,'Brock Bowers':92,'Colston Loveland':57,
  'Tyler Warren':50,'Kyle Pitts Sr.':44,'Kyle Pitts':44,'Harold Fannin Jr.':37,
  'Sam LaPorta':32,'Travis Kelce':30,'Dallas Goedert':27,
  'Tucker Kraft':23,'George Kittle':16,'Jake Ferguson':0,
  'Isaiah Likely':0,'Mark Andrews':10,'Dalton Kincaid':0,
  'Josh Allen':83,'Drake Maye':37,'Jayden Daniels':36,
  'Lamar Jackson':35,'Jalen Hurts':31,'Jaxson Dart':22,
  'Joe Burrow':21,'Brock Purdy':18,'Dak Prescott':16,
  'Trevor Lawrence':14,'Patrick Mahomes':8,'Justin Herbert':2,
};

const PROJ_PTS_BY_RANK = {
  RB:[372,372,335,312,292,279,277,273,270,266,250,242,234,226,218,210,202,194,186,178,170,163,156,149,142,135,129,123,118,113,108,104,100,96,93,89,86,83,80,77],
  WR:[340,336,324,320,289,273,273,270,258,257,248,238,230,222,214,206,199,192,185,179,173,167,162,156,150,145,140,135,130,125,121,117,113,110,107,104,101,98,95,92],
  QB:[372,327,326,325,321,312,311,307,306,304,298,292,282,275,268,261,255,249,243,238,232,227,222,217],
  TE:[254,244,209,202,196,189,184,182,179,175,168,160,153,145,138,131,125,119,113,107],
};

const VOR_BASELINES = { QB: 12, RB: 36, WR: 48, TE: 12, K: 14, DST: 12 };

const F_SCORING = {
  ppr:      { RB: 1.00, WR: 1.00, TE: 1.00, QB: 1.00, K: 1.00, DST: 1.00 },
  half_ppr: { RB: 1.04, WR: 0.90, TE: 0.92, QB: 1.00, K: 1.00, DST: 1.00 },
  standard: { RB: 1.08, WR: 0.80, TE: 0.84, QB: 1.00, K: 1.00, DST: 1.00 },
};

const F_SIZE = {
  QB: { 8: 0.70, 10: 0.85, 12: 1.00, 14: 1.15 },
  RB: { 8: 0.80, 10: 0.90, 12: 1.00, 14: 1.12 },
  WR: { 8: 0.82, 10: 0.92, 12: 1.00, 14: 1.10 },
  TE: { 8: 0.75, 10: 0.88, 12: 1.00, 14: 1.18 },
};

// ===== Ported engine functions =====

// Sim stand-in for STATE fields the engine reads
const STATE = {
  lastPickCount: 0,
  strategy: 'bpa',
  isSuperflex: IS_SF,
  rosterConfig: null,
  mergedPlayers,
};

function deriveRosterConfig(settings, isSuperflex) {
  const s = settings || {};
  const num = (v, d) => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : d;
  const starters = {
    QB:   num(s.slots_qb, 1),
    RB:   num(s.slots_rb, 2),
    WR:   num(s.slots_wr, 2),
    TE:   num(s.slots_te, 1),
    FLEX: num(s.slots_flex, 1),
    SF:   num(s.slots_super_flex, isSuperflex ? 1 : 0),
    K:    num(s.slots_k, 1),
    DST:  num(s.slots_def, 1),
  };
  const bench = num(s.slots_bn, 5);
  const flexEligible = ['RB', 'WR', 'TE'];
  const sfEligible = ['QB', 'RB', 'WR', 'TE'];
  const targetMin = {
    QB: starters.QB, RB: starters.RB, WR: starters.WR, TE: starters.TE,
    K: starters.K, DST: starters.DST,
  };
  const flexShare = { RB: 0.45, WR: 0.45, TE: 0.10 };
  flexEligible.forEach(p => { targetMin[p] += starters.FLEX * flexShare[p]; });
  const sfShare = { QB: 0.85, RB: 0.05, WR: 0.05, TE: 0.05 };
  sfEligible.forEach(p => { targetMin[p] += starters.SF * sfShare[p]; });
  const totalStarters = starters.QB + starters.RB + starters.WR + starters.TE +
                        starters.FLEX + starters.SF + starters.K + starters.DST;
  const flexForRB = Math.round(starters.FLEX * 0.45);
  const flexForWR = Math.round(starters.FLEX * 0.45);
  const hardCap = {
    QB:  starters.QB + starters.SF + 1,
    RB:  starters.RB + flexForRB + 2,
    WR:  starters.WR + flexForWR + 2,
    TE:  starters.TE + 1,
    K:   starters.K,
    DST: starters.DST,
  };
  return { starters, bench, totalRoster: totalStarters + bench, targetMin, hardCap,
           hasKicker: starters.K > 0, hasDST: starters.DST > 0, flexEligible, sfEligible };
}
STATE.rosterConfig = deriveRosterConfig(LEAGUE_SETTINGS, IS_SF);

function _normCDF(z) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const erf = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return 0.5 * (1 + sign * erf);
}

function calcSurvivalProbability(player, nextPickNum) {
  if (!player || !nextPickNum) return 0.5;
  const adp = (STATE.isSuperflex && player.composite_sf_adp != null)
    ? player.composite_sf_adp
    : (player.composite_adp || player.adp || 999);
  const stdev = Math.max(player.stdev || 15, 1);
  const picksUntilNext = nextPickNum - (STATE.lastPickCount + 1);
  if (picksUntilNext <= 0) return 0;
  const z = (nextPickNum - adp) / stdev;
  return Math.max(0.01, Math.min(0.99, 1 - _normCDF(z)));
}

function getProjectedPts(player, allPlayers) {
  const name = player.name || '';
  if (PROJ_PTS[name] !== undefined) return PROJ_PTS[name];
  const norm = s => s.toLowerCase().replace(/\./g,'').replace(/['’]/g,"'").replace(/\s+/g,' ').trim();
  const nName = norm(name);
  for (const [k, v] of Object.entries(PROJ_PTS)) {
    if (norm(k) === nName) return v;
  }
  const tokens = name.trim().split(/\s+/);
  const lastName = tokens[tokens.length - 1].toLowerCase();
  const pos = player.position;
  const lnMatches = Object.entries(PROJ_PTS).filter(([k]) =>
    k.split(' ').slice(-1)[0].toLowerCase() === lastName
  );
  if (lnMatches.length === 1) {
    const clean = s => s.toLowerCase().replace(/[^a-z]/g, '');
    const fi = clean(tokens[0]);
    const mf = clean(lnMatches[0][0].split(' ')[0]);
    if (tokens.length === 1 || fi === mf) return lnMatches[0][1];
  }
  const table = PROJ_PTS_BY_RANK[pos];
  if (!table) return 100;
  const posRank = (allPlayers || [])
    .filter(p => p.position === pos && (p.rank || 999) < (player.rank || 999))
    .length + 1;
  return table[Math.min(posRank - 1, table.length - 1)] || table[table.length - 1];
}

// Live VORP index (mirrors _computeVorpLookup priority: live map, then tables)
const _vorpLiveIndex = {};
{
  const norm = s => s.toLowerCase().replace(/\./g,'').replace(/['']/g,"'").trim();
  for (const [k, v] of Object.entries(vorpMap)) _vorpLiveIndex[norm(k)] = v;
}

function lookupVorp(name, pos) {
  if (!name) return null;
  const norm = s => s.toLowerCase().replace(/\./g,'').replace(/['']/g,"'").trim();
  const nLive = norm(name);
  const v = _vorpLiveIndex[nLive];
  if (v) {
    const val = (STATE.isSuperflex && v.vorp_sf != null) ? v.vorp_sf : v.vorp_std;
    if (val != null) return val;
  }
  if (VORP_TABLE[name] !== undefined) return VORP_TABLE[name];
  const n = norm(name);
  for (const [k, val] of Object.entries(VORP_TABLE)) {
    if (norm(k) === n) return val;
  }
  const tokens = name.trim().split(/\s+/);
  const last = tokens[tokens.length - 1].toLowerCase();
  const matches = Object.entries(VORP_TABLE).filter(([k]) =>
    k.split(' ').slice(-1)[0].toLowerCase() === last
  );
  if (matches.length === 1) {
    const clean = s => s.toLowerCase().replace(/[^a-z]/g, '');
    const fi = clean(tokens[0]);
    const mf = clean(matches[0][0].split(' ')[0]);
    if (tokens.length === 1 || fi === mf) return matches[0][1];
  }
  return null;
}

function calcVOR(player, available) {
  const direct = lookupVorp(player.name, player.position);
  if (direct !== null) return direct;
  const pos = player.position;
  const depth = VOR_BASELINES[pos] || 12;
  const byPos = available.filter(p => p.position === pos).sort((a, b) => (a.rank||999) - (b.rank||999));
  const baseline = byPos[depth - 1] || byPos[byPos.length - 1];
  const allP = STATE.mergedPlayers || available;
  const playerPts = getProjectedPts(player, allP);
  const baselinePts = baseline
    ? getProjectedPts(baseline, allP)
    : (PROJ_PTS_BY_RANK[pos]?.slice(-1)[0] || 80);
  return playerPts - baselinePts;
}

function sizeFactor(pos, teams) {
  const row = F_SIZE[pos];
  if (!row) return 1.0;
  if (row[teams] != null) return row[teams];
  if (teams <= 8) return row[8];
  if (teams >= 14) return row[14];
  const keys = [8, 10, 12, 14];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (teams > a && teams < b) return row[a] + (row[b] - row[a]) * ((teams - a) / (b - a));
  }
  return 1.0;
}

function adjustVorpValue(rawVorp, pos, scoringType, totalTeams, isSuperflex) {
  const sc = F_SCORING[scoringType] || F_SCORING.ppr;
  const fScore = sc[pos] != null ? sc[pos] : 1.0;
  let fSize = sizeFactor(pos, totalTeams);
  if (isSuperflex && pos === 'QB' && totalTeams > 12) {
    fSize *= Math.pow(1.05, (totalTeams - 12) / 2);
  }
  return rawVorp * fScore * fSize;
}

function positionReq(pos, isSuperflex) {
  const rc = STATE.rosterConfig;
  if (rc && rc.targetMin && rc.targetMin[pos] != null) return Math.max(0.1, rc.targetMin[pos]);
  const flexShare = { RB: 0.45, WR: 0.45, TE: 0.10 };
  if (pos === 'QB') return isSuperflex ? 2.0 : 1.0;
  if (pos === 'RB') return 2 + flexShare.RB;
  if (pos === 'WR') return 2 + flexShare.WR;
  if (pos === 'TE') return 1 + flexShare.TE;
  return 1.0;
}

function needGap(pos, ctx) {
  return Math.max(0, positionReq(pos, ctx.isSuperflex) - (ctx.counts[pos] || 0));
}

function needMultiplier(pos, ctx) {
  const rc = STATE.rosterConfig;
  const have = ctx.counts[pos] || 0;
  if (rc?.hardCap) {
    const cap = rc.hardCap[pos];
    if (cap != null && have >= cap) return 0.05;
  } else {
    if (pos === 'DST' && have >= (rc?.DST ?? 1)) return 0.05;
    if (pos === 'K'   && have >= (rc?.K   ?? 1)) return 0.05;
  }
  if (pos === 'K' || pos === 'DST') return 1.0;
  const req = positionReq(pos, ctx.isSuperflex);
  const gap = Math.max(0, req - have);
  let mNeed = 0.6 + 0.5 * Math.min(1, gap / req);
  let totalGaps = 0;
  ['QB', 'RB', 'WR', 'TE'].forEach(p => { totalGaps += Math.ceil(needGap(p, ctx)); });
  if (gap > 0 && (ctx.picksLeft - totalGaps) <= 1) mNeed = Math.max(mNeed, 1.45);
  if ((pos === 'RB' || pos === 'WR') && have >= Math.ceil(req) + 2) mNeed = 0.5;
  if (pos === 'TE' && have >= Math.ceil(req) + 1) mNeed = 0.5;
  if (pos === 'QB' && !ctx.isSuperflex && have >= Math.ceil(req) + 1) mNeed = 0.5;
  if (pos === 'RB' || pos === 'WR' || pos === 'TE') {
    const others = ['RB', 'WR', 'TE'].filter(p => p !== pos);
    const mySurplus = have - positionReq(pos, ctx.isSuperflex);
    const maxDeficit = Math.max(0, ...others.map(p =>
      positionReq(p, ctx.isSuperflex) - (ctx.counts[p] || 0)
    ));
    if (mySurplus >= 1 && maxDeficit >= 0.5) {
      const imbalance = Math.min(mySurplus, 2.5);
      mNeed *= Math.max(0.45, 1 - 0.12 * imbalance);
    }
  }
  return Math.max(0.4, Math.min(1.6, mNeed));
}

function urgencyMultiplier(player, ctx) {
  const pos = player.position;
  const runActive = (ctx.runCounts[pos] || 0) >= 3;
  const shrink = runActive ? 0.7 : 1.0;
  const surv = (pl, atPick) => {
    if (!atPick) return 1.0;
    const p = shrink !== 1.0 ? { ...pl, stdev: Math.max((pl.stdev || 15) * shrink, 1) } : pl;
    return calcSurvivalProbability(p, atPick);
  };
  const picksUntilDecision = ctx.decisionPick != null ? (ctx.decisionPick - ctx.currentPick) : 0;
  let ownSurv;
  if (ctx.onClock || picksUntilDecision > 2) {
    ownSurv = 1.0;
  } else if (ctx.followingPick && (ctx.followingPick - ctx.decisionPick) <= 3) {
    ownSurv = Math.max(surv(player, ctx.decisionPick), 0.85 * surv(player, ctx.followingPick));
  } else {
    ownSurv = surv(player, ctx.decisionPick);
  }
  const expectedValue = 0.3 + 0.7 * ownSurv;
  const tierThresh = { QB: 18, RB: 15, WR: 12, TE: 20 }[pos] || 15;
  const tierMeasure = ctx.followingPick || (ctx.onClock ? null : ctx.decisionPick);
  let tierFactor = 1.0, tierCount = 1, tierSurvivors = 99;
  const list = ctx.byPos[pos];
  if (list && list.length && tierMeasure) {
    const key = player.sleeper_id || player.name;
    const idx = list.findIndex(x => (x.p.sleeper_id || x.p.name) === key);
    if (idx >= 0) {
      let start = idx, end = idx;
      while (start > 0 && (list[start - 1].pts - list[start].pts) < tierThresh) start--;
      while (end < list.length - 1 && (list[end].pts - list[end + 1].pts) < tierThresh) end++;
      tierCount = end - start + 1;
      tierSurvivors = 0;
      for (let i = start; i <= end; i++) {
        if (i === idx) continue;
        tierSurvivors += surv(list[i].p, tierMeasure);
      }
      if (tierSurvivors < 0.75) tierFactor = 1.30;
      else if (tierSurvivors < 1.5) tierFactor = 1.15;
    }
  }
  const runFactor = runActive && needGap(pos, ctx) > 0 ? 1.10 : 1.0;
  const mUrgency = Math.max(0.25, Math.min(1.5, expectedValue * tierFactor * runFactor));
  return { mUrgency, tierCount, tierSurvivors, tierFactor, runActive };
}

function getStrategyWeight(player, ctx) {
  const pos = player.position;
  let strategy = STATE.strategy || ctx.strategy;
  if (ctx.isSuperflex && (!strategy || strategy === 'bpa')) strategy = 'superflex';
  if (!ctx.isSuperflex && (strategy === 'superflex' || strategy === 'superflex_punt')) strategy = 'bpa';
  const isSF = ctx.isSuperflex;
  const effRound = ctx.round + ctx.roundShift;
  const rbCount = ctx.counts.RB, wrCount = ctx.counts.WR,
        qbCount = ctx.counts.QB, teCount = ctx.counts.TE;
  const playerAdp = player.adp || 999;
  const rank = player.rank || 999;

  if (pos === 'K')   return (effRound < 13 || ctx.counts.K   >= (STATE.rosterConfig?.K   ?? 1)) ? 0.05 : 1.0;
  if (pos === 'DST') return (effRound < 12 || ctx.counts.DST >= (STATE.rosterConfig?.DST ?? 1)) ? 0.05 : 1.0;
  if (pos === 'TE' && effRound <= 2 && playerAdp > 25 && !isSF) return 0.08;
  if (pos === 'QB' && effRound <= 2 && !isSF) return 0.08;

  let w = 1.0;

  if (strategy === 'zero_rb') {
    if (pos === 'RB')      w = effRound <= 3 ? 0.10 : (effRound <= 6 ? 1.7 : 1.0);
    else if (pos === 'WR') w = effRound <= 4 ? 1.6 : 1.0;
    else if (pos === 'TE') w = teCount === 0 ? (effRound >= 2 ? 1.5 : 1.0) : 0.3;
    else if (pos === 'QB') w = qbCount >= 1 ? 0.3 : ((effRound >= 4 && effRound <= 6) ? 1.2 : 1.0);
  } else if (strategy === 'hero_rb') {
    const hasHero = ctx.hasHeroRB;
    if (pos === 'RB') {
      if (effRound <= 3) {
        w = (!hasHero && rank <= 20) ? 2.5 : 0.15;
      } else if (effRound <= 5) {
        w = hasHero && rbCount < 2 ? 0.75 : (rbCount < 2 ? 0.35 : 0.15);
      } else if (effRound <= 9) {
        w = rbCount < 2 ? 1.35 : (rbCount < 3 ? 0.55 : 0.15);
      } else {
        w = rbCount < 2 ? 0.85 : (rbCount < 4 ? 0.25 : 0.12);
      }
    } else if (pos === 'WR') {
      w = hasHero ? (effRound <= 4 ? 1.5 : 1.2) : 1.0;
    } else if (pos === 'QB') {
      if (qbCount === 0) w = effRound <= 7 ? 0.45 : 0.70;
      else w = 0.2;
    }
  } else if (strategy === 'robust_rb') {
    if (pos === 'RB')      w = rbCount < 4 ? (effRound <= 3 ? 2.0 : (effRound <= 6 ? 1.55 : 1.2)) : 0.5;
    else if (pos === 'WR') w = (rbCount >= 3 && wrCount < 3 && effRound <= 6) ? 1.4 : 1.0;
    else if (pos === 'TE') w = (teCount === 0 && effRound >= 4) ? 1.3 : 1.0;
    else if (pos === 'QB') w = qbCount >= 1 ? 0.3 : (effRound <= 6 ? 0.5 : 1.0);
  } else { // bpa (default)
    if (pos === 'QB') {
      if (qbCount >= 1)         w = 0.3;
      else if (effRound <= 5)   w = 0.45;
      else if (effRound <= 8)   w = 0.9;
      else                      w = 1.15;
    } else if (pos === 'TE' && teCount >= 1) w = 0.25;
  }

  return Math.max(0.05, Math.min(3.0, w));
}

function computeScoreBreakdown(player, ctx, available) {
  const rawVorp   = calcVOR(player, available);
  const base      = adjustVorpValue(rawVorp, player.position, ctx.scoringType, ctx.totalTeams, ctx.isSuperflex);
  const wStrategy = getStrategyWeight(player, ctx);
  const mNeed     = needMultiplier(player.position, ctx);
  const urg       = urgencyMultiplier(player, ctx);
  const mTarget   = 1.0; // no user targets in simulation
  const combo = Math.max(0.02, Math.min(4.0, wStrategy * mNeed * urg.mUrgency));
  const score = base * combo * mTarget;
  return { score, rawVorp, base, wStrategy, mNeed, mUrgency: urg.mUrgency, mTarget };
}

// ===== Draft simulation =====

function snakePicks(slot) {
  const picks = [];
  for (let r = 1; r <= ROUNDS; r++) {
    picks.push((r - 1) * TEAMS + (r % 2 === 1 ? slot : TEAMS + 1 - slot));
  }
  return picks;
}

const teams = [];
for (let slot = 1; slot <= TEAMS; slot++) {
  teams.push({
    slot,
    strategy: STRATEGY_BY_SLOT[slot] || 'bpa',
    myPickNumbers: snakePicks(slot),
    counts: { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 },
    roster: [],
  });
}

const draftedKeys = new Set();
const allPicks = []; // { player, position } in draft order
const rows = [];
rows.push('pick_no,round,slot,team_strategy,player_name,position,nfl_team,adp,vorp,strategy_weight,final_score');

const csvEsc = s => /[",]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s;

for (let pickNo = 1; pickNo <= TEAMS * ROUNDS; pickNo++) {
  const round = Math.ceil(pickNo / TEAMS);
  const slotIdx = (round % 2 === 1) ? ((pickNo - 1) % TEAMS) : (TEAMS - 1 - ((pickNo - 1) % TEAMS));
  const team = teams[slotIdx];

  STATE.lastPickCount = pickNo - 1;
  STATE.strategy = team.strategy;

  const available = mergedPlayers.filter(p => !draftedKeys.has(p.sleeper_id || p.name));

  // Build scoring context — mirrors buildScoringContext() for the on-clock team
  const currentPick = pickNo;
  const decisionPick = team.myPickNumbers.find(p => p >= currentPick) || null;
  const onClock = decisionPick !== null && decisionPick === currentPick;
  const followingPick = decisionPick != null
    ? (team.myPickNumbers.filter(p => p > decisionPick)[0] || null)
    : null;
  const picksLeft = team.myPickNumbers.filter(p => p >= currentPick).length;

  const recentPositions = allPicks.slice(-5).map(p => (p.position || '').replace('DEF', 'DST'));
  const runCounts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  recentPositions.forEach(pos => { if (runCounts[pos] !== undefined) runCounts[pos]++; });

  const byPos = {};
  ['QB', 'RB', 'WR', 'TE'].forEach(pos => {
    byPos[pos] = available
      .filter(p => p.position === pos)
      .map(p => ({ p, pts: getProjectedPts(p, mergedPlayers) }))
      .sort((a, b) => b.pts - a.pts);
  });

  const ctx = {
    isMock: true, totalTeams: TEAMS, totalRounds: ROUNDS, isSuperflex: IS_SF,
    scoringType: SCORING, currentPick, round, roundShift: (TEAMS - 12) / 2,
    myPickNumbers: team.myPickNumbers, decisionPick, followingPick, onClock,
    picksLeft, counts: team.counts,
    hasHeroRB: team.roster.some(p => p.position === 'RB' && (p.rank || 999) <= 20),
    runCounts, byPos, allP: mergedPlayers, strategy: team.strategy,
  };

  // Score all available; pick the top. Tie-break by overall rank (ADP order),
  // matching the stable sort of the rank-ordered board in the app.
  let best = null, bestParts = null;
  for (const p of available) {
    const parts = computeScoreBreakdown(p, ctx, available);
    if (!best || parts.score > bestParts.score ||
        (parts.score === bestParts.score && (p.rank || 999) < (best.rank || 999))) {
      best = p; bestParts = parts;
    }
  }

  draftedKeys.add(best.sleeper_id || best.name);
  team.counts[best.position] = (team.counts[best.position] || 0) + 1;
  team.roster.push(best);
  allPicks.push({ player: best, position: best.position });

  rows.push([
    pickNo, round, team.slot, team.strategy,
    csvEsc(best.name), best.position, best.team || '',
    (best.adp || 999).toFixed(2),
    bestParts.rawVorp.toFixed(1),
    bestParts.wStrategy.toFixed(2),
    bestParts.score.toFixed(1),
  ].join(','));
}

process.stdout.write(rows.join('\n') + '\n');

// Roster summaries to stderr so they don't pollute the CSV
teams.forEach(t => {
  const c = t.counts;
  process.stderr.write(
    `slot ${String(t.slot).padStart(2)} [${t.strategy.padEnd(9)}] ` +
    `QB:${c.QB} RB:${c.RB} WR:${c.WR} TE:${c.TE} K:${c.K} DST:${c.DST} ` +
    `other:${t.roster.length - c.QB - c.RB - c.WR - c.TE - c.K - c.DST}\n`);
});
