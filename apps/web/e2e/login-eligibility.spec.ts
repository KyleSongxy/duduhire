import { test, expect, type Page } from "@playwright/test";

// All API requests are intercepted. These synthetic identities never reach a
// mail sender, SMS provider, or the user's local account database.
const methods = [
  { method: "email", account: "e2e-registered@example.test", unknown: "e2e-unknown@example.test", input: "#auth-email", send: "登录", signupSend: "创建账户", label: "邮箱" },
  { method: "phone", account: "13900000001", unknown: "13900000002", input: "#auth-phone", send: "发送验证码", signupSend: "发送验证码", label: "手机号" },
] as const;
type Method = typeof methods[number]["method"];
type Check = { method: Method; account: string };

async function mockEligibilityService(page: Page) {
  const service = {
    checks: [] as Check[],
    completedChecks: [] as Check[],
    challenges: [] as Array<{ method: Method; body: Record<string, unknown> }>,
    registered: new Set<string>(methods.map(({ account }) => account)),
    lookupFailure: false,
    invalidAccounts: new Map<string, { code: string; message: string }>(),
    rejectChallenge: false,
    gates: new Map<string, Promise<void>>(),
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/auth/session") return json({ session: null });
    if (path === "/auth/methods") return json({ email: { available: true, delivery: "email" }, phone: { available: true, region: "CN" } });
    if (path === "/auth/login-eligibility") {
      const body = route.request().postDataJSON() as Check;
      service.checks.push(body);
      const registered = service.registered.has(body.account);
      const failure = service.lookupFailure;
      const invalid = service.invalidAccounts.get(body.account);
      const gate = service.gates.get(body.account);
      if (gate) await gate;
      if (invalid) await json({ error: invalid }, 400);
      else if (failure) await json({ error: { code: "LOOKUP_UNAVAILABLE", message: "模拟账号检查暂时不可用。" } }, 503);
      else await json({ registered });
      service.completedChecks.push(body);
      return;
    }
    if (path === "/auth/email/challenges" || path === "/auth/phone/challenges") {
      const method = path.includes("/email/") ? "email" : "phone";
      service.challenges.push({ method, body: route.request().postDataJSON() as Record<string, unknown> });
      if (service.rejectChallenge) return json({ error: { code: "ACCOUNT_NOT_REGISTERED", message: `该${method === "email" ? "邮箱" : "手机号"}尚未注册，请先注册账户。` } }, 409);
      return json(method === "email"
        ? { accepted: true, delivery: "email", expiresInSeconds: 900, resendAfterSeconds: 60 }
        : { accepted: true, delivery: "sms", challengeId: "eligibility-phone-challenge", expiresInSeconds: 300, resendAfterSeconds: 60 }, 202);
    }
    return json({ error: { code: "UNEXPECTED_MOCK_ENDPOINT", message: `测试未配置此接口：${path}` } }, 501);
  });
  return service;
}

