(() => {
  'use strict';
  const links = [...document.querySelectorAll('[data-page]')];
  const frame = document.querySelector('#pageFrame');
  const live = new URLSearchParams(location.search).get('transport') === 'camillanode';
  document.documentElement.dataset.transport = live ? 'live' : 'preview';
  const mobileNav = document.createElement('div');
  mobileNav.className = 'shell-mobile-nav';
  mobileNav.innerHTML = '<label for="mobilePageSelect">PAGE</label><select id="mobilePageSelect" aria-label="Choose workspace"></select>';
  document.querySelector('.shell-nav').before(mobileNav);
  const select = mobileNav.querySelector('select');
  const mobileGuiLink = document.createElement('a');
  mobileGuiLink.className = 'shell-gui-link';
  mobileGuiLink.dataset.camillagui = '';
  mobileGuiLink.hidden = true;
  mobileGuiLink.target = '_blank';
  mobileGuiLink.rel = 'noopener noreferrer';
  mobileGuiLink.setAttribute('aria-label', 'Open CamillaGUI in a new tab');
  mobileGuiLink.textContent = 'CamillaGUI ↗';
  mobileNav.append(mobileGuiLink);
  const groups = new Map();
  for (const link of links) {
    const label = link.dataset.group;
    if (!groups.has(label)) { const group = document.createElement('optgroup'); group.label = label; groups.set(label, group); select.append(group); }
    groups.get(label).append(new Option(link.textContent, link.dataset.page));
  }
  const routes = Object.fromEntries(links.map(link => {
    const url = new URL(link.href);
    url.searchParams.set('v', 'software-release1');
    if (live) url.searchParams.set('transport', 'camillanode');
    return [link.dataset.page, url.href];
  }));
  let selected = null, resize = 0;
  function choose(name) {
    const route = routes[name] ? name : 'control';
    if (selected !== route) {
      selected = route; frame.src = routes[route];
      frame.title = `${links.find(link => link.dataset.page === route).textContent} — E-Stack DSP`;
    }
    links.forEach(link => link.setAttribute('aria-current', link.dataset.page === route ? 'page' : 'false'));
    select.value = route; history.replaceState(null, '', `#${route}`);
  }
  function refreshFrameLayout() {
    cancelAnimationFrame(resize);
    resize = requestAnimationFrame(() => {
      const width = Math.floor(frame.parentElement.getBoundingClientRect().width);
      if (width > 0) frame.style.width = `${width}px`;
      frame.contentWindow?.dispatchEvent(new Event('resize'));
    });
  }
  new ResizeObserver(refreshFrameLayout).observe(frame);
  frame.addEventListener('load', refreshFrameLayout);
  addEventListener('resize', refreshFrameLayout);
  links.forEach(link => link.addEventListener('click', event => { event.preventDefault(); choose(link.dataset.page); }));
  select.addEventListener('change', () => choose(select.value));
  addEventListener('hashchange', () => choose(location.hash.slice(1)));
  addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'estack-navigate' && routes[event.data.page]) choose(event.data.page);
  });
  if (!live) {
    document.querySelector('.environment-banner').hidden = false;
    const script = document.createElement('script'); script.src = './shared/preview-shell.js'; document.head.append(script);
  }
  if (live) {
    window.EStackDSPBridge.api('/api/runtime').then(runtime => {
      let target = null;
      if (typeof runtime.camillaGuiProxy === 'string' && runtime.camillaGuiProxy.startsWith('/camillagui/')) {
        target = new URL(runtime.camillaGuiProxy, location.origin);
      } else if (runtime.mode === 'hardware') {
        target = new URL(location.href);
        target.protocol = 'http:';
        target.port = '5005';
        target.pathname = '/gui/index.html';
        target.search = '';
        target.hash = '';
      }
      if (!target) return;
      document.querySelectorAll('[data-camillagui]').forEach(link => {
        link.href = target.href;
        link.hidden = false;
      });
    }).catch(() => {});
  }
  choose(location.hash.slice(1));
})();
