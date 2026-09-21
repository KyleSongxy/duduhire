import assert from "node:assert/strict";
import PnvsSdk, { CheckSmsVerifyCodeRequest, SendSmsVerifyCodeRequest } from "@alicloud/dypnsapi20170525";
import type { $OpenApiUtil } from "@alicloud/openapi-core";
import type { RuntimeOptions } from "@darabonba/typescript";
import test from "node:test";
import {
  createAliyunPnvsProvider, PhoneVerificationProviderError, PNVS_ENDPOINT,
  type AliyunPnvsProviderOptions, type PnvsApiClient,
} from "../src/pnvsProvider.js";

const options: AliyunPnvsProviderOptions = { accessKeyId: "SyntheticPnvsAccessKey", accessKeySecret: "SyntheticPnvsSecret" };
const input = { phone: "+8613800000000", requestId: "synthetic-challenge-001", expiresInSeconds: 300 };
const code = "012345";

function success(model: Record<string, unknown> = {}) {
  return { statusCode: 200, body: { code: "OK", success: true, model: { outId: input.requestId, ...model } } };
}

function fixture(overrides: Partial<AliyunPnvsProviderOptions> = {}) {
  const sendCalls: { request: SendSmsVerifyCodeRequest; runtime: RuntimeOptions }[] = [];
  const checkCalls: { request: CheckSmsVerifyCodeRequest; runtime: RuntimeOptions }[] = [];
  let config: $OpenApiUtil.Config | undefined;
  let send: () => Promise<unknown> = async () => success({ verifyCode: code });
  let check: () => Promise<unknown> = async () => success({ verifyResult: "PASS" });
  const client: PnvsApiClient = {
    async sendSmsVerifyCodeWithOptions(request, runtime) { sendCalls.push({ request, runtime }); return send(); },
    async checkSmsVerifyCodeWithOptions(request, runtime) { checkCalls.push({ request, runtime }); return check(); },
  };
  const provider = createAliyunPnvsProvider({ ...options, ...overrides }, value => { config = value; return client; });
  return { provider, sendCalls, checkCalls, config: config!, respondSend: (fn: typeof send) => { send = fn; }, respondCheck: (fn: typeof check) => { check = fn; } };
}

function safeError(error: unknown): boolean {
  assert.ok(error instanceof PhoneVerificationProviderError);
  assert.equal(error.message, "Phone verification service is unavailable.");
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(error.stack ?? "", /SyntheticPnvs|13800000000|012345|provider-private/u);
  return true;
}

test("PNVS send uses the documented signature/template, six server-generated digits and exact challenge metadata", async () => {
  const { provider, sendCalls } = fixture();
  assert.deepEqual(await provider.send(input), { code });
  assert.equal(sendCalls.length, 1);
  const request = sendCalls[0]!.request;
  assert.ok(request instanceof SendSmsVerifyCodeRequest);
  assert.equal(request.countryCode, "86");
  assert.equal(request.phoneNumber, "13800000000");
  assert.equal(request.signName, "恒创联众");
  assert.equal(request.templateCode, "100001");
  assert.deepEqual(JSON.parse(request.templateParam!), { code: "##code##", min: "5" });
  assert.equal(request.codeLength, 6);
  assert.equal(request.codeType, 1);
  assert.equal(request.validTime, 300);
  assert.equal(request.interval, 60);
  assert.equal(request.duplicatePolicy, 1);
  assert.equal(request.autoRetry, 0);
  assert.equal(request.returnVerifyCode, true);
  assert.equal(request.outId, input.requestId);
});

test("PNVS preserves exact expiry seconds while rounding up the displayed minutes", async () => {
  const { provider, sendCalls } = fixture();
  for (const expiresInSeconds of [60, 61, 599, 600]) await provider.send({ ...input, expiresInSeconds });
  assert.deepEqual(sendCalls.map(({ request }) => [request.validTime, JSON.parse(request.templateParam!).min]), [
    [60, "1"], [61, "2"], [599, "10"], [600, "10"],
  ]);
});

