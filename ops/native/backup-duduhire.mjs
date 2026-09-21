#!/usr/bin/env node
// Node >=22.13. Local PostgreSQL backup only; no mail, upload, or restore.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ENV_FILE = '/etc/duduhire/migration.env';
const CA_FILE = '/etc/duduhire/ca.crt';
const BACKUP_DIRECTORY = '/var/lib/duduhire-backup';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FILE_PATTERN = /^duduhire-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[a-f0-9]{12}\.dump$/;

function check(condition, code) {
  if (!condition) throw new Error(code);
}

export function connectionEnvironment(input) {
  try {
    const settings = parseEnv(input);
    check(settings.NODE_ENV === 'production' && settings.MIGRATION_DATABASE_SSL === 'true', 'config');
    const url = new URL(settings.MIGRATION_DATABASE_URL);
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    check(['postgres:', 'postgresql:'].includes(url.protocol)
      && decodeURIComponent(url.pathname) === '/duduhire' && user === 'duduhire_owner'
      && ['localhost', '127.0.0.1'].includes(url.hostname) && (!url.port || url.port === '5432')
      && !url.search && !url.hash && password && !/[\u0000-\u001f\u007f]/u.test(password), 'target');
    check(!settings.NODE_EXTRA_CA_CERTS || settings.NODE_EXTRA_CA_CERTS === CA_FILE, 'ca');
    return {
      PATH: '/usr/pgsql-13/bin:/usr/bin:/bin', LANG: 'C',
      PGHOST: url.hostname, PGHOSTADDR: '127.0.0.1', PGPORT: '5432',
      PGDATABASE: 'duduhire', PGUSER: user, PGPASSWORD: password,
      PGSSLMODE: 'verify-full', PGSSLROOTCERT: CA_FILE,
      PGCONNECT_TIMEOUT: '5', PGPASSFILE: '/dev/null', PGSERVICEFILE: '/dev/null',
    };
  } catch {
    // URL/parser errors can include credentials. Never propagate their text.
    throw new Error('backup_connection_configuration_invalid');
  }
}

async function trustedAncestors(path, owner) {
  let current = dirname(path);
  while (true) {
    const info = await lstat(current);
    check(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o022) === 0
      && (info.uid === owner || info.uid === 0), 'backup_parent_permissions_invalid');
    if (current === parse(current).root) break;
    current = dirname(current);
  }
}

async function protectedFile(path, owner, mode) {
  await trustedAncestors(path, owner);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    check(info.isFile() && info.nlink === 1 && info.uid === owner
      && (mode === undefined ? (info.mode & 0o022) === 0 : (info.mode & 0o777) === mode), 'backup_input_permissions_invalid');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

export function backupDate(name) {
  const match = FILE_PATTERN.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millis] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString() === iso ? date.getTime() : null;
}

export async function prune(directory, now, owner) {
  let removed = 0;
  for (const name of await readdir(directory)) {
    const timestamp = backupDate(name);
    if (timestamp === null || timestamp >= now - RETENTION_MS) continue;
    const path = join(directory, name);
    const info = await lstat(path); // Do not follow symlinks, even if their name matches.
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== owner
      || (info.mode & 0o777) !== 0o600 || info.mtimeMs >= now - RETENTION_MS) continue;
    await unlink(path);
    removed += 1;
  }
  return removed;
}

export function runTool(command, args, { env, stdout = 'ignore', timeout, signal }) {
  return new Promise((resolveRun, reject) => {
    let failed = false;
    const child = spawn(command, args, {
      env, stdio: ['ignore', stdout, 'ignore'], timeout, signal, killSignal: 'SIGKILL',
    });
    child.once('error', () => { failed = true; });
    child.once('close', (code) => {
      if (code === 0 && !failed && !signal?.aborted) resolveRun();
      else reject(new Error(command === 'pg_dump' ? 'backup_pg_dump_failed' : 'backup_pg_restore_list_failed'));
    });
  });
}

// Injectable paths/tools are only for offline tests; the CLI has fixed targets.
export async function createBackup({ directory, env, owner, now = Date.now(), run = runTool, signal }) {
  await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  check(info.isDirectory() && !info.isSymbolicLink() && info.uid === owner && (info.mode & 0o777) === 0o700,
    'backup_directory_permissions_invalid');
  const lockPath = join(directory, '.backup.lock');
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const stamp = new Date(now).toISOString().replace(/[-:.]/gu, '');
  const name = `duduhire-${stamp}-${randomBytes(6).toString('hex')}.dump`;
  const finalPath = join(directory, name);
  const temporary = join(directory, `.${name}.tmp`);
  let dump;
  let temporaryCreated = false;
  try {
    await lock.writeFile(`${process.pid}\n`);
    check(!signal?.aborted, 'backup_interrupted');
    check(await absent(finalPath), 'backup_destination_exists');
    dump = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporaryCreated = true;
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--no-password', '--lock-wait-timeout=5000'],
      { env, stdout: dump.fd, timeout: 600_000, signal });
    await dump.sync();
    const archive = await dump.stat();
    check(archive.size > 0 && archive.nlink === 1, 'backup_archive_empty_or_changed');
    await dump.close();
    dump = undefined;
    // This checks archive readability, not a database restore or recovery RTO.
    await run('pg_restore', ['--list', temporary], { env, timeout: 60_000, signal });
    check(!signal?.aborted && await absent(finalPath), 'backup_interrupted_or_destination_exists');
    await rename(temporary, finalPath);
    temporaryCreated = false;
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    const removed = await prune(directory, now, owner);
    return { status: 'backup_created', file: finalPath, bytes: archive.size, archiveListVerified: true,
      restoreVerified: false, oldDumpsRemoved: removed };
  } finally {
    if (dump) await dump.close();
    if (temporaryCreated) await unlink(temporary);
    await lock.close();
    await unlink(lockPath);
  }
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Run as root with Node >=22.13. Fixed input: /etc/duduhire/migration.env; fixed target: owner/duduhire over verify-full TLS. No arguments enable other targets.');
    return;
  }
  check(process.argv.length === 2 && process.getuid?.() === 0, 'backup_requires_root_and_no_arguments');
  process.umask(0o077);
  await trustedAncestors(BACKUP_DIRECTORY, 0);
  const env = connectionEnvironment(await protectedFile(ENV_FILE, 0, 0o600));
  const ca = await protectedFile(CA_FILE, 0);
  check(ca.includes('-----BEGIN CERTIFICATE-----'), 'backup_ca_invalid');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    console.log(JSON.stringify(await createBackup({ directory: BACKUP_DIRECTORY, env, owner: 0, signal: controller.signal })));
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never print database URLs, passwords, tool stderr, archive data, or raw errors.
    const code = /^backup_[a-z_]+$/u.test(error?.message || '') ? error.message : 'backup_failed';
    console.error(JSON.stringify({ status: 'backup_failed', code,
      message: 'Check protected configuration, tool availability and backup directory. Completed backups are never overwritten.' }));
    process.exitCode = 1;
  });
}
