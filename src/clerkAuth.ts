import { createClerkClient } from '@clerk/backend';
import { isClerkAPIResponseError } from '@clerk/backend/errors';

export class ClerkUnconfiguredError extends Error {}
export class ClerkAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const clerkConfigured = (): boolean => Boolean(process.env.CLERK_SECRET_KEY);

let client: ReturnType<typeof createClerkClient> | null = null;

/**
 * Clerk owns credential storage and password policy for this app — the only
 * things this file does are create a Clerk user and verify a password
 * against one. Everything else (sessions, cookies, order history) stays
 * this app's own, in src/sessions.ts, so the login UI stays fully custom.
 */
function clerk() {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) throw new ClerkUnconfiguredError('CLERK_SECRET_KEY is not set');
  client ??= createClerkClient({ secretKey: key });
  return client;
}

/**
 * A 401/403 here means our own secret key is missing or wrong — a deployment
 * problem, not something the shopper did. Surfacing that as "bad password"
 * would send them chasing a typo that isn't theirs to fix.
 */
function throwIfMisconfigured(err: unknown): void {
  if (isClerkAPIResponseError(err) && (err.status === 401 || err.status === 403)) {
    throw new ClerkUnconfiguredError(err.errors[0]?.longMessage ?? err.errors[0]?.message ?? 'Clerk rejected our secret key');
  }
}

export async function clerkSignUp(email: string, password: string): Promise<void> {
  try {
    await clerk().users.createUser({ emailAddress: [email], password });
  } catch (err) {
    throwIfMisconfigured(err);
    if (isClerkAPIResponseError(err)) {
      const first = err.errors[0];
      if (first?.code === 'form_identifier_exists') {
        throw new ClerkAuthError('email_taken', 'an account with that email already exists');
      }
      throw new ClerkAuthError('invalid_password', first?.longMessage ?? first?.message ?? 'that password was rejected');
    }
    throw err;
  }
}

/** Same generic false either way: the caller must not learn which part was wrong. */
export async function clerkVerify(email: string, password: string): Promise<boolean> {
  const { data } = await clerk().users.getUserList({ emailAddress: [email] }).catch((err: unknown) => {
    throwIfMisconfigured(err);
    throw err;
  });
  const user = data[0];
  if (!user) return false;
  try {
    await clerk().users.verifyPassword({ userId: user.id, password });
    return true;
  } catch (err) {
    throwIfMisconfigured(err);
    return false;
  }
}
