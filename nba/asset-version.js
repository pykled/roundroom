// Content-hash cache busting for NBA pages. Rewrites same-origin CSS/JS refs
// under /nba/pages/ and /shared/ to "?v=<sha1-8>" of the file on disk, so a
// deploy that changes nba-ui.css or styles.css is picked up on the next page
// load instead of waiting out a browser cache. Hashes are memoised per mtime.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REF_RE = /(\b(?:src|href)=")(\/(?:nba\/pages|shared)\/[A-Za-z0-9._-]+\.(?:css|js))(\?[^"]*)?"/g;
const memo = new Map(); // abs path -> { mtimeMs, hash }

function hashFor(urlPath, root = ROOT) {
  const abs = path.join(root, urlPath);
  if (!abs.startsWith(root + path.sep)) return null;
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  const hit = memo.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.hash;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 8);
  memo.set(abs, { mtimeMs: st.mtimeMs, size: st.size, hash });
  return hash;
}

function versionAssets(html, root = ROOT) {
  return html.replace(REF_RE, (m, attr, urlPath) => {
    const h = hashFor(urlPath, root);
    return h ? `${attr}${urlPath}?v=${h}"` : m;
  });
}

module.exports = { versionAssets, hashFor };
