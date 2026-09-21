import type { DiscoveryKind } from "./domain.js";

/** Curated guidance, not evidence about a person or a promise of platform vetting. */
export const KNOWLEDGE_SOURCES = [
  { id: "upwork-profile", title: "Upwork：能力与经历档案", url: "https://support.upwork.com/hc/en-us/articles/360016252373-How-to-build-your-freelancer-profile-the-essentials", reviewedAt: "2026-09-07" },
  { id: "toptal-screening", title: "Toptal：工作样本与实际任务评估", url: "https://www.toptal.com/top-3-percent", reviewedAt: "2026-09-07" },
  { id: "nist-ai-rmf", title: "NIST：生成式 AI 风险管理框架", url: "https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf", reviewedAt: "2026-09-07" },
  { id: "ita-export-plan", title: "International Trade Administration：出海计划", url: "https://www.trade.gov/develop-export-plan", reviewedAt: "2026-09-07" },
  { id: "ita-market-research", title: "International Trade Administration：市场调研", url: "https://www.trade.gov/conducting-market-research", reviewedAt: "2026-09-07" },
] as const;

export type DiscoveryGuidance = {
  id: string;
  title: string;
  domain: "ai" | "global" | "general";
  questions: string[];
  fields: string[];
  capabilities: string[];
  evidenceChecks: string[];
  sourceUrls: string[];
};
type KnowledgeEntry = Omit<DiscoveryGuidance, "questions" | "sourceUrls"> & {
  triggers: RegExp;
  problemQuestions: string[];
  capabilityQuestions: string[];
  sourceIds: string[];
};

