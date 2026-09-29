const { test, expect } = require('@playwright/test');
const { demo, dsp, frame } = require('./batch-helpers');

test('Preferences Connections section reports live devices without writes', async ({ page, request }) => {
  await demo(request);
  const original = await dsp('GetConfigJson');
  const writes = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    if (/SetConfig|SetVolume|SetMute/.test(String(payload))) writes.push(payload);
  }));
  const preferences = await frame(page, 'preferences');
  const connections = preferences.locator('#connectionsPanel');
  await expect(connections.locator('#dsp')).toHaveText('Connected');
  await expect(connections.locator('#captureType')).toHaveText(original.devices.capture.type);
  await expect(connections.locator('#captureChannels')).toHaveText(String(original.devices.capture.channels));
  await expect(connections.locator('#spectrum')).not.toHaveText('—');
  expect(await preferences.evaluate(() => typeof EStackPrototypeDSP)).toBe('undefined');
  await connections.locator('#connectionRefresh').click();
  await expect(connections.locator('#connectionRefresh')).toBeEnabled();
  expect(await dsp('GetConfigJson')).toEqual(original);
  expect(writes).toEqual([]);
});
