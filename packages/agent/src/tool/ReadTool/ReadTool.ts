/**
 * ReadTool - File reading tool (Robust)
 *
 * Production-hardened on top of the multimodal upgrade. The shape is
 * the same two-mode dispatch (text vs document), but the validation,
 * security, error recovery, and result formatting layers all do more.
 *
 * What's new vs the previous version:
 *   - zod schema replaces the hand-rolled if-chain
 *   - device files (/dev/zero, /proc/fd/0, ...) blocked at validation
 *   - magic-byte detection: a binary renamed to .txt is refused
 *   - ENOENT suggests a similar file or thin-space macOS fix
 *   - mtime-based dedup returns a stub when content didn't change
 *   - truncation respects paragraph/sentence boundaries
 *   - malware reminder injected (skipped for claude-opus-4-6)
 *   - DUYA_FILE_PARSER_DISABLED kill switch on the document path
 */

import { readFile, stat, open } from 'node:fs/promises';
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
import { checkPathReadPermission } from '../../permissions/pathPermission.js';
import { expandPath } from '../../utils/path.js';
import { getFileParserConfig } from '../../file-parser/config.js';
import {
  NodeFileParser,
  getParser,
  type ParseResult,
} from '../../file-parser/index.js';
import {
  validateReadInput,
  type ReadInput,
} from './schema.js';
import {
  isUNCPath,
  isBlockedDevicePath,
  detectBinarySignature,
  looksBinaryByHeuristic,
} from './security.js';
import {
  getAlternateScreenshotPath,
  findSimilarFile,
  suggestPathUnderCwd,
} from './path-suggest.js';
import {
  getReadStateStore,
  getFileMtimeMs,
  type ReadState,
} from './file-state.js';
import { serializeParseResult, MALWARE_REMINDER } from './result-builder.js';

// Re-export ReadInput + validateReadInput for tests / external callers
export { validateReadInput } from './schema.js';
export type { ReadInput } from './schema.js';

const MAX_LINES = 10000;
const DEFAULT_MAX_TOKENS = 25_000;
const PAGE_RANGE_RE = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.yaml', '.yml', '.toml',
  '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.vue', '.svelte', '.mdx', '.astro',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php',
  '.sql', '.graphql', '.proto',
  '.env', '.gitignore', '.gitattributes',
  '.ini', '.conf', '.config', '.log',
]);
const BINARY_SNIFF_BYTES = 16;
const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.';

function isDocMode(input: ReadInput, ext: string | null): boolean {
  if (input.line_range) return false;
  if (input.pages) return true;
  if (ext && TEXT_EXTENSIONS.has(ext)) return false;
  return true;
}