const entries: KnowledgeEntry[] = [
  {
    id: "ai-knowledge", title: "企业知识库与问答", domain: "ai", triggers: /知识库|知识问答|智能问答|检索增强|\bRAG\b|向量检索/iu,
    fields: ["服务对象与问题", "资料来源与使用权限", "交付边界", "验收样本"], capabilities: ["知识库", "RAG检索", "智能问答", "模型评估"],
    problemQuestions: ["最常被问到的一个问题是什么？现在答案存在哪里？", "先交付可试用版本，还是接入现有系统？怎样判断答得对？"],
    capabilityQuestions: ["你亲自做了资料清洗、检索、回答生成或评估中的哪些部分？", "能否讲一个回答失败的例子，以及你如何检查和改进？"],
    evidenceChecks: ["区分演示、试点、正式上线；引用答案、测试样本和实际使用记录分别核实。", "资料数量、准确率、节省时间只有原文明确给出才记录；不能由使用 RAG 推导出具备模型训练能力。"], sourceIds: ["nist-ai-rmf", "toptal-screening"],
  },
  {
    id: "ai-agent", title: "AI 助手与业务自动化", domain: "ai", triggers: /智能体|\bagents?\b|自动化|工作流|\bRPA\b|\bn8n\b|\bDify\b/iu,
    fields: ["当前人工步骤", "输入输出与系统", "执行权限", "人工确认与失败处理"], capabilities: ["流程自动化", "AI智能体", "系统集成", "测试验收"],
    problemQuestions: ["目前哪一步最费时间？给一个从开始到完成的例子就好。", "哪些动作可以自动执行，哪些必须由人确认？"],
    capabilityQuestions: ["你接通了哪些系统，自动完成哪些步骤？遇到失败时怎么处理？", "上线后是否有人真实使用，还是个人练习或演示？"],
    evidenceChecks: ["分别记录 API 调用、流程设计、权限控制和人工接管；工具品牌不等于生产交付经验。", "交易、发信、删改数据等外部动作必须保留人工控制边界。"], sourceIds: ["nist-ai-rmf", "toptal-screening"],
  },
  {
    id: "ai-evaluation", title: "模型评估与上线验证", domain: "ai", triggers: /评估|评测|幻觉|大模型|\bLLM\b|\bAI\b|人工智能|提示词|微调/iu,
    fields: ["使用场景", "测试数据与基线", "验收标准", "数据与上线边界"], capabilities: ["模型评估", "提示词设计", "模型微调", "数据治理"],
    problemQuestions: ["AI 要完成什么具体任务？最不能接受的错误是什么？", "有没有现成样本可以判断它的结果是否可用？"],
    capabilityQuestions: ["你如何比较改进前后的结果？样本来自哪里？", "你负责的是使用模型、评测、训练，还是部署维护？"],
    evidenceChecks: ["单次满意输出不能当作稳定准确率；写清指标定义、样本与适用范围。", "提到 ChatGPT 或大模型不自动增加提示词、微调、评估等全部标签。"], sourceIds: ["nist-ai-rmf"],
  },
  {
    id: "global-market", title: "目标市场与进入路径", domain: "global", triggers: /出海|海外|国际化|市场调研|市场进入|\bGTM\b|东南亚|欧洲|美国|中东|日本/iu,
    fields: ["产品与客户", "目标国家或地区", "当前阶段", "本阶段交付结果"], capabilities: ["海外市场调研", "出海策略", "数据分析"],
    problemQuestions: ["准备把什么产品卖给哪个市场的哪类客户？暂未选定也可以。", "现在是选市场、找第一批客户，还是扩大已有业务？"],
    capabilityQuestions: ["你亲自负责过哪个市场、哪类产品和哪一步工作？", "你交付的是研究建议、试点验证还是实际销售结果？"],
    evidenceChecks: ["市场选择、行业和项目阶段分别记录；不能由熟悉一个国家推定熟悉整个地区。", "市场规模和政策不是用户事实，必要时按目标市场另行查证。"], sourceIds: ["ita-export-plan", "ita-market-research"],
  },
  {
    id: "global-growth", title: "海外获客与增长", domain: "global", triggers: /获客|海外营销|SEO|Google Ads|Meta Ads|TikTok|投放|独立站|跨境电商|\bShopify\b/iu,
    fields: ["目标客户", "渠道与现有基础", "预算范围", "转化指标"], capabilities: ["海外获客", "广告投放", "SEO优化", "跨境电商", "数据分析"],
    problemQuestions: ["目前通过什么渠道找客户，已有网站、账号或销售线索吗？", "这阶段更希望验证渠道、获得合格线索，还是带来订单？"],
    capabilityQuestions: ["你实际操作了什么渠道，负责内容、投放、网站还是转化分析？", "结果对应多长时间、多少预算？哪些贡献是你独立完成的？"],
    evidenceChecks: ["线索、订单、营收、利润不是同一指标；不能承诺保底获客或销售。", "平台名称只帮助定位渠道，不能代替案例与指标核实。"], sourceIds: ["ita-export-plan", "upwork-profile"],
  },
  {
    id: "global-localization", title: "本地化与海外客户协作", domain: "global", triggers: /本地化|多语言|翻译|英文|英语|日语|海外客服|跨文化/iu,
    fields: ["目标市场与语言", "内容或服务对象", "本人职责", "工作时段"], capabilities: ["内容本地化", "客户服务", "内容创作"],
    problemQuestions: ["需要本地化哪些内容，面向哪种语言的哪类用户？", "需要覆盖什么工作时段，质量由谁确认？"],
    capabilityQuestions: ["你亲自写作、翻译或改进过什么内容？面向哪个市场？", "工作中能用什么语言完成哪些任务？有没有可说明的样例？"],
    evidenceChecks: ["语言能力只按本人陈述记录；留学、国籍或地域不能当作语言能力证明。", "会英语不自动推导出海外销售或当地法规能力。"], sourceIds: ["upwork-profile", "ita-export-plan"],
  },
  {
    id: "global-partners", title: "渠道伙伴与贸易协同", domain: "global", triggers: /渠道伙伴|经销商|分销|供应链|物流|外贸|出口|海关|关税|合规/iu,
    fields: ["产品与目标市场", "合作方类型", "职责与交付边界", "需要核实的规则"], capabilities: ["渠道拓展", "跨境运营", "项目管理"],
    problemQuestions: ["希望找到什么样的合作方？需要覆盖哪个市场和哪一步业务？", "已有物流、支付、合规或本地合作资源吗？"],
    capabilityQuestions: ["你具体做了伙伴筛选、谈判、订单跟进还是交付协调？", "有哪些交付材料能说明你的贡献，哪些事项由专业机构负责？"],
    evidenceChecks: ["销售、进口许可、税务、支付等职责不能混为一个通用出海能力。", "知识库仅提示核实方向，不输出合规认证或法律判断。"], sourceIds: ["ita-export-plan", "ita-market-research"],
  },
];

