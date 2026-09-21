import { ApiError, apiRequest } from "./api";
import type { DiscoveryKind } from "./discoveryFlow";

export type WorkMode = "any" | "remote" | "onsite" | "hybrid";
export type Engagement = "any" | "project" | "part_time" | "full_time";
export type MatchingConstraints = {
  markets: string[];
  languages: string[];
  budgetMin: number | null;
  budgetMax: number | null;
  budgetCurrency: "CNY" | "USD" | "EUR" | null;
  budgetPeriod: "project" | "month" | "hour" | null;
  weeklyHours: number | null;
  availableFrom: string;
};
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
export type OwnedMatchingListing = MatchingListing & {
  sourceThreadId: string;
  sourceThreadVersion: number;
  status: "published" | "withdrawn";
  active: boolean;
};
export type MatchingState = {
  kind: DiscoveryKind;
  source: { threadId: string; version: number; confirmed: boolean } | null;
  listing: OwnedMatchingListing | null;
  suggestion: MatchingDraft;
  skills: string[];
  workModes: Record<WorkMode, string>;
  engagements: Record<Engagement, string>;
  suggestionEvidence?: Array<{ field: string; value: string; quote: string }>;
  knowledgeSources?: Array<{ id: string; title: string; url: string }>;
};
export type MatchingResult = {
  listing: MatchingListing;
  sharedSkills: string[];
  missingSkills: string[];
  reasons: string[];
  gaps: string[];
  readiness?: "needs_confirmation" | "conditions_aligned";
  followUpQuestions?: string[];
};
export type MatchingResults = {
  matches: MatchingResult[];
  total: number;
  catalogLimited: boolean;
  algorithm: "confirmed-skills-v1" | "evidence-skills-v2";
  catalog?: "examples";
  notice?: string;
};

export type MatchingDraftRecovery = {
  draft: MatchingDraft;
  base: { threadId: string | null; sourceVersion: number; listingVersion: number };
};

export function readMatchingDraft(storage: Pick<Storage, "getItem">, key: string): MatchingDraftRecovery | null {
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > 24_000) return null;
    const value = record(JSON.parse(raw));
    const base = record(value.base);
    return {
      draft: draft(value.draft),
      base: { threadId: base.threadId === null ? null : string(base.threadId), sourceVersion: number(base.sourceVersion), listingVersion: number(base.listingVersion) },
    };
  } catch {
    return null;
  }
}

export function writeMatchingDraft(storage: Pick<Storage, "setItem" | "removeItem">, key: string, value: MatchingDraftRecovery | null) {
  try {
    if (value) storage.setItem(key, JSON.stringify(value));
    else storage.removeItem(key);
  } catch {
    // The current editor stays available when browser storage is disabled.
  }
}

export function emptyMatchingConstraints(): MatchingConstraints {
  return { markets: [], languages: [], budgetMin: null, budgetMax: null, budgetCurrency: null, budgetPeriod: null, weeklyHours: null, availableFrom: "" };
}

function publicConstraints(value: MatchingConstraints | undefined): MatchingConstraints {
  const current = value ?? emptyMatchingConstraints();
  return { ...current, markets: current.markets.map((item) => item.trim()).filter(Boolean), languages: current.languages.map((item) => item.trim()).filter(Boolean) };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}
function invalidResponse() {
  return new ApiError("匹配数据暂时无法读取，请重新加载。", 0, "INVALID_MATCHING_RESPONSE");
}
function string(value: unknown): string {
  if (typeof value !== "string") throw invalidResponse();
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) throw invalidResponse();
  return [...value];
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidResponse();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalidResponse();
  return value;
}
function kind(value: unknown): DiscoveryKind {
  if (value !== "problem" && value !== "capability") throw invalidResponse();
  return value;
}
function constraints(value: unknown): MatchingConstraints {
  if (value === undefined) return emptyMatchingConstraints();
  const data = record(value);
  const amount = (value: unknown) => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalidResponse();
    return value;
  };
  if (![null, "CNY", "USD", "EUR"].includes(data.budgetCurrency as string | null)
    || ![null, "project", "month", "hour"].includes(data.budgetPeriod as string | null)) throw invalidResponse();
  return { markets: strings(data.markets), languages: strings(data.languages), budgetMin: amount(data.budgetMin), budgetMax: amount(data.budgetMax), budgetCurrency: data.budgetCurrency as MatchingConstraints["budgetCurrency"], budgetPeriod: data.budgetPeriod as MatchingConstraints["budgetPeriod"], weeklyHours: amount(data.weeklyHours), availableFrom: string(data.availableFrom) };
}
function draft(value: unknown): MatchingDraft {
  const data = record(value);
  if (!["any", "remote", "onsite", "hybrid"].includes(String(data.workMode))
    || !["any", "project", "part_time", "full_time"].includes(String(data.engagement))) throw invalidResponse();
  return {
    title: string(data.title), summary: string(data.summary), skills: strings(data.skills), requiredSkills: strings(data.requiredSkills),
    workMode: data.workMode as WorkMode, engagement: data.engagement as Engagement,
    location: string(data.location), notes: string(data.notes),
    constraints: constraints(data.constraints),
  };
}
function listing(value: unknown): MatchingListing {
  const data = record(value);
  return { ...draft(data), id: string(data.id), kind: kind(data.kind), version: number(data.version), createdAt: string(data.createdAt), updatedAt: string(data.updatedAt), ...(data.isExample === true ? { isExample: true } : {}), ...(typeof data.exampleDomain === "string" ? { exampleDomain: data.exampleDomain } : {}), ...(typeof data.contactable === "boolean" ? { contactable: data.contactable } : {}) };
}
function ownedListing(value: unknown): OwnedMatchingListing | null {
  if (value === null) return null;
  const data = record(value);
  if (data.status !== "published" && data.status !== "withdrawn") throw invalidResponse();
  return {
    ...listing(data), sourceThreadId: string(data.sourceThreadId), sourceThreadVersion: number(data.sourceThreadVersion),
    status: data.status, active: boolean(data.active),
  };
}

