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
let pendingTalentValues = null;
let activeTalentSkills = [];
let toastTimer;

const draftConfig = {
  enterprise: {
    key: 'duduhire-enterprise-draft-v1',
    form: 'enterprise-form',
    status: 'enterprise-draft-status',
    fields: ['enterprise-problem', 'enterprise-market', 'enterprise-stage', 'enterprise-impact', 'enterprise-tried', 'enterprise-result', 'enterprise-deadline', 'enterprise-sensitive'],
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
  appEyebrow.textContent = enterpriseActive ? 'DESCRIBE THE PAIN' : 'DISCOVER YOUR SKILLS';
  appTitle.innerHTML = enterpriseActive
    ? '<span class="app-title-line">描述我的痛点，</span><span class="app-title-line">先把问题说清楚</span>'
    : '<span class="app-title-line">挖掘我的能力，</span><span class="app-title-line">把经历拆成能力原子</span>';
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
  'enterprise-market': (value) => value.trim() ? '' : '请填写这个痛点发生的具体场景。',
  'enterprise-stage': (value) => value ? '' : '请选择业务当前所处阶段。',
  'enterprise-impact': (value) => value.trim() ? '' : '请说明这个问题正在影响什么。',
  'enterprise-result': (value) => value.trim() ? '' : '请说明这次希望获得的结果。',
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

function getService(deadline) {
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
    { title: '正在整理痛点事实', detail: '区分现象、影响与期望结果', progress: 28 },
    { title: '正在收缩问题边界', detail: '判断适合诊断、微任务还是协作验证', progress: 62 },
    { title: '正在识别所需能力', detail: '生成待人工确认的能力方向与追问', progress: 100 },
  ]);
  document.getElementById('enterprise-loading').hidden = true;
  submit.disabled = false;
  renderEnterpriseResult(values);
});

function renderEnterpriseResult(values) {
  const service = getService(values.deadline);
  const capabilities = scoreCapabilities(`${values.problem} ${values.result} ${values.market}`);
  const questions = [
    values.tried ? '哪些已尝试动作产生过短期改善，哪些完全无效？' : '团队已经尝试过哪些动作，分别有什么结果？',
    '完成任务所需的最小数据、账号权限或协作人员有哪些？',
    '谁会使用最终结果，谁能确认它是否真正解决了问题？',
  ];
  if (values.sensitive) questions.unshift('哪些信息属于敏感范围，专家可以看到什么、不能看到什么？');

  enterpriseCopy = [
    '《结构化任务卡｜草稿》',
    `发生场景与状态：${values.market} / ${values.stage}`,
    `痛点描述：${values.problem}`,
    `造成影响：${values.impact}`,
    `已尝试：${values.tried || '待补充'}`,
    `期望结果：${values.result}`,
    `建议下一步：${service.name}（${service.duration}）`,
    `可能需要的能力：${capabilities.map((item) => item.name).join('、')}`,
    `敏感材料：${values.sensitive ? '涉及，需先确认保密与权限' : '暂未标记'}`,
    '说明：本草稿需经人工确认问题范围、必要信息与服务边界后，才能进入下一步。',
  ].join('\n');

  document.getElementById('enterprise-output').innerHTML = `
    <div class="result-wrap">
      <section class="result-summary">
        <div class="result-summary-top">
          <div>
            <span class="mini-label">建议下一步</span>
            <h3>${escapeHTML(service.name)}</h3>
            <p>${escapeHTML(service.deliverable)} · ${escapeHTML(service.duration)}</p>
          </div>
          <strong class="result-price">待人工确认</strong>
        </div>
        <div class="disclaimer">当前版本不提供在线付费。人工确认问题范围、依赖条件、证据要求与风险后，再决定是否进入下一步。</div>
      </section>
      <section class="result-section">
        <h3>结构化任务卡</h3>
        <div class="brief-result">
          <div class="brief-result-row"><span>场景与状态</span><p>${escapeHTML(values.market)} · ${escapeHTML(values.stage)}</p></div>
          <div class="brief-result-row"><span>痛点描述</span><p>${escapeHTML(values.problem)}</p></div>
          <div class="brief-result-row"><span>造成影响</span><p>${escapeHTML(values.impact)}</p></div>
          <div class="brief-result-row"><span>已尝试</span><p>${escapeHTML(values.tried || '尚未填写，需在访谈中补充')}</p></div>
          <div class="brief-result-row"><span>期望结果</span><p>${escapeHTML(values.result)}</p></div>
          <div class="brief-result-row"><span>完成时间</span><p>${escapeHTML(values.deadline)}</p></div>
        </div>
      </section>
      <section class="result-section">
        <h3>可能需要的能力</h3>
        <div class="capability-tags">${capabilities.map((item) => `<span class="capability-tag">${escapeHTML(item.name)}</span>`).join('')}</div>
        <p class="form-hint">这些是待核验方向，不代表平台已经确认合适人员或档期。</p>
      </section>
      <section class="result-section">
        <h3>人工访谈需要继续确认</h3>
        <ol class="question-list">${questions.map((question) => `<li>${escapeHTML(question)}</li>`).join('')}</ol>
      </section>
      <div class="result-actions">
        <button class="btn btn-primary" type="button" data-action="copy-enterprise">复制任务卡</button>
        <button class="btn btn-secondary" type="button" data-action="download-enterprise">下载 TXT</button>
        <button class="btn btn-secondary" type="button" data-action="reset-enterprise">修改输入</button>
      </div>
      <div class="privacy-note"><span aria-hidden="true">i</span><p><strong>当前公开页只生成本地草稿，不会发起人工服务申请。</strong>人工入口开放后，会再次确认联系人、资料用途和服务条款。</p></div>
    </div>
  `;
  document.getElementById('enterprise-status').textContent = '已生成';
  document.getElementById('enterprise-status').className = 'status-badge success';
  document.getElementById('enterprise-output-status').textContent = '任务卡草稿';
  document.getElementById('enterprise-output-status').className = 'status-badge success';
  const layout = enterpriseFlow.querySelector('.builder-layout');
  const inputPanel = enterpriseForm.closest('.builder-panel');
  const outputPanel = document.getElementById('enterprise-output').closest('.builder-panel');
  inputPanel.hidden = true;
  layout.classList.add('result-mode');
  updateSteps('e', 2);
  scrollToElement(outputPanel);
}

