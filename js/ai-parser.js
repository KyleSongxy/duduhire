const marketCatalog = [
  { label: '印尼市场', aliases: ['印度尼西亚', '印尼'] },
  { label: '马来西亚市场', aliases: ['马来西亚'] },
  { label: '新加坡市场', aliases: ['新加坡'] },
  { label: '菲律宾市场', aliases: ['菲律宾'] },
  { label: '泰国市场', aliases: ['泰国'] },
  { label: '越南市场', aliases: ['越南'] },
  { label: '日本市场', aliases: ['日本'] },
  { label: '韩国市场', aliases: ['韩国'] },
  { label: '美国市场', aliases: ['美国'] },
  { label: '欧洲市场', aliases: ['欧洲', '欧盟'] },
  { label: '中东市场', aliases: ['中东'] },
  { label: '拉美市场', aliases: ['拉美', '拉丁美洲'] },
  { label: '东南亚市场', aliases: ['东南亚'] },
  { label: '中国市场', aliases: ['中国', '国内市场'] },
];

function splitNarrative(text) {
  return text
    .split(/[。！？!?；;\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function findSentence(sentences, keywords) {
  return sentences.find((sentence) => keywords.some((keyword) => sentence.includes(keyword))) || '';
}

export function extractMarket(text) {
  const found = marketCatalog
    .filter((market) => market.aliases.some((alias) => text.includes(alias)))
    .map((market) => market.label);
  if (found.length) return found.slice(0, 3).join(' / ');
  if (/(AI|人工智能|大模型|模型|Token|token|智能体|Agent|agent)/.test(text)) return 'AI 产品场景';
  return '具体场景待确认';
}

function inferStage(text) {
  if (/(刚开始|准备|筹备|启动|冷启动|验证阶段|从零|从 0)/.test(text)) return '刚开始验证';
  if (/(规模化|放大|提效|提升效率|稳定增长|复制到)/.test(text) && !/(下降|卡住|受阻|无法|问题)/.test(text)) return '需要提升效率';
  return '已经在推进';
}

function inferDeadline(text, fallback) {
  if (/(今天|明天|24\s*小时|48\s*小时|1\s*[-至到]\s*3\s*天)/.test(text)) return '1-3 天';
  if (/(两周|2\s*周|14\s*天|一个月|1\s*个月|30\s*天|4\s*周)/.test(text)) return '2-4 周';
  if (/(一周|7\s*天|10\s*天|三天|3\s*天|尽快)/.test(text)) return '3-10 天';
  return fallback || '尚未确定';
}

export function parseDemandText(text, options = {}) {
  const sentences = splitNarrative(text);
  const impact = findSentence(sentences, ['影响', '导致', '损失', '下降', '增加', '延误', '无法', '成本', '收入', '转化', '流量']);
  const tried = findSentence(sentences, ['尝试', '试过', '提交', '更换', '调整', '优化', '排查', '测试']);
  const result = findSentence([...sentences].reverse(), ['希望', '目标', '期望', '想要', '需要一份', '需要找到', '找出', '解决']);
  return {
    problem: text.trim(),
    market: extractMarket(text),
    stage: inferStage(text),
    impact: impact || '具体业务影响待进一步确认',
    tried,
    result: result || '明确主要原因，并形成可执行、可验收的下一步方案',
    deadline: inferDeadline(text, options.fallbackDeadline),
    sensitive: Boolean(options.sensitive),
  };
}

export function inferTalentContext(text, skills = [], fallbackMarket = '') {
  const market = extractMarket(text);
  return {
    market: market === '具体场景待确认' && fallbackMarket ? fallbackMarket : market,
    field: [...new Set(skills.map((skill) => skill.category).filter(Boolean))].slice(0, 2).join(' / ') || '能力方向待确认',
  };
}
