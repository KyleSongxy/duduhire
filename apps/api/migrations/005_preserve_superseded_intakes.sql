-- Preserve superseded browser-bound drafts for audit and retention cleanup while
-- allowing the runtime role to replace a draft without DELETE privileges.
ALTER TABLE intake_drafts
  ADD COLUMN invalidated_at timestamptz;

ALTER TABLE intake_drafts
  ADD CONSTRAINT intake_drafts_invalidation_state_check
  CHECK (
    (invalidated_at IS NULL OR invalidated_at >= created_at)
    AND NOT (claimed_at IS NOT NULL AND invalidated_at IS NOT NULL)
  );

DROP INDEX intake_drafts_one_open_per_browser_idx;
CREATE UNIQUE INDEX intake_drafts_one_open_per_browser_idx
  ON intake_drafts (browser_binding_hash)
  WHERE claimed_at IS NULL AND invalidated_at IS NULL;

DROP INDEX intake_drafts_expiry_idx;
CREATE INDEX intake_drafts_expiry_idx
  ON intake_drafts (expires_at)
  WHERE claimed_at IS NULL AND invalidated_at IS NULL;

-- The migration owner controls retention policy. Runtime and maintenance roles
-- receive no access to this table, so a compromised maintenance credential
-- cannot shorten retention before invoking cleanup.
CREATE TABLE public.data_retention_policy (
  singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  challenge_retention_days integer NOT NULL CHECK (challenge_retention_days BETWEEN 1 AND 365),
  session_retention_days integer NOT NULL CHECK (session_retention_days BETWEEN 1 AND 365),
  archived_discovery_retention_days integer NOT NULL CHECK (archived_discovery_retention_days BETWEEN 1 AND 365),
  published_outbox_retention_days integer NOT NULL CHECK (published_outbox_retention_days BETWEEN 1 AND 365),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO public.data_retention_policy (
  singleton,
  challenge_retention_days,
  session_retention_days,
  archived_discovery_retention_days,
  published_outbox_retention_days
) VALUES (TRUE, 7, 30, 30, 30);

-- Maintenance receives EXECUTE on this owner-controlled function instead of
-- broad SELECT/DELETE privileges on business tables. Every predicate and
-- retention interval is controlled by the migration owner.
CREATE FUNCTION public.run_data_retention_cleanup()
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

REVOKE ALL ON TABLE public.data_retention_policy FROM PUBLIC;
REVOKE ALL ON FUNCTION public.run_data_retention_cleanup() FROM PUBLIC;
