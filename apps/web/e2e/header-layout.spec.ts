import { test, expect, authenticate, syntheticEmail } from "./support/fixtures";

for (const role of ["guest", "client", "talent"] as const) {
  test(`${role}：桌面导航以页面居中且不与两侧控件重叠，手机导航保持可用`, async ({ page, environment }, testInfo) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const path = role === "talent" ? "/projects" : "/talent";
    if (role === "guest") {
      await page.goto(path);
      await expect(page.locator(".nav-actions .nav-cta")).toBeVisible();
    } else {
      await authenticate(page, environment, { email: syntheticEmail(`header-${role}`), role, returnTo: path });
      await expect(page.locator(".nav-role-switch")).toContainText(role === "client" ? "当前：需求方" : "当前：能力方");
    }
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
    const measurements = [];
    for (const width of [1440, 1280, 1101, 1100, 921]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(navigation).toBeVisible();
      const layout = await page.locator(".site-header").evaluate((header) => {
        const logo = header.querySelector(".brand-logo")!.getBoundingClientRect();
        const nav = header.querySelector(".desktop-nav")!.getBoundingClientRect();
        const actions = header.querySelector(".nav-actions")!.getBoundingClientRect();
        const viewport = document.documentElement.clientWidth;
        const links = Array.from(header.querySelectorAll(".desktop-nav a"), (link) => link.getBoundingClientRect());
        return {
          viewport,
          centerOffset: (nav.left + nav.right) / 2 - viewport / 2,
          logoGap: nav.left - logo.right,
          actionsGap: actions.left - nav.right,
          actionsRight: actions.right,
          linksOnOneRow: links.every((link) => Math.abs(link.top - links[0].top) < 1),
          overflow: document.documentElement.scrollWidth > viewport,
        };
      });
      measurements.push({ width, ...layout });
      // No-overflow alone misses a whole navigation shifted toward the account
      // controls. Measure its center relative to the page, and both clearances.
      expect(Math.abs(layout.centerOffset), JSON.stringify(layout)).toBeLessThanOrEqual(1);
      expect(layout.logoGap).toBeGreaterThanOrEqual(8);
      expect(layout.actionsGap).toBeGreaterThanOrEqual(8);
      expect(layout.actionsRight).toBeLessThanOrEqual(layout.viewport);
      expect(layout.linksOnOneRow).toBe(true);
      expect(layout.overflow).toBe(false);
      if (role !== "guest") {
        await expect(navigation.getByRole("link", { name: role === "client" ? "梳理用人需求" : "完善能力档案", exact: true })).toBeVisible();
        await expect(navigation.getByRole("link", { name: role === "client" ? "完善能力档案" : "梳理用人需求", exact: true })).toHaveCount(0);
      }
      if (width === 1440 || width === 921) {
        await page.locator(".site-header").screenshot({ path: testInfo.outputPath(`header-${role}-${width}.png`) });
      }
    }
    await testInfo.attach("header-geometry", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(navigation).toBeHidden();
    const menuButton = page.getByRole("button", { name: "打开导航", exact: true });
    await menuButton.click();
    const mobile = page.getByRole("navigation", { name: "移动端导航", exact: true });
    await expect(mobile).toBeVisible();
    for (const [identity, label] of [["client", "梳理用人需求"], ["talent", "完善能力档案"]] as const) {
      const link = mobile.getByRole("link", { name: label, exact: true });
      if (role === "guest" || role === identity) await expect(link).toBeVisible();
      else await expect(link).toHaveCount(0);
    }
    if (role !== "guest") {
      await expect(mobile.getByRole("button", { name: role === "client" ? "切换为能力方" : "切换为需求方", exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`header-${role}-390.png`) });
    await page.keyboard.press("Escape");
    await expect(mobile).toHaveCount(0);
    await expect(menuButton).toBeFocused();
    expect(pageErrors).toEqual([]);
  });
}