test("PNVS pins HTTPS and bypasses environment proxies, disables retries and validates TLS", async () => {
  const { config, provider, sendCalls, checkCalls } = fixture();
  assert.equal(config.endpoint, PNVS_ENDPOINT);
  assert.equal(config.protocol, "HTTPS");
  assert.equal(config.method, "POST");
  assert.equal(config.type, "access_key");
  assert.equal(config.accessKeyId, options.accessKeyId);
  assert.equal(config.accessKeySecret, options.accessKeySecret);
  assert.equal(config.noProxy, PNVS_ENDPOINT);
  assert.equal(config.tlsMinVersion, "TLSv1.2");
  assert.equal(config.retryOptions?.retryable, false);
  assert.equal(config.connectTimeout, 8_000);
  assert.equal(config.readTimeout, 8_000);
  assert.equal(config.credential, undefined);
  await provider.send(input);
  await provider.check({ ...input, code });
  for (const { runtime } of [...sendCalls, ...checkCalls]) {
    assert.equal(runtime.autoretry, false);
    assert.equal(runtime.maxAttempts, 1);
    assert.equal(runtime.retryOptions?.retryable, false);
    assert.equal(runtime.noProxy, PNVS_ENDPOINT);
    assert.equal(runtime.ignoreSSL, false);
    assert.equal(runtime.connectTimeout, 8_000);
    assert.equal(runtime.readTimeout, 8_000);
  }
});

test("PNVS check uses the same scheme and OutId and accepts only the explicit PASS result", async () => {
  const { provider, checkCalls, sendCalls, respondCheck } = fixture({ schemeName: "DuduHire-auth-dev" });
  await provider.send(input);
  assert.equal(await provider.check({ ...input, code }), true);
  const request = checkCalls[0]!.request;
  assert.ok(request instanceof CheckSmsVerifyCodeRequest);
  assert.equal(request.phoneNumber, "13800000000");
  assert.equal(request.countryCode, "86");
  assert.equal(request.verifyCode, code);
  assert.equal(request.schemeName, sendCalls[0]!.request.schemeName);
  assert.equal(request.outId, input.requestId);
  for (const verifyResult of ["UNKNOWN", "FAIL", "pass", "", undefined, true, 1]) {
    respondCheck(async () => success({ verifyResult }));
    assert.equal(await provider.check({ ...input, code }), false);
  }
});

test("PNVS rejects incomplete or inconsistent business responses even when the network request succeeded", async () => {
  const { provider, respondSend, respondCheck } = fixture();
  const invalid = [
    undefined, null, [], {}, { statusCode: 200 }, { statusCode: 200, body: null },
    { statusCode: 500, body: success().body }, { statusCode: "200", body: success().body },
    { statusCode: 200, body: { success: true, model: { outId: input.requestId } } },
    { statusCode: 200, body: { code: "OK", model: { outId: input.requestId } } },
    { statusCode: 200, body: { ...success().body, success: "true" } },
    { statusCode: 200, body: { ...success().body, success: false } },
    { statusCode: 200, body: { ...success().body, code: "provider-private" } },
    { statusCode: 200, body: { ...success().body, model: undefined } },
    { statusCode: 200, body: { ...success().body, model: {} } },
    success({ outId: "different-challenge", verifyCode: code, verifyResult: "PASS" }),
  ];
  for (const response of invalid) {
    respondSend(async () => response);
    respondCheck(async () => response);
    await assert.rejects(provider.send(input), safeError);
    await assert.rejects(provider.check({ ...input, code }), safeError);
  }
});

test("PNVS refuses missing or malformed server-returned codes without exposing them", async () => {
  const { provider, respondSend } = fixture();
  for (const verifyCode of [undefined, null, 123456, "12345", "1234567", "abcdef", "１２３４５６", "123456\n", " 123456"]) {
    respondSend(async () => success({ verifyCode }));
    await assert.rejects(provider.send(input), safeError);
  }
});

