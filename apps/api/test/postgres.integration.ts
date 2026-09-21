import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { OFFICIAL_OPENAI_BASE_URL, type AppConfig } from "../src/config.js";
import type { EmailSender } from "../src/email.js";
import { createDatabasePool, PostgresRepository } from "../src/postgresRepository.js";
import { DiscoveryStateConflictError } from "../src/repository.js";
import { createOpaqueToken } from "../src/security.js";
import { PostgresInquiryNotificationQueue, processInquiryNotification } from "../src/inquiryNotifications.js";
import { emptyMatchingConstraints, MatchingConflictError, type PublishMatchingInput } from "../src/matching.js";
import { MATCHING_EXAMPLES } from "../src/matchingExamples.js";
import type { DiscoveryKind, DiscoveryState } from "../src/domain.js";
import { matchingDiscoveryTurn, matchingDraftFixture } from "./matchingFixtures.js";

class CapturingEmailSender implements EmailSender {
  messages: Array<{ to: string; link: string; expiresInMinutes: number }> = [];

  async sendMagicLink(message: { to: string; link: string; expiresInMinutes: number }) {
    this.messages.push(message);
  }

  async close() {}
}

function firstCookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  assert.ok(value);
  return value.split(";", 1)[0];
}

async function signUpAndVerify(
  app: Awaited<ReturnType<typeof buildApp>>,
  emailSender: CapturingEmailSender,
  email: string,
  role: "client" | "talent",
  browserCookie?: string,
) {
  const messageIndex = emailSender.messages.length;
  const start = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/challenges",
    headers: browserCookie
      ? { origin: "https://app.example.com", cookie: browserCookie }
      : { origin: "https://app.example.com" },
    payload: { email, intent: "signup", role, returnTo: "/workspace" },
  });
  assert.equal(start.statusCode, 202);
  const boundBrowserCookie = firstCookie(start);
  const message = emailSender.messages[messageIndex];
  assert.ok(message);
  const token = new URLSearchParams(new URL(message.link).hash.slice(1)).get("token");
  assert.ok(token);
  const verified = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/verify",
    headers: { origin: "https://app.example.com", cookie: boundBrowserCookie },
    payload: { token },
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().authenticated, true);
  return { browserCookie: boundBrowserCookie, sessionCookie: firstCookie(verified) };
}

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = process.env.RUN_POSTGRES_TESTS === "true";
const grantScriptPath = fileURLToPath(new URL("../sql/grant-database-roles.sql", import.meta.url));

function integrationConfig(forDatabaseUrl: string): AppConfig {
  return {
    environment: "test",
    host: "127.0.0.1",
    port: 8787,
    databaseUrl: forDatabaseUrl,
    databaseSsl: false,
    webOrigin: "https://app.example.com",
    authTokenSecret: "integration-secret-that-is-longer-than-thirty-two-characters",
    authCookieName: "__Host-duduhire_session",
    authCookieSecure: true,
    sessionTtlDays: 30,
    magicLinkTtlMinutes: 15,
    emailResendSeconds: 30,
    emailHourlyLimit: 5,
    emailDeliveryMode: "console",
    emailFrom: "DuduHire <test@example.com>",
    aiMode: "local",
    openAiBaseUrl: OFFICIAL_OPENAI_BASE_URL,
    contactDataKey: "0123456789abcdef".repeat(4),
    contactDataKeyId: "contact-integration-v1",
    logLevel: "silent",
    trustProxy: false,
  };
}

function quoteGeneratedRole(role: string) {
  assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
  return `"${role}"`;
}

