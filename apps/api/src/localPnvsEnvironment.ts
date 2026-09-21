import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { getPnvsCredentialInputIssue } from "./pnvsCredentials.js";

export const localPnvsEnvironmentError = "Local PNVS credentials could not be loaded securely. Check the private file location, ownership and permissions.";

/** Loads credentials only; sending remains subject to the application's explicit enable switch. */
export function loadLocalPnvsEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  directory = resolve(homedir(), ".config/duduhire"),
): boolean {
  if (env.DUDUHIRE_LOAD_LOCAL_ENV !== "true" || env.NODE_ENV === "production") return false;
  // Never combine half an injected pair with a credential from a personal file.
  if (env.PNVS_ACCESS_KEY_ID !== undefined || env.PNVS_ACCESS_KEY_SECRET !== undefined) return false;

  let descriptor: number | undefined;
  try {
    const uid = process.getuid?.();
    if (uid === undefined || !isAbsolute(directory)) throw new Error(localPnvsEnvironmentError);
    const targetDirectory = resolve(directory);
    const root = parse(targetDirectory).root;
    let current = root;
    for (const segment of targetDirectory.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, segment);
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory() || (entry.uid !== uid && entry.uid !== 0)) {
        throw new Error(localPnvsEnvironmentError);
      }
      // Root-owned sticky temporary ancestors support isolated tests without trusting writable ancestors.
      if ((entry.mode & 0o022) !== 0 && !(entry.uid === 0 && (entry.mode & 0o1000) !== 0)) {
        throw new Error(localPnvsEnvironmentError);
      }
    }
    const parent = lstatSync(targetDirectory);
    if (parent.uid !== uid || (parent.mode & 0o7777) !== 0o700 || realpathSync(targetDirectory) !== targetDirectory) {
      throw new Error(localPnvsEnvironmentError);
    }
    const filePath = join(targetDirectory, "pnvs.json");
    const before = lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(localPnvsEnvironmentError);
    if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) {
      throw new Error(localPnvsEnvironmentError);
    }
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(descriptor);
    if (!file.isFile() || file.uid !== uid || (file.mode & 0o7777) !== 0o600 || file.nlink !== 1
      || file.size > 65_536 || file.ino !== before.ino || file.dev !== before.dev) {
      throw new Error(localPnvsEnvironmentError);
    }
    const raw: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(localPnvsEnvironmentError);
    const values = raw as Record<string, unknown>;
    if (Object.keys(values).length !== 2 || typeof values.accessKeyId !== "string" || typeof values.accessKeySecret !== "string"
      || getPnvsCredentialInputIssue(values.accessKeyId) !== undefined
      || getPnvsCredentialInputIssue(values.accessKeySecret) !== undefined) {
      throw new Error(localPnvsEnvironmentError);
    }
    env.PNVS_ACCESS_KEY_ID = values.accessKeyId.trim();
    env.PNVS_ACCESS_KEY_SECRET = values.accessKeySecret.trim();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Parsing and filesystem errors can contain private values. Never retain their message or cause.
    throw new Error(localPnvsEnvironmentError);
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Never expose private filesystem diagnostics. */ }
    }
  }
}