function parsePageRange(pages: string): { first: number; last: number | null } | null {
  const m = pages.match(PAGE_RANGE_RE);
  if (!m) return null;
  const first = parseInt(m[1], 10);
  const last = m[2] === undefined ? null : parseInt(m[2], 10);
  if (first < 1) return null;
  if (last !== null && last < first) return null;
  return { first, last };
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function parseLineRange(lineRange?: { start: number; end: number }): { start: number; end: number } | undefined {
  if (!lineRange) return undefined;
  const start = Math.max(1, lineRange.start || 1);
  const end = lineRange.end ?? -1;
  if (start > end && end !== -1) return undefined;
  return { start, end };
}

let sharedParser: NodeFileParser | null = null;
function getSharedParser(): NodeFileParser {
  if (!sharedParser) {
    const config = getFileParserConfig();
    sharedParser = new NodeFileParser({
      sessionId: 'read-tool',
      parseTimeoutMs: config.parseTimeoutMs,
      cacheTtlMs: config.cacheTtlMs,
      maxConcurrent: config.maxConcurrent,
    });
  }
  return sharedParser;
}

export function _resetSharedParser(): void {
  if (sharedParser) sharedParser.dispose();
  sharedParser = null;
}

export class ReadTool extends BaseTool {
  readonly name = 'read';
  readonly description = 'Read the contents of a file from the file system. Supports text files (with optional line ranges), PDFs, Word documents (.docx), PowerPoint files (.pptx), and images. Use the `pages` parameter for PDFs to read specific page ranges. Use the vision tool for actual image analysis.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file to read. Can be absolute or relative to the working directory.',
      },
      line_range: {
        type: 'object',
        description: 'Optional line range to read a text file. If not specified, reads the entire file (or routes to the document parser for binary formats).',
        properties: {
          start: { type: 'number', description: 'The starting line number (1-indexed).' },
          end: { type: 'number', description: 'The ending line number (1-indexed, inclusive). Use -1 to read to end of file.' },
        },
      },
      pages: {
        type: 'string',
        description: 'Optional PDF page range, e.g. "1-5" or "3". Only valid for PDF files. If not provided, the entire document is read.',
      },
      max_tokens: {
        type: 'number',
        description: 'Optional token cap for the returned content (default 25000). Documents exceeding this limit are truncated with a system reminder.',
      },
    },
    required: ['file_path'],
  };

  constructor(private parser: NodeFileParser = getSharedParser()) {
    super();
  }

  get interruptBehavior(): ToolInterruptBehavior {
    return 'block';
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  checkPermissions(input: unknown, context: ToolContext): PermissionCheckResult {
    const validation = validateReadInput(input);
    if (!validation.valid) {
      return { allowed: false, reason: 'Invalid input' };
    }
    const appState = context.getAppState();
    const permissionContext = appState?.toolPermissionContext as ToolPermissionContext | undefined;
    return checkPathReadPermission(
      validation.data.file_path,
      context.workingDirectory,
      permissionContext,
    );
  }

  async execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const validation = validateReadInput(input);
    if (!validation.valid) {
      return { id, name: 'read', result: `Input validation failed: ${validation.error}`, error: true };
    }
    return this.dispatch(validation.data, id, workingDirectory, context);
  }

  private async dispatch(
    input: ReadInput,
    id: string,
    workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    // Path-only security checks (no I/O).
    if (isUNCPath(input.file_path)) {
      return { id, name: 'read', error: true, result: 'Security check failed: UNC paths are not allowed' };
    }
    if (isBlockedDevicePath(input.file_path)) {
      return {
        id, name: 'read', error: true,
        result: `Security check failed: '${input.file_path}' is a device file that would block or produce infinite output.`,
      };
    }

    const rawExt = input.file_path.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? null;

    if (!isDocMode(input, rawExt)) {
      return readFileContent(input, id, workingDirectory, context);
    }
    return this.readAsDocument(input, id, workingDirectory, context, rawExt);
  }

  private async readAsDocument(
    input: ReadInput,
    id: string,
    workingDirectory?: string,
    context?: ToolUseContext,
    rawExt: string | null = null,
  ): Promise<ToolResult> {
    if (getFileParserConfig().disabled) {
      return {
        id, name: 'read', error: true,
        result: `Error: File parser is disabled (DUYA_FILE_PARSER_DISABLED). Read tools for ${input.file_path} are unavailable in this configuration.`,
      };
    }

    try {
      const resolved = expandPath(input.file_path, workingDirectory);

      // Resolve extension once so we can skip the magic-byte sniff
      // for files the document parser already knows how to handle.
      // (Otherwise a renamed PNG with .docx extension would be
      // refused by the magic-byte check before the parser could
      // legitimately process it.)
      const ext = (rawExt ?? resolved.toLowerCase().match(/\.[^./\\]+$/)?.[0]) || null;

      if (!ext || !getParser(ext)) {
        // No parser for this extension. Magic-byte sniff is the
        // only thing that could tell us what's actually inside;
        // if it's recognizable as a known binary format, surface
        // a clear error rather than crashing on a UTF-8 decode.
        const magicCheck = await sniffBinary(resolved);
        const formatHint = magicCheck.binary
          ? ` (${magicCheck.format ?? 'binary'})`
          : '';
        return {
          id, name: 'read', error: true,
          result: `Error: Cannot read '${input.file_path}' — unsupported binary format (${ext ?? 'no extension'})${formatHint}. Use a tool that handles this format directly.`,
        };
      }

      let statResult: Awaited<ReturnType<typeof stat>>;
      try {
        statResult = await stat(resolved);
      } catch (err) {
        if (err instanceof Error && err.message.includes('ENOENT')) {
          return suggestMissingFileError(id, input.file_path, resolved, workingDirectory);
        }
        throw err;
      }
      if (statResult.isDirectory()) {
        return {
          id, name: 'read', error: true,
          result: `Error: Path is a directory, not a file: ${normalizePath(resolved)}`,
        };
      }

      const result = await this.parser.parseFile(resolved, context?.abortController?.signal);
      const { result: text, metadata } = serializeParseResult(result, {
        maxTokens: input.max_tokens ?? DEFAULT_MAX_TOKENS,
        model: context?.options?.mainLoopModel,
        resolvedPath: normalizePath(resolved),
      });
      return { id, name: 'read', result: text, metadata };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { id, name: 'read', error: true, result: `Error reading file: ${msg}` };
    }
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    if (result.error) {
      return { type: 'error', content: result.result, metadata: result.metadata };
    }
    const lines = result.result.split('\n').length;
    const hasLineNumbers = /^\d+:\s/.test(result.result);
    if (hasLineNumbers) {
      return { type: 'code', content: result.result, metadata: { ...result.metadata, lineCount: lines } };
    }
    return { type: 'text', content: result.result, metadata: result.metadata };
  }

  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const path = obj.file_path as string | undefined;
      const range = obj.line_range as { start: number; end: number } | undefined;
      const pages = obj.pages as string | undefined;
      if (path) {
        if (range) return `read: ${path}:${range.start}-${range.end}`;
        if (pages) return `read: ${path} (pdf, pages ${pages})`;
        return `read: ${path}`;
      }
    }
    return 'read';
  }
}

