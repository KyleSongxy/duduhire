const authForm = document.getElementById('review-auth-form');
const tokenInput = document.getElementById('review-admin-token');
const authStatus = document.getElementById('review-auth-status');
const metricsElement = document.getElementById('review-metrics');
const providerMetrics = document.getElementById('provider-metrics');
const providerProbeStatus = document.getElementById('provider-probe-status');
const reviewList = document.getElementById('review-list');
const statusFilter = document.getElementById('review-status-filter');
const evidenceList = document.getElementById('evidence-review-list');
const evidenceFilter = document.getElementById('evidence-status-filter');
const evaluationList = document.getElementById('evaluation-list');
const evaluationFilter = document.getElementById('evaluation-status-filter');

let adminToken = '';

function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function adminHeaders(json = false) {
  return {
    accept: 'application/json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(adminToken ? { 'x-review-admin-token': adminToken } : {}),
  };
}

function metricValue(value, formatter = (item) => item) {
  const number = Number(value || 0);
  return formatter(number);
}

function renderMetrics(metrics) {
  const analysis = metrics.analysis || {};
  const feedback = Object.fromEntries(
    (metrics.feedback || []).map((item) => [item.verdict, Number(item.total)]),
  );
  const reviews = Object.fromEntries(
    (metrics.reviews || []).map((item) => [item.status, Number(item.total)]),
  );
  const evidence = (metrics.evidence || []).reduce((total, item) => total + Number(item.total), 0);
  const evaluation = Object.fromEntries(
    (metrics.evaluation || []).map((item) => [item.status, Number(item.total)]),
  );
  metricsElement.innerHTML = `
    <article><span>近 ${metrics.days} 天解析</span><strong>${metricValue(analysis.total)}</strong><small>${metricValue(analysis.refined)} 次二次解析</small></article>
    <article><span>平均响应</span><strong>${metricValue(analysis.avg_latency, (value) => `${Math.round(value)}ms`)}</strong><small>不包含浏览器渲染</small></article>
    <article><span>模型估算成本</span><strong>${metricValue(analysis.cost, (value) => `¥${value.toFixed(4)}`)}</strong><small>${metricValue(analysis.redactions)} 处自动脱敏</small></article>
    <article><span>正向反馈</span><strong>${metricValue(feedback.helpful)}</strong><small>${metricValue(feedback.not_helpful)} 条负向反馈</small></article>
    <article><span>待人工审核</span><strong>${metricValue(reviews.pending)}</strong><small>${metricValue(reviews.resolved)} 条已完成</small></article>
    <article><span>证据认证记录</span><strong>${evidence}</strong><small>L1–L3 全程人工授权</small></article>
    <article><span>黄金集进度</span><strong>${metricValue(evaluation.agreed) + metricValue(evaluation.adjudicated)}</strong><small>100 条中的已确认样本</small></article>
  `;

  providerMetrics.innerHTML = (metrics.providerAttempts || []).map((item) => {
    const attempts = Number(item.attempts || 0);
    const successes = Number(item.successes || 0);
    const successRate = attempts ? Math.round((successes / attempts) * 100) : 0;
    return `
      <article>
        <span>${escapeHTML(item.provider)} · ${escapeHTML(item.model)}</span>
        <strong>${successRate}%</strong>
        <small>${successes}/${attempts} 成功 · 平均 ${Math.round(Number(item.avg_latency || 0))}ms · ¥${Number(item.cost || 0).toFixed(4)}</small>
      </article>`;
  }).join('') || '<p>还没有模型调用样本。可先运行健康检查。</p>';
}

function summarizePayload(payload) {
  const analysis = payload?.analysis || {};
  if (analysis.problem) {
    return {
      title: analysis.problem.summary || '待审核痛点',
      detail: analysis.problem.desired_outcome || '目标待确认',
      evidence: (analysis.facts || []).slice(0, 4).map((fact) => fact.source_quote),
    };
  }
  return {
    title: analysis.capability_atoms?.[0]?.name || '待审核能力材料',
    detail: analysis.capability_atoms?.map((atom) => atom.task).join('；') || '本人贡献待确认',
    evidence: (analysis.projects || []).flatMap((project) => project.source_quotes || []).slice(0, 4),
  };
}

