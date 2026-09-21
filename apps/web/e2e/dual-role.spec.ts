import type { Page } from "@playwright/test";
import { test, expect, authenticate, syntheticEmail } from "./support/fixtures";

async function expectDesktopRole(page: Page, role: "client" | "talent") {
  const workspace = new URL(page.url()).pathname === "/workspace";
  const navigation = page.getByRole("navigation", { name: workspace ? "主要功能" : "主导航", exact: true });
  await expect(navigation.getByRole("link", { name: role === "client" ? "梳理用人需求" : "完善能力档案", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: role === "client" ? "完善能力档案" : "梳理用人需求", exact: true })).toHaveCount(0);
  await expect(page.locator(workspace ? ".workspace-role-switch" : ".nav-role-switch")).toContainText(role === "client" ? "当前：需求方" : "当前：能力方");
}

async function switchRole(page: Page, role: "client" | "talent", container = new URL(page.url()).pathname === "/workspace" ? ".workspace-role-switch" : ".nav-role-switch") {
  const response = page.waitForResponse((entry) => entry.url().endsWith("/api/v1/auth/role") && entry.request().method() === "POST");
  await page.locator(container).getByRole("button", { name: role === "client" ? "切换为需求方" : "切换为能力方", exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  await expect(page).toHaveURL(/\/workspace$/u);
  const body = await (await page.request.get("/api/v1/auth/session")).json();
  expect(body.session.user.role).toBe(role);
  expect(body.session.user.roles).toEqual(["client", "talent"]);
  await expect(page.locator(".workspace-role-switch")).toContainText(role === "client" ? "当前：需求方" : "当前：能力方");
  return body.session;
}

async function sendDiscovery(page: Page, role: "client" | "talent", prompt: string) {
  await page.getByRole("textbox", { name: role === "client" ? "描述你想解决的问题" : "讲述一段真实经历", exact: true }).fill(prompt);
  const response = page.waitForResponse((entry) => entry.url().endsWith("/api/v1/me/discovery/turns") && entry.request().method() === "POST");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const result = await response;
  expect(result.request().headers()["x-duduhire-role"]).toBe(role);
  expect(result.status()).toBe(200);
  await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("log")).toContainText(prompt);
}

test("同一账户切换身份，两个发现记录与未发送草稿分别持久化", async ({ page, environment, database }, testInfo) => {
  const email = syntheticEmail("dual-role");
  await authenticate(page, environment, { email, role: "client" });
  const original = (await (await page.request.get("/api/v1/auth/session")).json()).session;
  await expectDesktopRole(page, "client");
  await page.goto("/talent");
  const demand = "需求方记录：我们的售后工单每周积压80条，需要梳理分派流程和负责人。";
  await sendDiscovery(page, "client", demand);
  const demandComposer = page.getByRole("textbox", { name: "描述你想解决的问题", exact: true });
  await demandComposer.fill("需求方还没发送的补充草稿");
  const talentSession = await switchRole(page, "talent");
  expect(talentSession.user.id).toBe(original.user.id);
  expect(talentSession.signedInAt).toBe(original.signedInAt);
  expect(talentSession.expiresAt).toBe(original.expiresAt);
  await expectDesktopRole(page, "talent");
  await page.reload();
  await expectDesktopRole(page, "talent");
  await page.goto("/projects");
  await expect(page.getByRole("main")).not.toContainText(demand);
  const capability = "能力方记录：我负责整理知识资料并搭建检索页面，使支持团队每周减少12小时检索。";
  await sendDiscovery(page, "talent", capability);
  await page.getByRole("textbox", { name: "讲述一段真实经历", exact: true }).fill("能力方还没发送的补充草稿");
  await switchRole(page, "client");
  await expectDesktopRole(page, "client");
  await page.goto("/talent");
  await expect(page.getByRole("log")).toContainText(demand);
  await expect(page.getByRole("log")).not.toContainText(capability);
  await expect(demandComposer).toHaveValue("需求方还没发送的补充草稿");
  await switchRole(page, "talent");
  await page.goto("/projects");
  await expect(page.getByRole("log")).toContainText(capability);
  await expect(page.getByRole("textbox", { name: "讲述一段真实经历", exact: true })).toHaveValue("能力方还没发送的补充草稿");
  const turns = await database.query("SELECT d.kind, t.question FROM discovery_turns t JOIN discovery_threads d ON d.id=t.thread_id JOIN users u ON u.id=d.owner_user_id WHERE u.email=$1 ORDER BY d.kind", [email]);
  expect(turns.rows).toEqual([{ kind: "capability", question: capability }, { kind: "problem", question: demand }]);
  expect((await database.query("SELECT role FROM users WHERE email=$1", [email])).rows).toEqual([{ role: "client" }]);
  await page.goto("/workspace");
  await page.screenshot({ path: testInfo.outputPath("dual-role-workspace-1280.png"), fullPage: true });
  await page.goto("/projects");
  for (const width of [1280, 921]) {
    await page.setViewportSize({ width, height: 900 });
    await expectDesktopRole(page, "talent");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`dual-role-desktop-${width}.png`), fullPage: true });
  }
});

