import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import type { NewPhoneChallenge, PhoneChallengeLimits } from "../src/phoneAuthRepository.js";
import { PostgresRepository } from "../src/postgresRepository.js";
import type { NewSession } from "../src/repository.js";

// Deliberately never loads .env or DATABASE_URL. Every run owns a generated
// schema in an explicitly supplied local test database.
const databaseUrl = process.env.TEST_PHONE_DATABASE_URL?.trim();
const hash = () => createHash("sha256").update(randomUUID()).digest("hex");
const limits: PhoneChallengeLimits = { resendSeconds: 0, phoneHourlyLimit: 100, ipHourlyLimit: 100, dailyLimit: 1000 };
let phoneSequence = 0;
function challenge(overrides: Partial<NewPhoneChallenge> = {}): NewPhoneChallenge {
  const now = new Date();
  return {
    id: randomUUID(), phone: `+86138${String(++phoneSequence).padStart(8, "0")}`,
    intent: "signup", requestedRole: "client", codeHash: hash(), browserBindingHash: hash(), requestIpHash: hash(),
    returnTo: "/workspace", createdAt: now, expiresAt: new Date(now.getTime() + 300_000), ...overrides,
  };
}
function session(now = new Date()): NewSession {
  return { id: randomUUID(), tokenHash: hash(), createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000) };
}

