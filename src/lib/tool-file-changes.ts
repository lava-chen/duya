// src/lib/tool-file-changes.ts
// Pure helpers that derive file-change summaries and artifact cards
// from a session's tool calls. Originally inlined in MessageItem.tsx;
// extracted so the TaskDrawer / session-detail panel can reuse the
// same computation against the full message history.
//
// Behavior is preserved byte-for-byte with the original; callers pass
// already-paired ToolAction rows (see ToolActionsGroup.pairTools).

import { calculateDiff } from '@/components/diff/SimpleDiffViewer';
import { countContentLines } from '@/lib/streaming-tool-input';
import {
  fileKindLabel,
  fileNameFromPath,
  isDeliverableFile,
} from '@/lib/chat-file-links';
import type { ToolAction } from '@/components/chat/ToolActionsGroup';

export interface FileChangeSummary {
  path: string;
  name: string;
  additions: number;
  removals: number;
  kind: 'edit' | 'create';
}

export interface ArtifactSummary {
  path: string;
  name: string;
  kindLabel: string;
}

const FILE_CHANGE_TOOL_NAMES = new Set([
  'edit',
  'edit_file',
  'str_replace_editor',
  'write',
  'writefile',
  'write_file',
  'create_file',
  'createfile',
]);

const FILE_CREATE_TOOL_NAMES = new Set([
  'write',
  'writefile',
  'write_file',
  'create_file',
  'createfile',
]);

function getToolInputPath(input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;
  const rawPath = inp?.file_path || inp?.path || inp?.filePath || '';
  return typeof rawPath === 'string' ? rawPath : '';
}

/**
 * Split a `generateDiffString`-style diff block into removed / added text.
 *
 * Lines look like `+  5 const a = 10;` / `-  1 const a = 1;` — a +/- marker,
 * a right-aligned line number, then the content. Only CONTEXT is elided (as
 * `     ...`), never an addition or removal, so counting the +/- lines gives
 * exact stats.
 */
function collectDiffLines(diff: string): { removed: string[]; added: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('-')) {
      removed.push(stripLineNumberColumn(line.slice(1)));
    } else if (line.startsWith('+')) {
      added.push(stripLineNumberColumn(line.slice(1)));
    }
  }
  return { removed, added };
}

/**
 * Drop the numeric column EditTool prints between the +/- marker and the
 * content (`"  5 const a = 1;"` → `"const a = 1;"`). Only strips when a real
 * number column is present, so a plain unified diff without numbers keeps its
 * content intact.
 */
function stripLineNumberColumn(rest: string): string {
  const numbered = rest.match(/^\s+\d+ /);
  return numbered ? rest.slice(numbered[0].length) : rest.replace(/^ /, '');
}

/**
 * Parse the OLD/NEW content a mutating tool operated on, out of its result
 * text. Tolerant on purpose: the agent's tool output format has changed over
 * time, and an unrecognised shape silently collapsing to `+0 -0` is exactly
 * the failure this guards against.
 *
 * Shapes in the wild:
 *   1. `Successfully edited <file>: N block(s) changed.[\nFirst changed line: N]\n\n<diff>`
 *      — current EditTool.
 *   2. `Changed:\n<old>\n\nTo:\n<new>` — legacy EditTool.
 *   3. `{"content": …, "previous_content": …}` / `{"old_string": …, "new_string": …}`
 *      — JSON envelopes from older agents / MCP editors.
 *
 * WriteTool's `Successfully wrote N characters (M lines) to '<path>'` carries
 * no content, so it is handled by the caller's input fallback instead.
 */
export function parseToolDiffContent(
  result: string,
): { oldContent: string; newContent: string } | null {
  if (!result) return null;

  // 1) Current EditTool format: header, blank line, then the numbered diff.
  if (result.startsWith('Successfully edited')) {
    const blankLine = result.indexOf('\n\n');
    if (blankLine < 0) return null;
    const { removed, added } = collectDiffLines(result.slice(blankLine + 2));
    if (removed.length === 0 && added.length === 0) return null;
    return { oldContent: removed.join('\n'), newContent: added.join('\n') };
  }

  // 2) Legacy EditTool format.
  const changedMatch = result.match(/Changed:\n([\s\S]+?)\n\nTo:\n([\s\S]+)$/);
  if (changedMatch) {
    return { oldContent: changedMatch[1] || '', newContent: changedMatch[2] || '' };
  }

  // 3) JSON envelopes.
  try {
    const data = JSON.parse(result);
    if (typeof data?.content === 'string') {
      return {
        oldContent: typeof data.previous_content === 'string' ? data.previous_content : '',
        newContent: data.content,
      };
    }
    if (typeof data?.old_string === 'string' || typeof data?.new_string === 'string') {
      return {
        oldContent: typeof data.old_string === 'string' ? data.old_string : '',
        newContent: typeof data.new_string === 'string' ? data.new_string : '',
      };
    }
    if (typeof data?.diff === 'string') {
      const { removed, added } = collectDiffLines(data.diff);
      if (removed.length > 0 || added.length > 0) {
        return { oldContent: removed.join('\n'), newContent: added.join('\n') };
      }
    }
  } catch {
    // not JSON
  }

  return null;
}

