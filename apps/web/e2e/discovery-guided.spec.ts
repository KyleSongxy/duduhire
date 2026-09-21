import { test, expect, authenticate, syntheticEmail } from "./support/fixtures";
import { normalizeDiscoveryState } from "../src/discoveryFlow";

const examples = [
  { role: "client", path: "/talent", input: "描述你想解决的问题", example: "示例：企业出海需求" },
  { role: "talent", path: "/projects", input: "讲述一段真实经历", example: "示例：AI 项目经历" },
] as const;

for (const example of examples) {
  test(`${example.role}：示例仅回填可编辑文字，未发送的事实不会被示例覆盖`, async ({ page, environment, database }) => {
    const email = syntheticEmail(`guided-example-${example.role}`);
    await authenticate(page, environment, { email, role: example.role, returnTo: example.path });
    const input = page.getByRole("textbox", { name: example.input, exact: true });
    const exampleButton = page.getByRole("button", { name: example.example, exact: true });
    await expect(exampleButton).toBeEnabled();
    await exampleButton.click();
    await expect(input).toHaveValue(/^【示例输入，请替换为真实情况】/u);
    await expect(page.getByText("已填入可编辑示例，请替换成你的真实情况；尚未发送。", { exact: true })).toBeVisible();
    await expect(page.getByRole("log")).toHaveCount(0);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("请先将示例改为你的真实情况");
    await expect(input).toHaveValue(/^【示例输入，请替换为真实情况】/u);
    await expect(page.getByRole("log")).toHaveCount(0);
    const rows = await database.query("SELECT count(*)::int AS count FROM discovery_threads d JOIN users u ON u.id=d.owner_user_id WHERE u.email=$1", [email]);
    expect(rows.rows[0].count).toBe(0);
    await input.fill("这是我尚未发送的真实情况。");
    await expect(exampleButton).toBeDisabled();
    await expect(input).toHaveValue("这是我尚未发送的真实情况。");
  });
}

test("一段需求直接提炼，快捷确认保护未发送文字，匹配自动带入但不自动公开", async ({ page, environment }) => {
  await authenticate(page, environment, { email: syntheticEmail("guided-confirm"), role: "client", returnTo: "/talent" });
  const input = page.getByRole("textbox", { name: "描述你想解决的问题", exact: true });
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  const message = "工作背景：内部知识分散，客服经常重复查找产品资料。主要工作：整理知识资料并开发带来源引用的 AI 知识库，建立评测集。预期结果：客服能够快速查到可信的资料出处。合作方式：远程阶段项目。";
  await input.fill(message);
  const generated = page.waitForResponse((response) => response.url().endsWith("/api/v1/me/discovery/turns") && response.request().method() === "POST");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  expect((await generated).status()).toBe(200);
  const review = page.getByRole("region", { name: "用人需求草稿", exact: true });
  await expect(review).toContainText("主要工作");
  await expect(page.locator(".talent-chat-message-assistant").last()).not.toContainText("主要工作：");
  await expect(page.locator(".talent-chat-message-assistant").last()).toContainText("依据来自本人陈述或所附材料，未经平台核验。");
  const preserved = normalizeDiscoveryState(await (await page.request.get("/api/v1/me/discovery")).json());
  expect(preserved.turns.at(-1)?.answer).toContain("主要工作：");
  const confirm = page.getByRole("button", { name: "确认保存当前版本", exact: true });
  await expect(confirm).toBeEnabled();
  await input.fill("我还有一项条件没有发送");
  await expect(confirm).toBeDisabled();
  await review.getByRole("button", { name: "修改主要工作", exact: true }).click();
  await expect(input).toHaveValue(/^我还有一项条件没有发送\n主要工作：/u);
  await input.fill("");
  const confirmed = page.waitForResponse((response) => response.url().endsWith("/api/v1/me/discovery/turns") && response.request().method() === "POST");
  await confirm.click();
  expect((await confirmed).status()).toBe(200);
  const form = page.getByRole("form", { name: "匹配资料预览", exact: true });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("展示摘要", { exact: true })).not.toHaveValue("");
  await expect(form.getByRole("checkbox", { name: "我同意将以上内容用于匹配并展示给已登录的其他用户", exact: true })).not.toBeChecked();
  const state = await (await page.request.get("/api/v1/me/matching")).json();
  expect(state.listing).toBeNull();
  expect(state.source.confirmed).toBe(true);
  const conditionSummary = form.locator(".matching-panel__conditions > summary");
  await conditionSummary.click();
  await form.getByLabel("目标市场", { exact: true }).fill("德国");
  await form.getByLabel("工作语言", { exact: true }).fill("英语");
  await form.getByLabel("每周最低投入（小时）", { exact: true }).fill("20");
  await form.getByLabel("最晚开始日期", { exact: true }).fill("2026-10-01");
  await form.getByLabel("预算下限", { exact: true }).fill("30000");
  await form.getByLabel("预算上限", { exact: true }).fill("50000");
  await form.getByLabel("币种", { exact: true }).selectOption("CNY");
  await form.getByLabel("计费方式", { exact: true }).selectOption("project");
  await conditionSummary.click();
  for (const condition of ["市场：德国", "语言：英语", "预算：30,000–50,000人民币/项目", "每周至少 20 小时", "最晚 2026-10-01 开始"]) await expect(conditionSummary).toContainText(condition);
  await expect(form.getByLabel("预算下限", { exact: true })).not.toBeVisible();
  const previewed = page.waitForResponse((response) => response.url().endsWith("/api/v1/me/matching/preview") && response.request().method() === "POST");
  await form.getByRole("button", { name: "查看示例匹配", exact: true }).click();
  const preview = await previewed;
  expect(preview.status()).toBe(200);
  expect((await preview.json()).catalog).toBe("examples");
  await expect(page.getByRole("region", { name: "示例匹配结果", exact: true })).toContainText("不是可联系的真实用户");
  expect((await (await page.request.get("/api/v1/me/matching")).json()).listing).toBeNull();
});

