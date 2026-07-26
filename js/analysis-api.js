let statusPromise;
const inflightRequests = new Map();

async function getAnalysisStatus() {
  if (!statusPromise) {
    statusPromise = fetch('/api/analysis/status', {
      headers: { accept: 'application/json' },
    })
      .then((response) => (response.ok ? response.json() : { enabled: false }))
      .catch(() => ({ enabled: false }));
  }
  return statusPromise;
}

export async function analyzeWithDomesticModel(flow, payload) {
  const status = await getAnalysisStatus();
  if (!status.enabled) return null;
  const idempotencyKey = payload.idempotency_key
    || `${flow}_${crypto.randomUUID().replaceAll('-', '')}`;
  const requestPayload = {
    ...payload,
    idempotency_key: idempotencyKey,
  };
  if (inflightRequests.has(idempotencyKey)) return inflightRequests.get(idempotencyKey);
  const request = (async () => {
    try {
      const response = await fetch(`/api/analysis/${flow}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestPayload),
      });
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    } finally {
      inflightRequests.delete(idempotencyKey);
    }
  })();
  inflightRequests.set(idempotencyKey, request);
  return request;
}

export async function refineWithDomesticModel(flow, {
  text,
  sensitive = false,
  previousAnalysis,
  answers = [],
  corrections = '',
}) {
  return analyzeWithDomesticModel(flow, {
    text,
    sensitive,
    previous_analysis: previousAnalysis,
    answers,
    corrections,
  });
}

export async function requestStructuredMatch(flow, analysis, confirmation = {}) {
  try {
    const response = await fetch('/api/match', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ flow, analysis, confirmation }),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export async function submitAnalysisFeedback(payload) {
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

export async function submitHumanReview(payload) {
  try {
    const response = await fetch('/api/review', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

export function mapDemandAnalysis(result, fallback) {
  if (!result?.analysis) return fallback;
  const { analysis, meta } = result;
  const { problem } = analysis;
  return {
    ...fallback,
    market: problem.scene || fallback.market,
    stage: problem.stage || fallback.stage,
    impact: problem.impact.description || fallback.impact,
    tried: problem.attempts.map((item) => (
      item.result ? `${item.action}（${item.result}）` : item.action
    )).join('；') || fallback.tried,
    result: problem.desired_outcome || fallback.result,
    deadline: problem.constraints.deadline || fallback.deadline,
    acceptance: problem.acceptance_criteria.map((item) => item.criterion).join('；'),
    access: problem.constraints.data_access || '',
    modelAnalysis: analysis,
    analysisMeta: meta,
  };
}

export function getDemandModelQuestions(values) {
  return (values.modelAnalysis?.questions || []).map((question) => ({
    id: question.id,
    label: question.question,
    hint: question.reason,
  }));
}

export function getCapabilityModelSkills(result, templates, catalog) {
  if (!result?.analysis?.capability_atoms?.length) return [];
  const questions = result.analysis.questions || [];
  return result.analysis.capability_atoms.flatMap((atom, index) => {
    const canonical = catalog.find((item) => item.id === atom.canonical_capability_id);
    const template = templates.find((item) => item.name === canonical?.name)
      || templates.find((item) => item.name === atom.name);
    const skill = template || {
      id: atom.id,
      name: atom.name,
      category: atom.category,
      task: atom.task,
      method: atom.methods.join('、') || '方法待进一步确认',
      deliverables: atom.deliverables.length ? atom.deliverables : ['交付物待进一步确认'],
      evidenceExamples: atom.evidence_claim_ids.length
        ? `关联 ${atom.evidence_claim_ids.length} 条原文证据`
        : '需要补充可核验证据',
      boundary: atom.boundaries.join('；') || '能力边界待进一步确认',
      keywords: [atom.name, atom.task, ...atom.methods],
    };
    const question = questions.find((item) => (
      item.targets.includes(atom.id)
      || item.targets.includes(atom.canonical_capability_id)
      || item.targets.includes(atom.name)
    )) || questions[index];
    return [{
      ...skill,
      modelQuestion: question?.question || '',
      modelAtom: atom,
    }];
  });
}
