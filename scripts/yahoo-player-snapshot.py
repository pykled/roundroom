# Read-only Yahoo player-list snapshot for league 242808, via the signed-in OpenClaw browser (CDP :18800).
# Usage: python3 scripts/yahoo-player-snapshot.py data/nba/yahoo-snapshot-242808.json  (needs python playwright; browser logged into Yahoo)
# Paced (450ms/page), GET-only, no writes to Yahoo. No credentials are stored or read by this script.
import json, sys, datetime
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]
JS = """async () => {
  const num=s=>{ if(s==null) return null; const t=String(s).replace(/[,%]/g,'').trim(); if(t===''||t==='-') return null; const v=Number(t); return isNaN(v)?null:v; };
  const strip=s=>s.replace(/\\s+/g,' ').trim();
  const out=[]; const seen=new Set();
  for(let off=0; off<=700; off+=25){
    const url='/nba/242808/players?status=ALL&eteam=ALL&fteam=NONE&pos=P&cut_type=33&stat1=S_PSR&myteam=0&sort=AR&sdir=1&count='+off;
    let h; try{ const r=await fetch(url,{credentials:'include'}); h=await r.text(); }catch(e){ break; }
    const d=new DOMParser().parseFromString(h,'text/html');
    const tbl=[...d.querySelectorAll('table')].filter(t=>t.querySelectorAll('tbody tr').length>=5 && /Fan Pts|Pre-Season/i.test(t.innerText))[0];
    if(!tbl) break;
    let added=0;
    for(const tr of tbl.querySelectorAll('tbody tr')){
      const tds=[...tr.querySelectorAll('td')]; if(tds.length<10) continue;
      const a=tr.querySelector('a[href*="/players/"], a.name, a[href*="/nba/players/"]');
      const nm=a?strip(a.textContent):null; const href=a?(a.getAttribute('href')||''):''; const pid=(href.match(/players\\/(\\d+)/)||[])[1]||null;
      const info=strip((tr.querySelector('.ysf-player-name')||tds[1]||{}).textContent||'');
      const m=info.match(/([A-Z]{2,4})\\s*-\\s*([A-Za-z,\\/]+)\\s*$/);
      const c=tds.map(x=>strip(x.textContent)).slice(2);
      const key=pid||nm; if(!key||seen.has(key)) continue; seen.add(key);
      let tag=''; const i0=info.indexOf(nm); const rest=i0>=0?info.slice(i0+nm.length):''; const mm=rest.match(/^(.*?)(New\\s*)?Player Note/); if(mm) tag=(mm[1]||'').trim();
      out.push({pid,name:nm,team:m?m[1]:null,pos:m?m[2]:null,tag,isNew:/New\\s*Player Note/.test(info),status:c[2]||null,gp:num(c[3]),fanPts:num(c[4]),preRank:num(c[5]),curRank:num(c[6]),pctRos:num(c[7]),pts:num(c[9]),reb:num(c[10]),ast:num(c[11]),stl:num(c[12]),blk:num(c[13]),to:num(c[14]),pf:num(c[15]),tech:num(c[16]),dd:num(c[17]),td:num(c[18])});
      added++;
    }
    if(!added) break;
    await new Promise(r=>setTimeout(r,450));
  }
  return out;
}"""
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp("http://127.0.0.1:18800")
    ctx = b.contexts[0]
    page = ctx.new_page()
    page.goto("https://basketball.fantasysports.yahoo.com/nba/242808/players", wait_until="load")
    page.wait_for_timeout(2500)
    try:
        data = page.evaluate(JS)
    except Exception as e:
        print("retry after", str(e)[:80]); page.wait_for_timeout(3000); data = page.evaluate(JS)
    page.close()
    payload = {"source":"yahoo-player-list","leagueId":"242808","note":"Yahoo league player list read from Dillon's signed-in session (read-only). fanPts = Yahoo league-scored last-season totals (DD/TD/TECH blank in Yahoo list). preRank = Yahoo pre-season rank for this league.","fetchedAt":datetime.datetime.utcnow().isoformat()+"Z","count":len(data),"players":data}
    json.dump(payload, open(OUT,"w"), ensure_ascii=False)
    print("wrote", len(data), "->", OUT)
