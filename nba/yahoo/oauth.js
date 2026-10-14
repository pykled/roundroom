// Yahoo OAuth 2.0 (authorization-code, confidential client).
// Docs: https://developer.yahoo.com/oauth2/guide/flows_authcode/
const AUTHORIZE_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const SCOPE = 'fspt-r';

function isConfigured(env = process.env) {
  return !!(env.YAHOO_CLIENT_ID && env.YAHOO_CLIENT_SECRET);
}

function authorizeUrl({ redirectUri, state }, env = process.env) {
  const q = new URLSearchParams({
    client_id: env.YAHOO_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    state,
  });
  return `${AUTHORIZE_URL}?${q}`;
}

// OAuth error code from a token-endpoint body. Yahoo usually sends RFC 6749
// {"error":"invalid_grant"}, but has also been seen sending
// {"error":{"error":"…","description":"…"}}. Only well-formed codes are kept
// (never free text, which could echo request values). A bare 401 with no code
// is a rejected client credential (RFC 6749 §5.2), i.e. invalid_client.
const CODE_RE = /^[a-z_]{3,40}$/;
function errorCode(data, status) {
  let c = data && data.error;
  if (c && typeof c === 'object') c = c.error || c.code || null;
  if (typeof c === 'string' && CODE_RE.test(c)) return c;
  return status === 401 ? 'invalid_client' : null;
}

// Classify a failure from Yahoo (token endpoint or API) for the router:
//   'revoked'       — this user's refresh token is dead (invalid_grant): drop
//                     their tokens and ask them to reconnect.
//   'misconfigured' — our app credentials are bad (invalid_client etc.): keep
//                     every user's tokens; it is a server problem.
//   'not_connected' — no tokens stored.
//   'transient'     — anything else (network, 5xx, throttling).
const CONFIG_CODES = new Set(['invalid_client', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope']);
function classifyError(err) {
  const code = err && err.code;
  if (code === 'not_connected') return 'not_connected';
  if (code === 'invalid_grant') return 'revoked';
  if (CONFIG_CODES.has(code)) return 'misconfigured';
  return 'transient';
}

// POST to get_token with HTTP Basic client auth. Returns the token set with an
// absolute expires_at (ms). Errors never include the response body verbatim,
// which can echo the code/refresh token.
async function tokenRequest(params, { env = process.env, fetchImpl = fetch } = {}) {
  const basic = Buffer.from(`${env.YAHOO_CLIENT_ID}:${env.YAHOO_CLIENT_SECRET}`).toString('base64');
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok || !data || !data.access_token) {
    const code = errorCode(data, res.status);
    const err = new Error(`Yahoo token endpoint ${res.status}${code ? ` (${code})` : ''}`);
    err.status = res.status;
    err.code = code;
    err.source = 'token';
    throw err;
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || params.refresh_token,
    token_type: data.token_type || 'bearer',
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    xoauth_yahoo_guid: data.xoauth_yahoo_guid || null,
  };
}

function exchangeCode({ code, redirectUri }, opts) {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, opts);
}

function refreshTokens(refreshToken, { redirectUri = 'oob', ...opts } = {}) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: redirectUri }, opts);
}

module.exports = { AUTHORIZE_URL, TOKEN_URL, SCOPE, isConfigured, authorizeUrl, exchangeCode, refreshTokens, errorCode, classifyError };
