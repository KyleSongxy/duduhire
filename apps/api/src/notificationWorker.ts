import { setTimeout as delay } from "node:timers/promises";
import { loadNotificationConfig } from "./config.js";
import { createDatabasePool } from "./postgresRepository.js";
import { createInquiryNotificationSender, PostgresInquiryNotificationQueue, processInquiryNotification } from "./inquiryNotifications.js";

async function main() {
  const config = loadNotificationConfig();
  if (!config) {
    console.info(JSON.stringify({ status: "disabled", reason: "INQUIRY_NOTIFICATION_EMAIL_NOT_CONFIGURED" }));
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const pool = createDatabasePool(config.databaseUrl, config.databaseSsl);
  const queue = new PostgresInquiryNotificationQueue(pool);
  const sender = createInquiryNotificationSender(config);
  console.info(JSON.stringify({ status: "started", worker: "inquiry_notifications" }));
  try {
    while (!controller.signal.aborted) {
      let idle = true;
      try {
        const result = await processInquiryNotification(queue, sender);
        idle = result.status === "idle";
        if (!idle) console.info(JSON.stringify(result));
      } catch {
        console.error(JSON.stringify({ status: "error", code: "NOTIFICATION_PROCESSING_FAILED" }));
      }
      if (idle && !controller.signal.aborted) {
        await delay(config.pollMs, undefined, { signal: controller.signal }).catch(() => undefined);
      }
    }
  } finally {
    await sender.close();
    await pool.end();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch(() => {
  console.error(JSON.stringify({ status: "error", code: "NOTIFICATION_WORKER_START_FAILED" }));
  process.exitCode = 1;
});
