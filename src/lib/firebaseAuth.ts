// lib/firebaseAuth.ts
// Firebase ID token verification — WebCrypto se, firebase-admin ke bina.
// Google ke public X.509 certs fetch karke RS256 signature + claims verify karta hai.

import { b64urlDecode, getProjectId } from './googleAuth';

const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

// kid → CryptoKey cache (isolate lifetime tak)
let _keyCache: { keys: Map<string, CryptoKey>; expiresAt: number } | null = null;

async function getPublicKeys(): Promise<Map<string, CryptoKey>> {
  if (_keyCache && Date.now() < _keyCache.expiresAt) return _keyCache.keys;

  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Google certs (${res.status})`);

  // Cache-Control max-age respect karo
  const cc = res.headers.get('cache-control') || '';
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? 3600);

  const certs: Record<string, string> = await res.json();
  const keys = new Map<string, CryptoKey>();

  for (const [kid, pem] of Object.entries(certs)) {
    const der = pemCertToDer(pem);
    // X.509 cert se SPKI nikaalne ka shortcut: WebCrypto directly cert import
    // nahi karta, isliye cert parse karke publicKeyInfo extract karte hain
    const spki = extractSpkiFromCert(der);
    const key = await crypto.subtle.importKey(
      'spki',
      spki.buffer as ArrayBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(kid, key);
  }

  _keyCache = { keys, expiresAt: Date.now() + Math.min(maxAge, 21600) * 1000 };
  return keys;
}

function pemCertToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ─── Minimal DER walker — X.509 cert se subjectPublicKeyInfo nikaalo ─────────

function derLen(buf: Uint8Array, at: number): { len: number; next: number } {
  let b = buf[at];
  if (b < 0x80) return { len: b, next: at + 1 };
  const n = b & 0x7f;
  let len = 0;
  for (let i = 1; i <= n; i++) len = (len << 8) | buf[at + i];
  return { len, next: at + 1 + n };
}

function extractSpkiFromCert(cert: Uint8Array): Uint8Array {
  // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
  let p = 0;
  if (cert[p++] !== 0x30) throw new Error('Bad cert: expected SEQUENCE');
  p = derLen(cert, p).next;

  // tbsCertificate ::= SEQUENCE
  if (cert[p] !== 0x30) throw new Error('Bad cert: expected tbsCertificate');
  const tbsStart = p;
  p++;
  const tbs = derLen(cert, p);
  p = tbs.next;
  const tbsEnd = p + tbs.len;

  // tbs ke andar: [0] version?, serialNumber, signature, issuer, validity, subject, SPKI
  // Optional [0] version tag skip karo
  if (cert[p] === 0xa0) {
    p++;
    const l = derLen(cert, p);
    p = l.next + l.len;
  }
  // serialNumber (INTEGER), signature (SEQ), issuer (SEQ), validity (SEQ), subject (SEQ)
  for (let i = 0; i < 5; i++) {
    p++; // tag
    const l = derLen(cert, p);
    p = l.next + l.len;
    if (p > tbsEnd) throw new Error('Bad cert: ran past tbsCertificate');
  }
  // Ab p subjectPublicKeyInfo (SEQUENCE) pe hai
  if (cert[p] !== 0x30) throw new Error('Bad cert: expected SPKI SEQUENCE');
  const spkiStart = p;
  p++;
  const spkiLen = derLen(cert, p);
  const spkiEnd = spkiLen.next + spkiLen.len;
  void tbsStart;
  return cert.slice(spkiStart, spkiEnd);
}

// ─── verifyIdToken ────────────────────────────────────────────────────────────

export interface DecodedIdToken {
  uid: string;
  sub: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  auth_time: number;
  [key: string]: any;
}

function authError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export async function verifyIdToken(idToken: string): Promise<DecodedIdToken> {
  const projectId = getProjectId();

  const parts = idToken.split('.');
  if (parts.length !== 3) throw authError('Malformed JWT', 'auth/argument-error');

  let header: any, payload: any;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    throw authError('Malformed JWT', 'auth/argument-error');
  }

  if (header.alg !== 'RS256')
    throw authError(`Unexpected algorithm: ${header.alg}`, 'auth/argument-error');
  if (!header.kid)
    throw authError('Missing kid', 'auth/argument-error');

  const keys = await getPublicKeys();
  const key = keys.get(header.kid);
  if (!key) throw authError('Unknown signing key', 'auth/argument-error');

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(parts[2]).buffer as ArrayBuffer,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw authError('Invalid signature', 'auth/argument-error');

  const now = Math.floor(Date.now() / 1000);
  const SKEW = 300; // 5 min clock skew allowance

  if (typeof payload.exp !== 'number' || payload.exp < now)
    throw authError('Token expired', 'auth/id-token-expired');
  if (typeof payload.iat !== 'number' || payload.iat > now + SKEW)
    throw authError('Token issued in the future', 'auth/argument-error');
  if (payload.aud !== projectId)
    throw authError('Invalid audience', 'auth/argument-error');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`)
    throw authError('Invalid issuer', 'auth/argument-error');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128)
    throw authError('Invalid subject', 'auth/argument-error');

  return { ...payload, uid: payload.sub };
}
