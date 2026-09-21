import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveryKind, DiscoveryState, JsonObject } from "../src/domain.js";
import {
  confirmedSource, emptyMatchingConstraints, ownedListing, publicListing, rankMatches, suggestMatchingDraft, suggestMatchingEvidence, validateMatchingDraft,
  MatchingValidationError, type MatchingDraft, type MatchingListing, type MatchingListingRecord,
} from "../src/matching.js";
import { getDiscoveryGuidance, inferDomainSignals, KNOWLEDGE_SOURCES } from "../src/domainKnowledge.js";
import { MATCHING_EXAMPLES } from "../src/matchingExamples.js";
import { MATCHING_PROVIDER_FIXTURES } from "./matchingProviderFixtures.js";

const now = new Date("2026-09-06T00:00:00Z");
const draft = (overrides: Partial<MatchingDraft> = {}): MatchingDraft => ({
  title: "内部知识问答建设", summary: "梳理已有制度资料，建设员工自助知识问答，减少重复咨询。",
  skills: ["知识库", "智能问答"], requiredSkills: [], workMode: "remote", engagement: "project", location: "", notes: "", ...overrides,
});
const listing = (kind: DiscoveryKind, id: string, overrides: Partial<MatchingDraft> = {}): MatchingListing => ({
  ...draft(overrides), id, kind, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(),
});
function state(kind: DiscoveryKind = "problem"): DiscoveryState {
  const values = kind === "problem"
    ? { context: "员工查找制度有困难", work: "整理知识库，开展智能问答", outcome: "员工能够自行查到制度" }
    : { situation: "课程项目中资料分散", role: "我只参与文档整理，不是项目负责人", actions: "整理文档并分类，没有做前端开发", outcome: "团队更方便查到资料" };
  const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, status: "provided", evidence: [{ sourceId: "user:synthetic", quote: value }] }]));
  return {
    thread: { id: "thread-test", kind, status: "active", version: 3, createdAt: now, updatedAt: now },
    turns: [{ id: "turn-synthetic", requestId: "synthetic", question: Object.values(values).join("\n"), answer: "已整理。", analysisContext: "", attachments: [], provider: "local", model: "fixture", promptVersion: "test.v2", createdAt: now }],
    artifact: { id: "artifact-test", kind, version: 3, createdAt: now, updatedAt: now, draft: {
      kind: kind === "problem" ? "problem_brief" : "capability_identity", profile: "知识问答建设", capabilityIdentity: "知识资料整理",
      flow: { schemaVersion: 2, status: "confirmed", confirmedAt: now.toISOString(), fields, missingFields: [], stage: "confirmed", nextQuestion: "" },
    } },
  };
}
function flow(value: DiscoveryState) { return value.artifact!.draft.flow as JsonObject; }
function providedField(current: DiscoveryState, requestId: string, value: string) {
  const turn = current.turns.find((entry) => entry.requestId === requestId);
  if (turn) turn.question += `\n${value}`;
  else current.turns.push({ id: `turn-${requestId}`, requestId, question: value, answer: "已整理。", analysisContext: "", attachments: [], provider: "local", model: "fixture", promptVersion: "test.v2", createdAt: now });
  return { value, status: "provided", evidence: [{ sourceId: `user:${requestId}`, quote: value }] };
}

test("only current active v2 confirmed artifacts with complete provided facts can enter publication", () => {
  for (const kind of ["problem", "capability"] as const) assert.equal(confirmedSource(state(kind)), true);
  assert.equal(confirmedSource(null), false);
  for (const patch of [{ status: "ready" }, { schemaVersion: 1 }, { confirmedAt: "invalid" }, { confirmedAt: null }, { fields: {} }]) {
    const current = state();
    Object.assign(flow(current), patch);
    assert.equal(confirmedSource(current), false);
  }
  const archived = state(); archived.thread.status = "archived";
  assert.equal(confirmedSource(archived), false);
  for (const field of [
    { value: "AI inferred", status: "inferred", evidence: [{ sourceId: "user:one", quote: "word" }] },
    { value: "User claim", status: "provided", evidence: [] },
    { value: "User claim", status: "provided", evidence: [{ sourceId: "", quote: "" }] },
  ]) {
    const current = state(); (flow(current).fields as JsonObject).work = field;
    assert.equal(confirmedSource(current), false);
  }
});

