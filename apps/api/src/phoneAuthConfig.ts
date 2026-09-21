export type PhoneAuthConfig = {
  enabled: boolean;
  allowAllNumbers: boolean;
  allowedNumbers: string[];
  accessKeyId?: string;
  accessKeySecret?: string;
  codeTtlSeconds: number;
  resendSeconds: number;
  phoneHourlyLimit: number;
  ipHourlyLimit: number;
  dailyLimit: number;
  maxAttempts: number;
  /** Fixed absolute deadline for a bounded live test. Verification remains available afterward. */
  sendUntil?: number;
};

/** Only mainland mobile numbers; no guesses or stripping arbitrary characters. */
export function normalizeMainlandPhone(value: string): string | null {
  const phone = value.trim();
  if (/^1[3-9]\d{9}$/u.test(phone)) return `+86${phone}`;
  if (/^\+861[3-9]\d{9}$/u.test(phone)) return phone;
  return null;
}

export function loadPhoneAuthConfig(env: NodeJS.ProcessEnv = process.env): PhoneAuthConfig {
  const invalid = () => new Error("Phone authentication configuration is invalid. Check enablement, approved numbers, credentials and limits; values are not shown.");
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw invalid();
    return value;
  };
  if (env.PHONE_AUTH_ENABLED !== undefined && !["true", "false"].includes(env.PHONE_AUTH_ENABLED)) throw invalid();
  const enabled = env.PHONE_AUTH_ENABLED === "true";
  if (env.PHONE_AUTH_ALLOW_ALL_NUMBERS !== undefined && !["true", "false"].includes(env.PHONE_AUTH_ALLOW_ALL_NUMBERS)) throw invalid();
  const allowAllNumbers = env.PHONE_AUTH_ALLOW_ALL_NUMBERS === "true";
  const rawNumbers = env.PHONE_AUTH_ALLOWED_NUMBERS?.trim();
  const numbers = rawNumbers ? rawNumbers.split(",").map(normalizeMainlandPhone) : [];
  if (numbers.length > 20 || numbers.some(number => number === null)) throw invalid();
  const accessKeyId = env.PNVS_ACCESS_KEY_ID?.trim() || undefined;
  const accessKeySecret = env.PNVS_ACCESS_KEY_SECRET?.trim() || undefined;
  if ([accessKeyId, accessKeySecret].some(value => value && (value.length > 4096 || /[\s\p{Cc}]/u.test(value)))) throw invalid();
  if (enabled && (!accessKeyId || !accessKeySecret || (!allowAllNumbers && numbers.length === 0))) throw invalid();
  const sendUntil = env.PHONE_AUTH_SEND_UNTIL === undefined ? undefined : Date.parse(env.PHONE_AUTH_SEND_UNTIL);
  if (sendUntil !== undefined && (!Number.isFinite(sendUntil)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(env.PHONE_AUTH_SEND_UNTIL!)
    || sendUntil > Date.now() + 86_400_000)) throw invalid();
  return {
    enabled,
    allowAllNumbers,
    allowedNumbers: [...new Set(numbers as string[])],
    accessKeyId,
    accessKeySecret,
    codeTtlSeconds: integer("PHONE_AUTH_CODE_TTL_SECONDS", 300, 60, 600),
    resendSeconds: integer("PHONE_AUTH_RESEND_SECONDS", 60, 60, 600),
    phoneHourlyLimit: integer("PHONE_AUTH_PHONE_HOURLY_LIMIT", 3, 1, 10),
    ipHourlyLimit: integer("PHONE_AUTH_IP_HOURLY_LIMIT", 5, 1, 20),
    dailyLimit: integer("PHONE_AUTH_DAILY_LIMIT", 10, 1, 100),
    maxAttempts: integer("PHONE_AUTH_MAX_ATTEMPTS", 5, 1, 5),
    sendUntil,
  };
}
