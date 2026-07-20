import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const buildDirectory = resolve(projectRoot, 'dist');

if (!buildDirectory.startsWith(`${projectRoot}/`)) {
  throw new Error('Refusing to clean a build directory outside the project.');
}

await rm(buildDirectory, { recursive: true, force: true });
