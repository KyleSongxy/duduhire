import { capabilityCatalog, enterpriseDemandCatalog } from './data.js';

const searchInput = document.getElementById('capability-search');
const categoryFilter = document.getElementById('category-filter');
const marketFilter = document.getElementById('market-filter');
const grid = document.getElementById('directory-grid');
const resultCount = document.getElementById('result-count');
const resultNote = document.getElementById('result-note');
const noResults = document.getElementById('no-results');
const clearFilters = document.getElementById('clear-filters');
const assetGuide = document.getElementById('asset-guide');
const assetShortcuts = document.getElementById('asset-shortcuts');
const tabButtons = [...document.querySelectorAll('[data-view]')];
const params = new URLSearchParams(window.location.search);

document.getElementById('demand-total').textContent = enterpriseDemandCatalog.length;
document.getElementById('capability-total').textContent = capabilityCatalog.length;

let currentView = params.get('view') === 'capability' ? 'capability' : 'demand';

function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function publicServiceLabel(value = '') {
  return String(value)
    .replaceAll('标准微任务', '微任务')
    .replaceAll('付费试用项目', '协作验证')
    .replaceAll('付费试用', '协作验证');
}

function getDataset() {
  return currentView === 'demand' ? enterpriseDemandCatalog : capabilityCatalog;
}

function getSearchableText(item) {
  return Object.values(item)
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function setOptions(select, values, allLabel, requestedValue = '全部') {
  select.innerHTML = `<option value="全部">${allLabel}</option>${values.map((item) => `<option value="${escapeHTML(item)}">${escapeHTML(item)}</option>`).join('')}`;
  select.value = values.includes(requestedValue) ? requestedValue : '全部';
}

function populateFilters(requestedCategory = '全部', requestedMarket = '全部') {
  const data = getDataset();
  const categories = [...new Set(data.map((item) => item.category))];
  const markets = [...new Set(data.flatMap((item) => item.markets))];
  setOptions(categoryFilter, categories, '全部方向', requestedCategory);
  setOptions(marketFilter, markets, '全部市场', requestedMarket);
  renderShortcuts(categories);
}

function renderShortcuts(categories) {
  const visible = categories.slice(0, 6);
  assetShortcuts.innerHTML = `
    <span>快速查看</span>
    <button type="button" data-category="全部" class="${categoryFilter.value === '全部' ? 'active' : ''}">全部</button>
    ${visible.map((category) => `<button type="button" data-category="${escapeHTML(category)}" class="${categoryFilter.value === category ? 'active' : ''}">${escapeHTML(category)}</button>`).join('')}
  `;
}

function renderDemandCard(item) {
  return `
    <article class="directory-card demand-card">
      <div class="directory-card-top">
        <span class="priority-pill ${item.priority === '首发重点' ? '' : 'secondary'}">${escapeHTML(item.priority)}</span>
        <span class="directory-category">${escapeHTML(item.category)}<small>${escapeHTML(item.markets.join(' / '))}</small></span>
      </div>
      <h3>${escapeHTML(item.title)}</h3>
      <p>${escapeHTML(item.summary)}</p>
      <blockquote class="asset-example"><span>需求方可能这样描述</span><p>${escapeHTML(item.example)}</p></blockquote>
      <div class="deliverable-list" aria-label="典型交付物">${item.deliverables.map((deliverable) => `<span>${escapeHTML(deliverable)}</span>`).join('')}</div>
      <div class="directory-facts asset-facts">
        <div><span>业务阶段</span><strong>${escapeHTML(item.stage)}</strong></div>
        <div><span>参考周期</span><strong>${escapeHTML(item.duration)}</strong></div>
        <div><span>建议方式</span><strong>${escapeHTML(publicServiceLabel(item.service))}</strong></div>
      </div>
      <details class="asset-details">
        <summary>查看完整任务结构</summary>
        <dl>
          <div><dt>业务影响</dt><dd>${escapeHTML(item.impact)}</dd></div>
          <div><dt>希望解决</dt><dd>${escapeHTML(item.goal)}</dd></div>
          <div><dt>怎样验收</dt><dd>${escapeHTML(item.acceptance)}</dd></div>
          <div><dt>需要准备</dt><dd>${escapeHTML(item.inputs)}</dd></div>
          <div><dt>不包含</dt><dd>${escapeHTML(item.boundary)}</dd></div>
        </dl>
      </details>
      <a class="text-link" href="/skill-builder.html?role=enterprise&demand=${encodeURIComponent(item.id)}">用这个样例描述我的痛点 <span aria-hidden="true">→</span></a>
    </article>`;
}

function renderCapabilityCard(item) {
  return `
    <article class="directory-card capability-directory-card">
      <div class="directory-card-top">
        <span class="priority-pill ${item.priority === '当前重点' ? '' : 'secondary'}">${escapeHTML(item.priority)}</span>
        <span class="directory-category">${escapeHTML(item.category)}<small>${escapeHTML(item.markets.join(' / '))}</small></span>
      </div>
      <h3>${escapeHTML(item.name)}</h3>
      <p>${escapeHTML(item.description)}</p>
      <div class="directory-facts">
        <div><span>常见合作</span><strong>${escapeHTML(publicServiceLabel(item.service))}</strong></div>
        <div><span>参考周期</span><strong>${escapeHTML(item.duration)}</strong></div>
      </div>
      <details class="asset-details">
        <summary>查看任务与证据</summary>
        <dl>
          <div><dt>常见任务</dt><dd>${escapeHTML(item.tasks.join('、'))}</dd></div>
          <div><dt>常用方法</dt><dd>${escapeHTML(item.methods)}</dd></div>
          <div><dt>典型产出</dt><dd>${escapeHTML(item.deliverables.join('、'))}</dd></div>
          <div><dt>交付验收</dt><dd>${escapeHTML(item.acceptance)}</dd></div>
          <div><dt>推荐前核验</dt><dd>${escapeHTML(item.evidence)}</dd></div>
          <div><dt>能力边界</dt><dd>${escapeHTML(item.boundary)}</dd></div>
        </dl>
      </details>
      <a class="text-link" href="/skill-builder.html?role=talent&capability=${encodeURIComponent(item.id)}">用这个方向挖掘我的能力 <span aria-hidden="true">→</span></a>
    </article>`;
}

function updateUrl(query, category, market) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set('view', currentView);
  if (query) nextUrl.searchParams.set('q', searchInput.value.trim());
  else nextUrl.searchParams.delete('q');
  if (category !== '全部') nextUrl.searchParams.set('category', category);
  else nextUrl.searchParams.delete('category');
  if (market !== '全部') nextUrl.searchParams.set('market', market);
  else nextUrl.searchParams.delete('market');
  window.history.replaceState({}, '', nextUrl);
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const category = categoryFilter.value;
  const market = marketFilter.value;
  const filtered = getDataset().filter((item) => {
    const matchesQuery = !query || getSearchableText(item).includes(query);
    const matchesCategory = category === '全部' || item.category === category;
    const matchesMarket = market === '全部' || item.markets.includes(market);
    return matchesQuery && matchesCategory && matchesMarket;
  });

  updateUrl(query, category, market);
  renderShortcuts([...new Set(getDataset().map((item) => item.category))]);
  const unit = currentView === 'demand' ? '条痛点需求样例' : '项人才能力方向';
  resultCount.textContent = `共找到 ${filtered.length} ${unit}`;
  noResults.hidden = filtered.length !== 0;
  grid.hidden = filtered.length === 0;
  grid.innerHTML = filtered.map((item) => currentView === 'demand' ? renderDemandCard(item) : renderCapabilityCard(item)).join('');
}

