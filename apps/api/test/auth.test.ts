import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Client, type Pool, type PoolClient } from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig, loadDatabaseConfig, OFFICIAL_OPENAI_BASE_URL, type AppConfig } from "../src/config.js";
import type { DiscoveryAdvisor } from "../src/discoveryAdvisor.js";
import {
  emptyProfile,
  normalizeEmail,
  normalizeReturnTo,
  type AuthRole,
  type DiscoveryKind,
  type DiscoveryState,
  type EnterpriseInquiry,
  type IntakeDraft,
  type PersonalProfile,
  type UserRecord,
  type WorkspaceSummary,
  type AdminInquiry,
  type InquiryCursor,
  type ManagedInquiryStatus,
} from "../src/domain.js";
import { createSmtpTransportOptions, type EmailSender } from "../src/email.js";
import { createId, createOpaqueToken } from "../src/security.js";
import { createDatabasePool, PostgresRepository, withTransaction } from "../src/postgresRepository.js";
import {
  confirmedSource, MatchingConflictError, validateMatchingDraft,
  type MatchingListing, type MatchingListingRecord, type PublishMatchingInput,
} from "../src/matching.js";
import { matchingDiscoveryTurn, matchingDraftFixture } from "./matchingFixtures.js";
import { MATCHING_EXAMPLES } from "../src/matchingExamples.js";
import {
  DiscoveryKindForbiddenError,
  DiscoveryStateConflictError,
  ProfileVersionConflictError,
  InquiryVersionConflictError,
  type AppRepository,
  type AuthenticatedSession,
  type ChallengeCreationResult,
  type NewEmailChallenge,
  type NewDiscoveryTurn,
  type NewEnterpriseInquiry,
  type NewIntakeDraft,
  type NewSession,
  type ExpectedDiscoveryState,
  type VerifyChallengeResult,
} from "../src/repository.js";

class MemoryEmailSender implements EmailSender {
  messages: Array<{ to: string; link: string; expiresInMinutes: number }> = [];

  async sendMagicLink(message: { to: string; link: string; expiresInMinutes: number }) {
    this.messages.push(message);
  }

  async close() {}
}

class MemoryRepository implements AppRepository {
  challenges: NewEmailChallenge[] = [];
  users = new Map<string, UserRecord>();
  sessions = new Map<string, AuthenticatedSession & { revoked: boolean }>();
  profiles = new Map<string, PersonalProfile>();
  intakeRecords = new Map<string, NewIntakeDraft & { claimedAt: Date | null; claimedByUserId: string | null; invalidatedAt: Date | null }>();
  discoveries = new Map<string, DiscoveryState>();
  archivedDiscoveries: DiscoveryState[] = [];
  matchingListings = new Map<string, MatchingListingRecord>();
  matchingExamples: MatchingListing[] = [];
  inquiryInputs: NewEnterpriseInquiry[] = [];
  inquiries = new Map<string, EnterpriseInquiry>();
  adminInquiries = new Map<string, AdminInquiry>();
  inquiryAudit: Array<{ actorUserId: string; inquiryId: string; action: string; reason?: string }> = [];

  async ping() {}
  async close() {}

  async isRegisteredLoginAccount(method: "email" | "phone", account: string) {
    return [...this.users.values()].some(user => user[method] === account);
  }

  async createEmailChallengeIfAllowed(
    challenge: NewEmailChallenge,
    now: Date,
    resendSeconds: number,
    hourlyLimit: number,
  ): Promise<ChallengeCreationResult> {
    if (challenge.intent === "login" && !await this.isRegisteredLoginAccount("email", challenge.email)) {
      return { created: false, reason: "account_not_found" };
    }
    const matches = this.challenges.filter((item) => item.email === challenge.email);
    const recent = matches.filter((item) => item.createdAt.getTime() > now.getTime() - 3_600_000);
    const last = matches.at(-1)?.createdAt;
    const cooldownRetry = last ? Math.max(0, resendSeconds - Math.floor((now.getTime() - last.getTime()) / 1000)) : 0;
    const hourlyRetry = recent.length >= hourlyLimit
      ? Math.max(1, Math.ceil(3600 - (now.getTime() - recent[0]!.createdAt.getTime()) / 1000))
      : 0;
    const retryAfterSeconds = Math.max(cooldownRetry, hourlyRetry);
    if (retryAfterSeconds > 0) return { created: false, retryAfterSeconds };
    this.challenges.forEach((item) => {
      if (item.email === challenge.email && item.browserBindingHash === challenge.browserBindingHash) item.expiresAt = new Date(0);
    });
    this.challenges.push(challenge);
    return { created: true };
  }

  async invalidateEmailChallenge(id: string) {
    const challenge = this.challenges.find((item) => item.id === id);
    if (challenge) challenge.expiresAt = new Date(0);
  }

  async consumeEmailChallenge(tokenHash: string, browserBindingHash: string, now: Date, newSession: NewSession): Promise<VerifyChallengeResult> {
    const challenge = this.challenges.find((item) => item.tokenHash === tokenHash && item.browserBindingHash === browserBindingHash && item.expiresAt > now);
    if (!challenge) return { status: "invalid" };
    challenge.expiresAt = new Date(0);
    let user = this.users.get(challenge.email);
    if (!user && challenge.intent === "login") return { status: "account_not_found", returnTo: challenge.returnTo };
    if (!user) {
      user = {
        id: `user-${this.users.size + 1}`,
        email: challenge.email,
        role: challenge.requestedRole as AuthRole,
        emailVerifiedAt: now,
        createdAt: now,
      };
      this.users.set(challenge.email, user);
    } else {
      user = { ...user, emailVerifiedAt: now };
      this.users.set(challenge.email, user);
    }
    const session = { user: { ...user }, signedInAt: newSession.createdAt, expiresAt: newSession.expiresAt, revoked: false };
    this.sessions.set(newSession.tokenHash, session);
    return { status: "verified", session, returnTo: challenge.returnTo };
  }

  async findSession(tokenHash: string, now: Date) {
    const session = this.sessions.get(tokenHash);
    return session && !session.revoked && session.expiresAt > now ? session : null;
  }

  async switchSessionRole(tokenHash: string, role: AuthRole, now: Date) {
    const session = await this.findSession(tokenHash, now);
    if (!session) return null;
    const updated = { ...session, user: { ...session.user, role } };
    this.sessions.set(tokenHash, updated);
    return updated;
  }

  async revokeSession(tokenHash: string) {
    const session = this.sessions.get(tokenHash);
    if (session) session.revoked = true;
  }

  async readProfile(userId: string) {
    return this.profiles.get(userId) ?? emptyProfile();
  }