const general: DiscoveryGuidance = {
  id: "work-evidence", title: "工作内容与经历证据", domain: "general", questions: [],
  fields: ["场景", "本人职责或需要完成的工作", "具体行动", "结果与证据"],
  capabilities: [], evidenceChecks: ["区分本人行动、团队结果、兴趣和计划；缺失信息保留待确认。", "经历自述、材料支持和独立验证分开表述，不能把已确认档案称为平台认证。"],
  sourceUrls: KNOWLEDGE_SOURCES.filter((source) => ["upwork-profile", "toptal-screening"].includes(source.id)).map((source) => source.url),
};

export function getDiscoveryGuidance(kind: DiscoveryKind, text: string): DiscoveryGuidance[] {
  const relevant = entries.filter((entry) => entry.triggers.test(text)).slice(0, 3);
  return relevant.length ? relevant.map(({ id, title, domain, fields, capabilities, evidenceChecks, sourceIds, problemQuestions, capabilityQuestions }) => ({
    id, title, domain, fields: [...fields], capabilities: [...capabilities], evidenceChecks: [...evidenceChecks],
    questions: [...(kind === "problem" ? problemQuestions : capabilityQuestions)],
    sourceUrls: KNOWLEDGE_SOURCES.filter((source) => sourceIds.includes(source.id)).map((source) => source.url),
  })) : [{ ...general, questions: kind === "problem" ? ["最想解决哪件具体的事，完成后希望看到什么变化？"] : ["讲一件你亲自做过的事：当时遇到什么问题，你做了什么？"] }];
}

