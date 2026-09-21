export type AuthRole = "client" | "talent";
export type AuthIntent = "login" | "signup";

export type DiscoveryKind = "problem" | "capability";
export type DiscoveryThreadStatus = "active" | "archived";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type DiscoveryAttachmentMetadata = {
  name: string;
  mediaType: string;
  size: number;
};

export type DiscoveryTurn = {
  id: string;
  requestId: string;
  question: string;
  answer: string;
  attachments: DiscoveryAttachmentMetadata[];
  analysisContext: string;
  provider: string;
  model: string;
  promptVersion: string;
  createdAt: Date;
};

export type DiscoveryArtifact = {
  id: string;
  kind: DiscoveryKind;
  draft: JsonObject;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type DiscoveryThread = {
  id: string;
  kind: DiscoveryKind;
  status: DiscoveryThreadStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type DiscoveryState = {
  thread: DiscoveryThread;
  turns: DiscoveryTurn[];
  artifact: DiscoveryArtifact | null;
};

export type IntakeDraft = {
  id: string;
  prompt: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
};

export type WorkspaceSummary = {
  role: AuthRole;
  emailVerified: boolean;
  phoneVerified?: boolean;
  discoveryKind: DiscoveryKind;
  discoveryCompleted: boolean;
  activeThreadId: string | null;
  turnCount: number;
  artifactVersion: number | null;
  updatedAt: Date | null;
};

export type EnterpriseContactMethod = "phone" | "wechat";
export type EnterpriseInquiryStatus = "new" | "contacted" | "closed" | "spam";
export type ManagedInquiryStatus = "new" | "contacted" | "closed";
export type InquiryNotificationStatus = "pending" | "sent" | "failed";

export type AdminInquiry = {
  id: string;
  contactMethod: EnterpriseContactMethod;
  source: string;
  status: ManagedInquiryStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  notificationStatus: InquiryNotificationStatus;
};

export type InquiryCursor = { createdAt: string; id: string };
export type AdminInquiryPage = {
  items: AdminInquiry[];
  nextCursor: InquiryCursor | null;
  counts: Record<ManagedInquiryStatus, number>;
};

export type EnterpriseInquiry = {
  id: string;
  contactMethod: EnterpriseContactMethod;
  source: string;
  status: EnterpriseInquiryStatus;
  consentedAt: Date;
  createdAt: Date;
};

export type UserRecord = {
  id: string;
  email: string | null;
  role: AuthRole;
  emailVerifiedAt: Date | null;
  phone?: string | null;
  phoneVerifiedAt?: Date | null;
  createdAt: Date;
};

export type PersonalProfile = {
  displayName: string;
  countryCode: string;
  contact: string;
  organization: string;
  jobTitle: string;
  professionalTitle: string;
  bio: string;
  version: number;
  updatedAt: Date | null;
};

export const emptyProfile = (): PersonalProfile => ({
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

const EMAIL_LOCAL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u;
const EMAIL_DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9-]+$/u;

export function normalizeEmail(value: string) {
  const email = value.trim().normalize("NFKC").toLowerCase();
  if (email.length < 3 || email.length > 254 || email.split("@").length !== 2) return null;
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain || localPart.length > 64 || domain.length > 253 || !EMAIL_LOCAL_PATTERN.test(localPart)) return null;
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => (
    label.length < 1
    || label.length > 63
    || !EMAIL_DOMAIN_LABEL_PATTERN.test(label)
    || label.startsWith("-")
    || label.endsWith("-")
  ))) return null;
  return email;
}

export function normalizeReturnTo(value: string | undefined, fallback = "/workspace") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  const url = new URL(value, "https://duduhire.invalid");
  if (url.origin !== "https://duduhire.invalid" || !url.pathname.startsWith("/") || url.pathname.startsWith("//")) return fallback;
  const path = url.pathname.replace(/\/+$/u, "") || "/";
  if (path === "/login" || path === "/signup" || path === "/auth/verify") return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function sanitizeProfile(value: Omit<PersonalProfile, "version" | "updatedAt">) {
  return {
    displayName: value.displayName.trim().slice(0, 80),
    countryCode: /^(?:[A-Z]{2})?$/u.test(value.countryCode) ? value.countryCode : "",
    contact: value.contact.trim().slice(0, 80),
    organization: value.organization.trim().slice(0, 120),
    jobTitle: value.jobTitle.trim().slice(0, 80),
    professionalTitle: value.professionalTitle.trim().slice(0, 100),
    bio: value.bio.trim().slice(0, 500),
  };
}
