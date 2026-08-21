/**
 * electron/memory/rag_snippet.ts — term-windowed snippet construction for
 * RAG search hits (plan 430 follow-up).
 *
 * Mirrors `buildSnippet` / `extractTerms` in scripts/memory-rag-lib.mjs so
 * the CLI (`searchMemoryIndex`) and the hook core produce identical
 * previews: the window centers on the first literal occurrence of a query
 * term in the document body (leading YAML frontmatter skipped) instead of
 * the fixed file-head slice, is word-aligned, bounded, and marked with
 * "…" whenever the window does not span the whole body. Vector-only hits
 * (no literal term) fall back to the body head.
 *
 * Pure module: no Electron, DB, or config imports — unit-testable with
 * plain Vitest.
 */

/** CJK ranges — 2-char CJK terms get a LIKE fallback (trigram needs >=3 chars). */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Default snippet window length (characters of normalized body text). */
export const SNIPPET_MAX_LEN = 220;

/** Fraction of the window allocated to context before the first match. */
const SNIPPET_BEFORE_FRACTION = 0.4;

/**
 * Drop a leading YAML frontmatter block (`---` … `---` with the closing
 * delimiter on its own line) so snippet windows start at the real body
 * instead of polluting the preview with metadata.
 */
export function stripFrontmatter(raw: string): string {
  const text = String(raw ?? '');
  if (!/^---\s*\n/.test(text)) return text;
  const lines = text.split('\n');
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (close === -1) return text;
  return lines.slice(close + 1).join('\n');
}

/**
 * Extract the usable search terms from a prompt: >=3-char tokens plus
 * 2-char CJK tokens (the same term selection the keyword search uses).
 * Vector-only rows carry this set for snippet windowing.
 */
export function extractTerms(prompt: string): string[] {
  const cleaned = prompt
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const terms = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const trigramTerms = terms.filter((t) => t.length >= 3);
  const shortCjkTerms = terms.filter((t) => t.length === 2 && CJK_RE.test(t));
  return [...trigramTerms, ...shortCjkTerms];
}

/**
 * Build a snippet around the first literal occurrence of any query term
 * instead of the fixed file-head window. Returns '' for empty content.
 * The output is single-line normalized, word-aligned at both ends,
 * bounded to `maxLen`, and prefixed/suffixed with "…" whenever the window
 * does not span the whole body.
 */
export function buildSnippet(
  content: string,
  terms?: string[],
  opts?: { maxLen?: number },
): string {
  const maxLen = opts?.maxLen ?? SNIPPET_MAX_LEN;
  const body = stripFrontmatter(content);
  const norm = body.replace(/\s+/g, ' ').trim();
  if (!norm) return '';
  if (maxLen >= norm.length) return norm;

  const usable = [...new Set((terms ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))];

  const lower = norm.toLowerCase();
  let idx = -1;
  for (const t of usable) {
    const at = lower.indexOf(t);
    if (at >= 0 && (idx === -1 || at < idx)) idx = at;
  }

  let start: number;
  let end: number;
  if (idx === -1) {
    start = 0;
    end = Math.min(norm.length, maxLen);
  } else {
    const before = Math.floor(maxLen * SNIPPET_BEFORE_FRACTION);
    start = Math.max(0, idx - before);
    end = Math.min(norm.length, start + maxLen);
  }

  // Word-aligned boundaries: never start or end mid-word. Skipping past
  // the match itself (ws + 1 > idx) would defeat the windowing, so only
  // advance when the match survives. The trailing side trims a short
  // dangling partial word back instead of overshooting maxLen.
  if (start > 0) {
    const ws = norm.indexOf(' ', start);
    if (ws !== -1 && ws < end && ws + 1 <= idx) start = ws + 1;
  }
  if (end < norm.length) {
    const lastWs = norm.lastIndexOf(' ', end);
    if (lastWs > idx && end - lastWs < 24) end = lastWs;
  }

  const slice = norm.slice(start, end).trim();
  return (start > 0 ? '…' : '') + slice + (end < norm.length ? '…' : '');
}
