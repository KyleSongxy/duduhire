import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_QWEN_BASE_URL, loadConfig, readQwenBaseUrl } from "../src/config.js";
import { QwenClient, QwenProviderError } from "../src/qwenClient.js";
import { QwenDiscoveryAdvisor } from "../src/discoveryAdvisor.js";

const testEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused/test",
  AUTH_TOKEN_SECRET: "a-test-secret-with-more-than-thirty-two-characters",
};
const completionInput = { system: "返回 JSON", user: "仅合成测试，不含真实用户资料" };
const validReply = {
  acknowledgement: "先了解这项工作的背景。",
  updates: [{ field: "context", value: "重复答疑占用 HR 时间", status: "provided", evidence: [{ sourceId: "user:test-1", quote: "重复答疑占用 HR 时间" }] }],
  nextQuestion: "你希望这个人具体承担哪些工作？",
  summary: { title: "", value: "" },
};
const payload = (content: unknown = JSON.stringify(validReply), finishReason = "stop") => ({
  model: "qwen3.8-max",
  choices: [{ finish_reason: finishReason, message: { role: "assistant", content } }],
});
const makeClient = (fetchImplementation: typeof globalThis.fetch, options: { timeoutMs?: number } = {}) => new QwenClient({ apiKey: "sk-test-only", fetchImplementation, ...options });

test("Qwen is the default and never falls back when credentials are missing", () => {
  assert.throws(() => loadConfig(testEnvironment), /QWEN_API_KEY or DASHSCOPE_API_KEY is required/u);
  const configured = loadConfig({ ...testEnvironment, DASHSCOPE_API_KEY: "sk-dashscope-test" });
  assert.equal(configured.aiMode, "qwen");
  assert.equal(configured.qwenApiKey, "sk-dashscope-test");
  assert.equal(configured.qwenModel, "qwen3.8-max");
  assert.equal(configured.qwenBaseUrl, DEFAULT_QWEN_BASE_URL);
  assert.equal(loadConfig({ ...testEnvironment, QWEN_API_KEY: "sk-preferred", DASHSCOPE_API_KEY: "sk-second" }).qwenApiKey, "sk-preferred");
  assert.equal(loadConfig({ ...testEnvironment, AI_MODE: "local" }).aiMode, "local");
  assert.throws(() => loadConfig({ ...testEnvironment, QWEN_API_KEY: "replace-with-secret" }), /placeholder/u);
  assert.throws(() => loadConfig({ ...testEnvironment, QWEN_API_KEY: "sk white space" }), /whitespace/u);
  assert.throws(() => loadConfig({ ...testEnvironment, QWEN_API_KEY: "sk-test", QWEN_MODEL: "../escape" }), /QWEN_MODEL/u);
});

test("Qwen only accepts documented official regional HTTPS base URLs", () => {
  const urls = [
    DEFAULT_QWEN_BASE_URL,
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    ...["cn-beijing", "ap-southeast-1", "us-east-1", "eu-central-1", "ap-northeast-1"].map((region) => `https://workspace-123.${region}.maas.aliyuncs.com/compatible-mode/v1`),
  ];
  for (const url of urls) assert.equal(readQwenBaseUrl(`${url}/`), url);
  for (const url of [
    "http://dashscope.aliyuncs.com/compatible-mode/v1",
    "https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1",
    "https://dashscope.aliyuncs.com@evil.example/compatible-mode/v1",
    "https://user:password@dashscope.aliyuncs.com/compatible-mode/v1",
    "https://dashscope.aliyuncs.com:8443/compatible-mode/v1",
    "https://dashscope.aliyuncs.com/compatible-mode/v1?secret=hidden",
    "https://dashscope.aliyuncs.com/compatible-mode/v1#fragment",
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    "https://workspace.unknown-region.maas.aliyuncs.com/compatible-mode/v1",
    "https://one.two.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "https://127.0.0.1/compatible-mode/v1",
  ]) assert.throws(() => readQwenBaseUrl(url), /QWEN_BASE_URL/u);
});

