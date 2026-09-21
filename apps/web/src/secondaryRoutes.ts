export type SecondaryRoute = "talent" | "projects" | "how-it-works" | "pricing" | "enterprise";

export const secondaryRouteTitles: Record<SecondaryRoute, string> = {
  talent: "梳理用人需求",
  projects: "完善能力档案",
  "how-it-works": "DuduHire 如何工作",
  pricing: "定价与服务方案",
  enterprise: "企业服务",
};

export const secondaryRouteDescriptions: Record<SecondaryRoute, string> = {
  talent: "从真实需求出发，按能力证据、项目结果与匹配理由找到真正合适的专业人才。",
  projects: "把真实经历转化为可信能力证据，发现与你的专业价值真正相关的合作机会。",
  "how-it-works": "了解 DuduHire 如何用 AI 发现问题、定义价值、构建解决方案，并完成可解释的价值匹配。",
  pricing: "个人与单次项目可免费开始，团队与企业服务可按协作规模和治理需求配置。",
  enterprise: "从复杂业务问题出发，按真实能力证据组建专业团队，并统一管理协作、治理与结果验证。",
};
