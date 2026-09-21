import { apiRequest, setApiAuthContext } from "./api";
import type { PersonalProfile } from "./profileStore";

export type AuthRole = "client" | "talent";

export type AuthSession = {
  id: string;
  email: string | null;
  phone?: string | null;
  role: AuthRole;
  roles: AuthRole[];
  emailVerifiedAt: string | null;
  phoneVerifiedAt?: string | null;
  signedInAt: string;
  expiresAt: string;
  profile: PersonalProfile;
};

type SessionResponse = {
  session: {
    user: {
      id: string;
      email: string | null;
      phone?: string | null;
      role: AuthRole;
      roles?: AuthRole[];
      emailVerifiedAt: string | null;
      phoneVerifiedAt?: string | null;
    };
    signedInAt: string;
    expiresAt: string;
    profile: PersonalProfile;
  } | null;
};

type StartEmailAuthResponse = {
  accepted: true;
  delivery: "email" | "development";
  expiresInSeconds: number;
  resendAfterSeconds: number;
};

type CompleteEmailAuthResponse =
  | { authenticated: true; returnTo: string }
  | { authenticated: false; reason: "account_not_found"; returnTo: string };

export type AuthMethods = {
  email: { available: boolean; delivery: "email" | "development" | "disabled" };
  phone: { available: boolean; region: "CN" };
};

type StartPhoneAuthResponse = {
  accepted: true;
  delivery: "sms";
  challengeId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
};

export const AUTH_UPDATED_EVENT = "duduhire-auth-updated";
export const AUTH_SYNC_STORAGE_KEY = "duduhire-auth-sync";
const LEGACY_SESSION_KEY = "duduhire-session";
const LEGACY_ROLE_STORE_KEY = "duduhire-local-roles";
let currentSession: AuthSession | null = null;
let sessionRequest: Promise<AuthSession | null> | null = null;
let roleSwitchRequest: Promise<AuthSession> | null = null;
let sessionRevision = 0;

function mapSession(response: SessionResponse): AuthSession | null {
  if (!response.session) return null;
  return {
    id: response.session.user.id,
    email: response.session.user.email,
    phone: response.session.user.phone ?? null,
    role: response.session.user.role,
    roles: response.session.user.roles ?? ["client", "talent"],
    emailVerifiedAt: response.session.user.emailVerifiedAt,
    phoneVerifiedAt: response.session.user.phoneVerifiedAt ?? null,
    signedInAt: response.session.signedInAt,
    expiresAt: response.session.expiresAt,
    profile: response.session.profile,
  };
}

function clearLegacyAuthState() {
  try {
    window.localStorage.removeItem(LEGACY_SESSION_KEY);
    window.localStorage.removeItem(LEGACY_ROLE_STORE_KEY);
  } catch {
    // Legacy browser state is not an authentication source and can be ignored.
  }
}

function notifyAuthUpdated() {
  window.dispatchEvent(new CustomEvent(AUTH_UPDATED_EVENT));
  try {
    // Only announce an invalidation. Account details stay in the authenticated session.
    window.localStorage.setItem(AUTH_SYNC_STORAGE_KEY, window.crypto.randomUUID());
  } catch {
    // Focus refresh still synchronizes sessions when storage is unavailable.
  }
}

function acceptSession(response: SessionResponse) {
  currentSession = mapSession(response);
  setApiAuthContext(currentSession);
  if (currentSession) clearLegacyAuthState();
  return currentSession;
}

export function readAuthSession() {
  return currentSession;
}

export async function loadAuthSession({ force = false }: { force?: boolean } = {}) {
  if (roleSwitchRequest) return roleSwitchRequest;
  if (sessionRequest && !force) return sessionRequest;
  const revision = ++sessionRevision;
  const request = apiRequest<SessionResponse>("/auth/session")
    .then((response) => {
      if (revision === sessionRevision) acceptSession(response);
      return currentSession;
    })
    .finally(() => {
      if (sessionRequest === request) sessionRequest = null;
    });
  sessionRequest = request;
  return request;
}

export async function switchAuthRole(role: AuthRole) {
  if (roleSwitchRequest) return roleSwitchRequest;
  const revision = ++sessionRevision;
  const request = apiRequest<SessionResponse>("/auth/role", {
    method: "POST",
    body: JSON.stringify({ role }),
  }).then((response) => {
    const nextSession = mapSession(response);
    if (!nextSession || nextSession.role !== role) throw new Error("暂时无法确认身份切换结果，请刷新页面后重试。");
    if (revision === sessionRevision) {
      acceptSession(response);
      notifyAuthUpdated();
    }
    return nextSession;
  }).finally(() => {
    if (roleSwitchRequest === request) roleSwitchRequest = null;
  });
  roleSwitchRequest = request;
  return request;
}

