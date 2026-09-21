import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { QwenDiscoveryAdvisor } from "./discoveryAdvisor.js";
import type { FlowArtifact, FlowSource } from "./discoveryFlow.js";
import { loadLocalEnvironment } from "./localEnvironment.js";

// Explicit, paid-provider smoke test. Synthetic fixtures only; no DB or user data access.
async function main() {
  if (process.env.RUN_QWEN_SMOKE !== "true") throw new Error("Set RUN_QWEN_SMOKE=true to authorize four real Qwen requests with synthetic fixtures.");
  loadLocalEnvironment();
  const apiKey = process.env.QWEN_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) throw new Error("Configure QWEN_API_KEY or DASHSCOPE_API_KEY in the server environment first. No request was sent.");
  const advisor = new QwenDiscoveryAdvisor({ apiKey, model: process.env.QWEN_MODEL, baseUrl: process.env.QWEN_BASE_URL });
  for (const kind of ["problem", "capability"] as const) {
    let previousArtifact: FlowArtifact | undefined;
    const sources: FlowSource[] = [];
    let count = 0;
    const send = async (message: string) => {
      const requestId = randomUUID();
      sources.push({ id: `user:${requestId}`, text: message, kind: "user" });
      const reply = await advisor.advise({ kind, message, requestId, sources, previousArtifact, priorTurnCount: count++ });
      previousArtifact = reply.artifact;
      assert.equal(reply.provider, "qwen", "Smoke test must never use local fallback.");
      return reply;
    };
    const initial = kind === "problem"
      ? "工作背景：员工反复询问已批准的公司制度。主要工作：整理常见问题并建立自助查询资料。预期结果：员工能自行找到准确的制度答案。合作方式：短期项目。时间与合作条件：远程，预算尚未决定。必要能力：资料整理与流程梳理。面谈核实：请对方说明一次实际资料整理项目。"
      : "经历背景：课程小组资料分散，成员查找困难。个人职责：我不是组长，只负责资料整理。具体行动：我归纳问题并给文档统一分类。实际结果：同学反馈更容易找到材料，没有统计数据。可提供的依据：脱敏课程作品说明。希望承担的工作：资料整理。合作偏好：远程阶段合作。";
    const collected = await send(initial);
    assert.notEqual(collected.artifact.flow?.status, "confirmed", "First response cannot confirm a draft.");
    assert.equal(collected.artifact.flow?.missingFields.length, 0, `${kind}: Qwen failed to extract the supplied required facts.`);
    const draft = await send("先生成草稿");
    assert.equal(draft.artifact.flow?.status, "ready", `${kind}: supplied facts must produce a reviewable draft.`);
    const confirmed = await send("确认保存当前版本");
    assert.equal(confirmed.artifact.flow?.status, "confirmed", `${kind}: explicit confirmation failed.`);
    const edited = await send(kind === "problem" ? "修改主要工作：只整理现有制度，不建设查询系统。其他条件不变。" : "修改具体行动：我只统一了文档分类，没有归纳问题。其他内容不变。");
    assert.equal(edited.artifact.flow?.status, "ready", `${kind}: a correction must revoke confirmation.`);
    assert.equal(edited.artifact.flow?.confirmedAt, null, `${kind}: correction retained an obsolete confirmation.`);
    process.stdout.write(`${kind}: Qwen extraction, draft, confirmation and correction passed.\n`);
  }
  process.stdout.write("Synthetic Qwen smoke checks passed; this does not constitute production or human evidence verification.\n");
}

void main().catch((error: unknown) => {
  // Only application-authored validation messages are emitted; provider bodies are never logged.
  const knownMessage = error instanceof Error && /^(?:Set RUN_QWEN_SMOKE|Configure QWEN_API_KEY|Qwen provider |AI provider returned|problem:|capability:)/u.test(error.message);
  process.stderr.write(`${knownMessage && error instanceof Error ? error.message : "Qwen smoke validation failed. Check server configuration and the synthetic flow assertions; no private response is logged."}\n`);
  process.exitCode = 1;
});
