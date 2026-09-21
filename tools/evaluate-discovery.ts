import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { LocalDiscoveryAdvisor, QwenDiscoveryAdvisor } from "../apps/api/src/discoveryAdvisor.js";
import type { FlowArtifact, FlowSource } from "../apps/api/src/discoveryFlow.js";
import { loadLocalEnvironment } from "../apps/api/src/localEnvironment.js";

// Synthetic cases only. This CLI never reads accounts, conversations or a database.
// RUN_QWEN_EVAL=true explicitly enables paid requests; default is offline.
const cases = [
  { id: "ai-rag-demand", kind: "problem", text: "我们公司客服每天重复回答产品问题，已有产品手册但查找困难。想找人整理知识库，搭建带原文引用的 RAG 智能问答，并建立模型评估集。希望客服能找到准确答案，不能回答时转人工。按项目远程合作，预算 3万到5万元人民币，六周完成。", expected: { context: /客服|产品/u, work: /知识库|RAG/u, outcome: /准确|人工/u } },
  { id: "ai-agent-demand", kind: "problem", text: "我们是小型外贸团队，每天在邮件和 CRM 间手工录入询盘。需要一位开发者用 n8n 和 Agent 接好邮件分类、CRM 写入和人工审批，先别自动给客户发信。验收看询盘能否正确入库、失败能否重试。远程项目合作，预算还没定。", expected: { context: /询盘|外贸/u, work: /CRM|n8n|Agent/u, outcome: /入库|重试/u } },
  { id: "global-b2b-demand", kind: "problem", text: "我们做工业传感器，准备开拓德国市场，暂时没有海外客户线索。需要有人做市场调研、梳理目标客户画像，通过 LinkedIn 开发 B2B 线索并把过程记录在 CRM。前两个月先验收有效客户名单和意向访谈，不保证成交额。希望英文商务沟通，德语是加分项，远程兼职。", expected: { context: /传感器|德国/u, work: /LinkedIn|B2B|调研/u, outcome: /名单|访谈/u } },
  { id: "global-content-demand", kind: "problem", text: "我们的 Shopify 独立站要面向美国消费者，英文产品页现在像机器翻译。想找英语内容本地化人员重写产品页、做 SEO 关键词研究并配合设计整理文案。希望交付可审核的英文页面和关键词清单，先不投 Google Ads。可以远程按项目合作。", expected: { context: /Shopify|美国/u, work: /本地化|SEO/u, outcome: /页面|清单/u } },
  { id: "ai-rag-capability", kind: "capability", text: "上个项目是给 SaaS 客服做知识库问答。我是后端开发，负责 RAG 检索与模型评估，前端由同事负责。我清洗产品文档，做向量检索和重排，写了 80 条评估问题，并为答案加上引用。试用时客服反馈查资料更方便，没有统计准确率。可以提供脱敏评估报告，希望接远程 AI 项目。", expected: { situation: /客服|SaaS/u, role: /后端|检索/u, actions: /向量|评估|引用/u, outcome: /方便|反馈/u } },
  { id: "ai-agent-capability", kind: "capability", text: "之前销售团队手工汇总表单很慢。我担任自动化开发，独立负责 n8n 工作流和 CRM 接口。我接入表单，增加去重、人工审批和失败重试。最后销售同事可以直接在 CRM 看到待跟进记录，不用重复录入。我没有训练大模型，可以提供脱敏流程图，每周可投入20小时，远程兼职。", expected: { situation: /销售|表单/u, role: /自动化|工作流/u, actions: /去重|审批|重试/u, outcome: /重复录入|CRM/u } },
  { id: "global-b2b-capability", kind: "capability", text: "之前在工业设备团队做德国市场拓展，我负责市场调研和 B2B 客户开发，不负责签约。我分析竞争产品、整理客户画像，用 LinkedIn 筛选潜在线索并记录到 CRM。最终整理出 120 家目标客户名单，销售团队完成了后续访谈，成交额不能算我的成果。可以提供脱敏调研表，能用英语商务沟通，希望远程兼职。", expected: { situation: /工业|德国/u, role: /调研|开发/u, actions: /LinkedIn|画像/u, outcome: /120|名单/u } },
  { id: "global-content-capability", kind: "capability", text: "我为一个面向美国的 Shopify 品牌做过英文内容本地化。我负责 SEO 关键词研究和产品页文案，没有负责广告投放。我分析搜索意图，重写产品页并与设计师校对术语。结果是交付了 12 个审核通过的英文页面，尚未获得流量统计。可以提供脱敏前后对照稿，接受远程项目。", expected: { situation: /美国|Shopify/u, role: /SEO|文案/u, actions: /搜索|重写|术语/u, outcome: /12|页面/u } },
] as const;

