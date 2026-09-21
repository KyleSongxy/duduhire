import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { loadNotificationConfig } from "../src/config.js";
import { buildInquiryNotificationMessage, processInquiryNotification, type InquiryNotificationQueue, type InquiryNotificationSender } from "../src/inquiryNotifications.js";

test("notification delivery is disabled unless a single explicit recipient is configured", () => {
  assert.equal(loadNotificationConfig({}), null);
  assert.throws(() => loadNotificationConfig({ INQUIRY_NOTIFICATION_EMAIL: "one@example.com,two@example.com" }), /single email address/u);
  assert.throws(() => loadNotificationConfig({ INQUIRY_NOTIFICATION_EMAIL: "one@example.com", DATABASE_URL: "postgresql://runtime/app" }), /NOTIFICATION_DATABASE_URL/u);
  const config = loadNotificationConfig({
    NODE_ENV: "test", INQUIRY_NOTIFICATION_EMAIL: "operations@example.com",
    NOTIFICATION_DATABASE_URL: "postgresql://notifications/app_test", SMTP_URL: "smtp://localhost:1025", WEB_ORIGIN: "http://localhost:5173",
  });
  assert.ok(config);
  assert.equal(config.pollMs, 5_000);
  assert.equal(config.recipient, "operations@example.com");
});

test("notification message contains only safe operational context and a stable message ID", () => {
  const notification = { eventId: randomUUID(), inquiryId: randomUUID(), source: "pricing_page", attemptCount: 1 };
  const message = buildInquiryNotificationMessage(notification, "https://app.example.com");
  assert.match(message.text, /定价页面/u);
  assert.match(message.text, /https:\/\/app.example.com\/admin\/inquiries/u);
  assert.ok(message.text.includes(notification.inquiryId));
  assert.equal(message.messageId, `<${notification.eventId}@notifications.duduhire>`);
  const unsafeSource = buildInquiryNotificationMessage({ ...notification, source: "private@example.com\nBcc: attacker@example.com" }, "https://app.example.com");
  assert.doesNotMatch(JSON.stringify(unsafeSource), /private@example|attacker@example/u);
});

test("worker finalizes only after send success and never persists SMTP error details", async () => {
  const notification = { eventId: randomUUID(), inquiryId: randomUUID(), source: "home_pricing", attemptCount: 1 };
  const calls: string[] = [];
  let token = "";
  const queue: InquiryNotificationQueue = {
    async claim(leaseToken) { token = leaseToken; calls.push("claimed"); return notification; },
    async finish(eventId, leaseToken, delivered) {
      assert.equal(eventId, notification.eventId);
      assert.equal(leaseToken, token);
      calls.push(delivered ? "sent" : "failed"); return true;
    },
  };
  const sender: InquiryNotificationSender = { async send() { calls.push("delivering"); }, async close() {} };
  assert.deepEqual(await processInquiryNotification(queue, sender), { status: "sent", eventId: notification.eventId });
  assert.deepEqual(calls, ["claimed", "delivering", "sent"]);
  calls.length = 0;
  sender.send = async () => { throw new Error("SMTP rejected private@example.com and secret credential"); };
  assert.deepEqual(await processInquiryNotification(queue, sender), { status: "retry_scheduled", eventId: notification.eventId });
  assert.deepEqual(calls, ["claimed", "failed"]);
});

test("empty queues never send and finalization errors do not turn a successful send into a second failure update", async () => {
  let sent = 0;
  let finishes = 0;
  const sender: InquiryNotificationSender = { async send() { sent += 1; }, async close() {} };
  const queue: InquiryNotificationQueue = { async claim() { return null; }, async finish() { throw new Error("must not finish"); } };
  assert.deepEqual(await processInquiryNotification(queue, sender), { status: "idle" });
  assert.equal(sent, 0);
  queue.claim = async () => ({ eventId: randomUUID(), inquiryId: randomUUID(), source: "home_pricing", attemptCount: 1 });
  queue.finish = async () => { finishes += 1; throw new Error("database unavailable"); };
  await assert.rejects(processInquiryNotification(queue, sender), /database unavailable/u);
  assert.equal(sent, 1);
  assert.equal(finishes, 1);
});
