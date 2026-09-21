import { test, expect, authenticate, submitPricingInquiry, syntheticEmail } from "./support/fixtures";

test("FAQ 与企业流程 tabs 支持 Home、End、方向键和单一焦点", async ({ page }) => {
  for (const configuration of [
    { path: "/how-it-works", list: "常见问题分类", first: "开始探索", last: "合作与结果", second: "发现问题" },
    { path: "/enterprise", list: "企业项目交付流程", first: "诊断", last: "衡量", second: "蓝图" },
  ]) {
    await page.goto(configuration.path);
    const tabs = page.getByRole("tablist", { name: configuration.list });
    await tabs.getByRole("tab", { name: configuration.first, exact: true }).press("End");
    const last = tabs.getByRole("tab", { name: configuration.last, exact: true });
    await expect(last).toBeFocused();
    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
    await last.press("Home");
    const first = tabs.getByRole("tab", { name: configuration.first, exact: true });
    await expect(first).toBeFocused();
    await first.press("ArrowRight");
    const second = tabs.getByRole("tab", { name: configuration.second, exact: true });
    await expect(second).toBeFocused();
    await expect(page.getByRole("tabpanel", { name: configuration.second, exact: true })).toBeVisible();
    await second.press("ArrowLeft");
    await first.press("ArrowLeft");
    await expect(last).toBeFocused();
  }
});

test("375px 工作台菜单隔离背景、初始聚焦、Tab闭环及Escape返回", async ({ page, environment }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await authenticate(page, environment, { email: syntheticEmail("mobile"), role: "talent" });
  const opener = page.getByRole("button", { name: "打开工作台导航", exact: true });
  const sidebar = page.locator("#workspace-navigation");
  await expect(sidebar).toHaveAttribute("inert", "");
  await opener.click();
  const close = page.getByRole("button", { name: "关闭工作台导航", exact: true });
  await expect(close).toBeFocused();
  await expect(page.locator("#workspace-content")).toHaveAttribute("inert", "");
  await close.press("Shift+Tab");
  await expect(sidebar.getByRole("link", { name: "返回 DuduHire 首页", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(sidebar.getByRole("button", { name: "退出登录", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sidebar.getByRole("link", { name: "返回 DuduHire 首页", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(page.locator("#workspace-content")).not.toHaveAttribute("inert");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("三个定价咨询入口均提交数据库，并保留outbox通知事件", async ({ page, database }) => {
  for (const plan of ["team", "flexible", "managed"] as const) {
    const inquiry = await submitPricingInquiry(page, plan);
    const record = await database.query("SELECT i.contact_method, i.contact_ciphertext, i.source, i.status, e.event_type FROM enterprise_inquiries i JOIN outbox_events e ON e.aggregate_id=i.id WHERE i.id=$1", [inquiry.id]);
    expect(record.rows).toHaveLength(1);
    expect(record.rows[0]).toMatchObject({ contact_method: "wechat", source: "pricing_page", status: "new", event_type: "enterprise_inquiry.created" });
    expect(record.rows[0].contact_ciphertext).not.toContain(inquiry.contactValue);
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
});

test("只接受可读取文本附件，拒绝PDF并将文本内容传给服务端", async ({ page, environment, database }) => {
  const email = syntheticEmail("attachment");
  await authenticate(page, environment, { email, role: "talent" });
  await page.goto("/projects");
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({ name: "unsupported.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nE2E synthetic PDF") });
  await expect(page.getByRole("alert")).toContainText("无法读取“unsupported.pdf”");
  await expect(page.getByRole("list", { name: /已添加/u })).toHaveCount(0);
  const text = "我在项目中负责自动化设计，缩短了工单处理时间。";
  await fileInput.setInputFiles({ name: "e2e-experience.txt", mimeType: "text/plain", buffer: Buffer.from(text) });
  await expect(page.getByRole("list", { name: "已添加 1 个附件", exact: true })).toContainText("e2e-experience.txt");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
  const record = await database.query("SELECT t.attachments, t.analysis_context FROM discovery_turns t JOIN discovery_threads d ON d.id=t.thread_id JOIN users u ON u.id=d.owner_user_id WHERE u.email=$1", [email]);
  expect(record.rows).toHaveLength(1);
  expect(record.rows[0].attachments[0]).toMatchObject({ name: "e2e-experience.txt", mediaType: "text/plain", size: Buffer.byteLength(text) });
  expect(record.rows[0].analysis_context).toContain(text);
});
