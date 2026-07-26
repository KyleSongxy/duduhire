import { sha256 } from './privacy.js';

const initializedBindings = new WeakSet();

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS analysis_receipts (
    id text PRIMARY KEY NOT NULL,
    flow text NOT NULL,
    stage text NOT NULL,
    status text NOT NULL,
    source_hash text NOT NULL,
    provider text,
    model text,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    estimated_cost_cny real DEFAULT 0 NOT NULL,
    latency_ms integer DEFAULT 0 NOT NULL,
    redaction_count integer DEFAULT 0 NOT NULL,
    created_at integer NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS analysis_receipts_created_idx ON analysis_receipts (created_at)',
  'CREATE INDEX IF NOT EXISTS analysis_receipts_flow_idx ON analysis_receipts (flow, stage)',
  `CREATE TABLE IF NOT EXISTS feedback (
    id text PRIMARY KEY NOT NULL,
    receipt_id text,
    flow text NOT NULL,
    target text NOT NULL,
    verdict text NOT NULL,
    tags_json text DEFAULT '[]' NOT NULL,
    comment text,
    consent integer DEFAULT 0 NOT NULL,
    created_at integer NOT NULL,
    FOREIGN KEY (receipt_id) REFERENCES analysis_receipts(id) ON DELETE SET NULL
  )`,
  'CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at)',
  'CREATE INDEX IF NOT EXISTS feedback_verdict_idx ON feedback (verdict)',
  `CREATE TABLE IF NOT EXISTS review_queue (
    id text PRIMARY KEY NOT NULL,
    flow text NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    risk_flags_json text DEFAULT '[]' NOT NULL,
    redacted_payload_json text NOT NULL,
    reviewer_note text,
    resolution text,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS review_queue_status_idx ON review_queue (status, created_at)',
  `CREATE TABLE IF NOT EXISTS rate_limits (
    client_hash text NOT NULL,
    window_start integer NOT NULL,
    request_count integer DEFAULT 0 NOT NULL,
    updated_at integer NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS rate_limits_client_window_idx ON rate_limits (client_hash, window_start)',
  'CREATE INDEX IF NOT EXISTS rate_limits_updated_idx ON rate_limits (updated_at)',
  `CREATE TABLE IF NOT EXISTS model_health (
    provider text PRIMARY KEY NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    open_until integer DEFAULT 0 NOT NULL,
    last_failure text,
    updated_at integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS provider_attempts (
    id text PRIMARY KEY NOT NULL,
    flow text NOT NULL,
    stage text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    status text NOT NULL,
    latency_ms integer DEFAULT 0 NOT NULL,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    estimated_cost_cny real DEFAULT 0 NOT NULL,
    route_reason text,
    failure_reason text,
    created_at integer NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS provider_attempts_created_idx ON provider_attempts (created_at)',
  'CREATE INDEX IF NOT EXISTS provider_attempts_provider_idx ON provider_attempts (provider, model, status)',
  `CREATE TABLE IF NOT EXISTS evidence_submissions (
    id text PRIMARY KEY NOT NULL,
    owner_token_hash text NOT NULL,
    capability_name text NOT NULL,
    atom_id text,
    evidence_type text NOT NULL,
    description text NOT NULL,
    source_reference text,
    redaction_terms_json text DEFAULT '[]' NOT NULL,
    file_key text,
    file_name text,
    content_type text,
    byte_size integer DEFAULT 0 NOT NULL,
    file_sha256 text,
    level text DEFAULT 'L0' NOT NULL,
    status text DEFAULT 'material_pending' NOT NULL,
    reviewer_note text,
    reviewer_key text,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS evidence_submissions_status_idx ON evidence_submissions (status, created_at)',
  `CREATE TABLE IF NOT EXISTS microtask_challenges (
    id text PRIMARY KEY NOT NULL,
    evidence_id text NOT NULL UNIQUE,
    prompt text NOT NULL,
    rubric_json text DEFAULT '[]' NOT NULL,
    created_at integer NOT NULL,
    FOREIGN KEY (evidence_id) REFERENCES evidence_submissions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS microtask_submissions (
    id text PRIMARY KEY NOT NULL,
    challenge_id text NOT NULL,
    answer text NOT NULL,
    status text DEFAULT 'submitted' NOT NULL,
    score integer,
    reviewer_note text,
    submitted_at integer NOT NULL,
    reviewed_at integer,
    FOREIGN KEY (challenge_id) REFERENCES microtask_challenges(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS microtask_submissions_challenge_idx ON microtask_submissions (challenge_id, submitted_at)',
  `CREATE TABLE IF NOT EXISTS certification_events (
    id text PRIMARY KEY NOT NULL,
    evidence_id text NOT NULL,
    actor_kind text NOT NULL,
    actor_key text,
    action text NOT NULL,
    from_level text NOT NULL,
    to_level text NOT NULL,
    note text,
    created_at integer NOT NULL,
    FOREIGN KEY (evidence_id) REFERENCES evidence_submissions(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS certification_events_evidence_idx ON certification_events (evidence_id, created_at)',
  `CREATE TABLE IF NOT EXISTS eval_cases (
    case_id text PRIMARY KEY NOT NULL,
    flow text NOT NULL,
    input_text text NOT NULL,
    proposed_expected_json text NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS eval_cases_status_idx ON eval_cases (status, flow)',
  `CREATE TABLE IF NOT EXISTS eval_reviews (
    id text PRIMARY KEY NOT NULL,
    case_id text NOT NULL,
    reviewer_key text NOT NULL,
    expected_json text NOT NULL,
    decision text NOT NULL,
    note text,
    created_at integer NOT NULL,
    FOREIGN KEY (case_id) REFERENCES eval_cases(case_id) ON DELETE CASCADE
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS eval_reviews_case_reviewer_idx ON eval_reviews (case_id, reviewer_key)',
  `CREATE TABLE IF NOT EXISTS eval_adjudications (
    case_id text PRIMARY KEY NOT NULL,
    reviewer_key text NOT NULL,
    final_expected_json text NOT NULL,
    note text,
    created_at integer NOT NULL,
    FOREIGN KEY (case_id) REFERENCES eval_cases(case_id) ON DELETE CASCADE
  )`,
];

export function hasDatabase(env) {
  return Boolean(env?.DB?.prepare && env?.DB?.batch);
}

export async function ensureSchema(env) {
  if (!hasDatabase(env) || initializedBindings.has(env.DB)) return hasDatabase(env);
  await env.DB.batch(schemaStatements.map((statement) => env.DB.prepare(statement)));
  initializedBindings.add(env.DB);
  return true;
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export async function consumeDurableRateLimit(request, env, {
  limit = 10,
  windowMs = 10 * 60 * 1000,
  scope = 'analysis',
} = {}) {
  if (!await ensureSchema(env)) return null;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const ip = request.headers.get('cf-connecting-ip') || 'local-or-unknown';
  const clientHash = await sha256(`${env.RATE_LIMIT_SALT || 'duduhire-local'}:${scope}:${ip}`);
  await env.DB.prepare(`
    INSERT INTO rate_limits (client_hash, window_start, request_count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(client_hash, window_start)
    DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at
  `).bind(clientHash, windowStart, now).run();
  const row = await env.DB.prepare(`
    SELECT request_count FROM rate_limits WHERE client_hash = ? AND window_start = ?
  `).bind(clientHash, windowStart).first();
  if (Math.random() < 0.02) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE updated_at < ?')
      .bind(now - (24 * 60 * 60 * 1000))
      .run();
  }
  return {
    allowed: Number(row?.request_count || 0) <= limit,
    limit,
    remaining: Math.max(0, limit - Number(row?.request_count || 0)),
    resetAt: windowStart + windowMs,
  };
}

export async function saveAnalysisReceipt(env, record) {
  if (!await ensureSchema(env)) return null;
  const id = createId('ar');
  await env.DB.prepare(`
    INSERT INTO analysis_receipts (
      id, flow, stage, status, source_hash, provider, model,
      prompt_tokens, completion_tokens, estimated_cost_cny,
      latency_ms, redaction_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    record.flow,
    record.stage,
    record.status,
    record.sourceHash,
    record.provider || null,
    record.model || null,
    record.promptTokens || 0,
    record.completionTokens || 0,
    record.estimatedCostCny || 0,
    record.latencyMs || 0,
    record.redactionCount || 0,
    Date.now(),
  ).run();
  return id;
}

export async function saveProviderAttempt(env, record) {
  if (!await ensureSchema(env)) return null;
  const id = createId('pa');
  await env.DB.prepare(`
    INSERT INTO provider_attempts (
      id, flow, stage, provider, model, status, latency_ms,
      prompt_tokens, completion_tokens, estimated_cost_cny,
      route_reason, failure_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    record.flow,
    record.stage,
    record.provider,
    record.model,
    record.status,
    record.latencyMs || 0,
    record.promptTokens || 0,
    record.completionTokens || 0,
    record.estimatedCostCny || 0,
    record.routeReason || null,
    record.failureReason ? String(record.failureReason).slice(0, 240) : null,
    Date.now(),
  ).run();
  return id;
}

export async function saveFeedback(env, record) {
  if (!await ensureSchema(env)) return null;
  const id = createId('fb');
  await env.DB.prepare(`
    INSERT INTO feedback (
      id, receipt_id, flow, target, verdict, tags_json, comment, consent, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    record.receiptId || null,
    record.flow,
    record.target,
    record.verdict,
    JSON.stringify(record.tags || []),
    record.consent ? record.comment || null : null,
    record.consent ? 1 : 0,
    Date.now(),
  ).run();
  return id;
}

export async function enqueueReview(env, record) {
  if (!await ensureSchema(env)) return null;
  const id = createId('rv');
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO review_queue (
      id, flow, status, risk_flags_json, redacted_payload_json, created_at, updated_at
    ) VALUES (?, ?, 'pending', ?, ?, ?, ?)
  `).bind(
    id,
    record.flow,
    JSON.stringify(record.riskFlags || []),
    JSON.stringify(record.payload),
    now,
    now,
  ).run();
  return id;
}

export async function listReviews(env, status = 'pending', limit = 50) {
  if (!await ensureSchema(env)) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const query = status === 'all'
    ? env.DB.prepare(`
      SELECT * FROM review_queue ORDER BY created_at DESC LIMIT ?
    `).bind(safeLimit)
    : env.DB.prepare(`
      SELECT * FROM review_queue WHERE status = ? ORDER BY created_at ASC LIMIT ?
    `).bind(status, safeLimit);
  const result = await query.all();
  return (result.results || []).map((row) => ({
    id: row.id,
    flow: row.flow,
    status: row.status,
    riskFlags: JSON.parse(row.risk_flags_json || '[]'),
    payload: JSON.parse(row.redacted_payload_json || '{}'),
    reviewerNote: row.reviewer_note,
    resolution: row.resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function resolveReview(env, id, update) {
  if (!await ensureSchema(env)) return false;
  const result = await env.DB.prepare(`
    UPDATE review_queue
    SET status = ?, reviewer_note = ?, resolution = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    update.status,
    update.reviewerNote || null,
    update.resolution || null,
    Date.now(),
    id,
  ).run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function getOperationsMetrics(env, days = 7) {
  if (!await ensureSchema(env)) return null;
  const boundedDays = Math.min(Math.max(Number(days) || 7, 1), 90);
  const since = Date.now() - (boundedDays * 86400000);
  const [analysis, feedback, reviews, providers, health, attempts, evidence, evaluation] = await env.DB.batch([
    env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(estimated_cost_cny) AS cost,
        SUM(CASE WHEN stage = 'refined' THEN 1 ELSE 0 END) AS refined,
        AVG(latency_ms) AS avg_latency,
        SUM(redaction_count) AS redactions
      FROM analysis_receipts WHERE created_at >= ?
    `).bind(since),
    env.DB.prepare(`
      SELECT verdict, COUNT(*) AS total
      FROM feedback WHERE created_at >= ? GROUP BY verdict
    `).bind(since),
    env.DB.prepare(`
      SELECT status, COUNT(*) AS total
      FROM review_queue GROUP BY status
    `),
    env.DB.prepare(`
      SELECT provider, COUNT(*) AS total, SUM(estimated_cost_cny) AS cost
      FROM analysis_receipts WHERE created_at >= ? GROUP BY provider
    `).bind(since),
    env.DB.prepare(`
      SELECT provider, consecutive_failures, open_until, updated_at
      FROM model_health ORDER BY provider
    `),
    env.DB.prepare(`
      SELECT
        provider,
        model,
        COUNT(*) AS attempts,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
        AVG(CASE WHEN status = 'success' THEN latency_ms ELSE NULL END) AS avg_latency,
        SUM(estimated_cost_cny) AS cost
      FROM provider_attempts
      WHERE created_at >= ?
      GROUP BY provider, model
    `).bind(since),
    env.DB.prepare(`
      SELECT level, status, COUNT(*) AS total
      FROM evidence_submissions GROUP BY level, status
    `),
    env.DB.prepare(`
      SELECT status, COUNT(*) AS total
      FROM eval_cases GROUP BY status
    `),
  ]);
  return {
    days: boundedDays,
    analysis: analysis.results?.[0] || {},
    feedback: feedback.results || [],
    reviews: reviews.results || [],
    providers: providers.results || [],
    modelHealth: health.results || [],
    providerAttempts: attempts.results || [],
    evidence: evidence.results || [],
    evaluation: evaluation.results || [],
  };
}

export async function isCircuitOpen(env, provider) {
  if (!await ensureSchema(env)) return false;
  const row = await env.DB.prepare(`
    SELECT open_until FROM model_health WHERE provider = ?
  `).bind(provider).first();
  return Number(row?.open_until || 0) > Date.now();
}

export async function recordProviderSuccess(env, provider) {
  if (!await ensureSchema(env)) return;
  await env.DB.prepare(`
    INSERT INTO model_health (provider, consecutive_failures, open_until, updated_at)
    VALUES (?, 0, 0, ?)
    ON CONFLICT(provider)
    DO UPDATE SET consecutive_failures = 0, open_until = 0, last_failure = NULL, updated_at = excluded.updated_at
  `).bind(provider, Date.now()).run();
}

export async function recordProviderFailure(env, provider, reason) {
  if (!await ensureSchema(env)) return;
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO model_health (provider, consecutive_failures, open_until, last_failure, updated_at)
    VALUES (?, 1, 0, ?, ?)
    ON CONFLICT(provider)
    DO UPDATE SET
      consecutive_failures = consecutive_failures + 1,
      open_until = CASE
        WHEN consecutive_failures + 1 >= 3 THEN excluded.updated_at + 300000
        ELSE open_until
      END,
      last_failure = excluded.last_failure,
      updated_at = excluded.updated_at
  `).bind(provider, String(reason).slice(0, 240), now).run();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapEvidenceRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    capabilityName: row.capability_name,
    atomId: row.atom_id,
    evidenceType: row.evidence_type,
    description: row.description,
    sourceReference: row.source_reference,
    redactionTerms: parseJson(row.redaction_terms_json || '[]', []),
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: Number(row.byte_size || 0),
    hasFile: Boolean(row.file_key),
    level: row.level,
    status: row.status,
    reviewerNote: row.reviewer_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createEvidenceSubmission(env, record) {
  if (!await ensureSchema(env)) return null;
  const id = createId('ev');
  const challengeId = createId('mt');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO evidence_submissions (
        id, owner_token_hash, capability_name, atom_id, evidence_type,
        description, source_reference, redaction_terms_json, file_key,
        file_name, content_type, byte_size, file_sha256, level, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'L0', 'material_pending', ?, ?)
    `).bind(
      id,
      record.ownerTokenHash,
      record.capabilityName,
      record.atomId || null,
      record.evidenceType,
      record.description,
      record.sourceReference || null,
      JSON.stringify(record.redactionTerms || []),
      record.fileKey || null,
      record.fileName || null,
      record.contentType || null,
      record.byteSize || 0,
      record.fileSha256 || null,
      now,
      now,
    ),
    env.DB.prepare(`
      INSERT INTO microtask_challenges (
        id, evidence_id, prompt, rubric_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      challengeId,
      id,
      record.challenge.prompt,
      JSON.stringify(record.challenge.rubric || []),
      now,
    ),
    env.DB.prepare(`
      INSERT INTO certification_events (
        id, evidence_id, actor_kind, action, from_level, to_level, note, created_at
      ) VALUES (?, ?, 'owner', 'submitted_material', 'L0', 'L0', ?, ?)
    `).bind(createId('ce'), id, record.description.slice(0, 300), now),
  ]);
  return { id, challengeId };
}

export async function getEvidenceSubmission(env, id, ownerTokenHash = null) {
  if (!await ensureSchema(env)) return null;
  const query = ownerTokenHash
    ? env.DB.prepare(`
      SELECT * FROM evidence_submissions WHERE id = ? AND owner_token_hash = ?
    `).bind(id, ownerTokenHash)
    : env.DB.prepare('SELECT * FROM evidence_submissions WHERE id = ?').bind(id);
  const row = await query.first();
  if (!row) return null;
  const [challenge, latestSubmission, events] = await env.DB.batch([
    env.DB.prepare(`
      SELECT id, prompt, rubric_json, created_at
      FROM microtask_challenges WHERE evidence_id = ?
    `).bind(id),
    env.DB.prepare(`
      SELECT ms.id, ms.answer, ms.status, ms.score, ms.reviewer_note,
             ms.submitted_at, ms.reviewed_at
      FROM microtask_submissions ms
      JOIN microtask_challenges mc ON mc.id = ms.challenge_id
      WHERE mc.evidence_id = ?
      ORDER BY ms.submitted_at DESC LIMIT 1
    `).bind(id),
    env.DB.prepare(`
      SELECT actor_kind, action, from_level, to_level, note, created_at
      FROM certification_events WHERE evidence_id = ? ORDER BY created_at ASC
    `).bind(id),
  ]);
  const challengeRow = challenge.results?.[0];
  const submissionRow = latestSubmission.results?.[0];
  return {
    ...mapEvidenceRow(row),
    fileKey: row.file_key,
    challenge: challengeRow ? {
      id: challengeRow.id,
      prompt: challengeRow.prompt,
      rubric: parseJson(challengeRow.rubric_json || '[]', []),
      available: ['material_verified', 'microtask_submitted', 'microtask_passed', 'certified'].includes(row.status),
    } : null,
    microtask: submissionRow ? {
      id: submissionRow.id,
      answer: submissionRow.answer,
      status: submissionRow.status,
      score: submissionRow.score,
      reviewerNote: submissionRow.reviewer_note,
      submittedAt: submissionRow.submitted_at,
      reviewedAt: submissionRow.reviewed_at,
    } : null,
    events: (events.results || []).map((event) => ({
      actorKind: event.actor_kind,
      action: event.action,
      fromLevel: event.from_level,
      toLevel: event.to_level,
      note: event.note,
      createdAt: event.created_at,
    })),
  };
}

export async function listEvidenceSubmissions(env, status = 'all', limit = 50) {
  if (!await ensureSchema(env)) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const query = status === 'all'
    ? env.DB.prepare('SELECT * FROM evidence_submissions ORDER BY created_at DESC LIMIT ?').bind(safeLimit)
    : env.DB.prepare(`
      SELECT * FROM evidence_submissions WHERE status = ? ORDER BY created_at ASC LIMIT ?
    `).bind(status, safeLimit);
  const result = await query.all();
  return (result.results || []).map(mapEvidenceRow);
}

export async function submitMicrotask(env, evidenceId, ownerTokenHash, answer) {
  if (!await ensureSchema(env)) return null;
  const evidence = await env.DB.prepare(`
    SELECT es.level, es.status, mc.id AS challenge_id
    FROM evidence_submissions es
    JOIN microtask_challenges mc ON mc.evidence_id = es.id
    WHERE es.id = ? AND es.owner_token_hash = ?
  `).bind(evidenceId, ownerTokenHash).first();
  if (!evidence || evidence.level !== 'L1' || evidence.status !== 'material_verified') return null;
  const id = createId('ms');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO microtask_submissions (
        id, challenge_id, answer, status, submitted_at
      ) VALUES (?, ?, ?, 'submitted', ?)
    `).bind(id, evidence.challenge_id, answer, now),
    env.DB.prepare(`
      UPDATE evidence_submissions
      SET status = 'microtask_submitted', updated_at = ? WHERE id = ?
    `).bind(now, evidenceId),
    env.DB.prepare(`
      INSERT INTO certification_events (
        id, evidence_id, actor_kind, action, from_level, to_level, note, created_at
      ) VALUES (?, ?, 'owner', 'submitted_microtask', 'L1', 'L1', NULL, ?)
    `).bind(createId('ce'), evidenceId, now),
  ]);
  return id;
}

export async function reviewEvidenceSubmission(env, evidenceId, update) {
  if (!await ensureSchema(env)) return { updated: false, reason: 'storage_unavailable' };
  const current = await env.DB.prepare(`
    SELECT level, status FROM evidence_submissions WHERE id = ?
  `).bind(evidenceId).first();
  if (!current) return { updated: false, reason: 'not_found' };
  const target = {
    material_verified: { from: ['L0'], level: 'L1', status: 'material_verified', action: 'verified_material' },
    microtask_passed: { from: ['L1'], level: 'L2', status: 'microtask_passed', action: 'passed_microtask' },
    certified: { from: ['L2'], level: 'L3', status: 'certified', action: 'human_certified' },
    revision_required: { from: ['L0', 'L1', 'L2'], level: current.level, status: 'revision_required', action: 'requested_revision' },
    rejected: { from: ['L0', 'L1', 'L2'], level: current.level, status: 'rejected', action: 'rejected' },
  }[update.status];
  if (!target || !target.from.includes(current.level)) {
    return { updated: false, reason: 'invalid_transition' };
  }
  if (update.status === 'microtask_passed') {
    const submitted = await env.DB.prepare(`
      SELECT ms.id FROM microtask_submissions ms
      JOIN microtask_challenges mc ON mc.id = ms.challenge_id
      WHERE mc.evidence_id = ? AND ms.status = 'submitted'
      ORDER BY ms.submitted_at DESC LIMIT 1
    `).bind(evidenceId).first();
    if (!submitted) return { updated: false, reason: 'microtask_required' };
    await env.DB.prepare(`
      UPDATE microtask_submissions
      SET status = 'passed', score = ?, reviewer_note = ?, reviewed_at = ?
      WHERE id = ?
    `).bind(update.score, update.note || null, Date.now(), submitted.id).run();
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE evidence_submissions
      SET level = ?, status = ?, reviewer_note = ?, reviewer_key = ?, updated_at = ?
      WHERE id = ?
    `).bind(target.level, target.status, update.note || null, update.reviewerKey, now, evidenceId),
    env.DB.prepare(`
      INSERT INTO certification_events (
        id, evidence_id, actor_kind, actor_key, action,
        from_level, to_level, note, created_at
      ) VALUES (?, ?, 'reviewer', ?, ?, ?, ?, ?, ?)
    `).bind(
      createId('ce'),
      evidenceId,
      update.reviewerKey,
      target.action,
      current.level,
      target.level,
      update.note || null,
      now,
    ),
  ]);
  return { updated: true, level: target.level, status: target.status };
}

export async function seedEvaluationCases(env, cases) {
  if (!await ensureSchema(env)) return 0;
  const countRow = await env.DB.prepare('SELECT COUNT(*) AS total FROM eval_cases').first();
  if (Number(countRow?.total || 0) >= cases.length) return Number(countRow.total);
  const now = Date.now();
  const statements = cases.map((item) => env.DB.prepare(`
    INSERT INTO eval_cases (
      case_id, flow, input_text, proposed_expected_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(case_id) DO NOTHING
  `).bind(
    item.case_id,
    item.flow,
    item.input,
    JSON.stringify(item.expected),
    now,
    now,
  ));
  for (let index = 0; index < statements.length; index += 50) {
    await env.DB.batch(statements.slice(index, index + 50));
  }
  return cases.length;
}

export async function listEvaluationCases(env, status = 'all', limit = 30) {
  if (!await ensureSchema(env)) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const query = status === 'all'
    ? env.DB.prepare(`
      SELECT ec.*,
        (SELECT COUNT(*) FROM eval_reviews er WHERE er.case_id = ec.case_id) AS review_count
      FROM eval_cases ec ORDER BY ec.created_at ASC LIMIT ?
    `).bind(safeLimit)
    : env.DB.prepare(`
      SELECT ec.*,
        (SELECT COUNT(*) FROM eval_reviews er WHERE er.case_id = ec.case_id) AS review_count
      FROM eval_cases ec WHERE ec.status = ? ORDER BY ec.created_at ASC LIMIT ?
    `).bind(status, safeLimit);
  const result = await query.all();
  return (result.results || []).map((row) => ({
    caseId: row.case_id,
    flow: row.flow,
    input: row.input_text,
    proposedExpected: parseJson(row.proposed_expected_json, {}),
    status: row.status,
    reviewCount: Number(row.review_count || 0),
  }));
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableJson(value[key])]),
  );
}

export async function saveEvaluationReview(env, caseId, record) {
  if (!await ensureSchema(env)) return { saved: false, reason: 'storage_unavailable' };
  const reviewCount = await env.DB.prepare(`
    SELECT COUNT(*) AS total FROM eval_reviews WHERE case_id = ?
  `).bind(caseId).first();
  if (Number(reviewCount?.total || 0) >= 2) return { saved: false, reason: 'review_slots_full' };
  const expectedJson = JSON.stringify(stableJson(record.expected));
  try {
    await env.DB.prepare(`
      INSERT INTO eval_reviews (
        id, case_id, reviewer_key, expected_json, decision, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      createId('er'),
      caseId,
      record.reviewerKey,
      expectedJson,
      record.decision,
      record.note || null,
      Date.now(),
    ).run();
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return { saved: false, reason: 'independent_reviewer_required' };
    throw error;
  }
  const reviews = await env.DB.prepare(`
    SELECT expected_json FROM eval_reviews WHERE case_id = ? ORDER BY created_at ASC
  `).bind(caseId).all();
  const rows = reviews.results || [];
  const status = rows.length < 2
    ? 'reviewing'
    : rows[0].expected_json === rows[1].expected_json ? 'agreed' : 'disputed';
  await env.DB.prepare(`
    UPDATE eval_cases SET status = ?, updated_at = ? WHERE case_id = ?
  `).bind(status, Date.now(), caseId).run();
  return { saved: true, status, reviewCount: rows.length };
}

export async function adjudicateEvaluationCase(env, caseId, record) {
  if (!await ensureSchema(env)) return { saved: false, reason: 'storage_unavailable' };
  const reviews = await env.DB.prepare(`
    SELECT reviewer_key FROM eval_reviews WHERE case_id = ?
  `).bind(caseId).all();
  if ((reviews.results || []).length < 2) return { saved: false, reason: 'two_reviews_required' };
  if ((reviews.results || []).some((item) => item.reviewer_key === record.reviewerKey)) {
    return { saved: false, reason: 'independent_adjudicator_required' };
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO eval_adjudications (
        case_id, reviewer_key, final_expected_json, note, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET
        reviewer_key = excluded.reviewer_key,
        final_expected_json = excluded.final_expected_json,
        note = excluded.note,
        created_at = excluded.created_at
    `).bind(
      caseId,
      record.reviewerKey,
      JSON.stringify(stableJson(record.expected)),
      record.note || null,
      now,
    ),
    env.DB.prepare(`
      UPDATE eval_cases SET status = 'adjudicated', updated_at = ? WHERE case_id = ?
    `).bind(now, caseId),
  ]);
  return { saved: true, status: 'adjudicated' };
}