for (const entry of methods) {
  test(`${entry.label}登录：未注册账号不允许发送，注册入口保留方式和返回位置`, async ({ page }) => {
    const service = await mockEligibilityService(page);
    await page.goto(`/login?method=${entry.method}&returnTo=%2Fprojects%3Fsource%3Deligibility`);
    const send = page.getByRole("button", { name: entry.send, exact: true });
    await expect(send).toBeDisabled();
    await page.locator(entry.input).fill(entry.unknown);
    await expect(page.getByText(`该${entry.label}尚未注册，请先注册账户。`, { exact: true })).toBeVisible();
    await expect(send).toBeDisabled();
    // Submitting with Enter or a scripted form submission must obey the same gate.
    await page.locator(".auth-panel form").dispatchEvent("submit");
    expect(service.challenges).toEqual([]);
    expect(service.checks).toEqual([{ method: entry.method, account: entry.unknown }]);
    await page.getByRole("link", { name: "去注册", exact: true }).click();
    await expect(page).toHaveURL(/\/signup\?/u);
    const url = new URL(page.url());
    expect(url.searchParams.get("method") || "email").toBe(entry.method);
    expect(url.searchParams.get("returnTo")).toBe("/projects?source=eligibility");
    expect(url.href).not.toContain(entry.unknown);
  });

  test(`${entry.label}登录：仅在确认已注册后发送，改账号立即取消之前的许可`, async ({ page }) => {
    const service = await mockEligibilityService(page);
    await page.goto(`/login?method=${entry.method}`);
    const send = page.getByRole("button", { name: entry.send, exact: true });
    await page.locator(entry.input).fill(entry.account);
    await expect(send).toBeEnabled();
    await page.locator(entry.input).fill(entry.unknown);
    await expect(send).toBeDisabled();
    await page.locator(".auth-panel form").dispatchEvent("submit");
    await expect(page.getByText(`该${entry.label}尚未注册，请先注册账户。`, { exact: true })).toBeVisible();
    expect(service.challenges).toEqual([]);
    await page.locator(entry.input).fill(entry.account);
    await send.click();
    await expect(page.getByRole("status")).toContainText(entry.method === "email" ? "验证邮件已发送" : "验证码已申请发送");
    expect(service.challenges).toEqual([{ method: entry.method, body: {
      [entry.method === "email" ? "email" : "phone"]: entry.account,
      intent: "login", returnTo: "/workspace",
    } }]);
  });

  test(`${entry.label}登录：旧账号较晚返回的已注册结果不能解锁新账号`, async ({ page }) => {
    const service = await mockEligibilityService(page);
    let release!: () => void;
    service.gates.set(entry.account, new Promise<void>((resolve) => { release = resolve; }));
    await page.goto(`/login?method=${entry.method}`);
    await page.locator(entry.input).fill(entry.account);
    await expect.poll(() => service.checks.length).toBe(1);
    await expect(page.getByRole("button", { name: entry.send, exact: true })).toBeDisabled();
    await page.locator(entry.input).fill(entry.unknown);
    await expect(page.getByText(`该${entry.label}尚未注册，请先注册账户。`, { exact: true })).toBeVisible();
    release();
    await expect.poll(() => service.completedChecks.length).toBe(2);
    await expect(page.getByRole("button", { name: entry.send, exact: true })).toBeDisabled();
    await expect(page.getByText(`该${entry.label}尚未注册，请先注册账户。`, { exact: true })).toBeVisible();
    expect(service.challenges).toEqual([]);
  });

  test(`${entry.label}登录：查询失败继续禁发，明确重试通过后才解锁`, async ({ page }) => {
    const service = await mockEligibilityService(page);
    service.lookupFailure = true;
    await page.goto(`/login?method=${entry.method}`);
    await page.locator(entry.input).fill(entry.account);
    const retry = page.getByRole("button", { name: "重新检查账号", exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByRole("button", { name: entry.send, exact: true })).toBeDisabled();
    await page.locator(".auth-panel form").dispatchEvent("submit");
    expect(service.challenges).toEqual([]);
    service.lookupFailure = false;
    await retry.click();
    await expect(page.getByRole("button", { name: entry.send, exact: true })).toBeEnabled();
    expect(service.checks).toHaveLength(2);
  });

  test(`${entry.label}登录：查询返回格式错误时提示修改输入，不提供网络重试`, async ({ page }) => {
    const service = await mockEligibilityService(page);
    const invalidAccount = entry.method === "email" ? "a..b@example.test" : entry.unknown;
    const message = entry.method === "email" ? "请输入有效的邮箱地址。" : "请输入有效的中国大陆手机号。";
    service.invalidAccounts.set(invalidAccount, {
      code: entry.method === "email" ? "INVALID_EMAIL" : "INVALID_PHONE", message,
    });
    await page.goto(`/login?method=${entry.method}`);
    const input = page.locator(entry.input);
    await input.fill(invalidAccount);
    await expect(page.getByRole("alert")).toHaveText(message);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAttribute("aria-describedby", `auth-${entry.method}-error`);
    await expect(page.getByRole("button", { name: entry.send, exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "重新检查账号", exact: true })).toHaveCount(0);
    await expect(page.getByText("暂时无法确认账号是否已注册，请重新检查。", { exact: true })).toHaveCount(0);
    await page.getByRole("heading", { name: "工作台已准备就绪", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(message);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    expect(service.challenges).toEqual([]);
    await input.fill(entry.account);
    await expect(page.getByRole("button", { name: entry.send, exact: true })).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(input).toHaveAttribute("aria-invalid", "false");
    await page.getByRole("button", { name: entry.send, exact: true }).click();
    await expect(page.getByRole("status")).toContainText(entry.method === "email" ? "验证邮件已发送" : "验证码已申请发送");
    expect(service.checks).toHaveLength(2);
    expect(service.challenges).toHaveLength(1);
  });

  test(`${entry.label}登录：预检查后账户失效，发送接口拒绝后恢复未注册提示`, async ({ page }) => {
    const service = await mockEligibilityService(page);
    await page.goto(`/login?method=${entry.method}`);
    await page.locator(entry.input).fill(entry.account);
    const send = page.getByRole("button", { name: entry.send, exact: true });
    await expect(send).toBeEnabled();
    service.rejectChallenge = true;
    await send.click();
    await expect(page.getByText(`该${entry.label}尚未注册，请先注册账户。`, { exact: true })).toBeVisible();
    await expect(send).toBeDisabled();
    await expect(page.getByRole("link", { name: "去注册", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.locator(".auth-panel form").dispatchEvent("submit");
    expect(service.challenges).toHaveLength(1);
  });

  test(`${entry.label}注册：新账号不经过登录检查，可以继续验证注册`, async ({ page }) => {
    const service = await mockEligibilityService(page);
    await page.goto(`/signup?method=${entry.method}`);
    await page.locator(entry.input).fill(entry.unknown);
    await page.getByRole("button", { name: entry.signupSend, exact: true }).click();
    await expect(page.getByRole("status")).toContainText(entry.method === "email" ? "验证邮件已发送" : "验证码已申请发送");
    expect(service.checks).toEqual([]);
    expect(service.challenges).toEqual([{ method: entry.method, body: {
      [entry.method === "email" ? "email" : "phone"]: entry.unknown,
      intent: "signup", role: "client", returnTo: "/workspace",
    } }]);
  });
}

test("切换登录方式立即禁发，旧邮箱的查询结果不能放行手机号", async ({ page }) => {
  const service = await mockEligibilityService(page);
  let release!: () => void;
  service.gates.set(methods[0].account, new Promise<void>((resolve) => { release = resolve; }));
  await page.goto("/login?method=email");
  await page.locator("#auth-email").fill(methods[0].account);
  await expect.poll(() => service.checks.length).toBe(1);
  await page.getByRole("radio", { name: "手机短信", exact: true }).check();
  await expect(page.getByRole("button", { name: "发送验证码", exact: true })).toBeDisabled();
  await page.locator("#auth-phone").fill(methods[1].unknown);
  await expect(page.getByText("该手机号尚未注册，请先注册账户。", { exact: true })).toBeVisible();
  release();
  await expect.poll(() => service.completedChecks.length).toBe(2);
  await expect(page.getByRole("button", { name: "发送验证码", exact: true })).toBeDisabled();
  expect(service.challenges).toEqual([]);
});
