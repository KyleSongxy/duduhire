import { test, expect, type Page } from "@playwright/test";

// Every API request in this suite is intercepted. These cases do not send SMS,
// call a real verification provider, or prove that a carrier delivered a message.
const syntheticPhone = "13900000001";
const syntheticCode = "104827";
type Failure = { status: number; code: string; message: string; retryAfterSeconds?: number };

async function mockPhoneService(page: Page) {
  const service = {
    available: true,
    emailAvailable: true,
    methodsFailure: false,
    signedIn: false,
    accountFound: true,
    eligibilityChecks: [] as Array<Record<string, unknown>>,
    role: "client" as "client" | "talent",
    returnTo: "/workspace",
    sendFailure: null as Failure | null,
    verifyFailure: null as Failure | null,
    sendGate: null as Promise<void> | null,
    verifyGate: null as Promise<void> | null,
    malformedSend: false,
    challengeCount: 0,
    expiresInSeconds: 300,
    resendAfterSeconds: 60,
    posts: [] as Array<{ path: string; body: Record<string, unknown> }>,
  };
  const profile = { displayName: "", countryCode: "CN", contact: "", organization: "", jobTitle: "", professionalTitle: "", bio: "", version: 1, updatedAt: null };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const fail = (failure: Failure) => route.fulfill({ status: failure.status, contentType: "application/json",
      headers: failure.retryAfterSeconds === undefined ? {} : { "Retry-After": String(failure.retryAfterSeconds) },
      body: JSON.stringify({ error: { code: failure.code, message: failure.message } }) });
    const body = request.method() === "POST" ? request.postDataJSON() as Record<string, unknown> : {};
    if (path === "/auth/login-eligibility") {
      service.eligibilityChecks.push(body);
      return json({ registered: true });
    }
    if (request.method() === "POST") service.posts.push({ path, body });
    if (path === "/auth/session") return json({ session: service.signedIn ? {
      user: { id: "phone-mock-user", email: null, emailVerifiedAt: null, phone: `+86${syntheticPhone}`, phoneVerifiedAt: "2026-09-07T00:00:00.000Z", role: service.role },
      signedInAt: "2026-09-07T00:00:00.000Z", expiresAt: "2099-09-07T00:00:00.000Z", profile,
    } : null });
    if (path === "/auth/methods") return service.methodsFailure
      ? fail({ status: 503, code: "MOCK_METHODS_UNAVAILABLE", message: "模拟服务状态加载失败。" })
      : json({ email: { available: service.emailAvailable, delivery: service.emailAvailable ? "development" : "disabled" }, phone: { available: service.available, region: "CN" } });
    if (path === "/auth/email/challenges") return json({ accepted: true, delivery: "development", expiresInSeconds: 900, resendAfterSeconds: 60 }, 202);
    if (path === "/auth/email/verify" && !service.emailAvailable) return fail({ status: 503, code: "EMAIL_AUTH_DISABLED", message: "邮箱注册与登录暂未启用。" });
    if (path === "/auth/phone/challenges") {
      if (service.sendGate) await service.sendGate;
      if (service.sendFailure) return fail(service.sendFailure);
      service.challengeCount += 1;
      service.returnTo = String(body.returnTo);
      if (body.intent === "signup") service.role = body.role as "client" | "talent";
      return json({ accepted: true, delivery: service.malformedSend ? "development" : "sms", challengeId: `phone-challenge-${service.challengeCount}`, expiresInSeconds: service.expiresInSeconds, resendAfterSeconds: service.resendAfterSeconds }, 202);
    }
    if (path === "/auth/phone/verify") {
      if (service.verifyGate) await service.verifyGate;
      if (service.verifyFailure) return fail(service.verifyFailure);
      if (!service.accountFound) return json({ authenticated: false, reason: "account_not_found", returnTo: service.returnTo });
      service.signedIn = true;
      return json({ authenticated: true, returnTo: service.returnTo });
    }
    if (path === "/me/workspace") return json({ discoveryCompleted: false, paymentAccountStatus: "not_configured" });
    if (path === "/me/profile") return json({ profile });
    if (path === "/me/matching") return json({ kind: service.role === "talent" ? "capability" : "problem", source: null, listing: null, suggestion: { title: "", summary: "", skills: [], requiredSkills: [], workMode: "any", engagement: "any", location: "", notes: "" }, skills: [], workModes: { any: "不限", remote: "远程", onsite: "现场", hybrid: "混合" }, engagements: { any: "不限", project: "项目", part_time: "兼职", full_time: "全职" } });
    return fail({ status: 501, code: "MOCK_UNEXPECTED_ENDPOINT", message: `模拟测试未配置此接口：${path}` });
  });
  return service;
}

