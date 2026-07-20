import { capabilityCatalog, enterpriseDemandCatalog } from './data.js';

const navToggle = document.getElementById('nav-toggle');
const nav = document.getElementById('main-nav');
const preview = document.getElementById('capability-preview');
const demandPreview = document.getElementById('demand-preview');

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
  if (navToggle?.getAttribute('aria-expanded') === 'true' && !event.target.closest('.site-header')) {
    closeNav();
  }
});
window.addEventListener('resize', () => {
  if (window.innerWidth > 860) closeNav();
});

if (preview) {
  preview.innerHTML = capabilityCatalog.slice(0, 3).map((item) => `
    <a class="capability-card reveal" href="/skill-builder.html?role=enterprise&capability=${encodeURIComponent(item.id)}">
      <span class="capability-symbol" aria-hidden="true">${item.category}</span>
      <span>
        <h3>${item.name}</h3>
        <p>${item.deliverables.slice(0, 2).join('、')}</p>
      </span>
      <span class="arrow" aria-hidden="true">→</span>
    </a>
  `).join('');
}

if (demandPreview) {
  demandPreview.innerHTML = enterpriseDemandCatalog.slice(0, 4).map((item) => `
    <a class="demand-preview-item" href="/skill-builder.html?role=enterprise&demand=${encodeURIComponent(item.id)}">
      <span>${item.category}</span>
      <strong>${item.title}</strong>
      <p>${item.example}</p>
      <small>${item.deliverables.slice(0, 2).join(' · ')}</small>
    </a>
  `).join('');
}
