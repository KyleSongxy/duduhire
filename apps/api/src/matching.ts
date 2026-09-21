import type { DiscoveryKind, DiscoveryState } from "./domain.js";
import { affirmativeMentions, getDiscoveryGuidance, inferDomainSignals, KNOWLEDGE_SOURCES } from "./domainKnowledge.js";
import { extractNaturalMatchingConditions } from "./naturalMatchingConditions.js";
import { recoverEvidenceContext } from "./evidenceContext.js";

/** Job-related, controlled vocabulary: never rank on identity or protected traits. */
export const MATCHING_SKILLS = [
  "需求分析", "流程自动化", "知识库", "智能问答", "数据分析", "数据可视化",
  "产品设计", "UI设计", "前端开发", "后端开发", "系统集成", "测试验收",
  "内容创作", "市场营销", "客户服务", "人力资源", "财务流程", "项目管理",
  "RAG检索", "AI智能体", "提示词设计", "模型评估", "模型微调", "数据治理", "模型部署",
  "海外市场调研", "出海策略", "海外获客", "广告投放", "SEO优化", "内容本地化", "跨境电商", "渠道拓展", "跨境运营",
] as const;
export const WORK_MODES = { any: "可协商", remote: "远程", onsite: "现场", hybrid: "混合办公" } as const;
export const ENGAGEMENTS = { any: "可协商", project: "项目合作", part_time: "兼职", full_time: "全职" } as const;
export type WorkMode = keyof typeof WORK_MODES;
export type Engagement = keyof typeof ENGAGEMENTS;

export type MatchingConstraints = {
  /** On demands these are required coverage; on talent these are self-reported coverage. */
  markets: string[];
  languages: string[];
  budgetMin: number | null;
  budgetMax: number | null;
  budgetCurrency: "CNY" | "USD" | "EUR" | null;
  budgetPeriod: "project" | "month" | "hour" | null;
  /** Demand: minimum hours/week. Talent: maximum available hours/week. */
  weeklyHours: number | null;
  /** Demand: latest acceptable start; talent: earliest available start. ISO date, or empty. */
  availableFrom: string;
};

export const emptyMatchingConstraints = (): MatchingConstraints => ({
  markets: [], languages: [], budgetMin: null, budgetMax: null, budgetCurrency: null, budgetPeriod: null, weeklyHours: null, availableFrom: "",
});

export type MatchingDraft = {
  title: string;
  summary: string;
  skills: string[];
  requiredSkills: string[];
  workMode: WorkMode;
  engagement: Engagement;
  location: string;
  notes: string;
  constraints?: MatchingConstraints;
};

export type MatchingListing = MatchingDraft & {
  id: string;
  kind: DiscoveryKind;
  version: number;
  createdAt: string;
  updatedAt: string;
  isExample?: boolean;
  exampleDomain?: string;
  contactable?: boolean;
};

/** Owner-only fields must never be serialized into candidate results. */
export type OwnedMatchingListing = MatchingListing & {
  sourceThreadId: string;
  sourceThreadVersion: number;
  status: "published" | "withdrawn";
  active: boolean;
};

export type MatchingListingRecord = OwnedMatchingListing & { ownerUserId: string };
export type PublishMatchingInput = MatchingDraft & {
  expectedThreadId: string;
  expectedVersion: number;
  expectedListingVersion: number;
  consent: true;
};

export type MatchingResult = {
  listing: MatchingListing;
  sharedSkills: string[];
  missingSkills: string[];
  reasons: string[];
  gaps: string[];
  readiness: "needs_confirmation" | "conditions_aligned";
  followUpQuestions: string[];
};

export class MatchingConflictError extends Error {
  constructor() {
    super("Matching source or listing changed.");
    this.name = "MatchingConflictError";
  }
}

export class MatchingValidationError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "MatchingValidationError";
  }
}

export function publicListing(listing: MatchingListing): MatchingListing {
  return {
    id: listing.id, kind: listing.kind, version: listing.version,
    title: listing.title, summary: listing.summary,
    skills: [...listing.skills], requiredSkills: [...listing.requiredSkills],
    workMode: listing.workMode, engagement: listing.engagement,
    location: listing.location, notes: listing.notes,
    createdAt: listing.createdAt, updatedAt: listing.updatedAt,
    ...(listing.constraints ? { constraints: structuredClone(listing.constraints) } : {}),
    ...(listing.isExample === true ? { isExample: true, exampleDomain: listing.exampleDomain, contactable: false } : {}),
  };
}

