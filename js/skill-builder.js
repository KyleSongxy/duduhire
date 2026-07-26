import { capabilityCatalog, enterpriseDemandCatalog, serviceSkus, talentSkillTemplates } from './data.js';
import { inferTalentContext, parseDemandText } from './ai-parser.js';
import {
  analyzeWithDomesticModel,
  getCapabilityModelSkills,
  getDemandModelQuestions,
  getEvidenceStatus,
  mapDemandAnalysis,
  refineWithDomesticModel,
  requestStructuredMatch,
  submitAnalysisFeedback,
  submitEvidence,
  submitEvidenceMicrotask,
  submitHumanReview,
} from './analysis-api.js';
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
let enterpriseConfirmation = null;
let talentConfirmation = null;
const pendingReviews = {
  enterprise: null,
  talent: null,
};
let toastTimer;

function parseRedactionTerms(value) {
  return [...new Set(String(value || '')
    .split(/[,，;\n；]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2))]
    .slice(0, 20);
}

const talentExamples = {
  productization: '我负责把一个 AI 客服 Demo 接入客户工单流程。我重新梳理数据来源、权限、自动回复和人工升级规则，补充异常回退与测试集，最终通过试点验收并正式上线。过程可由流程图、版本记录和验收材料证明。',
  cost: '我负责一款 AI SaaS 的推理成本优化。先按任务类型审计调用日志和 Token 账单，再建立代表性评测集，设计多模型路由、缓存和降级方案。上线后在关键任务质量稳定的前提下降低了单次调用成本，过程可由账单、代码和评测报告证明。',
  roi: '我负责一个企业 AI 项目的试点转化。先记录现有人工流程的耗时和错误基线，再定义试点指标、数据采集和继续条件，最终把试点结果整理成采购决策材料并推动正式上线。过程可由试点方案、业务指标和客户验收记录证明。',
};

const draftConfig = {
  enterprise: {
    key: 'duduhire-enterprise-draft-v1',
    form: 'enterprise-form',
    status: 'enterprise-draft-status',
    fields: ['enterprise-problem', 'enterprise-market', 'enterprise-stage', 'enterprise-impact', 'enterprise-tried', 'enterprise-result', 'enterprise-submitter-role', 'enterprise-owner-name', 'enterprise-deadline', 'enterprise-sensitive', 'enterprise-redaction-terms'],
  },
  talent: {
    key: 'duduhire-talent-draft-v1',
    form: 'talent-form',
    status: 'talent-draft-status',
    fields: ['talent-experience', 'talent-market', 'talent-field', 'talent-redaction-terms'],
  },
};

function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function privacySummary(meta) {
  const privacy = meta?.privacy;
  if (!privacy?.redacted) return '';
  const labels = {
    email: '邮箱',
    cn_phone: '手机号',
    cn_id: '身份证号',
    bank_card: '银行卡号',
    credential: '账号凭据',
    organization_name: '客户 / 机构名',
  };
  const types = privacy.redaction_types.map((type) => labels[type] || type);
  return `
    <div class="privacy-result-note">
      <strong>发送前已自动脱敏 ${privacy.redaction_count} 处</strong>
      <span>${escapeHTML(types.join('、'))}不会发送给模型；建议仍然检查材料中是否包含客户名等业务敏感信息。</span>
    </div>`;
}

