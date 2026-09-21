import Fastify, { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { AppConfig } from "./config.js";
import { registerAdminRoutes } from "./adminRoutes.js";
import { registerPasswordAuthRoutes } from "./passwordAuthRoutes.js";
import { registerMatchingRoutes } from "./matchingRoutes.js";
import { isPhoneAuthRepository, registerPhoneAuthRoutes } from "./phoneAuthRoutes.js";
import { createAliyunPnvsProvider, type PhoneVerificationProvider } from "./pnvsProvider.js";
import type { PhoneAuthRepository } from "./phoneAuthRepository.js";
import { normalizeMainlandPhone } from "./phoneAuthConfig.js";
import { createDiscoveryAdvisor, type DiscoveryAdvisor } from "./discoveryAdvisor.js";
import { isDiscoveryConfirmation } from "./discoveryFlow.js";
import {
  normalizeEmail,
  normalizeReturnTo,
  sanitizeProfile,
  type AuthIntent,
  type AuthRole,
  type DiscoveryKind,
  type DiscoveryState,
  type JsonObject,
  type PersonalProfile,
} from "./domain.js";
import { createEmailSender, type EmailSender } from "./email.js";
import { decryptContactValue, encryptContactValue } from "./privacy.js";
import {
  DiscoveryKindForbiddenError,
  DiscoveryStateConflictError,
  ProfileVersionConflictError,
  type AppRepository,
  type AuthenticatedSession,
} from "./repository.js";
import { addDays, addMinutes, createId, createOpaqueToken, hashToken } from "./security.js";

type StartEmailBody = {
  email: string;
  intent: AuthIntent;
  role?: AuthRole;
  returnTo?: string;
};

type ProfileBody = Omit<PersonalProfile, "updatedAt">;

type DiscoveryAttachmentBody = {
  name: string;
  contentType: string;
  sizeBytes: number;
  textExcerpt: string;
};

type DiscoveryTurnBody = {
  requestId: string;
  prompt: string;
  attachments: DiscoveryAttachmentBody[];
  expectedThreadId?: string | null;
  expectedVersion?: number;
};

type DiscoveryResetBody = Pick<DiscoveryTurnBody, "expectedThreadId" | "expectedVersion">;

type EnterpriseInquiryBody = {
  requestId: string;
  method: "phone" | "wechat";
  contactValue: string;
  source: "home_pricing" | "pricing_page" | "enterprise_page";
};

const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

const profileBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["displayName", "countryCode", "contact", "organization", "jobTitle", "professionalTitle", "bio", "version"],
  properties: {
    displayName: { type: "string", maxLength: 80 },
    countryCode: { type: "string", pattern: "^(?:[A-Z]{2})?$" },
    contact: { type: "string", maxLength: 80 },
    organization: { type: "string", maxLength: 120 },
    jobTitle: { type: "string", maxLength: 80 },
    professionalTitle: { type: "string", maxLength: 100 },
    bio: { type: "string", maxLength: 500 },
    version: { type: "integer", minimum: 0 },
  },
} as const;

const discoveryTurnBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "prompt", "attachments"],
  properties: {
    requestId: { type: "string", pattern: uuidPattern },
    prompt: { type: "string", minLength: 1, maxLength: 12_000 },
    expectedThreadId: { anyOf: [{ type: "string", pattern: uuidPattern }, { type: "null" }] },
    expectedVersion: { type: "integer", minimum: 0 },
    attachments: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "contentType", "sizeBytes", "textExcerpt"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 255 },
          contentType: { type: "string", minLength: 1, maxLength: 120 },
          sizeBytes: { type: "integer", minimum: 0, maximum: 10 * 1024 * 1024 },
          textExcerpt: { type: "string", maxLength: 8_000 },
        },
      },
    },
  },
} as const;

function sessionPayload(session: AuthenticatedSession, profile: PersonalProfile) {
  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
      roles: ["client", "talent"],
      emailVerifiedAt: session.user.emailVerifiedAt?.toISOString() ?? null,
      phone: session.user.phone ?? null,
      phoneVerifiedAt: session.user.phoneVerifiedAt?.toISOString() ?? null,
    },
    signedInAt: session.signedInAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    profile: profilePayload(profile),
  };
}