  async saveProfile(
    userId: string,
    profile: Omit<PersonalProfile, "version" | "updatedAt">,
    now: Date,
    expectedVersion = 0,
  ) {
    const current = this.profiles.get(userId);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion) {
      throw new ProfileVersionConflictError(expectedVersion, currentVersion);
    }
    const saved = { ...profile, version: currentVersion + 1, updatedAt: now };
    this.profiles.set(userId, saved);
    return saved;
  }

  async createIntakeDraft(draft: NewIntakeDraft): Promise<IntakeDraft> {
    for (const current of this.intakeRecords.values()) {
      if (current.browserBindingHash === draft.browserBindingHash && current.claimedAt === null && current.invalidatedAt === null) {
        current.invalidatedAt = draft.createdAt;
      }
    }
    this.intakeRecords.set(draft.id, { ...draft, claimedAt: null, claimedByUserId: null, invalidatedAt: null });
    return { id: draft.id, prompt: draft.prompt, createdAt: draft.createdAt, expiresAt: draft.expiresAt, claimedAt: null };
  }

  async claimIntakeDraft(userId: string, intakeId: string, browserBindingHash: string, now: Date): Promise<IntakeDraft | null> {
    const draft = this.intakeRecords.get(intakeId);
    if (!draft || draft.browserBindingHash !== browserBindingHash || draft.claimedAt || draft.invalidatedAt || draft.expiresAt <= now) return null;
    draft.claimedAt = now;
    draft.claimedByUserId = userId;
    return {
      id: draft.id,
      prompt: draft.prompt,
      createdAt: draft.createdAt,
      expiresAt: draft.expiresAt,
      claimedAt: draft.claimedAt,
    };
  }

  async readDiscovery(userId: string, kind: DiscoveryKind) {
    this.assertDiscoveryOwner(userId);
    return this.discoveries.get(this.discoveryKey(userId, kind)) ?? null;
  }

  async appendDiscoveryTurn(
    userId: string,
    kind: DiscoveryKind,
    turn: NewDiscoveryTurn,
    now: Date,
    expectedState: ExpectedDiscoveryState,
  ): Promise<DiscoveryState> {
    this.assertDiscoveryOwner(userId);
    const key = this.discoveryKey(userId, kind);
    const current = this.discoveries.get(key);
    if (current?.turns.some((item) => item.requestId === turn.requestId)) return current;
    if (
      (current && !expectedState)
      || (!current && expectedState)
      || (current && expectedState && (
        current.thread.id !== expectedState.threadId
        || current.thread.version !== expectedState.threadVersion
      ))
    ) throw new DiscoveryStateConflictError();

    const state: DiscoveryState = current ?? {
      thread: {
        id: createId(),
        kind,
        status: "active",
        version: 0,
        createdAt: now,
        updatedAt: now,
      },
      turns: [],
      artifact: null,
    };
    state.thread = { ...state.thread, version: state.thread.version + 1, updatedAt: now };
    state.turns = [...state.turns, {
      id: createId(),
      requestId: turn.requestId,
      question: turn.question,
      answer: turn.answer,
      attachments: turn.attachments,
      analysisContext: turn.analysisContext,
      provider: turn.provider,
      model: turn.model,
      promptVersion: turn.promptVersion,
      createdAt: now,
    }];
    state.artifact = {
      id: state.artifact?.id ?? createId(),
      kind,
      draft: turn.artifactDraft,
      version: (state.artifact?.version ?? 0) + 1,
      createdAt: state.artifact?.createdAt ?? now,
      updatedAt: now,
    };
    this.discoveries.set(key, state);
    return state;
  }

  async resetDiscovery(userId: string, kind: DiscoveryKind, now: Date, expectedState?: ExpectedDiscoveryState) {
    this.assertDiscoveryOwner(userId);
    const key = this.discoveryKey(userId, kind);
    const current = this.discoveries.get(key);
    if (expectedState !== undefined && (
      (current && !expectedState)
      || (!current && expectedState)
      || (current && expectedState && (
        current.thread.id !== expectedState.threadId || current.thread.version !== expectedState.threadVersion
      ))
    )) throw new DiscoveryStateConflictError();
    if (!current) return false;
    this.archivedDiscoveries.push({ ...current, thread: { ...current.thread, status: "archived", version: current.thread.version + 1, updatedAt: now } });
    return this.discoveries.delete(key);
  }

  async readMatchingListing(userId: string, kind: DiscoveryKind): Promise<MatchingListingRecord | null> {
    this.assertDiscoveryOwner(userId);
    const listing = this.matchingListings.get(this.discoveryKey(userId, kind));
    if (!listing) return null;
    const state = await this.readDiscovery(userId, kind);
    return { ...listing, active: listing.status === "published" && confirmedSource(state)
      && state?.thread.id === listing.sourceThreadId && state.thread.version === listing.sourceThreadVersion };
  }

  async publishMatchingListing(userId: string, kind: DiscoveryKind, input: PublishMatchingInput, now: Date): Promise<MatchingListingRecord> {
    const draft = validateMatchingDraft(kind, input);
    const state = await this.readDiscovery(userId, kind);
    const previous = await this.readMatchingListing(userId, kind);
    if (input.consent !== true || !confirmedSource(state) || !state || state.thread.id !== input.expectedThreadId
      || state.thread.version !== input.expectedVersion || (previous?.version ?? 0) !== input.expectedListingVersion) {
      throw new MatchingConflictError();
    }
    const listing: MatchingListingRecord = {
      ...draft, id: previous?.id ?? createId(), ownerUserId: userId, kind,
      sourceThreadId: state.thread.id, sourceThreadVersion: state.thread.version,
      version: (previous?.version ?? 0) + 1, status: "published", active: true,
      createdAt: previous?.createdAt ?? now.toISOString(), updatedAt: now.toISOString(),
    };
    this.matchingListings.set(this.discoveryKey(userId, kind), listing);
    return listing;
  }

  async withdrawMatchingListing(userId: string, kind: DiscoveryKind, expectedListingId: string | null, expectedListingVersion: number, now: Date): Promise<MatchingListingRecord | null> {
    const previous = await this.readMatchingListing(userId, kind);
    if ((previous?.id ?? null) !== expectedListingId || (previous?.version ?? 0) !== expectedListingVersion) throw new MatchingConflictError();
    if (!previous || previous.status === "withdrawn") return previous;
    const listing: MatchingListingRecord = { ...previous, status: "withdrawn", active: false,
      version: previous.version + 1, updatedAt: now.toISOString() };
    this.matchingListings.set(this.discoveryKey(userId, kind), listing);
    return listing;
  }

  async readMatchingExamples(userId: string, kind: DiscoveryKind) {
    this.assertDiscoveryOwner(userId);
    return this.matchingExamples.filter((item) => item.kind !== kind);
  }

  async readMatchingCandidates(userId: string, kind: DiscoveryKind) {
    const source = await this.readMatchingListing(userId, kind);
    if (!source?.active) return { source, candidates: [], catalogLimited: false };
    const candidates: MatchingListingRecord[] = [];
    for (const stored of this.matchingListings.values()) {
      if (stored.ownerUserId === userId || stored.kind === kind || !stored.skills.some((skill) => source.skills.includes(skill))) continue;
      const listing = await this.readMatchingListing(stored.ownerUserId, stored.kind);
      if (listing?.active) candidates.push(listing);
    }
    candidates.sort((left, right) => right.skills.filter((skill) => source.skills.includes(skill)).length
      - left.skills.filter((skill) => source.skills.includes(skill)).length || left.id.localeCompare(right.id));
    return { source, candidates: candidates.slice(0, 500), catalogLimited: candidates.length > 500 };
  }

  async readWorkspaceSummary(userId: string, role: AuthRole): Promise<WorkspaceSummary> {
    const user = this.findUserById(userId);
    if (!user) throw new Error("Unknown user.");
    const kind: DiscoveryKind = role === "talent" ? "capability" : "problem";
    const state = this.discoveries.get(this.discoveryKey(userId, kind));
    const flow = state?.artifact?.draft.flow;
    const confirmed = flow && typeof flow === "object" && !Array.isArray(flow)
      && flow.status === "confirmed" && typeof flow.confirmedAt === "string" && flow.confirmedAt.length > 0;
    return {
      role,
      emailVerified: Boolean(user.emailVerifiedAt),
      discoveryKind: kind,
      discoveryCompleted: Boolean(confirmed),
      activeThreadId: state?.thread.id ?? null,
      turnCount: state?.turns.length ?? 0,
      artifactVersion: state?.artifact?.version ?? null,
      updatedAt: state?.thread.updatedAt ?? null,
    };
  }

  async createEnterpriseInquiry(inquiry: NewEnterpriseInquiry): Promise<EnterpriseInquiry> {
    const existing = this.inquiries.get(inquiry.id);
    if (existing) return existing;
    this.inquiryInputs.push(inquiry);
    const created: EnterpriseInquiry = {
      id: inquiry.id,
      contactMethod: inquiry.contactMethod,
      source: inquiry.source,
      status: "new",
      consentedAt: inquiry.consentedAt,
      createdAt: inquiry.createdAt,
    };
    this.inquiries.set(inquiry.id, created);
    this.adminInquiries.set(inquiry.id, {
      id: inquiry.id, contactMethod: inquiry.contactMethod, source: inquiry.source, status: "new",
      version: 1, createdAt: inquiry.createdAt, updatedAt: inquiry.createdAt, notificationStatus: "pending",
    });
    return created;
  }

  async listAdminInquiries(status: ManagedInquiryStatus, limit: number, cursor: InquiryCursor | null) {
    const all = [...this.adminInquiries.values()];
    const rows = all.filter((item) => item.status === status).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    const filtered = rows.filter((item) => !cursor || item.createdAt.toISOString() < cursor.createdAt || (item.createdAt.toISOString() === cursor.createdAt && item.id < cursor.id));
    const items = filtered.slice(0, limit);
    const last = items.at(-1);
    const counts = { new: 0, contacted: 0, closed: 0 };
    for (const item of all) counts[item.status] += 1;
    return { items, counts, nextCursor: filtered.length > limit && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null };
  }

  async updateInquiryStatus(actorUserId: string, inquiryId: string, status: ManagedInquiryStatus, expectedVersion: number) {
    const inquiry = this.adminInquiries.get(inquiryId);
    if (!inquiry) return null;
    if (inquiry.version !== expectedVersion) throw new InquiryVersionConflictError();
    const updated = { ...inquiry, status, version: inquiry.version + 1, updatedAt: new Date() };
    this.adminInquiries.set(inquiryId, updated);
    this.inquiryAudit.push({ actorUserId, inquiryId, action: "status_changed" });
    return updated;
  }

  async revealInquiryContact(actorUserId: string, inquiryId: string, reason: string) {
    const inquiry = this.inquiryInputs.find((item) => item.id === inquiryId);
    if (!inquiry) return null;
    this.inquiryAudit.push({ actorUserId, inquiryId, action: "contact_revealed", reason });
    return { contactMethod: inquiry.contactMethod, contactCiphertext: inquiry.contactCiphertext, encryptionKeyId: inquiry.encryptionKeyId };
  }

  private discoveryKey(userId: string, kind: DiscoveryKind) {
    return `${userId}:${kind}`;
  }

  private findUserById(userId: string) {
    return [...this.users.values()].find((user) => user.id === userId);
  }

  private assertDiscoveryOwner(userId: string) {
    if (!this.findUserById(userId)) throw new DiscoveryKindForbiddenError();
  }
}

const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 8787,
  databaseUrl: "postgresql://unused",
  databaseSsl: false,
  webOrigin: "https://app.example.com",
  authTokenSecret: "test-secret-that-is-longer-than-thirty-two-characters",
  authCookieName: "__Host-duduhire_session",
  authCookieSecure: true,
  sessionTtlDays: 30,
  magicLinkTtlMinutes: 15,
  emailResendSeconds: 0,
  emailHourlyLimit: 100,
  emailDeliveryMode: "console",
  emailFrom: "DuduHire <test@example.com>",
  aiMode: "local",
  openAiBaseUrl: OFFICIAL_OPENAI_BASE_URL,
  contactDataKey: "11".repeat(32),
  contactDataKeyId: "contact-test-v1",
  logLevel: "silent",
  trustProxy: false,
};

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers["set-cookie"];
  const first = Array.isArray(value) ? value[0] : value;
  assert.ok(first);
  return first.split(";", 1)[0];
}

function cookieHeader(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers["set-cookie"];
  return Array.isArray(value) ? value.join("\n") : value ?? "";
}

async function signUpUser(
  app: Awaited<ReturnType<typeof buildApp>>,
  emailSender: MemoryEmailSender,
  email: string,
  role: AuthRole,
  existingBrowserCookie?: string,
) {
  const headers: Record<string, string> = { origin: config.webOrigin };
  if (existingBrowserCookie) headers.cookie = existingBrowserCookie;
  const start = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/challenges",
    headers,
    payload: { email, intent: "signup", role },
  });
  assert.equal(start.statusCode, 202);
  const browserCookie = cookieFrom(start);
  const message = emailSender.messages.at(-1);
  assert.ok(message);
  const token = new URLSearchParams(new URL(message.link).hash.slice(1)).get("token");
  assert.ok(token);
  const verify = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/verify",
    headers: { origin: config.webOrigin, cookie: browserCookie },
    payload: { token },
  });
  assert.equal(verify.statusCode, 200);
  return { browserCookie, sessionCookie: cookieFrom(verify) };
}

function joinedCookies(...cookies: string[]) {
  return cookies.join("; ");
}

test("matching API requires publication consent, keeps owner data private and invalidates changed discovery", async (context) => {
  const repository = new MemoryRepository();
  const sender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender: sender });
  context.after(() => app.close());
  for (const path of ["", "/results"]) {
    const guest = await app.inject({ method: "GET", url: `/api/v1/me/matching${path}` });
    assert.equal(guest.statusCode, 401);
    assert.equal(guest.headers["cache-control"], "no-store");
  }
  const client = await signUpUser(app, sender, "matching-client@example.com", "client");
  const talent = await signUpUser(app, sender, "matching-talent@example.com", "talent");
  const clientId = repository.users.get("matching-client@example.com")!.id;
  const talentId = repository.users.get("matching-talent@example.com")!.id;
  const clientHeaders = { origin: config.webOrigin, cookie: client.sessionCookie };
  const talentHeaders = { origin: config.webOrigin, cookie: talent.sessionCookie };
  const get = (headers: typeof clientHeaders, suffix = "") => app.inject({ method: "GET", url: `/api/v1/me/matching${suffix}`, headers });
  const empty = await get(clientHeaders);
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().source, null);
  assert.equal(empty.json().listing, null);
  const emptyWithdrawal = await app.inject({ method: "POST", url: "/api/v1/me/matching/withdraw", headers: clientHeaders,
    payload: { expectedListingId: null, expectedListingVersion: 0 } });
  assert.deepEqual(emptyWithdrawal.json(), { listing: null });
  assert.equal(emptyWithdrawal.statusCode, 200);
  const unboundWithdrawal = await app.inject({ method: "POST", url: "/api/v1/me/matching/withdraw", headers: clientHeaders,
    payload: { expectedListingVersion: 0 } });
  assert.equal(unboundWithdrawal.statusCode, 400, "Withdrawal must bind the expected listing identity, even when absent.");
  assert.equal((await get(clientHeaders, "/results")).json().error.code, "MATCHING_NOT_PUBLISHED");
  const clientDiscovery = await repository.appendDiscoveryTurn(clientId, "problem", matchingDiscoveryTurn("problem"), new Date(), null);
  const talentDiscovery = await repository.appendDiscoveryTurn(talentId, "capability", matchingDiscoveryTurn("capability", false), new Date(), null);
  const input = (state: DiscoveryState, expectedListingVersion = 0): PublishMatchingInput => ({
    ...matchingDraftFixture, expectedThreadId: state.thread.id, expectedVersion: state.thread.version, expectedListingVersion, consent: true,
  });
  const put = (headers: typeof clientHeaders, payload: unknown) => app.inject({ method: "PUT", url: "/api/v1/me/matching/listing", headers, payload: payload as Record<string, unknown> });
  assert.equal((await get(clientHeaders)).json().listing, null, "Confirmation alone must never publish.");
  assert.equal((await put(clientHeaders, { ...input(clientDiscovery), consent: false })).statusCode, 400);
  assert.equal((await put({ ...clientHeaders, origin: "https://untrusted.example" }, input(clientDiscovery))).statusCode, 403);
  assert.equal((await put(clientHeaders, { ...input(clientDiscovery), ownerUserId: talentId })).statusCode, 400);
  assert.equal((await put(clientHeaders, input(talentDiscovery))).statusCode, 409);
  assert.equal((await put(talentHeaders, input(talentDiscovery))).statusCode, 409);
  assert.equal((await put(clientHeaders, { ...input(clientDiscovery), notes: "邮箱：private@example.com" })).json().error.code, "INVALID_MATCHING_LISTING");
  const publishedClient = await put(clientHeaders, input(clientDiscovery));
  assert.equal(publishedClient.statusCode, 200, publishedClient.body);
  assert.equal(publishedClient.json().listing.active, true);
  assert.doesNotMatch(publishedClient.body, /ownerUserId|PRIVATE_|example\.com|private-evidence/u);
  assert.equal((await put(clientHeaders, input(clientDiscovery))).json().error.code, "MATCHING_VERSION_CONFLICT");
  assert.equal((await get(clientHeaders, "/results")).json().total, 0);
  const confirmedTalent = await repository.appendDiscoveryTurn(talentId, "capability", matchingDiscoveryTurn("capability"), new Date(), {
    threadId: talentDiscovery.thread.id, threadVersion: talentDiscovery.thread.version,
  });
  const publishedTalent = await put(talentHeaders, input(confirmedTalent));
  assert.equal(publishedTalent.statusCode, 200, publishedTalent.body);
  for (const headers of [clientHeaders, talentHeaders]) {
    const results = await get(headers, "/results");
    assert.equal(results.statusCode, 200, results.body);
    assert.equal(results.json().total, 1);
    assert.equal(results.json().matches.length, 1);
    assert.equal(results.json().catalogLimited, false);
    assert.equal(results.json().algorithm, "evidence-skills-v2");
    assert.equal(results.json().catalog, "published");
    assert.doesNotMatch(results.body, /ownerUserId|sourceThread|userId|PRIVATE_|private-evidence|example\.com/u);
  }
  const requiredTalent = await put(talentHeaders, { ...input(confirmedTalent, 1), requiredSkills: ["知识库"] });
  assert.equal(requiredTalent.statusCode, 400, "Only the problem owner can specify mandatory skills.");
  const staleAccountWithdrawal = await app.inject({ method: "POST", url: "/api/v1/me/matching/withdraw", headers: talentHeaders,
    payload: { expectedListingId: publishedClient.json().listing.id, expectedListingVersion: 1 } });
  assert.equal(staleAccountWithdrawal.statusCode, 409, "Equal versions from different accounts must not identify the same publication.");
  assert.equal(staleAccountWithdrawal.json().error.code, "MATCHING_VERSION_CONFLICT");
  assert.equal((await get(talentHeaders)).json().listing.version, 1);
  assert.equal((await get(talentHeaders)).json().listing.active, true);
  const withdrawn = await app.inject({ method: "POST", url: "/api/v1/me/matching/withdraw", headers: talentHeaders,
    payload: { expectedListingId: publishedTalent.json().listing.id, expectedListingVersion: 1 } });
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  assert.equal(withdrawn.json().listing.status, "withdrawn");
  assert.equal((await get(clientHeaders, "/results")).json().total, 0);
  assert.equal((await get(talentHeaders, "/results")).statusCode, 409);
  assert.equal((await put(talentHeaders, input(confirmedTalent, 2))).statusCode, 200);
  await repository.appendDiscoveryTurn(talentId, "capability", matchingDiscoveryTurn("capability", false), new Date(), {
    threadId: confirmedTalent.thread.id, threadVersion: confirmedTalent.thread.version,
  });
  const staleListing = (await get(talentHeaders)).json().listing;
  assert.equal(staleListing.status, "published");
  assert.equal(staleListing.active, false);
  assert.equal((await get(clientHeaders, "/results")).json().total, 0);
  await repository.resetDiscovery(clientId, "problem", new Date());
  assert.equal((await get(clientHeaders)).json().listing.active, false);
  assert.equal((await get(clientHeaders, "/results")).statusCode, 409);
});