export function ownedListing(listing: MatchingListingRecord): OwnedMatchingListing {
  return {
    ...publicListing(listing), sourceThreadId: listing.sourceThreadId,
    sourceThreadVersion: listing.sourceThreadVersion, status: listing.status, active: listing.active,
  };
}

export function confirmedSource(state: DiscoveryState | null) {
  const flow = state?.artifact?.draft.flow;
  if (!state || state.thread.status !== "active" || !isRecord(flow)
    || flow.schemaVersion !== 2 || flow.status !== "confirmed"
    || typeof flow.confirmedAt !== "string" || !Number.isFinite(Date.parse(flow.confirmedAt))
    || !isRecord(flow.fields) || state.artifact?.kind !== state.thread.kind) return false;
  const required = state.thread.kind === "problem" ? ["context", "work", "outcome"] : ["situation", "role", "actions", "outcome"];
  return required.every((key) => {
    const field = (flow.fields as Record<string, unknown>)[key];
    return isRecord(field) && field.status === "provided" && typeof field.value === "string" && Boolean(field.value.trim())
      && Array.isArray(field.evidence) && field.evidence.length > 0
      && field.evidence.every((item) => isRecord(item) && typeof item.sourceId === "string" && Boolean(item.sourceId)
        && typeof item.quote === "string" && Boolean(item.quote.trim()));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A best-effort public-text guard, not a guarantee of anonymization. The preview
// and explicit publication consent remain mandatory, including after edits.
const contactPatterns = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
  /(?:https?:\/\/|www\.)[^\s，。；]+/giu,
  /(?<!\d)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?!\d)/gu,
  /\+\d(?:[-\s()]?\d){7,14}(?!\d)/gu,
  /(?<!\d)\d{15,18}[\dX]?(?!\d)/giu,
  /(?:微信(?:号)?|wechat|weixin|联系(?:电话|方式)?|手机号|手机号码?|邮箱|QQ)\s*[:：=]\s*[^\s，。；]+/giu,
  /\b(?:sk-[A-Za-z0-9._-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/giu,
];

function redactPublicText(value: string) {
  const safe = contactPatterns.reduce((text, pattern) => text.replace(pattern, "[请移除联系方式或敏感信息]"), value);
  return Array.from(safe).filter((character) => {
    const code = character.codePointAt(0)!;
    return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
  }).join("");
}

function cleanText(value: unknown, label: string, max: number, min = 0) {
  if (typeof value !== "string") throw new MatchingValidationError(`请填写${label}。`);
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max) throw new MatchingValidationError(`${label}需为 ${min}–${max} 个字符。`);
  const normalized = cleaned.normalize("NFKC");
  if (redactPublicText(normalized) !== normalized) throw new MatchingValidationError("公开内容中疑似包含联系方式、链接或敏感信息，请移除后再发布。");
  return cleaned;
}

export function validateMatchingDraft(kind: DiscoveryKind, draft: MatchingDraft): MatchingDraft {
  const title = cleanText(draft.title, "标题", 60, 2);
  const summary = cleanText(draft.summary, "公开简介", 500, 10);
  const location = cleanText(draft.location, "城市", 60);
  const notes = cleanText(draft.notes, "补充条件", 200);
  const allowed = new Set<string>(MATCHING_SKILLS);
  if (!Array.isArray(draft.skills) || draft.skills.length < 1 || draft.skills.length > 8
    || draft.skills.some((skill) => !allowed.has(skill)) || new Set(draft.skills).size !== draft.skills.length) {
    throw new MatchingValidationError("请选择 1–8 项与工作相关的能力，不要重复选择。");
  }
  if (!Array.isArray(draft.requiredSkills) || draft.requiredSkills.length > 8
    || new Set(draft.requiredSkills).size !== draft.requiredSkills.length
    || draft.requiredSkills.some((skill) => !draft.skills.includes(skill))
    || (kind === "capability" && draft.requiredSkills.length > 0)) {
    throw new MatchingValidationError("必须具备的能力只能由需求方从已选能力中指定。");
  }
  if (!Object.hasOwn(WORK_MODES, draft.workMode) || !Object.hasOwn(ENGAGEMENTS, draft.engagement)) {
    throw new MatchingValidationError("请选择有效的办公方式和合作方式。");
  }
  if (["onsite", "hybrid"].includes(draft.workMode) && !location) throw new MatchingValidationError("现场或混合办公需要填写合作城市。");
  if (/[\n\r/、,，;；|]/u.test(location)) throw new MatchingValidationError("城市请填写一个城市名；地点不限时，请将办公方式设为“可协商”。");
  return {
    title, summary, skills: [...draft.skills], requiredSkills: [...draft.requiredSkills],
    workMode: draft.workMode, engagement: draft.engagement, location, notes,
    ...(draft.constraints ? { constraints: validateMatchingConstraints(draft.constraints) } : {}),
  };
}

function validateMatchingConstraints(value: MatchingConstraints): MatchingConstraints {
  if (!isRecord(value)) throw new MatchingValidationError("请检查补充合作条件。");
  const allowed = new Set(Object.keys(emptyMatchingConstraints()));
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new MatchingValidationError("补充合作条件包含无法识别的字段。");
  const result = { ...emptyMatchingConstraints(), ...value };
  for (const key of ["markets", "languages"] as const) {
    if (!Array.isArray(result[key]) || result[key].length > 8) throw new MatchingValidationError("市场和工作语言各最多填写 8 项。");
    result[key] = result[key].map((entry) => cleanText(entry, key === "markets" ? "目标市场" : "工作语言", 40, 1));
    if (new Set(result[key].map(normalizeCriterion)).size !== result[key].length) throw new MatchingValidationError("市场或语言请勿重复填写。");
  }
  for (const key of ["budgetMin", "budgetMax", "weeklyHours"] as const) {
    const number = result[key];
    if (number !== null && (typeof number !== "number" || !Number.isFinite(number) || number <= 0 || number > (key === "weeklyHours" ? 168 : 1_000_000_000))) {
      throw new MatchingValidationError(key === "weeklyHours" ? "每周投入请填写 0–168 之间的有效小时数。" : "预算请填写有效的正数。");
    }
  }
  if (result.budgetMin !== null && result.budgetMax !== null && result.budgetMin > result.budgetMax) throw new MatchingValidationError("预算下限不能超过上限。");
  if (result.budgetCurrency !== null && !["CNY", "USD", "EUR"].includes(result.budgetCurrency)) throw new MatchingValidationError("请选择支持的预算币种。");
  if (result.budgetPeriod !== null && !["project", "month", "hour"].includes(result.budgetPeriod)) throw new MatchingValidationError("请选择项目、每月或每小时计价。");
  if (typeof result.availableFrom !== "string" || (result.availableFrom !== "" && (!/^\d{4}-\d{2}-\d{2}$/u.test(result.availableFrom)
    || !Number.isFinite(Date.parse(result.availableFrom)) || new Date(result.availableFrom).toISOString().slice(0, 10) !== result.availableFrom))) {
    throw new MatchingValidationError("开始日期请填写有效日期。");
  }
  return result;
}

export type MatchingSuggestionEvidence = { field: string; value: string; quote: string };

/** Old confirmed v2 fields may contain model expansions in value. Only exact,
 * source-bound user/material quotations may seed a new public matching draft. */
function groundedMatchingFields(state: DiscoveryState | null): Record<string, string> {
  if (!confirmedSource(state)) return {};
  const sources = new Map<string, string>();
  for (const turn of state!.turns) {
    sources.set(`user:${turn.requestId}`, turn.question);
    if (turn.analysisContext) sources.set(`attachment:${turn.requestId}`, turn.analysisContext);
  }
  const raw = (state!.artifact!.draft.flow as Record<string, unknown>).fields as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const [key, field] of Object.entries(raw)) {
    if (!isRecord(field) || field.status !== "provided" || !Array.isArray(field.evidence)) continue;
    const quotes = field.evidence.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.sourceId !== "string" || typeof entry.quote !== "string") return [];
      const quote = entry.quote.trim();
      const source = sources.get(entry.sourceId);
      return quote && source?.includes(quote) ? recoverEvidenceContext(source, quote) : [];
    });
    if (quotes.length) fields[key] = [...new Set(quotes)].join("\n");
  }
  return fields;
}

