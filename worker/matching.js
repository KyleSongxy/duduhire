import { capabilityCatalog, enterpriseDemandCatalog } from '../js/data.js';

const lowSignalTerms = new Set([
  'ai', '人工智能', '企业', '客户', '产品', '项目', '市场', '团队', '工作',
]);
const knownMarkets = [
  '中国', '新加坡', '印尼', '印度尼西亚', '泰国', '马来西亚', '东南亚',
  'AI 应用团队', '企业客户', '企业服务', '受监管行业',
];

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function uniqueTerms(values) {
  return [...new Set(values.flatMap((value) => (
    normalize(value)
      .split(/[、，。；：,.;:\s/|]+/)
      .filter((term) => term.length >= 2 && !lowSignalTerms.has(term))
  )))];
}

function termScore(sourceValues, candidateValues, maxScore) {
  const source = normalize(sourceValues.join(' '));
  const candidate = normalize(candidateValues.join(' '));
  const terms = uniqueTerms(sourceValues);
  if (!terms.length) return { score: 0, matches: [] };
  const matches = terms.filter((term) => candidate.includes(term) || source.includes(term) && candidate.includes(term));
  const keywordMatches = uniqueTerms(candidateValues).filter((term) => source.includes(term));
  const combined = [...new Set([...matches, ...keywordMatches])];
  const ratio = Math.min(1, combined.length / Math.max(2, Math.min(terms.length, 6)));
  return {
    score: Math.round(maxScore * ratio),
    matches: combined.slice(0, 5),
  };
}

function marketScore(sourceMarkets, candidateMarkets) {
  const source = sourceMarkets.map(normalize).filter(Boolean);
  const candidate = candidateMarkets.map(normalize).filter(Boolean);
  if (!source.length) return { score: 6, matches: [] };
  const matches = source.filter((market) => candidate.some((item) => (
    item.includes(market) || market.includes(item) || item === '多市场' || item === '东南亚'
  )));
  return {
    score: matches.length ? 15 : 0,
    matches,
  };
}

function buildReasons(parts) {
  return parts
    .filter((part) => part.score > 0)
    .map((part) => ({
      dimension: part.dimension,
      score: part.score,
      reason: part.matches.length
        ? `匹配到：${part.matches.join('、')}`
        : part.reason,
    }));
}

function confidenceLabel(score) {
  if (score >= 75) return 'high';
  if (score >= 50) return 'medium';
  return 'exploratory';
}

function passesKnownHardFilters(filters, candidate) {
  const requestedMarkets = knownMarkets.filter((market) => (
    filters.some((filter) => normalize(filter).includes(normalize(market)))
  ));
  if (!requestedMarkets.length) return true;
  const candidateMarkets = (candidate.markets || []).map(normalize);
  return requestedMarkets.some((market) => candidateMarkets.some((candidateMarket) => (
    candidateMarket.includes(normalize(market))
    || normalize(market).includes(candidateMarket)
    || candidateMarket === '多市场'
  )));
}

