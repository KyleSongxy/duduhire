CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('client', 'talent')),
  email_verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (email = LOWER(email)),
  CHECK (char_length(email) BETWEEN 3 AND 254)
);

CREATE TABLE email_challenges (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  intent text NOT NULL CHECK (intent IN ('login', 'signup')),
  requested_role text CHECK (requested_role IN ('client', 'talent')),
  token_hash char(64) NOT NULL UNIQUE,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK ((intent = 'signup' AND requested_role IS NOT NULL) OR intent = 'login'),
  CHECK (email = LOWER(email)),
  CHECK (char_length(email) BETWEEN 3 AND 254),
  CHECK (char_length(return_to) BETWEEN 1 AND 2048)
);

CREATE INDEX email_challenges_email_created_idx ON email_challenges (email, created_at DESC);
CREATE INDEX email_challenges_expiry_idx ON email_challenges (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX sessions_user_active_idx ON sessions (user_id, expires_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name varchar(80) NOT NULL DEFAULT '',
  country_code varchar(2) NOT NULL DEFAULT '',
  contact varchar(80) NOT NULL DEFAULT '',
  organization varchar(120) NOT NULL DEFAULT '',
  job_title varchar(80) NOT NULL DEFAULT '',
  professional_title varchar(100) NOT NULL DEFAULT '',
  bio varchar(500) NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (country_code = '' OR country_code ~ '^[A-Z]{2}$')
);
