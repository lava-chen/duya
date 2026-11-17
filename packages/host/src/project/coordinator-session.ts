import type { HostProjectRecord } from '@duya/agent-protocol/projects';
import type { HostSessionApiV1, HostWorkspaceRegistrationApiV1 } from '@duya/agent-protocol/session-api';
import { PROJECT_COORDINATOR_PROFILE_ID } from './identity.js';

export interface ProjectCoordinatorSessionResult {
  readonly sessionId: string;
  readonly created: boolean;
}

export interface ProjectCoordinatorSessionService {
  ensureCoordinatorSession(projectId: string): Promise<ProjectCoordinatorSessionResult>;
}

export interface ProjectCoordinatorSessionOptions {
  readonly projects: Pick<{
    getProject(projectId: string): Promise<HostProjectRecord | null>;
    bindCoordinatorSession(projectId: string, sessionId: string): Promise<HostProjectRecord | null>;
  }, 'getProject' | 'bindCoordinatorSession'>;
  readonly sessions: Pick<HostSessionApiV1, 'get' | 'create'>;
  readonly workspaces: Pick<HostWorkspaceRegistrationApiV1, 'registerLocalDirectory'>;
}

/**
 * Create or reuse the durable Coordinator conversation for one Project.
 * Concurrent callers in this Host process share the same creation promise, so
 * Desktop and CLI cannot race to create competing first sessions.
 */
export function createProjectCoordinatorSessionService(
  options: ProjectCoordinatorSessionOptions,
): ProjectCoordinatorSessionService {
  const inFlight = new Map<string, Promise<ProjectCoordinatorSessionResult>>();

  async function createOrReuse(projectId: string): Promise<ProjectCoordinatorSessionResult> {
    const project = await options.projects.getProject(projectId);
    if (project === null) throw new Error(`Project "${projectId}" does not exist`);

    const boundSessionId = project.coordinator_session_id?.trim();
    if (boundSessionId) {
      const existing = await options.sessions.get(boundSessionId, { includeAllSessions: true });
      if (existing !== null && existing.status !== 'deleted') {
        return { sessionId: boundSessionId, created: false };
      }
    }

    const workspace = await options.workspaces.registerLocalDirectory(project.canonical_root);
    const session = await options.sessions.create({
      workspaceId: workspace.workspaceId,
      workspaceRootId: workspace.rootId,
      workspaceRelativePath: workspace.relativePath,
      title: project.name ? `${project.name} 协调` : '项目协调',
      projectName: project.name,
      agentProfileId: PROJECT_COORDINATOR_PROFILE_ID,
    });
    const bound = await options.projects.bindCoordinatorSession(projectId, session.id);
    if (bound === null) throw new Error(`Project "${projectId}" disappeared while creating its Coordinator session`);
    return { sessionId: session.id, created: true };
  }

  return {
    ensureCoordinatorSession(projectId) {
      const existing = inFlight.get(projectId);
      if (existing !== undefined) {
        return existing.then(({ sessionId }) => ({ sessionId, created: false }));
      }
      const pending = createOrReuse(projectId).finally(() => {
        if (inFlight.get(projectId) === pending) inFlight.delete(projectId);
      });
      inFlight.set(projectId, pending);
      return pending;
    },
  };
}
