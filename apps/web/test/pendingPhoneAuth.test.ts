import test from "node:test";
import assert from "node:assert/strict";
import { readPendingPhoneAuth, savePendingPhoneAuth, type PendingPhoneAuth } from "../src/pendingPhoneAuth.ts";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } as Storage;
}
const key = "duduhire-pending-phone-auth-v1";
const pending = (): PendingPhoneAuth => ({ intent: "signup", returnTo: "/workspace", role: "talent", phone: "13900000001", challenge: { id: "test-challenge", expiresAt: Date.now() + 300_000, expiresInSeconds: 300 }, resendAt: Date.now() + 60_000 });

test("restores only unexpired matching context, never saves an OTP", () => {
  const store = storage();
  const value = { ...pending(), code: "123456" };
  savePendingPhoneAuth(store, value);
  assert.equal(store.getItem(key)?.includes("123456"), false);
  assert.equal(readPendingPhoneAuth(store, "signup", "/workspace")?.role, "talent");
  assert.equal(readPendingPhoneAuth(store, "login", "/workspace"), null);
  assert.equal(readPendingPhoneAuth(store, "signup", "/projects"), null);
  assert.equal(readPendingPhoneAuth(store, "signup", "/workspace", Date.now() + 301_000), null);
  assert.equal(store.getItem(key), null);
});

test("corrupt or implausible recovery data is discarded", () => {
  const store = storage();
  for (const value of ["not-json", JSON.stringify({ ...pending(), phone: "broken" }), JSON.stringify({ ...pending(), challenge: { id: "x", expiresAt: Date.now() + 86_400_000, expiresInSeconds: 300 } })]) {
    store.setItem(key, value);
    assert.equal(readPendingPhoneAuth(store, "signup", "/workspace"), null);
    assert.equal(store.getItem(key), null);
  }
});

test("clearing and unavailable storage are safe", () => {
  const store = storage();
  savePendingPhoneAuth(store, pending());
  savePendingPhoneAuth(store, null);
  assert.equal(store.getItem(key), null);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } } as Storage;
  assert.equal(readPendingPhoneAuth(blocked, "login", "/workspace"), null);
  assert.doesNotThrow(() => savePendingPhoneAuth(blocked, pending()));
});
