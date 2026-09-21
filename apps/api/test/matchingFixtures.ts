import { randomUUID } from "node:crypto";
import type { DiscoveryKind } from "../src/domain.js";
import type { MatchingDraft } from "../src/matching.js";
import type { NewDiscoveryTurn } from "../src/repository.js";

export function matchingDiscoveryTurn(kind: DiscoveryKind, confirmed = true): NewDiscoveryTurn {
  const requestId = randomUUID();
  const quote = "负责知识库和系统集成，完成信息梳理与交付验收";
  const required = kind === "problem" ? ["context", "work", "outcome"] : ["situation", "role", "actions", "outcome"];
  return {
    requestId, question: `${quote}。私有对话标记 PRIVATE_TRANSCRIPT_SENTINEL`,
    answer: "已整理当前版本。", attachments: [{ name: "private-evidence.txt", mediaType: "text/plain", size: 42 }],
    analysisContext: "PRIVATE_ANALYSIS_SENTINEL", provider: "local", model: "matching-integration-fixture", promptVersion: "test.v2",
    artifactDraft: {
      kind: kind === "problem" ? "problem_brief" : "capability_identity",
      flow: {
        schemaVersion: 2, status: confirmed ? "confirmed" : "ready", confirmedAt: confirmed ? new Date().toISOString() : null,
        fields: Object.fromEntries(required.map((key) => [key, {
          value: quote, status: "provided", evidence: [{ sourceId: `user:${requestId}`, quote }],
        }])),
      },
    },
  };
}

export const matchingDraftFixture: MatchingDraft = {
  title: "知识库实施与系统集成", summary: "梳理业务知识并完成系统集成，以可以使用的交付成果验收。",
  skills: ["知识库", "系统集成"], requiredSkills: [], workMode: "remote", engagement: "project", location: "", notes: "",
};