async function main() {
  const real = process.env.RUN_QWEN_EVAL === "true";
  if (real) loadLocalEnvironment();
  const apiKey = process.env.QWEN_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim();
  if (real && !apiKey) throw new Error("Qwen configuration missing; no provider requests sent.");
  const advisor = real
    ? new QwenDiscoveryAdvisor({ apiKey: apiKey!, model: process.env.QWEN_MODEL, baseUrl: process.env.QWEN_BASE_URL })
    : new LocalDiscoveryAdvisor();
  const results: Array<Record<string, unknown>> = [];
  for (const item of cases) {
    const started = Date.now();
    const sources: FlowSource[] = [];
    let previousArtifact: FlowArtifact | undefined;
    let providerCalls = 0;
    const send = async (message: string) => {
      const requestId = randomUUID();
      sources.push({ id: `user:${requestId}`, text: message, kind: "user" });
      const reply = await advisor.advise({ kind: item.kind, message, requestId, sources, previousArtifact });
      previousArtifact = reply.artifact;
      if (!/^(?:先生成草稿|确认保存当前版本)$/u.test(message)) providerCalls++;
      return reply;
    };
    try {
      const reply = await send(item.text);
      const flow = reply.artifact.flow;
      const checks: Record<string, boolean> = {
        provider: reply.provider === (real ? "qwen" : "local"),
        readyInOneTurn: flow?.status === "ready",
        requiredComplete: flow?.missingFields.length === 0,
        explicitConfirmationOnly: flow?.confirmedAt === null,
        relevantFacts: Object.entries(item.expected).every(([key, pattern]) => pattern.test(flow?.fields[key]?.value ?? "")),
        sourceIntegrity: Object.values(flow?.fields ?? {}).every((field) => field.status !== "provided" || (field.evidence.length > 0 && field.evidence.every((ref) => sources.some((s) => s.id === ref.sourceId && s.text.includes(ref.quote))))),
        noInventedTools: ["Gmail", "Outlook", "Slack", "Salesforce", "HubSpot", "Zapier"].every((tool) => item.text.includes(tool)
          || !Object.values(flow?.fields ?? {}).filter((field) => field.status === "provided").some((field) => field.value.includes(tool))),
      };
      const confirmed = await send("确认保存当前版本");
      checks.confirmation = confirmed.artifact.flow?.status === "confirmed";
      const correction = item.kind === "problem"
        ? "修改合作方式：改为远程项目合作，其他内容不变。"
        : "修改合作偏好：只接远程项目，不接受全职，其他内容不变。";
      const edited = await send(correction);
      checks.correctionRevokesConfirmation = edited.artifact.flow?.status === "ready" && edited.artifact.flow.confirmedAt === null;
      const correctionField = edited.artifact.flow?.fields[item.kind === "problem" ? "collaboration" : "preferences"];
      checks.latestEvidence = Boolean(correctionField?.evidence.some((ref) => ref.sourceId === sources.at(-1)?.id));
      const passed = Object.values(checks).every(Boolean);
      results.push({ id: item.id, passed, checks, elapsedMs: Date.now() - started, providerCalls, initial: reply, corrected: edited });
      process.stdout.write(`${passed ? "PASS" : "FAIL"} ${item.id} ${Date.now() - started}ms ${Object.entries(checks).filter(([,ok]) => !ok).map(([key]) => key).join(",")}\n`);
    } catch (error) {
      // Only application-authored error categories may be emitted, never provider bodies.
      const category = error instanceof Error && /^(?:AI provider returned|Invalid discovery flow input)/u.test(error.message)
        ? error.message : "provider_or_validation_failure";
      results.push({ id: item.id, passed: false, error: category, elapsedMs: Date.now() - started });
      process.stdout.write(`FAIL ${item.id} ${category}\n`);
    }
  }
  const report = {
    generatedAt: new Date().toISOString(), provider: real ? "qwen" : "local", syntheticOnly: true,
    note: "Fixed synthetic acceptance cases; this is not a population accuracy estimate or independent verification of professional experience.",
    passed: results.filter((result) => result.passed).length, total: cases.length, results,
  };
  const output = resolve(process.env.DISCOVERY_EVAL_OUTPUT || `tools/.generated/discovery-eval-${real ? "qwen" : "local"}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(`${report.passed}/${report.total} synthetic scenarios passed; report: ${output}\n`);
  if (report.passed !== report.total) process.exitCode = 1;
}

void main().catch(() => { process.stderr.write("Discovery evaluation could not start. Check server-side provider configuration.\n"); process.exitCode = 1; });
