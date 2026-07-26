import demandSchema from '../schemas/demand-analysis.schema.json' with { type: 'json' };
import capabilitySchema from '../schemas/capability-analysis.schema.json' with { type: 'json' };
import {
  buildUserPrompt,
  capabilitySystemPrompt,
  demandSystemPrompt,
} from './analysis-prompts.js';
import { validateJsonSchema } from './json-schema-validator.js';
import {
  buildAnalysisSource,
  redactSensitiveText,
  sha256,
} from './privacy.js';
import {
  consumeDurableRateLimit,
  hasDatabase,
  isCircuitOpen,
  recordProviderFailure,
  recordProviderSuccess,
  saveAnalysisReceipt,
  saveProviderAttempt,
} from './storage.js';

const schemas = {
  demand: demandSchema,
  capability: capabilitySchema,
};

const supportedFlows = new Set(['demand', 'capability']);
const humanReviewDemandRisks = new Set([
  'personal_sensitive_data',
  'unsafe_or_illegal',
  'prompt_injection',
  'high_impact_decision',
]);
const humanReviewCapabilityRisks = new Set([
  'personal_sensitive_data',
  'prompt_injection',
  'unsupported_seniority_claim',
  'high_impact_employment_decision',
]);
const requestBuckets = new Map();
const responseCache = new Map();

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

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\r\n?/g, '\n') : '';
}

function checkSameOrigin(request, url) {
  const origin = request.headers.get('origin');
  return !origin || origin === url.origin;
}

function consumeMemoryRateLimit(request, env) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const configuredLimit = Number.parseInt(env.AI_REQUESTS_PER_10_MINUTES || '10', 10);
  const limit = Number.isFinite(configuredLimit)
    ? Math.min(Math.max(configuredLimit, 1), 100)
    : 10;
  const clientId = request.headers.get('cf-connecting-ip') || 'local-or-unknown';
  const recent = (requestBuckets.get(clientId) || []).filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= limit) {
    requestBuckets.set(clientId, recent);
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: recent[0] + windowMs,
    };
  }
  recent.push(now);
  requestBuckets.set(clientId, recent);
  if (requestBuckets.size > 5000) requestBuckets.clear();
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - recent.length),
    resetAt: now + windowMs,
  };
}

export function getProviderChain(env, flow, text, context = {}) {
  const policy = ['balanced', 'cost', 'quality'].includes(env.MODEL_ROUTING_POLICY)
    ? env.MODEL_ROUTING_POLICY
    : 'balanced';
  const stage = context.stage || 'initial';
  const options = {};
  if (env.DEEPSEEK_API_KEY) {
    const usePro = flow === 'capability' || stage === 'refined' || text.length > 6000;
    options.deepseek = {
      name: 'deepseek',
      healthKey: usePro ? 'deepseek:pro' : 'deepseek:flash',
      endpoint: 'https://api.deepseek.com/chat/completions',
      apiKey: env.DEEPSEEK_API_KEY,
      model: usePro ? 'deepseek-v4-pro' : 'deepseek-v4-flash',
      routeReason: usePro ? 'complex_or_refined' : 'fast_fallback',
      requestExtras: {
        thinking: { type: 'disabled' },
      },
    };
  }
  if (env.DASHSCOPE_API_KEY) {
    options.qwenFlash = {
      name: 'qwen',
      healthKey: 'qwen:flash',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      apiKey: env.DASHSCOPE_API_KEY,
      model: 'qwen3.7-flash',
      routeReason: 'short_initial_cost',
      requestExtras: {
        enable_thinking: false,
      },
    };
    options.qwenPlus = {
      name: 'qwen',
      healthKey: 'qwen:plus',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      apiKey: env.DASHSCOPE_API_KEY,
      model: 'qwen3.7-plus',
      routeReason: 'complex_refined_quality',
      requestExtras: {
        enable_thinking: false,
      },
    };
  }
  const shortInitial = flow === 'demand' && stage === 'initial' && text.length <= 12000;
  const order = policy === 'quality'
    ? [options.qwenPlus, options.deepseek, options.qwenFlash]
    : policy === 'cost'
      ? [options.qwenFlash, options.deepseek, options.qwenPlus]
      : shortInitial
        ? [options.qwenFlash, options.deepseek, options.qwenPlus]
        : [options.qwenPlus, options.deepseek, options.qwenFlash];
  return order.filter(Boolean).map((provider, index) => ({
    ...provider,
    routeReason: `${policy}:${provider.routeReason}:${index + 1}`,
  }));
}