test("preview uses confirmed field values without exposing full threads, quotes or inferred skills", () => {
  const current = state("capability");
  current.turns.push({ id: "turn-private", requestId: "request-private", question: "私有聊天内容", answer: "私有AI回复", analysisContext: "附件全量私有内容", attachments: [], provider: "qwen", model: "qwen-test", promptVersion: "test", createdAt: now });
  const preview = suggestMatchingDraft(current);
  assert.match(preview.summary, /只参与文档整理，不是项目负责人/u);
  assert.match(preview.summary, /没有做前端开发/u);
  assert.deepEqual(preview.skills, []);
  assert.deepEqual(preview.requiredSkills, []);
  assert.equal(preview.workMode, "any");
  assert.doesNotMatch(JSON.stringify(preview), /私有|sourceId|user:synthetic/u);
  flow(current).status = "ready";
  assert.equal(suggestMatchingDraft(current).summary, "");
});

test("preview redacts common private contact values and secrets before presenting the proposed public text", () => {
  const current = state();
  (flow(current).fields as JsonObject).work = providedField(current, "test", "请联系 sample@example.test，电话 13800138000，凭证 sk-this-is-synthetic-test-only");
  const preview = suggestMatchingDraft(current);
  assert.doesNotMatch(preview.summary, /sample@example|13800138000|sk-this/u);
  assert.match(preview.summary, /请移除/u);
});

test("publication validates controlled job tags, kind-specific requirements and honest constraints", () => {
  assert.deepEqual(validateMatchingDraft("problem", draft()), draft());
  const invalid: Partial<MatchingDraft>[] = [
    { skills: [] }, { skills: ["知识库", "知识库"] }, { skills: ["男性"] },
    { requiredSkills: ["后端开发"] }, { requiredSkills: ["知识库", "知识库"] },
    { title: " " }, { summary: "短" }, { title: "长".repeat(61) }, { notes: "长".repeat(201) },
    { workMode: "onsite", location: "" }, { workMode: "hybrid", location: "" },
    { workMode: "any", location: "北京、上海" }, { workMode: "constructor" as MatchingDraft["workMode"] },
  ];
  for (const change of invalid) assert.throws(() => validateMatchingDraft("problem", draft(change)), MatchingValidationError);
  assert.throws(() => validateMatchingDraft("capability", draft({ requiredSkills: ["知识库"] })), MatchingValidationError);
  assert.deepEqual(validateMatchingDraft("problem", draft({ requiredSkills: ["知识库"] })).requiredSkills, ["知识库"]);
});

test("public fields reject common contacts and secrets, while ordinary monetary figures remain allowed", () => {
  for (const contact of ["person@example.test", "https://example.test/private", "138 0013 8000", "+44 7700 900123", "微信号：my_private_contact", "sk-synthetic-test-token-value"]) {
    assert.throws(() => validateMatchingDraft("problem", draft({ notes: contact })), MatchingValidationError);
  }
  assert.equal(validateMatchingDraft("problem", draft({ notes: "预算 100000 元，需另行协商。" })).notes, "预算 100000 元，需另行协商。");
});

test("same evidence gives bilateral results, with reasons but no made-up fit probabilities", () => {
  const project = listing("problem", "project-1");
  const talent = listing("capability", "talent-1");
  const clientResult = rankMatches(project, [talent])[0]!;
  const talentResult = rankMatches(talent, [project])[0]!;
  assert.deepEqual(clientResult.sharedSkills, talentResult.sharedSkills);
  assert.equal(clientResult.listing.id, talent.id);
  assert.equal(talentResult.listing.id, project.id);
  assert.match(clientResult.reasons.join(" "), /知识库、智能问答/u);
  assert.match(clientResult.gaps.join(" "), /未经平台独立验证/u);
  assert.match(clientResult.gaps.join(" "), /预算、报酬、开始时间/u);
  assert.equal("score" in clientResult, false);
  assert.deepEqual(rankMatches(project, []), []);
});

