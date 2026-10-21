# Feature: LLM provider adapter (ADR-001, capability 6)

Objective: a module calls a chat model through the SDK without holding any HTTP, key or provider code; the endpoint, the key and the model are the module's own settings (the key a secret), the wire format is OpenAI-compatible, and a probe says whether the configuration works.
Branch: feat/llm-adapter (from main e1b350e). Delivery strategy: ask-on-risk; the owner wants only `main` on GitHub, so the branch stays local and is fast-forwarded into `main`; no push without the owner. Test runner: `npm test` (node:test via tsx), `npm run typecheck`.

## Specs

- S1. Manifest: `llm: { baseUrlSetting, apiKeySetting?, modelSetting? }` opts the module in. Each value names a setting the
  module declares: `baseUrlSetting` a `string`, `apiKeySetting` a `secret`, `modelSetting` a `string` or `select`. Unknown fields
  are refused. A module without `llm` cannot call a model. [decision]
- S2. Configuration comes from those settings, read at every call (the same secret store as any setting, decrypted only in the
  process): the base URL is required (`not_configured`, naming the setting, when it is unset); the key is optional (a local
  server needs none) and is sent as `Authorization: Bearer <key>`; the model is the default of a call, which may name another.
  [decision]
- S3. Chat: the SDK exports `chat(moduleId, { messages, model?, temperature?, maxTokens?, signal? })`, resolving to
  `{ content, model, finishReason, usage }` (`usage` is `{ promptTokens, completionTokens, totalTokens }` or null). `messages`
  holds 1 to 200 items with a role of `system`, `user` or `assistant` and a non-empty string `content`, at most 200,000
  characters in all; `temperature` is 0 to 2; `maxTokens` is a whole number 1 to 32768. The platform POSTs JSON to
  `<base URL>/chat/completions` with `stream: false` and reads `choices[0].message.content`. [decision]
- S4. Probe: `probeLlm(moduleId)` does `GET <base URL>/models` and resolves to `{ latencyMs, models, model, modelAvailable }`
  (at most 50 model ids; `modelAvailable` is true or false when a model is configured, else null). The CLI has
  `llm probe <module>`; a refusal exits 3, a usage error 2. [decision]
- S5. Safety of the call: the base URL must be `http:` or `https:`, with no user name or password, no query and no fragment;
  a redirect is never followed (a 3xx is an error, so the key cannot be sent to another host); the call times out after 60 s
  (a `signal` can end it sooner); the reply is read up to 2 MiB; the key never appears in a log, an error message or a result;
  text the provider returned in an error is cut to 200 characters and has the key removed. [decision]
- S6. Errors: the SDK exports `LlmError` with a `code` of `not_configured`, `invalid_request`, `unreachable`, `timeout`,
  `unauthorized`, `rejected`, `rate_limited`, `bad_response` or `too_large`; `invalid_request` is raised before any network
  call. [decision]
- S7. The service is registered in the web app and in the worker (through `registerModuleRuntime`), so a route and a job call it
  the same way. [decision]
- S8. The install review lists the module's model settings; README, the module skill and an ADR note describe it.
- Not in this feature (follow-ups): streaming; tools or function calling; embeddings; images; retries with backoff; a usage or
  cost log and per-module quotas; more than one provider per module; an adapter for a provider that is not OpenAI-compatible
  (the provider is behind a small interface, so one can be added).

## Tasks

- [x] T1 (S1, S3, S4, S6 SDK side) manifest `llm`, `llm.ts` (types, symbol, `LlmError`, `chat`, `probeLlm`). Route: inline. Commit: next commit (RED observed; SDK 124/124)
- [ ] T2 (S2, S3, S4, S5, S6) OpenAI-compatible provider, `LlmService`, tests against a local HTTP server. Route: inline.
- [ ] T3 (S4 CLI, S7, S8 review) register in web and worker, `llm probe`, install review. Route: inline.
- [ ] T4 (S8 docs) README, skill, ADR; full suite; independent verifier. Route: inline then verifier.

## Log

- L1 (2026-10-21, user, verbatim): "si sigamos"
- L2: Route declaration: all tasks inline; no writer trigger (tasks share SDK, core, CLI and web files). No mapping trigger: the
  settings contract, the runtime registration and the CLI wiring were read for the previous three features. Risk: security
  (item 2: a stored secret is read and sent to a configured host, so a redirect, a log line or an error could leak it) and
  contracts others consume (an outbound network call made on behalf of module code), so an independent verifier runs at the end.
- L3: Decisions taken without asking, per the standing instruction: OpenAI-compatible only (it also covers local servers such as
  Ollama, vLLM or LM Studio), configured through the module's own settings so the existing settings screen is the
  configuration screen and no new storage is needed; private and loopback addresses are allowed on purpose (a local model is the
  main use) because the URL is set by an administrator, not by a caller; `LlmError` lives in the SDK so a module can catch it with
  `instanceof` across the globalThis boundary; no database table (no usage log yet).
