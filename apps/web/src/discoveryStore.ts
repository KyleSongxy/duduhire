import { ApiError, apiRequest, readApiAuthContextVersion } from "./api";
import { normalizeDiscoveryState, type DiscoveryState, type DiscoveryVersion } from "./discoveryFlow";
export type {
  DiscoveryKind,
  DiscoveryFlow,
  DiscoveryTurn,
  ProblemBriefArtifact,
  CapabilityIdentityArtifact,
  DiscoveryArtifact,
  DiscoveryState,
  DiscoveryVersion,
} from "./discoveryFlow";

export type DiscoveryAttachmentInput = {
  name: string;
  contentType: string;
  sizeBytes: number;
  textExcerpt: string;
};

const discoveryRequests = new Map<number, Promise<DiscoveryState>>();
const intakeClaims = new Map<string, Promise<string>>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value) throw new ApiError("服务返回了无效数据，请稍后重试。", 0, `INVALID_${field.toUpperCase()}`);
  return value;
}

export function createRequestId() {
  return window.crypto.randomUUID();
}

export async function createDiscoveryIntake(prompt: string) {
  const response = await apiRequest<unknown>("/discovery/intakes", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
  return requireString(asRecord(response)?.intakeId, "intake_id");
}

export function claimDiscoveryIntake(intakeId: string) {
  const key = `${readApiAuthContextVersion()}:${intakeId}`;
  const existing = intakeClaims.get(key);
  if (existing) return existing;
  const request = apiRequest<unknown>(`/me/discovery/intakes/${encodeURIComponent(intakeId)}/claim`, {
    method: "POST",
  }).then((response) => requireString(asRecord(response)?.prompt, "prompt"));
  intakeClaims.set(key, request);
  void request.finally(() => {
    if (intakeClaims.get(key) === request) intakeClaims.delete(key);
  }).catch(() => undefined);
  return request;
}

export function loadDiscovery() {
  const contextVersion = readApiAuthContextVersion();
  const existing = discoveryRequests.get(contextVersion);
  if (existing) return existing;
  const request = apiRequest<unknown>("/me/discovery").then(normalizeDiscoveryState);
  discoveryRequests.set(contextVersion, request);
  void request.finally(() => {
    if (discoveryRequests.get(contextVersion) === request) discoveryRequests.delete(contextVersion);
  }).catch(() => undefined);
  return request;
}

export async function submitDiscoveryTurn(input: {
  requestId: string;
  prompt: string;
  attachments: DiscoveryAttachmentInput[];
  expectedThreadId: string | null;
  expectedVersion: number;
}) {
  const response = await apiRequest<unknown>("/me/discovery/turns", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: 120_000,
  });
  return normalizeDiscoveryState(response);
}

export async function resetDiscovery(expected: DiscoveryVersion) {
  const response = await apiRequest<unknown>("/me/discovery/reset", {
    method: "POST",
    body: JSON.stringify({ expectedThreadId: expected.threadId, expectedVersion: expected.version }),
    timeoutMs: 30_000,
  });
  return response === undefined ? null : normalizeDiscoveryState(response);
}
