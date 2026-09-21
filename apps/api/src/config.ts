import { normalizeEmail } from "./domain.js";
import { loadPhoneAuthConfig, type PhoneAuthConfig } from "./phoneAuthConfig.js";

type RuntimeEnvironment = "development" | "test" | "production";
export type AiMode = "local" | "openai" | "qwen";

export const OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_QWEN_MODEL = "qwen3.8-max";

export type AppConfig = {
  phoneAuth?: PhoneAuthConfig;
  environment: RuntimeEnvironment;
  host: string;
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  webOrigin: string;
  authTokenSecret: string;
  authCookieName: string;
  authCookieSecure: boolean;
  sessionTtlDays: number;
  magicLinkTtlMinutes: number;
  emailResendSeconds: number;
  emailHourlyLimit: number;
  emailDeliveryMode: "console" | "smtp" | "disabled";
  smtpUrl?: string;
  emailFrom: string;
  aiMode: AiMode;
  openAiApiKey?: string;
  openAiModel?: string;
  openAiBaseUrl: string;
  qwenApiKey?: string;
  qwenModel?: string;
  qwenBaseUrl?: string;
  contactDataKey?: string;
  contactDataKeyId?: string;
  logLevel: string;
  trustProxy: false | string[];
  adminUserIds?: string[];
};

function readRequired(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected true or false, received: ${value}`);
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}, received: ${value}`);
  }
  return parsed;
}

function parseUrl(value: string, key: string) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${key} must be a valid URL.`);
  }
}

function readOrigin(value: string, key: string) {
  const url = parseUrl(value, key);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${key} must be an http(s) origin without a path, query, or credentials.`);
  }
  return url.origin;
}

const databaseTlsParameters = new Set(["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslpassword", "sslcrl"]);

function readDatabaseUrl(value: string) {
  const url = parseUrl(value, "DATABASE_URL");
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
  }
  for (const key of url.searchParams.keys()) {
    if (databaseTlsParameters.has(key.toLowerCase())) {
      throw new Error("Configure database TLS only with DATABASE_SSL; DATABASE_URL cannot contain SSL parameters.");
    }
  }
  if (url.search || url.hash) {
    throw new Error("DATABASE_URL cannot contain query parameters or a fragment; connection policy is configured by the application.");
  }
  return value;
}

function readSmtpUrl(value: string | undefined, production: boolean) {
  if (!value) return undefined;
  const url = parseUrl(value, "SMTP_URL");
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error("SMTP_URL must use the smtp or smtps protocol.");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("SMTP_URL cannot contain a path, query, or fragment.");
  }
  if (production && (!url.username || !url.password)) {
    throw new Error("Production SMTP_URL must include authentication credentials.");
  }
  return value;
}

function readEmailFrom(value: string | undefined, production: boolean) {
  const emailFrom = value?.trim() || (production ? "" : "DuduHire <no-reply@localhost.test>");
  if (!emailFrom) throw new Error("EMAIL_FROM is required in production.");
  const namedAddress = emailFrom.match(/^[^<>\r\n,]{1,100}<([^<>\r\n,]+)>$/u);
  const hasAngleBracket = emailFrom.includes("<") || emailFrom.includes(">");
  const mailbox = namedAddress?.[1]?.trim() ?? emailFrom;
  if (emailFrom.length > 320 || /[\r\n,;]/u.test(emailFrom) || (hasAngleBracket && !namedAddress) || !normalizeEmail(mailbox)) {
    throw new Error("EMAIL_FROM must be a valid single email sender.");
  }
  return emailFrom;
}

function readAiMode(value: string | undefined): AiMode {
  const mode = value?.trim() || "qwen";
  if (mode !== "local" && mode !== "openai" && mode !== "qwen") {
    throw new Error("AI_MODE must be qwen, openai, or local.");
  }
  return mode;
}