function matchDemandToCapabilities(analysis, confirmation) {
  const confirmedFactIds = new Set(confirmation?.confirmedFactIds || analysis.facts.map((fact) => fact.id));
  const confirmedFacts = analysis.facts.filter((fact) => confirmedFactIds.has(fact.id));
  const tasks = [
    analysis.matching_input.task_summary,
    ...analysis.matching_input.required_capabilities.map((item) => item.task),
    ...confirmedFacts.map((fact) => fact.claim),
  ];
  const deliverables = analysis.matching_input.required_capabilities.flatMap((item) => [
    item.expected_deliverable,
    item.evidence_needed,
  ]).filter(Boolean);
  const markets = [
    analysis.matching_input.market,
    analysis.problem.scene,
    ...analysis.problem.affected_actors,
  ].filter(Boolean);

  const hardFilters = analysis.matching_input.hard_filters || [];
  return capabilityCatalog.filter((candidate) => (
    passesKnownHardFilters(hardFilters, candidate)
  )).map((candidate, index) => {
    const task = termScore(tasks, [
      candidate.name,
      candidate.description,
      ...(candidate.tasks || []),
      ...(candidate.keywords || []),
    ], 50);
    const deliverable = termScore(deliverables, [
      ...(candidate.deliverables || []),
      candidate.evidence,
      candidate.acceptance,
    ], 25);
    const market = marketScore(markets, candidate.markets || []);
    const evidence = deliverables.length && candidate.evidence ? 8 : 4;
    const boundary = candidate.boundary ? 2 : 0;
    const score = task.score + deliverable.score + market.score + evidence + boundary;
    return {
      id: candidate.id,
      score,
      confidence: confidenceLabel(score),
      reasons: buildReasons([
        { dimension: '任务', ...task, reason: '任务结构接近' },
        { dimension: '交付', ...deliverable, reason: '交付与证据要求接近' },
        { dimension: '场景', ...market, reason: '场景仍需确认' },
        { dimension: '证据', score: evidence, matches: [], reason: '候选能力包含可核验证据要求' },
        { dimension: '边界', score: boundary, matches: [], reason: '候选能力明确说明合作边界' },
      ]),
      index,
    };
  }).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3);
}

function matchCapabilityToDemands(analysis, confirmation) {
  const confirmedAtomIds = new Set(
    confirmation?.confirmedAtomIds || analysis.capability_atoms.map((atom) => atom.id),
  );
  const atoms = analysis.capability_atoms.filter((atom) => confirmedAtomIds.has(atom.id));
  const tasks = [
    ...analysis.matching_input.task_terms,
    ...atoms.flatMap((atom) => [atom.name, atom.task, ...atom.methods]),
  ];
  const deliverables = [
    ...analysis.matching_input.deliverable_terms,
    ...atoms.flatMap((atom) => atom.deliverables),
  ];
  const markets = [
    ...analysis.matching_input.markets,
    ...atoms.map((atom) => atom.scene),
  ].filter(Boolean);
  const evidenceCount = atoms.reduce((sum, atom) => sum + atom.evidence_claim_ids.length, 0);

  return enterpriseDemandCatalog.map((candidate, index) => {
    const task = termScore(tasks, [
      candidate.title,
      candidate.summary,
      candidate.goal,
      ...(candidate.keywords || []),
    ], 50);
    const deliverable = termScore(deliverables, [
      ...(candidate.deliverables || []),
      candidate.acceptance,
      candidate.inputs,
    ], 25);
    const market = marketScore(markets, candidate.markets || []);
    const evidence = Math.min(8, evidenceCount * 2);
    const boundary = candidate.boundary ? 2 : 0;
    const score = task.score + deliverable.score + market.score + evidence + boundary;
    return {
      id: candidate.id,
      score,
      confidence: confidenceLabel(score),
      reasons: buildReasons([
        { dimension: '任务', ...task, reason: '能力任务与需求目标接近' },
        { dimension: '交付', ...deliverable, reason: '已做过的交付与需求产出接近' },
        { dimension: '场景', ...market, reason: '市场场景仍需确认' },
        {
          dimension: '证据',
          score: evidence,
          matches: [],
          reason: evidenceCount ? `已有 ${evidenceCount} 条自述或材料证据` : '尚缺可核验证据',
        },
        { dimension: '边界', score: boundary, matches: [], reason: '需求明确说明服务边界' },
      ]),
      index,
    };
  }).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3);
}

export function matchAnalysis(flow, analysis, confirmation = {}) {
  if (analysis.status === 'requires_human_review') {
    return {
      status: 'withheld',
      message: '高风险内容完成人工复核前不自动匹配。',
      matches: [],
    };
  }
  const matches = flow === 'demand'
    ? matchDemandToCapabilities(analysis, confirmation)
    : matchCapabilityToDemands(analysis, confirmation);
  return {
    status: 'ready',
    method: 'structured-v1',
    matches: matches.map(({ index, ...match }) => match),
  };
}
