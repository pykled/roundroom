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
    const err = new Error(`Yahoo token endpoint ${res.status}${data && data.error ? ` (${data.error})` : ''}`);
    err.status = res.status;
    err.code = data && data.error;
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

module.exports = { AUTHORIZE_URL, TOKEN_URL, SCOPE, isConfigured, authorizeUrl, exchangeCode, refreshTokens };
