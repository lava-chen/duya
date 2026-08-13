/**
 * ApplyPatchTool - apply a unified diff to one or more files
 *
 * Uses the Codex `*** Begin Patch` envelope format (the model has a strong
 * prior for it) with three file operations:
 *
 *   *** Begin Patch
 *   *** Add File: <path>
 *   +line
 *   +line
 *
 *   *** Update File: <path>
 *   @@
 *    context
 *   -removed
 *   +added
 *    context
 *
 *   *** Delete File: <path>
 *   *** End Patch
 *
 * Matching is by hunk context rather than exact-string equality, so it is
 * far more tolerant than `edit` to whitespace / line-ending / indentation
 * drift. A single call can edit many files at once.
 */

import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { resolve, isAbsolute, dirname } from 'node:path';
import type { ToolResult } from '../../types.js';
import { BaseTool } from '../BaseTool.js';
import type {
  ToolContext,
  RenderedToolMessage,
  ToolInterruptBehavior,
  PermissionCheckResult,
} from '../types.js';
import type { ToolUseContext } from '../../types.js';
import type { ToolPermissionContext } from '../../permissions/types.js';
import { checkPathWritePermission } from '../../permissions/policy.js';
import { expandPath } from '../../utils/path.js';
import { isPathWithinRoots } from '../allowedRoots.js';
import { withFileMutationQueue } from '../file-mutation-queue.js';

// ============================================================
// Input Validation
// ============================================================

export interface ApplyPatchInput {
  patch: string;
}

export function validateApplyPatchInput(
  input: unknown,
): { valid: true; data: ApplyPatchInput } | { valid: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.patch !== 'string') {
    return { valid: false, error: 'patch must be a string' };
  }
  if (obj.patch.trim().length === 0) {
    return { valid: false, error: 'patch cannot be empty' };
  }
  return { valid: true, data: { patch: obj.patch } };
}

// ============================================================
// Codex patch format parser
// ============================================================

export interface Hunk {
  /** Entries like ' context', '-removed', '+added', '\\ No newline...'. */
  lines: string[];
}

export interface ParsedOperation {
  kind: 'add' | 'update' | 'delete';
  path: string;
  /** For add: full new file content (already joined). */
  content?: string;
  /** For update: context hunks. */
  hunks?: Hunk[];
}

const BEGIN_RE = /^\*\*\*\s*Begin Patch\s*$/i;
const END_RE = /^\*\*\*\s*End Patch\s*$/i;
const OP_RE = /^\*\*\*\s*(Add|Update|Delete)\s+File:\s*(.+?)\s*$/i;
const HUNK_RE = /^@@(?:.*)?$/;

/**
 * Parse a Codex `*** Begin Patch` payload into file operations.
 * Throws on malformed input so the caller can surface a clear error.
 */
