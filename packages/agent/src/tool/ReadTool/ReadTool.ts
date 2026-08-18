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
 *   - every read returns the full deterministic content (no dedup stub,
 *     so identical reads hit the provider prompt cache)
 *   - truncation respects paragraph/sentence boundaries
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
import { checkPathReadPermission } from '../../permissions/policy.js';
import { expandPath } from '../../utils/path.js';
import { isPathWithinRoots } from '../allowedRoots.js';
import { getFileParserConfig } from '../../file-parser/config.js';
import {
  NodeFileParser,
  getParser,
  type ParseChunk,
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
import { serializeParseResult } from './result-builder.js';
import { recordFileRead } from '../file-read-state.js';
import { isModelLikelyMultimodal } from '../../utils/multimodal-detection.js';

// Re-export ReadInput + validateReadInput for tests / external callers
export { validateReadInput } from './schema.js';
export type { ReadInput } from './schema.js';

const MAX_LINES = 10000;
const DEFAULT_MAX_TOKENS = 25_000;
// Full-file (no line_range) text reads are capped at 2000 lines OR 50KB
// (whichever is hit first) so a single read cannot emit unbounded output.
// This matches the ReadTool.description promise. line_range remains the
// escape hatch for reading the rest (helpers plan 428).
const FULL_READ_MAX_LINES = 2000;
const FULL_READ_MAX_BYTES = 50 * 1024; // 50KB, measured as UTF-8 bytes
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
// Image files are not read directly by this tool. They are routed to the
// dedicated `vision_analyze` tool so pixels are never fed to a model that
// can't see them, and analysis stays on the vision tool (not duplicated here).
// Exception: when the active main model is multimodal (see
// isMainModelMultimodal below), ReadTool reads the image back as an inline
// image payload instead, so a vision-capable model sees it directly without
// a forced two-hop vision_analyze call.
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
// Maps a supported image extension to its MIME media type for the inline
// base64 image payload. Mirrors the values used by the document parsers.
const IMAGE_EXTENSION_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

/**
 * Decide whether the active main model can see image content inline.
 *
 * Uses the same heuristic the image-preprocessing path relies on
 * (isModelLikelyMultimodal). When the model is unknown/absent we stay
 * conservative (return false) so the existing "route to vision_analyze"
 * behavior is preserved rather than risking sending pixels to a model
 * that cannot consume them.
 */
export function isMainModelMultimodal(model: string | undefined): boolean {
  return isModelLikelyMultimodal(model ?? '');
}

function isDocMode(input: ReadInput, ext: string | null): boolean {
  // .ipynb must always go through the document parser — its first
  // bytes look like JSON which the binary magic-byte sniff in
  // readFileContent would refuse.
  if (ext === '.ipynb') return true;
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

// Per-session parser instances. The previous global singleton tagged
// every parse with sessionId='read-tool', which meant two concurrent
// sessions shared one parser's internal cache. NodeFileParser's cache
// key includes sessionId for some code paths (e.g. cross-session
// permission gating) and the singleton broke that isolation. Keeping
// one parser per real sessionId restores the intended isolation.
//
// The map is bounded (LRU by insertion order, see getParserForSession)
// so a long-running agent process that spawns many sub-agent sessions
// doesn't accumulate parsers forever. Each NodeFileParser holds its
// own bounded cache; disposing on eviction releases that memory.
const parserBySession = new Map<string, NodeFileParser>();
const MAX_PARSERS = 32;

function getParserForSession(sessionId: string | undefined): NodeFileParser {
  const key = sessionId ?? 'default';
  const existing = parserBySession.get(key);
  if (existing) {
    // Move-to-end so LRU order reflects recent use.
    parserBySession.delete(key);
    parserBySession.set(key, existing);
    return existing;
  }
  const config = getFileParserConfig();
  const parser = new NodeFileParser({
    sessionId: key,
    parseTimeoutMs: config.parseTimeoutMs,
    cacheTtlMs: config.cacheTtlMs,
    maxConcurrent: config.maxConcurrent,
  });
  // Bounded LRU: evict the oldest idle parser when at capacity.
  // We MUST NOT dispose a parser with in-flight work — doing so
  // leaves the pool in a "disposed" state where subsequent parseFile
  // calls on the same session throw "WorkerPool is disposed". If
  // every cached parser is busy, we let the cache grow past MAX_PARSERS
  // rather than abort a running parse; the next idle insertion will
  // reclaim the slot. Worst case (all 32+ parsers permanently busy)
  // is bounded by the number of concurrent sub-agent sessions, which
  // is itself bounded elsewhere.
  if (parserBySession.size >= MAX_PARSERS) {
    let evictKey: string | undefined;
    for (const k of parserBySession.keys()) {
      const p = parserBySession.get(k);
      if (p && p.pendingCount === 0) {
        evictKey = k;
        break;
      }
    }
    if (evictKey !== undefined) {
      const evict = parserBySession.get(evictKey);
      evict?.dispose();
      parserBySession.delete(evictKey);
    }
  }
  parserBySession.set(key, parser);
  return parser;
}

export function _resetSharedParser(): void {
  for (const p of parserBySession.values()) {
    p.dispose();
  }
  parserBySession.clear();
}

export class ReadTool extends BaseTool {
  readonly name = 'read';
  readonly description = 'Read the contents of a file from the file system. Supports text files, PDFs, Word documents (.docx), and PowerPoint files (.pptx). For text files the output is truncated to 2000 lines or 50KB (whichever is hit first); use `line_range` to read large files in chunks and keep advancing the range until the file is complete. Use the `pages` parameter for PDFs to read specific page ranges. Image files (png, jpg, gif, webp, etc.) are NOT read directly by this tool — use the `vision_analyze` tool to analyze image content. Prefer read over cat or sed to examine files.';
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
        description: 'Optional token cap for the returned content (default output is capped at 50KB). Documents exceeding the limit include read metadata explaining the truncation.',
      },
    },
    required: ['file_path'],
  };

  readonly parser: NodeFileParser | undefined;
  private readonly allowedRoots?: readonly string[];

  constructor(opts: { parser?: NodeFileParser; allowedRoots?: string[] } = {}) {
    super();
    this.parser = opts.parser;
    this.allowedRoots = opts.allowedRoots;
  }

  /**
   * Resolve the parser for a given call. Tests may inject a parser
   * via the constructor; production code paths go through the
   * per-session parser cache so two concurrent sessions don't share
   * a single parser's internal state.
   */
  private resolveParser(context?: ToolUseContext): NodeFileParser {
    return this.parser ?? getParserForSession(context?.options.sessionId);
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
    if (this.allowedRoots && this.allowedRoots.length > 0) {
      const resolved = expandPath(validation.data.file_path, workingDirectory);
      if (!isPathWithinRoots(resolved, [...this.allowedRoots])) {
        return {
          id,
          name: 'read',
          error: true,
          result: `Path '${validation.data.file_path}' is outside the allowed roots for this tool.`,
        };
      }
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

    let dispatchInput = input;
    if (input.cell_range && rawExt !== '.ipynb') {
      const { cell_range, ...rest } = input;
      dispatchInput = rest as ReadInput;
    }

    if (!isDocMode(dispatchInput, rawExt)) {
      const result = await readFileContent(dispatchInput, id, workingDirectory, context);
      if (input.cell_range && rawExt !== '.ipynb') {
        return {
          ...result,
          result: `[Read metadata: cell_range only applies to .ipynb files; ignored.]\n\n${result.result}`,
        };
      }
      return result;
    }
    return this.readAsDocument(dispatchInput, id, workingDirectory, context, rawExt);
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

      // Spreadsheet extensions have a dedicated `xlsx` skill (Python
      // pandas/openpyxl via the office skill family) that is more
      // capable than the built-in XlsxParser. Route these extensions
      // to the skill suggestion path instead of attempting to parse
      // them inline. The registry still keeps `.xlsx` registered for
      // direct XlsxParser consumers (e.g. tests), but ReadTool skips
      // it here so the model is pointed at the skill.
      const SKILL_ROUTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsm']);
      if (ext && SKILL_ROUTED_EXTENSIONS.has(ext.toLowerCase())) {
        const magicCheck = await sniffBinary(resolved);
        const formatHint = magicCheck.binary
          ? ` (${magicCheck.format ?? 'binary'})`
          : '';
        const suggestion = suggestHandlerForFormat(ext, magicCheck.format);
        return {
          id, name: 'read', error: true,
          result: `Error: Cannot read '${input.file_path}' — unsupported binary format (${ext})${formatHint}. ${suggestion}`,
        };
      }

      // Image files are handled by the dedicated vision_analyze tool, never
      // by this read tool. Reject them with a clear pointer so the model
      // routes image analysis through the vision tool instead of attaching
      // raw pixels that a non-vision main model cannot consume.
      //
      // Exception (plan 428 / multimodal direct-read): when the active main
      // model is multimodal, ReadTool reads the image and returns it as an
      // inline base64 payload (ToolResult.images) so the model sees it
      // directly instead of being forced into a two-hop vision_analyze call.
      // The StreamingToolExecutor already attaches result.images as image
      // content blocks, and non-vision models are downgraded downstream.
      if (ext && IMAGE_EXTENSIONS.has(ext.toLowerCase())) {
        const model = context?.options.mainLoopModel;
        if (isMainModelMultimodal(model)) {
          return await this.readImageInline(input, id, workingDirectory, ext.toLowerCase());
        }
        return {
          id, name: 'read', error: true,
          result: `Error: Cannot read '${input.file_path}' — this is an image file. Use the \`vision_analyze\` tool to analyze image content.`,
        };
      }

      if (!ext || !getParser(ext)) {
        // No parser for this extension. Magic-byte sniff is the
        // only thing that could tell us what's actually inside;
        // if it's recognizable as a known binary format, surface
        // a clear error that points the model at a concrete next
        // step instead of a generic "use another tool" stub.
        const magicCheck = await sniffBinary(resolved);
        const formatHint = magicCheck.binary
          ? ` (${magicCheck.format ?? 'binary'})`
          : '';
        const suggestion = suggestHandlerForFormat(ext, magicCheck.format);
        return {
          id, name: 'read', error: true,
          result: `Error: Cannot read '${input.file_path}' — unsupported binary format (${ext ?? 'no extension'})${formatHint}. ${suggestion}`,
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

      const result = await this.resolveParser(context).parseFile(resolved, context?.abortController?.signal);
      const { result: text, metadata, images } = serializeParseResult(result, {
        maxTokens: input.max_tokens ?? DEFAULT_MAX_TOKENS,
        resolvedPath: normalizePath(resolved),
      });

      let finalText = text;
      if (input.cell_range) {
        finalText = filterChunksByCellRange(text, input.cell_range, result.chunks);
      }

      // Record the observed mtime/size so edit can anchor old_string to
      // this exact version of the file (plan 428, file-read-state.ts).
      recordFileRead(resolved, { mtimeMs: statResult.mtimeMs, size: statResult.size });

      return { id, name: 'read', result: finalText, metadata, images };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { id, name: 'read', error: true, result: `Error reading file: ${msg}` };
    }
  }

  /**
   * Multimodal direct-read path: read an image file and return it as an
   * inline base64 payload on ToolResult.images so a vision-capable main
   * model sees the image directly in the tool_result (the executor attaches
   * these as ImageContent blocks). Mirrors how the document parser's pure
   * image path surfaces images in result-builder.
   *
   * Only called from readAsDocument for a known multimodal main model;
   * non-multimodal / unknown models keep the vision_analyze rejection
   * and never reach here.
   */
  private async readImageInline(
    input: ReadInput,
    id: string,
    workingDirectory?: string,
    ext = '.png',
  ): Promise<ToolResult> {
    try {
      const resolved = expandPath(input.file_path, workingDirectory);
      const data = await readFile(resolved);
      if (data.length === 0) {
        return {
          id, name: 'read', error: true,
          result: `Error: Cannot read '${input.file_path}' — the image file is empty.`,
        };
      }
      const mediaType = IMAGE_EXTENSION_MEDIA_TYPES[ext] ?? 'image/png';
      const result = `File: ${normalizePath(resolved)}\nMIME: ${mediaType}\n\n[Read metadata: image attached as inline image content. Vision-capable main models can see it directly.]`;
      return {
        id,
        name: 'read',
        result,
        metadata: { filePath: normalizePath(resolved), mediaType },
        images: [{ data: data.toString('base64'), mediaType }],
      };
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
  context?: ToolUseContext,
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
      // Explicitly tell the model how much of the file remains unread so it
      // can decide whether to continue with line_range (P0-2). Without this
      // a partial view is indistinguishable from the whole file, which is
      // exactly how a model ends up editing against truncated content.
      const omittedBefore = startIdx; // lines 1..start-1
      const omittedAfter = Math.max(0, lines.length - endLine); // lines end+1..N
      const notes: string[] = [];
      if (omittedBefore > 0) notes.push(`${omittedBefore} line(s) before the read range (lines 1-${startLine - 1})`);
      if (omittedAfter > 0) notes.push(`${omittedAfter} line(s) after the read range (lines ${endLine + 1}-${lines.length})`);
      if (notes.length > 0) {
        output += `\n\n[Read metadata: read ${endLine - startIdx} of ${lines.length} lines. Omitted: ${notes.join('; ')}. Use line_range to read the remaining lines.]`;
      }
    } else {
      // Full-file read. Cap the output to FULL_READ_MAX_LINES lines or
      // FULL_READ_MAX_BYTES UTF-8 bytes (whichever is hit first), matching
      // the tool description instead of returning the whole file unbounded.
      // We line-cap first (cheap), then byte-cap that payload. byteLength is
      // used because the description promises 50KB, and line-based truncation
      // alone cannot bound a file with very long lines.
      const totalLines = lines.length;
      const overLineLimit = totalLines > FULL_READ_MAX_LINES;
      const lineCapped = overLineLimit ? lines.slice(0, FULL_READ_MAX_LINES).join('\n') : content;
      const overByteLimit = Buffer.byteLength(lineCapped, 'utf-8') > FULL_READ_MAX_BYTES;
      const body = overByteLimit
        ? Buffer.from(lineCapped, 'utf-8').subarray(0, FULL_READ_MAX_BYTES).toString('utf-8')
        : lineCapped;

      output = body;
      startLine = 1;
      endLine = body.split('\n').length;

      if (overLineLimit || overByteLimit) {
        // Mirror the line_range note style so the model knows a partial
        // view is not the whole file and how to continue (plan 428).
        const notes: string[] = [];
        if (overLineLimit) notes.push(`truncated to first ${FULL_READ_MAX_LINES} of ${totalLines} lines`);
        if (overByteLimit) notes.push(`truncated at ~${Math.ceil(FULL_READ_MAX_BYTES / 1024)}KB`);
        output += `\n\n[Read metadata: returned ${endLine} of ${totalLines} lines. ${notes.join('; ')}. Use line_range to read the remaining lines.]`;
      }
    }

    // Record the observed mtime/size (full and line_range reads alike) so
    // edit can verify its old_string is anchored to this version of the
    // file (plan 428, file-read-state.ts). Best-effort: if the file vanishes
    // between read and stat there is nothing left to anchor.
    try {
      const readStat = await stat(resolvedPath);
      recordFileRead(resolvedPath, { mtimeMs: readStat.mtimeMs, size: readStat.size });
    } catch {
      // ignore — the read itself already succeeded
    }

    return {
      id,
      name: 'read',
      result: `File: ${normalizePath(resolvedPath)}\nLines: ${startLine}-${endLine}\n\n${output}`,
      metadata: {
        filePath: normalizePath(resolvedPath),
        lineCount: endLine - startLine + 1,
        totalLines: lines.length,
      },
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

/**
 * Map an unsupported extension / magic-byte format to a concrete next-step
 * hint for the model. The point is to make the "use a tool that handles
 * this format directly" message actually point somewhere: the model often
 * reaches for `bash` + python when it would be cheaper and safer to use a
 * purpose-built skill.
 *
 * The hint text references real skills and skills-likely-to-exist (e.g.
 * `xlsx`) so the model can match the name to what it sees in its available
 * skills list. Falls back to a generic pointer when no specific handler is
 * known.
 */
function suggestHandlerForFormat(
  ext: string | null,
  magicFormat: string | undefined,
): string {
  const lowerExt = ext?.toLowerCase() ?? '';

  // Extension-based hints first — these are the most reliable since the
  // user named the file deliberately.
  if (lowerExt === '.xlsx' || lowerExt === '.xls' || lowerExt === '.xlsm' || lowerExt === '.csv') {
    return 'Use the `xlsx` skill to read this spreadsheet.';
  }
  if (lowerExt === '.doc' || lowerExt === '.docx') {
    return 'Use the `docx` skill to read this Word document.';
  }
  if (lowerExt === '.ppt' || lowerExt === '.pptx') {
    return 'Use the `pptx` skill to read this PowerPoint file.';
  }
  if (lowerExt === '.pdf') {
    return 'Use the `pdf` skill to read this PDF.';
  }
  if (lowerExt === '.png' || lowerExt === '.jpg' || lowerExt === '.jpeg' || lowerExt === '.gif' || lowerExt === '.webp') {
    return 'Use the `vision_analyze` tool to analyze this image.';
  }
  if (lowerExt === '.zip' || lowerExt === '.tar' || lowerExt === '.gz' || lowerExt === '.7z' || lowerExt === '.rar') {
    return 'Extract this archive with `bash` (e.g. `unzip`, `tar -xf`) before reading its contents.';
  }

  // Magic-byte-based hints — covers cases where the extension is missing,
  // wrong, or the file was renamed.
  if (magicFormat) {
    if (magicFormat.startsWith('ZIP / Office Open XML')) {
      return 'This looks like a ZIP container (.xlsx, .docx, .pptx are all OOXML). Use the matching skill: `xlsx`, `docx`, or `pptx`.';
    }
    if (magicFormat === 'PDF') {
      return 'Use the `pdf` skill to read this PDF.';
    }
    if (magicFormat === 'GZIP' || magicFormat === 'BZIP2' || magicFormat === 'XZ' || magicFormat === '7-Zip' || magicFormat === 'RAR v1.5+') {
      return 'Extract this archive with `bash` (e.g. `tar -xf`, `unzip`, `7z x`) before reading its contents.';
    }
    if (
      magicFormat === 'PNG' || magicFormat === 'JPEG' || magicFormat === 'GIF87a' ||
      magicFormat === 'GIF89a' || magicFormat === 'WebP' || magicFormat === 'BMP' ||
      magicFormat === 'ICO / CUR'
    ) {
      return 'Use the `vision_analyze` tool to analyze this image.';
    }
    if (
      magicFormat === 'ELF executable' || magicFormat === 'Mach-O 32-bit' ||
      magicFormat === 'Mach-O 64-bit' || magicFormat === 'Mach-O reverse' ||
      magicFormat === 'Mach-O fat' || magicFormat === 'PE / Windows executable' ||
      magicFormat === 'Java class' || magicFormat === 'WebAssembly'
    ) {
      return 'This is a compiled binary. Do not try to decode it as text — examine it with `bash` (e.g. `file`, `strings`, `objdump`) instead.';
    }
  }

  return 'Use a tool that handles this format directly.';
}

/**
 * Drop cell chunks outside the requested range. Matches the
 * 1-indexed, inclusive semantics of cell_range. The summary chunk
 * (index === -1) is always kept.
 */
function filterChunksByCellRange(
  _text: string,
  range: { start: number; end: number },
  chunks: ParseChunk[],
): string {
  const summaryChunk = chunks.find((c) => c.index === -1);
  const cellChunks = chunks.filter((c) => c.index !== -1);
  const last = range.end === -1 ? cellChunks.length : range.end;
  const first = range.start - 1;
  const sliced = cellChunks.slice(first, last);
  const parts: string[] = [];
  if (summaryChunk && summaryChunk.type === 'text') parts.push(summaryChunk.text);
  for (const c of sliced) {
    if (c.type === 'text') parts.push(c.text);
  }
  return parts.join('\n\n');
}
