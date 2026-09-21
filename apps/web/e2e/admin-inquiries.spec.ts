import { test, expect, authenticate, submitPricingInquiry, syntheticEmail } from "./support/fixtures";

test("访客/普通用户无法访问后台，管理员可审计查看与更新咨询", async ({ page, browser, environment, database }) => {
  expect((await page.request.get("/api/v1/admin/access")).status()).toBe(401);
  expect((await page.request.get("/api/v1/admin/inquiries")).status()).toBe(401);
  await authenticate(page, environment, { email: syntheticEmail("nonadmin"), role: "client" });
  const inquiry = await submitPricingInquiry(page, "team");
  const ordinaryAccess = await page.request.get("/api/v1/admin/access");
  expect(await ordinaryAccess.json()).toEqual({ authorized: false });
  expect((await page.request.get("/api/v1/admin/inquiries")).status()).toBe(403);
  expect((await page.request.patch(`/api/v1/admin/inquiries/${inquiry.id}`, {
    headers: { Origin: environment.webOrigin }, data: { status: "closed", expectedVersion: 1 },
  })).status()).toBe(403);
  expect((await page.request.post(`/api/v1/admin/inquiries/${inquiry.id}/reveal-contact`, {
    headers: { Origin: environment.webOrigin }, data: { reason: "自动化验证未授权访问" },
  })).status()).toBe(403);
  let deniedListRequests = 0;
  const onRequest = (request: { url: () => string }) => { if (/\/api\/v1\/admin\/inquiries(?:\?|$)/u.test(request.url())) deniedListRequests += 1; };
  page.on("request", onRequest);
  await page.goto("/admin/inquiries");
  await expect(page.getByRole("heading", { name: "当前账户没有管理权限", exact: true })).toBeVisible();
  expect(deniedListRequests).toBe(0);
  page.off("request", onRequest);

  const adminContext = await browser.newContext({ baseURL: environment.webOrigin });
  const adminPage = await adminContext.newPage();
  try {
    await authenticate(adminPage, environment, { email: environment.adminEmail, returnTo: "/admin/inquiries" });
    await expect(adminPage.getByRole("heading", { level: 1, name: "让每次咨询都有回应。", exact: true })).toBeVisible();
    const listResponse = await adminPage.request.get("/api/v1/admin/inquiries?status=new&limit=20");
    expect(listResponse.status()).toBe(200);
    const list = await listResponse.json();
    const item = list.items.find((entry: { id: string }) => entry.id === inquiry.id);
    expect(item).toBeTruthy();
    expect(item).not.toHaveProperty("contactValue");
    expect(item).not.toHaveProperty("contactCiphertext");
    expect(item).not.toHaveProperty("contactHash");
    await adminPage.setViewportSize({ width: 375, height: 812 });
    await adminPage.getByRole("button", { name: `查看咨询 ${inquiry.id}`, exact: true }).click();
    await expect(adminPage.getByRole("button", { name: "返回咨询列表", exact: true })).toBeInViewport();
    await expect(adminPage.getByRole("heading", { level: 2, name: "服务方案", exact: true })).toBeFocused();
    expect(await adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await adminPage.getByRole("button", { name: "记录用途并查看", exact: true }).click();
    await expect(adminPage.getByRole("alert")).toContainText("至少 5 个字符");
    const purpose = "自动化回归验证咨询跟进权限";
    await adminPage.getByRole("textbox", { name: "本次查看用途", exact: true }).fill(purpose);
    await adminPage.getByRole("button", { name: "记录用途并查看", exact: true }).click();
    await expect(adminPage.getByText(inquiry.contactValue, { exact: true })).toBeVisible();
    const audit = await database.query("SELECT actor_user_id, reason FROM inquiry_audit_events WHERE inquiry_id=$1 AND action='contact_revealed'", [inquiry.id]);
    expect(audit.rows).toEqual([{ actor_user_id: environment.adminUserId, reason: purpose }]);
    await adminPage.getByRole("button", { name: "隐藏联系方式", exact: true }).click();
    await expect(adminPage.getByText(inquiry.contactValue, { exact: true })).toHaveCount(0);
    await adminPage.getByLabel("跟进状态", { exact: true }).selectOption("contacted");
    await adminPage.getByRole("button", { name: "保存跟进状态", exact: true }).click();
    await expect(adminPage.getByRole("status").filter({ hasText: "跟进状态已保存。" })).toBeVisible();
    await adminPage.getByRole("group", { name: "咨询状态筛选", exact: true }).getByRole("button", { name: /已联系/u }).click();
    await expect(adminPage.getByRole("button", { name: `查看咨询 ${inquiry.id}`, exact: true })).toBeVisible();
    const outdated = await adminPage.request.patch(`/api/v1/admin/inquiries/${inquiry.id}`, {
      headers: { Origin: environment.webOrigin }, data: { status: "closed", expectedVersion: item.version },
    });
    expect(outdated.status()).toBe(409);
    const statusAudit = await database.query("SELECT previous_status, next_status FROM inquiry_audit_events WHERE inquiry_id=$1 AND action='status_changed'", [inquiry.id]);
    expect(statusAudit.rows).toEqual([{ previous_status: "new", next_status: "contacted" }]);
  } finally { await adminContext.close(); }
});
