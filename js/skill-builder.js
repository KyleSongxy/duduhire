import { capabilityCatalog, enterpriseDemandCatalog, serviceSkus, talentSkillTemplates } from './data.js';
import { inferTalentContext, parseDemandText } from './ai-parser.js';
import { createContentKey, getUsageReceipt, recordUsage } from './usage-meter.js';

const params = new URLSearchParams(window.location.search);
const validRoles = new Set(['enterprise', 'talent']);
const roleSelection = document.getElementById('role-selection');
const appMain = document.getElementById('app-main');
const enterpriseFlow = document.getElementById('enterprise-flow');
const talentFlow = document.getElementById('talent-flow');
const switchEnterprise = document.getElementById('switch-enterprise');
const switchTalent = document.getElementById('switch-talent');
const appTitle = document.getElementById('app-title');
const appEyebrow = document.getElementById('app-eyebrow');
const toast = document.getElementById('toast');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let currentRole = validRoles.has(params.get('role')) ? params.get('role') : '';
let enterpriseCopy = '';
let talentCopy = '';
let pendingEnterpriseValues = null;
let enterpriseContentKey = '';
let pendingTalentValues = null;
let activeTalentSkills = [];
let talentContentKey = '';
let toastTimer;

const talentExamples = {
  content: '我负责印尼市场的 TikTok 内容运营。账号自然流量连续下降后，我按内容类型审计近 30 天数据，对照竞品和发布时间，调整内容结构并设计两周测试。最终自然播放量提升 62%，过程和结果可由周报及后台数据证明。',
  research: '我曾为一款面向东南亚的 SaaS 产品设计用户研究，在两周内完成 12 位目标用户访谈。我负责研究问题、招募标准、访谈和洞察整理，最终推动团队调整了试用引导与定价表达，相关结论可由研究报告和版本记录证明。',
  delivery: '我负责协调总部、印尼团队和外部供应商完成三个市场的新品发布。我重新梳理依赖、负责人和里程碑，建立风险升级与验收机制，最终按期上线并减少了重复返工，相关过程可由项目计划和复盘记录证明。',
};

const draftConfig = {
  enterprise: {
    key: 'duduhire-enterprise-draft-v1',
    form: 'enterprise-form',
    status: 'enterprise-draft-status',
    fields: ['enterprise-problem', 'enterprise-market', 'enterprise-stage', 'enterprise-impact', 'enterprise-tried', 'enterprise-result', 'enterprise-submitter-role', 'enterprise-owner-name', 'enterprise-deadline', 'enterprise-sensitive'],
  },
  talent: {
    key: 'duduhire-talent-draft-v1',
    form: 'talent-form',
    status: 'talent-draft-status',
    fields: ['talent-experience', 'talent-market', 'talent-field'],
  },
};

function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2200);
}

async function copyText(text, successMessage = '摘要已复制') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    showToast(copied ? successMessage : '复制失败，请手动选择文本');
  }
}

function copyCollaborationInvite() {
  const owner = document.getElementById('enterprise-owner-name').value.trim() || '最了解实际情况的业务负责人';
  const problem = document.getElementById('enterprise-problem').value.trim();
  const excerpt = problem ? `\n目前的初步描述：${problem.slice(0, 180)}${problem.length > 180 ? '…' : ''}` : '';
  const invite = [
    `${owner}，我们正在整理一个需要解决的真实问题，不是请你写职位描述。`,
    '请直接用文字或语音回答四件事：',
    '1. 现在具体发生了什么？',
    '2. 它正在影响哪个业务结果？',
    '3. 团队已经尝试过什么？',
    '4. 看到什么结果才算问题解决？',
    excerpt,
    '收到后我会把信息整理成可验证的痛点描述，再判断适合找专家、拆微任务还是招聘长期人才。',
  ].filter(Boolean).join('\n');
  copyText(invite, '补充邀请已复制');
  document.getElementById('collaboration-status').textContent = '已复制，可直接发送给实际负责人。';
}

function downloadText(text, filename) {
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast('文件已下载');
}

function scrollToElement(element, block = 'start') {
  element.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block });
}

function readDraft(config) {
  try {
    return JSON.parse(window.sessionStorage.getItem(config.key) || 'null');
  } catch {
    return null;
  }
}

function writeDraft(config) {
  const values = {};
  config.fields.forEach((id) => {
    const field = document.getElementById(id);
    values[id] = field.type === 'checkbox' ? field.checked : field.value;
  });
  try {
    window.sessionStorage.setItem(config.key, JSON.stringify(values));
    const status = document.getElementById(config.status);
    status.textContent = '草稿已保存在当前会话';
  } catch {
    document.getElementById(config.status).textContent = '浏览器未允许保存草稿';
  }
}

function restoreDraft(config) {
  const values = readDraft(config);
  if (!values) return false;
  config.fields.forEach((id) => {
    const field = document.getElementById(id);
    if (!(id in values)) return;
    if (field.type === 'checkbox') field.checked = Boolean(values[id]);
    else field.value = values[id];
  });
  document.getElementById(config.status).textContent = '已恢复当前会话草稿';
  return true;
}

function bindDraft(config) {
  restoreDraft(config);
  config.fields.forEach((id) => {
    const field = document.getElementById(id);
    field.addEventListener(field.type === 'checkbox' || field.tagName === 'SELECT' ? 'change' : 'input', () => writeDraft(config));
  });
}

function removeDraft(config) {
  try { window.sessionStorage.removeItem(config.key); } catch { /* no-op */ }
  document.getElementById(config.status).textContent = '草稿已清除';
}

function setRole(role, updateUrl = true) {
  currentRole = role;
  roleSelection.hidden = true;
  appMain.hidden = false;
  const enterpriseActive = role === 'enterprise';
  enterpriseFlow.hidden = !enterpriseActive;
  talentFlow.hidden = enterpriseActive;
  switchEnterprise.classList.toggle('active', enterpriseActive);
  switchTalent.classList.toggle('active', !enterpriseActive);
  switchEnterprise.setAttribute('aria-pressed', String(enterpriseActive));
  switchTalent.setAttribute('aria-pressed', String(!enterpriseActive));
  appEyebrow.textContent = enterpriseActive ? 'AI PAIN PARSING' : 'AI CAPABILITY PARSING';
  appTitle.innerHTML = enterpriseActive
    ? '<span class="app-title-line">说一段真实情况，</span><span class="app-title-line">让 AI 自动整理痛点</span>'
    : '<span class="app-title-line">提供一段真实经历，</span><span class="app-title-line">让 AI 自动解析能力</span>';
  document.title = enterpriseActive ? '描述我的痛点｜嘟嘟嗨 Duduhire' : '挖掘我的能力｜嘟嘟嗨 Duduhire';
  if (updateUrl) {
    const next = new URL(window.location.href);
    next.searchParams.set('role', role);
    window.history.replaceState({}, '', next);
  }
}

