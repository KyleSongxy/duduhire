import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import { createEmailSender, createSmtpTransportOptions } from "../src/email.js";
import type { AppConfig } from "../src/config.js";
import { createOpaqueToken } from "../src/security.js";

type DeliveryBehavior = "accept" | "reject-recipient" | "reject-message" | "disconnect-after-message" | "hold-acceptance";

// This server binds only loopback and never forwards messages. Exercising the
// real Nodemailer transport catches defects that injected EmailSender doubles
// cannot cover, without requiring an external service or real credentials.
async function startSmtpServer(behavior: DeliveryBehavior) {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const envelopes: Array<{ from: string; to: string }> = [];
  const messages: string[] = [];
  const login = { user: "local-smtp-test", pass: "synthetic:p@ss" };
  let acceptMessage: (() => void) | undefined;
  let markReceived!: (message: string) => void;
  const received = new Promise<string>((resolve) => { markReceived = resolve; });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 localhost SMTP test receiver\r\n");
    let buffer = "";
    let inData = false;
    let body: string[] = [];
    let from = "";
    let to = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line !== ".") {
            body.push(line.startsWith("..") ? line.slice(1) : line);
            continue;
          }
          inData = false;
          const message = body.join("\r\n");
          messages.push(message);
          envelopes.push({ from, to });
          markReceived(message);
          if (behavior === "hold-acceptance") acceptMessage = () => socket.write("250 2.0.0 Message accepted\r\n");
          else if (behavior === "reject-message") socket.write("550 5.7.1 Message rejected\r\n");
          else if (behavior === "disconnect-after-message") socket.destroy();
          else socket.write("250 2.0.0 Message accepted\r\n");
          continue;
        }
        const command = line.split(" ", 1)[0]!.toUpperCase();
        commands.push(command);
        if (command === "EHLO" || command === "HELO") {
          socket.write("250-localhost\r\n250-AUTH PLAIN\r\n250 SIZE 1048576\r\n");
        } else if (command === "AUTH") {
          const auth = line.split(" ");
          const expected = Buffer.from(`\0${login.user}\0${login.pass}`).toString("base64");
          const authenticated = auth[1]?.toUpperCase() === "PLAIN" && auth[2] === expected;
          socket.write(authenticated ? "235 2.7.0 Authenticated\r\n" : "535 5.7.8 Authentication failed\r\n");
        } else if (command === "MAIL") {
          from = line.slice("MAIL FROM:".length);
          socket.write("250 2.1.0 Sender accepted\r\n");
        } else if (command === "RCPT") {
          to = line.slice("RCPT TO:".length);
          socket.write(behavior === "reject-recipient" ? "550 5.1.1 Recipient rejected\r\n" : "250 2.1.5 Recipient accepted\r\n");
        } else if (command === "DATA") {
          inData = true;
          body = [];
          socket.write("354 End message with a single dot\r\n");
        } else if (command === "RSET" || command === "NOOP") {
          socket.write("250 2.0.0 OK\r\n");
        } else if (command === "QUIT") {
          socket.end("221 2.0.0 Bye\r\n");
        } else {
          socket.write("502 5.5.1 Command unavailable\r\n");
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `smtp://127.0.0.1:${address.port}`,
    authenticatedUrl: `smtp://${encodeURIComponent(login.user)}:${encodeURIComponent(login.pass)}@127.0.0.1:${address.port}`,
    received, messages, envelopes, commands,
    accept: () => { assert.ok(acceptMessage); acceptMessage(); },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function smtpConfig(smtpUrl: string): AppConfig {
  return {
    environment: "test", host: "127.0.0.1", port: 8787,
    databaseUrl: "postgresql://unused", databaseSsl: false, webOrigin: "https://app.example.test",
    authTokenSecret: "synthetic-test-secret-at-least-thirty-two-characters",
    authCookieName: "test_session", authCookieSecure: false,
    sessionTtlDays: 30, magicLinkTtlMinutes: 15, emailResendSeconds: 60, emailHourlyLimit: 5,
    emailDeliveryMode: "smtp", smtpUrl, emailFrom: "DuduHire <no-reply@example.test>",
    aiMode: "local", openAiBaseUrl: "https://api.openai.com/v1", logLevel: "silent", trustProxy: false,
  };
}

function magicLinkMessage() {
  return {
    deliveryId: randomUUID(), to: "smtp-recipient@example.test",
    link: `https://app.example.test/auth/verify#token=${createOpaqueToken()}`, expiresInMinutes: 15,
  };
}

function mimeParts(message: string) {
  const boundary = /boundary="([^"]+)"/u.exec(message)?.[1];
  assert.ok(boundary, "The message must contain both plain-text and HTML alternatives.");
  return message.split(`--${boundary}`).flatMap((part) => {
    const separator = part.indexOf("\r\n\r\n");
    if (separator < 0) return [];
    const header = part.slice(0, separator);
    const type = /Content-Type: (text\/(?:plain|html))/iu.exec(header)?.[1]?.toLowerCase();
    if (!type) return [];
    const encoding = /Content-Transfer-Encoding: ([^\r\n]+)/iu.exec(header)?.[1]?.toLowerCase();
    const raw = part.slice(separator + 4).trim();
    const value = encoding === "base64" ? Buffer.from(raw.replace(/\s/gu, ""), "base64").toString("utf8")
      : encoding === "quoted-printable" ? Buffer.from(raw.replace(/=\r\n/gu, "").replace(/=([\dA-F]{2})/giu, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1").toString("utf8")
      : raw;
    return [{ type, value }];
  });
}

test("disabled email sender rejects delivery without opening SMTP or logging a link", async () => {
  const sender = createEmailSender({ ...smtpConfig("unused-invalid-url"), emailDeliveryMode: "disabled" }, {
    info() { assert.fail("disabled delivery must not log a development link"); },
  });
  await assert.rejects(sender.sendMagicLink(magicLinkMessage()), /Email authentication is disabled/u);
  await sender.close();
});

test("real SMTP sender waits for final acceptance and transmits the supplied private one-time link in both alternatives", { timeout: 5_000 }, async (context) => {
  const smtp = await startSmtpServer("hold-acceptance");
  const log: unknown[] = [];
  const sender = createEmailSender(smtpConfig(smtp.url), { info: (...args) => { log.push(args); } });
  context.after(async () => { await sender.close(); await smtp.close(); });
  const message = magicLinkMessage();
  let settled = false;
  const delivery = sender.sendMagicLink(message).finally(() => { settled = true; });
  const raw = await smtp.received;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "RCPT acceptance and receipt of DATA must not be reported as final acceptance.");
  assert.ok(!smtp.commands.includes("AUTH"), "Plaintext test delivery must remain unauthenticated.");
  assert.deepEqual(smtp.envelopes, [{ from: "<no-reply@example.test>", to: "<smtp-recipient@example.test>" }]);
  assert.match(raw, /From: DuduHire <no-reply@example\.test>/u);
  const alternatives = mimeParts(raw);
  assert.deepEqual(alternatives.map((part) => part.type).sort(), ["text/html", "text/plain"]);
  for (const part of alternatives) {
    assert.ok(part.value.includes(message.link), "Each alternative must retain the exact generated verification token.");
    assert.match(part.value, /15 分钟/u);
    assert.match(part.value, /只能使用一次/u);
    assert.match(part.value, /同一浏览器/u);
  }
  const link = new URL(message.link);
  assert.equal(link.search, "", "The token belongs in the fragment, not in a server request or access log.");
  assert.match(link.hash, /^#token=[A-Za-z0-9_-]{40,128}$/u);
  assert.deepEqual(log, [], "SMTP mode must not print the recipient or authentication link through the console sender.");
  smtp.accept();
  await delivery;
  assert.equal(settled, true);
  assert.equal(smtp.messages.length, 1);
});

for (const behavior of ["reject-recipient", "reject-message", "disconnect-after-message"] as const) {
  test(`real SMTP sender rejects ${behavior} without reporting delivery success or automatically resending`, { timeout: 5_000 }, async (context) => {
    const smtp = await startSmtpServer(behavior);
    const sender = createEmailSender(smtpConfig(smtp.url), { info: () => assert.fail("SMTP must not fall back to console delivery.") });
    context.after(async () => { await sender.close(); await smtp.close(); });
    await assert.rejects(sender.sendMagicLink(magicLinkMessage()));
    assert.equal(smtp.commands.filter((command) => command === "MAIL").length, 1);
    assert.equal(smtp.messages.length, behavior === "reject-recipient" ? 0 : 1);
    if (behavior === "reject-recipient") assert.ok(!smtp.commands.includes("DATA"));
  });
}

for (const environment of ["development", "test", "production"] as const) {
  test(`${environment} SMTP refuses TLS downgrade before transmitting credentials or the message`, { timeout: 5_000 }, async (context) => {
    const smtp = await startSmtpServer("accept");
    const smtpUrl = environment === "production" ? smtp.url : smtp.authenticatedUrl;
    const sender = createEmailSender({ ...smtpConfig(smtpUrl), environment }, { info: () => undefined });
    context.after(async () => { await sender.close(); await smtp.close(); });
    await assert.rejects(sender.sendMagicLink(magicLinkMessage()));
    assert.ok(smtp.commands.includes("STARTTLS"));
    assert.ok(!smtp.commands.includes("AUTH"));
    assert.ok(!smtp.commands.includes("MAIL"));
    assert.equal(smtp.messages.length, 0);
  });
}

test("encoded SMTP credentials require TLS in development while unauthenticated loopback delivery remains available", () => {
  const secured = createSmtpTransportOptions("smtp://local-smtp-test:synthetic%3Ap%40ss@127.0.0.1:1025", false);
  assert.deepEqual(secured.auth, { user: "local-smtp-test", pass: "synthetic:p@ss" });
  assert.equal(secured.requireTLS, true);
  assert.equal(createSmtpTransportOptions("smtps://user:synthetic@smtp.example.test:465", false).secure, true);
  const local = createSmtpTransportOptions("smtp://127.0.0.1:1025", false);
  assert.equal(local.requireTLS, false);
  assert.ok(!("auth" in local));
});
