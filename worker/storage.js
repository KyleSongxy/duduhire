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
  const [analysis, feedback, reviews, providers, health] = await env.DB.batch([
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
  ]);
  return {
    days: boundedDays,
    analysis: analysis.results?.[0] || {},
    feedback: feedback.results || [],
    reviews: reviews.results || [],
    providers: providers.results || [],
    modelHealth: health.results || [],
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
