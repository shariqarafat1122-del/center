// lib/googleAuth.ts
// Service-account se OAuth2 access token — WebCrypto RS256 JWT sign karke.
// firebase-admin ka credential layer replace karta hai, Workers pe chalta hai.

export interface ServiceAccountEnv {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
}

let _env: ServiceAccountEnv | null = null;

// Router entry pe har request ke start mein call hota hai
export function initGoogleAuth(env: ServiceAccountEnv): void {
  _env = env;
}

export function getProjectId(): string {
  if (!_env?.FIREBASE_PROJECT_ID) throw new Error('ENV_MISSING: FIREBASE_PROJECT_ID');
  return _env.FIREBASE_PROJECT_ID;
}

// ─── base64url helpers ────────────────────────────────────────────────────────

function b64urlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ─── Private key import (PKCS8 PEM) ──────────────────────────────────────────

let _signingKey: CryptoKey | null = null;

async function getSigningKey(): Promise<CryptoKey> {
  if (_signingKey) return _signingKey;
  if (!_env?.FIREBASE_PRIVATE_KEY) throw new Error('ENV_MISSING: FIREBASE_PRIVATE_KEY');

  // Vercel-style escaping handle karo: quotes + \n literals
  const pem = _env.FIREBASE_PRIVATE_KEY
    .replace(/^"|"$/g, '')
    .replace(/\\n/g, '\n');

  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');

  const der = b64urlDecode(body.replace(/\+/g, '-').replace(/\//g, '_'));

  _signingKey = await crypto.subtle.importKey(
    'pkcs8',
    der.buffer as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return _signingKey;
}

// ─── Access token (cached) ────────────────────────────────────────────────────

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';

let _cachedToken: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  // 60s margin — token expire hone se pehle refresh
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) {
    return _cachedToken.token;
  }
  if (!_env?.FIREBASE_CLIENT_EMAIL) throw new Error('ENV_MISSING: FIREBASE_CLIENT_EMAIL');

  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlEncode(JSON.stringify({
    iss: _env.FIREBASE_CLIENT_EMAIL,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));

  const key = await getSigningKey();
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const assertion = `${header}.${claims}.${b64urlEncode(new Uint8Array(sig))}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google OAuth token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data: any = await res.json();
  _cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return _cachedToken.token;
}
