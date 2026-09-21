// Recorded synthetic Qwen-plus extraction, 2026-09-07; no real user data.
// Domain matching must remain useful after realistic provider phrasing.
export const MATCHING_PROVIDER_FIXTURES = [
  {
    "id": "ai-rag-demand",
    "kind": "problem",
    "fields": {
      "context": "我们公司客服每天重复回答产品问题，已有产品手册但查找困难。",
      "work": "想找人整理知识库，搭建带原文引用的 RAG 智能问答，并建立模型评估集。希望客服能找到准确答案，不能回答时转人工。",
      "outcome": "希望客服能找到准确答案，不能回答时转人工。按项目远程合作，预算 3万到5万元人民币，六周完成。",
      "collaboration": "按项目远程合作，预算 3万到5万元人民币，六周完成。",
      "constraints": "按项目远程合作，预算 3万到5万元人民币，六周完成。"
    }
  },
  {
    "id": "ai-agent-demand",
    "kind": "problem",
    "fields": {
      "context": "我们是小型外贸团队，每天在邮件和 CRM 间手工录入询盘。",
      "work": "需要一位开发者用 n8n 和 Agent 接好邮件分类、CRM 写入和人工审批，先别自动给客户发信。",
      "outcome": "验收看询盘能否正确入库、失败能否重试。",
      "collaboration": "远程项目合作，预算还没定。"
    }
  },
  {
    "id": "global-b2b-demand",
    "kind": "problem",
    "fields": {
      "context": "我们做工业传感器，准备开拓德国市场，暂时没有海外客户线索。",
      "work": "需要有人做市场调研、梳理目标客户画像，通过 LinkedIn 开发 B2B 线索并把过程记录在 CRM。",
      "outcome": "前两个月先验收有效客户名单和意向访谈，不保证成交额。",
      "collaboration": "远程兼职。",
      "requirements": "希望英文商务沟通，德语是加分项，远程兼职。"
    }
  },
  {
    "id": "global-content-demand",
    "kind": "problem",
    "fields": {
      "context": "我们的 Shopify 独立站要面向美国消费者，英文产品页现在像机器翻译。",
      "work": "想找英语内容本地化人员重写产品页、做 SEO 关键词研究并配合设计整理文案。",
      "outcome": "希望交付可审核的英文页面和关键词清单，先不投 Google Ads。",
      "collaboration": "可以远程按项目合作。"
    }
  },
  {
    "id": "ai-rag-capability",
    "kind": "capability",
    "fields": {
      "situation": "上个项目是给 SaaS 客服做知识库问答。",
      "role": "我是后端开发，负责 RAG 检索与模型评估，前端由同事负责。",
      "actions": "我清洗产品文档，做向量检索和重排，写了 80 条评估问题，并为答案加上引用。",
      "outcome": "试用时客服反馈查资料更方便，没有统计准确率。",
      "evidence": "可以提供脱敏评估报告，希望接远程 AI 项目。"
    }
  },
  {
    "id": "ai-agent-capability",
    "kind": "capability",
    "fields": {
      "situation": "之前销售团队手工汇总表单很慢。",
      "role": "我担任自动化开发，独立负责 n8n 工作流和 CRM 接口。",
      "actions": "我接入表单，增加去重、人工审批和失败重试。",
      "outcome": "最后销售同事可以直接在 CRM 看到待跟进记录，不用重复录入。",
      "evidence": "可以提供脱敏流程图",
      "preferences": "每周可投入20小时，远程兼职。"
    }
  },
  {
    "id": "global-b2b-capability",
    "kind": "capability",
    "fields": {
      "situation": "之前在工业设备团队做德国市场拓展，我负责市场调研和 B2B 客户开发，不负责签约。",
      "role": "我负责市场调研和 B2B 客户开发，不负责签约。我分析竞争产品、整理客户画像，用 LinkedIn 筛选潜在线索并记录到 CRM。",
      "actions": "我分析竞争产品、整理客户画像，用 LinkedIn 筛选潜在线索并记录到 CRM。",
      "outcome": "最终整理出 120 家目标客户名单，销售团队完成了后续访谈，成交额不能算我的成果。",
      "evidence": "可以提供脱敏调研表，能用英语商务沟通，希望远程兼职。",
      "preferences": "希望远程兼职。"
    }
  },
  {
    "id": "global-content-capability",
    "kind": "capability",
    "fields": {
      "situation": "我为一个面向美国的 Shopify 品牌做过英文内容本地化。",
      "role": "我负责 SEO 关键词研究和产品页文案，没有负责广告投放。我分析搜索意图，重写产品页并与设计师校对术语。",
      "actions": "我分析搜索意图，重写产品页并与设计师校对术语。",
      "outcome": "结果是交付了 12 个审核通过的英文页面，尚未获得流量统计。",
      "evidence": "可以提供脱敏前后对照稿，接受远程项目。"
    }
  }
] as const;
