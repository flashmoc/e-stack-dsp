const { test, expect } = require('@playwright/test');
const { demo } = require('./batch-helpers');

const pages = [
  'input-processing', 'control', 'output-processing', 'loudness',
  'system-presets', 'signal-generator', 'measurement-batch',
  'advanced', 'connections', 'preferences',
];

test('product workspaces share the Input page alignment without mobile overflow', async ({ page, request }) => {
  await demo(request);
  // 2133 CSS pixels approximate a 1920px window at 90% browser zoom.
  for (const width of [1920, 2133, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    let inputLeft;
    for (const name of pages) {
      await page.goto(`/estack-dsp/?transport=camillanode#${name}`);
      const main = page.frameLocator('iframe').locator('main');
      await expect(main.locator('h1')).toBeVisible();
      const layout = await main.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          width: rect.width,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      if (name === 'input-processing') inputLeft = layout.left;
      else if (inputLeft !== undefined) expect(layout.left).toBeCloseTo(inputLeft, 0);
      expect(layout.width).toBeLessThanOrEqual(1800);
      expect(layout.overflow, `${name} at ${width}px`).toBe(false);
    }
  }
});
