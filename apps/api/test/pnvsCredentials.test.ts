import assert from "node:assert/strict";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { savePnvsCredentials } from "../src/pnvsCredentials.js";

const credentials = {
  accessKeyId: "SyntheticAccessKey123456",
  accessKeySecret: "SyntheticSecret1234567890",
};
const sanitizedMessage = "Could not save PNVS credentials securely. No existing configuration was overwritten.";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "duduhire-pnvs-credentials-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "pnvs.json") };
}

function assertSecureFailure(action: () => unknown) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, sanitizedMessage);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, /SyntheticSecret|SyntheticAccessKey|duduhire-pnvs-credentials-/u);
    return true;
  });
}

test("PNVS credentials are trimmed and saved as JSON with only the two credential properties", (t) => {
  const { directory, file } = fixture(t);
  const input = {
    accessKeyId: `  ${credentials.accessKeyId}  `,
    accessKeySecret: `\r\n\t${credentials.accessKeySecret}\t\r\n`,
    unrelatedProperty: "must-not-be-saved",
  };
  const saved = savePnvsCredentials(input, directory);

  assert.equal(saved, file);
  assert.equal(realpathSync(saved), saved);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), credentials);
  assert.equal(statSync(directory).mode & 0o7777, 0o700);
  assert.equal(statSync(file).mode & 0o7777, 0o600);
  assert.equal(statSync(file).uid, process.getuid!());
});

for (const length of [1, 4096]) {
  test(`PNVS credentials accept the ${length}-character storage boundary without validating provider format`, (t) => {
    const { directory, file } = fixture(t);
    const value = "Ab9".repeat(Math.ceil(length / 3)).slice(0, length);
    assert.equal(savePnvsCredentials({ accessKeyId: value, accessKeySecret: value }, directory), file);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { accessKeyId: value, accessKeySecret: value });
  });
}

test("credential punctuation and Unicode survive JSON round trips without becoming extra properties", (t) => {
  const { directory } = fixture(t);
  const acceptedValues = [
    "Synthetic+Secret/123=", "Synthetic_Secret-123.456",
    "SyntheticSecret'123", "SyntheticSecret\"123", "SyntheticSecret\\123",
    "SyntheticSecret$123", "SyntheticSecret`123`", "SyntheticSecret$(true)",
    "SyntheticSecret#comment", "SyntheticSecret;true",
    "SyntheticSecret\",\"injected\":\"value", "SyntheticSecret汉字", "ＳyntheticSecret",
  ];

  for (const field of ["accessKeyId", "accessKeySecret"] as const) {
    for (const [index, value] of acceptedValues.entries()) {
      const target = join(directory, `${field}-${index}`);
      const input = { ...credentials, [field]: value };
      const file = savePnvsCredentials(input, target);
      assert.equal(file, join(target, "pnvs.json"));
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), input);
    }
  }
});

test("missing credential directories are created with owner-only permissions", (t) => {
  const { directory } = fixture(t);
  const parent = join(directory, "new-config");
  const target = join(parent, "duduhire");
  const saved = savePnvsCredentials(credentials, target);

  assert.equal(saved, join(target, "pnvs.json"));
  assert.equal(statSync(parent).mode & 0o7777, 0o700);
  assert.equal(statSync(target).mode & 0o7777, 0o700);
  assert.equal(statSync(target).uid, process.getuid!());
  assert.equal(statSync(saved).mode & 0o7777, 0o600);
});

test("credential files retain exact owner-only permissions under a restrictive umask", (t) => {
  const { directory, file } = fixture(t);
  assert.equal(statSync(directory).mode & 0o7777, 0o700);
  const previousUmask = process.umask(0o777);
  try {
    assert.equal(savePnvsCredentials(credentials, directory), file);
    assert.equal(statSync(file).mode & 0o7777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), credentials);
  } finally {
    process.umask(previousUmask);
  }
});

test("empty, oversized, whitespace and control-character credentials are rejected", (t) => {
  const { directory } = fixture(t);
  const controlCharacters = [
    ...Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)),
    ...Array.from({ length: 33 }, (_, index) => String.fromCharCode(index + 127)),
  ];
  const invalidValues = [
    "", " ", "\t\r\n", "A".repeat(4097),
    "Synthetic Secret123456", "Synthetic\tSecret123456",
    "SyntheticSecret123456\nNODE_OPTIONS=--inspect",
    "SyntheticSecret123456\rINJECTED=1", "Synthetic\0Secret123456",
    "Synthetic\u00a0Secret123456", "Synthetic\u2003Secret123456",
    "Synthetic\u2028Secret123456", "Synthetic\u2029Secret123456",
    ...controlCharacters.map(character => `Synthetic${character}Secret123456`),
  ];

  for (const field of ["accessKeyId", "accessKeySecret"] as const) {
    for (const [index, value] of invalidValues.entries()) {
      const target = join(directory, `${field}-${index}`);
      assertSecureFailure(() => savePnvsCredentials({ ...credentials, [field]: value }, target));
      assert.equal(existsSync(join(target, "pnvs.json")), false);
    }
  }
});

