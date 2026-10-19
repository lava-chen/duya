// Smart join for markdown text fragments that must render inside ONE
// markdown document (a single MarkdownRenderer pass).
//
// A blank-line join breaks constructs that span the fragment boundary:
//   - A table split across fragments loses its header/separator
//     context at the blank line, and the stray tail rows render as
//     literal pipe characters instead of table rows.
//   - An unclosed code fence swallows the injected blank line and
//     shifts the code body by one line.
//   - An unterminated inline-code span (`...` with an odd number of
//     backticks) is paired against the next matching backtick on the
//     other side of the seam, swallowing an arbitrary chunk of the
//     joined text into a stray <code> pill. The seam ends inside such
//     a span when an SSE chunk cut the text right between ` and `.
//
// So: join with a single newline while the boundary falls inside such
// a construct, and with a blank line (block boundary) everywhere else.
// A blank line between two list items keeps them in the same (loose)
// list, so plain list runs do not need the single-newline path.
//
// Note: backtick characters are written as unicode escapes so the
// source contains no raw backtick literals.

const BACKTICK = String.fromCharCode(96);
const FENCE_LINE = /^ {0,3}([\u0060]{3,}|~{3,})/;
const TABLE_ROW = /^ {0,3}\|/;

/** True when text ends inside an unterminated code fence. */
function endsInsideCodeFence(text: string): boolean {
  let openChar: string | null = null;
  let openLength = 0;
  for (const line of text.split('\n')) {
    const match = line.match(FENCE_LINE);
    if (!match) continue;
    const marker = match[1]!;
    if (openChar === null) {
      openChar = marker[0]!;
      openLength = marker.length;
    } else if (marker[0] === openChar && marker.length >= openLength) {
      openChar = null;
      openLength = 0;
    }
  }
  return openChar !== null;
}

/**
 * Whether the prefix `text` ends inside an unterminated inline-code
 * span. Counts backticks outside fenced code blocks (the same rules
 * react-markdown applies) and reports whether the running parity is
 * odd at the end of the string. An odd parity means the prefix needs
 * one more backtick before the join so the next fragment can pair with
 * it instead of stealing whatever comes next.
 */
export function endsInsideInlineCode(text: string): boolean {
  let parity = 0;
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of text.split('\n')) {
    const fenceMatch = line.match(FENCE_LINE);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fenceChar === null) {
        fenceChar = marker[0]!;
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    if (fenceChar !== null) continue;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === BACKTICK) parity ^= 1;
    }
  }
  return parity === 1;
}

function lastNonBlankLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== '') return lines[i]!;
  }
  return '';
}

function firstNonBlankLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? '';
}

/** Join two fragments with exactly one newline between their content. */
function joinSingleNewline(prev: string, next: string): string {
  return prev.replace(/(\r?\n)+$/, '') + '\n' + next.replace(/^(\r?\n)+/, '');
}

/** Join two fragments with exactly one blank line between their content. */
function joinBlankLine(prev: string, next: string): string {
  return prev.replace(/(\r?\n)+$/, '') + '\n\n' + next.replace(/^(\r?\n)+/, '');
}

export function mergeMarkdownFragments(prev: string, next: string): string {
  if (prev === '') return next;
  if (next === '') return prev;
  // Boundary inside a code fence: keep the code body contiguous.
  if (endsInsideCodeFence(prev)) return joinSingleNewline(prev, next);
  // Boundary inside an unterminated inline-code span: keep the half-open
  // span contiguous across the seam so the next fragment's backtick can
  // close it instead of swallowing the seam's blank line (or worse,
  // arbitrary text) into a stray code pill.
  if (endsInsideInlineCode(prev)) return joinSingleNewline(prev, next);
  // Boundary inside a table: GFM ends the table at a blank line, so the
  // tail rows would lose their header and render as literal pipes.
  if (TABLE_ROW.test(lastNonBlankLine(prev)) && TABLE_ROW.test(firstNonBlankLine(next))) {
    return joinSingleNewline(prev, next);
  }
  return joinBlankLine(prev, next);
}

export function joinMarkdownFragments(fragments: readonly string[]): string {
  return fragments.reduce((acc, part) => mergeMarkdownFragments(acc, part), '');
}

// Exposed for tests: build a three-backtick fence marker without raw
// backticks in the source.
export const CODE_FENCE_MARKER = BACKTICK.repeat(3);