function confirmedMatchingText(state: DiscoveryState | null) {
  if (!confirmedSource(state)) return { skills: "", all: "", conditions: "" };
  const fields = groundedMatchingFields(state);
  const read = (key: string) => fields[key] ?? "";
  // Talent background/outcomes can mention another person's work; only own role/actions propose skills.
  const skillKeys = state!.thread.kind === "problem" ? ["work", "outcome"] : ["role", "actions"];
  return { skills: skillKeys.map(read).filter(Boolean).join("\n"), all: Object.keys(fields).map(read).filter(Boolean).join("\n"), conditions: [read("constraints"), read("preferences"), read("collaboration")].filter(Boolean).join("\n") };
}

function suggestMatchingConditions(state: DiscoveryState | null) {
  const fields = groundedMatchingFields(state);
  const labeled = suggestStructuredConditions(confirmedMatchingText(state).conditions);
  const natural = extractNaturalMatchingConditions(state?.thread.kind ?? "problem", fields);
  const explicit = Object.fromEntries(Object.entries(labeled.constraints).filter(([, value]) => Array.isArray(value) ? value.length > 0 : value !== null && value !== ""));
  const constraints = { ...(natural.constraints ?? emptyMatchingConstraints()), ...explicit };
  const evidence = [
    ...labeled.evidence,
    ...natural.evidence.filter((item) => !item.field.startsWith("constraints.") || !Object.hasOwn(explicit, item.field.slice("constraints.".length))),
  ].map((item) => ({ ...item, quote: redactPublicText(item.quote).slice(0, 160) }));
  return { ...natural, constraints, evidence };
}

