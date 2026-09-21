import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { NewSession } from "./repository.js";

export interface PasswordRepository {
  reservePasswordLogin(identityHash: string, now: Date): Promise<number>;
  readPasswordHash(email: string): Promise<string | null>;
  createPasswordSession(email: string, expectedHash: string, session: NewSession): Promise<boolean>;
  canSetPassword(sessionHash: string, now: Date): Promise<boolean>;
  setPassword(sessionHash: string, passwordHash: string, now: Date): Promise<boolean>;
}

const params = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const derive = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 32, params, (error, key) => error ? reject(error) : resolve(key));
});
// Bound memory-intensive work even when requests arrive from many addresses.
let activeHashes = 0;
async function boundedHash(password: string, salt: Buffer) {
  if (activeHashes >= 4) throw new Error("PASSWORD_HASH_BUSY");
  activeHashes += 1;
  try { return await derive(password, salt); } finally { activeHashes -= 1; }
}
export function validPassword(password: string): boolean {
  return [...password].length >= 12 && [...password].length <= 128 && Buffer.byteLength(password, "utf8") <= 512;
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await boundedHash(password, salt);
  return `scrypt-v1$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const parts = encoded?.match(/^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/u);
  // Unknown users and users without passwords take the same expensive hash path.
  const key = await boundedHash(password, parts ? Buffer.from(parts[1]!, "hex") : Buffer.alloc(16));
  const expected = parts ? Buffer.from(parts[2]!, "hex") : Buffer.alloc(32);
  return timingSafeEqual(key, expected) && Boolean(parts);
}
