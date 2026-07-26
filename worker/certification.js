import {
  consumeDurableRateLimit,
  createEvidenceSubmission,
  getEvidenceSubmission,
  hasDatabase,
  listEvidenceSubmissions,
  reviewEvidenceSubmission,
  submitMicrotask,
} from './storage.js';
import { redactSensitiveText, sha256 } from './privacy.js';

const allowedEvidenceTypes = new Set([
  'work_product',
  'acceptance_record',
  'metric_report',
  'process_record',
  'reference',
]);
const allowedReviewStatuses = new Set([
  'material_verified',
  'microtask_passed',
  'certified',
  'revision_required',
  'rejected',
]);
const allowedContentTypes = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
  'text/markdown',
]);
const maxFileBytes = 5 * 1024 * 1024;

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

function normalize(value, max = 1000) {
  return typeof value === 'string'
    ? value.trim().replace(/\r\n?/g, '\n').slice(0, max)
    : '';
}

function parseTerms(value) {
  return [...new Set(normalize(value, 1600)
    .split(/[,，;\n；]/)
    .map((item) => item.trim().slice(0, 80))
    .filter((item) => item.length >= 2))]
    .slice(0, 20);
}

function makeChallenge(capabilityName) {
  return {
    prompt: `请用一个未在材料中直接给出的具体情境，说明你会如何独立完成“${capabilityName}”：先写判断依据，再写操作步骤、交付物、验收方式和你不会越过的边界。`,
    rubric: [
      '判断依据与情境一致',
      '步骤可执行且由本人完成',
      '交付物与验收标准明确',
      '能说明限制、风险和升级条件',
    ],
  };
}

