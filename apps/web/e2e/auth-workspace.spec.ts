import { randomUUID } from "node:crypto";
import { test, expect, authenticate, requestEmailLink, syntheticEmail } from "./support/fixtures";

test("邮箱验证绑定发起浏览器，链接仅使用一次，发送中不可改变身份", async ({ page, browser, environment, database }) => {
  const email = syntheticEmail("ownership");
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/api/v1/auth/email/challenges", async (route) => { await requestGate; await route.continue(); });
  await page.goto("/signup");
  await page.getByLabel("邮箱", { exact: false }).fill(email);
  const challengeResponse = page.waitForResponse("**/api/v1/auth/email/challenges");
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  await expect(page.getByRole("button", { name: "正在发送…", exact: true })).toBeDisabled();
  await expect(page.getByLabel("邮箱", { exact: false })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "需求方：我有一个需求", exact: true })).toBeDisabled();
  releaseRequest();
  expect((await challengeResponse).status()).toBe(202);
  await page.unroute("**/api/v1/auth/email/challenges");
  const { capturedMagicLink } = await import("./support/fixtures");
  const link = await capturedMagicLink(email, environment);
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  const stranger = await browser.newContext({ baseURL: environment.webOrigin });
  try {
    const rejected = await stranger.request.post("/api/v1/auth/email/verify", {
      headers: { Origin: environment.webOrigin }, data: { token },
    });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).error.code).toBe("BROWSER_CONTEXT_REQUIRED");
    expect((await database.query("SELECT count(*)::int AS count FROM users WHERE email = $1", [email])).rows[0].count).toBe(0);
  } finally { await stranger.close(); }
  await page.goto(link);
  await expect(page).toHaveURL(`${environment.webOrigin}/workspace`);
  await expect(page.getByText("邮箱地址已验证", { exact: true })).toBeVisible();
  const replay = await page.request.post("/api/v1/auth/email/verify", {
    headers: { Origin: environment.webOrigin }, data: { token },
  });
  expect(replay.status()).toBe(400);
  const stored = await database.query("SELECT email_verified_at, role FROM users WHERE email = $1", [email]);
  expect(stored.rows[0].email_verified_at).not.toBeNull();
  expect(stored.rows[0].role).toBe("client");
});

for (const role of ["client", "talent"] as const) {
  test(`${role}：注册初始身份、资料与对话跨刷新持久化`, async ({ page, environment, database }) => {
    const email = syntheticEmail(role);
    await authenticate(page, environment, { email, role });
    await expect(page.getByText("邮箱地址已验证", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "个人信息", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "个人信息", exact: true })).toBeVisible();
    await expect(page.getByText("同一账户可同时使用两种身份，通过页面上方按钮切换。基本资料共用，需求与能力档案分别保存。", { exact: true })).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    const displayName = role === "client" ? "需求方自动回归" : "专业人才自动回归";
    await page.getByLabel("显示名称", { exact: false }).fill(displayName);
    await page.getByLabel("所在国家或地区", { exact: true }).selectOption("SG");
    await page.getByLabel("联系手机号或微信号", { exact: false }).fill("e2e_profile_contact");
    if (role === "client") {
      await page.getByLabel("公司或组织", { exact: true }).fill("DuduHire E2E");
      await page.getByLabel("职位", { exact: true }).fill("项目负责人");
    } else {
      await page.getByLabel("专业标题", { exact: true }).fill("AI 工作流工程师");
    }
    await page.getByLabel(role === "client" ? "职责与需求方向" : "专业简介", { exact: true }).fill("这是隔离测试环境的自动化验证资料。");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("个人信息已更新");
    await page.reload();
    await expect(page.getByLabel("显示名称", { exact: false })).toHaveValue(displayName);
    await expect(page.getByLabel("联系手机号或微信号", { exact: false })).toHaveValue("e2e_profile_contact");
    const profile = await database.query("SELECT p.display_name, p.contact, u.role FROM profiles p JOIN users u ON u.id=p.user_id WHERE u.email=$1", [email]);
    expect(profile.rows[0].display_name).toBe(displayName);
    expect(profile.rows[0].contact).not.toContain("e2e_profile_contact");
    expect(profile.rows[0].role).toBe(role);

    const discoveryPath = role === "talent" ? "/projects" : "/talent";
    await page.goto(role === "talent" ? "/talent" : "/projects");
    await expect(page).toHaveURL(`${environment.webOrigin}${discoveryPath}`);
    const prompt = role === "talent"
      ? "我负责构建知识库和自动化工作流，使支持团队每周减少 12 小时重复检索。"
      : "我们的售后工单每周积压 80 条，希望在两个月内缩短响应时间并明确验收指标。";
    await page.getByRole("textbox", { name: role === "talent" ? "讲述一段真实经历" : "描述你想解决的问题", exact: true }).fill(prompt);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("log")).toContainText(prompt);
    await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
    await page.reload();
    await expect(page.getByRole("log")).toContainText(prompt);
    const turns = await database.query("SELECT t.question FROM discovery_turns t JOIN discovery_threads d ON d.id=t.thread_id JOIN users u ON u.id=d.owner_user_id WHERE u.email=$1", [email]);
    expect(turns.rows).toEqual([{ question: prompt }]);
    await page.goto("/workspace");
    await expect(page.locator(".workspace-setup-grid article").filter({ hasText: role === "talent" ? "构建能力身份卡" : "描述一个真实问题" })).toHaveAttribute("data-state", "required");
    await page.goto(discoveryPath);
    const details = role === "talent"
      ? "经历背景：支持团队查找资料困难\n个人职责：我负责整理资料和开发检索功能\n具体行动：归纳问题并搭建知识检索页面\n实际结果：团队反馈更容易找到答案\n可提供的依据：可提供脱敏项目说明\n适合承担的工作：内部知识工具建设\n合作偏好：远程阶段合作"
      : "工作背景：售后工单处理缓慢\n主要工作：梳理分派流程和建设工单看板\n预期结果：让每条工单都有明确负责人\n合作方式：阶段项目\n时间与合作条件：远程协作，预算待讨论\n必要能力与加分经验：必须有流程梳理经验，售后经验加分\n面谈核实重点：了解一次实际流程改进案例";
    const composer = page.getByRole("textbox", { name: role === "talent" ? "讲述一段真实经历" : "描述你想解决的问题", exact: true });
    await composer.fill(details);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("log")).toContainText("确认保存当前版本");
    await composer.fill("确认保存当前版本");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("log")).toContainText("已保存当前用户确认版本");
    await page.reload();
    await expect(page.getByRole("log")).toContainText("用户已确认");
    await page.goto("/workspace");
    await expect(page.locator(".workspace-setup-grid article").filter({ hasText: role === "talent" ? "构建能力身份卡" : "描述一个真实问题" })).toHaveAttribute("data-state", "complete");
    await page.goto(discoveryPath);
    await composer.fill(role === "talent" ? "具体行动：我只整理资料，没有参与开发" : "主要工作：先整理流程，暂不开发看板");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
    await page.goto("/workspace");
    await expect(page.locator(".workspace-setup-grid article").filter({ hasText: role === "talent" ? "构建能力身份卡" : "描述一个真实问题" })).toHaveAttribute("data-state", "required");
  });
}

