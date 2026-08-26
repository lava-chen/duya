/**
 * EditTool - File editing tool (Enhanced)
 * Precise file editing based on diff algorithm
 * Adds input validation and security checks
 */

import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { diffLines } from 'diff';
import type { ToolResult } from '../../types.js';
import { BaseTool } from '../BaseTool.js';
import type {
  RenderedToolMessage,
  ToolInterruptBehavior,
  ToolContext,
  PermissionCheckResult,
} from '../types.js';
import type { ToolUseContext } from '../../types.js';
import type { ToolPermissionContext } from '../../permissions/types.js';
import { checkPathWritePermission } from '../../permissions/policy.js';
import { expandPath } from '../../utils/path.js';
import { isPathWithinRoots } from '../allowedRoots.js';
import { withFileMutationQueue } from '../file-mutation-queue.js';
import { FileSnapshotStore } from '../file-snapshot-store.js';
import { computeContentSha, getFileReadState, recordFileRead } from '../file-read-state.js';

/** Module-level content-addressed snapshot store (shared with Write/ApplyPatch). */
const fileSnapshotStore = new FileSnapshotStore();

// ============================================================
// Types
// ============================================================

export interface EditUnit {
  old_string: string;
  new_string: string;
}

export interface EditToolInput {
  file_path: string;
  edits: EditUnit[];
}

// ============================================================
// Input Validation
// ============================================================

/**
 * Validates EditTool input. Accepts the modern `edits[]` array form (one or
 * more targeted replacements) or the legacy single-edit `old_string` /
 * `new_string` form, which is normalized into a one-element `edits` array.
 */
export function validateEditInput(input: unknown): { valid: true; data: EditToolInput } | { valid: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }

  const obj = input as Record<string, unknown>;

  if (!obj.file_path || typeof obj.file_path !== 'string') {
    return { valid: false, error: 'file_path must be a string' };
  }

  if (obj.file_path.trim().length === 0) {
    return { valid: false, error: 'file_path cannot be empty' };
  }

  let edits: EditUnit[];
  if (Array.isArray(obj.edits)) {
    edits = [];
    for (let i = 0; i < obj.edits.length; i++) {
      const e = obj.edits[i] as Record<string, unknown> | undefined;
      if (!e || typeof e !== 'object') {
        return { valid: false, error: `edits[${i}] must be an object` };
      }
      if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
        return { valid: false, error: `edits[${i}] must contain old_string and new_string strings` };
      }
      if (e.old_string.trim().length === 0) {
        return { valid: false, error: `edits[${i}].old_string cannot be empty` };
      }
      edits.push({ old_string: e.old_string, new_string: e.new_string });
    }
  } else {
    // Legacy single-edit form.
    if (typeof obj.old_string !== 'string' || typeof obj.new_string !== 'string') {
      return { valid: false, error: 'Provide either edits[] or both old_string and new_string' };
    }
    if (obj.old_string.trim().length === 0) {
      return { valid: false, error: 'old_string cannot be empty' };
    }
    edits = [{ old_string: obj.old_string, new_string: obj.new_string }];
  }

  if (edits.length === 0) {
    return { valid: false, error: 'edits must contain at least one replacement' };
  }

  return {
    valid: true,
    data: {
      file_path: obj.file_path as string,
      edits,
    },
  };
}

// ============================================================
// Tool Definition
// ============================================================