test("private matching preview requires a confirmed owner, isolates examples, and never publishes", async (context) => {
  const repository = new MemoryRepository(); const sender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender: sender }); context.after(() => app.close());
  const client = await signUpUser(app, sender, "example-preview@example.com", "client");
  const userId = repository.users.get("example-preview@example.com")!.id;
  const headers = { origin: config.webOrigin, cookie: client.sessionCookie };
  const preview = (draft = matchingDraftFixture) => app.inject({ method: "POST", url: "/api/v1/me/matching/preview", headers, payload: { draft } });
  assert.equal((await preview()).statusCode, 409);
  await repository.appendDiscoveryTurn(userId, "problem", matchingDiscoveryTurn("problem"), new Date(), null);
  for (const workMode of ["onsite", "hybrid"] as const) {
    const missingCity = await preview({ ...matchingDraftFixture, workMode, location: "" });
    assert.equal(missingCity.statusCode, 400);
    assert.match(missingCity.json().error.message, /合作城市/u);
  }
  const empty = await preview();
  assert.equal(empty.statusCode, 200); assert.equal(empty.json().catalogStatus, "empty");
  assert.match(empty.json().notice, /尚未导入/u);
  const now = new Date().toISOString();
  repository.matchingExamples = MATCHING_EXAMPLES.map((item) => ({ ...item.draft, id: item.id, kind: item.kind, version: 1, createdAt: now, updatedAt: now, isExample: true, contactable: false }));
  repository.matchingExamples.push({ ...matchingDraftFixture, id: "real-record-sentinel", kind: "capability", version: 1, createdAt: now, updatedAt: now });
  const response = await preview();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().catalog, "examples"); assert.equal(response.json().catalogStatus, "ready");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.ok(response.json().total > 0);
  for (const item of response.json().matches) { assert.equal(item.listing.isExample, true); assert.equal(item.listing.contactable, false); }
  assert.doesNotMatch(response.body, /real-record-sentinel|ownerUserId|sourceThreadId/u);
  assert.equal(repository.matchingListings.size, 0);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/me/matching/results", headers })).statusCode, 409);
  const rejected = await preview({ ...matchingDraftFixture, constraints: { markets: ["private@example.com"] } } as typeof matchingDraftFixture);
  assert.equal(rejected.statusCode, 400);
  const unauthenticated = await app.inject({ method: "POST", url: "/api/v1/me/matching/preview", headers: { origin: config.webOrigin }, payload: { draft: matchingDraftFixture } });
  assert.equal(unauthenticated.statusCode, 401);
});

test("normalizes email and rejects unsafe return paths", () => {
  assert.equal(normalizeEmail("  User@Example.COM  "), "user@example.com");
  assert.equal(normalizeEmail("not-an-email"), null);
  for (const unsafeEmail of [
    "group:victim@example.com;",
    "victim(comment)@example.com",
    "<victim@example.com>",
    "victim@example.com>",
    "victim..alias@example.com",
  ]) assert.equal(normalizeEmail(unsafeEmail), null);
  assert.equal(normalizeReturnTo("//evil.example/path"), "/workspace");
  assert.equal(normalizeReturnTo("/%2e%2e//evil.example"), "/workspace");
  assert.equal(normalizeReturnTo("/workspace?tab=profile"), "/workspace?tab=profile");
  assert.equal(normalizeReturnTo("/auth/verify#token=attacker"), "/workspace");
});

test("production config refuses insecure email and cookie settings", () => {
  assert.throws(() => loadDatabaseConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://example/database",
    DATABASE_SSL: "false",
  }), /TLS/u);

  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://example",
    DATABASE_SSL: "true",
    WEB_ORIGIN: "https://duduhire.com",
    AUTH_TOKEN_SECRET: "a-secure-secret-with-at-least-32-characters",
    AUTH_COOKIE_SECURE: "false",
    EMAIL_DELIVERY_MODE: "console",
    EMAIL_FROM: "DuduHire <no-reply@example.com>",
  }), /Secure/u);

  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://example",
    DATABASE_SSL: "true",
    WEB_ORIGIN: "https://duduhire.com",
    AUTH_TOKEN_SECRET: "a-secure-secret-with-at-least-32-characters",
    EMAIL_DELIVERY_MODE: "smtp",
    SMTP_URL: "smtps://smtp.example.com:465",
    EMAIL_FROM: "DuduHire <no-reply@example.com>",
  }), /credentials/u);

  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://example",
    DATABASE_SSL: "true",
    WEB_ORIGIN: "https://duduhire.com",
    AUTH_TOKEN_SECRET: "a-secure-secret-with-at-least-32-characters",
    EMAIL_DELIVERY_MODE: "smtp",
    SMTP_URL: "smtps://user:password@smtp.example.com:465",
  }), /EMAIL_FROM/u);

  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://example/database?sslmode=disable",
    DATABASE_SSL: "true",
    WEB_ORIGIN: "https://duduhire.com",
    AUTH_TOKEN_SECRET: "a-secure-secret-with-at-least-32-characters",
    EMAIL_DELIVERY_MODE: "smtp",
    SMTP_URL: "smtps://user:password@smtp.example.com:465",
    EMAIL_FROM: "DuduHire <no-reply@example.com>",
  }), /DATABASE_URL cannot contain SSL/u);
});

test("SMTP transport cannot downgrade production TLS options", () => {
  const options = createSmtpTransportOptions("smtp://user:password@smtp.example.com:587", true);
  assert.equal(options.host, "smtp.example.com");
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.pool, true);
  assert.equal(options.maxConnections, 5);
  assert.equal(options.maxMessages, 100);
  assert.equal(options.maxRequeues, 0);
  assert.equal(options.requireTLS, true);
  assert.equal(options.ignoreTLS, false);
  assert.equal(options.connectionTimeout, 5_000);
  assert.equal(options.greetingTimeout, 5_000);
  assert.equal(options.socketTimeout, 10_000);
  assert.deepEqual(options.auth, { user: "user", pass: "password" });
});

test("production email can only be disabled explicitly and retains all other startup guards", () => {
  const env = {
    NODE_ENV: "production", DATABASE_URL: "postgresql://runtime:synthetic@database.example.test/duduhire",
    DATABASE_SSL: "true", WEB_ORIGIN: "https://app.example.test",
    AUTH_TOKEN_SECRET: "synthetic-auth-secret-with-more-than-thirty-two-characters",
    EMAIL_DELIVERY_MODE: "disabled", AI_MODE: "qwen", QWEN_API_KEY: "sk-synthetic-qwen-test",
    CONTACT_DATA_KEY: "0123456789abcdef".repeat(4), CONTACT_DATA_KEY_ID: "contact-test-v1",
  };
  const configured = loadConfig(env);
  assert.equal(configured.emailDeliveryMode, "disabled");
  assert.equal(configured.smtpUrl, undefined);
  assert.equal(configured.emailFrom, "");
  assert.equal(loadConfig({ ...env, SMTP_URL: "unused-invalid-smtp" }).smtpUrl, undefined);
  assert.throws(() => loadConfig({ ...env, EMAIL_DELIVERY_MODE: "smtp" }), /SMTP_URL/u);
  for (const mode of [undefined, "console"]) {
    assert.throws(() => loadConfig({ ...env, EMAIL_DELIVERY_MODE: mode, EMAIL_FROM: "DuduHire <no-reply@example.test>" }), /Production email delivery/u);
  }
  for (const [change, error] of [
    [{ DATABASE_SSL: "false" }, /TLS/u],
    [{ WEB_ORIGIN: "http://app.example.test" }, /HTTPS/u],
    [{ AUTH_COOKIE_SECURE: "false" }, /Secure/u],
    [{ AUTH_COOKIE_NAME: "unsafe_session" }, /__Host-/u],
    [{ AUTH_TOKEN_SECRET: "changeme-changeme-changeme-changeme" }, /random secret/u],
    [{ QWEN_API_KEY: "" }, /QWEN_API_KEY/u],
    [{ AI_MODE: "local" }, /Production AI_MODE/u],
    [{ CONTACT_DATA_KEY: "" }, /CONTACT_DATA_KEY/u],
  ] as const) assert.throws(() => loadConfig({ ...env, ...change }), error);
});

test("database pools use bounded workload-specific timeouts", async () => {
  const runtimePool = createDatabasePool("postgresql://localhost/duduhire", false);
  const migrationPool = createDatabasePool("postgresql://localhost/duduhire", false, "migration");
  assert.equal(runtimePool.options.connectionTimeoutMillis, 5_000);
  assert.equal(runtimePool.options.statement_timeout, 5_000);
  assert.equal(runtimePool.options.query_timeout, 7_000);
  assert.equal(runtimePool.options.lock_timeout, 3_000);
  assert.equal(migrationPool.options.statement_timeout, 300_000);
  assert.equal(migrationPool.options.lock_timeout, 30_000);
  assert.ok(runtimePool.listenerCount("error") > 0);
  assert.doesNotThrow(() => runtimePool.emit("error", new Error("simulated idle connection failure")));

  const previousPgOptions = process.env.PGOPTIONS;
  process.env.PGOPTIONS = "-c statement_timeout=0 -c lock_timeout=0";
  const actualClient = new Client(runtimePool.options);
  if (previousPgOptions === undefined) delete process.env.PGOPTIONS;
  else process.env.PGOPTIONS = previousPgOptions;
  const connectionParameters = (actualClient as unknown as {
    connectionParameters: Record<string, unknown>;
  }).connectionParameters;
  assert.equal(connectionParameters.statement_timeout, 5_000);
  assert.equal(connectionParameters.query_timeout, 7_000);
  assert.equal(connectionParameters.lock_timeout, 3_000);
  assert.equal(connectionParameters.idle_in_transaction_session_timeout, 10_000);
  assert.equal(connectionParameters.application_name, "duduhire_runtime");
  assert.equal(
    connectionParameters.options,
    "-c search_path=public,pg_catalog -c statement_timeout=5000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000",
  );
  await Promise.all([runtimePool.end(), migrationPool.end()]);
});

