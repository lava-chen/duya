// Fenced code block marker (``` or ~~~)
const FENCE_RE = /^ {0,3}([`~]{3,})/;
// Detect a fence marker anywhere in a line (used to split glued prose).
const FENCE_INLINE_RE = /([`~]{3,})/;

/**
 * Normalize $$ / ``` boundaries so remark-math and the code-block parser
 * recognise block-level constructs.
 *
 * Three failure modes are repaired:
 *
 *   1. Inline-glued math: `1.公式$$\nformula\n$$` — the leading `$$` is glued
 *      to a prose paragraph (no blank line after). remark-math falls back to
 *      inline math, which renders the entire multi-line formula as raw LaTeX
 *      source. Split into its own line so it becomes block-level display math.
 *
 *   2. Unclosed math blocks: `$$\nx = 1` (no closing $$) — append `$$` at end.
 *
 *   3. Unclosed fenced code blocks: open ``` with no closing fence — append
 *      the matching fence.
 */
export function preprocessUnclosedConstructs(text: string): string {
  let out = normalizeMathBoundaries(text);
  out = normalizeCodeFenceBoundaries(out);
  return closeUnfinishedMath(out);
}

// Split `$$` onto its own line when it was glued to preceding prose, and
// ensure a blank line precedes any standalone `$$` so remark-math parses
// it as a display-math block rather than inline math.
function normalizeMathBoundaries(text: string): string {
  const lines = text.split('\n');
  const fixed: string[] = [];
  let fenceChar: string | null = null;
  let fenceLen = 0;
  let inMathBlock = false;
  // Buffer holds the lines belonging to the open math block so we can
  // re-emit them as separate lines after splitting the leading `$$` off.
  let mathBuffer: string[] = [];

  const isFenceLine = (line: string): RegExpMatchArray | null => line.match(FENCE_RE);

  const flushMathBuffer = (closeLine: string | null) => {
    // The first line of the buffer starts with $$; push everything except
    // its leading `$$` token to `fixed` (it's the body), then push `$$` on
    // its own line. The closing $$ gets pushed as a separate line too.
    const bodyLines = mathBuffer.slice(1);
    for (const b of bodyLines) fixed.push(b);
    if (closeLine) fixed.push(closeLine);
    mathBuffer = [];
    inMathBlock = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Detect any fence marker on this line — including glued ones.
    // We require fenceChar === null OR a matching close to update state;
    // other code handles opener/closer glued to prose via the inline regex.
    const fenceMatch = isFenceLine(line);
    const inlineMatch = FENCE_INLINE_RE.exec(line);
    const fenceMarker = fenceMatch ? fenceMatch[1]! : (inlineMatch ? inlineMatch[1] : null);

    if (fenceMarker !== null) {
      if (fenceChar === null) {
        fenceChar = fenceMarker[0]!;
        fenceLen = fenceMarker.length;
        fixed.push(line);
        continue;
      } else if (fenceMarker[0] === fenceChar && fenceMarker.length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
        fixed.push(line);
        continue;
      }
    }
    if (fenceChar !== null) {
      fixed.push(line);
      continue;
    }

    // We're in a math block. Track lines and detect the close.
    if (inMathBlock) {
      // A bare `$$` line ends the block.
      if (trimmed === '$$') {
        // Flush buffered body lines, then push the closing $$ on its own line.
        const bodyLines = mathBuffer.slice(1);
        for (const b of bodyLines) fixed.push(b);
        fixed.push('$$');
        // Add blank line after $$ if next line is non-empty prose.
        const next = lines[i + 1];
        if (next !== undefined && next.trim() !== '' && !isFenceLine(next)) {
          fixed.push('');
        }
        mathBuffer = [];
        inMathBlock = false;
        continue;
      }
      // A trailing-$$ glued close like `math$$` — split.
      if (trimmed.endsWith('$$') && !trimmed.endsWith('$$$') && !trimmed.startsWith('$$')) {
        const bodyLines = mathBuffer.slice(1);
        for (const b of bodyLines) fixed.push(b);
        // Split the line: everything before the trailing $$ is body, $$ is close.
        const idx = line.lastIndexOf('$$');
        const body = line.slice(0, idx);
        fixed.push(body);
        fixed.push('$$');
        const next = lines[i + 1];
        if (next !== undefined && next.trim() !== '' && !isFenceLine(next)) {
          fixed.push('');
        }
        mathBuffer = [];
        inMathBlock = false;
        continue;
      }
      // Plain body line — accumulate.
      mathBuffer.push(line);
      continue;
    }

    // Detect opening $$ glued to prose: line ends with $$ and the leading
    // content is non-$$ text. Split it.
    if (trimmed.endsWith('$$') && !trimmed.endsWith('$$$') && !trimmed.startsWith('$$')) {
      const idx = line.lastIndexOf('$$');
      const prose = line.slice(0, idx);
      fixed.push(prose);
      inMathBlock = true;
      mathBuffer = ['$$'];
      // If the opening line is `text$$` (glued close on same line), there's
      // nothing in between — flush immediately with empty body.
      flushMathBuffer('$$');
      // Ensure blank line after the closing $$.
      const next = lines[i + 1];
      if (next !== undefined && next.trim() !== '' && !isFenceLine(next)) {
        fixed.push('');
      }
      continue;
    }

    // Detect standalone opening $$ on its own line — ensure blank line before.
    if (trimmed === '$$' || trimmed.startsWith('$$ ')) {
      const last = fixed[fixed.length - 1];
      if (last !== undefined && last.trim() !== '' && !isFenceLine(last)) {
        fixed.push('');
      }
      inMathBlock = true;
      mathBuffer = ['$$'];
      fixed.push(line);
      continue;
    }

    fixed.push(line);
  }

  // Flush remaining math buffer (block never closed within the document).
  if (inMathBlock) {
    for (const b of mathBuffer.slice(1)) fixed.push(b);
  }

  return fixed.join('\n');
}

