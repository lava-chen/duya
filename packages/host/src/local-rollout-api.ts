import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ImportValidationError } from '@duya/data/message-log';
import type {
  HostLocalSessionImportApiV1,
  HostLocalSessionImportInput,
  HostLocalSessionImportResult,
  HostLocalSessionRollbackResult,
  HostLocalRolloutImportInput,
  HostRolloutExportResult,
  HostRolloutImportResult,
} from '@duya/agent-protocol/session-api';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import type { HostSessionApiV1 } from '@duya/agent-protocol/session-api';

export interface HostLocalRolloutApiV1 extends HostLocalSessionImportApiV1 {
  exportRollout(sessionId: string, destinationDirectory?: string): Promise<HostRolloutExportResult>;
  importRollout(input: HostLocalRolloutImportInput): Promise<HostRolloutImportResult>;
}

export class HostLocalRolloutApiError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostLocalRolloutApiError';
  }
}

/** Local file import adapter. Public/remote APIs accept uploaded data, never a host path. */
export function createHostLocalRolloutApi(options: {
  readonly stores: Pick<CoreDataHostStores, 'sessions' | 'messageLog'>;
  readonly sessions: Pick<HostSessionApiV1, 'create'>;
  readonly rolloutRoot: string;
}): HostLocalRolloutApiV1 {
  return {
    async exportRollout(sessionId, destinationDirectory) {
      if (destinationDirectory !== undefined && !path.isAbsolute(destinationDirectory)) {
        throw new HostLocalRolloutApiError(400, 'invalid_rollout_path', 'Rollout destination directory must be absolute');
      }
      try {
        return options.stores.messageLog.exportRollout(sessionId, destinationDirectory);
      } catch (error) {
        throw normalizeRolloutError(error);
      }
    },
    async importRollout(input) {
      const sourcePath = input.sourcePath.trim();
      if (!path.isAbsolute(sourcePath)) {
        throw new HostLocalRolloutApiError(400, 'invalid_rollout_path', 'Rollout source path must be absolute');
      }

      if (input.mode === 'continue') {
        const targetSessionId = input.targetSessionId.trim();
        if (targetSessionId.length === 0) {
          throw new HostLocalRolloutApiError(400, 'invalid_session_id', 'Target session id is required');
        }
        try {
          return options.stores.messageLog.importContinueFromFile(targetSessionId, sourcePath);
        } catch (error) {
          throw normalizeRolloutError(error);
        }
      }

      const sessionId = `import-${randomUUID()}`;
      const title = input.title && input.title.length > 0
        ? input.title
        : `Imported session (${path.basename(sourcePath)})`;
      await options.sessions.create({
        id: sessionId,
        title,
        agentType: 'main',
        status: 'active',
      });
      try {
        return options.stores.messageLog.importRestoreFromFile(sessionId, sourcePath);
      } catch (error) {
        throw normalizeRolloutError(error);
      }
    },
    async createImportedSession(input: HostLocalSessionImportInput): Promise<HostLocalSessionImportResult> {
      const sessionId = input.sessionId.trim();
      if (
        !sessionId ||
        typeof input.title !== 'string' ||
        typeof input.workingDirectory !== 'string' ||
        typeof input.projectName !== 'string'
      ) {
        throw new HostLocalRolloutApiError(400, 'invalid_session_import', 'Imported session metadata is invalid');
      }
      options.stores.sessions.create({
        id: sessionId,
        title: input.title,
        workingDirectory: input.workingDirectory,
        projectName: input.projectName,
        status: 'active',
        mode: 'code',
        providerId: 'env',
        agentType: 'main',
      });
      return { sessionId };
    },
    async rollbackImportedSessions(sessionIds): Promise<HostLocalSessionRollbackResult> {
      const deletedSessionIds: string[] = [];
      const failedSessionIds: string[] = [];
      const rolloutRoot = path.resolve(options.rolloutRoot);
      for (const rawSessionId of sessionIds) {
        const sessionId = rawSessionId.trim();
        if (!sessionId) {
          failedSessionIds.push(rawSessionId);
          continue;
        }
        try {
          const relativePath = options.stores.sessions.getRolloutPath(sessionId);
          options.stores.messageLog.deleteBySession(sessionId);
          options.stores.sessions.delete(sessionId);
          if (relativePath) {
            const absolutePath = path.resolve(rolloutRoot, relativePath);
            if (isPathInside(rolloutRoot, absolutePath)) {
              try { fs.unlinkSync(absolutePath); } catch { /* File cleanup is best-effort after row deletion. */ }
            }
          }
          deletedSessionIds.push(sessionId);
        } catch {
          failedSessionIds.push(sessionId);
        }
      }
      return { deletedSessionIds, failedSessionIds };
    },
  };
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeRolloutError(error: unknown): unknown {
  if (error instanceof ImportValidationError) {
    return new HostLocalRolloutApiError(400, 'invalid_rollout', error.message);
  }
  if (error instanceof Error && error.message.startsWith('importRollout: source file not found:')) {
    return new HostLocalRolloutApiError(404, 'rollout_source_not_found', error.message);
  }
  if (error instanceof Error && error.message.startsWith('exportRollout: session not found:')) {
    return new HostLocalRolloutApiError(404, 'session_not_found', error.message);
  }
  if (error instanceof Error && error.message.startsWith('importContinueFromFile: session not found:')) {
    return new HostLocalRolloutApiError(404, 'session_not_found', error.message);
  }
  return error;
}
