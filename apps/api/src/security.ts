import { createHmac, randomBytes, randomUUID } from "node:crypto";

export function createId() {
  return randomUUID();
}

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string, secret: string) {
  return createHmac("sha256", secret).update(token, "utf8").digest("hex");
}

export function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86_400_000);
}