async function openPhoneAuth(page: Page, path = "/login") {
  await page.goto(path);
  await page.getByRole("radio", { name: "手机短信", exact: true }).check();
  await page.locator("#auth-phone").fill(syntheticPhone);
}

async function sendCode(page: Page) {
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("验证码已申请发送");
}

test("手机号服务停用时禁发，并保留原邮箱开发模式提示", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.available = false;
  await openPhoneAuth(page);
  await expect(page.getByText("手机号验证暂不可用，请选择邮件链接继续。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送验证码", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "验证并登录", exact: true })).toBeDisabled();
  await page.getByRole("radio", { name: "邮件链接", exact: true }).check();
  await page.getByLabel("邮箱", { exact: false }).fill("phone-suite@example.test");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("未发送真实验证邮件");
  await page.getByLabel("邮箱", { exact: false }).fill("phone-suite-changed@example.test");
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeEnabled();
  expect(service.posts.map(({ path }) => path)).toEqual(["/auth/email/challenges"]);
});

test("邮箱停用时默认使用仍可用的短信注册，不请求邮件接口", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.emailAvailable = false;
  await page.goto("/signup");
  await expect(page.getByRole("radio", { name: "手机短信", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "邮件链接（暂不可用）", exact: true })).toBeDisabled();
  await expect(page.getByText("邮箱注册与登录暂未启用。请使用手机短信继续。", { exact: true })).toBeVisible();
  await page.locator("#auth-phone").fill(syntheticPhone);
  await sendCode(page);
  await page.locator("#auth-phone-code").fill(syntheticCode);
  await page.getByRole("button", { name: "验证并创建账户", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/u);
  expect(service.posts.map(({ path }) => path)).toEqual(["/auth/phone/challenges", "/auth/phone/verify"]);
});

test("邮箱和短信均停用时禁止发送，不提示改用不可用的方式", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.emailAvailable = false;
  service.available = false;
  await page.goto("/login?method=email");
  await expect(page.getByText("邮箱注册与登录暂未启用。请稍后再试或联系管理员。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "邮箱暂不可用", exact: true })).toBeDisabled();
  await expect(page.locator("#auth-email")).toBeDisabled();
  await page.locator(".auth-panel form").dispatchEvent("submit");
  await page.getByRole("radio", { name: "手机短信", exact: true }).check();
  await expect(page.getByText("手机号验证暂不可用，请稍后再试或联系管理员。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送验证码", exact: true })).toBeDisabled();
  await page.locator(".auth-panel form").dispatchEvent("submit");
  expect(service.posts).toEqual([]);
});

test("邮箱停用时旧链接显示停用原因，不提供无效的网络重试", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.emailAvailable = false;
  await page.goto(`/auth/verify#token=${"a".repeat(43)}`);
  await expect(page.getByRole("heading", { name: "邮箱验证暂未启用", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回登录", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新验证", exact: true })).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("");
  expect(service.signedIn).toBe(false);
  expect(service.posts.map(({ path }) => path)).toEqual(["/auth/email/verify"]);
});

test("手机号服务状态读取失败时可重试，确认之前不发送短信", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.methodsFailure = true;
  await openPhoneAuth(page);
  await expect(page.getByText("暂时无法确认注册与登录服务状态，请稍后重试。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送验证码", exact: true })).toBeDisabled();
  service.methodsFailure = false;
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(page.getByRole("button", { name: "发送验证码", exact: true })).toBeEnabled();
  expect(service.posts).toEqual([]);
});

