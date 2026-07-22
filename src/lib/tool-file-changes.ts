// src/lib/tool-file-changes.ts
// Pure helpers that derive file-change summaries and artifact cards
// from a session's tool calls. Originally inlined in MessageItem.tsx;
// extracted so the TaskDrawer / session-detail panel can reuse the
// same computation against the full message history.
//
// Behavior is preserved byte-for-byte with the original; callers pass
// already-paired ToolAction rows (see ToolActionsGroup.pairTools).

import { calculateDiff } from '@/components/diff/SimpleDiffViewer';
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

function parseEditResultForSummary(
  result: string
): { oldContent: string; newContent: string } | null {
  const changedMatch = result.match(/Changed:\n([\s\S]+?)\n\nTo:\n([\s\S]+)$/);
  if (changedMatch) {
    return {
      oldContent: changedMatch[1] || '',
      newContent: changedMatch[2] || '',
    };
  }

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
  } catch {
    return null;
  }

  return null;
}

export function computeToolFileChange(tool: ToolAction): FileChangeSummary | null {
  const path = getToolInputPath(tool.input);
  if (!path || tool.isError) return null;

  const input = tool.input as Record<string, unknown> | undefined;
  const lowerName = tool.name.toLowerCase();
  const isCreate = FILE_CREATE_TOOL_NAMES.has(lowerName);
  let additions = 0;
  let removals = 0;

  if (tool.result) {
    const parsed = parseEditResultForSummary(tool.result);
    if (parsed) {
      const stats = calculateDiff(parsed.oldContent, parsed.newContent).stats;
      additions = stats.additions;
      removals = stats.removals;
    }
  } else if (typeof input?.old_string === 'string' && typeof input?.new_string === 'string') {
    const stats = calculateDiff(input.old_string, input.new_string).stats;
    additions = stats.additions;
    removals = stats.removals;
  } else if (typeof input?.content === 'string') {
    additions = input.content.split('\n').filter((line) => line !== '').length;
  }

  return {
    path,
    name: fileNameFromPath(path),
    additions,
    removals,
    kind: isCreate ? 'create' : 'edit',
  };
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