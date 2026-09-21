const storageKey = "duduhire-pending-phone-auth-v1";

export type PendingPhoneAuth = {
  intent: "login" | "signup";
  returnTo: string;
  role: "client" | "talent";
  phone: string;
  challenge: { id: string; expiresAt: number; expiresInSeconds: number };
  resendAt: number;
};

// Tab-scoped recovery metadata only. Never persist the SMS code or a session token.
// The API still verifies expiry, consumption, and the HttpOnly browser binding.
export function readPendingPhoneAuth(storage: Storage, intent: PendingPhoneAuth["intent"], returnTo: string, now = Date.now()): PendingPhoneAuth | null {
  try {
    const value = JSON.parse(storage.getItem(storageKey) || "null") as PendingPhoneAuth | null;
    if (!value) return null;
    if (!["login", "signup"].includes(value.intent) || !["client", "talent"].includes(value.role)
      || typeof value.returnTo !== "string" || !value.returnTo.startsWith("/") || value.returnTo.startsWith("//")
      || typeof value.phone !== "string" || !/^1[3-9]\d{9}$/u.test(value.phone)
      || typeof value.challenge?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.challenge.id)
      || !Number.isFinite(value.challenge.expiresAt) || value.challenge.expiresAt <= now || value.challenge.expiresAt > now + 600_000
      || !Number.isInteger(value.challenge.expiresInSeconds) || value.challenge.expiresInSeconds < 1 || value.challenge.expiresInSeconds > 600
      || !Number.isFinite(value.resendAt) || value.resendAt < 0 || value.resendAt > now + 86_400_000) {
      storage.removeItem(storageKey);
      return null;
    }
    return value.intent === intent && value.returnTo === returnTo ? value : null;
  } catch {
    try { storage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
    return null;
  }
}

export function savePendingPhoneAuth(storage: Storage, value: PendingPhoneAuth | null) {
  try {
    if (!value || value.challenge.expiresAt <= Date.now()) storage.removeItem(storageKey);
    else storage.setItem(storageKey, JSON.stringify({
      intent: value.intent, returnTo: value.returnTo, role: value.role, phone: value.phone,
      challenge: { id: value.challenge.id, expiresAt: value.challenge.expiresAt, expiresInSeconds: value.challenge.expiresInSeconds },
      resendAt: value.resendAt,
    }));
  } catch { /* Continue in memory when tab storage is unavailable. */ }
}
