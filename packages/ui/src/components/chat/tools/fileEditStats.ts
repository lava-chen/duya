// Shared diff-stat computation for the file edit / create tool family.
//
// This module used to live inside FileEditToolRow.tsx as a private
// helper. It is now shared so a group's header can sum the very same
// numbers the per-row chrome shows: one source of truth means the
// collapsed group line ("已编辑 2 个文件 +272 -77") can never disagree
// with the two rows underneath it.
//
// Pure functions, no React. Safe to unit test in isolation.

import { calculateDiff } from '@/components/diff/SimpleDiffViewer';
import { computeLineChangeStat, countContentLines } from '@/lib/streaming-tool-input';
import { FILE_CREATE_TOOLS, FILE_EDIT_TOOLS } from './classify';
import type { FileEditStats, ToolAction } from './types';

/**
 * Compute live diff stats for edit / write / create_file tools.
 *
 * Priority:
 *   1. If `result` is available, parse the authoritative result format
 *      (edit: "Changed:/To:" blocks; write: JSON `{content, file_path}`).
 *   2. Otherwise count the string fields directly off `input`. During
 *      plan-461 streaming these fields grow chunk by chunk, so the
 *      `+N -M` ticks up in real time; a monotone line count reads better
 *      than a half-streamed diff, and the authoritative diff replaces it
 *      as soon as the result lands.
 */
export function computeFileEditStats(tool: ToolAction): FileEditStats {
  const inp = tool.input as Record<string, unknown> | undefined;
  const name = tool.name.toLowerCase();
  const isCreateTool = FILE_CREATE_TOOLS.has(name);
  const isEditTool = FILE_EDIT_TOOLS.has(name);

  // 1) Prefer authoritative result when present.
  if (tool.result && !tool.isError) {
    const parsed = parseEditResult(tool.result);
    if (parsed) {
      // Authoritative result → true diff stats (context lines cancel out).
      const stats = calculateDiff(parsed.oldContent, parsed.newContent).stats;
      return { stats, kind: 'edit' };
    }
    // write result is JSON: { file_path, content, previous_content? }
    try {
      const data = JSON.parse(tool.result);
      if (typeof data?.content === 'string') {
        const oldContent = typeof data.previous_content === 'string' ? data.previous_content : '';
        if (oldContent) {
          const stats = calculateDiff(oldContent, data.content as string).stats;
          return { stats, kind: 'edit' };
        }
        const additions = countContentLines(data.content as string);
        return { stats: { additions, removals: 0 }, kind: 'create' };
      }
    } catch {
      // not JSON — fall through to input
    }
  }

  // 2) Live estimate from `input` while streaming (plan 461: fields grow
  //    chunk by chunk as the model generates the arguments). For edits we
  //    trim the common prefix/suffix lines (ZCode computeLineChangeStat
  //    parity) so a one-line change inside a 20-line block reads +1/-1
  //    instead of +20/-20.
  if (isEditTool) {
    const newStr = (inp?.new_string ?? inp?.new_str) as string | undefined;
    const oldStr = (inp?.old_string ?? inp?.old_str) as string | undefined;
    if (typeof newStr === 'string' || typeof oldStr === 'string') {
      return {
        stats: computeLineChangeStat(
          typeof oldStr === 'string' ? oldStr : null,
          typeof newStr === 'string' ? newStr : '',
        ),
        kind: 'edit',
      };
    }
  }
  if (isCreateTool && typeof inp?.content === 'string') {
    return { stats: { additions: countContentLines(inp.content as string), removals: 0 }, kind: 'create' };
  }

  return { stats: { additions: 0, removals: 0 }, kind: 'unknown' };
}

/**
 * Sum the diff stats of every file-touching tool call in a set.
 *
 * Non-file tools contribute 0/0 (their `computeFileEditStats` result is
 * `kind: 'unknown'`), so the caller can pass the whole round without
 * pre-filtering.
 */
export function aggregateFileEditStats(tools: ToolAction[]): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const tool of tools) {
    const { stats } = computeFileEditStats(tool);
    additions += stats.additions;
    removals += stats.removals;
  }
  return { additions, removals };
}

/**
 * Parse edit tool result to get old and new content.
 * Returns `{ filePath, oldContent, newContent }` or null on parse failure.
 *
 * EditTool returns formats like:
 *   "Successfully edited {file}: N block(s) changed.\n\n-{old} +{new}"
 * or the older "Changed:\n...\nTo:\n..." format.
 */
export function parseEditResult(result: string): { filePath: string; oldContent: string; newContent: string } | null {
  try {
    // Try "Changed:\n...\nTo:\n..." format first
    const changedMatch = result.match(/Changed:\n([\s\S]+?)\n\nTo:\n([\s\S]+)$/);
    if (changedMatch) {
      const filePathMatch = result.match(/Successfully edited (.+)\n/);
      const filePath = filePathMatch ? filePathMatch[1] : 'unknown';
      return { filePath, oldContent: changedMatch[1], newContent: changedMatch[2] };
    }

    // Parse EditTool's actual output format:
    // "Successfully edited {file}: N block(s) changed.\n\n-{line} +{line} ..."
    const filePathMatch = result.match(/Successfully edited (.+?):/);
    if (filePathMatch) {
      const filePath = filePathMatch[1];
      // Extract all lines that start with - or + (the actual diff)
      const diffSection = result.match(/\n\n([\s\S]+)$/)?.[1] ?? '';
      const lines = diffSection.split('\n');
      const removedLines: string[] = [];
      const addedLines: string[] = [];

      for (const line of lines) {
        // Match lines like "-  5 const old = 'value';" or "+  5 const new = 'value';"
        const minusMatch = line.match(/^-\s*\d*\s*(.*)$/);
        const plusMatch = line.match(/^\+\s*\d*\s*(.*)$/);
        if (minusMatch && minusMatch[1].trim() !== '...') {
          removedLines.push(minusMatch[1]);
        } else if (plusMatch && plusMatch[1].trim() !== '...') {
          addedLines.push(plusMatch[1]);
        }
      }

      if (removedLines.length > 0 || addedLines.length > 0) {
        return {
          filePath,
          oldContent: removedLines.join('\n'),
          newContent: addedLines.join('\n'),
        };
      }
    }

    // Try JSON format
    const data = JSON.parse(result);
    if (data.old_string !== undefined && data.new_string !== undefined) {
      const filePath = data.file_path || data.path || 'unknown';
      return {
        filePath,
        oldContent: data.old_string || '',
        newContent: data.new_string || data.diff || '',
      };
    }

    return null;
  } catch {
    return null;
  }
}
