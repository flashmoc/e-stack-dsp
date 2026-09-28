(() => {
  'use strict';
  const live = new URLSearchParams(location.search).get('transport') === 'camillanode';
  document.documentElement.dataset.prototypePage = live ? 'output-processing' : 'output-processing-local';
  if (!live) {
    document.body.innerHTML = '<main class="output-page"><section class="ui-panel output-unavailable"><h1>Output Processing requires CamillaNode mode</h1><p>Open the product with <code>?transport=camillanode#output-processing</code>. The standalone per-way prototype remains a mock-only design reference.</p></section></main>';
    return;
  }
  const script = document.createElement('script'); script.src = './live-page.js?v=output-layout2'; script.onerror = () => { document.body.innerHTML = '<main class="output-page"><section class="ui-panel output-unavailable"><h1>Output Processing unavailable</h1><p>The live DSP page could not start.</p></section></main>'; }; document.head.append(script);
})();
