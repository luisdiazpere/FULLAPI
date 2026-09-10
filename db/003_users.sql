CREATE TABLE users (
  email         text PRIMARY KEY CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Opaque bearer tokens, not JWTs: revoking on logout is a DELETE, not a denylist.
CREATE TABLE sessions (
  token      text PRIMARY KEY,
  email      text NOT NULL REFERENCES users (email) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
