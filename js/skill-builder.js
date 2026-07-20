import { capabilityCatalog, enterpriseDemandCatalog, serviceSkus, talentSkillTemplates } from './data.js';

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
let evidenceCopy = '';
let toastTimer;

const draftConfig = {
  enterprise: {
    key: 'duduhire-enterprise-draft-v1',
    form: 'enterprise-form',
    status: 'enterprise-draft-status',
    fields: ['enterprise-problem', 'enterprise-market', 'enterprise-stage', 'enterprise-impact', 'enterprise-tried', 'enterprise-result', 'enterprise-deadline', 'enterprise-budget', 'enterprise-sensitive'],
  },
  talent: {
    key: 'duduhire-talent-draft-v1',
    form: 'talent-form',
    status: 'talent-draft-status',
    fields: ['talent-experience', 'talent-market', 'talent-field', 'talent-cooperation', 'talent-availability'],
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
  appEyebrow.textContent = enterpriseActive ? 'FOR BUSINESS' : 'FOR TALENT';
  appTitle.textContent = enterpriseActive ? '把模糊问题，变成可确认的任务' : '把做过的事，变成可验证的能力';
  document.title = enterpriseActive ? '企业问题诊断｜嘟嘟嗨 Duduhire' : '人才能力定位｜嘟嘟嗨 Duduhire';
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
  'enterprise-problem': (value) => value.trim().length < 20 ? '请至少用 20 个字说明具体现象与变化。' : '',
  'enterprise-market': (value) => value.trim() ? '' : '请填写本次任务涉及的目标市场。',
  'enterprise-stage': (value) => value ? '' : '请选择业务当前所处阶段。',
  'enterprise-impact': (value) => value.trim() ? '' : '请说明这个问题正在影响什么。',
  'enterprise-result': (value) => value.trim() ? '' : '请说明这次希望获得的结果。',
  'talent-experience': (value) => value.trim().length < 40 ? '请至少用 40 个字说明任务、你的具体动作与结果。' : '',
  'evidence-description': (value) => value.trim().length < 20 ? '请至少用 20 个字说明材料对应的任务、角色和结果。' : '',
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

['enterprise-problem', 'enterprise-market', 'enterprise-stage', 'enterprise-impact', 'enterprise-result', 'talent-experience'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => setError(id, ''));
  document.getElementById(id).addEventListener('change', () => setError(id, ''));
  document.getElementById(id).addEventListener('blur', () => validateField(id));
});

function updateSteps(prefix, activeNumber) {
  for (let index = 1; index <= 3; index += 1) {
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
  const matched = scored.filter((item) => item.score > 0).slice(0, 3).map((item) => item.capability);
  return matched.length ? matched : capabilityCatalog.slice(0, 3);
}

function getService(id, deadline) {
  if (id) return serviceSkus.find((service) => service.id === id) || serviceSkus[1];
  if (deadline === '1-3 天') return serviceSkus[0];
  if (deadline === '2-4 周') return serviceSkus[2];
  return serviceSkus[1];
}

const enterpriseForm = document.getElementById('enterprise-form');
enterpriseForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = {
    problem: document.getElementById('enterprise-problem').value.trim(),
    market: document.getElementById('enterprise-market').value.trim(),
    stage: document.getElementById('enterprise-stage').value,
    impact: document.getElementById('enterprise-impact').value.trim(),
    tried: document.getElementById('enterprise-tried').value.trim(),
    result: document.getElementById('enterprise-result').value.trim(),
    deadline: document.getElementById('enterprise-deadline').value,
    budget: document.getElementById('enterprise-budget').value,
    sensitive: document.getElementById('enterprise-sensitive').checked,
  };

  const errors = Object.fromEntries(
    ['enterprise-problem', 'enterprise-market', 'enterprise-stage', 'enterprise-impact', 'enterprise-result']
      .map((id) => [id, validateField(id)]),
  );
  Object.entries(errors).forEach(([id, message]) => setError(id, message));
  const firstError = Object.keys(errors).find((id) => errors[id]);
  setErrorSummary('enterprise-error-summary', Boolean(firstError));
  if (firstError) {
    document.getElementById(firstError).focus();
    return;
  }

  const submit = document.getElementById('analyze-btn');
  submit.disabled = true;
  enterpriseForm.hidden = true;
  document.getElementById('enterprise-status').textContent = '整理中';
  document.getElementById('enterprise-status').className = 'status-badge warning';
  updateSteps('e', 1);
  await runLoading('enterprise', [
    { title: '正在整理问题事实', detail: '区分现象、影响与期望结果', progress: 28 },
    { title: '正在收缩任务边界', detail: '判断适合快诊、微任务还是付费试用', progress: 62 },
    { title: '正在识别能力与风险', detail: '生成待人工核验的能力组合与追问', progress: 100 },
  ]);
  document.getElementById('enterprise-loading').hidden = true;
  submit.disabled = false;
  renderEnterpriseResult(values);
});

