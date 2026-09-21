-- Preserve email identities as-is. A phone account has a real verified phone,
-- with NULL email fields; editable profile contact details are never identities.
ALTER TABLE public.users
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN email_verified_at DROP NOT NULL,
  ADD COLUMN phone text UNIQUE,
  ADD COLUMN phone_verified_at timestamptz,
  ADD CONSTRAINT users_phone_format_check CHECK (phone IS NULL OR phone ~ '^\+861[3-9][0-9]{9}$'),
  ADD CONSTRAINT users_verified_identity_check CHECK (
    (email IS NOT NULL AND email_verified_at IS NOT NULL)
    OR (phone IS NOT NULL AND phone_verified_at IS NOT NULL)
  ),
  ADD CONSTRAINT users_verification_address_check CHECK (
    (email_verified_at IS NULL OR email IS NOT NULL)
    AND (phone_verified_at IS NULL OR phone IS NOT NULL)
  );

CREATE TABLE public.phone_challenges (
  id uuid PRIMARY KEY,
  phone text NOT NULL CHECK (phone ~ '^\+861[3-9][0-9]{9}$'),
  intent text NOT NULL CHECK (intent IN ('login', 'signup')),
  requested_role text CHECK (requested_role IN ('client', 'talent')),
  code_hash char(64) NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  browser_binding_hash char(64) NOT NULL CHECK (browser_binding_hash ~ '^[0-9a-f]{64}$'),
  request_ip_hash char(64) NOT NULL CHECK (request_ip_hash ~ '^[0-9a-f]{64}$'),
  return_to text NOT NULL CHECK (char_length(return_to) BETWEEN 1 AND 2048),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  sent_at timestamptz,
  invalidated_at timestamptz,
  consumed_at timestamptz,
  verification_attempts integer NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0),
  verification_lease_id uuid,
  verification_lease_expires_at timestamptz,
  CHECK ((intent = 'signup' AND requested_role IS NOT NULL)
    OR (intent = 'login' AND requested_role IS NULL)),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR sent_at IS NOT NULL),
  CHECK (consumed_at IS NULL OR invalidated_at IS NULL),
  CHECK ((verification_lease_id IS NULL) = (verification_lease_expires_at IS NULL)),
  CHECK (verification_lease_id IS NULL OR (sent_at IS NOT NULL AND consumed_at IS NULL AND invalidated_at IS NULL))
);

CREATE UNIQUE INDEX phone_challenges_one_open_per_phone_idx ON public.phone_challenges (phone)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX phone_challenges_phone_created_idx ON public.phone_challenges (phone, created_at DESC);
CREATE INDEX phone_challenges_ip_created_idx ON public.phone_challenges (request_ip_hash, created_at DESC);
CREATE INDEX phone_challenges_created_idx ON public.phone_challenges (created_at);
CREATE INDEX phone_challenges_expiry_idx ON public.phone_challenges (expires_at);
REVOKE ALL ON TABLE public.phone_challenges FROM PUBLIC;

-- Preserve the maintenance function's return contract and existing EXECUTE
-- grants. Failed, consumed and superseded sends share the owner-controlled
-- challenge retention policy. The extra created_at guard protects the rolling
-- 24-hour send budget even if policy settings later become more aggressive.
CREATE OR REPLACE FUNCTION public.run_data_retention_cleanup()
RETURNS TABLE (
  removed_email_challenges bigint,
  removed_sessions bigint,
  removed_intake_drafts bigint,
  removed_archived_discovery_threads bigint,
  removed_published_outbox_events bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $cleanup$
DECLARE
  policy public.data_retention_policy%ROWTYPE;
BEGIN
  SELECT * INTO STRICT policy
    FROM public.data_retention_policy
   WHERE singleton = TRUE;

  DELETE FROM public.email_challenges
    WHERE expires_at < NOW() - (policy.challenge_retention_days * INTERVAL '1 day');
  GET DIAGNOSTICS removed_email_challenges = ROW_COUNT;

  DELETE FROM public.phone_challenges
    WHERE expires_at < NOW() - (policy.challenge_retention_days * INTERVAL '1 day')
      AND created_at < NOW() - INTERVAL '24 hours';

  DELETE FROM public.sessions
    WHERE expires_at < NOW() - (policy.session_retention_days * INTERVAL '1 day')
       OR (revoked_at IS NOT NULL AND revoked_at < NOW() - (policy.session_retention_days * INTERVAL '1 day'));
  GET DIAGNOSTICS removed_sessions = ROW_COUNT;

  DELETE FROM public.intake_drafts
    WHERE expires_at < NOW();
  GET DIAGNOSTICS removed_intake_drafts = ROW_COUNT;

  DELETE FROM public.discovery_threads
    WHERE status = 'archived'
      AND updated_at < NOW() - (policy.archived_discovery_retention_days * INTERVAL '1 day');
  GET DIAGNOSTICS removed_archived_discovery_threads = ROW_COUNT;

  DELETE FROM public.outbox_events
    WHERE published_at IS NOT NULL
      AND published_at < NOW() - (policy.published_outbox_retention_days * INTERVAL '1 day');
  GET DIAGNOSTICS removed_published_outbox_events = ROW_COUNT;

  RETURN NEXT;
END;
$cleanup$;
REVOKE ALL ON FUNCTION public.run_data_retention_cleanup() FROM PUBLIC;