export function suggestMatchingEvidence(state: DiscoveryState | null): MatchingSuggestionEvidence[] {
  const text = confirmedMatchingText(state);
  const evidence: MatchingSuggestionEvidence[] = inferDomainSignals(text.skills, text.all).skills.slice(0, 8).map(({ skill, quote }) => ({ field: "skills", value: skill, quote: redactPublicText(quote).slice(0, 160) }));
  for (const [field, candidates] of [
    ["workMode", [["remote", /远程办公|远程合作|全远程|只接受远程|remote work/iu], ["onsite", /现场办公|驻场|到岗办公/iu], ["hybrid", /混合办公|hybrid work/iu]]],
    ["engagement", [["project", /项目合作|按项目合作|按项目交付/iu], ["part_time", /兼职|part[- ]time/iu], ["full_time", /全职|full[- ]time/iu]]],
  ] as const) {
    const values = candidates.flatMap(([value, pattern]) => affirmativeMentions(text.conditions, pattern).map(({ quote }) => ({ field, value, quote: redactPublicText(quote).slice(0, 160) })));
    if (new Set(values.map((item) => item.value)).size === 1 && values[0]) evidence.push(values[0]);
  }
  evidence.push(...suggestMatchingConditions(state).evidence);
  const location = suggestLocationEvidence(text.conditions);
  if (location) evidence.push(location);
  return evidence.filter((item, index) => evidence.findIndex((other) => other.field === item.field && other.value === item.value) === index);
}

function suggestLocationEvidence(text: string): MatchingSuggestionEvidence | null {
  const candidates: MatchingSuggestionEvidence[] = [];
  for (const quote of text.split(/[。\n，,；;]/u).map((value) => value.trim()).filter(Boolean)) {
    if (/不在|不接受|不考虑|不需要|无需|不能|不要|曾经|之前|以前|上一|过去|不限|待定|协商|或|任选|\bnot\b|\bor\b/iu.test(quote)) continue;
    const labelled = quote.match(/(?:工作地点|办公地点|合作城市|工作城市|驻场城市)\s*[:：]\s*([\p{Script=Han}A-Za-z· .-]{2,40})$/u)?.[1]?.trim();
    const physical = quote.match(/(上海|北京|广州|深圳|杭州|苏州|南京|成都|重庆|武汉|天津|西安|厦门|青岛|济南|宁波|无锡|郑州|长沙|合肥|福州|大连|珠海|东莞|佛山|香港|澳门)(?:市)?\s*(?:驻场|现场办公|混合办公|坐班|到岗办公)/u)?.[1];
    const value = physical ?? labelled;
    if (!value || /(?:公司|总部|现场|驻场|办公|工作|项目|居住|合作|需要|接受)/u.test(value)) continue;
    candidates.push({ field: "location", value, quote: redactPublicText(quote).slice(0, 160) });
  }
  return new Set(candidates.map((item) => city(item.value))).size === 1 ? candidates[0]! : null;
}

