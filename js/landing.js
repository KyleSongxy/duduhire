import { capabilityCatalog, enterpriseDemandCatalog } from './data.js';

const navToggle = document.getElementById('nav-toggle');
const nav = document.getElementById('main-nav');
const loginDialog = document.getElementById('login-dialog');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function getDemoPair(demandId) {
  const demand = enterpriseDemandCatalog.find((item) => item.id === demandId) || enterpriseDemandCatalog[0];
  const primaryCapabilityId = demand.capabilityIds[0];
  const capability = capabilityCatalog.find((item) => item.id === primaryCapabilityId) || capabilityCatalog[0];
  return { demand, capability };
}

function renderMatchDemo(demandId, scrollIntoView = false) {
  const { demand, capability } = getDemoPair(demandId);
  document.querySelectorAll('[role="tab"][data-demo-scenario]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.demoScenario === demand.id));
  });

  document.getElementById('demo-demand-meta').textContent = `${demand.markets.slice(0, 2).join(' / ')} · ${demand.stage}`;
  document.getElementById('demo-demand-example').textContent = demand.example;
  document.getElementById('demo-demand-impact').textContent = demand.impact;
  document.getElementById('demo-demand-goal').textContent = demand.goal;
  document.getElementById('demo-capability-category').textContent = capability.category;
  document.getElementById('demo-capability-name').textContent = capability.name;
  document.getElementById('demo-capability-description').textContent = capability.description;
  document.getElementById('demo-capability-meta').textContent = `${capability.duration} · ${capability.service.split(' / ').at(-1)}`;
  document.getElementById('demo-match-reasons').innerHTML = `
    <li><span>负责什么</span><strong>${capability.tasks.join('；')}</strong></li>
    <li><span>如何完成</span><strong>${capability.methods}</strong></li>
    <li><span>交付什么</span><strong>${capability.deliverables.join('、')}</strong></li>
    <li><span>如何核验</span><strong>${capability.evidence}。判断标准：${capability.acceptance}</strong></li>
    <li><span>能力边界</span><strong>${capability.boundary}</strong></li>
  `;
  document.getElementById('demo-microtask-title').textContent = `${demand.duration} · ${demand.service.split(' / ')[0]}`;
  document.getElementById('demo-microtask-copy').textContent = `先交付${demand.deliverables.slice(0, 3).join('、')}，验证判断是否建立在真实材料与业务约束上。`;
  document.getElementById('demo-risk-copy').textContent = `真实案例、可用档期，以及${demand.inputs}`;
  document.getElementById('demo-acceptance-copy').textContent = demand.acceptance;
  document.getElementById('demo-try-link').href = `./skill-builder.html?role=enterprise&demand=${encodeURIComponent(demand.id)}`;

  if (scrollIntoView) {
    document.getElementById('match-demo').scrollIntoView({
      behavior: reduceMotion.matches ? 'auto' : 'smooth',
      block: 'start',
    });
  }
}

document.getElementById('home-demand-total').textContent = `${enterpriseDemandCatalog.length} 个样例`;
document.getElementById('home-capability-total').textContent = `${capabilityCatalog.length} 项能力`;

renderMatchDemo('ai-pilot-to-production');

function closeNav() {
  nav?.classList.remove('open');
  navToggle?.setAttribute('aria-expanded', 'false');
  navToggle?.setAttribute('aria-label', '打开导航');
  document.body.classList.remove('nav-open');
}

navToggle?.addEventListener('click', () => {
  const open = navToggle.getAttribute('aria-expanded') !== 'true';
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
  nav?.classList.toggle('open', open);
  document.body.classList.toggle('nav-open', open);
});

nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeNav));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && navToggle?.getAttribute('aria-expanded') === 'true') {
    closeNav();
    navToggle.focus();
  }
});
document.addEventListener('click', (event) => {
  const scenarioButton = event.target.closest('[data-demo-scenario]');
  if (scenarioButton) {
    renderMatchDemo(scenarioButton.dataset.demoScenario, !scenarioButton.matches('[role="tab"]'));
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'open-login') {
    closeNav();
    if (typeof loginDialog?.showModal === 'function') loginDialog.showModal();
    return;
  }
  if (action === 'close-login') {
    loginDialog?.close();
    return;
  }
  if (navToggle?.getAttribute('aria-expanded') === 'true' && !event.target.closest('.site-header')) {
    closeNav();
  }
});
loginDialog?.addEventListener('click', (event) => {
  if (event.target === loginDialog) loginDialog.close();
});
window.addEventListener('resize', () => {
  if (window.innerWidth > 860) closeNav();
});