export class EditTool extends BaseTool {
  readonly name = 'edit';
  readonly description = 'Edit a single file via exact text replacement. Provide edits[], each with a unique old_string and a new_string. Match each old_string against the original file (not earlier edits) and keep it as small as possible while still unique — do not pad with large unchanged regions. Use one call with multiple edits[] for several locations in one file. For multi-file changes use apply_patch; never use cat, sed, or Python to write files.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to edit',
      },
      edits: {
        type: 'array',
        description: 'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping edits. For backward compatibility, old_string + new_string is also accepted as a single edit.',
        items: {
          type: 'object',
          properties: {
            old_string: {
              type: 'string',
              description: 'The exact string to find and replace. Must be globally unique in the file; keep it as small as possible while still unique — do not include large unchanged regions.',
            },
            new_string: {
              type: 'string',
              description: 'The new string to replace the old_string with',
            },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['file_path', 'edits'],
  };

  private readonly allowedRoots?: readonly string[];

  constructor(opts: { allowedRoots?: string[] } = {}) {
    super();
    this.allowedRoots = opts.allowedRoots;
  }

  get interruptBehavior(): ToolInterruptBehavior {
    return 'cancel';
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  checkPermissions(input: unknown, context: ToolContext): PermissionCheckResult {
    const validation = validateEditInput(input);
    if (!validation.valid) {
      return { allowed: false, reason: 'Invalid input' };
    }

    const { file_path } = validation.data;
    const appState = context.getAppState();
    const permissionContext = appState?.toolPermissionContext as ToolPermissionContext | undefined;

    return checkPathWritePermission(file_path, context.workingDirectory, permissionContext);
  }

  async execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const validation = validateEditInput(input);
    if (!validation.valid) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    if (this.allowedRoots && this.allowedRoots.length > 0) {
      const resolved = expandPath(validation.data.file_path, workingDirectory);
      if (!isPathWithinRoots(resolved, [...this.allowedRoots])) {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          error: true,
          result: `Path '${validation.data.file_path}' is outside the allowed roots for this tool.`,
        };
      }
    }

    return executeEdit(crypto.randomUUID(), validation.data, workingDirectory);
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    if (result.error) {
      return {
        type: 'error',
        content: result.result,
        metadata: result.metadata,
      };
    }

    const lines = result.result.split('\n');
    const hasDiff = lines.some(l => l.startsWith('Successfully edited') || l.startsWith('+') || l.startsWith('-'));

    if (hasDiff) {
      return {
        type: 'code',
        content: result.result,
        metadata: result.metadata,
      };
    }

    return {
      type: 'text',
      content: result.result,
      metadata: result.metadata,
    };
  }

  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const path = obj.file_path as string | undefined;
      if (path) {
        return `edit: ${path}`;
      }
    }
    return 'edit';
  }
}

export const editTool = new EditTool();

// ============================================================
// Edit Execution
// ============================================================

/**
 * Return the 0-based start indices where `needle` occurs as a contiguous
 * block inside `lines`. Used for both exact matching and diagnostics.
 */
function findOccurrences(lines: string[], needle: string[]): number[] {
  const starts: number[] = [];
  if (needle.length === 0 || needle.length > lines.length) return starts;
  for (let i = 0; i <= lines.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (lines[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) starts.push(i);
  }
  return starts;
}

function stripTrailingWhitespace(lines: string[]): string[] {
  return lines.map((l) => l.replace(/[ \t]+$/, ''));
}

/**
 * Progressive Unicode normalization for tolerant matching. Applies NFKC,
 * trims trailing whitespace per line, then folds smart quotes, dashes, and
 * special spaces to their ASCII equivalents. Never adds/removes newlines, so
 * the resulting line count matches the input.
 */
function normalizeForFuzzyMatch(text: string): string {
  let s = text.normalize('NFKC');
  s = s
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
  s = s.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  s = s.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  s = s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-');
  s = s.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
  return s;
}

/**
 * Old_string matching variants, tried in order. The first (exact, CRLF
 * normalized) is what the model intended; the rest are tolerant fallbacks
 * (P1-4) for the common failure modes of whitespace/line-ending drift.
 * Each variant carries a note so the success message can say which one hit.
 */
function oldStringVariants(normalizedOld: string): Array<{ needle: string[]; note: string }> {
  const base = normalizedOld.split('\n');
  const variants: Array<{ needle: string[]; note: string }> = [];
  variants.push({ needle: base, note: '' });
  const stripped = stripTrailingWhitespace(base);
  if (stripped.join('\n') !== base.join('\n')) {
    variants.push({ needle: stripped, note: 'matched after stripping trailing whitespace from old_string lines' });
  }
  return variants;
}

/** Prefix-similarity ratio in [0,1]; used to find the closest file line. */
function prefixSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  let prefix = 0;
  const n = Math.min(a.length, b.length);
  while (prefix < n && a[prefix] === b[prefix]) prefix++;
  return prefix / max;
}