test("exclude same side, self, no related skills, missing required skills and explicit constraint conflicts", () => {
  const project = listing("problem", "project-1", { requiredSkills: ["智能问答"], workMode: "onsite", location: "上海" });
  const cases = [
    listing("problem", "other-project"), listing("capability", project.id),
    listing("capability", "unrelated", { skills: ["UI设计"] }),
    listing("capability", "missing-required", { skills: ["知识库"], workMode: "onsite", location: "上海" }),
    listing("capability", "remote", { workMode: "remote" }),
    listing("capability", "hybrid", { workMode: "hybrid", location: "上海" }),
    listing("capability", "engagement", { engagement: "full_time", workMode: "onsite", location: "上海" }),
    listing("capability", "different-city", { workMode: "onsite", location: "北京" }),
  ];
  assert.deepEqual(rankMatches(project, cases), []);
  for (const item of cases.filter((item) => item.kind === "capability")) assert.deepEqual(rankMatches(item, [project]), []);
});

test("unknown constraints are transparent and are not claimed to satisfy a condition", () => {
  const project = listing("problem", "project", { workMode: "onsite", location: "上海", notes: "每周到场讨论" });
  const talent = listing("capability", "talent", { skills: ["知识库"], workMode: "any", engagement: "any" });
  const [match] = rankMatches(project, [talent]);
  assert.ok(match);
  assert.deepEqual(match.missingSkills, ["智能问答"]);
  assert.equal(match.reasons.length, 1);
  assert.match(match.gaps.join(" "), /办公方式尚有一方选择可协商/u);
  assert.match(match.gaps.join(" "), /现场合作城市尚未明确/u);
  assert.match(match.gaps.join(" "), /补充条件仅作展示/u);
  assert.match(match.gaps.join(" "), /不代表不具备/u);
  const sameCity = rankMatches(project, [listing("capability", "same-city", { workMode: "onsite", location: "上海市" })]);
  assert.equal(sameCity.length, 1);
  assert.match(sameCity[0]!.reasons.join(" "), /现场合作城市一致/u);
  const negotiableCity = rankMatches(project, [{ ...talent, location: "北京" }]);
  assert.equal(negotiableCity.length, 1);
  assert.match(negotiableCity[0]!.gaps.join(" "), /不代表已接受异地合作/u);
  assert.doesNotMatch(negotiableCity[0]!.reasons.join(" "), /城市一致/u);
});

test("ranking is deterministic and unaffected by free text, popularity, demographic data or duplicate records", () => {
  const source = listing("problem", "project");
  const full = listing("capability", "a", { notes: "开始时间需确认" });
  const partial = listing("capability", "b", { skills: ["知识库"] });
  const uncertain = listing("capability", "c", { workMode: "any", engagement: "any" });
  const original = rankMatches(source, [uncertain, partial, full, full]);
  assert.deepEqual(original.map(({ listing: item }) => item.id), ["a", "c", "b"]);
  const changed = rankMatches(source, [partial, { ...full, title: "Any gender, age, school or nationality", summary: "身份不参与排序", updatedAt: "2099-01-01" }, uncertain]);
  assert.deepEqual(changed.map(({ listing: item }) => item.id), ["a", "c", "b"]);
});

test("candidate serialization strips owner identity, source references, status and unknown sensitive fields", () => {
  const record: MatchingListingRecord & { contact: string; email: string; transcript: string } = {
    ...listing("capability", "talent"), sourceThreadId: "private-thread", sourceThreadVersion: 3,
    ownerUserId: "private-owner", status: "published", active: true, contact: "private-contact", email: "private-email", transcript: "private-chat",
  };
  const serialized = JSON.stringify(publicListing(record));
  assert.doesNotMatch(serialized, /private|sourceThread|ownerUser|active|status/u);
  const owned = ownedListing(record);
  assert.equal(owned.sourceThreadId, "private-thread");
  assert.doesNotMatch(JSON.stringify(owned), /private-owner|private-contact|private-email|private-chat/u);
});

