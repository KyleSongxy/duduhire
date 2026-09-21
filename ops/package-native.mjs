#!/usr/bin/env node
// Offline release packaging only. Never connects to or changes a server.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const migrations = [
  '001_auth_and_profiles.sql', '002_bind_email_challenges_to_browser.sql',
  '003_marketplace_persistence.sql', '004_finalize_browser_binding.sql',
  '005_preserve_superseded_intakes.sql', '006_inquiry_operations.sql',
  '007_bilateral_matching.sql', '008_matching_knowledge_and_examples.sql',
  '009_phone_authentication.sql',
  '010_password_authentication.sql',
  '011_session_active_role.sql',
].map(name => `apps/api/migrations/${name}`);
const fixedFiles = [
  'package.json', 'package-lock.json', 'apps/api/package.json', 'apps/web/package.json',
  'apps/api/sql/grant-database-roles.sql', 'docs/DATABASE_ROLES.md',
  'docs/NATIVE_DEPLOYMENT.md', 'ops/package-native.mjs', ...migrations,
];
const requiredFiles = [...fixedFiles, 'apps/api/dist/server.js', 'apps/api/dist/migrate.js',
  'apps/web/dist/index.html', 'apps/web/dist/service-worker.js'];
const generatedFiles = ['RELEASE.json', 'SHA256SUMS'];
const webExtensions = new Set(['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg',
  '.webp', '.avif', '.gif', '.ico', '.mp4', '.webm', '.woff', '.woff2', '.txt', '.webmanifest']);
const digest = data => createHash('sha256').update(data).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function allowedPath(name) {
  assert(/^[A-Za-z0-9_./-]+$/.test(name), `Non-portable archive path: ${name}`);
  assert(!name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..'),
    `Unsafe archive path: ${name}`);
  assert(!name.split('/').some(part => part.startsWith('.') || part === 'node_modules' || part === '__MACOSX'),
    `Forbidden archive path: ${name}`);
  assert(fixedFiles.includes(name) || generatedFiles.includes(name)
    || (name.startsWith('apps/api/dist/') && /(?:\.js|\.d\.ts)$/.test(name))
    || (name.startsWith('apps/web/dist/') && webExtensions.has(extname(name))),
  `Path outside release allowlist: ${name}`);
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function collect(relativePath) {
  // Check every ancestor too: a normal file under a symlinked directory is rejected.
  let path = root;
  for (const part of relativePath.split('/')) {
    path = join(path, part);
    assert(!(await lstat(path)).isSymbolicLink(), `Symlink rejected: ${relativePath}`);
  }
  const info = await lstat(path);
  if (info.isDirectory()) {
    const files = [];
    for (const name of (await readdir(path)).sort()) {
      if (name === '.DS_Store' || name.startsWith('._') || name.endsWith('.map')) continue;
      files.push(...await collect(`${relativePath}/${name}`));
    }
    return files;
  }
  assert(info.isFile() && info.nlink === 1, `Non-regular or hard-linked source rejected: ${relativePath}`);
  allowedPath(relativePath);
  return [relativePath];
}

// Emit strict USTAR regular files ourselves: no filesystem ownership, xattrs,
// resource forks, links, extended headers, host timestamps or absolute paths.
function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  let shortName = name;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const slash = name.lastIndexOf('/');
    prefix = name.slice(0, slash);
    shortName = name.slice(slash + 1);
  }
  assert(Buffer.byteLength(shortName) <= 100 && Buffer.byteLength(prefix) <= 155, `USTAR path too long: ${name}`);
  const octal = (value, offset, length) => {
    const text = value.toString(8).padStart(length - 1, '0');
    assert(text.length < length, `USTAR numeric overflow: ${name}`);
    header.write(text, offset, length - 1, 'ascii');
  };
  header.write(shortName, 0, 100, 'ascii');
  octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(size, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
  header.write(`${checksum}\0 `, 148, 8, 'ascii');
  return header;
}

async function* tarFiles(stage, names) {
  for (const name of names) {
    const path = join(stage, name);
    const size = (await lstat(path)).size;
    yield tarHeader(name, size);
    let consumed = 0;
    for await (const chunk of createReadStream(path)) { consumed += chunk.length; yield chunk; }
    assert(consumed === size, `Staged file changed while archiving: ${name}`);
    if (size % 512) yield Buffer.alloc(512 - size % 512);
  }
  yield Buffer.alloc(1024);
}