function renderReviews(reviews) {
  if (!reviews.length) {
    reviewList.innerHTML = '<div class="empty-state"><div class="empty-state-inner"><h3>当前筛选下没有材料</h3><p>新的高风险材料会在用户明确同意后进入这里。</p></div></div>';
    return;
  }
  reviewList.innerHTML = reviews.map((review) => {
    const summary = summarizePayload(review.payload);
    return `
      <article class="review-card" data-review-id="${escapeHTML(review.id)}">
        <header>
          <div>
            <span>${review.flow === 'demand' ? '痛点' : '能力'} · ${escapeHTML(review.status)}</span>
            <h3>${escapeHTML(summary.title)}</h3>
            <p>${escapeHTML(summary.detail)}</p>
          </div>
          <time>${new Date(review.createdAt).toLocaleString('zh-CN')}</time>
        </header>
        <div class="capability-tags">
          ${(review.riskFlags || []).map((flag) => `<span class="capability-tag">${escapeHTML(flag)}</span>`).join('')}
        </div>
        <details>
          <summary>查看已脱敏证据片段</summary>
          <ul>${summary.evidence.map((quote) => `<li>${escapeHTML(quote)}</li>`).join('') || '<li>没有可展示的证据片段</li>'}</ul>
        </details>
        <form data-review-update>
          <div class="review-update-grid">
            <label>处理状态
              <select name="status" class="form-select">
                ${['pending', 'in_review', 'resolved', 'rejected'].map((status) => (
                  `<option value="${status}" ${status === review.status ? 'selected' : ''}>${status}</option>`
                )).join('')}
              </select>
            </label>
            <label>处理结论
              <input class="form-input" name="resolution" maxlength="80" value="${escapeHTML(review.resolution || '')}" placeholder="例如：脱敏后可重新解析">
            </label>
          </div>
          <label>审核说明
            <textarea class="form-textarea compact" name="reviewerNote" maxlength="1200">${escapeHTML(review.reviewerNote || '')}</textarea>
          </label>
          <button class="btn btn-secondary" type="submit">保存处理结果</button>
          <p data-review-update-status role="status"></p>
        </form>
      </article>`;
  }).join('');
}

function renderEvidence(submissions) {
  const labels = {
    material_pending: '材料待核验',
    material_verified: 'L1 材料已通过',
    microtask_submitted: '微任务待评分',
    microtask_passed: 'L2 微任务已通过',
    certified: 'L3 已认证',
    revision_required: '待补充',
    rejected: '已驳回',
  };
  if (!submissions.length) {
    evidenceList.innerHTML = '<div class="empty-state"><div class="empty-state-inner"><h3>没有待处理的证据</h3><p>用户提交后会显示在这里。</p></div></div>';
    return;
  }
  evidenceList.innerHTML = submissions.map((item) => `
    <article class="review-card" data-evidence-review-id="${escapeHTML(item.id)}">
      <header>
        <div><span>${escapeHTML(item.level)} · ${escapeHTML(labels[item.status] || item.status)}</span><h3>${escapeHTML(item.capabilityName)}</h3><p>${escapeHTML(item.description)}</p></div>
        <time>${new Date(item.createdAt).toLocaleString('zh-CN')}</time>
      </header>
      <dl class="evidence-summary">
        <div><dt>材料类型</dt><dd>${escapeHTML(item.evidenceType)}</dd></div>
        <div><dt>引用</dt><dd>${item.sourceReference ? `<a href="${escapeHTML(item.sourceReference)}" target="_blank" rel="noopener noreferrer">打开 HTTPS 引用</a>` : '未提供'}</dd></div>
        <div><dt>私有文件</dt><dd>${item.hasFile ? `<a href="/api/evidence-submissions/${encodeURIComponent(item.id)}/file" target="_blank">${escapeHTML(item.fileName || '下载材料')}</a>` : '未上传'}</dd></div>
      </dl>
      <form data-evidence-review-update>
        <div class="review-update-grid">
          <label>审核动作
            <select class="form-select" name="status">
              <option value="material_verified">通过材料，授予 L1</option>
              <option value="microtask_passed">微任务通过，授予 L2</option>
              <option value="certified">最终人工认证，授予 L3</option>
              <option value="revision_required">要求补充</option>
              <option value="rejected">驳回</option>
            </select>
          </label>
          <label>微任务得分（通过 L2 时 ≥70）
            <input class="form-input" name="score" type="number" min="0" max="100" value="80">
          </label>
        </div>
        <label>审核说明
          <textarea class="form-textarea compact" name="note" maxlength="1200" required placeholder="记录核验依据、边界和需要补充的内容。"></textarea>
        </label>
        <button class="btn btn-secondary" type="submit">提交人工决定</button>
        <p data-evidence-review-status role="status"></p>
      </form>
    </article>`).join('');
}

