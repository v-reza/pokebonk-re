// api/[...path].mjs — Vercel Serverless Function catch-all for PokéBonk API.
//
// Matches all /api/** endpoints on Vercel static hosting and routes them
// through the shared Firebase backend route table in firebase/backend.mjs.
// Does NOT import server.mjs or serve static files.
import { initFirebaseBackend } from '../firebase/backend.mjs';
import { json } from '../firebase/shared.mjs';

let backendPromise = null;

export function getBackend() {
  if (!backendPromise) {
    backendPromise = initFirebaseBackend().catch((err) => {
      // Clear memoized promise on failure so subsequent invocations can retry
      backendPromise = null;
      throw err;
    });
  }
  return backendPromise;
}

export function setBackendForTest(stubBackend) {
  backendPromise = Promise.resolve(stubBackend);
}

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'cache-control': 'no-store',
    });
    return res.end();
  }

  // Ensure body is readable by body(req) in firebase/shared.mjs even if pre-parsed by Vercel
  if (req.body !== undefined && req.readableEnded) {
    const raw = typeof req.body === 'string'
      ? Buffer.from(req.body)
      : Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(JSON.stringify(req.body));
    req[Symbol.asyncIterator] = async function* () {
      yield raw;
    };
  }

  const host = req.headers.host || '127.0.0.1';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = new URL(req.url, `${proto}://${host}`);

  // Normalize path: strip leading /api prefix if present
  let apiPath = url.pathname;
  if (apiPath.startsWith('/api/')) {
    apiPath = apiPath.slice(4) || '/';
  } else if (apiPath === '/api') {
    apiPath = '/';
  }
  if (!apiPath.startsWith('/')) {
    apiPath = '/' + apiPath;
  }

  let backend;
  try {
    backend = await getBackend();
  } catch (err) {
    console.error('[api] Firebase backend initialization error:', err.message || err);
    if (!res.writableEnded) {
      json(res, 500, {
        error: 'Database backend initialization failed.',
        detail: process.env.NODE_ENV === 'production' ? undefined : (err.message || String(err)),
      });
    }
    return;
  }

  const m = backend.match ? backend.match(req.method, apiPath) : null;
  if (!m) {
    return json(res, 404, { error: 'Not found.' });
  }

  try {
    const out = await m.handler(req, res, url, m.params);
    if (out !== undefined && !res.writableEnded) {
      json(res, 200, out);
    }
  } catch (err) {
    console.error(`[api] ${req.method} ${apiPath} error:`, err);
    if (!res.writableEnded) {
      json(res, 500, { error: 'Internal server error.' });
    }
  }
}
