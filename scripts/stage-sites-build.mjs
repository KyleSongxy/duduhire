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

for (const directory of ['assets', 'css', 'js']) {
  await cp(resolve(projectRoot, directory), resolve(client, directory), {
    recursive: true,
  });
}

for (const page of [
  'skill-builder.html',
  'skill-leaderboard.html',
  'service-notice.html',
  'review-console.html',
]) {
  await copyFile(resolve(projectRoot, page), resolve(client, page));
}