/** Explicit aliases support editable suggestions. Broad domain mentions add no skills. */
export const SKILL_ALIASES: ReadonlyArray<{ skill: string; aliases: RegExp }> = [
  { skill: "需求分析", aliases: /需求分析|需求调研|业务需求梳理/iu },
  { skill: "流程自动化", aliases: /流程自动化|业务自动化|自动化流程|自动化工作流|\bRPA\b|\bn8n\b/iu },
  { skill: "知识库", aliases: /知识库/iu },
  { skill: "智能问答", aliases: /智能问答|知识问答|问答系统|问答助手|智能客服|客服机器人/iu },
  { skill: "数据分析", aliases: /数据分析|转化分析|漏斗分析/iu },
  { skill: "数据可视化", aliases: /数据可视化|数据看板|\bPower\s?BI\b|\bTableau\b/iu },
  { skill: "产品设计", aliases: /产品设计|产品原型/iu },
  { skill: "UI设计", aliases: /UI\s?设计|界面设计/iu },
  { skill: "前端开发", aliases: /前端开发|\bReact\b|\bVue\b/iu },
  { skill: "后端开发", aliases: /后端开发|\bFastAPI\b|\bFastify\b/iu },
  { skill: "系统集成", aliases: /系统集成|系统对接|API\s?对接|API\s?集成/iu },
  { skill: "测试验收", aliases: /测试验收|验收测试|自动化测试/iu },
  { skill: "内容创作", aliases: /内容创作|文案撰写|内容策划|产品页文案|(?:撰写|编写|重写|改写).{0,8}(?:文案|产品页|页面内容)/iu },
  { skill: "市场营销", aliases: /市场营销|营销策划/iu },
  { skill: "客户服务", aliases: /客户服务|客服支持|客户支持/iu },
  { skill: "人力资源", aliases: /人力资源|招聘流程/iu },
  { skill: "财务流程", aliases: /财务流程|财务自动化/iu },
  { skill: "项目管理", aliases: /项目管理/iu },
  { skill: "RAG检索", aliases: /\bRAG\b|检索增强|向量检索/iu },
  { skill: "AI智能体", aliases: /AI\s?智能体|智能体|\bAI\s?agents?\b/iu },
  { skill: "提示词设计", aliases: /提示词设计|提示词优化|提示词工程|\bprompt engineering\b/iu },
  { skill: "模型评估", aliases: /模型评估|模型评测|大模型评测|问答评测|AI\s?评测|AI\s?评估/iu },
  { skill: "模型微调", aliases: /模型微调|大模型微调|\bLoRA\b|\bfine[- ]?tuning\b/iu },
  { skill: "数据治理", aliases: /数据治理|数据清洗|数据标注/iu },
  { skill: "模型部署", aliases: /模型部署|模型服务化|推理服务|\bMLOps\b/iu },
  { skill: "海外市场调研", aliases: /海外市场调研|海外市场研究|国际市场调研|目标市场调研/iu },
  { skill: "出海策略", aliases: /出海策略|出海战略|市场进入策略|海外\s?GTM/iu },
  { skill: "海外获客", aliases: /海外获客|海外客户开发|海外线索|国际客户开发/iu },
  { skill: "广告投放", aliases: /广告投放|\bGoogle Ads\b|\bMeta Ads\b|投放优化/iu },
  { skill: "SEO优化", aliases: /\bSEO\b|搜索引擎优化/iu },
  { skill: "内容本地化", aliases: /内容本地化|网站本地化|产品本地化|多语言本地化/iu },
  { skill: "跨境电商", aliases: /跨境电商运营|运营跨境电商|(?:运营|搭建|管理)\s*Shopify|Shopify\s*(?:运营|建站|店铺管理)|Amazon\s?运营|亚马逊运营/iu },
  { skill: "渠道拓展", aliases: /渠道拓展|渠道伙伴|经销商开发|分销商开发/iu },
  { skill: "跨境运营", aliases: /跨境运营|外贸跟单|出口运营|海外运营/iu },
];