test("database transaction failures destroy the connection and preserve the original error", async () => {
  const originalError = new Error("original transaction failure");
  let releasedWith: Error | boolean | undefined;
  const client = Object.assign(new EventEmitter(), {
    async query(statement: string) {
      if (statement === "ROLLBACK") throw new Error("rollback also failed");
      return { rows: [] };
    },
    release(error?: Error | boolean) {
      releasedWith = error;
    },
  }) as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;

  await assert.rejects(
    withTransaction(pool, async () => { throw originalError; }),
    (error: unknown) => error === originalError,
  );
  assert.equal(releasedWith, originalError);
  assert.equal(client.listenerCount("error"), 0);
});

test("active database client errors abort and destroy the transaction connection", async () => {
  const connectionError = new Error("connection interrupted");
  let releasedWith: Error | boolean | undefined;
  const client = Object.assign(new EventEmitter(), {
    async query() {
      return { rows: [] };
    },
    release(error?: Error | boolean) {
      releasedWith = error;
    },
  }) as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;

  await assert.rejects(
    withTransaction(pool, async (activeClient) => {
      activeClient.emit("error", connectionError);
      return "uncommitted";
    }),
    (error: unknown) => error === connectionError,
  );
  assert.equal(releasedWith, connectionError);
  assert.equal(client.listenerCount("error"), 0);
});

test("email challenges distinguish development from email delivery without exposing credentials", async (context) => {
  for (const mode of ["console", "smtp"] as const) {
    const repository = new MemoryRepository();
    const emailSender = new MemoryEmailSender();
    const app = await buildApp({ config: { ...config, emailDeliveryMode: mode }, repository, emailSender });
    context.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email/challenges",
      headers: { origin: config.webOrigin },
      payload: { email: "delivery-check@example.com", intent: "signup", role: "client" },
    });

    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), {
      accepted: true,
      delivery: mode === "smtp" ? "email" : "development",
      expiresInSeconds: config.magicLinkTtlMinutes * 60,
      resendAfterSeconds: config.emailResendSeconds,
    });
    assert.equal(emailSender.messages.length, 1);
    assert.equal(repository.users.size, 0);
    assert.equal(repository.sessions.size, 0);
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("disabled email refuses signup, login and existing links without sending or changing authentication state", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const enabledApp = await buildApp({ config, repository, emailSender });
  context.after(() => enabledApp.close());
  const priorChallenge = await enabledApp.inject({
    method: "POST", url: "/api/v1/auth/email/challenges", headers: { origin: config.webOrigin },
    payload: { email: "disabled-auth@example.test", intent: "signup", role: "client" },
  });
  assert.equal(priorChallenge.statusCode, 202);
  const token = new URLSearchParams(new URL(emailSender.messages[0]!.link).hash.slice(1)).get("token");
  assert.ok(token);
  const originalChallenges = structuredClone(repository.challenges);
  const disabledApp = await buildApp({ config: { ...config, emailDeliveryMode: "disabled" }, repository, emailSender });
  context.after(() => disabledApp.close());
  const methods = await disabledApp.inject("/api/v1/auth/methods");
  assert.deepEqual(methods.json().email, { available: false, delivery: "disabled" });
  assert.equal(methods.headers["cache-control"], "no-store");

  for (const intent of ["signup", "login"] as const) {
    const response = await disabledApp.inject({
      method: "POST", url: "/api/v1/auth/email/challenges", headers: { origin: config.webOrigin },
      payload: { email: "disabled-auth@example.test", intent, ...(intent === "signup" ? { role: "client" } : {}) },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "EMAIL_AUTH_DISABLED");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const verification = await disabledApp.inject({
    method: "POST", url: "/api/v1/auth/email/verify",
    headers: { origin: config.webOrigin, cookie: cookieFrom(priorChallenge) }, payload: { token },
  });
  assert.equal(verification.statusCode, 503);
  assert.equal(verification.json().error.code, "EMAIL_AUTH_DISABLED");
  assert.equal(verification.headers["set-cookie"], undefined);
  assert.equal(verification.headers["cache-control"], "no-store");
  assert.equal(emailSender.messages.length, 1);
  assert.deepEqual(repository.challenges, originalChallenges);
  assert.equal(repository.users.size, 0);
  assert.equal(repository.sessions.size, 0);
});

test("challenge response waits for SMTP acceptance and keeps the delivered link usable", async (context) => {
  const repository = new MemoryRepository();
  const messages: Array<{ to: string; link: string; expiresInMinutes: number }> = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let finishDelivery!: () => void;
  const delivery = new Promise<void>((resolve) => { finishDelivery = resolve; });
  const emailSender: EmailSender = {
    async sendMagicLink(message) {
      messages.push(message);
      markStarted();
      await delivery;
    },
    async close() {},
  };
  const app = await buildApp({ config: { ...config, emailDeliveryMode: "smtp" }, repository, emailSender });
  context.after(() => app.close());

  const responsePromise = app.inject({
    method: "POST",
    url: "/api/v1/auth/email/challenges",
    headers: { origin: config.webOrigin },
    payload: { email: "slow-smtp@example.com", intent: "signup", role: "client" },
  });
  await started;
  const earlyOutcome = await Promise.race([
    responsePromise.then(() => "responded" as const),
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 5)),
  ]);
  assert.equal(earlyOutcome, "waiting");

  finishDelivery();
  const response = await responsePromise;
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().delivery, "email");
  assert.equal(repository.challenges.length, 1);
  assert.ok(repository.challenges[0]!.expiresAt.getTime() > Date.now());

  const token = new URLSearchParams(new URL(messages[0]!.link).hash.slice(1)).get("token");
  assert.ok(token);
  const verification = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/verify",
    headers: { origin: config.webOrigin, cookie: cookieFrom(response) },
    payload: { token },
  });
  assert.equal(verification.statusCode, 200);
});

test("definitive email failure invalidates its challenge", async (context) => {
  const repository = new MemoryRepository();
  const emailSender: EmailSender = {
    async sendMagicLink() {
      throw new Error("SMTP rejected the message");
    },
    async close() {},
  };
  const app = await buildApp({ config, repository, emailSender });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/challenges",
    headers: { origin: config.webOrigin },
    payload: { email: "rejected-smtp@example.com", intent: "signup", role: "client" },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(repository.challenges[0]!.expiresAt.getTime(), 0);
});

test("malformed connection URLs never echo embedded secrets", () => {
  const databaseSecret = "database-super-secret";
  assert.throws(
    () => loadDatabaseConfig({ DATABASE_URL: `postgresql://user:${databaseSecret}@[broken`, DATABASE_SSL: "false" }),
    (error: unknown) => error instanceof Error && !error.message.includes(databaseSecret) && !("input" in error),
  );
  assert.throws(
    () => createDatabasePool(`postgresql://user:${databaseSecret}@[broken`, false),
    (error: unknown) => error instanceof Error && !error.message.includes(databaseSecret) && !("input" in error),
  );
  assert.throws(
    () => loadDatabaseConfig({
      DATABASE_URL: "postgresql://localhost/duduhire?statement_timeout=0&options=-c%20search_path%3Devil",
      DATABASE_SSL: "false",
    }),
    /cannot contain query parameters or a fragment/u,
  );
  assert.throws(
    () => createDatabasePool("postgresql://localhost/duduhire?query_timeout=0&application_name=evil", false),
    /query parameters or fragments cannot override/u,
  );
  assert.throws(
    () => createDatabasePool("postgresql://localhost/duduhire#unexpected", false),
    /query parameters or fragments cannot override/u,
  );
  const smtpSecret = "smtp-super-secret";
  assert.throws(
    () => createSmtpTransportOptions(`smtp://user:${smtpSecret}@[broken`, true),
    (error: unknown) => error instanceof Error && !error.message.includes(smtpSecret) && !("input" in error),
  );
});

test("readiness rejects an incomplete database schema", async () => {
  const pool = {
    query: async () => ({ rows: [{ schema_ready: false }] }),
  } as unknown as Pool;
  await assert.rejects(new PostgresRepository(pool).ping(), /schema is not ready/u);
});

test("guest session probe pre-seeds the browser binding used by a challenge", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender });
  context.after(() => app.close());

  const probe = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
  assert.deepEqual(probe.json(), { session: null });
  const preseededBinding = cookieFrom(probe);
  assert.match(preseededBinding, /^__Host-duduhire_auth_intent=/u);

  const start = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/challenges",
    headers: { origin: config.webOrigin, cookie: preseededBinding },
    payload: { email: "preseed@example.com", intent: "signup", role: "client" },
  });
  assert.equal(start.statusCode, 202);
  assert.equal(cookieFrom(start), preseededBinding);
});

test("verified magic link creates an initial-role session and server profile", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender });
  context.after(() => app.close());

  const start = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/challenges",
    headers: { origin: config.webOrigin },
    payload: { email: "Talent@Example.com", intent: "signup", role: "talent", returnTo: "/workspace?tab=profile" },
  });
  assert.equal(start.statusCode, 202);
  assert.equal(emailSender.messages.length, 1);
  const browserBindingCookie = cookieFrom(start);
  assert.match(browserBindingCookie, /^(?:__Host-)?duduhire_auth_intent=/u);
  assert.match(cookieHeader(start), /HttpOnly/u);
  assert.match(cookieHeader(start), /Secure/u);
  assert.match(cookieHeader(start), /SameSite=Lax/u);
  assert.match(cookieHeader(start), /Path=\//u);

  const verificationUrl = new URL(emailSender.messages[0]!.link);
  assert.equal(`${verificationUrl.origin}${verificationUrl.pathname}`, "https://app.example.com/auth/verify");
  const token = new URLSearchParams(verificationUrl.hash.slice(1)).get("token");
  assert.ok(token);
  const unboundVerify = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/verify",
    headers: { origin: config.webOrigin },
    payload: { token },
  });
  assert.equal(unboundVerify.statusCode, 400);
  assert.equal(unboundVerify.json().error.code, "BROWSER_CONTEXT_REQUIRED");
  const mismatchedVerify = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/verify",
    headers: { origin: config.webOrigin, cookie: `__Host-duduhire_auth_intent=${createOpaqueToken()}` },
    payload: { token },
  });
  assert.equal(mismatchedVerify.statusCode, 400);
  assert.equal(mismatchedVerify.json().error.code, "INVALID_OR_EXPIRED_LINK");
  const verify = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/verify",
    headers: { origin: config.webOrigin, cookie: browserBindingCookie },
    payload: { token },
  });
  assert.equal(verify.statusCode, 200);
  assert.deepEqual(verify.json(), { authenticated: true, returnTo: "/workspace?tab=profile" });
  const cookie = cookieFrom(verify);
  assert.match(cookie, /^__Host-duduhire_session=/u);
  assert.match(cookieHeader(verify), /HttpOnly/u);
  assert.match(cookieHeader(verify), /Secure/u);
  assert.match(cookieHeader(verify), /SameSite=Lax/u);
  assert.match(cookieHeader(verify), /Path=\//u);

  const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } });
  assert.equal(session.statusCode, 200);
  const sessionBody = session.json();
  assert.equal(sessionBody.session.user.email, "talent@example.com");
  assert.equal(sessionBody.session.user.role, "talent");
  assert.ok(sessionBody.session.user.emailVerifiedAt);
  assert.deepEqual(sessionBody.session.profile, {
    displayName: "",
    countryCode: "",
    contact: "",
    organization: "",
    jobTitle: "",
    professionalTitle: "",
    bio: "",
    version: 0,
    updatedAt: null,
  });

  const profileValue = {
    displayName: "林岚",
    countryCode: "CN",
    contact: "weixin-id",
    organization: "",
    jobTitle: "",
    professionalTitle: "AI 产品顾问",
    bio: "专注复杂业务流程。",
    version: 0,
  };
  const save = await app.inject({
    method: "PUT",
    url: "/api/v1/me/profile",
    headers: { cookie, origin: config.webOrigin },
    payload: profileValue,
  });
  assert.equal(save.statusCode, 200);
  assert.deepEqual(save.json().profile.displayName, profileValue.displayName);

  const profile = await app.inject({ method: "GET", url: "/api/v1/me/profile", headers: { cookie } });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().profile.professionalTitle, "AI 产品顾问");

  const refreshedSession = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } });
  assert.equal(refreshedSession.json().session.profile.displayName, "林岚");

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/verify",
    headers: { origin: config.webOrigin, cookie: browserBindingCookie },
    payload: { token },
  });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().error.code, "INVALID_OR_EXPIRED_LINK");

  const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie, origin: config.webOrigin } });
  assert.equal(logout.statusCode, 204);
  assert.match(cookieHeader(logout), /(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/u);
  const signedOut = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } });
  assert.equal(signedOut.json().session, null);
});

