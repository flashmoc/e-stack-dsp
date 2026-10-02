(() => {
  'use strict';
  const hardware = new URLSearchParams(location.search).get('transport') === 'camillanode';
  const load = source => new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = source; script.onload = resolve; script.onerror = () => reject(new Error(`Unable to load ${source}`)); document.head.append(script);
  });
  document.documentElement.dataset.prototypePage = hardware ? 'input-processing' : 'input-processing-local';
  const start = hardware
    ? load('./live-page.js?v=geq-import-1')
    : load('../../shared/mock-camilladsp.js').then(() => load('./fixtures.js')).then(() => load('./local-page.js'));
  start.catch(error => {
    document.body.innerHTML = `<main class="input-page"><section class="ui-panel"><h1>Input Processing unavailable</h1><p>${error.message}</p></section></main>`;
  });
})();
