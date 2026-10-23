/**
 * diff-highlight.ts — per-line syntax tokens for the diff viewer.
 *
 * The diff viewer needs three things at once that a syntax highlighter
 * component cannot give it: the ORIGINAL file line numbers (a removed line
 * shows the old file's number, an added line the new one, so the numbering
 * is not the sequential 1..N of any single document), the +/- background
 * that belongs to the DIFF layer, and the syntax colours that belong to
 * the CODE layer. So the AST is taken apart here and the viewer keeps
 * drawing the rows itself.
 *
 * The engine is `refractor`, the same Prism implementation the chat code
 * block uses: `react-syntax-highlighter`'s `PrismLight` is a thin React
 * wrapper around this exact singleton (see
 * `react-syntax-highlighter/dist/esm/prism-light.js`), so the languages
 * registered in `lib/prism-languages.ts` are the ones available here.
 *
 * Text fidelity is the contract: concatenating the tokens of a line must
 * reproduce the source line byte for byte. Everything is highlighted as a
 * whole document so a token that spans several lines (a block comment, a
 * template literal) is coloured correctly on every line it covers.
 */

import { refractor } from '@/lib/prism-languages';

/**
 * Colour buckets. Prism emits dozens of token types; the diff only needs a
 * handful of visual roles, so the types are folded into buckets that map
 * one-to-one onto a CSS class and a theme variable.
 */
export type DiffSyntaxKind =
  | 'comment'
  | 'string'
  | 'keyword'
  | 'function'
  | 'number'
  | 'type'
  | 'tag'
  | 'attr'
  | 'operator'
  | 'punctuation'
  | 'variable'
  | 'plain';

export interface DiffSyntaxToken {
  text: string;
  kind: DiffSyntaxKind;
}

/** One source line, split into tokens. An empty line has no tokens. */
export type DiffSyntaxLine = DiffSyntaxToken[];

/**
 * Beyond this many characters the source is not highlighted at all. A
 * multi-thousand-line file costs hundreds of milliseconds to tokenize, and
 * the diff only ever shows a screenful of it.
 */
export const DIFF_HIGHLIGHT_MAX_CHARS = 120_000;

/** Prism token type -> colour bucket. Unknown types fall back to 'plain'. */
const KIND_BY_TOKEN: Record<string, DiffSyntaxKind> = {
  comment: 'comment',
  prolog: 'comment',
  doctype: 'comment',
  cdata: 'comment',
  string: 'string',
  'template-string': 'string',
  interpolation: 'string',
  regexp: 'string',
  'char.escape': 'string',
  keyword: 'keyword',
  boolean: 'keyword',
  constant: 'keyword',
  function: 'function',
  'function-variable': 'function',
  method: 'function',
  number: 'number',
  unit: 'number',
  builtin: 'type',
  'class-name': 'type',
  'maybe-class-name': 'type',
  namespace: 'type',
  type: 'type',
  tag: 'tag',
  'attr-name': 'attr',
  'attr-value': 'attr',
  operator: 'operator',
  punctuation: 'punctuation',
  property: 'variable',
  variable: 'variable',
  parameter: 'variable',
  symbol: 'variable',
};

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string | string[] };
  children?: HastNode[];
}

function kindFromClasses(classes: string[]): DiffSyntaxKind | null {
  for (const className of classes) {
    if (className === 'token') continue;
    const kind = KIND_BY_TOKEN[className];
    if (kind) return kind;
  }
  return null;
}

/** Flatten the hast tree into a token stream that preserves every character. */
function collectTokens(node: HastNode, kind: DiffSyntaxKind, out: DiffSyntaxToken[]): void {
  if (node.type === 'text') {
    if (node.value) out.push({ text: node.value, kind });
    return;
  }
  if (node.type !== 'element') return;
  const raw = node.properties?.className;
  const classes = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\s+/) : [];
  const nextKind = kindFromClasses(classes) ?? kind;
  for (const child of node.children ?? []) {
    collectTokens(child, nextKind, out);
  }
}

/** Split a token stream into lines. A token may cover several lines. */
function toLines(tokens: DiffSyntaxToken[]): DiffSyntaxLine[] {
  const lines: DiffSyntaxLine[] = [[]];
  for (const token of tokens) {
    const parts = token.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i]) lines[lines.length - 1].push({ text: parts[i], kind: token.kind });
    }
  }
  return lines;
}

/**
 * Tokenize a whole source file into per-line tokens.
 *
 * Returns `null` when the source cannot be highlighted — no language, an
 * unregistered language, a source too large, or a grammar that throws. The
 * caller then renders the line as plain text, which is exactly what an
 * unhighlighted diff looked like before.
 */
export function highlightDiffSource(
  code: string,
  language: string | undefined,
): DiffSyntaxLine[] | null {
  if (!language || language === 'text') return null;
  if (code.length > DIFF_HIGHLIGHT_MAX_CHARS) return null;
  if (!refractor.registered(language)) return null;
  try {
    const tree = refractor.highlight(code, language) as unknown as HastNode;
    const tokens: DiffSyntaxToken[] = [];
    for (const child of tree.children ?? []) {
      collectTokens(child, 'plain', tokens);
    }
    return toLines(tokens);
  } catch {
    // A grammar that throws must not take the diff down with it.
    return null;
  }
}
