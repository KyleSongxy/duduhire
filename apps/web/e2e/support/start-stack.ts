import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { buildApp } from "../../../api/src/app.js";
import { loadConfig } from "../../../api/src/config.js";
import type { EmailSender } from "../../../api/src/email.js";
import { createDatabasePool, PostgresRepository } from "../../../api/src/postgresRepository.js";
import { testStateDirectory, validateTestDatabaseUrl, webOrigin, webPort, type TestEnvironment } from "./settings.js";

const execute = promisify(execFile);
const stateDirectory = testStateDirectory();
const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const apiRoot = fileURLToPath(new URL("../../../api/", import.meta.url));
const mailboxDirectory = join(stateDirectory, "mailbox");
let managedPostgres: { binaryDirectory: string; dataDirectory: string } | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let vite: ViteDevServer | undefined;
let shuttingDown = false;

async function freePort() {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate an E2E port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function postgresBinaries() {
  const fromPath = await execute("which", ["initdb"]).then(({ stdout }) => dirname(stdout.trim())).catch(() => "");
  const candidates = [
    process.env.E2E_PG_BIN,
    fromPath,
    ...["18", "17", "16", "15", "14"].flatMap((version) => [
      `/opt/homebrew/opt/postgresql@${version}/bin`,
      `/usr/local/opt/postgresql@${version}/bin`,
      `/usr/lib/postgresql/${version}/bin`,
    ]),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (await access(join(candidate, "initdb")).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error("PostgreSQL initdb was not found. Set E2E_PG_BIN, or supply E2E_DATABASE_URL for a dedicated loopback *_test database.");
}

async function prepareDatabase() {
  if (process.env.E2E_DATABASE_URL) return validateTestDatabaseUrl(process.env.E2E_DATABASE_URL);
  const binaryDirectory = await postgresBinaries();
  const dataDirectory = join(stateDirectory, "postgres-data");
  const socketDirectory = join(stateDirectory, "postgres-socket");
  await mkdir(socketDirectory, { mode: 0o700 });
  await execute(join(binaryDirectory, "initdb"), ["-D", dataDirectory, "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"], { timeout: 30_000 });
  const port = await freePort();
  managedPostgres = { binaryDirectory, dataDirectory };
  await writeFile(join(stateDirectory, "managed-postgres.json"), JSON.stringify(managedPostgres), { mode: 0o600 });
  await execute(join(binaryDirectory, "pg_ctl"), [
    "-D", dataDirectory, "-l", join(stateDirectory, "postgres.log"),
    "-o", `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, "-w", "start",
  ], { timeout: 30_000 });
  await execute(join(binaryDirectory, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "duduhire_e2e_test"]);
  return validateTestDatabaseUrl(`postgresql://postgres@127.0.0.1:${port}/duduhire_e2e_test`);
}

class CapturingTestEmailSender implements EmailSender {
  async sendMagicLink(message: Parameters<EmailSender["sendMagicLink"]>[0]) {
    if (!/^e2e-[a-z0-9-]+@example\.test$/u.test(message.to)) throw new Error("E2E mail capture accepts synthetic @example.test identities only.");
    const filename = createHash("sha256").update(message.to).digest("hex");
    const temporaryPath = join(mailboxDirectory, `${filename}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(message), { mode: 0o600 });
    await rename(temporaryPath, join(mailboxDirectory, `${filename}.json`));
  }
  async close() {}
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  let failed = false;
  try { await vite?.close(); } catch { failed = true; }
  try { await app?.close(); } catch { failed = true; }
  if (managedPostgres) {
    try {
      await execute(join(managedPostgres.binaryDirectory, "pg_ctl"), ["-D", managedPostgres.dataDirectory, "-m", "fast", "-w", "stop"], { timeout: 15_000 });
    } catch { failed = true; }
  }
  process.exit(failed ? 1 : 0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

try {
  await mkdir(mailboxDirectory, { mode: 0o700 });
  const databaseUrl = await prepareDatabase();
  const apiPort = await freePort();
  const adminUserId = randomUUID();
  const adminEmail = `e2e-admin-${randomUUID()}@example.test`;
  const configEnvironment = {
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: "false",
    WEB_ORIGIN: webOrigin,
    HOST: "127.0.0.1",
    PORT: String(apiPort),
    // Only this isolated stack trusts its loopback Vite proxy to supply the
    // fixture's virtual client IP; production rate limits remain unchanged.
    TRUST_PROXY_CIDRS: "127.0.0.1/32",
    AUTH_TOKEN_SECRET: randomBytes(48).toString("hex"),
    AUTH_COOKIE_NAME: "duduhire_e2e_session",
    AUTH_COOKIE_SECURE: "false",
    // The injected capture sender simulates delivery without contacting a mail server.
    EMAIL_DELIVERY_MODE: "smtp",
    SMTP_URL: "smtp://127.0.0.1:1",
    EMAIL_FROM: "DuduHire E2E <no-reply@example.test>",
    EMAIL_RESEND_SECONDS: "30",
    EMAIL_HOURLY_LIMIT: "20",
    AI_MODE: "local",
    CONTACT_DATA_KEY: randomBytes(32).toString("hex"),
    CONTACT_DATA_KEY_ID: `contact-e2e-${randomUUID()}`,
    ADMIN_USER_IDS: adminUserId,
    LOG_LEVEL: "silent",
  };
  await execute(process.execPath, ["--import", "tsx", join(apiRoot, "src/migrate.ts")], {
    cwd: apiRoot,
    env: { ...process.env, ...configEnvironment, MIGRATION_DATABASE_URL: databaseUrl, MIGRATION_DATABASE_SSL: "false" },
    timeout: 30_000,
  });
  const pool = createDatabasePool(databaseUrl, false);
  await pool.query("INSERT INTO users (id, email, role, email_verified_at) VALUES ($1, $2, 'client', NOW())", [adminUserId, adminEmail]);
  await pool.query("INSERT INTO profiles (user_id) VALUES ($1)", [adminUserId]);
  const config = loadConfig(configEnvironment);
  app = await buildApp({ config, repository: new PostgresRepository(pool), emailSender: new CapturingTestEmailSender() });
  await app.listen({ host: "127.0.0.1", port: apiPort });
  vite = await createViteServer({
    root: webRoot,
    configFile: join(webRoot, "vite.config.ts"),
    mode: "test",
    logLevel: "warn",
    server: {
      host: "127.0.0.1", port: webPort, strictPort: true,
      proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
    },
    define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("/api/v1") },
  });
  await vite.listen();
  const readiness = await fetch(`${webOrigin}/api/health/ready`);
  if (!readiness.ok) throw new Error(`Isolated API readiness failed (${readiness.status}).`);
  const environment: TestEnvironment = { databaseUrl, webOrigin, adminUserId, adminEmail };
  await writeFile(join(stateDirectory, "ready.json"), JSON.stringify(environment), { mode: 0o600 });
  process.stdout.write(`Isolated E2E stack ready at ${webOrigin}\n`);
  process.send?.({ ready: true });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await shutdown();
}
