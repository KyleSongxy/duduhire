import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { normalizeReturnTo, type AuthIntent, type AuthRole } from "./domain.js";
import type { PhoneAuthRepository } from "./phoneAuthRepository.js";
import { normalizeMainlandPhone } from "./phoneAuthConfig.js";
import type { PhoneVerificationProvider } from "./pnvsProvider.js";
import { addDays, createId, createOpaqueToken, hashToken } from "./security.js";

const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const bindingPattern = /^[A-Za-z0-9_-]{40,128}$/u;

export function isPhoneAuthRepository(value: unknown): value is PhoneAuthRepository {
  if (!value || typeof value !== "object") return false;
  return ["createPhoneChallengeIfAllowed", "markPhoneChallengeSent", "invalidatePhoneChallenge",
    "reservePhoneChallengeVerification", "releasePhoneChallengeVerification", "completePhoneChallengeVerification"]
    .every(method => typeof (value as Record<string, unknown>)[method] === "function");
}

export function registerPhoneAuthRoutes(app: FastifyInstance, {
  config, repository, provider, ensureBrowserBinding, browserBindingCookieName,
}: {
  config: AppConfig;
  repository?: PhoneAuthRepository;
  provider?: PhoneVerificationProvider;
  ensureBrowserBinding: (request: FastifyRequest, reply: FastifyReply) => string;
  browserBindingCookieName: string;
}) {
  const settings = config.phoneAuth;
  const available = Boolean(settings?.enabled && (settings.allowAllNumbers || settings.allowedNumbers.length) && repository && provider);
  const emailAvailable = config.emailDeliveryMode !== "disabled";
  const unavailable = (reply: FastifyReply) => reply.code(503).send({ error: {
    code: "PHONE_AUTH_UNAVAILABLE", message: emailAvailable
      ? "手机号注册暂未启用，请使用邮箱，或联系管理员安排短信联调。"
      : "手机号注册暂未启用，请稍后再试或联系管理员。",
  } });
  const invalidCode = (reply: FastifyReply) => reply.code(400).send({ error: {
    code: "INVALID_OR_EXPIRED_CODE", message: "验证码不正确、已失效或尝试次数已用完，请检查后重试或重新获取。",
  } });
  const codeHash = (id: string, code: string) => hashToken(`phone-code:${id}:${code}`, config.authTokenSecret);

  app.get("/api/v1/auth/methods", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return {
      email: { available: emailAvailable, delivery: emailAvailable ? config.emailDeliveryMode === "smtp" ? "email" : "development" : "disabled" },
      phone: { available, region: "CN" },
    };
  });

  app.post<{ Body: { phone: string; intent: AuthIntent; role?: AuthRole; returnTo?: string } }>("/api/v1/auth/phone/challenges", {
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    schema: { body: {
      type: "object", additionalProperties: false, required: ["phone", "intent"],
      properties: {
        phone: { type: "string", minLength: 11, maxLength: 20 },
        intent: { type: "string", enum: ["login", "signup"] },
        role: { type: "string", enum: ["client", "talent"] },
        returnTo: { type: "string", minLength: 1, maxLength: 2048 },
      },
    } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!available || !settings || !repository || !provider) return unavailable(reply);
    if (settings.sendUntil !== undefined && Date.now() >= settings.sendUntil) return reply.code(403).send({ error: {
      code: "SMS_TEST_WINDOW_CLOSED", message: "本次短信测试发送窗口已结束，不会再发送短信。已收到且仍有效的验证码可以继续核验；如需重新发送，请先确认新的测试授权。",
    } });
    const phone = normalizeMainlandPhone(request.body.phone);
    if (!phone) return reply.code(400).send({ error: { code: "INVALID_PHONE", message: "请输入中国大陆 11 位手机号。" } });
    if (request.body.intent === "signup" && !request.body.role) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "请选择账户类型。" } });
    if (!settings.allowAllNumbers && !settings.allowedNumbers.includes(phone)) return reply.code(403).send({ error: { code: "PHONE_NOT_ALLOWED", message: emailAvailable
      ? "当前仅开放已获授权的联调号码，请使用邮箱或联系管理员。"
      : "当前仅开放已获授权的联调号码，请联系管理员。" } });
    const now = new Date();
    const challengeId = createId();
    const binding = ensureBrowserBinding(request, reply);
    const creation = await repository.createPhoneChallengeIfAllowed({
      id: challengeId, phone, intent: request.body.intent,
      requestedRole: request.body.intent === "signup" ? request.body.role! : null,
      // An unsent challenge cannot be verified; the real hash is set atomically with sent_at.
      codeHash: codeHash(challengeId, createOpaqueToken()),
      browserBindingHash: hashToken(binding, config.authTokenSecret),
      requestIpHash: hashToken(`phone-ip:${request.ip}`, config.authTokenSecret),
      returnTo: normalizeReturnTo(request.body.returnTo),
      expiresAt: new Date(now.getTime() + settings.codeTtlSeconds * 1000), createdAt: now,
    }, now, settings);
    if (!creation.created) {
      if ("reason" in creation) return reply.code(409).send({ error: {
        code: "ACCOUNT_NOT_REGISTERED", message: "该手机号尚未注册，请先注册账户。",
      } });
      reply.header("Retry-After", String(creation.retryAfterSeconds));
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "短信发送频率或额度已达限制，请稍后重试。" } });
    }
    // A database-lock wait must not carry a sending request beyond its fixed authorization window.
    if (settings.sendUntil !== undefined && Date.now() >= settings.sendUntil) {
      await repository.invalidatePhoneChallenge(challengeId);
      return reply.code(403).send({ error: { code: "SMS_TEST_WINDOW_CLOSED", message: "本次短信测试发送窗口已结束，未继续发送。请先确认新的测试授权。" } });
    }
    try {
      const sent = await provider.send({ phone, requestId: challengeId, expiresInSeconds: settings.codeTtlSeconds });
      if (!/^\d{6}$/u.test(sent.code) || !await repository.markPhoneChallengeSent(challengeId, codeHash(challengeId, sent.code))) {
        throw new Error("SMS challenge could not be activated.");
      }
    } catch {
      await repository.invalidatePhoneChallenge(challengeId);
      request.log.warn({ challengeId }, "phone authentication send failed; no provider details logged");
      return reply.code(503).send({ error: { code: "SMS_UNAVAILABLE", message: "暂时无法确认短信发送状态，请稍后重新获取验证码。" } });
    }
    return reply.code(202).send({ accepted: true, delivery: "sms", challengeId,
      expiresInSeconds: Math.max(1, Math.floor((now.getTime() + settings.codeTtlSeconds * 1000 - Date.now()) / 1000)),
      resendAfterSeconds: settings.resendSeconds });
  });

  app.post<{ Body: { challengeId: string; code: string } }>("/api/v1/auth/phone/verify", {
    config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
    schema: { body: { type: "object", additionalProperties: false, required: ["challengeId", "code"], properties: {
      challengeId: { type: "string", pattern: uuidPattern }, code: { type: "string", pattern: "^[0-9]{6}$" },
    } } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!available || !settings || !repository || !provider) return unavailable(reply);
    const binding = request.cookies[browserBindingCookieName];
    if (!binding || !bindingPattern.test(binding)) return reply.code(400).send({ error: { code: "BROWSER_CONTEXT_REQUIRED", message: "请在申请验证码的同一浏览器中完成验证。" } });
    const { challengeId, code } = request.body;
    const leaseId = createId();
    const reserved = await repository.reservePhoneChallengeVerification(challengeId, hashToken(binding, config.authTokenSecret),
      codeHash(challengeId, code), new Date(), leaseId, settings.maxAttempts);
    if (reserved.status !== "reserved") return invalidCode(reply);
    let verified: boolean;
    try {
      verified = await provider.check({ phone: reserved.phone, code, requestId: challengeId });
    } catch {
      await repository.releasePhoneChallengeVerification(challengeId, leaseId);
      request.log.warn({ challengeId }, "phone authentication verification unavailable; no provider details logged");
      return reply.code(503).send({ error: { code: "SMS_VERIFICATION_UNAVAILABLE", message: "短信核验服务暂时不可用，请稍后重试；若验证码已失效，请重新获取。" } });
    }
    if (!verified) {
      await repository.invalidatePhoneChallenge(challengeId);
      return invalidCode(reply);
    }
    const now = new Date();
    const rawSessionToken = createOpaqueToken();
    const result = await repository.completePhoneChallengeVerification(challengeId, leaseId, now, {
      id: createId(), tokenHash: hashToken(rawSessionToken, config.authTokenSecret), createdAt: now, expiresAt: addDays(now, config.sessionTtlDays),
    });
    if (result.status === "invalid") return invalidCode(reply);
    if (result.status === "account_not_found") return reply.send({ authenticated: false, reason: "account_not_found", returnTo: result.returnTo });
    reply.setCookie(config.authCookieName, rawSessionToken, { httpOnly: true, secure: config.authCookieSecure,
      sameSite: "lax", path: "/", maxAge: config.sessionTtlDays * 86_400 });
    return reply.send({ authenticated: true, returnTo: result.returnTo });
  });
}
