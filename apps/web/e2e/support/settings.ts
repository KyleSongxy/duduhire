import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const webPort = Number(process.env.E2E_WEB_PORT || "5179");
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) {
  throw new Error("E2E_WEB_PORT must be an integer between 1024 and 65535.");
}
export const webOrigin = `http://127.0.0.1:${webPort}`;

export type TestEnvironment = {
  webOrigin: string;
  databaseUrl: string;
  adminEmail: string;
  adminUserId: string;
};

export function validateTestDatabaseUrl(value: string) {
  const url = new URL(value);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!(["postgres:", "postgresql:"].includes(url.protocol))
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/^[a-zA-Z0-9_]+_test$/u.test(name)
    || url.search || url.hash) {
    throw new Error("E2E_DATABASE_URL must target a loopback PostgreSQL database whose name ends in _test, without query parameters.");
  }
  return value;
}

export function testStateDirectory() {
  const directory = process.env.DUDUHIRE_E2E_STATE_DIR;
  if (!directory) throw new Error("The isolated E2E stack has not been started by Playwright globalSetup.");
  return directory;
}

export async function readTestEnvironment(): Promise<TestEnvironment> {
  const environment = JSON.parse(await readFile(join(testStateDirectory(), "ready.json"), "utf8")) as TestEnvironment;
  validateTestDatabaseUrl(environment.databaseUrl);
  if (environment.webOrigin !== webOrigin) throw new Error("E2E origin does not match the isolated stack.");
  return environment;
}
