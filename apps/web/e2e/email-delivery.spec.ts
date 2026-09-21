import { test, expect, syntheticEmail } from "./support/fixtures";

for (const mode of ["signup", "login"] as const) {
  test(`${mode}：开发演练不冒充邮件发送，并保留重试冷却`, async ({ page }) => {
    // This suite isolates delivery feedback; eligibility is covered separately.
    await page.route("**/api/v1/auth/login-eligibility", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ registered: true }),
    }));
    let requests = 0;
    await page.route("**/api/v1/auth/email/challenges", async (route) => {
      requests += 1;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true, delivery: "development", expiresInSeconds: 3, resendAfterSeconds: 2 }),
      });
    });
    await page.goto(`/${mode}?method=email`);
    await page.clock.install();
    const email = page.getByLabel("邮箱", { exact: false });
    await email.fill(syntheticEmail(`delivery-${mode}`));
    await page.getByRole("button", { name: mode === "signup" ? "创建账户" : "登录", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("当前为开发演练，未发送真实验证邮件。请联系管理员启用邮件发送服务后再试。");
    await expect(email).toHaveAttribute("aria-describedby", "auth-email-development");
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "稍后重试", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "请检查邮箱", exact: true })).toHaveCount(0);
    await expect(page.locator('a[href*="/auth/verify"]')).toHaveCount(0);
    await page.clock.fastForward(2_100);
    await expect(page.getByRole("button", { name: "重试", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByRole("button", { name: "稍后重试", exact: true })).toBeDisabled();
    expect(requests).toBe(2);
    await page.clock.fastForward(3_100);
    await expect(page.getByRole("alert")).toContainText("未发送真实验证邮件");
    await expect(page.getByRole("alert")).not.toContainText("已过期");
    await email.fill(syntheticEmail("delivery-changed"));
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: mode === "signup" ? "创建账户" : "登录", exact: true })).toBeEnabled();
  });
}

test("启用邮件发送后，开发提示切换为真实发送状态", async ({ page }) => {
  let delivery: "development" | "email" = "development";
  await page.route("**/api/v1/auth/email/challenges", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ accepted: true, delivery, expiresInSeconds: 900, resendAfterSeconds: 2 }),
    });
  });
  await page.goto("/signup");
  await page.clock.install();
  const email = syntheticEmail("delivery-enabled");
  await page.getByLabel("邮箱", { exact: false }).fill(email);
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("未发送真实验证邮件");
  delivery = "email";
  await page.clock.fastForward(2_100);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(`验证邮件已发送至 ${email}`);
  await expect(page.getByRole("status")).toContainText("15 分钟");
  await expect(page.getByRole("button", { name: "请检查邮箱", exact: true })).toBeDisabled();
  await page.clock.fastForward(2_100);
  await expect(page.getByRole("button", { name: "重新发送", exact: true })).toBeEnabled();
});

test("缺失投递类型的成功响应不得显示邮件已发送", async ({ page }) => {
  await page.route("**/api/v1/auth/email/challenges", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ accepted: true, expiresInSeconds: 900, resendAfterSeconds: 30 }),
    });
  });
  await page.goto("/signup");
  await page.getByLabel("邮箱", { exact: false }).fill(syntheticEmail("delivery-invalid"));
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("暂时无法确认邮件发送状态，请稍后重试。");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "创建账户", exact: true })).toBeEnabled();
});

test("邮件重发失败清除旧成功状态，旧过期计时不覆盖本次错误", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/v1/auth/email/challenges", async (route) => {
    requests += 1;
    await route.fulfill({
      status: requests === 1 ? 202 : 503,
      contentType: "application/json",
      body: JSON.stringify(requests === 1
        ? { accepted: true, delivery: "email", expiresInSeconds: 10, resendAfterSeconds: 2 }
        : { error: { code: "EMAIL_UNAVAILABLE", message: "邮件发送服务暂时不可用，请稍后重试。" } }),
    });
  });
  await page.goto("/signup");
  await page.clock.install();
  const email = syntheticEmail("delivery-resend-failed");
  await page.getByLabel("邮箱", { exact: false }).fill(email);
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(`验证邮件已发送至 ${email}`);
  await expect(page.getByRole("button", { name: "请检查邮箱", exact: true })).toBeDisabled();
  await page.clock.fastForward(2_100);
  await page.getByRole("button", { name: "重新发送", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("邮件发送服务暂时不可用，请稍后重试。");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "请检查邮箱", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "创建账户", exact: true })).toBeEnabled();
  expect(requests).toBe(2);
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("alert")).toHaveText("邮件发送服务暂时不可用，请稍后重试。");
  await expect(page.getByRole("status")).toHaveCount(0);
});