function makeOwnerToken() {
  return `evtok_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
}

async function digestBytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function safeFilename(value) {
  return normalize(value, 120)
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    || 'evidence';
}

async function ownerTokenHash(request, env) {
  const token = request.headers.get('x-evidence-token') || '';
  if (!/^evtok_[a-zA-Z0-9]{40,}$/.test(token)) return '';
  return sha256(`${env.RATE_LIMIT_SALT || 'duduhire-local'}:evidence:${token}`);
}

function publicEvidenceView(record) {
  if (!record) return null;
  return {
    id: record.id,
    capabilityName: record.capabilityName,
    evidenceType: record.evidenceType,
    description: record.description,
    sourceReference: record.sourceReference,
    fileName: record.fileName,
    byteSize: record.byteSize,
    hasFile: record.hasFile,
    level: record.level,
    status: record.status,
    reviewerNote: record.reviewerNote,
    challenge: record.challenge ? {
      id: record.challenge.id,
      prompt: record.challenge.available ? record.challenge.prompt : null,
      rubric: record.challenge.available ? record.challenge.rubric : [],
      available: record.challenge.available,
    } : null,
    microtask: record.microtask ? {
      status: record.microtask.status,
      score: record.microtask.score,
      reviewerNote: record.microtask.reviewerNote,
      submittedAt: record.microtask.submittedAt,
      reviewedAt: record.microtask.reviewedAt,
    } : null,
    events: record.events,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function handleCertificationRequest(request, env, auth) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/evidence-submissions')) return null;
  if (!hasDatabase(env)) return jsonResponse({ error: 'STORAGE_UNAVAILABLE' }, 503);

  if (url.pathname === '/api/evidence-submissions' && request.method === 'POST') {
    const contentLength = Number.parseInt(request.headers.get('content-length') || '0', 10);
    if (Number.isFinite(contentLength) && contentLength > maxFileBytes + 400000) {
      return jsonResponse({ error: 'PAYLOAD_TOO_LARGE', max_bytes: maxFileBytes }, 413);
    }
    const rateLimit = await consumeDurableRateLimit(request, env, {
      limit: 5,
      scope: 'evidence',
    });
    if (rateLimit && !rateLimit.allowed) return jsonResponse({ error: 'RATE_LIMITED' }, 429);
    let form;
    try {
      form = await request.formData();
    } catch {
      return jsonResponse({ error: 'INVALID_FORM_DATA' }, 400);
    }
    if (form.get('consent') !== 'true') return jsonResponse({ error: 'CONSENT_REQUIRED' }, 400);
    const capabilityName = normalize(form.get('capability_name'), 160);
    const atomId = normalize(form.get('atom_id'), 120);
    const evidenceType = normalize(form.get('evidence_type'), 40);
    const description = normalize(form.get('description'), 1800);
    const sourceReference = normalize(form.get('source_reference'), 500);
    const redactionTerms = parseTerms(form.get('redaction_terms'));
    const file = form.get('file');
    if (!capabilityName || !allowedEvidenceTypes.has(evidenceType) || description.length < 20) {
      return jsonResponse({ error: 'INVALID_EVIDENCE_INPUT' }, 400);
    }
    if (!sourceReference && (!(file instanceof File) || file.size === 0)) {
      return jsonResponse({ error: 'FILE_OR_REFERENCE_REQUIRED' }, 400);
    }
    if (sourceReference && !/^https:\/\//i.test(sourceReference)) {
      return jsonResponse({ error: 'HTTPS_REFERENCE_REQUIRED' }, 400);
    }

    let fileKey = null;
    let fileName = null;
    let contentType = null;
    let byteSize = 0;
    let fileSha256 = null;
    if (file instanceof File && file.size > 0) {
      if (!env?.EVIDENCE?.put) return jsonResponse({ error: 'OBJECT_STORAGE_UNAVAILABLE' }, 503);
      if (file.size > maxFileBytes) return jsonResponse({ error: 'FILE_TOO_LARGE', max_bytes: maxFileBytes }, 413);
      contentType = file.type || 'application/octet-stream';
      if (!allowedContentTypes.has(contentType)) {
        return jsonResponse({ error: 'UNSUPPORTED_FILE_TYPE' }, 415);
      }
      fileName = safeFilename(file.name);
      let bytes = await file.arrayBuffer();
      if (contentType === 'text/plain' || contentType === 'text/markdown') {
        const redactedText = redactSensitiveText(new TextDecoder().decode(bytes), redactionTerms).text;
        bytes = new TextEncoder().encode(redactedText).buffer;
      }
      byteSize = bytes.byteLength;
      fileSha256 = await digestBytes(bytes);
      fileKey = `private-evidence/${crypto.randomUUID()}`;
      await env.EVIDENCE.put(fileKey, bytes, {
        httpMetadata: { contentType },
        customMetadata: {
          original_name: fileName,
          sha256: fileSha256,
        },
      });
    }

    const ownerToken = makeOwnerToken();
    const tokenHash = await sha256(
      `${env.RATE_LIMIT_SALT || 'duduhire-local'}:evidence:${ownerToken}`,
    );
    const redactedDescription = redactSensitiveText(description, redactionTerms).text;
    const redactedReference = sourceReference
      ? redactSensitiveText(sourceReference, redactionTerms).text
      : '';
    try {
      const created = await createEvidenceSubmission(env, {
        ownerTokenHash: tokenHash,
        capabilityName: redactSensitiveText(capabilityName, redactionTerms).text,
        atomId,
        evidenceType,
        description: redactedDescription,
        sourceReference: redactedReference,
        redactionTerms,
        fileKey,
        fileName,
        contentType,
        byteSize,
        fileSha256,
        challenge: makeChallenge(capabilityName),
      });
      return jsonResponse({
        created: true,
        id: created.id,
        owner_token: ownerToken,
        level: 'L0',
        status: 'material_pending',
        next: '等待人工核验材料；通过后开放微任务。',
      }, 201);
    } catch (error) {
      if (fileKey && env?.EVIDENCE?.delete) await env.EVIDENCE.delete(fileKey);
      throw error;
    }
  }

  if (url.pathname === '/api/evidence-submissions' && request.method === 'GET') {
    if (!auth.isReviewer) return jsonResponse({ error: 'REVIEWER_REQUIRED' }, 401);
    const status = url.searchParams.get('status') || 'all';
    const items = await listEvidenceSubmissions(env, status, url.searchParams.get('limit'));
    return jsonResponse({ submissions: items });
  }

  const fileMatch = url.pathname.match(/^\/api\/evidence-submissions\/([a-zA-Z0-9_]+)\/file$/);
  if (fileMatch && request.method === 'GET') {
    if (!auth.isReviewer) return jsonResponse({ error: 'REVIEWER_REQUIRED' }, 401);
    const record = await getEvidenceSubmission(env, fileMatch[1]);
    if (!record?.fileKey || !env?.EVIDENCE?.get) return jsonResponse({ error: 'FILE_NOT_FOUND' }, 404);
    const object = await env.EVIDENCE.get(record.fileKey);
    if (!object) return jsonResponse({ error: 'FILE_NOT_FOUND' }, 404);
    return new Response(object.body, {
      headers: {
        'content-type': record.contentType || 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.fileName || 'evidence')}`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  const reviewMatch = url.pathname.match(/^\/api\/evidence-submissions\/([a-zA-Z0-9_]+)\/review$/);
  if (reviewMatch && request.method === 'PATCH') {
    if (!auth.isReviewer) return jsonResponse({ error: 'REVIEWER_REQUIRED' }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'INVALID_JSON' }, 400);
    }
    if (!allowedReviewStatuses.has(body?.status)) return jsonResponse({ error: 'INVALID_STATUS' }, 400);
    const score = body.status === 'microtask_passed'
      ? Math.min(Math.max(Number(body.score) || 0, 0), 100)
      : null;
    if (body.status === 'microtask_passed' && score < 70) {
      return jsonResponse({ error: 'PASSING_SCORE_REQUIRED' }, 400);
    }
    const result = await reviewEvidenceSubmission(env, reviewMatch[1], {
      status: body.status,
      score,
      note: redactSensitiveText(normalize(body.note, 1200)).text,
      reviewerKey: auth.reviewerKey,
    });
    return jsonResponse(result, result.updated ? 200 : result.reason === 'not_found' ? 404 : 409);
  }

  const microtaskMatch = url.pathname.match(/^\/api\/evidence-submissions\/([a-zA-Z0-9_]+)\/microtask$/);
  if (microtaskMatch && request.method === 'POST') {
    const tokenHash = await ownerTokenHash(request, env);
    if (!tokenHash) return jsonResponse({ error: 'OWNER_TOKEN_REQUIRED' }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'INVALID_JSON' }, 400);
    }
    const answer = redactSensitiveText(normalize(body?.answer, 4000), body?.redaction_terms).text;
    if (answer.length < 80) return jsonResponse({ error: 'MICROTASK_ANSWER_TOO_SHORT' }, 400);
    const id = await submitMicrotask(env, microtaskMatch[1], tokenHash, answer);
    if (!id) return jsonResponse({ error: 'MATERIAL_VERIFICATION_REQUIRED' }, 409);
    return jsonResponse({ submitted: true, id, level: 'L1', status: 'microtask_submitted' }, 201);
  }

  const itemMatch = url.pathname.match(/^\/api\/evidence-submissions\/([a-zA-Z0-9_]+)$/);
  if (itemMatch && request.method === 'GET') {
    if (auth.isReviewer) {
      const record = await getEvidenceSubmission(env, itemMatch[1]);
      return record ? jsonResponse({ submission: record }) : jsonResponse({ error: 'NOT_FOUND' }, 404);
    }
    const tokenHash = await ownerTokenHash(request, env);
    if (!tokenHash) return jsonResponse({ error: 'OWNER_TOKEN_REQUIRED' }, 401);
    const record = await getEvidenceSubmission(env, itemMatch[1], tokenHash);
    return record
      ? jsonResponse({ submission: publicEvidenceView(record) })
      : jsonResponse({ error: 'NOT_FOUND' }, 404);
  }

  return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
}
