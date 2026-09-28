const { test, expect } = require('@playwright/test');
const { demo, frame } = require('./batch-helpers');

for (const width of [1440, 390]) test(`independent signal and gain scales at ${width}px`, async ({page, request}) => {
  await demo(request);
  let peak = -12;
  const writes = [];
  // Display fixtures only: no DSP writes. The production transport stays real.
  await page.routeWebSocket('**/ws/dsp', socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const payload = JSON.parse(String(message));
      if (typeof payload === 'object') { writes.push(payload); throw Error('Meter test must not write DSP'); }
      if (payload === 'GetPlaybackSignalPeak') socket.send(JSON.stringify({ GetPlaybackSignalPeak:{result:'Ok',value:Array(8).fill(peak)} }));
      else if (payload === 'GetVolume') socket.send(JSON.stringify({ GetVolume:{result:'Ok',value:-12} }));
      else if (payload === 'GetMute') socket.send(JSON.stringify({ GetMute:{result:'Ok',value:false} }));
      else server.send(message);
    });
    server.onMessage(message => {
      const reply = JSON.parse(String(message));
      if (reply.GetConfigJson?.result === 'Ok') {
        const config = JSON.parse(reply.GetConfigJson.value);
        for (const filter of Object.values(config.filters)) if (filter.type === 'Gain') Object.assign(filter.parameters,{gain:-12,mute:false});
        reply.GetConfigJson.value = JSON.stringify(config);
      }
      socket.send(JSON.stringify(reply));
    });
  });
  await page.setViewportSize({width,height:width===390?844:900});
  const f = await frame(page,'control');
  await expect(f.locator('[data-meter-readout="master"]')).toHaveText('−12.0 dBFS');
  await expect(f.locator('.calibrated-meter')).toHaveCount(7);
  const geometry = () => f.locator('.mixer-strip').evaluateAll(strips => strips.map(strip => {
    const y = el => { const r=el.getBoundingClientRect();return r.top+r.height/2; };
    const dbfs = [...strip.querySelectorAll('.legacy-dbfs-scale span')].find(el => el.textContent === '-12');
    const gain = [...strip.querySelectorAll('.gain-tick')].find(el => el.textContent === '-12');
    const handle = strip.querySelector('.legacy-fader-handle');
    const track = strip.querySelector('.legacy-meter-track').getBoundingClientRect();
    const zero = [...strip.querySelectorAll('.legacy-dbfs-scale span')].find(el => el.textContent === '0');
    return [y(gain)-y(handle),y(dbfs)-strip.querySelector('.legacy-meter-peak').getBoundingClientRect().top,y(zero)-track.top];
  }));
  await expect.poll(async () => (await geometry()).every(values => values.every(v => Math.abs(v)<1.5))).toBe(true);
  await expect(f.locator('[data-fader="master"]')).toHaveAttribute('min','-60');
  await expect(f.locator('.meter-zero')).toHaveCount(0);
  await f.locator('.master-strip').scrollIntoViewIfNeeded();
  await page.screenshot({path:`test-results/control-meter-${width}.png`});
  peak = 0;
  await expect(f.locator('[data-meter-readout="master"]')).toHaveText('0.0 dBFS');
  await expect(f.locator('[data-meter-readout="0"]')).toHaveText('0.0 dBFS');
  expect(await f.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes).toEqual([]);
});
