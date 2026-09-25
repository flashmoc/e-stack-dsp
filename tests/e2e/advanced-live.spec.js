const { test, expect } = require("@playwright/test");
const { demo, dsp, frame } = require("./batch-helpers");
test("Advanced inspects actual topology without DSP writes at phone width", async ({
  page,
  request,
}) => {
  await demo(request);
  await page.setViewportSize({ width: 390, height: 844 });
  const config = await dsp("GetConfigJson"),
    writes = [];
  page.on("websocket", (ws) =>
    ws.on("framesent", ({ payload }) => {
      if (/SetConfigJson|SetVolume/.test(String(payload))) writes.push(payload);
    }),
  );
  const f = await frame(page, "advanced");
  await expect(f.locator("#state")).toContainText("Live");
  expect(await f.evaluate(() => typeof EStackPrototypeDSP)).toBe("undefined");
  await expect(f.locator("#devices")).toContainText(
    config.devices.capture.type,
  );
  await expect(f.locator("#devices")).toContainText(
    config.devices.playback.device ||
      config.devices.playback.filename ||
      "runtime source",
  );
  await expect(f.locator("#pipeline>li")).toHaveCount(config.pipeline.length);
  for (const kind of ["mixers", "filters", "processors"])
    for (const name of Object.keys(config[kind] || {}))
      await expect(f.locator("#definitions")).toContainText(name);
  await f.locator(".inspector > summary").click();
  await f.locator("#pipeline summary").first().click();
  await f.locator("#refresh").click();
  await expect(f.locator("#pipeline details").first()).toHaveAttribute(
    "open",
    "",
  );
  await expect(f.locator("#raw")).toHaveText(JSON.stringify(config, null, 2));
  expect(
    await f.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(writes).toEqual([]);
  expect(await dsp("GetConfigJson")).toEqual(config);
});
