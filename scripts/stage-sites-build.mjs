import { access, copyFile, cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const dist = resolve(projectRoot, 'dist');
const client = resolve(dist, 'client');
const generatedWorker = resolve(dist, 'duduhire', 'index.js');
const serverWorker = resolve(dist, 'server', 'index.js');

await access(generatedWorker);
await access(resolve(client, 'index.html'));

await mkdir(resolve(dist, 'server'), { recursive: true });
await copyFile(generatedWorker, serverWorker);

for (const directory of ['assets', 'css', 'js', 'data']) {
  await cp(resolve(projectRoot, directory), resolve(client, directory), {
    recursive: true,
  });
}

const browserVendorDirectory = resolve(client, 'js', 'vendor');
await mkdir(browserVendorDirectory, { recursive: true });
for (const [source, destination] of [
  ['node_modules/pdfjs-dist/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['node_modules/mammoth/mammoth.browser.min.js', 'mammoth.browser.min.js'],
]) {
  await copyFile(resolve(projectRoot, source), resolve(browserVendorDirectory, destination));
}

for (const page of [
  'skill-builder.html',
  'skill-leaderboard.html',
  'service-notice.html',
  'review-console.html',
]) {
  await copyFile(resolve(projectRoot, page), resolve(client, page));
}