function suggestStructuredConditions(text: string) {
  const constraints = emptyMatchingConstraints();
  const evidence: MatchingSuggestionEvidence[] = [];
  const add = (field: string, value: string, quote: string) => evidence.push({ field, value, quote: redactPublicText(quote).slice(0, 160) });
  for (const [key, pattern] of [
    ["markets", /(?:目标市场|服务市场|服务过的市场|市场经验|目标地区)\s*[:：]\s*([^\n。；;]+)/iu],
    ["languages", /(?:工作语言|沟通语言|可用语言)\s*[:：]\s*([^\n。；;]+)/iu],
  ] as const) {
    // Delimited labels are intentionally narrow: a city in someone's past job is not a preference.
    const match = text.match(pattern);
    if (match && !/不|未|暂无|待定|协商|不限|没有|或|任选|\bnot\b|\bno\b|\bor\b/iu.test(match[1]!)) {
      constraints[key] = [...new Set(match[1]!.split(/[、,，/]/u).map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= 40 && !/加分|优先|可选|要求|每周|预算|办公|合作|[:：\d]/u.test(item)).map(normalizeCriterion))].slice(0, 8);
      for (const value of constraints[key]) add(`constraints.${key}`, value, match[0]);
    }
  }
  return { constraints, evidence };
}

export function matchingKnowledgeSources(state: DiscoveryState | null) {
  const urls = new Set(getDiscoveryGuidance(state?.thread.kind ?? "problem", confirmedMatchingText(state).all).flatMap((item) => item.sourceUrls));
  return KNOWLEDGE_SOURCES.filter((source) => urls.has(source.url)).map(({ id, title, url }) => ({ id, title, url }));
}

export function suggestMatchingDraft(state: DiscoveryState | null): MatchingDraft {
  const empty: MatchingDraft = { title: "", summary: "", skills: [], requiredSkills: [], workMode: "any", engagement: "any", location: "", notes: "" };
  if (!confirmedSource(state)) return empty;
  const artifact = state!.artifact!.draft;
  const fields = groundedMatchingFields(state);
  const kind = state!.thread.kind;
  const keys = kind === "problem" ? [["work", "主要工作"], ["outcome", "预期结果"]] : [["role", "本人职责"], ["actions", "具体行动"], ["outcome", "实际结果"]];
  const summary = keys.map(([key, label]) => {
    const field = fields[key!];
    return field ? `${label}：${field}` : "";
  }).filter(Boolean).join("\n");
  const title = kind === "problem" ? artifact.profile : artifact.capabilityIdentity;
  const evidence = suggestMatchingEvidence(state);
  const workMode = evidence.find((item) => item.field === "workMode")?.value as WorkMode | undefined;
  const engagement = evidence.find((item) => item.field === "engagement")?.value as Engagement | undefined;
  const text = confirmedMatchingText(state);
  const structured = suggestMatchingConditions(state);
  return {
    ...empty,
    title: redactPublicText(typeof title === "string" ? title : "").slice(0, 60),
    summary: redactPublicText(summary).slice(0, 500),
    skills: evidence.filter((item) => item.field === "skills").map((item) => item.value),
    // Preserve an explicit physical requirement. Validation asks for a city if absent.
    workMode: workMode ?? "any",
    location: evidence.find((item) => item.field === "location")?.value ?? "",
    engagement: engagement ?? "any",
    notes: redactPublicText(text.conditions).slice(0, 200),
    ...(structured.evidence.length ? { constraints: structured.constraints } : {}),
  };
}

function city(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s/gu, "").replace(/市$/u, "");
}

