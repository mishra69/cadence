// skill-asset: oidc.js v1.0.0 (canonical: skills/pwa-cloudflare/assets/oidc.js)
// OpenID Connect ID-token verification for Cloudflare Workers.
//
// Nothing here is Google-specific: an ID token is a JWT signed by the provider,
// and verifying one is always the same four steps — find the signing key by
// `kid`, check the signature, check the claims, check it hasn't expired. Only
// the JWKS URL, the accepted issuers and the audience differ per provider.
//
//   import { verifyIdToken, GOOGLE } from '../lib/oidc.js';
//   const claims = await verifyIdToken(token, { ...GOOGLE, audience: env.CLIENT_ID });
//
// Throws on any failure. Callers should treat every error the same way — a
// generic "sign-in failed" — rather than reporting which check failed.

export const GOOGLE = {
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
};

export const MICROSOFT = {
  jwksUrl: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
  issuers: ['https://login.microsoftonline.com/common/v2.0'],
};

export const APPLE = {
  jwksUrl: 'https://appleid.apple.com/auth/keys',
  issuers: ['https://appleid.apple.com'],
};

/**
 * @param {string} idToken     the raw JWT from the provider
 * @param {object} opts
 * @param {string} opts.jwksUrl
 * @param {string[]} opts.issuers   accepted `iss` values
 * @param {string} opts.audience    your client id — the check that scopes the
 *                                  token to THIS app
 * @param {number} [opts.cacheTtl]  seconds to edge-cache the key set
 * @param {number} [opts.clockSkew] seconds of tolerance for `iat`
 * @returns {Promise<object>} the verified claims
 */
export async function verifyIdToken(idToken, opts) {
  const { jwksUrl, issuers, audience, cacheTtl = 3600, clockSkew = 300 } = opts;
  if (!jwksUrl || !issuers || !audience) {
    throw new Error('verifyIdToken needs jwksUrl, issuers and audience');
  }

  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const [rawHeader, rawPayload, rawSig] = parts;

  const header = JSON.parse(b64urlToString(rawHeader));
  const claims = JSON.parse(b64urlToString(rawPayload));

  // Only RS256 is accepted. Trusting the token's own `alg` is how the classic
  // "alg: none" and HMAC-confusion attacks work.
  if (header.alg !== 'RS256') throw new Error('unexpected alg ' + header.alg);

  const key = await importSigningKey(jwksUrl, header.kid, cacheTtl);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  );
  if (!valid) throw new Error('bad signature');

  // A valid signature only proves the provider issued it. These prove it was
  // issued for this app, and is still current.
  if (!issuers.includes(claims.iss)) throw new Error('bad issuer');
  if (claims.aud !== audience) throw new Error('bad audience');
  if (!claims.sub) throw new Error('no subject');

  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp <= now) throw new Error('expired');
  if (claims.iat && claims.iat > now + clockSkew) throw new Error('issued in the future');

  return claims;
}

async function importSigningKey(jwksUrl, kid, cacheTtl) {
  // Providers rotate keys, so the set can't be hardcoded — but fetching it on
  // every sign-in is wasteful. The edge cache makes it roughly one fetch per
  // ttl per colo.
  const jwks = await fetch(jwksUrl, { cf: { cacheTtl, cacheEverything: true } })
    .then(r => r.json());

  const jwk = (jwks.keys || []).find(k => k.kid === kid);
  if (!jwk) throw new Error('unknown signing key');

  // Only the RSA modulus and exponent are passed: some providers include `alg`
  // or `use` fields that importKey rejects when they disagree with the
  // algorithm below.
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}
