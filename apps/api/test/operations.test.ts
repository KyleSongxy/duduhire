import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rotationScript = fileURLToPath(new URL("../src/rotateContactDataKey.ts", import.meta.url));
const currentKey = "0".repeat(64);
const validNextKey = "fedcba9876543210".repeat(4);

function runRotation(overrides: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", rotationScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      CURRENT_CONTACT_DATA_KEY: currentKey,
      CURRENT_CONTACT_DATA_KEY_ID: "contact-current-v1",
      NEXT_CONTACT_DATA_KEY: validNextKey,
      NEXT_CONTACT_DATA_KEY_ID: "contact-next-v2",
      ...overrides,
    },
  });
}

test("contact key rotation rejects a repeated-character next key before database access", () => {
  const result = runRotation({ NEXT_CONTACT_DATA_KEY: "1".repeat(64) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEXT_CONTACT_DATA_KEY must be a non-placeholder random key/u);
});

test("contact key rotation rejects a placeholder next key id before database access", () => {
  const result = runRotation({ NEXT_CONTACT_DATA_KEY_ID: "contact-placeholder-next" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEXT_CONTACT_DATA_KEY_ID must not use a placeholder value/u);
});
