import type {
  ApiFormat,
  MessageContent,
  ProviderBlockContent,
  TextContent,
} from '../types.js';

// Plan 440 phase 1: degradation policy for provider-native blocks that the
// duya block model does not natively represent. Inbound parsers wrap them
// in a `provider_block` carrier (never silently drop); outbound serializers
// forward a carrier verbatim only when replaying to the same API format,
// and otherwise degrade it to a one-line text placeholder.

/** Summarize a carrier into one bounded, user-visible line. */
export function summarizeProviderBlock(block: ProviderBlockContent): string {
  let detail = '';
  try {
    detail = JSON.stringify(block.payload) ?? '';
  } catch {
    // Circular or otherwise unserializable payload — summarize without it.
  }
  if (detail.length > 200) {
    detail = detail.slice(0, 200) + '…';
  }
  return `[${block.kind}]${detail ? ` ${detail}` : ''}`;
}

/** Type guard for the carrier block. */
export function isProviderBlock(
  block: MessageContent,
): block is ProviderBlockContent {
  return block.type === 'provider_block';
}

/**
 * Outbound rule: only Anthropic-protocol same-origin replay forwards the
 * verbatim payload — the Messages API requires paired server_tool_use /
 * result blocks to round-trip or it rejects the history. Every other path
 * degrades to a text placeholder, which is wire-valid on any target format;
 * native OpenAI item re-emission is deferred until verified live.
 */
export function resolveProviderBlockOutbound(
  block: ProviderBlockContent,
  targetApi: ApiFormat,
): ProviderBlockContent | TextContent {
  if (targetApi === 'anthropic' && block.origin === 'anthropic') {
    return block;
  }
  return { type: 'text', text: summarizeProviderBlock(block) };
}
