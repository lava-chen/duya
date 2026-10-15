import {
  absolutePathFromRoot,
  registerWorkspaceDirectory,
  resolveWorkspaceBinding,
  resolveWorkspacePathReference,
} from '@duya/data/workspace-resolver';
import type { SqliteDatabase } from '@duya/data/core-database';
import type { WorkspaceId } from '@duya/agent-protocol';
import type { HostWorkspaceBinding } from '@duya/agent-protocol/session-api';
import type { WorkspaceStore } from '@duya/data/workspace-store';
import type { HostWorkspaceAccess } from './session-api.js';

function normalizeRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
}

/** Compose the existing Workspace identity store and lazy legacy binding resolver. */
export function createDatabaseWorkspaceAccess(
  db: SqliteDatabase,
  workspaces: WorkspaceStore,
): HostWorkspaceAccess {
  return {
    resolveWorkspaceReference(workingDirectory) {
      const reference = resolveWorkspacePathReference({ db, cwd: workingDirectory });
      if (!reference) return null;
      return {
        state: 'bound',
        workspaceId: reference.workspace_id as WorkspaceId,
        rootId: reference.root_id,
        relativePath: reference.relative_path,
      };
    },
    registerLocalDirectory(directory) {
      const reference = registerWorkspaceDirectory({ db, cwd: directory });
      if (!reference) return null;
      return {
        state: 'bound',
        workspaceId: reference.workspace_id as WorkspaceId,
        rootId: reference.root_id,
        relativePath: reference.relative_path,
      };
    },
    resolvePath(workspaceId, rootId, relativePath = '') {
      const workspace = workspaces.getWorkspace(workspaceId);
      if (!workspace) return null;
      const selectedRootId = rootId ?? workspace.default_root_id;
      if (!selectedRootId) return null;
      const root = workspaces.getRoot(selectedRootId);
      if (!root || root.workspace_id !== workspaceId || root.access === 'none') return null;
      const safeRelativePath = normalizeRelativePath(relativePath);
      if (safeRelativePath === null) return null;
      return absolutePathFromRoot(root.canonical_realpath, safeRelativePath);
    },
    bindSession(sessionId, workspaceId, rootId, relativePath) {
      const workspace = workspaces.getWorkspace(workspaceId);
      if (!workspace) return null;
      const selectedRootId = rootId ?? workspace.default_root_id;
      if (!selectedRootId) return null;
      const root = workspaces.getRoot(selectedRootId);
      if (!root || root.workspace_id !== workspaceId || root.access === 'none') return null;
      const safeRelativePath = normalizeRelativePath(relativePath);
      if (safeRelativePath === null) return null;
      const workingDirectory = absolutePathFromRoot(root.canonical_realpath, safeRelativePath);
      workspaces.bindSession({
        session_id: sessionId,
        workspace_id: workspaceId,
        root_id: root.root_id,
        relative_path: safeRelativePath,
        binding_kind: 'explicit',
        project_id: workspace.project_id,
        resolved_from_cwd: workingDirectory,
        revision_seen: workspace.revision,
      });
      return workingDirectory;
    },
    clearSessionBinding(sessionId) {
      workspaces.deleteBinding(sessionId);
    },
    identifyWorkspace(sessionId, workingDirectory) {
      const resolution = resolveWorkspaceBinding({ db, sessionId, cwd: workingDirectory });
      const binding = resolution.binding;
      if (!binding) return null;
      return {
        state: 'bound',
        workspaceId: binding.workspace_id as WorkspaceId,
        rootId: binding.root_id,
        relativePath: binding.relative_path,
      };
    },
  };
}
