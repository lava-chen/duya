// Normalization helpers shared between the streaming path
// (`useStreamingActions.streamingEventsToActions`) and the persisted
// path (`MessageItem.messageToActionItems`). Both must turn a
// tool_use + tool_result pair into the same `ToolAction` shape, and
// both must tolerate malformed `toolInput` JSON without crashing the
// surrounding component.
//
// Previously `messageToActionItems` called `JSON.parse(msg.toolInput)`
// with no try/catch — a single corrupted row would take down the whole
// MessageItem. Centralizing the parse here ensures every code path
// applies the same defensive handling.

/**
 * Parse a tool_use `input` payload stored as a JSON string. Returns
 * `{}` when the input is missing, empty, or not valid JSON (previously
 * a malformed payload would throw and crash the MessageItem subtree).
 *
 * The empty-object fallback matches the shape expected by downstream
 * registry / row components: `getSummary(input, name)` and the
 * catch-all renderer both handle `{}` gracefully.
 */
export function parseToolInputSafe(input: string | undefined | null): unknown {
  if (!input) return {};
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // Malformed JSON — return the raw string wrapped so the catch-all
    // renderer can still display something useful instead of crashing.
    // We wrap in an object with a `_raw` key so consumers that expect
    // an object still work, but the original payload is recoverable.
    return { _raw: trimmed };
  }
}

/**
 * Build a `ToolAction` from a tool_use id/name + its paired result.
 * Centralizes the field mapping so streaming and persisted paths
 * produce identical shapes (the streaming path previously inlined
 * this; the persisted path uses it via `messageToActionItems`).
 */
export function buildToolAction(
  id: string | undefined,
  name: string,
  input: unknown,
  result?: { content?: string; is_error?: boolean; duration_ms?: number | null; metadata?: Record<string, unknown> },
  fallbackDurationMs?: number | null,
): {
  id: string | undefined;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
} {
  return {
    id,
    name,
    input,
    result: result?.content,
    isError: result?.is_error,
    durationMs: result?.duration_ms ?? fallbackDurationMs,
    metadata: result?.metadata,
  };
}
