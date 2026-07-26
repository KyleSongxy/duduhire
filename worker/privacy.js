const redactionRules = [
  {
    type: 'email',
    label: '[已隐藏邮箱]',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
  {
    type: 'cn_phone',
    label: '[已隐藏手机号]',
    pattern: /(?:\+?86[\s-]?)?1[3-9]\d{9}/g,
  },
  {
    type: 'cn_id',
    label: '[已隐藏身份证号]',
    pattern: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
  },
  {
    type: 'bank_card',
    label: '[已隐藏银行卡号]',
    pattern: /\b(?:\d[\s-]?){16,19}\b/g,
  },
  {
    type: 'credential',
    label: '[已隐藏凭据]',
    pattern: /(?:api[_\s-]?key|access[_\s-]?token|password|passwd|密码|密钥|令牌)\s*[:：=]\s*[^\s,，;；]{6,}/gi,
  },
];

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\r\n?/g, '\n') : '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRedactionTerms(terms) {
  if (!Array.isArray(terms)) return [];
  return [...new Set(terms
    .filter((item) => typeof item === 'string')
    .map((item) => normalizeText(item).slice(0, 80))
    .filter((item) => item.length >= 2))]
    .slice(0, 20);
}

export function redactSensitiveText(value, terms = []) {
  let text = normalizeText(value);
  const redactions = [];
  const confidentialTerms = normalizeRedactionTerms(terms);
  let organizationCount = 0;
  for (const term of confidentialTerms.sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(escapeRegExp(term), 'gi');
    text = text.replace(pattern, () => {
      organizationCount += 1;
      return '[已隐藏客户/机构名]';
    });
  }
  text = text.replace(
    /((?:客户|甲方|机构|公司|品牌)(?:名|名称)?\s*[:：]\s*)([^，。；;\n]{2,40})/g,
    (_, prefix) => {
      organizationCount += 1;
      return `${prefix}[已隐藏客户/机构名]`;
    },
  );
  if (organizationCount) {
    redactions.push({ type: 'organization_name', count: organizationCount });
  }
  for (const rule of redactionRules) {
    let count = 0;
    text = text.replace(rule.pattern, () => {
      count += 1;
      return rule.label;
    });
    if (count) redactions.push({ type: rule.type, count });
  }
  return {
    text,
    redactions,
    count: redactions.reduce((sum, item) => sum + item.count, 0),
  };
}

export function redactJsonValue(value, depth = 0) {
  if (depth > 8) return '[内容层级过深，未入库]';
  if (typeof value === 'string') return redactSensitiveText(value).text.slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactJsonValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['apiKey', 'token', 'password'].includes(key))
      .slice(0, 100)
      .map(([key, item]) => [key, redactJsonValue(item, depth + 1)]),
  );
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function buildAnalysisSource({ text, answers = [], corrections = '' }) {
  const sections = [normalizeText(text)];
  const usableAnswers = Array.isArray(answers) ? answers.slice(0, 5) : [];
  if (usableAnswers.length) {
    sections.push([
      '补充问答：',
      ...usableAnswers.map((item, index) => (
        `${index + 1}. 问：${normalizeText(item.question)}\n答：${normalizeText(item.answer)}`
      )),
    ].join('\n'));
  }
  if (normalizeText(corrections)) {
    sections.push(`用户修正：\n${normalizeText(corrections)}`);
  }
  return sections.filter(Boolean).join('\n\n');
}

export function getRedactionTypes() {
  return ['organization_name', ...redactionRules.map((rule) => rule.type)];
}
