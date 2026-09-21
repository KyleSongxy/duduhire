import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { test as base, expect, type Page } from "@playwright/test";
import { readTestEnvironment, testStateDirectory, type TestEnvironment } from "./settings";

export const test = base.extend<{
  environment: TestEnvironment;
  database: pg.Pool;
}>({
  environment: async ({ baseURL }, provide) => {
    const environment = await readTestEnvironment();
    if (baseURL !== environment.webOrigin) throw new Error("Unexpected E2E fixture origin.");
    await provide(environment);
  },
  database: async ({ environment }, provide) => {
    const pool = new pg.Pool({ connectionString: environment.databaseUrl, ssl: false, max: 2 });
    try { await provide(pool); } finally { await pool.end(); }
  },
});
export { expect };

export function syntheticEmail(label: string) {
  // Keep the local part within 64 characters, including the 36-character UUID.
  const boundedLabel = label.toLowerCase().replace(/[^a-z0-9-]/gu, "-").slice(0, 23) || "case";
  return `e2e-${boundedLabel}-${randomUUID()}@example.test`;
}

export async function capturedMagicLink(email: string, environment: TestEnvironment) {
  const filename = `${createHash("sha256").update(email).digest("hex")}.json`;
  await expect.poll(async () => {
    const message = await readFile(join(testStateDirectory(), "mailbox", filename), "utf8")
      .then((value) => JSON.parse(value) as { to: string; link: string })
      .catch(() => null);
    return message?.to === email;
  }, { message: "The local test mail capture should receive this synthetic identity's verification message." }).toBe(true);
  const { link } = JSON.parse(await readFile(join(testStateDirectory(), "mailbox", filename), "utf8")) as { link: string };
  const url = new URL(link);
  expect(url.origin).toBe(environment.webOrigin);
  expect(url.pathname).toBe("/auth/verify");
  return link;
}

export async function requestEmailLink(
  page: Page,
  environment: TestEnvironment,
  options: { email: string; role?: "client" | "talent"; returnTo?: string },
) {
  const mode = options.role ? "signup" : "login";
  await page.goto(`/${mode}?method=email&returnTo=${encodeURIComponent(options.returnTo || "/workspace")}`);
  if (options.role) {
    await page.locator(`input[name="role"][value="${options.role}"]`).check();
  }
  await page.getByLabel("邮箱", { exact: false }).fill(options.email);
  const sent = page.waitForResponse((response) => response.url().endsWith("/api/v1/auth/email/challenges") && response.request().method() === "POST");
  await page.getByRole("button", { name: options.role ? "创建账户" : "登录", exact: true }).click();
  expect((await sent).status()).toBe(202);
  await expect(page.getByRole("status")).toContainText("同一浏览器");
  await expect(page.getByRole("status")).toContainText("15 分钟");
  return capturedMagicLink(options.email, environment);
}

export async function authenticate(
  page: Page,
  environment: TestEnvironment,
  options: { email: string; role?: "client" | "talent"; returnTo?: string },
) {
  const link = await requestEmailLink(page, environment, options);
  await page.goto(link);
  await expect(page).toHaveURL(`${environment.webOrigin}${options.returnTo || "/workspace"}`);
  return link;
}

export async function submitPricingInquiry(page: Page, plan: "team" | "flexible" | "managed") {
  const names = {
    team: { plan: "团队协作", action: "咨询团队方案" },
    flexible: { plan: "灵活用工", action: "讨论用工需求" },
    managed: { plan: "托管交付", action: "规划托管项目" },
  }[plan];
  const contactValue = `e2e_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await page.goto("/pricing");
  await page.getByRole("navigation", { name: "选择付费方案" }).getByRole("button", { name: new RegExp(names.plan, "u") }).click();
  await page.getByRole("button", { name: names.action, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: /微信号/u }).check();
  await dialog.getByRole("textbox", { name: "微信号", exact: true }).fill(contactValue);
  const sent = page.waitForResponse((response) => response.url().endsWith("/api/v1/enterprise/inquiries") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "确认留下", exact: true }).click();
  const response = await sent;
  expect(response.status()).toBe(202);
  await expect(dialog).toContainText("信息已确认");
  const request = response.request().postDataJSON() as { requestId: string; source: string };
  expect(request.source).toBe("pricing_page");
  return { id: request.requestId, contactValue };
}
