export type DiscoveryKind = "problem" | "capability";

export type DiscoveryFlow = {
  schemaVersion: 2;
  status: "collecting" | "ready" | "confirmed";
  stage: string;
  fields: Record<string, {
    value: string;
    status: "provided" | "inferred" | "skipped";
    evidence: Array<{ sourceId: string; quote: string }>;
  }>;
  missingFields: string[];
  nextQuestion: string;
  confirmedAt: string | null;
};

export type DiscoveryTurn = {
  id: string;
  requestId?: string;
  question: string;
  answer: string;
  attachments?: string[];
  createdAt?: string;
};

export type ProblemBriefArtifact = {
  id?: string;
  kind: "problem_brief";
  diagnosis: string;
  action: string;
  profile: string;
  evidence: string[];
  flow?: DiscoveryFlow;
};

export type CapabilityIdentityArtifact = {
  id?: string;
  kind: "capability_identity";
  coreValue: string;
  capabilityIdentity: string;
  nextStep: string;
  evidence: string[];
  flow?: DiscoveryFlow;
};

export type DiscoveryArtifact = ProblemBriefArtifact | CapabilityIdentityArtifact;

export type DiscoveryVersion = {
  threadId: string | null;
  version: number;
};

export type DiscoveryState = DiscoveryVersion & {
  kind: DiscoveryKind;
  turns: DiscoveryTurn[];
  artifact: DiscoveryArtifact | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function normalizeDiscoveryFlow(value: unknown): DiscoveryFlow | undefined {
  const flow = asRecord(value);
  if (flow?.schemaVersion !== 2
    || (flow.status !== "collecting" && flow.status !== "ready" && flow.status !== "confirmed")) return undefined;
  const fields: DiscoveryFlow["fields"] = {};
  for (const [key, value] of Object.entries(asRecord(flow.fields) ?? {})) {
    const field = asRecord(value);
    if (!field || typeof field.value !== "string"
      || (field.status !== "provided" && field.status !== "inferred" && field.status !== "skipped")) continue;
    const evidence = Array.isArray(field.evidence) ? field.evidence.flatMap((value) => {
      const source = asRecord(value);
      return typeof source?.sourceId === "string" && typeof source.quote === "string"
        ? [{ sourceId: source.sourceId, quote: source.quote }] : [];
    }) : [];
    fields[key] = { value: field.value, status: field.status, evidence };
  }
  // A confirmation is not represented as saved unless the server supplies its timestamp.
  const confirmedAt = typeof flow.confirmedAt === "string" && Number.isFinite(Date.parse(flow.confirmedAt))
    ? flow.confirmedAt : null;
  return {
    schemaVersion: 2,
    status: flow.status === "confirmed" && !confirmedAt ? "ready" : flow.status,
    stage: typeof flow.stage === "string" ? flow.stage : "",
    fields,
    missingFields: Array.isArray(flow.missingFields) ? flow.missingFields.filter((item): item is string => typeof item === "string") : [],
    nextQuestion: typeof flow.nextQuestion === "string" ? flow.nextQuestion : "",
    confirmedAt,
  };
}

function normalizeArtifact(value: unknown): DiscoveryArtifact | null {
  const envelope = asRecord(value);
  if (!envelope) return null;
  const draft = asRecord(envelope.draft) ?? envelope;
  const kind = draft.kind === "capability_identity" || draft.kind === "problem_brief"
    ? draft.kind : envelope.kind === "capability" ? "capability_identity"
      : envelope.kind === "problem" ? "problem_brief" : envelope.kind;
  const evidence = Array.isArray(draft.evidence)
    ? draft.evidence.filter((item): item is string => typeof item === "string") : [];
  const flow = normalizeDiscoveryFlow(draft.flow);
  const metadata = {
    ...(typeof envelope.id === "string" ? { id: envelope.id } : {}),
    ...(flow ? { flow } : {}),
    evidence,
  };
  if (kind === "capability_identity" && typeof draft.coreValue === "string"
    && typeof draft.capabilityIdentity === "string" && typeof draft.nextStep === "string") {
    return { ...metadata, kind, coreValue: draft.coreValue, capabilityIdentity: draft.capabilityIdentity, nextStep: draft.nextStep };
  }
  if (kind === "problem_brief" && typeof draft.diagnosis === "string"
    && typeof draft.action === "string" && typeof draft.profile === "string") {
    return { ...metadata, kind, diagnosis: draft.diagnosis, action: draft.action, profile: draft.profile };
  }
  return null;
}

export function normalizeDiscoveryState(value: unknown): DiscoveryState {
  const response = asRecord(value);
  const state = asRecord(response?.discovery) ?? response;
  const thread = asRecord(state?.thread);
  const version = thread?.version ?? state?.version ?? state?.threadVersion;
  const turns = Array.isArray(state?.turns) ? state.turns.flatMap((value) => {
    const turn = asRecord(value);
    if (!turn || typeof turn.question !== "string" || typeof turn.answer !== "string") return [];
    const attachments = Array.isArray(turn.attachments) ? turn.attachments.flatMap((value) => {
      const name = typeof value === "string" ? value : asRecord(value)?.name;
      return typeof name === "string" ? [name.slice(0, 255)] : [];
    }) : [];
    return [{
      id: typeof turn.id === "string" || typeof turn.id === "number" ? String(turn.id) : globalThis.crypto.randomUUID(),
      ...(typeof turn.requestId === "string" ? { requestId: turn.requestId } : {}),
      question: turn.question,
      answer: turn.answer,
      ...(attachments.length ? { attachments } : {}),
      ...(typeof turn.createdAt === "string" ? { createdAt: turn.createdAt } : {}),
    }];
  }) : [];
  return {
    threadId: typeof thread?.id === "string" ? thread.id : typeof state?.threadId === "string" ? state.threadId : null,
    version: typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : 0,
    kind: (state?.kind ?? thread?.kind) === "capability" ? "capability" : "problem",
    turns,
    artifact: normalizeArtifact(state?.artifact),
  };
}

export function shouldShowCapabilityArtifact(artifact: DiscoveryArtifact | null): artifact is CapabilityIdentityArtifact {
  if (artifact?.kind !== "capability_identity" || !artifact.capabilityIdentity.trim() || !artifact.coreValue.trim()) return false;
  const flow = artifact.flow;
  if (!flow) return false;
  if (flow.status === "ready" || flow.status === "confirmed") return true;
  return ["role", "actions"].every((key) => flow.fields[key]?.status === "provided" && Boolean(flow.fields[key]?.value.trim()));
}

export function discoveryFlowHelper(flow: DiscoveryFlow | undefined, fallback: string) {
  if (!flow) return fallback;
  if (flow.status === "confirmed") return "当前版本已确认保存，未经平台验证。匹配内容已带入下方；需要继续完善，直接补充或修改即可。";
  if (flow.status === "ready") return "检查草稿后可点击“确认保存当前版本”；也可以直接说出要修改的地方。";
  return "可以一次补充多项信息，已提供的内容会保留；不确定可点“暂时跳过”，也可“先生成草稿”。";
}

const fieldLabels: Record<DiscoveryKind, Record<string, string>> = {
  problem: { context: "工作背景", work: "主要工作", outcome: "预期结果", collaboration: "合作方式", constraints: "时间与合作条件", requirements: "必要能力与加分经验", verification: "面谈核实重点" },
  capability: { situation: "经历背景", role: "个人职责", actions: "具体行动", outcome: "实际结果", evidence: "可提供的依据", direction: "适合承担的工作", preferences: "合作偏好" },
};

export function shouldFoldDiscoveryHistory(answer: string): boolean {
  if (answer.length > 400) return true;
  const lines = answer.split(/\r?\n/u).map((line) => line.trim());
  const headings = new Set(["用人需求说明", "需求简报", "能力档案"].flatMap((heading) => ["草稿", "用户已确认"].map((status) => `${heading} · ${status}`)));
  if (!lines.some((line) => headings.has(line))) return false;
  const labels = [...Object.values(fieldLabels.problem), ...Object.values(fieldLabels.capability)];
  return labels.filter((label) => lines.some((line) => line.startsWith(`${label}：`))).length >= 2;
}

/** Shorten only the exact server-rendered draft that is also present in the
 * current structured artifact. Source records and unrelated answer text stay intact. */
export function discoveryAnswerForDisplay(answer: string, artifact: DiscoveryArtifact | null): string {
  const flow = artifact?.flow;
  if (!artifact || !flow || flow.schemaVersion !== 2 || !Object.values(flow.fields).some((field) => field.value.trim())) return answer;
  const kind = artifact.kind === "problem_brief" ? "problem" : "capability";
  const heading = `${kind === "problem" ? "用人需求说明" : "能力档案"} · ${flow.status === "confirmed" ? "用户已确认" : "草稿"}`;
  const entries = Object.entries(fieldLabels[kind]);
  const lines = entries.map(([key, label]) => {
    const field = flow.fields[key];
    const value = !field || field.status === "skipped" ? "待补充" : `${field.value}${field.status === "inferred" ? "（AI 建议，待确认）" : ""}`;
    return `${label}：${value}`;
  });
  const missing = entries.filter(([key]) => flow.missingFields.includes(key)).map(([, label]) => label);
  const provenance = "依据来自本人陈述或所附材料，未经平台核验。";
  const renderedDraft = [heading, ...lines,
    missing.length ? `还需补充：${missing.join("、")}。可以先保留这份草稿，之后继续。` : "", provenance,
  ].filter(Boolean).join("\n");
  const start = answer.indexOf(renderedDraft);
  if (start === -1 || answer.indexOf(renderedDraft, start + renderedDraft.length) !== -1) return answer;
  const before = answer.slice(0, start);
  const after = answer.slice(start + renderedDraft.length);
  // The server joins acknowledgement, draft, and next step with empty lines.
  // A draft-like quotation inside an ordinary paragraph is not a generated block.
  if ((before && !before.endsWith("\n\n")) || (after && !after.startsWith("\n\n"))) return answer;
  return [before.trim(), `${heading}\n${provenance}`, after.trim()].filter(Boolean).join("\n\n");
}

export function discoveryReviewFields(kind: DiscoveryKind, flow: DiscoveryFlow) {
  return Object.entries(fieldLabels[kind]).flatMap(([key, label]) => {
    const field = flow.fields[key];
    if (!field?.value.trim()) return [];
    return [{ key, label, ...field, statusLabel: field.status === "inferred" ? "建议 · 待确认" : field.status === "skipped" ? "稍后补充" : field.evidence.length ? "来自你的描述" : "待补充依据" }];
  });
}

export function discoveryMissingLabels(kind: DiscoveryKind, flow: DiscoveryFlow) {
  return flow.missingFields.flatMap((key) => fieldLabels[kind][key] ? [fieldLabels[kind][key]] : []);
}

export type DiscoveryExample = { label: string; prompt: string };
export const discoveryExamples: Record<DiscoveryKind, DiscoveryExample[]> = {
  problem: [
    { label: "AI 知识库需求", prompt: "【示例输入，请替换为真实情况】我们有 20 人的售后团队，产品手册和历史工单分散，客服每天反复找答案。希望有人梳理资料、搭建带来源引用的 AI 知识库，接入现有客服系统，并对错误回答和人工转接做测试。先用脱敏资料验证，目标是让客服快速找到可靠出处，不让 AI 直接承诺退款。希望 6 周内完成试点，可远程按项目合作，预算还没定。" },
    { label: "AI 评测需求", prompt: "【示例输入，请替换为真实情况】我们已有一个 AI 助手，但同一个问题的答案不稳定。需要有人整理真实问题，建立评测集，检查回答是否有资料依据、拒答是否合理，以及延迟和成本。希望先交付可重复运行的评测报告与改进清单。现有后端同事负责系统接入，外部协作者负责评测设计和实施，可远程阶段合作。" },
    { label: "企业出海需求", prompt: "【示例输入，请替换为真实情况】我们是做工业设备的 B2B 企业，准备进入德国市场，目前没有当地销售线索。希望找人核实目标客户、访谈潜在买家，调整英文和德文产品材料，并建立渠道伙伴名单。希望 8 周内形成市场进入建议和可追踪的商机流程，不承诺一定成交。需要工业品出海经验、英语工作沟通能力，德语是加分项，可远程按项目合作。" },
  ],
  capability: [
    { label: "AI 项目经历", prompt: "【示例输入，请替换为真实情况】我参与过内部 AI 知识库项目，资料分散是主要问题。我个人负责清洗文档、设计检索流程，用 Python 接入模型，给回答加出处并整理评测集；同事负责权限和上线。我做了 80 条问题的离线测试，记录了错答类型，目前只有内部试用反馈，没有生产效果数据。我可以提供脱敏流程图和评测报告，希望接 AI 知识库或评测的远程阶段项目。" },
    { label: "AI 入门作品", prompt: "【示例输入，请替换为真实情况】我做过一个个人作品：用公开产品文档搭建问答助手。我自己整理资料、写 Python 检索脚本并设计了 30 个测试问题，记录回答错误后调整了分段方式。代码能本地运行，有 README 和测试记录，尚未给真实客户使用。我希望先承担文档整理和 AI 评测助理的工作，每周可以远程投入 15 小时。" },
    { label: "企业出海经历", prompt: "【示例输入，请替换为真实情况】我曾参与工业设备进入欧洲市场的项目，个人负责目标客户调研、英文产品材料和渠道伙伴访谈，没有负责签约。我整理了 50 家潜在客户的信息，协助完成 8 次英语访谈，形成市场反馈和跟进表；最终订单是销售团队完成的。我可以提供脱敏调研框架，适合做 B2B 出海市场调研和渠道开发，英语可工作沟通，可远程阶段合作。" },
  ],
};

export type DiscoveryPendingSubmission = DiscoveryVersion & { requestId: string };
export type DiscoveryComposerDraft = {
  prompt: string;
  startsFresh: boolean;
  attachmentCount: number;
  pending: DiscoveryPendingSubmission | null;
};

const COMPOSER_TTL_MS = 60 * 60 * 1000;

export function readDiscoveryComposerDraft(storage: Pick<Storage, "getItem" | "removeItem">, key: string, now = Date.now()): DiscoveryComposerDraft | null {
  try {
    const draft = asRecord(JSON.parse(storage.getItem(key) || "null"));
    if (!draft || typeof draft.expiresAt !== "number" || draft.expiresAt <= now
      || typeof draft.prompt !== "string" || draft.prompt.length > 12_000) {
      storage.removeItem(key);
      return null;
    }
    const pending = asRecord(draft.pending);
    return {
      prompt: draft.prompt,
      startsFresh: draft.startsFresh === true,
      attachmentCount: typeof draft.attachmentCount === "number" ? Math.max(0, Math.min(5, Math.floor(draft.attachmentCount))) : 0,
      pending: pending && typeof pending.requestId === "string"
        && (typeof pending.threadId === "string" || pending.threadId === null)
        && typeof pending.version === "number" && Number.isSafeInteger(pending.version) && pending.version >= 0
        ? { requestId: pending.requestId, threadId: pending.threadId, version: pending.version } : null,
    };
  } catch {
    return null;
  }
}

export function writeDiscoveryComposerDraft(storage: Pick<Storage, "setItem" | "removeItem">, key: string, draft: DiscoveryComposerDraft, now = Date.now()) {
  try {
    if (!draft.prompt && !draft.attachmentCount) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ ...draft, expiresAt: now + COMPOSER_TTL_MS }));
  } catch {
    // Unavailable browser storage must not prevent sending or editing a message.
  }
}