test("curated guidance has traceable primary sources without claiming user facts", () => {
  const ai = getDiscoveryGuidance("problem", "建设 RAG 知识库，降低客服问答错误");
  assert.ok(ai.some((entry) => entry.id === "ai-knowledge"));
  const global = getDiscoveryGuidance("capability", "我负责德国海外市场调研和渠道伙伴筛选");
  assert.ok(global.some((entry) => entry.domain === "global"));
  const sources = new Set(KNOWLEDGE_SOURCES.map((source) => source.url));
  for (const entry of [...ai, ...global, ...getDiscoveryGuidance("problem", "帮助整理流程")]) {
    assert.ok(entry.questions.length > 0); assert.ok(entry.evidenceChecks.length > 0);
    assert.ok(entry.sourceUrls.every((url) => sources.has(url as typeof KNOWLEDGE_SOURCES[number]["url"])));
  }
});

test("skill suggestions retain explicit affirmative work evidence and exclude negation, interests, and others' work", () => {
  const text = "我负责知识库和 RAG 检索，没有做模型微调和前端开发。我做过模型评估，想学习模型部署。我写 SEO 内容，同事负责广告投放。文案发在 Shopify。";
  const signals = inferDomainSignals(text).skills;
  assert.deepEqual(signals.map((item) => item.skill), ["知识库", "RAG检索", "模型评估", "SEO优化"]);
  assert.ok(signals.every((item) => text.includes(item.quote)));
  assert.deepEqual(inferDomainSignals("我用过AI，并没有负责知识库，也不会 RAG，I did not do fine tuning").skills, []);
  assert.deepEqual(inferDomainSignals("RAG 不熟悉，模型评估没有经验，广告投放由同事负责").skills, []);
  assert.deepEqual(inferDomainSignals("团队负责RAG，我只写文档，广告投放不归我负责").skills, []);
});

test("confirmed evidence pre-fills editable skills and unambiguous cooperation while unknown facts remain empty", () => {
  const current = state("problem");
  const fields = flow(current).fields as JsonObject;
  const provided = (value: string) => providedField(current, "test", value);
  fields.work = provided("搭建知识库和 RAG，开展模型评估；不需要模型微调");
  fields.constraints = provided("远程办公，项目合作，每周至少20小时，预算：30000-50000元/项目。工作语言：英语。目标市场：新加坡。");
  const suggestion = suggestMatchingDraft(current);
  assert.deepEqual(suggestion.skills, ["知识库", "RAG检索", "模型评估"]);
  assert.deepEqual(suggestion.requiredSkills, []);
  assert.equal(suggestion.workMode, "remote"); assert.equal(suggestion.engagement, "project");
  assert.equal(suggestion.constraints?.budgetMin, 30000); assert.equal(suggestion.constraints?.budgetMax, 50000);
  assert.equal(suggestion.constraints?.budgetCurrency, "CNY"); assert.equal(suggestion.constraints?.budgetPeriod, "project");
  assert.equal(suggestion.constraints?.weeklyHours, 20);
  assert.deepEqual(suggestion.constraints?.languages, ["英语"]);
  const evidence = suggestMatchingEvidence(current);
  assert.ok(evidence.some((item) => item.field === "skills" && item.value === "RAG检索" && item.quote.includes("RAG")));
  assert.doesNotMatch(JSON.stringify(evidence), /sourceId|user:test/u);
  fields.constraints = provided("不接受远程办公，只接受全职，预算未定，不要求英语。");
  const uncertain = suggestMatchingDraft(current);
  assert.equal(uncertain.workMode, "any"); assert.equal(uncertain.engagement, "full_time");
  assert.equal(uncertain.constraints?.budgetMax ?? null, null);
});

