CREATE TABLE intake_drafts (
  id uuid PRIMARY KEY,
  browser_binding_hash char(64) NOT NULL,
  prompt text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_by_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  claimed_at timestamptz,
  CHECK (browser_binding_hash ~ '^[0-9a-f]{64}$'),
  CHECK (char_length(prompt) BETWEEN 1 AND 12000),
  CHECK (expires_at > created_at),
  CHECK ((claimed_at IS NULL AND claimed_by_user_id IS NULL)
      OR (claimed_at IS NOT NULL AND claimed_by_user_id IS NOT NULL)),
  CHECK (claimed_at IS NULL OR (claimed_at >= created_at AND claimed_at < expires_at))
);

CREATE UNIQUE INDEX intake_drafts_one_open_per_browser_idx
  ON intake_drafts (browser_binding_hash)
  WHERE claimed_at IS NULL;
CREATE INDEX intake_drafts_expiry_idx
  ON intake_drafts (expires_at)
  WHERE claimed_at IS NULL;

CREATE TABLE discovery_threads (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('problem', 'capability')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, kind),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX discovery_threads_one_active_per_owner_kind_idx
  ON discovery_threads (owner_user_id, kind)
  WHERE status = 'active';
CREATE INDEX discovery_threads_owner_updated_idx
  ON discovery_threads (owner_user_id, updated_at DESC);

CREATE TABLE discovery_turns (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES discovery_threads(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  question text NOT NULL,
  answer text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  analysis_context text NOT NULL DEFAULT '',
  provider varchar(100) NOT NULL,
  model varchar(128) NOT NULL,
  prompt_version varchar(80) NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (thread_id, request_id),
  UNIQUE (thread_id, sequence),
  CHECK (char_length(question) BETWEEN 1 AND 12000),
  CHECK (char_length(answer) BETWEEN 1 AND 12000),
  CHECK (char_length(analysis_context) <= 12000),
  CHECK (char_length(provider) BETWEEN 1 AND 100),
  CHECK (char_length(model) BETWEEN 1 AND 128),
  CHECK (char_length(prompt_version) BETWEEN 1 AND 80),
  CHECK (jsonb_typeof(attachments) = 'array'),
  CHECK (jsonb_array_length(attachments) <= 5),
  CHECK (octet_length(attachments::text) <= 16384)
);

CREATE INDEX discovery_turns_thread_sequence_idx
  ON discovery_turns (thread_id, sequence);

CREATE TABLE discovery_artifacts (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('problem', 'capability')),
  draft jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (thread_id, kind) REFERENCES discovery_threads(id, kind) ON DELETE CASCADE,
  CHECK (jsonb_typeof(draft) = 'object'),
  CHECK (octet_length(draft::text) <= 65536),
  CHECK (updated_at >= created_at)
);

CREATE TABLE enterprise_inquiries (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  contact_method text NOT NULL CHECK (contact_method IN ('phone', 'wechat')),
  contact_ciphertext text NOT NULL,
  contact_hash char(64) NOT NULL,
  encryption_key_id varchar(100) NOT NULL,
  source varchar(100) NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed', 'spam')),
  consented_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (char_length(contact_ciphertext) BETWEEN 16 AND 4096),
  CHECK (contact_hash ~ '^[0-9a-f]{64}$'),
  CHECK (char_length(encryption_key_id) BETWEEN 1 AND 100),
  CHECK (char_length(source) BETWEEN 1 AND 100),
  CHECK (consented_at <= created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX enterprise_inquiries_contact_hash_idx
  ON enterprise_inquiries (contact_hash, created_at DESC);
CREATE INDEX enterprise_inquiries_status_created_idx
  ON enterprise_inquiries (status, created_at);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  aggregate_type varchar(80) NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type varchar(120) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  CHECK (char_length(aggregate_type) BETWEEN 1 AND 80),
  CHECK (char_length(event_type) BETWEEN 1 AND 120),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (octet_length(payload::text) <= 16384),
  CHECK (published_at IS NULL OR published_at >= created_at)
);

CREATE INDEX outbox_events_pending_idx
  ON outbox_events (available_at, created_at)
  WHERE published_at IS NULL;
