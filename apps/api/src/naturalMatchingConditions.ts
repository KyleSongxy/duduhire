import type { DiscoveryKind } from "./domain.js";
import type { Engagement, MatchingConstraints, WorkMode } from "./matching.js";

type Evidence = { field: string; value: string; quote: string };
type NaturalConditions = { constraints?: MatchingConstraints; workMode?: WorkMode; engagement?: Engagement; location?: string; evidence: Evidence[] };
const empty = (): MatchingConstraints => ({ markets: [], languages: [], budgetMin: null, budgetMax: null, budgetCurrency: null, budgetPeriod: null, weeklyHours: null, availableFrom: "" });
const countries: Array<[string, RegExp]> = [
  ["美国", /美国|\bUSA?\b|United States/iu], ["英国", /英国|\bUK\b|United Kingdom/iu],
  ["德国", /德国|Germany/iu], ["法国", /法国|France/iu], ["日本", /日本|Japan/iu],
  ["新加坡", /新加坡|Singapore/iu], ["加拿大", /加拿大|Canada/iu], ["澳大利亚", /澳大利亚|澳洲|Australia/iu],
  ["印度尼西亚", /印度尼西亚|印尼|Indonesia/iu], ["越南", /越南|Vietnam/iu], ["泰国", /泰国|Thailand/iu],
  ["马来西亚", /马来西亚|Malaysia/iu], ["阿联酋", /阿联酋|\bUAE\b/iu], ["沙特阿拉伯", /沙特(?:阿拉伯)?|Saudi Arabia/iu],
  ["东南亚", /东南亚|Southeast Asia/iu], ["欧洲", /欧洲|Europe/iu], ["中东", /中东|Middle East/iu],
];
const languages: Array<[string, RegExp]> = [
  ["英语", /英语|英文|English/iu], ["中文", /中文|普通话|Mandarin|Chinese/iu],
  ["德语", /德语|德文|German/iu], ["法语", /法语|法文|French/iu], ["日语", /日语|日文|Japanese/iu],
  ["西班牙语", /西班牙语|西语|Spanish/iu], ["阿拉伯语", /阿拉伯语|Arabic/iu],
];