function collectDemandFactReferences(analysis) {
  const references = [];
  for (const metric of analysis.problem.impact.metrics) references.push(...metric.source_fact_ids);
  for (const attempt of analysis.problem.attempts) references.push(...attempt.source_fact_ids);
  for (const hypothesis of analysis.problem.root_cause_hypotheses) references.push(...hypothesis.basis_fact_ids);
  return references;
}

function validateDemandSemantics(analysis) {
  const issues = [];
  const factIds = new Set(analysis.facts.map((fact) => fact.id));
  for (const fact of analysis.facts) {
    if (!analysis.source.text.includes(fact.source_quote)) {
      issues.push(`source_quote not found for ${fact.id}`);
    }
  }
  for (const reference of collectDemandFactReferences(analysis)) {
    if (!factIds.has(reference)) issues.push(`unknown fact reference ${reference}`);
  }
  if (
    analysis.status === 'ready_for_matching'
    && analysis.uncertainties.some((item) => item.blocking)
  ) {
    issues.push('ready_for_matching cannot contain blocking uncertainties');
  }
  if (
    analysis.risk_flags.some((flag) => humanReviewDemandRisks.has(flag))
    && analysis.status !== 'requires_human_review'
  ) {
    issues.push('high-risk demand must require human review');
  }
  return issues;
}

function validateCapabilitySemantics(analysis) {
  const issues = [];
  const projectIds = new Set(analysis.projects.map((project) => project.id));
  const evidenceIds = new Set();
  for (const project of analysis.projects) {
    for (const quote of project.source_quotes) {
      if (!analysis.source.text.includes(quote)) issues.push(`project quote not found for ${project.id}`);
    }
    for (const evidence of project.evidence) {
      evidenceIds.add(evidence.id);
      if (!analysis.source.text.includes(evidence.source_quote)) {
        issues.push(`evidence quote not found for ${evidence.id}`);
      }
    }
  }
  for (const atom of analysis.capability_atoms) {
    if (atom.level !== 'L0') issues.push(`invalid capability level for ${atom.id}`);
    for (const projectId of atom.project_ids) {
      if (!projectIds.has(projectId)) issues.push(`unknown project reference ${projectId}`);
    }
    for (const evidenceId of atom.evidence_claim_ids) {
      if (!evidenceIds.has(evidenceId)) issues.push(`unknown evidence reference ${evidenceId}`);
    }
  }
  if (
    analysis.status === 'ready_for_l0_card'
    && analysis.uncertainties.some((item) => item.blocking)
  ) {
    issues.push('ready_for_l0_card cannot contain blocking uncertainties');
  }
  if (
    analysis.risk_flags.some((flag) => humanReviewCapabilityRisks.has(flag))
    && analysis.status !== 'requires_human_review'
  ) {
    issues.push('high-risk capability must require human review');
  }
  return issues;
}

export function validateAnalysis(flow, analysis, source) {
  const schema = schemas[flow];
  if (!schema) return { valid: false, issues: ['unsupported flow'] };
  const schemaResult = validateJsonSchema(schema, analysis);
  const issues = schemaResult.errors.map((error) => `${error.instancePath} ${error.message}`);
  if (schemaResult.valid && analysis.source.text !== source.text) issues.push('source.text must equal submitted text');
  if (schemaResult.valid && analysis.source.sensitive !== source.sensitive) issues.push('source.sensitive must equal submitted value');
  if (schemaResult.valid) {
    issues.push(...(flow === 'demand'
      ? validateDemandSemantics(analysis)
      : validateCapabilitySemantics(analysis)));
  }
  return { valid: issues.length === 0, issues };
}

function estimateCostCny(model, usage = {}) {
  const rates = {
    'deepseek-v4-flash': { input: 1, output: 2 },
    'deepseek-v4-pro': { input: 3, output: 6 },
    'qwen3.7-flash': { input: 0.2, output: 0.8 },
    'qwen3.7-plus': { input: 2, output: 8 },
  };
  const rate = rates[model];
  if (!rate) return null;
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  return Number(((inputTokens * rate.input + outputTokens * rate.output) / 1_000_000).toFixed(6));
}

