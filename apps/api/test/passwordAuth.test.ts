import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, validPassword, verifyPassword } from "../src/passwordAuth.js";

test("password hashes have independent salts, verify correctly, and never embed plaintext", async () => {
  const password = "a synthetic long password";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("wrong synthetic password", first), false);
  assert.equal(await verifyPassword(password, null), false);
  assert.equal(await verifyPassword(password, "broken"), false);
});

test("password length bounds permit long phrases and Unicode without silent truncation", () => {
  assert.equal(validPassword("short"), false);
  assert.equal(validPassword("a".repeat(129)), false);
  assert.equal(validPassword("一段只用于自动化回归测试的密码短语"), true);
  assert.equal(validPassword("a long pass phrase with spaces"), true);
});