/** Index of the first differing char (or min length if one is a prefix). */
function firstDiffIndex(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

/** Render control characters so invisible diffs (CR, LF, tab, spaces) show up. */
function escapeEol(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/** Human-readable byte info for one character position. */
function charInfo(line: string, i: number): string {
  if (i >= line.length) return '<EOF>';
  const c = line[i];
  return `${JSON.stringify(c)} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`;
}

/**
 * Build a detailed "old_string not found" diagnostic (P0-1). Instead of a
 * bare one-liner, surface the closest match line, the first divergence
 * with actual byte values, line-ending/encoding facts, and actionable
 * hints (truncated read / path with spaces / use apply_patch).
 */
function buildNotFoundDiagnostic(opts: {
  filePath: string;
  hasCRLF: boolean;
  hasBOM: boolean;
  lines: string[];
  oldLines: string[];
  editLabel?: string;
}): string {
  const { filePath, hasCRLF, hasBOM, lines, oldLines, editLabel = 'old_string' } = opts;
  const parts: string[] = [`Error: ${editLabel} not found in file: ${filePath}`];

  // Lead with an imperative re-read command (grok-style) so the model treats
  // its cached content as suspect and stops retrying the same stale old_string.
  parts.push('Use the read tool to see the correct string.');
  parts.push('The user (or a prior tool call) may have changed the file since you last read it.');

  const firstLine = oldLines[0];
  if (firstLine !== undefined && lines.length > 0) {
    let bestIdx = -1;
    let bestSim = -1;
    for (let i = 0; i < lines.length; i++) {
      const sim = prefixSimilarity(lines[i], firstLine);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestSim > 0) {
      const baseLineNum = bestIdx + 1;
      // How many of old_string's lines matched contiguously from the best match.
      let contiguous = 1;
      while (
        contiguous < oldLines.length &&
        bestIdx + contiguous < lines.length &&
        lines[bestIdx + contiguous] === oldLines[contiguous]
      ) {
        contiguous++;
      }
      parts.push(`Closest match: line ${baseLineNum} (${contiguous}/${oldLines.length} lines matched contiguously, then diverged).`);
      const fileLineAt = lines[bestIdx + contiguous - 1];
      const oldLineAt = oldLines[contiguous - 1];
      const d = firstDiffIndex(fileLineAt, oldLineAt);
      // firstDiffIndex returns the min length when one line is a prefix of the
      // other, so charInfo would show <EOF> on both sides and the model could
      // not tell which one is truncated. Disambiguate: file-truncated vs
      // over-long (incomplete) old_string.
      const fileEnded = d >= fileLineAt.length;
      const oldEnded = d >= oldLineAt.length;
      if (fileEnded !== oldEnded) {
        if (fileEnded) {
          parts.push(
            `File content is a PREFIX of ${editLabel} at this line (${fileLineAt.length} chars vs expected ${oldLineAt.length}): file ends here, ${editLabel} continues with ${charInfo(oldLineAt, d)}.`,
          );
          parts.push(
            'The file content is shorter than expected — likely truncated by compaction or an incomplete read. ' +
              'Re-read the file (optionally with line_range) to confirm exact bytes, then retry the edit.',
          );
        } else {
          parts.push(
            `${editLabel} is a PREFIX of the file content at this line (${oldLineAt.length} chars vs file ${fileLineAt.length}): ${editLabel} ends here, file continues with ${charInfo(fileLineAt, d)}.`,
          );
          parts.push(
            `${editLabel} may be incomplete or truncated (e.g. cut off by compaction). ` +
              'Include the full line or re-read the file to confirm exact bytes, then retry the edit.',
          );
        }
      } else {
        parts.push(
          `First divergence at file char ${d}: file has ${charInfo(fileLineAt, d)}, old_string expects ${charInfo(oldLineAt, d)}.`,
        );
        parts.push(`  file context: ...${escapeEol(fileLineAt.slice(Math.max(0, d - 20), d + 40))}...`);
        parts.push(`  old_string : ...${escapeEol(oldLineAt.slice(Math.max(0, d - 20), d + 40))}...`);
      }
    }
  }

  if (hasCRLF) parts.push('File uses CRLF line endings (\\r\\n).');
  if (hasBOM) parts.push('File starts with a UTF-8 BOM (U+FEFF).');
  if (/\s/.test(filePath)) parts.push('File path contains a space — double-check the path is exact.');
  parts.push(
    'The old_string may differ from disk by whitespace, indentation, line endings, or encoding. ' +
      'If the content came from an earlier read, it may have been truncated by compaction — re-read the file ' +
      '(optionally with line_range) to confirm exact bytes, or use the apply_patch tool which matches by hunk context instead of exact equality.',
  );
  return parts.join('\n');
}

/**
 * Map fs error messages to friendly tool errors.
 */
function mapFsError(errorMessage: string, filePath: string): string {
  if (errorMessage.includes('ENOENT') || errorMessage.includes('no such file')) {
    return `Error: File not found: ${filePath}`;
  }
  if (errorMessage.includes('EACCES') || errorMessage.includes('permission')) {
    return `Error: Permission denied: ${filePath}`;
  }
  return `Error editing file: ${errorMessage}`;
}

/**
 * mtime comparison with a small tolerance (plan 448). Windows filesystems
 * plus cloud-sync/AV/indexer churn produce meaningless sub-millisecond
 * mtime bumps between two stat() calls, and float equality across separate
 * stat rounds trips is unreliable. Treat mtimes within 1ms as unchanged;
 * real external edits move mtime by far more.
 */
function isMtimeWithinTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

/**
 * Resolution outcome for one edit's old_string against the original file.
 */
type ResolveResult =
  | { kind: 'ok'; start: number; needle: string[]; note: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; occurrences: number; lineNums: number[] };

/**
 * Resolve one old_string against the ORIGINAL normalized content. Tries exact
 * match first, then tolerant trailing-whitespace and Unicode fuzzy fallbacks
 * (P1-4). Returns 'ok' with the 0-based start index and the matched needle
 * lines, 'ambiguous' when the old_string occurs multiple times, or 'missing'.
 */
function resolveEditMatch(normalizedContent: string, normalizedOld: string): ResolveResult {
  const lines = normalizedContent.split('\n');
  const oldLines = normalizedOld.split('\n');

  const exactStarts = findOccurrences(lines, oldLines);
  if (exactStarts.length === 1) {
    return { kind: 'ok', start: exactStarts[0], needle: oldLines, note: '' };
  }
  if (exactStarts.length > 1) {
    return { kind: 'ambiguous', occurrences: exactStarts.length, lineNums: exactStarts.map((i) => i + 1) };
  }

  // Tolerant fallback: strip trailing whitespace from BOTH the file view and
  // the needle. Line counts are unchanged, so a found index maps back.
  for (const v of oldStringVariants(normalizedOld)) {
    const strippedFile = stripTrailingWhitespace(lines);
    const starts = findOccurrences(strippedFile, v.needle);
    if (starts.length === 1) {
      return { kind: 'ok', start: starts[0], needle: v.needle, note: v.note };
    }
  }

  // Unicode fuzzy fallback: normalize the whole file and the needle (NFKC,
  // smart quotes, dashes, special spaces). Line counts are preserved, so a
  // found index maps 1:1 back to `lines`.
  const normalizedFile = normalizeForFuzzyMatch(normalizedContent);
  const normalizedNeedle = normalizeForFuzzyMatch(normalizedOld);
  const starts = findOccurrences(normalizedFile.split('\n'), normalizedNeedle.split('\n'));
  if (starts.length === 1) {
    return {
      kind: 'ok',
      start: starts[0],
      needle: oldLines,
      note: 'matched after Unicode normalization (smart quotes, dashes, spaces)',
    };
  }
  return { kind: 'missing' };
}

/**
 * Generate a compact, human-readable diff of the changes with line numbers,
 * plus the line number of the first change in the new file.
 */
function generateDiffString(oldContent: string, newContent: string, contextLines = 3): { diff: string; firstChangedLine: number | undefined } {
  const parts = diffLines(oldContent, newContent);
  const output: string[] = [];
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const width = String(maxLineNum).length;
  let oldNum = 1;
  let newNum = 1;
  let lastChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split('\n');
    if (raw[raw.length - 1] === '') raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newNum;
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newNum).padStart(width, ' ')} ${line}`);
          newNum++;
        } else {
          output.push(`-${String(oldNum).padStart(width, ' ')} ${line}`);
          oldNum++;
        }
      }
      lastChange = true;
    } else {
      const nextIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      if (lastChange || nextIsChange) {
        const shown = raw.slice(0, contextLines);
        const skipped = raw.length - shown.length;
        for (const line of shown) {
          output.push(` ${String(oldNum).padStart(width, ' ')} ${line}`);
          oldNum++;
          newNum++;
        }
        if (skipped > 0) {
          output.push(` ${''.padStart(width, ' ')} ...`);
          oldNum += skipped;
          newNum += skipped;
        }
      } else {
        oldNum += raw.length;
        newNum += raw.length;
      }
      lastChange = false;
    }
  }

  return { diff: output.join('\n'), firstChangedLine };
}

/**
 * Execute file edits. Supports multiple disjoint edits in one call
 * (matched against the original file, applied in reverse order).
 */
export async function executeEdit(
  toolUseId: string,
  input: EditToolInput,
  workingDirectory?: string,
): Promise<ToolResult> {
  const { file_path, edits } = input;

  // Resolve path
  let resolvedPath = file_path;
  if (!isAbsolute(resolvedPath)) {
    resolvedPath = resolve(workingDirectory || process.cwd(), file_path);
  }

  // Serialize the whole read-modify-write per resolved file so concurrent
  // edits to the same path stay ordered (see file-mutation-queue.ts).
  return withFileMutationQueue(resolvedPath, async () => {
    // Plan 428: anchor edits to a verified read. Refuse to edit a file that
    // was never read in this session, or that changed on disk since the last
    // read — otherwise the model may build old_string from compacted
    // (placeholder) or externally modified content.
    let currentStat: Awaited<ReturnType<typeof stat>>;
    try {
      currentStat = await stat(resolvedPath);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { id: toolUseId, name: 'edit', result: mapFsError(errorMessage, file_path), error: true };
    }

    const readState = getFileReadState(resolvedPath);
    if (!readState) {
      return {
        id: toolUseId,
        name: 'edit',
        result:
          `Error: File has not been read yet: ${file_path}\n` +
          'Read the file first with the read tool, then retry the edit with an old_string taken from the actual file content.',
        error: true,
      };
    }

    // Content must be loaded regardless so the staleness exemption can
    // compare fingerprints (plan 448); the edit needs it anyway.
    let content: string;
    try {
      content = await readFile(resolvedPath, 'utf-8');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { id: toolUseId, name: 'edit', result: mapFsError(errorMessage, file_path), error: true };
    }

    // Staleness: mtime within tolerance AND size identical means untouched.
    // Exemption (claude-code-haha style, plan 448): when mtime/size say the
    // file drifted but the recorded observation was a FULL view whose sha256
    // still matches current disk bytes, the drift was cosmetic (OneDrive sync,
    // antivirus, indexer touching mtime without changing content) and the
    // edit proceeds. Partial views never qualify — a truncated view cannot
    // vouch for content it never saw.
    const mtimeStale = !isMtimeWithinTolerance(readState.mtimeMs, currentStat.mtimeMs);
    const sizeStale = readState.size !== currentStat.size;
    let stale = mtimeStale || sizeStale;
    if (stale && readState.isFullView && readState.contentSha !== undefined) {
      if (computeContentSha(content) === readState.contentSha) {
        stale = false;
      }
    }
    if (stale) {
      return {
        id: toolUseId,
        name: 'edit',
        result:
          `Error: File was modified after the last read: ${file_path}\n` +
          'The file changed on disk since it was last read (bash, apply_patch, or an external process may have touched it). ' +
          'Re-read the file with the read tool, then retry the edit with a fresh old_string.',
        error: true,
      };
    }

    // Plan 429 #3: snapshot the pre-edit content (best-effort) so a session
    // rewind can restore this file. `content` is the untouched on-disk text.
    let preImageSha: string | undefined;
    try {
      preImageSha = await fileSnapshotStore.put(content);
    } catch {
      preImageSha = undefined;
    }

    // Track file facts for diagnostics and to preserve style on write.
    const hasCRLF = content.includes('\r\n');
    const hasBOM = content.charCodeAt(0) === 0xfeff;
    const contentCore = hasBOM ? content.slice(1) : content;

    // Normalize CRLF -> LF for matching. The original style is restored on write.
    const normalizedContent = contentCore.replace(/\r\n/g, '\n');
    const lines = normalizedContent.split('\n');

    // Resolve every edit against the ORIGINAL lines. Fail fast on the first
    // missing / ambiguous / overlapping edit with a specific diagnostic.
    const resolved: Array<{ start: number; needle: string[]; note: string; newText: string }> = [];
    const totalEdits = edits.length;
    for (let i = 0; i < totalEdits; i++) {
      const edit = edits[i];
      const normalizedOld = edit.old_string.replace(/\r\n/g, '\n');
      const oldLines = normalizedOld.split('\n');
      const editLabel = totalEdits === 1 ? 'old_string' : `edits[${i}].old_string`;

      const match = resolveEditMatch(normalizedContent, normalizedOld);
      if (match.kind === 'missing') {
        return {
          id: toolUseId,
          name: 'edit',
          result: buildNotFoundDiagnostic({ filePath: file_path, hasCRLF, hasBOM, lines, oldLines, editLabel }),
          error: true,
        };
      }
      if (match.kind === 'ambiguous') {
        const lineNums = match.lineNums.join(', ');
        return {
          id: toolUseId,
          name: 'edit',
          result: `Error: ${editLabel} appears ${match.occurrences} times in the file (lines ${lineNums}). Please make it unique by including more context.`,
          error: true,
        };
      }
      resolved.push({ start: match.start, needle: match.needle, note: match.note, newText: edit.new_string.replace(/\r\n/g, '\n') });
    }

    // Overlap check: matches must be disjoint regions of the original file.
    const sorted = [...resolved].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1].start + sorted[i - 1].needle.length > sorted[i].start) {
        return {
          id: toolUseId,
          name: 'edit',
          result: `Error: edits overlap in ${file_path}. Merge overlapping edits into one edit that covers the whole block.`,
          error: true,
        };
      }
    }

    try {
      // Apply replacements in reverse order so earlier offsets stay stable.
      let resultLines = [...lines];
      for (const r of [...resolved].sort((a, b) => b.start - a.start)) {
        resultLines = [
          ...resultLines.slice(0, r.start),
          ...r.newText.split('\n'),
          ...resultLines.slice(r.start + r.needle.length),
        ];
      }
      let result = resultLines.join('\n');

      // Restore the original line ending style and BOM so we don't silently
      // rewrite a CRLF/BOM file (which would create a noisy full-file diff).
      if (hasCRLF) result = result.replace(/\n/g, '\r\n');
      if (hasBOM) result = '\uFEFF' + result;

      // Write atomically: write to a temp file in the same directory, then
      // rename. A crash during writeFile would otherwise leave a truncated
      // file in place of the original.
      const tmpPath = `${resolvedPath}.tmp.${Date.now()}`;
      await writeFile(tmpPath, result, 'utf-8');
      await rename(tmpPath, resolvedPath);

      // Re-anchor the read state to this tool's own write so consecutive
      // edits in the same session are not rejected as stale (plan 428).
      // The written string IS the full new content, so record a full-view
      // fingerprint (plan 448) — this also makes the next edit immune to
      // cosmetic mtime churn between the two calls. Best-effort: a racing
      // stat failure just means the next edit asks for a re-read.
      try {
        const postStat = await stat(resolvedPath);
        recordFileRead(resolvedPath, {
          mtimeMs: postStat.mtimeMs,
          size: postStat.size,
          isFullView: true,
          contentSha: computeContentSha(result),
        });
      } catch {
        // ignore
      }

      // Report the applied diff and the first changed line so the model can see
      // exactly what changed without re-reading the whole file.
      const { diff, firstChangedLine } = generateDiffString(normalizedContent, resultLines.join('\n'));
      const blockWord = totalEdits === 1 ? 'block' : 'blocks';
      const changedLine = firstChangedLine !== undefined ? `\nFirst changed line: ${firstChangedLine}` : '';
      const notes = resolved.filter((r) => r.note).map((r) => r.note);
      const noteSuffix = notes.length > 0 ? `\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}` : '';
      const metadata: ToolResult['metadata'] = { filePath: resolvedPath };
      if (preImageSha) metadata.preImageSha = preImageSha;
      return {
        id: toolUseId,
        name: 'edit',
        result: `Successfully edited ${file_path}: ${totalEdits} ${blockWord} changed.${changedLine}\n\n${diff}${noteSuffix}`,
        metadata,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { id: toolUseId, name: 'edit', result: mapFsError(errorMessage, file_path), error: true };
    }
  });
}
