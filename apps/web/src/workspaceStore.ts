import { apiRequest, readApiAuthContextVersion } from "./api";

export type PaymentAccountStatus = "not_configured" | "pending" | "active";

export type WorkspaceState = {
  discoveryCompleted: boolean;
  paymentAccountStatus: PaymentAccountStatus;
};

const workspaceRequests = new Map<number, Promise<WorkspaceState>>();

export function loadWorkspace() {
  const contextVersion = readApiAuthContextVersion();
  const existing = workspaceRequests.get(contextVersion);
  if (existing) return existing;
  const request = apiRequest<unknown>("/me/workspace").then((value) => {
    const response = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const rawPaymentStatus = response.paymentAccountStatus ?? response.paymentStatus;
    const paymentAccountStatus: PaymentAccountStatus = rawPaymentStatus === "active"
      ? "active"
      : rawPaymentStatus === "pending"
        ? "pending"
        : "not_configured";
    return {
      discoveryCompleted: response.discoveryCompleted === true,
      paymentAccountStatus,
    };
  });
  workspaceRequests.set(contextVersion, request);
  void request.finally(() => {
    if (workspaceRequests.get(contextVersion) === request) workspaceRequests.delete(contextVersion);
  }).catch(() => undefined);
  return request;
}
