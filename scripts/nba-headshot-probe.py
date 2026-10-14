#!/usr/bin/env python3
"""U0: measure NBA headshot + team-logo CDN hit rates for a player sample.

  DATABASE_URL= PORT=7992 node --env-file=.env.local server.js &
  curl -s http://127.0.0.1:7992/api/nba/players > /tmp/nbap.json
  curl -s https://api.sleeper.app/v1/players/nba > /tmp/sleeper-nba.json
  python3 scripts/nba-headshot-probe.py   # -> docs/nba-ui/u0-headshot-probe.json

Sample: 10 stars, 10 role players (rank 91-100), 5 deep (rank 401-405), up to
8 rookies (Sleeper years_exp 0) and 6 Yahoo-only players (id "y<pid>").
ESPN ids come from the 30 ESPN team rosters, matched on normalised name.
"""
import json, hashlib, os, re, unicodedata, urllib.parse, urllib.request, urllib.error
import concurrent.futures as cf

OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'nba-ui', 'u0-headshot-probe.json')
P = json.load(open('/tmp/nbap.json'))['players']
SL = json.load(open('/tmp/sleeper-nba.json'))
UA = {'User-Agent': 'Mozilla/5.0'}


def get(url, tries=3):
    for i in range(tries):
        r = _get(url)
        if not str(r['status']).startswith('ERR'):
            return r
    return r


def _get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
            b = r.read()
            return {'status': r.status, 'type': r.headers.get('Content-Type'), 'bytes': len(b), 'md5': hashlib.md5(b).hexdigest()[:8]}
    except urllib.error.HTTPError as e:
        return {'status': e.code, 'type': e.headers.get('Content-Type'), 'bytes': 0, 'md5': None}
    except Exception as e:  # noqa: BLE001
        return {'status': 'ERR ' + str(e)[:40], 'bytes': 0, 'md5': None}


def norm(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'\b(jr|sr|ii|iii|iv)\b', '', s)
    return re.sub(r'[^a-z]', '', s)


def jget(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20))


teams = jget('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams')['sports'][0]['leagues'][0]['teams']
espn, abbrs = {}, {}


def roster(t):
    t = t['team']
    return t, jget(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{t['id']}/roster").get('athletes', [])


with cf.ThreadPoolExecutor(10) as ex:
    for t, aths in ex.map(roster, teams):
        abbrs[t['abbreviation']] = t['id']
        for a in aths:
            espn[norm(a['fullName'])] = {'id': a['id'], 'team': t['abbreviation']}

srt = sorted(P, key=lambda p: p.get('rank') or 9999)
rook = [p for p in srt if p['id'] in SL and SL[p['id']].get('years_exp') == 0][:8]
yonly = [p for p in srt if str(p['id']).startswith('y')][:6]
sample = ([('star', p) for p in srt[:10]] + [('role', p) for p in srt[90:100]] + [('deep', p) for p in srt[400:405]]
          + [('rookie', p) for p in rook] + [('yahoo-only', p) for p in yonly])


def probe(item):
    cat, p = item
    sid = None if str(p['id']).startswith('y') else p['id']
    e = espn.get(norm(p['name']))
    via = 'roster' if e else None
    if not e:  # not on an ESPN team roster page yet: ESPN's player search
        try:
            q = urllib.parse.quote(p['name'])
            it = (jget(f'https://site.web.api.espn.com/apis/common/v3/search?query={q}&type=player&sport=basketball&league=nba&limit=1').get('items') or [None])[0]
            if it and norm(it.get('displayName', '')) == norm(p['name']):
                e, via = {'id': it['id']}, 'search'
        except Exception:  # noqa: BLE001
            pass
    r = {'espnVia': via,'cat': cat, 'name': p['name'], 'team': p['team'], 'id': p['id'], 'yahooPid': p.get('yahooPid'), 'espnId': e and e['id']}
    r['sleeperThumb'] = get(f'https://sleepercdn.com/content/nba/players/thumb/{sid}.jpg') if sid else None
    r['sleeperFull'] = get(f'https://sleepercdn.com/content/nba/players/{sid}.jpg') if sid else None
    r['espn'] = get(f"https://a.espncdn.com/i/headshots/nba/players/full/{e['id']}.png") if e else None
    r['espnSmall'] = get(f"https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/{e['id']}.png&w=96&h=70") if e else None
    return r


with cf.ThreadPoolExecutor(4) as ex:
    res = list(ex.map(probe, sample))

logos = {}
for ab in sorted({p['team'] for p in P if p['team']}):
    logos[ab] = {'espn': get(f'https://a.espncdn.com/i/teamlogos/nba/500/{ab.lower()}.png')['status'],
                 'sleeper': get(f'https://sleepercdn.com/images/team_logos/nba/{ab.lower()}.png')['status']}

md5s = {}
for r in res:
    for k in ('sleeperThumb', 'sleeperFull', 'espn'):
        if r[k] and r[k]['md5']:
            md5s.setdefault(r[k]['md5'], set()).add(r['name'])
# the same bytes for two DIFFERENT players = a placeholder silhouette
dups = {k: sorted(v) for k, v in md5s.items() if len(v) > 1}


def ok(x):
    return bool(x) and x['status'] == 200 and x['bytes'] > 0 and x['md5'] not in dups


summary = {'n': len(res), 'sleeperThumb': sum(ok(r['sleeperThumb']) for r in res), 'sleeperFull': sum(ok(r['sleeperFull']) for r in res),
           'espnIdMatched': sum(1 for r in res if r['espnId']), 'espn': sum(ok(r['espn']) for r in res),
           'chain': sum(1 for r in res if ok(r['sleeperThumb']) or ok(r['espn'])), 'placeholderDups': dups}
json.dump({'summary': summary, 'sample': res, 'logos': logos, 'espnTeamIds': abbrs}, open(OUT, 'w'), indent=1)
print(json.dumps(summary))
for r in res:
    s, f, e = r['sleeperThumb'], r['sleeperFull'], r['espn']
    print(f"{r['cat']:10} {r['name'][:22]:22} {r['team'] or '-':4} sl={s and (s['status'], s['bytes'])} full={f and (f['status'], f['bytes'])} espn={r['espnId']} {e and (e['status'], e['bytes'])}")
print({k: v for k, v in logos.items() if v['espn'] != 200 or v['sleeper'] != 200} or 'all logos 200')
