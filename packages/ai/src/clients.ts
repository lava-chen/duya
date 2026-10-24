/**
 * @duya/ai/clients — the provider-SDK surface.
 *
 * ## Why this subpath exists
 *
 * The root `@duya/ai` entry is the one the renderer imports. It used to
 * re-export the protocol adapters (`createAnthropicClient`,
 * `createOpenAICompletionsClient`, `anthropicStreams`, ...) as well, and
 * those modules statically import the vendor SDKs (`@anthropic-ai/sdk`,
 * `openai`). A static re-export is a static edge: the bundler cannot drop
 * the module behind it, so the vendor SDKs landed in the renderer's ENTRY
 * chunk and were downloaded and evaluated before the first screen could
 * paint — measured at 141 `openai` modules + 69 `@anthropic-ai/sdk` modules
 * inside the first-screen closure.
 *
 * The SDKs are needed by the agent runtime (main process / worker), never by
 * the first screen. Splitting the barrel makes that structural instead of
 * accidental: the root entry has NO static edge to the SDKs, so no renderer
 * bundle can pull them in, whatever the consumer imports.
 *
 * Consumers that DO talk to a provider import `@duya/ai/clients`.
 * Consumers that only read model metadata, context estimates or runtime
 * configuration import `@duya/ai` (or the narrower `@duya/ai/context`).
 *
 * The PAYLOAD BUILDERS live here for the same reason the clients do: a
 * request that cannot be inspected cannot be proved correct, so the builders
 * have to be reachable -- but three of them live in modules that statically
 * import the vendor SDKs, and re-exporting those from the root entry would
 * put the SDKs back into the renderer's first screen. The root entry keeps
 * the Model Request boundary instead, which imports nothing at all.
 *
 * The names here are byte-identical to the ones the root entry used to
 * export; only the import path changed.
 */

export { createAnthropicClient } from './api/anthropic-messages.js';
export { createOpenAICompletionsClient } from './api/openai-completions.js';
export { createOpenAIResponsesClient } from './api/openai-responses.js';
export {
  anthropicStreams,
  openAICompletionsStreams,
  openAIResponsesStreams,
  bedrockConverseStreams,
  googleGenerativeAiStreams,
} from './providers/adapters.js';

// ─── The payload builders ───
//
// The wire shape each adapter produces, so a test can assert on what the
// MODEL reads rather than on the engine's intermediate array.
export { toAnthropicMessages } from './api/anthropic-messages.js';
export { toResponsesInput } from './api/openai-responses.js';
export { toOpenAIMessages } from './api/openai-completions.js';
export { toGeminiContents, type GeminiContent } from './api/google-generative-ai.js';
export {
  toBedrockMessages,
  type BedrockConverseMessage,
  type BedrockConverseRequest,
} from './api/bedrock-converse.js';
