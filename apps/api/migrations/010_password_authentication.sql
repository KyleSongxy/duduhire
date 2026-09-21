CREATE TABLE user_passwords (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE sessions ADD COLUMN password_setup_expires_at timestamptz;

CREATE TABLE password_login_limits (
  identity_hash char(64) PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0)
);