function databaseUrlForRole(ownerDatabaseUrl: string, role: string, password: string) {
  const url = new URL(ownerDatabaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

function applyDatabaseRoleGrants(
  ownerDatabaseUrl: string,
  databaseSsl: boolean,
  runtimeRole: string,
  maintenanceRole: string,
  notificationRole?: string,
) {
  const url = new URL(ownerDatabaseUrl);
  const databaseName = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  const username = decodeURIComponent(url.username);
  assert.ok(databaseName);
  assert.ok(username);
  const result = spawnSync("psql", [
    "--no-psqlrc",
    "--host", url.hostname,
    "--port", url.port || "5432",
    "--username", username,
    "--dbname", databaseName,
    "--set", `database_name=${databaseName}`,
    "--set", `runtime_role=${runtimeRole}`,
    "--set", `maintenance_role=${maintenanceRole}`,
    ...(notificationRole ? ["--set", `notification_role=${notificationRole}`] : []),
    "--file", grantScriptPath,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PGPASSWORD: decodeURIComponent(url.password),
      PGSSLMODE: databaseSsl ? "verify-full" : "disable",
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, [
    "The checked-in database role grant script failed.",
    result.stdout,
    result.stderr,
  ].filter(Boolean).join("\n"));
}

async function assertDatabasePermissionDenied(action: () => Promise<unknown>, operation: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.equal((error as { code?: string }).code, "42501", `${operation} must fail with insufficient_privilege.`);
    return true;
  });
}

test("PostgreSQL matching enforces runtime grants, bilateral privacy, consent, source invalidation and concurrent publication", {
  skip: !integrationEnabled,
}, async () => {
  assert.ok(databaseUrl);
  const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL?.trim() || databaseUrl;
  assert.match(new URL(ownerUrl).pathname, /_test$/u, "Matching integration requires a dedicated *_test database.");
  const databaseSsl = process.env.DATABASE_SSL === "true";
  const owner = createDatabasePool(ownerUrl, databaseSsl, "migration");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const runtimeRole = `matching_runtime_${suffix}`;
  const maintenanceRole = `matching_maintenance_${suffix}`;
  const password = randomBytes(24).toString("hex");
  const createdRoles: string[] = [];
  const userIds: string[] = [];
  const deletedAggregateIds: string[] = [];
  const emails: string[] = [];
  const exampleId = `example-integration-${suffix}`;
  let runtime: ReturnType<typeof createDatabasePool> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    for (const role of [runtimeRole, maintenanceRole]) {
      await owner.query(`CREATE ROLE ${quoteGeneratedRole(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      createdRoles.push(role);
    }
    applyDatabaseRoleGrants(ownerUrl, databaseSsl, runtimeRole, maintenanceRole);
    const runtimeUrl = databaseUrlForRole(ownerUrl, runtimeRole, password);
    runtime = createDatabasePool(runtimeUrl, databaseSsl);
    const repository = new PostgresRepository(runtime);
    await repository.ping();
    await assertDatabasePermissionDenied(() => runtime!.query("DELETE FROM matching_listings WHERE FALSE"), "runtime matching deletion");
    await assertDatabasePermissionDenied(() => runtime!.query("UPDATE matching_listings SET owner_user_id=owner_user_id WHERE FALSE"), "runtime matching owner change");
    await assertDatabasePermissionDenied(() => runtime!.query("UPDATE matching_listings SET kind=kind WHERE FALSE"), "runtime matching kind change");
    await assertDatabasePermissionDenied(() => runtime!.query("UPDATE matching_examples SET draft=draft WHERE FALSE"), "runtime example mutation");
    await assertDatabasePermissionDenied(() => runtime!.query("DELETE FROM matching_examples WHERE FALSE"), "runtime example deletion");
    const example = MATCHING_EXAMPLES.find((item) => item.kind === "capability")!;
    await owner.query("INSERT INTO matching_examples (id, kind, domain, draft, seed_version) VALUES ($1, $2, $3, $4::jsonb, 'integration')", [exampleId, example.kind, example.domain, JSON.stringify(example.draft)]);
    const maintenance = createDatabasePool(databaseUrlForRole(ownerUrl, maintenanceRole, password), databaseSsl);
    try {
      await assertDatabasePermissionDenied(() => maintenance.query("SELECT * FROM matching_listings"), "maintenance catalog access");
    } finally { await maintenance.end(); }
    const sender = new CapturingEmailSender();
    const config = { ...integrationConfig(runtimeUrl), databaseSsl };
    app = await buildApp({ config, repository, emailSender: sender });
    const createUser = async (role: "client" | "talent", label: string) => {
      const email = `matching-${label}-${suffix}@example.com`; emails.push(email);
      const auth = await signUpAndVerify(app!, sender, email, role);
      const row = await runtime!.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [email]);
      const id = row.rows[0]!.id; userIds.push(id);
      const kind: DiscoveryKind = role === "client" ? "problem" : "capability";
      const state = await repository.appendDiscoveryTurn(id, kind, matchingDiscoveryTurn(kind), new Date(), null);
      return { id, kind, state, headers: { origin: config.webOrigin, cookie: auth.sessionCookie } };
    };
    const client = await createUser("client", "client");
    const switched = await app.inject({ method: "POST", url: "/api/v1/auth/role", headers: client.headers, payload: { role: "talent" } });
    assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(switched.json().session.user.role, "talent");
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/auth/role", headers: client.headers, payload: { role: "client" } })).statusCode, 200);
    const talent = await createUser("talent", "talent");
    const legacySession = await runtime.query<{ active_role: string }>(
      "INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,NOW(),NOW()+INTERVAL '1 day') RETURNING active_role",
      [randomUUID(), talent.id, randomBytes(32).toString("hex")],
    );
    assert.equal(legacySession.rows[0]?.active_role, "talent", "Runtime legacy inserts preserve a talent's initial role.");
    const unrelated = await createUser("talent", "unrelated");
    const input = (state: DiscoveryState, expectedListingVersion = 0): PublishMatchingInput => ({
      ...matchingDraftFixture, expectedThreadId: state.thread.id, expectedVersion: state.thread.version, expectedListingVersion, consent: true,
    });
    const put = (user: typeof client, payload: PublishMatchingInput) => app!.inject({ method: "PUT", url: "/api/v1/me/matching/listing", headers: user.headers, payload });
    const state = (user: typeof client) => app!.inject({ method: "GET", url: "/api/v1/me/matching", headers: user.headers });
    const results = (user: typeof client) => app!.inject({ method: "GET", url: "/api/v1/me/matching/results", headers: user.headers });
    const withdraw = (user: typeof client, expectedListingId: string | null, expectedListingVersion: number) => app!.inject({ method: "POST", url: "/api/v1/me/matching/withdraw", headers: user.headers, payload: { expectedListingId, expectedListingVersion } });
    assert.equal((await state(client)).json().listing, null);
    assert.equal((await withdraw(client, null, 0)).statusCode, 200);
    assert.equal((await results(client)).statusCode, 409);
    const preview = await app.inject({ method: "POST", url: "/api/v1/me/matching/preview", headers: client.headers, payload: { draft: matchingDraftFixture } });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().catalog, "examples");
    assert.ok(preview.json().matches.some((item: { listing: { id: string; contactable: boolean } }) => item.listing.id === exampleId && item.listing.contactable === false));
    assert.equal((await state(client)).json().listing, null, "Example preview must not publish a real listing.");
    const beforeConsent = await app.inject({ method: "PUT", url: "/api/v1/me/matching/listing", headers: client.headers,
      payload: { ...input(client.state), consent: false } });
    assert.equal(beforeConsent.statusCode, 400);
    assert.equal((await put(client, input(talent.state))).statusCode, 409, "Cannot publish another account's source thread.");
    await assert.rejects(repository.publishMatchingListing(client.id, "capability", input(client.state), new Date()),
      MatchingConflictError);
    const constraints = { ...emptyMatchingConstraints(), languages: ["英语"], budgetMax: 50000, budgetCurrency: "CNY" as const, budgetPeriod: "project" as const, weeklyHours: 20 };
    const clientPublication = await put(client, { ...input(client.state), skills: ["知识库", "系统集成", "模型评估"], constraints });
    assert.equal(clientPublication.statusCode, 200, clientPublication.body);
    assert.equal(clientPublication.json().listing.active, true);
    assert.deepEqual(clientPublication.json().listing.constraints, constraints);
    assert.deepEqual((await state(client)).json().listing.constraints, constraints, "Optional constraints survive a database round trip.");
    assert.equal((await results(client)).json().total, 0, "Confirmed but unpublished discovery is absent from the catalog.");
    const talentPublication = await put(talent, input(talent.state));
    assert.equal(talentPublication.statusCode, 200, talentPublication.body);
    const clientListingId = clientPublication.json().listing.id as string;
    const talentListingId = talentPublication.json().listing.id as string;
    const wrongListingWithdrawal = await withdraw(talent, clientListingId, 1);
    assert.equal(wrongListingWithdrawal.statusCode, 409, "A stale other-account publication with the same version must be rejected.");
    assert.equal((await state(talent)).json().listing.active, true);
    assert.equal((await state(talent)).json().listing.version, 1);
    const unrelatedPublication = await put(unrelated, { ...input(unrelated.state), skills: ["UI设计"] });
    assert.equal(unrelatedPublication.statusCode, 200, unrelatedPublication.body);
    for (const user of [client, talent]) {
      const response = await results(user);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().total, 1);
      assert.equal(response.json().matches.length, 1);
      assert.equal(response.json().catalog, "published");
      assert.ok(response.json().matches.every((item: { listing: { isExample?: boolean } }) => item.listing.isExample !== true));
      assert.doesNotMatch(response.body, /ownerUserId|sourceThread|PRIVATE_|private-evidence|example\.com/u);
      for (const ownerId of userIds) assert.ok(!response.body.includes(ownerId));
    }
    assert.equal((await results(unrelated)).json().total, 0, "Candidates must share a declared skill.");
    const mandatory = await put(client, { ...input(client.state, 1), skills: ["知识库", "系统集成", "后端开发"], requiredSkills: ["后端开发"] });
    assert.equal(mandatory.statusCode, 200, mandatory.body);
    assert.equal((await results(client)).json().total, 0);
    assert.equal((await results(talent)).json().total, 0, "Mandatory problem skills also apply when talent searches for problems.");
    assert.equal((await put(client, input(client.state, 2))).statusCode, 200);
    const race = await Promise.all([put(talent, input(talent.state, 1)), put(talent, input(talent.state, 1))]);
    assert.deepEqual(race.map((response) => response.statusCode).sort(), [200, 409]);
    assert.equal((await state(talent)).json().listing.version, 2);
    assert.equal((await withdraw(talent, talentListingId, 1)).statusCode, 409);
    assert.equal((await withdraw(talent, talentListingId, 2)).json().listing.version, 3);
    assert.equal((await withdraw(talent, talentListingId, 3)).json().listing.version, 3, "Withdrawing a current withdrawn version is idempotent.");
    assert.equal((await results(client)).json().total, 0);
    assert.equal((await results(talent)).json().error.code, "MATCHING_NOT_PUBLISHED");
    assert.equal((await put(talent, input(talent.state, 3))).statusCode, 200);
    const revision = await Promise.allSettled([
      repository.appendDiscoveryTurn(talent.id, talent.kind, matchingDiscoveryTurn(talent.kind, false), new Date(), {
        threadId: talent.state.thread.id, threadVersion: talent.state.thread.version,
      }),
      repository.publishMatchingListing(talent.id, talent.kind, input(talent.state, 4), new Date()),
    ]);
    assert.equal(revision[0]?.status, "fulfilled");
    const concurrentPublication = revision[1];
    assert.ok(concurrentPublication?.status === "fulfilled" || concurrentPublication?.reason instanceof MatchingConflictError);
    const afterRevision = (await state(talent)).json();
    assert.equal(afterRevision.listing.active, false);
    assert.equal(afterRevision.source.confirmed, false);
    assert.equal((await results(client)).json().total, 0);
    const revised = await repository.readDiscovery(talent.id, talent.kind); assert.ok(revised);
    const reconfirmed = await repository.appendDiscoveryTurn(talent.id, talent.kind, matchingDiscoveryTurn(talent.kind), new Date(), {
      threadId: revised.thread.id, threadVersion: revised.thread.version,
    });
    assert.equal((await state(talent)).json().listing.active, false, "Reconfirmation must not silently grant consent to publish a newer source.");
    assert.equal((await put(talent, input(reconfirmed, afterRevision.listing.version))).statusCode, 200);
    assert.equal((await results(client)).json().total, 1);
    await repository.resetDiscovery(talent.id, talent.kind, new Date(), { threadId: reconfirmed.thread.id, threadVersion: reconfirmed.thread.version });
    assert.equal((await state(talent)).json().listing.active, false);
    assert.equal((await results(client)).json().total, 0);
    const archivedListing = await repository.readMatchingListing(talent.id, talent.kind); assert.ok(archivedListing);
    deletedAggregateIds.push(archivedListing.id, reconfirmed.thread.id);
    await owner.query("DELETE FROM discovery_threads WHERE id=$1 AND status='archived'", [reconfirmed.thread.id]);
    assert.equal(await repository.readMatchingListing(talent.id, talent.kind), null, "Retention deletion of an archived thread cascades to its consented publication.");
    const catalog = await owner.query<{ source_artifact_version: number; source_thread_version: number; consented_at: Date }>(
      "SELECT source_artifact_version, source_thread_version, consented_at FROM matching_listings WHERE owner_user_id=$1", [client.id]);
    assert.equal(catalog.rows[0]?.source_artifact_version, client.state.artifact?.version);
    assert.equal(catalog.rows[0]?.source_thread_version, client.state.thread.version);
    assert.ok(catalog.rows[0]?.consented_at instanceof Date);
  } finally {
    if (app) await app.close(); else await runtime?.end();
    try {
      await owner.query("DELETE FROM matching_examples WHERE id=$1", [exampleId]);
      await owner.query(`DELETE FROM outbox_events WHERE aggregate_id IN (
        SELECT id FROM matching_listings WHERE owner_user_id=ANY($1::uuid[])
        UNION ALL SELECT id FROM discovery_threads WHERE owner_user_id=ANY($1::uuid[])
        UNION ALL SELECT unnest($2::uuid[]))`, [userIds, deletedAggregateIds]);
      await owner.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
      await owner.query("DELETE FROM email_challenges WHERE email=ANY($1::text[])", [emails]);
      for (const role of createdRoles.reverse()) {
        await owner.query(`DROP OWNED BY ${quoteGeneratedRole(role)}`);
        await owner.query(`DROP ROLE ${quoteGeneratedRole(role)}`);
      }
    } finally { await owner.end(); }
  }
});

test("inquiry operations enforce DB roles, audited contact access, optimistic concurrency and notification leases", {
  skip: !integrationEnabled,
}, async () => {
  assert.ok(databaseUrl);
  const ownerDatabaseUrl = process.env.TEST_DATABASE_ADMIN_URL?.trim() || databaseUrl;
  assert.match(new URL(ownerDatabaseUrl).pathname, /_test$/u, "Notification tests require a dedicated empty *_test database.");
  const databaseSsl = process.env.DATABASE_SSL === "true";
  const owner = createDatabasePool(ownerDatabaseUrl, databaseSsl, "migration");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const runtimeRole = `inquiry_runtime_${suffix}`;
  const maintenanceRole = `inquiry_maintenance_${suffix}`;
  const notificationRole = `inquiry_notification_${suffix}`;
  const roles = [runtimeRole, maintenanceRole, notificationRole];
  const createdRoles: string[] = [];
  const password = randomBytes(24).toString("hex");
  const adminId = randomUUID();
  const adminEmail = `inquiry-admin-${suffix}@example.com`;
  const inquiryIds: string[] = [];
  let runtime: ReturnType<typeof createDatabasePool> | undefined;
  let notifications: ReturnType<typeof createDatabasePool> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const pending = await owner.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM public.outbox_events
      WHERE event_type = 'enterprise_inquiry.created' AND published_at IS NULL AND dead_lettered_at IS NULL`);
    assert.equal(pending.rows[0]?.count, "0", "Refusing to claim another task's pending notifications.");
    for (const role of roles) {
      await owner.query(`CREATE ROLE ${quoteGeneratedRole(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      createdRoles.push(role);
    }
    applyDatabaseRoleGrants(ownerDatabaseUrl, databaseSsl, runtimeRole, maintenanceRole, notificationRole);
    runtime = createDatabasePool(databaseUrlForRole(ownerDatabaseUrl, runtimeRole, password), databaseSsl);
    notifications = createDatabasePool(databaseUrlForRole(ownerDatabaseUrl, notificationRole, password), databaseSsl);
    const repository = new PostgresRepository(runtime);
    await repository.ping();
    for (const table of ["users", "sessions", "enterprise_inquiries", "inquiry_audit_events", "outbox_events", "matching_listings"]) {
      await assertDatabasePermissionDenied(() => notifications!.query(`SELECT * FROM public.${table} LIMIT 1`), `notification SELECT on ${table}`);
    }
    await assertDatabasePermissionDenied(() => notifications!.query("SELECT * FROM public.admin_reveal_inquiry_contact($1,$2,$3,$4)", [randomUUID(), adminId, randomUUID(), "Test isolation"]), "notification contact access");
    await assertDatabasePermissionDenied(() => runtime!.query("SELECT * FROM public.claim_inquiry_notification($1)", [randomUUID()]), "runtime notification claim");
    await assertDatabasePermissionDenied(() => runtime!.query("SELECT contact_ciphertext FROM public.enterprise_inquiries LIMIT 1"), "runtime direct contact access");
    await assertDatabasePermissionDenied(() => runtime!.query("DELETE FROM public.inquiry_audit_events WHERE FALSE"), "runtime audit deletion");

    await owner.query("INSERT INTO public.users(id,email,role,email_verified_at) VALUES($1,$2,'client',NOW())", [adminId, adminEmail]);
    const config = { ...integrationConfig(databaseUrlForRole(ownerDatabaseUrl, runtimeRole, password)), databaseSsl, adminUserIds: [adminId] };
    const sender = new CapturingEmailSender();
    app = await buildApp({ config, repository, emailSender: sender });
    const auth = await signUpAndVerify(app, sender, adminEmail, "client");
    const headers = { origin: config.webOrigin, cookie: auth.sessionCookie };
    const createInquiry = async () => {
      const id = randomUUID(); inquiryIds.push(id);
      const response = await app!.inject({ method: "POST", url: "/api/v1/enterprise/inquiries", headers,
        payload: { requestId: id, method: "phone", contactValue: "13800000000", source: "pricing_page" } });
      assert.equal(response.statusCode, 202, response.body);
      return id;
    };
    const inquiryId = await createInquiry();
    const list = await app.inject({ method: "GET", url: "/api/v1/admin/inquiries", headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().items[0].id, inquiryId);
    assert.equal(list.json().items[0].notificationStatus, "pending");
    assert.doesNotMatch(list.body, /13800000000|contact_ciphertext|contactHash|encryptionKeyId/u);
    const updates = await Promise.all(["contacted", "closed"].map((status) => app!.inject({
      method: "PATCH", url: `/api/v1/admin/inquiries/${inquiryId}`, headers, payload: { status, expectedVersion: 1 },
    })));
    assert.deepEqual(updates.map((response) => response.statusCode).sort(), [200, 409]);
    const reveal = await app.inject({ method: "POST", url: `/api/v1/admin/inquiries/${inquiryId}/reveal-contact`, headers,
      payload: { reason: "Respond to requested consultation" } });
    assert.equal(reveal.statusCode, 200, reveal.body);
    assert.deepEqual(reveal.json(), { contactMethod: "phone", contactValue: "13800000000" });
    assert.equal(reveal.headers["cache-control"], "no-store");
    const audit = await owner.query<{ action: string; actor_user_id: string; reason: string | null }>(
      "SELECT action, actor_user_id, reason FROM public.inquiry_audit_events WHERE inquiry_id=$1 ORDER BY created_at", [inquiryId]);
    assert.equal(audit.rows.length, 2);
    assert.equal(audit.rows[0]?.action, "status_changed");
    assert.equal(audit.rows[1]?.action, "contact_revealed");
    assert.ok(audit.rows.every((row) => row.actor_user_id === adminId));
    assert.doesNotMatch(JSON.stringify(audit.rows), /13800000000/u);

    const queue = new PostgresInquiryNotificationQueue(notifications);
    const token = randomUUID();
    const claimed = await queue.claim(token);
    assert.ok(claimed);
    assert.equal(claimed.inquiryId, inquiryId);
    assert.deepEqual(Object.keys(claimed).sort(), ["eventId", "inquiryId", "source", "attemptCount"].sort());
    assert.equal(await queue.claim(randomUUID()), null, "Another worker cannot claim an active lease.");
    assert.equal(await queue.finish(claimed.eventId, randomUUID(), true), false, "An incorrect lease cannot acknowledge delivery.");
    assert.equal(await queue.finish(claimed.eventId, token, false), true);
    assert.equal(await queue.claim(randomUUID()), null, "Backoff prevents immediate retries.");
    await owner.query("UPDATE public.outbox_events SET available_at=NOW() WHERE id=$1", [claimed.eventId]);
    const expiredToken = randomUUID();
    assert.equal((await queue.claim(expiredToken))?.attemptCount, 2);
    await owner.query("UPDATE public.outbox_events SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [claimed.eventId]);
    const takeoverToken = randomUUID();
    assert.equal((await queue.claim(takeoverToken))?.attemptCount, 3);
    assert.equal(await queue.finish(claimed.eventId, expiredToken, true), false, "A stale lease cannot publish after takeover.");
    assert.equal(await queue.finish(claimed.eventId, takeoverToken, false), true);
    await owner.query("UPDATE public.outbox_events SET available_at=NOW() WHERE id=$1", [claimed.eventId]);
    let delivered = 0;
    const processed = await processInquiryNotification(queue, { async send() { delivered += 1; }, async close() {} });
    assert.equal(processed.status, "sent");
    assert.equal(delivered, 1);
    const persistedSent = await owner.query<{ notification_status: string }>("SELECT notification_status FROM public.enterprise_inquiries WHERE id=$1", [inquiryId]);
    assert.equal(persistedSent.rows[0]?.notification_status, "sent");

    const exhaustedId = await createInquiry();
    await owner.query("UPDATE public.outbox_events SET attempt_count=7 WHERE aggregate_id=$1", [exhaustedId]);
    await processInquiryNotification(queue, { async send() { throw new Error("SMTP error with private@example.com"); }, async close() {} });
    const exhausted = await owner.query<{ attempt_count: number; dead_lettered_at: Date; last_error: string }>(
      "SELECT attempt_count,dead_lettered_at,last_error FROM public.outbox_events WHERE aggregate_id=$1", [exhaustedId]);
    assert.equal(exhausted.rows[0]?.attempt_count, 8);
    assert.ok(exhausted.rows[0]?.dead_lettered_at);
    assert.equal(exhausted.rows[0]?.last_error, "SMTP_DELIVERY_FAILED");
    assert.equal(await queue.claim(randomUUID()), null);

    const crashId = await createInquiry();
    await owner.query("UPDATE public.outbox_events SET attempt_count=8,lease_token=$2,lease_expires_at=NOW()-INTERVAL '1 second' WHERE aggregate_id=$1", [crashId, randomUUID()]);
    assert.equal(await queue.claim(randomUUID()), null);
    const failed = await owner.query<{ notification_status: string }>("SELECT notification_status FROM public.enterprise_inquiries WHERE id=ANY($1::uuid[])", [[exhaustedId, crashId]]);
    assert.ok(failed.rows.every((row) => row.notification_status === "failed"));

    const lockedId = await createInquiry();
    const lockClient = await owner.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 FOR UPDATE", [lockedId]);
      assert.equal(await queue.claim(randomUUID()), null, "SKIP LOCKED must avoid blocking on an event held by another transaction.");
    } finally { await lockClient.query("ROLLBACK"); lockClient.release(); }
    const releasedToken = randomUUID();
    const released = await queue.claim(releasedToken);
    assert.equal(released?.inquiryId, lockedId);
    assert.ok(released);
    assert.equal(await queue.finish(released.eventId, releasedToken, true), true);
  } finally {
    if (app) await app.close(); else await runtime?.end();
    await notifications?.end();
    try {
      await owner.query("DELETE FROM public.inquiry_audit_events WHERE inquiry_id=ANY($1::uuid[])", [inquiryIds]);
      await owner.query("DELETE FROM public.outbox_events WHERE aggregate_id=ANY($1::uuid[])", [inquiryIds]);
      await owner.query("DELETE FROM public.enterprise_inquiries WHERE id=ANY($1::uuid[])", [inquiryIds]);
      await owner.query("DELETE FROM public.users WHERE id=$1", [adminId]);
      await owner.query("DELETE FROM public.email_challenges WHERE email=$1", [adminEmail]);
      for (const role of createdRoles.reverse()) {
        await owner.query(`DROP OWNED BY ${quoteGeneratedRole(role)}`);
        await owner.query(`DROP ROLE ${quoteGeneratedRole(role)}`);
      }
    } finally { await owner.end(); }
  }
});

test("PostgreSQL persists authentication, marketplace workflows, encrypted contacts, and exact idempotency", {
  skip: !integrationEnabled,
}, async () => {
  assert.ok(databaseUrl);
  const databaseName = new URL(databaseUrl).pathname.split("/").filter(Boolean).at(-1) ?? "";
  assert.match(databaseName, /(?:_test|_validation)$/u, "Integration tests require a dedicated *_test or *_validation database.");
  const unique = randomUUID();
  const email = `client-${unique}@example.com`;
  const talentEmail = `talent-${unique}@example.com`;
  const limitedEmail = `limited-${unique}@example.com`;
  const intakePrompt = `integration intake ${unique}`;
  const discoveryRequestId = randomUUID();
  const talentDiscoveryRequestId = randomUUID();
  const inquiryId = randomUUID();
  const profileContact = `wx-${unique}`;
  let intakeId: string | undefined;
  let clientUserId: string | undefined;
  let talentUserId: string | undefined;
  let clientThreadId: string | undefined;
  let talentThreadId: string | undefined;
  const pool = createDatabasePool(databaseUrl, process.env.DATABASE_SSL === "true");
  const repository = new PostgresRepository(pool);
  const emailSender = new CapturingEmailSender();
  const config = integrationConfig(databaseUrl);
  const app = await buildApp({ config, repository, emailSender });

  try {
    const browserProbe = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
    assert.equal(browserProbe.statusCode, 200);
    const browserCookie = firstCookie(browserProbe);
    const intake = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/intakes",
      headers: { origin: config.webOrigin, cookie: browserCookie },
      payload: { prompt: intakePrompt },
    });
    assert.equal(intake.statusCode, 201);
    intakeId = intake.json().intakeId as string;

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email/challenges",
      headers: { origin: config.webOrigin, cookie: browserCookie },
      payload: { email, intent: "signup", role: "client", returnTo: "/workspace?tab=profile" },
    });
    assert.equal(start.statusCode, 202);
    assert.equal(firstCookie(start), browserCookie);
    const token = new URLSearchParams(new URL(emailSender.messages[0]!.link).hash.slice(1)).get("token");
    assert.ok(token);

    await pool.query("UPDATE email_challenges SET created_at = created_at - INTERVAL '31 seconds' WHERE email = $1", [email]);
    const otherBrowserStart = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email/challenges",
      headers: { origin: config.webOrigin },
      payload: { email, intent: "signup", role: "talent", returnTo: "/workspace" },
    });
    assert.equal(otherBrowserStart.statusCode, 202);
    const otherBrowserCookie = firstCookie(otherBrowserStart);

    const wrongBrowser = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email/verify",
      headers: { origin: config.webOrigin, cookie: `__Host-duduhire_auth_intent=${createOpaqueToken()}` },
      payload: { token },
    });
    assert.equal(wrongBrowser.statusCode, 400);

    const verified = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email/verify",
      headers: { origin: config.webOrigin, cookie: browserCookie },
      payload: { token },
    });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.json().authenticated, true, "A challenge from another browser must not invalidate the original browser's link.");
    const sessionCookie = firstCookie(verified);

    const authenticatedSession = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: sessionCookie } });
    assert.equal(authenticatedSession.statusCode, 200);
    assert.equal(authenticatedSession.json().session.user.role, "client");
    clientUserId = authenticatedSession.json().session.user.id as string;

    const wrongIntakeClaim = await app.inject({
      method: "POST",
      url: `/api/v1/me/discovery/intakes/${intakeId}/claim`,
      headers: { origin: config.webOrigin, cookie: `${sessionCookie}; ${otherBrowserCookie}` },
    });
    assert.equal(wrongIntakeClaim.statusCode, 404);

    const claimedIntake = await app.inject({
      method: "POST",
      url: `/api/v1/me/discovery/intakes/${intakeId}/claim`,
      headers: { origin: config.webOrigin, cookie: `${sessionCookie}; ${browserCookie}` },
    });
    assert.equal(claimedIntake.statusCode, 200);
    assert.deepEqual(claimedIntake.json(), { prompt: intakePrompt });
    const intakeRow = await pool.query<{ claimed_by_user_id: string; claimed_at: Date | null }>(
      "SELECT claimed_by_user_id, claimed_at FROM intake_drafts WHERE id = $1",
      [intakeId],
    );
    assert.equal(intakeRow.rows[0]?.claimed_by_user_id, clientUserId);
    assert.ok(intakeRow.rows[0]?.claimed_at);

    const replayedIntake = await app.inject({
      method: "POST",
      url: `/api/v1/me/discovery/intakes/${intakeId}/claim`,
      headers: { origin: config.webOrigin, cookie: `${sessionCookie}; ${browserCookie}` },
    });
    assert.equal(replayedIntake.statusCode, 404);

    const profileValue = {
      displayName: "集成测试用户",
      countryCode: "CN",
      contact: profileContact,
      organization: "测试组织",
      jobTitle: "负责人",
      professionalTitle: "",
      bio: "PostgreSQL 持久化验证。",
      version: 0,
    };
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/me/profile",
      headers: { origin: config.webOrigin, cookie: sessionCookie },
      payload: profileValue,
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().profile.contact, profileContact);
    const profileRow = await pool.query<{ contact: string }>("SELECT contact FROM profiles WHERE user_id = $1", [clientUserId]);
    assert.match(profileRow.rows[0]?.contact ?? "", /^v2\./u);
    assert.notEqual(profileRow.rows[0]?.contact, profileContact);
    const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: sessionCookie } });
    assert.equal(session.json().session.profile.displayName, profileValue.displayName);
    assert.equal(session.json().session.profile.contact, profileContact);

    const clientDiscovery = await app.inject({
      method: "POST",
      url: "/api/v1/me/discovery/turns",
      headers: { origin: config.webOrigin, cookie: sessionCookie },
      payload: {
        requestId: discoveryRequestId,
        prompt: "销售线索已经进入 CRM，但团队仍会漏掉后续跟进。",
        attachments: [{
          name: "current-process.txt",
          contentType: "text/plain",
          sizeBytes: 36,
          textExcerpt: "线索由销售手动登记，缺少自动提醒。",
        }],
      },
    });
    assert.equal(clientDiscovery.statusCode, 200);
    assert.equal(clientDiscovery.json().discovery.kind, "problem");
    assert.equal(clientDiscovery.json().discovery.turns.length, 1);
    assert.equal(clientDiscovery.json().discovery.artifact.draft.kind, "problem_brief");
    clientThreadId = clientDiscovery.json().discovery.threadId as string;

    const repeatedClientDiscovery = await app.inject({
      method: "POST",
      url: "/api/v1/me/discovery/turns",
      headers: { origin: config.webOrigin, cookie: sessionCookie },
      payload: {
        requestId: discoveryRequestId,
        prompt: "同一幂等键不应创建第二轮。",
        attachments: [],
      },
    });
    assert.equal(repeatedClientDiscovery.statusCode, 200);
    assert.equal(repeatedClientDiscovery.json().discovery.turns.length, 1);
    const persistedClientTurn = await pool.query<{
      turn_count: string;
      provider: string;
      model: string;
      prompt_version: string;
      attachments: unknown;
    }>(
      `SELECT COUNT(*) OVER ()::text AS turn_count,
              provider, model, prompt_version, attachments
         FROM discovery_turns
        WHERE thread_id = $1
          AND request_id = $2`,
      [clientThreadId, discoveryRequestId],
    );
    assert.equal(persistedClientTurn.rows[0]?.turn_count, "1");
    assert.equal(persistedClientTurn.rows[0]?.provider, "local");
    assert.ok(persistedClientTurn.rows[0]?.model);
    assert.ok(persistedClientTurn.rows[0]?.prompt_version);
    assert.deepEqual(persistedClientTurn.rows[0]?.attachments, [
      { name: "current-process.txt", mediaType: "text/plain", size: 36 },
    ]);

    const clientWorkspace = await app.inject({
      method: "GET",
      url: "/api/v1/me/workspace",
      headers: { cookie: sessionCookie },
    });
    assert.equal(clientWorkspace.statusCode, 200);
    assert.equal(clientWorkspace.json().role, "client");
    assert.equal(clientWorkspace.json().emailVerified, true);
    assert.equal(clientWorkspace.json().discoveryKind, "problem");
    assert.equal(clientWorkspace.json().discoveryCompleted, false);
    assert.equal(clientWorkspace.json().activeThreadId, clientThreadId);
    assert.equal(clientWorkspace.json().turnCount, 1);
    assert.equal(clientWorkspace.json().artifactVersion, 1);

    // Persistence must distinguish an AI-produced draft from explicit confirmation
    // and must not force users to discard their history after eight turns.
    for (let index = 2; index <= 9; index += 1) {
      const before = await repository.readDiscovery(clientUserId, "problem");
      assert.ok(before);
      await repository.appendDiscoveryTurn(clientUserId, "problem", {
        requestId: randomUUID(), question: `补充需求 ${index}`, answer: "已更新当前需求草稿。",
        attachments: [], analysisContext: "", provider: "local", model: "persistence-integration", promptVersion: "test.v2",
        artifactDraft: {
          kind: "problem_brief", diagnosis: "减少重复答疑", action: "整理可查询制度", profile: "业务资料整理与工具实施",
          evidence: ["用户陈述"], flow: { status: index === 9 ? "confirmed" : "ready", confirmedAt: index === 9 ? new Date().toISOString() : null },
        },
      }, new Date(), { threadId: before.thread.id, threadVersion: before.thread.version });
    }
    const confirmed = await repository.readDiscovery(clientUserId, "problem");
    assert.ok(confirmed);
    assert.equal(confirmed.turns.length, 9);
    assert.equal(confirmed.artifact?.version, 9);
    assert.equal((await repository.readWorkspaceSummary(clientUserId, "client")).discoveryCompleted, true);
    assert.match(confirmed.turns[0]?.analysisContext ?? "", /缺少自动提醒/u);
    await assert.rejects(repository.resetDiscovery(clientUserId, "problem", new Date(), {
      threadId: confirmed.thread.id, threadVersion: clientDiscovery.json().discovery.version,
    }), DiscoveryStateConflictError);

    const revisedInput = {
      requestId: randomUUID(), question: "把合作方式改成短期项目", answer: "已修改，请重新确认当前版本。",
      attachments: [], analysisContext: "", provider: "local", model: "persistence-integration", promptVersion: "test.v2",
      artifactDraft: { kind: "problem_brief", flow: { status: "ready", confirmedAt: null } },
    };
    const expectedRevision = { threadId: confirmed.thread.id, threadVersion: confirmed.thread.version };
    const concurrentRevisions = await Promise.allSettled([
      repository.appendDiscoveryTurn(clientUserId, "problem", revisedInput, new Date(), expectedRevision),
      repository.appendDiscoveryTurn(clientUserId, "problem", { ...revisedInput, requestId: randomUUID() }, new Date(), expectedRevision),
    ]);
    assert.equal(concurrentRevisions.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedRevision = concurrentRevisions.find((result) => result.status === "rejected");
    assert.ok(rejectedRevision?.status === "rejected" && rejectedRevision.reason instanceof DiscoveryStateConflictError);
    assert.equal((await repository.readWorkspaceSummary(clientUserId, "client")).discoveryCompleted, false);
    const revised = await repository.readDiscovery(clientUserId, "problem");
    assert.equal(revised?.turns.length, 10);
    assert.equal(revised?.artifact?.version, 10);

    const inquiryContact = "+86 138 0000 0000";
    const inquiry = await app.inject({
      method: "POST",
      url: "/api/v1/enterprise/inquiries",
      headers: { origin: config.webOrigin, cookie: sessionCookie },
      payload: { requestId: inquiryId, method: "phone", contactValue: inquiryContact, source: "home_pricing" },
    });
    assert.equal(inquiry.statusCode, 202);
    const inquiryReplay = await app.inject({
      method: "POST",
      url: "/api/v1/enterprise/inquiries",
      headers: { origin: config.webOrigin, cookie: sessionCookie },
      payload: { requestId: inquiryId, method: "phone", contactValue: inquiryContact, source: "home_pricing" },
    });
    assert.equal(inquiryReplay.statusCode, 202);
    const persistedInquiry = await pool.query<{
      row_count: string;
      user_id: string | null;
      contact_ciphertext: string;
      contact_hash: string;
      encryption_key_id: string;
    }>(
      `SELECT COUNT(*) OVER ()::text AS row_count, user_id, contact_ciphertext,
              contact_hash, encryption_key_id
         FROM enterprise_inquiries
        WHERE id = $1`,
      [inquiryId],
    );
    assert.equal(persistedInquiry.rows[0]?.row_count, "1");
    assert.equal(persistedInquiry.rows[0]?.user_id, clientUserId);
    assert.match(persistedInquiry.rows[0]?.contact_ciphertext ?? "", /^v2\./u);
    assert.notEqual(persistedInquiry.rows[0]?.contact_ciphertext, inquiryContact);
    assert.doesNotMatch(persistedInquiry.rows[0]?.contact_ciphertext ?? "", /138 0000 0000/u);
    assert.match(persistedInquiry.rows[0]?.contact_hash ?? "", /^[0-9a-f]{64}$/u);
    assert.equal(persistedInquiry.rows[0]?.encryption_key_id, config.contactDataKeyId);
    const inquiryOutbox = await pool.query<{ event_count: string }>(
      `SELECT COUNT(*)::text AS event_count
         FROM outbox_events
        WHERE aggregate_id = $1
          AND event_type = 'enterprise_inquiry.created'`,
      [inquiryId],
    );
    assert.equal(inquiryOutbox.rows[0]?.event_count, "1");

    const firstTalent = await signUpAndVerify(app, emailSender, talentEmail, "talent");
    const firstTalentSession = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: firstTalent.sessionCookie },
    });
    talentUserId = firstTalentSession.json().session.user.id as string;
    assert.equal(firstTalentSession.json().session.user.role, "talent");

    await pool.query("UPDATE email_challenges SET created_at = created_at - INTERVAL '31 seconds' WHERE email = $1", [talentEmail]);
    const attemptedRoleChange = await signUpAndVerify(app, emailSender, talentEmail, "client");
    const fixedTalentSession = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: attemptedRoleChange.sessionCookie },
    });
    assert.equal(fixedTalentSession.json().session.user.id, talentUserId);
    assert.equal(fixedTalentSession.json().session.user.role, "talent");
    const talentRoleRow = await pool.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [talentUserId]);
    assert.equal(talentRoleRow.rows[0]?.role, "talent");

    const talentDiscovery = await app.inject({
      method: "POST",
      url: "/api/v1/me/discovery/turns",
      headers: { origin: config.webOrigin, cookie: attemptedRoleChange.sessionCookie },
      payload: {
        requestId: talentDiscoveryRequestId,
        prompt: "我主导过 AI 客服知识库和工单自动化项目。",
        attachments: [],
      },
    });
    assert.equal(talentDiscovery.statusCode, 200);
    assert.equal(talentDiscovery.json().discovery.kind, "capability");
    assert.equal(talentDiscovery.json().discovery.artifact.draft.kind, "capability_identity");
    talentThreadId = talentDiscovery.json().discovery.threadId as string;
    const talentThreadRow = await pool.query<{ kind: string; owner_user_id: string }>(
      "SELECT kind, owner_user_id FROM discovery_threads WHERE id = $1",
      [talentThreadId],
    );
    assert.deepEqual(talentThreadRow.rows[0], { kind: "capability", owner_user_id: talentUserId });

    const resetClient = await app.inject({
      method: "POST",
      url: "/api/v1/me/discovery/reset",
      headers: { origin: config.webOrigin, cookie: sessionCookie },
    });
    assert.equal(resetClient.statusCode, 200);
    assert.equal(resetClient.json().discovery.kind, "problem");
    assert.equal(resetClient.json().discovery.threadId, null);
    assert.deepEqual(resetClient.json().discovery.turns, []);
    const archivedClientThread = await pool.query<{ status: string }>(
      "SELECT status FROM discovery_threads WHERE id = $1",
      [clientThreadId],
    );
    assert.equal(archivedClientThread.rows[0]?.status, "archived");
    const clientWorkspaceAfterReset = await app.inject({
      method: "GET",
      url: "/api/v1/me/workspace",
      headers: { cookie: sessionCookie },
    });
    assert.equal(clientWorkspaceAfterReset.json().discoveryCompleted, false);
    assert.equal(clientWorkspaceAfterReset.json().activeThreadId, null);
    assert.equal(clientWorkspaceAfterReset.json().turnCount, 0);
    const workflowOutbox = await pool.query<{ aggregate_id: string; event_count: string }>(
      `SELECT aggregate_id::text, COUNT(*)::text AS event_count
         FROM outbox_events
        WHERE aggregate_id = ANY($1::uuid[])
        GROUP BY aggregate_id`,
      [[intakeId, clientThreadId, talentThreadId]],
    );
    const outboxCountByAggregate = new Map(workflowOutbox.rows.map((row) => [row.aggregate_id, row.event_count]));
    assert.equal(outboxCountByAggregate.get(intakeId), "2");
    assert.equal(outboxCountByAggregate.get(clientThreadId), "11");
    assert.equal(outboxCountByAggregate.get(talentThreadId), "1");

    const parallel = await Promise.all(Array.from({ length: 8 }, () => app.inject({
      method: "POST",
      url: "/api/v1/auth/email/challenges",
      headers: { origin: config.webOrigin },
      payload: { email: limitedEmail, intent: "signup", role: "talent", returnTo: "/workspace" },
    })));
    assert.equal(parallel.filter((response) => response.statusCode === 202).length, 1);
    assert.equal(parallel.filter((response) => response.statusCode === 429).length, 7);
    assert.ok(parallel.filter((response) => response.statusCode === 429).every((response) => Number(response.headers["retry-after"]) >= 1));

    await repository.ping();
  } finally {
    try {
      const cleanupEmails = [email, talentEmail, limitedEmail];
      const persistedUsers = await pool.query<{ id: string }>(
        "SELECT id FROM users WHERE email = ANY($1::text[])",
        [cleanupEmails],
      );
      const cleanupUserIds = [...new Set([
        ...persistedUsers.rows.map((row) => row.id),
        ...[clientUserId, talentUserId].filter((value): value is string => Boolean(value)),
      ])];
      const persistedIntakes = await pool.query<{ id: string }>(
        "SELECT id FROM intake_drafts WHERE prompt = $1",
        [intakePrompt],
      );
      const cleanupIntakeIds = [...new Set([
        ...persistedIntakes.rows.map((row) => row.id),
        ...[intakeId].filter((value): value is string => Boolean(value)),
      ])];
      const persistedThreads = cleanupUserIds.length > 0
        ? await pool.query<{ id: string }>(
            "SELECT id FROM discovery_threads WHERE owner_user_id = ANY($1::uuid[])",
            [cleanupUserIds],
          )
        : { rows: [] };
      const cleanupThreadIds = [...new Set([
        ...persistedThreads.rows.map((row) => row.id),
        ...[clientThreadId, talentThreadId].filter((value): value is string => Boolean(value)),
      ])];
      const cleanupAggregateIds = [...new Set([...cleanupIntakeIds, ...cleanupThreadIds, inquiryId])];
      if (cleanupAggregateIds.length > 0) {
        await pool.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])", [cleanupAggregateIds]);
      }
      await pool.query("DELETE FROM enterprise_inquiries WHERE id = $1", [inquiryId]);
      if (cleanupIntakeIds.length > 0) {
        await pool.query("DELETE FROM intake_drafts WHERE id = ANY($1::uuid[])", [cleanupIntakeIds]);
      }
      if (cleanupUserIds.length > 0) {
        await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [cleanupUserIds]);
      }
      await pool.query("DELETE FROM email_challenges WHERE email = ANY($1::text[])", [cleanupEmails]);
    } finally {
      await app.close();
    }
  }
});

test("checked-in PostgreSQL grants enforce runtime and maintenance isolation", {
  skip: !integrationEnabled,
}, async () => {
  assert.ok(databaseUrl);
  const ownerDatabaseUrl = process.env.TEST_DATABASE_ADMIN_URL?.trim() || databaseUrl;
  const databaseSsl = process.env.DATABASE_SSL === "true";
  const databaseName = new URL(ownerDatabaseUrl).pathname.split("/").filter(Boolean).at(-1) ?? "";
  assert.match(databaseName, /(?:_test|_validation)$/u, "Role tests require a dedicated *_test or *_validation database.");

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const runtimeRole = `duduhire_runtime_${suffix}`;
  const maintenanceRole = `duduhire_maintenance_${suffix}`;
  const runtimePassword = randomBytes(24).toString("hex");
  const maintenancePassword = randomBytes(24).toString("hex");
  const runtimeDatabaseUrl = databaseUrlForRole(ownerDatabaseUrl, runtimeRole, runtimePassword);
  const maintenanceDatabaseUrl = databaseUrlForRole(ownerDatabaseUrl, maintenanceRole, maintenancePassword);
  const email = `restricted-${suffix}@example.com`;
  const firstPrompt = `restricted superseded intake ${suffix}`;
  const secondPrompt = `restricted current intake ${suffix}`;
  const inquiryId = randomUUID();
  const expiredIntakeId = randomUUID();
  const createdIds = new Set<string>([inquiryId, expiredIntakeId]);
  const ownerPool = createDatabasePool(ownerDatabaseUrl, databaseSsl, "migration");
  let runtimeRoleCreated = false;
  let maintenanceRoleCreated = false;
  let runtimePool: ReturnType<typeof createDatabasePool> | undefined;
  let maintenancePool: ReturnType<typeof createDatabasePool> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  try {
    const owner = await ownerPool.query<{ current_user: string; owns_runtime_table: boolean }>(
      `SELECT current_user,
              (SELECT tableowner = current_user
                 FROM pg_catalog.pg_tables
                WHERE schemaname = 'public'
                  AND tablename = 'users') AS owns_runtime_table`,
    );
    assert.equal(owner.rows[0]?.owns_runtime_table, true, "Grant regression must run as the migration/table owner.");

    await ownerPool.query(
      `CREATE ROLE ${quoteGeneratedRole(runtimeRole)} LOGIN PASSWORD '${runtimePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    runtimeRoleCreated = true;
    await ownerPool.query(
      `CREATE ROLE ${quoteGeneratedRole(maintenanceRole)} LOGIN PASSWORD '${maintenancePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    maintenanceRoleCreated = true;
    applyDatabaseRoleGrants(ownerDatabaseUrl, databaseSsl, runtimeRole, maintenanceRole);

    runtimePool = createDatabasePool(runtimeDatabaseUrl, databaseSsl);
    const repository = new PostgresRepository(runtimePool);
    const emailSender = new CapturingEmailSender();
    const config = integrationConfig(runtimeDatabaseUrl);
    config.databaseSsl = databaseSsl;
    app = await buildApp({ config, repository, emailSender });
    await repository.ping();

    const runtimePrivileges = await runtimePool.query<{
      can_delete_intakes: boolean;
      can_read_outbox: boolean;
      can_read_contact_ciphertext: boolean;
      can_read_contact_hash: boolean;
      can_read_contact_key_id: boolean;
      can_read_inquiry_user_id: boolean;
      can_create_schema_objects: boolean;
      can_create_temp_tables: boolean;
      can_update_session_owner: boolean;
      can_update_active_role: boolean;
      can_update_user_role: boolean;
      can_update_challenge_email: boolean;
    }>(
      `SELECT has_table_privilege(current_user, 'public.intake_drafts', 'DELETE') AS can_delete_intakes,
              has_table_privilege(current_user, 'public.outbox_events', 'SELECT') AS can_read_outbox,
              has_column_privilege(current_user, 'public.enterprise_inquiries', 'contact_ciphertext', 'SELECT') AS can_read_contact_ciphertext,
              has_column_privilege(current_user, 'public.enterprise_inquiries', 'contact_hash', 'SELECT') AS can_read_contact_hash,
              has_column_privilege(current_user, 'public.enterprise_inquiries', 'encryption_key_id', 'SELECT') AS can_read_contact_key_id,
              has_column_privilege(current_user, 'public.enterprise_inquiries', 'user_id', 'SELECT') AS can_read_inquiry_user_id,
              has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema_objects,
              has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_create_temp_tables,
              has_column_privilege(current_user, 'public.sessions', 'user_id', 'UPDATE') AS can_update_session_owner,
              has_column_privilege(current_user, 'public.sessions', 'active_role', 'UPDATE') AS can_update_active_role,
              has_column_privilege(current_user, 'public.users', 'role', 'UPDATE') AS can_update_user_role,
              has_column_privilege(current_user, 'public.email_challenges', 'email', 'UPDATE') AS can_update_challenge_email`,
    );
    assert.deepEqual(runtimePrivileges.rows[0], {
      can_delete_intakes: false,
      can_read_outbox: false,
      can_read_contact_ciphertext: false,
      can_read_contact_hash: false,
      can_read_contact_key_id: false,
      can_read_inquiry_user_id: false,
      can_create_schema_objects: false,
      can_create_temp_tables: false,
      can_update_session_owner: false,
      can_update_active_role: true,
      can_update_user_role: false,
      can_update_challenge_email: false,
    });

    await assertDatabasePermissionDenied(
      () => runtimePool!.query("DELETE FROM public.intake_drafts WHERE FALSE"),
      "runtime DELETE on intake_drafts",
    );
    await assertDatabasePermissionDenied(
      () => runtimePool!.query("SELECT * FROM public.outbox_events LIMIT 1"),
      "runtime SELECT on outbox_events",
    );
    await assertDatabasePermissionDenied(
      () => runtimePool!.query("SELECT user_id, contact_ciphertext, contact_hash, encryption_key_id FROM public.enterprise_inquiries LIMIT 1"),
      "runtime SELECT on encrypted enterprise contact fields",
    );
    await assertDatabasePermissionDenied(
      () => runtimePool!.query("UPDATE public.sessions SET user_id = user_id WHERE FALSE"),
      "runtime UPDATE on session ownership",
    );
    await assertDatabasePermissionDenied(
      () => runtimePool!.query("UPDATE public.users SET role = role WHERE FALSE"),
      "runtime UPDATE on immutable account role",
    );
    await assertDatabasePermissionDenied(
      () => runtimePool!.query("UPDATE public.email_challenges SET email = email WHERE FALSE"),
      "runtime UPDATE on challenge ownership",
    );
    await assertDatabasePermissionDenied(
      () => runtimePool!.query(`CREATE TABLE public.runtime_forbidden_${suffix} (id integer)`),
      "runtime CREATE in public schema",
    );
    await assertDatabasePermissionDenied(
      () => runtimePool!.query(`CREATE TEMPORARY TABLE runtime_temp_forbidden_${suffix} (id integer)`),
      "runtime CREATE TEMPORARY TABLE",
    );

    const browserProbe = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
    assert.equal(browserProbe.statusCode, 200);
    const browserCookie = firstCookie(browserProbe);
    const firstIntake = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/intakes",
      headers: { origin: config.webOrigin, cookie: browserCookie },
      payload: { prompt: firstPrompt },
    });
    assert.equal(firstIntake.statusCode, 201);
    const firstIntakeId = firstIntake.json().intakeId as string;
    createdIds.add(firstIntakeId);

    const secondIntake = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/intakes",
      headers: { origin: config.webOrigin, cookie: browserCookie },
      payload: { prompt: secondPrompt },
    });
    assert.equal(secondIntake.statusCode, 201);
    const secondIntakeId = secondIntake.json().intakeId as string;
    createdIds.add(secondIntakeId);

    const intakeRows = await ownerPool.query<{
      id: string;
      invalidated_at: Date | null;
      claimed_at: Date | null;
    }>(
      `SELECT id, invalidated_at, claimed_at
         FROM public.intake_drafts
        WHERE id = ANY($1::uuid[])
        ORDER BY created_at`,
      [[firstIntakeId, secondIntakeId]],
    );
    assert.equal(intakeRows.rows.length, 2, "Replacing a browser draft must preserve both audit rows.");
    assert.ok(intakeRows.rows.find((row) => row.id === firstIntakeId)?.invalidated_at);
    assert.equal(intakeRows.rows.find((row) => row.id === secondIntakeId)?.invalidated_at, null);

    const auth = await signUpAndVerify(app, emailSender, email, "client", browserCookie);
    const oldClaim = await app.inject({
      method: "POST",
      url: `/api/v1/me/discovery/intakes/${firstIntakeId}/claim`,
      headers: { origin: config.webOrigin, cookie: `${auth.sessionCookie}; ${browserCookie}` },
    });
    assert.equal(oldClaim.statusCode, 404, "An invalidated intake must never be claimable.");
    const currentClaim = await app.inject({
      method: "POST",
      url: `/api/v1/me/discovery/intakes/${secondIntakeId}/claim`,
      headers: { origin: config.webOrigin, cookie: `${auth.sessionCookie}; ${browserCookie}` },
    });
    assert.equal(currentClaim.statusCode, 200);
    assert.deepEqual(currentClaim.json(), { prompt: secondPrompt });

    const profile = await app.inject({
      method: "PUT",
      url: "/api/v1/me/profile",
      headers: { origin: config.webOrigin, cookie: auth.sessionCookie },
      payload: {
        displayName: "受限角色回归",
        countryCode: "CN",
        contact: `wx-${suffix}`,
        organization: "DuduHire",
        jobTitle: "测试负责人",
        professionalTitle: "",
        bio: "验证 runtime 最小权限仍支持完整业务流程。",
        version: 0,
      },
    });
    assert.equal(profile.statusCode, 200);
    assert.equal(profile.json().profile.version, 1);

    const discovery = await app.inject({
      method: "POST",
      url: "/api/v1/me/discovery/turns",
      headers: { origin: config.webOrigin, cookie: auth.sessionCookie },
      payload: {
        requestId: randomUUID(),
        prompt: "我们需要减少销售线索遗漏。",
        attachments: [],
      },
    });
    assert.equal(discovery.statusCode, 200);
    const discoveryThreadId = discovery.json().discovery.threadId as string;
    assert.ok(discoveryThreadId);
    createdIds.add(discoveryThreadId);

    const inquiry = await app.inject({
      method: "POST",
      url: "/api/v1/enterprise/inquiries",
      headers: { origin: config.webOrigin, cookie: auth.sessionCookie },
      payload: { requestId: inquiryId, method: "wechat", contactValue: `wx${suffix}`, source: "enterprise_page" },
    });
    assert.equal(inquiry.statusCode, 202);
    const inquiryReplay = await app.inject({
      method: "POST",
      url: "/api/v1/enterprise/inquiries",
      headers: { origin: config.webOrigin, cookie: auth.sessionCookie },
      payload: { requestId: inquiryId, method: "wechat", contactValue: `wx${suffix}`, source: "enterprise_page" },
    });
    assert.equal(inquiryReplay.statusCode, 202, "Idempotent inquiry lookup must work without sensitive-column SELECT.");

    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/me/discovery/reset",
      headers: { origin: config.webOrigin, cookie: auth.sessionCookie },
    });
    assert.equal(reset.statusCode, 200);
    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { origin: config.webOrigin, cookie: auth.sessionCookie },
    });
    assert.equal(logout.statusCode, 204);

    await ownerPool.query(
      `INSERT INTO public.intake_drafts
        (id, browser_binding_hash, prompt, created_at, expires_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
      [expiredIntakeId, randomBytes(32).toString("hex"), `expired restricted intake ${suffix}`],
    );

    maintenancePool = createDatabasePool(maintenanceDatabaseUrl, databaseSsl, "maintenance");
    const maintenancePrivileges = await maintenancePool.query<{
      can_run_cleanup: boolean;
      can_read_intakes: boolean;
      can_delete_intakes: boolean;
      can_read_retention_policy: boolean;
      can_create_schema_objects: boolean;
      can_create_temp_tables: boolean;
    }>(
      `SELECT has_function_privilege(current_user, 'public.run_data_retention_cleanup()', 'EXECUTE') AS can_run_cleanup,
              has_table_privilege(current_user, 'public.intake_drafts', 'SELECT') AS can_read_intakes,
              has_table_privilege(current_user, 'public.intake_drafts', 'DELETE') AS can_delete_intakes,
              has_table_privilege(current_user, 'public.data_retention_policy', 'SELECT') AS can_read_retention_policy,
              has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema_objects,
              has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_create_temp_tables`,
    );
    assert.deepEqual(maintenancePrivileges.rows[0], {
      can_run_cleanup: true,
      can_read_intakes: false,
      can_delete_intakes: false,
      can_read_retention_policy: false,
      can_create_schema_objects: false,
      can_create_temp_tables: false,
    });
    await assertDatabasePermissionDenied(
      () => maintenancePool!.query("SELECT * FROM public.intake_drafts LIMIT 1"),
      "maintenance SELECT on intake_drafts",
    );
    await assertDatabasePermissionDenied(
      () => maintenancePool!.query("DELETE FROM public.intake_drafts WHERE FALSE"),
      "maintenance DELETE on intake_drafts",
    );
    await assertDatabasePermissionDenied(
      () => maintenancePool!.query("SELECT * FROM public.data_retention_policy"),
      "maintenance SELECT on owner-controlled retention policy",
    );
    await assertDatabasePermissionDenied(
      () => maintenancePool!.query(`CREATE TABLE public.maintenance_forbidden_${suffix} (id integer)`),
      "maintenance CREATE in public schema",
    );
    await assertDatabasePermissionDenied(
      () => maintenancePool!.query(`CREATE TEMPORARY TABLE maintenance_temp_forbidden_${suffix} (id integer)`),
      "maintenance CREATE TEMPORARY TABLE",
    );

    const cleanup = await maintenancePool.query<{ removed_intake_drafts: string }>(
      "SELECT removed_intake_drafts::text FROM public.run_data_retention_cleanup()",
    );
    assert.ok(Number(cleanup.rows[0]?.removed_intake_drafts ?? 0) >= 1);
    const retentionResult = await ownerPool.query<{ expired_exists: boolean; current_exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM public.intake_drafts WHERE id = $1) AS expired_exists,
              EXISTS (SELECT 1 FROM public.intake_drafts WHERE id = $2) AS current_exists`,
      [expiredIntakeId, secondIntakeId],
    );
    assert.equal(retentionResult.rows[0]?.expired_exists, false, "Cleanup must remove an expired intake.");
    assert.equal(retentionResult.rows[0]?.current_exists, true, "Cleanup must preserve an unexpired claimed intake.");
  } finally {
    try {
      if (app) {
        await app.close();
      } else if (runtimePool) {
        await runtimePool.end();
      }
      if (maintenancePool) await maintenancePool.end();
    } finally {
      try {
        const aggregateIds = [...createdIds];
        if (aggregateIds.length > 0) {
          await ownerPool.query("DELETE FROM public.outbox_events WHERE aggregate_id = ANY($1::uuid[])", [aggregateIds]);
        }
        await ownerPool.query("DELETE FROM public.enterprise_inquiries WHERE id = $1", [inquiryId]);
        await ownerPool.query(
          "DELETE FROM public.intake_drafts WHERE id = ANY($1::uuid[])",
          [[...createdIds]],
        );
        await ownerPool.query("DELETE FROM public.users WHERE email = $1", [email]);
        await ownerPool.query("DELETE FROM public.email_challenges WHERE email = $1", [email]);
      } finally {
        if (maintenanceRoleCreated) {
          await ownerPool.query(`DROP OWNED BY ${quoteGeneratedRole(maintenanceRole)}`);
          await ownerPool.query(`DROP ROLE ${quoteGeneratedRole(maintenanceRole)}`);
        }
        if (runtimeRoleCreated) {
          await ownerPool.query(`DROP OWNED BY ${quoteGeneratedRole(runtimeRole)}`);
          await ownerPool.query(`DROP ROLE ${quoteGeneratedRole(runtimeRole)}`);
        }
        await ownerPool.end();
      }
    }
  }
});

test("one account keeps two discovery drafts and publications through session role changes", { skip: !integrationEnabled }, async () => {
  assert.ok(databaseUrl);
  assert.match(new URL(databaseUrl).pathname, /(?:_test|_validation)$/u);
  const pool = createDatabasePool(databaseUrl, process.env.DATABASE_SSL === "true");
  const repository = new PostgresRepository(pool);
  const sender = new CapturingEmailSender();
  const config = integrationConfig(databaseUrl);
  const app = await buildApp({ config, repository, emailSender: sender });
  const suffix = randomUUID();
  const email = `dual-role-${suffix}@example.test`;
  const otherEmail = `dual-role-other-${suffix}@example.test`;
  const userIds: string[] = [];
  try {
    const owner = await signUpAndVerify(app, sender, email, "client");
    const headers = { cookie: owner.sessionCookie, origin: config.webOrigin };
    const original = (await app.inject({ method: "GET", url: "/api/v1/auth/session", headers })).json().session;
    const userId = original.user.id as string;
    userIds.push(userId);
    assert.deepEqual(original.user.roles, ["client", "talent"]);
    const clientHeaders = { ...headers, "x-duduhire-role": "client" };
    const talentHeaders = { ...headers, "x-duduhire-role": "talent" };
    const switchRole = (role: "client" | "talent") => app.inject({ method: "POST", url: "/api/v1/auth/role", headers, payload: { role } });
    const profile = { displayName: "双身份用户", countryCode: "CN", contact: "", organization: "需求组织", jobTitle: "产品负责人", professionalTitle: "系统集成顾问", bio: "保留能力经历", version: 0 };
    const savedProfile = await app.inject({ method: "PUT", url: "/api/v1/me/profile", headers, payload: profile });
    assert.equal(savedProfile.statusCode, 200);
    const clientState = await repository.appendDiscoveryTurn(userId, "problem", matchingDiscoveryTurn("problem"), new Date(), null);
    const publication = (state: DiscoveryState) => ({ ...matchingDraftFixture, consent: true, expectedThreadId: state.thread.id, expectedVersion: state.thread.version, expectedListingVersion: 0 });
    const publishedClient = await app.inject({ method: "PUT", url: "/api/v1/me/matching/listing", headers: clientHeaders, payload: publication(clientState) });
    assert.equal(publishedClient.statusCode, 200, publishedClient.body);
    const setupExpiry = (await pool.query("SELECT password_setup_expires_at FROM sessions WHERE user_id=$1", [userId])).rows[0].password_setup_expires_at;
    const switched = await switchRole("talent");
    assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(switched.json().session.user.id, userId);
    assert.equal(switched.json().session.signedInAt, original.signedInAt);
    assert.equal(switched.json().session.expiresAt, original.expiresAt);
    assert.deepEqual((await pool.query("SELECT password_setup_expires_at FROM sessions WHERE user_id=$1", [userId])).rows[0].password_setup_expires_at, setupExpiry);
    assert.deepEqual(switched.json().session.profile, savedProfile.json().profile);
    const fresh = (await app.inject({ method: "GET", url: "/api/v1/auth/session", headers })).json().session;
    assert.equal(fresh.user.role, "talent");
    const blankCapability = await app.inject({ method: "GET", url: "/api/v1/me/discovery", headers: talentHeaders });
    assert.equal(blankCapability.json().discovery.kind, "capability");
    assert.equal(blankCapability.json().discovery.threadId, null);
    const talentState = await repository.appendDiscoveryTurn(userId, "capability", matchingDiscoveryTurn("capability"), new Date(), null);
    const publishedTalent = await app.inject({ method: "PUT", url: "/api/v1/me/matching/listing", headers: talentHeaders, payload: publication(talentState) });
    assert.equal(publishedTalent.statusCode, 200, publishedTalent.body);
    assert.notEqual(publishedTalent.json().listing.id, publishedClient.json().listing.id);
    for (const url of ["/api/v1/me/discovery", "/api/v1/me/workspace", "/api/v1/me/matching", "/api/v1/me/matching/results"]) {
      const stale = await app.inject({ method: "GET", url, headers: clientHeaders });
      assert.equal(stale.statusCode, 409, url);
      assert.equal(stale.json().error.code, "ACTIVE_ROLE_CHANGED");
    }
    for (const request of [
      { method: "POST" as const, url: "/api/v1/me/discovery/turns", payload: { requestId: randomUUID(), prompt: "旧页面写入", attachments: [] } },
      { method: "POST" as const, url: "/api/v1/me/discovery/reset", payload: {} },
      { method: "PUT" as const, url: "/api/v1/me/matching/listing", payload: publication(clientState) },
      { method: "POST" as const, url: "/api/v1/me/matching/withdraw", payload: { expectedListingId: publishedClient.json().listing.id, expectedListingVersion: 1 } },
    ]) {
      const stale = await app.inject({ ...request, headers: clientHeaders });
      assert.equal(stale.statusCode, 409, request.url);
      assert.equal(stale.json().error.code, "ACTIVE_ROLE_CHANGED");
    }
    const ownCandidates = await repository.readMatchingCandidates(userId, "capability");
    assert.ok(ownCandidates.candidates.every(candidate => candidate.ownerUserId !== userId));
    const other = await signUpAndVerify(app, sender, otherEmail, "talent");
    const otherHeaders = { cookie: other.sessionCookie, origin: config.webOrigin };
    const otherUserId = (await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: otherHeaders })).json().session.user.id as string;
    userIds.push(otherUserId);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/me/discovery", headers: otherHeaders })).json().discovery.threadId, null);
    const crossOwnerPublish = await app.inject({ method: "PUT", url: "/api/v1/me/matching/listing", headers: otherHeaders, payload: publication(talentState) });
    assert.equal(crossOwnerPublish.statusCode, 409);
    const otherState = await repository.appendDiscoveryTurn(otherUserId, "capability", matchingDiscoveryTurn("capability"), new Date(), null);
    await repository.publishMatchingListing(otherUserId, "capability", publication(otherState), new Date());
    const races = await Promise.all([switchRole("client"), switchRole("talent")]);
    assert.deepEqual(races.map(result => result.statusCode), [200, 200]);
    assert.deepEqual(races.map(result => result.json().session.user.role), ["client", "talent"]);
    const actualRole = (await app.inject({ method: "GET", url: "/api/v1/auth/session", headers })).json().session.user.role;
    const staleAfterRace = await app.inject({ method: "POST", url: "/api/v1/me/discovery/reset", headers: { ...headers, "x-duduhire-role": actualRole === "client" ? "talent" : "client" }, payload: {} });
    assert.equal(staleAfterRace.statusCode, 409);
    for (const role of ["client", "talent"] as const) {
      await switchRole(role);
      const expected = role === "client" ? clientState : talentState;
      const roleHeaders = { ...headers, "x-duduhire-role": role };
      const restored = await app.inject({ method: "GET", url: "/api/v1/me/discovery", headers: roleHeaders });
      assert.equal(restored.json().discovery.threadId, expected.thread.id);
      assert.equal(restored.json().discovery.turns.length, 1);
      const workspace = await app.inject({ method: "GET", url: "/api/v1/me/workspace", headers: roleHeaders });
      assert.equal(workspace.json().role, role);
      assert.equal(workspace.json().activeThreadId, expected.thread.id);
      assert.equal(workspace.json().discoveryCompleted, true);
      const listing = await repository.readMatchingListing(userId, role === "client" ? "problem" : "capability");
      assert.equal(listing?.active, true);
    }
    const candidateIds = (await repository.readMatchingCandidates(userId, "problem")).candidates.map(candidate => candidate.ownerUserId);
    assert.ok(candidateIds.includes(otherUserId));
    assert.ok(!candidateIds.includes(userId));
    assert.equal((await pool.query("SELECT role FROM users WHERE id=$1", [userId])).rows[0].role, "client");
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: otherHeaders })).json().session.user.role, "talent");
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/v1/me/profile", headers })).json(), savedProfile.json());
    // A new browser begins in the registration role without affecting this browser.
    await pool.query("UPDATE email_challenges SET created_at=created_at-INTERVAL '31 seconds' WHERE email=$1", [email]);
    const secondBrowser = await signUpAndVerify(app, sender, email, "talent");
    const newSession = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: secondBrowser.sessionCookie } });
    assert.equal(newSession.json().session.user.role, "client");
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers })).json().session.user.role, "talent");
  } finally {
    await pool.query("DELETE FROM outbox_events WHERE (aggregate_type='discovery_thread' AND aggregate_id IN (SELECT id FROM discovery_threads WHERE owner_user_id=ANY($1::uuid[]))) OR (aggregate_type='matching_listing' AND aggregate_id IN (SELECT id FROM matching_listings WHERE owner_user_id=ANY($1::uuid[])))", [userIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    await pool.query("DELETE FROM email_challenges WHERE email=ANY($1::text[])", [[email, otherEmail]]);
    await app.close();
  }
});

test("active role migration backfills existing client and talent sessions and enforces valid values", { skip: !integrationEnabled }, async () => {
  assert.ok(databaseUrl);
  assert.match(new URL(databaseUrl).pathname, /(?:_test|_validation)$/u);
  const pool = createDatabasePool(databaseUrl, process.env.DATABASE_SSL === "true");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Recreate the pre-upgrade session shape inside a rollback-only transaction.
    await client.query("ALTER TABLE sessions DROP COLUMN active_role CASCADE");
    const users = [randomUUID(), randomUUID()];
    await client.query("INSERT INTO users(id,email,role,email_verified_at) VALUES($1,$2,'client',NOW()),($3,$4,'talent',NOW())",
      [users[0], `migration-${users[0]}@example.test`, users[1], `migration-${users[1]}@example.test`]);
    for (const userId of users) {
      await client.query("INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,NOW(),NOW()+INTERVAL '1 day')",
        [randomUUID(), userId, randomBytes(32).toString("hex")]);
    }
    await client.query(await readFile(new URL("../migrations/011_session_active_role.sql", import.meta.url), "utf8"));
    // Old API INSERT statements remain valid while instances are replaced.
    for (const userId of users) {
      await client.query("INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,NOW(),NOW()+INTERVAL '1 day')",
        [randomUUID(), userId, randomBytes(32).toString("hex")]);
    }
    const result = await client.query<{ role: string; active_role: string }>("SELECT DISTINCT u.role,s.active_role FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.id=ANY($1::uuid[]) ORDER BY u.role", [users]);
    assert.deepEqual(result.rows, [{ role: "client", active_role: "client" }, { role: "talent", active_role: "talent" }]);
    assert.equal((await client.query("SELECT is_nullable FROM information_schema.columns WHERE table_name='sessions' AND column_name='active_role'")).rows[0].is_nullable, "NO");
    await assert.rejects(client.query("UPDATE sessions SET active_role='admin' WHERE user_id=$1", [users[0]]), { code: "23514" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
