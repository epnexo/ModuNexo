/**
 * How a module's code asks a language model. The endpoint, the key and the model are the module's own settings, named in
 * its manifest under `llm`; the platform reads them on every call, speaks the OpenAI-compatible wire format and keeps the
 * key out of logs, errors and results. Like jobs, events and files, the client is reached through a global symbol that the
 * platform registers (the web app and the worker do), so the SDK holds no HTTP code and every copy of it finds the same one.
 */
export const LLM_CLIENT: unique symbol = Symbol.for("modunexo.llm.client") as never;

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  /** Non-empty text. */
  content: string;
}

export interface ChatRequest {
  /** 1 to 200 messages, at most 200,000 characters in all. */
  messages: ChatMessage[];
  /** Overrides the module's model setting for this call. */
  model?: string;
  /** 0 to 2. */
  temperature?: number;
  /** A whole number from 1 to 32768. */
  maxTokens?: number;
  /** Ends the call sooner than the platform's own 60 s limit. */
  signal?: AbortSignal;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  /** The model that answered, as the provider reports it. */
  model: string;
  finishReason: string | null;
  usage: ChatUsage | null;
}

export interface LlmProbeResult {
  /** The base URL the call went to, as the platform validated it: no user name, query or fragment. */
  endpoint: string;
  /** How long the provider took to list its models, in milliseconds. */
  latencyMs: number;
  /** Up to 50 model ids the provider lists. */
  models: string[];
  /** The module's configured model, or null when it has none. */
  model: string | null;
  /** Whether the configured model is in the list; null when there is no configured model or the list was not readable. */
  modelAvailable: boolean | null;
}

export type LlmErrorCode =
  | "not_configured"
  | "invalid_request"
  | "unreachable"
  | "timeout"
  | "unauthorized"
  | "rejected"
  | "rate_limited"
  | "bad_response"
  | "too_large";

/** Marks an error as an `LlmError` whichever copy of the SDK made it. */
const LLM_ERROR: unique symbol = Symbol.for("modunexo.llm.error") as never;

/**
 * What the platform raises when a call cannot be made or the provider refuses it. `code` says which; the message never
 * holds the key. A bundler may load the SDK more than once, so the platform and a module can hold different copies of this
 * class: `instanceof` therefore looks for the mark every copy puts on its errors, not for the class it was made from.
 */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly [LLM_ERROR] = true;

  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { [LLM_ERROR]?: unknown })[LLM_ERROR] === true;
  }
}

export interface LlmClient {
  chat(moduleId: string, request: ChatRequest): Promise<ChatResult>;
  probe(moduleId: string): Promise<LlmProbeResult>;
}

/** A model call ran where the platform has not registered a client: a script, a test, a build step. */
export class LlmUnavailableError extends Error {
  constructor() {
    super("a model can only be called while the platform is running: no llm client is registered in this process");
    this.name = "LlmUnavailableError";
  }
}

function client(): LlmClient {
  const found = (globalThis as typeof globalThis & { [LLM_CLIENT]?: LlmClient })[LLM_CLIENT];
  if (found === undefined) throw new LlmUnavailableError();
  return found;
}

/**
 * Ask the module's configured model for a reply. The module must declare `llm` in its manifest and be enabled, and its
 * base URL setting must be set. Rejects with an `LlmError` whose `code` says what went wrong.
 */
export async function chat(moduleId: string, request: ChatRequest): Promise<ChatResult> {
  return client().chat(moduleId, request);
}

/** Check the module's model settings by asking the provider for its models. Rejects with an `LlmError` when it cannot. */
export async function probeLlm(moduleId: string): Promise<LlmProbeResult> {
  return client().probe(moduleId);
}