test("structured constraints validate date, amount, hours, synonyms and public privacy", () => {
  const constraints = { ...emptyMatchingConstraints(), languages: ["英语"], budgetMin: 12000, budgetMax: 18000, budgetCurrency: "CNY" as const, budgetPeriod: "month" as const, weeklyHours: 12, availableFrom: "2026-10-01" };
  assert.deepEqual(validateMatchingDraft("problem", draft({ constraints })).constraints, constraints);
  for (const patch of [{ budgetMin: 19000 }, { weeklyHours: 169 }, { budgetMax: Number.NaN }, { availableFrom: "2026-02-30" }, { languages: ["英语", "English"] }, { markets: ["person@example.test"] }]) {
    assert.throws(() => validateMatchingDraft("problem", draft({ constraints: { ...constraints, ...patch } })), MatchingValidationError);
  }
});

test("natural confirmed statements pre-fill market, mandatory language, range and dates without labelled forms", () => {
  const current = state("problem"); const fields = flow(current).fields as JsonObject;
  const provided = (value: string) => providedField(current, "natural", value);
  fields.context = provided("我们准备进入德国市场，向工业客户销售设备。");
  fields.work = provided("需要海外市场调研和渠道拓展，能用英语商务沟通，德语加分。");
  fields.collaboration = provided("可以远程项目合作。");
  fields.constraints = provided("预算3万到5万元人民币，每周至少20小时，最晚2026年10月1日开始。");
  const suggestion = suggestMatchingDraft(current);
  assert.equal(suggestion.workMode, "remote"); assert.equal(suggestion.engagement, "project");
  assert.deepEqual(suggestion.constraints?.markets, ["德国"]);
  assert.deepEqual(suggestion.constraints?.languages, ["英语"]);
  assert.equal(suggestion.constraints?.budgetMin, 30000); assert.equal(suggestion.constraints?.budgetMax, 50000);
  assert.equal(suggestion.constraints?.budgetPeriod, "project");
  assert.equal(suggestion.constraints?.availableFrom, "2026-10-01");
  const evidence = suggestMatchingEvidence(current);
  assert.ok(evidence.some((item) => item.field === "constraints.markets" && item.quote.includes("德国")));
  assert.ok(evidence.some((item) => item.field === "constraints.budgetPeriod" && item.quote.includes("项目合作")));
  assert.equal(evidence.some((item) => item.field === "constraints.languages" && item.value === "德语"), false);
});

test("budget, hours, start date, market and language hard conflicts exclude bilaterally", () => {
  const required = { ...emptyMatchingConstraints(), languages: ["English"], markets: ["美国"], budgetMin: 10000, budgetMax: 20000, budgetCurrency: "CNY" as const, budgetPeriod: "month" as const, weeklyHours: 20, availableFrom: "2026-10-01" };
  const source = listing("problem", "source", { constraints: required });
  const talent = listing("capability", "talent", { constraints: { ...required, languages: ["英语"], markets: ["USA"], budgetMin: 15000, budgetMax: 24000, weeklyHours: 24, availableFrom: "2026-09-15" } });
  const aligned = rankMatches(source, [talent])[0]!;
  assert.equal(aligned.readiness, "conditions_aligned");
  assert.match(aligned.reasons.join(" "), /工作语言覆盖|每周可投入 24/u);
  for (const patch of [{ budgetMin: 21000 }, { weeklyHours: 12 }, { availableFrom: "2026-10-02" }, { markets: ["英国"] }, { languages: ["中文"] }, { markets: ["美国加拿大"] }]) {
    const incompatible = { ...talent, constraints: { ...talent.constraints!, ...patch } };
    assert.deepEqual(rankMatches(source, [incompatible]), []);
    assert.deepEqual(rankMatches(incompatible, [source]), []);
  }
});