function clauses(text: string) { return text.split(/[。；;\n，,]|(?:但是|但我|而我)/u).map((value) => value.trim()).filter(Boolean); }
function affirmative(text: string) {
  return !/没有|未曾|未做|未负责|不会|不懂|不负责|不接受|不考虑|不需要|无需|不要求|不涉及|尚未|不确定|待定|还没定|暂未|没做|并非|仅了解|计划学|想学|正在学|\bnot\b|\bnever\b|\bwithout\b/iu.test(text);
}
function ownWork(text: string) { return !/(?:同事|他人|别人|合作方|另一位|其他人).*(?:负责|完成|承担)|(?:国籍|出生|留学|旅游|旅行|长大|移民)/u.test(text); }
function amount(value: string) {
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  const digits: Record<string, number> = { 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  const parts=value.split("点"); let total=0; let current=0;
  for (const char of parts[0] ?? "") {
    if (char === "十" || char === "百") { total+=(current || 1)*(char === "十" ? 10 : 100); current=0; }
    else if (digits[char] !== undefined) current=digits[char]!;
    else return NaN;
  }
  const fraction=parts[1] ? parts[1].split("").map((char)=>digits[char]).join("") : "";
  return total+current+(fraction ? Number(`0.${fraction}`) : 0);
}

/** Only explicit, job-related statements become editable suggestions. No geography or language inference from identity. */
export function extractNaturalMatchingConditions(kind: DiscoveryKind, fields: Record<string, string>): NaturalConditions {
  const result: NaturalConditions = { evidence: [] };
  const constraints = empty();
  const add = (field: string, value: string, quote: string) => {
    if (!result.evidence.some((item) => item.field === field && item.value === value)) result.evidence.push({ field, value, quote });
  };
  const explicitPreferences = Object.values(fields).flatMap(clauses).filter((quote) =>
    !/之前|当时|曾经|过去|当年|上个项目/u.test(quote)
    && /(?:希望|接受|只接|可以|愿意|可投入).*(?:远程|全职|兼职|按项目|项目合作|每周)/u.test(quote));
  const conditionText = [fields.collaboration, fields.constraints, fields.preferences, ...explicitPreferences].filter(Boolean).join("\n");
  const conditionClauses = [...new Set(clauses(conditionText))];
  const choose = <T extends string>(field: string, options: Array<[T, RegExp]>): T | undefined => {
    const matches = options.flatMap(([value, pattern]) => conditionClauses.filter((quote) => affirmative(quote) && pattern.test(quote)).map((quote) => ({ value, quote })));
    if (new Set(matches.map((item) => item.value)).size !== 1) return undefined;
    const item = matches[0]!; add(field, item.value, item.quote); return item.value;
  };
  result.workMode = choose<WorkMode>("workMode", [["remote", /远程|\bremote\b/iu], ["onsite", /现场办公|驻场|坐班|到岗办公|onsite/iu], ["hybrid", /混合办公|hybrid/iu]]);
  result.engagement = choose<Engagement>("engagement", [["project", /(?:按|接|做|远程|阶段)?项目(?:制|合作|交付)|按项目|(?:接|接受)\s*(?:远程)?\s*(?:AI\s*)?项目|远程\s*(?:AI\s*)?项目/iu], ["part_time", /兼职|part[- ]time/iu], ["full_time", /全职|full[- ]time/iu]]);

  const marketText = kind === "problem"
    ? [fields.context, fields.work, fields.requirements, conditionText].filter(Boolean).join("\n")
    : [fields.situation, fields.role, fields.actions].filter(Boolean).join("\n");
  for (const quote of clauses(marketText)) {
    if (!affirmative(quote) || !ownWork(quote) || /加分|优先|不限|或|任选|任一|其中/u.test(quote)) continue;
    const jobContext = kind === "problem" ? /开拓|拓展|进入|面向|服务|目标|覆盖|出口|销售|市场/u : /我|本人|负责|参与|做过|项目|为|服务过|团队|市场/u;
    if (!jobContext.test(quote)) continue;
    for (const [value, pattern] of countries) {
      if (pattern.test(quote) && !constraints.markets.includes(value)) {
        constraints.markets.push(value); add("constraints.markets", value, quote);
      }
    }
  }
  const languageText = kind === "problem"
    ? [fields.requirements, fields.work, conditionText].filter(Boolean).join("\n")
    : [fields.role, fields.actions, fields.evidence, fields.preferences].filter(Boolean).join("\n");
  for (const quote of clauses(languageText)) {
    if (!affirmative(quote) || !ownWork(quote) || /加分|优先|可选|不限|不作要求|不作为要求|或|任选|任一|其中/u.test(quote)) continue;
    if (!/沟通|交流|工作语言|可用语言|商务|撰写|写作|翻译|本地化|文案|产品页|内容|能用|使用|精通|流利/u.test(quote)) continue;
    for (const [value, pattern] of languages) {
      if (pattern.test(quote) && !constraints.languages.includes(value)) {
        constraints.languages.push(value); add("constraints.languages", value, quote);
      }
    }
  }

  const hourMatches = conditionClauses.flatMap((quote) => {
    if (!affirmative(quote)) return [];
    // A demand's maximum is not its minimum; a talent's minimum is not their availability cap.
    if ((kind === "problem" && /最多|上限|不超过/u.test(quote)) || (kind === "capability" && /至少|最低|起步/u.test(quote))) return [];
    const match = quote.match(/每周(?:最低|至少|可投入|最多|可用|能投入|投入|可以投入|有)?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+(?:点[零一二三四五六七八九]+)?)\s*(?:小时|h\b)/iu);
    const value = match ? amount(match[1]!) : 0;
    return value > 0 && value <= 168 ? [{ value, quote }] : [];
  });
  if (new Set(hourMatches.map((item) => item.value)).size === 1) {
    constraints.weeklyHours = hourMatches[0]!.value; add("constraints.weeklyHours", String(constraints.weeklyHours), hourMatches[0]!.quote);
  }
  const startMatches = conditionClauses.flatMap((quote) => {
    if (!affirmative(quote)) return [];
    const marker = kind === "problem" ? /最晚|最迟|不晚于|需要.*(?:开始|到岗)|开始日期/u : /最早|可(?:以)?从|可(?:以)?开始|可到岗|开始日期/u;
    if (!marker.test(quote)) return [];
    const match = quote.match(/\b(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?/u);
    if (!match) return [];
    const value = `${match[1]}-${match[2]!.padStart(2,"0")}-${match[3]!.padStart(2,"0")}`;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) ? [{ value, quote }] : [];
  });
  if (new Set(startMatches.map((item) => item.value)).size === 1) {
    constraints.availableFrom = startMatches[0]!.value; add("constraints.availableFrom", constraints.availableFrom, startMatches[0]!.quote);
  }

  const budgets: Array<{ min: number | null; max: number | null; currency: MatchingConstraints["budgetCurrency"]; period: MatchingConstraints["budgetPeriod"]; quote: string }> = [];
  for (const quote of conditionClauses) {
    if (!affirmative(quote) || /大约|大概|左右|暂定|待确认|可协商|可以协商|约\s*[零〇一二两三四五六七八九十百\d]/u.test(quote)) continue;
    const match = quote.match(/(?:预算|报价|期望报酬|月薪|时薪)\s*[:：]?\s*(?:(人民币|美元|欧元|CNY|USD|EUR)\s*)?(?:为|是|约|大约|最多|至少|不超过|不低于|上限|最低)?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+(?:点[零一二三四五六七八九]+)?)\s*(万|千|[kK])?\s*(?:[-–~至到]\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+(?:点[零一二三四五六七八九]+)?)\s*(万|千|[kK])?)?\s*(元人民币|人民币|美元|欧元|CNY|USD|EUR|元)?/iu);
    if (!match) continue;
    const unit = (value: string | undefined) => value === "万" ? 10000 : value && /千|k/iu.test(value) ? 1000 : 1;
    const min = amount(match[2]!) * unit(match[3] ?? match[5]);
    const max = match[4] ? amount(match[4]) * unit(match[5] ?? match[3]) : min;
    const currencyText = `${match[1] ?? ""}${match[6] ?? ""}`;
    const currency = /美元|USD/iu.test(currencyText) ? "USD" : /欧元|EUR/iu.test(currencyText) ? "EUR" : /人民币|CNY|元/u.test(currencyText) ? "CNY" : null;
    const periods: Array<MatchingConstraints["budgetPeriod"]> = [];
    if (/每小时|时薪|[/／]小时/u.test(quote)) periods.push("hour");
    if (/每月|月薪|[/／]月/u.test(quote)) periods.push("month");
    if (/每项目|项目总|[/／]项目|总预算/u.test(quote) || (!periods.length && result.engagement === "project")) periods.push("project");
    if (!currency || periods.length !== 1 || min <= 0 || max < min || max > 1_000_000_000) continue;
    const upper = /最多|上限|不超过|以内/u.test(quote);
    const lower = /至少|最低|不低于|起(?:步)?(?:价)?(?:$|[。])/u.test(quote);
    if (upper && lower && !match[4]) continue;
    budgets.push({ min: upper && !match[4] ? null : min, max: lower && !match[4] ? null : max, currency, period: periods[0]!, quote });
  }
  if (new Set(budgets.map(({ min,max,currency,period }) => JSON.stringify([min,max,currency,period]))).size === 1) {
    const value = budgets[0]!;
    constraints.budgetMin = value.min; constraints.budgetMax = value.max; constraints.budgetCurrency = value.currency; constraints.budgetPeriod = value.period;
    for (const key of ["budgetMin", "budgetMax", "budgetCurrency", "budgetPeriod"] as const) {
      const quote = key === "budgetPeriod" && value.period === "project" && !/每项目|项目总|[/／]项目|总预算/u.test(value.quote)
        ? result.evidence.find((item) => item.field === "engagement" && item.value === "project")?.quote ?? value.quote : value.quote;
      if (constraints[key] !== null) add(`constraints.${key}`, String(constraints[key]), quote);
    }
  }
  constraints.markets = constraints.markets.slice(0,8); constraints.languages = constraints.languages.slice(0,8);
  if (result.evidence.some((item) => item.field.startsWith("constraints."))) result.constraints = constraints;
  return result;
}