switchEnterprise.addEventListener('click', () => setRole('enterprise'));
switchTalent.addEventListener('click', () => setRole('talent'));

if (currentRole) {
  setRole(currentRole, false);
} else {
  roleSelection.hidden = false;
  appMain.hidden = true;
}

bindDraft(draftConfig.enterprise);
bindDraft(draftConfig.talent);

function syncCollaborationFields() {
  const role = document.getElementById('enterprise-submitter-role').value;
  document.getElementById('collaboration-invite').hidden = role === 'owner';
}

document.getElementById('enterprise-submitter-role').addEventListener('change', syncCollaborationFields);
syncCollaborationFields();

function applyDemandExample(demandId) {
  const demand = enterpriseDemandCatalog.find((item) => item.id === demandId);
  if (!demand) return;
  const input = document.getElementById('enterprise-problem');
  input.value = demand.example;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const deadline = document.getElementById('enterprise-deadline');
  deadline.value = demand.duration.includes('2-4 周') ? '2-4 周' : demand.duration.includes('1-3 天') ? '1-3 天' : '3-10 天';
  deadline.dispatchEvent(new Event('change', { bubbles: true }));
  setError('enterprise-problem', '');
  showToast('已带入痛点示例，可直接修改');
  input.focus();
}

function applyTalentExample(exampleId) {
  const example = talentExamples[exampleId];
  if (!example) return;
  const input = document.getElementById('talent-experience');
  input.value = example;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  setError('talent-experience', '');
  showToast('已带入经历示例，请替换成你的真实情况');
  input.focus();
}

function bindCounter(inputId, outputId) {
  const input = document.getElementById(inputId);
  const output = document.getElementById(outputId);
  const render = () => { output.textContent = `${input.value.length} / ${input.maxLength}`; };
  input.addEventListener('input', render);
  render();
}

bindCounter('enterprise-problem', 'problem-count');
bindCounter('talent-experience', 'experience-count');

function setError(inputId, message) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(`${inputId}-error`);
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (error) error.textContent = message;
}

const fieldValidators = {
  'enterprise-problem': (value) => value.trim().length < 30 ? '请至少用 30 个字说明发生了什么，以及它正在影响什么。' : '',
  'talent-experience': (value) => value.trim().length < 40 ? '请至少用 40 个字说明任务、你的具体动作与结果。' : '',
};

function validateField(id) {
  const field = document.getElementById(id);
  const message = fieldValidators[id](field.value);
  setError(id, message);
  return message;
}

function setErrorSummary(id, visible) {
  const summary = document.getElementById(id);
  summary.hidden = !visible;
}

['enterprise-problem', 'talent-experience'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => setError(id, ''));
  document.getElementById(id).addEventListener('change', () => setError(id, ''));
  document.getElementById(id).addEventListener('blur', () => validateField(id));
});

function updateSteps(prefix, activeNumber) {
  const stepCount = document.querySelectorAll(`[id^="${prefix}-step-"]`).length;
  for (let index = 1; index <= stepCount; index += 1) {
    const step = document.getElementById(`${prefix}-step-${index}`);
    step.classList.remove('active', 'done');
    step.removeAttribute('aria-current');
    if (index < activeNumber) step.classList.add('done');
    if (index === activeNumber) {
      step.classList.add('active');
      step.setAttribute('aria-current', 'step');
    }
  }
}

function runLoading(type, steps) {
  const loading = document.getElementById(`${type}-loading`);
  const title = document.getElementById(`${type}-loading-title`);
  const detail = document.getElementById(`${type}-loading-detail`);
  const progress = document.getElementById(`${type}-progress`);
  loading.hidden = false;

  return new Promise((resolve) => {
    let index = 0;
    const next = () => {
      const step = steps[index];
      title.textContent = step.title;
      detail.textContent = step.detail;
      progress.style.transform = `scaleX(${step.progress / 100})`;
      index += 1;
      if (index < steps.length) window.setTimeout(next, 430);
      else window.setTimeout(resolve, 260);
    };
    next();
  });
}

