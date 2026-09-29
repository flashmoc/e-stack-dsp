const { test, expect } = require('@playwright/test');
const { demo, dsp, frame } = require('./batch-helpers');

test('browser appearance and default page affect the live product without DSP writes', async ({ page, request }) => {
  await demo(request);
  const original = await dsp('GetConfigJson');
  const preferences = await frame(page, 'preferences');
  expect(await preferences.evaluate(() => typeof EStackPrototypeDSP)).toBe('undefined');

  await preferences.locator('[data-choice="background"][data-value="midnight"]').click();
  await preferences.locator('[data-choice="accent"][data-value="amber"]').click();
  await preferences.locator('#corners').selectOption('crisp');
  await preferences.locator('#density').selectOption('compact');
  await preferences.locator('#contrast').selectOption('high');
  await preferences.locator('#homePage').selectOption('advanced');

  await expect(page.locator('html')).toHaveAttribute('data-background', 'midnight');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(10, 18, 32)');
  await expect(preferences.locator('html')).toHaveAttribute('data-accent', 'amber');
  await expect(preferences.locator('section').first()).toHaveCSS('border-radius', '2px');
  await expect(preferences.locator('[data-choice="background"][data-value="midnight"]')).toHaveAttribute('aria-pressed', 'true');

  await expect(preferences.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(preferences.locator('body')).toHaveCSS('background-color', 'rgb(10, 18, 32)');
  await expect(preferences.locator('.product-surface')).toHaveCSS('padding', '16px');
  await expect(preferences.locator('#connectionsPanel')).toHaveCSS('border-top-color', 'rgb(129, 157, 163)');
  const output = await frame(page, 'output-processing');
  await expect(output.locator('body')).toHaveCSS('background-color', 'rgb(10, 18, 32)');
  const control = await frame(page, 'control');
  await expect(control.locator('body')).toHaveCSS('background-color', 'rgb(10, 18, 32)');

  await page.goto('/estack-dsp/?transport=camillanode');
  await expect(page).toHaveURL(/#advanced$/);
  await expect(page.locator('[data-page="advanced"]')).toHaveAttribute('aria-current', 'page');
  await page.goto('/estack-dsp/?transport=camillanode#control');
  await expect(page.locator('[data-page="control"]')).toHaveAttribute('aria-current', 'page');

  const resetPage = await frame(page, 'preferences');
  await expect(resetPage.locator('#homePage')).toHaveValue('advanced');
  await resetPage.locator('#reset').click();
  await expect(resetPage.locator('#density')).toHaveValue('comfortable');
  await expect(resetPage.locator('#contrast')).toHaveValue('standard');
  await expect(resetPage.locator('#homePage')).toHaveValue('control');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(12, 23, 25)');
  expect(await dsp('GetConfigJson')).toEqual(original);
});

test('phone preferences stay touchable and choose the default workspace', async ({ page, request }) => {
  await demo(request);
  await page.setViewportSize({ width: 390, height: 844 });
  const preferences = await frame(page, 'preferences');
  await preferences.locator('[data-choice="background"][data-value="warm"]').click();
  await preferences.locator('[data-choice="accent"][data-value="violet"]').click();
  await preferences.locator('#homePage').selectOption('signal-generator');
  const layout = await preferences.evaluate(() => ({
    width: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    touch: document.querySelector('[data-choice="background"]').getBoundingClientRect().height,
  }));
  expect(layout.content).toBeLessThanOrEqual(layout.width);
  expect(layout.touch).toBeGreaterThanOrEqual(44);
  await page.goto('/estack-dsp/?transport=camillanode');
  await expect(page).toHaveURL(/#signal-generator$/);
  await expect(page.locator('#mobilePageSelect')).toHaveValue('signal-generator');
});

test('stored Connections default opens Preferences after navigation consolidation', async ({ page, request }) => {
  await demo(request);
  await page.goto('/estack-dsp/?transport=camillanode#control');
  await page.evaluate(() => localStorage.setItem('estack.product.presentation', JSON.stringify({ homePage: 'connections' })));
  await page.goto('/estack-dsp/?transport=camillanode');
  await expect(page).toHaveURL(/#preferences$/);
  await expect(page.frameLocator('#pageFrame').locator('#homePage')).toHaveValue('preferences');
  await expect(page.frameLocator('#pageFrame').locator('#connectionsPanel')).toBeVisible();
});
