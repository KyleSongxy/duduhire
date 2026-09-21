import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { AppRepository } from "./repository.js";
import { normalizeEmail, normalizeReturnTo } from "./domain.js";
import { addDays, createId, createOpaqueToken, hashToken } from "./security.js";
import { hashPassword, validPassword, verifyPassword, type PasswordRepository } from "./passwordAuth.js";

export function registerPasswordAuthRoutes(app: FastifyInstance, config: AppConfig, repository: AppRepository) {
  const candidate = repository as AppRepository & Partial<PasswordRepository>;
  const available = [candidate.reservePasswordLogin, candidate.readPasswordHash, candidate.createPasswordSession, candidate.canSetPassword, candidate.setPassword].every(value => typeof value === "function");
  const passwords = candidate as AppRepository & PasswordRepository;
  const cookieOptions = { httpOnly: true, secure: config.authCookieSecure, sameSite: "lax" as const, path: "/" };
  const passwordSchema = { type: "string", minLength: 1, maxLength: 128 };

  app.post<{ Body: { email: string; password: string; returnTo?: string } }>("/api/v1/auth/password/login", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    schema: { body: { type: "object", additionalProperties: false, required: ["email", "password"], properties: {
      email: { type: "string", maxLength: 254 }, password: passwordSchema, returnTo: { type: "string", maxLength: 2048 },
    } } },
  }, async (request, reply) => {
    if (!available) return reply.code(503).send({ error: { code: "PASSWORD_AUTH_UNAVAILABLE", message: "密码登录暂不可用。" } });
    const email = normalizeEmail(request.body.email);
    if (!email || Buffer.byteLength(request.body.password) > 512) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "请输入有效的邮箱和密码。" } });
    const now = new Date();
    const retry = await passwords.reservePasswordLogin(hashToken(`password-login:${email}`, config.authTokenSecret), now);
    if (retry) return reply.header("Retry-After", String(retry)).code(429).send({ error: { code: "RATE_LIMITED", message: "密码尝试过于频繁，请 15 分钟后再试，或使用邮件链接登录。" } });
    const encoded = await passwords.readPasswordHash(email);
    let matched: boolean;
    try { matched = await verifyPassword(request.body.password, encoded); }
    catch { return reply.code(503).send({ error: { code: "PASSWORD_AUTH_UNAVAILABLE", message: "密码验证暂时繁忙，请稍后重试。" } }); }
    const token = createOpaqueToken();
    if (!matched || !encoded || !await passwords.createPasswordSession(email, encoded, {
      id: createId(), tokenHash: hashToken(token, config.authTokenSecret), createdAt: now, expiresAt: addDays(now, config.sessionTtlDays),
    })) return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "邮箱或密码不正确。尚未设置密码？请先通过邮箱设置密码。" } });
    reply.setCookie(config.authCookieName, token, { ...cookieOptions, maxAge: config.sessionTtlDays * 86_400 });
    return { authenticated: true, returnTo: normalizeReturnTo(request.body.returnTo) };
  });

  app.get("/api/v1/auth/password/setup", async (request, reply) => {
    if (!available) return reply.code(503).send({ error: { code: "PASSWORD_AUTH_UNAVAILABLE", message: "密码设置暂不可用。" } });
    const token = request.cookies[config.authCookieName];
    const hashed = token ? hashToken(token, config.authTokenSecret) : "";
    const session = token ? await repository.findSession(hashed, new Date()) : null;
    if (!session) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先验证邮箱。" } });
    return { canSetPassword: await passwords.canSetPassword(hashed, new Date()), email: session.user.email };
  });

  app.post<{ Body: { password: string } }>("/api/v1/auth/password/setup", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    schema: { body: { type: "object", additionalProperties: false, required: ["password"], properties: { password: passwordSchema } } },
  }, async (request, reply) => {
    if (!available) return reply.code(503).send({ error: { code: "PASSWORD_AUTH_UNAVAILABLE", message: "密码设置暂不可用。" } });
    if (!validPassword(request.body.password)) return reply.code(400).send({ error: { code: "INVALID_PASSWORD", message: "密码长度须为 12–128 个字符，可使用空格和中文。" } });
    const token = request.cookies[config.authCookieName];
    const hashed = token ? hashToken(token, config.authTokenSecret) : "";
    const needProof = () => reply.code(403).send({ error: { code: "EMAIL_REVERIFICATION_REQUIRED", message: "请重新验证邮箱后再设置密码，验证授权有效期为 15 分钟。" } });
    if (!token || !await passwords.canSetPassword(hashed, new Date())) return needProof();
    let encoded: string;
    try { encoded = await hashPassword(request.body.password); }
    catch { return reply.code(503).send({ error: { code: "PASSWORD_AUTH_UNAVAILABLE", message: "密码设置暂时繁忙，请稍后重试。" } }); }
    if (!await passwords.setPassword(hashed, encoded, new Date())) return needProof();
    reply.clearCookie(config.authCookieName, cookieOptions);
    return { saved: true };
  });
}
