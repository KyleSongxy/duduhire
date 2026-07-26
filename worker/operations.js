import { validateAnalysis } from './analysis.js';
import { matchAnalysis } from './matching.js';
import { getRedactionTypes, redactJsonValue, redactSensitiveText } from './privacy.js';
import {
  consumeDurableRateLimit,
  enqueueReview,
  getOperationsMetrics,
  hasDatabase,
  listReviews,
  resolveReview,
  saveFeedback,
} from './storage.js';

const allowedFlows = new Set(['demand', 'capability']);
const allowedFeedbackTargets = new Set(['analysis', 'questions', 'match']);
const allowedVerdicts = new Set(['helpful', 'partly_helpful', 'not_helpful']);
const allowedReviewStatuses = new Set(['pending', 'in_review', 'resolved', 'rejected']);

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

function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  return !origin || origin === url.origin;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function normalizeEmailHeader(request) {
  return (request.headers.get('oai-authenticated-user-email') || '').trim().toLowerCase();
}

function isReviewer(request, env) {
  const email = normalizeEmailHeader(request);
  const allowedEmails = String(env.REVIEWER_EMAILS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (email && allowedEmails.includes(email)) return true;
  const suppliedToken = request.headers.get('x-review-admin-token') || '';
  return Boolean(env.REVIEW_ADMIN_TOKEN && suppliedToken && suppliedToken === env.REVIEW_ADMIN_TOKEN);
}

export async function handleOperationsRequest(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;

  if (url.pathname === '/api/operations/status' && request.method === 'GET') {
    return jsonResponse({
      database: hasDatabase(env),
      feedback: hasDatabase(env),
      review: hasDatabase(env),
      reviewer: isReviewer(request, env),
      redaction_types: getRedactionTypes(),
    });
  }

  if (!sameOrigin(request, url)) return jsonResponse({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
  if (request.method !== 'GET') {
    const contentLength = Number.parseInt(request.headers.get('content-length') || '0', 10);
    if (Number.isFinite(contentLength) && contentLength > 250000) {
      return jsonResponse({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    }
  }

  if (url.pathname === '/api/match' && request.method === 'POST') {
    const body = await readJson(request);
    if (!body || !allowedFlows.has(body.flow) || !body.analysis) {
      return jsonResponse({ error: 'INVALID_MATCH_INPUT' }, 400);
    }
    const validation = validateAnalysis(body.flow, body.analysis, body.analysis.source || {});
    if (!validation.valid) {
      return jsonResponse({ error: 'INVALID_ANALYSIS', issues: validation.issues.slice(0, 6) }, 422);
    }
    return jsonResponse(matchAnalysis(body.flow, body.analysis, body.confirmation || {}));
  }

  if (url.pathname === '/api/feedback' && request.method === 'POST') {
    if (!hasDatabase(env)) return jsonResponse({ error: 'STORAGE_UNAVAILABLE' }, 503);
    const rateLimit = await consumeDurableRateLimit(request, env, {
      limit: 30,
      scope: 'feedback',
    });
    if (rateLimit && !rateLimit.allowed) {
      return jsonResponse({ error: 'RATE_LIMITED' }, 429);
    }
    const body = await readJson(request);
    if (
      !body
      || !allowedFlows.has(body.flow)
      || !allowedFeedbackTargets.has(body.target)
      || !allowedVerdicts.has(body.verdict)
    ) {
      return jsonResponse({ error: 'INVALID_FEEDBACK' }, 400);
    }
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((item) => typeof item === 'string').slice(0, 8)
      : [];
    const comment = redactSensitiveText(String(body.comment || '').slice(0, 800)).text;
    const id = await saveFeedback(env, {
      receiptId: typeof body.receiptId === 'string' ? body.receiptId.slice(0, 80) : null,
      flow: body.flow,
      target: body.target,
      verdict: body.verdict,
      tags,
      comment,
      consent: Boolean(body.consent),
    });
    return jsonResponse({ saved: true, id }, 201);
  }

  if (url.pathname === '/api/review' && request.method === 'POST') {
    if (!hasDatabase(env)) return jsonResponse({ error: 'STORAGE_UNAVAILABLE' }, 503);
    const rateLimit = await consumeDurableRateLimit(request, env, {
      limit: 5,
      scope: 'review',
    });
    if (rateLimit && !rateLimit.allowed) {
      return jsonResponse({ error: 'RATE_LIMITED' }, 429);
    }
    const body = await readJson(request);
    if (!body?.consent) return jsonResponse({ error: 'CONSENT_REQUIRED' }, 400);
    if (!allowedFlows.has(body.flow) || !body.analysis) {
      return jsonResponse({ error: 'INVALID_REVIEW_INPUT' }, 400);
    }
    const payload = redactJsonValue({
      analysis: {
        ...body.analysis,
        source: {
          ...body.analysis.source,
          text: redactSensitiveText(body.analysis.source?.text || body.text || '').text.slice(0, 5000),
        },
      },
      user_note: String(body.note || '').slice(0, 1000),
    });
    const id = await enqueueReview(env, {
      flow: body.flow,
      riskFlags: body.analysis.risk_flags || [],
      payload,
    });
    return jsonResponse({ queued: true, id }, 201);
  }

  if (url.pathname === '/api/reviews' && request.method === 'GET') {
    if (!isReviewer(request, env)) return jsonResponse({ error: 'REVIEWER_REQUIRED' }, 401);
    const status = url.searchParams.get('status') || 'pending';
    if (status !== 'all' && !allowedReviewStatuses.has(status)) {
      return jsonResponse({ error: 'INVALID_STATUS' }, 400);
    }
    const reviews = await listReviews(env, status, url.searchParams.get('limit'));
    return jsonResponse({ reviews });
  }

  const reviewMatch = url.pathname.match(/^\/api\/reviews\/([a-zA-Z0-9_]+)$/);
  if (reviewMatch && request.method === 'PATCH') {
    if (!isReviewer(request, env)) return jsonResponse({ error: 'REVIEWER_REQUIRED' }, 401);
    const body = await readJson(request);
    if (!body || !allowedReviewStatuses.has(body.status)) {
      return jsonResponse({ error: 'INVALID_REVIEW_UPDATE' }, 400);
    }
    const updated = await resolveReview(env, reviewMatch[1], {
      status: body.status,
      reviewerNote: redactSensitiveText(String(body.reviewerNote || '').slice(0, 1200)).text,
      resolution: String(body.resolution || '').slice(0, 80),
    });
    return jsonResponse({ updated }, updated ? 200 : 404);
  }

  if (url.pathname === '/api/metrics' && request.method === 'GET') {
    if (!isReviewer(request, env)) return jsonResponse({ error: 'REVIEWER_REQUIRED' }, 401);
    const metrics = await getOperationsMetrics(env, url.searchParams.get('days'));
    return jsonResponse({ metrics });
  }

  return null;
}