test("registration does not change the initial role and untrusted origins are rejected", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender });
  context.after(() => app.close());

  const rejected = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/challenges",
    headers: { origin: "https://evil.example" },
    payload: { email: "owner@example.com", intent: "signup", role: "client" },
  });
  assert.equal(rejected.statusCode, 403);

  for (const role of ["talent", "client"] as const) {
    const started = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email/challenges",
      headers: { origin: config.webOrigin },
      payload: { email: "owner@example.com", intent: "signup", role },
    });
    assert.equal(started.statusCode, 202);
    const browserBindingCookie = cookieFrom(started);
    const message = emailSender.messages.at(-1);
    assert.ok(message);
    const url = new URL(message.link);
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    assert.ok(token);
    const verified = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email/verify",
      headers: { origin: config.webOrigin, cookie: browserBindingCookie },
      payload: { token },
    });
    assert.equal(verified.statusCode, 200);
  }

  assert.equal(repository.users.get("owner@example.com")?.role, "talent");
});

test("the newest same-browser signup link determines the initial role", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender });
  context.after(() => app.close());

  const first = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/challenges",
    headers: { origin: config.webOrigin },
    payload: { email: "new-role@example.com", intent: "signup", role: "talent" },
  });
  const browserCookie = cookieFrom(first);
  const firstToken = new URLSearchParams(new URL(emailSender.messages[0]!.link).hash.slice(1)).get("token");
  assert.ok(firstToken);

  const second = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/challenges",
    headers: { origin: config.webOrigin, cookie: browserCookie },
    payload: { email: "new-role@example.com", intent: "signup", role: "client" },
  });
  assert.equal(second.statusCode, 202);
  const secondToken = new URLSearchParams(new URL(emailSender.messages[1]!.link).hash.slice(1)).get("token");
  assert.ok(secondToken);

  const stale = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/verify",
    headers: { origin: config.webOrigin, cookie: browserCookie },
    payload: { token: firstToken },
  });
  assert.equal(stale.statusCode, 400);

  const latest = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/verify",
    headers: { origin: config.webOrigin, cookie: browserCookie },
    payload: { token: secondToken },
  });
  assert.equal(latest.statusCode, 200);
  assert.equal(repository.users.get("new-role@example.com")?.role, "client");
});

test("login for an unknown address is rejected before creating a challenge or sending email", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender });
  context.after(() => app.close());

  const start = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/challenges",
    headers: { origin: config.webOrigin },
    payload: { email: "missing@example.com", intent: "login", returnTo: "/workspace" },
  });
  assert.equal(start.statusCode, 409);
  assert.equal(start.json().error.code, "ACCOUNT_NOT_REGISTERED");
  assert.equal(start.headers["cache-control"], "no-store");
  assert.equal(emailSender.messages.length, 0);
  assert.equal(repository.challenges.length, 0);
  assert.equal(repository.users.size, 0);
  assert.equal(repository.sessions.size, 0);
});

test("registered email login normalizes the account and preserves its role", async context => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender });
  context.after(() => app.close());
  await signUpUser(app, emailSender, "registered@example.test", "talent");
  const started = await app.inject({
    method: "POST", url: "/api/v1/auth/email/challenges", headers: { origin: config.webOrigin },
    payload: { email: " REGISTERED@EXAMPLE.TEST ", intent: "login", role: "client" },
  });
  assert.equal(started.statusCode, 202, started.body);
  assert.equal(emailSender.messages.length, 2);
  assert.equal(emailSender.messages[1]?.to, "registered@example.test");
  const token = new URLSearchParams(new URL(emailSender.messages[1]!.link).hash.slice(1)).get("token");
  const verified = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email/verify",
    headers: { origin: config.webOrigin, cookie: cookieFrom(started) },
    payload: { token },
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().authenticated, true);
  assert.equal(repository.users.size, 1);
  assert.equal(repository.users.get("registered@example.test")?.role, "talent");
});

test("login eligibility validates normalized identities without creating auth state or requiring a provider", async context => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const now = new Date();
  repository.users.set("registered@example.test", { id: "existing", email: "registered@example.test", role: "client",
    phone: "+8613900000001", emailVerifiedAt: now, phoneVerifiedAt: now, createdAt: now });
  const app = await buildApp({ config: { ...config, emailDeliveryMode: "disabled" }, repository, emailSender });
  context.after(() => app.close());
  const cases = [
    { method: "email", account: " REGISTERED@EXAMPLE.TEST ", registered: true },
    { method: "phone", account: "13900000001", registered: true },
    { method: "phone", account: "+8613900000001", registered: true },
    { method: "email", account: "unknown@example.test", registered: false },
    { method: "phone", account: "13900000002", registered: false },
  ];
  for (const { registered, ...payload } of cases) {
    const result = await app.inject({ method: "POST", url: "/api/v1/auth/login-eligibility",
      headers: { origin: config.webOrigin }, payload });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { registered });
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["set-cookie"], undefined);
  }
  for (const method of ["email", "phone"]) {
    const invalid = await app.inject({ method: "POST", url: "/api/v1/auth/login-eligibility",
      headers: { origin: config.webOrigin }, payload: { method, account: "invalid" } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, method === "email" ? "INVALID_EMAIL" : "INVALID_PHONE");
  }
  assert.equal(emailSender.messages.length, 0);
  assert.equal(repository.challenges.length, 0);
  assert.equal(repository.sessions.size, 0);
  assert.equal(repository.users.size, 1);
});

test("login eligibility rejects untrusted origins and rate-limits lookups", async context => {
  const repository = new MemoryRepository();
  let lookups = 0;
  repository.isRegisteredLoginAccount = async () => { lookups += 1; return false; };
  const app = await buildApp({ config, repository, emailSender: new MemoryEmailSender() });
  context.after(() => app.close());
  const payload = { method: "email", account: "unknown@example.test" };
  for (const origin of [undefined, "https://untrusted.invalid"]) {
    const denied = await app.inject({ method: "POST", url: "/api/v1/auth/login-eligibility", remoteAddress: "127.0.0.2",
      headers: origin ? { origin } : {}, payload });
    assert.equal(denied.statusCode, 403);
  }
  assert.equal(lookups, 0);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login-eligibility",
      headers: { origin: config.webOrigin }, payload });
    assert.equal(response.statusCode, 200);
  }
  const limited = await app.inject({ method: "POST", url: "/api/v1/auth/login-eligibility",
    headers: { origin: config.webOrigin }, payload });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "RATE_LIMITED");
  assert.equal(limited.headers["cache-control"], "no-store");
  assert.equal(lookups, 60);
});

test("every state-changing API rejects missing or untrusted origins", async (context) => {
  const repository = new MemoryRepository();
  const app = await buildApp({ config, repository, emailSender: new MemoryEmailSender() });
  context.after(() => app.close());

  const requests = [
    app.inject({
      method: "POST",
      url: "/api/v1/discovery/intakes",
      payload: { prompt: "梳理销售流程" },
    }),
    app.inject({
      method: "POST",
      url: "/api/v1/enterprise/inquiries",
      headers: { origin: "https://attacker.example" },
      payload: { requestId: createId(), method: "phone", contactValue: "13800000000", source: "home_pricing" },
    }),
    app.inject({ method: "POST", url: "/api/v1/auth/logout" }),
  ];
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((response) => response.statusCode), [403, 403, 403]);
  for (const response of responses) assert.equal(response.json().error.code, "ORIGIN_NOT_ALLOWED");
  assert.equal(repository.intakeRecords.size, 0);
  assert.equal(repository.inquiryInputs.length, 0);

  const readOnly = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
  assert.equal(readOnly.statusCode, 200);
});

test("homepage intake is browser-bound, expires from reuse, and can be claimed exactly once", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender });
  context.after(() => app.close());

  const probe = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
  const browserCookie = cookieFrom(probe);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/discovery/intakes",
    headers: { origin: config.webOrigin, cookie: browserCookie },
    payload: { prompt: "  帮我重新设计销售线索跟进流程  " },
  });
  assert.equal(created.statusCode, 201);
  const intakeId = created.json().intakeId as string;
  assert.match(intakeId, /^[0-9a-f-]{36}$/u);
  assert.equal(repository.intakeRecords.get(intakeId)?.prompt, "帮我重新设计销售线索跟进流程");

  const signedIn = await signUpUser(app, emailSender, "intake-owner@example.com", "client", browserCookie);
  const wrongBrowser = await app.inject({
    method: "POST",
    url: `/api/v1/me/discovery/intakes/${intakeId}/claim`,
    headers: {
      origin: config.webOrigin,
      cookie: joinedCookies(signedIn.sessionCookie, `__Host-duduhire_auth_intent=${createOpaqueToken()}`),
    },
  });
  assert.equal(wrongBrowser.statusCode, 404);
  assert.equal(repository.intakeRecords.get(intakeId)?.claimedAt, null);

  const claimed = await app.inject({
    method: "POST",
    url: `/api/v1/me/discovery/intakes/${intakeId}/claim`,
    headers: { origin: config.webOrigin, cookie: joinedCookies(signedIn.sessionCookie, signedIn.browserCookie) },
  });
  assert.equal(claimed.statusCode, 200);
  assert.deepEqual(claimed.json(), { prompt: "帮我重新设计销售线索跟进流程" });
  assert.ok(repository.intakeRecords.get(intakeId)?.claimedAt);

  const replay = await app.inject({
    method: "POST",
    url: `/api/v1/me/discovery/intakes/${intakeId}/claim`,
    headers: { origin: config.webOrigin, cookie: joinedCookies(signedIn.sessionCookie, signedIn.browserCookie) },
  });
  assert.equal(replay.statusCode, 404);
  assert.equal(replay.json().error.code, "INTAKE_NOT_FOUND");
});

