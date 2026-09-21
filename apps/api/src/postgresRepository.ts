import { randomUUID, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  emptyProfile,
  type AuthRole,
  type DiscoveryAttachmentMetadata,
  type DiscoveryArtifact,
  type DiscoveryKind,
  type DiscoveryState,
  type DiscoveryThread,
  type DiscoveryTurn,
  type EnterpriseContactMethod,
  type EnterpriseInquiry,
  type EnterpriseInquiryStatus,
  type IntakeDraft,
  type JsonObject,
  type PersonalProfile,
  type UserRecord,
  type WorkspaceSummary,
  type AdminInquiry,
  type AdminInquiryPage,
  type InquiryCursor,
  type ManagedInquiryStatus,
} from "./domain.js";
import type {
  AppRepository,
  AuthenticatedSession,
  ChallengeCreationResult,
  NewEmailChallenge,
  NewEnterpriseInquiry,
  NewDiscoveryTurn,
  NewIntakeDraft,
  NewSession,
  ExpectedDiscoveryState,
  VerifyChallengeResult,
} from "./repository.js";
import { DiscoveryKindForbiddenError, DiscoveryStateConflictError, InquiryVersionConflictError, ProfileVersionConflictError } from "./repository.js";
import type {
  NewPhoneChallenge, PhoneAuthRepository, PhoneChallengeLimits, PhoneChallengeVerificationReservation,
} from "./phoneAuthRepository.js";
import {
  confirmedSource, MatchingConflictError, validateMatchingDraft,
  type MatchingConstraints, type MatchingDraft, type MatchingListing, type MatchingListingRecord, type PublishMatchingInput,
} from "./matching.js";

type MatchingListingRow = {
  id: string;
  owner_user_id: string;
  kind: DiscoveryKind;
  source_thread_id: string;
  source_thread_version: number;
  status: "published" | "withdrawn";
  version: number;
  title: string;
  summary: string;
  skills: string[];
  required_skills: string[];
  work_mode: MatchingDraft["workMode"];
  engagement: MatchingDraft["engagement"];
  location: string;
  notes: string;
  constraints: MatchingConstraints | null;
  created_at: Date;
  updated_at: Date;
  active: boolean;
};

function mapMatchingListing(row: MatchingListingRow): MatchingListingRecord {
  return {
    id: row.id, ownerUserId: row.owner_user_id, kind: row.kind,
    sourceThreadId: row.source_thread_id, sourceThreadVersion: row.source_thread_version,
    status: row.status, version: row.version, active: row.active,
    title: row.title, summary: row.summary, skills: row.skills, requiredSkills: row.required_skills,
    workMode: row.work_mode, engagement: row.engagement, location: row.location, notes: row.notes,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    ...(row.constraints ? { constraints: row.constraints } : {}),
  };
}

const matchingListingColumns = `m.id, m.owner_user_id, m.kind, m.source_thread_id,
  m.source_thread_version, m.status, m.version, m.title, m.summary, m.skills,
  m.required_skills, m.work_mode, m.engagement, m.location, m.notes, m.constraints, m.created_at, m.updated_at`;
// These checks are shared by own publication reads and candidate searches, so a
// later discovery turn or reset makes the previous consented version invisible.
const matchingListingActive = `(m.status = 'published' AND t.status = 'active'
  AND t.owner_user_id = m.owner_user_id AND t.kind = m.kind
  AND t.version = m.source_thread_version AND a.version = m.source_artifact_version
  AND a.kind = m.kind AND a.draft->'flow'->>'schemaVersion' = '2'
  AND a.draft->'flow'->>'status' = 'confirmed'
  AND NULLIF(a.draft->'flow'->>'confirmedAt', '') IS NOT NULL)`;

async function readMatchingListingWithClient(client: PoolClient, userId: string, kind: DiscoveryKind) {
  const result = await client.query<MatchingListingRow>(
    `SELECT ${matchingListingColumns}, COALESCE(${matchingListingActive}, false) AS active
       FROM matching_listings m
       JOIN discovery_threads t ON t.id = m.source_thread_id
       LEFT JOIN discovery_artifacts a ON a.thread_id = t.id
      WHERE m.owner_user_id = $1 AND m.kind = $2`,
    [userId, kind],
  );
  return result.rows[0] ? mapMatchingListing(result.rows[0]) : null;
}

type AdminInquiryRow = {
  id: string;
  contact_method: AdminInquiry["contactMethod"];
  source: string;
  status: ManagedInquiryStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
  notification_status: AdminInquiry["notificationStatus"];
};

function mapAdminInquiry(row: AdminInquiryRow): AdminInquiry {
  return {
    id: row.id, contactMethod: row.contact_method, source: row.source,
    status: row.status, version: row.version, createdAt: row.created_at,
    updatedAt: row.updated_at, notificationStatus: row.notification_status,
  };
}

type UserRow = {
  id: string;
  email: string | null;
  role: AuthRole;
  email_verified_at: Date | null;
  phone: string | null;
  phone_verified_at: Date | null;
  created_at: Date;
};

type PhoneChallengeRow = {
  id: string;
  phone: string;
  intent: "login" | "signup";
  requested_role: AuthRole | null;
  return_to: string;
  code_hash: string;
  browser_binding_hash: string;
  verification_attempts: number;
  verification_lease_expires_at: Date | null;
};

function equalAuthHash(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

type ChallengeRow = {
  id: string;
  created_at: Date;
  email: string;
  intent: "login" | "signup";
  requested_role: AuthRole | null;
  return_to: string;
};

type SessionRow = UserRow & {
  signed_in_at: Date;
  session_expires_at: Date;
};

type ProfileRow = {
  display_name: string;
  country_code: string;
  contact: string;
  organization: string;
  job_title: string;
  professional_title: string;
  bio: string;
  version: number;
  updated_at: Date;
};

type IntakeDraftRow = {
  id: string;
  prompt: string;
  created_at: Date;
  expires_at: Date;
  claimed_at: Date | null;
};

type DiscoveryThreadRow = {
  id: string;
  kind: DiscoveryKind;
  status: "active" | "archived";
  version: number;
  created_at: Date;
  updated_at: Date;
};

type DiscoveryTurnRow = {
  id: string;
  request_id: string;
  question: string;
  answer: string;
  attachments: unknown;
  analysis_context: string;
  provider: string;
  model: string;
  prompt_version: string;
  created_at: Date;
};

type DiscoveryArtifactRow = {
  id: string;
  kind: DiscoveryKind;
  draft: JsonObject;
  version: number;
  created_at: Date;
  updated_at: Date;
};

type WorkspaceSummaryRow = {
  role: AuthRole;
  email_verified: boolean;
  phone_verified: boolean;
  discovery_kind: DiscoveryKind;
  active_thread_id: string | null;
  turn_count: string;
  artifact_version: number | null;
  discovery_confirmed: boolean;
  updated_at: Date | null;
};

type EnterpriseInquiryRow = {
  id: string;
  contact_method: EnterpriseContactMethod;
  source: string;
  status: EnterpriseInquiryStatus;
  consented_at: Date;
  created_at: Date;
  inserted?: boolean;
};

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    emailVerifiedAt: row.email_verified_at,
    phone: row.phone,
    phoneVerifiedAt: row.phone_verified_at,
    createdAt: row.created_at,
  };
}

