import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadDatabaseConfig } from "./config.js";
import { createDatabasePool, withDedicatedDatabaseClient } from "./postgresRepository.js";

async function queryWithDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
if (process.env.NODE_ENV === "production" && !process.env.MIGRATION_DATABASE_URL?.trim()) {
  throw new Error("MIGRATION_DATABASE_URL is required for production migrations.");
}
if (process.env.NODE_ENV === "production" && process.env.MIGRATION_DATABASE_SSL !== "true") {
  throw new Error("MIGRATION_DATABASE_SSL=true is required for production migrations.");
}
const config = loadDatabaseConfig({
  ...process.env,
  DATABASE_URL: process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL,
  DATABASE_SSL: process.env.MIGRATION_DATABASE_SSL?.trim() || process.env.DATABASE_SSL,
});
const pool = createDatabasePool(config.databaseUrl, config.databaseSsl, "migration");

try {
  await withDedicatedDatabaseClient(pool, async (client, assertHealthy) => {
    await client.query("SELECT pg_advisory_lock($1)", [1_197_873_441]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum char(64),
        applied_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum char(64)");
    assertHealthy();

    const files = (await readdir(migrationDirectory)).filter((file) => /^\d+.*\.sql$/u.test(file)).sort();
    for (const file of files) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = await client.query<{ checksum: string | null }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [file],
      );
      const appliedChecksum = applied.rows[0]?.checksum;
      if (applied.rowCount) {
        if (appliedChecksum && appliedChecksum !== checksum) {
          throw new Error(`Applied migration checksum mismatch: ${file}`);
        }
        if (!appliedChecksum) {
          await client.query("UPDATE schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL", [file, checksum]);
        }
        continue;
      }
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
      assertHealthy();
      await client.query("COMMIT");
      process.stdout.write(`Applied migration ${file}\n`);
    }
    assertHealthy();
    await queryWithDeadline(
      client.query("SELECT pg_advisory_unlock($1)", [1_197_873_441]),
      1_000,
      "Timed out while releasing the migration lock.",
    );
  });
} finally {
  await pool.end();
}