function renderEnterpriseResult(values) {
  const service = getService(values.budget, values.deadline);
  const capabilities = scoreCapabilities(`${values.problem} ${values.result} ${values.market}`);
  const questions = [
    values.tried ? '哪些已尝试动作产生过短期改善，哪些完全无效？' : '团队已经尝试过哪些动作，分别有什么结果？',
    '完成任务所需的最小数据、账号权限或协作人员有哪些？',
    '谁负责日常沟通，谁是最终验收人？',
  ];
  if (values.sensitive) questions.unshift('哪些信息属于敏感范围，专家可以看到什么、不能看到什么？');

  enterpriseCopy = [
    '《业务问题诊断草稿》',
    `市场与阶段：${values.market} / ${values.stage}`,
    `业务现象：${values.problem}`,
    `业务影响：${values.impact}`,
    `已尝试：${values.tried || '待补充'}`,
    `期望结果：${values.result}`,
    `建议方式：${service.name}（${service.duration}，参考 ${service.price}）`,
    `初步能力：${capabilities.map((item) => item.name).join('、')}`,
    `敏感材料：${values.sensitive ? '涉及，需先确认保密与权限' : '暂未标记'}`,
    '说明：本草稿需经 15 分钟需求访谈和人工资格判断后方可立项。',
  ].join('\n');

  document.getElementById('enterprise-output').innerHTML = `
    <div class="result-wrap">
      <section class="result-summary">
        <div class="result-summary-top">
          <div>
            <span class="mini-label">建议合作方式</span>
            <h3>${escapeHTML(service.name)}</h3>
            <p>${escapeHTML(service.deliverable)} · ${escapeHTML(service.duration)}</p>
          </div>
          <strong class="result-price">${escapeHTML(service.price)}</strong>
        </div>
        <div class="disclaimer">参考价格不构成固定报价。人工确认任务范围、依赖条件、证据要求与风险后再给出正式方案。</div>
      </section>
      <section class="result-section">
        <h3>问题诊断草稿</h3>
        <div class="brief-result">
          <div class="brief-result-row"><span>市场与阶段</span><p>${escapeHTML(values.market)} · ${escapeHTML(values.stage)}</p></div>
          <div class="brief-result-row"><span>业务现象</span><p>${escapeHTML(values.problem)}</p></div>
          <div class="brief-result-row"><span>业务影响</span><p>${escapeHTML(values.impact)}</p></div>
          <div class="brief-result-row"><span>已尝试</span><p>${escapeHTML(values.tried || '尚未填写，需在访谈中补充')}</p></div>
          <div class="brief-result-row"><span>期望结果</span><p>${escapeHTML(values.result)}</p></div>
          <div class="brief-result-row"><span>完成时间</span><p>${escapeHTML(values.deadline)}</p></div>
        </div>
      </section>
      <section class="result-section">
        <h3>初步能力组合</h3>
        <div class="capability-tags">${capabilities.map((item) => `<span class="capability-tag">${escapeHTML(item.name)}</span>`).join('')}</div>
        <p class="form-hint">这些是待核验方向，不代表平台已经确认候选人或档期。</p>
      </section>
      <section class="result-section">
        <h3>人工访谈需要继续确认</h3>
        <ol class="question-list">${questions.map((question) => `<li>${escapeHTML(question)}</li>`).join('')}</ol>
      </section>
      <div class="result-actions">
        <button class="btn btn-primary" type="button" data-action="copy-enterprise">复制问题单</button>
        <button class="btn btn-secondary" type="button" data-action="download-enterprise">下载 TXT</button>
        <button class="btn btn-secondary" type="button" data-action="reset-enterprise">修改输入</button>
      </div>
      <div class="privacy-note"><span aria-hidden="true">i</span><p><strong>当前公开页只生成本地草稿，不会发起人工服务申请。</strong>请先复制或下载问题单；人工入口开放后，会再次确认联系人、资料用途和服务条款。合格需求确认后，平台目标是在 48 小时内给出首批推荐，或明确无法匹配。</p></div>
    </div>
  `;
  document.getElementById('enterprise-status').textContent = '已生成';
  document.getElementById('enterprise-status').className = 'status-badge success';
  document.getElementById('enterprise-output-status').textContent = '诊断草稿';
  document.getElementById('enterprise-output-status').className = 'status-badge success';
  updateSteps('e', 2);
}