async function callProvider(provider, flow, source, context = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          {
            role: 'system',
            content: flow === 'demand' ? demandSystemPrompt : capabilitySystemPrompt,
          },
          {
            role: 'user',
            content: buildUserPrompt({
              ...source,
              ...context,
            }),
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: flow === 'demand' ? 2600 : 4200,
        ...provider.requestExtras,
      }),
    });
    if (!response.ok) {
      throw new Error(`${provider.name} returned ${response.status}`);
    }
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') throw new Error(`${provider.name} returned empty content`);
    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch {
      throw new Error(`${provider.name} returned invalid JSON`);
    }
    analysis.source = {
      text: source.text,
      language: 'zh-CN',
      sensitive: source.sensitive,
    };
    const validation = validateAnalysis(flow, analysis, source);
    if (!validation.valid) {
      throw new Error(`${provider.name} failed contract validation: ${validation.issues.slice(0, 4).join('; ')}`);
    }
    const usage = payload.usage || {};
    return {
      analysis,
      meta: {
        provider: provider.name,
        model: provider.model,
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
        estimated_cost_cny: estimateCostCny(provider.model, usage),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runAnalysis(flow, source, env, context = {}) {
  const providers = getProviderChain(env, flow, source.text, context);
  if (!providers.length) {
    return {
      error: 'MODEL_NOT_CONFIGURED',
      message: '国内模型服务尚未配置，页面将继续使用本地演示规则。',
      status: 503,
    };
  }
  const failures = [];
  for (const provider of providers) {
    let circuitOpen = false;
    try {
      circuitOpen = await isCircuitOpen(env, provider.healthKey);
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'model_health.read_failed',
        provider: provider.name,
        reason: error.message,
      }));
    }
    if (circuitOpen) {
      failures.push({
        provider: provider.name,
        model: provider.model,
        attempt: 0,
        reason: 'circuit_open',
      });
      try {
        await saveProviderAttempt(env, {
          flow,
          stage: context.stage || 'initial',
          provider: provider.name,
          model: provider.model,
          status: 'circuit_open',
          routeReason: provider.routeReason,
        });
      } catch {
        // Routing must remain available when telemetry storage is unavailable.
      }
      continue;
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const attemptStartedAt = Date.now();
      try {
        const result = await callProvider(provider, flow, source, context);
        try {
          await Promise.all([
            recordProviderSuccess(env, provider.healthKey),
            saveProviderAttempt(env, {
              flow,
              stage: context.stage || 'initial',
              provider: provider.name,
              model: provider.model,
              status: 'success',
              latencyMs: Date.now() - attemptStartedAt,
              promptTokens: result.meta.prompt_tokens,
              completionTokens: result.meta.completion_tokens,
              estimatedCostCny: result.meta.estimated_cost_cny,
              routeReason: provider.routeReason,
            }),
          ]);
        } catch {
          // Model success must not be converted into a user-visible failure by telemetry storage.
        }
        result.meta.route_reason = provider.routeReason;
        return result;
      } catch (error) {
        try {
          const reason = error.name === 'AbortError' ? 'timeout' : error.message;
          await Promise.all([
            recordProviderFailure(env, provider.healthKey, reason),
            saveProviderAttempt(env, {
              flow,
              stage: context.stage || 'initial',
              provider: provider.name,
              model: provider.model,
              status: 'failure',
              latencyMs: Date.now() - attemptStartedAt,
              routeReason: provider.routeReason,
              failureReason: reason,
            }),
          ]);
        } catch {
          // Provider failover remains available when health storage is temporarily unavailable.
        }
        failures.push({
          provider: provider.name,
          model: provider.model,
          attempt,
          reason: error.name === 'AbortError' ? 'timeout' : error.message,
        });
      }
    }
  }
  return {
    error: 'MODEL_ANALYSIS_FAILED',
    message: '模型未能生成符合契约的结果，请稍后重试或使用本地演示。',
    failures,
    status: 502,
  };
}

