/**
 * Odin OAuth helper - gets a client_credentials token
 * Token URL: https://odin.alpy.com/oauth/token
 * Reused across requests (cached per process instance)
 */

const ODIN_TOKEN_URL = 'https://odin.alpy.com/oauth/token';
const CLIENT_ID = process.env.ODIN_CLIENT_ID || 'c0cc1d5a4007c84fddcfc22879f00082';
const CLIENT_SECRET = process.env.ODIN_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiresAt = 0;

export async function getOdinToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const res = await fetch(ODIN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'email',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Odin token error ' + res.status + ': ' + err);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return cachedToken;
}
