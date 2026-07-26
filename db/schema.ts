// D1 schema contract. Runtime access stays in worker/storage.js and uses prepared statements.
// The matching SQL migration lives in drizzle/0000_operational_loop.sql.

export interface AnalysisReceipt {
  id: string;
  flow: 'demand' | 'capability';
  stage: 'initial' | 'refined';
  status: string;
  sourceHash: string;
  provider: string | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  estimatedCostCny: number;
  latencyMs: number;
  redactionCount: number;
  createdAt: number;
}

export interface FeedbackRecord {
  id: string;
  receiptId: string | null;
  flow: 'demand' | 'capability';
  target: 'analysis' | 'questions' | 'match';
  verdict: 'helpful' | 'partly_helpful' | 'not_helpful';
  tagsJson: string;
  comment: string | null;
  consent: boolean;
  createdAt: number;
}

export interface ReviewRecord {
  id: string;
  flow: 'demand' | 'capability';
  status: 'pending' | 'in_review' | 'resolved' | 'rejected';
  riskFlagsJson: string;
  redactedPayloadJson: string;
  reviewerNote: string | null;
  resolution: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderAttempt {
  id: string;
  flow: 'demand' | 'capability';
  stage: 'initial' | 'refined' | 'probe';
  provider: 'deepseek' | 'qwen';
  model: string;
  status: 'success' | 'failure' | 'circuit_open';
  latencyMs: number;
  estimatedCostCny: number;
  routeReason: string | null;
  createdAt: number;
}

export interface EvidenceSubmission {
  id: string;
  capabilityName: string;
  evidenceType: string;
  level: 'L0' | 'L1' | 'L2' | 'L3';
  status: 'material_pending' | 'material_verified' | 'microtask_submitted' | 'microtask_passed' | 'certified' | 'revision_required' | 'rejected';
  createdAt: number;
  updatedAt: number;
}

export interface EvaluationCase {
  caseId: string;
  flow: 'demand' | 'capability';
  status: 'pending' | 'reviewing' | 'agreed' | 'disputed' | 'adjudicated';
  createdAt: number;
  updatedAt: number;
}