test("PNVS rejects invalid destinations, metadata and lifetime before invoking the client", async () => {
  const { provider, sendCalls, checkCalls } = fixture();
  for (const phone of ["13800000000", "8613800000000", "+11234567890", "+8612800000000", "+8613800000000\n"]) {
    await assert.rejects(provider.send({ ...input, phone }), safeError);
    await assert.rejects(provider.check({ ...input, phone, code }), safeError);
  }
  for (const requestId of ["", "a".repeat(129), "phone=13800000000", "challenge\nprivate"]) {
    await assert.rejects(provider.send({ ...input, requestId }), safeError);
  }
  for (const expiresInSeconds of [0, 59, 601, 60.5, NaN, Infinity]) {
    await assert.rejects(provider.send({ ...input, expiresInSeconds }), safeError);
  }
  for (const invalidCode of ["", "12345", "1234567", "abcdef", "123456\n"]) {
    assert.equal(await provider.check({ ...input, code: invalidCode }), false);
  }
  assert.equal(sendCalls.length, 0);
  assert.equal(checkCalls.length, 0);
});

test("PNVS provider errors discard private provider messages and causes without retrying", async () => {
  const { provider, respondSend, respondCheck, sendCalls, checkCalls } = fixture();
  const fail = async () => { throw new Error(`provider-private ${input.phone} ${code} ${options.accessKeySecret}`, { cause: options }); };
  respondSend(fail);
  respondCheck(fail);
  await assert.rejects(provider.send(input), safeError);
  await assert.rejects(provider.check({ ...input, code }), safeError);
  assert.equal(sendCalls.length, 1);
  assert.equal(checkCalls.length, 1);
});

test("PNVS enforces an overall deadline without retries for both operations", async () => {
  const { provider, respondSend, respondCheck, sendCalls, checkCalls } = fixture({ timeoutMs: 15 });
  const hang = () => new Promise<never>(() => {});
  respondSend(hang);
  respondCheck(hang);
  await assert.rejects(provider.send(input), safeError);
  await assert.rejects(provider.check({ ...input, code }), safeError);
  assert.equal(sendCalls.length, 1);
  assert.equal(checkCalls.length, 1);
});

test("PNVS rejects invalid configuration and SDK initialization errors without leaking credentials", () => {
  const invalid: Partial<AliyunPnvsProviderOptions>[] = [
    { accessKeyId: "" }, { accessKeySecret: "SyntheticPnvsSecret\ninjected" },
    { signName: "" }, { signName: "private\ncontent" }, { templateCode: "SMS_custom" },
    { schemeName: "a".repeat(21) }, { schemeName: "private\ncontent" },
    { timeoutMs: 0 }, { timeoutMs: 8_001 }, { timeoutMs: NaN }, { timeoutMs: 1.5 },
  ];
  for (const value of invalid) {
    assert.throws(() => createAliyunPnvsProvider({ ...options, ...value }, () => { throw new Error("unexpected client construction"); }), safeError);
  }
  assert.throws(() => createAliyunPnvsProvider(options, () => { throw new Error(options.accessKeySecret); }), safeError);
});

test("the installed official SDK maps only the authorized Send/Check actions without network access", async (t) => {
  const observed: { params: $OpenApiUtil.Params; request: $OpenApiUtil.OpenApiRequest }[] = [];
  const provider = createAliyunPnvsProvider(options, config => {
    const sdk = new PnvsSdk.default(config);
    t.mock.method(sdk, "callApi", async (params: $OpenApiUtil.Params, request: $OpenApiUtil.OpenApiRequest) => {
      observed.push({ params, request });
      return {
        statusCode: 200,
        body: { Code: "OK", Success: true, Model: { OutId: input.requestId, VerifyCode: code, VerifyResult: "PASS" } },
      };
    });
    return sdk;
  });
  assert.deepEqual(await provider.send(input), { code });
  assert.equal(await provider.check({ ...input, code }), true);
  assert.deepEqual(observed.map(item => item.params.action), ["SendSmsVerifyCode", "CheckSmsVerifyCode"]);
  for (const { params, request } of observed) {
    assert.equal(params.protocol, "HTTPS");
    assert.equal(params.version, "2017-05-25");
    assert.equal(params.method, "POST");
    assert.equal(request.query?.PhoneNumber, "13800000000");
    assert.equal(request.query?.OutId, input.requestId);
  }
});