function resetEnterprise() {
  enterpriseForm.hidden = false;
  document.getElementById('enterprise-output').innerHTML = `
    <div class="empty-state"><div class="empty-state-inner"><div class="empty-visual" aria-hidden="true">问</div><h3>修改后重新生成</h3><p>你的输入仍保留在左侧，调整任何字段后再次提交即可。</p></div></div>`;
  document.getElementById('enterprise-status').textContent = '可修改';
  document.getElementById('enterprise-status').className = 'status-badge';
  document.getElementById('enterprise-output-status').textContent = '待生成';
  document.getElementById('enterprise-output-status').className = 'status-badge';
  document.getElementById('enterprise-progress').style.transform = 'scaleX(0)';
  updateSteps('e', 1);
  document.getElementById('enterprise-problem').focus();
}

const talentForm = document.getElementById('talent-form');
talentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = {
    experience: document.getElementById('talent-experience').value.trim(),
    market: document.getElementById('talent-market').value.trim(),
    field: document.getElementById('talent-field').value.trim(),
    cooperation: document.getElementById('talent-cooperation').value,
    availability: document.getElementById('talent-availability').value,
  };
  const experienceError = validateField('talent-experience');
  setError('talent-experience', experienceError);
  setErrorSummary('talent-error-summary', Boolean(experienceError));
  if (experienceError) {
    document.getElementById('talent-experience').focus();
    return;
  }

  const submit = document.getElementById('decode-btn');
  submit.disabled = true;
  talentForm.hidden = true;
  document.getElementById('talent-status').textContent = '分析中';
  document.getElementById('talent-status').className = 'status-badge warning';
  updateSteps('t', 1);
  await runLoading('talent', [
    { title: '正在识别你完成过的任务', detail: '区分你的角色、方法与结果', progress: 30 },
    { title: '正在拆解可复用能力', detail: '匹配适合的任务类型与场景', progress: 64 },
    { title: '正在标记证据缺口', detail: '所有首次结果均保持为 L0 初步推测', progress: 100 },
  ]);
  document.getElementById('talent-loading').hidden = true;
  submit.disabled = false;
  renderTalentResult(values);
});

