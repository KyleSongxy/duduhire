import type { DiscoveryKind } from "./domain.js";
import type { FlowField, FlowSource } from "./discoveryFlow.js";

type Definition = { key: string; label: string };
type Update = FlowField & { field: string };

// These rules only keep excerpts that the user actually wrote. They support local
// rehearsal and explicitly labelled edits; they are not a substitute for the AI.
const cues: Record<DiscoveryKind, Record<string, RegExp>> = {
  problem: {
    context: /(?:我们|公司|团队|产品|客户|用户|业务|目前|现在|正在).*(?:做|是|有|面向|主要|希望|想|缺|反复|遇到|准备|需要|困难|问题|打算|进入|出海)|(?:线索|转化|客服|成本|数据|知识库|效率).*(?:低|高|慢|缺|难|不|反复)/iu,
    work: /(?:希望|需要|想|寻找|找|招|聘|负责|帮助|协助|任务|工作内容).*(?:人|工程|顾问|运营|负责|搭建|整理|开发|改善|建立|优化|完成|交付|建设|验证|增长|拓展|获客|落地)|(?:负责|任务|工作内容)[：:]/iu,
    outcome: /(?:目标|期望|预期|成功标准|验收|做到|达到|希望.{0,16}(?:最终|能|将|把|让|减少|提升|降低|提高|交付|拿到|得到|获得))|(?:提升|降低|减少|提高|缩短|增加|获得|拿到|达到).*(?:\d|一半|线索|客户|订单|收入|效率|准确率|覆盖|响应)/iu,
    collaboration: /(?:全职|兼职|长期|短期|按项目|项目制|项目合作|阶段合作|阶段项目|顾问合作|外包|驻场)/iu,
    constraints: /(?:预算|薪资|薪酬|报酬|人民币|美元|万元|万\/|k\/|每月|月薪|周内|个月内|天内|到岗|时区|地点|坐班|远程|每周|不超过|上线时间|交付时间)/iu,
    requirements: /(?:必须|必需|必备|熟悉|擅长|精通|至少|加分|优先|做过|经验|英语|英文|语言能力|不能|不接受|不要求).*(?:能力|经验|工作|英语|英文|语言|沟通|开发|销售|运营|市场|行业|AI|RAG|Agent|Python|出海|合规|证书|年)|(?:必须|必备|加分|优先)[：:]/iu,
    verification: /(?:面谈|面试|核实|核验|作品|案例|评估方式|看过往|看实际)/iu,
  },
  capability: {
    situation: /(?:项目|作品|课程|实习|公司|团队|客户|当时|背景|之前|过去|曾经|做过|参与过|负责过)/iu,
    role: /(?:我|本人)(?:主要|只|仅|独立|具体|实际|直接)?(?:负责|参与|承担|支持|协助|主导|带领|不是|并非|担任|是|作为)|(?:个人职责|我的职责|负责部分)[：:]/iu,
    actions: /(?:我|本人)(?:主要|只|仅|独立|具体|实际|还|先|再)?(?:做了|做过|搭建|开发|编写|整理|归纳|分析|设计|制作|优化|配置|访谈|验证|测试|调研|建立|调整|拆分|清洗|部署|接入|实施|上线|运营|管理)|(?:具体做法|采取的行动|关键步骤)[：:]/iu,
    outcome: /(?:结果|成果|效果|反馈|验收|最终|最后|已上线|还没上线|尚未上线|未上线|没有上线|试运行|测试中|带来|帮助.*(?:提升|降低|减少)|提升|降低|减少|提高|缩短|增加|达到|完成了|交付了|获得|拿到)/iu,
    evidence: /(?:作品|链接|项目记录|截图|报告|代码仓库|GitHub|github|演示|案例材料|验收记录|证明|脱敏|反馈记录|对照稿|流程图)|https?:\/\//u,
    direction: /(?:接下来|以后|未来|下一份|希望|想要|想找|求职|方向|目标岗位).*(?:做|承担|负责|从事|工作|项目|岗位|发展|顾问|工程|运营|出海)/iu,
    preferences: /(?:全职|兼职|长期|短期|项目制|阶段合作|顾问合作|外包|驻场|远程|每周|地点|坐班|时区|可投入|可工作|可到岗|可开始)/iu,
  },
};

