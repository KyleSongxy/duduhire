import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";

const allowedKeys = ["AI_MODE", "QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_MODEL", "QWEN_BASE_URL"] as const;
const secretKeys = new Set<string>(["QWEN_API_KEY", "DASHSCOPE_API_KEY"]);
const localEnvironmentError = "Local Qwen configuration could not be loaded securely. Check the private file location, ownership and permissions.";

/** Local entry points opt in; production and already-injected credentials never read a personal file. */
export function loadLocalEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DUDUHIRE_LOAD_LOCAL_ENV !== "true" || env.NODE_ENV === "production") return false;
  if (env.QWEN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim()) return false;

  try {
    const configuredPath = env.DUDUHIRE_QWEN_ENV_FILE;
    if (configuredPath !== undefined && !isAbsolute(configuredPath)) throw new Error(localEnvironmentError);
    const filePath = resolve(configuredPath ?? resolve(homedir(), ".config/duduhire/qwen.env"));
    // Comparing the complete resolved path also rejects symlinks in parent directories.
    if (realpathSync(filePath) !== filePath) throw new Error(localEnvironmentError);
    const uid = process.getuid?.();
    const directory = statSync(dirname(filePath));
    if (uid === undefined || !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o7777) !== 0o700) {
      throw new Error(localEnvironmentError);
    }
    if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error(localEnvironmentError);
    // NONBLOCK keeps a substituted FIFO from hanging before fstat rejects non-regular files.
    const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let values: ReturnType<typeof parseEnv>;
    try {
      const file = fstatSync(descriptor);
      if (!file.isFile() || file.uid !== uid || (file.mode & 0o7777) !== 0o600 || file.size > 65_536) {
        throw new Error(localEnvironmentError);
      }
      values = parseEnv(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
    for (const key of allowedKeys) {
      const hasValue = secretKeys.has(key) ? Boolean(env[key]?.trim()) : env[key] !== undefined;
      if (!hasValue && values[key] !== undefined) env[key] = values[key];
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Do not attach the original error: parser/system errors can include private contents or paths.
    throw new Error(localEnvironmentError);
  }
}
