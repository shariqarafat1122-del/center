// index.ts — Cloudflare Worker entry point
// Vercel file-based routing ki jagah central router.
// Paths bilkul same rakhe hain taaki client code mein koi change na ho:
//   POST /api/poker/action
//   POST /api/poker/create
//   POST /api/realludo/action
//   POST /api/tictactoe/action
//   POST /api/nine-card/action
//   POST /api/joker-pair/:action   (join|start|action|leave|auto-discard|retry-payout)

import { setEnv, type WorkerEnv } from './lib/env';
import { initGoogleAuth } from './lib/googleAuth';
import { makeVercelRequest, makeVercelResponse } from './lib/vercelShim';
import { isOriginAllowed, corsHeadersFor } from './lib/cors';

import pokerAction from './poker/action';
import pokerCreate from './poker/create';
import realludoAction from './realludo/action';
import tictactoeAction from './tictactoe/action';
import nineCardAction from './nine-card/action';
import jokerPairAction from './joker-pair/action';
import tambolaAction from './tambola/action';

type Handler = (req: any, res: any) => Promise<any> | any;

const ROUTES: Record<string, Handler> = {
  '/api/poker/action': pokerAction,
  '/api/poker/create': pokerCreate,
  '/api/realludo/action': realludoAction,
  '/api/tictactoe/action': tictactoeAction,
  '/api/nine-card/action': nineCardAction,
  '/api/tambola/action': tambolaAction,
};

const JOKER_PAIR_PREFIX = '/api/joker-pair/';

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // Env init — baaki modules getEnv()/getAccessToken() se access karte hain
    setEnv(env);
    initGoogleAuth(env);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = request.headers.get('Origin');
    const cors = corsHeadersFor(origin);

    // ── Origin allowlist enforcement ──────────────────────────────────────
    // Browser se aayi request (Origin header ke saath) agar allowed domain
    // se nahi hai to yahin block — handler tak jaane hi nahi dete.
    if (origin && !isOriginAllowed(origin)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    // Global OPTIONS preflight — handlers tak jaane ki zaroorat nahi
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    let handler: Handler | undefined = ROUTES[path];
    let jokerAction: string | null = null;

    if (!handler && path.startsWith(JOKER_PAIR_PREFIX)) {
      jokerAction = path.slice(JOKER_PAIR_PREFIX.length);
      if (jokerAction && !jokerAction.includes('/')) handler = jokerPairAction;
    }

    if (!handler) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    const req = await makeVercelRequest(request);
    if (jokerAction) req.query.action = jokerAction; // Vercel [action].ts param compat

    const res = makeVercelResponse();

    try {
      await handler(req, res);
    } catch (err: any) {
      console.error(`[worker] Unhandled error on ${path}:`, err);
      if (!res._finished) {
        res.status(err?.status || 500).json({ error: err?.message || 'Internal server error' });
      }
    }

    if (!res._finished) {
      res.status(500).json({ error: 'Handler did not produce a response' });
    }

    // CORS headers har response pe — matched origin hi echo hota hai
    const response = res._toResponse();
    for (const [k, v] of Object.entries(cors)) {
      response.headers.set(k, v);
    }
    return response;
  },
};
