import { randomInt } from "node:crypto";
import { test, expect } from "./support/fixtures";
import { buildApp } from "../../api/src/app";
import { loadConfig } from "../../api/src/config";
import { createDatabasePool, PostgresRepository } from "../../api/src/postgresRepository";

test("真实隔离数据库：重发限流不废弃已有短信验证码，也不再次调用短信服务", async ({ environment, database }) => {
  const phone = `+86139${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: environment.databaseUrl, WEB_ORIGIN: environment.webOrigin,
    AUTH_TOKEN_SECRET: "phone-recovery-synthetic-secret-over-32-characters", AI_MODE: "local", LOG_LEVEL: "silent" });
  config.phoneAuth = { ...config.phoneAuth!, enabled: true, allowedNumbers: [phone] };
  let sends = 0;
  const app = await buildApp({ config, repository: new PostgresRepository(createDatabasePool(environment.databaseUrl, false)),
    phoneProvider: { async send() { sends += 1; return { code: "582941" }; }, async check() { return true; } },
    emailSender: { async sendMagicLink() { throw new Error("This test must not send email."); }, async close() {} } });
  try {
    const headers = { origin: environment.webOrigin };
    const payload = { phone, intent: "signup", role: "talent" };
    const first = await app.inject({ method: "POST", url: "/api/v1/auth/phone/challenges", headers, payload });
    expect(first.statusCode).toBe(202);
    const cookies = first.headers["set-cookie"];
    const binding = (Array.isArray(cookies) ? cookies : [cookies]).find(value => value?.startsWith("duduhire_auth_intent="))?.split(";")[0];
    expect(binding).toBeTruthy();
    const limited = await app.inject({ method: "POST", url: "/api/v1/auth/phone/challenges", headers: { ...headers, cookie: binding! }, payload });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(sends).toBe(1);
    const row = await database.query("SELECT invalidated_at FROM phone_challenges WHERE id=$1", [first.json().challengeId]);
    expect(row.rows[0].invalidated_at).toBeNull();
    const verified = await app.inject({ method: "POST", url: "/api/v1/auth/phone/verify", headers: { ...headers, cookie: binding! },
      payload: { challengeId: first.json().challengeId, code: "582941" } });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().authenticated).toBe(true);
  } finally {
    await database.query("DELETE FROM phone_challenges WHERE phone=$1", [phone]);
    await database.query("DELETE FROM users WHERE phone=$1", [phone]);
    await app.close();
  }
});
