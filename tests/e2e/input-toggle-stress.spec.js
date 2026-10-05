const { test, expect } = require('@playwright/test');
const { demo, dsp } = require('./batch-helpers');
const state = require('../../public/prototypes/estack-ui/shared/domain/input-eq-state');

test('repeated input GEQ and PEQ switches preserve configuration and Master', async ({ page, request }) => {
  test.setTimeout(120000);
  await demo(request);
  const original = await dsp('GetConfigJson');
  const volume = await dsp('GetVolume');
  try {
    await page.goto('/estack-dsp/?transport=camillanode#input-processing');
    await expect.poll(() => page.frames().some(frame => frame.url().includes('/input-processing/page.html'))).toBe(true);
    const frame = page.frames().find(item => item.url().includes('/input-processing/page.html'));
    await expect(frame.locator('#inputState')).toHaveText('EQ synchronized');
    await frame.evaluate(async () => {
      await EStackInputProcessingService.setGraphicEq([3, 2, 1, 0, -1, -2, -1, 0, 1, 2], true);
      await EStackInputProcessingService.setBand('GLOBAL_EQ_01', { gain: 2 });
    });
    for (let index = 0; index < 50; index++) {
      const processor = index % 2 ? 'peq' : 'geq';
      const before = await dsp('GetConfigJson');
      const enabled = state.read(before)[processor].enabled;
      await frame.evaluate(async ({ processor, enabled }) => {
        await EStackInputProcessingService.setProcessorEnabled(processor, !enabled);
      }, { processor, enabled });
      const after = await dsp('GetConfigJson');
      expect(state.read(after)[processor].enabled).toBe(!enabled);
      expect(after.devices).toEqual(original.devices);
      expect(after.mixers).toEqual(original.mixers);
      expect(await dsp('GetVolume')).toBe(volume);
    }
  } finally {
    await dsp({ SetConfigJson: JSON.stringify(original) });
    await dsp({ SetVolume: volume });
    expect(await dsp('GetConfigJson')).toEqual(original);
  }
});
