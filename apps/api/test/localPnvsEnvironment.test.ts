import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { loadLocalPnvsEnvironment, localPnvsEnvironmentError } from "../src/localPnvsEnvironment.js";

const credentials = { accessKeyId: "SyntheticPnvsAccessKey", accessKeySecret: "SyntheticPnvsSecret" };

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "duduhire-pnvs-loader-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "pnvs.json");
  const env: NodeJS.ProcessEnv = { NODE_ENV: "development", DUDUHIRE_LOAD_LOCAL_ENV: "true" };
  const save = (value: unknown = credentials) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return { directory, file, env, save };
}

function assertSecureFailure(action: () => unknown) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, localPnvsEnvironmentError);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, /SyntheticPnvs|duduhire-pnvs-loader/u);
    return true;
  });
}

test("local PNVS loader imports exactly the credential pair without enabling sending or touching Qwen", (t) => {
  const { directory, env, save } = fixture(t);
  env.QWEN_API_KEY = "SyntheticQwenUnchanged";
  save();
  assert.equal(loadLocalPnvsEnvironment(env, directory), true);
  assert.deepEqual(env, {
    NODE_ENV: "development", DUDUHIRE_LOAD_LOCAL_ENV: "true", QWEN_API_KEY: "SyntheticQwenUnchanged",
    PNVS_ACCESS_KEY_ID: credentials.accessKeyId, PNVS_ACCESS_KEY_SECRET: credentials.accessKeySecret,
  });
});

test("production, missing opt-in and injected or partial environment credentials never read a private file", (t) => {
  const { directory, env, file } = fixture(t);
  writeFileSync(file, "malformed private content", { mode: 0o644 });
  const cases: NodeJS.ProcessEnv[] = [
    { ...env, NODE_ENV: "production" }, { ...env, DUDUHIRE_LOAD_LOCAL_ENV: undefined },
    { ...env, DUDUHIRE_LOAD_LOCAL_ENV: "false" },
    { ...env, PNVS_ACCESS_KEY_ID: "SyntheticInjectedId" },
    { ...env, PNVS_ACCESS_KEY_SECRET: "SyntheticInjectedSecret" },
    { ...env, PNVS_ACCESS_KEY_ID: "" }, { ...env, PNVS_ACCESS_KEY_SECRET: "" },
  ];
  for (const input of cases) {
    const before = { ...input };
    assert.equal(loadLocalPnvsEnvironment(input, directory), false);
    assert.deepEqual(input, before);
  }
});

test("missing local PNVS file or directory is optional", (t) => {
  const { directory, env } = fixture(t);
  assert.equal(loadLocalPnvsEnvironment(env, directory), false);
  assert.equal(loadLocalPnvsEnvironment(env, join(directory, "missing")), false);
  assert.equal(env.PNVS_ACCESS_KEY_ID, undefined);
});

test("PNVS loader rejects relative locations and symlinks at every level", (t) => {
  const { directory, env } = fixture(t);
  const actual = join(directory, "actual");
  mkdirSync(actual, { mode: 0o700 });
  const file = join(actual, "pnvs.json");
  writeFileSync(file, JSON.stringify(credentials), { mode: 0o600 });
  assertSecureFailure(() => loadLocalPnvsEnvironment(env, relative(process.cwd(), actual)));
  const parentLink = join(directory, "linked-parent");
  symlinkSync(actual, parentLink);
  assertSecureFailure(() => loadLocalPnvsEnvironment(env, parentLink));
  const nested = join(actual, "nested");
  mkdirSync(nested, { mode: 0o700 });
  assertSecureFailure(() => loadLocalPnvsEnvironment(env, join(parentLink, "nested")));
  symlinkSync(file, join(directory, "pnvs.json"));
  assertSecureFailure(() => loadLocalPnvsEnvironment(env, directory));
});

test("PNVS loader rejects dangling symlinks instead of treating them as absent configuration", (t) => {
  const { directory, file, env } = fixture(t);
  symlinkSync(join(directory, "missing"), file);
  assertSecureFailure(() => loadLocalPnvsEnvironment(env, directory));
});

test("PNVS loader requires owner-only directory and file permissions", (t) => {
  const { directory, file, env, save } = fixture(t);
  save();
  for (const mode of [0o400, 0o640, 0o644, 0o660, 0o1600]) {
    chmodSync(file, mode);
    assertSecureFailure(() => loadLocalPnvsEnvironment(env, directory));
  }
  chmodSync(file, 0o600);
  for (const mode of [0o500, 0o750, 0o755, 0o770, 0o1700]) {
    chmodSync(directory, mode);
    assertSecureFailure(() => loadLocalPnvsEnvironment(env, directory));
  }
  chmodSync(directory, 0o700);
});

test("PNVS loader rejects other owners, hard links and non-regular files", (t) => {
  const { directory, file, env, save } = fixture(t);
  save();
  t.mock.method(process, "getuid", () => -1);
  assertSecureFailure(() => loadLocalPnvsEnvironment(env, directory));
  t.mock.restoreAll();
  const hardlink = join(directory, "additional-link");
  linkSync(file, hardlink);
  assertSecureFailure(() => loadLocalPnvsEnvironment(env, directory));
  rmSync(file);
  mkdirSync(file, { mode: 0o700 });
  assertSecureFailure(() => loadLocalPnvsEnvironment(env, directory));
  rmSync(file, { recursive: true });
  execFileSync("mkfifo", ["-m", "600", file]);
  assertSecureFailure(() => loadLocalPnvsEnvironment(env, directory));
});

test("PNVS loader refuses malformed, extra-key, oversized or invalid credential data atomically", (t) => {
  const { directory, file, env, save } = fixture(t);
  const invalid = [
    null, [], "text", {}, { accessKeyId: credentials.accessKeyId }, { ...credentials, extra: "value" },
    { ...credentials, PNVS_ENABLED: "true" }, { ...credentials, accessKeySecret: 123 },
    { ...credentials, accessKeyId: "" }, { ...credentials, accessKeySecret: "a".repeat(4097) },
    { ...credentials, accessKeySecret: "SyntheticPnvsSecret\ninjected=value" },
    { ...credentials, accessKeySecret: "Synthetic\0PnvsSecret" },
  ];
  for (const value of invalid) {
    save(value);
    assertSecureFailure(() => loadLocalPnvsEnvironment(env, directory));
    assert.equal(env.PNVS_ACCESS_KEY_ID, undefined);
    assert.equal(env.PNVS_ACCESS_KEY_SECRET, undefined);
  }
  for (const text of ["{\"accessKeySecret\":\"SyntheticPnvsSecret", "x".repeat(65_537)]) {
    writeFileSync(file, text, { mode: 0o600 });
    assertSecureFailure(() => loadLocalPnvsEnvironment(env, directory));
  }
});