function normalizeCriterion(value: string) {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
  const aliases: Record<string, string> = {
    english: "英语", 英文: "英语", chinese: "中文", 普通话: "中文", mandarin: "中文", japanese: "日语", 日本语: "日语", german: "德语", french: "法语", spanish: "西班牙语",
    us: "美国", usa: "美国", "united states": "美国", uk: "英国", "united kingdom": "英国", singapore: "新加坡", japan: "日本", germany: "德国", france: "法国", canada: "加拿大", china: "中国", australia: "澳大利亚", "southeast asia": "东南亚", europe: "欧洲", "middle east": "中东",
  };
  return aliases[normalized] ?? normalized;
}

function compareStructuredConditions(problem: MatchingListing, talent: MatchingListing) {
  const required = problem.constraints ?? emptyMatchingConstraints();
  const offered = talent.constraints ?? emptyMatchingConstraints();
  const reasons: string[] = []; const gaps: string[] = []; const questions: string[] = [];
  let conflict = false;
  for (const [key, label] of [["markets", "市场经验"], ["languages", "工作语言"]] as const) {
    if (!required[key].length) continue;
    if (!offered[key].length) {
      gaps.push(`人才尚未列明${label}：${required[key].join("、")}，需要确认。`);
      questions.push(`能否说明你在${required[key].join("、")}方面的${label === "工作语言" ? "实际工作沟通能力" : "相关项目与本人贡献"}？`);
    } else {
      const offeredSet = new Set(offered[key].map(normalizeCriterion));
      if (required[key].some((item) => !offeredSet.has(normalizeCriterion(item)))) conflict = true;
      else reasons.push(`${label}覆盖需求方填写的条件：${required[key].join("、")}（本人自述，待核实）`);
    }
  }
  const demandBudget = required.budgetMin !== null || required.budgetMax !== null;
  const talentBudget = offered.budgetMin !== null || offered.budgetMax !== null;
  if (demandBudget && talentBudget && required.budgetCurrency && required.budgetPeriod
    && required.budgetCurrency === offered.budgetCurrency && required.budgetPeriod === offered.budgetPeriod) {
    if ((required.budgetMax !== null && offered.budgetMin !== null && required.budgetMax < offered.budgetMin)
      || (required.budgetMin !== null && offered.budgetMax !== null && required.budgetMin > offered.budgetMax)) conflict = true;
    else if ((required.budgetMax !== null && offered.budgetMin !== null) || (required.budgetMin !== null && offered.budgetMax !== null)) {
      reasons.push(`所填预算与报价范围可相容：${required.budgetCurrency}，按${{ project: "项目", month: "月", hour: "小时" }[required.budgetPeriod]}计价；具体金额仍需确认。`);
    } else gaps.push("预算只填了同侧上限或下限，尚不能确认金额相容。");
  } else gaps.push("预算或报酬的金额、币种、计价周期尚未齐全一致，未自动换汇或判断相容。");
  if (required.weeklyHours !== null && offered.weeklyHours !== null) {
    if (offered.weeklyHours < required.weeklyHours) conflict = true;
    else reasons.push(`每周可投入 ${offered.weeklyHours} 小时，覆盖需求最低 ${required.weeklyHours} 小时。`);
  } else gaps.push("每周最低投入或可投入时长尚未明确。");
  if (required.availableFrom && offered.availableFrom) {
    if (offered.availableFrom > required.availableFrom) conflict = true;
    else reasons.push(`人才最早 ${offered.availableFrom} 可开始，未晚于需求方最晚 ${required.availableFrom} 的开始日期。`);
  } else gaps.push("开始时间尚未双方明确。");
  return { conflict, reasons, gaps, questions };
}

