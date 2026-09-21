-- The rolling-deploy compatibility window introduced by migration 002 is now
-- closed. All supported API versions always persist a browser binding hash.
ALTER TABLE email_challenges
  ALTER COLUMN browser_binding_hash SET NOT NULL;

ALTER TABLE email_challenges
  ADD CONSTRAINT email_challenges_browser_binding_hash_format
  CHECK (browser_binding_hash ~ '^[0-9a-f]{64}$');

-- Authenticated profile contact data is encrypted by the API before storage.
-- Existing plaintext rows remain readable during migration and are re-encrypted
-- the next time their owner saves the profile.
ALTER TABLE profiles
  ALTER COLUMN contact TYPE text;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_contact_storage_size
  CHECK (char_length(contact) <= 4096);
