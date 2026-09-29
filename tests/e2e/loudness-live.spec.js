const { test, expect } = require('@playwright/test');
const { demo, dsp, frame } = require('./batch-helpers');
const fs = require('fs');
const model = require('../../server/loudnessPresetModel');

test('loudness displays live compensation and keeps server preset mutations scoped', async ({ page, request }) => {
  await demo(request);
  const original = await dsp('GetConfigJson');
  await request.get('/api/loudness/settings');
  const settings = fs.readFileSync('wiimLoudnessConfig.json');
  let factor = 0.25;
  let bridgeConnected = true;
  await page.route('**/api/loudness/bridge', route => route.fulfill({
    json: {
      status: 'ok',
      serviceAlive: bridgeConnected,
      connected: bridgeConnected,
      wiimConnected: bridgeConnected,
      camillaConnected: bridgeConnected,
      compensationFactor: factor,
      state: bridgeConnected ? 'connected' : 'offline'
    }
  }));

  try {
    const f = await frame(page, 'loudness');
    await expect(f.locator('#toggle')).toBeEnabled();
    expect(await f.evaluate(() => typeof EStackPrototypeDSP)).toBe('undefined');

    await f.locator('[data-preset=home]').click();
    await expect(f.locator('#presetName')).toHaveText('HOME');
    await expect(f.locator('#responseStatus')).toHaveText('Current · 25% of maximum');
    const maxPath = await f.locator('#responseMaximum').getAttribute('d');
    const quarterPath = await f.locator('#responseCurrent').getAttribute('d');
    expect(maxPath).toBeTruthy();
    expect(quarterPath).toBeTruthy();
    expect(quarterPath).not.toBe(maxPath);
    model.assertOnlyLoudnessChanged(original, await dsp('GetConfigJson'));

    factor = 1;
    await expect(f.locator('#responseStatus')).toHaveText('Current · 100% of maximum');
    await expect(f.locator('#responseCurrent')).toHaveAttribute('d', maxPath);
    bridgeConnected = false;
    await expect(f.locator('#responseStatus')).toContainText('unavailable');
    await expect(f.locator('#responseCurrent')).not.toHaveAttribute('d');

    await f.locator('#toggle').click();
    await expect(f.locator('#toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(f.locator('#responseStatus')).toHaveText('Loudness off · flat response');
    model.assertOnlyLoudnessChanged(original, await dsp('GetConfigJson'));

    await f.locator('#toggle').click();
    await expect(f.locator('#toggle')).toHaveAttribute('aria-pressed', 'true');
    model.assertOnlyLoudnessChanged(original, await dsp('GetConfigJson'));
    await f.locator('#startDb').fill('-12');
    await f.locator('#saveCurve').click();
    await expect.poll(async () =>
      (await (await request.get('/api/loudness/settings')).json()).curve.startDb
    ).toBe(-12);
    await expect(f.locator('#startDb')).toHaveValue('-12');
  } finally {
    await dsp({ SetConfigJson: JSON.stringify(original) });
    fs.writeFileSync('wiimLoudnessConfig.json', settings);
    expect(await dsp('GetConfigJson')).toEqual(original);
  }
});
