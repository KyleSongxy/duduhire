import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export default async function globalSetup() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "duduhire-e2e-"));
  process.env.DUDUHIRE_E2E_STATE_DIR = stateDirectory;
  const logPath = join(stateDirectory, "stack.log");
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  const child = spawn(process.execPath, [
    "--import", "tsx",
    fileURLToPath(new URL("./start-stack.ts", import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
    env: { ...process.env, NODE_ENV: "test", DUDUHIRE_E2E_STATE_DIR: stateDirectory },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  let childClosed = false;
  child.once("close", () => { childClosed = true; });

  const cleanup = async () => {
    if (!childClosed) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
        const deadline = setTimeout(resolve, 25_000);
        child.once("close", () => { clearTimeout(timeout); clearTimeout(deadline); resolve(); });
        child.kill("SIGTERM");
      });
    }
    const managed = await readFile(join(stateDirectory, "managed-postgres.json"), "utf8")
      .then((value) => JSON.parse(value) as { binaryDirectory: string; dataDirectory: string })
      .catch(() => undefined);
    let databaseStopped = !managed;
    if (managed?.dataDirectory === join(stateDirectory, "postgres-data")) {
      const execute = promisify(execFile);
      const isStopped = async () => execute(join(managed.binaryDirectory, "pg_ctl"), ["-D", managed.dataDirectory, "status"], { timeout: 5_000 })
        .then(() => false)
        .catch((error: { code?: number | string }) => error.code === 3);
      databaseStopped = await isStopped();
      if (!databaseStopped) {
        // Stop only this invocation's cluster, then verify termination before removing its files.
        await execute(join(managed.binaryDirectory, "pg_ctl"), ["-D", managed.dataDirectory, "-m", "fast", "-w", "stop"], { timeout: 15_000 }).catch(() => undefined);
        databaseStopped = await isStopped();
      }
    }
    await new Promise<void>((resolve) => log.end(resolve));
    if (!childClosed || !databaseStopped) {
      throw new Error(`E2E service shutdown could not be confirmed. Temporary files were preserved at ${stateDirectory}.`);
    }
    // Only this invocation's mkdtemp directory is removed; supplied test databases are retained.
    await rm(stateDirectory, { recursive: true, force: true });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Isolated E2E stack did not become ready within 90 seconds.")), 90_000);
      child.once("error", (error) => { clearTimeout(deadline); reject(error); });
      child.once("exit", (code) => { clearTimeout(deadline); reject(new Error(`Isolated E2E stack exited before startup (code ${code}).`)); });
      child.on("message", (message) => {
        if (message && typeof message === "object" && "ready" in message && message.ready === true) {
          clearTimeout(deadline);
          resolve();
        }
      });
    });
  } catch (error) {
    const output = await readFile(logPath, "utf8").catch(() => "");
    await cleanup();
    throw new Error(`${error instanceof Error ? error.message : "E2E startup failed."}\n${output}`);
  }
  return cleanup;
}
