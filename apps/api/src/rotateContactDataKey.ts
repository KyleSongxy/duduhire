import { loadDatabaseConfig } from "./config.js";
import { createDatabasePool, withDedicatedDatabaseClient } from "./postgresRepository.js";
import { decryptContactValue, encryptContactValue } from "./privacy.js";

const envelopePattern = /^v[12]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u;
const confirmationPhrase = "ROTATE_CONTACT_DATA";

function readRequired(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readKey(name: string) {
  const value = readRequired(name);
  if (!/^[A-Fa-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} must be exactly 64 hexadecimal characters.`);
  }
  return value.toLowerCase();
}

function readKeyId(name: string) {
  const value = readRequired(name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(value)) {
    throw new Error(`${name} must be a valid key identifier of at most 100 characters.`);
  }
  return value;
}

const currentKey = readKey("CURRENT_CONTACT_DATA_KEY");
const nextKey = readKey("NEXT_CONTACT_DATA_KEY");
const currentKeyId = readKeyId("CURRENT_CONTACT_DATA_KEY_ID");
const nextKeyId = readKeyId("NEXT_CONTACT_DATA_KEY_ID");
if (/^([0-9a-f])\1{63}$/u.test(nextKey) || nextKey === "deadbeef".repeat(8)) {
  throw new Error("NEXT_CONTACT_DATA_KEY must be a non-placeholder random key.");
}
if (/(?:replace|placeholder)/iu.test(nextKeyId)) {
  throw new Error("NEXT_CONTACT_DATA_KEY_ID must not use a placeholder value.");
}
if (currentKey === nextKey) throw new Error("The next contact data key must differ from the current key.");
if (currentKeyId === nextKeyId) throw new Error("The next contact data key id must differ from the current key id.");

if (process.env.NODE_ENV === "production" && !process.env.ROTATION_DATABASE_URL?.trim()) {
  throw new Error("ROTATION_DATABASE_URL is required for production contact-key rotation.");
}
if (process.env.NODE_ENV === "production" && process.env.ROTATION_DATABASE_SSL !== "true") {
  throw new Error("ROTATION_DATABASE_SSL=true is required for production contact-key rotation.");
}

const database = loadDatabaseConfig({
  ...process.env,
  DATABASE_URL: process.env.ROTATION_DATABASE_URL?.trim() || process.env.DATABASE_URL,
  DATABASE_SSL: process.env.ROTATION_DATABASE_SSL?.trim() || process.env.DATABASE_SSL,
});
const applyChanges = process.env.CONTACT_KEY_ROTATION_CONFIRM === confirmationPhrase;
const pool = createDatabasePool(database.databaseUrl, database.databaseSsl, "maintenance");

try {
  const result = await withDedicatedDatabaseClient(pool, async (client, assertHealthy) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_197_873_442]);
      const profiles = await client.query<{ user_id: string; contact: string }>(
        "SELECT user_id, contact FROM profiles WHERE contact <> '' FOR UPDATE",
      );
      let profilesReencrypted = 0;
      let profilesAlreadyUsingNextKey = 0;
      let legacyPlaintextProfiles = 0;
      for (const profile of profiles.rows) {
        const nextContext = { scope: "profile" as const, recordId: profile.user_id, keyId: nextKeyId };
        const currentContext = { scope: "profile" as const, recordId: profile.user_id, keyId: currentKeyId };
        let plaintext: string;
        if (!envelopePattern.test(profile.contact)) {
          plaintext = profile.contact;
          legacyPlaintextProfiles += 1;
        } else {
          try {
            plaintext = decryptContactValue(profile.contact, nextKey, nextContext);
            if (profile.contact.startsWith("v2.")) {
              profilesAlreadyUsingNextKey += 1;
              continue;
            }
          } catch {
            plaintext = decryptContactValue(profile.contact, currentKey, currentContext);
          }
        }
        await client.query(
          "UPDATE profiles SET contact = $2 WHERE user_id = $1",
          [profile.user_id, encryptContactValue(plaintext, nextKey, nextContext)],
        );
        profilesReencrypted += 1;
      }

      const inquiries = await client.query<{ id: string; contact_ciphertext: string; encryption_key_id: string }>(
        `SELECT id, contact_ciphertext, encryption_key_id
           FROM enterprise_inquiries
          FOR UPDATE`,
      );
      let enterpriseInquiriesReencrypted = 0;
      let enterpriseInquiriesAlreadyUsingNextKey = 0;
      for (const inquiry of inquiries.rows) {
        const nextContext = { scope: "enterprise_inquiry" as const, recordId: inquiry.id, keyId: nextKeyId };
        const currentContext = { scope: "enterprise_inquiry" as const, recordId: inquiry.id, keyId: currentKeyId };
        if (inquiry.encryption_key_id === nextKeyId) {
          const plaintext = decryptContactValue(inquiry.contact_ciphertext, nextKey, nextContext);
          if (inquiry.contact_ciphertext.startsWith("v2.")) {
            enterpriseInquiriesAlreadyUsingNextKey += 1;
            continue;
          }
          await client.query(
            `UPDATE enterprise_inquiries
                SET contact_ciphertext = $2,
                    updated_at = NOW()
              WHERE id = $1`,
            [inquiry.id, encryptContactValue(plaintext, nextKey, nextContext)],
          );
          enterpriseInquiriesReencrypted += 1;
          continue;
        }
        if (inquiry.encryption_key_id !== currentKeyId) {
          throw new Error(`Enterprise inquiry uses an unexpected encryption key id: ${inquiry.encryption_key_id}`);
        }
        const plaintext = decryptContactValue(inquiry.contact_ciphertext, currentKey, currentContext);
        await client.query(
          `UPDATE enterprise_inquiries
              SET contact_ciphertext = $2,
                  encryption_key_id = $3,
                  updated_at = NOW()
            WHERE id = $1`,
          [inquiry.id, encryptContactValue(plaintext, nextKey, nextContext), nextKeyId],
        );
        enterpriseInquiriesReencrypted += 1;
      }
      assertHealthy();

      if (applyChanges) await client.query("COMMIT");
      else await client.query("ROLLBACK");
      return {
        mode: applyChanges ? "applied" : "dry-run",
        profilesScanned: profiles.rowCount ?? 0,
        profilesReencrypted,
        profilesAlreadyUsingNextKey,
        legacyPlaintextProfiles,
        enterpriseInquiriesScanned: inquiries.rowCount ?? 0,
        enterpriseInquiriesReencrypted,
        enterpriseInquiriesAlreadyUsingNextKey,
        nextKeyId,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!applyChanges) {
    process.stderr.write(`Dry run only. Set CONTACT_KEY_ROTATION_CONFIRM=${confirmationPhrase} to commit.\n`);
  }
} finally {
  await pool.end();
}
