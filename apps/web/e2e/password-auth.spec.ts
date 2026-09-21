import { test, expect, syntheticEmail, authenticate, capturedMagicLink } from "./support/fixtures";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../api/src/app";
import { loadConfig } from "../../api/src/config";
import { createDatabasePool, PostgresRepository } from "../../api/src/postgresRepository";
import { hashToken } from "../../api/src/security";

// These flows deliberately exercise several real, memory-intensive scrypt hashes.
test.describe.configure({ timeout: 120_000 });

// Uses the existing isolated PostgreSQL stack and a local capture mailer only.
const firstPassword = "first synthetic pass phrase";
const nextPassword = "second synthetic pass phrase";

test("邮箱验证后设置密码、密码登录和忘记密码重置完整闭环", async ({ page, environment, database }) => {
  const email = syntheticEmail("password-flow");
  await authenticate(page, environment, { email, role: "talent" });
  const user = await database.query("SELECT id FROM users WHERE email=$1", [email]);
  const oldCookies = (await page.context().cookies()).map(({ name, value }) => `${name}=${value}`).join("; ");
  // Issue a second link before setting the password, to check that it cannot later reset it.
  await database.query("UPDATE email_challenges SET created_at=created_at-INTERVAL '31 seconds' WHERE email=$1", [email]);
  const extraLink = await page.request.post("/api/v1/auth/email/challenges", { headers: { Origin: environment.webOrigin }, data: { email, intent: "login", returnTo: "/account/password" } });
  expect(extraLink.status()).toBe(202);
  const oldLink = await capturedMagicLink(email, environment);
  await page.getByRole("link", { name: "个人信息", exact: true }).click();
  await page.getByRole("link", { name: "设置或修改登录密码", exact: true }).click();
  await expect(page.getByRole("heading", { name: "设置登录密码", exact: true })).toBeVisible();
  await page.getByLabel("新密码", { exact: true }).fill(firstPassword);
  await page.getByLabel("确认新密码", { exact: true }).fill("a different synthetic password");
  await page.getByRole("button", { name: "保存密码", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("两次输入的密码不一致。");
  await page.getByLabel("确认新密码", { exact: true }).fill(firstPassword);
  await page.getByRole("button", { name: "保存密码", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?.*passwordSaved=true/u);
  const saved = await database.query("SELECT password_hash FROM user_passwords WHERE user_id=$1", [user.rows[0].id]);
  expect(saved.rows[0].password_hash).toMatch(/^scrypt-v1\$/u);
  expect(saved.rows[0].password_hash).not.toContain(firstPassword);
  expect(Number((await database.query("SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL", [user.rows[0].id])).rows[0].count)).toBe(0);
  const replaySetup = await page.request.post("/api/v1/auth/password/setup", { headers: { Origin: environment.webOrigin, Cookie: oldCookies }, data: { password: nextPassword } });
  expect(replaySetup.status()).toBe(403);
  const token = new URLSearchParams(new URL(oldLink).hash.slice(1)).get("token");
  const replayLink = await page.request.post("/api/v1/auth/email/verify", { headers: { Origin: environment.webOrigin }, data: { token } });
  expect(replayLink.status()).toBe(400);
  await page.locator("#password-email").fill(email);
  await page.locator("#login-password").fill("wrong synthetic password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("邮箱或密码不正确");
  await page.locator("#login-password").fill(firstPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/u);
  // Password login alone must not authorize a password replacement.
  const proof = await page.request.get("/api/v1/auth/password/setup");
  expect((await proof.json()).canSetPassword).toBe(false);
  const denied = await page.request.post("/api/v1/auth/password/setup", { headers: { Origin: environment.webOrigin }, data: { password: nextPassword } });
  expect(denied.status()).toBe(403);
  await database.query("UPDATE email_challenges SET created_at=created_at-INTERVAL '31 seconds' WHERE email=$1", [email]);
  await page.goto("/account/password");
  const sent = page.waitForResponse(response => response.url().endsWith("/auth/email/challenges") && response.request().method() === "POST");
  await page.getByRole("button", { name: "发送验证邮件", exact: true }).click();
  expect((await sent).status()).toBe(202);
  await page.goto(await capturedMagicLink(email, environment));
  await expect(page.getByLabel("新密码", { exact: true })).toBeVisible();
  await page.getByLabel("新密码", { exact: true }).fill(nextPassword);
  await page.getByLabel("确认新密码", { exact: true }).fill(nextPassword);
  await page.getByRole("button", { name: "保存密码", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?.*passwordSaved=true/u);
  const oldPassword = await page.request.post("/api/v1/auth/password/login", { headers: { Origin: environment.webOrigin }, data: { email, password: firstPassword } });
  expect(oldPassword.status()).toBe(401);
  await page.locator("#password-email").fill(email);
  await page.locator("#login-password").fill(nextPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/u);
});

test("注册可选择验证后设置密码；密码接口限制来源、长度和账户尝试次数", async ({ page, environment, database }) => {
  const email = syntheticEmail("password-signup");
  await page.goto("/signup");
  await page.getByLabel("邮箱", { exact: false }).fill(email);
  await page.getByLabel("验证后设置登录密码", { exact: true }).check();
  const sent = page.waitForResponse(response => response.url().endsWith("/auth/email/challenges") && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  expect((await sent).status()).toBe(202);
  await page.goto(await capturedMagicLink(email, environment));
  await expect(page).toHaveURL(/\/account\/password\?/u);
  await expect(page.getByLabel("新密码", { exact: true })).toBeVisible();
  // Keep genuine route limits enabled. A separate API instance isolates this
  // adversarial sequence from the preceding browser flow's shared loopback IP.
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: environment.databaseUrl, WEB_ORIGIN: environment.webOrigin,
    AUTH_TOKEN_SECRET: "password-boundary-synthetic-secret-over-32-characters", AI_MODE: "local", LOG_LEVEL: "silent" });
  const app = await buildApp({ config, repository: new PostgresRepository(createDatabasePool(environment.databaseUrl, false)),
    emailSender: { async sendMagicLink() { throw new Error("This boundary test must not send email."); }, async close() {} } });
  const token = randomUUID();
  const sessionId = randomUUID();
  const headers = { origin: environment.webOrigin, cookie: `${config.authCookieName}=${token}` };
  try {
    await database.query("INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at,password_setup_expires_at,active_role) SELECT $1,id,$2,NOW(),NOW()+INTERVAL '1 day',NOW()+INTERVAL '15 minutes',role FROM users WHERE email=$3", [sessionId, hashToken(token, config.authTokenSecret), email]);
    const proof = await app.inject({ method: "GET", url: "/api/v1/auth/password/setup", headers });
    expect(proof.json().canSetPassword).toBe(true);
    const foreign = await app.inject({ method: "POST", url: "/api/v1/auth/password/setup", headers: { ...headers, origin: "https://foreign.invalid" }, payload: { password: firstPassword } });
    expect(foreign.statusCode).toBe(403);
    const short = await app.inject({ method: "POST", url: "/api/v1/auth/password/setup", headers, payload: { password: "short" } });
    expect(short.statusCode).toBe(400);
    // Expired mailbox proof must not be enough even with a valid long-lived session.
    await database.query("UPDATE sessions SET password_setup_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [sessionId]);
    const expired = await app.inject({ method: "POST", url: "/api/v1/auth/password/setup", headers, payload: { password: firstPassword } });
    expect(expired.statusCode).toBe(403);
    const unknown = syntheticEmail("password-limit");
    for (let i = 0; i < 10; i += 1) {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/password/login", headers, payload: { email: unknown, password: firstPassword } });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.inject({ method: "POST", url: "/api/v1/auth/password/login", headers, payload: { email: unknown, password: firstPassword } });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  } finally { await app.close(); }
});