export function matchingDraftFrom(state: MatchingState): MatchingDraft {
  const value = state.listing?.active ? state.listing : state.suggestion;
  // Public fields only. Never spread an owner listing or the private AI artifact into a publish request.
  return {
    title: value.title, summary: value.summary, skills: [...value.skills], requiredSkills: state.kind === "problem" ? [...value.requiredSkills] : [],
    workMode: value.workMode, engagement: value.engagement, location: value.location, notes: value.notes,
    constraints: { ...(value.constraints ?? emptyMatchingConstraints()), markets: [...(value.constraints?.markets ?? [])], languages: [...(value.constraints?.languages ?? [])] },
  };
}

export async function loadMatchingState(signal?: AbortSignal): Promise<MatchingState> {
  const data = record(await apiRequest<unknown>("/me/matching", { signal }));
  const source = data.source === null ? null : record(data.source);
  const workModes = record(data.workModes);
  const engagements = record(data.engagements);
  return {
    kind: kind(data.kind), source: source ? { threadId: string(source.threadId), version: number(source.version), confirmed: boolean(source.confirmed) } : null,
    listing: ownedListing(data.listing), suggestion: draft(data.suggestion), skills: strings(data.skills),
    workModes: { any: string(workModes.any), remote: string(workModes.remote), onsite: string(workModes.onsite), hybrid: string(workModes.hybrid) },
    engagements: { any: string(engagements.any), project: string(engagements.project), part_time: string(engagements.part_time), full_time: string(engagements.full_time) },
    suggestionEvidence: Array.isArray(data.suggestionEvidence) ? data.suggestionEvidence.map((value) => { const item = record(value); return { field: string(item.field), value: string(item.value), quote: string(item.quote) }; }) : [],
    knowledgeSources: Array.isArray(data.knowledgeSources) ? data.knowledgeSources.map((value) => { const item = record(value); return { id: string(item.id), title: string(item.title), url: string(item.url) }; }).filter((item) => /^https:\/\//u.test(item.url)) : [],
  };
}

export async function publishMatchingListing(value: MatchingDraft, state: MatchingState) {
  if (!state.source?.confirmed) throw new ApiError("请先确认保存当前需求或能力档案，再参与匹配。", 409, "MATCHING_SOURCE_UNCONFIRMED");
  const response = record(await apiRequest<unknown>("/me/matching/listing", {
    method: "PUT",
    body: JSON.stringify({
      title: value.title.trim(), summary: value.summary.trim(), skills: value.skills,
      requiredSkills: state.kind === "problem" ? value.requiredSkills : [], workMode: value.workMode,
      engagement: value.engagement, location: value.location.trim(), notes: value.notes.trim(),
      constraints: publicConstraints(value.constraints),
      expectedThreadId: state.source.threadId, expectedVersion: state.source.version,
      expectedListingVersion: state.listing?.version ?? 0, consent: true,
    }),
  }));
  const saved = ownedListing(response.listing);
  if (!saved) throw invalidResponse();
  return saved;
}

export async function withdrawMatchingListing(expectedListingId: string, expectedListingVersion: number) {
  const response = record(await apiRequest<unknown>("/me/matching/withdraw", {
    method: "POST", body: JSON.stringify({ expectedListingId, expectedListingVersion }),
  }));
  return ownedListing(response.listing);
}

export async function loadMatchingResults(signal?: AbortSignal): Promise<MatchingResults> {
  return normalizeMatchingResults(await apiRequest<unknown>("/me/matching/results", { signal }));
}

export async function previewMatchingExamples(value: MatchingDraft, signal?: AbortSignal): Promise<MatchingResults> {
  return normalizeMatchingResults(await apiRequest<unknown>("/me/matching/preview", { method: "POST", body: JSON.stringify({ draft: { ...value, constraints: publicConstraints(value.constraints) } }), signal }));
}

function normalizeMatchingResults(value: unknown): MatchingResults {
  const data = record(value);
  if (!Array.isArray(data.matches) || (data.algorithm !== "confirmed-skills-v1" && data.algorithm !== "evidence-skills-v2")) throw invalidResponse();
  return {
    matches: data.matches.map((value) => {
      const result = record(value);
      return { listing: listing(result.listing), sharedSkills: strings(result.sharedSkills), missingSkills: strings(result.missingSkills), reasons: strings(result.reasons), gaps: strings(result.gaps), ...(result.readiness === "conditions_aligned" || result.readiness === "needs_confirmation" ? { readiness: result.readiness } : {}), ...(Array.isArray(result.followUpQuestions) ? { followUpQuestions: strings(result.followUpQuestions) } : {}) };
    }),
    total: number(data.total), catalogLimited: boolean(data.catalogLimited), algorithm: data.algorithm,
    ...(data.catalog === "examples" ? { catalog: "examples" as const } : {}), ...(typeof data.notice === "string" ? { notice: data.notice } : {}),
  };
}
