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

/**
 * True line-level change stat between two contents, computed by trimming
 * the common prefix and suffix lines (O(n), ZCode `computeLineChangeStat`
 * parity). Unlike counting full field line counts, an edit that replaces
 * one line inside a 20-line block reports +1/-1 instead of +20/-20.
 *
 * Empty lines are counted as-is (matching SimpleDiffViewer's raw
 * split-on-'\n' semantics); a trailing incomplete streaming line counts
 * as one line.
 */
export interface LineChangeStat {
  additions: number;
  removals: number;
}

function splitLogicalLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

export function computeLineChangeStat(oldText: string | null, newText: string): LineChangeStat {
  const beforeLines = splitLogicalLines(oldText ?? '');
  const afterLines = splitLogicalLines(newText);

  let prefixIndex = 0;
  while (
    prefixIndex < beforeLines.length &&
    prefixIndex < afterLines.length &&
    beforeLines[prefixIndex] === afterLines[prefixIndex]
  ) {
    prefixIndex += 1;
  }

  let beforeTailIndex = beforeLines.length - 1;
  let afterTailIndex = afterLines.length - 1;
  while (
    beforeTailIndex >= prefixIndex &&
    afterTailIndex >= prefixIndex &&
    beforeLines[beforeTailIndex] === afterLines[afterTailIndex]
  ) {
    beforeTailIndex -= 1;
    afterTailIndex -= 1;
  }

  const removedCount = beforeTailIndex - prefixIndex + 1;
  const addedCount = afterTailIndex - prefixIndex + 1;
  return {
    additions: addedCount > 0 ? addedCount : 0,
    removals: removedCount > 0 ? removedCount : 0,
  };
}

/**
 * Materialization gate for streaming tool inputs (ZCode
 * `shouldMaterializeZCodeStreamingToolInputPreview` parity).
 *
 * Deltas append to a raw buffer for free; only "materializing" — running
 * the partial-JSON extraction, merging into the row, and notifying
 * subscribers — is throttled. Without the gate a fast model streaming a
 * large file write would trigger a full re-parse of the accumulated raw
 * every coalesce tick.
 */
export interface StreamingToolInputGateState {
  deltaCount: number;
  lastPreviewAt: number;
  lastPreviewRawLength: number;
}

export function createStreamingToolInputGateState(): StreamingToolInputGateState {
  return { deltaCount: 0, lastPreviewAt: 0, lastPreviewRawLength: 0 };
}

/** The very first delta always materializes so the card appears immediately. */
const STREAMING_TOOL_INPUT_EAGER_DELTA_COUNT = 1;

/** File-write tools parse a potentially huge `content` — hard 1s window. */
const FILE_STREAMING_INPUT_PREVIEW_MIN_INTERVAL_MS = 1_000;

/** Other tools' string args stay small — 750ms interval or 8KB growth. */
const STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS = 750;
const STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH = 8 * 1024;
const STREAMING_TOOL_INPUT_PREVIEW_TIME_BUDGET_MAX_RAW = 8 * 1024;

/** Mirrors FILE_EDIT_TOOLS + FILE_CREATE_TOOLS in
 *  src/components/chat/tools/classify.ts — keep the two in sync. */
const FILE_STREAMING_PREVIEW_TOOLS = new Set([
  'write', 'writefile', 'write_file', 'create_file', 'createfile',
  'edit', 'edit_file', 'str_replace_editor',
]);

function isFileStreamingPreviewTool(toolName: string | undefined): boolean {
  return toolName !== undefined && FILE_STREAMING_PREVIEW_TOOLS.has(toolName.trim().toLowerCase());
}

export function shouldMaterializeStreamingToolInput(
  state: StreamingToolInputGateState,
  rawInput: string,
  toolName: string | undefined,
  now: number,
): boolean {
  if (state.deltaCount <= STREAMING_TOOL_INPUT_EAGER_DELTA_COUNT) {
    return true;
  }
  if (isFileStreamingPreviewTool(toolName)) {
    // Big file-write args must not bypass the 1s window, or the faster the
    // model outputs, the more often the UI re-parses.
    return now - state.lastPreviewAt >= FILE_STREAMING_INPUT_PREVIEW_MIN_INTERVAL_MS;
  }
  if (rawInput.length - state.lastPreviewRawLength >= STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH) {
    return true;
  }
  const intervalElapsed =
    now - state.lastPreviewAt >= STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS;
  if (!intervalElapsed) {
    return false;
  }
  // Small inputs keep the time budget; past it only raw growth triggers.
  return rawInput.length <= STREAMING_TOOL_INPUT_PREVIEW_TIME_BUDGET_MAX_RAW;
}

export function markStreamingToolInputMaterialized(
  state: StreamingToolInputGateState,
  now: number,
  rawLength: number,
): void {
  state.lastPreviewAt = now;
  state.lastPreviewRawLength = rawLength;
}
