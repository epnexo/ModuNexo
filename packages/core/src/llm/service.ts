import type pg from "pg";
import { type ChatRequest, type ChatResult, type LlmClient, type LlmDeclaration, LlmError, type LlmProbeResult, type SettingValue } from "@modunexo/sdk";
import { resolveMasterKey } from "../auth/master-key.ts";
import type { Registry } from "../registry.ts";
import { SettingsService } from "../settings/service.ts";
import { type LlmProvider, OpenAiCompatibleProvider, parseBaseUrl } from "./provider.ts";

export const MAX_MESSAGES = 200;
export const MAX_PROMPT_CHARS = 200_000;
export const MAX_COMPLETION_TOKENS = 32_768;
export const MAX_MODEL_NAME_CHARS = 200;
/** How many model ids a probe returns. */
export const MAX_PROBE_MODELS = 50;
const ROLES = new Set(["system", "user", "assistant"]);

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string | null;
}

export interface LlmServiceOptions {
  /** Reads a module's setting, a secret decrypted. Default: the settings store, with the master key from the environment. */
  settings?: (moduleId: string, key: string) => Promise<SettingValue | null>;
  /** Builds the provider for a configuration. Default: the OpenAI-compatible one. */
  provider?: (config: ProviderConfig) => LlmProvider;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What a chat request must be before the platform spends a network call on it. */
function checkRequest(request: unknown): ChatRequest {
  const refuse = (why: string): never => {
    throw new LlmError("invalid_request", why);
  };
  if (!isObject(request)) return refuse("the request must be an object with a list of messages");
  const { messages, model, temperature, maxTokens } = request;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) return refuse(`messages must be a list of 1 to ${MAX_MESSAGES} messages`);
  let characters = 0;
  messages.forEach((message: unknown, index) => {
    if (!isObject(message) || typeof message.role !== "string" || !ROLES.has(message.role)) refuse(`messages[${index}].role must be system, user or assistant`);
    const content = (message as Record<string, unknown>).content;
    if (typeof content !== "string" || content === "") refuse(`messages[${index}].content must be a non-empty string`);
    characters += (content as string).length;
  });
  if (characters > MAX_PROMPT_CHARS) return refuse(`the messages hold ${characters} characters; the limit is ${MAX_PROMPT_CHARS}`);
  if (model !== undefined && (typeof model !== "string" || model.length < 1 || model.length > MAX_MODEL_NAME_CHARS || /[\u0000-\u001f\u007f]/.test(model))) {
    return refuse(`model must be a name of 1 to ${MAX_MODEL_NAME_CHARS} characters without control characters`);
  }
  if (temperature !== undefined && (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) return refuse("temperature must be a number from 0 to 2");
  if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_COMPLETION_TOKENS)) {
    return refuse(`maxTokens must be a whole number from 1 to ${MAX_COMPLETION_TOKENS}`);
  }
  return request as unknown as ChatRequest;
}

/**
 * The platform side of the model API: finds the module's endpoint, key and model in its settings, asks the provider and
 * hands back the reply. The settings are read on every call, so a change on the settings screen applies at once.
 */
export class LlmService implements LlmClient {
  private readonly readSetting: (moduleId: string, key: string) => Promise<SettingValue | null>;
  private readonly makeProvider: (config: ProviderConfig) => LlmProvider;

  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: Registry,
    options: LlmServiceOptions = {},
  ) {
    this.readSetting = options.settings ?? ((moduleId, key) => new SettingsService(pool, registry, { masterKey: resolveMasterKey() }).get(moduleId, key));
    this.makeProvider = options.provider ?? ((config) => new OpenAiCompatibleProvider(config));
  }

  async chat(moduleId: string, request: ChatRequest): Promise<ChatResult> {
    const declaration = await this.declaration(moduleId);
    const checked = checkRequest(request);
    const { provider, model } = await this.connect(moduleId, declaration);
    const chosen = checked.model ?? model;
    if (chosen === null) {
      throw new LlmError(
        "not_configured",
        declaration.modelSetting === undefined ? `module "${moduleId}" names no model setting: pass "model" in the request` : `set the setting "${declaration.modelSetting}" of module "${moduleId}" to a model, or pass "model" in the request`,
      );
    }
    return provider.chat(
      {
        model: chosen,
        messages: checked.messages,
        ...(checked.temperature === undefined ? {} : { temperature: checked.temperature }),
        ...(checked.maxTokens === undefined ? {} : { maxTokens: checked.maxTokens }),
      },
      checked.signal,
    );
  }

  async probe(moduleId: string): Promise<LlmProbeResult> {
    const declaration = await this.declaration(moduleId);
    const { provider, model } = await this.connect(moduleId, declaration);
    const started = performance.now();
    const ids = await provider.models();
    const latencyMs = Math.round(performance.now() - started);
    return { latencyMs, models: ids.slice(0, MAX_PROBE_MODELS), model, modelAvailable: model === null ? null : ids.includes(model) };
  }

  private async declaration(moduleId: string): Promise<LlmDeclaration> {
    const manifest = this.registry.get(moduleId);
    if (manifest === undefined) throw new LlmError("not_configured", `module "${moduleId}" is not registered`);
    if (manifest.llm === undefined) throw new LlmError("not_configured", `module "${moduleId}" does not declare llm`);
    const enabled = await this.pool.query("select 1 from core.modules where id = $1 and state = 'enabled'", [moduleId]);
    if (enabled.rowCount === 0) throw new LlmError("not_configured", `module "${moduleId}" is not enabled`);
    return manifest.llm;
  }

  /** A setting as text: unset, blank or not text is null. Failures to read it become a message that says what to do. */
  private async text(moduleId: string, key: string): Promise<string | null> {
    let value: SettingValue | null;
    try {
      value = await this.readSetting(moduleId, key);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "SecretUnreadableError") throw new LlmError("not_configured", `the stored value of "${key}" of module "${moduleId}" cannot be read (the master key changed): set it again`);
      if (name === "MasterKeyError" && error instanceof Error) throw new LlmError("not_configured", error.message);
      throw error;
    }
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  }

  private async connect(moduleId: string, declaration: LlmDeclaration): Promise<{ provider: LlmProvider; model: string | null }> {
    const raw = await this.text(moduleId, declaration.baseUrlSetting);
    if (raw === null) throw new LlmError("not_configured", `set the setting "${declaration.baseUrlSetting}" of module "${moduleId}" to the provider's base URL`);
    let baseUrl: string;
    try {
      baseUrl = parseBaseUrl(raw);
    } catch (error) {
      throw new LlmError("not_configured", `the setting "${declaration.baseUrlSetting}" of module "${moduleId}" ${(error as Error).message}`);
    }
    const apiKey = declaration.apiKeySetting === undefined ? null : await this.text(moduleId, declaration.apiKeySetting);
    const model = declaration.modelSetting === undefined ? null : await this.text(moduleId, declaration.modelSetting);
    return { provider: this.makeProvider({ baseUrl, apiKey }), model };
  }
}
