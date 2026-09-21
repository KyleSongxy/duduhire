import type {
  AuthIntent,
  AuthRole,
  DiscoveryAttachmentMetadata,
  DiscoveryKind,
  DiscoveryState,
  EnterpriseContactMethod,
  EnterpriseInquiry,
  IntakeDraft,
  JsonObject,
  PersonalProfile,
  UserRecord,
  WorkspaceSummary,
  AdminInquiry,
  AdminInquiryPage,
  InquiryCursor,
  ManagedInquiryStatus,
} from "./domain.js";
import type { MatchingListing, MatchingListingRecord, PublishMatchingInput } from "./matching.js";

export type ChallengeCreationResult =
  | { created: true }
  | { created: false; reason: "account_not_found" }
  | { created: false; retryAfterSeconds: number };

export type NewEmailChallenge = {
  id: string;
  email: string;
  intent: AuthIntent;
  requestedRole: AuthRole | null;
  tokenHash: string;
  browserBindingHash: string;
  returnTo: string;
  expiresAt: Date;
  createdAt: Date;
};

export type NewSession = {
  id: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
};

export type AuthenticatedSession = {
  user: UserRecord;
  signedInAt: Date;
  expiresAt: Date;
};

export type VerifyChallengeResult =
  | { status: "verified"; session: AuthenticatedSession; returnTo: string }
  | { status: "account_not_found"; returnTo: string }
  | { status: "invalid" };

export type NewIntakeDraft = {
  id: string;
  browserBindingHash: string;
  prompt: string;
  createdAt: Date;
  expiresAt: Date;
};

export type NewDiscoveryTurn = {
  requestId: string;
  question: string;
  answer: string;
  attachments: DiscoveryAttachmentMetadata[];
  analysisContext: string;
  provider: string;
  model: string;
  promptVersion: string;
  artifactDraft: JsonObject;
};

export type ExpectedDiscoveryState = {
  threadId: string;
  threadVersion: number;
} | null;

export type NewEnterpriseInquiry = {
  id: string;
  userId: string | null;
  contactMethod: EnterpriseContactMethod;
  contactCiphertext: string;
  contactHash: string;
  encryptionKeyId: string;
  source: string;
  consentedAt: Date;
  createdAt: Date;
};

export class ProfileVersionConflictError extends Error {
  readonly code = "PROFILE_VERSION_CONFLICT";

  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super("The profile changed since it was loaded.");
    this.name = "ProfileVersionConflictError";
  }
}

export class InquiryVersionConflictError extends Error {
  constructor() {
    super("The inquiry changed since it was loaded.");
    this.name = "InquiryVersionConflictError";
  }
}

export class DiscoveryKindForbiddenError extends Error {
  readonly code = "DISCOVERY_KIND_FORBIDDEN";

  constructor() {
    super("The discovery kind is not available for this account role.");
    this.name = "DiscoveryKindForbiddenError";
  }
}

export class DiscoveryStateConflictError extends Error {
  readonly code = "DISCOVERY_STATE_CONFLICT";

  constructor() {
    super("The discovery thread changed while the response was being prepared.");
    this.name = "DiscoveryStateConflictError";
  }
}

export interface AppRepository {
  ping(): Promise<void>;
  close(): Promise<void>;
  isRegisteredLoginAccount(method: "email" | "phone", account: string): Promise<boolean>;
  createEmailChallengeIfAllowed(
    challenge: NewEmailChallenge,
    now: Date,
    resendSeconds: number,
    hourlyLimit: number,
  ): Promise<ChallengeCreationResult>;
  invalidateEmailChallenge(id: string): Promise<void>;
  consumeEmailChallenge(tokenHash: string, browserBindingHash: string, now: Date, session: NewSession): Promise<VerifyChallengeResult>;
  findSession(tokenHash: string, now: Date): Promise<AuthenticatedSession | null>;
  switchSessionRole(tokenHash: string, role: AuthRole, now: Date): Promise<AuthenticatedSession | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  readProfile(userId: string): Promise<PersonalProfile>;
  saveProfile(
    userId: string,
    profile: Omit<PersonalProfile, "version" | "updatedAt">,
    now: Date,
    expectedVersion?: number,
  ): Promise<PersonalProfile>;
  createIntakeDraft(draft: NewIntakeDraft): Promise<IntakeDraft>;
  claimIntakeDraft(userId: string, intakeId: string, browserBindingHash: string, now: Date): Promise<IntakeDraft | null>;
  readDiscovery(userId: string, kind: DiscoveryKind): Promise<DiscoveryState | null>;
  appendDiscoveryTurn(
    userId: string,
    kind: DiscoveryKind,
    turn: NewDiscoveryTurn,
    now: Date,
    expectedState: ExpectedDiscoveryState,
  ): Promise<DiscoveryState>;
  resetDiscovery(userId: string, kind: DiscoveryKind, now: Date, expectedState?: ExpectedDiscoveryState): Promise<boolean>;
  readMatchingListing(userId: string, kind: DiscoveryKind): Promise<MatchingListingRecord | null>;
  publishMatchingListing(userId: string, kind: DiscoveryKind, input: PublishMatchingInput, now: Date): Promise<MatchingListingRecord>;
  withdrawMatchingListing(userId: string, kind: DiscoveryKind, expectedListingId: string | null, expectedListingVersion: number, now: Date): Promise<MatchingListingRecord | null>;
  readMatchingCandidates(userId: string, kind: DiscoveryKind): Promise<{
    source: MatchingListingRecord | null;
    candidates: MatchingListingRecord[];
    catalogLimited: boolean;
  }>;
  /** Read only the separate synthetic catalog; never fall back to live accounts. */
  readMatchingExamples?(userId: string, kind: DiscoveryKind): Promise<MatchingListing[]>;
  readWorkspaceSummary(userId: string, role: AuthRole): Promise<WorkspaceSummary>;
  createEnterpriseInquiry(inquiry: NewEnterpriseInquiry): Promise<EnterpriseInquiry>;
  listAdminInquiries(status: ManagedInquiryStatus, limit: number, cursor: InquiryCursor | null): Promise<AdminInquiryPage>;
  updateInquiryStatus(actorUserId: string, inquiryId: string, status: ManagedInquiryStatus, expectedVersion: number): Promise<AdminInquiry | null>;
  revealInquiryContact(actorUserId: string, inquiryId: string, reason: string): Promise<{
    contactMethod: EnterpriseContactMethod;
    contactCiphertext: string;
    encryptionKeyId: string;
  } | null>;
}
