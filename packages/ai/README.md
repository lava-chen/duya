# `@duya/ai` — Wire protocol + family wrapper + provider catalog

> Plan 451. The single source of truth for every LLM duya talks to.

## Three-layer architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Provider catalog  (src/providers/<name>.ts)          │  ← 13-line
│   id, baseUrl, auth, models, optional wrappers      │     thin
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Family wrappers  (src/providers/wrappers/<family>-*.ts)        │
│   (ProviderStreams) → ProviderStreams                          │
│   request-side transforms + response-side observation         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Wire protocol  (src/api/<protocol>.ts)                          │
│   HTTP / SSE / JSON / auth / tool-call shape                   │
│   emits AssistantMessageEvent → emitSSE → SSEEvent             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Shared utilities  (src/utils/)                                  │
│   errors / retry / json-repair / usage / think-tag-parser      │
└─────────────────────────────────────────────────────────────────┘
```

| Layer | Count today | Files |
|---|---|---|
| Wire protocols | 6 (+1 stub) | `anthropic-messages.ts`, `openai-completions.ts`, `openai-responses.ts`, `ollama-chat.ts`, `bedrock-converse.ts`, `google-generative-ai.ts` (+ `vertex` lands P5) |
| Wrappers | 2 + 1 utility | `compose.ts` + `anthropic-family-{tool-payload-compat,thinking-replay,cache-control}.ts` (+ `openai-family-*` lands P4) |
| Providers | 17 | `anthropic`, `openai`, `openrouter`, `ollama`, `deepseek`, `qwen`, `glm`, `kimi`, `xai`, `stepfun`, `volcengine`, `bailian`, `minimax`, `minimax-cn`, `bedrock`, `google` |

## Conventions

### `pipe(base, ...wrappers)` order

The LAST wrapper in the argument list sits at the OUTERMOST layer:

```
pipe(base, w1, w2, w3) === w3(w2(w1(base)))
```

Standard middleware order — request enters w3 first, events exit w3 last.

### Auto-injection from `ModelCompat`

`createProvider` consults each model's `compat` flags at stream-call time and
appends the right wrapper. Provider authors can ALWAYS override by listing
their own wrappers first.

| `compat` field | Auto-injected wrapper |
|---|---|
| `toolResultTransport: 'text-user-message' \| 'none'` | `anthropicFamilyToolPayloadCompat` |
| `forceAdaptiveThinking: true` | `anthropicFamilyThinkingReplay` (response-side observer) |

Future mappings (Phase 3+): `supportsToolReferences`, `supportsThinkingTokenBudget`, `openAIThinkingFormat`, …

### `AssistantMessageEvent` ↔ `SSEEvent` boundary

Wire-protocol files yield internal `AssistantMessageEvent`s. `emit-sse.ts` is
the **only** place where the two event systems meet. Consumers (DuyaAgent,
agent-process-entry) only ever see `SSEEvent`.

## How to add a new provider (5 steps)

### Step 1 — Decide the wire protocol

Look at the provider's API. Pick ONE of:

- `'anthropic'` — Anthropic Messages API or compatible (Claude, GLM-Anthropic, etc.)
- `'openai-chat'` — OpenAI Chat Completions or compatible (DeepSeek, vLLM, OpenRouter, Moonshot/Kimi, Ollama with `/v1`)
- `'openai-responses'` — OpenAI Responses API (Codex, GPT-5 family)
- `'gemini'` — Google GenerativeLanguage `streamGenerateContent`
- `'bedrock'` — AWS Bedrock ConverseStream
- `'ollama'` — Ollama native `/api/chat`
- New protocol? See "How to add a new wire protocol" below.

### Step 2 — Pick / write the wire-protocol adapter

Existing adapters live in `src/api/`. Each exposes:

```ts
export function createXClient(options: AIClientOptions): AIClient
```

If your provider fits one of the existing adapters, write a thin preset
(`createProvider({ api: xStreams(...) })`). If your provider's protocol is
genuinely different (different SSE event names, different tool-call shape,
different auth header), add a new adapter — see "How to add a new wire protocol".

### Step 3 — Wire it in `src/providers/adapters.ts`

Add an `xStreams(options): ProviderStreams<'x'>` function that wraps the
new adapter via `fromClient(...)`. Export it.

### Step 4 — Write the provider preset + model catalog

Two thin files:

```
src/providers/<id>.ts          ← createProvider({ id, baseUrl, auth, models, api })
src/providers/<id>.models.ts   ← export const <id>Models: Model<'x'>[] = [ … ]
```

Then register in `src/providers/all.ts` (append to `allProviders`) and
re-export the model array from `src/providers/index.ts` (add to
`allProviderModels`). Auth resolvers live in `src/auth/helpers.ts`.

### Step 5 — Tests

- `test/api/<protocol>.test.ts` — protocol-level unit tests with mocked fetch.
- `test/providers/catalog-catalogs.test.ts` — catalog registration assertions.

## How to add a new wire protocol

(Only when Step 1 produces a new protocol that's not already supported.)

1. Create `src/api/<protocol>.ts` — exports `createXClient(options: AIClientOptions): AIClient`. The client's `streamChat` yields `SSEEvent`s (use `emitSSE` to downgrade internal `AssistantMessageEvent`s).
2. Add the protocol to the `ApiFormat` union in `src/types.ts`.
3. Add the adapter to `src/providers/adapters.ts` and re-export from `src/providers/index.ts`.
4. Update `src/runtime-adapter.ts` `inferApiFormatFromLegacyProviderType` if the provider has a legacy type entry.
5. Update existing `runtime-adapter.test.ts` expectations for the new mapping.
6. End-to-end tests with mocked fetch (see `test/api/bedrock-converse.test.ts` for the pattern).

## How to add a family wrapper

(For per-provider quirks that don't belong in the wire protocol.)

1. Decide the wrapper shape:
   - **Stream wrapper**: `(ProviderStreams) => ProviderStreams`. Use when the
     transformation is at the `Message[]` or `SSEEvent` layer (request body
     text, response event shape).
   - **Wire-payload wrapper**: needs the `onPayload` hook (not yet in
     ProviderStreams; lands Phase 3+). Use when the transformation is on the
     HTTP wire (e.g. cache_control breakpoints in Anthropic MessageParam[]).
   - **Utility module** (re-export only): use when the decision logic is
     worth testing but the application is wire-payload-only.

2. Write `src/providers/wrappers/<family>-<aspect>.ts` exporting the wrapper
   function plus any pure helpers.

3. Register the compat → wrapper mapping in `src/providers/wrappers/compat-injection.ts`.

4. Re-export from `src/providers/wrappers/index.ts`.

5. Tests: `test/wrappers/<family>-<aspect>.test.ts`.

## API surface

```ts
// Wire-protocol adapter constructor (each api/*.ts)
export function createAnthropicClient(opts: AIClientOptions): AIClient
export function createOpenAICompletionsClient(opts: AIClientOptions): AIClient
export function createOpenAIResponsesClient(opts: AIClientOptions): AIClient
export function createBedrockConverseClient(opts: BedrockConverseClientOptions): AIClient
export function createGoogleGenerativeAiClient(opts: GoogleGenerativeAiClientOptions): AIClient
// …

