// lib/vercelShim.ts
// VercelRequest / VercelResponse adapter over Workers' fetch API.
// Game handlers bina change ke chalte hain — woh req.body / res.status().json()
// use karte hain, yeh shim unhe Workers Response mein translate karta hai.

export interface VercelRequest {
  method: string;
  headers: Record<string, string | undefined>;
  body: any;
  query: Record<string, string | string[]>;
  url: string;
}

export interface VercelResponse {
  status(code: number): VercelResponse;
  json(data: any): VercelResponse;
  send(data: any): VercelResponse;
  end(data?: string): VercelResponse;
  setHeader(name: string, value: string): VercelResponse;
  // internal
  _finished: boolean;
  _toResponse(): Response;
}

export async function makeVercelRequest(request: Request): Promise<VercelRequest> {
  const url = new URL(request.url);

  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  const query: Record<string, string | string[]> = {};
  for (const [k, v] of url.searchParams.entries()) {
    const existing = query[k];
    if (existing === undefined) query[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else query[k] = [existing, v];
  }

  let body: any = undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const ct = headers['content-type'] || '';
    try {
      if (ct.includes('application/json')) {
        body = await request.json();
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        const text = await request.text();
        body = Object.fromEntries(new URLSearchParams(text).entries());
      } else {
        const text = await request.text();
        // Vercel bhi best-effort JSON parse karta hai
        try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
      }
    } catch {
      body = undefined;
    }
  }

  return { method: request.method, headers, body, query, url: request.url };
}

export function makeVercelResponse(): VercelResponse {
  let statusCode = 200;
  const headers = new Headers();
  let bodyOut: string | null = null;

  const res: VercelResponse = {
    _finished: false,

    status(code: number) {
      statusCode = code;
      return res;
    },

    setHeader(name: string, value: string) {
      headers.set(name, value);
      return res;
    },

    json(data: any) {
      headers.set('Content-Type', 'application/json');
      bodyOut = JSON.stringify(data);
      res._finished = true;
      return res;
    },

    send(data: any) {
      if (typeof data === 'object' && data !== null) return res.json(data);
      bodyOut = String(data ?? '');
      res._finished = true;
      return res;
    },

    end(data?: string) {
      if (data !== undefined) bodyOut = data;
      res._finished = true;
      return res;
    },

    _toResponse() {
      return new Response(bodyOut, { status: statusCode, headers });
    },
  };

  return res;
}