export async function probeProvider(env, providerName) {
  const candidates = getProviderChain(env, 'demand', '健康检查', { stage: 'initial' });
  const provider = candidates.find((item) => (
    providerName === item.name
    || providerName === item.healthKey
    || providerName === item.model
  ));
  if (!provider) return { ok: false, error: 'PROVIDER_NOT_CONFIGURED' };
  const startedAt = Date.now();
  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: '只输出 JSON：{"ok":true}' }],
        response_format: { type: 'json_object' },
        max_tokens: 32,
        ...provider.requestExtras,
      }),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content || '{}');
    if (parsed.ok !== true) throw new Error('INVALID_HEALTH_RESPONSE');
    try {
      await Promise.all([
        recordProviderSuccess(env, provider.healthKey),
        saveProviderAttempt(env, {
          flow: 'demand',
          stage: 'probe',
          provider: provider.name,
          model: provider.model,
          status: 'success',
          latencyMs: Date.now() - startedAt,
          promptTokens: payload.usage?.prompt_tokens || 0,
          completionTokens: payload.usage?.completion_tokens || 0,
          estimatedCostCny: estimateCostCny(provider.model, payload.usage || {}),
          routeReason: 'manual_health_probe',
        }),
      ]);
    } catch {
      // A successful provider probe remains successful when telemetry is unavailable.
    }
    return {
      ok: true,
      provider: provider.name,
      model: provider.model,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    try {
      await Promise.all([
        recordProviderFailure(env, provider.healthKey, error.message),
        saveProviderAttempt(env, {
          flow: 'demand',
          stage: 'probe',
          provider: provider.name,
          model: provider.model,
          status: 'failure',
          latencyMs: Date.now() - startedAt,
          routeReason: 'manual_health_probe',
          failureReason: error.message,
        }),
      ]);
    } catch {
      // Probe errors are still returned when telemetry is unavailable.
    }
    return {
      ok: false,
      provider: provider.name,
      model: provider.model,
      latencyMs: Date.now() - startedAt,
      error: String(error.message).slice(0, 80),
    };
  }
}

