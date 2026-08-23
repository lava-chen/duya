/**
 * Session-scoped worktree registry (plan 441).
 *
 * Tracks which git worktree the main agent session currently occupies so
 * `enter_worktree` can enforce the single-writer rule and `exit_worktree`
 * knows where to restore the working directory to. In-memory by design:
 * a session restart lands back in its persisted working_directory anyway,
 * and the worktree itself survives on disk regardless.
 */

import type { AgentWorktreeHandle } from './worktree-manager.js';

export interface SessionWorktreeEntry {
  handle: AgentWorktreeHandle;
  /** Directory to restore on exit (the session root before entering). */
  previousWorkingDirectory?: string;
}

const sessionWorktrees = new Map<string, SessionWorktreeEntry>();

export function getSessionWorktree(sessionId: string): SessionWorktreeEntry | undefined {
  return sessionWorktrees.get(sessionId);
}

export function setSessionWorktree(sessionId: string, entry: SessionWorktreeEntry): void {
  sessionWorktrees.set(sessionId, entry);
}

export function clearSessionWorktree(sessionId: string): boolean {
  return sessionWorktrees.delete(sessionId);
}

/**
 * In-flight enter markers: creation awaits git several times between the
 * "already inside?" check and registration, so concurrent calls must be
 * serialized synchronously or they all slip past the check and one tree
 * leaks outside the registry.
 */
const pendingEnters = new Set<string>();

/** Reserve the enter slot; false when already inside or an enter is in flight. */
export function beginEnter(sessionId: string): boolean {
  if (sessionWorktrees.has(sessionId) || pendingEnters.has(sessionId)) return false;
  pendingEnters.add(sessionId);
  return true;
}

/** Release the reservation (after registration or on failure). */
export function endEnter(sessionId: string): void {
  pendingEnters.delete(sessionId);
}
