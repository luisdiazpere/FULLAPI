import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { makeRateLimiter } from './rateLimit.ts';

const SCRYPT_KEYLEN = 64;
const COOKIE_NAME = 'session';

/** node:crypto's scrypt, not a new dependency: a salted, memory-hard KDF is the same job bcrypt does. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

const cookieAttrs = (secure: boolean) => {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) attrs.push('Secure');
  return attrs;
};

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  return [`${COOKIE_NAME}=${token}`, ...cookieAttrs(secure), `Expires=${expiresAt.toUTCString()}`].join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return [`${COOKIE_NAME}=`, ...cookieAttrs(secure), 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'].join('; ');
}

/** Shared by signup and login: a few wrong guesses is normal, hundreds is an attack. */
export const allowAuthAttempt = makeRateLimiter(10, 60_000);