export async function handleAnalysisRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/api/analysis/status' && request.method === 'GET') {
    const providers = getProviderChain(env, 'demand', '', { stage: 'initial' });
    return jsonResponse({
      enabled: providers.length > 0,
      providers: [...new Set(providers.map((provider) => provider.name))],
      models: providers.map((provider) => provider.model),
      routing_policy: ['balanced', 'cost', 'quality'].includes(env.MODEL_ROUTING_POLICY)
        ? env.MODEL_ROUTING_POLICY
        : 'balanced',
      database: hasDatabase(env),
      storage: hasDatabase(env) ? 'metadata-only' : 'none',
      fallback: 'local-demo',
      features: {
        refinement: true,
        redaction: true,
        structured_matching: true,
        durable_feedback: hasDatabase(env),
        evidence_certification: Boolean(env?.EVIDENCE?.put) && hasDatabase(env),
      },
    });
  }

  const match = url.pathname.match(/^\/api\/analysis\/(demand|capability)$/);
  if (!match) return null;
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }
  if (!checkSameOrigin(request, url)) {
    return jsonResponse({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
  }
  const configuredLimit = Number.parseInt(env.AI_REQUESTS_PER_10_MINUTES || '10', 10);
  const limit = Number.isFinite(configuredLimit)
    ? Math.min(Math.max(configuredLimit, 1), 100)
    : 10;
  let rateLimit = null;
  try {
    rateLimit = await consumeDurableRateLimit(request, env, { limit });
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'rate_limit.durable_failed',
      reason: error.message,
    }));
  }
  rateLimit ||= consumeMemoryRateLimit(request, env);
  if (!rateLimit.allowed) {
    return jsonResponse({
      error: 'RATE_LIMITED',
      message: '解析请求过于频繁，请稍后再试。',
      retry_after_seconds: Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
    }, 429);
  }

  let body;
  const contentLength = Number.parseInt(request.headers.get('content-length') || '0', 10);
  if (Number.isFinite(contentLength) && contentLength > 250000) {
    return jsonResponse({ error: 'PAYLOAD_TOO_LARGE' }, 413);
  }
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'INVALID_JSON', message: '请求内容不是合法 JSON。' }, 400);
  }

  const flow = match[1];
  if (!supportedFlows.has(flow)) return jsonResponse({ error: 'UNSUPPORTED_FLOW' }, 404);
  const text = normalizeText(body?.text);
  const maxLength = flow === 'demand' ? 12000 : 50000;
  if (!text || text.length > maxLength) {
    return jsonResponse({
      error: 'INVALID_INPUT',
      message: `请输入 1-${maxLength} 个字符。`,
    }, 400);
  }
  const answers = Array.isArray(body?.answers)
    ? body.answers
      .filter((item) => item && typeof item.question === 'string' && typeof item.answer === 'string')
      .slice(0, 5)
      .map((item) => ({
        question: normalizeText(item.question).slice(0, 500),
        answer: normalizeText(item.answer).slice(0, 1200),
        targets: Array.isArray(item.targets)
          ? item.targets.filter((target) => typeof target === 'string').slice(0, 8)
          : [],
      }))
    : [];
  const corrections = normalizeText(body?.corrections).slice(0, 2000);
  const redactionTerms = Array.isArray(body?.redaction_terms)
    ? body.redaction_terms
      .filter((item) => typeof item === 'string')
      .map((item) => normalizeText(item).slice(0, 80))
      .filter((item) => item.length >= 2)
      .slice(0, 20)
    : [];
  let previousAnalysis = null;
  if (body?.previous_analysis && typeof body.previous_analysis === 'object') {
    const serializedPrevious = JSON.stringify(body.previous_analysis);
    if (serializedPrevious.length <= 120000) previousAnalysis = body.previous_analysis;
  }
  const stage = answers.length || corrections ? 'refined' : 'initial';
  const combinedSource = buildAnalysisSource({ text, answers, corrections });
  const redacted = redactSensitiveText(combinedSource, redactionTerms);
  const source = {
    text: redacted.text,
    sensitive: Boolean(body?.sensitive) || redacted.count > 0,
  };
  const idempotencyKey = typeof body?.idempotency_key === 'string'
    && /^[a-zA-Z0-9_-]{12,100}$/.test(body.idempotency_key)
    ? body.idempotency_key
    : '';
  const cacheKey = idempotencyKey ? `${flow}:${idempotencyKey}` : '';
  const cached = cacheKey ? responseCache.get(cacheKey) : null;
  if (cached && cached.expiresAt > Date.now()) {
    return jsonResponse({
      ...cached.result,
      meta: {
        ...cached.result.meta,
        reused: true,
      },
    });
  }
  const startedAt = Date.now();
  const result = await runAnalysis(flow, source, env, {
    stage,
    previousAnalysis,
    answers,
    corrections,
  });
  if (result.error) return jsonResponse(result, result.status);
  const latencyMs = Date.now() - startedAt;
  const sourceHash = await sha256(`${env.RATE_LIMIT_SALT || 'duduhire-local'}:${source.text}`);
  let receiptId = null;
  try {
    receiptId = await saveAnalysisReceipt(env, {
      flow,
      stage,
      status: result.analysis.status,
      sourceHash,
      provider: result.meta.provider,
      model: result.meta.model,
      promptTokens: result.meta.prompt_tokens,
      completionTokens: result.meta.completion_tokens,
      estimatedCostCny: result.meta.estimated_cost_cny,
      latencyMs,
      redactionCount: redacted.count,
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'analysis.receipt_failed',
      flow,
      reason: error.message,
    }));
  }
  result.meta = {
    ...result.meta,
    receipt_id: receiptId,
    stage,
    latency_ms: latencyMs,
    reused: false,
    privacy: {
      redacted: redacted.count > 0,
      redaction_count: redacted.count,
      redaction_types: redacted.redactions.map((item) => item.type),
      stored_source: false,
    },
    rate_limit: {
      limit: rateLimit.limit,
      remaining: rateLimit.remaining,
    },
  };
  console.info(JSON.stringify({
    event: 'analysis.completed',
    flow,
    stage,
    status: result.analysis.status,
    provider: result.meta.provider,
    model: result.meta.model,
    latency_ms: latencyMs,
    cost_cny: result.meta.estimated_cost_cny,
    redactions: redacted.count,
  }));
  if (cacheKey) {
    responseCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + (10 * 60 * 1000),
    });
    if (responseCache.size > 500) {
      const now = Date.now();
      for (const [key, entry] of responseCache) {
        if (entry.expiresAt <= now) responseCache.delete(key);
      }
      if (responseCache.size > 500) responseCache.clear();
    }
  }
  return jsonResponse(result);
}
