import assert from "node:assert/strict";
import test from "node:test";
import { loadPhoneAuthConfig, normalizeMainlandPhone } from "../src/phoneAuthConfig.js";

test("SMS stays disabled even with saved or injected credentials", () => {
  const config = loadPhoneAuthConfig({ PNVS_ACCESS_KEY_ID: "synthetic", PNVS_ACCESS_KEY_SECRET: "synthetic" });
  assert.equal(config.enabled, false);
  assert.equal(config.allowAllNumbers, false);
  assert.deepEqual(config.allowedNumbers, []);
});

test("mainland phone normalization accepts only explicit mainland mobile forms", () => {
  assert.equal(normalizeMainlandPhone("13800000000"), "+8613800000000");
  assert.equal(normalizeMainlandPhone(" +8613800000000 "), "+8613800000000");
  for (const phone of ["", "+12125551234", "8613800000000", "138 0000 0000", "13800000000x", "12800000000", "１３８００００００００"]) {
    assert.equal(normalizeMainlandPhone(phone), null);
  }
});

test("enablement requires both dedicated credentials and a bounded allowlist", () => {
  for (const env of [
    { PHONE_AUTH_ENABLED: "true" },
    { PHONE_AUTH_ENABLED: "true", PNVS_ACCESS_KEY_ID: "synthetic", PNVS_ACCESS_KEY_SECRET: "synthetic" },
    { PHONE_AUTH_ENABLED: "true", PHONE_AUTH_ALLOWED_NUMBERS: "13800000000" },
    { PHONE_AUTH_ALLOWED_NUMBERS: "13800000000," },
    { PHONE_AUTH_ALLOWED_NUMBERS: "*" },
    { PHONE_AUTH_ENABLED: "yes" },
    { PHONE_AUTH_ALLOW_ALL_NUMBERS: "yes" },
    { PHONE_AUTH_DAILY_LIMIT: "0" },
    { PHONE_AUTH_DAILY_LIMIT: "101" },
    { PHONE_AUTH_MAX_ATTEMPTS: "6" },
    { PHONE_AUTH_RESEND_SECONDS: "0" },
    { PNVS_ACCESS_KEY_SECRET: "synthetic-secret marker" },
  ]) {
    assert.throws(() => loadPhoneAuthConfig(env), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /synthetic|13800000000/u);
      return true;
    });
  }
  const config = loadPhoneAuthConfig({ PHONE_AUTH_ENABLED: "true", PHONE_AUTH_ALLOWED_NUMBERS: "13800000000,+8613800000000", PNVS_ACCESS_KEY_ID: "synthetic", PNVS_ACCESS_KEY_SECRET: "synthetic", PHONE_AUTH_DAILY_LIMIT: "1" });
  assert.equal(config.enabled, true);
  assert.deepEqual(config.allowedNumbers, ["+8613800000000"]);
  assert.equal(config.dailyLimit, 1);
});

test("public mainland access is explicit and retains credentials and a bounded global budget", () => {
  const env = { PHONE_AUTH_ENABLED: "true", PHONE_AUTH_ALLOW_ALL_NUMBERS: "true", PNVS_ACCESS_KEY_ID: "synthetic", PNVS_ACCESS_KEY_SECRET: "synthetic", PHONE_AUTH_DAILY_LIMIT: "30" };
  const config = loadPhoneAuthConfig(env);
  assert.equal(config.allowAllNumbers, true);
  assert.equal(config.dailyLimit, 30);
  assert.equal(config.sendUntil, undefined);
  assert.deepEqual(config.allowedNumbers, []);
  assert.throws(() => loadPhoneAuthConfig({ ...env, PNVS_ACCESS_KEY_SECRET: undefined }));
  assert.throws(() => loadPhoneAuthConfig({ ...env, PHONE_AUTH_ALLOW_ALL_NUMBERS: "false" }));
  assert.throws(() => loadPhoneAuthConfig({ ...env, PHONE_AUTH_DAILY_LIMIT: "101" }));
});

test("one-off sending windows are absolute, bounded, and do not reopen after restart", () => {
  const deadline = new Date(Date.now() + 1_200_000).toISOString();
  assert.equal(loadPhoneAuthConfig({ PHONE_AUTH_SEND_UNTIL: deadline }).sendUntil, Date.parse(deadline));
  const ended = "2020-01-01T00:00:00.000Z";
  assert.equal(loadPhoneAuthConfig({ PHONE_AUTH_SEND_UNTIL: ended }).sendUntil, Date.parse(ended));
  for (const value of ["", "20 minutes", "2026-01-01", "synthetic-secret", new Date(Date.now() + 2 * 86_400_000).toISOString()]) {
    assert.throws(() => loadPhoneAuthConfig({ PHONE_AUTH_SEND_UNTIL: value }), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /synthetic-secret/u);
      return true;
    });
  }
});
