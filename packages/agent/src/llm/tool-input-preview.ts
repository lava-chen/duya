const PREVIEW_STRING_KEYS = [
  'file_path',
  'filePath',
  'path',
  'content',
  'old_string',
  'new_string',
] as const;

/**
 * Extract a best-effort preview from a partially streamed tool input JSON
 * string. This is for UI rendering only; actual tool execution still uses the
 * fully parsed final JSON payload.
 */
export function extractToolInputPreview(partialJson: string): Record<string, unknown> {
  const preview: Record<string, unknown> = {};

  for (const key of PREVIEW_STRING_KEYS) {
    const value = extractJsonStringValue(partialJson, key);
    if (value !== undefined) {
      preview[key] = value;
    }
  }

  return preview;
}

export function hasToolInputPreview(input: Record<string, unknown>): boolean {
  return Object.keys(input).length > 0;
}

function extractJsonStringValue(source: string, key: string): string | undefined {
  const keyNeedle = `"${key}"`;
  const keyIndex = source.indexOf(keyNeedle);
  if (keyIndex === -1) return undefined;

  let index = keyIndex + keyNeedle.length;
  index = skipWhitespace(source, index);
  if (source[index] !== ':') return undefined;
  index += 1;
  index = skipWhitespace(source, index);
  if (source[index] !== '"') return undefined;
  index += 1;

  let raw = '';
  let escaped = false;

  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) break;

    if (escaped) {
      raw += `\\${char}`;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      return decodeJsonString(raw);
    }

    raw += char;
  }

  if (escaped) {
    raw += '\\';
  }

  return decodePartialJsonString(raw);
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index] ?? '')) {
    index += 1;
  }
  return index;
}

function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return decodePartialJsonString(raw);
  }
}

function decodePartialJsonString(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
