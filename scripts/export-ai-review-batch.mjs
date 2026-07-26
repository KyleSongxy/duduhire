import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, 'data/ai-eval-seed.jsonl');
const outputPath = resolve(root, process.env.AI_REVIEW_BATCH || 'data/ai-review-batch.jsonl');
const requestedCount = Math.min(Math.max(Number(process.env.AI_REVIEW_COUNT) || 30, 1), 100);

const cases = (await readFile(sourcePath, 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

const pending = cases.filter((item) => item.review_status === 'pending');
const demandTarget = Math.ceil(requestedCount / 2);
const selected = [
  ...pending.filter((item) => item.flow === 'demand').slice(0, demandTarget),
  ...pending.filter((item) => item.flow === 'capability').slice(0, requestedCount - demandTarget),
].slice(0, requestedCount);

const batch = selected.map((item) => ({
  case_id: item.case_id,
  flow: item.flow,
  input: item.input,
  proposed_expected: item.expected,
  review: {
    reviewer: '',
    decision: 'pending',
    corrected_expected: null,
    error_tags: [],
    note: '',
    reviewed_at: null,
  },
}));

await writeFile(outputPath, `${batch.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
console.log(`Exported ${batch.length} cases to ${outputPath}.`);
console.log('A human reviewer must fill reviewer, decision, corrected_expected, and reviewed_at before applying.');
