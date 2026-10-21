/**
 * packages/ai/src/providers/wrappers/anthropic-family-tool-payload-compat.ts
 *
 * Plan 451 Phase 1 wrapper: anthropic-family tool-payload compatibility.
 *
 * Some Anthropic-compatible endpoints (most notably the DeepSeek `/anthropic`
 * compat surface) reject the structured `tool_result` content block that the
 * native Anthropic API expects. Plan 418 introduced a three-level progressive
 * transport ladder:
 *
 *   L0 tool-result-block — native tool_use + tool_result blocks
 *   L1 text-user-message  — tool_result folded into plain text in user msgs
 *   L2 none               — tool blocks dropped entirely
 *
 * This wrapper applies the ladder step resolved for the current model to the
 * message list BEFORE the protocol layer sees it. The protocol layer can
 * trust whatever messages it receives (the ladder's per-request escalation
 * stays inside the protocol layer for now; this wrapper handles the initial
 * selection).
 *
 * Decision precedence (matches `resolveToolResultTransport` in
 * anthropic-messages.ts — reimplemented here to drop the cross-package
 * dep on `api/anthropic-messages.ts`):
 *
 *   1. explicit `model.compat?.toolResultTransport`
 *   2. base-URL inference (DeepSeek `/anthropic` → text-user-message)
 *   3. protocol default (`tool-result-block`)
 */

import type { Wrapper } from './compose.js';
import type { Message, ToolResultTransport } from '../../types.js';
import { textifyToolResults } from '../../api/transform-messages.js';

const DEEPSEEK_ANTHROPIC_HOSTS = ['api.deepseek.com'] as const;

/** True iff `baseURL` looks like the DeepSeek Anthropic-compat endpoint. */
export function isDeepSeekAnthropicEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  const lower = baseURL.toLowerCase();
  return DEEPSEEK_ANTHROPIC_HOSTS.some((host) => lower.includes(host));
}

/** Pure transport resolver. Exported for tests and for the protocol layer's
 *  ladder-retry path that needs to escalate without re-running the wrapper. */
export function resolveToolResultTransport(
  baseURL: string | undefined,
  compat: { toolResultTransport?: ToolResultTransport } | undefined,
): ToolResultTransport {
  if (compat?.toolResultTransport) return compat.toolResultTransport;
  if (isDeepSeekAnthropicEndpoint(baseURL)) return 'text-user-message';
  return 'tool-result-block';
}

/** Apply the resolved transport to a message list. */
export function applyToolResultTransport(
  messages: Message[],
  baseURL: string | undefined,
  compat: { toolResultTransport?: ToolResultTransport } | undefined,
): Message[] {
  const transport = resolveToolResultTransport(baseURL, compat);
  if (transport === 'tool-result-block') return messages;
  if (transport === 'text-user-message') return textifyToolResults(messages);
  // 'none' → drop tool messages entirely.
  return messages.filter((m) => m.role !== 'tool');
}

/**
 * Stream wrapper. Reads the model + options, resolves the transport, and
 * forwards the (possibly transformed) messages to the inner stream.
 *
 * Phase 1: this wrapper is USABLE — providers that opt in via
 * `createProvider({ wrappers: [anthropicFamilyToolPayloadCompat()] })`
 * will use the wrapper-applied messages. Phase 2 will wire it into the
 * affected providers (minimax, deepseek-anthropic, glm-anthropic) and
 * remove the inline textification from the protocol layer.
 */
export function anthropicFamilyToolPayloadCompat(): Wrapper {
  return (inner) => ({
    stream: (model, options) => {
      const rawMessages = options.messages;
      if (!Array.isArray(rawMessages)) {
        return inner.stream(model, options);
      }
      const baseURL = (model as { baseUrl?: string }).baseUrl;
      const compat = (model as {
        compat?: { toolResultTransport?: ToolResultTransport };
      }).compat;
      const finalMessages = applyToolResultTransport(
        rawMessages as Message[],
        baseURL,
        compat,
      );
      return inner.stream(model, { ...options, messages: finalMessages });
    },
  });
}