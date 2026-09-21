import { loadDatabaseConfig } from "./config.js";
import { MATCHING_EXAMPLES, MATCHING_EXAMPLES_VERSION } from "./matchingExamples.js";
import { validateMatchingDraft } from "./matching.js";
import { createDatabasePool, withDedicatedDatabaseClient } from "./postgresRepository.js";

// Seeding is an explicit local development command. Production never receives synthetic accounts.
const config = loadDatabaseConfig(process.env);
const target = new URL(config.databaseUrl);
if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
  throw new Error("Matching examples may only be seeded into an explicitly configured local development database.");
}
const pool = createDatabasePool(config.databaseUrl, config.databaseSsl, "migration");
try {
  await withDedicatedDatabaseClient(pool, async (client) => {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [1_197_873_442]);
    for (const item of MATCHING_EXAMPLES) {
      const draft = validateMatchingDraft(item.kind, item.draft);
      await client.query(
        `INSERT INTO matching_examples (id, kind, domain, draft, seed_version)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, domain = EXCLUDED.domain,
           draft = EXCLUDED.draft, seed_version = EXCLUDED.seed_version,
           updated_at = CASE WHEN matching_examples.draft IS DISTINCT FROM EXCLUDED.draft
             OR matching_examples.seed_version IS DISTINCT FROM EXCLUDED.seed_version THEN now() ELSE matching_examples.updated_at END`,
        [item.id, item.kind, item.domain, JSON.stringify(draft), MATCHING_EXAMPLES_VERSION],
      );
    }
    await client.query("COMMIT");
  });
  process.stdout.write(`Seeded ${MATCHING_EXAMPLES.length} isolated matching examples (${MATCHING_EXAMPLES_VERSION}); no accounts or contacts created.\n`);
} finally {
  await pool.end();
}
