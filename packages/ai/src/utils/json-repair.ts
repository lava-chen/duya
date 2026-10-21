/**
 * packages/ai/src/utils/json-repair.ts
 *
 * Lenient JSON parsing for untrusted third-party endpoints (Plan 418).
 *
 * Some Anthropic-compatible endpoints (e.g. DeepSeek /anthropic) emit SSE
 * `data:` frames whose JSON string literals contain raw control characters
 * (unescaped newlines, tabs) or invalid backslash escapes. A strict
 * `JSON.parse` rejects the whole frame and crashes the stream; `repairJson`
 * fixes the common cases so the frame survives with its content intact.
 *
 * Ported from pi (packages/ai/src/utils/json-parse.ts), which is Claude
 * Code's tolerant event parser. `parseJsonWithRepair` returns null when the
 * frame cannot be repaired — callers should skip it rather than crash.
 */

const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case '\b': return '\\b';
    case '\f': return '\\f';
    case '\n': return '\\n';
    case '\r': return '\\r';
    case '\t': return '\\t';
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`;
  }
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
  let repaired = '';
  let inString = false;

  for (let index = 0; index < json.length; index++) {
    const char = json[index];

    if (!inString) {
      repaired += char;
      if (char === '"') {
        inString = true;
      }
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === '\\') {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += '\\\\';
        continue;
      }

      if (nextChar === 'u') {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }

      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }

      repaired += '\\\\';
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
  }

  return repaired;
}

/**
 * Parse JSON, repairing common malformed string literals first. Returns null
 * when the input is neither valid nor repairable (callers skip the frame).
 */
export function parseJsonWithRepair(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const repaired = repairJson(text);
    if (repaired === text) return null;
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}