/** Only user-selected work criteria participate. Free text/PII never affects ordering. */
export function rankMatches(source: MatchingListing, candidates: MatchingListing[]): MatchingResult[] {
  const seen = new Set<string>();
  const ranked: Array<{ result: MatchingResult; knownConditions: number }> = [];
  for (const candidate of candidates) {
    if (candidate.id === source.id || seen.has(candidate.id) || candidate.kind === source.kind) continue;
    seen.add(candidate.id);
    const problem = source.kind === "problem" ? source : candidate;
    const capability = source.kind === "capability" ? source : candidate;
    const sharedSkills = problem.skills.filter((skill) => capability.skills.includes(skill));
    if (sharedSkills.length === 0 || problem.requiredSkills.some((skill) => !capability.skills.includes(skill))) continue;
    if (source.engagement !== "any" && candidate.engagement !== "any" && source.engagement !== candidate.engagement) continue;
    if (source.workMode !== "any" && candidate.workMode !== "any" && source.workMode !== candidate.workMode) continue;
    const hasPhysicalRequirement = [source.workMode, candidate.workMode].some((mode) => mode === "onsite" || mode === "hybrid");
    const bothPhysical = [source.workMode, candidate.workMode].every((mode) => mode === "onsite" || mode === "hybrid");
    const sameCity = Boolean(source.location && candidate.location && city(source.location) === city(candidate.location));
    // A location entered alongside "negotiable" is not a binding refusal to
    // travel/relocate. Keep it explicit as an unknown rather than silently reject.
    if (bothPhysical && source.location && candidate.location && !sameCity) continue;

    const missingSkills = problem.skills.filter((skill) => !capability.skills.includes(skill));
    const conditions = compareStructuredConditions(problem, capability);
    if (conditions.conflict) continue;
    const reasons = [`双方选择的共同能力：${sharedSkills.join("、")}`];
    const gaps: string[] = [];
    let knownConditions = 0;
    if (source.engagement !== "any" && candidate.engagement !== "any") {
      reasons.push(`合作方式一致：${ENGAGEMENTS[source.engagement]}`);
      knownConditions += 1;
    } else gaps.push("合作方式尚有一方选择可协商，需要双方确认。");
    if (source.workMode !== "any" && candidate.workMode !== "any") {
      reasons.push(`办公方式一致：${WORK_MODES[source.workMode]}`);
      knownConditions += 1;
    } else gaps.push("办公方式尚有一方选择可协商，需要双方确认。");
    if (hasPhysicalRequirement) {
      if (sameCity) {
        reasons.push(`现场合作城市一致：${source.location}`);
        knownConditions += 1;
      } else if (source.location && candidate.location) {
        gaps.push("双方填写的城市不同，且一方办公方式可协商；需要确认能否到场，不代表已接受异地合作。");
      } else gaps.push("现场合作城市尚未明确，需要确认到场安排。");
    }
    if (missingSkills.length) gaps.push(`人才公开资料暂未列出：${missingSkills.join("、")}；不代表不具备，需进一步核实。`);
    if (source.notes || candidate.notes) gaps.push("补充条件仅作展示，未自动判断是否相容，请逐项确认。");
    reasons.push(...conditions.reasons);
    knownConditions += conditions.reasons.length;
    if (!problem.constraints && !capability.constraints) gaps.push("预算、报酬、开始时间和可投入时长尚未自动核对。");
    else gaps.push(...conditions.gaps);
    const readiness = gaps.length ? "needs_confirmation" : "conditions_aligned";
    if (candidate.isExample) gaps.push("示例中的经历与能力为虚构设定，只用于体验匹配，不能联系或发起真实合作。");
    else gaps.push("经历与能力由用户自行填写并确认，未经平台独立验证。");
    const followUpQuestions = [...conditions.questions];
    if (missingSkills.length) followUpQuestions.push(`关于${missingSkills.join("、")}，你是否有相关经历或可展示的工作样本？`);
    followUpQuestions.push(`能否展示一个与${sharedSkills.slice(0, 2).join("、")}相关的案例，说明本人职责、交付材料和结果？`);
    if (conditions.gaps.length) followUpQuestions.push("可否一起确认预算计价、开始日期和每周投入时间？");
    ranked.push({ result: { listing: publicListing(candidate), sharedSkills, missingSkills, reasons, gaps, readiness, followUpQuestions: followUpQuestions.slice(0, 3) }, knownConditions });
  }
  ranked.sort((a, b) => b.result.sharedSkills.length - a.result.sharedSkills.length
    || b.knownConditions - a.knownConditions
    || a.result.listing.id.localeCompare(b.result.listing.id, "en"));
  return ranked.map(({ result }) => result);
}
