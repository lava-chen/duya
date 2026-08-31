/**
 * streaming-tool-input.ts
 *
 * Plan 461: lenient extraction of top-level string fields from a *streamed*
 * JSON tool-argument object.
 *
 * The model emits a tool call's arguments token by token
 * (`tool_use_delta`), so the accumulated raw string is almost never a
 * complete JSON document — it is a prefix like:
 *
 *   {"file_path":"E:\\a\\b.txt","content":"line1\nline2\nli
 *
 * This module walks that prefix and extracts the top-level string fields
 * that have a complete value (or an unterminated trailing value, which is
 * exactly what a live file write looks like). Numbers, booleans, nulls,
 * arrays and objects are skipped because a truncated value would corrupt
 * the row's shape — the authoritative parsed input replaces everything
 * when the final `tool_use` event arrives.
 *
 * Never persisted; only used to render the live preview while the model
 * is still producing the arguments.
 */

/**
 * Extract top-level string fields from a (possibly incomplete) JSON
 * object prefix. Returns `{}` for anything that is not a JSON object.
 *
 * Handles:
 *  - escaped characters (`\"`, `\\`, `\n`, `\t`, `\uXXXX`, …)
 *  - unterminated trailing string values (returned as-is, minus the
 *    dangling escape sequence which may still be mid-stream)
 *  - nested objects / arrays as values (skipped, never truncated into
 *    the fields map)
 *  - field keys that are themselves incomplete (ignored until a
 *    complete `"key":` pair appears)
 */
export function extractPartialToolFields(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'string' || raw.length === 0) return out;

  const n = raw.length;
  let i = 0;

  const isWs = (c: string | undefined): boolean =>
    c === ' ' || c === '\t' || c === '\n' || c === '\r';

  const skipWs = (): void => {
    while (i < n && isWs(raw[i])) i++;
  };

  /**
   * Read a JSON string starting at raw[i] === '"'. Returns the decoded
   * value. For an unterminated string it returns everything decoded so
   * far, holding back a trailing incomplete escape (`\`, `\u`, `\u12`)
   * so the next chunk can complete it. Consumes the closing quote when
   * present.
   */
  const readString = (): string => {
    i++; // consume opening quote
    let value = '';
    while (i < n) {
      const c = raw[i];
      if (c === '\\') {
        const esc = raw[i + 1];
        if (esc === undefined) break; // dangling backslash — wait for next chunk
        if (esc === 'u') {
          const hex = raw.slice(i + 2, i + 6);
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break; // incomplete \uXXXX
          value += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        switch (esc) {
          case '"': value += '"'; break;
          case '\\': value += '\\'; break;
          case '/': value += '/'; break;
          case 'b': value += '\b'; break;
          case 'f': value += '\f'; break;
          case 'n': value += '\n'; break;
          case 'r': value += '\r'; break;
          case 't': value += '\t'; break;
          default: value += esc; break; // lenient: unknown escape → literal
        }
        i += 2;
        continue;
      }
      if (c === '"') {
        i++; // consume closing quote — value is terminated
        return value;
      }
      value += c;
      i++;
    }
    return value; // unterminated — partial value
  };

  while (i < n) {
    skipWs();
    const c = raw[i];
    if (c === '{' || c === ',') {
      i++;
      continue;
    }
    if (c === '}' || c === ']') break; // object closed (or stray) — done
    if (c !== '"') {
      // Not a string key — either a partial key start, a scalar at the
      // top level, or garbage. Skip one char and keep scanning; the
      // structure never recovers until the next `,` or `{`.
      i++;
      continue;
    }

    const key = readString();
    skipWs();
    if (raw[i] !== ':') {
      i++;
      continue;
    }
    i++; // consume ':'
    skipWs();
    if (i >= n) break;
    if (raw[i] === '"') {
      const value = readString();
      // A terminated value is authoritative; an unterminated trailing
      // value is the live stream. Either way the field is usable.
      if (key) out[key] = value;
    } else {
      // Non-string value (number / bool / null / nested object / array).
      // Skip until the next top-level `,` or `}` without truncating.
      let depth = 0;
      while (i < n) {
        const ch = raw[i];
        if (ch === '{' || ch === '[') {
          depth++;
        } else if (ch === '}' || ch === ']') {
          if (depth === 0) break;
          depth--;
        } else if ((ch === ',' || ch === '}') && depth === 0) {
          break;
        }
        i++;
      }
    }
  }

  return out;
}

/** Convenience: count non-empty lines in a partial file write. */
export function countContentLines(content: string | undefined): number {
  if (typeof content !== 'string' || content.length === 0) return 0;
  const trimmed = content.replace(/[ \t\r]+$/gm, '');
  if (trimmed.length === 0) return 0;
  return trimmed.split('\n').filter((l) => l.trim() !== '').length;
}