function profilePayload(profile: PersonalProfile) {
  return {
    displayName: profile.displayName,
    countryCode: profile.countryCode,
    contact: profile.contact,
    organization: profile.organization,
    jobTitle: profile.jobTitle,
    professionalTitle: profile.professionalTitle,
    bio: profile.bio,
    version: profile.version,
    updatedAt: profile.updatedAt?.toISOString() ?? null,
  };
}

function discoveryKindForRole(role: AuthRole): DiscoveryKind {
  return role === "talent" ? "capability" : "problem";
}

function discoveryPayload(state: DiscoveryState | null, kind: DiscoveryKind) {
  return {
    discovery: {
      threadId: state?.thread.id ?? null,
      version: state?.thread.version ?? 0,
      kind,
      turns: state?.turns.map((turn) => ({
        id: turn.id,
        requestId: turn.requestId,
        question: turn.question,
        answer: turn.answer,
        attachments: turn.attachments,
        createdAt: turn.createdAt.toISOString(),
      })) ?? [],
      artifact: state?.artifact
        ? {
            id: state.artifact.id,
            kind: state.artifact.kind,
            draft: state.artifact.draft,
            version: state.artifact.version,
            updatedAt: state.artifact.updatedAt.toISOString(),
          }
        : null,
    },
  };
}

function normalizeEnterpriseContact(method: EnterpriseInquiryBody["method"], rawValue: string) {
  const value = rawValue.trim().normalize("NFKC");
  if (method === "phone") {
    const digits = value.replace(/\D/gu, "");
    if (!/^[+\d][\d\s()-]*$/u.test(value) || digits.length < 6 || digits.length > 15) return null;
    return value.replace(/\s+/gu, " ");
  }
  if (/\s/u.test(value) || value.length < 2 || value.length > 32) return null;
  return value;
}

