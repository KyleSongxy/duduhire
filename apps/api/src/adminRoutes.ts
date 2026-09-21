import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import type { InquiryCursor, ManagedInquiryStatus } from "./domain.js";
import { decryptContactValue } from "./privacy.js";
import { InquiryVersionConflictError, type AppRepository, type AuthenticatedSession } from "./repository.js";

const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const idParams = { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: uuidPattern } } };
const statusSchema = { type: "string", enum: ["new", "contacted", "closed"] };

function parseCursor(value: string | undefined): InquiryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.createdAt !== "string" || typeof record.id !== "string"
      || !new RegExp(uuidPattern, "u").test(record.id) || new Date(record.createdAt).toISOString() !== record.createdAt) throw new Error();
    return { createdAt: record.createdAt, id: record.id };
  } catch {
    throw Object.assign(new Error("Invalid pagination cursor."), { statusCode: 400 });
  }
}

export function registerAdminRoutes({ app, config, repository, requireSession, contactDataKey, contactDataKeyId }: {
  app: FastifyInstance;
  config: AppConfig;
  repository: AppRepository;
  requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<AuthenticatedSession | null>;
  contactDataKey: string;
  contactDataKeyId: string;
}) {
  const allowedIds = new Set((config.adminUserIds ?? []).map((id) => id.toLowerCase()));
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await requireSession(request, reply);
    if (!session) return null;
    if (!allowedIds.has(session.user.id.toLowerCase())) {
      await reply.code(403).send({ error: { code: "ADMIN_REQUIRED", message: "当前账户没有管理权限。" } });
      return null;
    }
    return session;
  };

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/v1/admin/")) reply.header("Cache-Control", "no-store");
  });

  app.get("/api/v1/admin/access", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    return { authorized: allowedIds.has(session.user.id.toLowerCase()) };
  });

  app.get<{ Querystring: { status?: ManagedInquiryStatus; limit?: number; cursor?: string } }>("/api/v1/admin/inquiries", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: {
      status: statusSchema, limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", minLength: 1, maxLength: 300, pattern: "^[A-Za-z0-9_-]+$" },
    } } },
  }, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const page = await repository.listAdminInquiries(request.query.status ?? "new", request.query.limit ?? 20, parseCursor(request.query.cursor));
    return { ...page, nextCursor: page.nextCursor ? Buffer.from(JSON.stringify(page.nextCursor)).toString("base64url") : null };
  });

  app.patch<{ Params: { id: string }; Body: { status: ManagedInquiryStatus; expectedVersion: number } }>("/api/v1/admin/inquiries/:id", {
    schema: { params: idParams, body: { type: "object", additionalProperties: false, required: ["status", "expectedVersion"], properties: {
      status: statusSchema, expectedVersion: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
    } } },
  }, async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    try {
      const inquiry = await repository.updateInquiryStatus(session.user.id, request.params.id, request.body.status, request.body.expectedVersion);
      if (!inquiry) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "咨询记录不存在。" } });
      return { inquiry };
    } catch (error) {
      if (error instanceof InquiryVersionConflictError) {
        return reply.code(409).send({ error: { code: "INQUIRY_VERSION_CONFLICT", message: "咨询记录已更新，请刷新后重试。" } });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: { reason: string } }>("/api/v1/admin/inquiries/:id/reveal-contact", {
    config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
    schema: { params: idParams, body: { type: "object", additionalProperties: false, required: ["reason"], properties: {
      reason: { type: "string", minLength: 5, maxLength: 300 },
    } } },
  }, async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    const reason = request.body.reason.trim();
    if (reason.length < 5) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "请填写查看联系方式的业务原因。" } });
    const inquiryId = request.params.id.toLowerCase();
    const contact = await repository.revealInquiryContact(session.user.id, inquiryId, reason);
    if (!contact) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "咨询记录不存在。" } });
    if (contact.encryptionKeyId !== contactDataKeyId) throw new Error("Contact encryption key is unavailable.");
    if (!contact.contactCiphertext.startsWith("v2.")) throw new Error("Legacy inquiry contact requires offline key rotation.");
    return {
      contactMethod: contact.contactMethod,
      contactValue: decryptContactValue(contact.contactCiphertext, contactDataKey, {
        scope: "enterprise_inquiry", recordId: inquiryId, keyId: contact.encryptionKeyId,
      }),
    };
  });
}