test("missing facts and incompatible budget units never appear as known matches", () => {
  const source = listing("problem", "source", { constraints: { ...emptyMatchingConstraints(), markets: ["日本"], languages: ["日语"], budgetMax: 10000, budgetCurrency: "CNY", budgetPeriod: "month", weeklyHours: 20 } });
  const unknown = listing("capability", "unknown", { constraints: { ...emptyMatchingConstraints(), budgetMin: 999999, budgetCurrency: "USD", budgetPeriod: "hour" } });
  const result = rankMatches(source, [unknown])[0]!;
  assert.equal(result.readiness, "needs_confirmation");
  assert.match(result.gaps.join(" "), /人才尚未列明市场经验|未自动换汇/u);
  assert.doesNotMatch(result.reasons.join(" "), /预算.*相容|市场经验覆盖/u);
  assert.ok(result.followUpQuestions.some((question) => question.includes("日本")));
});

test("all synthetic pairs are valid and mutually discoverable with explicit no-contact metadata", () => {
  assert.equal(MATCHING_EXAMPLES.length, 22);
  const catalog = MATCHING_EXAMPLES.map((entry) => ({ ...validateMatchingDraft(entry.kind, entry.draft), id: entry.id, kind: entry.kind, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), isExample: true, exampleDomain: entry.domain, contactable: false }));
  for (const item of catalog) {
    assert.match(item.summary, /虚构/u);
    assert.match(item.notes, /不提供联系/u);
    const results = rankMatches(item, catalog);
    assert.ok(results.length > 0, item.id);
    assert.ok(results.every((result) => result.listing.isExample && result.listing.contactable === false));
    assert.ok(results.every((result) => result.gaps.some((gap) => gap.includes("虚构设定"))));
    assert.ok(results.every((result) => !result.gaps.some((gap) => gap.includes("由用户自行填写"))));
  }
});

test("recorded synthetic Qwen artifacts become useful matching drafts through scoped work-action mappings", () => {
  const expected: Record<string, string[]> = {
    "ai-rag-demand": ["知识库", "RAG检索", "智能问答", "模型评估"],
    "ai-agent-demand": ["流程自动化", "AI智能体", "系统集成"],
    "global-b2b-demand": ["海外市场调研", "海外获客"],
    "global-content-demand": ["内容本地化", "内容创作", "SEO优化"],
    "ai-rag-capability": ["后端开发", "知识库", "RAG检索", "模型评估", "数据治理"],
    "ai-agent-capability": ["流程自动化", "系统集成"],
    "global-b2b-capability": ["海外市场调研", "海外获客"],
    "global-content-capability": ["内容创作", "SEO优化", "内容本地化"],
  };
  const examples = MATCHING_EXAMPLES.map((entry) => ({ ...entry.draft, id: entry.id, kind: entry.kind, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), isExample: true, contactable: false }));
  for (const fixture of MATCHING_PROVIDER_FIXTURES) {
    const current = state(fixture.kind);
    (flow(current) as JsonObject).fields = Object.fromEntries(Object.entries(fixture.fields).map(([key, value]) => [key, providedField(current, "provider-fixture", value)]));
    const suggestion = suggestMatchingDraft(current);
    for (const skill of expected[fixture.id]!) assert.ok(suggestion.skills.includes(skill), `${fixture.id}: missing ${skill}; got ${suggestion.skills.join("、")}`);
    if (fixture.id.startsWith("global-content")) {
      assert.ok(!suggestion.skills.includes("广告投放")); assert.ok(!suggestion.skills.includes("跨境电商"));
    }
    const matches = rankMatches({ ...suggestion, id: `source-${fixture.id}`, kind: fixture.kind, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() }, examples);
    assert.ok(matches.length > 0, `${fixture.id} must have a relevant example without relaxing hard constraints`);
  }
  assert.deepEqual(inferDomainSignals("做市场调研与客户画像", "一家国内社区杂货店").skills, []);
  assert.deepEqual(inferDomainSignals("先不投 Google Ads，不接 CRM 接口，只在 Shopify 写文案", "AI 项目").skills, []);
  assert.deepEqual(inferDomainSignals("同事负责市场调研，B2B客户开发不归我负责", "德国市场").skills, []);
});

