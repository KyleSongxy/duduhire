import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DiscoveryKind } from "./domain.js";
import {
  confirmedSource, ENGAGEMENTS, MATCHING_SKILLS, MatchingConflictError, MatchingValidationError,
  matchingKnowledgeSources, ownedListing, publicListing, rankMatches, suggestMatchingDraft, suggestMatchingEvidence, validateMatchingDraft, WORK_MODES,
  type MatchingDraft, type PublishMatchingInput,
} from "./matching.js";
import { DiscoveryKindForbiddenError, type AppRepository, type AuthenticatedSession } from "./repository.js";

const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const versionSchema = { type: "integer", minimum: 0, maximum: 2_147_483_647 };
const skillsSchema = { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", enum: MATCHING_SKILLS } };
const nullablePositive = { anyOf: [{ type: "number", exclusiveMinimum: 0, maximum: 1_000_000_000 }, { type: "null" }] };
const constraintsSchema = { type: "object", additionalProperties: false, properties: {
  markets: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } },
  languages: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } },
  budgetMin: nullablePositive, budgetMax: nullablePositive,
  budgetCurrency: { anyOf: [{ type: "string", enum: ["CNY", "USD", "EUR"] }, { type: "null" }] },
  budgetPeriod: { anyOf: [{ type: "string", enum: ["project", "month", "hour"] }, { type: "null" }] },
  weeklyHours: { anyOf: [{ type: "number", exclusiveMinimum: 0, maximum: 168 }, { type: "null" }] },
  availableFrom: { type: "string", maxLength: 10 },
} };
const draftProperties = {
  title: { type: "string", minLength: 2, maxLength: 60 }, summary: { type: "string", minLength: 10, maxLength: 500 },
  skills: { ...skillsSchema, minItems: 1 }, requiredSkills: skillsSchema,
  workMode: { type: "string", enum: Object.keys(WORK_MODES) }, engagement: { type: "string", enum: Object.keys(ENGAGEMENTS) },
  location: { type: "string", maxLength: 60 }, notes: { type: "string", maxLength: 200 }, constraints: constraintsSchema,
};
const draftRequired = ["title", "summary", "skills", "requiredSkills", "workMode", "engagement", "location", "notes"];