test("Qwen sends server-side Chat Completions with JSON mode and thinking disabled", async () => {
  let capturedUrl = "";
  let request: RequestInit | undefined;
  const client = makeClient(async (url, init) => {
    capturedUrl = String(url);
    request = init;
    return new Response(JSON.stringify(payload()), { status: 200 });
  });
  const result = await client.complete(completionInput);
  assert.equal(capturedUrl, `${DEFAULT_QWEN_BASE_URL}/chat/completions`);
  assert.equal(request?.redirect, "error");
  assert.equal(new Headers(request?.headers).get("authorization"), "Bearer sk-test-only");
  const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.enable_thinking, false);
  assert.equal(body.stream, false);
  assert.equal(body.model, "qwen3.8-max");
  assert.equal(result.text, JSON.stringify(validReply));
  assert.equal(result.model, "qwen3.8-max");
});

test("Qwen advisor passes model extraction into the shared flow with source validation", async () => {
  let calls = 0;
  const advisor = new QwenDiscoveryAdvisor({ apiKey: "sk-test-only", fetchImplementation: async () => {
    calls++;
    return new Response(JSON.stringify(payload()), { status: 200 });
  } });
  const result = await advisor.advise({ kind: "problem", message: "重复答疑占用 HR 时间", requestId: "test-1" });
  assert.equal(calls, 1);
  assert.equal(result.provider, "qwen");
  assert.equal(result.promptVersion, "duduhire.discovery.v2.1");
  assert.equal(result.artifact.flow?.fields.context?.value, "重复答疑占用 HR 时间");
  assert.equal(result.artifact.flow?.status, "collecting");
  await assert.rejects(advisor.advise({ kind: "problem", message: "不同的输入", requestId: "test-1" }), /unsupported evidence/u);
});

test("Qwen errors expose only safe categories and never fall back or leak provider content", async () => {
  for (const [status, code] of [[401, "authentication"], [403, "authentication"], [429, "rate_limit"], [500, "unavailable"], [302, "unavailable"]] as const) {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return new Response('{"error":"sk-private-secret user-private-content"}', { status });
    });
    await assert.rejects(client.complete(completionInput), (error: unknown) => {
      assert.ok(error instanceof QwenProviderError);
      assert.equal(error.code, code);
      assert.doesNotMatch(String(error), /private/u);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(makeClient(async () => { throw new Error("sk-private-secret"); }).complete(completionInput), (error: unknown) => {
    assert.ok(error instanceof QwenProviderError);
    assert.equal(error.code, "unavailable");
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("Qwen rejects truncation, refusals, tools, missing or malformed responses", async () => {
  for (const body of [
    payload("{}", "length"), payload("{}", "content_filter"), payload(null),
    { choices: [] },
    { choices: [...payload().choices, ...payload().choices] },
    { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}", refusal: "No" } }] },
    { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}", tool_calls: [{}] } }] },
    { choices: [{ finish_reason: "stop", message: { role: "user", content: "{}" } }] },
  ]) {
    await assert.rejects(makeClient(async () => new Response(JSON.stringify(body))).complete(completionInput), (error: unknown) => error instanceof QwenProviderError && error.code === "invalid_output");
  }
  await assert.rejects(makeClient(async () => new Response("not json")).complete(completionInput), /invalid_output/u);
});

test("Qwen applies a byte limit even when content-length is absent or misleading", async () => {
  for (const headers of [{}, { "content-length": "1" }, { "content-length": "999999" }]) {
    await assert.rejects(makeClient(async () => new Response("中".repeat(100_000), { headers })).complete(completionInput), /invalid_output/u);
  }
});

test("Qwen aborts stalled requests and does not expose transport error details", async () => {
  const client = makeClient((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("sensitive transport detail")), { once: true });
  }), { timeoutMs: 5 });
  await assert.rejects(client.complete(completionInput), (error: unknown) => {
    assert.ok(error instanceof QwenProviderError);
    assert.equal(error.code, "timeout");
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.throws(() => makeClient(globalThis.fetch, { timeoutMs: 0 }), /positive integer/u);
});

test("Qwen timeout covers reading the response body after headers arrive", async () => {
  const client = makeClient(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choices":'));
      init?.signal?.addEventListener("abort", () => controller.error(new Error("private body detail")), { once: true });
    },
  })), { timeoutMs: 5 });
  await assert.rejects(client.complete(completionInput), (error: unknown) => error instanceof QwenProviderError && error.code === "timeout" && error.cause === undefined);
});
