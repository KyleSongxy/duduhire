import type { Locator } from "@playwright/test";
import { test, expect, authenticate, syntheticEmail } from "./support/fixtures";

const longToken = "FormattingRegression".repeat(8);
const message = [
  "",
  "  姓名：回归测试用户",
  "年龄：30",
  "",
  "个人简介：",
  "  1. 我负责知识库资料整理。",
  "    补充：保留四格缩进。",
  "\t2. 完成客服访谈和评测。",
  `作品：${longToken}`,
  "",
  "",
].join("\n");

async function expectOriginalLayout(bubble: Locator) {
  await expect(bubble).toHaveCount(1);
  expect(await bubble.textContent()).toBe(message);
  const layout = await bubble.evaluate((element, token) => {
    const node = element.firstChild!;
    const text = node.textContent!;
    const position = (label: string) => {
      const offset = text.indexOf(label);
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    };
    const range = document.createRange();
    range.setStart(node, text.indexOf(token));
    range.setEnd(node, text.indexOf(token) + token.length);
    const bounds = element.getBoundingClientRect();
    const styles = getComputedStyle(element);
    return {
      name: position("姓名"), age: position("年龄"), introduction: position("个人简介"),
      first: position("1."), nested: position("补充"), second: position("2."),
      lineHeight: Number.parseFloat(styles.lineHeight),
      contentTop: bounds.top + Number.parseFloat(styles.paddingTop),
      wrappedLines: new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.y))).size,
      bubbleOverflows: element.scrollWidth > element.clientWidth + 1,
      viewportOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
      withinViewport: bounds.left >= 0 && bounds.right <= window.innerWidth,
    };
  }, longToken);
  // Measure rendered text, so collapsing whitespace or merely clipping a long
  // token fails even when the DOM still contains the original string.
  expect(layout.name.y - layout.contentTop).toBeGreaterThan(layout.lineHeight * 0.8);
  expect(layout.age.y - layout.name.y).toBeCloseTo(layout.lineHeight, 0);
  expect(layout.introduction.y - layout.age.y).toBeCloseTo(layout.lineHeight * 2, 0);
  expect(layout.name.x).toBeGreaterThan(layout.age.x + 4);
  expect(layout.first.x).toBeGreaterThan(layout.introduction.x + 4);
  expect(layout.nested.x).toBeGreaterThan(layout.first.x + 4);
  expect(layout.second.x).toBeGreaterThan(layout.introduction.x + 4);
  expect(layout.wrappedLines).toBeGreaterThan(1);
  expect(layout.bubbleOverflows).toBe(false);
  expect(layout.viewportOverflows).toBe(false);
  expect(layout.withinViewport).toBe(true);
}

for (const mode of [
  { role: "client", path: "/talent", input: "描述你想解决的问题" },
  { role: "talent", path: "/projects", input: "讲述一段真实经历" },
] as const) {
  test(`${mode.role}：多行原文在发送中、保存及刷新后保留空行和缩进，桌面手机均自动折行`, async ({ page, environment, database }, testInfo) => {
    const email = syntheticEmail(`formatting-${mode.role}`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await authenticate(page, environment, { email, role: mode.role, returnTo: mode.path });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const input = page.getByRole("textbox", { name: mode.input, exact: true });
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await input.fill(message);
    // Hold only this local request long enough to inspect the pending bubble;
    // the same request then reaches the real isolated API and PostgreSQL.
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/v1/me/discovery/turns", async (route) => {
      await pending;
      await route.continue();
    });
    const sent = page.waitForRequest((request) => request.url().endsWith("/api/v1/me/discovery/turns") && request.method() === "POST");
    const response = page.waitForResponse((result) => result.url().endsWith("/api/v1/me/discovery/turns") && result.request().method() === "POST");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const request = await sent;
    expect(request.postDataJSON().prompt).toBe(message);
    const bubble = page.locator(".talent-chat-message-user > p");
    try {
      await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "true");
      await expectOriginalLayout(bubble);
    } finally {
      release();
    }
    expect((await response).status()).toBe(200);
    await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
    await expectOriginalLayout(bubble);
    const stored = await database.query(
      "SELECT t.question FROM discovery_turns t JOIN discovery_threads d ON d.id=t.thread_id JOIN users u ON u.id=d.owner_user_id WHERE u.email=$1",
      [email],
    );
    expect(stored.rows.map((row: { question: string }) => row.question)).toEqual([message]);
    await page.screenshot({ path: testInfo.outputPath("multiline-desktop-1280.png"), fullPage: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
      await expectOriginalLayout(bubble);
      await expect(input).toHaveValue("");
    }
    await page.screenshot({ path: testInfo.outputPath("multiline-mobile-390.png"), fullPage: true });
  });
}