test("切换失败保留当前身份并可重试，旧身份请求不会写入另一类档案", async ({ page, environment, database }) => {
  const email = syntheticEmail("role-retry");
  await authenticate(page, environment, { email, role: "client" });
  let fail = true;
  await page.route("**/api/v1/auth/role", async (route) => {
    if (fail) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "TEMPORARY_FAILURE", message: "身份切换暂时不可用，请重试。" } }) });
    else await route.continue();
  });
  const control = page.locator(".workspace-role-switch");
  await control.getByRole("button", { name: "切换为能力方", exact: true }).click();
  await expect(control.getByRole("alert")).toContainText("身份切换暂时不可用，请重试。");
  await expect(control.getByRole("button", { name: "切换为能力方", exact: true })).toBeEnabled();
  await expectDesktopRole(page, "client");
  fail = false;
  await switchRole(page, "talent", ".workspace-role-switch");
  const stale = await page.request.post("/api/v1/me/discovery/turns", {
    headers: { Origin: environment.webOrigin, "X-DuduHire-Role": "client" },
    data: { requestId: crypto.randomUUID(), prompt: "旧需求方页面不能写进能力档案", attachments: [], expectedThreadId: null, expectedVersion: 0 },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe("ACTIVE_ROLE_CHANGED");
  expect((await database.query("SELECT count(*)::int AS count FROM discovery_threads d JOIN users u ON u.id=d.owner_user_id WHERE u.email=$1", [email])).rows[0].count).toBe(0);
});

test("同一浏览器其他标签页会同步当前身份", async ({ page, context, environment }) => {
  await authenticate(page, environment, { email: syntheticEmail("role-tab"), role: "client" });
  const second = await context.newPage();
  try {
    await second.goto("/workspace");
    await expectDesktopRole(second, "client");
    await switchRole(page, "talent");
    await expectDesktopRole(second, "talent");
    await expect(second.locator(".workspace-role-switch")).toContainText("当前：能力方");
  } finally { await second.close(); }
});

test("未保存个人信息切换后恢复，保存时保留另一身份的专属字段", async ({ page, environment, database }) => {
  const email = syntheticEmail("profile-role");
  await authenticate(page, environment, { email, role: "client", returnTo: "/workspace?tab=profile" });
  await page.getByLabel("显示名称", { exact: false }).fill("双身份资料草稿");
  await page.getByLabel("公司或组织", { exact: true }).fill("需求方待保存组织");
  await switchRole(page, "talent");
  await page.goto("/workspace?tab=profile");
  await page.getByLabel("显示名称", { exact: false }).fill("能力方已保存姓名");
  await page.getByLabel("专业标题", { exact: true }).fill("已保存的知识库顾问");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("个人信息已更新");
  await switchRole(page, "client");
  await page.goto("/workspace?tab=profile");
  await expect(page.getByLabel("显示名称", { exact: false })).toHaveValue("双身份资料草稿");
  await expect(page.getByLabel("公司或组织", { exact: true })).toHaveValue("需求方待保存组织");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("个人信息已更新");
  const profile = await database.query("SELECT p.display_name, p.organization, p.professional_title FROM profiles p JOIN users u ON u.id=p.user_id WHERE u.email=$1", [email]);
  expect(profile.rows).toEqual([{ display_name: "双身份资料草稿", organization: "需求方待保存组织", professional_title: "已保存的知识库顾问" }]);
});

test("匹配预览编辑切换后恢复，发布同意不会自动恢复", async ({ page, environment }) => {
  await authenticate(page, environment, { email: syntheticEmail("matching-role"), role: "client" });
  await page.goto("/talent");
  await sendDiscovery(page, "client", "工作背景：内部制度分散，员工经常重复向人力资源同事咨询\n主要工作：整理批准的制度资料，建立知识分类和常见问题说明\n预期结果：同事可以自行找到制度出处和办理方式\n合作方式：阶段项目\n时间与合作条件：远程合作，具体开始时间待讨论\n必要能力与加分经验：具备知识资料整理经验\n面谈核实重点：实际整理过的知识资料案例");
  await sendDiscovery(page, "client", "确认保存当前版本");
  const form = page.getByRole("form", { name: "匹配资料预览", exact: true });
  await form.getByLabel("展示标题", { exact: true }).fill("切换身份前未发布的自定义标题");
  const consent = form.getByRole("checkbox", { name: "我同意将以上内容用于匹配并展示给已登录的其他用户", exact: true });
  await consent.check();
  await switchRole(page, "talent");
  await switchRole(page, "client");
  await page.goto("/talent");
  await expect(form.getByLabel("展示标题", { exact: true })).toHaveValue("切换身份前未发布的自定义标题");
  await expect(consent).not.toBeChecked();
  expect((await (await page.request.get("/api/v1/me/matching")).json()).listing).toBeNull();
});

test("手机导航按身份显示入口，320px与390px均可切换", async ({ page, environment }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  const navigation = page.getByRole("navigation", { name: "移动端导航", exact: true });
  await expect(navigation.getByRole("link", { name: "梳理用人需求", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "完善能力档案", exact: true })).toBeVisible();
  await authenticate(page, environment, { email: syntheticEmail("role-mobile"), role: "talent" });
  await page.goto("/projects");
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await expect(navigation.getByRole("link", { name: "完善能力档案", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "梳理用人需求", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("dual-role-mobile-menu-390.png"), fullPage: true });
  await switchRole(page, "client", "#mobile-navigation");
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator(".workspace-role-switch")).toContainText("当前：需求方");
  await page.screenshot({ path: testInfo.outputPath("dual-role-mobile-workspace-320.png"), fullPage: true });
  await switchRole(page, "talent", ".workspace-role-switch");
  await page.goto("/projects");
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await expect(navigation.getByRole("link", { name: "完善能力档案", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "梳理用人需求", exact: true })).toHaveCount(0);
});