/** Conservative scope: a negative/uncertain coordinated clause is never affirmative evidence. */
export function affirmativeMentions(text: string, pattern: RegExp): Array<{ value: string; quote: string }> {
  const found: Array<{ value: string; quote: string }> = [];
  const clauses = text.split(/[，,。；;\n！？!?]|(?:但是|但我|但需要|而我|而是|but\s+)/iu);
  for (const raw of clauses) {
    const quote = raw.trim();
    if (!quote) continue;
    const matches = quote.matchAll(new RegExp(pattern.source, [...new Set(`${pattern.flags}g`)].join("")));
    for (const match of matches) {
      const before = quote.slice(0, match.index);
      const after = quote.slice((match.index ?? 0) + match[0].length);
      const negativeBefore = /(?:没有|没做|不会|不懂|不做|不投|不写|不接|不建|不开发|不运营|不负责|不具备|未做|未参与|未负责|尚未|从未|不要求|不需要|无需|不要|不接受|不支持|不考虑|不含|不涉及|不是|不能|不熟悉|不擅长|缺乏|只想学|想学习|正在学|计划学|仅了解|(?:先|暂时)?别|\bnot\b|\bnever\b|\bwithout\b|\bno\b|\bdon['’]?t\b|\bcannot\b)/iu.test(before);
      const negativeAfter = /^(?:方面)?\s*(?:我|本人)?(?:也|还)?\s*(?:没有经验|没经验|没有做|没做|没有负责|没负责|未参与|不熟悉|不会|未做过|不考虑|不接受|不需要|无需|不包含|不归我|不是我|与我无关)/iu.test(after);
      const otherActor = /(?:同事|队友|其他人|他人|别人|外包方|另一位|搭档|她|他)(?:来|去|会|在|主要|独立)?(?:负责|完成|做|开发|搭建|设计|运营)|(?:交给|由)(?:同事|团队|队友|他人|其他人|外包)/u.test(before)
        || /^(?:是)?(?:由)?(?:同事|队友|其他人|别人|外包方|团队|部门|公司|项目组|供应商|她|他)(?:负责|完成|做)/u.test(after)
        || (!/我|本人/u.test(before) && /(?:团队|部门|公司|项目组)(?:一起|主要|独立|已经|曾经)?(?:负责|完成|做|开发|搭建|设计|运营)/u.test(before));
      if (!negativeBefore && !negativeAfter && !otherActor) found.push({ value: match[0], quote });
    }
  }
  return found;
}

export function inferDomainSignals(text: string, context = text): { skills: Array<{ skill: string; quote: string }>; domainIds: string[] } {
  const skills = SKILL_ALIASES.flatMap(({ skill, aliases }) => {
    const evidence = affirmativeMentions(text, aliases)[0];
    return evidence ? [{ skill, quote: evidence.quote }] : [];
  });
  const globalContext = /出海|海外|国际市场|外贸|出口|德国|美国|英国|法国|日本|新加坡|加拿大|澳大利亚|东南亚|欧洲|中东/iu.test(context);
  const aiContext = /智能体|\bAI\b|\bLLM\b|\bRAG\b|\bn8n\b|自动化|大模型/iu.test(context);
  const contextual: Array<{ skill: string; context: boolean; action: RegExp }> = [
    { skill: "海外市场调研", context: globalContext, action: /市场调研|市场研究|(?:分析|研究|比较).{0,8}(?:竞品|竞争产品)|(?:梳理|整理|研究).{0,8}(?:目标客户画像|客户画像)/iu },
    { skill: "海外获客", context: globalContext, action: /(?:B2B|企业|目标)\s*客户开发|(?:开发|筛选|触达|挖掘|获取).{0,10}(?:潜在|B2B|客户|意向)?\s*(?:线索|客户名单)|(?:LinkedIn|领英).{0,16}(?:开发|筛选|触达|获客)/iu },
    { skill: "系统集成", context: aiContext, action: /(?:接好|接入|对接|集成|连接).{0,20}(?:CRM|ERP|API|接口|邮件|表单)|(?:CRM|ERP|API|客户系统|邮件系统)\s*(?:写入|接口|对接|集成)/iu },
    { skill: "AI智能体", context: aiContext, action: /(?:用|搭建|开发|构建|负责).{0,20}\bAgent\b|\bAgent\b.{0,12}(?:接好|接入|调用|执行|分类)/iu },
    { skill: "知识库", context: /知识库|知识问答/iu.test(context), action: /(?:清洗|整理|分段|切分).{0,8}(?:文档|资料)|\bRAG\b.{0,8}检索|向量检索/iu },
    { skill: "智能问答", context: /问答|智能客服/iu.test(context), action: /(?:答案|回答).{0,8}(?:引用|生成|检查)|(?:生成|检查|引用).{0,8}(?:答案|回答)/iu },
    { skill: "数据治理", context: aiContext, action: /(?:清洗|去重|标注|校验).{0,8}(?:文档|资料|数据)|(?:文档|数据).{0,8}(?:清洗|去重|标注)/iu },
    { skill: "内容本地化", context: globalContext && /英语|英文|日语|日文|德语|德文|多语言|本地化/iu.test(context), action: /(?:重写|改写|翻译).{0,10}(?:产品页|页面|文案|内容)|校对术语|术语校对|双语术语/u },
  ];
  for (const rule of contextual) {
    if (!rule.context || skills.some((item) => item.skill === rule.skill)) continue;
    const evidence = affirmativeMentions(text, rule.action)[0];
    if (evidence) skills.push({ skill: rule.skill, quote: evidence.quote });
  }
  return {
    skills,
    domainIds: entries.filter((entry) => entry.triggers.test(context)).map((entry) => entry.id),
  };
}
