import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const pnvsCredentialError = "Could not save PNVS credentials securely. No existing configuration was overwritten.";

export interface PnvsCredentials {
  accessKeyId: string;
  accessKeySecret: string;
}

/** A safe diagnostic category only; never includes any part of the credential. */
export function getPnvsCredentialInputIssue(value: string): "empty" | "too_long" | "whitespace_or_control" | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "empty";
  if (trimmed.length > 4096) return "too_long";
  if (/[\s\p{Cc}]/u.test(trimmed)) return "whitespace_or_control";
  return undefined;
}

const repositoryDirectory = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Only the default private location is exposed by the CLI; a directory argument supports isolated tests. */
export function preparePnvsCredentialDestination(directory = resolve(homedir(), ".config/duduhire")): string {
  try {
    const uid = process.getuid?.();
    if (uid === undefined || !isAbsolute(directory)) throw new Error(pnvsCredentialError);
    const targetDirectory = resolve(directory);
    if (isInside(repositoryDirectory, targetDirectory)) throw new Error(pnvsCredentialError);
    const root = parse(targetDirectory).root;
    let current = root;
    // Validate each existing ancestor before creating descendants, so a symlink is never followed.
    for (const segment of targetDirectory.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, segment);
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory() || (entry.uid !== uid && entry.uid !== 0)) {
        throw new Error(pnvsCredentialError);
      }
      // Root-owned sticky temporary directories are safe ancestors for isolated tests.
      if ((entry.mode & 0o022) !== 0 && !(entry.uid === 0 && (entry.mode & 0o1000) !== 0)) {
        throw new Error(pnvsCredentialError);
      }
    }
    const entry = lstatSync(targetDirectory);
    if (entry.uid !== uid || (entry.mode & 0o7777) !== 0o700 || realpathSync(targetDirectory) !== targetDirectory) {
      throw new Error(pnvsCredentialError);
    }
    const file = join(targetDirectory, "pnvs.json");
    try {
      lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return file;
      throw error;
    }
    throw new Error(pnvsCredentialError);
  } catch {
    // Never print filesystem/parser errors, input values, paths, or causes.
    throw new Error(pnvsCredentialError);
  }
}

/** Saves credentials only: no provider calls, environment loading, logging, or existing-file replacement. */
export function savePnvsCredentials(credentials: PnvsCredentials, directory?: string): string {
  let temporaryFile: string | undefined;
  let descriptor: number | undefined;
  let createdTemporaryFile = false;
  try {
    const accessKeyId = credentials.accessKeyId.trim();
    const accessKeySecret = credentials.accessKeySecret.trim();
    // Check safe entry, not a provider-specific token grammar. JSON preserves punctuation verbatim.
    if ([accessKeyId, accessKeySecret].some(value => getPnvsCredentialInputIssue(value) !== undefined)) {
      throw new Error(pnvsCredentialError);
    }
    const file = preparePnvsCredentialDestination(directory);
    if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error(pnvsCredentialError);
    temporaryFile = `${file}.${randomUUID()}.tmp`;
    descriptor = openSync(temporaryFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    createdTemporaryFile = true;
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ accessKeyId, accessKeySecret }, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // Publish complete contents atomically. linkSync fails if any file/symlink already owns the destination.
    linkSync(temporaryFile, file);
    return file;
  } catch {
    throw new Error(pnvsCredentialError);
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Do not emit private system errors. */ }
    }
    if (createdTemporaryFile && temporaryFile !== undefined) {
      try { unlinkSync(temporaryFile); } catch { /* A residual temporary file is still owner-only. */ }
    }
  }
}
