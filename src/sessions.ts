import { randomBytes } from 'node:crypto';
import { pool } from './db.ts';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type Session = { email: string };

/** Opaque bearer token, not a JWT: revoking on logout is a DELETE, not a denylist. */
export async function createSession(email: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query('INSERT INTO sessions (token, email, expires_at) VALUES ($1, $2, $3)', [token, email, expiresAt]);
  return { token, expiresAt };
}

export async function getSession(token: string): Promise<Session | null> {
  const { rows } = await pool.query<Session>(
    'SELECT email FROM sessions WHERE token = $1 AND expires_at > now()',
    [token],
  );
  return rows[0] ?? null;
}

export async function destroySession(token: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}