test("explicit language labels do not turn optional languages or alternatives into requirements", () => {
  const current = state(); const fields = flow(current).fields as JsonObject;
  const provided = (value: string) => providedField(current, "labels", value);
  fields.constraints = provided("工作语言：英语，德语加分。目标市场：美国、USA。");
  const suggestion = suggestMatchingDraft(current);
  assert.deepEqual(suggestion.constraints?.languages, ["英语"]); assert.deepEqual(suggestion.constraints?.markets, ["美国"]);
  fields.constraints = provided("工作语言：英语或日语。目标市场：美国或加拿大。");
  assert.deepEqual(suggestMatchingDraft(current).constraints?.languages ?? [], []);
  assert.deepEqual(suggestMatchingDraft(current).constraints?.markets ?? [], []);
});

test("legacy confirmed model expansions cannot seed skills, conditions or public summary beyond grounded quotations", () => {
  const current = state("problem"); const fields = flow(current).fields as JsonObject;
  fields.work = { ...providedField(current, "legacy-user", "整理知识库"), value: "整理知识库，构建 RAG 检索、模型评估并通过 Slack 和 Gmail 接入 CRM 实现系统集成。" };
  fields.constraints = { ...providedField(current, "legacy-user", "预算和办公方式暂未确定。"), value: "远程项目合作，预算30000元/项目，每周至少20小时。工作语言：英语。目标市场：德国。" };
  const before = structuredClone(current.artifact!.draft);
  const suggestion = suggestMatchingDraft(current);
  assert.deepEqual(suggestion.skills, ["知识库"]);
  assert.equal(suggestion.workMode, "any"); assert.equal(suggestion.engagement, "any");
  assert.deepEqual(suggestion.constraints?.markets ?? [], []); assert.deepEqual(suggestion.constraints?.languages ?? [], []);
  assert.equal(suggestion.constraints?.budgetMax ?? null, null); assert.equal(suggestion.constraints?.weeklyHours ?? null, null);
  assert.doesNotMatch(suggestion.summary, /Slack|Gmail|CRM|系统集成|RAG|模型评估/u);
  assert.doesNotMatch(JSON.stringify(suggestMatchingEvidence(current)), /Slack|Gmail|CRM|30000|20/u);
  assert.deepEqual(current.artifact!.draft, before, "Legacy persisted artifacts remain unchanged.");
});

test("matching evidence must occur in the named user or attachment source, never assistant output or another turn", () => {
  const current = state("capability"); const fields = flow(current).fields as JsonObject;
  current.turns.push({ id: "turn-material", requestId: "material", question: "补充脱敏材料。", answer: "我完成模型微调和模型部署。", analysisContext: "私有材料前言。本人负责 RAG 检索。私有材料附录。", attachments: [], provider: "qwen", model: "fixture", promptVersion: "test.v2", createdAt: now });
  fields.actions = { value: "本人负责 RAG 检索、模型微调和模型部署", status: "provided", evidence: [
    { sourceId: "attachment:material", quote: "本人负责 RAG 检索。" },
    { sourceId: "user:material", quote: "我完成模型微调和模型部署。" },
    { sourceId: "user:wrong-turn", quote: "本人负责 RAG 检索。" },
  ] };
  let suggestion = suggestMatchingDraft(current);
  assert.deepEqual(suggestion.skills, ["RAG检索"]);
  assert.doesNotMatch(suggestion.summary, /私有材料|模型微调|模型部署/u);
  fields.actions = { value: "本人负责 RAG 检索", status: "provided", evidence: [{ sourceId: "user:material", quote: "本人负责 RAG 检索。" }] };
  suggestion = suggestMatchingDraft(current);
  assert.deepEqual(suggestion.skills, [], "Attachment text is not evidence for a user-message source ID.");
  current.turns = [];
  assert.deepEqual(suggestMatchingDraft(current).skills, [], "Missing historical sources fail closed for automatic suggestions.");
});

