const { test, expect } = require("@playwright/test");
const { demo, dsp } = require("./batch-helpers");
const fs = require("fs");
test("system capture/apply/startup preserves hardware and mixed records, locks temporary workflows and restores demo", async ({
  page,
  request,
}) => {
  await demo(request);
  const original = await dsp("GetConfigJson"),
    master = await dsp("GetVolume");
  const files = [
    "savedConfigs.dat",
    "startupConfig.json",
    "config/measurement-batch.json",
  ];
  const saved = files.map((file) =>
    fs.existsSync(file) ? fs.readFileSync(file) : null,
  );
  const writes = [];
  page.on("websocket", (ws) =>
    ws.on("framesent", ({ payload }) => {
      if (/SetConfigJson|SetVolume/.test(String(payload))) writes.push(payload);
    }),
  );
  const post = async (url, data = {}) => request.post(url, { data });
  try {
    const records = await request.get("/getConfigFile");
    const all = await records.json();
    const marker = {
      id: "audit-unrelated",
      type: "audit-unrelated",
      name: "Preserve",
      data: { exact: [1, 2, 3] },
    };
    expect(
      (
        await post("/saveConfigFile", { base: all, records: [...all, marker] })
      ).ok(),
    ).toBe(true);
    // A stale complete collection cannot erase a concurrently saved record.
    expect(
      (await post("/saveConfigFile", { base: all, records: all })).status(),
    ).toBe(409);
    await dsp({ SetVolume: -18 });
    await page.goto(
      "/estack-dsp/pages/system-presets/page.html?transport=camillanode",
    );
    page.on("dialog", (dialog) => dialog.accept());
    await expect(page.locator("#capture")).toBeEnabled();
    await page.locator("#name").fill("System release E2E");
    await page.locator("#capture").click();
    await expect(
      page.locator(".preset-row").filter({ hasText: "System release E2E" }),
    ).toBeVisible();
    const row = page
      .locator(".preset-row")
      .filter({ hasText: "System release E2E" });
    const id = await row.getAttribute("data-id");
    await page.evaluate(() => { localStorage.setItem("estack.globalEq.disabled.GLOBAL_EQ_01", "true"); localStorage.setItem("estack.peq.disabled.0.0", "true"); });
    await dsp({ SetVolume: -22 });
    await page.locator('#exportLive').click();
    await expect(page.locator('#exportDialog')).toBeVisible();
    await page.locator('#showExport').click();
    const liveExport = JSON.parse(await page.locator('#exportJson').inputValue());
    expect(liveExport.scope).toBe('live');
    expect(liveExport.config).toEqual(original);
    expect(liveExport.masterVolume).toBe(-22);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#downloadExport').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('estack-live-system.json');
    expect(JSON.parse(fs.readFileSync(await download.path(), 'utf8'))).toEqual(liveExport);
    await page.locator('#closeExport').click();
    await row.locator('[data-action=export]').click();
    await page.locator('#showExport').click();
    const savedExport = JSON.parse(await page.locator('#exportJson').inputValue());
    expect(savedExport.scope).toBe('saved-preset');
    expect(savedExport.id).toBe(id);
    expect(savedExport.masterVolume).toBe(-18);
    expect(savedExport.processing.filters).toEqual(original.filters);
    expect(savedExport.config).toBeUndefined();
    await page.locator('#closeExport').click();
    expect(await dsp('GetConfigJson')).toEqual(original);
    expect(await dsp('GetVolume')).toBe(-22);
    await row.locator("[data-action=apply]").click();
    await expect(page.locator("#dirty")).toHaveText("ACTIVE");
    expect(await dsp("GetVolume")).toBe(-18);
    expect(await page.evaluate(() => localStorage.getItem("estack.globalEq.disabled.GLOBAL_EQ_01"))).toBe("false");
    expect(await page.evaluate(() => localStorage.getItem("estack.peq.disabled.0.0"))).toBe("false");
    const current = await dsp("GetConfigJson");
    expect(current.devices).toEqual(original.devices);
    expect(current.mixers).toEqual(original.mixers);
    expect(current.filters).toEqual(original.filters);
    expect(current.pipeline).toEqual(original.pipeline);
    expect(current.processors).toEqual(original.processors);
    await dsp({ SetVolume: -19 });
    await expect(page.locator("#dirty")).toHaveText("MODIFIED");
    for (const mode of ["specific", "last", "yaml"]) {
      await page.locator("#bootMode").selectOption(mode);
      if (mode === "specific")
        await page.locator("#bootTarget").selectOption(id);
      await page.locator("#saveStartup").click();
      await expect
        .poll(
          async () =>
            (await (await request.get("/api/startup-config")).json()).mode,
        )
        .toBe(mode);
      expect(await dsp("GetConfigJson")).toEqual(current);
      expect(await dsp("GetVolume")).toBe(-19);
    }
    expect((await post("/api/system-presets/delete", { id })).ok()).toBe(false);
    expect(
      (
        await post("/api/test-signal/start", {
          type: "Sine",
          targets: [0],
          freq: 80,
          level: -45,
          duration: 5,
        })
      ).ok(),
    ).toBe(true);
    await expect(page.locator('#exportLive')).toBeDisabled();
    await expect(row.locator('[data-action=export]')).toBeEnabled();
    expect((await post("/api/system-presets/apply", { id })).status()).toBe(
      409,
    );
    expect(
      (
        await post("/api/system-presets/capture", {
          name: "Temporary forbidden",
        })
      ).status(),
    ).toBe(409);
    await post("/api/test-signal/stop");
    expect(
      (
        await post("/api/measurement-batch/import", {
          version: 1,
          name: "System exclusion",
          defaults: { muteUnlisted: true, settleMs: 0 },
          steps: [{ id: "A", name: "Sub", activeWays: ["SUB"], ways: {} }],
        })
      ).ok(),
    ).toBe(true);
    expect((await post("/api/measurement-batch/start")).ok()).toBe(true);
    expect((await post("/api/system-presets/apply", { id })).status()).toBe(
      409,
    );
    expect(
      (
        await post("/api/system-presets/capture", {
          name: "Temporary forbidden",
        })
      ).status(),
    ).toBe(409);
    await post("/api/measurement-batch/abort");
    expect(await dsp("GetConfigJson")).toEqual(current);
    expect(
      (await (await request.get("/getConfigFile")).json()).find(
        (r) => r.id === marker.id,
      ),
    ).toEqual(marker);
    expect(writes).toEqual([]);
  } finally {
    await page.goto("about:blank");
    await post("/api/test-signal/stop");
    await post("/api/measurement-batch/abort");
    await dsp({ SetConfigJson: JSON.stringify(original) });
    await dsp({ SetVolume: master });
    files.forEach((file, i) => {
      if (saved[i]) fs.writeFileSync(file, saved[i]);
      else if (fs.existsSync(file)) fs.unlinkSync(file);
    });
    expect(await dsp("GetConfigJson")).toEqual(original);
    expect(await dsp("GetVolume")).toBe(master);
  }
});