test("手机号注册锁定发送和验证中的身份，防止重复请求并显示真实账户验证状态", async ({ page }) => {
  const service = await mockPhoneService(page);
  let releaseSend!: () => void;
  service.sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
  await openPhoneAuth(page, "/signup?returnTo=%2Fworkspace%3Ftab%3Dprofile");
  await page.locator('input[name="role"][value="talent"]').check();
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  await expect(page.locator("#auth-phone")).toBeDisabled();
  await expect(page.getByRole("radio", { name: "邮件链接", exact: true })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "需求方：我有一个需求", exact: true })).toBeDisabled();
  await page.locator(".auth-panel form").dispatchEvent("submit");
  releaseSend();
  await expect(page.getByRole("status")).toContainText("验证码已申请发送");
  await expect(page.getByRole("button", { name: /秒后可重新发送/u })).toBeDisabled();
  await page.locator("#auth-phone-code").fill(syntheticCode);
  let releaseVerify!: () => void;
  service.verifyGate = new Promise<void>((resolve) => { releaseVerify = resolve; });
  await page.getByRole("button", { name: "验证并创建账户", exact: true }).click();
  await expect(page.locator("#auth-phone-code")).toBeDisabled();
  await expect(page.locator('input[name="role"][value="talent"]')).toBeDisabled();
  await page.locator(".auth-panel form").dispatchEvent("submit");
  releaseVerify();
  await expect(page).toHaveURL(/\/workspace\?tab=profile$/u);
  await expect(page.getByText("手机号码已验证", { exact: true })).toBeVisible();
  await expect(page.getByText("登录手机号", { exact: true })).toBeVisible();
  await expect(page.getByText("邮箱地址已验证", { exact: true })).toHaveCount(0);
  await expect(page.getByText("登录邮箱", { exact: true })).toHaveCount(0);
  expect(service.posts).toEqual([
    { path: "/auth/phone/challenges", body: { phone: syntheticPhone, intent: "signup", role: "talent", returnTo: "/workspace?tab=profile" } },
    { path: "/auth/phone/verify", body: { challengeId: "phone-challenge-1", code: syntheticCode } },
  ]);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain(syntheticPhone);
  expect(stored).not.toContain(syntheticCode);
  expect(page.url()).not.toContain(syntheticPhone);
  expect(page.url()).not.toContain(syntheticCode);
  await page.goto("/workspace");
  await expect(page.getByText("手机号码已验证", { exact: true })).toBeVisible();
  await expect(page.getByText("邮箱地址已验证", { exact: true })).toHaveCount(0);
});

test("发送后账户被移除时仍只转注册提示，不自动创建账户且不在 URL 携带号码和验证码", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.accountFound = false;
  await openPhoneAuth(page, "/login?returnTo=%2Fprojects%3Fsource%3Dphone-test");
  await sendCode(page);
  await page.locator("#auth-phone-code").fill(syntheticCode);
  await page.getByRole("button", { name: "验证并登录", exact: true }).click();
  await expect(page).toHaveURL(/\/signup\?/u);
  await expect(page.getByRole("alert")).toContainText("该手机号尚未注册");
  await expect(page.locator("#auth-phone")).toHaveValue("");
  await expect(page.getByRole("radio", { name: "手机短信", exact: true })).toBeChecked();
  await expect(page.locator('input[name="role"][value="talent"]')).toBeChecked();
  const url = new URL(page.url());
  expect(url.searchParams.get("returnTo")).toBe("/projects?source=phone-test");
  expect(url.href).not.toContain(syntheticPhone);
  expect(url.href).not.toContain(syntheticCode);
  expect(service.signedIn).toBe(false);
  expect(service.posts.filter(({ path }) => path === "/auth/phone/challenges")).toEqual([
    { path: "/auth/phone/challenges", body: { phone: syntheticPhone, intent: "login", returnTo: "/projects?source=phone-test" } },
  ]);
});

