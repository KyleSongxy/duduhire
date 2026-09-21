import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { backupDate, connectionEnvironment, createBackup, prune } from './backup-duduhire.mjs';

const settings = 'NODE_ENV=production\nMIGRATION_DATABASE_SSL=true\nMIGRATION_DATABASE_URL="postgresql://duduhire_owner:synthetic%3Ap%40ss@localhost:5432/duduhire"\nNODE_EXTRA_CA_CERTS=/etc/duduhire/ca.crt\n';
const NOW = Date.parse('2026-09-12T03:30:00.000Z');
const OLD_NAME = 'duduhire-20260901T033000000Z-012345abcdef.dump';
const CURRENT_NAME = 'duduhire-20260911T033000000Z-012345abcdef.dump';
const owner = process.getuid();

async function directory(context) {
  const root = await mkdtemp(join(tmpdir(), 'duduhire-backup-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const backup = join(root, 'backups');
  await mkdir(backup, { mode: 0o700 });
  return { root, backup };
}

async function oldFile(path, data = 'synthetic old archive') {
  await writeFile(path, data, { mode: 0o600 });
  await utimes(path, new Date('2026-09-01'), new Date('2026-09-01'));
}

test('only owner/duduhire on local verified TLS is accepted and unrelated dotenv keys cannot override libpq', () => {
  const env = connectionEnvironment(settings + 'PGSSLMODE=disable\nPGSERVICE=other\nPGDATABASE=zjad\nPGSSLROOTCERT=/wrong\n');
  assert.equal(env.PGUSER, 'duduhire_owner');
  assert.equal(env.PGDATABASE, 'duduhire');
  assert.equal(env.PGPASSWORD, 'synthetic:p@ss');
  assert.equal(env.PGSSLMODE, 'verify-full');
  assert.equal(env.PGSSLROOTCERT, '/etc/duduhire/ca.crt');
  assert.equal(env.PGHOSTADDR, '127.0.0.1');
  assert.equal(env.PGSERVICE, undefined);
  for (const changed of [
    settings.replace('/duduhire"', '/zjad"'), settings.replace('duduhire_owner:', 'postgres:'),
    settings.replace('@localhost:', '@remote.example:'), settings.replace('5432', '5433'),
    settings.replace('/duduhire"', '/duduhire?sslmode=disable"'), settings.replace('SSL=true', 'SSL=false'),
    settings.replace('/etc/duduhire/ca.crt', '/wrong/ca.crt'), settings.replace('production', 'development'),
  ]) assert.throws(() => connectionEnvironment(changed), { message: 'backup_connection_configuration_invalid' });
});

test('success validates a private temp archive before rename; credentials never enter tool argv', async (context) => {
  const { backup } = await directory(context);
  const calls = [];
  const env = connectionEnvironment(settings);
  const result = await createBackup({ directory: backup, owner, now: NOW, env, run: async (command, args, options) => {
    calls.push({ command, args });
    assert.equal(args.some((value) => /postgresql:|synthetic:p@ss|PGPASSWORD/u.test(value)), false);
    if (command === 'pg_dump') {
      assert.equal(options.env.PGSSLMODE, 'verify-full');
      writeSync(options.stdout, 'synthetic custom archive');
    } else {
      assert.equal(command, 'pg_restore');
      assert.equal(args[0], '--list');
      assert.ok(args[1].endsWith('.dump.tmp'));
      assert.equal((await stat(args[1])).mode & 0o777, 0o600);
      assert.equal((await readdir(backup)).some((name) => name.endsWith('.dump')), false);
    }
  } });
  assert.equal(result.status, 'backup_created');
  assert.equal(result.archiveListVerified, true);
  assert.equal(result.restoreVerified, false);
  assert.equal((await stat(result.file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(backup)).map((name) => name.endsWith('.dump')), [true]);
  assert.deepEqual(calls.map(({ command }) => command), ['pg_dump', 'pg_restore']);
});

for (const failAt of ['pg_dump', 'pg_restore']) test(`${failAt} failure does not publish or prune existing backups`, async (context) => {
  const { backup } = await directory(context);
  await oldFile(join(backup, OLD_NAME));
  await assert.rejects(createBackup({ directory: backup, owner, now: NOW, env: connectionEnvironment(settings), run: async (command, _args, options) => {
    if (command === failAt) throw new Error('synthetic failure');
    writeSync(options.stdout, 'synthetic archive');
  } }), /synthetic failure/u);
  assert.deepEqual(await readdir(backup), [OLD_NAME]);
});

test('empty dump is rejected before pg_restore and leaves no published archive', async (context) => {
  const { backup } = await directory(context);
  let calls = 0;
  await assert.rejects(createBackup({ directory: backup, owner, now: NOW, env: {}, run: async () => { calls += 1; } }), /backup_archive_empty/u);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(backup), []);
});

test('retention removes only old named private regular archives, never symlinks, hardlinks or unrelated files', async (context) => {
  const { root, backup } = await directory(context);
  await oldFile(join(backup, OLD_NAME));
  await oldFile(join(backup, CURRENT_NAME));
  await oldFile(join(backup, 'zjad-20260901.dump'));
  await oldFile(join(backup, '.temporary.dump.tmp'));
  const outside = join(root, 'outside.dump');
  await oldFile(outside);
  const symlinkName = 'duduhire-20260901T033000000Z-abcdef012345.dump';
  const hardlinkName = 'duduhire-20260901T033000000Z-abcdef012346.dump';
  await symlink(outside, join(backup, symlinkName));
  await link(outside, join(backup, hardlinkName));
  const freshMtimeName = 'duduhire-20260901T033000000Z-abcdef012347.dump';
  await oldFile(join(backup, freshMtimeName));
  await utimes(join(backup, freshMtimeName), new Date(NOW), new Date(NOW));
  assert.equal(await prune(backup, NOW, owner), 1);
  assert.equal(await readFile(outside, 'utf8'), 'synthetic old archive');
  const remaining = await readdir(backup);
  assert.equal(remaining.includes(OLD_NAME), false);
  for (const name of [CURRENT_NAME, 'zjad-20260901.dump', '.temporary.dump.tmp', symlinkName, hardlinkName, freshMtimeName]) assert.ok(remaining.includes(name));
});

test('unsafe output directory and an existing lock fail before running any database tool', async (context) => {
  const { root, backup } = await directory(context);
  const linked = join(root, 'linked');
  await symlink(backup, linked);
  const run = async () => assert.fail('must not call a database tool');
  await assert.rejects(createBackup({ directory: linked, owner, now: NOW, env: {}, run }), /backup_directory_permissions_invalid/u);
  await writeFile(join(backup, '.backup.lock'), 'another process', { mode: 0o600 });
  await assert.rejects(createBackup({ directory: backup, owner, now: NOW, env: {}, run }), { code: 'EEXIST' });
  assert.equal(await readFile(join(backup, '.backup.lock'), 'utf8'), 'another process');
});

test('retention timestamps must have the exact generated format and a real UTC date', () => {
  assert.equal(backupDate(OLD_NAME), Date.parse('2026-09-01T03:30:00.000Z'));
  assert.equal(backupDate('duduhire-20260230T033000000Z-012345abcdef.dump'), null);
  assert.equal(backupDate('../' + OLD_NAME), null);
  assert.equal(backupDate(OLD_NAME + '.bak'), null);
});
