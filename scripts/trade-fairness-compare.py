import json, sys
# usage: python3 scripts/trade-fairness-compare.py [dir with health-{1qb,sf,dyn}.json from scripts/trade-calc-health.js --json]
DIR = sys.argv[1] if len(sys.argv) > 1 else '/tmp/blend'
# Fairness: model verdict (final value, ±10 % FAIR band) vs FantasyCalc-only verdict (raw FC sum, same band; and FC-analyzer style +750 per open roster spot to the side receiving fewer players)
WAIVER = 750
def verdict(g, r):
    m = max(g, r, 1); d = (r - g) / m
    return ('FAIR' if abs(d) <= 0.10 else 'WIN' if d > 0.10 else 'LOSE'), d
def run(fmt, trades):
    d = json.load(open(f'{DIR}/health-{fmt}.json'))
    ps = {p['name']: p for p in d['players']}
    bypos = {}
    for p in d['players']:
        bypos.setdefault(p['pos'], []).append(p)
    for k in bypos: bypos[k].sort(key=lambda p: p['marketRank'])
    def pick(spec):
        if isinstance(spec, str): return ps[spec]
        pos, r = spec; return bypos[pos][r - 1]
    print(f"\n=== {fmt} ===")
    rows = []
    for label, give, recv in trades:
        try:
            G = [pick(s) for s in give]; R = [pick(s) for s in recv]
            # a named player that resolves to the same rank slot as the partner: shift the partner one rank down
            for i, r in enumerate(R):
                if any(r is g for g in G) and isinstance(recv[i], tuple):
                    pos, rk = recv[i]; R[i] = bypos[pos][rk]
        except (KeyError, IndexError) as e:
            print('  skip', label, e); continue
        mg, mr = sum(p['final'] for p in G), sum(p['final'] for p in R)
        fg, fr = sum(p['fc'] for p in G), sum(p['fc'] for p in R)
        # FC analyzer style: the side receiving fewer players gets +750 per spot
        ag, ar = fg, fr
        if len(R) < len(G): ar += WAIVER * (len(G) - len(R))
        elif len(G) < len(R): ag += WAIVER * (len(R) - len(G))
        mv, md = verdict(mg, mr); fv, fd = verdict(fg, fr); av, ad = verdict(ag, ar)
        names = lambda L: ' + '.join(f"{p['name']} ({p['pos']}{p['marketRank']}{', ' + p['status'] if p['status'] else ''}{', inj' + format(p['injMult'], '.2f') if p['injMult'] != 1 else ''}{', form' + format(p['formMult'], '.2f') if p['formMult'] != 1 else ''})" for p in L)
        flag = '' if mv == fv else '  <-- DISAGREE'
        print(f"  {label}\n     give {names(G)}\n     recv {names(R)}\n     model {mg} vs {mr} -> {mv} ({md:+.1%}) | FC sum {fg} vs {fr} -> {fv} ({fd:+.1%}) | FC+waiver {ag} vs {ar} -> {av} ({ad:+.1%}){flag}")
        rows.append((label, mv, md, fv, fd, av, ad))
    n = len(rows); agree = sum(1 for r in rows if r[1] == r[3]); agreeA = sum(1 for r in rows if r[1] == r[5])
    print(f"  agreement model vs FC-sum {agree}/{n}; vs FC+waiver {agreeA}/{n}")
T1 = [
    ('1-for-1 WR3 for RB4', [('WR', 3)], [('RB', 4)]),
    ('1-for-1 RB8 for WR8', [('RB', 8)], [('WR', 8)]),
    ('1-for-1 TE1 for WR6', [('TE', 1)], [('WR', 6)]),
    ('1-for-1 QB3 for WR10', [('QB', 3)], [('WR', 10)]),
    ('1-for-1 QB1 for RB3', [('QB', 1)], [('RB', 3)]),
    ('1-for-1 QB12 for WR24', [('QB', 12)], [('WR', 24)]),
    ('1-for-1 WR12 for RB14', [('WR', 12)], [('RB', 14)]),
    ('1-for-1 WR30 for RB30 (tail)', [('WR', 30)], [('RB', 30)]),
    ('1-for-1 Etienne (IR) for RB-rank-23', ['Travis Etienne'], [('RB', 23)]),
    ('1-for-1 Rashee Rice (Out) for WR26', ['Rashee Rice'], [('WR', 26)]),
    ('1-for-1 Davante Adams (IR) for WR25', ['Davante Adams'], [('WR', 25)]),
    ('1-for-1 Nabers for WR7', ['Malik Nabers'], [('WR', 7)]),
    ('1-for-1 Pickens for WR16', ['George Pickens'], [('WR', 16)]),
    ('1-for-1 Evans (Out) for WR21', ['Mike Evans'], [('WR', 21)]),
    ('2-for-1 RB9 + WR15 for RB2', [('RB', 9), ('WR', 15)], [('RB', 2)]),
    ('2-for-1 WR7 + RB12 for WR1', [('WR', 7), ('RB', 12)], [('WR', 1)]),
    ('2-for-1 WR10 + WR20 for WR4', [('WR', 10), ('WR', 20)], [('WR', 4)]),
    ('2-for-1 RB15 + WR25 for RB6', [('RB', 15), ('WR', 25)], [('RB', 6)]),
    ('3-for-2 RB5 + WR20 + WR30 for WR4 + RB15', [('RB', 5), ('WR', 20), ('WR', 30)], [('WR', 4), ('RB', 15)]),
    ('3-for-2 WR8 + RB18 + TE8 for RB7 + WR14', [('WR', 8), ('RB', 18), ('TE', 8)], [('RB', 7), ('WR', 14)]),
    ('3-for-1 WR12 + WR22 + RB25 for RB1', [('WR', 12), ('WR', 22), ('RB', 25)], [('RB', 1)]),
]
TSF = T1 + [
    ('SF: QB4 for RB3', [('QB', 4)], [('RB', 3)]),
    ('SF: QB8 + WR12 for QB2', [('QB', 8), ('WR', 12)], [('QB', 2)]),
    ('SF: QB12 for WR6', [('QB', 12)], [('WR', 6)]),
    ('SF: QB16 for RB12', [('QB', 16)], [('RB', 12)]),
    ('SF: QB20 + QB24 for QB10', [('QB', 20), ('QB', 24)], [('QB', 10)]),
]
TDYN = T1 + [
    ('DYN: Evans (33) for WR-rank-30', ['Mike Evans'], [('WR', 30)]),
    ('DYN: RB rank 10 for WR rank 10', [('RB', 10)], [('WR', 10)]),
    ('DYN: Henry (32) for RB12', ['Derrick Henry'], [('RB', 12)]),
    ('DYN: Diggs (32) for WR40', ['Stefon Diggs'], [('WR', 40)]),
]
run('1qb', T1); run('sf', TSF); run('dyn', TDYN)
