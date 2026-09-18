/**
 * project-actions.ts — Single source of truth for project + session actions
 * exposed by menus across the renderer (Plan 547).
 *
 * Background: before this plan, every menu surface (sidebar session, sidebar
 * project, projects page project, projects page batch toolbar) implemented its
 * own copy of "archive all sessions under a project" / "delete project" with
 * subtle divergences — the sidebar project `⋯` → "删除项目" actually looped
 * `deleteThread` over the sessions and left the project entity untouched,
 * while the projects page `⋯` → "移除项目" called `projects.delete`.  Six
 * click-handlers, three definitions of "delete project".
 *
 * This module is the only place that composes those primitives.  All callers
 * (sidebar `ProjectGroupItem`, sidebar `ThreadListItem`, projects page
 * `ProjectsView`, the new shared `RemoveProjectConfirm` modal) invoke these
 * exports verbatim — no other file is allowed to call `archiveThreadIPC` /
 * `deleteThreadIPC` / `projects.delete` directly when the operation is
 * user-triggered from a menu.
 *
 * Composability rules:
 * - Pure async functions, no React.
 * - Take explicit arguments; reads from stores happen in the caller.
 * - Return counts for batch ops; `void` for single-target ops.
 * - Multi-path projects match sessions whose `workingDirectory` resolves to
 *   ANY of `project.paths[*].path`, normalized via
 *   `normalizeWorkingDirectoryForCompare` (Plan 547 / plan 537 §3).
 *
 * No new IPC is added in this plan — all actions compose existing primitives
 * (`archiveThreadIPC`, `deleteThreadIPC`, `updateThreadIPC`, `projects.update`,
 * `projects.delete`, `exportRolloutIPC`, `shell.openPath`, clipboard).
 */

import {
  archiveThreadIPC,
  deleteThreadIPC,
  updateThreadIPC,
  exportRolloutIPC,
} from './ipc-client';
import { useConversationStore } from '@/stores/conversation-store';
import {
  useProjectsStore,
  normalizeWorkingDirectoryForCompare,
  type ProjectEntity,
} from '@/stores/projects-store';

/** Forward the cross-window threads-changed notification (matches conversation-store.ts). */
function notifyThreadsChanged(): void {
  window.electronAPI?.sync?.notifyThreadsChanged?.();
}

// ---------------------------------------------------------------------------
// Session-scoped operations (existing primitives, wrapped for cross-surface use)
// ---------------------------------------------------------------------------

/** Archive a single session via the existing Plan 506 primitive. */
export async function archiveSingleSession(threadId: string): Promise<void> {
  useConversationStore.getState().archiveThread(threadId);
}

/** Delete a single session via the existing Plan 506 primitive. */
export async function deleteSingleSession(threadId: string): Promise<void> {
  useConversationStore.getState().deleteThread(threadId);
}

/** Rename a single session via `updateThreadIPC`. */
export async function renameSingleSession(
  threadId: string,
  newTitle: string,
): Promise<void> {
  await updateThreadIPC(threadId, { title: newTitle });
}

/** Export one session's rollout (Plan 506 A1). */
export async function exportSingleSessionRollout(threadId: string): Promise<{
  absolutePath: string;
  lines: number;
  bytes: number;
}> {
  return exportRolloutIPC(threadId);
}

/** Toggle the pin flag on a single session. */
export function toggleSessionPin(thread: { id: string; pinned?: boolean }): void {
  useConversationStore
    .getState()
    .setThreadPinned(thread.id, !thread.pinned);
}

/** Copy a session id to the system clipboard. */
export async function copySessionId(threadId: string): Promise<void> {
  await navigator.clipboard.writeText(threadId);
}

// ---------------------------------------------------------------------------
// Session-set operations (caller decides selection scope)
// ---------------------------------------------------------------------------

/**
 * Archive every session whose id is in the input set.
 *
 * Caller-supplied — does NOT filter by project; the caller has already
 * decided what "selected" means (batch toolbar passes the checkbox set,
 * a per-project "archive all" action passes `getSessionIdsUnderProject()`).
 *
 * Returns the number of sessions successfully archived (locally; IPC failure
 * is logged inside the store action and is not surfaced here — the local
 * state is already updated optimistically).
 */
export async function archiveSelectedSessions(threadIds: string[]): Promise<number> {
  const state = useConversationStore.getState();
  for (const id of threadIds) {
    state.archiveThread(id);
  }
  notifyThreadsChanged();
  return threadIds.length;
}

