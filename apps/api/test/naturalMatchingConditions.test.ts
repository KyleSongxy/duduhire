import assert from "node:assert/strict";
import test from "node:test";
import { extractNaturalMatchingConditions as extract } from "../src/naturalMatchingConditions.js";

test("natural demand carries stated markets, working language and remote project terms", () => {
  const fields = { context: "我们做工业传感器，准备开拓德国市场。", requirements: "希望英文商务沟通，德语是加分项。", collaboration: "远程按项目合作。", constraints: "预算3万到5万元人民币，六周完成。" };
  const result = extract("problem", fields);
  assert.equal(result.workMode, "remote"); assert.equal(result.engagement, "project");
  assert.deepEqual(result.constraints?.markets, ["德国"]); assert.deepEqual(result.constraints?.languages, ["英语"]);
  assert.equal(result.constraints?.budgetMin, 30000); assert.equal(result.constraints?.budgetMax, 50000);
  assert.equal(result.constraints?.budgetCurrency, "CNY"); assert.equal(result.constraints?.budgetPeriod, "project");
  assert.ok(result.evidence.every((item) => Object.values(fields).some((value) => value.includes(item.quote))));
});

test("talent project market is not nationality and language is not inferred from a country", () => {
  const result = extract("capability", { situation: "我为面向美国的Shopify品牌做本地化。", role: "我负责英文产品页文案。", preferences: "远程项目合作，每周可投入20小时。" });
  assert.deepEqual(result.constraints?.markets, ["美国"]); assert.deepEqual(result.constraints?.languages, ["英语"]);
  assert.equal(result.constraints?.weeklyHours,20);
  const unrelated = extract("capability", { situation: "我曾去日本旅游，在德国留学。", role: "同事负责英文内容。", preferences: "我想学习英语。" });
  assert.equal(unrelated.constraints,undefined);
  const misplaced = extract("capability",{ evidence:"可以提供脱敏评估报告，希望接远程AI项目。" });
  assert.equal(misplaced.workMode,"remote"); assert.equal(misplaced.engagement,"project");
  const historical = extract("capability",{ situation:"之前接受远程项目合作。" });
  assert.equal(historical.workMode,undefined);
});

test("negated and optional capabilities do not become required markets or languages", () => {
  const result = extract("problem", { context: "暂不考虑德国市场，面向美国消费者。", requirements: "不要求英文沟通，日语加分。", constraints: "不接受现场办公，可以远程兼职。" });
  assert.deepEqual(result.constraints?.markets,["美国"]); assert.deepEqual(result.constraints?.languages,[]);
  assert.equal(result.workMode,"remote"); assert.equal(result.engagement,"part_time");
});

test("multiple distinct alternatives remain negotiable rather than choosing one", () => {
  const result = extract("capability", { preferences: "可远程也可现场办公，全职或兼职都接受。" });
  assert.equal(result.workMode,undefined); assert.equal(result.engagement,undefined);
  const alternatives = extract("problem", { context: "考虑进入美国或德国市场。", requirements: "英语或德语可用于工作沟通。" });
  assert.equal(alternatives.constraints,undefined);
});

test("budget requires currency and a stated billing basis", () => {
  assert.equal(extract("problem",{ constraints:"预算3到5万。" }).constraints,undefined);
  assert.equal(extract("problem",{ constraints:"预算3到5万元人民币。" }).constraints,undefined);
  const result=extract("capability",{ preferences:"报价500美元每小时起。" });
  assert.equal(result.constraints?.budgetMin,500); assert.equal(result.constraints?.budgetMax,null);
  assert.equal(result.constraints?.budgetCurrency,"USD"); assert.equal(result.constraints?.budgetPeriod,"hour");
  const approximate=extract("problem",{ collaboration:"项目合作。", constraints:"预算约三万元人民币，可协商。" });
  assert.equal(approximate.constraints,undefined);
});

test("one-sided budgets preserve their direction and conflicting budgets stay unknown", () => {
  const max=extract("problem",{ collaboration:"项目合作。", constraints:"预算不超过5万元人民币。" });
  assert.equal(max.constraints?.budgetMin,null); assert.equal(max.constraints?.budgetMax,50000);
  const conflict=extract("problem",{ collaboration:"项目合作。", constraints:"预算3万元人民币。预算5万元人民币。" });
  assert.equal(conflict.constraints,undefined);
});

test("hour requirements and availability are not reversed", () => {
  assert.equal(extract("problem",{ constraints:"每周至少20小时。" }).constraints?.weeklyHours,20);
  assert.equal(extract("capability",{ preferences:"每周最多30小时。" }).constraints?.weeklyHours,30);
  assert.equal(extract("problem",{ constraints:"每周最多20小时。" }).constraints,undefined);
  assert.equal(extract("capability",{ preferences:"每周至少10小时。" }).constraints,undefined);
});

test("absolute start dates require correct role direction and a valid date", () => {
  assert.equal(extract("problem",{ constraints:"最迟2026年10月1日开始。" }).constraints?.availableFrom,"2026-10-01");
  assert.equal(extract("capability",{ preferences:"最早2026-09-20可开始。" }).constraints?.availableFrom,"2026-09-20");
  assert.equal(extract("problem",{ constraints:"最早2026-09-20开始。" }).constraints,undefined);
  assert.equal(extract("capability",{ preferences:"最早2026-02-30可开始。" }).constraints,undefined);
  assert.equal(extract("problem",{ constraints:"下个月开始。" }).constraints,undefined);
});

test("amount units on both ends and monthly rates preserve values", () => {
  const result=extract("capability",{ preferences:"期望报酬1.5万到2万元人民币每月。" });
  assert.equal(result.constraints?.budgetMin,15000); assert.equal(result.constraints?.budgetMax,20000);
  assert.equal(result.constraints?.budgetPeriod,"month");
  const chinese=extract("problem", { collaboration:"按项目合作。", constraints:"预算三至五万元人民币。每周至少二十小时。" });
  assert.equal(chinese.constraints?.budgetMin,30000); assert.equal(chinese.constraints?.budgetMax,50000);
  assert.equal(chinese.constraints?.weeklyHours,20);
});