/**
 * Resolve the OLD/NEW content for a tool action: the authoritative result
 * first, then the live input (which is all we have while a tool is still
 * streaming, and the fallback when the result uses a shape we don't parse).
 */
export function resolveToolDiffContent(
  tool: ToolAction,
): { oldContent: string; newContent: string } | null {
  if (typeof tool.result === 'string' && tool.result) {
    const parsed = parseToolDiffContent(tool.result);
    if (parsed) return parsed;
  }

  const input = tool.input as Record<string, unknown> | undefined;
  if (typeof input?.old_string === 'string' && typeof input?.new_string === 'string') {
    return { oldContent: input.old_string, newContent: input.new_string };
  }
  if (typeof input?.content === 'string') {
    return { oldContent: '', newContent: input.content };
  }
  return null;
}

/**
 * Line stats for an OLD→NEW content pair.
 *
 * An empty old side means a brand-new file: its body is pure addition.
 * Routing that through `calculateDiff` would treat the empty string as one
 * line and report a phantom `-1`, so new files are counted directly.
 */
export function diffLineStats(
  oldContent: string,
  newContent: string,
): { additions: number; removals: number } {
  if (oldContent === '') {
    return { additions: countContentLines(newContent), removals: 0 };
  }
  const stats = calculateDiff(oldContent, newContent).stats;
  return { additions: stats.additions, removals: stats.removals };
}

export function computeToolFileChange(tool: ToolAction): FileChangeSummary | null {
  const path = getToolInputPath(tool.input);
  if (!path || tool.isError) return null;

  const input = tool.input as Record<string, unknown> | undefined;
  const lowerName = tool.name.toLowerCase();
  const isCreate = FILE_CREATE_TOOL_NAMES.has(lowerName);
  let additions = 0;
  let removals = 0;

  // NOTE: the fallback is deliberately NOT an `else if` on `tool.result`.
  // Gating it on "no result yet" meant any result shape the parser did not
  // recognise produced a silent `+0 -0` — which is how the turn-level change
  // card and the TaskDrawer lost their line counts while FileEditToolRow
  // (separate `if`) kept working.
  const resolved = resolveToolDiffContent(tool);
  if (resolved) {
    const stats = diffLineStats(resolved.oldContent, resolved.newContent);
    additions = stats.additions;
    removals = stats.removals;
  }

  return {
    path,
    name: fileNameFromPath(path),
    additions,
    removals,
    kind: isCreate ? 'create' : 'edit',
  };
}

/**
 * Plan 566: extract the OLD/NEW content pair a mutating tool operated on,
 * together with the path it targeted.
 *
 * Used by the turn-level change card to render an inline diff of everything
 * that happened to one file across a whole turn. Shares `resolveToolDiffContent`
 * with the stats pipeline so the diff and the `+N -M` can never disagree.
 *
 * Returns null for non-file tools, errored tools, and tools whose payload
 * carries no comparable content.
 */
export function extractToolFileDiff(
  tool: ToolAction,
): { path: string; oldContent: string; newContent: string } | null {
  const path = getToolInputPath(tool.input);
  if (!path || tool.isError) return null;

  const resolved = resolveToolDiffContent(tool);
  return resolved ? { path, ...resolved } : null;
}

export function buildFileChangeSummaries(tools: ToolAction[]): FileChangeSummary[] {
  const summaries = new Map<string, FileChangeSummary>();

  for (const tool of tools) {
    const lowerName = tool.name.toLowerCase();
    if (!FILE_CHANGE_TOOL_NAMES.has(lowerName)) continue;

    const change = computeToolFileChange(tool);
    if (!change) continue;

    const existing = summaries.get(change.path);
    if (existing) {
      existing.additions += change.additions;
      existing.removals += change.removals;
      if (existing.kind !== 'create') existing.kind = change.kind;
    } else {
      summaries.set(change.path, change);
    }
  }

  return Array.from(summaries.values());
}

export function buildArtifactSummaries(changes: FileChangeSummary[]): ArtifactSummary[] {
  return changes
    .filter((change) => change.kind === 'create' && isDeliverableFile(change.path))
    .map((change) => ({
      path: change.path,
      name: change.name,
      kindLabel: fileKindLabel(change.path),
    }));
}