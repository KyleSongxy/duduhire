import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let links = 0;
let assets = 0;
const docs = ['README.md', 'ops/README.md', ...readdirSync(join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
for (const file of docs) {
  const text = readFileSync(join(root, file), 'utf8').replace(/```[\s\S]*?```/gu, '');
  for (const match of text.matchAll(/\[[^\]\n]+\]\((<[^>]+>|[^\s)]+)\)/gu)) {
    const href = match[1].replace(/^<|>$/gu, '');
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/iu.test(href)) continue;
    const target = decodeURIComponent(href.split('#')[0]);
    if (!target) continue;
    links++;
    if (!existsSync(resolve(root, dirname(file), target))) failures.push(`${file}: missing link ${href}`);
  }
}
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) { inspect(file); continue; }
    if (!/\.(?:tsx?|css|html)$/u.test(entry.name)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(/["'`(](\/(?:images|fonts)\/[^"'`)\s]+)/gu)) {
      assets++;
      if (!existsSync(join(root, 'apps/web/public', match[1]))) failures.push(`${file}: missing asset ${match[1]}`);
    }
  }
}
inspect(join(root, 'apps/web/src'));
for (const match of readFileSync(join(root, 'apps/web/index.html'), 'utf8').matchAll(/(?:href|src)="(\/(?:images|fonts)\/[^"?]+)/gu)) {
  assets++;
  if (!existsSync(join(root, 'apps/web/public', match[1]))) failures.push(`index.html: missing asset ${match[1]}`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Repository references OK: ${links} local document links, ${assets} static asset references.`);
}
