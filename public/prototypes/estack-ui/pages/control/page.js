(() => {
  'use strict';
  const hardware = new URLSearchParams(location.search).get('transport') === 'camillanode';
  const load = source => new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = source; script.onload = resolve; script.onerror = () => reject(new Error(`Unable to load ${source}`)); document.head.append(script);
  });
  document.documentElement.dataset.prototypePage = hardware ? 'control' : 'control-local';
  if (hardware) load('./live-page.js?v=headroom-feedback1').catch(error => { document.body.innerHTML = `<main class="control-page"><section class="ui-panel"><h1>Control unavailable</h1><p>${error.message}</p></section></main>`; });
  else load('../../shared/mock-camilladsp.js?v=control-v47').then(() => load('./fixtures.js?v=control-v47')).then(() => load('./local-page.js?v=compact-links2')).catch(error => console.error(error));
})();
