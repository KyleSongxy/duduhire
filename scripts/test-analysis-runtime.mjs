import assert from 'node:assert/strict';
import { getProviderChain, validateAnalysis } from '../worker/analysis.js';
import { matchAnalysis } from '../worker/matching.js';
import { buildAnalysisSource, redactSensitiveText } from '../worker/privacy.js';

const demandText = '产品调用量增加后成本上升，希望两周内找到主要成本来源。';
const demand = {
  schema_version: '1.0',
  status: 'needs_clarification',
  source: {
    text: demandText,
    language: 'zh-CN',
    sensitive: false,
  },
  facts: [
    {
      id: 'f_1',
      kind: 'symptom',
      claim: '调用量增加后成本上升',
      source_quote: '调用量增加后成本上升',
      confidence: 1,
    },
    {
      id: 'f_2',
      kind: 'deadline',
      claim: '希望两周内完成',
      source_quote: '希望两周内',
      confidence: 1,
    },
  ],
  problem: {
    summary: '产品调用成本随调用量增加而上升，需要定位主要成本来源。',
    scene: 'AI 产品',
    stage: null,
    affected_actors: [],
    impact: {
      description: '成本上升',
      metrics: [],
    },
    attempts: [],
    desired_outcome: '找到主要成本来源',
    constraints: {
      deadline: '两周内',
      budget: null,
      data_access: null,
      stakeholders: [],
      forbidden_actions: [],
    },
    acceptance_criteria: [],
    root_cause_status: 'unknown',
    root_cause_hypotheses: [],
  },
  uncertainties: [
    {
      field: '数据访问',
      reason: '没有说明是否可以查看调用日志和账单',
      blocking: true,
    },
  ],
  questions: [
    {
      id: 'q_1',
      targets: ['数据访问'],
      question: '可以提供哪些调用日志和账单信息？',
      reason: '这会决定能否定位成本来源',
      priority: 1,
    },
  ],
  matching_input: {
    task_summary: '定位 AI 产品的主要调用成本来源',
    required_capabilities: [
      {
        task: '审计模型调用成本',
        expected_deliverable: '成本基线',
        evidence_needed: '调用日志和账单',
      },
    ],
    market: null,
    hard_filters: [],
  },
  risk_flags: [],
};

assert.equal(validateAnalysis('demand', demand, demand.source).valid, true);

const ungroundedDemand = structuredClone(demand);
ungroundedDemand.facts[0].source_quote = '原文里没有这句话';
assert.equal(validateAnalysis('demand', ungroundedDemand, ungroundedDemand.source).valid, false);

const capabilityText = '我负责审计调用日志，交付了成本基线，相关过程可由账单核验。';
const capability = {
  schema_version: '1.0',
  status: 'ready_for_l0_card',
  source: {
    text: capabilityText,
    language: 'zh-CN',
    sensitive: false,
  },
  projects: [
    {
      id: 'p_1',
      title: '调用成本审计',
      scene: 'AI 产品',
      role: null,
      contribution: 'owned',
      goal: null,
      actions: ['审计调用日志'],
      methods: [],
      deliverables: ['成本基线'],
      outcomes: [],
      evidence: [
        {
          id: 'e_1',
          statement: '过程可由账单核验',
          source_quote: '相关过程可由账单核验',
          verification_status: 'document_referenced',
          confidence: 1,
        },
      ],
      boundaries: ['没有提供量化降本结果'],
      source_quotes: ['我负责审计调用日志', '交付了成本基线'],
    },
  ],
  capability_atoms: [
    {
      id: 'c_1',
      canonical_capability_id: 'model-routing-cost-optimization',
      name: '模型路由与推理成本优化',
      category: 'AI 工程化',
      scene: 'AI 产品',
      task: '审计模型调用成本',
      methods: [],
      deliverables: ['成本基线'],
      outcomes: [],
      evidence_claim_ids: ['e_1'],
      project_ids: ['p_1'],
      boundaries: ['没有提供量化降本结果'],
      level: 'L0',
      confidence: 0.8,
    },
  ],
  uncertainties: [],
  questions: [],
  matching_input: {
    task_terms: ['调用成本审计'],
    markets: ['AI 产品'],
    deliverable_terms: ['成本基线'],
    verified_evidence_only: false,
  },
  risk_flags: [],
};

assert.equal(validateAnalysis('capability', capability, capability.source).valid, true);

const promotedCapability = structuredClone(capability);
promotedCapability.capability_atoms[0].level = 'L3';
assert.equal(validateAnalysis('capability', promotedCapability, promotedCapability.source).valid, false);

const redacted = redactSensitiveText('联系邮箱 demo@example.com，手机号 13800138000，密码：secret123');
assert.equal(redacted.count, 3);
assert.equal(redacted.text.includes('demo@example.com'), false);
assert.equal(redacted.text.includes('13800138000'), false);
assert.equal(redacted.text.includes('secret123'), false);

const refinedSource = buildAnalysisSource({
  text: demandText,
  answers: [{
    question: '可以提供哪些数据？',
    answer: '可以提供调用日志和账单。',
  }],
  corrections: '验收标准需要包含回滚方案。',
});
assert.equal(refinedSource.includes('补充问答'), true);
assert.equal(refinedSource.includes('用户修正'), true);

const demandMatches = matchAnalysis('demand', demand, {
  confirmedFactIds: ['f_1', 'f_2'],
});
assert.equal(demandMatches.status, 'ready');
assert.equal(demandMatches.matches.length, 3);
assert.equal(demandMatches.matches[0].score >= demandMatches.matches[1].score, true);

const capabilityMatches = matchAnalysis('capability', capability, {
  confirmedAtomIds: ['c_1'],
});
assert.equal(capabilityMatches.status, 'ready');
assert.equal(capabilityMatches.matches.length, 3);

const highRiskCapability = structuredClone(capability);
highRiskCapability.status = 'requires_human_review';
highRiskCapability.risk_flags = ['prompt_injection'];
assert.equal(matchAnalysis('capability', highRiskCapability).status, 'withheld');

const providerChain = getProviderChain({
  DEEPSEEK_API_KEY: 'test',
  DASHSCOPE_API_KEY: 'test',
}, 'capability', 'x'.repeat(7000));
assert.deepEqual(
  providerChain.map((provider) => [provider.name, provider.model]),
  [
    ['qwen', 'qwen3.7-plus'],
    ['deepseek', 'deepseek-v4-pro'],
    ['qwen', 'qwen3.7-flash'],
  ],
);

const shortDemandChain = getProviderChain({
  DEEPSEEK_API_KEY: 'test',
  DASHSCOPE_API_KEY: '  Bearer "sk-ws-test"  ',
}, 'demand', '简短需求', { stage: 'initial' });
assert.deepEqual(
  shortDemandChain.map((provider) => provider.model),
  ['qwen3.7-flash', 'deepseek-v4-flash', 'qwen3.7-plus'],
);
assert.equal(shortDemandChain[0].apiKey, 'sk-ws-test');
assert.equal(shortDemandChain[0].keyFormat.kind, 'model_studio_workspace');
assert.equal(shortDemandChain[0].keyFormat.removed_wrapper, true);

const redactedOrganization = redactSensitiveText(
  '客户名：星河科技，项目由星河科技发起。',
  ['星河科技'],
);
assert.equal(redactedOrganization.text.includes('星河科技'), false);
assert.equal(redactedOrganization.redactions.some((item) => item.type === 'organization_name'), true);

console.log('Analysis runtime validation tests passed.');