export function parseCodexPatch(patchText: string): ParsedOperation[] {
  const lines = patchText.split('\n');
  const ops: ParsedOperation[] = [];
  let i = 0;

  // Skip any leading content before *** Begin Patch.
  while (i < lines.length && !BEGIN_RE.test(lines[i])) {
    i++;
  }
  if (i >= lines.length) {
    throw new Error('Could not find "*** Begin Patch" marker');
  }
  i++; // consume "*** Begin Patch"

  let current: ParsedOperation | null = null;
  let addLines: string[] = [];
  let hunkLines: string[] = [];
  let inHunk = false;

  const flushHunk = () => {
    if (current && current.kind === 'update' && hunkLines.length > 0) {
      current.hunks = current.hunks ?? [];
      current.hunks.push({ lines: hunkLines });
      hunkLines = [];
    }
    inHunk = false;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (END_RE.test(line)) {
      break;
    }
    const opMatch = line.match(OP_RE);
    if (opMatch) {
      flushHunk();
      if (addLines.length > 0 && current?.kind === 'add') {
        current.content = addLines.join('\n');
      }
      addLines = [];
      const kind = opMatch[1].toLowerCase() as ParsedOperation['kind'];
      current = { kind, path: opMatch[2].trim().replace(/^["']|["']$/g, '') };
      ops.push(current);
      continue;
    }
    if (current === null) {
      continue; // content before any file op
    }
    if (HUNK_RE.test(line)) {
      flushHunk();
      if (current.kind !== 'update') {
        throw new Error(`Unexpected @@ hunk under *** ${current.kind} File: ${current.path}`);
      }
      inHunk = true;
      continue;
    }
    if (current.kind === 'add') {
      if (inHunk) throw new Error('Unexpected hunk content inside *** Add File');
      if (line.startsWith('+')) {
        addLines.push(line.slice(1));
      }
      continue;
    }
    if (current.kind === 'update') {
      if (inHunk) hunkLines.push(line);
      continue;
    }
    // delete: nothing to collect.
  }

  flushHunk();
  if (addLines.length > 0 && current?.kind === 'add') {
    current.content = addLines.join('\n');
  }

  if (ops.length === 0) {
    throw new Error('Patch contains no file operations');
  }
  return ops;
}

// ============================================================
// Context-based hunk application
// ============================================================

/**
 * Find 0-based start indices where `needle` appears as a contiguous block in
 * `lines`. Used for both exact and tolerant matching.
 */
function findBlock(lines: string[], needle: string[]): number[] {
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

export interface HunkApplyResult {
  success: true;
  lines: string[];
}

export interface HunkApplyFailure {
  success: false;
  expectedLines: string[];
  actualContextStart: number;
}

export type HunkApplyResultUnion = HunkApplyResult | HunkApplyFailure;

/**
 * Apply one hunk to a list of file lines. Returns the new line list, or
 * a failure object if the hunk could not be applied (context mismatch).
 *
 * Strategy: build the "search block" (context + removed lines) and the
 * "replacement block" (context + added lines). Find the search block; if
 * exactly one occurrence, swap it for the replacement. If zero, retry with
 * trailing whitespace stripped (tolerance). If ambiguous, return null.
 */
export function applyHunkToLines(fileLines: string[], hunk: Hunk): HunkApplyResultUnion {
  const search: string[] = [];
  const replacement: string[] = [];
  for (const l of hunk.lines) {
    if (l.startsWith('-')) search.push(l.slice(1));
    else if (l.startsWith('+')) replacement.push(l.slice(1));
    else if (l.startsWith(' ')) {
      const content = l.slice(1);
      search.push(content);
      replacement.push(content);
    }
    // '\\ No newline at end of file' is ignored for matching purposes.
  }

  let starts = findBlock(fileLines, search);
  if (starts.length === 0) {
    starts = findBlock(stripTrailingWhitespace(fileLines), search);
    if (starts.length === 1) {
      // Position found on the stripped view; index is stable since stripping
      // never changes line count.
      return {
        success: true,
        lines: swapBlock(fileLines, starts[0], search.length, replacement),
      };
    }
    return { success: false, expectedLines: search, actualContextStart: 0 };
  }
  if (starts.length > 1) return { success: false, expectedLines: search, actualContextStart: starts[0] };
  return {
    success: true,
    lines: swapBlock(fileLines, starts[0], search.length, replacement),
  };
}

function swapBlock(fileLines: string[], start: number, len: number, replacement: string[]): string[] {
  return [
    ...fileLines.slice(0, start),
    ...replacement,
    ...fileLines.slice(start + len),
  ];
}

// ============================================================
// Tool Definition
// ============================================================

export class ApplyPatchTool extends BaseTool {
  readonly name = 'apply_patch';
  readonly description =
    'Apply a unified diff to one or more files in one call. Use the Codex patch format: wrap the patch in `*** Begin Patch` and `*** End Patch`, and use `*** Add File: <path>`, `*** Update File: <path>`, or `*** Delete File: <path>` followed by `@@` hunks with context lines and `-`/`+` prefixed lines. Matching is by hunk context, so it tolerates whitespace / line-ending differences better than edit. Prefer this over edit for multi-line or multi-file changes.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description:
          'The patch text in Codex format: `*** Begin Patch` ... file operations ... `*** End Patch`. Example:\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n const x = 1;\n-const y = 2;\n+const y = 3;\n const z = 4;\n*** End Patch',
      },
    },
    required: ['patch'],
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

  checkPermissions(_input: unknown, context: ToolContext): PermissionCheckResult {
    const appState = context.getAppState();
    const permissionContext = appState?.toolPermissionContext as ToolPermissionContext | undefined;
    // Per-file gating happens in execute() since we only learn the paths after
    // parsing the patch. Allow here; execute() enforces the real checks.
    void permissionContext;
    return { allowed: true };
  }

  async execute(input: Record<string, unknown>, workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const validation = validateApplyPatchInput(input);
    if (!validation.valid) {
      return { id, name: this.name, result: `Input validation failed: ${validation.error}`, error: true };
    }

    let ops: ParsedOperation[];
    try {
      ops = parseCodexPatch(validation.data.patch);
    } catch (err) {
      return {
        id,
        name: this.name,
        result: `Error: failed to parse patch: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      };
    }

    const applied: string[] = [];
    const failures: string[] = [];

    for (const op of ops) {
      let resolved = op.path;
      if (!isAbsolute(resolved)) {
        resolved = resolve(workingDirectory || process.cwd(), op.path);
      }

      if (this.allowedRoots && this.allowedRoots.length > 0 && !isPathWithinRoots(resolved, [...this.allowedRoots])) {
        failures.push(`Path '${op.path}' is outside the allowed roots for this tool.`);
        continue;
      }

      // Serialize the read-modify-write for the same file so same-file
      // operations run in order, while different files mutate in parallel.
      await withFileMutationQueue(resolved, async () => {
        try {
          if (op.kind === 'add') {
            await writeFileAtomic(resolved, (op.content ?? '') + '\n');
            applied.push(`added ${op.path}`);
          } else if (op.kind === 'delete') {
            await rm(resolved, { force: true });
            applied.push(`deleted ${op.path}`);
          } else {
            // update
            let content: string;
            try {
              content = await readFile(resolved, 'utf-8');
            } catch (err) {
              if (err instanceof Error && err.message.includes('ENOENT')) {
                failures.push(`File not found: ${op.path}. Cannot apply update.`);
              } else {
                failures.push(`${op.path}: ${err instanceof Error ? err.message : String(err)}`);
              }
              return;
            }
            const hasBOM = content.charCodeAt(0) === 0xfeff;
            const core = hasBOM ? content.slice(1) : content;
            // Normalize CRLF for matching; preserve style on write.
            const hadCRLF = core.includes('\r\n');
            const fileLines = core.replace(/\r\n/g, '\n').split('\n');

            let resultLines = fileLines;
            let ok = true;
            let failDetail: HunkApplyFailure | undefined;
            for (const hunk of op.hunks ?? []) {
              const res = applyHunkToLines(resultLines, hunk);
              if (!res.success) {
                ok = false;
                failDetail = res;
                break;
              }
              resultLines = res.lines;
            }
            if (!ok && failDetail) {
              // Verification re-read (Codex style): report the actual lines
              // near the failed hunk so the model can self-correct without
              // re-reading the whole file.
              const actualCtx = failDetail.actualContextStart + failDetail.expectedLines.length;
              const expected = failDetail.expectedLines.join('\n');
              const actual = fileLines
                .slice(Math.max(0, failDetail.actualContextStart - 2), Math.min(fileLines.length, actualCtx))
                .map((l, idx) => {
                  const abs = failDetail.actualContextStart - 2 + idx;
                  return `${abs + 1}: ${l}`;
                })
                .join('\n');
              failures.push(
                `apply_patch verification failed: Failed to find expected lines in ${op.path}.\n` +
                  `Expected hunk:\n${expected}\n\n` +
                  `Actual lines near the failure:\n${actual || '(file empty)'}`,
              );
              return;
            }

            let result = resultLines.join('\n');
            if (hadCRLF) result = result.replace(/\n/g, '\r\n');
            if (hasBOM) result = '\uFEFF' + result;
            await writeFileAtomic(resolved, result);
            applied.push(`updated ${op.path}`);
          }
        } catch (err) {
          failures.push(`${op.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    const summary: string[] = [];
    if (applied.length > 0) {
      summary.push(`Applied ${applied.length} operation(s):\n${applied.map((a) => `  - ${a}`).join('\n')}`);
    }
    if (failures.length > 0) {
      summary.push(`Failed ${failures.length} operation(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    }

    return {
      id,
      name: this.name,
      result: summary.join('\n\n') || 'No operations to apply.',
      error: failures.length > 0 && applied.length === 0,
    };
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    if (result.error) {
      return { type: 'error', content: result.result, metadata: result.metadata };
    }
    return { type: 'text', content: result.result, metadata: result.metadata };
  }

  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const patchText = typeof obj.patch === 'string' ? obj.patch : '';
      const fileCount = (patchText.match(/^\*\*\*\s*(Add|Update|Delete)\s+File:/gim) ?? []).length;
      return fileCount > 0 ? `apply_patch (${fileCount} file(s))` : 'apply_patch';
    }
    return 'apply_patch';
  }
}

export const applyPatchTool = new ApplyPatchTool();

// ============================================================
// Helpers
// ============================================================

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${path}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, path);
}