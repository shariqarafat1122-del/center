// lib/cors.ts
// Origin allowlist — OPTIONAL.
//
// NEXT_PUBLIC_APP_URL khali/unset  → SAB origins allowed (open CORS).
//   Security Firebase token check (verifyToken) se hoti hai, CORS se nahi.
// NEXT_PUBLIC_APP_URL set hai      → sirf listed domains allowed.
//   comma-separated: https://myapp.vercel.app,https://www.mydomain.com
//
// Bina Origin ke requests (server-to-server, curl) CORS se nahi rukti —
// unhe Firebase token check (verifyToken) rokta hai.

import { getEnv } from './env';

export function getAllowedOrigins(): string[] {
  const raw = getEnv().NEXT_PUBLIC_APP_URL || '';
  return raw
    .split(',')
    .map(s => s.trim().replace(/\/+$/, '')) // trailing slash hatao
    .filter(Boolean);
}

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true; // no Origin = non-browser client — token check karega
  const allowed = getAllowedOrigins();
  if (allowed.length === 0) return true; // allowlist khali = sab allowed
  const normalized = origin.replace(/\/+$/, '');
  return allowed.includes(normalized);
}

// Response headers ke liye — allowed origin echo hota hai
export function corsHeadersFor(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin.replace(/\/+$/, '');
  }
  return headers;
}