function resetEnterprise() {
  enterpriseForm.closest('.builder-panel').hidden = false;
  enterpriseFlow.querySelector('.builder-layout').classList.remove('result-mode');
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
        <span class="mini-label">第一轮提炼</span>
        <h3>识别到 ${skills.length} 项能力原子</h3>
        <p>能力原子名称来自固定分类。请补充真实解决过程，再生成个人能力名片。</p>
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
  updateSteps('t', 2);
  scrollToElement(outputPanel);
  document.querySelector('[data-skill-answer]')?.focus({ preventScroll: true });
}

talentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = {
    experience: document.getElementById('talent-experience').value.trim(),
    market: document.getElementById('talent-market').value.trim(),
    field: document.getElementById('talent-field').value.trim(),
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
  document.getElementById('talent-status').textContent = '提炼中';
  document.getElementById('talent-status').className = 'status-badge warning';
  updateSteps('t', 1);
  await runLoading('talent', [
    { title: '正在识别做过的任务', detail: '区分岗位描述与本人实际动作', progress: 30 },
    { title: '正在提炼能力原子', detail: '从预设能力名称中选择 3-5 项', progress: 66 },
    { title: '正在生成针对性追问', detail: '继续确认方法、结果与贡献边界', progress: 100 },
  ]);
  document.getElementById('talent-loading').hidden = true;
  submit.disabled = false;
  const skills = getTalentSkills(`${values.experience} ${values.market} ${values.field}`);
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
      <div class="result-actions">
        <button class="btn btn-primary" type="button" data-action="copy-talent">复制名片摘要</button>
        <button class="btn btn-secondary" type="button" data-action="download-talent">下载 TXT</button>
        <button class="btn btn-ghost" type="button" data-action="reset-talent">重新挖掘</button>
      </div>
      <div class="privacy-note"><span aria-hidden="true">i</span><p><strong>名片只保存在当前页面。</strong>进入能力库、对外展示或匹配前，会再次确认身份、材料和可见范围。</p></div>
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
  document.getElementById('talent-output').innerHTML = `
    <div class="empty-state"><div class="empty-state-inner"><div class="empty-visual" aria-hidden="true">能</div><h3>修改后重新挖掘</h3><p>你的经历仍保留在左侧。建议补充本人角色、可量化结果与证明方式。</p></div></div>`;
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
  enterpriseForm.closest('.builder-panel').hidden = false;
  enterpriseFlow.querySelector('.builder-layout').classList.remove('result-mode');
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
  talentForm.closest('.builder-panel').hidden = false;
  talentFlow.querySelector('.builder-layout').classList.remove('result-mode');
  talentForm.hidden = false;
  talentCopy = '';
  pendingTalentValues = null;
  activeTalentSkills = [];
  setError('talent-experience', '');
  setErrorSummary('talent-error-summary', false);
  document.getElementById('experience-count').textContent = '0 / 1800';
  document.getElementById('resume-upload-status').textContent = '尚未选择文件';
  document.getElementById('talent-output').innerHTML = '<div class="empty-state"><div class="empty-state-inner"><div class="empty-visual" aria-hidden="true">能</div><h3>草稿已清除</h3><p>从一段你亲自完成、结果明确的经历重新开始。</p></div></div>';
  document.getElementById('talent-status').textContent = '未开始';
  document.getElementById('talent-output-status').textContent = '待生成';
  updateSteps('t', 1);
  document.getElementById('talent-experience').focus();
}

document.addEventListener('click', (event) => {
  const voiceButton = event.target.closest('[data-voice-target]');
  if (voiceButton) {
    startVoiceInput(voiceButton);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'copy-enterprise') copyText(enterpriseCopy);
  if (action === 'download-enterprise') downloadText(enterpriseCopy, '嘟嘟嗨-结构化任务卡草稿.txt');
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
