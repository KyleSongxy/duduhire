import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AppRepository } from "../src/repository.js";
import type { PhoneAuthRepository } from "../src/phoneAuthRepository.js";

test("encoded authentication paths preserve origin checks and never log raw phone exceptions", async t => {
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://synthetic@127.0.0.1/phone_security_test",
    AUTH_TOKEN_SECRET: "synthetic-origin-test-secret-more-than-32-characters", AI_MODE: "local", LOG_LEVEL: "silent" });
  config.phoneAuth = { ...config.phoneAuth!, enabled: true, allowedNumbers: ["+8613900000001"] };
  let requests = 0;
  const phoneRepository: PhoneAuthRepository = {
    async createPhoneChallengeIfAllowed() { requests += 1; throw new Error("SYNTHETIC_PRIVATE_PHONE_CODE_SQL_VALUE"); },
    async markPhoneChallengeSent() { return false; }, async invalidatePhoneChallenge() {},
    async reservePhoneChallengeVerification() { return { status: "invalid" }; },
    async releasePhoneChallengeVerification() {}, async completePhoneChallengeVerification() { return { status: "invalid" }; },
  };
  const app = await buildApp({ config, repository: { async close() {} } as AppRepository, phoneRepository,
    phoneProvider: { async send() { throw new Error("must not send"); }, async check() { throw new Error("must not check"); } } });
  t.after(() => app.close());
  const logs: unknown[][] = [];
  app.addHook("onRequest", async request => {
    request.log.error = ((...args: unknown[]) => { logs.push(args); }) as typeof request.log.error;
  });
  const payload = { phone: "13900000001", intent: "signup", role: "client" };
  for (const url of ["/api/v1/auth/phone/challenges", "/api/v%31/auth/phone/challenges", "/api/v1/auth/%70hone/challenges"]) {
    const denied = await app.inject({ method: "POST", url, headers: { origin: "https://untrusted.invalid" }, payload });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.headers["cache-control"], "no-store");
    const missingOrigin = await app.inject({ method: "POST", url, payload });
    assert.equal(missingOrigin.statusCode, 403);
  }
  assert.equal(requests, 0);
  for (const url of ["/api/v1/auth/phone/challenges", "/api/v%31/auth/phone/challenges", "/api/v1/auth/%70hone/challenges"]) {
    const failed = await app.inject({ method: "POST", url, headers: { origin: config.webOrigin }, payload });
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.headers["cache-control"], "no-store");
    assert.doesNotMatch(failed.body, /SYNTHETIC_PRIVATE|13900000001/u);
  }
  assert.equal(logs.length, 3);
  for (const args of logs) {
    const data = args[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), ["requestId", "route"]);
    assert.doesNotMatch(JSON.stringify(args), /SYNTHETIC_PRIVATE|13900000001/u);
  }
});

test("login eligibility errors fail closed without exposing account values in responses or logs", async t => {
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://synthetic@127.0.0.1/phone_security_test",
    AUTH_TOKEN_SECRET: "synthetic-origin-test-secret-more-than-32-characters", AI_MODE: "local", LOG_LEVEL: "silent" });
  let lookups = 0;
  const repository = { async close() {}, async isRegisteredLoginAccount() {
    lookups += 1;
    throw new Error("SYNTHETIC_PRIVATE_ACCOUNT_SQL_VALUE");
  } } as unknown as AppRepository;
  const app = await buildApp({ config, repository });
  t.after(() => app.close());
  const logs: unknown[][] = [];
  app.addHook("onRequest", async request => {
    request.log.error = ((...args: unknown[]) => { logs.push(args); }) as typeof request.log.error;
  });
  for (const url of ["/api/v1/auth/login-eligibility", "/api/v%31/auth/login-eligibility", "/api/v1/auth/%6Cogin-eligibility"]) {
    const payload = { method: "phone", account: "13900000001" };
    const rejected = await app.inject({ method: "POST", url, payload });
    assert.equal(rejected.statusCode, 403);
    const failed = await app.inject({ method: "POST", url, headers: { origin: config.webOrigin }, payload });
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.json().error.code, "INTERNAL_ERROR");
    assert.equal(failed.headers["cache-control"], "no-store");
    assert.equal(failed.headers["set-cookie"], undefined);
    assert.doesNotMatch(failed.body, /SYNTHETIC_PRIVATE|13900000001/u);
  }
  assert.equal(lookups, 3);
  assert.equal(logs.length, 3);
  for (const args of logs) {
    assert.deepEqual(Object.keys(args[0] as object).sort(), ["requestId", "route"]);
    assert.doesNotMatch(JSON.stringify(args), /SYNTHETIC_PRIVATE|13900000001/u);
  }
});
