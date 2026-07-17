# BetAdda API — Cloudflare Workers

Vercel serverless ka Cloudflare Workers port. Sare game APIs (poker, realludo,
tictactoe, nine-card, joker-pair) + wallet logic yahan shift ho gaya hai.

## Kya change hua

| Vercel | Cloudflare |
|---|---|
| `firebase-admin` (gRPC) | `src/lib/firestoreRest.ts` — Firestore REST API, same surface (Timestamp, FieldValue, runTransaction, batch, queries) |
| `firebase-admin/auth` verifyIdToken | `src/lib/firebaseAuth.ts` — WebCrypto RS256 + Google public certs |
| Service account credential | `src/lib/googleAuth.ts` — WebCrypto se OAuth2 token (1hr cache) |
| `@vercel/node` req/res | `src/lib/vercelShim.ts` — game handlers unchanged chalte hain |
| `node:crypto` randomInt/timingSafeEqual | `src/lib/nodeCompat.ts` — `crypto.getRandomValues` rejection-sampling |
| File-based routing | `src/index.ts` central router — **URLs bilkul same hain**, client mein sirf base URL change hoga |

Game logic files (`poker/`, `realludo/`, `tictactoe/`, `nine-card/`, `joker-pair/`,
`lib/walletInternal.ts`, `lib/middleware.ts`, `lib/ludoLogic.ts`) sirf import-swap ke saath
copy hui hain — logic untouched.

**Note:** `verifyIdToken` mein `checkRevoked` ab signature-only verify hai (REST se revocation
check ke liye har request pe extra Google call lagti). Token expiry/audience/issuer sab
verify hota hai.

## Deploy

```bash
npm install

# Secrets (values wahi jo Vercel dashboard mein the)
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY     # poori PEM, \n ke saath ya bina — dono chalega
npx wrangler secret put NEXT_PUBLIC_APP_URL      # allowed domain(s), comma-separated
# single:   https://myapp.vercel.app
# multiple: https://myapp.vercel.app,https://www.mydomain.com

npm run deploy
```

## Local dev

```bash
# .dev.vars file banao (gitignore mein rakhna):
#   FIREBASE_PROJECT_ID=...
#   FIREBASE_CLIENT_EMAIL=...
#   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
#   NEXT_PUBLIC_APP_URL=http://localhost:3000
npm run dev
```

## Client-side change

Sirf API base URL update karo:

```js
// pehle:  https://your-app.vercel.app/api/poker/action
// ab:     https://betadda-api.<your-subdomain>.workers.dev/api/poker/action
```

Custom domain chahiye to `wrangler.toml` mein routes add karo:

```toml
routes = [{ pattern = "api.yourdomain.com/*", zone_name = "yourdomain.com" }]
```

## Endpoints (unchanged)

- `POST /api/poker/action`
- `POST /api/poker/create`
- `POST /api/realludo/action`
- `POST /api/tictactoe/action`
- `POST /api/nine-card/action`
- `POST /api/joker-pair/{join|start|action|leave|auto-discard|retry-payout}`
