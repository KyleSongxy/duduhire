import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, authenticate, syntheticEmail } from "./support/fixtures";

const endpoint = "/api/v1/me/matching";
const consentLabel = "我同意将以上内容用于匹配并展示给已登录的其他用户";
const problemFacts = [
  "工作背景：内部制度分散，员工经常重复向人力资源同事咨询",
  "主要工作：整理批准的制度资料，建立知识分类和常见问题说明",
  "预期结果：同事可以自行找到制度出处和办理方式",
  "合作方式：阶段项目",
  "时间与合作条件：远程合作，具体开始时间待讨论",
  "必要能力与加分经验：具备知识资料整理经验",
  "面谈核实重点：实际整理过的知识资料案例",
].join("\n");
const capabilityFacts = [
  "经历背景：内部制度资料分散，团队难以快速查找",
  "个人职责：我负责知识资料分类，不是项目负责人",
  "具体行动：我整理批准的制度并编写常见问题说明",
  "实际结果：同事反馈查找资料更加方便",
  "可提供的依据：可提供脱敏后的分类说明",
  "适合承担的工作：知识资料整理和常见问题梳理",
  "合作偏好：远程阶段项目",
].join("\n");

type Kind = "client" | "talent";
type Listing = { id: string; version: number; title: string; status: string; active: boolean };
type State = { source: { threadId: string; version: number; confirmed: boolean } | null; listing: Listing | null };
type Results = { matches: Array<{ listing: { id: string; title: string } }>; total: number; catalogLimited: boolean };

function matchingRegion(page: Page, role: Kind) {
  return page.getByRole("region", { name: role === "client" ? "人才匹配" : "项目匹配", exact: true });
}

async function sendDiscovery(page: Page, role: Kind, prompt: string) {
  const input = page.getByRole("textbox", { name: role === "client" ? "描述你想解决的问题" : "讲述一段真实经历", exact: true });
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await input.fill(prompt);
  const sent = page.waitForResponse((response) => response.url().endsWith("/api/v1/me/discovery/turns") && response.request().method() === "POST");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  expect((await sent).status()).toBe(200);
  await expect(page.getByRole("log")).toHaveAttribute("aria-busy", "false");
}

async function confirmDiscovery(page: Page, role: Kind) {
  await sendDiscovery(page, role, role === "client" ? problemFacts : capabilityFacts);
  await sendDiscovery(page, role, "确认保存当前版本");
  const state = await (await page.request.get(endpoint)).json() as State;
  expect(state.source?.confirmed).toBe(true);
  expect(state.listing).toBeNull();
  return state;
}

async function preparePublication(page: Page, role: Kind, title: string, editing = false) {
  await page.bringToFront();
  const region = matchingRegion(page, role);
  // Discovery opens matching automatically. Wait for the actual control rather
  // than treating a transient loading state as a collapsed legacy panel.
  if (editing) {
    const edit = region.getByRole("button", { name: "修改展示资料", exact: true });
    await edit.click();
  }
  const form = region.getByRole("form", { name: "匹配资料预览", exact: true });
  await expect(form).toBeVisible();
  await form.getByLabel("展示标题", { exact: true }).fill(title);
  await form.getByLabel("展示摘要", { exact: true }).fill(role === "client"
    ? "希望整理已批准的内部制度资料，建立清晰的知识分类和常见问题说明，让同事可以自行查找办理方式。"
    : "我负责整理内部制度资料和编写常见问题说明，能够提供脱敏的分类案例，帮助团队更方便地查找知识资料。");
  await form.getByRole("group", { name: "工作能力", exact: true }).getByRole("checkbox", { name: "知识库", exact: true }).check();
  await form.locator(".matching-panel__conditions > summary").click();
  if (role === "client") {
    await form.getByText("补充筛选条件与说明（选填）", { exact: true }).click();
    await form.getByRole("group", { name: "必须具备的能力", exact: true }).getByRole("checkbox", { name: "必须具备：知识库", exact: true }).check();
  }
  await form.getByLabel("工作方式", { exact: true }).selectOption("remote");
  await form.getByLabel("合作方式", { exact: true }).selectOption("project");
  await expect(form.getByRole("checkbox", { name: consentLabel, exact: true })).not.toBeChecked();
  return form;
}

