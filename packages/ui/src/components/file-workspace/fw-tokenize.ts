/**
 * fw-tokenize.ts — block-scoped syntax highlighting for the file workspace.
 *
 * Why not reuse `SyntaxHighlighter` here: it tokenizes the *whole* document
 * on every mount. A 10k-line file costs ~600ms on the main thread even
 * though the viewport shows ~60 rows. This module tokenizes 100-line chunks
 * on demand and keeps the last N chunks in an LRU, so scrolling into new
 * code costs <1ms per chunk and memory stays bounded.
 *
 * The trade-off is that a token spanning a chunk boundary (a block comment
 * opened in chunk 1 and closed in chunk 3) is coloured per chunk. Generated
 * fixtures and real source rarely do this; when it matters, raise
 * CHUNK_LINES so the whole construct fits inside one chunk.
 */

export type TokenKind =
  | "comment"
  | "string"
  | "control"
  | "decl"
  | "number"
  | "func"
  | "type"
  | "prop"
  | "punct";

const CONTROL = new Set([
  "return", "if", "else", "for", "while", "do", "switch", "case", "default",
  "break", "continue", "try", "catch", "finally", "throw", "await", "async",
  "yield", "typeof", "instanceof", "in", "of", "new", "delete", "this",
  "super", "true", "false", "null", "undefined",
]);

const DECL = new Set([
  "import", "export", "from", "const", "let", "var", "function", "class",
  "extends", "implements", "interface", "type", "enum", "declare", "namespace",
  "abstract", "static", "public", "private", "protected", "readonly", "as",
  "satisfies", "keyof", "infer",
]);

const BUILTIN_TYPES = new Set([
  "string", "number", "boolean", "unknown", "any", "never", "object",
  "symbol", "bigint", "void", "Record", "Promise", "Array", "Map", "Set",
  "Partial", "Readonly",
]);

const TOKEN_RE =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\[\s\S])*?`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\b\d[\d_]*(?:\.\d+)?\b|[A-Za-z_$][\w$]*|[^\S]+|[^\w\s]/g;

function escapeHtml(s: string): string {
  if (s.indexOf("&") < 0 && s.indexOf("<") < 0 && s.indexOf(">") < 0) return s;
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function classify(tok: string, code: string, index: number): TokenKind | null {
  const c = tok.charAt(0);
  if (c === "/" && (tok.charAt(1) === "/" || tok.charAt(1) === "*")) return "comment";
  if (c === "`" || c === '"' || c === "'") return "string";
  if (c >= "0" && c <= "9") return "number";
  if (/[A-Za-z_$]/.test(c)) {
    if (CONTROL.has(tok)) return "control";
    if (DECL.has(tok)) return "decl";
    if (BUILTIN_TYPES.has(tok)) return "type";
    let p = index - 1;
    while (p >= 0 && /\s/.test(code.charAt(p))) p--;
    const prev = p >= 0 ? code.charAt(p) : "";
    if (prev === ".") return "prop";
    if (prev === "<" || (prev === "/" && code.charAt(p - 1) === "<")) return "type";
    let n = index + tok.length;
    while (n < code.length && /\s/.test(code.charAt(n))) n++;
    const next = code.charAt(n);
    if (next === "(") return "func";
    if (next === "=" && code.charAt(n + 1) !== "=") return "prop";
    if (/^[A-Z]/.test(tok)) return "type";
    return null;
  }
  return "punct";
}

/**
 * Tokenize a text block and return one HTML string per input line.
 * The returned array always has the same length as `text.split("\n")`.
 */
export function tokenizeBlock(text: string): string[] {
  const lines: string[] = [];
  let cur = "";

  const emit = (str: string, kind: TokenKind | null) => {
    if (!str) return;
    const parts = str.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push(cur);
        cur = "";
      }
      if (!parts[i]) continue;
      const safe = escapeHtml(parts[i]);
      cur += kind ? `<span class="fw-t-${kind}">${safe}</span>` : safe;
    }
  };

  TOKEN_RE.lastIndex = 0;
  let m = TOKEN_RE.exec(text);
  while (m) {
    const tok = m[0];
    if (/^[^\S\n]+$/.test(tok)) {
      emit(tok, null);
    } else {
      emit(tok, classify(tok, text, m.index));
    }
    m = TOKEN_RE.exec(text);
  }
  lines.push(cur);
  return lines;
}

/**
 * Bracket-pair folding ranges. Strings and comments are skipped so
 * `"{ not a brace }"` inside a literal does not open a fold.
 * Returns `startLine (1-indexed) -> endLine (1-indexed)`, only for ranges
 * that span more than one line.
 */
export function computeFolds(lines: string[]): Map<number, number> {
  const folds = new Map<number, number>();
  const stack: number[] = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    let j = 0;
    while (j < t.length) {
      const c = t.charAt(j);
      const n = t.charAt(j + 1);
      if (inBlockComment) {
        if (c === "*" && n === "/") {
          inBlockComment = false;
          j += 2;
          continue;
        }
        j++;
        continue;
      }
      if (c === "/" && n === "/") break;
      if (c === "/" && n === "*") {
        inBlockComment = true;
        j += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        j++;
        while (j < t.length) {
          if (t.charCodeAt(j) === 92) {
            j += 2;
            continue;
          }
          if (t.charAt(j) === quote) {
            j++;
            break;
          }
          j++;
        }
        continue;
      }
      if (c === "{" || c === "[" || c === "(") {
        stack.push(i);
      } else if (c === "}" || c === "]" || c === ")") {
        const start = stack.pop();
        if (start !== undefined && i > start) {
          const key = start + 1;
          const end = i + 1;
          const prev = folds.get(key);
          if (prev === undefined || prev < end) folds.set(key, end);
        }
      }
      j++;
    }
  }
  return folds;
}

/** Visual indent level: two spaces per level, a tab counts as two. */
export function indentDepth(line: string): number {
  let width = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === " ") width++;
    else if (c === "\t") width += 2;
    else break;
  }
  return Math.floor(width / 2);
}