function mapSession(row: SessionRow): AuthenticatedSession {
  return {
    user: mapUser(row),
    signedInAt: row.signed_in_at,
    expiresAt: row.session_expires_at,
  };
}

function mapProfile(row: ProfileRow): PersonalProfile {
  return {
    displayName: row.display_name,
    countryCode: row.country_code,
    contact: row.contact,
    organization: row.organization,
    jobTitle: row.job_title,
    professionalTitle: row.professional_title,
    bio: row.bio,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function mapIntakeDraft(row: IntakeDraftRow): IntakeDraft {
  return {
    id: row.id,
    prompt: row.prompt,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at,
  };
}

function mapDiscoveryThread(row: DiscoveryThreadRow): DiscoveryThread {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDiscoveryAttachments(value: unknown): DiscoveryAttachmentMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): DiscoveryAttachmentMetadata[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.mediaType !== "string" || !Number.isSafeInteger(item.size) || (item.size as number) < 0) {
      return [];
    }
    return [{ name: item.name, mediaType: item.mediaType, size: item.size as number }];
  });
}

function mapDiscoveryTurn(row: DiscoveryTurnRow): DiscoveryTurn {
  return {
    id: row.id,
    requestId: row.request_id,
    question: row.question,
    answer: row.answer,
    attachments: mapDiscoveryAttachments(row.attachments),
    analysisContext: row.analysis_context,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

function mapDiscoveryArtifact(row: DiscoveryArtifactRow): DiscoveryArtifact {
  return {
    id: row.id,
    kind: row.kind,
    draft: row.draft,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEnterpriseInquiry(row: EnterpriseInquiryRow): EnterpriseInquiry {
  return {
    id: row.id,
    contactMethod: row.contact_method,
    source: row.source,
    status: row.status,
    consentedAt: row.consented_at,
    createdAt: row.created_at,
  };
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error("Database transaction failed.");
}

async function attemptRollback(client: PoolClient) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.query("ROLLBACK").then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 1_000);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

export async function withDedicatedDatabaseClient<T>(
  pool: Pool,
  action: (client: PoolClient, assertHealthy: () => void) => Promise<T>,
) {
  const client = await pool.connect();
  let clientError: Error | undefined;
  let releaseError: Error | undefined;
  const onClientError = (error: Error) => {
    clientError ??= error;
  };
  client.on("error", onClientError);
  try {
    return await action(client, () => {
      if (clientError) throw clientError;
    });
  } catch (error) {
    releaseError = asError(error);
    await attemptRollback(client);
    throw error;
  } finally {
    client.release(releaseError ?? clientError);
    client.removeListener("error", onClientError);
  }
}

export async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  return withDedicatedDatabaseClient(pool, async (client, assertHealthy) => {
    await client.query("BEGIN");
    const result = await action(client);
    assertHealthy();
    await client.query("COMMIT");
    return result;
  });
}


async function enqueueOutboxEvent(
  client: PoolClient,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: JsonObject,
  now: Date,
) {
  await client.query(
    `INSERT INTO outbox_events
      (id, aggregate_type, aggregate_id, event_type, payload, created_at, available_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
    [randomUUID(), aggregateType, aggregateId, eventType, JSON.stringify(payload), now],
  );
}

async function assertDiscoveryOwnerExists(client: PoolClient, userId: string) {
  // Both discovery kinds belong to every account; reads and writes below still
  // constrain each record by its authenticated owner and explicit kind.
  const result = await client.query("SELECT id FROM users WHERE id = $1", [userId]);
  if (!result.rowCount) throw new DiscoveryKindForbiddenError();
}

async function readDiscoveryStateWithClient(client: PoolClient, userId: string, kind: DiscoveryKind): Promise<DiscoveryState | null> {
  const threadResult = await client.query<DiscoveryThreadRow>(
    `SELECT id, kind, status, version, created_at, updated_at
       FROM discovery_threads
      WHERE owner_user_id = $1
        AND kind = $2
        AND status = 'active'
      LIMIT 1`,
    [userId, kind],
  );
  const threadRow = threadResult.rows[0];
  if (!threadRow) return null;

  const turnsResult = await client.query<DiscoveryTurnRow>(
    `SELECT id, request_id, question, answer, attachments, analysis_context,
            provider, model, prompt_version, created_at
       FROM discovery_turns
      WHERE thread_id = $1
      ORDER BY sequence ASC`,
    [threadRow.id],
  );
  const artifactResult = await client.query<DiscoveryArtifactRow>(
    `SELECT id, kind, draft, version, created_at, updated_at
       FROM discovery_artifacts
      WHERE thread_id = $1`,
    [threadRow.id],
  );

  return {
    thread: mapDiscoveryThread(threadRow),
    turns: turnsResult.rows.map(mapDiscoveryTurn),
    artifact: artifactResult.rows[0] ? mapDiscoveryArtifact(artifactResult.rows[0]) : null,
  };
}

type DatabaseWorkload = "runtime" | "migration" | "maintenance";

const databaseWorkloadTimeouts: Record<DatabaseWorkload, Pick<PoolConfig,
  "statement_timeout" | "query_timeout" | "lock_timeout" | "idle_in_transaction_session_timeout"
>> = {
  runtime: {
    statement_timeout: 5_000,
    query_timeout: 7_000,
    lock_timeout: 3_000,
    idle_in_transaction_session_timeout: 10_000,
  },
  migration: {
    statement_timeout: 300_000,
    query_timeout: 305_000,
    lock_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  },
  maintenance: {
    statement_timeout: 120_000,
    query_timeout: 125_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 30_000,
  },
};

export function createDatabasePool(databaseUrl: string, useSsl: boolean, workload: DatabaseWorkload = "runtime") {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid URL.");
  }
  for (const key of url.searchParams.keys()) {
    if (["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslpassword", "sslcrl"].includes(key.toLowerCase())) {
      throw new Error("DATABASE_URL SSL parameters cannot override the explicit TLS policy.");
    }
  }
  if (url.search || url.hash) {
    throw new Error("DATABASE_URL query parameters or fragments cannot override application connection policy.");
  }
  const workloadTimeouts = databaseWorkloadTimeouts[workload];
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: `duduhire_${workload}`,
    options: [
      "-c search_path=public,pg_catalog",
      `-c statement_timeout=${workloadTimeouts.statement_timeout}`,
      `-c lock_timeout=${workloadTimeouts.lock_timeout}`,
      `-c idle_in_transaction_session_timeout=${workloadTimeouts.idle_in_transaction_session_timeout}`,
    ].join(" "),
    ...workloadTimeouts,
    ssl: useSsl ? { rejectUnauthorized: true } : false,
  });
  // pg-pool emits idle connection failures as EventEmitter errors. Always keep a
  // listener attached so a database restart cannot terminate the API process.
  pool.on("error", () => undefined);
  return pool;
}

export class PostgresRepository implements AppRepository, PhoneAuthRepository {
  constructor(private readonly pool: Pool) {}

  async ping() {
    const result = await this.pool.query<{ schema_ready: boolean }>(
      `SELECT
         to_regclass('public.users') IS NOT NULL
         AND to_regclass('public.email_challenges') IS NOT NULL
         AND to_regclass('public.phone_challenges') IS NOT NULL
         AND to_regclass('public.sessions') IS NOT NULL
         AND to_regclass('public.profiles') IS NOT NULL
         AND to_regclass('public.intake_drafts') IS NOT NULL
         AND to_regclass('public.discovery_threads') IS NOT NULL
         AND to_regclass('public.discovery_turns') IS NOT NULL
         AND to_regclass('public.discovery_artifacts') IS NOT NULL
         AND to_regclass('public.matching_listings') IS NOT NULL
         AND to_regclass('public.matching_examples') IS NOT NULL
         AND to_regclass('public.enterprise_inquiries') IS NOT NULL
         AND to_regclass('public.outbox_events') IS NOT NULL
         AND to_regclass('public.data_retention_policy') IS NOT NULL
         AND to_regclass('public.inquiry_audit_events') IS NOT NULL
         AND to_regclass('public.enterprise_inquiry_admin_list') IS NOT NULL
         AND to_regprocedure('public.run_data_retention_cleanup()') IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'email_challenges'
              AND column_name = 'browser_binding_hash'
              AND is_nullable = 'NO'
         )
         AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'intake_drafts'
              AND column_name = 'invalidated_at'
         )
         AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND column_name = 'phone_verified_at'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'sessions'
              AND column_name = 'active_role' AND is_nullable = 'NO'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'sessions'
              AND column_name = 'password_setup_expires_at'
         )
         AND EXISTS (
           SELECT 1 FROM public.schema_migrations
            WHERE name = '011_session_active_role.sql'
              AND checksum IS NOT NULL
         ) AS schema_ready`,
    );
    if (!result.rows[0]?.schema_ready) throw new Error("Database schema is not ready.");
  }

  async close() {
    await this.pool.end();
  }

  async isRegisteredLoginAccount(method: "email" | "phone", account: string): Promise<boolean> {
    const result = await this.pool.query<{ registered: boolean }>(
      method === "email"
        ? "SELECT EXISTS (SELECT 1 FROM users WHERE email = $1) AS registered"
        : "SELECT EXISTS (SELECT 1 FROM users WHERE phone = $1) AS registered",
      [account],
    );
    return result.rows[0]?.registered === true;
  }

  async createPhoneChallengeIfAllowed(
    challenge: NewPhoneChallenge,
    now: Date,
    limits: PhoneChallengeLimits,
  ): Promise<ChallengeCreationResult> {
    if (!Number.isSafeInteger(limits.resendSeconds) || limits.resendSeconds < 0
      || [limits.phoneHourlyLimit, limits.ipHourlyLimit, limits.dailyLimit].some((limit) => !Number.isSafeInteger(limit) || limit < 1)) {
      throw new RangeError("Phone challenge limits must be positive integers (resendSeconds may be zero).");
    }
    return withTransaction(this.pool, async (client) => {
      // One shared reservation lock keeps the global send budget correct across
      // API processes. It is released before the caller contacts the provider.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('duduhire:phone-send-budget', 0))");
      if (challenge.intent === "login") {
        const account = await client.query("SELECT 1 FROM users WHERE phone = $1", [challenge.phone]);
        if (!account.rowCount) return { created: false, reason: "account_not_found" };
      }
      const rateResult = await client.query<{
        last_phone_request: Date | null;
        oldest_phone_request: Date | null;
        oldest_ip_request: Date | null;
        oldest_daily_request: Date | null;
        phone_count: string;
        ip_count: string;
        daily_count: string;
      }>(
        `SELECT MAX(created_at) FILTER (WHERE phone = $1) AS last_phone_request,
                MIN(created_at) FILTER (WHERE phone = $1 AND created_at > $3::timestamptz - INTERVAL '1 hour') AS oldest_phone_request,
                MIN(created_at) FILTER (WHERE request_ip_hash = $2 AND created_at > $3::timestamptz - INTERVAL '1 hour') AS oldest_ip_request,
                MIN(created_at) AS oldest_daily_request,
                COUNT(*) FILTER (WHERE phone = $1 AND created_at > $3::timestamptz - INTERVAL '1 hour') AS phone_count,
                COUNT(*) FILTER (WHERE request_ip_hash = $2 AND created_at > $3::timestamptz - INTERVAL '1 hour') AS ip_count,
                COUNT(*) AS daily_count
           FROM phone_challenges
          WHERE created_at > $3::timestamptz - INTERVAL '24 hours'`,
        [challenge.phone, challenge.requestIpHash, now],
      );
      const rate = rateResult.rows[0]!;
      const remaining = (oldest: Date | null, seconds: number) => oldest
        ? Math.max(0, Math.ceil(seconds - (now.getTime() - oldest.getTime()) / 1000)) : 0;
      const retryAfterSeconds = Math.max(
        remaining(rate.last_phone_request, limits.resendSeconds),
        Number(rate.phone_count) >= limits.phoneHourlyLimit ? remaining(rate.oldest_phone_request, 3600) : 0,
        Number(rate.ip_count) >= limits.ipHourlyLimit ? remaining(rate.oldest_ip_request, 3600) : 0,
        Number(rate.daily_count) >= limits.dailyLimit ? remaining(rate.oldest_daily_request, 86_400) : 0,
      );
      if (retryAfterSeconds > 0) return { created: false, retryAfterSeconds };

      // Superseding the number also invalidates leases held by another browser.
      await client.query(
        `UPDATE phone_challenges
            SET invalidated_at = $2, verification_lease_id = NULL, verification_lease_expires_at = NULL
          WHERE phone = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [challenge.phone, now],
      );
      await client.query(
        `INSERT INTO phone_challenges
          (id, phone, intent, requested_role, code_hash, browser_binding_hash, request_ip_hash, return_to, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [challenge.id, challenge.phone, challenge.intent, challenge.requestedRole, challenge.codeHash,
          challenge.browserBindingHash, challenge.requestIpHash, challenge.returnTo, challenge.expiresAt, challenge.createdAt],
      );
      return { created: true };
    });
  }

  async markPhoneChallengeSent(id: string, codeHash: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE phone_challenges SET sent_at = NOW(), code_hash = $2
        WHERE id = $1 AND sent_at IS NULL AND consumed_at IS NULL
          AND invalidated_at IS NULL AND expires_at > NOW()`,
      [id, codeHash],
    );
    return result.rowCount === 1;
  }

  async invalidatePhoneChallenge(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE phone_challenges
          SET invalidated_at = NOW(), verification_lease_id = NULL, verification_lease_expires_at = NULL
        WHERE id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [id],
    );
  }

  async reservePhoneChallengeVerification(
    id: string,
    browserBindingHash: string,
    codeHash: string,
    now: Date,
    leaseId: string,
    maxAttempts: number,
  ): Promise<PhoneChallengeVerificationReservation> {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) return { status: "invalid" };
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<PhoneChallengeRow>(
        `SELECT id, phone, intent, requested_role, return_to, code_hash, browser_binding_hash,
                verification_attempts, verification_lease_expires_at
           FROM phone_challenges
          WHERE id = $1 AND sent_at IS NOT NULL AND consumed_at IS NULL
            AND invalidated_at IS NULL AND expires_at > $2
          FOR UPDATE`,
        [id, now],
      );
      const challenge = result.rows[0];
      if (!challenge || challenge.verification_attempts >= maxAttempts
        || (challenge.verification_lease_expires_at && challenge.verification_lease_expires_at > now)) {
        return { status: "invalid" };
      }
      // Commit every eligible attempt, including invalid bindings/codes and
      // later provider failures, so retries cannot bypass the attempt limit.
      await client.query(
        `UPDATE phone_challenges SET verification_attempts = verification_attempts + 1,
                verification_lease_id = NULL, verification_lease_expires_at = NULL WHERE id = $1`,
        [id],
      );
      const browserMatches = equalAuthHash(browserBindingHash, challenge.browser_binding_hash);
      const codeMatches = equalAuthHash(codeHash, challenge.code_hash);
      if (!browserMatches || !codeMatches) return { status: "invalid" };
      await client.query(
        `UPDATE phone_challenges SET verification_lease_id = $2,
                verification_lease_expires_at = $3::timestamptz + INTERVAL '30 seconds' WHERE id = $1`,
        [id, leaseId, now],
      );
      return { status: "reserved", phone: challenge.phone };
    });
  }

  async releasePhoneChallengeVerification(id: string, leaseId: string): Promise<void> {
    await this.pool.query(
      `UPDATE phone_challenges SET verification_lease_id = NULL, verification_lease_expires_at = NULL
        WHERE id = $1 AND verification_lease_id = $2`,
      [id, leaseId],
    );
  }

  async completePhoneChallengeVerification(
    id: string,
    leaseId: string,
    now: Date,
    newSession: NewSession,
  ): Promise<VerifyChallengeResult> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<PhoneChallengeRow>(
        `UPDATE phone_challenges
            SET consumed_at = $3, verification_lease_id = NULL, verification_lease_expires_at = NULL
          WHERE id = $1 AND verification_lease_id = $2 AND verification_lease_expires_at > $3
            AND consumed_at IS NULL AND invalidated_at IS NULL AND sent_at IS NOT NULL AND expires_at > $3
          RETURNING id, phone, intent, requested_role, return_to`,
        [id, leaseId, now],
      );
      const challenge = result.rows[0];
      if (!challenge) return { status: "invalid" };

      const found = await client.query<UserRow>(
        `SELECT id, email, role, email_verified_at, phone, phone_verified_at, created_at
           FROM users WHERE phone = $1 FOR UPDATE`,
        [challenge.phone],
      );
      let user = found.rows[0];
      if (!user && challenge.intent === "login") {
        return { status: "account_not_found", returnTo: challenge.return_to };
      }
      if (!user) {
        if (!challenge.requested_role) return { status: "invalid" };
        const inserted = await client.query<UserRow>(
          `INSERT INTO users (id, phone, role, phone_verified_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4, $4)
           ON CONFLICT (phone) DO UPDATE SET phone_verified_at = EXCLUDED.phone_verified_at, updated_at = EXCLUDED.updated_at
           RETURNING id, email, role, email_verified_at, phone, phone_verified_at, created_at`,
          [randomUUID(), challenge.phone, challenge.requested_role, now],
        );
        user = inserted.rows[0];
      } else {
        const updated = await client.query<UserRow>(
          `UPDATE users SET phone_verified_at = $2, updated_at = $2 WHERE id = $1
           RETURNING id, email, role, email_verified_at, phone, phone_verified_at, created_at`,
          [user.id, now],
        );
        user = updated.rows[0];
      }
      if (!user) throw new Error("Verified phone identity was not persisted.");
      await client.query("INSERT INTO profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [user.id]);
      await client.query(
        `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, active_role) VALUES ($1, $2, $3, $4, $5, $6)`,
        [newSession.id, user.id, newSession.tokenHash, newSession.createdAt, newSession.expiresAt, user.role],
      );
      return {
        status: "verified", returnTo: challenge.return_to,
        session: { user: mapUser(user), signedInAt: newSession.createdAt, expiresAt: newSession.expiresAt },
      };
    });
  }

  async createEmailChallengeIfAllowed(
    challenge: NewEmailChallenge,
    now: Date,
    resendSeconds: number,
    hourlyLimit: number,
  ): Promise<ChallengeCreationResult> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [challenge.email]);
      if (challenge.intent === "login") {
        const account = await client.query("SELECT 1 FROM users WHERE email = $1", [challenge.email]);
        if (!account.rowCount) return { created: false, reason: "account_not_found" };
      }
      const rateResult = await client.query<{
        last_requested_at: Date | null;
        oldest_in_window: Date | null;
        count_last_hour: string;
      }>(
        `SELECT MAX(created_at) AS last_requested_at,
                MIN(created_at) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '1 hour') AS oldest_in_window,
                COUNT(*) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '1 hour') AS count_last_hour
           FROM email_challenges
          WHERE email = $1`,
        [challenge.email, now],
      );
      const rate = rateResult.rows[0];
      const lastElapsed = rate?.last_requested_at
        ? Math.floor((now.getTime() - rate.last_requested_at.getTime()) / 1000)
        : Number.POSITIVE_INFINITY;
      const cooldownRetry = Math.max(0, resendSeconds - lastElapsed);
      const hourlyRetry = Number(rate?.count_last_hour ?? 0) >= hourlyLimit && rate?.oldest_in_window
        ? Math.max(1, Math.ceil(3600 - (now.getTime() - rate.oldest_in_window.getTime()) / 1000))
        : 0;
      const retryAfterSeconds = Math.max(cooldownRetry, hourlyRetry);
      if (retryAfterSeconds > 0) return { created: false, retryAfterSeconds };

      await client.query(
        `UPDATE email_challenges
            SET consumed_at = $3
          WHERE email = $1
            AND browser_binding_hash = $2
            AND consumed_at IS NULL`,
        [challenge.email, challenge.browserBindingHash, challenge.createdAt],
      );
      await client.query(
        `INSERT INTO email_challenges
          (id, email, intent, requested_role, token_hash, browser_binding_hash, return_to, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          challenge.id,
          challenge.email,
          challenge.intent,
          challenge.requestedRole,
          challenge.tokenHash,
          challenge.browserBindingHash,
          challenge.returnTo,
          challenge.expiresAt,
          challenge.createdAt,
        ],
      );
      return { created: true };
    });
  }

  async invalidateEmailChallenge(id: string) {
    await this.pool.query(
      "UPDATE email_challenges SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL",
      [id],
    );
  }

  async consumeEmailChallenge(tokenHash: string, browserBindingHash: string, now: Date, session: NewSession): Promise<VerifyChallengeResult> {
    return withTransaction(this.pool, async (client) => {
      const challengeResult = await client.query<ChallengeRow>(
        `SELECT id, email, intent, requested_role, return_to, created_at
           FROM email_challenges
          WHERE token_hash = $1
            AND browser_binding_hash = $2
            AND consumed_at IS NULL
            AND expires_at > $3
          FOR UPDATE`,
        [tokenHash, browserBindingHash, now],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge) return { status: "invalid" };

      const userResult = await client.query<UserRow>(
        "SELECT id, email, role, email_verified_at, phone, phone_verified_at, created_at FROM users WHERE email = $1 FOR UPDATE",
        [challenge.email],
      );
      let user = userResult.rows[0];

      if (user) {
        const reset = await client.query("SELECT 1 FROM user_passwords WHERE user_id=$1 AND updated_at >= $2", [user.id, challenge.created_at]);
        if (reset.rowCount) return { status: "invalid" };
      }

      if (!user && challenge.intent === "login") {
        await client.query("UPDATE email_challenges SET consumed_at = $2 WHERE id = $1", [challenge.id, now]);
        return { status: "account_not_found", returnTo: challenge.return_to };
      }

      if (!user) {
        if (!challenge.requested_role) return { status: "invalid" };
        const insertedUser = await client.query<UserRow>(
          `INSERT INTO users (id, email, role, email_verified_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4, $4)
           ON CONFLICT (email) DO UPDATE SET
             email_verified_at = EXCLUDED.email_verified_at,
             updated_at = EXCLUDED.updated_at
           RETURNING id, email, role, email_verified_at, phone, phone_verified_at, created_at`,
          [randomUUID(), challenge.email, challenge.requested_role, now],
        );
        user = insertedUser.rows[0];
      } else {
        const updatedUser = await client.query<UserRow>(
          `UPDATE users
              SET email_verified_at = $2, updated_at = $2
            WHERE id = $1
            RETURNING id, email, role, email_verified_at, phone, phone_verified_at, created_at`,
          [user.id, now],
        );
        user = updatedUser.rows[0];
      }

      if (!user) return { status: "invalid" };
      await client.query("UPDATE email_challenges SET consumed_at = $2 WHERE id = $1", [challenge.id, now]);
      await client.query(
        `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, password_setup_expires_at, active_role)
         VALUES ($1, $2, $3, $4, $5, $4::timestamptz + INTERVAL '15 minutes', $6)`,
        [session.id, user.id, session.tokenHash, session.createdAt, session.expiresAt, user.role],
      );

      return {
        status: "verified",
        returnTo: challenge.return_to,
        session: {
          user: mapUser(user),
          signedInAt: session.createdAt,
          expiresAt: session.expiresAt,
        },
      };
    });
  }

  async reservePasswordLogin(identityHash: string, now: Date): Promise<number> {
    const result = await this.pool.query<{ attempts: number; window_start: Date }>(
      `INSERT INTO password_login_limits(identity_hash, window_start, attempts) VALUES ($1, $2, 1)
       ON CONFLICT (identity_hash) DO UPDATE SET
         attempts = CASE WHEN password_login_limits.window_start <= $2::timestamptz - INTERVAL '15 minutes' THEN 1 ELSE password_login_limits.attempts + 1 END,
         window_start = CASE WHEN password_login_limits.window_start <= $2::timestamptz - INTERVAL '15 minutes' THEN $2 ELSE password_login_limits.window_start END
       RETURNING attempts, window_start`, [identityHash, now]);
    const row = result.rows[0]!;
    return row.attempts > 10 ? Math.max(1, Math.ceil((row.window_start.getTime() + 900_000 - now.getTime()) / 1000)) : 0;
  }

  async readPasswordHash(email: string): Promise<string | null> {
    const result = await this.pool.query<{ password_hash: string }>(
      "SELECT p.password_hash FROM user_passwords p JOIN users u ON u.id=p.user_id WHERE u.email=$1 AND u.email_verified_at IS NOT NULL", [email]);
    return result.rows[0]?.password_hash ?? null;
  }

  async createPasswordSession(email: string, expectedHash: string, session: NewSession): Promise<boolean> {
    return withTransaction(this.pool, async client => {
      const user = await client.query<{ id: string; role: AuthRole }>("SELECT id, role FROM users WHERE email=$1 AND email_verified_at IS NOT NULL FOR UPDATE", [email]);
      if (!user.rows[0]) return false;
      const credential = await client.query<{ password_hash: string }>("SELECT password_hash FROM user_passwords WHERE user_id=$1", [user.rows[0].id]);
      if (credential.rows[0]?.password_hash !== expectedHash) return false;
      await client.query("INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at,active_role) VALUES ($1,$2,$3,$4,$5,$6)",
        [session.id, user.rows[0].id, session.tokenHash, session.createdAt, session.expiresAt, user.rows[0].role]);
      return true;
    });
  }

  async canSetPassword(sessionHash: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1
       AND s.revoked_at IS NULL AND s.expires_at>$2 AND s.password_setup_expires_at>$2
       AND u.email IS NOT NULL AND u.email_verified_at IS NOT NULL`, [sessionHash, now]);
    return Boolean(result.rowCount);
  }

  async setPassword(sessionHash: string, passwordHash: string, now: Date): Promise<boolean> {
    return withTransaction(this.pool, async client => {
      // All credential writers and password logins lock the user first.
      const owner = await client.query<{ id: string }>(
        "SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND u.email IS NOT NULL FOR UPDATE OF u", [sessionHash]);
      if (!owner.rows[0]) return false;
      const proof = await client.query(
        "SELECT 1 FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>$2 AND password_setup_expires_at>$2 FOR UPDATE", [sessionHash, now]);
      if (!proof.rowCount) return false;
      await client.query(`INSERT INTO user_passwords(user_id,password_hash,updated_at) VALUES ($1,$2,$3)
        ON CONFLICT(user_id) DO UPDATE SET password_hash=$2, updated_at=$3`, [owner.rows[0].id, passwordHash, now]);
      await client.query("UPDATE sessions SET revoked_at=$2, password_setup_expires_at=NULL WHERE user_id=$1 AND revoked_at IS NULL", [owner.rows[0].id, now]);
      // Email verification also checks this credential's update time while holding
      // the user lock, so previously issued links cannot authorize another reset.
      return true;
    });
  }

  async findSession(tokenHash: string, now: Date): Promise<AuthenticatedSession | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT u.id, u.email, s.active_role AS role, u.email_verified_at, u.phone, u.phone_verified_at, u.created_at,
              s.created_at AS signed_in_at, s.expires_at AS session_expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > $2`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    return row ? mapSession(row) : null;
  }

  async switchSessionRole(tokenHash: string, role: AuthRole, now: Date): Promise<AuthenticatedSession | null> {
    // Return this update's snapshot atomically, including when another tab switches.
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions s SET active_role = $2
         FROM users u
        WHERE s.user_id = u.id AND s.token_hash = $1
          AND s.revoked_at IS NULL AND s.expires_at > $3
      RETURNING u.id, u.email, s.active_role AS role, u.email_verified_at,
                u.phone, u.phone_verified_at, u.created_at,
                s.created_at AS signed_in_at, s.expires_at AS session_expires_at`,
      [tokenHash, role, now],
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async revokeSession(tokenHash: string, now: Date) {
    await this.pool.query(
      "UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL",
      [tokenHash, now],
    );
  }

  async readProfile(userId: string): Promise<PersonalProfile> {
    const result = await this.pool.query<ProfileRow>(
      `SELECT display_name, country_code, contact, organization, job_title,
              professional_title, bio, version, updated_at
         FROM profiles
        WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row ? mapProfile(row) : emptyProfile();
  }

  async saveProfile(
    userId: string,
    profile: Omit<PersonalProfile, "version" | "updatedAt">,
    now: Date,
    expectedVersion = 0,
  ): Promise<PersonalProfile> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new ProfileVersionConflictError(expectedVersion, 0);
    }
    const result = await this.pool.query<ProfileRow>(
      `WITH updated AS (
         UPDATE profiles
            SET display_name = $2,
                country_code = $3,
                contact = $4,
                organization = $5,
                job_title = $6,
                professional_title = $7,
                bio = $8,
                version = version + 1,
                updated_at = $10
          WHERE user_id = $1
            AND version = $9
        RETURNING display_name, country_code, contact, organization, job_title,
                  professional_title, bio, version, updated_at
       ), inserted AS (
         INSERT INTO profiles
           (user_id, display_name, country_code, contact, organization, job_title, professional_title, bio, version, updated_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, 1, $10
          WHERE $9::integer = 0
         ON CONFLICT (user_id) DO NOTHING
        RETURNING display_name, country_code, contact, organization, job_title,
                  professional_title, bio, version, updated_at
       )
       SELECT * FROM updated
       UNION ALL
       SELECT * FROM inserted`,
      [
        userId,
        profile.displayName,
        profile.countryCode,
        profile.contact,
        profile.organization,
        profile.jobTitle,
        profile.professionalTitle,
        profile.bio,
        expectedVersion,
        now,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      const current = await this.pool.query<{ version: number }>("SELECT version FROM profiles WHERE user_id = $1", [userId]);
      throw new ProfileVersionConflictError(expectedVersion, current.rows[0]?.version ?? 0);
    }
    return mapProfile(row);
  }

  async createIntakeDraft(draft: NewIntakeDraft): Promise<IntakeDraft> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [draft.browserBindingHash]);
      await client.query(
        `UPDATE intake_drafts
            SET invalidated_at = GREATEST($2, created_at)
          WHERE browser_binding_hash = $1
            AND claimed_at IS NULL
            AND invalidated_at IS NULL`,
        [draft.browserBindingHash, draft.createdAt],
      );
      const result = await client.query<IntakeDraftRow>(
        `INSERT INTO intake_drafts
          (id, browser_binding_hash, prompt, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, prompt, created_at, expires_at, claimed_at`,
        [draft.id, draft.browserBindingHash, draft.prompt, draft.createdAt, draft.expiresAt],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Intake draft creation did not return a row.");
      await enqueueOutboxEvent(client, "intake_draft", row.id, "intake_draft.created", {}, draft.createdAt);
      return mapIntakeDraft(row);
    });
  }

  async claimIntakeDraft(userId: string, intakeId: string, browserBindingHash: string, now: Date): Promise<IntakeDraft | null> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [intakeId]);
      const result = await client.query<IntakeDraftRow>(
        `UPDATE intake_drafts
            SET claimed_by_user_id = $3,
                claimed_at = $4
          WHERE id = $1
            AND browser_binding_hash = $2
            AND claimed_at IS NULL
            AND invalidated_at IS NULL
            AND expires_at > $4
        RETURNING id, prompt, created_at, expires_at, claimed_at`,
        [intakeId, browserBindingHash, userId, now],
      );
      const row = result.rows[0];
      if (!row) return null;
      await enqueueOutboxEvent(client, "intake_draft", row.id, "intake_draft.claimed", {}, now);
      return mapIntakeDraft(row);
    });
  }

  async readDiscovery(userId: string, kind: DiscoveryKind): Promise<DiscoveryState | null> {
    return withDedicatedDatabaseClient(this.pool, async (client, assertHealthy) => {
      await assertDiscoveryOwnerExists(client, userId);
      const state = await readDiscoveryStateWithClient(client, userId, kind);
      assertHealthy();
      return state;
    });
  }

  async appendDiscoveryTurn(
    userId: string,
    kind: DiscoveryKind,
    turn: NewDiscoveryTurn,
    now: Date,
    expectedState: ExpectedDiscoveryState,
  ): Promise<DiscoveryState> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${userId}:${kind}`]);
      await assertDiscoveryOwnerExists(client, userId);

      let threadResult = await client.query<DiscoveryThreadRow>(
        `SELECT id, kind, status, version, created_at, updated_at
           FROM discovery_threads
          WHERE owner_user_id = $1
            AND kind = $2
            AND status = 'active'
          FOR UPDATE`,
        [userId, kind],
      );

      const activeThread = threadResult.rows[0];
      if (activeThread) {
        const duplicate = await client.query<{ id: string }>(
          "SELECT id FROM discovery_turns WHERE thread_id = $1 AND request_id = $2",
          [activeThread.id, turn.requestId],
        );
        if (duplicate.rows[0]) {
          const existingState = await readDiscoveryStateWithClient(client, userId, kind);
          if (!existingState) throw new Error("Idempotent discovery turn has no active thread.");
          return existingState;
        }
      }

      if (
        (activeThread && !expectedState)
        || (!activeThread && expectedState)
        || (activeThread && expectedState && (
          activeThread.id !== expectedState.threadId
          || activeThread.version !== expectedState.threadVersion
        ))
      ) {
        throw new DiscoveryStateConflictError();
      }

      if (!threadResult.rows[0]) {
        threadResult = await client.query<DiscoveryThreadRow>(
          `INSERT INTO discovery_threads
            (id, owner_user_id, kind, status, version, created_at, updated_at)
           VALUES ($1, $2, $3, 'active', 1, $4, $4)
           RETURNING id, kind, status, version, created_at, updated_at`,
          [randomUUID(), userId, kind, now],
        );
      }
      const thread = threadResult.rows[0];
      if (!thread) throw new Error("Discovery thread creation did not return a row.");

      const sequenceResult = await client.query<{ next_sequence: string }>(
        `SELECT (COALESCE(MAX(sequence), 0) + 1)::text AS next_sequence
           FROM discovery_turns
          WHERE thread_id = $1`,
        [thread.id],
      );
      const nextSequence = Number(sequenceResult.rows[0]?.next_sequence ?? 1);
      const turnId = randomUUID();
      await client.query(
        `INSERT INTO discovery_turns
          (id, thread_id, request_id, sequence, question, answer, attachments,
           analysis_context, provider, model, prompt_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
        [
          turnId,
          thread.id,
          turn.requestId,
          nextSequence,
          turn.question,
          turn.answer,
          JSON.stringify(turn.attachments),
          turn.analysisContext,
          turn.provider,
          turn.model,
          turn.promptVersion,
          now,
        ],
      );
      const artifactResult = await client.query<{ version: number }>(
        `INSERT INTO discovery_artifacts
          (id, thread_id, kind, draft, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, 1, $5, $5)
         ON CONFLICT (thread_id) DO UPDATE SET
           draft = EXCLUDED.draft,
           version = discovery_artifacts.version + 1,
           updated_at = EXCLUDED.updated_at
         RETURNING version`,
        [randomUUID(), thread.id, kind, JSON.stringify(turn.artifactDraft), now],
      );
      await client.query(
        `UPDATE discovery_threads
            SET version = version + 1,
                updated_at = $2
          WHERE id = $1`,
        [thread.id, now],
      );
      await enqueueOutboxEvent(
        client,
        "discovery_thread",
        thread.id,
        "discovery_turn.appended",
        { kind, turnId, artifactVersion: artifactResult.rows[0]?.version ?? 1 },
        now,
      );

      const state = await readDiscoveryStateWithClient(client, userId, kind);
      if (!state) throw new Error("Discovery update did not return an active thread.");
      return state;
    });
  }

  async resetDiscovery(userId: string, kind: DiscoveryKind, now: Date, expectedState?: ExpectedDiscoveryState): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${userId}:${kind}`]);
      await assertDiscoveryOwnerExists(client, userId);
      if (expectedState !== undefined) {
        const active = await client.query<{ id: string; version: number }>(
          "SELECT id, version FROM discovery_threads WHERE owner_user_id = $1 AND kind = $2 AND status = 'active' FOR UPDATE",
          [userId, kind],
        );
        const thread = active.rows[0];
        if (
          (thread && !expectedState)
          || (!thread && expectedState)
          || (thread && expectedState && (
            thread.id !== expectedState.threadId || thread.version !== expectedState.threadVersion
          ))
        ) throw new DiscoveryStateConflictError();
      }
      const result = await client.query<{ id: string }>(
        `UPDATE discovery_threads
            SET status = 'archived',
                version = version + 1,
                updated_at = $3
          WHERE owner_user_id = $1
            AND kind = $2
            AND status = 'active'
        RETURNING id`,
        [userId, kind, now],
      );
      const thread = result.rows[0];
      if (!thread) return false;
      await enqueueOutboxEvent(client, "discovery_thread", thread.id, "discovery_thread.archived", { kind }, now);
      return true;
    });
  }

  async readMatchingListing(userId: string, kind: DiscoveryKind): Promise<MatchingListingRecord | null> {
    return withTransaction(this.pool, async (client) => {
      await assertDiscoveryOwnerExists(client, userId);
      return readMatchingListingWithClient(client, userId, kind);
    });
  }

  async publishMatchingListing(userId: string, kind: DiscoveryKind, input: PublishMatchingInput, now: Date): Promise<MatchingListingRecord> {
    const draft = validateMatchingDraft(kind, input);
    if (input.consent !== true || !Number.isSafeInteger(input.expectedListingVersion) || input.expectedListingVersion < 0) {
      throw new MatchingConflictError();
    }
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${userId}:${kind}`]);
      await assertDiscoveryOwnerExists(client, userId);
      const state = await readDiscoveryStateWithClient(client, userId, kind);
      if (!confirmedSource(state) || !state?.artifact || state.thread.id !== input.expectedThreadId
        || state.thread.version !== input.expectedVersion) throw new MatchingConflictError();
      const previous = await readMatchingListingWithClient(client, userId, kind);
      if ((previous?.version ?? 0) !== input.expectedListingVersion) throw new MatchingConflictError();
      const listingId = previous?.id ?? randomUUID();
      await client.query(
        `INSERT INTO matching_listings
          (id, owner_user_id, kind, source_thread_id, source_thread_version, source_artifact_version,
           status, version, title, summary, skills, required_skills, work_mode, engagement,
           location, notes, consented_at, created_at, updated_at, constraints)
         VALUES ($1, $2, $3, $4, $5, $6, 'published', 1, $7, $8, $9::text[], $10::text[], $11, $12,
                 $13, $14, $15, $15, $15, $16::jsonb)
         ON CONFLICT (owner_user_id, kind) DO UPDATE SET
           source_thread_id = EXCLUDED.source_thread_id,
           source_thread_version = EXCLUDED.source_thread_version,
           source_artifact_version = EXCLUDED.source_artifact_version,
           status = 'published', version = matching_listings.version + 1,
           title = EXCLUDED.title, summary = EXCLUDED.summary, skills = EXCLUDED.skills,
           required_skills = EXCLUDED.required_skills, work_mode = EXCLUDED.work_mode,
           engagement = EXCLUDED.engagement, location = EXCLUDED.location, notes = EXCLUDED.notes,
           consented_at = EXCLUDED.consented_at, updated_at = EXCLUDED.updated_at, constraints = EXCLUDED.constraints`,
        [listingId, userId, kind, state.thread.id, state.thread.version, state.artifact.version,
          draft.title, draft.summary, draft.skills, draft.requiredSkills, draft.workMode, draft.engagement,
          draft.location, draft.notes, now, draft.constraints ? JSON.stringify(draft.constraints) : null],
      );
      await enqueueOutboxEvent(client, "matching_listing", listingId, "matching_listing.published", { kind }, now);
      const listing = await readMatchingListingWithClient(client, userId, kind);
      if (!listing?.active) throw new Error("Matching publication did not return an active listing.");
      return listing;
    });
  }

  async withdrawMatchingListing(userId: string, kind: DiscoveryKind, expectedListingId: string | null, expectedListingVersion: number, now: Date): Promise<MatchingListingRecord | null> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${userId}:${kind}`]);
      await assertDiscoveryOwnerExists(client, userId);
      const previous = await readMatchingListingWithClient(client, userId, kind);
      if ((previous?.id ?? null) !== expectedListingId || !Number.isSafeInteger(expectedListingVersion)
        || (previous?.version ?? 0) !== expectedListingVersion) {
        throw new MatchingConflictError();
      }
      if (!previous || previous.status === "withdrawn") return previous;
      await client.query(
        `UPDATE matching_listings SET status = 'withdrawn', version = version + 1, updated_at = $3
          WHERE owner_user_id = $1 AND kind = $2`,
        [userId, kind, now],
      );
      await enqueueOutboxEvent(client, "matching_listing", previous.id, "matching_listing.withdrawn", { kind }, now);
      return readMatchingListingWithClient(client, userId, kind);
    });
  }

  async readMatchingCandidates(userId: string, kind: DiscoveryKind): Promise<{
    source: MatchingListingRecord | null;
    candidates: MatchingListingRecord[];
    catalogLimited: boolean;
  }> {
    return withTransaction(this.pool, async (client) => {
      // Serialize the source check with publish, withdrawal and discovery edits.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${userId}:${kind}`]);
      await assertDiscoveryOwnerExists(client, userId);
      const source = await readMatchingListingWithClient(client, userId, kind);
      if (!source?.active) return { source, candidates: [], catalogLimited: false };
      const result = await client.query<MatchingListingRow>(
        `SELECT ${matchingListingColumns}, true AS active
           FROM matching_listings m
           JOIN discovery_threads t ON t.id = m.source_thread_id
           JOIN discovery_artifacts a ON a.thread_id = t.id
          WHERE m.owner_user_id <> $1 AND m.kind = $2 AND m.skills && $3::text[]
            AND ${matchingListingActive}
          ORDER BY (SELECT COUNT(*) FROM unnest(m.skills) AS skill WHERE skill = ANY($3::text[])) DESC,
                   m.id ASC
          LIMIT 501`,
        [userId, kind === "problem" ? "capability" : "problem", source.skills],
      );
      return {
        source,
        candidates: result.rows.slice(0, 500).map(mapMatchingListing),
        catalogLimited: result.rows.length > 500,
      };
    });
  }

  async readMatchingExamples(userId: string, kind: DiscoveryKind): Promise<MatchingListing[]> {
    return withTransaction(this.pool, async (client) => {
      await assertDiscoveryOwnerExists(client, userId);
      const result = await client.query<{ id: string; kind: DiscoveryKind; domain: string; draft: MatchingDraft; created_at: Date; updated_at: Date }>(
        "SELECT id, kind, domain, draft, created_at, updated_at FROM matching_examples WHERE kind = $1 ORDER BY id LIMIT 100",
        [kind === "problem" ? "capability" : "problem"],
      );
      return result.rows.map((row) => ({
        ...validateMatchingDraft(row.kind, row.draft), id: row.id, kind: row.kind, version: 1,
        isExample: true, exampleDomain: row.domain, contactable: false,
        createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      }));
    });
  }

  async readWorkspaceSummary(userId: string, role: AuthRole): Promise<WorkspaceSummary> {
    const result = await this.pool.query<WorkspaceSummaryRow>(
      `SELECT $2::text AS role,
              (u.email_verified_at IS NOT NULL) AS email_verified,
              (u.phone_verified_at IS NOT NULL) AS phone_verified,
              CASE WHEN $2::text = 'talent' THEN 'capability' ELSE 'problem' END AS discovery_kind,
              t.id AS active_thread_id,
              COUNT(dt.id)::text AS turn_count,
              a.version AS artifact_version,
              COALESCE(a.draft->'flow'->>'status' = 'confirmed'
                AND NULLIF(a.draft->'flow'->>'confirmedAt', '') IS NOT NULL, false) AS discovery_confirmed,
              GREATEST(t.updated_at, a.updated_at) AS updated_at
         FROM users u
         LEFT JOIN discovery_threads t
           ON t.owner_user_id = u.id
          AND t.kind = CASE WHEN $2::text = 'talent' THEN 'capability' ELSE 'problem' END
          AND t.status = 'active'
         LEFT JOIN discovery_turns dt ON dt.thread_id = t.id
         LEFT JOIN discovery_artifacts a ON a.thread_id = t.id
        WHERE u.id = $1
        GROUP BY u.email_verified_at, u.phone_verified_at, t.id, t.updated_at, a.version, a.updated_at, a.draft`,
      [userId, role],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Workspace owner was not found.");
    const turnCount = Number(row.turn_count);
    return {
      role: row.role,
      emailVerified: row.email_verified,
      phoneVerified: row.phone_verified,
      discoveryKind: row.discovery_kind,
      discoveryCompleted: turnCount > 0 && row.discovery_confirmed,
      activeThreadId: row.active_thread_id,
      turnCount,
      artifactVersion: row.artifact_version,
      updatedAt: row.updated_at,
    };
  }

  async createEnterpriseInquiry(inquiry: NewEnterpriseInquiry): Promise<EnterpriseInquiry> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [inquiry.id]);
      const result = await client.query<EnterpriseInquiryRow>(
        `WITH inserted AS (
           INSERT INTO enterprise_inquiries
             (id, user_id, contact_method, contact_ciphertext, contact_hash,
              encryption_key_id, source, status, consented_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', $8, $9, $9)
           ON CONFLICT (id) DO NOTHING
           RETURNING id, contact_method, source, status, consented_at, created_at
         )
         SELECT id, contact_method, source, status, consented_at, created_at, TRUE AS inserted
           FROM inserted
         UNION ALL
         SELECT id, contact_method, source, status, consented_at, created_at, FALSE AS inserted
           FROM enterprise_inquiries
          WHERE id = $1
            AND NOT EXISTS (SELECT 1 FROM inserted)
         LIMIT 1`,
        [
          inquiry.id,
          inquiry.userId,
          inquiry.contactMethod,
          inquiry.contactCiphertext,
          inquiry.contactHash,
          inquiry.encryptionKeyId,
          inquiry.source,
          inquiry.consentedAt,
          inquiry.createdAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Enterprise inquiry creation did not return a row.");
      if (row.inserted) {
        await enqueueOutboxEvent(client, "enterprise_inquiry", row.id, "enterprise_inquiry.created", {
          contactMethod: row.contact_method,
          source: row.source,
        }, inquiry.createdAt);
      }
      return mapEnterpriseInquiry(row);
    });
  }

  async listAdminInquiries(status: ManagedInquiryStatus, limit: number, cursor: InquiryCursor | null): Promise<AdminInquiryPage> {
    const [result, countsResult] = await Promise.all([
      this.pool.query<AdminInquiryRow>(
        `SELECT id, contact_method, source, status, version, created_at, updated_at, notification_status
         FROM public.enterprise_inquiry_admin_list WHERE status = $1
           AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [status, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      ),
      this.pool.query<{ status: ManagedInquiryStatus; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM public.enterprise_inquiry_admin_list
         WHERE status IN ('new', 'contacted', 'closed') GROUP BY status`,
      ),
    ]);
    const items = result.rows.slice(0, limit).map(mapAdminInquiry);
    const last = items.at(-1);
    const counts = { new: 0, contacted: 0, closed: 0 };
    for (const row of countsResult.rows) counts[row.status] = Number(row.count);
    return {
      items, counts,
      nextCursor: result.rows.length > limit && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
    };
  }

  async updateInquiryStatus(actorUserId: string, inquiryId: string, status: ManagedInquiryStatus, expectedVersion: number): Promise<AdminInquiry | null> {
    return withTransaction(this.pool, async (client) => {
      const updated = await client.query<{ outcome: string }>(
        "SELECT public.admin_update_inquiry_status($1, $2, $3, $4, $5) AS outcome",
        [randomUUID(), actorUserId, inquiryId, status, expectedVersion],
      );
      if (updated.rows[0]?.outcome === "conflict") throw new InquiryVersionConflictError();
      if (updated.rows[0]?.outcome === "not_found") return null;
      const result = await client.query<AdminInquiryRow>(
        `SELECT id, contact_method, source, status, version, created_at, updated_at, notification_status
         FROM public.enterprise_inquiry_admin_list WHERE id = $1`, [inquiryId],
      );
      return result.rows[0] ? mapAdminInquiry(result.rows[0]) : null;
    });
  }

  async revealInquiryContact(actorUserId: string, inquiryId: string, reason: string) {
    const result = await this.pool.query<{
      contact_method: EnterpriseContactMethod; contact_ciphertext: string; encryption_key_id: string;
    }>("SELECT * FROM public.admin_reveal_inquiry_contact($1, $2, $3, $4)", [randomUUID(), actorUserId, inquiryId, reason]);
    const row = result.rows[0];
    return row ? { contactMethod: row.contact_method, contactCiphertext: row.contact_ciphertext, encryptionKeyId: row.encryption_key_id } : null;
  }
}
