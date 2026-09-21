ALTER TABLE public.enterprise_inquiries
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN notification_status text NOT NULL DEFAULT 'pending'
    CHECK (notification_status IN ('pending', 'sent', 'failed'));

ALTER TABLE public.outbox_events
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD CONSTRAINT outbox_lease_pair_check CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL));

UPDATE public.enterprise_inquiries i SET notification_status = 'sent'
WHERE EXISTS (SELECT 1 FROM public.outbox_events e WHERE e.aggregate_id = i.id
  AND e.event_type = 'enterprise_inquiry.created' AND e.published_at IS NOT NULL);

CREATE INDEX enterprise_inquiries_admin_page_idx
  ON public.enterprise_inquiries (status, created_at DESC, id DESC);
CREATE INDEX outbox_inquiry_claim_idx ON public.outbox_events (available_at, created_at)
  WHERE event_type = 'enterprise_inquiry.created' AND published_at IS NULL AND dead_lettered_at IS NULL;

CREATE TABLE public.inquiry_audit_events (
  id uuid PRIMARY KEY,
  inquiry_id uuid NOT NULL REFERENCES public.enterprise_inquiries(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('status_changed', 'contact_revealed')),
  reason varchar(300),
  previous_status text,
  next_status text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK ((action = 'contact_revealed' AND char_length(btrim(reason)) BETWEEN 5 AND 300
          AND previous_status IS NULL AND next_status IS NULL)
      OR (action = 'status_changed' AND reason IS NULL
          AND previous_status IN ('new', 'contacted', 'closed', 'spam')
          AND next_status IN ('new', 'contacted', 'closed')))
);
CREATE INDEX inquiry_audit_events_inquiry_idx ON public.inquiry_audit_events (inquiry_id, created_at DESC);

-- This view intentionally excludes user IDs, contact hashes and ciphertext.
CREATE VIEW public.enterprise_inquiry_admin_list AS
SELECT id, contact_method, source, status, version, created_at, updated_at, notification_status
FROM public.enterprise_inquiries;

CREATE FUNCTION public.admin_update_inquiry_status(p_audit_id uuid, p_actor uuid, p_id uuid, p_status text, p_expected_version integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE current_inquiry public.enterprise_inquiries%ROWTYPE;
BEGIN
  IF p_status NOT IN ('new', 'contacted', 'closed') OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'Invalid inquiry update';
  END IF;
  SELECT * INTO current_inquiry FROM public.enterprise_inquiries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF current_inquiry.version <> p_expected_version THEN RETURN 'conflict'; END IF;
  UPDATE public.enterprise_inquiries SET status = p_status, version = version + 1,
    updated_at = GREATEST(NOW(), created_at) WHERE id = p_id;
  INSERT INTO public.inquiry_audit_events (id, inquiry_id, actor_user_id, action, previous_status, next_status)
    VALUES (p_audit_id, p_id, p_actor, 'status_changed', current_inquiry.status, p_status);
  RETURN 'updated';
END;
$fn$;

-- Reading encrypted contact data is inseparable from appending its audit event.
CREATE FUNCTION public.admin_reveal_inquiry_contact(p_audit_id uuid, p_actor uuid, p_id uuid, p_reason text)
RETURNS TABLE (contact_method text, contact_ciphertext text, encryption_key_id varchar)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE current_inquiry public.enterprise_inquiries%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'A contact access reason is required';
  END IF;
  SELECT * INTO current_inquiry FROM public.enterprise_inquiries WHERE id = p_id FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.inquiry_audit_events (id, inquiry_id, actor_user_id, action, reason)
    VALUES (p_audit_id, p_id, p_actor, 'contact_revealed', btrim(p_reason));
  RETURN QUERY SELECT current_inquiry.contact_method, current_inquiry.contact_ciphertext, current_inquiry.encryption_key_id;
END;
$fn$;

-- Only the dedicated notification role can claim/finalize inquiry notifications.
-- Other outbox event types are never consumed by this worker.
CREATE FUNCTION public.claim_inquiry_notification(p_lease_token uuid)
RETURNS TABLE (event_id uuid, inquiry_id uuid, source varchar, attempt_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF p_lease_token IS NULL THEN RAISE EXCEPTION 'Lease token is required'; END IF;
  WITH exhausted AS (
    UPDATE public.outbox_events SET dead_lettered_at = NOW(), lease_token = NULL,
      lease_expires_at = NULL, last_error = 'DELIVERY_ATTEMPTS_EXHAUSTED'
    WHERE event_type = 'enterprise_inquiry.created' AND published_at IS NULL AND dead_lettered_at IS NULL
      AND outbox_events.attempt_count >= 8 AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
    RETURNING aggregate_id
  ) UPDATE public.enterprise_inquiries SET notification_status = 'failed'
      WHERE id IN (SELECT aggregate_id FROM exhausted);

  RETURN QUERY WITH candidate AS (
    SELECT e.id FROM public.outbox_events e
    WHERE e.event_type = 'enterprise_inquiry.created' AND e.aggregate_type = 'enterprise_inquiry'
      AND e.published_at IS NULL AND e.dead_lettered_at IS NULL AND e.available_at <= NOW()
      AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= NOW()) AND e.attempt_count < 8
    ORDER BY e.created_at, e.id FOR UPDATE SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE public.outbox_events e SET lease_token = p_lease_token,
      lease_expires_at = NOW() + INTERVAL '120 seconds', attempt_count = e.attempt_count + 1
    FROM candidate WHERE e.id = candidate.id
    RETURNING e.id, e.aggregate_id, e.attempt_count
  ) SELECT c.id, c.aggregate_id, i.source, c.attempt_count
      FROM claimed c JOIN public.enterprise_inquiries i ON i.id = c.aggregate_id;
END;
$fn$;

CREATE FUNCTION public.finish_inquiry_notification(p_event_id uuid, p_lease_token uuid, p_delivered boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE item public.outbox_events%ROWTYPE;
BEGIN
  SELECT * INTO item FROM public.outbox_events WHERE id = p_event_id AND lease_token = p_lease_token
    AND event_type = 'enterprise_inquiry.created' AND published_at IS NULL AND dead_lettered_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  UPDATE public.outbox_events SET lease_token = NULL, lease_expires_at = NULL,
    published_at = CASE WHEN p_delivered THEN GREATEST(NOW(), created_at) ELSE NULL END,
    dead_lettered_at = CASE WHEN NOT p_delivered AND attempt_count >= 8 THEN NOW() ELSE NULL END,
    last_error = CASE WHEN p_delivered THEN NULL ELSE 'SMTP_DELIVERY_FAILED' END,
    available_at = CASE WHEN p_delivered THEN available_at
      ELSE NOW() + (LEAST(3600, 30 * power(2, GREATEST(0, attempt_count - 1))) * INTERVAL '1 second') END
  WHERE id = p_event_id;
  UPDATE public.enterprise_inquiries SET notification_status = CASE
    WHEN p_delivered THEN 'sent' WHEN item.attempt_count >= 8 THEN 'failed' ELSE 'pending' END
    WHERE id = item.aggregate_id;
  RETURN TRUE;
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_update_inquiry_status(uuid, uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reveal_inquiry_contact(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_inquiry_notification(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_inquiry_notification(uuid, uuid, boolean) FROM PUBLIC;