test("工作台读取失败显示真实错误，并可重试恢复", async ({ page, environment }) => {
  await authenticate(page, environment, { email: syntheticEmail("retry"), role: "client" });
  let fail = true;
  await page.route("**/api/v1/me/workspace", async (route) => {
    if (fail) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "E2E_UNAVAILABLE", message: "测试中的临时连接失败。" } }) });
    else await route.continue();
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "账户状态加载失败", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("测试中的临时连接失败。");
  await expect(page.locator(".workspace-setup-grid")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.locator(".workspace-setup-grid article")).toHaveCount(3);
  await expect(page.getByText("邮箱地址已验证", { exact: true })).toBeVisible();
});

test("登录邮件成功提示可见，修改邮箱清除旧提示", async ({ page, environment }) => {
  await requestEmailLink(page, environment, { email: syntheticEmail("notice"), role: "talent" });
  await expect(page.getByRole("status")).toContainText("链接有效期为 15 分钟");
  await page.getByLabel("邮箱", { exact: false }).fill(syntheticEmail("changed"));
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "创建账户", exact: true })).toBeEnabled();
});


test("邮箱登录：真实隔离接口拒绝未注册账号，已注册账号仍可验证登录", async ({ page, environment, database }) => {
  const unknownEmail = syntheticEmail("unknown-login");
  await page.goto("/login?method=email");
  await page.getByLabel("邮箱", { exact: false }).fill(unknownEmail);
  await expect(page.getByText("该邮箱尚未注册，请先注册账户。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeDisabled();
  const rejected = await page.request.post("/api/v1/auth/email/challenges", {
    headers: { Origin: environment.webOrigin },
    data: { email: unknownEmail, intent: "login", returnTo: "/workspace" },
  });
  expect(rejected.status()).toBe(409);
  expect((await rejected.json()).error.code).toBe("ACCOUNT_NOT_REGISTERED");
  expect((await database.query("SELECT count(*)::int AS count FROM email_challenges WHERE email=$1", [unknownEmail])).rows[0].count).toBe(0);
  expect((await database.query("SELECT count(*)::int AS count FROM users WHERE email=$1", [unknownEmail])).rows[0].count).toBe(0);

  // Fixtures validate this is a temporary loopback *_test database. The test
  // sender only captures synthetic @example.test mail in this run's directory.
  const registeredEmail = syntheticEmail("known-login");
  const userId = randomUUID();
  await database.query("INSERT INTO users (id, email, role, email_verified_at) VALUES ($1, $2, 'talent', NOW())", [userId, registeredEmail]);
  await database.query("INSERT INTO profiles (user_id) VALUES ($1)", [userId]);
  await authenticate(page, environment, { email: registeredEmail });
  await expect(page.getByText("邮箱地址已验证", { exact: true })).toBeVisible();
  expect((await database.query("SELECT count(*)::int AS count FROM users WHERE email=$1", [registeredEmail])).rows[0].count).toBe(1);
});