async function verify(archive) {
  const checksumPath = `${archive}.sha256`;
  const checksum = (await readFile(checksumPath, 'utf8')).trim();
  const actualArchiveHash = await fileHash(archive);
  assert(checksum === `${actualArchiveHash}  ${basename(archive)}`, 'Archive SHA256 mismatch');
  // This bounded local format is intentionally not a general-purpose tar extractor.
  // A 512 MiB ceiling also prevents unbounded decompression of an untrusted file.
  const tar = gunzipSync(await readFile(archive), { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map();
  const texts = new Map();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      assert(tar.length - offset >= 1024 && tar.subarray(offset).every(byte => byte === 0), 'Invalid tar terminator');
      ended = true;
      break;
    }
    const field = (start, length) => header.subarray(start, start + length).toString('ascii').split('\0')[0];
    const number = (start, length) => {
      const text = field(start, length).trim();
      assert(/^[0-7]+$/.test(text), 'Invalid tar numeric field');
      return Number.parseInt(text, 8);
    };
    const storedChecksum = number(148, 8);
    const checkHeader = Buffer.from(header);
    checkHeader.fill(32, 148, 156);
    assert(storedChecksum === checkHeader.reduce((sum, byte) => sum + byte, 0), 'Tar header checksum mismatch');
    assert(field(257, 6) === 'ustar' && field(263, 2) === '00', 'Unsupported tar format');
    assert(field(156, 1) === '0' && !field(157, 100), 'Archive must contain regular files only');
    assert(number(100, 8) === 0o644 && number(108, 8) === 0 && number(116, 8) === 0,
      'Unexpected archive permissions or ownership');
    const prefix = field(345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${field(0, 100)}`;
    allowedPath(name);
    assert(!files.has(name), `Duplicate archive entry: ${name}`);
    const size = number(124, 12);
    const start = offset + 512;
    const end = start + size;
    assert(Number.isSafeInteger(size) && end <= tar.length, 'Truncated archive entry');
    const content = tar.subarray(start, end);
    files.set(name, digest(content));
    if (generatedFiles.includes(name)) texts.set(name, content.toString('utf8'));
    offset = start + Math.ceil(size / 512) * 512;
    assert(offset <= tar.length && tar.subarray(end, offset).every(byte => byte === 0), 'Invalid tar padding');
  }
  assert(ended, 'Missing archive terminator');
  for (const name of [...requiredFiles, ...generatedFiles]) assert(files.has(name), `Required file missing: ${name}`);
  const manifestNames = new Set();
  for (const line of texts.get('SHA256SUMS').trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert(match && match[2] !== 'SHA256SUMS', 'Invalid SHA256SUMS record');
    const [, expected, name] = match;
    assert(!manifestNames.has(name), `Duplicate checksum record: ${name}`);
    assert(files.get(name) === expected, `Payload SHA256 mismatch: ${name}`);
    manifestNames.add(name);
  }
  assert(manifestNames.size === files.size - 1, 'Manifest does not cover every payload file');
  const metadata = JSON.parse(texts.get('RELEASE.json'));
  assert(metadata.schemaVersion === 1 && metadata.payloadFileCount === files.size - 2, 'Release metadata mismatch');
  assert(JSON.stringify(metadata.migrations) === JSON.stringify(migrations), 'Migration inventory mismatch');
  return { archive, sha256: actualArchiveHash, bytes: (await lstat(archive)).size,
    payloadFiles: metadata.payloadFileCount, migrationFiles: migrations.length,
    releaseId: metadata.releaseId, verification: 'PASS: archive digest, safe regular paths, required files, complete SHA256 manifest' };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--verify' && args.length === 2) {
    process.stdout.write(`${JSON.stringify(await verify(resolve(args[1])), null, 2)}\n`);
    return;
  }
  if (args.includes('--help')) {
    process.stdout.write('node ops/package-native.mjs [--output /tmp/duduhire-native-release] [--id safe-release-id]\nnode ops/package-native.mjs --verify /absolute/path/release.tar.gz\n');
    return;
  }
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    assert(['--output', '--id'].includes(args[i]) && args[i + 1] && !options.has(args[i]), 'Invalid or duplicate argument; use --help');
    options.set(args[i], args[i + 1]);
  }
  const now = new Date();
  const id = options.get('--id') || `duduhire-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id), 'Invalid release id');
  const output = resolve(options.get('--output') || '/tmp/duduhire-native-release');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const destination = join(await realpath(output), id);
  // No overwrite or cleanup of previous releases; a collision fails explicitly.
  await mkdir(destination, { mode: 0o700 });
  const stage = join(destination, 'payload');
  await mkdir(stage, { mode: 0o700 });
  const actualMigrations = (await readdir(join(root, 'apps/api/migrations'))).filter(name => name.endsWith('.sql')).sort();
  assert(JSON.stringify(actualMigrations) === JSON.stringify(migrations.map(name => basename(name))),
    'Migration directory changed; explicitly update the release inventory first');
  const names = [...fixedFiles];
  for (const tree of ['apps/api/dist', 'apps/web/dist']) names.push(...await collect(tree));
  names.sort();
  for (const name of requiredFiles) assert(names.includes(name), `Required build output missing: ${name}`);
  const hashes = [];
  for (const name of names) {
    await collect(name);
    const source = join(root, name);
    const target = join(stage, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const sourceHash = await fileHash(source);
    await copyFile(source, target);
    const stagedHash = await fileHash(target);
    assert(sourceHash === stagedHash, `Source changed during packaging: ${name}`);
    hashes.push(`${stagedHash}  ${name}`);
  }
  const metadata = { schemaVersion: 1, releaseId: id, createdAt: now.toISOString(),
    node: '>=22.13', dependencyInstallPlatform: 'target Linux server',
    payloadFileCount: names.length, migrations, status: 'packaged; server acceptance pending' };
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  await writeFile(join(stage, 'RELEASE.json'), metadataText, { mode: 0o600, flag: 'wx' });
  hashes.push(`${digest(metadataText)}  RELEASE.json`);
  await writeFile(join(stage, 'SHA256SUMS'), `${hashes.sort().join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  const archive = join(destination, `${id}.tar.gz`);
  await pipeline(Readable.from(tarFiles(stage, [...names, ...generatedFiles].sort())), createGzip({ level: 6 }),
    createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
  await writeFile(`${archive}.sha256`, `${await fileHash(archive)}  ${basename(archive)}\n`, { mode: 0o600, flag: 'wx' });
  const result = await verify(archive);
  await writeFile(join(destination, 'verification.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try { await main(); } catch (error) {
  process.stderr.write(`Release packaging failed: ${error.message}\n`);
  process.exitCode = 1;
}
