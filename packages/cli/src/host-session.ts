import { resolve } from 'node:path';
import type {
  DurableTimelineEntry,
  HostRunApiV1,
  HostSessionListItem,
  HostSessionRecord,
  HostTaskApiV1,
} from '@duya/agent-protocol';
import { projectTimelinePersistenceMessages, type Message as TranscriptMessage } from '@duya/agent-protocol/transcript';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { readLocalHostRuntime, startLocalHost, type LocalHostHandle } from '@duya/host/local-host';

type TimelineEntry = Parameters<HostSessionHttpClient['appendTimeline']>[1]['entries'][number];

function sameWorkspace(left: HostSessionRecord['workspace'], right: HostSessionRecord['workspace']): boolean {
  return left.state === 'bound'
    && right.state === 'bound'
    && left.workspaceId === right.workspaceId
    && left.rootId === right.rootId
    && left.relativePath === right.relativePath;
}

export interface CliHostSession {
  readonly id: string;
  readonly model: string;
  readonly providerId: string;
  readonly taskApi: HostTaskApiV1;
  readonly runApi: HostRunApiV1;
  listSessions(): Promise<readonly HostSessionListItem[]>;
  loadSession(sessionId: string): Promise<{ readonly session: HostSessionRecord; readonly messages: readonly TranscriptMessage[] }>;
  activateSession(session: HostSessionRecord): void;
  updateModel(model: string): Promise<void>;
  appendTimeline(entries: readonly TimelineEntry[], turnId?: string): Promise<void>;
  updateTitle(title: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create a CLI session through the active local Host. Reuse Desktop's Host API
 * when it is running; otherwise compose the same Electron-free Host locally.
 */
export async function createCliHostSession(options: {
  readonly title: string;
  readonly model: string;
  readonly providerId?: string;
  readonly workingDirectory: string;
}): Promise<CliHostSession> {
  let ownedHost: LocalHostHandle | null = null;
  let runtime = await readLocalHostRuntime();

  if (!runtime) {
    try {
      ownedHost = await startLocalHost();
      runtime = await readLocalHostRuntime();
    } catch (startError) {
      // Another CLI may have won the Host startup race. Reuse it only when its
      // authenticated runtime descriptor is now readable and its PID is live.
      runtime = await readLocalHostRuntime();
      if (!runtime) throw startError;
    }
  }

  if (!runtime) {
    await ownedHost?.close();
    throw new Error('Duya Host started without publishing a runtime descriptor');
  }

  const api = new HostSessionHttpClient(`http://${runtime.host}:${runtime.port}`, runtime.token);
  try {
    // Fail before creating anything if the descriptor is stale or the API is
    // not actually accepting authenticated requests.
    await api.list({ limit: 1 });
    const workspace = await api.registerLocalDirectory(resolve(options.workingDirectory));
    const session = await api.create({
      title: options.title,
      model: options.model,
      providerId: options.providerId ?? 'cli',
      mode: 'code',
      workspaceId: workspace.workspaceId,
      workspaceRootId: workspace.rootId,
      workspaceRelativePath: workspace.relativePath,
    });

    let current = session;
    let closed = false;
    return {
      get id() { return current.id; },
      get model() { return current.model; },
      get providerId() { return current.providerId; },
      taskApi: api,
      runApi: api,
      listSessions: async () => {
        const sessions: HostSessionListItem[] = [];
        let cursor: string | undefined;
        do {
          const page = await api.list({
            workspaceId: current.workspace.state === 'bound'
              ? current.workspace.workspaceId
              : workspace.workspaceId,
            limit: 100,
            includeArchived: false,
            includeAllSessions: false,
            includeDeleted: false,
            ...(cursor === undefined ? {} : { cursor }),
          });
          sessions.push(...page.sessions.filter(({ session: candidate }) =>
            sameWorkspace(candidate.workspace, current.workspace)));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return sessions;
      },
      loadSession: async (sessionId) => {
        const record = await api.get(sessionId);
        if (!record) throw new Error(`Session not found: ${sessionId}`);
        if (!sameWorkspace(record.workspace, current.workspace)) {
          throw new Error('Session belongs to a different workspace directory.');
        }
        const entries: Extract<DurableTimelineEntry, { type: 'message' | 'compaction' }>[] = [];
        let cursor: string | undefined;
        do {
          const page = await api.readMessages(sessionId, {
            limit: 200,
            includeSuperseded: false,
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const item of page.messages) {
            if (item.entry.type === 'message' || item.entry.type === 'compaction') {
              entries.push(item.entry);
            }
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return { session: record, messages: projectTimelinePersistenceMessages(entries) };
      },
      activateSession: (record) => { current = record; },
      updateModel: async (model) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (current.model === model) return;
          const result = await api.update(current.id, current.updatedAt, { model });
          if (result.updated) {
            current = result.session;
            return;
          }
          if (result.reason === 'not_found') {
            throw new Error(`CLI session disappeared while updating its model: ${current.id}`);
          }
          const latest = await api.get(current.id);
          if (!latest) throw new Error(`CLI session disappeared while updating its model: ${current.id}`);
          current = latest;
        }
        throw new Error(`CLI session changed concurrently while updating its model: ${current.id}`);
      },
      appendTimeline: async (entries, turnId) => {
        if (entries.length === 0) return;
        await api.appendTimeline(current.id, {
          entries: [...entries],
          ...(turnId === undefined ? {} : { turnId }),
        });
      },
      updateTitle: async (title) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (current.title === title) return;
          const result = await api.update(current.id, current.updatedAt, { title });
          if (result.updated) {
            current = result.session;
            return;
          }
          if (result.reason === 'not_found') {
            throw new Error(`CLI session disappeared while updating its title: ${current.id}`);
          }
          const latest = await api.get(current.id);
          if (!latest) throw new Error(`CLI session disappeared while updating its title: ${current.id}`);
          current = latest;
        }
        throw new Error(`CLI session title changed concurrently: ${current.id}`);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await ownedHost?.close();
      },
    };
  } catch (error) {
    await ownedHost?.close();
    throw error;
  }
}