function scoreCapabilities(text) {
  const normalized = text.toLowerCase();
  const scored = capabilityCatalog.map((capability, index) => ({
    capability,
    index,
    score: capability.keywords.reduce((sum, keyword) => sum + (normalized.includes(keyword.toLowerCase()) ? 1 : 0), 0),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = scored.filter((item) => item.score > 0).slice(0, 3).map((item) => item.capability);
  for (const item of scored) {
    if (selected.length >= 3) break;
    if (!selected.some((capability) => capability.id === item.capability.id)) selected.push(item.capability);
  }
  return selected.slice(0, 3);
}

function scoreDemands(text) {
  const normalized = text.toLowerCase();
  const scored = enterpriseDemandCatalog.map((demand, index) => ({
    demand,
    index,
    score: demand.keywords.reduce((sum, keyword) => sum + (normalized.includes(keyword.toLowerCase()) ? 1 : 0), 0),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = scored.filter((item) => item.score > 0).slice(0, 3).map((item) => item.demand);
  for (const item of scored) {
    if (selected.length >= 3) break;
    if (!selected.some((demand) => demand.id === item.demand.id)) selected.push(item.demand);
  }
  return selected.slice(0, 3);
}

function getService(deadline) {
  if (deadline === '1-3 天') return serviceSkus[0];
  if (deadline === '2-4 周') return serviceSkus[2];
  return serviceSkus[1];
}

function syncParsedDemandFields(values) {
  const parsedFields = {
    'enterprise-market': values.market,
    'enterprise-stage': values.stage,
    'enterprise-impact': values.impact,
    'enterprise-tried': values.tried,
    'enterprise-result': values.result,
    'enterprise-deadline': values.deadline,
  };
  Object.entries(parsedFields).forEach(([id, value]) => {
    const field = document.getElementById(id);
    field.value = value;
    field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

const enterpriseForm = document.getElementById('enterprise-form');
enterpriseForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const problem = document.getElementById('enterprise-problem').value.trim();
  const error = validateField('enterprise-problem');
  setErrorSummary('enterprise-error-summary', Boolean(error));
  if (error) {
    document.getElementById('enterprise-problem').focus();
    return;
  }
  const values = parseDemandText(problem, {
    fallbackDeadline: document.getElementById('enterprise-deadline').value,
    sensitive: document.getElementById('enterprise-sensitive').checked,
  });
  values.submitterRole = document.getElementById('enterprise-submitter-role').value;
  values.owner = document.getElementById('enterprise-owner-name').value.trim();
  values.acceptance = '';
  values.access = '';
  syncParsedDemandFields(values);

  const submit = document.getElementById('analyze-btn');
  submit.disabled = true;
  enterpriseForm.hidden = true;
  document.getElementById('enterprise-status').textContent = 'AI 解析中';
  document.getElementById('enterprise-status').className = 'status-badge warning';
  updateSteps('e', 2);
  await runLoading('enterprise', [
    { title: 'AI 正在理解你的描述', detail: '识别业务场景、现象与关键阻碍', progress: 28 },
    { title: 'AI 正在拆解任务结构', detail: '提取影响、预期交付与时间约束', progress: 62 },
    { title: 'AI 正在生成确认问题', detail: '标记缺失信息与待核验能力方向', progress: 100 },
  ]);
  document.getElementById('enterprise-loading').hidden = true;
  submit.disabled = false;
  renderEnterpriseQuestions(values);
});

function buildDemandQuestions(values) {
  const questions = [];
  if (values.impact === '具体业务影响待进一步确认') {
    questions.push({
      id: 'impact',
      label: '这个问题正在影响哪个业务结果？',
      hint: '例如：延误新品发布、增加获客成本、让团队无法判断下一步。',
    });
  } else {
    questions.push({
      id: 'acceptance',
      label: '看到什么结果，才算这次问题真正被解决？',
      hint: '尽量写可观察的判断标准，而不是“效果更好”。',
    });
  }
  questions.push(values.tried ? {
    id: 'tried-detail',
    label: '已经尝试的动作中，哪些短期有效，哪些完全无效？',
    hint: '这能避免匹配到的人重复做已经验证过的事情。',
  } : {
    id: 'tried',
    label: '团队已经尝试过哪些动作，分别发生了什么？',
    hint: '如果还没有尝试，可以直接填写“尚未尝试”。',
  });
  if (values.result === '明确主要原因，并形成可执行、可验收的下一步方案') {
    questions.push({
      id: 'result',
      label: '你希望对方最终交付什么，而不只是提供建议？',
      hint: '例如：诊断报告、两周行动清单、内容样稿或验证数据。',
    });
  } else {
    questions.push({
      id: 'access',
      label: '完成任务最少需要哪些数据、权限或协作人员？',
      hint: '只写必要范围，敏感信息可以先写类别，不需要粘贴原始材料。',
    });
  }
  questions.push({
    id: 'owner',
    label: values.submitterRole === 'owner'
      ? '谁会使用结果，并确认它是否解决了实际问题？'
      : '哪位业务负责人最了解情况，并可以确认最终结果？',
    hint: values.owner ? `当前填写：${values.owner}。可以补充其确认方式。` : '填写角色或团队即可，不需要提供联系方式。',
  });
  if (values.sensitive && questions.length < 5) {
    questions.push({
      id: 'sensitive-boundary',
      label: '哪些信息可以用于诊断，哪些必须保持不可见？',
      hint: '例如：可看脱敏趋势，不可看用户身份与完整订单。',
    });
  }
  return questions.slice(0, 5);
}

function renderEnterpriseQuestions(values) {
  pendingEnterpriseValues = values;
  enterpriseContentKey = createContentKey('demand', values.problem);
  recordUsage({
    flow: 'demand',
    stage: 'structure',
    contentKey: enterpriseContentKey,
    inputCharacters: values.problem.length,
  });
  const questions = buildDemandQuestions(values);
  document.getElementById('enterprise-output').innerHTML = `
    <div class="result-wrap demand-question-stage">
      <section class="result-summary">
        <div class="result-summary-top">
          <div>
            <span class="mini-label">智能整理演示</span>
            <h3>问题结构已识别，还差 ${questions.length} 个关键答案</h3>
            <p>只追问会影响匹配和验收的信息，不重复填写传统需求表。</p>
          </div>
          <strong class="result-price">${questions.length} 题</strong>
        </div>
        <div class="disclaimer">你可以回答后查看更完整的匹配，也可以先跳过，用现有信息预览结果。</div>
      </section>
      <form class="demand-followup-form" id="enterprise-followup-form" novalidate>
        ${questions.map((question, index) => `
          <section class="demand-question-card">
            <div class="demand-question-number">${String(index + 1).padStart(2, '0')}</div>
            <div>
              <label class="form-label" for="demand-answer-${escapeHTML(question.id)}">${escapeHTML(question.label)}</label>
              <textarea class="form-textarea compact" id="demand-answer-${escapeHTML(question.id)}" data-demand-answer="${escapeHTML(question.id)}" maxlength="420" aria-describedby="demand-hint-${escapeHTML(question.id)} demand-error-${escapeHTML(question.id)}" placeholder="${escapeHTML(question.hint)}"></textarea>
              <p class="form-hint" id="demand-hint-${escapeHTML(question.id)}">${escapeHTML(question.hint)}</p>
              <p class="field-error" id="demand-error-${escapeHTML(question.id)}" role="alert"></p>
            </div>
          </section>
        `).join('')}
        <div class="result-actions">
          <button class="btn btn-primary btn-large" type="submit">确认信息并查看匹配</button>
          <button class="btn btn-secondary" type="button" data-action="skip-enterprise-followup">先用现有信息预览</button>
          <button class="btn btn-ghost" type="button" data-action="reset-enterprise">返回修改原文</button>
        </div>
      </form>
    </div>`;
  document.getElementById('enterprise-status').textContent = '待补充';
  document.getElementById('enterprise-status').className = 'status-badge warning';
  document.getElementById('enterprise-output-status').textContent = `${questions.length} 个确认问题`;
  document.getElementById('enterprise-output-status').className = 'status-badge warning';
  const layout = enterpriseFlow.querySelector('.builder-layout');
  const inputPanel = enterpriseForm.closest('.builder-panel');
  const outputPanel = document.getElementById('enterprise-output').closest('.builder-panel');
  inputPanel.hidden = true;
  layout.classList.add('result-mode');
  updateSteps('e', 3);
  scrollToElement(outputPanel);
  document.querySelector('[data-demand-answer]')?.focus({ preventScroll: true });
}

function mergeDemandAnswers(values, answers) {
  const next = { ...values };
  if (answers.impact) next.impact = answers.impact;
  if (answers.tried) next.tried = answers.tried;
  if (answers['tried-detail']) next.tried = `${next.tried || '已尝试动作'}；补充：${answers['tried-detail']}`;
  if (answers.result) next.result = answers.result;
  if (answers.acceptance) next.acceptance = answers.acceptance;
  if (answers.access) next.access = answers.access;
  if (answers.owner) next.owner = answers.owner;
  if (answers['sensitive-boundary']) next.sensitiveBoundary = answers['sensitive-boundary'];
  return next;
}

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'enterprise-followup-form') return;
  event.preventDefault();
  const answers = {};
  let firstInvalid = null;
  event.target.querySelectorAll('[data-demand-answer]').forEach((field) => {
    const value = field.value.trim();
    answers[field.dataset.demandAnswer] = value;
    const error = document.getElementById(`demand-error-${field.dataset.demandAnswer}`);
    const message = value.length < 4 ? '请简短回答，或选择“先用现有信息预览”。' : '';
    field.setAttribute('aria-invalid', message ? 'true' : 'false');
    error.textContent = message;
    if (message && !firstInvalid) firstInvalid = field;
  });
  if (firstInvalid) {
    firstInvalid.focus();
    return;
  }
  renderEnterpriseResult(mergeDemandAnswers(pendingEnterpriseValues, answers));
});

function renderEnterpriseResult(values) {
  const service = getService(values.deadline);
  const capabilities = scoreCapabilities(`${values.problem} ${values.result} ${values.market}`);
  const leadCapability = capabilities[0];
  const contentKey = enterpriseContentKey || createContentKey('demand', values.problem);
  recordUsage({
    flow: 'demand',
    stage: 'match',
    contentKey,
    inputCharacters: values.problem.length,
  });
  const usage = getUsageReceipt('demand', contentKey);

  enterpriseCopy = [
    '《结构化痛点描述｜草稿》',
    `发生场景与状态：${values.market} / ${values.stage}`,
    `痛点描述：${values.problem}`,
    `造成影响：${values.impact}`,
    `已尝试：${values.tried || '待补充'}`,
    `期望结果：${values.result}`,
    `验收方式：${values.acceptance || values.result}`,
    `业务确认人：${values.owner || '待确认'}`,
    `必要信息：${values.access || '待确认最小数据与权限范围'}`,
    `建议下一步：${service.name}（${service.duration}）`,
    `优先核验能力：${capabilities.map((item) => item.name).join('、')}`,
    `敏感材料：${values.sensitive ? '涉及，需先确认保密与权限' : '暂未标记'}`,
    `建议微任务：由“${leadCapability.name}”方向先完成${leadCapability.deliverables.slice(0, 3).join('、')}。`,
    '说明：这是本地匹配演示，能力方向、真实人员、证据和档期仍需人工核验。',
  ].join('\n');

  document.getElementById('enterprise-output').innerHTML = `
    <div class="result-wrap demand-match-result">
      <section class="result-summary match-result-summary">
        <div class="result-summary-top">
          <div>
            <span class="mini-label">平台匹配演示</span>
            <h3>已找到 ${capabilities.length} 个优先核验方向</h3>
            <p>结果来自场景、任务、证据要求与合作边界的对照，不是简历关键词排序。</p>
          </div>
          <strong class="result-price">待核验</strong>
        </div>
        <div class="disclaimer">当前公开页只展示匹配逻辑，不代表具体人员已通过审核或确认档期。</div>
      </section>
      <section class="result-section">
        <h3>结构化痛点描述</h3>
        <div class="brief-result">
          <div class="brief-result-row"><span>场景与状态</span><p>${escapeHTML(values.market)} · ${escapeHTML(values.stage)}</p></div>
          <div class="brief-result-row"><span>痛点描述</span><p>${escapeHTML(values.problem)}</p></div>
          <div class="brief-result-row"><span>造成影响</span><p>${escapeHTML(values.impact)}</p></div>
          <div class="brief-result-row"><span>已尝试</span><p>${escapeHTML(values.tried || '尚未填写，需在访谈中补充')}</p></div>
          <div class="brief-result-row"><span>期望结果</span><p>${escapeHTML(values.result)}</p></div>
          <div class="brief-result-row"><span>业务确认人</span><p>${escapeHTML(values.owner || '待确认')}</p></div>
          <div class="brief-result-row"><span>验收方式</span><p>${escapeHTML(values.acceptance || values.result)}</p></div>
          <div class="brief-result-row"><span>必要信息</span><p>${escapeHTML(values.access || '待确认最小数据、权限与协作人员')}</p></div>
          <div class="brief-result-row"><span>完成时间</span><p>${escapeHTML(values.deadline)}</p></div>
        </div>
      </section>
      <section class="result-section platform-work-section">
        <div class="result-section-heading">
          <div><span class="mini-label">平台在中间做什么</span><h3>说明为什么值得继续验证</h3></div>
        </div>
        <div class="platform-work-grid">
          <div><span>整理</span><strong>把一句困扰变成可确认的任务边界</strong></div>
          <div><span>对照</span><strong>比较相似场景、实际任务与证据要求</strong></div>
          <div><span>验证</span><strong>用微任务确认能力、沟通与交付质量</strong></div>
        </div>
      </section>
      <section class="result-section">
        <div class="result-section-heading">
          <div><span class="mini-label">能力匹配方向</span><h3>先看做过什么，再确认是谁</h3></div>
          <small>${capabilities.length} 项待核验</small>
        </div>
        <div class="match-direction-grid">
          ${capabilities.map((capability, index) => `
            <article class="match-direction-card${index === 0 ? ' featured' : ''}">
              <div class="match-direction-top">
                <span>${index === 0 ? '优先核验' : '补充方向'}</span>
                <small>${escapeHTML(capability.category)}</small>
              </div>
              <h3>${escapeHTML(capability.name)}</h3>
              <p>${escapeHTML(capability.description)}</p>
              <ul>
                <li><span>场景</span><strong>${escapeHTML(capability.markets.slice(0, 3).join('、'))}</strong></li>
                <li><span>任务</span><strong>${escapeHTML(capability.tasks[0])}</strong></li>
                <li><span>证据</span><strong>${escapeHTML(capability.evidence)}</strong></li>
              </ul>
              <details>
                <summary>查看能力边界与交付</summary>
                <dl>
                  <div><dt>典型交付</dt><dd>${escapeHTML(capability.deliverables.join('、'))}</dd></div>
                  <div><dt>能力边界</dt><dd>${escapeHTML(capability.boundary)}</dd></div>
                </dl>
              </details>
            </article>
          `).join('')}
        </div>
      </section>
      <section class="microtask-recommendation">
        <div>
          <span class="mini-label">建议下一步 · 先验证再决定</span>
          <h3>${escapeHTML(service.name)} · ${escapeHTML(service.duration)}</h3>
          <p>由“${escapeHTML(leadCapability.name)}”方向先完成${escapeHTML(leadCapability.deliverables.slice(0, 3).join('、'))}，再决定扩大协作或进入招聘。</p>
        </div>
        <dl>
          <div><dt>输入边界</dt><dd>${escapeHTML(values.access || '仅提供完成诊断所需的最小数据与脱敏材料')}</dd></div>
          <div><dt>验收标准</dt><dd>${escapeHTML(values.acceptance || values.result)}</dd></div>
          <div><dt>仍需确认</dt><dd>真实案例、证据有效性、可用档期与合作方式</dd></div>
        </dl>
      </section>
      <details class="usage-receipt">
        <summary><span>本次处理记录</span><small>输入过程中 0 次模型调用</small></summary>
        <div>
          <span><strong>${usage.localOperations}</strong><small>本地演示步骤</small></span>
          <span><strong>${usage.modelCalls}</strong><small>实际模型调用</small></span>
          <span><strong>${usage.tokens}</strong><small>实际 Token</small></span>
          <p>${usage.reused ? '检测到相同内容；会话已标记为可复用，正式接入模型时可避免重复计费。' : '调用只发生在“确认解析”和“查看匹配”两个明确动作；演示版使用本地规则，不产生 Token 成本。'}</p>
        </div>
      </details>
      <div class="result-actions">
        <button class="btn btn-primary" type="button" data-action="copy-enterprise">复制痛点与匹配摘要</button>
        <button class="btn btn-secondary" type="button" data-action="download-enterprise">下载 TXT</button>
        <button class="btn btn-secondary" type="button" data-action="reset-enterprise">修改原文并重新解析</button>
      </div>
      <div class="privacy-note"><span aria-hidden="true">i</span><p><strong>当前结果只保存在本页面，不会自动发起服务申请。</strong>正式撮合前会再次确认材料用途、人员证据、档期和合作边界。</p></div>
    </div>
  `;
  document.getElementById('enterprise-status').textContent = '已生成';
  document.getElementById('enterprise-status').className = 'status-badge success';
  document.getElementById('enterprise-output-status').textContent = '匹配预览';
  document.getElementById('enterprise-output-status').className = 'status-badge success';
  const layout = enterpriseFlow.querySelector('.builder-layout');
  const inputPanel = enterpriseForm.closest('.builder-panel');
  const outputPanel = document.getElementById('enterprise-output').closest('.builder-panel');
  inputPanel.hidden = true;
  layout.classList.add('result-mode');
  updateSteps('e', 4);
  scrollToElement(outputPanel);
}

function resetEnterprise() {
  enterpriseForm.closest('.builder-panel').hidden = false;
  enterpriseFlow.querySelector('.builder-layout').classList.remove('result-mode');
  enterpriseForm.hidden = false;
  pendingEnterpriseValues = null;
  enterpriseContentKey = '';
  document.getElementById('enterprise-output').innerHTML = `
    <div class="empty-state"><div class="empty-state-inner"><div class="empty-visual ai-empty-visual" aria-hidden="true">AI</div><h3>修改后重新解析</h3><p>原文仍保留在左侧。补充背景、影响或目标后，再让 AI 重新整理。</p></div></div>`;
  document.getElementById('enterprise-status').textContent = '可修改';
  document.getElementById('enterprise-status').className = 'status-badge';
  document.getElementById('enterprise-output-status').textContent = '待生成';
  document.getElementById('enterprise-output-status').className = 'status-badge';
  document.getElementById('enterprise-progress').style.transform = 'scaleX(0)';
  updateSteps('e', 1);
  document.getElementById('enterprise-problem').focus();
}

const talentForm = document.getElementById('talent-form');

function getTalentSkills(text) {
  const normalized = text.toLowerCase();
  const scored = talentSkillTemplates.map((skill, index) => ({
    skill,
    index,
    score: skill.keywords.reduce((sum, keyword) => sum + (normalized.includes(keyword.toLowerCase()) ? 1 : 0), 0),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const matches = scored.filter((item) => item.score > 0).slice(0, 5).map((item) => item.skill);
  const selected = [...matches];
  for (const item of scored) {
    if (selected.length >= 3) break;
    if (!selected.some((skill) => skill.id === item.skill.id)) selected.push(item.skill);
  }
  return selected.slice(0, 5);
}

function getSkillQuestion(skill) {
  return `在“${skill.task}”这类事情中，你本人具体负责哪一步？用了什么方法，最终结果怎样被确认？`;
}

function renderSkillQuestions(values, skills) {
  pendingTalentValues = values;
  activeTalentSkills = skills;
  document.getElementById('talent-output').innerHTML = `
    <div class="result-wrap skill-question-stage">
      <section class="result-summary">
        <span class="mini-label">AI 初步解析</span>
        <h3>识别到 ${skills.length} 项能力原子</h3>
        <p>请核对 AI 提炼的能力方向，并补充本人行动、结果与证据。</p>
        <div class="capability-tags">${skills.map((skill) => `<span class="capability-tag">${escapeHTML(skill.category)} · ${escapeHTML(skill.name)}</span>`).join('')}</div>
      </section>
      <form class="skill-questions-form" id="skill-questions-form" novalidate>
        ${skills.map((skill, index) => `
          <section class="skill-question-card">
            <div class="skill-question-head"><span>${String(index + 1).padStart(2, '0')}</span><div><small>${escapeHTML(skill.category)}</small><h3>${escapeHTML(skill.name)}</h3></div></div>
            <label class="form-label" for="skill-answer-${escapeHTML(skill.id)}">${escapeHTML(getSkillQuestion(skill))}</label>
            <div class="textarea-with-action">
              <textarea class="form-textarea compact" id="skill-answer-${escapeHTML(skill.id)}" data-skill-answer="${escapeHTML(skill.id)}" maxlength="420" aria-describedby="skill-error-${escapeHTML(skill.id)}" placeholder="例如：我负责数据诊断和策略判断；先按内容类型对照近 30 天数据，再排除发布节奏和素材质量问题，最后用两周测试确认调整方向。"></textarea>
              <button class="voice-button" type="button" data-voice-target="skill-answer-${escapeHTML(skill.id)}" aria-label="使用语音回答 ${escapeHTML(skill.name)} 的追问"><span aria-hidden="true">◉</span> 语音回答</button>
            </div>
            <p class="field-error" id="skill-error-${escapeHTML(skill.id)}" role="alert"></p>
          </section>
        `).join('')}
        <div class="result-actions">
          <button class="btn btn-primary btn-large" type="submit">生成个人能力名片</button>
          <button class="btn btn-ghost" type="button" data-action="reset-talent">返回修改经历</button>
        </div>
      </form>
    </div>`;
  document.getElementById('talent-status').textContent = '待确认';
  document.getElementById('talent-status').className = 'status-badge warning';
  document.getElementById('talent-output-status').textContent = `${skills.length} 项能力原子`;
  document.getElementById('talent-output-status').className = 'status-badge warning';
  const layout = talentFlow.querySelector('.builder-layout');
  const inputPanel = talentForm.closest('.builder-panel');
  const outputPanel = document.getElementById('talent-output').closest('.builder-panel');
  inputPanel.hidden = true;
  layout.classList.add('result-mode');
  updateSteps('t', 3);
  scrollToElement(outputPanel);
  document.querySelector('[data-skill-answer]')?.focus({ preventScroll: true });
}

talentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = {
    experience: document.getElementById('talent-experience').value.trim(),
    market: '',
    field: '',
  };
  const experienceError = validateField('talent-experience');
  setError('talent-experience', experienceError);
  setErrorSummary('talent-error-summary', Boolean(experienceError));
  if (experienceError) {
    document.getElementById('talent-experience').focus();
    return;
  }

  talentContentKey = createContentKey('talent', values.experience);
  recordUsage({
    flow: 'talent',
    stage: 'capability-structure',
    contentKey: talentContentKey,
    inputCharacters: values.experience.length,
  });

  const submit = document.getElementById('decode-btn');
  submit.disabled = true;
  talentForm.hidden = true;
  document.getElementById('talent-status').textContent = 'AI 解析中';
  document.getElementById('talent-status').className = 'status-badge warning';
  updateSteps('t', 1);
  await runLoading('talent', [
    { title: 'AI 正在阅读你的经历', detail: '区分岗位描述与本人实际行动', progress: 30 },
    { title: 'AI 正在提炼能力原子', detail: '连接任务、方法、结果与证据', progress: 66 },
    { title: 'AI 正在生成针对性追问', detail: '继续确认贡献边界与熟练程度', progress: 100 },
  ]);
  document.getElementById('talent-loading').hidden = true;
  submit.disabled = false;
  const skills = getTalentSkills(values.experience);
  const inferredContext = inferTalentContext(values.experience, skills, document.getElementById('talent-market').value);
  values.market = inferredContext.market;
  values.field = inferredContext.field;
  document.getElementById('talent-market').value = values.market;
  document.getElementById('talent-field').value = values.field;
  document.getElementById('talent-market').dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('talent-field').dispatchEvent(new Event('input', { bubbles: true }));
  renderSkillQuestions(values, skills);
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'skill-questions-form') return;
  event.preventDefault();
  const answers = {};
  let firstInvalid = null;
  event.target.querySelectorAll('[data-skill-answer]').forEach((field) => {
    const value = field.value.trim();
    answers[field.dataset.skillAnswer] = value;
    const error = document.getElementById(`skill-error-${field.dataset.skillAnswer}`);
    const message = value.length < 12 ? '请至少用 12 个字说明你本人做了什么、怎么做或结果如何。' : '';
    field.setAttribute('aria-invalid', message ? 'true' : 'false');
    error.textContent = message;
    if (message && !firstInvalid) firstInvalid = field;
  });
  if (firstInvalid) {
    firstInvalid.focus();
    return;
  }
  renderTalentResult(pendingTalentValues, activeTalentSkills, answers);
});

function renderTalentResult(values, skills, answers) {
  const scene = [values.market || '场景待补充', values.field || '方向由能力提炼'].join(' · ');
  const matchingDemands = scoreDemands(`${values.experience} ${skills.map((skill) => `${skill.name} ${skill.task}`).join(' ')}`);
  const contentKey = talentContentKey || createContentKey('talent', values.experience);
  recordUsage({
    flow: 'talent',
    stage: 'evidence-card',
    contentKey,
    inputCharacters: values.experience.length,
  });
  const usage = getUsageReceipt('talent', contentKey);
  talentCopy = [
    '《个人能力名片｜初步版》',
    `场景：${scene}`,
    `能力原子：${skills.map((skill) => skill.name).join('、')}`,
    '',
    ...skills.map((skill, index) => [
      `${index + 1}. ${skill.name}｜${skill.category}｜L0 初步推测`,
      `一句话：${skill.task}`,
      `本人补充：${answers[skill.id]}`,
      `典型产出：${skill.deliverables.join('、')}`,
      `可核验证据：${skill.evidenceExamples}`,
      `能力边界：${skill.boundary}`,
    ].join('\n')),
    '',
    `可匹配痛点方向：${matchingDemands.map((demand) => demand.title).join('、')}`,
    '',
    '说明：本名片来自简历、经历自述与针对性追问，不等于能力认证或平台推荐。正式公开或匹配前需另行授权并人工审核。',
  ].join('\n');

  document.getElementById('talent-output').innerHTML = `
    <div class="result-wrap capability-graph-report">
      <section class="capability-report-head">
        <div><span class="mini-label">个人能力名片</span><h3>${skills.length} 项能力原子</h3><p>${escapeHTML(scene)}</p></div>
        <span class="level-pill">L0 · 待验证</span>
      </section>
      <section class="capability-namecard-grid" aria-label="能力原子卡片">
        ${skills.map((skill) => `
          <article class="capability-namecard">
            <div class="capability-namecard-top"><span>${escapeHTML(skill.category)}</span><span>L0</span></div>
            <h3>${escapeHTML(skill.name)}</h3>
            <p>${escapeHTML(skill.task)}</p>
            <details>
              <summary>查看任务与证据</summary>
              <dl>
                <div><dt>本人补充</dt><dd>${escapeHTML(answers[skill.id])}</dd></div>
                <div><dt>常用方法</dt><dd>${escapeHTML(skill.method)}</dd></div>
                <div><dt>典型产出</dt><dd>${escapeHTML(skill.deliverables.join('、'))}</dd></div>
                <div><dt>可核验证据</dt><dd>${escapeHTML(skill.evidenceExamples)}</dd></div>
                <div><dt>能力边界</dt><dd>${escapeHTML(skill.boundary)}</dd></div>
              </dl>
            </details>
          </article>
        `).join('')}
      </section>
      <section class="result-section">
        <div class="result-section-heading">
          <div><span class="mini-label">可匹配痛点方向</span><h3>这些真实问题值得进一步对照</h3></div>
          <small>仍需确认档期与证据</small>
        </div>
        <div class="matched-demand-list">
          ${matchingDemands.map((demand) => `
            <article>
              <div><span>${escapeHTML(demand.category)}</span><small>${escapeHTML(demand.markets.slice(0, 2).join(' / '))}</small></div>
              <h3>${escapeHTML(demand.title)}</h3>
              <p>${escapeHTML(demand.summary)}</p>
              <dl>
                <div><dt>期望交付</dt><dd>${escapeHTML(demand.deliverables.slice(0, 2).join('、'))}</dd></div>
                <div><dt>匹配依据</dt><dd>能力任务与场景关键词相似，仍需核验真实案例与合作边界</dd></div>
              </dl>
            </article>
          `).join('')}
        </div>
      </section>
      <details class="usage-receipt">
        <summary><span>本次处理记录</span><small>输入过程中 0 次模型调用</small></summary>
        <div>
          <span><strong>${usage.localOperations}</strong><small>本地演示步骤</small></span>
          <span><strong>${usage.modelCalls}</strong><small>实际模型调用</small></span>
          <span><strong>${usage.tokens}</strong><small>实际 Token</small></span>
          <p>${usage.reused ? '检测到相同内容；会话已标记为可复用，正式接入模型时可避免重复计费。' : '能力提炼和名片生成只在明确确认后执行；演示版使用本地规则，不产生 Token 成本。'}</p>
        </div>
      </details>
      <div class="result-actions">
        <button class="btn btn-primary" type="button" data-action="copy-talent">复制名片摘要</button>
        <button class="btn btn-secondary" type="button" data-action="download-talent">下载 TXT</button>
        <button class="btn btn-ghost" type="button" data-action="reset-talent">重新挖掘</button>
      </div>
      <div class="privacy-note"><span aria-hidden="true">i</span><p><strong>这是一份 AI 解析草稿，只保存在当前页面。</strong>进入能力库、对外展示或匹配前，会再次确认身份、材料和可见范围。</p></div>
    </div>`;
  document.getElementById('talent-status').textContent = '已生成';
  document.getElementById('talent-status').className = 'status-badge success';
  document.getElementById('talent-output-status').textContent = '名片草稿';
  document.getElementById('talent-output-status').className = 'status-badge success';
  updateSteps('t', 3);
  scrollToElement(document.getElementById('talent-output').closest('.builder-panel'));
}

function resetTalent() {
  talentForm.closest('.builder-panel').hidden = false;
  talentFlow.querySelector('.builder-layout').classList.remove('result-mode');
  talentForm.hidden = false;
  pendingTalentValues = null;
  activeTalentSkills = [];
  talentContentKey = '';
  document.getElementById('talent-output').innerHTML = `
    <div class="empty-state"><div class="empty-state-inner"><div class="empty-visual ai-empty-visual" aria-hidden="true">AI</div><h3>修改后重新解析</h3><p>你的经历仍保留在左侧。补充本人行动、可量化结果与证明方式后再试一次。</p></div></div>`;
  document.getElementById('talent-status').textContent = '可修改';
  document.getElementById('talent-status').className = 'status-badge';
  document.getElementById('talent-output-status').textContent = '待生成';
  document.getElementById('talent-output-status').className = 'status-badge';
  document.getElementById('talent-progress').style.transform = 'scaleX(0)';
  updateSteps('t', 1);
  document.getElementById('talent-experience').focus();
}

const resumeUpload = document.getElementById('resume-upload');
const resumeUploadStatus = document.getElementById('resume-upload-status');
resumeUpload.addEventListener('change', async () => {
  const [file] = resumeUpload.files;
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    resumeUploadStatus.textContent = '文件超过 5MB，请选择更小的文件或直接粘贴经历。';
    resumeUpload.value = '';
    return;
  }
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'txt' || extension === 'md') {
    const text = (await file.text()).trim();
    if (!text) {
      resumeUploadStatus.textContent = `${file.name} 没有可读取的文字，请选择其他文件或直接填写经历。`;
      return;
    }
    const experience = document.getElementById('talent-experience');
    experience.value = text.slice(0, experience.maxLength);
    experience.dispatchEvent(new Event('input', { bubbles: true }));
    resumeUploadStatus.textContent = `已读取 ${file.name}${text.length > experience.maxLength ? '，内容已截取至 1800 字' : ''}`;
    showToast('简历文本已导入');
    return;
  }
  resumeUploadStatus.textContent = `已选择 ${file.name}。演示版不会上传此文件，暂时无法读取该格式；请粘贴关键经历继续。`;
});

let activeRecognition = null;
let activeVoiceButton = null;

function resetVoiceButton() {
  if (!activeVoiceButton) return;
  activeVoiceButton.classList.remove('active');
  activeVoiceButton.innerHTML = `<span aria-hidden="true">◉</span> ${escapeHTML(activeVoiceButton.dataset.voiceIdleLabel || '语音输入')}`;
  activeVoiceButton = null;
}

function startVoiceInput(button) {
  if (!button.dataset.voiceIdleLabel) button.dataset.voiceIdleLabel = button.textContent.trim();
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    showToast('当前浏览器暂不支持语音输入，请使用键盘填写');
    return;
  }
  if (activeRecognition) {
    activeRecognition.stop();
    activeRecognition = null;
    resetVoiceButton();
    return;
  }
  const target = document.getElementById(button.dataset.voiceTarget);
  if (!target) return;
  const recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.continuous = false;
  recognition.interimResults = false;
  activeRecognition = recognition;
  activeVoiceButton = button;
  button.classList.add('active');
  button.innerHTML = '<span aria-hidden="true">■</span> 停止录音';
  recognition.addEventListener('result', (event) => {
    const transcript = [...event.results].map((result) => result[0].transcript).join('');
    const separator = target.value.trim() ? '。' : '';
    target.value = `${target.value.trim()}${separator}${transcript}`.slice(0, target.maxLength || 2000);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    showToast('语音已转成文字，请检查后开始 AI 解析');
  });
  recognition.addEventListener('error', () => showToast('没有识别到有效语音，请重试或改用键盘'));
  recognition.addEventListener('end', () => {
    activeRecognition = null;
    resetVoiceButton();
  });
  recognition.start();
}

function clearEnterpriseDraft() {
  removeDraft(draftConfig.enterprise);
  enterpriseForm.reset();
  pendingEnterpriseValues = null;
  enterpriseContentKey = '';
  syncCollaborationFields();
  enterpriseForm.closest('.builder-panel').hidden = false;
  enterpriseFlow.querySelector('.builder-layout').classList.remove('result-mode');
  enterpriseForm.hidden = false;
  enterpriseCopy = '';
  setError('enterprise-problem', '');
  setErrorSummary('enterprise-error-summary', false);
  document.getElementById('problem-count').textContent = '0 / 1000';
  document.getElementById('enterprise-output').innerHTML = '<div class="empty-state"><div class="empty-state-inner"><div class="empty-visual ai-empty-visual" aria-hidden="true">AI</div><h3>草稿已清除</h3><p>重新讲一段具体、可观察的真实情况。</p></div></div>';
  document.getElementById('enterprise-status').textContent = '未开始';
  document.getElementById('enterprise-output-status').textContent = '待生成';
  updateSteps('e', 1);
  document.getElementById('enterprise-problem').focus();
}

function clearTalentDraft() {
  removeDraft(draftConfig.talent);
  talentForm.reset();
  talentForm.closest('.builder-panel').hidden = false;
  talentFlow.querySelector('.builder-layout').classList.remove('result-mode');
  talentForm.hidden = false;
  talentCopy = '';
  pendingTalentValues = null;
  activeTalentSkills = [];
  talentContentKey = '';
  setError('talent-experience', '');
  setErrorSummary('talent-error-summary', false);
  document.getElementById('experience-count').textContent = '0 / 1800';
  document.getElementById('resume-upload-status').textContent = '尚未选择文件';
  document.getElementById('talent-output').innerHTML = '<div class="empty-state"><div class="empty-state-inner"><div class="empty-visual ai-empty-visual" aria-hidden="true">AI</div><h3>草稿已清除</h3><p>重新提供一段你亲自完成、结果明确的经历。</p></div></div>';
  document.getElementById('talent-status').textContent = '未开始';
  document.getElementById('talent-output-status').textContent = '待生成';
  updateSteps('t', 1);
  document.getElementById('talent-experience').focus();
}

document.addEventListener('click', (event) => {
  const demandExample = event.target.closest('[data-demand-example]');
  if (demandExample) {
    applyDemandExample(demandExample.dataset.demandExample);
    return;
  }
  const talentExample = event.target.closest('[data-talent-example]');
  if (talentExample) {
    applyTalentExample(talentExample.dataset.talentExample);
    return;
  }
  const voiceButton = event.target.closest('[data-voice-target]');
  if (voiceButton) {
    startVoiceInput(voiceButton);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'copy-collaboration-invite') copyCollaborationInvite();
  if (action === 'skip-enterprise-followup' && pendingEnterpriseValues) renderEnterpriseResult(pendingEnterpriseValues);
  if (action === 'copy-enterprise') copyText(enterpriseCopy);
  if (action === 'download-enterprise') downloadText(enterpriseCopy, '嘟嘟嗨-结构化痛点描述草稿.txt');
  if (action === 'reset-enterprise') resetEnterprise();
  if (action === 'copy-talent') copyText(talentCopy);
  if (action === 'download-talent') downloadText(talentCopy, '嘟嘟嗨-个人能力名片.txt');
  if (action === 'reset-talent') resetTalent();
  if (action === 'clear-enterprise-draft') clearEnterpriseDraft();
  if (action === 'clear-talent-draft') clearTalentDraft();
});

const prefillDemandId = params.get('demand');
const prefillCapabilityId = params.get('capability');

if (prefillDemandId) {
  const demand = enterpriseDemandCatalog.find((item) => item.id === prefillDemandId);
  if (demand) {
    const values = {
      'enterprise-problem': demand.example,
      'enterprise-market': demand.markets.find((market) => market !== '多市场' && market !== '东南亚') || demand.markets[0],
      'enterprise-stage': demand.stage.includes('规模化') ? '需要提升效率' : demand.stage.includes('增长期') ? '已经在推进' : '刚开始验证',
      'enterprise-impact': demand.impact,
      'enterprise-result': demand.goal,
      'enterprise-deadline': demand.duration.includes('2-4 周') ? '2-4 周' : demand.duration.includes('1-3 天') ? '1-3 天' : '3-10 天',
    };
    if (!document.getElementById('enterprise-problem').value.trim()) {
      Object.entries(values).forEach(([id, value]) => {
        const field = document.getElementById(id);
        field.value = value;
        field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input'));
      });
      showToast('已带入需求样例，可按实际情况修改');
    }
  }
} else if (prefillCapabilityId) {
  const capability = capabilityCatalog.find((item) => item.id === prefillCapabilityId);
  if (capability) {
    const experienceInput = document.getElementById('talent-experience');
    const marketInput = document.getElementById('talent-market');
    const fieldInput = document.getElementById('talent-field');
    if (!experienceInput.value.trim()) {
      experienceInput.value = `我做过与“${capability.name}”相关的项目。我的具体职责、做法与结果是：`;
      marketInput.value = capability.markets[0] === '多市场' ? '' : capability.markets[0];
      fieldInput.value = capability.category;
      experienceInput.dispatchEvent(new Event('input'));
      marketInput.dispatchEvent(new Event('input'));
      fieldInput.dispatchEvent(new Event('input'));
      showToast('已带入能力方向，请补充你的真实经历');
    }
  }
}