function feedbackPanel(flow, receiptId, target = 'match') {
  if (!receiptId) return '';
  return `
    <section class="feedback-panel" data-feedback-panel data-flow="${flow}" data-target="${target}" data-receipt-id="${escapeHTML(receiptId)}">
      <div>
        <span class="mini-label">帮助我们校准结果</span>
        <h3>这次${target === 'match' ? '匹配' : '解析'}是否有帮助？</h3>
      </div>
      <div class="feedback-actions">
        <button type="button" data-feedback-verdict="helpful">有帮助</button>
        <button type="button" data-feedback-verdict="partly_helpful">部分有帮助</button>
        <button type="button" data-feedback-verdict="not_helpful">没有帮助</button>
      </div>
      <label>
        <span>补充原因（可选）</span>
        <textarea data-feedback-comment maxlength="800" placeholder="例如：场景判断正确，但交付物方向不符合实际。"></textarea>
      </label>
      <label class="checkbox-row compact">
        <input type="checkbox" data-feedback-consent>
        <span>同意保存上面的反馈文字；不勾选时只保存评价按钮。</span>
      </label>
      <p data-feedback-status role="status"></p>
    </section>`;
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
  appEyebrow.textContent = enterpriseActive ? '痛点解析' : '能力解析';
  appTitle.innerHTML = enterpriseActive
    ? '<span class="app-title-line">说清现在卡在哪里，</span><span class="app-title-line">先找到可验证的下一步</span>'
    : '<span class="app-title-line">提交做过的真实项目，</span><span class="app-title-line">让真实能力被看见</span>';
  document.title = enterpriseActive ? '描述当前卡点｜嘟嘟嗨 Duduhire' : '提交实战能力｜嘟嘟嗨 Duduhire';
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

const lowSignalKeywords = new Set(['ai', '人工智能', '企业', '企业客户', '客户', '产品', '项目', '试点', '上线']);

function scoreCapabilities(text, preferredIds = []) {
  const normalized = text.toLowerCase();
  const scored = capabilityCatalog.map((capability, index) => ({
    capability,
    index,
    score: capability.keywords.reduce((sum, keyword) => {
      if (!normalized.includes(keyword.toLowerCase())) return sum;
      return sum + (lowSignalKeywords.has(keyword.toLowerCase()) ? 0.2 : 1);
    }, preferredIds.includes(capability.id) ? 2 : 0),
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

function renderDemandConfirmation(values) {
  pendingEnterpriseValues = values;
  const analysis = values.modelAnalysis;
  if (!analysis) {
    renderEnterpriseResult(values);
    return;
  }
  const selected = enterpriseConfirmation?.confirmedFactIds
    || analysis.facts.map((fact) => fact.id);
  enterpriseConfirmation = { confirmedFactIds: selected };
  document.getElementById('enterprise-output').innerHTML = `
    <div class="result-wrap confirmation-stage">
      <section class="result-summary">
        <span class="mini-label">匹配前确认</span>
        <h3>逐条确认 AI 提取的事实</h3>
        <p>只把你确认过的事实带入匹配。取消勾选等于删除；需要修改时，在下方写明修正并让 AI 重新解析。</p>
        ${privacySummary(values.analysisMeta)}
      </section>
      <form id="demand-confirmation-form" class="confirmation-form">
        <section class="confirmation-list" aria-label="待确认事实">
          ${analysis.facts.map((fact) => `
            <label class="confirmation-item">
              <input type="checkbox" name="confirmed-fact" value="${escapeHTML(fact.id)}" ${selected.includes(fact.id) ? 'checked' : ''}>
              <span>
                <small>${escapeHTML(fact.kind)} · 可信度 ${Math.round(fact.confidence * 100)}%</small>
                <strong>${escapeHTML(fact.claim)}</strong>
                <q>${escapeHTML(fact.source_quote)}</q>
              </span>
            </label>
          `).join('')}
        </section>
        <label class="confirmation-correction">
          <span>需要修改或补充的地方</span>
          <textarea id="demand-corrections" maxlength="2000" placeholder="例如：时间不是两周，而是月底前；验收标准还应包括可回滚。"></textarea>
        </label>
        <div class="result-actions">
          <button class="btn btn-primary" type="submit">确认事实并查看匹配</button>
          <button class="btn btn-secondary" type="button" data-action="refine-demand">应用修正并重新解析</button>
          <button class="btn btn-ghost" type="button" data-action="reset-enterprise">返回原文</button>
        </div>
      </form>
    </div>`;
  document.getElementById('enterprise-status').textContent = '待确认';
  document.getElementById('enterprise-status').className = 'status-badge warning';
  document.getElementById('enterprise-output-status').textContent = `${analysis.facts.length} 条事实`;
  document.getElementById('enterprise-output-status').className = 'status-badge warning';
  updateSteps('e', 3);
  scrollToElement(document.getElementById('enterprise-output').closest('.builder-panel'));
}

function renderTalentConfirmation(values, skills) {
  pendingTalentValues = values;
  activeTalentSkills = skills;
  const analysis = values.modelAnalysis;
  if (!analysis?.capability_atoms?.length) {
    renderTalentResult(values, skills, {});
    return;
  }
  const selected = talentConfirmation?.confirmedAtomIds
    || analysis.capability_atoms.map((atom) => atom.id);
  talentConfirmation = { confirmedAtomIds: selected };
  document.getElementById('talent-output').innerHTML = `
    <div class="result-wrap confirmation-stage">
      <section class="result-summary">
        <span class="mini-label">生成名片前确认</span>
        <h3>确认哪些能力原子真正属于你</h3>
        <p>取消勾选会删除对应能力；所有条目仍是 L0 自述草稿，不会因为确认自动升级为认证能力。</p>
        ${privacySummary(values.analysisMeta)}
      </section>
      <form id="talent-confirmation-form" class="confirmation-form">
        <section class="confirmation-list" aria-label="待确认能力原子">
          ${analysis.capability_atoms.map((atom) => `
            <label class="confirmation-item">
              <input type="checkbox" name="confirmed-atom" value="${escapeHTML(atom.id)}" ${selected.includes(atom.id) ? 'checked' : ''}>
              <span>
                <small>${escapeHTML(atom.category)} · L0 · 可信度 ${Math.round(atom.confidence * 100)}%</small>
                <strong>${escapeHTML(atom.name)}</strong>
                <p>${escapeHTML(atom.task)}</p>
                <q>${escapeHTML(atom.deliverables.join('、') || '交付物待补充')}</q>
              </span>
            </label>
          `).join('')}
        </section>
        <label class="confirmation-correction">
          <span>需要修改或补充的地方</span>
          <textarea id="talent-corrections" maxlength="2000" placeholder="例如：我只参与了数据审计，没有负责模型路由；交付物是成本基线。"></textarea>
        </label>
        <div class="result-actions">
          <button class="btn btn-primary" type="submit">确认能力并生成名片</button>
          <button class="btn btn-secondary" type="button" data-action="refine-talent">应用修正并重新解析</button>
          <button class="btn btn-ghost" type="button" data-action="reset-talent">返回原文</button>
        </div>
      </form>
    </div>`;
  document.getElementById('talent-status').textContent = '待确认';
  document.getElementById('talent-status').className = 'status-badge warning';
  document.getElementById('talent-output-status').textContent = `${analysis.capability_atoms.length} 项能力`;
  document.getElementById('talent-output-status').className = 'status-badge warning';
  updateSteps('t', 3);
  scrollToElement(document.getElementById('talent-output').closest('.builder-panel'));
}

function renderModelReviewState(type, analysis, sourceText = '') {
  const isEnterprise = type === 'enterprise';
  const flow = isEnterprise ? enterpriseFlow : talentFlow;
  const output = document.getElementById(`${type}-output`);
  const form = document.getElementById(`${type}-form`);
  const labels = {
    personal_sensitive_data: '包含个人敏感信息',
    confidential_business_data: '可能包含未公开业务信息',
    unsafe_or_illegal: '涉及高风险或不安全内容',
    prompt_injection: '材料中包含试图改变解析规则的指令',
    unsupported_financial_claim: '包含未经支持的金额或收益要求',
    high_impact_decision: '涉及高影响决策',
    unsupported_seniority_claim: '要求无依据提升能力等级',
    unsupported_outcome_claim: '包含未经支持的成果声明',
    high_impact_employment_decision: '涉及高影响就业判断',
    other: '需要人工判断',
  };
  const risks = analysis.risk_flags.map((flag) => labels[flag] || labels.other);
  pendingReviews[type] = {
    flow: isEnterprise ? 'demand' : 'capability',
    text: sourceText || analysis.source?.text || '',
    analysis,
  };
  output.innerHTML = `
    <div class="result-wrap">
      <section class="result-summary">
        <span class="mini-label">暂停自动处理</span>
        <h3>这份材料需要先由人工确认</h3>
        <p>系统没有继续生成匹配或能力结论，避免把敏感信息、材料内指令或高影响判断当成普通内容处理。</p>
        <div class="capability-tags">
          ${(risks.length ? risks : ['需要人工判断']).map((risk) => `<span class="capability-tag">${escapeHTML(risk)}</span>`).join('')}
        </div>
      </section>
      <section class="result-section">
        <h3>你可以怎么继续</h3>
        <div class="brief-result">
          <div class="brief-result-row"><span>先脱敏</span><p>移除身份号码、联系方式、客户名单、账号密码和不必要的未公开数据。</p></div>
          <div class="brief-result-row"><span>保留事实</span><p>只描述业务场景、本人行动、交付物和可公开的结果范围。</p></div>
          <div class="brief-result-row"><span>人工确认</span><p>涉及招聘决定、能力认证、违法危险内容或材料真实性时，不由模型自动判断。</p></div>
        </div>
      </section>
      <section class="review-submit-panel">
        <label class="checkbox-row">
          <input type="checkbox" id="${type}-review-consent">
          <span>我同意将系统已脱敏的结构化材料保存到人工审核队列。</span>
        </label>
        <label>
          <span>给审核人员的补充说明（可选）</span>
          <textarea id="${type}-review-note" maxlength="1000" placeholder="说明哪些内容可以查看，以及希望人工判断什么。"></textarea>
        </label>
        <button class="btn btn-secondary" type="button" data-action="submit-review-${type}">提交人工审核</button>
        <p id="${type}-review-status" role="status"></p>
      </section>
      <div class="result-actions">
        <button class="btn btn-primary" type="button" data-action="reset-${isEnterprise ? 'enterprise' : 'talent'}">返回修改原文</button>
      </div>
    </div>`;
  document.getElementById(`${type}-status`).textContent = '待人工确认';
  document.getElementById(`${type}-status`).className = 'status-badge warning';
  document.getElementById(`${type}-output-status`).textContent = '已暂停';
  document.getElementById(`${type}-output-status`).className = 'status-badge warning';
  const layout = flow.querySelector('.builder-layout');
  const inputPanel = form.closest('.builder-panel');
  const outputPanel = output.closest('.builder-panel');
  inputPanel.hidden = true;
  layout.classList.add('result-mode');
  updateSteps(isEnterprise ? 'e' : 't', isEnterprise ? 3 : 3);
  scrollToElement(outputPanel);
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
  let values = parseDemandText(problem, {
    fallbackDeadline: document.getElementById('enterprise-deadline').value,
    sensitive: document.getElementById('enterprise-sensitive').checked,
  });
  const sourceDemand = enterpriseDemandCatalog.find((item) => item.id === prefillDemandId && item.example === problem);
  if (sourceDemand) {
    values.market = sourceDemand.markets.slice(0, 2).join(' / ');
    values.stage = sourceDemand.stage;
    values.impact = sourceDemand.impact;
    values.result = sourceDemand.goal;
    values.deadline = sourceDemand.duration;
    values.preferredCapabilityIds = sourceDemand.capabilityIds;
  }
  values.submitterRole = document.getElementById('enterprise-submitter-role').value;
  values.owner = document.getElementById('enterprise-owner-name').value.trim();
  values.acceptance = sourceDemand?.acceptance || '';
  values.access = sourceDemand?.inputs || '';
  values.redactionTerms = parseRedactionTerms(
    document.getElementById('enterprise-redaction-terms').value,
  );

  const submit = document.getElementById('analyze-btn');
  submit.disabled = true;
  enterpriseForm.hidden = true;
  document.getElementById('enterprise-status').textContent = 'AI 解析中';
  document.getElementById('enterprise-status').className = 'status-badge warning';
  updateSteps('e', 2);
  const modelPromise = analyzeWithDomesticModel('demand', {
    text: problem,
    sensitive: values.sensitive,
    redaction_terms: values.redactionTerms,
  });
  const [, modelResult] = await Promise.all([runLoading('enterprise', [
    { title: 'AI 正在理解你的描述', detail: '识别业务场景、现象与关键阻碍', progress: 28 },
    { title: 'AI 正在拆解任务结构', detail: '提取影响、预期交付与时间约束', progress: 62 },
    { title: 'AI 正在生成确认问题', detail: '标记缺失信息与待核验能力方向', progress: 100 },
  ]), modelPromise]);
  values = mapDemandAnalysis(modelResult, values);
  enterpriseContentKey = createContentKey('demand', values.problem);
  recordUsage({
    flow: 'demand',
    stage: 'structure',
    contentKey: enterpriseContentKey,
    inputCharacters: values.problem.length,
    mode: values.analysisMeta ? 'model' : 'local-demo',
    tokens: values.analysisMeta?.total_tokens || 0,
    costCny: values.analysisMeta?.estimated_cost_cny || 0,
  });
  syncParsedDemandFields(values);
  document.getElementById('enterprise-loading').hidden = true;
  submit.disabled = false;
  if (values.modelAnalysis?.status === 'requires_human_review') {
    renderModelReviewState('enterprise', values.modelAnalysis, problem);
    return;
  }
  if (values.modelAnalysis?.status === 'ready_for_matching' && !values.modelAnalysis.questions.length) {
    renderDemandConfirmation(values);
    return;
  }
  renderEnterpriseQuestions(values);
});

function buildDemandQuestions(values) {
  const modelQuestions = getDemandModelQuestions(values);
  if (modelQuestions.length) return modelQuestions;
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
  const questions = buildDemandQuestions(values);
  document.getElementById('enterprise-output').innerHTML = `
    <div class="result-wrap demand-question-stage">
      <section class="result-summary">
        <div class="result-summary-top">
          <div>
            <span class="mini-label">${values.analysisMeta ? '国内模型智能整理' : '本地规则整理演示'}</span>
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
  const modelQuestions = new Map(
    (values.modelAnalysis?.questions || []).map((question) => [question.id, question]),
  );
  const modelFollowups = Object.entries(answers)
    .filter(([id, answer]) => modelQuestions.has(id) && answer)
    .map(([id, answer]) => ({
      question: modelQuestions.get(id).question,
      targets: modelQuestions.get(id).targets,
      answer,
    }));
  for (const followup of modelFollowups) {
    const targetText = followup.targets.join(' ').toLowerCase();
    if (/impact|影响|指标/.test(targetText)) next.impact = followup.answer;
    if (/attempt|尝试|动作/.test(targetText)) next.tried = followup.answer;
    if (/outcome|result|目标|结果|交付/.test(targetText)) next.result = followup.answer;
    if (/acceptance|验收/.test(targetText)) next.acceptance = followup.answer;
    if (/access|data|权限|数据/.test(targetText)) next.access = followup.answer;
    if (/owner|actor|stakeholder|负责人|确认人/.test(targetText)) next.owner = followup.answer;
  }
  next.modelFollowups = modelFollowups;
  return next;
}

document.addEventListener('submit', async (event) => {
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
  let values = mergeDemandAnswers(pendingEnterpriseValues, answers);
  if (values.modelAnalysis) {
    event.target.querySelector('button[type="submit"]').disabled = true;
    const refined = await refineWithDomesticModel('demand', {
      text: values.problem,
      sensitive: values.sensitive,
      previousAnalysis: values.modelAnalysis,
      answers: values.modelFollowups || [],
      redactionTerms: values.redactionTerms || [],
    });
    values = mapDemandAnalysis(refined, values);
    recordUsage({
      flow: 'demand',
      stage: 'refine',
      contentKey: enterpriseContentKey,
      inputCharacters: values.problem.length,
      mode: refined?.meta ? 'model' : 'local-demo',
      tokens: refined?.meta?.total_tokens || 0,
      costCny: refined?.meta?.estimated_cost_cny || 0,
    });
    if (values.modelAnalysis?.status === 'requires_human_review') {
      renderModelReviewState('enterprise', values.modelAnalysis, values.problem);
      return;
    }
  }
  renderDemandConfirmation(values);
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'demand-confirmation-form') return;
  event.preventDefault();
  const confirmedFactIds = [...event.target.querySelectorAll('[name="confirmed-fact"]:checked')]
    .map((field) => field.value);
  if (!confirmedFactIds.length) {
    showToast('请至少确认一条事实，或返回修改原文');
    return;
  }
  enterpriseConfirmation = { confirmedFactIds };
  renderEnterpriseResult(pendingEnterpriseValues);
});

async function renderEnterpriseResult(values) {
  const service = getService(values.deadline);
  const matchingTask = values.modelAnalysis?.matching_input?.task_summary || '';
  const confirmedDetails = (values.modelFollowups || []).map((item) => item.answer).join(' ');
  const legacyCapabilities = scoreCapabilities(
    `${values.problem} ${values.result} ${values.market} ${matchingTask} ${confirmedDetails}`,
    values.preferredCapabilityIds,
  );
  const structured = values.modelAnalysis
    ? await requestStructuredMatch('demand', values.modelAnalysis, enterpriseConfirmation || {})
    : null;
  const capabilities = structured?.status === 'ready'
    ? structured.matches.map((match) => ({
        ...capabilityCatalog.find((item) => item.id === match.id),
        match,
      })).filter((item) => item.id)
    : legacyCapabilities.map((item) => ({ ...item, match: null }));
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
    ...(values.modelFollowups?.length
      ? [`补充确认：${values.modelFollowups.map((item) => `${item.question} ${item.answer}`).join('；')}`]
      : []),
    `建议下一步：${service.name}（${service.duration}）`,
    `优先核验能力：${capabilities.map((item) => item.name).join('、')}`,
    `敏感材料：${values.sensitive ? '涉及，需先确认保密与权限' : '暂未标记'}`,
    `建议微任务：由“${leadCapability.name}”方向先完成${leadCapability.deliverables.slice(0, 3).join('、')}。`,
    '说明：这是结构化匹配草稿，能力方向、真实人员、证据和档期仍需人工核验。',
  ].join('\n');

  document.getElementById('enterprise-output').innerHTML = `
    <div class="result-wrap demand-match-result">
      <section class="result-summary match-result-summary">
        <div class="result-summary-top">
          <div>
            <span class="mini-label">${structured?.status === 'ready' ? '结构化匹配 V1' : '本地匹配预览'}</span>
            <h3>已找到 ${capabilities.length} 个优先核验方向</h3>
            <p>结果分别比较任务、交付、场景、证据和合作边界，并保留每项得分依据。</p>
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
          ${values.modelFollowups?.length ? `<div class="brief-result-row"><span>补充确认</span><p>${escapeHTML(values.modelFollowups.map((item) => item.answer).join('；'))}</p></div>` : ''}
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
                <small>${capability.match ? `${capability.match.score} 分 · ${capability.match.confidence}` : escapeHTML(capability.category)}</small>
              </div>
              <h3>${escapeHTML(capability.name)}</h3>
              <p>${escapeHTML(capability.description)}</p>
              <ul>
                <li><span>场景</span><strong>${escapeHTML(capability.markets.slice(0, 3).join('、'))}</strong></li>
                <li><span>任务</span><strong>${escapeHTML(capability.tasks[0])}</strong></li>
                <li><span>证据</span><strong>${escapeHTML(capability.evidence)}</strong></li>
              </ul>
              <details>
                <summary>查看匹配依据、边界与交付</summary>
                <dl>
                  ${capability.match?.reasons?.map((reason) => `
                    <div><dt>${escapeHTML(reason.dimension)} +${reason.score}</dt><dd>${escapeHTML(reason.reason)}</dd></div>
                  `).join('') || ''}
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
        <summary><span>本次处理记录</span><small>${usage.modelCalls} 次模型调用</small></summary>
        <div>
          <span><strong>${usage.localOperations}</strong><small>本地演示步骤</small></span>
          <span><strong>${usage.modelCalls}</strong><small>实际模型调用</small></span>
          <span><strong>${usage.tokens}</strong><small>实际 Token</small></span>
          <p>${usage.reused
    ? '检测到相同内容；本次会话复用了已有结果，避免重复计费。'
    : usage.modelCalls
      ? `本次通过国内模型生成结构化草稿，估算模型费用约 ¥${usage.costCny.toFixed(4)}；结果仍需用户确认。`
      : '本次使用浏览器内规则生成演示结果，不产生 Token 成本。'}</p>
        </div>
      </details>
      ${feedbackPanel('demand', values.analysisMeta?.receipt_id, 'match')}
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
  enterpriseConfirmation = null;
  pendingReviews.enterprise = null;
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
    score: skill.keywords.reduce((sum, keyword) => {
      if (!normalized.includes(keyword.toLowerCase())) return sum;
      return sum + (lowSignalKeywords.has(keyword.toLowerCase()) ? 0.2 : 1);
    }, 0),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const matches = scored.filter((item) => item.score >= 1.5).slice(0, 5).map((item) => item.skill);
  const selected = [...matches];
  for (const item of scored) {
    if (selected.length >= 3) break;
    if (item.score < 0.8) continue;
    if (!selected.some((skill) => skill.id === item.skill.id)) selected.push(item.skill);
  }
  for (const item of scored) {
    if (selected.length >= 3) break;
    if (!selected.some((skill) => skill.id === item.skill.id)) selected.push(item.skill);
  }
  return selected.slice(0, 5);
}

function getSkillQuestion(skill) {
  return skill.modelQuestion
    || `在“${skill.task}”这类事情中，你本人具体负责哪一步？用了什么方法，最终结果怎样被确认？`;
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
    redactionTerms: parseRedactionTerms(
      document.getElementById('talent-redaction-terms').value,
    ),
  };
  const experienceError = validateField('talent-experience');
  setError('talent-experience', experienceError);
  setErrorSummary('talent-error-summary', Boolean(experienceError));
  if (experienceError) {
    document.getElementById('talent-experience').focus();
    return;
  }

  talentContentKey = createContentKey('talent', values.experience);

  const submit = document.getElementById('decode-btn');
  submit.disabled = true;
  talentForm.hidden = true;
  document.getElementById('talent-status').textContent = 'AI 解析中';
  document.getElementById('talent-status').className = 'status-badge warning';
  updateSteps('t', 1);
  const modelPromise = analyzeWithDomesticModel('capability', {
    text: values.experience,
    sensitive: false,
    redaction_terms: values.redactionTerms,
  });
  const [, modelResult] = await Promise.all([runLoading('talent', [
    { title: 'AI 正在阅读你的经历', detail: '区分岗位描述与本人实际行动', progress: 30 },
    { title: 'AI 正在提炼能力原子', detail: '连接任务、方法、结果与证据', progress: 66 },
    { title: 'AI 正在生成针对性追问', detail: '继续确认贡献边界与熟练程度', progress: 100 },
  ]), modelPromise]);
  document.getElementById('talent-loading').hidden = true;
  submit.disabled = false;
  recordUsage({
    flow: 'talent',
    stage: 'capability-structure',
    contentKey: talentContentKey,
    inputCharacters: values.experience.length,
    mode: modelResult?.meta ? 'model' : 'local-demo',
    tokens: modelResult?.meta?.total_tokens || 0,
    costCny: modelResult?.meta?.estimated_cost_cny || 0,
  });
  if (modelResult?.analysis?.status === 'requires_human_review') {
    renderModelReviewState('talent', modelResult.analysis, values.experience);
    return;
  }
  const modelSkills = getCapabilityModelSkills(
    modelResult,
    talentSkillTemplates,
    capabilityCatalog,
  );
  const skills = modelSkills.length ? modelSkills : getTalentSkills(values.experience);
  if (modelResult?.analysis && !modelSkills.length) {
    const questions = modelResult.analysis.questions || [];
    skills.forEach((skill, index) => {
      skill.modelQuestion = questions[index]?.question || '';
    });
  }
  values.modelAnalysis = modelResult?.analysis || null;
  values.analysisMeta = modelResult?.meta || null;
  const inferredContext = inferTalentContext(values.experience, skills, document.getElementById('talent-market').value);
  values.market = inferredContext.market;
  values.field = inferredContext.field;
  document.getElementById('talent-market').value = values.market;
  document.getElementById('talent-field').value = values.field;
  document.getElementById('talent-market').dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('talent-field').dispatchEvent(new Event('input', { bubbles: true }));
  if (values.modelAnalysis?.status === 'ready_for_l0_card' && !values.modelAnalysis.questions.length) {
    renderTalentConfirmation(values, skills);
  } else {
    renderSkillQuestions(values, skills);
  }
});

document.addEventListener('submit', async (event) => {
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
  let values = pendingTalentValues;
  let skills = activeTalentSkills;
  if (values.modelAnalysis) {
    event.target.querySelector('button[type="submit"]').disabled = true;
    const followups = skills.map((skill) => ({
      question: getSkillQuestion(skill),
      targets: skill.modelAtom?.id ? [skill.modelAtom.id] : [skill.id],
      answer: answers[skill.id],
    }));
    const refined = await refineWithDomesticModel('capability', {
      text: values.experience,
      previousAnalysis: values.modelAnalysis,
      answers: followups,
      redactionTerms: values.redactionTerms || [],
    });
    if (refined?.analysis?.status === 'requires_human_review') {
      renderModelReviewState('talent', refined.analysis, values.experience);
      return;
    }
    if (refined?.analysis) {
      values = {
        ...values,
        modelAnalysis: refined.analysis,
        analysisMeta: refined.meta,
        modelFollowups: followups,
      };
      const refinedSkills = getCapabilityModelSkills(
        refined,
        talentSkillTemplates,
        capabilityCatalog,
      );
      if (refinedSkills.length) skills = refinedSkills;
      recordUsage({
        flow: 'talent',
        stage: 'capability-refine',
        contentKey: talentContentKey,
        inputCharacters: values.experience.length,
        mode: 'model',
        tokens: refined.meta?.total_tokens || 0,
        costCny: refined.meta?.estimated_cost_cny || 0,
      });
    }
  }
  values.skillAnswers = answers;
  renderTalentConfirmation(values, skills);
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'talent-confirmation-form') return;
  event.preventDefault();
  const confirmedAtomIds = [...event.target.querySelectorAll('[name="confirmed-atom"]:checked')]
    .map((field) => field.value);
  if (!confirmedAtomIds.length) {
    showToast('请至少确认一项能力，或返回修改经历');
    return;
  }
  talentConfirmation = { confirmedAtomIds };
  const confirmedSkills = activeTalentSkills.filter((skill) => (
    !skill.modelAtom?.id || confirmedAtomIds.includes(skill.modelAtom.id)
  ));
  renderTalentResult(pendingTalentValues, confirmedSkills, pendingTalentValues.skillAnswers || {});
});

function evidenceCertificationPanel(skills, redactionTerms = []) {
  return `
    <section class="evidence-certification" id="evidence-certification">
      <div class="result-section-heading">
        <div>
          <span class="mini-label">L1–L3 能力核验</span>
          <h3>用材料、微任务和人工审核升级可信等级</h3>
        </div>
        <small>模型不能授予认证等级</small>
      </div>
      <div class="certification-ladder" aria-label="认证等级路径">
        <span class="active"><strong>L0</strong>已确认自述</span>
        <span><strong>L1</strong>材料核验</span>
        <span><strong>L2</strong>微任务通过</span>
        <span><strong>L3</strong>人工认证</span>
      </div>
      <form id="evidence-certification-form" class="evidence-certification-form">
        <div class="review-update-grid">
          <label>选择能力
            <select class="form-select" name="capability_name" required>
              ${skills.map((skill) => (
                `<option value="${escapeHTML(skill.name)}" data-atom-id="${escapeHTML(skill.modelAtom?.id || skill.id)}">${escapeHTML(skill.name)}</option>`
              )).join('')}
            </select>
          </label>
          <label>材料类型
            <select class="form-select" name="evidence_type" required>
              <option value="work_product">本人交付物</option>
              <option value="acceptance_record">验收 / 通过记录</option>
              <option value="metric_report">指标 / 结果报告</option>
              <option value="process_record">过程 / 版本记录</option>
              <option value="reference">可联系证明人或公开引用</option>
            </select>
          </label>
        </div>
        <label>材料说明
          <textarea class="form-textarea compact" name="description" minlength="20" maxlength="1800" required placeholder="说明这份材料证明了什么、你本人完成了什么，以及它不能证明什么。"></textarea>
        </label>
        <label>HTTPS 公开或受控链接（与文件二选一）
          <input class="form-input" type="url" name="source_reference" maxlength="500" placeholder="https://…">
        </label>
        <label>上传私有材料（最大 5MB）
          <input class="form-input" type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.txt,.md,application/pdf,image/png,image/jpeg,text/plain,text/markdown">
        </label>
        <label>需要遮盖的客户 / 机构名
          <input class="form-input" name="redaction_terms" maxlength="400" value="${escapeHTML(redactionTerms.join('，'))}" placeholder="用逗号分隔">
        </label>
        <label class="checkbox-row compact">
          <input type="checkbox" name="consent" value="true" required>
          <span>我有权提交该材料，并确认已移除不必要的个人敏感信息；材料仅供授权审核者核验。</span>
        </label>
        <button class="btn btn-secondary" type="submit">提交 L1 材料核验</button>
        <p data-evidence-form-status role="status"></p>
      </form>
      <div id="evidence-progress" class="evidence-progress" hidden></div>
    </section>`;
}

function renderEvidenceProgress(submission, ownerToken = '') {
  const container = document.getElementById('evidence-progress');
  if (!container || !submission) return;
  container.hidden = false;
  container.dataset.evidenceId = submission.id;
  const labels = {
    material_pending: '材料等待人工核验',
    material_verified: 'L1 已通过，可完成微任务',
    microtask_submitted: '微任务等待人工评分',
    microtask_passed: 'L2 已通过，等待最终认证',
    certified: 'L3 人工认证已完成',
    revision_required: '需要补充或修正材料',
    rejected: '材料未通过核验',
  };
  container.innerHTML = `
    <div class="evidence-progress-head">
      <div><span class="mini-label">核验进度</span><h3>${escapeHTML(submission.capabilityName)}</h3></div>
      <span class="level-pill">${escapeHTML(submission.level)} · ${escapeHTML(labels[submission.status] || submission.status)}</span>
    </div>
    ${ownerToken ? `
      <div class="credential-note">
        <strong>请保存一次性追踪凭证</strong>
        <code>${escapeHTML(ownerToken)}</code>
        <small>凭证只在本次提交后展示；丢失后平台无法替你恢复。</small>
      </div>` : ''}
    ${submission.reviewerNote ? `<p class="reviewer-note"><strong>审核说明：</strong>${escapeHTML(submission.reviewerNote)}</p>` : ''}
    ${submission.challenge?.available ? `
      <form id="evidence-microtask-form">
        <span class="mini-label">L2 微任务</span>
        <h3>${escapeHTML(submission.challenge.prompt)}</h3>
        <ul>${submission.challenge.rubric.map((item) => `<li>${escapeHTML(item)}</li>`).join('')}</ul>
        <textarea class="form-textarea" name="answer" minlength="80" maxlength="4000" required placeholder="至少 80 字，按判断依据、操作步骤、交付物、验收和边界作答。"></textarea>
        <button class="btn btn-secondary" type="submit" ${submission.microtask ? 'disabled' : ''}>${submission.microtask ? '微任务已提交' : '提交微任务'}</button>
        <p data-microtask-status role="status"></p>
      </form>` : '<p>材料通过 L1 人工核验后，系统会开放一项与该能力对应的微任务。</p>'}
    <button class="text-button" type="button" data-action="refresh-evidence">刷新核验进度</button>`;
}

async function renderTalentResult(values, skills, answers) {
  const scene = [values.market || '场景待补充', values.field || '方向由能力提炼'].join(' · ');
  const legacyDemands = scoreDemands(`${values.experience} ${skills.map((skill) => `${skill.name} ${skill.task}`).join(' ')}`);
  const structured = values.modelAnalysis
    ? await requestStructuredMatch('capability', values.modelAnalysis, talentConfirmation || {})
    : null;
  const matchingDemands = structured?.status === 'ready'
    ? structured.matches.map((match) => ({
        ...enterpriseDemandCatalog.find((item) => item.id === match.id),
        match,
      })).filter((item) => item.id)
    : legacyDemands.map((item) => ({ ...item, match: null }));
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
      `本人补充：${answers[skill.id] || '已从原文确认'}`,
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
                <div><dt>本人补充</dt><dd>${escapeHTML(answers[skill.id] || '已从原文确认')}</dd></div>
                <div><dt>常用方法</dt><dd>${escapeHTML(skill.method)}</dd></div>
                <div><dt>典型产出</dt><dd>${escapeHTML(skill.deliverables.join('、'))}</dd></div>
                <div><dt>可核验证据</dt><dd>${escapeHTML(skill.evidenceExamples)}</dd></div>
                <div><dt>能力边界</dt><dd>${escapeHTML(skill.boundary)}</dd></div>
              </dl>
            </details>
          </article>
        `).join('')}
      </section>
      ${evidenceCertificationPanel(skills, values.redactionTerms || [])}
      <section class="result-section">
        <div class="result-section-heading">
          <div><span class="mini-label">可匹配痛点方向</span><h3>这些真实问题值得进一步对照</h3></div>
          <small>仍需确认档期与证据</small>
        </div>
        <div class="matched-demand-list">
          ${matchingDemands.map((demand) => `
            <article>
              <div><span>${escapeHTML(demand.category)}</span><small>${demand.match ? `${demand.match.score} 分 · ${demand.match.confidence}` : escapeHTML(demand.markets.slice(0, 2).join(' / '))}</small></div>
              <h3>${escapeHTML(demand.title)}</h3>
              <p>${escapeHTML(demand.summary)}</p>
              <dl>
                <div><dt>期望交付</dt><dd>${escapeHTML(demand.deliverables.slice(0, 2).join('、'))}</dd></div>
                ${demand.match?.reasons?.map((reason) => `
                  <div><dt>${escapeHTML(reason.dimension)} +${reason.score}</dt><dd>${escapeHTML(reason.reason)}</dd></div>
                `).join('') || '<div><dt>匹配依据</dt><dd>能力任务与场景相似，仍需核验真实案例与合作边界</dd></div>'}
              </dl>
            </article>
          `).join('')}
        </div>
      </section>
      <details class="usage-receipt">
        <summary><span>本次处理记录</span><small>${usage.modelCalls} 次模型调用</small></summary>
        <div>
          <span><strong>${usage.localOperations}</strong><small>本地演示步骤</small></span>
          <span><strong>${usage.modelCalls}</strong><small>实际模型调用</small></span>
          <span><strong>${usage.tokens}</strong><small>实际 Token</small></span>
          <p>${usage.reused
    ? '检测到相同内容；本次会话复用了已有结果，避免重复计费。'
    : usage.modelCalls
      ? `本次通过国内模型生成 L0 能力草稿，估算模型费用约 ¥${usage.costCny.toFixed(4)}；不代表能力认证。`
      : '本次使用浏览器内规则生成演示结果，不产生 Token 成本。'}</p>
        </div>
      </details>
      ${feedbackPanel('capability', values.analysisMeta?.receipt_id, 'match')}
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

document.addEventListener('submit', async (event) => {
  if (event.target.id === 'evidence-certification-form') {
    event.preventDefault();
    const form = event.target;
    const status = form.querySelector('[data-evidence-form-status]');
    const select = form.elements.capability_name;
    const option = select.options[select.selectedIndex];
    const payload = new FormData(form);
    payload.set('atom_id', option.dataset.atomId || '');
    payload.set('consent', form.elements.consent.checked ? 'true' : 'false');
    status.textContent = '正在加密上传并建立核验记录…';
    form.querySelector('button[type="submit"]').disabled = true;
    const result = await submitEvidence(payload);
    form.querySelector('button[type="submit"]').disabled = false;
    if (!result.ok) {
      const messages = {
        FILE_OR_REFERENCE_REQUIRED: '请上传一份材料，或提供 HTTPS 引用链接。',
        FILE_TOO_LARGE: '文件超过 5MB，请压缩或改为提交链接。',
        UNSUPPORTED_FILE_TYPE: '仅支持 PDF、PNG、JPG、TXT 和 Markdown。',
        CONSENT_REQUIRED: '请先确认材料授权与隐私声明。',
      };
      status.textContent = messages[result.body?.error] || '提交失败，请检查内容后重试。';
      return;
    }
    const key = `duduhire-evidence-${result.body.id}`;
    try { window.sessionStorage.setItem(key, result.body.owner_token); } catch { /* no-op */ }
    status.textContent = '材料已进入人工核验队列。';
    renderEvidenceProgress({
      id: result.body.id,
      capabilityName: select.value,
      level: result.body.level,
      status: result.body.status,
      challenge: { available: false, rubric: [] },
    }, result.body.owner_token);
  }

  if (event.target.id === 'evidence-microtask-form') {
    event.preventDefault();
    const container = event.target.closest('[data-evidence-id]');
    const id = container?.dataset.evidenceId;
    let token = '';
    try { token = window.sessionStorage.getItem(`duduhire-evidence-${id}`) || ''; } catch { /* no-op */ }
    const status = event.target.querySelector('[data-microtask-status]');
    if (!token) {
      status.textContent = '当前会话没有追踪凭证，请使用保存的凭证重新打开进度。';
      return;
    }
    status.textContent = '正在提交微任务…';
    const result = await submitEvidenceMicrotask(
      id,
      token,
      event.target.elements.answer.value.trim(),
      pendingTalentValues?.redactionTerms || [],
    );
    status.textContent = result.ok
      ? '微任务已提交，等待人工评分。'
      : '提交失败；请先确认材料已通过 L1 核验。';
    if (result.ok) event.target.querySelector('button[type="submit"]').disabled = true;
  }
});

function resetTalent() {
  talentForm.closest('.builder-panel').hidden = false;
  talentFlow.querySelector('.builder-layout').classList.remove('result-mode');
  talentForm.hidden = false;
  pendingTalentValues = null;
  activeTalentSkills = [];
  talentContentKey = '';
  talentConfirmation = null;
  pendingReviews.talent = null;
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
  enterpriseConfirmation = null;
  pendingReviews.enterprise = null;
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
  talentConfirmation = null;
  pendingReviews.talent = null;
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

async function refineDemandFromConfirmation() {
  const corrections = document.getElementById('demand-corrections')?.value.trim() || '';
  if (!corrections) {
    showToast('请先写明需要修改或补充的内容');
    return;
  }
  const result = await refineWithDomesticModel('demand', {
    text: pendingEnterpriseValues.problem,
    sensitive: pendingEnterpriseValues.sensitive,
    previousAnalysis: pendingEnterpriseValues.modelAnalysis,
    answers: pendingEnterpriseValues.modelFollowups || [],
    corrections,
    redactionTerms: pendingEnterpriseValues.redactionTerms || [],
  });
  if (!result?.analysis) {
    showToast('重新解析失败，请稍后再试');
    return;
  }
  pendingEnterpriseValues = mapDemandAnalysis(result, pendingEnterpriseValues);
  enterpriseConfirmation = null;
  recordUsage({
    flow: 'demand',
    stage: 'correction',
    contentKey: enterpriseContentKey,
    inputCharacters: pendingEnterpriseValues.problem.length,
    mode: 'model',
    tokens: result.meta?.total_tokens || 0,
    costCny: result.meta?.estimated_cost_cny || 0,
  });
  if (result.analysis.status === 'requires_human_review') {
    renderModelReviewState('enterprise', result.analysis, pendingEnterpriseValues.problem);
    return;
  }
  renderDemandConfirmation(pendingEnterpriseValues);
}

async function refineTalentFromConfirmation() {
  const corrections = document.getElementById('talent-corrections')?.value.trim() || '';
  if (!corrections) {
    showToast('请先写明需要修改或补充的内容');
    return;
  }
  const result = await refineWithDomesticModel('capability', {
    text: pendingTalentValues.experience,
    previousAnalysis: pendingTalentValues.modelAnalysis,
    answers: pendingTalentValues.modelFollowups || [],
    corrections,
    redactionTerms: pendingTalentValues.redactionTerms || [],
  });
  if (!result?.analysis) {
    showToast('重新解析失败，请稍后再试');
    return;
  }
  pendingTalentValues = {
    ...pendingTalentValues,
    modelAnalysis: result.analysis,
    analysisMeta: result.meta,
  };
  talentConfirmation = null;
  recordUsage({
    flow: 'talent',
    stage: 'correction',
    contentKey: talentContentKey,
    inputCharacters: pendingTalentValues.experience.length,
    mode: 'model',
    tokens: result.meta?.total_tokens || 0,
    costCny: result.meta?.estimated_cost_cny || 0,
  });
  if (result.analysis.status === 'requires_human_review') {
    renderModelReviewState('talent', result.analysis, pendingTalentValues.experience);
    return;
  }
  const refinedSkills = getCapabilityModelSkills(result, talentSkillTemplates, capabilityCatalog);
  if (refinedSkills.length) activeTalentSkills = refinedSkills;
  renderTalentConfirmation(pendingTalentValues, activeTalentSkills);
}

async function saveFeedbackFromPanel(button) {
  const panel = button.closest('[data-feedback-panel]');
  if (!panel) return;
  const status = panel.querySelector('[data-feedback-status]');
  const comment = panel.querySelector('[data-feedback-comment]').value.trim();
  const consent = panel.querySelector('[data-feedback-consent]').checked;
  button.disabled = true;
  const saved = await submitAnalysisFeedback({
    receiptId: panel.dataset.receiptId,
    flow: panel.dataset.flow,
    target: panel.dataset.target,
    verdict: button.dataset.feedbackVerdict,
    comment,
    consent,
  });
  if (saved?.saved) {
    status.textContent = '反馈已保存，谢谢。';
    panel.querySelectorAll('[data-feedback-verdict]').forEach((item) => {
      item.disabled = true;
    });
  } else {
    button.disabled = false;
    status.textContent = '暂时无法保存，请稍后再试。';
  }
}

async function queuePendingReview(type) {
  const pending = pendingReviews[type];
  if (!pending) return;
  const consent = document.getElementById(`${type}-review-consent`)?.checked;
  const status = document.getElementById(`${type}-review-status`);
  if (!consent) {
    status.textContent = '请先确认同意保存已脱敏材料。';
    return;
  }
  status.textContent = '正在提交…';
  const result = await submitHumanReview({
    ...pending,
    note: document.getElementById(`${type}-review-note`)?.value.trim() || '',
    consent: true,
  });
  status.textContent = result?.queued
    ? `已进入人工审核队列，编号 ${result.id}。`
    : '暂时无法提交，请稍后再试。';
}

document.addEventListener('click', async (event) => {
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
  const feedbackButton = event.target.closest('[data-feedback-verdict]');
  if (feedbackButton) {
    await saveFeedbackFromPanel(feedbackButton);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'copy-collaboration-invite') copyCollaborationInvite();
  if (action === 'skip-enterprise-followup' && pendingEnterpriseValues) renderDemandConfirmation(pendingEnterpriseValues);
  if (action === 'refine-demand') await refineDemandFromConfirmation();
  if (action === 'refine-talent') await refineTalentFromConfirmation();
  if (action === 'submit-review-enterprise') await queuePendingReview('enterprise');
  if (action === 'submit-review-talent') await queuePendingReview('talent');
  if (action === 'refresh-evidence') {
    const container = button.closest('[data-evidence-id]');
    const id = container?.dataset.evidenceId;
    let token = '';
    try { token = window.sessionStorage.getItem(`duduhire-evidence-${id}`) || ''; } catch { /* no-op */ }
    if (!id || !token) {
      showToast('当前会话没有追踪凭证');
      return;
    }
    button.disabled = true;
    const result = await getEvidenceStatus(id, token);
    button.disabled = false;
    if (!result?.submission) {
      showToast('暂时无法读取核验进度');
      return;
    }
    renderEvidenceProgress(result.submission);
  }
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
