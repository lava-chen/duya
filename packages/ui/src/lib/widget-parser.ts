export interface WidgetSegment {
  type: 'text' | 'widget';
  content?: string;
  data?: { widget_code: string };
}

// Match ```show-widget, then content, then a closing ``` that is on its own line
// The closing \n``` ensures we match the actual fence close, not triple backticks in content
const SHOW_WIDGET_FENCE_RE = /```show-widget\s*\n([\s\S]*?)\n```/g;

export function parseAllShowWidgets(text: string): WidgetSegment[] {
  const segments: WidgetSegment[] = [];
  const fences: Array<{ index: number; raw: string; inner: string }> = [];

  let match: RegExpExecArray | null;
  SHOW_WIDGET_FENCE_RE.lastIndex = 0;
  while ((match = SHOW_WIDGET_FENCE_RE.exec(text)) !== null) {
    fences.push({
      index: match.index,
      raw: match[0],
      inner: match[1].trim(),
    });
  }

  if (fences.length === 0) {
    segments.push({ type: 'text', content: text });
    return segments;
  }

  let textCursor = 0;
  for (const fence of fences) {
    if (fence.index > textCursor) {
      const beforeText = text.slice(textCursor, fence.index);
      if (beforeText.trim()) {
        segments.push({ type: 'text', content: beforeText });
      }
    }

    const data = parseFenceJson(fence.inner);
    if (data) {
      segments.push({ type: 'widget', data });
    } else {
      segments.push({ type: 'text', content: fence.raw });
    }

    textCursor = fence.index + fence.raw.length;
  }

  if (textCursor < text.length) {
    const afterText = text.slice(textCursor);
    if (afterText.trim()) {
      segments.push({ type: 'text', content: afterText });
    }
  }

  return segments;
}

function parseFenceJson(raw: string): { widget_code: string } | null {
  // First, try the old JSON wrapper format: {"widget_code":"..."}
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');

  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    const jsonStr = raw.slice(jsonStart, jsonEnd + 1);
    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.widget_code === 'string' && parsed.widget_code.length > 0) {
        return { widget_code: parsed.widget_code };
      }
    } catch {
      // JSON.parse failed — try resilient extraction for common LLM mistakes
      const recovered = resilientExtract(jsonStr);
      if (recovered) return recovered;
    }
  }

  // Fallback: the fence content IS the widget code directly (new simplified format)
  // No JSON wrapper needed — just raw HTML/SVG/JS
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    return { widget_code: trimmed };
  }

  return null;
}

/**
 * Extract widget_code from malformed JSON that LLMs commonly produce.
 * Uses regex to find the "widget_code" key-value pair directly,
 * bypassing JSON.parse for the wrapper object.
 */
function resilientExtract(jsonStr: string): { widget_code: string } | null {
  // Match: "widget_code" : "...content..." (handle optional whitespace around colon)
  const re = /"widget_code"\s*:\s*"((?:[^"\\]|\\.)*)"\s*[,}]/;
  const match = re.exec(jsonStr);
  if (!match) return null;

  let value = match[1];
  // Unescape JSON escape sequences: \", \\, \n, \r, \t
  value = value.replace(/\\(["\\/bfnrt])/g, (_, ch) => {
    const map: Record<string, string> = {
      '"': '"', '\\': '\\', '/': '/', 'b': '\b',
      'f': '\f', 'n': '\n', 'r': '\r', 't': '\t',
    };
    return map[ch] ?? ch;
  });

  if (value.length === 0) return null;
  return { widget_code: value };
}

export function hasUnclosedWidgetFence(text: string): boolean {
  let openCount = 0;
  let idx = 0;
  while (idx < text.length) {
    const fenceStart = text.indexOf('```show-widget', idx);
    if (fenceStart === -1) break;

    openCount++;
    idx = fenceStart + 15;

    const closingFence = text.indexOf('```', idx);
    if (closingFence === -1) return true;

    openCount--;
    idx = closingFence + 3;
  }
  return openCount > 0;
}

export function getPartialWidgetCode(text: string): {
  beforeText: string;
  partialCode: string;
} | null {
  const fenceStart = text.lastIndexOf('```show-widget');
  if (fenceStart === -1) return null;

  const beforeText = text.slice(0, fenceStart);
  const afterFence = text.slice(fenceStart + 15);

  const newlineIdx = afterFence.indexOf('\n');
  const codeStart = newlineIdx === -1 ? 0 : newlineIdx + 1;
  let raw = afterFence.slice(codeStart);

  const lastClosing = raw.lastIndexOf('```');
  if (lastClosing !== -1) {
    return null;
  }

  const scriptTagIdx = raw.lastIndexOf('<script');
  if (scriptTagIdx !== -1) {
    const scriptCloseIdx = raw.indexOf('</script>', scriptTagIdx);
    if (scriptCloseIdx === -1) {
      raw = raw.slice(0, scriptTagIdx);
    }
  }

  return {
    beforeText,
    partialCode: raw,
  };
}
