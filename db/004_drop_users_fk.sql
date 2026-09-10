-- Clerk owns accounts now; drop the dead local users table and the FK that
-- referenced it, which threw sessions_email_fkey on every successful login.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_email_fkey;
DROP TABLE IF EXISTS users;
