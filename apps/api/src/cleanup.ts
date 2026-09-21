import { loadDatabaseConfig } from "./config.js";
import { createDatabasePool } from "./postgresRepository.js";

if (process.env.NODE_ENV === "production" && !process.env.MAINTENANCE_DATABASE_URL?.trim()) {
  throw new Error("MAINTENANCE_DATABASE_URL is required for production cleanup.");
}
if (process.env.NODE_ENV === "production" && process.env.MAINTENANCE_DATABASE_SSL !== "true") {
  throw new Error("MAINTENANCE_DATABASE_SSL=true is required for production cleanup.");
}
const config = loadDatabaseConfig({
  ...process.env,
  DATABASE_URL: process.env.MAINTENANCE_DATABASE_URL?.trim() || process.env.DATABASE_URL,
  DATABASE_SSL: process.env.MAINTENANCE_DATABASE_SSL?.trim() || process.env.DATABASE_SSL,
});
const pool = createDatabasePool(config.databaseUrl, config.databaseSsl, "maintenance");

try {
  const result = await pool.query<{
    removed_email_challenges: string;
    removed_sessions: string;
    removed_intake_drafts: string;
    removed_archived_discovery_threads: string;
    removed_published_outbox_events: string;
  }>("SELECT * FROM public.run_data_retention_cleanup()");
  const removed = result.rows[0];
  if (!removed) throw new Error("Retention cleanup did not return a result.");
  process.stdout.write(`${JSON.stringify({
    removed: {
      emailChallenges: Number(removed.removed_email_challenges),
      sessions: Number(removed.removed_sessions),
      intakeDrafts: Number(removed.removed_intake_drafts),
      archivedDiscoveryThreads: Number(removed.removed_archived_discovery_threads),
      publishedOutboxEvents: Number(removed.removed_published_outbox_events),
    },
  })}\n`);
} finally {
  await pool.end();
}
