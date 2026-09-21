import { DEFAULT_QWEN_MODEL, readQwenBaseUrl } from "./config.js";

export const QWEN_DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

type QwenFailureCode = "authentication" | "rate_limit" | "unavailable" | "timeout" | "invalid_output";

export class QwenProviderError extends Error {
  constructor(readonly code: QwenFailureCode) {
    super(`Qwen provider ${code}.`);
    this.name = "QwenProviderError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readBoundedResponse(response: Response) {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new QwenProviderError("invalid_output");
  }
  if (!response.body) throw new QwenProviderError("invalid_output");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new QwenProviderError("invalid_output");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export type QwenClientOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImplementation?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/** Server-only Chat Completions transport. Never forwards provider errors or silently switches models/providers. */
export class QwenClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: QwenClientOptions) {
    if (!options.apiKey.trim() || /\s/u.test(options.apiKey)) throw new Error("Qwen API credentials are required and cannot contain whitespace.");
    this.model = options.model?.trim() || DEFAULT_QWEN_MODEL;
    if (!/^qwen[A-Za-z0-9._:-]{0,123}$/iu.test(this.model)) throw new Error("Qwen model identifier is invalid.");
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) {
      throw new Error("Qwen discovery timeout must be a positive integer.");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = readQwenBaseUrl(options.baseUrl);
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.timeoutMs = Math.min(options.timeoutMs ?? QWEN_DISCOVERY_TIMEOUT_MS, QWEN_DISCOVERY_TIMEOUT_MS);
  }

  async complete(input: { system: string; user: string }): Promise<{ text: string; model: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: `${input.system}\n只输出一个合法的 JSON 对象，不要添加 Markdown 标记。` },
            { role: "user", content: input.user },
          ],
          response_format: { type: "json_object" },
          enable_thinking: false,
          stream: false,
          temperature: 0.2,
          // qwen-plus supports max_tokens; max_completion_tokens requires newer model families.
          max_tokens: 4_000,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new QwenProviderError("authentication");
        if (response.status === 429) throw new QwenProviderError("rate_limit");
        throw new QwenProviderError("unavailable");
      }
      const responseText = await readBoundedResponse(response);
      let payload: unknown;
      try { payload = JSON.parse(responseText); } catch { throw new QwenProviderError("invalid_output"); }
      if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length !== 1) {
        throw new QwenProviderError("invalid_output");
      }
      const choice = payload.choices[0];
      if (!isRecord(choice) || choice.finish_reason !== "stop" || !isRecord(choice.message)
        || choice.message.role !== "assistant" || choice.message.refusal || choice.message.tool_calls
        || typeof choice.message.content !== "string" || !choice.message.content.trim()) {
        throw new QwenProviderError("invalid_output");
      }
      const model = typeof payload.model === "string" && /^qwen[A-Za-z0-9._:-]{0,123}$/iu.test(payload.model) ? payload.model : this.model;
      return { text: choice.message.content, model };
    } catch (error) {
      if (controller.signal.aborted) throw new QwenProviderError("timeout");
      if (error instanceof QwenProviderError) throw error;
      // Do not retain a cause: network errors may include credentials, request content, or provider bodies.
      throw new QwenProviderError("unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }
}
