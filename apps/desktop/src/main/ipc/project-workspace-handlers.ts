/**
 * Project workspace IPC handlers — the Desktop's Project-first surface.
 *
 * ## What this surface is
 *
 * Entering a project shows the user ONE project state: the coordinator
 * conversation, the project tasks, and the working sessions. This file is the
 * only way the renderer gets any of it, and it answers in three shapes:
 *
 *   - `projects:state` — the whole project state, in one read.
 *   - `projects:coordinator:ensure` — the project's coordinator conversation,
 *     created on first use and durable afterwards.
 *   - `session:control:lease:*` — the per-session control lease, which is what
 *     decides who may direct a working session right now.
 *
 * ## Why the state is ONE read
 *
 * The project view shows a coordinator, a task list and a working-session
 * list side by side. If those came from three calls, the view could show a
 * coordinator that disagrees with the task bound to it — a picture that never
 * existed. So the Host projects them together and the renderer reads one
 * thing.
 *
 * ## Why the coordinator is created here
 *
 * The coordinator conversation is a normal Session that the PROJECT owns. It is
 * created through the Host's own session API (so the workspace binding, the
 * permission profile and the session row all come from the one authority), and
 * then bound to the project. Creating it anywhere else — in the renderer, in
 * the Agent Server — would put a second session authority next to the Host's.
 *
 * The binding is durable: the next call finds the session and says
 * `created: false`. Replacing the coordinator later does not change the
 * project's identity, its tasks or its memory.
 */

import { ipcMain } from 'electron';

import type {
  ProjectWorkspaceCoordinatorResult,
  ProjectWorkspaceLeaseResult,
  ProjectWorkspaceReleaseResult,
  ProjectWorkspaceStateResult,
  ProjectWorkspaceStatusResult,
} from '../../contracts/project-workspace';
import {
  getDesktopHostProjectApi,
  getDesktopHostSessionApi,
  getDesktopHostSessionInputApi,
} from '../cli/desktop-host-api';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';
import { getLogger, LogComponent } from '../logging/logger';

let registered = false;

const logger = getLogger();

/** The lease the Desktop asks for when the user takes a session over. */
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

/** How many working sessions one status read may cover. */
const MAX_STATUS_SESSIONS = 64;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The live state of one session, as the Agent Server reports it.
 *
 * The Agent Server is the only surface that knows whether a session is
 * running right now — the session row records that a session exists, not
 * what it is doing. So the progress column reads the Agent Server, and a
 * session it has never seen is `null` rather than a guess.
 */