test("discovery is role-scoped, persisted, idempotent, and continues beyond eight turns with stable source references", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const advisorInputs: Array<Parameters<DiscoveryAdvisor["advise"]>[0]> = [];
  const discoveryAdvisor: DiscoveryAdvisor = {
    async advise(input) {
      advisorInputs.push(input);
      if (input.kind === "problem") {
        return {
          answer: `问题诊断：${input.message}`,
          artifact: {
            kind: "problem_brief",
            diagnosis: "销售信息没有形成连续的跟进链路。",
            action: "先统一线索状态",
            profile: "销售流程与 AI 自动化",
            evidence: ["流程图", "集成记录", "业务指标"],
          },
          provider: "local",
          model: "test-advisor",
          promptVersion: "test.v1",
        };
      }
      return {
        answer: `能力梳理：${input.message}`,
        artifact: {
          kind: "capability_identity",
          coreValue: "把复杂流程转化为可交付系统。",
          capabilityIdentity: "AI 工作流实施顾问",
          nextStep: "补充一个真实项目结果",
          evidence: ["项目记录", "交付物", "结果指标"],
        },
        provider: "local",
        model: "test-advisor",
        promptVersion: "test.v1",
      };
    },
  };
  const app = await buildApp({ config, repository, emailSender, discoveryAdvisor });
  context.after(() => app.close());

  const client = await signUpUser(app, emailSender, "discovery-client@example.com", "client");
  const talent = await signUpUser(app, emailSender, "discovery-talent@example.com", "talent");
  const clientRequestId = createId();
  const clientTurn = await app.inject({
    method: "POST",
    url: "/api/v1/me/discovery/turns",
    headers: { origin: config.webOrigin, cookie: client.sessionCookie },
    payload: {
      requestId: clientRequestId,
      prompt: "我们用 CRM，但销售线索仍然经常漏跟进。",
      attachments: [{ name: "process.txt", contentType: "text/plain", sizeBytes: 24, textExcerpt: "线索进入后由销售手动登记。" }],
    },
  });
  assert.equal(clientTurn.statusCode, 200);
  assert.equal(clientTurn.json().discovery.kind, "problem");
  assert.equal(clientTurn.json().discovery.turns.length, 1);
  assert.deepEqual(clientTurn.json().discovery.turns[0].attachments, [
    { name: "process.txt", mediaType: "text/plain", size: 24 },
  ]);
  assert.equal(clientTurn.json().discovery.artifact.draft.kind, "problem_brief");
  const clientUser = repository.users.get("discovery-client@example.com");
  assert.ok(clientUser);
  const storedClient = repository.discoveries.get(`${clientUser.id}:problem`);
  assert.equal(storedClient?.turns[0]?.provider, "local");
  assert.equal(storedClient?.turns[0]?.model, "test-advisor");
  assert.equal(storedClient?.turns[0]?.promptVersion, "test.v1");
  assert.match(storedClient?.turns[0]?.analysisContext ?? "", /线索进入后/u);

  const duplicate = await app.inject({
    method: "POST",
    url: "/api/v1/me/discovery/turns",
    headers: { origin: config.webOrigin, cookie: client.sessionCookie },
    payload: { requestId: clientRequestId, prompt: "重复提交不应调用模型", attachments: [] },
  });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().discovery.turns.length, 1);
  assert.equal(advisorInputs.length, 1);

  const kindOverride = await app.inject({
    method: "POST",
    url: "/api/v1/me/discovery/turns",
    headers: { origin: config.webOrigin, cookie: client.sessionCookie },
    payload: { requestId: clientRequestId, kind: "capability", prompt: "尝试覆盖身份", attachments: [] },
  });
  assert.equal(kindOverride.statusCode, 400);
  assert.equal(kindOverride.json().error.code, "INVALID_REQUEST");
  assert.equal(advisorInputs.length, 1);

  const talentTurn = await app.inject({
    method: "POST",
    url: "/api/v1/me/discovery/turns",
    headers: { origin: config.webOrigin, cookie: talent.sessionCookie },
    payload: { requestId: createId(), prompt: "我负责过 AI 客服知识库项目。", attachments: [] },
  });
  assert.equal(talentTurn.statusCode, 200);
  assert.equal(talentTurn.json().discovery.kind, "capability");
  assert.equal(talentTurn.json().discovery.artifact.draft.kind, "capability_identity");
  assert.deepEqual(advisorInputs.slice(0, 2).map((input) => input.kind), ["problem", "capability"]);

  for (let index = 2; index <= 8; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/me/discovery/turns",
      headers: { origin: config.webOrigin, cookie: client.sessionCookie },
      payload: { requestId: createId(), prompt: `补充业务信息 ${index}`, attachments: [] },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().discovery.turns.length, index);
  }

  const ninthTurn = await app.inject({
    method: "POST",
    url: "/api/v1/me/discovery/turns",
    headers: { origin: config.webOrigin, cookie: client.sessionCookie },
    payload: { requestId: createId(), prompt: "第九轮继续补充，不丢失历史材料", attachments: [] },
  });
  assert.equal(ninthTurn.statusCode, 200);
  assert.equal(ninthTurn.json().discovery.turns.length, 9);
  assert.equal(advisorInputs.length, 10);
  assert.match(advisorInputs.at(-1)?.context ?? "", /线索进入后由销售手动登记/u);
  assert.deepEqual(advisorInputs.at(-1)?.sources?.find((source) => source.id === `attachment:${clientRequestId}`), {
    id: `attachment:${clientRequestId}`,
    text: "附件：process.txt（text/plain）\n线索进入后由销售手动登记。",
    kind: "attachment",
  });
  assert.equal(advisorInputs.at(-1)?.previousArtifact?.kind, "problem_brief");
  assert.ok((advisorInputs.at(-1)?.context?.length ?? 0) <= 64_000);
  assert.equal(ninthTurn.json().discovery.version, storedClient?.thread.version);

  const workspace = await app.inject({
    method: "GET",
    url: "/api/v1/me/workspace",
    headers: { cookie: client.sessionCookie },
  });
  assert.equal(workspace.statusCode, 200);
  assert.equal(workspace.json().role, "client");
  assert.equal(workspace.json().emailVerified, true);
  assert.equal(workspace.json().discoveryKind, "problem");
  assert.equal(workspace.json().discoveryCompleted, false);
  assert.equal(workspace.json().turnCount, 9);
  assert.equal(workspace.json().artifactVersion, 9);
  assert.equal(workspace.json().paymentAccountStatus, "not_configured");
  assert.ok(workspace.json().activeThreadId);
  assert.ok(workspace.json().updatedAt);
});

test("both discovery flows persist draft, explicit confirmation, correction and reload without changing ownership", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender });
  context.after(() => app.close());
  const fixtures = [
    {
      role: "client" as const, kind: "problem", first: "工作背景：员工反复向HR询问制度",
      details: "主要工作：整理制度并建立可查询的资料入口\n预期结果：员工能独立找到常见问题的答案\n合作方式：阶段项目合作\n时间与合作条件：线上合作，预算待商议\n必要能力与加分经验：有资料整理与内部工具实施经历\n面谈核实重点：看实际项目中本人承担的工作",
      correction: "合作方式：改成长期兼职合作", field: "collaboration", corrected: "改成长期兼职合作",
    },
    {
      role: "talent" as const, kind: "capability", first: "经历背景：参与企业内部知识库整理项目",
      details: "个人职责：负责制度分类和资料整理\n具体行动：梳理重复问题并建立对应资料目录\n实际结果：员工反馈资料查找更方便，没有统计数字\n可提供的依据：可提供脱敏后的目录说明\n适合承担的工作：资料整理与知识库运营\n合作偏好：线上阶段项目合作",
      correction: "个人职责：我只参与资料整理，不负责整体项目", field: "role", corrected: "我只参与资料整理，不负责整体项目",
    },
  ];
  for (const fixture of fixtures) {
    const user = await signUpUser(app, emailSender, `flow-${fixture.role}@example.com`, fixture.role);
    const headers = { origin: config.webOrigin, cookie: user.sessionCookie };
    let threadId: string | null = null;
    let version = 0;
    const send = async (prompt: string) => {
      const response = await app.inject({ method: "POST", url: "/api/v1/me/discovery/turns", headers,
        payload: { requestId: createId(), prompt, attachments: [], expectedThreadId: threadId, expectedVersion: version } });
      assert.equal(response.statusCode, 200, response.body);
      const discovery = response.json().discovery;
      threadId = discovery.threadId;
      version = discovery.version;
      return discovery;
    };
    const first = await send(fixture.first);
    assert.equal(first.kind, fixture.kind);
    assert.equal(first.artifact.draft.flow.status, "collecting");
    const firstWorkspace = await app.inject({ method: "GET", url: "/api/v1/me/workspace", headers });
    assert.equal(firstWorkspace.json().discoveryCompleted, false);
    const ready = await send(fixture.details);
    assert.equal(ready.artifact.draft.flow.status, "ready");
    assert.equal(ready.artifact.draft.flow.confirmedAt, null);
    const unreadAttachment = await app.inject({ method: "POST", url: "/api/v1/me/discovery/turns", headers,
      payload: { requestId: createId(), prompt: "确认保存当前版本", expectedThreadId: threadId, expectedVersion: version,
        attachments: [{ name: "changes.txt", contentType: "text/plain", sizeBytes: 20, textExcerpt: "这里还有尚未处理的新材料" }] } });
    assert.equal(unreadAttachment.statusCode, 400);
    assert.equal(unreadAttachment.json().error.code, "CONFIRMATION_HAS_ATTACHMENTS");
    const confirmed = await send("确认保存当前版本");
    assert.equal(confirmed.artifact.draft.flow.status, "confirmed");
    assert.ok(Number.isFinite(Date.parse(confirmed.artifact.draft.flow.confirmedAt)));
    const workspace = await app.inject({ method: "GET", url: "/api/v1/me/workspace", headers });
    assert.equal(workspace.json().discoveryCompleted, true);
    const corrected = await send(fixture.correction);
    assert.equal(corrected.artifact.draft.flow.status, "ready");
    assert.equal(corrected.artifact.draft.flow.confirmedAt, null);
    assert.equal(corrected.artifact.draft.flow.fields[fixture.field].value, fixture.corrected);
    assert.equal(corrected.artifact.draft.flow.fields[fixture.field].evidence[0].sourceId, `user:${corrected.turns.at(-1).requestId}`);
    const changedWorkspace = await app.inject({ method: "GET", url: "/api/v1/me/workspace", headers });
    assert.equal(changedWorkspace.json().discoveryCompleted, false);
    const reloaded = await app.inject({ method: "GET", url: "/api/v1/me/discovery", headers });
    assert.deepEqual(reloaded.json().discovery, corrected);
    assert.equal(corrected.artifact.version, 4);
    assert.equal(corrected.turns.length, 4);
  }
});

test("discovery checks the browser version before calling the advisor and protects reset against stale tabs", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  let advisorCalls = 0;
  const discoveryAdvisor: DiscoveryAdvisor = {
    async advise() {
      advisorCalls += 1;
      return {
        answer: "请继续说明预期结果。",
        artifact: { kind: "problem_brief", diagnosis: "梳理重复工作", action: "待补充", profile: "待确认", evidence: ["待补充", "待补充", "待补充"] },
        provider: "local", model: "version-test", promptVersion: "test.v1",
      };
    },
  };
  const app = await buildApp({ config, repository, emailSender, discoveryAdvisor });
  context.after(() => app.close());
  const user = await signUpUser(app, emailSender, "discovery-version@example.com", "client");
  const headers = { origin: config.webOrigin, cookie: user.sessionCookie };
  const requestId = createId();
  const first = await app.inject({ method: "POST", url: "/api/v1/me/discovery/turns", headers,
    payload: { requestId, prompt: "需要解决重复答疑", attachments: [], expectedThreadId: null, expectedVersion: 0 } });
  assert.equal(first.statusCode, 200);
  const discovery = first.json().discovery;
  assert.ok(discovery.version > 0);
  const duplicate = await app.inject({ method: "POST", url: "/api/v1/me/discovery/turns", headers,
    payload: { requestId, prompt: "需要解决重复答疑", attachments: [], expectedThreadId: null, expectedVersion: 0 } });
  assert.equal(duplicate.statusCode, 200, "An exact retry wins before the stale-version check.");
  assert.equal(advisorCalls, 1);

  const unversionedConfirmation = await app.inject({ method: "POST", url: "/api/v1/me/discovery/turns", headers,
    payload: { requestId: createId(), prompt: "确认保存当前版本", attachments: [] } });
  assert.equal(unversionedConfirmation.statusCode, 409);
  assert.equal(unversionedConfirmation.json().error.code, "DISCOVERY_VERSION_REQUIRED");
  const stale = await app.inject({ method: "POST", url: "/api/v1/me/discovery/turns", headers,
    payload: { requestId: createId(), prompt: "确认保存当前版本", attachments: [], expectedThreadId: discovery.threadId, expectedVersion: 0 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "DISCOVERY_STATE_CONFLICT");
  const partial = await app.inject({ method: "POST", url: "/api/v1/me/discovery/turns", headers,
    payload: { requestId: createId(), prompt: "补充内容", attachments: [], expectedVersion: discovery.version } });
  assert.equal(partial.statusCode, 400);
  assert.equal(advisorCalls, 1, "Invalid versions must not incur a model call.");

  const staleReset = await app.inject({ method: "POST", url: "/api/v1/me/discovery/reset", headers,
    payload: { expectedThreadId: discovery.threadId, expectedVersion: 0 } });
  assert.equal(staleReset.statusCode, 409);
  assert.equal(repository.archivedDiscoveries.length, 0);
  const reset = await app.inject({ method: "POST", url: "/api/v1/me/discovery/reset", headers,
    payload: { expectedThreadId: discovery.threadId, expectedVersion: discovery.version } });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().discovery.version, 0);
  assert.equal(repository.archivedDiscoveries[0]?.thread.id, discovery.threadId);

  const oldConfirmation = await app.inject({ method: "POST", url: "/api/v1/me/discovery/turns", headers,
    payload: { requestId: createId(), prompt: "确认保存当前版本", attachments: [], expectedThreadId: discovery.threadId, expectedVersion: discovery.version } });
  assert.equal(oldConfirmation.statusCode, 409);
  assert.equal(advisorCalls, 1);
});

