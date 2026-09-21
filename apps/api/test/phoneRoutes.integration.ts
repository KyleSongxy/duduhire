import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDatabasePool, PostgresRepository } from "../src/postgresRepository.js";
import type { PhoneVerificationProvider } from "../src/pnvsProvider.js";
import { hashToken } from "../src/security.js";

const databaseUrl = process.env.TEST_PHONE_ROUTES_DATABASE_URL;
const enabled = process.env.RUN_POSTGRES_TESTS === "true" && Boolean(databaseUrl);

function cookie(response: { headers: Record<string, string | string[] | undefined> }, name: string) {
  const values = response.headers["set-cookie"];
  const value = (Array.isArray(values) ? values : values ? [values] : []).find(item => item.startsWith(`${name}=`));
  assert.ok(value, `expected ${name} cookie`);
  return value.split(";")[0]!;
}

test("phone API with real PostgreSQL and synthetic PNVS: never sends real SMS", { skip: !enabled }, async t => {
  const target = new URL(databaseUrl!);
  assert.ok(["127.0.0.1", "localhost"].includes(target.hostname));
  assert.match(target.pathname, /_test$/u);
  const pool = createDatabasePool(databaseUrl!, false);
  const repository = new PostgresRepository(pool);
  const runPrefix = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const phones = Array.from({ length: 12 }, (_, index) => `+86139${runPrefix}${String(index).padStart(2, "0")}`);
  const email = `login-eligibility-${runPrefix}@example.test`;
  const messages: Array<{ to: string; link: string }> = [];
  let sends = 0;
  let checks = 0;
  let failSend = false;
  let failCheck = false;
  let rejectCheck = false;
  const provider: PhoneVerificationProvider = {
    async send() { sends += 1; if (failSend) throw new Error("synthetic-private-provider-error"); return { code: "582941" }; },
    async check() { checks += 1; if (failCheck) throw new Error("synthetic-private-provider-error"); return !rejectCheck; },
  };
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: databaseUrl!, WEB_ORIGIN: "http://127.0.0.1:5198", AI_MODE: "local",
    AUTH_TOKEN_SECRET: "phone-route-synthetic-hmac-secret-with-more-than-32-characters", LOG_LEVEL: "silent" });
  config.phoneAuth = { ...config.phoneAuth!, enabled: true, allowedNumbers: phones, ipHourlyLimit: 20, dailyLimit: 100 };
  const app = await buildApp({ config, repository, phoneProvider: provider,
    emailSender: { async sendMagicLink(message) { messages.push(message); }, async close() {} } });
  t.after(async () => {
    await pool.query("DELETE FROM phone_challenges WHERE phone=ANY($1::text[])", [phones]);
    await pool.query("DELETE FROM users WHERE phone=ANY($1::text[])", [phones]);
    await pool.query("DELETE FROM email_challenges WHERE email=$1", [email]);
    await pool.query("DELETE FROM users WHERE email=$1", [email]);
    await app.close();
  });
  const headers = { origin: config.webOrigin };
  const start = async (phone: string, intent = "signup", role = "client", returnTo = "/workspace", ip = "127.0.0.1") => {
    const result = await app.inject({ method: "POST", url: "/api/v1/auth/phone/challenges", headers, remoteAddress: ip,
      payload: { phone, intent, ...(intent === "signup" ? { role } : {}), returnTo } });
    assert.equal(result.statusCode, 202, result.body);
    assert.equal(result.json().delivery, "sms");
    assert.doesNotMatch(result.body, /582941|accessKey|synthetic-private/u);
    return { id: result.json().challengeId as string, browser: cookie(result, "duduhire_auth_intent") };
  };
  const verify = (id: string, browser: string, code = "582941") => app.inject({ method: "POST", url: "/api/v1/auth/phone/verify",
    remoteAddress: `127.0.1.${Number.parseInt(id.slice(0, 2), 16) % 254 + 1}`,
    headers: { ...headers, cookie: browser }, payload: { challengeId: id, code } });

  await t.test("disabled configuration, cross-origin and unapproved numbers cannot send", async () => {
    const disabledApp = await buildApp({ config: { ...config, phoneAuth: { ...config.phoneAuth!, enabled: false } },
      repository: new PostgresRepository(createDatabasePool(databaseUrl!, false)), phoneProvider: provider });
    try {
      assert.equal((await disabledApp.inject("/api/v1/auth/methods")).json().phone.available, false);
      assert.equal((await disabledApp.inject({ method: "POST", url: "/api/v1/auth/phone/challenges", headers,
        payload: { phone: phones[0], intent: "signup", role: "client" } })).statusCode, 503);
    } finally { await disabledApp.close(); }
    const methods = await app.inject("/api/v1/auth/methods");
    assert.equal(methods.json().phone.available, true);
    const foreign = await app.inject({ method: "POST", url: "/api/v1/auth/phone/challenges", headers: { origin: "https://untrusted.invalid" }, payload: { phone: phones[0], intent: "signup", role: "client" } });
    assert.equal(foreign.statusCode, 403);
    for (const url of ["/api/v%31/auth/phone/challenges", "/api/v1/auth/%70hone/challenges"]) {
      const encoded = await app.inject({ method: "POST", url, headers: { origin: "https://untrusted.invalid" },
        payload: { phone: phones[0], intent: "signup", role: "client" } });
      assert.equal(encoded.statusCode, 403);
      assert.equal(encoded.headers["cache-control"], "no-store");
    }
    const notApproved = await app.inject({ method: "POST", url: "/api/v1/auth/phone/challenges", headers, payload: { phone: "13812345678", intent: "signup", role: "client" } });
    assert.equal(notApproved.statusCode, 403);
    assert.equal(sends, 0);
  });

  await t.test("phone signup creates a session with no fictitious email; replay and logout fail closed", async () => {
    const started = await start(phones[0]!, "signup", "talent", "https://untrusted.invalid");
    const row = (await pool.query("SELECT code_hash FROM phone_challenges WHERE id=$1", [started.id])).rows[0];
    assert.equal(row.code_hash, hashToken(`phone-code:${started.id}:582941`, config.authTokenSecret));
    const verified = await verify(started.id, started.browser);
    assert.equal(verified.statusCode, 200, verified.body);
    assert.equal(verified.json().returnTo, "/workspace");
    const sessionCookie = cookie(verified, config.authCookieName);
    const session = (await app.inject({ url: "/api/v1/auth/session", headers: { cookie: sessionCookie } })).json().session;
    assert.equal(session.user.email, null);
    assert.equal(session.user.emailVerifiedAt, null);
    assert.equal(session.user.phone, phones[0]);
    assert.ok(session.user.phoneVerifiedAt);
    assert.equal(session.user.role, "talent");
    const workspace = (await app.inject({ url: "/api/v1/me/workspace", headers: { cookie: sessionCookie } })).json();
    assert.equal(workspace.emailVerified, false);
    assert.equal(workspace.phoneVerified, true);
    assert.equal((await verify(started.id, started.browser)).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { ...headers, cookie: sessionCookie } })).statusCode, 204);
    assert.equal((await app.inject({ url: "/api/v1/auth/session", headers: { cookie: sessionCookie } })).json().session, null);
  });

  await t.test("browser binding and local code hash reject errors before any provider check", async () => {
    const started = await start(phones[1]!);
    const before = checks;
    const missing = await verify(started.id, "");
    assert.equal(missing.json().error.code, "BROWSER_CONTEXT_REQUIRED");
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await verify(started.id, started.browser, "000000")).statusCode, 400);
    assert.equal((await verify(started.id, started.browser)).statusCode, 400);
    assert.equal(checks, before);
  });

  await t.test("unknown login cannot reserve or send SMS; simultaneous signup verify consumes once", async () => {
    const before = sends;
    const rejected = await app.inject({ method: "POST", url: "/api/v1/auth/phone/challenges", headers,
      payload: { phone: phones[2]!.slice(3), intent: "login" } });
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().error.code, "ACCOUNT_NOT_REGISTERED");
    assert.equal(rejected.headers["cache-control"], "no-store");
    assert.equal(sends, before);
    assert.equal((await pool.query("SELECT id FROM phone_challenges WHERE phone=$1", [phones[2]])).rowCount, 0);
    assert.equal((await pool.query("SELECT id FROM users WHERE phone=$1", [phones[2]])).rowCount, 0);
    const concurrent = await start(phones[3]!);
    const responses = await Promise.all([verify(concurrent.id, concurrent.browser), verify(concurrent.id, concurrent.browser)]);
    assert.equal(responses.filter(response => response.statusCode === 200).length, 1);
    assert.equal(responses.filter(response => response.statusCode === 400).length, 1);
  });

  await t.test("registered phone login and eligibility use the same normalized identity and retain its role", async () => {
    const known = await app.inject({ method: "POST", url: "/api/v1/auth/login-eligibility", headers,
      payload: { method: "phone", account: phones[0]!.slice(3) } });
    assert.deepEqual(known.json(), { registered: true });
    assert.equal(known.headers["set-cookie"], undefined);
    const unknown = await app.inject({ method: "POST", url: "/api/v1/auth/login-eligibility", headers,
      payload: { method: "phone", account: phones[2] } });
    assert.deepEqual(unknown.json(), { registered: false });
    await pool.query("UPDATE phone_challenges SET created_at=created_at-INTERVAL '61 seconds' WHERE phone=$1", [phones[0]]);
    const before = sends;
    const started = await start(phones[0]!.slice(3), "login", "client", "/workspace", "127.0.0.8");
    assert.equal(sends, before + 1);
    const result = await verify(started.id, started.browser);
    assert.equal(result.json().authenticated, true);
    assert.equal((await pool.query("SELECT role FROM users WHERE phone=$1", [phones[0]])).rows[0].role, "talent");
  });

  await t.test("email lookup, send guard and verified signup agree on account registration", async () => {
    const lookup = () => app.inject({ method: "POST", url: "/api/v1/auth/login-eligibility", headers,
      payload: { method: "email", account: ` ${email.toUpperCase()} ` } });
    assert.deepEqual((await lookup()).json(), { registered: false });
    const request = (intent: "login" | "signup") => app.inject({ method: "POST", url: "/api/v1/auth/email/challenges", headers,
      remoteAddress: "127.0.0.9", payload: { email: ` ${email.toUpperCase()} `, intent, ...(intent === "signup" ? { role: "talent" } : {}) } });
    const denied = await request("login");
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.json().error.code, "ACCOUNT_NOT_REGISTERED");
    assert.equal(messages.length, 0);
    assert.equal((await pool.query("SELECT id FROM email_challenges WHERE email=$1", [email])).rowCount, 0);
    const signup = await request("signup");
    assert.equal(signup.statusCode, 202);
    assert.equal(messages.length, 1);
    assert.deepEqual((await lookup()).json(), { registered: false }, "An unverified signup is not a registered account.");
    const pending = (await pool.query("SELECT id, consumed_at FROM email_challenges WHERE email=$1", [email])).rows[0];
    assert.equal((await request("login")).statusCode, 409);
    assert.equal(messages.length, 1);
    assert.equal((await pool.query("SELECT consumed_at FROM email_challenges WHERE id=$1", [pending.id])).rows[0].consumed_at, null);
    const token = new URLSearchParams(new URL(messages[0]!.link).hash.slice(1)).get("token");
    const verified = await app.inject({ method: "POST", url: "/api/v1/auth/email/verify",
      headers: { ...headers, cookie: cookie(signup, "duduhire_auth_intent") }, payload: { token } });
    assert.equal(verified.json().authenticated, true);
    assert.deepEqual((await lookup()).json(), { registered: true });
    await pool.query("UPDATE email_challenges SET created_at=created_at-INTERVAL '61 seconds' WHERE email=$1", [email]);
    const login = await request("login");
    assert.equal(login.statusCode, 202);
    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.to, email);
    assert.equal((await pool.query("SELECT role FROM users WHERE email=$1", [email])).rows[0].role, "talent");
    // The consume-time guard remains authoritative if an account disappears after sending.
    await pool.query("DELETE FROM users WHERE email=$1", [email]);
    const latestToken = new URLSearchParams(new URL(messages[1]!.link).hash.slice(1)).get("token");
    const removed = await app.inject({ method: "POST", url: "/api/v1/auth/email/verify",
      headers: { ...headers, cookie: cookie(login, "duduhire_auth_intent") }, payload: { token: latestToken } });
    assert.equal(removed.json().reason, "account_not_found");
    assert.equal((await pool.query("SELECT id FROM users WHERE email=$1", [email])).rowCount, 0);
  });

  await t.test("provider outage releases the lease for retry, but a rejected code never authenticates", async () => {
    const started = await start(phones[4]!, "signup", "client", "/talent", "127.0.0.2");
    failCheck = true;
    const failed = await verify(started.id, started.browser);
    assert.equal(failed.statusCode, 503);
    assert.doesNotMatch(failed.body, /synthetic-private|582941/u);
    failCheck = false;
    assert.equal((await verify(started.id, started.browser)).statusCode, 200);
    const rejected = await start(phones[5]!, "signup", "client", "/workspace", "127.0.0.3");
    rejectCheck = true;
    assert.equal((await verify(rejected.id, rejected.browser)).statusCode, 400);
    rejectCheck = false;
    assert.equal((await verify(rejected.id, rejected.browser)).statusCode, 400);
  });

  await t.test("failed send is not reported as sent and is counted against retry cooldown", async () => {
    failSend = true;
    const failed = await app.inject({ method: "POST", url: "/api/v1/auth/phone/challenges", headers, remoteAddress: "127.0.0.4", payload: { phone: phones[6], intent: "signup", role: "client" } });
    assert.equal(failed.statusCode, 503);
    assert.doesNotMatch(failed.body, /synthetic-private|582941/u);
    failSend = false;
    const retry = await app.inject({ method: "POST", url: "/api/v1/auth/phone/challenges", headers, remoteAddress: "127.0.0.4", payload: { phone: phones[6], intent: "signup", role: "client" } });
    assert.equal(retry.statusCode, 429);
    assert.ok(Number(retry.headers["retry-after"]) > 0);
  });
});
