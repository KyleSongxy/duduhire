import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalDiscoveryAdvisor,
  OpenAiDiscoveryAdvisor,
  QwenDiscoveryAdvisor,
  createDiscoveryAdvisor,
} from "../src/discoveryAdvisor.js";
import { loadConfig, OFFICIAL_OPENAI_BASE_URL } from "../src/config.js";
import { decryptContactValue, encryptContactValue } from "../src/privacy.js";

const productionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://runtime:secret@database.example.com/duduhire",
  DATABASE_SSL: "true",
  WEB_ORIGIN: "https://duduhire.example.com",
  AUTH_TOKEN_SECRET: "production-auth-secret-with-more-than-thirty-two-characters",
  EMAIL_DELIVERY_MODE: "smtp",
  SMTP_URL: "smtps://mailer:secret@smtp.example.com:465",
  EMAIL_FROM: "DuduHire <no-reply@example.com>",
  AI_MODE: "openai",
  OPENAI_API_KEY: "sk-production-test",
  OPENAI_MODEL: "gpt-test",
  OPENAI_BASE_URL: OFFICIAL_OPENAI_BASE_URL,
  CONTACT_DATA_KEY: "0123456789abcdef".repeat(4),
  CONTACT_DATA_KEY_ID: "contact-test-v1",
};

test("production allows real Qwen or explicit OpenAI and requires an encryption key", () => {
  assert.throws(() => loadConfig({
    ...productionEnvironment,
    AUTH_TOKEN_SECRET: "changeme-changeme-changeme-changeme",
  }), /non-placeholder random secret/u);
  assert.throws(() => loadConfig({ ...productionEnvironment, AI_MODE: "local" }), /AI_MODE must be qwen or openai/u);
  assert.throws(() => loadConfig({ ...productionEnvironment, OPENAI_MODEL: "" }), /OPENAI_MODEL/u);
  assert.throws(() => loadConfig({ ...productionEnvironment, OPENAI_BASE_URL: "https://proxy.example.com/v1" }), /api\.openai\.com/u);
  assert.throws(() => loadConfig({ ...productionEnvironment, CONTACT_DATA_KEY: "short" }), /64 hexadecimal/u);
  assert.throws(() => loadConfig({ ...productionEnvironment, CONTACT_DATA_KEY: "a".repeat(64) }), /non-placeholder random key/u);
  assert.equal(loadConfig(productionEnvironment).aiMode, "openai");
  const qwen = loadConfig({ ...productionEnvironment, AI_MODE: "qwen", QWEN_API_KEY: "sk-qwen-test" });
  assert.equal(qwen.aiMode, "qwen");
  assert.equal(qwen.qwenModel, "qwen3.8-max");
  assert.ok(createDiscoveryAdvisor(qwen) instanceof QwenDiscoveryAdvisor);
});

test("local discovery advisor explicitly rehearses the stateful flow without invented expertise", async () => {
  const advisor = new LocalDiscoveryAdvisor();
  const problem = await advisor.advise({
    kind: "problem",
    message: "销售线索已经进入 CRM，但团队没有及时跟进。",
  });
  assert.equal(problem.provider, "local");
  assert.equal(problem.artifact.kind, "problem_brief");
  assert.equal(problem.artifact.flow?.status, "collecting");
  assert.equal(problem.artifact.flow?.fields.context?.value, "销售线索已经进入 CRM，但团队没有及时跟进。");

  const capability = await advisor.advise({
    kind: "capability",
    message: "我负责过数据指标和自动报表。",
  });
  assert.equal(capability.artifact.kind, "capability_identity");
  assert.equal(capability.artifact.flow?.status, "collecting");
  assert.equal(capability.artifact.flow?.fields.situation?.value, "我负责过数据指标和自动报表。");
});

test("OpenAI discovery uses the official Responses endpoint without storage and validates output", async () => {
  let capturedUrl = "";
  let capturedRequest: Record<string, unknown> | undefined;
  const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      status: "completed",
      model: "gpt-test",
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            acknowledgement: "先从这个项目开始梳理。",
            updates: [{ field: "situation", value: "参与过一个项目", status: "provided", evidence: [{ sourceId: "user:current", quote: "我负责过一个项目。" }] }],
            nextQuestion: "你本人具体负责哪一部分？",
            summary: { title: "", value: "" },
          }),
        }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const advisor = new OpenAiDiscoveryAdvisor({
    apiKey: "sk-test",
    model: "gpt-test",
    fetchImplementation,
  });
  const advice = await advisor.advise({ kind: "capability", message: "我负责过一个项目。" });

  assert.equal(capturedUrl, `${OFFICIAL_OPENAI_BASE_URL}/responses`);
  assert.equal(capturedRequest?.store, false);
  assert.deepEqual((capturedRequest?.text as { format: { type: string } }).format.type, "json_object");
  assert.equal(advice.provider, "openai");
  assert.equal(advice.artifact.kind, "capability_identity");
  assert.equal(advice.artifact.flow?.status, "collecting");
});

test("OpenAI discovery rejects output that does not exactly match the artifact schema", async () => {
  const fetchImplementation: typeof globalThis.fetch = async () => new Response(JSON.stringify({
    status: "completed",
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({ answer: "看似有效", artifact: { kind: "problem_brief" }, unexpected: true }),
      }],
    }],
  }), { status: 200 });
  const advisor = new OpenAiDiscoveryAdvisor({ apiKey: "sk-test", model: "gpt-test", fetchImplementation });
  await assert.rejects(
    advisor.advise({ kind: "problem", message: "需要梳理业务问题" }),
    /unexpected response shape/u,
  );
});

test("contact encryption uses authenticated randomized envelopes", () => {
  const key = "ab".repeat(32);
  const context = { scope: "profile" as const, recordId: "user-1", keyId: "contact-v2" };
  const first = encryptContactValue("13800000000", key, context);
  const second = encryptContactValue("13800000000", key, context);
  assert.notEqual(first, second);
  assert.match(first, /^v2\./u);
  assert.equal(decryptContactValue(first, key, context), "13800000000");
  assert.throws(
    () => decryptContactValue(first, key, { ...context, recordId: "user-2" }),
    /authenticated/u,
  );

  const legacyEnvelope = "v1.AQEBAQEBAQEBAQEB.1kvXVcJ79tjppCwjPOQnEQ.QZDWQSq79cGh0wlZ1aw";
  assert.equal(decryptContactValue(legacyEnvelope, key, context), "legacy-contact");

  const parts = first.split(".");
  const tag = parts[2]!;
  parts[2] = `${tag.startsWith("A") ? "B" : "A"}${tag.slice(1)}`;
  assert.throws(() => decryptContactValue(parts.join("."), key, context), /authenticated/u);
});
