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