function renderEvaluation(cases) {
  if (!cases.length) {
    evaluationList.innerHTML = '<div class="empty-state"><div class="empty-state-inner"><h3>当前筛选下没有样本</h3><p>切换筛选查看其他标注状态。</p></div></div>';
    return;
  }
  evaluationList.innerHTML = cases.map((item) => `
    <article class="review-card" data-eval-case-id="${escapeHTML(item.caseId)}">
      <header>
        <div><span>${item.flow === 'demand' ? '痛点' : '能力'} · ${escapeHTML(item.status)} · ${item.reviewCount}/2 审</span><h3>${escapeHTML(item.caseId)}</h3><p>${escapeHTML(item.input)}</p></div>
      </header>
      <form data-evaluation-review>
        <label>结构化期望（JSON）
          <textarea class="form-textarea eval-json" name="expected" rows="12">${escapeHTML(JSON.stringify(item.proposedExpected, null, 2))}</textarea>
        </label>
        <div class="review-update-grid">
          <label>决定
            <select class="form-select" name="decision">
              <option value="accept">接受建议标签</option>
              <option value="edit">已修改标签</option>
            </select>
          </label>
          <label>标注说明
            <input class="form-input" name="note" maxlength="1200" placeholder="记录修改理由或歧义">
          </label>
        </div>
        <div class="feedback-actions">
          <button class="btn btn-secondary" type="submit">提交独立标注</button>
          ${item.status === 'disputed' ? '<button class="btn btn-primary" type="button" data-evaluation-adjudicate>提交第三人仲裁</button>' : ''}
        </div>
        <p data-evaluation-status role="status"></p>
      </form>
    </article>`).join('');
}

async function loadConsole() {
  authStatus.textContent = '正在载入…';
  const [metricsResponse, reviewsResponse, evidenceResponse, evaluationResponse] = await Promise.all([
    fetch('/api/metrics?days=7', { headers: adminHeaders() }),
    fetch(`/api/reviews?status=${encodeURIComponent(statusFilter.value)}`, { headers: adminHeaders() }),
    fetch(`/api/evidence-submissions?status=${encodeURIComponent(evidenceFilter.value)}`, { headers: adminHeaders() }),
    fetch(`/api/evaluation/cases?status=${encodeURIComponent(evaluationFilter.value)}&limit=30`, { headers: adminHeaders() }),
  ]);
  if ([metricsResponse, reviewsResponse, evidenceResponse, evaluationResponse].some((response) => response.status === 401)) {
    authStatus.textContent = '没有审核权限。请在已授权工作区打开，或输入管理员令牌。';
    metricsElement.innerHTML = '';
    return;
  }
  if ([metricsResponse, reviewsResponse, evidenceResponse, evaluationResponse].some((response) => !response.ok)) {
    authStatus.textContent = '控制台部分功能暂时不可用，请稍后再试。';
    return;
  }
  const [{ metrics }, { reviews }, { submissions }, { cases }] = await Promise.all([
    metricsResponse.json(),
    reviewsResponse.json(),
    evidenceResponse.json(),
    evaluationResponse.json(),
  ]);
  authStatus.textContent = '审核权限已确认。';
  renderMetrics(metrics);
  renderReviews(reviews);
  renderEvidence(submissions);
  renderEvaluation(cases);
}

authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  adminToken = tokenInput.value.trim();
  loadConsole();
});

statusFilter.addEventListener('change', loadConsole);
evidenceFilter.addEventListener('change', loadConsole);
evaluationFilter.addEventListener('change', loadConsole);

reviewList.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-review-update]');
  if (!form) return;
  event.preventDefault();
  const card = form.closest('[data-review-id]');
  const status = form.querySelector('[data-review-update-status]');
  status.textContent = '正在保存…';
  const response = await fetch(`/api/reviews/${encodeURIComponent(card.dataset.reviewId)}`, {
    method: 'PATCH',
    headers: adminHeaders(true),
    body: JSON.stringify(Object.fromEntries(new FormData(form))),
  });
  status.textContent = response.ok ? '处理结果已保存。' : '保存失败，请检查权限后重试。';
  if (response.ok) loadConsole();
});

evidenceList.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-evidence-review-update]');
  if (!form) return;
  event.preventDefault();
  const card = form.closest('[data-evidence-review-id]');
  const status = form.querySelector('[data-evidence-review-status]');
  status.textContent = '正在保存人工决定…';
  const response = await fetch(
    `/api/evidence-submissions/${encodeURIComponent(card.dataset.evidenceReviewId)}/review`,
    {
      method: 'PATCH',
      headers: adminHeaders(true),
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    },
  );
  const result = await response.json();
  status.textContent = response.ok
    ? `已更新为 ${result.level} · ${result.status}。`
    : `无法执行：${result.reason || result.error || '请检查等级顺序'}。`;
  if (response.ok) loadConsole();
});

evaluationList.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-evaluation-review]');
  if (!form) return;
  event.preventDefault();
  const card = form.closest('[data-eval-case-id]');
  const status = form.querySelector('[data-evaluation-status]');
  let expected;
  try {
    expected = JSON.parse(form.elements.expected.value);
  } catch {
    status.textContent = 'JSON 格式不正确。';
    return;
  }
  status.textContent = '正在保存独立标注…';
  const response = await fetch(
    `/api/evaluation/cases/${encodeURIComponent(card.dataset.evalCaseId)}/reviews`,
    {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({
        expected,
        decision: form.elements.decision.value,
        note: form.elements.note.value,
      }),
    },
  );
  const result = await response.json();
  status.textContent = response.ok
    ? `标注已保存，样本状态：${result.status}。`
    : `无法保存：${result.reason || result.error}。`;
  if (response.ok) loadConsole();
});

evaluationList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-evaluation-adjudicate]');
  if (!button) return;
  const form = button.closest('[data-evaluation-review]');
  const card = form.closest('[data-eval-case-id]');
  const status = form.querySelector('[data-evaluation-status]');
  let expected;
  try {
    expected = JSON.parse(form.elements.expected.value);
  } catch {
    status.textContent = 'JSON 格式不正确。';
    return;
  }
  status.textContent = '正在提交仲裁决定…';
  const response = await fetch(
    `/api/evaluation/cases/${encodeURIComponent(card.dataset.evalCaseId)}/adjudicate`,
    {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ expected, note: form.elements.note.value }),
    },
  );
  const result = await response.json();
  status.textContent = response.ok
    ? '仲裁结果已保存。'
    : `无法仲裁：${result.reason || result.error}。`;
  if (response.ok) loadConsole();
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-provider-probe]');
  if (!button) return;
  button.disabled = true;
  providerProbeStatus.textContent = `正在检查 ${button.textContent.trim()}…`;
  const response = await fetch(
    `/api/providers/${encodeURIComponent(button.dataset.providerProbe)}/probe`,
    { method: 'POST', headers: adminHeaders(true), body: '{}' },
  );
  const result = await response.json();
  button.disabled = false;
  providerProbeStatus.textContent = result.ok
    ? `${result.model} 已连通，响应 ${result.latencyMs}ms。`
    : `${result.model || button.dataset.providerProbe} 检查失败：${result.error || '未知错误'}。`;
  if (result.ok) loadConsole();
});

loadConsole();
