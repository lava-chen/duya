import type { ToolGroupProgressSource } from '@duya/ai';

/** Private control tool and validation for short tool-group progress titles. */
export const PROGRESS_UPDATE_TOOL_NAME = 'progress_update';
export const MAX_PROGRESS_TITLE_LENGTH = 120;

export function sanitizeProgressTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  const title = value.trim();
  if (!title) return undefined;
  return title.slice(0, MAX_PROGRESS_TITLE_LENGTH).trimEnd() || undefined;
}

export const PROGRESS_UPDATE_TOOL = {
  name: PROGRESS_UPDATE_TOOL_NAME,
  description: 'Set a short plain-text progress title for the current tool group. This private control call does not perform work.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: MAX_PROGRESS_TITLE_LENGTH },
    },
    required: ['title'],
    additionalProperties: false,
  },
} as const;

export interface ToolGroupAssignment {
  groupId: string;
  progressTitle?: string;
  progressSource: ToolGroupProgressSource;
  progressEvent?: {
    groupId: string;
    title: string;
    source: ToolGroupProgressSource;
  };
}

interface PendingProgress {
  groupId: string;
  title: string;
  source: ToolGroupProgressSource;
}

/** Keeps streamed tool membership stable across calls, retries, and turns. */
export class ToolGroupProgressTracker {
  private readonly groupByCallId = new Map<string, string>();
  private readonly titleByGroupId = new Map<string, string>();
  private readonly sourceByGroupId = new Map<string, ToolGroupProgressSource>();
  private activeGroupId: string | null = null;
  private pending?: PendingProgress;

  queue(title: unknown, source: ToolGroupProgressSource): void {
    const safeTitle = sanitizeProgressTitle(title);
    if (!safeTitle) return;
    this.pending = { groupId: crypto.randomUUID(), title: safeTitle, source };
  }

  pendingSnapshot(): PendingProgress | undefined {
    return this.pending ? { ...this.pending } : undefined;
  }

  restorePending(snapshot: PendingProgress | undefined): void {
    this.pending = snapshot ? { ...snapshot } : undefined;
  }

  assign(callId: string): ToolGroupAssignment {
    const knownGroupId = this.groupByCallId.get(callId);
    if (knownGroupId) {
      return {
        groupId: knownGroupId,
        progressTitle: this.titleByGroupId.get(knownGroupId),
        progressSource: this.sourceByGroupId.get(knownGroupId) ?? 'tool_fallback',
      };
    }

    let progressEvent: ToolGroupAssignment['progressEvent'];
    if (this.pending) {
      const progress = this.pending;
      this.pending = undefined;
      this.activeGroupId = progress.groupId;
      this.titleByGroupId.set(progress.groupId, progress.title);
      this.sourceByGroupId.set(progress.groupId, progress.source);
      progressEvent = {
        groupId: progress.groupId,
        title: progress.title,
        source: progress.source,
      };
    } else if (!this.activeGroupId) {
      this.activeGroupId = crypto.randomUUID();
      this.sourceByGroupId.set(this.activeGroupId, 'tool_fallback');
    }

    const groupId = this.activeGroupId;
    if (!groupId) throw new Error('Tool group assignment failed');
    this.groupByCallId.set(callId, groupId);
    return {
      groupId,
      progressTitle: this.titleByGroupId.get(groupId),
      progressSource: this.sourceByGroupId.get(groupId) ?? 'tool_fallback',
      progressEvent,
    };
  }

  closeActiveGroup(): void {
    this.activeGroupId = null;
  }
}

/** Returns null for an ordinary tool; a matched private call may have no safe title. */
export function readProgressUpdateCall(
  toolName: string,
  privateToolName: string,
  input: unknown,
): { title?: string } | null {
  if (toolName !== privateToolName) return null;
  const title = input && typeof input === 'object' && !Array.isArray(input)
    ? sanitizeProgressTitle((input as Record<string, unknown>).title)
    : undefined;
  return { title };
}