/**
 * Delete every session whose id is in the input set.
 * See `archiveSelectedSessions` for the no-project-filter contract.
 */
export async function deleteSelectedSessions(threadIds: string[]): Promise<number> {
  const state = useConversationStore.getState();
  for (const id of threadIds) {
    state.deleteThread(id);
  }
  notifyThreadsChanged();
  return threadIds.length;
}

// ---------------------------------------------------------------------------
// Project-scoped operations
// ---------------------------------------------------------------------------

/**
 * Compute the set of session ids whose `workingDirectory` matches any path in
 * the project's `paths[]` (after cross-platform normalization).
 *
 * Used by all project-scoped batch actions below and by the confirm modal so
 * the "X sessions will be deleted" hint is accurate.
 */
export function getSessionIdsUnderProject(project: ProjectEntity): string[] {
  const projectPaths = project.paths
    .map((p) => normalizeWorkingDirectoryForCompare(p.path))
    .filter(Boolean);
  if (projectPaths.length === 0) return [];
  const threads = useConversationStore.getState().threads;
  const matched: string[] = [];
  for (const t of threads) {
    const wd = normalizeWorkingDirectoryForCompare(t.workingDirectory ?? '');
    if (wd && projectPaths.includes(wd)) {
      matched.push(t.id);
    }
  }
  return matched;
}

/**
 * Archive every session under the given project.
 * Caller passes the project entity (already loaded from `useProjectsStore`).
 * Returns the number of archived sessions.
 */
export async function archiveSessionsUnderProject(
  project: ProjectEntity,
): Promise<number> {
  const ids = getSessionIdsUnderProject(project);
  if (ids.length === 0) return 0;
  return archiveSelectedSessions(ids);
}

/**
 * Delete every session under the given project.
 * Returns the number of deleted sessions.
 */
export async function deleteSessionsUnderProject(
  project: ProjectEntity,
): Promise<number> {
  const ids = getSessionIdsUnderProject(project);
  if (ids.length === 0) return 0;
  return deleteSelectedSessions(ids);
}

/**
 * Delete the project entity via the `projects.delete` IPC added in commit
 * `20ec6fcf`.  Cross-DB cleanup (project row + project rollouts + recent
 * folder) is handled on the main process side.  Chat history of sessions
 * under this project is NOT touched here — callers that want to delete both
 * the project AND its sessions compose this with `deleteSessionsUnderProject`
 * explicitly (see the new `RemoveProjectConfirm` modal).
 */
export async function deleteProject(project: ProjectEntity): Promise<boolean> {
  const api = window.electronAPI?.projects;
  if (!api?.delete) return false;
  const result = await api.delete(project.project_id);
  if (result.success && result.deleted) {
    useProjectsStore.getState().invalidate();
    notifyThreadsChanged();
  }
  return result.success && result.deleted;
}

/**
 * Rename a project via `projects.update` IPC.
 * Preserves every other field (description, paths, icon, color) verbatim.
 */
export async function renameProject(
  project: ProjectEntity,
  newName: string,
): Promise<boolean> {
  const api = window.electronAPI?.projects;
  if (!api?.update) return false;
  const result = await api.update(project.project_id, { name: newName });
  if (result.success) {
    useProjectsStore.getState().invalidate();
  }
  return result.success;
}

/**
 * Open the primary path of a project in the OS file manager.
 * Multi-path projects open the first path only — opening all paths in
 * parallel is out of scope (Plan 547 §7 risks).
 */
export async function openProjectFolder(project: ProjectEntity): Promise<void> {
  const primary = project.paths[0]?.path;
  if (!primary) return;
  await window.electronAPI?.shell?.openPath?.(primary);
}

/** Copy a project's primary path to the clipboard. */
export async function copyProjectPath(project: ProjectEntity): Promise<void> {
  const primary = project.paths[0]?.path;
  if (!primary) return;
  await navigator.clipboard.writeText(primary);
}

/**
 * Composite: delete sessions under the project, then delete the project entity.
 * Used by the `RemoveProjectConfirm` modal when the user has opted in to the
 * "also delete all sessions" checkbox.
 *
 * Returns the count of sessions deleted alongside a boolean flag for whether
 * the project entity was successfully removed.
 */
export async function deleteProjectAndSessions(
  project: ProjectEntity,
): Promise<{ sessionsDeleted: number; projectDeleted: boolean }> {
  const sessionsDeleted = await deleteSessionsUnderProject(project);
  const projectDeleted = await deleteProject(project);
  return { sessionsDeleted, projectDeleted };
}