test("能力核心事实齐全即可成稿，可选问题可随时返回草稿且保留原事实", async ({ page, environment }) => {
  await authenticate(page, environment, { email: syntheticEmail("guided-optional"), role: "talent", returnTo: "/projects" });
  const input = page.getByRole("textbox", { name: "讲述一段真实经历", exact: true });
  const endpoint = "/api/v1/me/discovery/turns";
  const submit = async (prompt: string) => {
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await input.fill(prompt);
    const sent = page.waitForResponse((response) => response.url().endsWith(endpoint) && response.request().method() === "POST");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const response = await sent;
    expect(response.status()).toBe(200);
    await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
    return normalizeDiscoveryState(await response.json());
  };
  const initial = await submit("经历背景：内部支持资料分散，团队查找答案困难。个人职责：我只负责知识资料整理与评测。具体行动：我分类产品说明并编写 30 条评测问题，没有负责系统上线。实际结果：完成了分类说明和评测记录，尚无线上效果数据。");
  expect(initial.artifact?.flow?.status).toBe("ready");
  expect(initial.artifact?.flow?.missingFields).toEqual([]);
  expect(initial.artifact?.flow?.fields.preferences).toBeUndefined();
  await expect(page.getByRole("button", { name: "确认保存当前版本", exact: true })).toBeEnabled();
  const optional = await submit("继续完善");
  expect(optional.artifact?.flow?.status).toBe("collecting");
  expect(optional.artifact?.flow?.missingFields).toEqual([]);
  expect(["evidence", "direction", "preferences"]).toContain(optional.artifact?.flow?.stage);
  const sent = page.waitForResponse((response) => response.url().endsWith(endpoint) && response.request().method() === "POST");
  await page.getByRole("button", { name: "先生成草稿", exact: true }).click();
  const response = await sent;
  expect(response.status()).toBe(200);
  const returned = normalizeDiscoveryState(await response.json());
  expect(returned.artifact?.flow?.status).toBe("ready");
  for (const key of ["situation", "role", "actions", "outcome"]) {
    expect(returned.artifact?.flow?.fields[key]).toEqual(initial.artifact?.flow?.fields[key]);
  }
  await expect(page.getByRole("button", { name: "确认保存当前版本", exact: true })).toBeEnabled();
});
