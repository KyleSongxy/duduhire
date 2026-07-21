const navToggle = document.getElementById('nav-toggle');
const nav = document.getElementById('main-nav');

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
