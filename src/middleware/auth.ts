/**
 * API-key auth. Every request must present the shared key (set as API_KEY in
 * .env) either as `Authorization: Bearer <key>` or `x-api-key: <key>`.
 *
 * - CORS preflight (OPTIONS) is allowed through (the browser can't attach the
 *   key to a preflight).
 * - If API_KEY is not configured, auth is DISABLED (a startup warning is logged)
 *   so the app still runs out of the box; set API_KEY to enforce it.
 */
import type { RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/** Constant-time compare so a wrong key can't be guessed via response timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function extractKey(req: Parameters<RequestHandler>[0]): string | undefined {
  const xkey = req.header('x-api-key');
  if (xkey) return xkey;
  const auth = req.header('authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return undefined;
}

export const apiKeyAuth: RequestHandler = (req, res, next) => {
  if (req.method === 'OPTIONS') return next(); // CORS preflight
  const expected = config.apiKey;
  if (!expected) return next(); // auth disabled (no key configured)

  const provided = extractKey(req);
  if (provided && safeEqual(provided, expected)) return next();

  res.status(401).json({
    message:
      'Missing or invalid API key. Send it as "Authorization: Bearer <key>" or "x-api-key: <key>".',
    error: 'Unauthorized',
    statusCode: 401,
  });
};
