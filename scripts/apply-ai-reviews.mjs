import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const seedPath = resolve(root, 'data/ai-eval-seed.jsonl');
const reviewPath = resolve(root, process.env.AI_REVIEW_BATCH || 'data/ai-review-batch.jsonl');

const parseJsonl = (text) => text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const seeds = parseJsonl(await readFile(seedPath, 'utf8'));
const reviews = parseJsonl(await readFile(reviewPath, 'utf8'));
const seedById = new Map(seeds.map((item) => [item.case_id, item]));
const allowedDecisions = new Set(['reviewed', 'adjudicated']);
const errors = [];

for (const item of reviews) {
  const review = item.review || {};
  const seed = seedById.get(item.case_id);
  if (!seed) {
    errors.push(`${item.case_id}: case does not exist in seed set`);
    continue;
  }
  if (!review.reviewer?.trim()) errors.push(`${item.case_id}: reviewer is required`);
  if (!allowedDecisions.has(review.decision)) {
    errors.push(`${item.case_id}: decision must be reviewed or adjudicated`);
  }
  if (!review.reviewed_at || Number.isNaN(Date.parse(review.reviewed_at))) {
    errors.push(`${item.case_id}: reviewed_at must be an ISO date`);
  }
  if (review.corrected_expected && typeof review.corrected_expected !== 'object') {
    errors.push(`${item.case_id}: corrected_expected must be an object or null`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

for (const item of reviews) {
  const seed = seedById.get(item.case_id);
  seed.expected = item.review.corrected_expected || item.proposed_expected || seed.expected;
  seed.review_status = item.review.decision;
  seed.review = {
    reviewer: item.review.reviewer.trim(),
    error_tags: Array.isArray(item.review.error_tags) ? item.review.error_tags : [],
    note: String(item.review.note || ''),
    reviewed_at: item.review.reviewed_at,
  };
}

await writeFile(seedPath, `${seeds.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
console.log(`Applied ${reviews.length} human review decisions to ${seedPath}.`);
