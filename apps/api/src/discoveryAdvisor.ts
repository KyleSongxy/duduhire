import { DEFAULT_QWEN_MODEL, OFFICIAL_OPENAI_BASE_URL, type AppConfig } from "./config.js";
import { runDiscoveryFlow, type DiscoveryFlowAdvice, type DiscoveryFlowInput, type FlowArtifact } from "./discoveryFlow.js";
import { QwenClient, type QwenClientOptions } from "./qwenClient.js";

export type { DiscoveryKind } from "./domain.js";
export type DiscoveryArtifact = FlowArtifact;
export type DiscoveryAdvice = DiscoveryFlowAdvice;
export type DiscoveryAdvisorInput = DiscoveryFlowInput;

export interface DiscoveryAdvisor {
  advise(input: DiscoveryAdvisorInput): Promise<DiscoveryAdvice>;
}

export const DISCOVERY_PROMPT_VERSION = "duduhire.discovery.v2.1";
export const OPENAI_DISCOVERY_TIMEOUT_MS = 30_000;

export class LocalDiscoveryAdvisor implements DiscoveryAdvisor {
  advise(input: DiscoveryAdvisorInput): Promise<DiscoveryAdvice> {
    return runDiscoveryFlow(input, undefined, {
      provider: "local", model: "duduhire-local-flow-v2.1", promptVersion: DISCOVERY_PROMPT_VERSION,
    });
  }
}

export type QwenDiscoveryAdvisorOptions = QwenClientOptions;

export class QwenDiscoveryAdvisor implements DiscoveryAdvisor {
  private readonly client: QwenClient;
  private readonly model: string;

  constructor(options: QwenDiscoveryAdvisorOptions) {
    this.client = new QwenClient(options);
    this.model = options.model?.trim() || DEFAULT_QWEN_MODEL;
  }

  advise(input: DiscoveryAdvisorInput): Promise<DiscoveryAdvice> {
    return runDiscoveryFlow(input, async (request) => (await this.client.complete(request)).text, {
      provider: "qwen", model: this.model, promptVersion: DISCOVERY_PROMPT_VERSION,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractOpenAiText(payload: unknown) {
  if (!isRecord(payload) || payload.status !== "completed" || !Array.isArray(payload.output)) {
    throw new Error("AI provider did not complete the discovery response.");
  }
  const texts: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content)) continue;
      if (content.type === "refusal") throw new Error("AI provider refused the discovery response.");
      if (content.type === "output_text" && typeof content.text === "string") texts.push(content.text);
    }
  }
  if (texts.length !== 1 || !texts[0]?.trim()) throw new Error("AI provider returned an unexpected number of outputs.");
  return texts[0];
}

export type OpenAiDiscoveryAdvisorOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImplementation?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/** Compatibility for existing deployments; Qwen is the default production provider. */
export class OpenAiDiscoveryAdvisor implements DiscoveryAdvisor {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAiDiscoveryAdvisorOptions) {
    if (options.baseUrl && options.baseUrl.replace(/\/+$/u, "") !== OFFICIAL_OPENAI_BASE_URL) {
      throw new Error(`OpenAI discovery requests must use ${OFFICIAL_OPENAI_BASE_URL}.`);
    }
    if (!options.apiKey || /\s/u.test(options.apiKey) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.model)) {
      throw new Error("OpenAI discovery credentials and model are required.");
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) {
      throw new Error("OpenAI discovery timeout must be a positive integer.");
    }
    this.timeoutMs = Math.min(options.timeoutMs ?? OPENAI_DISCOVERY_TIMEOUT_MS, OPENAI_DISCOVERY_TIMEOUT_MS);
  }

  private async complete(input: { system: string; user: string }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(`${OFFICIAL_OPENAI_BASE_URL}/responses`, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          store: false,
          instructions: `${input.system}\n只输出一个合法的 JSON 对象。`,
          input: [{ role: "user", content: [{ type: "input_text", text: input.user }] }],
          max_output_tokens: 4_000,
          text: { format: { type: "json_object" } },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("AI provider request failed.");
      }
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (!response.body || (Number.isFinite(contentLength) && contentLength > 256 * 1024)) {
        await response.body?.cancel();
        throw new Error("AI provider response exceeded the maximum size.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let responseText = "";
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 256 * 1024) {
            await reader.cancel();
            throw new Error("AI provider response exceeded the maximum size.");
          }
          responseText += decoder.decode(chunk.value, { stream: true });
        }
        responseText += decoder.decode();
      } finally { reader.releaseLock(); }
      return extractOpenAiText(JSON.parse(responseText) as unknown);
    } catch {
      if (controller.signal.aborted) throw new Error("AI provider request timed out.");
      // Raw provider failures can contain private input or credentials and must not enter application logs.
      throw new Error("AI provider request failed or returned invalid output.");
    } finally { clearTimeout(timeout); }
  }

  advise(input: DiscoveryAdvisorInput): Promise<DiscoveryAdvice> {
    return runDiscoveryFlow(input, (request) => this.complete(request), {
      provider: "openai", model: this.model, promptVersion: DISCOVERY_PROMPT_VERSION,
    });
  }
}

export function createDiscoveryAdvisor(config: Pick<AppConfig,
  "aiMode" | "openAiApiKey" | "openAiModel" | "openAiBaseUrl" | "qwenApiKey" | "qwenModel" | "qwenBaseUrl"
>): DiscoveryAdvisor {
  if (config.aiMode === "local") return new LocalDiscoveryAdvisor();
  if (config.aiMode === "qwen") {
    if (!config.qwenApiKey) throw new Error("Qwen discovery configuration is incomplete.");
    return new QwenDiscoveryAdvisor({ apiKey: config.qwenApiKey, model: config.qwenModel, baseUrl: config.qwenBaseUrl });
  }
  if (config.aiMode !== "openai" || !config.openAiApiKey || !config.openAiModel) {
    throw new Error("OpenAI discovery configuration is incomplete.");
  }
  return new OpenAiDiscoveryAdvisor({ apiKey: config.openAiApiKey, model: config.openAiModel, baseUrl: config.openAiBaseUrl });
}
