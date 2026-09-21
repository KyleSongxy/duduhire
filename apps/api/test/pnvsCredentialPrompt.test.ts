import assert from "node:assert/strict";
import test from "node:test";
import { getPnvsCredentialInputIssue } from "../src/pnvsCredentials.js";
import { readValidatedPnvsCredential } from "../src/pnvsCredentialPrompt.js";

test("credential input diagnostics contain categories only", () => {
  assert.equal(getPnvsCredentialInputIssue(" \r\n"), "empty");
  assert.equal(getPnvsCredentialInputIssue("a".repeat(4097)), "too_long");
  assert.equal(getPnvsCredentialInputIssue("synthetic marker"), "whitespace_or_control");
  assert.equal(getPnvsCredentialInputIssue("synthetic\0marker"), "whitespace_or_control");
  assert.equal(getPnvsCredentialInputIssue("  synthetic+marker/=\r\n"), undefined);
});

for (const field of ["AccessKey ID", "AccessKey Secret"] as const) {
  test(`${field} retries empty, oversized, and multiline input without exposing values`, async () => {
    const answers = ["", " ", "a".repeat(4097), "synthetic\nprivate-marker", "  synthetic+accepted/=  "];
    const prompts: string[] = [];
    const messages: string[] = [];
    const value = await readValidatedPnvsCredential(field, async prompt => {
      prompts.push(prompt);
      assert.ok(answers.length > 0, "must not prompt after valid input");
      return answers.shift()!;
    }, message => { messages.push(message); });
    assert.equal(value, "synthetic+accepted/=");
    assert.equal(prompts.length, 5);
    assert.ok(prompts.every(prompt => prompt === `${field}（隐藏输入）：`));
    assert.equal(messages.length, 4);
    assert.match(messages[0], /没有收到内容/u);
    assert.match(messages[2], /内容过长/u);
    assert.match(messages[3], /空白或控制字符/u);
    assert.doesNotMatch(messages.join(""), /synthetic|private-marker|accepted|aaaa/u);
  });
}

test("retrying an empty Secret does not request the accepted ID again", async () => {
  const answers = ["synthetic-id", "", "synthetic-secret"];
  const prompts: string[] = [];
  const read = async (prompt: string) => {
    prompts.push(prompt);
    assert.ok(answers.length > 0);
    return answers.shift()!;
  };
  const report = () => {};
  assert.equal(await readValidatedPnvsCredential("AccessKey ID", read, report), "synthetic-id");
  assert.equal(await readValidatedPnvsCredential("AccessKey Secret", read, report), "synthetic-secret");
  assert.deepEqual(prompts, ["AccessKey ID（隐藏输入）：", "AccessKey Secret（隐藏输入）：", "AccessKey Secret（隐藏输入）："]);
});

test("cancellation stops the prompt without logging the error or restarting input", async () => {
  let attempts = 0;
  const messages: string[] = [];
  const cancellation = new Error("synthetic-private-error");
  await assert.rejects(readValidatedPnvsCredential("AccessKey Secret", async () => {
    attempts += 1;
    throw cancellation;
  }, message => { messages.push(message); }), error => error === cancellation);
  assert.equal(attempts, 1);
  assert.deepEqual(messages, []);
});
