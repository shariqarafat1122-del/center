// lib/nodeCompat.ts
// node:crypto ke jo functions game code use karta hai, unke Workers equivalents.

// crypto.randomInt(min, max) — max EXCLUSIVE, Node jaisa hi.
// Rejection sampling se modulo bias avoid karte hain (card shuffle fair rahe).
export function randomInt(min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max))
    throw new Error('randomInt: min/max must be safe integers');
  if (max <= min) throw new Error('randomInt: max must be greater than min');

  const range = max - min;
  if (range > 0xffffffff) throw new Error('randomInt: range too large');

  const limit = Math.floor(0x100000000 / range) * range;
  const buf = new Uint32Array(1);
  let x: number;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return min + (x % range);
}

// crypto.timingSafeEqual — constant-time compare (secrets ke liye)
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
