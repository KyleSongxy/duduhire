import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const CONTACT_CIPHER_VERSION = "v2";
const LEGACY_CONTACT_CIPHER_VERSION = "v1";
const CONTACT_CIPHER_ALGORITHM = "aes-256-gcm";
const LEGACY_CONTACT_CIPHER_AAD = Buffer.from("duduhire:contact:v1", "utf8");
const CONTACT_IV_BYTES = 12;
const CONTACT_AUTH_TAG_BYTES = 16;

export type ContactCipherContext = {
  scope: "profile" | "enterprise_inquiry";
  recordId: string;
  keyId: string;
};

function contactCipherAad(context: ContactCipherContext) {
  if (!context.recordId || !context.keyId) throw new Error("Contact encryption context is incomplete.");
  return Buffer.from(JSON.stringify(["duduhire", "contact", CONTACT_CIPHER_VERSION, context.scope, context.recordId, context.keyId]), "utf8");
}

function readContactDataKey(keyHex: string) {
  if (!/^[A-Fa-f0-9]{64}$/u.test(keyHex)) {
    throw new Error("Contact data key must be exactly 64 hexadecimal characters (32 bytes).");
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("Contact data key must contain 32 bytes.");
  return key;
}

/**
 * Returns a self-describing, versioned envelope suitable for a text column.
 * The key itself is never embedded in the result.
 */
export function encryptContactValue(value: string, keyHex: string, context: ContactCipherContext) {
  const key = readContactDataKey(keyHex);
  const iv = randomBytes(CONTACT_IV_BYTES);
  const cipher = createCipheriv(CONTACT_CIPHER_ALGORITHM, key, iv, { authTagLength: CONTACT_AUTH_TAG_BYTES });
  cipher.setAAD(contactCipherAad(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    CONTACT_CIPHER_VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptContactValue(envelope: string, keyHex: string, context: ContactCipherContext) {
  const [version, encodedIv, encodedAuthTag, encodedCiphertext, ...unexpected] = envelope.split(".");
  if (
    (version !== CONTACT_CIPHER_VERSION && version !== LEGACY_CONTACT_CIPHER_VERSION)
    || !encodedIv
    || !encodedAuthTag
    || encodedCiphertext === undefined
    || unexpected.length > 0
  ) {
    throw new Error("Encrypted contact value has an unsupported format.");
  }

  const key = readContactDataKey(keyHex);
  const iv = Buffer.from(encodedIv, "base64url");
  const authTag = Buffer.from(encodedAuthTag, "base64url");
  const ciphertext = Buffer.from(encodedCiphertext, "base64url");
  if (iv.length !== CONTACT_IV_BYTES || authTag.length !== CONTACT_AUTH_TAG_BYTES) {
    throw new Error("Encrypted contact value is invalid.");
  }

  try {
    const decipher = createDecipheriv(CONTACT_CIPHER_ALGORITHM, key, iv, { authTagLength: CONTACT_AUTH_TAG_BYTES });
    decipher.setAAD(version === LEGACY_CONTACT_CIPHER_VERSION ? LEGACY_CONTACT_CIPHER_AAD : contactCipherAad(context));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Encrypted contact value could not be authenticated.");
  }
}
