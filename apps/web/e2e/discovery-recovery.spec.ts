import type { Page } from "@playwright/test";
import { normalizeDiscoveryState } from "../src/discoveryFlow";
import { test, expect, authenticate, syntheticEmail } from "./support/fixtures";

const turnEndpoint = "/api/v1/me/discovery/turns";
const confirmation = "确认保存当前版本";
const completeProblem = [
  "工作背景：售后工单处理缓慢",
  "主要工作：梳理分派流程和建设工单看板",
  "预期结果：让每条工单都有明确负责人",
  "合作方式：阶段项目",
  "时间与合作条件：远程协作，预算待讨论",
  "必要能力与加分经验：必须有流程梳理经验，售后经验加分",
  "面谈核实重点：了解一次实际流程改进案例",
].join("\n");

type TurnRequest = { requestId: string; expectedThreadId: string | null; expectedVersion: number };

async function submitPrompt(page: Page, prompt: string) {
  await page.getByRole("textbox", { name: "描述你想解决的问题", exact: true }).fill(prompt);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith(turnEndpoint) && response.request().method() === "POST");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
  return {
    state: normalizeDiscoveryState(await response.json()),
    request: response.request().postDataJSON() as TurnRequest,
  };
}

for (const role of ["client", "talent"] as const) {
  test(`${role}：未发送的文本跨刷新恢复且不生成服务端对话`, async ({ page, environment, database }) => {
    const email = syntheticEmail(`composer-${role}`);
    const path = role === "client" ? "/talent" : "/projects";
    const inputLabel = role === "client" ? "描述你想解决的问题" : "讲述一段真实经历";
    const draft = role === "client" ? "我们想先梳理售后分派流程，还没有决定招聘还是阶段合作。" : "我在实习时负责整理常见问题，想补充这段经历。";
    await authenticate(page, environment, { email, role, returnTo: path });
    const composer = page.getByRole("textbox", { name: inputLabel, exact: true });
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await composer.fill(draft);
    await expect.poll(() => page.evaluate((text) => Object.values(window.sessionStorage).some((value) => {
      try { return (JSON.parse(value) as { prompt?: string }).prompt === text; } catch { return false; }
    }), draft), { message: "Unsent text should be recoverable before reloading." }).toBe(true);
    await page.reload();
    await expect(composer).toHaveValue(draft);
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await expect(page.getByRole("log")).toHaveCount(0);
    const turns = await database.query(
      "SELECT count(*)::int AS count FROM discovery_turns t JOIN discovery_threads d ON d.id=t.thread_id JOIN users u ON u.id=d.owner_user_id WHERE u.email=$1",
      [email],
    );
    expect(turns.rows[0].count).toBe(0);
  });
}

test("服务端已保存但回复传输失败：刷新按请求标识恢复，不重复提交", async ({ page, environment, database }) => {
  const email = syntheticEmail("lost-discovery-response");
  await authenticate(page, environment, { email, role: "client", returnTo: "/talent" });
  const composer = page.getByRole("textbox", { name: "描述你想解决的问题", exact: true });
  const prompt = "工作背景：售后团队每天需要人工检查未分派的工单。";
  let persistedStatus = 0;
  let persistedRequestId = "";
  await page.route(`**${turnEndpoint}`, async (route) => {
    persistedRequestId = (route.request().postDataJSON() as TurnRequest).requestId;
    const saved = await route.fetch();
    persistedStatus = saved.status();
    // The isolated server commits normally, while only the browser's response is lost.
    await route.abort("failed");
  });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("输入和附件已保留");
  await expect(composer).toHaveValue(prompt);
  expect(persistedStatus).toBe(200);
  expect(persistedRequestId).not.toBe("");
  const stored = await database.query<{ request_id: string; provider: string }>(
    "SELECT t.request_id, t.provider FROM discovery_turns t JOIN discovery_threads d ON d.id=t.thread_id JOIN users u ON u.id=d.owner_user_id WHERE u.email=$1",
    [email],
  );
  expect(stored.rows).toEqual([{ request_id: persistedRequestId, provider: "local" }]);
  await page.unroute(`**${turnEndpoint}`);
  let replayedTurns = 0;
  page.on("request", (request) => {
    if (request.url().endsWith(turnEndpoint) && request.method() === "POST") replayedTurns += 1;
  });
  await page.reload();
  await expect(page.getByRole("log")).toContainText(prompt);
  await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const restored = normalizeDiscoveryState(await (await page.request.get("/api/v1/me/discovery")).json());
  expect(restored.turns.map((turn) => turn.requestId)).toEqual([persistedRequestId]);
  expect(replayedTurns).toBe(0);
});

