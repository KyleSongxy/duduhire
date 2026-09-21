import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { getPnvsCredentialInputIssue } from "./pnvsCredentials.js";

/** Retry only the invalid field; report categories, never values or raw errors. */
export async function readValidatedPnvsCredential(
  field: "AccessKey ID" | "AccessKey Secret",
  read = readHiddenCredential,
  report: (message: string) => void = message => { process.stdout.write(message); },
): Promise<string> {
  for (;;) {
    const value = await read(`${field}（隐藏输入）：`);
    const issue = getPnvsCredentialInputIssue(value);
    if (issue === undefined) return value.trim();
    const explanation = issue === "empty"
      ? "没有收到内容。请粘贴对应字段，再按一次 Enter。"
      : issue === "too_long"
        ? "内容过长。请只复制对应字段的值，不要复制整段页面。"
        : "内容中包含空白或控制字符。请重新复制对应字段的值，不要包含标签或多行内容。";
    report(`${field} ${explanation}（隐藏输入时不会显示字符）\n`);
  }
}

/** Echo and readline history are disabled for both fields, including AccessKey ID. */
export function readHiddenCredential(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error("An interactive terminal is required."));
  }
  const silentOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: process.stdin, output: silentOutput, terminal: true, historySize: 0 });
  return new Promise((resolve, reject) => {
    let answered = false;
    reader.once("SIGINT", () => reader.close());
    reader.once("close", () => {
      silentOutput.end();
      process.stdout.write("\n");
      if (!answered) reject(new Error("Credential entry cancelled."));
    });
    reader.question("", answer => {
      answered = true;
      resolve(answer);
      reader.close();
    });
    // Show the prompt only once raw mode and input handlers are ready: pasted values must not echo.
    process.stdout.write(label);
  });
}
