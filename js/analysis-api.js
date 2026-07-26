let statusPromise;

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
  try {
    const response = await fetch(`/api/analysis/${flow}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    return response.json();
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
    if (!template) return [];
    const question = questions.find((item) => (
      item.targets.includes(atom.id)
      || item.targets.includes(atom.canonical_capability_id)
      || item.targets.includes(atom.name)
    )) || questions[index];
    return [{
      ...template,
      modelQuestion: question?.question || '',
      modelAtom: atom,
    }];
  });
}
