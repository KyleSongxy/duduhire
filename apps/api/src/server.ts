import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadLocalEnvironment } from "./localEnvironment.js";
import { loadLocalPnvsEnvironment } from "./localPnvsEnvironment.js";
import { createDatabasePool, PostgresRepository } from "./postgresRepository.js";

loadLocalEnvironment();
loadLocalPnvsEnvironment();
const config = loadConfig();
const pool = createDatabasePool(config.databaseUrl, config.databaseSsl);
const repository = new PostgresRepository(pool);
const app = await buildApp({ config, repository });
pool.on("error", (error) => {
  app.log.error(
    { errorName: error.name, errorCode: (error as NodeJS.ErrnoException).code },
    "idle database connection failed",
  );
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const hardStop = setTimeout(() => {
    app.log.error({ signal }, "graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  hardStop.unref();
  try {
    await app.close();
    clearTimeout(hardStop);
    process.exit(0);
  } catch (error) {
    clearTimeout(hardStop);
    app.log.error(error, "graceful shutdown failed");
    process.exit(1);
  }
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
