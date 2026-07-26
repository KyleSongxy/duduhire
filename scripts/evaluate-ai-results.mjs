import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const seedPath = resolve(root, 'data/ai-eval-seed.jsonl');
const resultsPath = resolve(root, process.env.AI_EVAL_RESULTS || 'data/ai-eval-results.jsonl');

function parseJsonl(text, label) {
  return text.trim().split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1}: ${error.message}`);
    }
  });
}

const seeds = parseJsonl(await readFile(seedPath, 'utf8'), 'seed');

try {
  await access(resultsPath);
} catch {
  console.log('Evaluation harness is ready.');
  console.log(`Seed cases: ${seeds.length}. Model results: 0.`);
  console.log('Set AI_EVAL_RESULTS to a JSONL file containing case_id, analysis, and matches to score a model run.');
  process.exit(0);
}

const results = parseJsonl(await readFile(resultsPath, 'utf8'), 'result');
const resultById = new Map(results.map((item) => [item.case_id, item]));
const scored = [];

for (const seed of seeds) {
  const result = resultById.get(seed.case_id);
  if (!result?.analysis) continue;
  const expected = seed.expected;
  const analysis = result.analysis;
  const quotes = seed.flow === 'demand'
    ? (analysis.facts || []).map((fact) => fact.source_quote)
    : (analysis.projects || []).flatMap((project) => [
        ...(project.source_quotes || []),
        ...(project.evidence || []).map((evidence) => evidence.source_quote),
      ]);
  const quoteGrounding = quotes.every((quote) => seed.input.includes(quote));
  const statusPass = expected.status_any_of.includes(analysis.status);
  const riskPass = (expected.risk_flags || []).every((flag) => (
    (analysis.risk_flags || []).includes(flag)
  ));
  const predictedIds = (result.matches || []).map((match) => match.id);
  const targets = expected.target_catalog_ids || [];
  const top3Hit = targets.length === 0 || targets.some((id) => predictedIds.slice(0, 3).includes(id));
  scored.push({
    caseId: seed.case_id,
    statusPass,
    riskPass,
    quoteGrounding,
    top3Hit,
    pass: statusPass && riskPass && quoteGrounding && top3Hit,
  });
}

function rate(predicate) {
  if (!scored.length) return 0;
  return scored.filter(predicate).length / scored.length;
}

const report = {
  seedCases: seeds.length,
  evaluatedCases: scored.length,
  coverage: scored.length / seeds.length,
  passRate: rate((item) => item.pass),
  statusAccuracy: rate((item) => item.statusPass),
  quoteGroundingRate: rate((item) => item.quoteGrounding),
  riskRecall: rate((item) => item.riskPass),
  top3Recall: rate((item) => item.top3Hit),
  failedCaseIds: scored.filter((item) => !item.pass).map((item) => item.caseId),
};

console.log(JSON.stringify(report, null, 2));

if (report.coverage === 1 && (
  report.quoteGroundingRate < 0.98
  || report.riskRecall < 1
  || report.top3Recall < 0.85
)) {
  process.exitCode = 1;
}
