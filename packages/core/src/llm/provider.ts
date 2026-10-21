import { type ChatMessage, type ChatResult, type ChatUsage, LlmError } from "@modunexo/sdk";

/** How long a call may take before the platform gives up on the provider. */
export const LLM_TIMEOUT_MS = 60_000;
/** The most the platform reads from a reply. */
export const LLM_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** What of an error text from the provider is passed on. */
const MAX_PROVIDER_TEXT = 200;
/** Enough of an error body to find its message in. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_MODEL_IDS = 2000;

/**
 * A provider's base URL as the platform will use it: `http` or `https`, with no user name or password, no query and no
 * fragment, and without a trailing slash. Throws an `Error` that says what is wrong.
 */
export function parseBaseUrl(value: string): string {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("must be an http or https URL");
  if (url.username !== "" || url.password !== "") throw new Error("must be a URL without a user name or password");
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(text)) throw new Error("must be a URL without a query or a fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export interface ProviderChatInput {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

/** What the platform needs from a model provider; another wire format is another implementation of this. */
export interface LlmProvider {
  chat(input: ProviderChatInput, signal?: AbortSignal): Promise<ChatResult>;
  /** Every model id the provider lists (up to 2000). */
  models(signal?: AbortSignal): Promise<string[]>;
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  /** Sent as `Authorization: Bearer`; null for a server that needs none. */
  apiKey: string | null;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * The OpenAI wire format (`/chat/completions`, `/models`) that most providers and local servers speak. It follows no
 * redirect, reads a bounded reply, and keeps the key out of every message it raises.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly base: string;
  private readonly origin: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    try {
      this.base = parseBaseUrl(options.baseUrl);
    } catch (error) {
      throw new LlmError("not_configured", `the base URL ${(error as Error).message}`);
    }
    this.origin = new URL(this.base).origin;
    this.apiKey = options.apiKey === null || options.apiKey === "" ? null : options.apiKey;
    this.timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? LLM_MAX_RESPONSE_BYTES;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async chat(input: ProviderChatInput, signal?: AbortSignal): Promise<ChatResult> {
    const body: Record<string, unknown> = { model: input.model, messages: input.messages, stream: false };
    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
    const data = await this.request("POST", "/chat/completions", body, signal);
    const choice = isObject(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
    const message = isObject(choice) ? choice.message : undefined;
    if (!isObject(message) || typeof message.content !== "string") {
      throw new LlmError("bad_response", "the provider's reply holds no text (choices[0].message.content)");
    }
    const answered = isObject(data) && typeof data.model === "string" && data.model !== "" ? data.model : input.model;
    return {
      content: message.content,
      model: answered,
      finishReason: isObject(choice) && typeof choice.finish_reason === "string" ? choice.finish_reason : null,
      usage: isObject(data) ? this.usageOf(data.usage) : null,
    };
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    const data = await this.request("GET", "/models", undefined, signal);
    if (!isObject(data) || !Array.isArray(data.data)) throw new LlmError("bad_response", "the provider's reply is not a list of models (data[])");
    const ids: string[] = [];
    for (const entry of data.data) {
      if (isObject(entry) && typeof entry.id === "string" && entry.id !== "") ids.push(entry.id);
      if (ids.length >= MAX_MODEL_IDS) break;
    }
    return ids;
  }

  private usageOf(usage: unknown): ChatUsage | null {
    if (!isObject(usage) || !count(usage.prompt_tokens) || !count(usage.completion_tokens)) return null;
    const total = count(usage.total_tokens) ? usage.total_tokens : usage.prompt_tokens + usage.completion_tokens;
    return { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: total };
  }

  /** Text for a message: the key removed first, so a cut cannot leave half of it behind. */
  private clean(text: string): string {
    const scrubbed = this.apiKey === null ? text : text.split(this.apiKey).join("[redacted]");
    return scrubbed.replace(/\s+/g, " ").trim().slice(0, MAX_PROVIDER_TEXT);
  }

  /** What went wrong on the way, as the error the caller gets: its own abort stays an abort. */
  private networkError(error: unknown, caller: AbortSignal | undefined, timeout: AbortSignal): unknown {
    if (caller?.aborted === true) return caller.reason instanceof Error ? caller.reason : new DOMException("This operation was aborted", "AbortError");
    if (timeout.aborted) return new LlmError("timeout", `the model did not answer within ${this.timeoutMs / 1000} s`);
    if (error instanceof LlmError) return error;
    const cause = error instanceof Error ? (error.cause as { code?: string; message?: string } | undefined) : undefined;
    const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
    return new LlmError("unreachable", this.clean(`could not reach ${this.origin}: ${detail}`));
  }

  /** The reply's bytes, never more than `limit`; `null` when there are more. */
  private async read(response: Response, limit: number): Promise<Uint8Array | null> {
    if (response.body === null) return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) return null;
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks);
  }

  private async request(method: "GET" | "POST", path: string, body: unknown, caller?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey !== null) headers.authorization = `Bearer ${this.apiKey}`;
    try {
      const response = await this.fetchImpl(`${this.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal });
      return await this.interpret(response);
    } catch (error) {
      throw this.networkError(error, caller, timeout);
    }
  }

  private async interpret(response: Response): Promise<unknown> {
    const status = response.status;
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new LlmError("rejected", `the provider answered with a redirect (HTTP ${status}); redirects are not followed, so the key cannot leave the configured host`);
    }
    if (status < 200 || status >= 300) throw await this.refusal(response);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new LlmError("too_large", `the provider's reply is over ${this.maxResponseBytes} bytes`);
    }
    const bytes = await this.read(response, this.maxResponseBytes);
    if (bytes === null) throw new LlmError("too_large", `the provider's reply is over ${this.maxResponseBytes} bytes`);
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch {
      throw new LlmError("bad_response", "the provider's reply is not JSON");
    }
  }

  private async refusal(response: Response): Promise<LlmError> {
    const status = response.status;
    const bytes = await this.read(response, MAX_ERROR_BODY_BYTES).catch(() => null);
    const text = bytes === null ? "" : Buffer.from(bytes).toString("utf8");
    let said = text;
    try {
      const parsed = JSON.parse(text) as unknown;
      const error = isObject(parsed) ? parsed.error : undefined;
      if (isObject(error) && typeof error.message === "string") said = error.message;
      else if (typeof error === "string") said = error;
      else if (isObject(parsed) && typeof parsed.message === "string") said = parsed.message;
    } catch {
      // not JSON: the text itself stands in
    }
    const cleaned = this.clean(said.startsWith("<") ? "" : said);
    const message = `the provider answered HTTP ${status}${cleaned === "" ? "" : `: ${cleaned}`}`;
    const code = status === 401 || status === 403 ? "unauthorized" : status === 429 ? "rate_limited" : status === 408 ? "timeout" : "rejected";
    return new LlmError(code, message);
  }
}
