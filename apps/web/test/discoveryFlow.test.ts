import assert from "node:assert/strict";
import test from "node:test";
import {
  discoveryFlowHelper,
  discoveryAnswerForDisplay,
  discoveryExamples,
  discoveryMissingLabels,
  discoveryReviewFields,
  normalizeDiscoveryFlow,
  normalizeDiscoveryState,
  readDiscoveryComposerDraft,
  shouldShowCapabilityArtifact,
  shouldFoldDiscoveryHistory,
  writeDiscoveryComposerDraft,
  type CapabilityIdentityArtifact,
  type DiscoveryComposerDraft,
  type DiscoveryFlow,
  type ProblemBriefArtifact,
} from "../src/discoveryFlow.ts";

function flow(overrides: Partial<DiscoveryFlow> = {}): DiscoveryFlow {
  return { schemaVersion: 2, status: "collecting", stage: "role", fields: {}, missingFields: ["role", "actions"], nextQuestion: "你具体负责哪一部分？", confirmedAt: null, ...overrides };
}

function artifact(value?: DiscoveryFlow): CapabilityIdentityArtifact {
  return { kind: "capability_identity", coreValue: "帮助同事查找内部资料", capabilityIdentity: "知识库开发", evidence: [], nextStep: "补充个人负责的工作", ...(value ? { flow: value } : {}) };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("discovery restores nested artifacts, source evidence, request IDs and authoritative thread version", () => {
  const state = normalizeDiscoveryState({ discovery: {
    version: 1,
    thread: { id: "thread-1", kind: "capability", version: 7 },
    turns: [{ id: "turn-1", requestId: "request-1", question: "我负责资料分类。", answer: "后来有什么变化？", attachments: [{ name: "case.md" }] }],
    artifact: { id: "artifact-1", kind: "capability", draft: artifact(flow({
      fields: { role: { value: "资料分类", status: "provided", evidence: [{ sourceId: "turn-1", quote: "我负责资料分类" }] } },
    })) },
  } });
  assert.equal(state.threadId, "thread-1");
  assert.equal(state.version, 7);
  assert.equal(state.kind, "capability");
  assert.equal(state.turns[0]?.requestId, "request-1");
  assert.deepEqual(state.turns[0]?.attachments, ["case.md"]);
  assert.deepEqual(state.artifact?.flow?.fields.role.evidence, [{ sourceId: "turn-1", quote: "我负责资料分类" }]);
});

test("discovery supports top-level version and empty-thread state without manufacturing a thread", () => {
  assert.equal(normalizeDiscoveryState({ version: 4 }).version, 4);
  assert.equal(normalizeDiscoveryState({ threadVersion: 6 }).version, 6);
  assert.equal(normalizeDiscoveryState({ version: -1 }).version, 0);
  assert.equal(normalizeDiscoveryState({ version: 1.5 }).version, 0);
  assert.deepEqual(normalizeDiscoveryState(null), { threadId: null, version: 0, kind: "problem", turns: [], artifact: null });
});

test("unknown schema and unsupported field statuses are not treated as confirmed facts", () => {
  assert.equal(normalizeDiscoveryFlow({ ...flow(), schemaVersion: 1 }), undefined);
  assert.equal(normalizeDiscoveryFlow({ ...flow(), status: "verified" }), undefined);
  const normalized = normalizeDiscoveryFlow({ ...flow(), fields: {
    role: { value: "项目负责人", status: "verified", evidence: [] },
    actions: { value: "整理资料", status: "provided", evidence: [null, { sourceId: 2, quote: "资料" }, { sourceId: "turn-1", quote: "整理资料" }] },
  } });
  assert.equal(normalized?.fields.role, undefined);
  assert.deepEqual(normalized?.fields.actions.evidence, [{ sourceId: "turn-1", quote: "整理资料" }]);
});

test("confirmation requires a saved timestamp and never becomes platform verification", () => {
  assert.equal(normalizeDiscoveryFlow(flow({ status: "confirmed" }))?.status, "ready");
  assert.equal(normalizeDiscoveryFlow(flow({ status: "confirmed", confirmedAt: "invalid" }))?.status, "ready");
  const saved = normalizeDiscoveryFlow(flow({ status: "confirmed", confirmedAt: "2026-09-06T12:00:00Z" }));
  assert.equal(saved?.status, "confirmed");
  assert.match(discoveryFlowHelper(saved, ""), /未经平台验证/u);
  assert.match(discoveryFlowHelper(saved, ""), /继续完善/u);
});

test("capability card stays hidden for premature, inferred or legacy summaries", () => {
  assert.equal(shouldShowCapabilityArtifact(artifact()), false);
  assert.equal(shouldShowCapabilityArtifact(artifact(flow())), false);
  assert.equal(shouldShowCapabilityArtifact(artifact(flow({ fields: {
    role: { value: "开发者", status: "provided", evidence: [] },
    actions: { value: "搭建系统", status: "inferred", evidence: [] },
  } }))), false);
  assert.equal(shouldShowCapabilityArtifact(artifact(flow({ fields: {
    role: { value: "开发者", status: "provided", evidence: [] },
    actions: { value: "搭建系统", status: "provided", evidence: [] },
  } }))), true);
  assert.equal(shouldShowCapabilityArtifact(artifact(flow({ status: "ready" }))), true);
  assert.equal(shouldShowCapabilityArtifact({ ...artifact(flow({ status: "ready" })), capabilityIdentity: " " }), false);
});

test("existing helper communicates the available command for each phase", () => {
  assert.equal(discoveryFlowHelper(undefined, "原有附件说明"), "原有附件说明");
  assert.match(discoveryFlowHelper(flow(), ""), /暂时跳过/u);
  assert.match(discoveryFlowHelper(flow(), ""), /先生成草稿/u);
  assert.match(discoveryFlowHelper(flow({ status: "ready" }), ""), /确认保存当前版本/u);
});

test("review preserves source quotes and differentiates user facts, suggestions and skipped gaps", () => {
  const reviewed = flow({ fields: {
    role: { value: "只负责整理评测集", status: "provided", evidence: [{ sourceId: "user:1", quote: "我只负责整理评测集，未负责上线" }] },
    direction: { value: "AI 评测协作", status: "inferred", evidence: [] },
    preferences: { value: "暂时不确定", status: "skipped", evidence: [{ sourceId: "user:2", quote: "暂时不确定" }] },
    unknown: { value: "无关字段", status: "provided", evidence: [] },
  }, missingFields: ["outcome", "evidence", "unknown"] });
  const fields = discoveryReviewFields("capability", reviewed);
  assert.deepEqual(fields.map((field) => field.key), ["role", "direction", "preferences"]);
  assert.deepEqual(fields.map((field) => field.statusLabel), ["来自你的描述", "建议 · 待确认", "稍后补充"]);
  assert.equal(fields[0].evidence[0].quote, "我只负责整理评测集，未负责上线");
  assert.deepEqual(discoveryMissingLabels("capability", reviewed), ["实际结果", "可提供的依据"]);
});

test("both discovery entries offer editable clearly marked AI and overseas examples", () => {
  for (const kind of ["problem", "capability"] as const) {
    assert.equal(discoveryExamples[kind].length, 3);
    assert.equal(new Set(discoveryExamples[kind].map((example) => example.label)).size, 3);
    assert.ok(discoveryExamples[kind].some((example) => example.label.includes("出海")));
    for (const example of discoveryExamples[kind]) {
      assert.match(example.prompt, /^【示例输入，请替换为真实情况】/u);
      assert.ok(example.prompt.length > 100 && example.prompt.length < 12000);
    }
  }
});

test("latest exact generated draft is shown once while acknowledgement, status, source notice and next step remain", () => {
  const current: ProblemBriefArtifact = {
    kind: "problem_brief", diagnosis: "资料分散", action: "搭建知识库", profile: "知识库协作", evidence: [],
    flow: flow({ status: "ready", stage: "review", missingFields: [], nextQuestion: "", fields: {
      context: { value: "资料分散", status: "provided", evidence: [] },
      work: { value: "搭建带来源引用的知识库", status: "provided", evidence: [] },
      outcome: { value: "让客服查到资料出处", status: "provided", evidence: [] },
      collaboration: { value: "阶段项目", status: "inferred", evidence: [] },
      constraints: { value: "暂时不确定", status: "skipped", evidence: [] },
    } }),
  };
  const serverAnswer = "已记录你希望解决的资料查找问题。\n\n用人需求说明 · 草稿\n工作背景：资料分散\n主要工作：搭建带来源引用的知识库\n预期结果：让客服查到资料出处\n合作方式：阶段项目（AI 建议，待确认）\n时间与合作条件：待补充\n必要能力与加分经验：待补充\n面谈核实重点：待补充\n依据来自本人陈述或所附材料，未经平台核验。\n\n如需调整，直接告诉我要改哪里；确认无误后，请回复“确认保存当前版本”。";
  const shown = discoveryAnswerForDisplay(serverAnswer, current);
  assert.equal(shown, "已记录你希望解决的资料查找问题。\n\n用人需求说明 · 草稿\n依据来自本人陈述或所附材料，未经平台核验。\n\n如需调整，直接告诉我要改哪里；确认无误后，请回复“确认保存当前版本”。");
  assert.match(serverAnswer, /主要工作：搭建带来源引用的知识库/u);
  assert.equal(discoveryAnswerForDisplay(serverAnswer, null), serverAnswer);
  assert.equal(discoveryAnswerForDisplay(serverAnswer, { ...current, flow: undefined }), serverAnswer);
  assert.equal(discoveryAnswerForDisplay(serverAnswer, { ...current, flow: flow({ fields: {} }) }), serverAnswer);
  const quotedInline = serverAnswer.replace("已记录你希望解决的资料查找问题。\n\n", "这段原文引用如下：");
  assert.equal(discoveryAnswerForDisplay(quotedInline, current), quotedInline);
  const changed = { ...current, flow: { ...current.flow!, fields: { ...current.flow!.fields, work: { value: "更新后的工作", status: "provided" as const, evidence: [] } } } };
  assert.equal(discoveryAnswerForDisplay(serverAnswer, changed), serverAnswer);
  assert.equal(discoveryAnswerForDisplay("你问如何使用能力档案 · 草稿。可以按实际经历修改，依据仍来自本人陈述。", current), "你问如何使用能力档案 · 草稿。可以按实际经历修改，依据仍来自本人陈述。");
});

test("capability display keeps confirmation and safely falls back when server draft format differs", () => {
  const current = artifact(flow({ status: "confirmed", stage: "confirmed", confirmedAt: "2026-09-07T00:00:00Z", missingFields: [], nextQuestion: "", fields: {
    role: { value: "只负责评测", status: "provided", evidence: [] },
    actions: { value: "整理问题\n记录错答", status: "provided", evidence: [] },
  } }));
  const reply = "已保存当前用户确认版本。\n\n能力档案 · 用户已确认\n经历背景：待补充\n个人职责：只负责评测\n具体行动：整理问题\n记录错答\n实际结果：待补充\n可提供的依据：待补充\n适合承担的工作：待补充\n合作偏好：待补充\n依据来自本人陈述或所附材料，未经平台核验。";
  assert.equal(discoveryAnswerForDisplay(reply, current), "已保存当前用户确认版本。\n\n能力档案 · 用户已确认\n依据来自本人陈述或所附材料，未经平台核验。");
  const ordinaryQuote = reply.replace("已保存当前用户确认版本。\n\n", "这里引用一段文字：");
  assert.equal(discoveryAnswerForDisplay(ordinaryQuote, current), ordinaryQuote);
  const changedFormat = reply.replace("合作偏好：待补充", "合作偏好（尚未填写）");
  assert.equal(discoveryAnswerForDisplay(changedFormat, current), changedFormat);
});

test("short historical structured drafts fold while ordinary brief advice remains open", () => {
  const capability = "已整理。\n\n能力档案 · 草稿\n经历背景：资料分散\n个人职责：只负责评测\n具体行动：整理问题\n实际结果：尚无线上数据\n依据来自本人陈述或所附材料，未经平台核验。";
  assert.ok(capability.length < 400);
  assert.equal(shouldFoldDiscoveryHistory(capability), true);
  assert.equal(shouldFoldDiscoveryHistory("用人需求说明 · 草稿\n工作背景：资料分散\n主要工作：整理资料"), true);
  assert.equal(shouldFoldDiscoveryHistory("需求简报 · 草稿\n工作背景：资料分散\n主要工作：整理资料"), true);
  assert.equal(shouldFoldDiscoveryHistory(capability.replace("· 草稿", "· 用户已确认")), true);
  assert.equal(shouldFoldDiscoveryHistory("“能力档案 · 草稿”只是待确认版本，你可以直接补充个人职责或实际结果。"), false);
  assert.equal(shouldFoldDiscoveryHistory("能力档案 · 草稿\n请说说你的具体行动。"), false);
  assert.equal(shouldFoldDiscoveryHistory("你本人具体负责哪一部分？"), false);
});

test("composer recovery is account-key isolated, bounded and preserves retry identity/version", () => {
  const storage = memoryStorage();
  const draft: DiscoveryComposerDraft = {
    prompt: "确认保存当前版本",
    startsFresh: false,
    attachmentCount: 0,
    pending: { requestId: "retry-1", threadId: "thread-1", version: 3 },
  };
  writeDiscoveryComposerDraft(storage, "account-a", draft, 1000);
  assert.deepEqual(readDiscoveryComposerDraft(storage, "account-a", 2000), draft);
  assert.equal(readDiscoveryComposerDraft(storage, "account-b", 2000), null);
  assert.equal(readDiscoveryComposerDraft(storage, "account-a", 3_601_000), null);
  assert.equal(storage.getItem("account-a"), null);
});

test("composer does not keep completed text and tolerates unavailable browser storage", () => {
  const storage = memoryStorage();
  storage.setItem("draft", "not json");
  assert.equal(readDiscoveryComposerDraft(storage, "draft"), null);
  writeDiscoveryComposerDraft(storage, "draft", { prompt: "", startsFresh: false, attachmentCount: 0, pending: null });
  assert.equal(storage.getItem("draft"), null);
  const blocked = {
    getItem: () => { throw new Error("storage denied"); },
    setItem: () => { throw new Error("storage denied"); },
    removeItem: () => { throw new Error("storage denied"); },
  };
  assert.equal(readDiscoveryComposerDraft(blocked, "draft"), null);
  assert.doesNotThrow(() => writeDiscoveryComposerDraft(blocked, "draft", { prompt: "未发送内容", startsFresh: false, attachmentCount: 0, pending: null }));
});