function getTalentSkills(text) {
  const normalized = text.toLowerCase();
  const scored = talentSkillTemplates.map((skill, index) => ({
    skill,
    index,
    score: skill.keywords.reduce((sum, keyword) => sum + (normalized.includes(keyword.toLowerCase()) ? 1 : 0), 0),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const highestScore = scored[0]?.score || 0;
  const minimumScore = highestScore >= 2 ? 2 : 1;
  const matched = scored.filter((item) => item.score >= minimumScore).slice(0, 2).map((item) => item.skill);
  return matched.length ? matched : talentSkillTemplates.slice(0, 2);
}

function renderTalentResult(values) {
  const skills = getTalentSkills(`${values.experience} ${values.market} ${values.field}`);
  const selectedService = values.cooperation === 'flexible'
    ? { name: '按任务灵活确认', price: '不输出单一“身价”' }
    : serviceSkus.find((service) => service.id === values.cooperation) || serviceSkus[1];
  const title = values.field || skills[0].name;
  const scene = [values.market || '目标市场待补充', values.availability].join(' · ');

  talentCopy = [
    '《出海能力定位报告｜初步版》',
    `定位方向：${title}`,
    `市场与档期：${scene}`,
    `偏好合作：${selectedService.name}${selectedService.price ? `（${selectedService.price}）` : ''}`,
    '',
    ...skills.map((skill, index) => [
      `${index + 1}. ${skill.name}｜L0 初步推测`,
      `任务：${skill.task}`,
      `方法：${skill.method}`,
      `典型产出：${skill.deliverables.join('、')}`,
      `适合：${skill.fit}`,
      `可核验证据：${skill.evidenceExamples}`,
      `待补证据：${skill.evidencePrompt}`,
      `能力边界：${skill.boundary}`,
    ].join('\n')),
    '',
    '说明：本报告来自当前自述，不等于认证、收入承诺或企业推荐。正式入库需另行授权并完成人工审核。',
  ].join('\n');

  document.getElementById('talent-output').innerHTML = `
    <div class="result-wrap">
      <section class="result-summary">
        <div class="result-summary-top">
          <div>
            <span class="mini-label">初步定位</span>
            <h3>${escapeHTML(title)}</h3>
            <p>${escapeHTML(scene)}</p>
          </div>
          <strong class="result-price">${escapeHTML(selectedService.name)}</strong>
        </div>
        <div class="disclaimer">不输出单一、绝对的“身价”。如展示价格，只采用具体任务的参考区间，并以范围、周期、市场与证据等级为前提。</div>
      </section>
      <section class="result-section">
        <h3>识别到 ${skills.length} 项待验证能力</h3>
        ${skills.map((skill) => `
          <article class="skill-result">
            <div class="skill-result-head"><strong>${escapeHTML(skill.name)}</strong><span class="level-pill">L0 · 初步推测</span></div>
            <dl>
              <div><dt>可做任务</dt><dd>${escapeHTML(skill.task)}</dd></div>
              <div><dt>可能方法</dt><dd>${escapeHTML(skill.method)}</dd></div>
              <div><dt>典型产出</dt><dd>${escapeHTML(skill.deliverables.join('、'))}</dd></div>
              <div><dt>适合场景</dt><dd>${escapeHTML(skill.fit)}</dd></div>
              <div><dt>可核验证据</dt><dd>${escapeHTML(skill.evidenceExamples)}</dd></div>
              <div><dt>补证建议</dt><dd>${escapeHTML(skill.evidencePrompt)}</dd></div>
              <div><dt>能力边界</dt><dd>${escapeHTML(skill.boundary)}</dd></div>
            </dl>
          </article>
        `).join('')}
      </section>
      <section class="result-section">
        <h3>进入可推荐人才池前，还需要</h3>
        <ol class="question-list">
          <li>确认每个案例中你本人承担的职责与贡献边界。</li>
          <li>补充至少一种可核验材料：作品、数据、推荐人或公开案例。</li>
          <li>选择企业可见范围，并确认档期、报价与利益冲突。</li>
        </ol>
      </section>
      <div class="result-actions">
        <button class="btn btn-primary" type="button" data-action="show-evidence">查看补证步骤</button>
        <button class="btn btn-secondary" type="button" data-action="copy-talent">复制报告摘要</button>
        <button class="btn btn-secondary" type="button" data-action="download-talent">下载 TXT</button>
        <button class="btn btn-ghost" type="button" data-action="reset-talent">修改经历</button>
      </div>
    </div>
  `;
  document.getElementById('talent-status').textContent = '已生成';
  document.getElementById('talent-status').className = 'status-badge success';
  document.getElementById('talent-output-status').textContent = 'L0 · 初步版';
  document.getElementById('talent-output-status').className = 'status-badge warning';
  updateSteps('t', 2);
}

function resetTalent() {
  talentForm.hidden = false;
  document.getElementById('evidence-form').hidden = true;
  evidencePrepForm.hidden = false;
  evidencePrepForm.reset();
  document.getElementById('evidence-output').hidden = true;
  setError('evidence-description', '');
  document.getElementById('talent-output').innerHTML = `
    <div class="empty-state"><div class="empty-state-inner"><div class="empty-visual" aria-hidden="true">能</div><h3>修改后重新生成</h3><p>你的经历仍保留在左侧。建议补充本人角色、可量化结果与证明方式。</p></div></div>`;
  document.getElementById('talent-status').textContent = '可修改';
  document.getElementById('talent-status').className = 'status-badge';
  document.getElementById('talent-output-status').textContent = '待生成';
  document.getElementById('talent-output-status').className = 'status-badge';
  document.getElementById('talent-progress').style.transform = 'scaleX(0)';
  updateSteps('t', 1);
  document.getElementById('talent-experience').focus();
}

const evidencePrepForm = document.getElementById('evidence-prep-form');
const evidenceDescription = document.getElementById('evidence-description');
evidenceDescription.addEventListener('input', () => setError('evidence-description', ''));
evidenceDescription.addEventListener('blur', () => validateField('evidence-description'));

const evidenceGuidance = {
  '作品或交付物摘要': ['只保留与目标能力直接相关的页面或片段', '说明你本人负责的部分与协作者边界', '标出交付时间、采用情况或可确认结果'],
  '脱敏数据截图': ['遮盖账号、客户、订单与个人身份信息', '保留时间范围、指标口径和对比基准', '说明数据与你采取的动作之间有什么关系'],
  '推荐人': ['先获得推荐人同意，再提供联系方式', '说明推荐人与项目的关系及可核验范围', '不要要求推荐人披露未授权的企业信息'],
  '公开案例链接': ['确认页面可以公开访问且未违反原项目约定', '标注你在案例中的具体职责', '补充链接无法直接证明的结果或方法'],
};

evidencePrepForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const descriptionError = validateField('evidence-description');
  if (descriptionError) {
    evidenceDescription.focus();
    return;
  }
  const type = document.getElementById('evidence-type').value;
  const visibility = document.getElementById('evidence-visibility').value;
  const description = evidenceDescription.value.trim();
  const sanitized = document.getElementById('evidence-sanitized').checked;
  const guidance = evidenceGuidance[type];
  evidenceCopy = [
    '《能力补证准备清单》',
    `材料类型：${type}`,
    `希望的可见范围：${visibility}`,
    `材料说明：${description}`,
    `脱敏确认：${sanitized ? '已确认会先脱敏' : '尚未确认，请在正式提交前完成'}`,
    '',
    '准备要点：',
    ...guidance.map((item, index) => `${index + 1}. ${item}`),
    '',
    '说明：本清单仅保存在当前页面，不代表材料已上传、审核或获得能力认证。',
  ].join('\n');
  document.getElementById('evidence-output').hidden = false;
  document.getElementById('evidence-output').innerHTML = `
    <div class="evidence-output-head">
      <div><span class="mini-label">准备清单</span><h3>${escapeHTML(type)}</h3></div>
      <span class="status-badge ${sanitized ? 'success' : 'warning'}">${sanitized ? '已确认脱敏' : '待确认脱敏'}</span>
    </div>
    <dl class="evidence-summary">
      <div><dt>可见范围</dt><dd>${escapeHTML(visibility)}</dd></div>
      <div><dt>材料说明</dt><dd>${escapeHTML(description)}</dd></div>
    </dl>
    <ol class="question-list">${guidance.map((item) => `<li>${escapeHTML(item)}</li>`).join('')}</ol>
    <div class="result-actions">
      <button class="btn btn-primary" type="button" data-action="copy-evidence">复制清单</button>
      <button class="btn btn-secondary" type="button" data-action="download-evidence">下载 TXT</button>
      <button class="btn btn-ghost" type="button" data-action="reset-evidence">重新填写</button>
    </div>`;
  evidencePrepForm.hidden = true;
  updateSteps('t', 4);
  scrollToElement(document.getElementById('evidence-output'), 'nearest');
});

function clearEnterpriseDraft() {
  removeDraft(draftConfig.enterprise);
  enterpriseForm.reset();
  enterpriseForm.hidden = false;
  enterpriseCopy = '';
  ['enterprise-problem', 'enterprise-market', 'enterprise-stage', 'enterprise-impact', 'enterprise-result'].forEach((id) => setError(id, ''));
  setErrorSummary('enterprise-error-summary', false);
  document.getElementById('problem-count').textContent = '0 / 500';
  document.getElementById('enterprise-output').innerHTML = '<div class="empty-state"><div class="empty-state-inner"><div class="empty-visual" aria-hidden="true">问</div><h3>草稿已清除</h3><p>从一个具体、可观察的业务现象重新开始。</p></div></div>';
  document.getElementById('enterprise-status').textContent = '未开始';
  document.getElementById('enterprise-output-status').textContent = '待生成';
  updateSteps('e', 1);
  document.getElementById('enterprise-problem').focus();
}

function clearTalentDraft() {
  removeDraft(draftConfig.talent);
  talentForm.reset();
  talentForm.hidden = false;
  talentCopy = '';
  evidenceCopy = '';
  setError('talent-experience', '');
  setErrorSummary('talent-error-summary', false);
  document.getElementById('experience-count').textContent = '0 / 800';
  document.getElementById('evidence-form').hidden = true;
  evidencePrepForm.hidden = false;
  evidencePrepForm.reset();
  document.getElementById('evidence-output').hidden = true;
  setError('evidence-description', '');
  document.getElementById('talent-output').innerHTML = '<div class="empty-state"><div class="empty-state-inner"><div class="empty-visual" aria-hidden="true">能</div><h3>草稿已清除</h3><p>从一段你亲自完成、结果明确的经历重新开始。</p></div></div>';
  document.getElementById('talent-status').textContent = '未开始';
  document.getElementById('talent-output-status').textContent = '待生成';
  updateSteps('t', 1);
  document.getElementById('talent-experience').focus();
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'copy-enterprise') copyText(enterpriseCopy);
  if (action === 'download-enterprise') downloadText(enterpriseCopy, '嘟嘟嗨-业务问题诊断草稿.txt');
  if (action === 'reset-enterprise') resetEnterprise();
  if (action === 'copy-talent') copyText(talentCopy);
  if (action === 'download-talent') downloadText(talentCopy, '嘟嘟嗨-出海能力定位初步报告.txt');
  if (action === 'reset-talent') resetTalent();
  if (action === 'clear-enterprise-draft') clearEnterpriseDraft();
  if (action === 'clear-talent-draft') clearTalentDraft();
  if (action === 'copy-evidence') copyText(evidenceCopy, '清单已复制');
  if (action === 'download-evidence') downloadText(evidenceCopy, '嘟嘟嗨-能力补证准备清单.txt');
  if (action === 'reset-evidence') {
    document.getElementById('evidence-output').hidden = true;
    evidencePrepForm.hidden = false;
    updateSteps('t', 3);
    evidenceDescription.focus();
  }
  if (action === 'show-evidence') {
    const evidenceForm = document.getElementById('evidence-form');
    evidenceForm.hidden = false;
    updateSteps('t', 3);
    scrollToElement(evidenceForm);
    document.getElementById('evidence-form-title').focus({ preventScroll: true });
  }
});

