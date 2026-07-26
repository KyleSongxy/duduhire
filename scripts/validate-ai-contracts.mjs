import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(projectRoot, relativePath), 'utf8'));
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});

const demandSchema = await readJson('schemas/demand-analysis.schema.json');
const capabilitySchema = await readJson('schemas/capability-analysis.schema.json');

ajv.compile(demandSchema);
ajv.compile(capabilitySchema);

const seedText = await readFile(resolve(projectRoot, 'data/ai-eval-seed.jsonl'), 'utf8');
const seedCases = seedText.trim().split('\n').map((line, index) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
  }
});

const ids = new Set();
const allowedFlows = new Set(['demand', 'capability']);
const errors = [];

for (const [index, item] of seedCases.entries()) {
  const location = `line ${index + 1}`;
  if (!item.case_id || typeof item.case_id !== 'string') errors.push(`${location}: missing case_id`);
  if (ids.has(item.case_id)) errors.push(`${location}: duplicate case_id ${item.case_id}`);
  ids.add(item.case_id);
  if (!allowedFlows.has(item.flow)) errors.push(`${location}: invalid flow ${item.flow}`);
  if (typeof item.input !== 'string' || !item.input.trim()) errors.push(`${location}: empty input`);
  if (item.review_status !== 'pending') errors.push(`${location}: seed cases must remain pending before human review`);
  if (!Array.isArray(item.expected?.status_any_of) || item.expected.status_any_of.length === 0) {
    errors.push(`${location}: expected.status_any_of is required`);
  }
  if (!Array.isArray(item.expected?.forbidden_claims)) {
    errors.push(`${location}: expected.forbidden_claims must be an array`);
  }
}

if (seedCases.length !== 100) errors.push(`expected 100 seed cases, found ${seedCases.length}`);

const demandCount = seedCases.filter((item) => item.flow === 'demand').length;
const capabilityCount = seedCases.filter((item) => item.flow === 'capability').length;
if (demandCount !== 47) errors.push(`expected 47 demand cases, found ${demandCount}`);
if (capabilityCount !== 53) errors.push(`expected 53 capability cases, found ${capabilityCount}`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('AI contracts are valid.');
  console.log(`Seed set: ${seedCases.length} cases (${demandCount} demand, ${capabilityCount} capability).`);
  console.log('Review status: 100 pending, 0 reviewed, 0 adjudicated.');
}
