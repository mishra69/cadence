// Session tokens and sign-in.
//
// Google's ID-token flow: the browser gets a signed JWT from GIS, the Worker
// verifies it (lib/oidc.js — including the `aud` check, which is the one that
// scopes a perfectly-valid Google signature to *this* app), and then issues its
// own short token so every subsequent request is one HMAC instead of a JWKS
// fetch.
//
// Note this is the account gate, not the privacy gate. The privacy gate is the
// Face ID / PIN lock in the client (§4.1), which is deliberately client-side
// only — the threat model is someone holding my unlocked phone, not an attacker
// with a network capture.
import { verifyIdToken, GOOGLE } from './oidc.js';

const SESSION_TTL_S = 60 * 60 * 24 * 90;   // 90 days: this is a daily-use app on one device

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

/** Issue a session token for a verified Google `sub`. */
export async function issueSession(sub, secret, now = Date.now()) {
  const payload = b64urlEncode(enc.encode(JSON.stringify({
    sub, exp: Math.floor(now / 1000) + SESSION_TTL_S,
  })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * @returns {Promise<string|null>} the user id (Google `sub`), or null if the
 * token is absent, malformed, forged or expired — the caller treats all four
 * identically.
 */
export async function verifySession(token, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;

  // crypto.subtle.verify is constant-time; never compare signatures with ===.
  let ok;
  try {
    ok = await crypto.subtle.verify(
      'HMAC', await hmacKey(secret), b64urlDecode(sig), enc.encode(payload)
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!claims.sub || !claims.exp || claims.exp * 1000 <= now) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/** The user id for a request, or null. */
export async function userFromRequest(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return verifySession(token, env.TOKEN_SECRET);
}

/**
 * Exchange a Google ID token for a session token.
 * Throws on any failure; the caller reports a single generic "sign-in failed"
 * rather than telling a probe which check it tripped.
 */
export async function signInWithGoogle(idToken, env) {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is not configured');
  if (!env.TOKEN_SECRET) throw new Error('TOKEN_SECRET is not configured');

  const claims = await verifyIdToken(idToken, { ...GOOGLE, audience: env.GOOGLE_CLIENT_ID });

  // Single-user app. The allowlist is checked on email because that is what a
  // human can write down, but the account is *keyed* on `sub` — emails get
  // changed and recycled, `sub` never does.
  const allowed = (env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length) {
    if (!claims.email_verified) throw new Error('email not verified');
    if (!allowed.includes(String(claims.email || '').toLowerCase())) throw new Error('not allowed');
  }

  return {
    token: await issueSession(claims.sub, env.TOKEN_SECRET),
    // These all ride along in the ID token already — no extra scope, no second
    // request to Google. `picture` is a cross-origin URL on
    // lh3.googleusercontent.com, and `=s96-c` asks for a 96px square crop
    // rather than whatever size the account happens to hold.
    user: {
      id: claims.sub,
      name: claims.given_name || claims.name || null,
      email: claims.email || null,
      picture: claims.picture ? `${claims.picture.split('=')[0]}=s96-c` : null,
    },
  };
}
