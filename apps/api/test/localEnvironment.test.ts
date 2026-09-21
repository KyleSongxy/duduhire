import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadLocalEnvironment } from "../src/localEnvironment.js";

function fixture(t: TestContext, content = "QWEN_API_KEY=synthetic-file-key\nQWEN_MODEL=qwen-plus\n") {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "duduhire-qwen-env-"));
  chmodSync(directory, 0o700);
  const file = join(directory, "qwen.env");
  writeFileSync(file, content, { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { DUDUHIRE_LOAD_LOCAL_ENV: "true", DUDUHIRE_QWEN_ENV_FILE: file };
  return { directory, file, env };
}

test("local Qwen file access requires explicit opt-in and is disabled in production", () => {
  for (const overrides of [{}, { DUDUHIRE_LOAD_LOCAL_ENV: "false" }, { DUDUHIRE_LOAD_LOCAL_ENV: "true", NODE_ENV: "production" }]) {
    const env: NodeJS.ProcessEnv = { DUDUHIRE_QWEN_ENV_FILE: "invalid-relative-path", ...overrides };
    assert.equal(loadLocalEnvironment(env), false);
    assert.equal(env.QWEN_API_KEY, undefined);
  }
});

test("either injected Qwen credential skips the complete private file configuration", () => {
  for (const key of ["QWEN_API_KEY", "DASHSCOPE_API_KEY"] as const) {
    const env: NodeJS.ProcessEnv = {
      DUDUHIRE_LOAD_LOCAL_ENV: "true",
      DUDUHIRE_QWEN_ENV_FILE: "invalid-relative-path",
      [key]: "synthetic-injected-key",
    };
    assert.equal(loadLocalEnvironment(env), false);
    assert.equal(env.QWEN_MODEL, undefined);
    assert.equal(env.QWEN_BASE_URL, undefined);
    assert.equal(env[key], "synthetic-injected-key");
  }
});

test("private files only fill the Qwen whitelist without replacing explicit process configuration", (t) => {
  const { env } = fixture(t, [
    "AI_MODE=qwen", "QWEN_API_KEY=synthetic-file-key", "DASHSCOPE_API_KEY=synthetic-alias-key",
    "QWEN_MODEL=qwen-plus", "QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1",
    "NODE_ENV=production", "DATABASE_URL=synthetic-database", "RUN_QWEN_SMOKE=true", "NODE_OPTIONS=--inspect",
  ].join("\n"));
  Object.assign(env, { QWEN_API_KEY: " ", AI_MODE: "local", QWEN_MODEL: "qwen-turbo", QWEN_BASE_URL: "" });
  assert.equal(loadLocalEnvironment(env), true);
  assert.equal(env.QWEN_API_KEY, "synthetic-file-key");
  assert.equal(env.DASHSCOPE_API_KEY, "synthetic-alias-key");
  assert.equal(env.AI_MODE, "local");
  assert.equal(env.QWEN_MODEL, "qwen-turbo");
  assert.equal(env.QWEN_BASE_URL, "");
  for (const key of ["NODE_ENV", "DATABASE_URL", "RUN_QWEN_SMOKE", "NODE_OPTIONS"]) assert.equal(env[key], undefined);
});

test("absent private files leave existing configuration validation in control", (t) => {
  const { directory, env } = fixture(t);
  env.DUDUHIRE_QWEN_ENV_FILE = join(directory, "absent.env");
  assert.equal(loadLocalEnvironment(env), false);
  assert.equal(env.QWEN_API_KEY, undefined);
});

test("relative override paths are rejected without exposing a path or cause", () => {
  assert.throws(() => loadLocalEnvironment({ DUDUHIRE_LOAD_LOCAL_ENV: "true", DUDUHIRE_QWEN_ENV_FILE: "private-relative-synthetic-path" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Local Qwen configuration could not be loaded securely\./u);
    assert.doesNotMatch(error.message, /private-relative-synthetic-path/u);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("private file and immediate directory must have exact owner-only permissions", (t) => {
  const { directory, file, env } = fixture(t);
  for (const [target, unsafeMode, safeMode] of [[file, 0o640, 0o600], [directory, 0o750, 0o700]] as const) {
    chmodSync(target, unsafeMode);
    assert.throws(() => loadLocalEnvironment(env), /Local Qwen configuration could not be loaded securely/u);
    assert.equal(env.QWEN_API_KEY, undefined);
    chmodSync(target, safeMode);
  }
  assert.equal(loadLocalEnvironment(env), true);
});

test("symlinks to a private file or any containing directory are rejected", (t) => {
  const { directory, file, env } = fixture(t);
  const linkedFile = join(directory, "linked.env");
  symlinkSync(file, linkedFile);
  env.DUDUHIRE_QWEN_ENV_FILE = linkedFile;
  assert.throws(() => loadLocalEnvironment(env), /Local Qwen configuration could not be loaded securely/u);

  const privateDirectory = join(directory, "private");
  mkdirSync(privateDirectory, { mode: 0o700 });
  writeFileSync(join(privateDirectory, "qwen.env"), "QWEN_API_KEY=synthetic-linked-key\n", { mode: 0o600 });
  const linkedDirectory = join(directory, "linked-directory");
  symlinkSync(privateDirectory, linkedDirectory);
  env.DUDUHIRE_QWEN_ENV_FILE = join(linkedDirectory, "qwen.env");
  assert.throws(() => loadLocalEnvironment(env), /Local Qwen configuration could not be loaded securely/u);
  assert.equal(env.QWEN_API_KEY, undefined);
});

test("private configuration owned by a different user is rejected", (t) => {
  const { env } = fixture(t);
  t.mock.method(process, "getuid", () => -1);
  assert.throws(() => loadLocalEnvironment(env), /Local Qwen configuration could not be loaded securely/u);
  assert.equal(env.QWEN_API_KEY, undefined);
});

test("non-regular and oversized private files are rejected with sanitized errors", (t) => {
  const { directory, file, env } = fixture(t);
  const nestedDirectory = join(directory, "directory.env");
  mkdirSync(nestedDirectory, { mode: 0o700 });
  env.DUDUHIRE_QWEN_ENV_FILE = nestedDirectory;
  assert.throws(() => loadLocalEnvironment(env), /Local Qwen configuration could not be loaded securely/u);
  writeFileSync(file, `QWEN_API_KEY=synthetic-private-marker-${"x".repeat(65_536)}`);
  env.DUDUHIRE_QWEN_ENV_FILE = file;
  assert.throws(() => loadLocalEnvironment(env), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /synthetic-private-marker|duduhire-qwen-env-/u);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(env.QWEN_API_KEY, undefined);
});
