import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AppRepository } from "../src/repository.js";
import type { PhoneAuthRepository } from "../src/phoneAuthRepository.js";

for (const publicAccess of [false, true]) {
  test(`mainland signup/login public access=${publicAccess} preserves shared quota and origin checks`, async t => {
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://synthetic@127.0.0.1/public_sms_test",
      AUTH_TOKEN_SECRET: "synthetic-public-access-secret-more-than-32-characters", AI_MODE: "local", LOG_LEVEL: "silent" });
    config.phoneAuth = { ...config.phoneAuth!, enabled: true, allowAllNumbers: publicAccess,
      allowedNumbers: publicAccess ? [] : ["+8613900000001"], dailyLimit: 30 };
    let reserved = 0, sent = 0, exhausted = false;
    const phoneRepository: PhoneAuthRepository = {
      async createPhoneChallengeIfAllowed(challenge, _now, limits) {
        reserved += 1;
        assert.equal(challenge.phone, "+8613800000002");
        assert.equal(limits.dailyLimit, 30);
        return exhausted ? { created: false, retryAfterSeconds: 3600 } : { created: true };
      },
      async markPhoneChallengeSent() { return true; }, async invalidatePhoneChallenge() {},
      async reservePhoneChallengeVerification() { return { status: "invalid" }; },
      async releasePhoneChallengeVerification() {}, async completePhoneChallengeVerification() { return { status: "invalid" }; },
    };
    const app = await buildApp({ config, repository: { async close() {} } as AppRepository, phoneRepository,
      phoneProvider: { async send() { sent += 1; return { code: "123456" }; }, async check() { throw Error("not used"); } } });
    t.after(() => app.close());
    assert.equal((await app.inject("/api/v1/auth/methods")).json().phone.available, true);
    const post = (payload: object, origin = config.webOrigin) => app.inject({ method: "POST", url: "/api/v1/auth/phone/challenges", headers: { origin }, payload });
    const signup = { phone: "13800000002", intent: "signup", role: "client" };
    assert.equal((await post(signup, "https://untrusted.invalid")).statusCode, 403);
    assert.equal((await post({ ...signup, phone: "+12125551234" })).statusCode, 400);
    assert.equal(sent, 0);
    for (const intent of ["signup", "login"]) {
      const result = await post({ ...signup, intent });
      assert.equal(result.statusCode, publicAccess ? 202 : 403);
      if (!publicAccess) assert.equal(result.json().error.code, "PHONE_NOT_ALLOWED");
      else assert.ok(result.json().challengeId);
      assert.doesNotMatch(result.body, /123456/u);
    }
    assert.equal(sent, publicAccess ? 2 : 0);
    exhausted = true;
    const limited = await post(signup);
    assert.equal(limited.statusCode, publicAccess ? 429 : 403);
    if (publicAccess) {
      assert.equal(limited.json().error.code, "RATE_LIMITED");
      assert.equal(limited.headers["retry-after"], "3600");
    }
    assert.equal(sent, publicAccess ? 2 : 0);
    assert.equal(reserved, publicAccess ? 3 : 0);
  });
}
