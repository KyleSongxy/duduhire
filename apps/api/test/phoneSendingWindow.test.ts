import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AppRepository } from "../src/repository.js";
import type { PhoneAuthRepository } from "../src/phoneAuthRepository.js";

test("closed send window blocks provider calls without preventing verification of a still-valid code", async t => {
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://synthetic@127.0.0.1/window_test",
    AUTH_TOKEN_SECRET: "synthetic-window-test-secret-more-than-32-characters", AI_MODE: "local", LOG_LEVEL: "silent",
    EMAIL_DELIVERY_MODE: "disabled" });
  config.phoneAuth = { ...config.phoneAuth!, enabled: true, allowedNumbers: ["+8613900000001"], sendUntil: Date.now() - 1 };
  let checks = 0;
  const phoneRepository: PhoneAuthRepository = {
    async createPhoneChallengeIfAllowed() { throw new Error("must not reserve a send"); },
    async markPhoneChallengeSent() { throw new Error("must not activate a send"); },
    async invalidatePhoneChallenge() {},
    async reservePhoneChallengeVerification() { return { status: "reserved", phone: "+8613900000001" }; },
    async releasePhoneChallengeVerification() {},
    async completePhoneChallengeVerification() { return { status: "account_not_found", returnTo: "/workspace" }; },
  };
  const app = await buildApp({ config, repository: { async close() {} } as AppRepository, phoneRepository,
    phoneProvider: { async send() { throw new Error("must not send"); }, async check() { checks += 1; return true; } } });
  t.after(() => app.close());
  assert.deepEqual((await app.inject("/api/v1/auth/methods")).json(), {
    email: { available: false, delivery: "disabled" }, phone: { available: true, region: "CN" },
  });
  const result = await app.inject({ method: "POST", url: "/api/v1/auth/phone/challenges",
    headers: { origin: config.webOrigin }, payload: { phone: "13900000001", intent: "signup", role: "client" } });
  assert.equal(result.statusCode, 403);
  assert.equal(result.json().error.code, "SMS_TEST_WINDOW_CLOSED");
  const verified = await app.inject({ method: "POST", url: "/api/v1/auth/phone/verify",
    headers: { origin: config.webOrigin, cookie: `duduhire_auth_intent=${"a".repeat(43)}` },
    payload: { challengeId: "a29c08bb-4c65-47b7-a0e0-e42c18dace01", code: "103827" } });
  assert.equal(verified.statusCode, 200);
  assert.equal(checks, 1);
  assert.equal(verified.json().authenticated, false);
});