test("PostgreSQL phone authentication uses isolated persistence, atomic budgets and one-time identity verification", {
  skip: databaseUrl ? false : "TEST_PHONE_DATABASE_URL is absent; no PostgreSQL phone integration was run.",
}, async (t) => {
  assert.ok(databaseUrl);
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Phone integration only accepts a local test database.");
  assert.match(url.pathname, /_test$/u, "Phone integration requires an explicit *_test database.");
  assert.equal(url.search, "", "Test connection options must not override schema isolation.");
  assert.equal(url.hash, "");
  const schema = `phone_auth_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^phone_auth_test_[a-f0-9]{32}$/u);
  const owner = new Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new Pool({ connectionString: databaseUrl, max: 12,
    options: `-c search_path=${schema},pg_catalog -c statement_timeout=5000 -c lock_timeout=3000` });
  owner.on("error", () => undefined);
  pool.on("error", () => undefined);
  const repository = new PostgresRepository(pool);
  let schemaCreated = false;
  const legacyId = randomUUID();
  const legacyEmail = "preserved-phone-test@example.com";
  const legacyPhoneContact = "+8613900000001";
  const legacyVerifiedAt = new Date("2024-01-02T03:04:05.000Z");
  const create = async (item = challenge(), requestedLimits = limits) => {
    assert.deepEqual(await repository.createPhoneChallengeIfAllowed(item, item.createdAt, requestedLimits), { created: true });
    return item;
  };
  const sent = async (item = challenge()) => {
    await create(item);
    assert.equal(await repository.markPhoneChallengeSent(item.id, item.codeHash), true);
    return item;
  };
  const reserve = (item: NewPhoneChallenge, lease = randomUUID(), now = new Date(), maxAttempts = 5) => ({
    lease, result: repository.reservePhoneChallengeVerification(item.id, item.browserBindingHash, item.codeHash, now, lease, maxAttempts),
  });
  const resetChallenges = () => pool.query("TRUNCATE phone_challenges");
  try {
    await owner.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    const files = (await readdir(new URL("../migrations/", import.meta.url))).filter((file) => /^\d+.*\.sql$/u.test(file)).sort();
    for (const file of files) {
      if (file === "009_phone_authentication.sql") {
        await pool.query("INSERT INTO users (id, email, role, email_verified_at) VALUES ($1, $2, 'talent', $3)",
          [legacyId, legacyEmail, legacyVerifiedAt]);
        await pool.query("INSERT INTO profiles (user_id, contact) VALUES ($1, $2)", [legacyId, legacyPhoneContact]);
      }
      const sql = (await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")).replace(/\bpublic\./gu, `${schema}.`);
      await pool.query(sql);
    }

    await t.test("migration preserves old email identities, rejects unverified accounts and never merges profile contacts", async () => {
      const old = (await pool.query("SELECT * FROM users WHERE id = $1", [legacyId])).rows[0];
      assert.equal(old.email, legacyEmail);
      assert.equal(old.role, "talent");
      assert.deepEqual(old.email_verified_at, legacyVerifiedAt);
      assert.equal(old.phone, null);
      assert.equal(old.phone_verified_at, null);
      await assert.rejects(pool.query("INSERT INTO users (id, role) VALUES ($1, 'client')", [randomUUID()]), { code: "23514" });
      await assert.rejects(pool.query("INSERT INTO users (id, email, role) VALUES ($1, $2, 'client')", [randomUUID(), "unverified@example.com"]), { code: "23514" });
      const item = await sent(challenge({ phone: legacyPhoneContact }));
      const reserved = reserve(item);
      assert.equal((await reserved.result).status, "reserved");
      const result = await repository.completePhoneChallengeVerification(item.id, reserved.lease, new Date(), session());
      assert.equal(result.status, "verified");
      if (result.status !== "verified") return;
      assert.notEqual(result.session.user.id, legacyId);
      assert.equal(result.session.user.email, null);
      assert.equal(result.session.user.emailVerifiedAt, null);
      assert.equal(result.session.user.phone, legacyPhoneContact);
      assert.equal((await repository.readProfile(legacyId)).contact, legacyPhoneContact);
      await assert.rejects(pool.query("INSERT INTO users (id, phone, role, phone_verified_at) VALUES ($1, $2, 'talent', NOW())", [randomUUID(), legacyPhoneContact]), { code: "23505" });

      const emailChallenge = { id: randomUUID(), email: legacyEmail, intent: "login" as const,
        requestedRole: null, tokenHash: hash(), browserBindingHash: hash(), returnTo: "/workspace", createdAt: new Date(), expiresAt: new Date(Date.now() + 300_000) };
      assert.deepEqual(await repository.createEmailChallengeIfAllowed(emailChallenge, new Date(), 0, 10), { created: true });
      const emailResult = await repository.consumeEmailChallenge(emailChallenge.tokenHash, emailChallenge.browserBindingHash, new Date(), session());
      assert.equal(emailResult.status, "verified");
      if (emailResult.status === "verified") {
        assert.equal(emailResult.session.user.id, legacyId);
        assert.equal(emailResult.session.user.phone, null);
        assert.equal(emailResult.session.user.phoneVerifiedAt, null);
      }
    });

    await t.test("signup commits one session and profile, rejects replay, and retains the existing role", async () => {
      await resetChallenges();
      const item = await sent(challenge({ requestedRole: "talent" }));
      const reserved = reserve(item);
      assert.equal((await reserved.result).status, "reserved");
      const sessions = [session(), session()];
      const results = await Promise.all(sessions.map((newSession) => repository.completePhoneChallengeVerification(item.id, reserved.lease, new Date(), newSession)));
      assert.deepEqual(results.map((result) => result.status).sort(), ["invalid", "verified"]);
      const result = results.find((entry) => entry.status === "verified")!;
      if (result.status !== "verified") return;
      const user = result.session.user;
      assert.equal(user.role, "talent");
      assert.equal(user.email, null);
      assert.ok(user.phoneVerifiedAt instanceof Date);
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM profiles WHERE user_id = $1", [user.id])).rows[0].count), 1);
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM sessions WHERE user_id = $1", [user.id])).rows[0].count), 1);
      const stored = (await Promise.all(sessions.map((value) => repository.findSession(value.tokenHash, new Date())))).find(Boolean)!;
      assert.deepEqual(stored.user, user);
      const summary = await repository.readWorkspaceSummary(user.id, user.role);
      assert.equal(summary.emailVerified, false);
      assert.equal(summary.phoneVerified, true);
      assert.equal(summary.discoveryKind, "capability");
      assert.equal((await reserve(item).result).status, "invalid");

      const again = await sent(challenge({ phone: item.phone, requestedRole: "client" }));
      const next = reserve(again);
      assert.equal((await next.result).status, "reserved");
      const existing = await repository.completePhoneChallengeVerification(again.id, next.lease, new Date(), session());
      assert.equal(existing.status, "verified");
      if (existing.status === "verified") {
        assert.equal(existing.session.user.id, user.id);
        assert.equal(existing.session.user.role, "talent", "A signup request cannot change an existing account role.");
      }
    });

    await t.test("unknown login creates no challenge and preserves a pending signup", async () => {
      await resetChallenges();
      const signup = await sent();
      const item = challenge({ phone: signup.phone, intent: "login", requestedRole: null, returnTo: "/talent" });
      assert.deepEqual(await repository.createPhoneChallengeIfAllowed(item, item.createdAt, limits), { created: false, reason: "account_not_found" });
      assert.equal((await pool.query("SELECT id FROM phone_challenges WHERE id = $1", [item.id])).rowCount, 0);
      assert.equal((await pool.query("SELECT invalidated_at FROM phone_challenges WHERE id = $1", [signup.id])).rows[0].invalidated_at, null);
      assert.equal((await pool.query("SELECT id FROM users WHERE phone = $1", [item.phone])).rowCount, 0);
    });

    await t.test("registered login works but a removed account cannot be recreated during verification", async () => {
      await resetChallenges();
      const phone = challenge().phone;
      const id = randomUUID();
      await pool.query("INSERT INTO users (id, phone, role, phone_verified_at) VALUES ($1, $2, 'talent', NOW())", [id, phone]);
      assert.equal(await repository.isRegisteredLoginAccount("phone", phone), true);
      const item = await sent(challenge({ phone, intent: "login", requestedRole: null, returnTo: "/talent" }));
      await pool.query("DELETE FROM users WHERE id = $1", [id]);
      assert.equal(await repository.isRegisteredLoginAccount("phone", phone), false);
      const reserved = reserve(item);
      assert.equal((await reserved.result).status, "reserved");
      const newSession = session();
      assert.deepEqual(await repository.completePhoneChallengeVerification(item.id, reserved.lease, new Date(), newSession), { status: "account_not_found", returnTo: "/talent" });
      assert.equal((await pool.query("SELECT id FROM users WHERE phone = $1", [item.phone])).rowCount, 0);
      assert.equal((await pool.query("SELECT id FROM sessions WHERE id = $1", [newSession.id])).rowCount, 0);
      assert.equal((await reserve(item).result).status, "invalid");
    });

    await t.test("only sent challenges activate, incorrect codes and bindings commit attempts, and the limit closes verification", async () => {
      await resetChallenges();
      const item = await create();
      assert.equal((await reserve(item).result).status, "invalid");
      const providerHash = hash();
      assert.equal(await repository.markPhoneChallengeSent(item.id, providerHash), true);
      assert.equal(await repository.markPhoneChallengeSent(item.id, hash()), false);
      assert.equal((await reserve(item).result).status, "invalid", "The pre-send placeholder hash must not verify.");
      assert.equal((await repository.reservePhoneChallengeVerification(item.id, hash(), providerHash, new Date(), randomUUID(), 3)).status, "invalid");
      assert.equal((await repository.reservePhoneChallengeVerification(item.id, item.browserBindingHash, hash(), new Date(), randomUUID(), 3)).status, "invalid");
      const row = (await pool.query("SELECT verification_attempts, verification_lease_id FROM phone_challenges WHERE id = $1", [item.id])).rows[0];
      assert.equal(row.verification_attempts, 3);
      assert.equal(row.verification_lease_id, null);
      assert.equal((await repository.reservePhoneChallengeVerification(item.id, item.browserBindingHash, providerHash, new Date(), randomUUID(), 3)).status, "invalid");
      const expired = await create(challenge({ createdAt: new Date(Date.now() - 600_000), expiresAt: new Date(Date.now() - 1000) }));
      assert.equal(await repository.markPhoneChallengeSent(expired.id, expired.codeHash), false);
    });

    await t.test("verification leases are exclusive, expire, and cannot be released by an older worker", async () => {
      await resetChallenges();
      const item = await sent();
      const now = new Date();
      const leases = Array.from({ length: 6 }, () => randomUUID());
      const results = await Promise.all(leases.map((lease) => repository.reservePhoneChallengeVerification(item.id, item.browserBindingHash, item.codeHash, now, lease, 5)));
      assert.equal(results.filter((result) => result.status === "reserved").length, 1);
      const firstLease = leases[results.findIndex((result) => result.status === "reserved")]!;
      const attempts = (await pool.query("SELECT verification_attempts FROM phone_challenges WHERE id = $1", [item.id])).rows[0].verification_attempts;
      assert.equal(attempts, 1);
      await repository.releasePhoneChallengeVerification(item.id, randomUUID());
      assert.equal((await reserve(item, randomUUID(), now).result).status, "invalid");
      const afterExpiry = new Date(now.getTime() + 31_000);
      assert.equal((await repository.completePhoneChallengeVerification(item.id, firstLease, afterExpiry, session())).status, "invalid");
      const renewed = reserve(item, randomUUID(), afterExpiry);
      assert.equal((await renewed.result).status, "reserved");
      await repository.releasePhoneChallengeVerification(item.id, firstLease);
      assert.equal((await repository.completePhoneChallengeVerification(item.id, renewed.lease, afterExpiry, session())).status, "verified");

      const second = await sent();
      const released = reserve(second);
      assert.equal((await released.result).status, "reserved");
      await repository.releasePhoneChallengeVerification(second.id, released.lease);
      assert.equal((await repository.completePhoneChallengeVerification(second.id, released.lease, new Date(), session())).status, "invalid");
      assert.equal((await reserve(second).result).status, "reserved");
    });

    await t.test("global, phone and IP budgets reserve atomically and still count failed sends", async () => {
      await resetChallenges();
      const now = new Date();
      const items = Array.from({ length: 12 }, () => challenge({ createdAt: now }));
      const results = await Promise.all(items.map((item) => repository.createPhoneChallengeIfAllowed(item, now, { ...limits, dailyLimit: 3 })));
      assert.equal(results.filter((result) => result.created).length, 3);
      for (const result of results) if (!result.created) {
        assert.ok("retryAfterSeconds" in result);
        assert.equal(result.retryAfterSeconds, 86_400);
      }
      const accepted = items.filter((_item, index) => results[index]!.created);
      await Promise.all(accepted.map((item) => repository.invalidatePhoneChallenge(item.id)));
      assert.equal(await repository.markPhoneChallengeSent(accepted[0]!.id, hash()), false);
      assert.equal((await repository.createPhoneChallengeIfAllowed(challenge(), new Date(), { ...limits, dailyLimit: 3 })).created, false);
      const tomorrow = new Date(now.getTime() + 86_400_001);
      assert.equal((await repository.createPhoneChallengeIfAllowed(challenge({ createdAt: tomorrow, expiresAt: new Date(tomorrow.getTime() + 300_000) }), tomorrow, { ...limits, dailyLimit: 3 })).created, true);

      await resetChallenges();
      const ip = hash();
      const ipRace = await Promise.all(Array.from({ length: 8 }, () => challenge({ requestIpHash: ip, createdAt: now }))
        .map((item) => repository.createPhoneChallengeIfAllowed(item, now, { ...limits, ipHourlyLimit: 2 })));
      assert.equal(ipRace.filter((result) => result.created).length, 2);
      for (const result of ipRace) if (!result.created) {
        assert.ok("retryAfterSeconds" in result);
        assert.equal(result.retryAfterSeconds, 3600);
      }

      await resetChallenges();
      const original = await create(challenge({ createdAt: now }), { ...limits, resendSeconds: 30 });
      await repository.invalidatePhoneChallenge(original.id);
      const tooSoon = challenge({ phone: original.phone, createdAt: now });
      assert.deepEqual(await repository.createPhoneChallengeIfAllowed(tooSoon, now, { ...limits, resendSeconds: 30 }), { created: false, retryAfterSeconds: 30 });
      assert.deepEqual(await repository.createPhoneChallengeIfAllowed(tooSoon, now, { ...limits, phoneHourlyLimit: 1 }), { created: false, retryAfterSeconds: 3600 });
      await resetChallenges();
      const samePhone = challenge().phone;
      const phoneRace = await Promise.all(Array.from({ length: 8 }, () => challenge({ phone: samePhone, createdAt: now }))
        .map((item) => repository.createPhoneChallengeIfAllowed(item, now, { ...limits, phoneHourlyLimit: 2 })));
      assert.equal(phoneRace.filter((result) => result.created).length, 2);
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM phone_challenges WHERE consumed_at IS NULL AND invalidated_at IS NULL")).rows[0].count), 1);
    });

    await t.test("a replacement invalidates an earlier browser and any active provider lease", async () => {
      await resetChallenges();
      const item = await sent();
      const reserved = reserve(item);
      assert.equal((await reserved.result).status, "reserved");
      const replacement = await create(challenge({ phone: item.phone, requestedRole: "talent" }));
      assert.equal((await repository.completePhoneChallengeVerification(item.id, reserved.lease, new Date(), session())).status, "invalid");
      assert.equal((await reserve(item).result).status, "invalid");
      assert.equal(await repository.markPhoneChallengeSent(replacement.id, replacement.codeHash), true);
      assert.equal((await repository.reservePhoneChallengeVerification(replacement.id, item.browserBindingHash, replacement.codeHash, new Date(), randomUUID(), 5)).status, "invalid");
      const next = reserve(replacement);
      assert.equal((await next.result).status, "reserved");
      const result = await repository.completePhoneChallengeVerification(replacement.id, next.lease, new Date(), session());
      assert.equal(result.status, "verified");
      if (result.status === "verified") assert.equal(result.session.user.role, "talent");
    });

    await t.test("a failed session insert rolls back consumption and identity creation", async () => {
      await resetChallenges();
      const item = await sent();
      const reserved = reserve(item);
      assert.equal((await reserved.result).status, "reserved");
      const duplicate = session();
      await pool.query("INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, active_role) VALUES ($1, $2, $3, $4, $5, 'client')",
        [duplicate.id, legacyId, duplicate.tokenHash, duplicate.createdAt, duplicate.expiresAt]);
      await assert.rejects(repository.completePhoneChallengeVerification(item.id, reserved.lease, new Date(), duplicate), { code: "23505" });
      assert.equal((await pool.query("SELECT id FROM users WHERE phone = $1", [item.phone])).rowCount, 0);
      const row = (await pool.query("SELECT consumed_at, verification_lease_id FROM phone_challenges WHERE id = $1", [item.id])).rows[0];
      assert.equal(row.consumed_at, null);
      assert.equal(row.verification_lease_id, reserved.lease);
      assert.equal((await repository.completePhoneChallengeVerification(item.id, reserved.lease, new Date(), session())).status, "verified");
    });

    await t.test("maintenance retention deletes expired old phone records and retains the rolling budget history", async () => {
      await resetChallenges();
      const oldTime = new Date(Date.now() - 9 * 86_400_000);
      const old = await create(challenge({ createdAt: oldTime, expiresAt: new Date(oldTime.getTime() + 300_000) }));
      const recent = await create();
      await repository.invalidatePhoneChallenge(recent.id);
      await pool.query(`SELECT * FROM ${schema}.run_data_retention_cleanup()`);
      assert.equal((await pool.query("SELECT id FROM phone_challenges WHERE id = $1", [old.id])).rowCount, 0);
      assert.equal((await pool.query("SELECT id FROM phone_challenges WHERE id = $1", [recent.id])).rowCount, 1);
    });
  } finally {
    await pool.end();
    if (schemaCreated) await owner.query(`DROP SCHEMA ${schema} CASCADE`);
    await owner.end();
  }
});