export function readQwenBaseUrl(value: string | undefined) {
  const url = parseUrl(value?.trim() || DEFAULT_QWEN_BASE_URL, "QWEN_BASE_URL");
  const legacyHost = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].includes(url.hostname);
  // Only workspace endpoints documented by Alibaba Cloud are accepted. No arbitrary proxy can receive credentials.
  const workspaceHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1)\.maas\.aliyuncs\.com$/u.test(url.hostname);
  if (
    url.protocol !== "https:"
    || (!legacyHost && !workspaceHost)
    || url.port
    || url.pathname.replace(/\/+$/u, "") !== "/compatible-mode/v1"
    || url.username || url.password || url.search || url.hash
  ) {
    throw new Error("QWEN_BASE_URL must use an official Alibaba Cloud HTTPS Chat API endpoint with path /compatible-mode/v1 and no credentials, query, or fragment.");
  }
  return `${url.origin}/compatible-mode/v1`;
}

function readQwenSecret(value: string | undefined) {
  const secret = value?.trim();
  if (!secret) return undefined;
  if (/\s/u.test(secret)) throw new Error("QWEN_API_KEY or DASHSCOPE_API_KEY cannot contain whitespace.");
  if (/(?:replace|change[-_ ]?me|placeholder|your[-_ ]?(?:api[-_ ]?)?key)/iu.test(secret)) {
    throw new Error("Qwen credentials must not use placeholder values.");
  }
  return secret;
}

function readQwenModel(value: string | undefined) {
  const model = value?.trim() || DEFAULT_QWEN_MODEL;
  if (!/^qwen[A-Za-z0-9._:-]{0,123}$/iu.test(model)) {
    throw new Error("QWEN_MODEL must be a valid Qwen model identifier.");
  }
  return model;
}

function readOpenAiBaseUrl(value: string | undefined) {
  const raw = value?.trim() || OFFICIAL_OPENAI_BASE_URL;
  const url = parseUrl(raw, "OPENAI_BASE_URL");
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (
    url.protocol !== "https:"
    || url.origin !== "https://api.openai.com"
    || pathname !== "/v1"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`OPENAI_BASE_URL must be ${OFFICIAL_OPENAI_BASE_URL}.`);
  }
  return OFFICIAL_OPENAI_BASE_URL;
}

function readOpenAiSecret(value: string | undefined) {
  const secret = value?.trim();
  if (!secret) return undefined;
  if (/\s/u.test(secret)) throw new Error("OPENAI_API_KEY cannot contain whitespace.");
  return secret;
}

function readOpenAiModel(value: string | undefined) {
  const model = value?.trim();
  if (!model) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(model)) {
    throw new Error("OPENAI_MODEL must be a valid model identifier.");
  }
  return model;
}

function readContactDataKey(value: string | undefined) {
  const key = value?.trim();
  if (!key) return undefined;
  if (!/^[A-Fa-f0-9]{64}$/u.test(key)) {
    throw new Error("CONTACT_DATA_KEY must be exactly 64 hexadecimal characters (32 bytes).");
  }
  return key.toLowerCase();
}

function readContactDataKeyId(value: string | undefined) {
  const keyId = value?.trim();
  if (!keyId) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(keyId)) {
    throw new Error("CONTACT_DATA_KEY_ID must be a valid key identifier of at most 100 characters.");
  }
  return keyId;
}

function readTrustProxy(value: string | undefined): false | string[] {
  if (value === undefined || value.trim() === "") return false;
  const cidrs = value.split(",").map((item) => item.trim()).filter(Boolean);
  const trustsEveryAddress = cidrs.some((item) => ["true", "all", "0.0.0.0/0", "::/0"].includes(item.toLowerCase()));
  if (cidrs.length === 0 || cidrs.length > 10 || cidrs.some((item) => item.length > 80) || trustsEveryAddress) {
    throw new Error("TRUST_PROXY_CIDRS must contain at most 10 trusted proxy IP/CIDR entries.");
  }
  return cidrs;
}

function readAdminUserIds(value: string | undefined) {
  if (!value?.trim()) return [];
  const ids = value.split(",").map((item) => item.trim().toLowerCase());
  if (ids.length > 100 || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))) {
    throw new Error("ADMIN_USER_IDS must contain at most 100 comma-separated user UUIDs.");
  }
  return [...new Set(ids)];
}

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = readDatabaseUrl(readRequired(env, "DATABASE_URL"));
  const databaseSsl = readBoolean(env.DATABASE_SSL, false);
  if (env.NODE_ENV === "production" && !databaseSsl) throw new Error("Production database connections must use TLS.");
  return { databaseUrl, databaseSsl };
}