async function publish(page: Page, form: Locator, editing = false) {
  await form.getByRole("checkbox", { name: consentLabel, exact: true }).check();
  const sent = page.waitForResponse((response) => response.url().endsWith(`${endpoint}/listing`) && response.request().method() === "PUT");
  await form.getByRole("button", { name: editing ? "确认更新匹配资料" : "确认发布并查看匹配", exact: true }).click();
  const response = await sent;
  expect(response.status()).toBe(200);
  const { listing } = await response.json() as { listing: Listing };
  expect(listing.active).toBe(true);
  return listing;
}

async function refreshResults(page: Page, role: Kind) {
  const sent = page.waitForResponse((response) => response.url().endsWith(`${endpoint}/results`) && response.request().method() === "GET");
  await matchingRegion(page, role).getByRole("button", { name: "刷新匹配结果", exact: true }).click();
  const response = await sent;
  expect(response.status()).toBe(200);
  return await response.json() as Results;
}

async function captureMatching(page: Page, region: Locator, testInfo: TestInfo, size: "desktop" | "mobile") {
  await region.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth)).toBe(true);
  for (const target of ["panel", "viewport"] as const) {
    const path = testInfo.outputPath(`matching-${size}-${target}.png`);
    // Element screenshots extend beyond the viewport; exclude the unrelated
    // fixed global header from this crop, and retain it in the viewport capture.
    if (target === "panel") await region.screenshot({ path, style: ".site-header { visibility: hidden !important; }" });
    else await page.screenshot({ path });
    await testInfo.attach(`matching-${size}-${target}`, { path, contentType: "image/png" });
  }
}

test("真实双端确认后明确发布才互相匹配，退出并刷新后不再展示", async ({ page, browser, environment, database }, testInfo) => {
  const talentContext = await browser.newContext({ baseURL: environment.webOrigin });
  const talentPage = await talentContext.newPage();
  const clientEmail = syntheticEmail("match-client");
  const talentEmail = syntheticEmail("match-talent");
  const clientTitle = "合成需求：内部知识资料整理";
  const talentTitle = "合成人才：知识资料整理协作者";
  try {
    await test.step("两端经邮箱验证和原发现对话确认，不自动发布", async () => {
      await authenticate(page, environment, { email: clientEmail, role: "client", returnTo: "/talent" });
      await confirmDiscovery(page, "client");
      await authenticate(talentPage, environment, { email: talentEmail, role: "talent", returnTo: "/projects" });
      await confirmDiscovery(talentPage, "talent");
      const unpublished = await page.request.get(`${endpoint}/results`);
      expect(unpublished.status()).toBe(409);
      expect((await unpublished.json()).error.code).toBe("MATCHING_NOT_PUBLISHED");
    });

    let clientListing!: Listing;
    let talentListing!: Listing;
    await test.step("预览及同意独立完成，未发布的人才不进入结果", async () => {
      const form = await preparePublication(page, "client", clientTitle);
      const before = await (await page.request.get(endpoint)).json() as State;
      expect(before.listing).toBeNull();
      clientListing = await publish(page, form);
      const beforeTalent = await (await page.request.get(`${endpoint}/results`)).json() as Results;
      expect(beforeTalent.matches).toEqual([]);
      talentListing = await publish(talentPage, await preparePublication(talentPage, "talent", talentTitle));
      await expect(matchingRegion(talentPage, "talent")).toContainText(clientTitle);
      const result = await refreshResults(page, "client");
      expect(result.matches.map((item) => item.listing.id)).toContain(talentListing.id);
      await expect(matchingRegion(page, "client")).toContainText(talentTitle);
      const serialized = JSON.stringify(result);
      for (const forbidden of [clientEmail, talentEmail, "ownerUserId", "sourceThreadId", "sourceThreadVersion", "attachments", "contact", "email"]) {
        expect(serialized).not.toContain(forbidden);
      }
      const stored = await database.query<{ provider: string }>(
        "SELECT t.provider FROM discovery_turns t JOIN discovery_threads d ON d.id=t.thread_id JOIN users u ON u.id=d.owner_user_id WHERE u.email=ANY($1::text[])",
        [[clientEmail, talentEmail]],
      );
      expect(stored.rows).toHaveLength(4);
      expect(stored.rows.every((row) => row.provider === "local")).toBe(true);
    });

    await test.step("桌面和390px保持可读且无水平溢出，保存匹配截图", async () => {
      await captureMatching(page, matchingRegion(page, "client"), testInfo, "desktop");
      await page.setViewportSize({ width: 390, height: 844 });
      await captureMatching(page, matchingRegion(page, "client"), testInfo, "mobile");
      await page.setViewportSize({ width: 1280, height: 720 });
    });

    await test.step("人才明确退出，双方刷新不再保留匹配结果", async () => {
      talentPage.once("dialog", (dialog) => dialog.accept());
      const withdrawn = talentPage.waitForResponse((response) => response.url().endsWith(`${endpoint}/withdraw`) && response.request().method() === "POST");
      await matchingRegion(talentPage, "talent").getByRole("button", { name: "退出匹配", exact: true }).click();
      expect((await withdrawn).status()).toBe(200);
      await expect(matchingRegion(talentPage, "talent")).not.toContainText(clientTitle);
      const result = await refreshResults(page, "client");
      expect(result.matches.some((item) => item.listing.id === talentListing.id)).toBe(false);
      await expect(matchingRegion(page, "client")).not.toContainText(talentTitle);
      await page.reload();
      await expect(matchingRegion(page, "client").getByRole("region", { name: "匹配结果", exact: true })).toHaveAttribute("aria-busy", "false");
      await expect(matchingRegion(page, "client")).not.toContainText(talentTitle);
      await talentPage.reload();
      await expect(matchingRegion(talentPage, "talent")).not.toContainText(clientTitle);
      const state = await (await talentPage.request.get(endpoint)).json() as State;
      expect(state.listing?.status).toBe("withdrawn");
      expect(state.listing?.active).toBe(false);
      expect((await talentPage.request.get(`${endpoint}/results`)).status()).toBe(409);
      expect((await (await page.request.get(endpoint)).json() as State).listing?.id).toBe(clientListing.id);
    });
  } finally { await talentContext.close(); }
});

