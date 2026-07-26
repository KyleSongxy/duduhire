import {
  adjudicateEvaluationCase,
  listEvaluationCases,
  saveEvaluationReview,
  seedEvaluationCases,
} from './storage.js';
import { redactSensitiveText } from './privacy.js';
import evalSeedText from '../data/ai-eval-seed.jsonl?raw';

const statuses = new Set(['all', 'pending', 'reviewing', 'agreed', 'disputed', 'adjudicated']);
const decisions = new Set(['accept', 'edit']);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function ensureSeeds(env) {
  const cases = evalSeedText
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (cases.length !== 100) throw new Error('EVALUATION_SEED_COUNT_INVALID');
  await seedEvaluationCases(env, cases);
}

function validateExpected(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray(value.status_any_of)
    && value.status_any_of.length
    && Array.isArray(value.forbidden_claims),
  );
}

export async function handleEvaluationRequest(request, env, auth) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/evaluation')) return null;
  if (!auth.isReviewer) return jsonResponse({ error: 'REVIEWER_REQUIRED' }, 401);
  await ensureSeeds(env);

  if (url.pathname === '/api/evaluation/cases' && request.method === 'GET') {
    const status = url.searchParams.get('status') || 'all';
    if (!statuses.has(status)) return jsonResponse({ error: 'INVALID_STATUS' }, 400);
    const cases = await listEvaluationCases(env, status, url.searchParams.get('limit'));
    return jsonResponse({ cases });
  }

  const reviewMatch = url.pathname.match(/^\/api\/evaluation\/cases\/([^/]+)\/reviews$/);
  if (reviewMatch && request.method === 'POST') {
    const body = await readJson(request);
    if (!body || !decisions.has(body.decision) || !validateExpected(body.expected)) {
      return jsonResponse({ error: 'INVALID_REVIEW' }, 400);
    }
    const result = await saveEvaluationReview(env, decodeURIComponent(reviewMatch[1]), {
      reviewerKey: auth.reviewerKey,
      decision: body.decision,
      expected: body.expected,
      note: redactSensitiveText(String(body.note || '').slice(0, 1200)).text,
    });
    return jsonResponse(result, result.saved ? 201 : 409);
  }

  const adjudicateMatch = url.pathname.match(/^\/api\/evaluation\/cases\/([^/]+)\/adjudicate$/);
  if (adjudicateMatch && request.method === 'POST') {
    const body = await readJson(request);
    if (!body || !validateExpected(body.expected)) {
      return jsonResponse({ error: 'INVALID_ADJUDICATION' }, 400);
    }
    const result = await adjudicateEvaluationCase(env, decodeURIComponent(adjudicateMatch[1]), {
      reviewerKey: auth.reviewerKey,
      expected: body.expected,
      note: redactSensitiveText(String(body.note || '').slice(0, 1200)).text,
    });
    return jsonResponse(result, result.saved ? 201 : 409);
  }

  return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
}
