-- Account identity remains stable; each browser session selects a working role.
-- Backfill existing sessions before enforcing the new invariant.
ALTER TABLE sessions ADD COLUMN active_role text;
UPDATE sessions s SET active_role = u.role FROM users u WHERE u.id = s.user_id;
ALTER TABLE sessions ALTER COLUMN active_role SET NOT NULL;
ALTER TABLE sessions ADD CONSTRAINT sessions_active_role_check
  CHECK (active_role IN ('client', 'talent'));

-- During a rolling deployment an older API may still omit the new column.
-- Derive its initial role from the existing account instead of failing login
-- or defaulting every legacy talent session to the client role.
CREATE OR REPLACE FUNCTION public.initialize_session_active_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  SELECT u.role INTO NEW.active_role FROM public.users u WHERE u.id = NEW.user_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_initialize_active_role
BEFORE INSERT ON sessions
FOR EACH ROW WHEN (NEW.active_role IS NULL)
EXECUTE FUNCTION public.initialize_session_active_role();