const prefillDemandId = params.get('demand');
const prefillCapabilityId = params.get('capability');

if (prefillDemandId) {
  const demand = enterpriseDemandCatalog.find((item) => item.id === prefillDemandId);
  if (demand) {
    const values = {
      'enterprise-problem': demand.example,
      'enterprise-market': demand.markets.find((market) => market !== '多市场' && market !== '东南亚') || demand.markets[0],
      'enterprise-stage': demand.stage.includes('规模化') ? '规模化' : demand.stage.includes('增长期') ? '增长期' : '验证期',
      'enterprise-impact': demand.impact,
      'enterprise-result': demand.goal,
      'enterprise-deadline': demand.duration.includes('2-4 周') ? '2-4 周' : demand.duration.includes('1-3 天') ? '1-3 天' : '3-10 天',
      'enterprise-budget': demand.service.includes('付费试用') && !demand.service.includes('标准微任务') ? 'paid-trial' : demand.service.includes('标准微任务') ? 'micro-task' : 'diagnosis',
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
    const problemInput = document.getElementById('enterprise-problem');
    const marketInput = document.getElementById('enterprise-market');
    if (!problemInput.value.trim()) {
      problemInput.value = `我们希望解决“${capability.name}”相关问题。当前具体现象是：`;
      marketInput.value = capability.markets[0] === '多市场' ? '' : capability.markets[0];
      problemInput.dispatchEvent(new Event('input'));
      marketInput.dispatchEvent(new Event('input'));
    }
  }
}