export async function requestEmailAuth(input: {
  email: string;
  intent: "login" | "signup";
  role?: AuthRole;
  returnTo: string;
}) {
  const response = await apiRequest<StartEmailAuthResponse>("/auth/email/challenges", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: 60_000,
  });
  if (!response || response.accepted !== true
    || (response.delivery !== "email" && response.delivery !== "development")
    || !Number.isInteger(response.expiresInSeconds) || response.expiresInSeconds <= 0
    || !Number.isInteger(response.resendAfterSeconds) || response.resendAfterSeconds < 0) {
    throw new Error("暂时无法确认邮件发送状态，请稍后重试。");
  }
  return response;
}

export async function loginWithPassword(email: string, password: string, returnTo: string) {
  const response = await apiRequest<{ authenticated: true; returnTo: string }>("/auth/password/login", {
    method: "POST", body: JSON.stringify({ email, password, returnTo }),
  });
  if (response?.authenticated !== true || typeof response.returnTo !== "string") throw new Error("暂时无法确认登录结果，请重试。");
  return response;
}

export async function loadPasswordSetup() {
  return apiRequest<{ canSetPassword: boolean; email: string | null }>("/auth/password/setup");
}

export async function savePassword(password: string) {
  const response = await apiRequest<{ saved: boolean }>("/auth/password/setup", {
    method: "POST", body: JSON.stringify({ password }),
  });
  if (response?.saved !== true) throw new Error("暂时无法确认密码保存结果，请重试。");
}

export async function completeEmailAuth(token: string) {
  return apiRequest<CompleteEmailAuthResponse>("/auth/email/verify", {
    method: "POST",
    body: JSON.stringify({ token }),
    timeoutMs: 60_000,
  });
}

export async function loadAuthMethods() {
  const response = await apiRequest<AuthMethods>("/auth/methods");
  if (!response || !["email", "development", "disabled"].includes(response.email?.delivery)
    || typeof response.email?.available !== "boolean"
    || response.email.available !== (response.email.delivery !== "disabled")
    || typeof response.phone?.available !== "boolean" || response.phone.region !== "CN") {
    throw new Error("暂时无法确认注册与登录服务状态。");
  }
  return response;
}

export async function checkLoginEligibility(method: "email" | "phone", account: string, signal: AbortSignal) {
  const response = await apiRequest<{ registered: boolean }>("/auth/login-eligibility", {
    method: "POST",
    body: JSON.stringify({ method, account }),
    signal,
  });
  if (!response || typeof response.registered !== "boolean") {
    throw new Error("暂时无法确认账号是否已注册，请重新检查。");
  }
  return response.registered;
}

export async function requestPhoneAuth(input: {
  phone: string;
  intent: "login" | "signup";
  role?: AuthRole;
  returnTo: string;
}) {
  const response = await apiRequest<StartPhoneAuthResponse>("/auth/phone/challenges", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: 60_000,
  });
  if (!response || response.accepted !== true || response.delivery !== "sms"
    || typeof response.challengeId !== "string" || !response.challengeId.trim()
    || !Number.isInteger(response.expiresInSeconds) || response.expiresInSeconds <= 0
    || !Number.isInteger(response.resendAfterSeconds) || response.resendAfterSeconds < 0) {
    throw new Error("暂时无法确认验证码发送状态，请稍后重新申请。");
  }
  return response;
}

export async function completePhoneAuth(challengeId: string, code: string) {
  const response = await apiRequest<CompleteEmailAuthResponse>("/auth/phone/verify", {
    method: "POST",
    body: JSON.stringify({ challengeId, code }),
    timeoutMs: 60_000,
  });
  if (!response || typeof response.returnTo !== "string"
    || (response.authenticated !== true
      && (response.authenticated !== false || response.reason !== "account_not_found"))) {
    throw new Error("暂时无法确认验证结果，请稍后重试。");
  }
  return response;
}

export async function clearAuthSession() {
  try {
    if (roleSwitchRequest) await roleSwitchRequest;
    ++sessionRevision;
    await apiRequest<void>("/auth/logout", { method: "POST" });
    ++sessionRevision;
    sessionRequest = null;
    acceptSession({ session: null });
    clearLegacyAuthState();
    notifyAuthUpdated();
    return true;
  } catch {
    return false;
  }
}

export function normalizeReturnTo(value: string | null | undefined, fallback = "/workspace") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  const target = new URL(value, window.location.origin);
  if (target.origin !== window.location.origin) return fallback;
  if (!target.pathname.startsWith("/") || target.pathname.startsWith("//")) return fallback;
  const path = target.pathname.replace(/\/+$/u, "") || "/";
  if (path === "/login" || path === "/signup" || path === "/auth/verify") return fallback;
  return `${target.pathname}${target.search}${target.hash}`;
}

export function buildAuthHref(mode: "login" | "signup", returnTo: string) {
  const params = new URLSearchParams({ returnTo: normalizeReturnTo(returnTo) });
  return `/${mode}?${params.toString()}`;
}

export function inferAuthRole(returnTo: string): AuthRole {
  return returnTo.startsWith("/projects") ? "talent" : "client";
}

export function currentPathWithSearchAndHash() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}