export async function buildApp({
  config,
  repository,
  emailSender: suppliedEmailSender,
  discoveryAdvisor: suppliedDiscoveryAdvisor,
  phoneProvider: suppliedPhoneProvider,
  phoneRepository: suppliedPhoneRepository,
}: {
  config: AppConfig;
  repository: AppRepository;
  emailSender?: EmailSender;
  discoveryAdvisor?: DiscoveryAdvisor;
  phoneProvider?: PhoneVerificationProvider;
  phoneRepository?: PhoneAuthRepository;
}) {
  const app = Fastify({
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
    trustProxy: config.trustProxy,
    requestIdHeader: "x-request-id",
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: config.logLevel,
      redact: {
        paths: ["req.headers.cookie", "req.headers.authorization", "res.headers.set-cookie"],
        censor: "[Redacted]",
      },
    },
  });

  await app.register(cookie);
  await app.register(cors, { origin: config.webOrigin, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { global: false });

  const emailSender = suppliedEmailSender ?? createEmailSender(config, app.log);
  const discoveryAdvisor = suppliedDiscoveryAdvisor ?? createDiscoveryAdvisor(config);
  const phoneProvider = suppliedPhoneProvider ?? (config.phoneAuth?.enabled && config.phoneAuth.accessKeyId && config.phoneAuth.accessKeySecret
    ? createAliyunPnvsProvider({ accessKeyId: config.phoneAuth.accessKeyId, accessKeySecret: config.phoneAuth.accessKeySecret }) : undefined);
  const contactDataKey = config.contactDataKey ?? hashToken("duduhire-development-contact-key", config.authTokenSecret);
  const contactDataKeyId = config.contactDataKeyId ?? "contact-development-v1";
  const cookieOptions = {
    httpOnly: true,
    secure: config.authCookieSecure,
    sameSite: "lax" as const,
    path: "/",
  };
  const browserBindingCookieName = config.authCookieName.startsWith("__Host-")
    ? "__Host-duduhire_auth_intent"
    : "duduhire_auth_intent";
  const opaqueTokenPattern = /^[A-Za-z0-9_-]{40,128}$/u;

  const ensureBrowserBinding = (request: FastifyRequest, reply: FastifyReply) => {
    const existing = request.cookies[browserBindingCookieName];
    const token = existing && opaqueTokenPattern.test(existing) ? existing : createOpaqueToken();
    reply.setCookie(browserBindingCookieName, token, {
      ...cookieOptions,
      maxAge: Math.max(config.magicLinkTtlMinutes, 60) * 60,
    });
    return token;
  };

  const rejectUntrustedOrigin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.origin !== config.webOrigin) {
      await reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED", message: "请求来源无效。" } });
    }
  };

  const readRequestSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = request.cookies[config.authCookieName];
    if (!rawToken) return null;
    const session = await repository.findSession(hashToken(rawToken, config.authTokenSecret), new Date());
    if (!session) reply.clearCookie(config.authCookieName, cookieOptions);
    return session;
  };

  const decryptProfileContact = (profile: PersonalProfile, userId: string): PersonalProfile => {
    if (!profile.contact || !/^v[12]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u.test(profile.contact)) {
      return profile;
    }
    return {
      ...profile,
      contact: decryptContactValue(profile.contact, contactDataKey, { scope: "profile", recordId: userId, keyId: contactDataKeyId }),
    };
  };

  const readProfile = async (userId: string) => decryptProfileContact(await repository.readProfile(userId), userId);

  app.addHook("preHandler", async (request, reply) => {
    if (
      request.routeOptions.url?.startsWith("/api/v1/")
      && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
    ) {
      await rejectUntrustedOrigin(request, reply);
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url?.startsWith("/api/v1/auth/")) reply.header("Cache-Control", "no-store");
  });

  const matchesExpectedRole = async (request: FastifyRequest, reply: FastifyReply, session: AuthenticatedSession) => {
    const expectedRole = request.headers["x-duduhire-role"];
    if (expectedRole === undefined) return true;
    if (expectedRole !== "client" && expectedRole !== "talent") {
      await reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "当前身份参数无效。" } });
      return false;
    }
    if (session.user.role !== expectedRole) {
      await reply.header("Cache-Control", "no-store").code(409).send({
        error: { code: "ACTIVE_ROLE_CHANGED", message: "身份已在其他页面切换，请刷新后继续。" },
      });
      return false;
    }
    return true;
  };

  const requireSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await readRequestSession(request, reply);
    if (!session) {
      await reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录。" } });
      return null;
    }
    const path = request.routeOptions.url ?? "";
    if ((path.startsWith("/api/v1/me/discovery") || path.startsWith("/api/v1/me/matching")
      || path === "/api/v1/me/workspace") && !await matchesExpectedRole(request, reply, session)) return null;
    return session;
  };

  app.addHook("onResponse", async (request, reply) => {
    app.log.info(
      { requestId: request.id, method: request.method, route: request.routeOptions.url, statusCode: reply.statusCode },
      "request completed",
    );
  });

  app.setErrorHandler((error, request, reply) => {
    // SQL/provider errors can include phone/code values. Never serialize raw auth exceptions.
    if (request.routeOptions.url?.startsWith("/api/v1/auth/phone/")
      || request.routeOptions.url?.startsWith("/api/v1/auth/password/")
      || request.routeOptions.url === "/api/v1/auth/login-eligibility") {
      request.log.error({ requestId: request.id, route: request.routeOptions.url }, "authentication request failed");
    } else {
      request.log.error({ err: error, requestId: request.id, route: request.routeOptions.url }, "request failed");
    }
    const status = (error as { statusCode?: number }).statusCode;
    const statusCode = status && status < 500 ? status : 500;
    const responseByStatus: Record<number, { code: string; message: string }> = {
      400: { code: "INVALID_REQUEST", message: "请求内容无效。" },
      401: { code: "AUTH_REQUIRED", message: "请先登录。" },
      403: { code: "FORBIDDEN", message: "当前账户无权执行此操作。" },
      404: { code: "NOT_FOUND", message: "请求的内容不存在。" },
      409: { code: "CONFLICT", message: "数据已发生变化，请刷新后重试。" },
      413: { code: "PAYLOAD_TOO_LARGE", message: "提交的内容过大。" },
      429: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试。" },
    };
    const { code, message } = responseByStatus[statusCode] ?? { code: "INTERNAL_ERROR", message: "服务暂时不可用。" };
    reply.code(statusCode).send({ error: { code, message, requestId: request.id } });
  });

  app.get("/api/health/live", async () => ({ status: "ok" }));
  app.get("/api/health/ready", async (_request, reply) => {
    await repository.ping();
    return reply.send({ status: "ready" });
  });

  registerPasswordAuthRoutes(app, config, repository);
  registerPhoneAuthRoutes(app, {
    config,
    repository: suppliedPhoneRepository ?? (isPhoneAuthRepository(repository) ? repository : undefined),
    provider: phoneProvider,
    ensureBrowserBinding,
    browserBindingCookieName,
  });

  app.post<{ Body: { method: "email" | "phone"; account: string } }>(
    "/api/v1/auth/login-eligibility",
    {
      config: { rateLimit: { max: 60, timeWindow: "10 minutes" } },
      schema: { body: {
        type: "object", additionalProperties: false, required: ["method", "account"],
        properties: {
          method: { type: "string", enum: ["email", "phone"] },
          account: { type: "string", minLength: 1, maxLength: 254 },
        },
      } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const { method } = request.body;
      const account = method === "email" ? normalizeEmail(request.body.account) : normalizeMainlandPhone(request.body.account);
      if (!account) return reply.code(400).send({ error: method === "email"
        ? { code: "INVALID_EMAIL", message: "请输入有效的邮箱地址。" }
        : { code: "INVALID_PHONE", message: "请输入中国大陆 11 位手机号。" },
      });
      return { registered: await repository.isRegisteredLoginAccount(method, account) };
    },
  );

  app.post<{ Body: StartEmailBody }>(
    "/api/v1/auth/email/challenges",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "intent"],
          properties: {
            email: { type: "string", minLength: 3, maxLength: 254 },
            intent: { type: "string", enum: ["login", "signup"] },
            role: { type: "string", enum: ["client", "talent"] },
            returnTo: { type: "string", minLength: 1, maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      if (config.emailDeliveryMode === "disabled") {
        return reply.header("Cache-Control", "no-store").code(503).send({ error: {
          code: "EMAIL_AUTH_DISABLED", message: "邮箱注册与登录暂未启用，请返回登录页面查看可用方式。",
        } });
      }
      const email = normalizeEmail(request.body.email);
      const requestedRole = request.body.intent === "signup" ? request.body.role : undefined;
      if (!email || (request.body.intent === "signup" && !requestedRole)) {
        return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "请输入有效的邮箱地址。" } });
      }

      const now = new Date();
      const token = createOpaqueToken();
      const challengeId = createId();
      const returnTo = normalizeReturnTo(request.body.returnTo);
      const browserBindingToken = ensureBrowserBinding(request, reply);
      const creation = await repository.createEmailChallengeIfAllowed({
        id: challengeId,
        email,
        intent: request.body.intent,
        requestedRole: requestedRole ?? null,
        tokenHash: hashToken(token, config.authTokenSecret),
        browserBindingHash: hashToken(browserBindingToken, config.authTokenSecret),
        returnTo,
        expiresAt: addMinutes(now, config.magicLinkTtlMinutes),
        createdAt: now,
      }, now, config.emailResendSeconds, config.emailHourlyLimit);
      if (!creation.created) {
        if ("reason" in creation) return reply.header("Cache-Control", "no-store").code(409).send({ error: {
          code: "ACCOUNT_NOT_REGISTERED", message: "该邮箱尚未注册，请先注册账户。",
        } });
        reply.header("Retry-After", String(creation.retryAfterSeconds));
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "发送过于频繁，请稍后重试。" } });
      }

      try {
        const link = `${config.webOrigin}/auth/verify#token=${encodeURIComponent(token)}`;
        await emailSender.sendMagicLink({
          deliveryId: challengeId,
          to: email,
          link,
          expiresInMinutes: config.magicLinkTtlMinutes,
        });
      } catch (error) {
        await repository.invalidateEmailChallenge(challengeId);
        request.log.error(
          {
            challengeId,
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorCode: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
          },
          "authentication email delivery failed",
        );
        return reply.code(503).send({ error: { code: "EMAIL_UNAVAILABLE", message: "验证邮件暂时无法发送，请稍后重试。" } });
      }

      reply.header("Cache-Control", "no-store");
      return reply.code(202).send({
        accepted: true,
        delivery: config.emailDeliveryMode === "smtp" ? "email" : "development",
        expiresInSeconds: config.magicLinkTtlMinutes * 60,
        resendAfterSeconds: config.emailResendSeconds,
      });
    },
  );

  app.post<{ Body: { token: string } }>(
    "/api/v1/auth/email/verify",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: { token: { type: "string", minLength: 40, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" } },
        },
      },
    },
    async (request, reply) => {
      if (config.emailDeliveryMode === "disabled") {
        return reply.header("Cache-Control", "no-store").code(503).send({ error: {
          code: "EMAIL_AUTH_DISABLED", message: "邮箱注册与登录暂未启用，请返回登录页面查看可用方式。",
        } });
      }
      const browserBindingToken = request.cookies[browserBindingCookieName];
      if (!browserBindingToken || !opaqueTokenPattern.test(browserBindingToken)) {
        return reply.code(400).send({ error: { code: "BROWSER_CONTEXT_REQUIRED", message: "请在发起验证的浏览器中打开此链接。" } });
      }
      const now = new Date();
      const rawSessionToken = createOpaqueToken();
      const result = await repository.consumeEmailChallenge(
        hashToken(request.body.token, config.authTokenSecret),
        hashToken(browserBindingToken, config.authTokenSecret),
        now,
        {
          id: createId(),
          tokenHash: hashToken(rawSessionToken, config.authTokenSecret),
          createdAt: now,
          expiresAt: addDays(now, config.sessionTtlDays),
        },
      );

      reply.header("Cache-Control", "no-store");
      if (result.status === "invalid") {
        return reply.code(400).send({ error: { code: "INVALID_OR_EXPIRED_LINK", message: "验证链接无效或已过期。" } });
      }
      if (result.status === "account_not_found") {
        return reply.send({ authenticated: false, reason: "account_not_found", returnTo: result.returnTo });
      }

      reply.setCookie(config.authCookieName, rawSessionToken, {
        ...cookieOptions,
        maxAge: config.sessionTtlDays * 86_400,
      });
      return reply.send({ authenticated: true, returnTo: result.returnTo });
    },
  );

  app.get("/api/v1/auth/session", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    ensureBrowserBinding(request, reply);
    const session = await readRequestSession(request, reply);
    if (!session) return reply.send({ session: null });
    const profile = await readProfile(session.user.id);
    return reply.send({ session: sessionPayload(session, profile) });
  });

  app.post<{ Body: { role: AuthRole } }>("/api/v1/auth/role", {
    schema: { body: {
      type: "object", additionalProperties: false, required: ["role"],
      properties: { role: { type: "string", enum: ["client", "talent"] } },
    } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const tokenHash = hashToken(request.cookies[config.authCookieName]!, config.authTokenSecret);
    const updated = await repository.switchSessionRole(tokenHash, request.body.role, new Date());
    if (!updated) {
      reply.clearCookie(config.authCookieName, cookieOptions);
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录。" } });
    }
    return reply.send({ session: sessionPayload(updated, await readProfile(updated.user.id)) });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const rawToken = request.cookies[config.authCookieName];
    if (rawToken) await repository.revokeSession(hashToken(rawToken, config.authTokenSecret), new Date());
    reply.clearCookie(config.authCookieName, cookieOptions);
    return reply.code(204).send();
  });

  app.get("/api/v1/me/profile", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    reply.header("Cache-Control", "no-store");
    return reply.send({ profile: profilePayload(await readProfile(session.user.id)) });
  });

  app.put<{ Body: ProfileBody }>(
    "/api/v1/me/profile",
    { schema: { body: profileBodySchema } },
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      const { version, ...rawProfile } = request.body;
      const profile = sanitizeProfile(rawProfile);
      if (!profile.displayName) {
        return reply.code(400).send({ error: { code: "DISPLAY_NAME_REQUIRED", message: "请填写姓名或常用称呼。", field: "displayName" } });
      }
      try {
        const storedProfile = {
          ...profile,
          contact: profile.contact
            ? encryptContactValue(profile.contact, contactDataKey, { scope: "profile", recordId: session.user.id, keyId: contactDataKeyId })
            : "",
        };
        const savedProfile = await repository.saveProfile(session.user.id, storedProfile, new Date(), version);
        return reply.send({ profile: profilePayload(decryptProfileContact(savedProfile, session.user.id)) });
      } catch (error) {
        if (error instanceof ProfileVersionConflictError) {
          return reply.code(409).send({
            error: {
              code: error.code,
              message: "资料已在其他页面更新，请刷新后再试。",
              currentVersion: error.currentVersion,
            },
          });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: { prompt: string } }>(
    "/api/v1/discovery/intakes",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["prompt"],
          properties: { prompt: { type: "string", minLength: 1, maxLength: 12_000 } },
        },
      },
    },
    async (request, reply) => {
      const session = await readRequestSession(request, reply);
      if (session && !await matchesExpectedRole(request, reply, session)) return;
      const prompt = request.body.prompt.trim();
      if (!prompt) {
        return reply.code(400).send({ error: { code: "PROMPT_REQUIRED", message: "请先描述你想解决的问题。" } });
      }
      const now = new Date();
      const browserBinding = ensureBrowserBinding(request, reply);
      const draft = await repository.createIntakeDraft({
        id: createId(),
        browserBindingHash: hashToken(browserBinding, config.authTokenSecret),
        prompt,
        createdAt: now,
        expiresAt: addMinutes(now, 60),
      });
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send({ intakeId: draft.id, expiresAt: draft.expiresAt.toISOString() });
    },
  );

  app.post<{ Params: { intakeId: string } }>(
    "/api/v1/me/discovery/intakes/:intakeId/claim",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["intakeId"],
          properties: { intakeId: { type: "string", pattern: uuidPattern } },
        },
      },
    },
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      if (session.user.role !== "client") {
        return reply.code(403).send({ error: { code: "INTAKE_ROLE_FORBIDDEN", message: "请切换到需求方身份后读取该内容。" } });
      }
      const browserBinding = request.cookies[browserBindingCookieName];
      if (!browserBinding || !opaqueTokenPattern.test(browserBinding)) {
        return reply.code(404).send({ error: { code: "INTAKE_NOT_FOUND", message: "首页内容已失效，请重新输入。" } });
      }
      const draft = await repository.claimIntakeDraft(
        session.user.id,
        request.params.intakeId,
        hashToken(browserBinding, config.authTokenSecret),
        new Date(),
      );
      reply.header("Cache-Control", "no-store");
      if (!draft) {
        return reply.code(404).send({ error: { code: "INTAKE_NOT_FOUND", message: "首页内容已失效，请重新输入。" } });
      }
      return reply.send({ prompt: draft.prompt });
    },
  );

  app.get("/api/v1/me/discovery", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const kind = discoveryKindForRole(session.user.role);
    reply.header("Cache-Control", "no-store");
    return reply.send(discoveryPayload(await repository.readDiscovery(session.user.id, kind), kind));
  });

  app.post<{ Body: DiscoveryTurnBody }>(
    "/api/v1/me/discovery/turns",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: { body: discoveryTurnBodySchema },
    },
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      const question = request.body.prompt.trim();
      if (!question) {
        return reply.code(400).send({ error: { code: "PROMPT_REQUIRED", message: "请输入内容后再发送。" } });
      }
      const kind = discoveryKindForRole(session.user.role);
      const current = await repository.readDiscovery(session.user.id, kind);
      const duplicate = current?.turns.some((turn) => turn.requestId === request.body.requestId);
      if (duplicate) return reply.send(discoveryPayload(current, kind));
      const hasExpectedThread = request.body.expectedThreadId !== undefined;
      const hasExpectedVersion = request.body.expectedVersion !== undefined;
      if (hasExpectedThread !== hasExpectedVersion) {
        return reply.code(400).send({
          error: { code: "INVALID_REQUEST", message: "请同时提供对话标识和版本。" },
        });
      }
      if (isDiscoveryConfirmation(question) && !hasExpectedVersion) {
        return reply.code(409).send({
          error: { code: "DISCOVERY_VERSION_REQUIRED", message: "请刷新当前草稿后再确认保存。" },
        });
      }
      if (isDiscoveryConfirmation(question) && request.body.attachments.length > 0) {
        return reply.code(400).send({
          error: { code: "CONFIRMATION_HAS_ATTACHMENTS", message: "请先发送新材料并检查更新后的草稿，再单独确认保存当前版本。" },
        });
      }
      if (hasExpectedVersion && (
        request.body.expectedThreadId !== (current?.thread.id ?? null)
        || request.body.expectedVersion !== (current?.thread.version ?? 0)
      )) {
        return reply.code(409).send({
          error: { code: "DISCOVERY_STATE_CONFLICT", message: "对话已在其他页面发生变化，请刷新后重试。" },
        });
      }

      const attachmentContext = request.body.attachments
        .filter((attachment) => attachment.textExcerpt.trim())
        .map((attachment) => `附件：${attachment.name}（${attachment.contentType}）\n${attachment.textExcerpt.trim()}`)
        .join("\n\n")
        .slice(0, 12_000);
      const history = current?.turns
        .map((turn) => [
          `用户 [user:${turn.requestId}]：${turn.question}`,
          turn.analysisContext ? `材料 [attachment:${turn.requestId}]：${turn.analysisContext}` : "",
          `顾问：${turn.answer}`,
        ].filter(Boolean).join("\n"))
        .join("\n\n")
        .slice(-52_000) ?? "";
      const context = [history, attachmentContext].filter(Boolean).join("\n\n").slice(-64_000);
      // Source IDs stay stable across turns so persisted facts can retain their
      // original user/material reference even when conversational context is trimmed.
      const sources = [
        ...(current?.turns.flatMap((turn) => [
          { id: `user:${turn.requestId}`, text: turn.question, kind: "user" as const },
          ...(turn.analysisContext ? [{ id: `attachment:${turn.requestId}`, text: turn.analysisContext, kind: "attachment" as const }] : []),
        ]) ?? []),
        { id: `user:${request.body.requestId}`, text: question, kind: "user" as const },
        ...(attachmentContext ? [{ id: `attachment:${request.body.requestId}`, text: attachmentContext, kind: "attachment" as const }] : []),
      ];
      // Capture the version before awaiting the model: concurrent replies must
      // compare against this snapshot, not a subsequently updated repository object.
      const expectedState = current ? { threadId: current.thread.id, threadVersion: current.thread.version } : null;

      let advice;
      try {
        advice = await discoveryAdvisor.advise({
          kind,
          message: question,
          context,
          priorTurnCount: current?.turns.length ?? 0,
          previousArtifact: current?.artifact?.draft,
          requestId: request.body.requestId,
          sources,
        });
      } catch (error) {
        request.log.error(
          { errorName: error instanceof Error ? error.name : "UnknownError", requestId: request.id },
          "discovery advisor failed",
        );
        return reply.code(503).send({ error: { code: "AI_UNAVAILABLE", message: "AI 顾问暂时不可用，请稍后重试。" } });
      }

      try {
        const state = await repository.appendDiscoveryTurn(session.user.id, kind, {
          requestId: request.body.requestId,
          question,
          answer: advice.answer,
          attachments: request.body.attachments.map((attachment) => ({
            name: attachment.name,
            mediaType: attachment.contentType,
            size: attachment.sizeBytes,
          })),
          analysisContext: attachmentContext,
          provider: advice.provider,
          model: advice.model,
          promptVersion: advice.promptVersion,
          artifactDraft: advice.artifact as unknown as JsonObject,
        }, new Date(), expectedState);
        reply.header("Cache-Control", "no-store");
        return reply.send(discoveryPayload(state, kind));
      } catch (error) {
        if (error instanceof DiscoveryStateConflictError) {
          return reply.code(409).send({ error: { code: error.code, message: "对话已在其他页面发生变化，请刷新后重试。" } });
        }
        if (error instanceof DiscoveryKindForbiddenError) {
          return reply.code(403).send({ error: { code: error.code, message: "当前账户无权使用此发现流程。" } });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: DiscoveryResetBody | undefined }>("/api/v1/me/discovery/reset", {
    preValidation: async (request) => {
      if (request.body === undefined) request.body = {};
    },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          expectedThreadId: { anyOf: [{ type: "string", pattern: uuidPattern }, { type: "null" }] },
          expectedVersion: { type: "integer", minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const kind = discoveryKindForRole(session.user.role);
    const hasExpectedThread = request.body?.expectedThreadId !== undefined;
    const hasExpectedVersion = request.body?.expectedVersion !== undefined;
    if (hasExpectedThread !== hasExpectedVersion || (hasExpectedThread && request.body?.expectedThreadId === null && request.body.expectedVersion !== 0)) {
      return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "请提供一致的对话标识和版本。" } });
    }
    const expectedState = hasExpectedThread
      ? request.body?.expectedThreadId ? { threadId: request.body.expectedThreadId, threadVersion: request.body.expectedVersion! } : null
      : undefined;
    try {
      await repository.resetDiscovery(session.user.id, kind, new Date(), expectedState);
    } catch (error) {
      if (error instanceof DiscoveryStateConflictError) {
        return reply.code(409).send({ error: { code: error.code, message: "对话已在其他页面发生变化，请刷新后重试。" } });
      }
      if (error instanceof DiscoveryKindForbiddenError) {
        return reply.code(403).send({ error: { code: error.code, message: "当前账户无权使用此发现流程。" } });
      }
      throw error;
    }
    reply.header("Cache-Control", "no-store");
    return reply.send(discoveryPayload(null, kind));
  });

  app.get("/api/v1/me/workspace", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const summary = await repository.readWorkspaceSummary(session.user.id, session.user.role);
    reply.header("Cache-Control", "no-store");
    return reply.send({
      ...summary,
      updatedAt: summary.updatedAt?.toISOString() ?? null,
      paymentAccountStatus: "not_configured",
    });
  });

  app.post<{ Body: EnterpriseInquiryBody }>(
    "/api/v1/enterprise/inquiries",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["requestId", "method", "contactValue", "source"],
          properties: {
            requestId: { type: "string", pattern: uuidPattern },
            method: { type: "string", enum: ["phone", "wechat"] },
            contactValue: { type: "string", minLength: 2, maxLength: 32 },
            source: { type: "string", enum: ["home_pricing", "pricing_page", "enterprise_page"] },
          },
        },
      },
    },
    async (request, reply) => {
      const contactValue = normalizeEnterpriseContact(request.body.method, request.body.contactValue);
      if (!contactValue) {
        return reply.code(400).send({ error: { code: "INVALID_CONTACT", message: "请输入有效的联系方式。" } });
      }
      const session = await readRequestSession(request, reply);
      const now = new Date();
      const inquiryId = request.body.requestId.toLowerCase();
      await repository.createEnterpriseInquiry({
        id: inquiryId,
        userId: session?.user.id ?? null,
        contactMethod: request.body.method,
        contactCiphertext: encryptContactValue(contactValue, contactDataKey, {
          scope: "enterprise_inquiry",
          recordId: inquiryId,
          keyId: contactDataKeyId,
        }),
        contactHash: hashToken(contactValue.toLocaleLowerCase("en-US"), config.authTokenSecret),
        encryptionKeyId: contactDataKeyId,
        source: request.body.source,
        consentedAt: now,
        createdAt: now,
      });
      return reply.code(202).send({ accepted: true });
    },
  );

  registerAdminRoutes({ app, config, repository, requireSession, contactDataKey, contactDataKeyId });
  registerMatchingRoutes({ app, repository, requireSession });

  app.addHook("onClose", async () => {
    await emailSender.close();
    await repository.close();
  });

  return app;
}
