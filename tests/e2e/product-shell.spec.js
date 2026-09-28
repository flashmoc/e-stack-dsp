const { test, expect } = require("@playwright/test");
const { demo } = require("./batch-helpers");
const routes = [
  "control",
  "input-processing",
  "output-processing",
  "loudness",
  "system-presets",
  "signal-generator",
  "measurement-batch",
  "advanced",
  "connections",
  "preferences",
];
for (const width of [390, 1440])
  test(`finished product navigation and live health at ${width}px`, async ({
    page,
    request,
  }) => {
    await demo(request);
    await page.setViewportSize({ width, height: 900 });
    const requests = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto("/estack-dsp/?transport=camillanode");
    await expect(page).toHaveTitle("E-Stack DSP");
    await expect(page.locator(".shell-nav")).not.toContainText(
      /Design System|Prototype|MOCK/i,
    );
    await expect(page.locator(".environment-banner")).toBeHidden();
    const guiLink = page.locator(width === 390 ? '.shell-mobile-nav [data-camillagui]' : '.shell-nav [data-camillagui]');
    await expect(guiLink).toBeVisible();
    await expect(guiLink).toHaveAttribute('href', `${new URL('/camillagui/gui/index.html', page.url()).href}`);
    await expect(guiLink).toHaveAttribute('target', '_blank');
    await page.screenshot({path:`test-results/product-shell-gui-${width}.png`});
    const [guiPage] = await Promise.all([page.waitForEvent('popup'), guiLink.click()]);
    await guiPage.waitForLoadState('domcontentloaded');
    expect(guiPage.url()).toContain('/camillagui/gui/index.html');
    await guiPage.close();
    const shell = await page.locator(".shell-health").elementHandle();
    for (const route of routes) {
      if (width === 390)
        await page.locator("#mobilePageSelect").selectOption(route);
      else await page.locator(`[data-page="${route}"]`).click();
      await expect
        .poll(() =>
          page
            .frames()
            .some(
              (f) =>
                f.url().includes(`/pages/${route}/page.html`) &&
                f.url().includes("transport=camillanode"),
            ),
        )
        .toBe(true);
      const f = page
        .frames()
        .find((f) => f.url().includes(`/pages/${route}/page.html`));
      await f.waitForLoadState();
      expect(await f.evaluate(() => typeof EStackPrototypeDSP)).toBe(
        "undefined",
      );
      expect(await f.locator("body").innerText()).not.toMatch(
        /MOCK-ONLY|LOCAL SIMULATION|LOCAL MODEL|PROTOTYPE/i,
      );
      await expect(page.locator("[data-shell-load]")).toHaveText(/\d+\.\d %/);
      expect(await shell.evaluate((el) => el.isConnected)).toBe(true);
    }
    expect(
      requests.filter((url) =>
        /mock-camilladsp|\/fixtures\.|preview-shell/.test(url),
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
  });