const aliases: Record<string, string[]> = {
  context: ["业务背景", "需求背景", "背景"], work: ["工作内容", "主要职责", "岗位职责", "需要负责", "交付内容"],
  situation: ["项目背景", "经历", "背景"], role: ["我的职责", "个人贡献", "负责部分"], actions: ["具体做法", "采取的行动", "关键步骤"],
  outcome: ["结果", "成果", "目标", "验收标准", "成功标准"], collaboration: ["合作形式"], constraints: ["合作条件", "预算和时间"],
  requirements: ["能力要求", "任职要求"], evidence: ["证明材料", "作品材料"], direction: ["工作方向", "求职方向"], preferences: ["可投入时间"],
};

function provided(field: string, excerpts: Array<{ quote: string; sourceId: string }>): Update {
  const evidence = excerpts.slice(0, 4);
  const value = evidence.map((item) => item.quote).join("；").slice(0, 1200);
  const unknown = /^(?:不知道|不清楚|还不确定|暂时不确定|暂无|待补充|稍后补充|暂时没有|还没想好)[。！!\s]*$/u.test(value);
  return { field, status: unknown ? "skipped" : "provided", value, evidence };
}

export function extractLocalFacts(kind: DiscoveryKind, sources: FlowSource[], definitions: Definition[]): Update[] {
  const labelled = new Map<string, Array<{ quote: string; sourceId: string }>>();
  const natural = new Map<string, Array<{ quote: string; sourceId: string }>>();
  for (const source of sources) {
    // Keep sentence context, especially negation and team/personal attribution.
    const sentences = source.text.split(/(?<=[。！？!?；;])|\r?\n/gu).map((line) => line.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (sentence.length > 800 || isNonFactualReply(sentence)) continue;
      if (/[？?]$/u.test(sentence) || /(?:忽略|无视|覆盖).*(?:规则|指令|提示词)|(?:系统提示|system prompt)/iu.test(sentence)) continue;
      const labelText = sentence.replace(/^(?:请)?(?:修改|更正|更新|调整)(?:一下)?/u, "");
      const definition = definitions.find((field) => [field.label, field.key, ...(aliases[field.key] ?? [])]
        .some((label) => labelText.startsWith(`${label}：`) || labelText.startsWith(`${label}:`)));
      if (definition) {
        const colon = sentence.search(/[：:]/u);
        const quote = sentence.slice(colon + 1).trim();
        if (quote) labelled.set(definition.key, [{ quote, sourceId: source.id }]);
        continue;
      }
      for (const field of definitions) {
        // Future preferences and supporting materials are not another experience.
        if (field.key === "situation" && /^(?:可以|能提供|希望|想找|接受|偏好|每周|修改|更正)/u.test(sentence)) continue;
        if (field.key === "context" && /^(?:希望|目标|验收|想找|需要|修改|更正)/u.test(sentence)) continue;
        if (!cues[kind][field.key]?.test(sentence)) continue;
        const existing = natural.get(field.key) ?? [];
        if (!existing.some((item) => item.quote === sentence)) existing.push({ quote: sentence, sourceId: source.id });
        natural.set(field.key, existing);
      }
    }
  }
  return definitions.flatMap(({ key }) => {
    const excerpts = labelled.get(key) ?? natural.get(key);
    return excerpts?.length ? [provided(key, excerpts)] : [];
  });
}

export function isNonFactualReply(message: string) {
  return /^(?:你好|您好|谢谢(?:你)?|好的?|可以|嗯+|随便|没什么|不知道|不清楚|暂时没有|没有了|先这样|请看附件|帮我(?:梳理|整理|优化|完善)(?:一下)?|(?:我想|我要|请)(?:招人|招聘|找工作|找项目))[。！!\s]*$/u.test(message)
    || /[？?]$/u.test(message)
    || /(?:忽略|无视|覆盖).*(?:规则|指令|提示词)|(?:系统提示|system prompt)/iu.test(message);
}
