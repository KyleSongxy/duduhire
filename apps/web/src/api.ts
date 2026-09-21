const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim();
export const API_BASE_URL = (configuredApiBase || "/api/v1").replace(/\/+$/u, "");
export const ACTIVE_ROLE_CHANGED_EVENT = "duduhire-active-role-changed";

let authContext: { id: string; role: "client" | "talent" } | null = null;
let authContextVersion = 0;

export function setApiAuthContext(session: typeof authContext) {
  if (authContext?.id !== session?.id || authContext?.role !== session?.role) authContextVersion += 1;
  authContext = session;
}

export function readApiAuthContextVersion() {
  return authContextVersion;
}

type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    field?: string;
    requestId?: string;
  };
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "REQUEST_FAILED",
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiRequestInit = RequestInit & { timeoutMs?: number };

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { timeoutMs = 15_000, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  if (requestInit.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const usesIdentity = path.startsWith("/me/");
  const requestContextVersion = authContextVersion;
  if (usesIdentity && authContext) headers.set("X-DuduHire-Role", authContext.role);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...requestInit,
      headers,
      credentials: "include",
      signal: requestInit.signal
        ? AbortSignal.any([requestInit.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError("无法连接服务，请稍后重试。", 0, "NETWORK_ERROR");
  }

  if (usesIdentity && requestContextVersion !== authContextVersion) {
    throw new ApiError("当前使用身份已更改，请刷新页面后继续；原身份的已保存内容会保留。", 409, "ACTIVE_ROLE_CHANGED");
  }

  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({})) as T & ApiErrorBody;
  if (usesIdentity && requestContextVersion !== authContextVersion) {
    throw new ApiError("当前使用身份已更改，请刷新页面后继续；原身份的已保存内容会保留。", 409, "ACTIVE_ROLE_CHANGED");
  }
  if (!response.ok) {
    const retryAfter = response.headers.get("Retry-After");
    const retrySeconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter)
      : retryAfter ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000) : undefined;
    const retryAfterSeconds = retrySeconds !== undefined && Number.isFinite(retrySeconds) && retrySeconds >= 0
      ? Math.min(retrySeconds, 86_400) : undefined;
    const message = body.error?.code === "ACTIVE_ROLE_CHANGED"
      ? "使用身份已在其他页面切换，请刷新页面后继续；原身份的已保存内容会保留。"
      : body.error?.message || "请求失败，请稍后重试。";
    if (body.error?.code === "ACTIVE_ROLE_CHANGED") window.dispatchEvent(new CustomEvent(ACTIVE_ROLE_CHANGED_EVENT));
    throw new ApiError(message, response.status, body.error?.code, retryAfterSeconds);
  }
  return body;
}