test("concurrent discovery replies preserve compare-and-swap and exact request idempotency", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const bothEntered = new Promise<void>((resolve) => { entered = resolve; });
  const discoveryAdvisor: DiscoveryAdvisor = {
    async advise() {
      calls += 1;
      if (calls === 2) entered();
      await gate;
      return {
        answer: "已记录，请补充目标。",
        artifact: { kind: "problem_brief", diagnosis: "重复答疑", action: "待补充", profile: "待确认", evidence: ["待补充", "待补充", "待补充"] },
        provider: "local", model: "concurrent-test", promptVersion: "test.v1",
      };
    },
  };
  const app = await buildApp({ config, repository, emailSender, discoveryAdvisor });
  context.after(async () => { release(); await app.close(); });
  const user = await signUpUser(app, emailSender, "concurrent-discovery@example.com", "client");
  const headers = { origin: config.webOrigin, cookie: user.sessionCookie };
  const send = (requestId: string) => app.inject({ method: "POST", url: "/api/v1/me/discovery/turns", headers,
    payload: { requestId, prompt: "梳理重复答疑", attachments: [], expectedThreadId: null, expectedVersion: 0 } });
  const first = send(createId());
  const second = send(createId());
  await bothEntered;
  release();
  const concurrent = await Promise.all([first, second]);
  assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [200, 409]);
  const winner = concurrent.find((response) => response.statusCode === 200)!.json().discovery;
  const sameId = createId();
  const duplicateSend = () => app.inject({ method: "POST", url: "/api/v1/me/discovery/turns", headers,
    payload: { requestId: sameId, prompt: "补充具体结果", attachments: [], expectedThreadId: winner.threadId, expectedVersion: winner.version } });
  const duplicates = await Promise.all([duplicateSend(), duplicateSend()]);
  assert.deepEqual(duplicates.map((response) => response.statusCode), [200, 200]);
  assert.equal(duplicates[0]!.json().discovery.turns.length, 2);
  assert.equal(duplicates[1]!.json().discovery.turns.length, 2);
});

test("a discovery reset during advisor work discards the stale response", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  let advisorCallCount = 0;
  let markSecondCallStarted!: () => void;
  const secondCallStarted = new Promise<void>((resolve) => { markSecondCallStarted = resolve; });
  let releaseSecondCall!: () => void;
  const secondCallRelease = new Promise<void>((resolve) => { releaseSecondCall = resolve; });
  const discoveryAdvisor: DiscoveryAdvisor = {
    async advise(input) {
      advisorCallCount += 1;
      if (advisorCallCount === 2) {
        markSecondCallStarted();
        await secondCallRelease;
      }
      return {
        answer: `问题诊断：${input.message}`,
        artifact: {
          kind: "problem_brief",
          diagnosis: "销售线索没有形成连续的跟进链路。",
          action: "先统一线索状态",
          profile: "销售流程与 AI 自动化",
          evidence: ["流程图", "集成记录", "业务指标"],
        },
        provider: "local",
        model: "delayed-test-advisor",
        promptVersion: "test.v1",
      };
    },
  };
  const app = await buildApp({ config, repository, emailSender, discoveryAdvisor });
  context.after(async () => {
    releaseSecondCall();
    await app.close();
  });

  const user = await signUpUser(app, emailSender, "discovery-reset-race@example.com", "client");
  const initialTurn = await app.inject({
    method: "POST",
    url: "/api/v1/me/discovery/turns",
    headers: { origin: config.webOrigin, cookie: user.sessionCookie },
    payload: { requestId: createId(), prompt: "我们的销售线索经常漏跟进。", attachments: [] },
  });
  assert.equal(initialTurn.statusCode, 200);
  assert.equal(initialTurn.json().discovery.turns.length, 1);

  const pendingTurn = app.inject({
    method: "POST",
    url: "/api/v1/me/discovery/turns",
    headers: { origin: config.webOrigin, cookie: user.sessionCookie },
    payload: { requestId: createId(), prompt: "请继续完善解决方案。", attachments: [] },
  });
  await secondCallStarted;

  const reset = await app.inject({
    method: "POST",
    url: "/api/v1/me/discovery/reset",
    headers: { origin: config.webOrigin, cookie: user.sessionCookie },
  });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().discovery.threadId, null);
  assert.deepEqual(reset.json().discovery.turns, []);

  releaseSecondCall();
  const staleResponse = await pendingTurn;
  assert.equal(staleResponse.statusCode, 409);
  assert.equal(staleResponse.json().error.code, "DISCOVERY_STATE_CONFLICT");

  const discovery = await app.inject({
    method: "GET",
    url: "/api/v1/me/discovery",
    headers: { cookie: user.sessionCookie },
  });
  assert.equal(discovery.statusCode, 200);
  assert.equal(discovery.json().discovery.threadId, null);
  assert.deepEqual(discovery.json().discovery.turns, []);
  assert.equal(discovery.json().discovery.artifact, null);
  assert.equal(repository.discoveries.size, 0);
  assert.equal(repository.archivedDiscoveries.length, 1);
  assert.equal(repository.archivedDiscoveries[0]?.turns.length, 1);
});

test("enterprise inquiries validate contact data and expose only encrypted, hashed persistence values", async (context) => {
  const repository = new MemoryRepository();
  const app = await buildApp({ config, repository, emailSender: new MemoryEmailSender() });
  context.after(() => app.close());

  const invalidPhone = await app.inject({
    method: "POST",
    url: "/api/v1/enterprise/inquiries",
    headers: { origin: config.webOrigin },
    payload: { requestId: createId(), method: "phone", contactValue: "not-a-phone", source: "home_pricing" },
  });
  assert.equal(invalidPhone.statusCode, 400);
  assert.equal(invalidPhone.json().error.code, "INVALID_CONTACT");
  assert.equal(repository.inquiryInputs.length, 0);

  const invalidWechat = await app.inject({
    method: "POST",
    url: "/api/v1/enterprise/inquiries",
    headers: { origin: config.webOrigin },
    payload: { requestId: createId(), method: "wechat", contactValue: "two words", source: "enterprise_page" },
  });
  assert.equal(invalidWechat.statusCode, 400);

  const requestId = createId();
  const rawContact = "+86 138 0000 0000";
  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/enterprise/inquiries",
    headers: { origin: config.webOrigin },
    payload: { requestId, method: "phone", contactValue: rawContact, source: "home_pricing" },
  });
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(accepted.json(), { accepted: true });
  assert.equal(repository.inquiryInputs.length, 1);
  const stored = repository.inquiryInputs[0];
  assert.ok(stored);
  assert.equal(stored.id, requestId);
  assert.equal(stored.userId, null);
  assert.equal(stored.contactMethod, "phone");
  assert.equal(stored.source, "home_pricing");
  assert.equal(stored.encryptionKeyId, config.contactDataKeyId);
  assert.notEqual(stored.contactCiphertext, rawContact);
  assert.notEqual(stored.contactHash, rawContact.toLocaleLowerCase("en-US"));
  assert.doesNotMatch(stored.contactCiphertext, /138 0000 0000/u);
  assert.doesNotMatch(JSON.stringify(stored), /\+86 138 0000 0000/u);

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/enterprise/inquiries",
    headers: { origin: config.webOrigin },
    payload: { requestId, method: "phone", contactValue: rawContact, source: "home_pricing" },
  });
  assert.equal(replay.statusCode, 202);
  assert.equal(repository.inquiryInputs.length, 1);
  assert.equal(repository.inquiries.size, 1);
});

test("pricing page inquiries preserve their source and retry idempotently while unsupported sources are rejected", async (context) => {
  const repository = new MemoryRepository();
  const app = await buildApp({ config, repository, emailSender: new MemoryEmailSender() });
  context.after(() => app.close());
  const requestId = createId();
  const inquiry = {
    requestId,
    method: "wechat",
    contactValue: "pricing_customer",
    source: "pricing_page",
  };

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/enterprise/inquiries",
    headers: { origin: config.webOrigin },
    payload: inquiry,
  });
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(accepted.json(), { accepted: true });
  assert.equal(repository.inquiryInputs.length, 1);
  assert.equal(repository.inquiryInputs[0]?.id, requestId);
  assert.equal(repository.inquiryInputs[0]?.source, "pricing_page");
  assert.equal(repository.inquiryInputs[0]?.contactMethod, "wechat");
  assert.equal(repository.inquiries.get(requestId)?.source, "pricing_page");

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/enterprise/inquiries",
    headers: { origin: config.webOrigin },
    payload: inquiry,
  });
  assert.equal(replay.statusCode, 202);
  assert.deepEqual(replay.json(), { accepted: true });
  assert.equal(repository.inquiryInputs.length, 1);
  assert.equal(repository.inquiries.size, 1);

  const invalidSource = await app.inject({
    method: "POST",
    url: "/api/v1/enterprise/inquiries",
    headers: { origin: config.webOrigin },
    payload: { ...inquiry, requestId: createId(), source: "unsupported_page" },
  });
  assert.equal(invalidSource.statusCode, 400);
  assert.equal(invalidSource.json().error.code, "INVALID_REQUEST");
  assert.equal(repository.inquiryInputs.length, 1);
  assert.equal(repository.inquiries.size, 1);
});