export type NotificationConfig = {
  databaseUrl: string;
  databaseSsl: boolean;
  recipient: string;
  smtpUrl: string;
  emailFrom: string;
  webOrigin: string;
  requireTls: boolean;
  pollMs: number;
};

export function loadNotificationConfig(env: NodeJS.ProcessEnv = process.env): NotificationConfig | null {
  if (!env.INQUIRY_NOTIFICATION_EMAIL?.trim()) return null;
  const recipient = normalizeEmail(env.INQUIRY_NOTIFICATION_EMAIL);
  if (!recipient) throw new Error("INQUIRY_NOTIFICATION_EMAIL must be a valid single email address.");
  const production = env.NODE_ENV === "production";
  const database = loadDatabaseConfig({ ...env, DATABASE_URL: readRequired(env, "NOTIFICATION_DATABASE_URL") });
  const smtpUrl = readSmtpUrl(readRequired(env, "SMTP_URL"), production);
  if (!smtpUrl) throw new Error("SMTP_URL is required for inquiry notifications.");
  const webOrigin = readOrigin(env.WEB_ORIGIN || "http://localhost:5173", "WEB_ORIGIN");
  if (production && !webOrigin.startsWith("https:")) throw new Error("Production WEB_ORIGIN must use HTTPS.");
  return {
    ...database, recipient, smtpUrl, webOrigin, requireTls: production,
    emailFrom: readEmailFrom(env.EMAIL_FROM, production),
    pollMs: readInteger(env.INQUIRY_NOTIFICATION_POLL_MS, 5_000, 1_000, 60_000),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = (env.NODE_ENV || "development") as RuntimeEnvironment;
  if (!(["development", "test", "production"] as const).includes(environment)) {
    throw new Error(`Unsupported NODE_ENV: ${environment}`);
  }

  const database = loadDatabaseConfig(env);
  const webOrigin = readOrigin(env.WEB_ORIGIN || "http://localhost:5173", "WEB_ORIGIN");
  const authTokenSecret = readRequired(env, "AUTH_TOKEN_SECRET");
  if (authTokenSecret.length < 32) throw new Error("AUTH_TOKEN_SECRET must contain at least 32 characters.");

  const emailDeliveryMode = (env.EMAIL_DELIVERY_MODE || "console") as AppConfig["emailDeliveryMode"];
  if (emailDeliveryMode !== "console" && emailDeliveryMode !== "smtp" && emailDeliveryMode !== "disabled") {
    throw new Error("EMAIL_DELIVERY_MODE must be console, smtp, or disabled.");
  }
  const smtpUrl = emailDeliveryMode === "disabled" ? undefined : readSmtpUrl(env.SMTP_URL?.trim(), environment === "production");
  if (emailDeliveryMode === "smtp" && !smtpUrl) throw new Error("SMTP_URL is required when EMAIL_DELIVERY_MODE=smtp.");
  const emailFrom = emailDeliveryMode === "disabled" ? "" : readEmailFrom(env.EMAIL_FROM, environment === "production");

  const authCookieSecure = readBoolean(env.AUTH_COOKIE_SECURE, environment === "production");
  const authCookieName = env.AUTH_COOKIE_NAME?.trim() || (environment === "production" ? "__Host-duduhire_session" : "duduhire_session");

  if (environment === "production") {
    if (webOrigin.startsWith("http:")) throw new Error("Production WEB_ORIGIN must use HTTPS.");
    if (!authCookieSecure) throw new Error("Production authentication cookies must be Secure.");
    if (!authCookieName.startsWith("__Host-")) throw new Error("Production AUTH_COOKIE_NAME must use the __Host- prefix.");
    if (emailDeliveryMode === "console") throw new Error("Production email delivery must use SMTP or be explicitly disabled.");
    if (/(?:replace|change[-_ ]?me|placeholder|example)/iu.test(authTokenSecret) || new Set(authTokenSecret).size < 8) {
      throw new Error("Production AUTH_TOKEN_SECRET must be a non-placeholder random secret.");
    }
  }

  const aiMode = readAiMode(env.AI_MODE);
  const openAiApiKey = readOpenAiSecret(env.OPENAI_API_KEY);
  const openAiModel = readOpenAiModel(env.OPENAI_MODEL);
  const openAiBaseUrl = readOpenAiBaseUrl(env.OPENAI_BASE_URL);
  const qwenApiKey = aiMode === "qwen" ? readQwenSecret(env.QWEN_API_KEY?.trim() || env.DASHSCOPE_API_KEY) : undefined;
  const qwenModel = readQwenModel(env.QWEN_MODEL);
  const qwenBaseUrl = readQwenBaseUrl(env.QWEN_BASE_URL);
  const contactDataKey = readContactDataKey(env.CONTACT_DATA_KEY);
  const contactDataKeyId = readContactDataKeyId(env.CONTACT_DATA_KEY_ID);
  if (aiMode === "openai" && !openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required when AI_MODE=openai.");
  }
  if (aiMode === "openai" && !openAiModel) {
    throw new Error("OPENAI_MODEL is required when AI_MODE=openai.");
  }
  if (aiMode === "qwen" && !qwenApiKey) {
    throw new Error("QWEN_API_KEY or DASHSCOPE_API_KEY is required when AI_MODE=qwen. Local rules require explicit AI_MODE=local and are not a Qwen fallback.");
  }
  if (environment === "production" && aiMode === "local") {
    throw new Error("Production AI_MODE must be qwen or openai.");
  }
  if (environment === "production" && aiMode === "openai" && (
    !openAiApiKey
    || !openAiModel
    || /(?:replace|change[-_ ]?me|placeholder)/iu.test(openAiApiKey)
    || /(?:replace|placeholder)/iu.test(openAiModel)
  )) {
    throw new Error("Production OpenAI credentials and model must not use placeholder values.");
  }
  if (environment === "production" && !contactDataKey) {
    throw new Error("CONTACT_DATA_KEY is required in production.");
  }
  if (environment === "production" && contactDataKey && (/^([0-9a-f])\1{63}$/u.test(contactDataKey) || contactDataKey === "deadbeef".repeat(8))) {
    throw new Error("Production CONTACT_DATA_KEY must be a non-placeholder random key.");
  }
  if (environment === "production" && !contactDataKeyId) {
    throw new Error("CONTACT_DATA_KEY_ID is required in production.");
  }
  if (environment === "production" && contactDataKeyId && /(?:replace|placeholder)/iu.test(contactDataKeyId)) {
    throw new Error("Production CONTACT_DATA_KEY_ID must not use a placeholder value.");
  }

  return {
    environment,
    phoneAuth: loadPhoneAuthConfig(env),
    host: env.HOST?.trim() || "127.0.0.1",
    port: readInteger(env.PORT, 8787, 1, 65_535),
    ...database,
    webOrigin,
    authTokenSecret,
    authCookieName,
    authCookieSecure,
    sessionTtlDays: readInteger(env.SESSION_TTL_DAYS, 30, 1, 90),
    magicLinkTtlMinutes: readInteger(env.MAGIC_LINK_TTL_MINUTES, 15, 5, 60),
    emailResendSeconds: readInteger(env.EMAIL_RESEND_SECONDS, 60, 30, 600),
    emailHourlyLimit: readInteger(env.EMAIL_HOURLY_LIMIT, 5, 1, 20),
    emailDeliveryMode,
    smtpUrl,
    emailFrom,
    aiMode,
    openAiApiKey,
    openAiModel,
    openAiBaseUrl,
    qwenApiKey,
    qwenModel,
    qwenBaseUrl,
    contactDataKey,
    contactDataKeyId,
    logLevel: env.LOG_LEVEL?.trim() || "info",
    trustProxy: readTrustProxy(env.TRUST_PROXY_CIDRS),
    adminUserIds: readAdminUserIds(env.ADMIN_USER_IDS),
  };
}
