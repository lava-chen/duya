/**
 * result-builder - shape the result string the model sees
 *
 * Three concerns:
 *   1. Truncation: respect max_tokens, but stop at paragraph /
 *      sentence boundaries instead of mid-word.
 *   2. Malware hint: append a system-reminder that asks the model
 *      to consider whether the file might be malware before acting
 *      on it. Skipped for claude-opus-4-6 (model's safety is in
 *      its system prompt).
 *   3. Image reminder: when document content includes images,
 *      tell the model to use the vision tool rather than try to
 *      "read" the base64 from the text result.
 *
 * The output format mirrors the reference implementation's
 * FileReadTool.mapToolResultToToolResultBlockParam: a header with
 * file/method/page metadata, the body, then a series of optional
 * system-reminders. Models know to honor these reminders.
 */

import type { ParseResult, ImageChunk, TextChunk } from '../../file-parser/index.js';

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 25_000;

/**
 * Models where the malware reminder is unnecessary because their
 * system prompt already covers the concern. Keep this list short —
 * every model in the wild should be paranoid about untrusted code.
 */
const MITIGATION_EXEMPT_MODELS = new Set(['claude-opus-4-6']);

/**
 * Truncate a chunk at the nearest paragraph break within the budget.
 * If the chunk itself is shorter than the budget, return it whole.
 * If we have to cut, prefer to end on a sentence terminator and
 * emit an ellipsis so the model knows the content is incomplete.
 */
function truncateChunk(chunk: string, charBudget: number): { text: string; truncated: boolean } {
  if (chunk.length <= charBudget) {
    return { text: chunk, truncated: false };
  }

  // Find a paragraph break within the budget, walking backward
  const paraBreak = chunk.lastIndexOf('\n\n', charBudget);
  if (paraBreak > charBudget / 2) {
    return { text: chunk.slice(0, paraBreak) + '\n\n[…truncated…]', truncated: true };
  }

  // No paragraph break: try sentence boundary
  const sentenceEnders = ['. ', '.\n', '! ', '!\n', '? ', '?\n'];
  let bestSentenceEnd = -1;
  for (const ender of sentenceEnders) {
    const idx = chunk.lastIndexOf(ender, charBudget);
    if (idx > bestSentenceEnd) bestSentenceEnd = idx + ender.length;
  }
  if (bestSentenceEnd > charBudget / 2) {
    return { text: chunk.slice(0, bestSentenceEnd) + '[…truncated…]', truncated: true };
  }

  // Last resort: hard cut on whitespace, never mid-character
  let cut = charBudget;
  while (cut > 0 && !/\s/.test(chunk[cut])) cut--;
  if (cut === 0) cut = charBudget; // pathological case: no whitespace at all
  return { text: chunk.slice(0, cut) + ' […truncated…]', truncated: true };
}

export interface SerializeOptions {
  /** Token cap (default 25_000). */
  maxTokens?: number;
  /** Model name — used to skip the malware reminder for whitelisted models. */
  model?: string;
  /** Absolute path of the file (already resolved). */
  resolvedPath: string;
}

export interface SerializedResult {
  result: string;
  metadata: Record<string, unknown>;
}

/**
 * Convert a ParseResult into the ToolResult string the model sees.
 * Pure function — no I/O, no side effects.
 */
export function serializeParseResult(
  parsed: ParseResult,
  options: SerializeOptions,
): SerializedResult {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  const textChunks = parsed.chunks.filter((c): c is TextChunk => c.type === 'text');
  const imageChunks = parsed.chunks.filter((c): c is ImageChunk => c.type === 'image');

  // Header
  const headerParts: string[] = [`File: ${options.resolvedPath}`];
  if (parsed.extractMethod) headerParts.push(`Method: ${parsed.extractMethod}`);
  if (parsed.pageCount) headerParts.push(`Pages: ${parsed.pageCount}`);
  headerParts.push(`Characters: ${parsed.charCount}`);

  // Body: truncate at paragraph/sentence boundaries
  const bodyLines: string[] = [];
  let accumulated = 0;
  let lastFullyIncludedIdx = -1;
  for (let i = 0; i < textChunks.length; i++) {
    const chunk = textChunks[i];
    const remaining = maxChars - accumulated;
    if (remaining <= 0) break;
    const { text, truncated } = truncateChunk(chunk.text, remaining);
    bodyLines.push(text);
    accumulated += text.length;
    lastFullyIncludedIdx = i;
    if (truncated) {
      // Stop after the first truncation; we don't try to fit more
      // chunks into a budget we've already blown.
      break;
    }
  }
  const includedChunks = lastFullyIncludedIdx + 1;
  const omittedChunks = textChunks.length - includedChunks;
  const body = bodyLines.join('\n\n').trim();

  // Tail reminders
  const reminders: string[] = [];
  if (omittedChunks > 0) {
    reminders.push(
      `<system-reminder>Truncated ${omittedChunks} of ${textChunks.length} text chunks to stay within max_tokens=${maxTokens}. Use the pages parameter (PDF) or line_range (text files) for smaller portions.</system-reminder>`,
    );
  }
  if (imageChunks.length > 0) {
    const imgList = imageChunks
      .map((c) => (c.page !== undefined ? `page ${c.page + 1}` : 'inline'))
      .join(', ');
    reminders.push(
      `<system-reminder>File contains ${imageChunks.length} image(s) (${imgList}). The read tool surfaces text only. Call the vision tool on the same path to analyze images.</system-reminder>`,
    );
  }
  if (!isMalwareExempt(options.model)) {
    reminders.push(MALWARE_REMINDER);
  }

  const result = reminders.length > 0
    ? `${headerParts.join('\n')}\n\n${body}\n\n${reminders.join('\n\n')}`
    : `${headerParts.join('\n')}\n\n${body}`;

  // Metadata envelope (for UI rendering and downstream consumers)
  const metadata: Record<string, unknown> = {
    filePath: options.resolvedPath,
    charCount: parsed.charCount,
    extractMethod: parsed.extractMethod,
  };
  if (parsed.pageCount) metadata.pageCount = parsed.pageCount;
  if (imageChunks.length > 0) metadata.imageCount = imageChunks.length;
  if (parsed.thumbnail) metadata.thumbnail = parsed.thumbnail;
  // "truncated" means the model's view of the content is incomplete.
  // Two flavors:
  //   - omittedChunks > 0: tail chunks were dropped (separate reminder)
  //   - last chunk was chunk-truncated (in-body ellipsis)
  if (omittedChunks > 0 || bodyLines.length === 0) {
    metadata.truncated = true;
    metadata.truncatedChunks = omittedChunks;
  } else {
    // Detect in-body truncation marker (e.g. "[…truncated…]")
    const lastLine = bodyLines[bodyLines.length - 1] ?? '';
    if (/truncated/i.test(lastLine)) {
      metadata.truncated = true;
      metadata.truncatedWithinLastChunk = true;
    }
  }

  return { result, metadata };
}

/**
 * System reminder injected after a successful file read to ask the
 * model to consider whether the file is malware. The reference
 * implementation's exact wording — kept verbatim because model
 * behavior is sensitive to phrasing.
 */
export const MALWARE_REMINDER =
  '\n\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.\n</system-reminder>\n';

export function isMalwareExempt(model: string | undefined): boolean {
  if (!model) return false;
  // Try the canonical (short) name first; fall back to the full id
  // in case the caller passed a fully qualified model identifier.
  if (MITIGATION_EXEMPT_MODELS.has(model)) return true;
  const shortName = model.split('/').pop() ?? model;
  return MITIGATION_EXEMPT_MODELS.has(shortName);
}
