const { test, expect } = require('@playwright/test');
const { demo, dsp, frame } = require('./batch-helpers');

test('Preferences estimates live chunks and applies only a confirmed chunk edit', async ({ page, request }) => {
  await demo(request);
  const original = await dsp('GetConfigJson');
  const originalMaster = await dsp('GetVolume');
  await dsp({ SetVolume: -18 });
  const master = -18;
  try {
    const preferences = await frame(page, 'preferences');
    const state = await request.get('/api/chunk-size').then(response => response.json());
    await expect(preferences.locator('#chunkSizeCurrent')).toHaveText(`${original.devices.chunksize} samples`);
    expect(state.currentChunkMs).toBeCloseTo(original.devices.chunksize * 1000 / original.devices.samplerate, 1);
    const target = state.options.find(option => option.size !== original.devices.chunksize);
    expect(target).toBeTruthy();
    await preferences.locator('#chunkSizeChoice').selectOption(String(target.size));
    await expect(preferences.locator('#chunkSizeEstimate')).toHaveText(`${target.chunkMs} ms`);
    expect(await dsp('GetConfigJson')).toEqual(original);
    page.once('dialog', dialog => dialog.dismiss());
    await preferences.locator('#chunkSizeApply').click();
    expect(await dsp('GetConfigJson')).toEqual(original);
    page.once('dialog', dialog => dialog.accept());
    await preferences.locator('#chunkSizeApply').click();
    await expect(preferences.locator('#chunkSizeCurrent')).toHaveText(`${target.size} samples`);
    const changed = await dsp('GetConfigJson');
    expect(changed).toEqual({ ...original, devices: { ...original.devices, chunksize: target.size } });
    await expect.poll(() => dsp('GetVolume')).toBe(master);
    await expect(preferences.locator('#chunkSizeState')).toHaveText('Live · session only');
  } finally {
    const current = await dsp('GetConfigJson');
    if (JSON.stringify(current) !== JSON.stringify(original)) await dsp({ SetConfigJson: JSON.stringify(original) });
    if (await dsp('GetVolume') !== originalMaster) await dsp({ SetVolume: originalMaster });
  }
});
