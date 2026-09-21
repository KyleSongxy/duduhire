ALTER TABLE email_challenges
  ADD COLUMN browser_binding_hash char(64);

-- Links created before browser binding was introduced must no longer authenticate.
UPDATE email_challenges
   SET browser_binding_hash = repeat('0', 64),
       consumed_at = COALESCE(consumed_at, NOW())
 WHERE browser_binding_hash IS NULL;

-- Keep the column nullable during the rolling-deploy window so the previous API
-- can continue writing. The new API always supplies a binding hash and will not
-- accept legacy NULL rows.