test("physical work requirements stay binding and request a city instead of turning negotiable", () => {
  const current = state("problem"); const fields = flow(current).fields as JsonObject;
  for (const [text, expected] of [["需要现场办公，项目合作。", "onsite"], ["只接受混合办公，项目合作。", "hybrid"]] as const) {
    fields.constraints = providedField(current, "physical", text);
    const suggestion = suggestMatchingDraft(current);
    assert.equal(suggestion.workMode, expected); assert.equal(suggestion.location, "");
    assert.throws(() => validateMatchingDraft("problem", suggestion), (error: unknown) => error instanceof MatchingValidationError && error.userMessage.includes("合作城市"));
  }
  fields.constraints = providedField(current, "physical", "工作地点：上海，现场办公，项目合作。");
  let suggestion = suggestMatchingDraft(current);
  assert.equal(suggestion.workMode, "onsite"); assert.equal(suggestion.location, "上海");
  assert.equal(validateMatchingDraft("problem", suggestion).location, "上海");
  assert.ok(suggestMatchingEvidence(current).some((item) => item.field === "location" && item.quote === "工作地点：上海"));
  fields.constraints = providedField(current, "physical", "上海驻场，项目合作。");
  suggestion = suggestMatchingDraft(current);
  assert.equal(suggestion.workMode, "onsite"); assert.equal(suggestion.location, "上海");
  fields.context = providedField(current, "physical", "过去在上海驻场，客户总部在北京。");
  fields.constraints = providedField(current, "physical", "需要现场办公，项目合作。");
  assert.equal(suggestMatchingDraft(current).location, "", "A previous project location is not a current work requirement.");
  fields.constraints = providedField(current, "physical", "需要现场办公，工作地点：上海或北京。");
  assert.equal(suggestMatchingDraft(current).location, "", "Alternative cities require the user to choose a supported single city.");
});

test("legacy partial quotations recover omitted negation and other-person attribution before proposing skills", () => {
  const current = state("capability"); const fields = flow(current).fields as JsonObject;
  const cases = [
    { source: "我没有做过模型微调，只负责资料整理。", quote: "模型微调", forbidden: "模型微调", context: "没有做过模型微调" },
    { source: "广告投放由同事负责，我只整理文档。", quote: "广告投放", forbidden: "广告投放", context: "由同事负责" },
    { source: "同事负责 RAG 检索，我只参与内容整理。", quote: "RAG 检索", forbidden: "RAG检索", context: "同事负责" },
    { source: "团队负责模型部署，我负责资料整理。", quote: "模型部署", forbidden: "模型部署", context: "团队负责" },
    { source: "模型微调由团队负责，我没有参与开发。", quote: "模型微调", forbidden: "模型微调", context: "由团队负责" },
    { source: "RAG 我也没做过，只负责资料整理。", quote: "RAG", forbidden: "RAG检索", context: "我也没做过" },
  ];
  for (const [index, item] of cases.entries()) {
    const requestId = `partial-${index}`;
    providedField(current, requestId, item.source);
    fields.role = { value: item.quote, status: "provided", evidence: [{ sourceId: `user:${requestId}`, quote: item.quote }] };
    fields.actions = providedField(current, `own-action-${index}`, "我只负责资料整理。");
    const before = structuredClone(current.artifact!.draft);
    const suggestion = suggestMatchingDraft(current);
    assert.ok(!suggestion.skills.includes(item.forbidden), item.source);
    assert.ok(suggestion.summary.includes(item.context), `${item.source}: necessary context must remain visible`);
    assert.deepEqual(current.artifact!.draft, before);
  }
  const own = "我负责 RAG 检索，模型微调由同事负责。";
  providedField(current, "partial-positive", own);
  fields.role = { value: "RAG 检索", status: "provided", evidence: [{ sourceId: "user:partial-positive", quote: "RAG 检索" }] };
  assert.ok(suggestMatchingDraft(current).skills.includes("RAG检索"), "A supported own contribution stays usable.");
});