test("双页发布冲突不覆盖新版本，继续原对话后旧发布保守暂停", async ({ page, environment }) => {
  await authenticate(page, environment, { email: syntheticEmail("match-cas"), role: "client", returnTo: "/talent" });
  await confirmDiscovery(page, "client");
  const initial = await publish(page, await preparePublication(page, "client", "合成需求：知识分类项目"));
  const stalePage = await page.context().newPage();
  let releaseStaleRequest = () => {};
  let releaseInitialState = () => {};
  try {
    const initialStateGate = new Promise<void>((resolve) => { releaseInitialState = resolve; });
    // Keep the first matching read pending so opening the edit form must wait
    // through a real loading state. Responses and server state remain genuine.
    await stalePage.route(`**${endpoint}`, async (route) => {
      await initialStateGate;
      await route.continue();
    });
    await stalePage.goto("/talent");
    const preparingStaleForm = preparePublication(stalePage, "client", "不应覆盖的新标题", true);
    void preparingStaleForm.catch(() => undefined);
    await expect(matchingRegion(stalePage, "client").getByText("正在读取匹配状态…", { exact: true })).toBeVisible();
    releaseInitialState();
    const staleForm = await preparingStaleForm;
    await stalePage.unroute(`**${endpoint}`);
    const requestGate = new Promise<void>((resolve) => { releaseStaleRequest = resolve; });
    let notifyRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => { notifyRequestStarted = resolve; });
    let staleRequest: { expectedListingVersion: number; expectedVersion: number; title: string } | undefined;
    let stalePutCount = 0;
    // Hold only this browser's real PUT until the other page saves. No response
    // or payload is mocked: the actual server must reject the original stale CAS.
    await stalePage.route(`**${endpoint}/listing`, async (route) => {
      stalePutCount += 1;
      staleRequest = route.request().postDataJSON() as typeof staleRequest;
      notifyRequestStarted();
      await requestGate;
      await route.continue();
    });
    await staleForm.getByRole("checkbox", { name: consentLabel, exact: true }).check();
    const rejectedPromise = stalePage.waitForResponse((response) => response.url().endsWith(`${endpoint}/listing`) && response.request().method() === "PUT");
    await staleForm.getByRole("button", { name: "确认更新匹配资料", exact: true }).click();
    await requestStarted;
    const updated = await publish(page, await preparePublication(page, "client", "已确认更新：制度知识分类", true), true);
    expect(updated.version).toBeGreaterThan(initial.version);
    const refreshed = stalePage.waitForResponse((response) => response.url().endsWith(endpoint) && response.request().method() === "GET");
    releaseStaleRequest();
    const rejected = await rejectedPromise;
    expect(rejected.status()).toBe(409);
    expect((await rejected.json()).error.code).toBe("MATCHING_VERSION_CONFLICT");
    expect(staleRequest?.expectedListingVersion).toBe(initial.version);
    expect(staleRequest?.title).toBe("不应覆盖的新标题");
    expect((await refreshed).status()).toBe(200);
    await expect(matchingRegion(stalePage, "client").getByRole("alert").filter({ hasText: "预览依据的版本已发生变化" })).toBeVisible();
    await expect(staleForm.getByLabel("展示标题", { exact: true })).toHaveValue("不应覆盖的新标题");
    await expect(staleForm.getByRole("checkbox", { name: consentLabel, exact: true })).not.toBeChecked();
    await expect(staleForm.getByRole("button", { name: "确认更新匹配资料", exact: true })).toBeDisabled();
    expect(stalePutCount).toBe(1);
    const current = await (await page.request.get(endpoint)).json() as State;
    expect(staleRequest?.expectedVersion).toBe(current.source?.version);
    expect(current.listing?.title).toBe("已确认更新：制度知识分类");
    expect(current.listing?.version).toBe(updated.version);
    await stalePage.unroute(`**${endpoint}/listing`);

    await sendDiscovery(page, "client", "这份需求说明怎么使用？");
    const paused = await (await page.request.get(endpoint)).json() as State;
    expect(paused.source?.version).toBeGreaterThan(current.source?.version ?? 0);
    expect(paused.listing?.status).toBe("published");
    expect(paused.listing?.active).toBe(false);
    const unavailable = await page.request.get(`${endpoint}/results`);
    expect(unavailable.status()).toBe(409);
    expect((await unavailable.json()).error.code).toBe("MATCHING_NOT_PUBLISHED");
    await page.reload();
    const restored = await (await page.request.get(endpoint)).json() as State;
    expect(restored.listing?.active).toBe(false);

    await test.step("工作台可退出已暂停的匹配，退出不删除原对话", async () => {
      await page.goto("/workspace");
      const region = matchingRegion(page, "client");
      await expect(region).toContainText("原展示版本已暂停匹配");
      const withdrawButton = region.getByRole("button", { name: "退出匹配", exact: true });
      await expect(withdrawButton).toBeEnabled();
      const discoveryBeforeResponse = await page.request.get("/api/v1/me/discovery");
      expect(discoveryBeforeResponse.status()).toBe(200);
      const discoveryBefore = await discoveryBeforeResponse.json();
      expect(discoveryBefore.discovery.threadId).toBe(restored.source?.threadId);
      expect(discoveryBefore.discovery.turns.length).toBeGreaterThan(0);
      page.once("dialog", (dialog) => dialog.accept());
      const withdrawnPromise = page.waitForResponse((response) => response.url().endsWith(`${endpoint}/withdraw`) && response.request().method() === "POST");
      await withdrawButton.click();
      const withdrawn = await withdrawnPromise;
      expect(withdrawn.status()).toBe(200);
      expect(withdrawn.request().postDataJSON()).toEqual({
        expectedListingId: restored.listing?.id,
        expectedListingVersion: restored.listing?.version,
      });
      await expect(region).toContainText("已退出匹配");
      await expect(withdrawButton).not.toBeVisible();
      const after = await (await page.request.get(endpoint)).json() as State;
      expect(after.listing?.status).toBe("withdrawn");
      expect(after.listing?.active).toBe(false);
      expect(after.source).toEqual(restored.source);
      const discoveryAfterResponse = await page.request.get("/api/v1/me/discovery");
      expect(discoveryAfterResponse.status()).toBe(200);
      expect(await discoveryAfterResponse.json()).toEqual(discoveryBefore);
    });
  } finally {
    releaseInitialState();
    releaseStaleRequest();
    await stalePage.close();
  }
});
