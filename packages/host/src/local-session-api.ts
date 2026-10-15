import type { SessionId } from '@duya/agent-protocol';
import type {
  HostLocalSessionSummary,
  HostLocalSessionSummaryQuery,
  HostSessionApiV1,
  HostSessionListQuery,
} from '@duya/agent-protocol/session-api';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import type { CoreSession } from '@duya/data/session-store';

/** Local-only session projection for Desktop's legacy IPC row adapter. */
export interface HostLocalSessionApiV1 {
  readLocalSession(
    sessionId: SessionId,
    options?: { readonly includeAllSessions?: boolean },
  ): Promise<CoreSession | null>;
  listLocalSessions(query?: HostSessionListQuery): Promise<HostLocalSessionPage>;
  listLocalSessionSummariesByPrefix(
    query: HostLocalSessionSummaryQuery,
  ): Promise<readonly HostLocalSessionSummary[]>;
}

export interface HostLocalSessionPage {
  readonly sessions: readonly CoreSession[];
  readonly nextCursor: string | null;
}

/**
 * Keep legacy-only fields, including local filesystem paths, on the local Host
 * surface. The public session API continues to expose opaque Workspace IDs.
 */
export function createHostLocalSessionApi(options: {
  readonly stores: Pick<CoreDataHostStores, 'sessions'>;
  readonly sessions: Pick<HostSessionApiV1, 'get' | 'list'>;
}): HostLocalSessionApiV1 {
  return {
    async readLocalSession(sessionId, getOptions = {}) {
      const visible = await options.sessions.get(sessionId, getOptions);
      return visible ? options.stores.sessions.get(sessionId) : null;
    },
    async listLocalSessions(query = {}) {
      const page = await options.sessions.list(query);
      const sessions: CoreSession[] = [];
      for (const item of page.sessions) {
        const stored = options.stores.sessions.get(item.session.id);
        if (stored) sessions.push(stored);
      }
      return { sessions, nextCursor: page.nextCursor };
    },
    async listLocalSessionSummariesByPrefix(query) {
      return options.stores.sessions.listByPrefix(query.idPrefix, {
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      }).map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        model: row.model,
        messageCount: row.message_count,
      }));
    },
  };
}
