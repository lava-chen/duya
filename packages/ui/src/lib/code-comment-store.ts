/**
 * code-comment-store.ts - Per-line code comments created in the review
 * panel's file preview (ZCode-style).
 *
 * The store is the single source of truth for a review session's comments:
 *
 *   - `CodeReviewPanel` (file preview mode) renders inline comment cards
 *     from it and writes on submit / delete.
 *   - `MessageInput` renders a pending-comment chip strip from it and
 *     serializes the unsent ones into the outgoing model content
 *     (`buildCodeCommentsPromptBlock`), then flags them sent.
 *
 * Plain module singleton + `useSyncExternalStore` — no extra state library.
 * Bucketed by absolute workspace path so two projects never cross-contaminate;
 * within a bucket the id is deterministic (`path:startLine-endLine`) so
 * re-commenting the same range updates the existing card instead of stacking.
 */

export interface CodeCommentRange {
  startLine: number;
  endLine: number;
}

export interface CodeComment extends CodeCommentRange {
  /** Deterministic: `${path}:${startLine}-${endLine}` (unique inside a workspace). */
  id: string;
  /** Workspace-relative file path, as shown in the review panel. */
  path: string;
  /** Selected source text at comment time (context for the model). */
  selectedText: string;
  /** The user's comment body. */
  comment: string;
  createdAt: number;
  /** Timestamp of the last send that carried this comment; null = pending. */
  sentAt: number | null;
}

export interface CodeCommentDraft {
  path: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  comment: string;
}

type Listener = () => void;

const EMPTY_COMMENTS: readonly CodeComment[] = [];

const buckets = new Map<string, CodeComment[]>();
const listeners = new Set<Listener>();

function normalizeRange(startLine: number, endLine: number): CodeCommentRange {
  return {
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
  };
}

export function makeCodeCommentId(path: string, startLine: number, endLine: number): string {
  const range = normalizeRange(startLine, endLine);
  return `${path}:${range.startLine}-${range.endLine}`;
}

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeCodeComments(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for `useSyncExternalStore` — array identity changes only on mutation. */
export function getCodeComments(workspacePath: string): readonly CodeComment[] {
  return buckets.get(workspacePath) ?? EMPTY_COMMENTS;
}

const pendingSnapshots = new Map<
  string,
  { source: readonly CodeComment[]; pending: readonly CodeComment[] }
>();

/**
 * `getCodeComments` filtered to unsent comments, equally safe as a
 * `useSyncExternalStore` snapshot: the filter would otherwise allocate a
 * fresh array per call, changing snapshot identity every render and looping
 * React updates. Cached against the source bucket's identity, recomputed
 * only after a mutation replaces that bucket.
 */
export function getPendingCodeComments(workspacePath: string): readonly CodeComment[] {
  const source = getCodeComments(workspacePath);
  if (source === EMPTY_COMMENTS) return EMPTY_COMMENTS;
  const cached = pendingSnapshots.get(workspacePath);
  if (cached && cached.source === source) return cached.pending;
  const pending = source.filter((comment) => comment.sentAt === null);
  pendingSnapshots.set(workspacePath, { source, pending });
  return pending;
}

export function addCodeComment(workspacePath: string, draft: CodeCommentDraft): CodeComment {
  const range = normalizeRange(draft.startLine, draft.endLine);
  const comment: CodeComment = {
    id: makeCodeCommentId(draft.path, range.startLine, range.endLine),
    path: draft.path,
    startLine: range.startLine,
    endLine: range.endLine,
    selectedText: draft.selectedText,
    comment: draft.comment.trim(),
    createdAt: Date.now(),
    sentAt: null,
  };
  const current = buckets.get(workspacePath) ?? [];
  const next = [...current.filter((existing) => existing.id !== comment.id), comment];
  buckets.set(workspacePath, next);
  emit();
  return comment;
}

export function removeCodeComment(workspacePath: string, id: string): void {
  const current = buckets.get(workspacePath);
  if (!current) return;
  const next = current.filter((comment) => comment.id !== id);
  if (next.length === current.length) return;
  if (next.length === 0) buckets.delete(workspacePath);
  else buckets.set(workspacePath, next);
  emit();
}

/** Flags every comment in the workspace as carried by a sent message. */
export function markCodeCommentsSent(workspacePath: string): void {
  const current = buckets.get(workspacePath);
  if (!current || current.every((comment) => comment.sentAt !== null)) return;
  const now = Date.now();
  buckets.set(
    workspacePath,
    current.map((comment) => (comment.sentAt === null ? { ...comment, sentAt: now } : comment)),
  );
  emit();
}

export function countPendingCodeComments(workspacePath: string): number {
  return getPendingCodeComments(workspacePath).length;
}

/**
 * Serializes pending comments into the prompt block appended after the
 * user's typed text. Format mirrors ZCode's `# Code comments:` block so
 * downstream tooling can treat them identically; empty when nothing pending.
 */
export function buildCodeCommentsPromptBlock(workspacePath: string): string {
  const pending = getPendingCodeComments(workspacePath);
  if (pending.length === 0) return "";

  const items = pending.map((comment, index) => {
    const lineLabel =
      comment.startLine === comment.endLine
        ? String(comment.startLine)
        : `${comment.startLine}-${comment.endLine}`;
    const selectedText = comment.selectedText.trim();
    const body = comment.comment.trim();
    return [
      `## Comment ${index + 1}`,
      `File: ${comment.path}`,
      "Side: R",
      `Lines: ${lineLabel}`,
      `Selected text:`,
      "```",
      selectedText,
      "```",
      "Comment:",
      body,
    ].join("\n");
  });

  return `# Code comments:\n\n${items.join("\n\n")}`;
}