test("an existing credential file is never overwritten or given different permissions", (t) => {
  const { directory, file } = fixture(t);
  const original = "EXISTING_CONFIGURATION=synthetic-existing-marker\n";
  writeFileSync(file, original, { mode: 0o640 });
  chmodSync(file, 0o640);
  const originalStat = statSync(file);

  assertSecureFailure(() => savePnvsCredentials(credentials, directory));
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(statSync(file).mode & 0o7777, 0o640);
  assert.equal(statSync(file).ino, originalStat.ino);
});

test("saving credentials twice preserves the first successful save", (t) => {
  const { directory, file } = fixture(t);
  savePnvsCredentials(credentials, directory);
  const original = readFileSync(file, "utf8");

  assertSecureFailure(() => savePnvsCredentials({
    accessKeyId: "DifferentAccessKey123456",
    accessKeySecret: "DifferentSecret123456789",
  }, directory));
  assert.equal(readFileSync(file, "utf8"), original);
});

test("relative credential directory paths are rejected", (t) => {
  const { directory } = fixture(t);
  const target = join(directory, "relative-target");
  assertSecureFailure(() => savePnvsCredentials(credentials, relative(process.cwd(), target)));
  assert.equal(existsSync(target), false);
});

test("a symlink at the credential directory is rejected without writing through it", (t) => {
  const { directory } = fixture(t);
  const target = join(directory, "private");
  const link = join(directory, "linked-directory");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, link);

  assertSecureFailure(() => savePnvsCredentials(credentials, link));
  assert.equal(existsSync(join(target, "pnvs.json")), false);
  assert.equal(readlinkSync(link), target);
});

test("a symlink in any ancestor directory is rejected", (t) => {
  const { directory } = fixture(t);
  const target = join(directory, "private");
  const nested = join(target, "nested");
  const link = join(directory, "linked-ancestor");
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  symlinkSync(target, link);

  assertSecureFailure(() => savePnvsCredentials(credentials, join(link, "nested")));
  assertSecureFailure(() => savePnvsCredentials(credentials, join(link, "not-created", "duduhire")));
  assert.equal(existsSync(join(nested, "pnvs.json")), false);
  assert.equal(existsSync(join(target, "not-created", "duduhire", "pnvs.json")), false);
});

test("an existing credential symlink is preserved and its target stays unchanged", (t) => {
  const { directory, file } = fixture(t);
  const target = join(directory, "existing-file");
  const original = "synthetic-existing-file-content\n";
  writeFileSync(target, original, { mode: 0o600 });
  symlinkSync(target, file);

  assertSecureFailure(() => savePnvsCredentials(credentials, directory));
  assert.equal(readlinkSync(file), target);
  assert.equal(readFileSync(target, "utf8"), original);
});

test("a dangling credential symlink is preserved without creating its target", (t) => {
  const { directory, file } = fixture(t);
  const target = join(directory, "missing-target");
  symlinkSync(target, file);

  assertSecureFailure(() => savePnvsCredentials(credentials, directory));
  assert.equal(readlinkSync(file), target);
  assert.equal(existsSync(target), false);
});

test("a non-regular credential target is rejected without removing it", (t) => {
  const { directory, file } = fixture(t);
  mkdirSync(file, { mode: 0o700 });
  const marker = join(file, "preserve-this-file");
  writeFileSync(marker, "synthetic-preserved-marker", { mode: 0o600 });

  assertSecureFailure(() => savePnvsCredentials(credentials, directory));
  assert.equal(lstatSync(file).isDirectory(), true);
  assert.equal(readFileSync(marker, "utf8"), "synthetic-preserved-marker");
});

test("a non-directory credential directory is rejected with a sanitized error", (t) => {
  const { directory } = fixture(t);
  const target = join(directory, credentials.accessKeySecret);
  writeFileSync(target, "synthetic-preserved-content", { mode: 0o600 });

  assertSecureFailure(() => savePnvsCredentials(credentials, target));
  assert.equal(readFileSync(target, "utf8"), "synthetic-preserved-content");
});

test("credential directories must already have exact owner-only permissions", (t) => {
  const { directory } = fixture(t);
  for (const mode of [0o750, 0o770, 0o755, 0o777, 0o1700]) {
    const target = join(directory, `mode-${mode.toString(8)}`);
    mkdirSync(target, { mode: 0o700 });
    chmodSync(target, mode);
    assertSecureFailure(() => savePnvsCredentials(credentials, target));
    assert.equal(statSync(target).mode & 0o7777, mode);
    assert.equal(existsSync(join(target, "pnvs.json")), false);
  }
});

test("credential directories owned by a different user are rejected", (t) => {
  const { directory, file } = fixture(t);
  t.mock.method(process, "getuid", () => -1);
  assertSecureFailure(() => savePnvsCredentials(credentials, directory));
  assert.equal(existsSync(file), false);
});
