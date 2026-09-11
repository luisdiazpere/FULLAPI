import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseSessionCookie } from './auth.ts';

/**
 * Closes /api/* to everything except the shop's own page.
 *
 * What this does buy: another site cannot drive this API with a logged-in visitor's
 * cookie. That was wide open — SameSite=Lax was the only control and there were no
 * CSRF tokens anywhere.
 *
 * What it does not buy: protection from a scripted client. Sec-Fetch-Site is only
 * unforgeable by *browser JavaScript*; curl sets whatever it likes. Automation is
 * bounded by the rate limits, not by this. Anyone who tells you a web API can prove
 * a request came from their own page is selling obfuscation.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The CSRF token is derived from the session token rather than stored, so this needs
 * no migration and no second revocation path: killing the session kills the token.
 * Domain-separated so it never collides with the at-rest session hash.
 */
export const csrfFor = (sessionToken: string): string =>
  createHash('sha256').update(`csrf:${sessionToken}`).digest('hex');

export function allowedOrigins(): string[] {
  const configured = process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
  if (configured?.length) return configured;
  // Fall back to the canonical origin we already know: the one Stripe sends buyers back to.
  try {
    return [new URL(process.env.CHECKOUT_SUCCESS_URL ?? '').origin];
  } catch {
    return [];
  }
}

/** Marks a request as in-process so app.inject() can satisfy the checks below. */
export function internalHeaders(cookie?: string): Record<string, string> {
  const origin = allowedOrigins()[0] ?? 'http://127.0.0.1';
  const token = parseSessionCookie(cookie);
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    ...(cookie ? { cookie } : {}),
    ...(token ? { 'x-csrf-token': csrfFor(token) } : {}),
  };
}

const deny = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, message: string) =>
  reply.code(403).send({ error: { code: 'forbidden', message } });

export default async function perimeter(app: FastifyInstance) {
  const origins = allowedOrigins();

  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    // Only the JSON API. The three HTML page routes are entered by typing a URL or
    // following Stripe's redirect, where Sec-Fetch-Site is 'none' or 'cross-site'.
    if (!req.url.startsWith('/api/')) return;

    if (SAFE_METHODS.has(req.method)) {
      // A same-origin fetch always sends this. 'none' means a top-level navigation —
      // someone pasting an API URL into the address bar — which is not the frontend.
      if (req.headers['sec-fetch-site'] !== 'same-origin') {
        return deny(reply, 'this API is only callable from the shop');
      }
      return;
    }

    // Browsers always send Origin on a same-origin non-GET, so absent is not a browser.
    const origin = req.headers.origin;
    if (!origin || !origins.includes(origin)) {
      return deny(reply, 'this API is only callable from the shop');
    }

    // CSRF only bites once there is an ambient credential to abuse. An anonymous POST
    // has nothing to steal, and the Origin check above already stops a cross-site form.
    const token = parseSessionCookie(req.headers.cookie);
    if (token && req.headers['x-csrf-token'] !== csrfFor(token)) {
      return deny(reply, 'missing or stale CSRF token');
    }
  });
}