// Split ``` / ~~~ fences that are glued to surrounding prose so the
// parser sees them as standalone block markers.
function normalizeCodeFenceBoundaries(text: string): string {
  const lines = text.split('\n');
  const fixed: string[] = [];
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(FENCE_INLINE_RE);
    if (!match) {
      fixed.push(line);
      continue;
    }
    const marker = match[1]!;
    const idx = line.indexOf(marker);
    const before = line.slice(0, idx);
    const after = line.slice(idx + marker.length);

    if (fenceChar === null) {
      // Opening fence.
      fenceChar = marker[0]!;
      fenceLen = marker.length;
      if (before.trim() !== '') {
        // Prose glued before fence — split.
        fixed.push(before);
        // Push the fence marker + info string (e.g. ```ts) on its own line.
        fixed.push(marker + after);
      } else {
        fixed.push(line);
      }
      continue;
    }

    if (marker[0] === fenceChar && marker.length >= fenceLen) {
      // Closing fence.
      fenceChar = null;
      fenceLen = 0;
      if (after.trim() !== '') {
        // Trailing prose glued after closing fence — split.
        fixed.push(marker);
        fixed.push(after);
      } else if (before.trim() !== '') {
        // Prose glued before closing fence (rare — fence ends a line
        // that has prose content before it). Split so the renderer
        // sees a standalone fence.
        fixed.push(before);
        fixed.push(marker);
      } else {
        fixed.push(line);
      }
      continue;
    }

    fixed.push(line);
  }
  return fixed.join('\n');
}

// Append closing $$ / $ / fence when text ends mid-construct.
function closeUnfinishedMath(text: string): string {
  let mathState = 0; // 0 = outside, 1 = inline, 2 = display
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '$') { i++; continue; }
    if (text[i] === '$') {
      if (text[i + 1] === '$') {
        if (mathState === 0) mathState = 2;
        else if (mathState === 2) mathState = 0;
        else if (mathState === 1) mathState = 2;
        i++;
      } else {
        mathState = mathState === 0 ? 1 : 0;
      }
    }
  }
  if (mathState !== 0) {
    if (mathState === 2) return text + '\n$$';
    return text + '$';
  }

  // Match a fence marker at the START of a line OR with info-string text
  // glued after it (e.g. `\`\`\`iter N 开始` is still an opening fence).
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of text.split('\n')) {
    const match = line.match(FENCE_INLINE_RE);
    if (!match) continue;
    const marker = match[1]!;
    const afterMarker = line.slice(match.index! + marker.length);
    // A marker glued to non-empty text after it still counts as an opener
    // or closer (CommonMark allows info strings and is permissive about
    // trailing content on the fence line).
    if (fenceChar === null) {
      fenceChar = marker[0]!;
      fenceLen = marker.length;
      // Remember whether the trailing text is an info string — if so we
      // expect the next matching fence to be plain (no info string).
      if (afterMarker.trim() !== '') {
        // Treat it like a normal opener.
      }
    } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
      fenceChar = null;
      fenceLen = 0;
    }
  }
  if (fenceChar !== null) {
    return text + '\n' + fenceChar.repeat(fenceLen);
  }

  return text;
}