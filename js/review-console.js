const authForm = document.getElementById('review-auth-form');
const tokenInput = document.getElementById('review-admin-token');
const authStatus = document.getElementById('review-auth-status');
const metricsElement = document.getElementById('review-metrics');
const reviewList = document.getElementById('review-list');
const statusFilter = document.getElementById('review-status-filter');

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
  metricsElement.innerHTML = `
    <article><span>近 ${metrics.days} 天解析</span><strong>${metricValue(analysis.total)}</strong><small>${metricValue(analysis.refined)} 次二次解析</small></article>
    <article><span>平均响应</span><strong>${metricValue(analysis.avg_latency, (value) => `${Math.round(value)}ms`)}</strong><small>不包含浏览器渲染</small></article>
    <article><span>模型估算成本</span><strong>${metricValue(analysis.cost, (value) => `¥${value.toFixed(4)}`)}</strong><small>${metricValue(analysis.redactions)} 处自动脱敏</small></article>
    <article><span>正向反馈</span><strong>${metricValue(feedback.helpful)}</strong><small>${metricValue(feedback.not_helpful)} 条负向反馈</small></article>
    <article><span>待人工审核</span><strong>${metricValue(reviews.pending)}</strong><small>${metricValue(reviews.resolved)} 条已完成</small></article>
  `;
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
            <textarea class="form-textarea compact" name="reviewerNote" maxlength="1200" placeholder="说明风险判断、需要修改的内容和下一步。">${escapeHTML(review.reviewerNote || '')}</textarea>
          </label>
          <button class="btn btn-secondary" type="submit">保存处理结果</button>
          <p data-review-update-status role="status"></p>
        </form>
      </article>`;
  }).join('');
}

async function loadConsole() {
  authStatus.textContent = '正在载入…';
  const [metricsResponse, reviewsResponse] = await Promise.all([
    fetch('/api/metrics?days=7', { headers: adminHeaders() }),
    fetch(`/api/reviews?status=${encodeURIComponent(statusFilter.value)}`, { headers: adminHeaders() }),
  ]);
  if (metricsResponse.status === 401 || reviewsResponse.status === 401) {
    authStatus.textContent = '没有审核权限。请在已授权工作区打开，或输入管理员令牌。';
    metricsElement.innerHTML = '';
    return;
  }
  if (!metricsResponse.ok || !reviewsResponse.ok) {
    authStatus.textContent = '控制台暂时不可用，请稍后再试。';
    return;
  }
  const [{ metrics }, { reviews }] = await Promise.all([
    metricsResponse.json(),
    reviewsResponse.json(),
  ]);
  authStatus.textContent = '审核权限已确认。';
  renderMetrics(metrics);
  renderReviews(reviews);
}

authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  adminToken = tokenInput.value.trim();
  loadConsole();
});

statusFilter.addEventListener('change', loadConsole);

reviewList.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-review-update]');
  if (!form) return;
  event.preventDefault();
  const card = form.closest('[data-review-id]');
  const status = form.querySelector('[data-review-update-status]');
  const payload = Object.fromEntries(new FormData(form));
  status.textContent = '正在保存…';
  const response = await fetch(`/api/reviews/${encodeURIComponent(card.dataset.reviewId)}`, {
    method: 'PATCH',
    headers: adminHeaders(true),
    body: JSON.stringify(payload),
  });
  status.textContent = response.ok ? '处理结果已保存。' : '保存失败，请检查权限后重试。';
  if (response.ok) loadConsole();
});

loadConsole();