// ============================================================
// Module-level helpers
// ============================================================

/**
 * Read the first 16 bytes of a file to detect binary formats via
 * magic-byte signatures. Falls back to a non-printable-ratio
 * heuristic if no signature matches.
 *
 * Used by both ReadTool.readAsDocument and readFileContent so that
 * text-mode and document-mode reads share the same safety net.
 */
async function sniffBinary(resolvedPath: string): Promise<{ binary: boolean; format?: string }> {
  let head: Buffer;
  try {
    const fh = await open(resolvedPath, 'r');
    try {
      const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return { binary: false };
  }
  const sig = detectBinarySignature(head);
  if (sig) return { binary: true, format: sig };
  if (looksBinaryByHeuristic(head)) return { binary: true, format: 'binary (heuristic)' };
  return { binary: false };
}

const MITIGATION_EXEMPT_MODELS = new Set(['claude-opus-4-6']);

/** Test override: when true, suppress the malware reminder regardless of model. */
const MALWARE_EXEMPT_MODEL_TEST_OVERRIDE = false;

function isMalwareExempt(model: string | undefined): boolean {
  if (!model) return false;
  if (MITIGATION_EXEMPT_MODELS.has(model)) return true;
  const short = model.split('/').pop() ?? model;
  return MITIGATION_EXEMPT_MODELS.has(short);
}

const FILE_NOT_FOUND_CWD_NOTE = 'Current working directory:';

/**
 * Top-level ENOENT helper. Used by both the document-mode dispatch
 * (ReadTool.handleMissingFile) and the text-mode readFileContent so
 * path suggestions stay consistent across both paths.
 */
async function suggestMissingFileError(
  id: string,
  inputPath: string,
  resolvedPath: string,
  cwd: string | undefined,
): Promise<ToolResult> {
  const baseMessage = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${cwd ?? '(unknown)'}.`;

  // 1. macOS screenshot thin-space variant
  const altPath = getAlternateScreenshotPath(resolvedPath);
  if (altPath) {
    try {
      const altStat = await stat(altPath);
      if (altStat.isFile()) {
        return {
          id, name: 'read', error: true,
          result: `${baseMessage} Note: macOS screenshots may use a thin space (U+202F) before AM/PM — the alternate path '${normalizePath(altPath)}' exists.`,
        };
      }
    } catch {
      // fall through
    }
  }

  // 2. cwd-relative suggestion
  const cwdSuggestion = suggestPathUnderCwd(inputPath, cwd);
  if (cwdSuggestion) {
    return {
      id, name: 'read', error: true,
      result: `${baseMessage} Did you mean ${normalizePath(cwdSuggestion)}?`,
    };
  }

  // 3. similar filename in same directory
  const similar = findSimilarFile(resolvedPath);
  if (similar) {
    return {
      id, name: 'read', error: true,
      result: `${baseMessage} Did you mean ${normalizePath(similar)}?`,
    };
  }

  return {
    id, name: 'read', error: true,
    result: `Error: File not found: ${normalizePath(inputPath)}`,
  };
}

export async function readFileContent(
  input: ReadInput,
  id: string,
  workingDirectory?: string,
  _context?: ToolUseContext,
): Promise<ToolResult> {
  const validation = validateReadInput(input);
  if (!validation.valid) {
    return { id, name: 'read', result: `Input validation failed: ${validation.error}`, error: true };
  }
  const { file_path, line_range } = validation.data;

  // Defense in depth: re-check the security guards even though
  // dispatch() should have caught them. readFileContent is exported
  // as a top-level function and other callers may bypass dispatch.
  if (isUNCPath(file_path)) {
    return { id, name: 'read', error: true, result: 'Security check failed: UNC paths are not allowed' };
  }
  if (isBlockedDevicePath(file_path)) {
    return {
      id, name: 'read', error: true,
      result: `Security check failed: '${file_path}' is a device file that would block or produce infinite output.`,
    };
  }

  try {
    const resolvedPath = expandPath(file_path, workingDirectory);

    // mtime-based dedup: if the model has already read this exact
    // range and the file hasn't been modified, return a stub.
    // Bypass when the read itself is a partial view (line_range
    // with end != -1 means "I only want a slice" — those don't
    // dedup because the model might have meant a different slice
    // by mistake, and the stub would hide the bug).
    const requestedOffset = line_range?.start ?? 1;
    const requestedLimit = line_range?.end;
    const isPartialView = line_range !== undefined && line_range.end !== -1;
    if (!isPartialView) {
      const existing = getReadStateStore().get(resolvedPath);
      const mtimeMs = getFileMtimeMs(resolvedPath);
      if (existing && mtimeMs !== undefined && existing.timestamp === mtimeMs) {
        return {
          id, name: 'read', result: FILE_UNCHANGED_STUB,
          metadata: { filePath: normalizePath(resolvedPath), unchanged: true, charCount: existing.content.length },
        };
      }
    }

    try {
      const stats = await stat(resolvedPath);
      if (stats.isDirectory()) {
        return { id, name: 'read', result: `Error: Path is a directory, not a file: ${normalizePath(resolvedPath)}`, error: true };
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('ENOENT')) {
        return suggestMissingFileError(id, file_path, resolvedPath, workingDirectory);
      }
    }

    // Magic-byte sniff: refuse to feed binary content as text
    const magicCheck = await sniffBinary(resolvedPath);
    if (magicCheck.binary) {
      return {
        id, name: 'read', error: true,
        result: `Security check failed: '${file_path}' appears to be a ${magicCheck.format ?? 'binary'} file. Use a tool that handles this format directly.`,
      };
    }

    const range = parseLineRange(line_range);
    const content = await readFile(resolvedPath, 'utf-8');
    const lines = content.split('\n');

    let output: string;
    let startLine: number;
    let endLine: number;
    if (range) {
      const startIdx = range.start - 1;
      endLine = range.end === -1 ? lines.length : range.end;
      if (startIdx >= lines.length) {
        return {
          id, name: 'read', result: `Error: Start line ${range.start} exceeds file length (${lines.length} lines)`, error: true,
        };
      }
      const requestedLines = endLine - startIdx;
      if (requestedLines > MAX_LINES) {
        return {
          id, name: 'read',
          result: `Error: Requested ${requestedLines} lines exceeds maximum of ${MAX_LINES}. Please use a smaller line_range.`,
          error: true,
        };
      }
      const resultLines = lines.slice(startIdx, endLine);
      output = resultLines.map((line, i) => `${range.start + i}: ${line}`).join('\n');
      startLine = range.start;
    } else {
      output = content;
      startLine = 1;
      endLine = lines.length;
    }

    // Cache for next time (mtime + content)
    const mtimeMs = getFileMtimeMs(resolvedPath);
    if (mtimeMs !== undefined) {
      const state: ReadState = {
        content: output,
        timestamp: mtimeMs,
        offset: requestedOffset,
        limit: requestedLimit,
      };
      getReadStateStore().set(resolvedPath, state);
    }

    // Malware reminder (skipped for whitelisted models)
    const shouldRemind = !isMalwareExempt(_context?.options?.mainLoopModel);
    const tail = shouldRemind ? `\n\n${MALWARE_REMINDER.trim()}` : '';

    return {
      id,
      name: 'read',
      result: `File: ${normalizePath(resolvedPath)}\nLines: ${startLine}-${endLine}\n\n${output}${tail}`,
      metadata: { filePath: normalizePath(resolvedPath), lineCount: endLine - startLine + 1 },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage.includes('ENOENT') || errorMessage.includes('no such file')) {
      return { id, name: 'read', result: `Error: File not found: ${normalizePath(file_path)}`, error: true };
    }
    if (errorMessage.includes('EISDIR') || errorMessage.includes('is a directory')) {
      return { id, name: 'read', result: `Error: Path is a directory, not a file: ${normalizePath(file_path)}`, error: true };
    }
    if (errorMessage.includes('EACCES') || errorMessage.includes('permission')) {
      return { id, name: 'read', result: `Error: Permission denied: ${normalizePath(file_path)}`, error: true };
    }
    return { id, name: 'read', result: `Error reading file: ${errorMessage}`, error: true };
  }
}

/**
 * @deprecated Use ReadTool class directly
 */
export function createReadTool(): ReadTool {
  return new ReadTool();
}
