import assert from 'node:assert/strict';
import { validateAnalysis } from '../worker/analysis.js';

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

console.log('Analysis runtime validation tests passed.');