export function registerMatchingRoutes({ app, repository, requireSession }: {
  app: FastifyInstance;
  repository: AppRepository;
  requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<AuthenticatedSession | null>;
}) {
  const kindFor = (session: AuthenticatedSession): DiscoveryKind => session.user.role === "talent" ? "capability" : "problem";
  const handleError = (error: unknown, reply: FastifyReply) => {
    if (error instanceof MatchingConflictError) return reply.code(409).send({
      error: { code: "MATCHING_VERSION_CONFLICT", message: "发现内容或发布版本已变化，请刷新后确认当前内容。" },
    });
    if (error instanceof MatchingValidationError) return reply.code(400).send({
      error: { code: "INVALID_MATCHING_LISTING", message: error.userMessage },
    });
    if (error instanceof DiscoveryKindForbiddenError) return reply.code(403).send({
      error: { code: "DISCOVERY_KIND_FORBIDDEN", message: "当前账户无法使用这个发现方向。" },
    });
    throw error;
  };

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/v1/me/matching")) reply.header("Cache-Control", "no-store");
  });

  app.get("/api/v1/me/matching", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const kind = kindFor(session);
    try {
      const [state, listing] = await Promise.all([
        repository.readDiscovery(session.user.id, kind), repository.readMatchingListing(session.user.id, kind),
      ]);
      return {
        kind,
        source: state ? { threadId: state.thread.id, version: state.thread.version, confirmed: confirmedSource(state) } : null,
        listing: listing ? ownedListing(listing) : null,
        suggestion: suggestMatchingDraft(state),
        suggestionEvidence: suggestMatchingEvidence(state), knowledgeSources: matchingKnowledgeSources(state),
        skills: MATCHING_SKILLS, workModes: WORK_MODES, engagements: ENGAGEMENTS,
      };
    } catch (error) { return handleError(error, reply); }
  });

  app.put<{ Body: PublishMatchingInput }>("/api/v1/me/matching/listing", {
    config: { rateLimit: { max: 60, timeWindow: "1 hour" } },
    schema: { body: { type: "object", additionalProperties: false,
      required: ["expectedThreadId", "expectedVersion", "expectedListingVersion", "consent", ...draftRequired],
      properties: {
        expectedThreadId: { type: "string", pattern: uuidPattern },
        expectedVersion: { ...versionSchema, minimum: 1 }, expectedListingVersion: versionSchema,
        consent: { type: "boolean", const: true },
        ...draftProperties,
      },
    } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    try {
      const listing = await repository.publishMatchingListing(session.user.id, kindFor(session), request.body, new Date());
      return { listing: ownedListing(listing) };
    } catch (error) { return handleError(error, reply); }
  });

  app.post<{ Body: { draft: MatchingDraft } }>("/api/v1/me/matching/preview", {
    config: { rateLimit: { max: 120, timeWindow: "1 hour" } },
    schema: { body: { type: "object", additionalProperties: false, required: ["draft"], properties: {
      draft: { type: "object", additionalProperties: false, required: draftRequired, properties: draftProperties },
    } } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    try {
      const kind = kindFor(session);
      const state = await repository.readDiscovery(session.user.id, kind);
      if (!confirmedSource(state)) return reply.code(409).send({ error: { code: "MATCHING_NOT_CONFIRMED", message: "请先确认整理结果，再查看示例匹配。" } });
      const draft = validateMatchingDraft(kind, request.body.draft);
      const candidates = repository.readMatchingExamples ? await repository.readMatchingExamples(session.user.id, kind) : [];
      const timestamp = new Date().toISOString();
      const source = { ...draft, id: "private-preview", kind, version: 1, createdAt: timestamp, updatedAt: timestamp };
      // Defensive filtering keeps any accidental real-record projection out of the example endpoint.
      const examples = candidates.filter((candidate) => candidate.isExample === true && candidate.contactable === false && candidate.id.startsWith("example-"));
      const matches = rankMatches(source, examples);
      return {
        matches: matches.slice(0, 20), total: matches.length, catalogLimited: false, algorithm: "evidence-skills-v2", catalog: "examples",
        catalogStatus: examples.length ? "ready" : "empty", exampleCount: examples.length,
        notice: examples.length ? "示例内容均为虚构，仅用于体验匹配；不会发布你的资料，也不能联系或发起真实合作。" : "示例库尚未导入，暂时没有可预览的示例。",
      };
    } catch (error) { return handleError(error, reply); }
  });

  app.post<{ Body: { expectedListingId: string | null; expectedListingVersion: number } }>("/api/v1/me/matching/withdraw", {
    config: { rateLimit: { max: 60, timeWindow: "1 hour" } },
    schema: { body: { type: "object", additionalProperties: false, required: ["expectedListingId", "expectedListingVersion"],
      properties: {
        expectedListingId: { anyOf: [{ type: "string", pattern: uuidPattern }, { type: "null" }] },
        expectedListingVersion: versionSchema,
      },
    } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    try {
      const listing = await repository.withdrawMatchingListing(session.user.id, kindFor(session), request.body.expectedListingId, request.body.expectedListingVersion, new Date());
      return { listing: listing ? ownedListing(listing) : null };
    } catch (error) { return handleError(error, reply); }
  });

  app.get("/api/v1/me/matching/results", {
    config: { rateLimit: { max: 120, timeWindow: "1 hour" } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    try {
      const { source, candidates, catalogLimited } = await repository.readMatchingCandidates(session.user.id, kindFor(session));
      if (!source?.active) return reply.code(409).send({
        error: { code: "MATCHING_NOT_PUBLISHED", message: "请先确认发现内容，并发布当前版本的匹配资料。" },
      });
      const matches = rankMatches(publicListing(source), candidates.map(publicListing));
      return { matches: matches.slice(0, 20), total: matches.length, catalogLimited, algorithm: "evidence-skills-v2", catalog: "published" };
    } catch (error) { return handleError(error, reply); }
  });
}