test("手机号和验证码在前端校验，倒计时到期显示过期并要求重新发送", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.expiresInSeconds = 3;
  service.resendAfterSeconds = 1;
  await page.clock.install();
  await openPhoneAuth(page);
  await page.locator("#auth-phone").fill("12345");
  await expect(page.getByRole("button", { name: "发送验证码", exact: true })).toBeDisabled();
  expect(service.posts).toEqual([]);
  expect(service.eligibilityChecks).toEqual([]);
  await page.locator("#auth-phone").fill(syntheticPhone);
  await sendCode(page);
  await page.locator("#auth-phone-code").fill("123");
  await page.getByRole("button", { name: "验证并登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("6 位短信验证码");
  expect(service.posts).toHaveLength(1);
  await page.clock.fastForward(3100);
  await expect(page.getByText("验证码已过期，请重新申请发送。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "验证并登录", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "重新发送验证码", exact: true })).toBeEnabled();
});

test("短信重发失败保留输入但废弃旧 challenge，不能继续提交旧验证码", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.resendAfterSeconds = 1;
  await page.clock.install();
  await openPhoneAuth(page);
  await sendCode(page);
  await page.locator("#auth-phone-code").fill(syntheticCode);
  await page.clock.fastForward(1100);
  service.sendFailure = { status: 503, code: "SMS_UNAVAILABLE", message: "模拟短信服务暂不可用，请稍后重新申请。" };
  await page.getByRole("button", { name: "重新发送验证码", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("模拟短信服务暂不可用");
  await expect(page.locator("#auth-phone")).toHaveValue(syntheticPhone);
  await expect(page.locator("#auth-phone-code")).toHaveValue(syntheticCode);
  await expect(page.getByRole("button", { name: "验证并登录", exact: true })).toBeDisabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(service.posts.filter(({ path }) => path === "/auth/phone/verify")).toHaveLength(0);
});

test("短信核验服务故障可使用当前输入重试，明确失效时必须重新申请", async ({ page }) => {
  const service = await mockPhoneService(page);
  await openPhoneAuth(page);
  await sendCode(page);
  await page.locator("#auth-phone-code").fill(syntheticCode);
  service.verifyFailure = { status: 503, code: "SMS_VERIFICATION_UNAVAILABLE", message: "模拟核验服务暂不可用，请重试。" };
  await page.getByRole("button", { name: "验证并登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("模拟核验服务暂不可用");
  await expect(page.locator("#auth-phone-code")).toHaveValue(syntheticCode);
  await expect(page.getByRole("button", { name: "验证并登录", exact: true })).toBeEnabled();
  service.verifyFailure = { status: 400, code: "INVALID_OR_EXPIRED_CODE", message: "验证码无效或已过期，请重新申请。" };
  await page.getByRole("button", { name: "验证并登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("验证码无效或已过期");
  await expect(page.getByRole("button", { name: "验证并登录", exact: true })).toBeDisabled();
  expect(service.posts.filter(({ path }) => path === "/auth/phone/verify").map(({ body }) => body)).toEqual([
    { challengeId: "phone-challenge-1", code: syntheticCode }, { challengeId: "phone-challenge-1", code: syntheticCode },
  ]);
});

test("修改手机号、账户类型或认证方式都清除旧验证码和发送反馈", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.resendAfterSeconds = 0;
  await openPhoneAuth(page, "/signup");
  await sendCode(page);
  await page.locator("#auth-phone-code").fill(syntheticCode);
  await page.locator("#auth-phone").fill("13900000002");
  await expect(page.locator("#auth-phone-code")).toHaveValue("");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "验证并创建账户", exact: true })).toBeDisabled();
  await sendCode(page);
  await page.locator("#auth-phone-code").fill(syntheticCode);
  await page.locator('input[name="role"][value="talent"]').check();
  await expect(page.locator("#auth-phone-code")).toHaveValue("");
  await expect(page.getByRole("status")).toHaveCount(0);
  await sendCode(page);
  await page.getByRole("radio", { name: "邮件链接", exact: true }).check();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("radio", { name: "手机短信", exact: true }).check();
  await expect(page.locator("#auth-phone-code")).toHaveValue("");
  await expect(page.getByRole("button", { name: "验证并创建账户", exact: true })).toBeDisabled();
});

test("非短信的伪成功响应不会显示已申请发送或允许验证", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.malformedSend = true;
  await openPhoneAuth(page);
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认验证码发送状态");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "验证并登录", exact: true })).toBeDisabled();
});

for (const mode of ["login", "signup"] as const) {
  test(`${mode} 短信：刷新恢复待验证状态和冷却，不保存验证码且不自动重发`, async ({ page }) => {
    const service = await mockPhoneService(page);
    await openPhoneAuth(page, `/${mode}`);
    if (mode === "signup") await page.locator('input[name="role"][value="talent"]').check();
    await sendCode(page);
    await page.locator("#auth-phone-code").fill(syntheticCode);
    await page.reload();
    await expect(page.getByRole("radio", { name: "手机短信", exact: true })).toBeChecked();
    await expect(page.locator("#auth-phone")).toHaveValue(syntheticPhone);
    await expect(page.locator("#auth-phone-code")).toHaveValue("");
    if (mode === "signup") await expect(page.locator('input[name="role"][value="talent"]')).toBeChecked();
    const submit = page.getByRole("button", { name: mode === "signup" ? "验证并创建账户" : "验证并登录", exact: true });
    await expect(submit).toBeEnabled();
    await expect(page.getByRole("button", { name: /秒后可重新发送/u })).toBeDisabled();
    expect(service.posts.filter(({ path }) => path.endsWith("/challenges"))).toHaveLength(1);
    await page.locator("#auth-phone-code").fill(syntheticCode);
    await submit.click();
    await expect(page).toHaveURL(/\/workspace$/u);
    expect(service.posts.filter(({ path }) => path.endsWith("/verify"))[0]?.body.challengeId).toBe("phone-challenge-1");
    expect(await page.evaluate(() => sessionStorage.getItem("duduhire-pending-phone-auth-v1"))).toBeNull();
  });
}

test("短信：重发429保留已有验证码并按服务端等待时间倒计时，刷新后仍可验证", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.resendAfterSeconds = 1;
  await page.clock.install();
  await openPhoneAuth(page);
  await sendCode(page);
  await page.locator("#auth-phone-code").fill(syntheticCode);
  await page.clock.fastForward(1100);
  service.sendFailure = { status: 429, code: "RATE_LIMITED", message: "发送频率或额度已达限制", retryAfterSeconds: 1800 };
  await page.getByRole("button", { name: "重新发送验证码", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已收到的验证码仍可在有效期内提交");
  await expect(page.getByRole("button", { name: "验证并登录", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: /17\d\d 秒后可重新发送|1800 秒后可重新发送/u })).toBeDisabled();
  await expect(page.locator("#auth-phone-code")).toHaveValue(syntheticCode);
  await page.reload();
  await expect(page.getByRole("button", { name: "验证并登录", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: /秒后可重新发送/u })).toBeDisabled();
  await page.locator("#auth-phone-code").fill(syntheticCode);
  await page.getByRole("button", { name: "验证并登录", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/u);
  expect(service.posts.filter(({ path }) => path.endsWith("/challenges"))).toHaveLength(2);
  expect(service.posts.filter(({ path }) => path.endsWith("/verify"))[0]?.body.challengeId).toBe("phone-challenge-1");
});

test("短信：过期、改手机号或更换账户类型后不恢复旧验证状态", async ({ page }) => {
  const service = await mockPhoneService(page);
  service.expiresInSeconds = 2;
  service.resendAfterSeconds = 1;
  await page.clock.install();
  await openPhoneAuth(page, "/signup?method=phone");
  await sendCode(page);
  await page.clock.fastForward(2100);
  await page.reload();
  await expect(page.getByRole("button", { name: "验证并创建账户", exact: true })).toBeDisabled();
  await expect(page.locator("#auth-phone")).toHaveValue("");
  service.expiresInSeconds = 300;
  await page.locator("#auth-phone").fill(syntheticPhone);
  await sendCode(page);
  await page.locator('input[name="role"][value="talent"]').check();
  await page.reload();
  await expect(page.getByRole("button", { name: "验证并创建账户", exact: true })).toBeDisabled();
  await page.locator("#auth-phone").fill(syntheticPhone);
  await sendCode(page);
  await page.locator("#auth-phone").fill("13900000002");
  await page.reload();
  await expect(page.getByRole("button", { name: "验证并创建账户", exact: true })).toBeDisabled();
});
