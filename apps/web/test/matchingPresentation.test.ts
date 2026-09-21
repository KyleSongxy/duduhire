import assert from "node:assert/strict";
import test from "node:test";
import { matchingConditionsSummary } from "../src/matchingPresentation.ts";
import type { MatchingDraft } from "../src/matchingStore.ts";

const workModes = { any: "可协商", remote: "远程", onsite: "现场办公", hybrid: "混合办公" };
const engagements = { any: "可协商", project: "项目合作", part_time: "兼职", full_time: "全职" };
const draft: MatchingDraft = { title: "出海项目", summary: "市场调研", skills: [], requiredSkills: [], workMode: "remote", engagement: "project", location: "", notes: "", constraints: {
  markets: ["德国", "英国"], languages: ["英语"], budgetMin: 30_000, budgetMax: 50_000, budgetCurrency: "CNY", budgetPeriod: "project", weeklyHours: 20, availableFrom: "2026-10-01",
} };

test("collapsed conditions reveal all known constraints with currency, period and directional limits", () => {
  assert.equal(matchingConditionsSummary(draft, workModes, engagements, false), "远程 · 项目合作 · 市场：德国、英国 · 语言：英语 · 预算：30,000–50,000人民币/项目 · 每周至少 20 小时 · 最晚 2026-10-01 开始");
  const talent = matchingConditionsSummary(draft, workModes, engagements, true);
  assert.match(talent, /报酬：30,000–50,000人民币\/项目/u);
  assert.match(talent, /每周可投入 20 小时/u);
  assert.match(talent, /最早 2026-10-01 开始/u);
});

test("empty conditions stay concise and one-sided budgets never invent the missing limit", () => {
  assert.equal(matchingConditionsSummary({ ...draft, constraints: undefined, workMode: "any", engagement: "any" }, workModes, engagements, false), "可协商");
  const partial = { ...draft, constraints: { ...draft.constraints!, markets: [], languages: [], budgetMin: null, budgetMax: 120, budgetCurrency: "USD" as const, budgetPeriod: "hour" as const, weeklyHours: null, availableFrom: "" } };
  assert.equal(matchingConditionsSummary(partial, workModes, engagements, false), "远程 · 项目合作 · 预算：至多 120美元/小时");
  assert.equal(matchingConditionsSummary({ ...partial, constraints: { ...partial.constraints, budgetMin: 120, budgetMax: null } }, workModes, engagements, true), "远程 · 项目合作 · 报酬：至少 120美元/小时");
});