function setView(view, requestedCategory = '全部', requestedMarket = '全部') {
  currentView = view;
  tabButtons.forEach((button) => {
    const active = button.dataset.view === view;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  grid.setAttribute('aria-labelledby', view === 'demand' ? 'demand-tab' : 'capability-tab');
  assetGuide.textContent = view === 'demand'
    ? '痛点需求样例帮助你把一句“做得不好”写成可以判断范围和验收方式的问题。'
    : '人才能力图谱说明一项能力能完成什么任务、常用什么方法，以及推荐前需要核验什么证据。';
  resultNote.textContent = view === 'demand'
    ? '所有内容都是问题模板，不代表真实客户案例或当前需求量。'
    : '目录不按热度给人才排名，“当前重点”只表示首发服务范围。';
  searchInput.placeholder = view === 'demand'
    ? '搜索业务现象，例如：流量下滑、复购、渠道'
    : '搜索任务或能力，例如：本地化、用户研究、数据';
  populateFilters(requestedCategory, requestedMarket);
  render();
}

searchInput.value = params.get('q') || '';
setView(currentView, params.get('category') || '全部', params.get('market') || '全部');

searchInput.addEventListener('input', render);
categoryFilter.addEventListener('change', render);
marketFilter.addEventListener('change', render);

tabButtons.forEach((button, index) => {
  button.addEventListener('click', () => setView(button.dataset.view));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabButtons.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabButtons.length - 1;
    tabButtons[nextIndex].focus();
    setView(tabButtons[nextIndex].dataset.view);
  });
});

assetShortcuts.addEventListener('click', (event) => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  categoryFilter.value = button.dataset.category;
  render();
});

clearFilters.addEventListener('click', () => {
  searchInput.value = '';
  categoryFilter.value = '全部';
  marketFilter.value = '全部';
  searchInput.focus();
  render();
});
