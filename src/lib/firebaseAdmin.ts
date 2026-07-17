// lib/firebaseAdmin.ts (Cloudflare Workers version)
// Vercel wale api/lib/firebaseAdmin.ts ka drop-in replacement.
// firebase-admin ki jagah: Firestore REST client + WebCrypto token verify.
//
// IMPORTANT: router (index.ts) har request ke shuru mein initGoogleAuth(env)
// call karta hai — us se pehle db/auth use mat karo.

import { Firestore } from './firestoreRest';
import { getProjectId } from './googleAuth';
import { verifyIdToken, type DecodedIdToken } from './firebaseAuth';

let _db: Firestore | null = null;

function getDb(): Firestore {
  if (!_db) _db = new Firestore(getProjectId());
  return _db;
}

// Lazy proxy — module-load pe env available nahi hota Workers mein,
// isliye pehli property access pe hi Firestore banate hain
export const db: Firestore = new Proxy({} as Firestore, {
  get(_t, prop) {
    const real = getDb() as any;
    const v = real[prop];
    return typeof v === 'function' ? v.bind(real) : v;
  },
});

export const auth = {
  // checkRevoked param accept karte hain compat ke liye, lekin REST se
  // revocation check ke liye extra Firebase call lagti — sign yahan verify hota hai
  async verifyIdToken(idToken: string, _checkRevoked?: boolean): Promise<DecodedIdToken> {
    return verifyIdToken(idToken);
  },
};