// Provider factory
export function createProvider<TApi extends ApiFormat>(opts: {
  id: string;
  name?: string;
  baseUrl?: string;
  auth: ProviderAuthConfig;
  models: readonly Model<TApi>[];
  api: ProviderApi<TApi>;
  wrappers?: Wrapper[];      // explicit (inner)
}): Provider<TApi>

// All built-in providers + flat model catalog
export const allProviders: readonly Provider[];
export const allProviderModels: Model[];

// Capability resolution
export function findModelCompat(
  apiFormat: ApiFormat,
  modelId: string,
  overrides?: ModelCompat,
): ModelCompat | undefined

// Reasoning level clamping
export function clampThinkingLevel(model: Model, level: ThinkingLevel | undefined): ThinkingLevel | undefined
export function getSupportedThinkingLevels(model: Model): ModelThinkingLevel[]
```

## Contracts (do NOT break without plan review)

Per plan 310 §3 (the original `@duya/ai` design doc):

- `AIClient.streamChat` returns `AsyncGenerator<SSEEvent, AssistantMessage, unknown>`.
- `SSEEvent` 17 type literal union (`text` / `thinking` / `tool_use_started` / `tool_use` / `tool_result` / …).
- Worker IPC events (`chatchat:text` / `chat:thinking` / `chat:done` / …).
- `Model.compat` field shape — only ADD flags; never rename or remove without plan 451+ review.

## Plan documents

- [`docs/exec-plans/active/451-multi-protocol-and-wrapper-layer.md`](../../docs/exec-plans/active/451-multi-protocol-and-wrapper-layer.md) — Plan 451 (current).
- [`docs/design-docs/2026-07-29-multi-model-reasoning-architecture.md`](../../docs/design-docs/2026-07-29-multi-model-reasoning-architecture.md) — Plan 310 design doc.

## Open follow-ups

- **Wire-payload wrappers** (cache_control placement, thinking-replay mutations) — need `onPayload` hook on `ProviderStreams`; deferred to Phase 3+.
- **Vertex AI Express** — `api/google-vertex.ts` reusing Gemini payload + OAuth access-token auth.
- **OpenAI Codex Responses** — `api/openai-codex-responses.ts` for the ChatGPT-Responses protocol.
- **Mistral Conversations** — `api/mistral-conversations.ts`.
- **Azure OpenAI Responses** — `api/azure-openai-responses.ts`.
- **OpenAI family wrappers** — `openaiFamilyThinkingFormat` (the 5-case switch in `openai-completions.ts:130-180`), `openaiFamilyToolPairingRepair`, `openaiFamilyUsage`.