test("双页确认冲突：保留输入并展示最新草稿，重新确认后才保存", async ({ page, environment, database }) => {
  const email = syntheticEmail("version-review");
  await authenticate(page, environment, { email, role: "client", returnTo: "/talent" });
  const first = await submitPrompt(page, completeProblem);
  expect(first.state.artifact?.flow?.status).toBe("ready");
  const reviewPage = await page.context().newPage();
  try {
    await reviewPage.goto("/talent");
    const reviewComposer = reviewPage.getByRole("textbox", { name: "描述你想解决的问题", exact: true });
    await expect(reviewPage.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await expect(reviewPage.getByRole("log")).toContainText(completeProblem);
    await reviewComposer.fill(confirmation);

    const correction = "主要工作：先整理售后分派流程，暂不开发看板";
    const updated = await submitPrompt(page, correction);
    expect(updated.state.version).toBeGreaterThan(first.state.version);
    expect(updated.state.artifact?.flow?.status).toBe("ready");

    const rejectedPromise = reviewPage.waitForResponse((response) => response.url().endsWith(turnEndpoint) && response.request().method() === "POST");
    await reviewPage.getByRole("button", { name: "发送消息", exact: true }).click();
    const rejected = await rejectedPromise;
    expect(rejected.status()).toBe(409);
    expect((await rejected.json() as { error: { code: string } }).error.code).toBe("DISCOVERY_STATE_CONFLICT");
    const staleRequest = rejected.request().postDataJSON() as TurnRequest;
    expect(staleRequest.expectedThreadId).toBe(first.state.threadId);
    expect(staleRequest.expectedVersion).toBe(first.state.version);
    await expect(reviewPage.getByRole("alert")).toContainText("最新内容已载入");
    await expect(reviewPage.getByRole("log")).toContainText(correction);
    await expect(reviewComposer).toHaveValue(confirmation);
    const stillDraft = normalizeDiscoveryState(await (await reviewPage.request.get("/api/v1/me/discovery")).json());
    expect(stillDraft.artifact?.flow?.status).toBe("ready");
    expect(stillDraft.artifact?.flow?.confirmedAt).toBeNull();
    expect(stillDraft.turns).toHaveLength(2);

    // Reviewing the updated conversation is followed by a second explicit send, never an automatic retry.
    const saved = await submitPrompt(reviewPage, confirmation);
    expect(saved.request.requestId).not.toBe(staleRequest.requestId);
    expect(saved.request.expectedVersion).toBe(updated.state.version);
    expect(saved.state.artifact?.flow?.status).toBe("confirmed");
    expect(saved.state.artifact?.flow?.confirmedAt).not.toBeNull();
    expect(saved.state.artifact?.flow?.fields.work.value).toBe("先整理售后分派流程，暂不开发看板");
    await expect(reviewPage.getByRole("log")).toContainText("已保存当前用户确认版本");
    await expect(reviewPage.getByRole("alert")).toHaveCount(0);
    const stored = await database.query<{ request_id: string; provider: string }>(
      "SELECT t.request_id, t.provider FROM discovery_turns t JOIN discovery_threads d ON d.id=t.thread_id JOIN users u ON u.id=d.owner_user_id WHERE u.email=$1 ORDER BY t.sequence",
      [email],
    );
    expect(stored.rows).toHaveLength(3);
    expect(stored.rows.every((turn) => turn.provider === "local")).toBe(true);
    expect(stored.rows.some((turn) => turn.request_id === staleRequest.requestId)).toBe(false);
  } finally {
    await reviewPage.close();
  }
});
