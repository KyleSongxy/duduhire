import type { Engagement, MatchingDraft, WorkMode } from "./matchingStore";

export function matchingConditionsSummary(draft: MatchingDraft, workModes: Record<WorkMode, string>, engagements: Record<Engagement, string>, isTalent: boolean) {
  const parts = [...new Set([workModes[draft.workMode], engagements[draft.engagement], draft.location.trim()].filter(Boolean))];
  const conditions = draft.constraints;
  if (!conditions) return parts.join(" · ");
  const markets = conditions.markets.map((value) => value.trim()).filter(Boolean);
  const languages = conditions.languages.map((value) => value.trim()).filter(Boolean);
  if (markets.length) parts.push(`市场：${markets.join("、")}`);
  if (languages.length) parts.push(`语言：${languages.join("、")}`);
  const number = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  if (conditions.budgetMin !== null || conditions.budgetMax !== null) {
    const { budgetMin: min, budgetMax: max } = conditions;
    const range = min !== null && max !== null ? min === max ? number(min) : `${number(min)}–${number(max)}` : min !== null ? `至少 ${number(min)}` : `至多 ${number(max!)}`;
    const currency = conditions.budgetCurrency ? { CNY: "人民币", USD: "美元", EUR: "欧元" }[conditions.budgetCurrency] : "";
    const period = conditions.budgetPeriod ? `/${{ project: "项目", month: "月", hour: "小时" }[conditions.budgetPeriod]}` : "";
    parts.push(`${isTalent ? "报酬" : "预算"}：${range}${currency}${period}`);
  }
  if (conditions.weeklyHours !== null) parts.push(`每周${isTalent ? "可投入" : "至少"} ${number(conditions.weeklyHours)} 小时`);
  if (conditions.availableFrom) parts.push(`${isTalent ? "最早" : "最晚"} ${conditions.availableFrom} 开始`);
  return parts.join(" · ");
}