async function readAgentServerSessionStatus(port: number, sessionId: string): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionId)}/status`);
    if (!response.ok) return null;
    const data = (await response.json()) as { status?: unknown };
    return typeof data.status === 'string' ? data.status : null;
  } catch {
    return null;
  }
}

/**
 * The project's coordinator conversation, created on first use.
 *
 * Three cases, and they are different:
 *
 *   - the project has no coordinator yet → create one and bind it;
 *   - the project has one and the session still exists → return it;
 *   - the project has one but the session is gone → the binding is stale, so
 *     it is replaced. A project whose coordinator row was deleted should not
 *     be permanently unusable, and a stale id would otherwise fail every
 *     later read of the project state.
 */
async function ensureCoordinatorSession(projectId: string): Promise<{ sessionId: string; created: boolean }> {
  const projectApi = getDesktopHostProjectApi();
  const sessionApi = getDesktopHostSessionApi();

  const project = await projectApi.getProject(projectId);
  if (!project) throw new Error(`Project "${projectId}" does not exist`);

  const boundSessionId = project.coordinator_session_id;
  if (isNonEmptyString(boundSessionId)) {
    const existing = await sessionApi.get(boundSessionId, { includeAllSessions: true });
    if (existing) return { sessionId: boundSessionId, created: false };
  }

  // The coordinator works in the project's own directory, so the workspace
  // binding is registered through the Host first — the Desktop never persists
  // a raw path on a session row.
  const workspace = await sessionApi.registerLocalDirectory(project.canonical_root);
  const created = await sessionApi.create({
    ...(workspace?.state === 'bound'
      ? {
          workspaceId: workspace.workspaceId,
          workspaceRootId: workspace.rootId,
          workspaceRelativePath: workspace.relativePath,
        }
      : {}),
    title: project.name ? `${project.name} 协调` : '项目协调',
    projectName: project.name,
  });
  await projectApi.bindCoordinatorSession(projectId, created.id);
  return { sessionId: created.id, created: true };
}

export function registerProjectWorkspaceHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('projects:state', async (_event, rawProjectId: unknown): Promise<ProjectWorkspaceStateResult> => {
    if (!isNonEmptyString(rawProjectId)) {
      return { success: false, error: 'Invalid projectId: must be a non-empty string' };
    }
    try {
      const state = await getDesktopHostProjectApi().getProjectState(rawProjectId);
      return { success: true, state };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('projects:state failed', error instanceof Error ? error : new Error(message), undefined, LogComponent.DB);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('projects:coordinator:ensure', async (_event, rawProjectId: unknown): Promise<ProjectWorkspaceCoordinatorResult> => {
    if (!isNonEmptyString(rawProjectId)) {
      return { success: false, error: 'Invalid projectId: must be a non-empty string' };
    }
    try {
      const { sessionId, created } = await ensureCoordinatorSession(rawProjectId);
      return { success: true, sessionId, created };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        'projects:coordinator:ensure failed',
        error instanceof Error ? error : new Error(message),
        undefined,
        LogComponent.DB,
      );
      return { success: false, error: message };
    }
  });

  ipcMain.handle('projects:workSessionStatus', async (_event, rawSessionIds: unknown): Promise<ProjectWorkspaceStatusResult> => {
    if (!Array.isArray(rawSessionIds)) {
      return { success: false, error: 'Invalid sessionIds: expected an array' };
    }
    const sessionIds = rawSessionIds.filter(isNonEmptyString).slice(0, MAX_STATUS_SESSIONS);
    if (sessionIds.length === 0) return { success: true, statuses: {} };
    try {
      const port = getAgentServerPort();
      if (port === null) return { success: true, statuses: {} };
      const entries = await Promise.all(
        sessionIds.map(async (sessionId) => {
          const status = await readAgentServerSessionStatus(port, sessionId);
          return [sessionId, status] as const;
        }),
      );
      const statuses: Record<string, string> = {};
      for (const [sessionId, status] of entries) {
        if (status !== null) statuses[sessionId] = status;
      }
      return { success: true, statuses };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        'projects:workSessionStatus failed',
        error instanceof Error ? error : new Error(message),
        undefined,
        LogComponent.DB,
      );
      return { success: false, error: message };
    }
  });

  ipcMain.handle('session:control:lease:get', async (_event, rawSessionId: unknown): Promise<ProjectWorkspaceLeaseResult> => {
    if (!isNonEmptyString(rawSessionId)) {
      return { success: false, error: 'Invalid sessionId: must be a non-empty string' };
    }
    try {
      const lease = await getDesktopHostSessionInputApi().readControlLease(rawSessionId);
      return { success: true, lease };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        'session:control:lease:get failed',
        error instanceof Error ? error : new Error(message),
        undefined,
        LogComponent.DB,
      );
      return { success: false, error: message };
    }
  });

  ipcMain.handle(
    'session:control:lease:acquire',
    async (_event, rawSessionId: unknown, rawRequestId: unknown, rawTtlMs: unknown): Promise<ProjectWorkspaceLeaseResult> => {
      if (!isNonEmptyString(rawSessionId)) {
        return { success: false, error: 'Invalid sessionId: must be a non-empty string' };
      }
      if (!isNonEmptyString(rawRequestId)) {
        return { success: false, error: 'Invalid requestId: must be a non-empty string' };
      }
      const ttlMs = typeof rawTtlMs === 'number' && Number.isSafeInteger(rawTtlMs) && rawTtlMs > 0
        ? rawTtlMs
        : DEFAULT_LEASE_TTL_MS;
      try {
        // A `null` lease is the ordinary answer to "somebody else holds this
        // session", not an error: the user simply may not take it over right
        // now, and the UI says so.
        const lease = await getDesktopHostSessionInputApi().acquireControlLease({
          sessionId: rawSessionId,
          requestId: rawRequestId,
          ttlMs,
        });
        return { success: true, lease };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          'session:control:lease:acquire failed',
          error instanceof Error ? error : new Error(message),
          undefined,
          LogComponent.DB,
        );
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    'session:control:lease:release',
    async (_event, rawSessionId: unknown, rawRevision: unknown): Promise<ProjectWorkspaceReleaseResult> => {
      if (!isNonEmptyString(rawSessionId)) {
        return { success: false, error: 'Invalid sessionId: must be a non-empty string' };
      }
      if (typeof rawRevision !== 'number' || !Number.isSafeInteger(rawRevision) || rawRevision < 1) {
        return { success: false, error: 'Invalid revision: must be a positive integer' };
      }
      try {
        const released = await getDesktopHostSessionInputApi().releaseControlLease(rawSessionId, rawRevision);
        return { success: true, released };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          'session:control:lease:release failed',
          error instanceof Error ? error : new Error(message),
          undefined,
          LogComponent.DB,
        );
        return { success: false, error: message };
      }
    },
  );
}
