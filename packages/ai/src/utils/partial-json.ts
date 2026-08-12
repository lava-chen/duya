/**
 * packages/ai/src/utils/partial-json.ts
 *
 * Plan 418 L1 — recover tool-call arguments from truncated JSON.
 *
 * Lossy third-party Anthropic-compatible endpoints (DeepSeek /anthropic)
 * sometimes truncate the streamed `input_json_delta` payload so the final
 * accumulated JSON does not parse. `partialParse` (from the SDK's
 * partial-json-parser) tolerates unclosed strings/objects and returns the
 * best-effort object, letting us keep the arguments instead of silently
 * replacing them with `{}`.
 */

import { partialParse } from '@anthropic-ai/sdk/_vendor/partial-json-parser/parser.js';

/**
 * Best-effort partial JSON parse. Returns the parsed value when the input is
 * complete or recoverable, `undefined` when the parser rejects it outright.
 */
export function parsePartialJsonSafe(text: string): unknown {
  if (!text || !text.trim()) return undefined;
  try {
    return partialParse(text);
  } catch {
    return undefined;
  }
}