test("inquiry administration requires an authenticated explicitly allowlisted user", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender });
  context.after(() => app.close());
  const inquiryId = createId();
  const requests = [
    { method: "GET" as const, url: "/api/v1/admin/inquiries" },
    { method: "PATCH" as const, url: `/api/v1/admin/inquiries/${inquiryId}`, payload: { status: "contacted", expectedVersion: 1 } },
    { method: "POST" as const, url: `/api/v1/admin/inquiries/${inquiryId}/reveal-contact`, payload: { reason: "Respond to the inquiry" } },
  ];
  for (const request of requests) {
    const response = await app.inject({ ...request, headers: { origin: config.webOrigin } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const ordinary = await signUpUser(app, emailSender, "ordinary@example.com", "client");
  const access = await app.inject({ method: "GET", url: "/api/v1/admin/access", headers: { cookie: ordinary.sessionCookie } });
  assert.deepEqual(access.json(), { authorized: false });
  for (const request of requests) {
    const response = await app.inject({ ...request, headers: { origin: config.webOrigin, cookie: ordinary.sessionCookie } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "ADMIN_REQUIRED");
  }
  assert.equal(repository.inquiryAudit.length, 0);
});

test("administrator configuration is empty by default and accepts only explicit UUIDs", () => {
  const env = { NODE_ENV: "test", AI_MODE: "local", DATABASE_URL: "postgresql://unused", AUTH_TOKEN_SECRET: config.authTokenSecret };
  assert.deepEqual(loadConfig(env).adminUserIds, []);
  assert.throws(() => loadConfig({ ...env, ADMIN_USER_IDS: "admin@example.com" }), /ADMIN_USER_IDS/u);
  assert.throws(() => loadConfig({ ...env, ADMIN_USER_IDS: "*" }), /ADMIN_USER_IDS/u);
  const id = createId();
  assert.deepEqual(loadConfig({ ...env, ADMIN_USER_IDS: `${id.toUpperCase()}, ${id}` }).adminUserIds, [id]);
});

test("admins can page safe inquiry summaries, audit contact access and detect stale status updates", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const adminId = createId();
  repository.users.set("operator@example.com", {
    id: adminId, email: "operator@example.com", role: "client", emailVerifiedAt: new Date(), createdAt: new Date(),
  });
  const app = await buildApp({ config: { ...config, adminUserIds: [adminId] }, repository, emailSender });
  context.after(() => app.close());
  const admin = await signUpUser(app, emailSender, "operator@example.com", "client");
  const headers = { origin: config.webOrigin, cookie: admin.sessionCookie };
  const access = await app.inject({ method: "GET", url: "/api/v1/admin/access", headers });
  assert.deepEqual(access.json(), { authorized: true });
  const inquiryIds = [createId(), createId()];
  for (const requestId of inquiryIds) {
    const created = await app.inject({
      method: "POST", url: "/api/v1/enterprise/inquiries", headers,
      payload: { requestId: requestId.toUpperCase(), method: "wechat", contactValue: "contact_private", source: "pricing_page" },
    });
    assert.equal(created.statusCode, 202);
  }
  const page = await app.inject({ method: "GET", url: "/api/v1/admin/inquiries?status=new&limit=1", headers });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.deepEqual(page.json().counts, { new: 2, contacted: 0, closed: 0 });
  assert.equal(page.json().items.length, 1);
  assert.ok(page.json().nextCursor);
  const item = page.json().items[0];
  assert.deepEqual(Object.keys(item).sort(), ["id", "source", "contactMethod", "status", "version", "createdAt", "updatedAt", "notificationStatus"].sort());
  assert.equal(item.notificationStatus, "pending");
  assert.doesNotMatch(page.body, /contact_private|contactCiphertext|contactHash|encryptionKeyId|operator@example/u);
  const next = await app.inject({ method: "GET", url: `/api/v1/admin/inquiries?status=new&limit=1&cursor=${page.json().nextCursor}`, headers });
  assert.equal(next.statusCode, 200);
  assert.equal(next.json().items.length, 1);
  assert.notEqual(next.json().items[0].id, item.id);
  assert.equal(next.json().nextCursor, null);
  const malformed = await app.inject({ method: "GET", url: "/api/v1/admin/inquiries?cursor=e30", headers });
  assert.equal(malformed.statusCode, 400);

  const update = await app.inject({ method: "PATCH", url: `/api/v1/admin/inquiries/${item.id}`, headers, payload: { status: "contacted", expectedVersion: 1 } });
  assert.equal(update.statusCode, 200);
  assert.equal(update.json().inquiry.version, 2);
  assert.equal(update.json().inquiry.status, "contacted");
  const stale = await app.inject({ method: "PATCH", url: `/api/v1/admin/inquiries/${item.id}`, headers, payload: { status: "closed", expectedVersion: 1 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "INQUIRY_VERSION_CONFLICT");
  assert.equal(repository.inquiryAudit.length, 1);

  const withoutOrigin = await app.inject({ method: "POST", url: `/api/v1/admin/inquiries/${item.id}/reveal-contact`, headers: { cookie: admin.sessionCookie }, payload: { reason: "Respond to customer" } });
  assert.equal(withoutOrigin.statusCode, 403);
  const blankReason = await app.inject({ method: "POST", url: `/api/v1/admin/inquiries/${item.id}/reveal-contact`, headers, payload: { reason: "      " } });
  assert.equal(blankReason.statusCode, 400);
  assert.equal(repository.inquiryAudit.length, 1);
  const reveal = await app.inject({ method: "POST", url: `/api/v1/admin/inquiries/${item.id}/reveal-contact`, headers, payload: { reason: " Respond to customer request " } });
  assert.equal(reveal.statusCode, 200);
  assert.equal(reveal.headers["cache-control"], "no-store");
  assert.deepEqual(reveal.json(), { contactMethod: "wechat", contactValue: "contact_private" });
  assert.deepEqual(repository.inquiryAudit.at(-1), { actorUserId: adminId, inquiryId: item.id, action: "contact_revealed", reason: "Respond to customer request" });
  const missing = await app.inject({ method: "POST", url: `/api/v1/admin/inquiries/${createId()}/reveal-contact`, headers, payload: { reason: "Respond to customer request" } });
  assert.equal(missing.statusCode, 404);
  assert.equal(repository.inquiryAudit.length, 2);
  repository.revealInquiryContact = async () => { throw new Error("Audit insert failed"); };
  const auditFailure = await app.inject({ method: "POST", url: `/api/v1/admin/inquiries/${item.id}/reveal-contact`, headers, payload: { reason: "Respond to customer request" } });
  assert.equal(auditFailure.statusCode, 500);
  assert.doesNotMatch(auditFailure.body, /contact_private|Audit insert failed/u);
});

test("profile writes use optimistic concurrency and reject a stale version with 409", async (context) => {
  const repository = new MemoryRepository();
  const emailSender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender });
  context.after(() => app.close());
  const { sessionCookie } = await signUpUser(app, emailSender, "profile-owner@example.com", "talent");
  const profile = {
    displayName: "周然",
    countryCode: "CN",
    contact: "zhou-ran",
    organization: "",
    jobTitle: "",
    professionalTitle: "AI 实施顾问",
    bio: "负责复杂工作流上线。",
  };

  const first = await app.inject({
    method: "PUT",
    url: "/api/v1/me/profile",
    headers: { origin: config.webOrigin, cookie: sessionCookie },
    payload: { ...profile, version: 0 },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().profile.version, 1);

  const stale = await app.inject({
    method: "PUT",
    url: "/api/v1/me/profile",
    headers: { origin: config.webOrigin, cookie: sessionCookie },
    payload: { ...profile, displayName: "覆盖值", version: 0 },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "PROFILE_VERSION_CONFLICT");
  assert.equal(stale.json().error.currentVersion, 1);

  const current = await app.inject({ method: "GET", url: "/api/v1/me/profile", headers: { cookie: sessionCookie } });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().profile.displayName, "周然");
  assert.equal(current.json().profile.version, 1);
});

test("role switching requires authentication, trusted Origin and a valid role, and preserves the account and session", async context => {
  const repository = new MemoryRepository();
  const sender = new MemoryEmailSender();
  const app = await buildApp({ config, repository, emailSender: sender });
  context.after(() => app.close());
  const anonymous = await app.inject({ method: "POST", url: "/api/v1/auth/role", headers: { origin: config.webOrigin }, payload: { role: "talent" } });
  assert.equal(anonymous.statusCode, 401);
  const user = await signUpUser(app, sender, "dual-role@example.test", "client");
  const headers = { origin: config.webOrigin, cookie: user.sessionCookie };
  const original = (await app.inject({ method: "GET", url: "/api/v1/auth/session", headers })).json().session;
  for (const origin of [undefined, "https://untrusted.example"]) {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/role", headers: { cookie: user.sessionCookie, ...(origin ? { origin } : {}) }, payload: { role: "talent" } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "ORIGIN_NOT_ALLOWED");
  }
  for (const payload of [{}, { role: "admin" }, { role: "talent", userId: "someone-else" }, { role: null }]) {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/role", headers, payload });
    assert.equal(response.statusCode, 400);
  }
  const switched = await app.inject({ method: "POST", url: "/api/v1/auth/role", headers, payload: { role: "talent" } });
  assert.equal(switched.statusCode, 200);
  assert.equal(switched.headers["cache-control"], "no-store");
  assert.deepEqual(switched.json().session, { ...original, user: { ...original.user, role: "talent", roles: ["client", "talent"] } });
  const refreshed = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers });
  assert.deepEqual(refreshed.json(), switched.json());
  const repeated = await app.inject({ method: "POST", url: "/api/v1/auth/role", headers, payload: { role: "talent" } });
  assert.deepEqual(repeated.json(), switched.json());
  assert.equal(repository.users.get("dual-role@example.test")?.role, "client");
  await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers });
  const revoked = await app.inject({ method: "POST", url: "/api/v1/auth/role", headers, payload: { role: "client" } });
  assert.equal(revoked.statusCode, 401);
});

test("old-role tabs are rejected while discovery already in progress stays with its captured kind", async context => {
  const repository = new MemoryRepository();
  const sender = new MemoryEmailSender();
  let releaseAdvice!: () => void;
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const released = new Promise<void>(resolve => { releaseAdvice = resolve; });
  const discoveryAdvisor: DiscoveryAdvisor = { async advise(input) {
    notifyStarted();
    await released;
    return {
      answer: "已保存该需求信息。", provider: "local", model: "test", promptVersion: "test",
      artifact: { kind: "problem_brief", diagnosis: input.message, action: "梳理流程", profile: "系统集成", evidence: [] },
    };
  } };
  const app = await buildApp({ config, repository, emailSender: sender, discoveryAdvisor });
  context.after(() => app.close());
  const user = await signUpUser(app, sender, "delayed-dual-role@example.test", "client");
  const headers = { origin: config.webOrigin, cookie: user.sessionCookie, "x-duduhire-role": "client" };
  const pendingTurn = app.inject({ method: "POST", url: "/api/v1/me/discovery/turns", headers,
    payload: { requestId: createId(), prompt: "需要自动化销售流程", attachments: [] } });
  // Injection starts when its thenable is observed.
  const turnResult = Promise.resolve(pendingTurn);
  await started;
  const switched = await app.inject({ method: "POST", url: "/api/v1/auth/role", headers, payload: { role: "talent" } });
  assert.equal(switched.statusCode, 200);
  releaseAdvice();
  const finished = await turnResult;
  assert.equal(finished.statusCode, 200);
  assert.equal(finished.json().discovery.kind, "problem");
  for (const url of ["/api/v1/me/discovery", "/api/v1/me/workspace", "/api/v1/me/matching", "/api/v1/me/matching/results"]) {
    const response = await app.inject({ method: "GET", url, headers });
    assert.equal(response.statusCode, 409, url);
    assert.equal(response.json().error.code, "ACTIVE_ROLE_CHANGED");
  }
  const staleRequests = [
    { url: "/api/v1/me/discovery/turns", payload: { requestId: createId(), prompt: "旧页面消息", attachments: [] } },
    { url: "/api/v1/me/discovery/reset", payload: {} },
    { url: "/api/v1/me/matching/withdraw", payload: { expectedListingId: null, expectedListingVersion: 0 } },
    { url: "/api/v1/discovery/intakes", payload: { prompt: "旧首页需求" } },
    { url: `/api/v1/me/discovery/intakes/${createId()}/claim` },
  ];
  for (const request of staleRequests) {
    const response = await app.inject({ method: "POST", ...request, headers });
    assert.equal(response.statusCode, 409, request.url);
    assert.equal(response.json().error.code, "ACTIVE_ROLE_CHANGED");
  }
  const currentHeaders = { ...headers, "x-duduhire-role": "talent" };
  const capability = await app.inject({ method: "GET", url: "/api/v1/me/discovery", headers: currentHeaders });
  assert.equal(capability.statusCode, 200);
  assert.equal(capability.json().discovery.kind, "capability");
  assert.deepEqual(capability.json().discovery.turns, []);
  const workspace = await app.inject({ method: "GET", url: "/api/v1/me/workspace", headers: currentHeaders });
  assert.equal(workspace.json().role, "talent");
  assert.equal(workspace.json().turnCount, 0);
  await app.inject({ method: "POST", url: "/api/v1/auth/role", headers: currentHeaders, payload: { role: "client" } });
  const restored = await app.inject({ method: "GET", url: "/api/v1/me/discovery", headers });
  assert.equal(restored.json().discovery.turns.length, 1);
  const invalidHeader = await app.inject({ method: "GET", url: "/api/v1/me/discovery", headers: { ...headers, "x-duduhire-role": "admin" } });
  assert.equal(invalidHeader.statusCode, 400);
});
