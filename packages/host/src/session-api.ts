import { randomUUID } from 'node:crypto';
import { rolloutLineTimestamp, type DurableTimelineEntry } from '@duya/agent-protocol/rollout-events';
import type {
  HostSessionApiV1,
  HostSessionArchiveResult,
  HostSessionCreateInput,
  HostSessionDeleteResult,
  HostSessionForkInput,
  HostSessionForkResult,
  HostSessionPermissionProfileInput,
  HostRolloutReconcileResult,
  HostSessionListQuery,
  HostSessionSearchQuery,
  HostSessionSearchResult,
  HostMessageSearchResult,
  HostMessageSearchQuery,
  HostSessionChangeStats,
  HostMessagePage,
  HostMessageReadQuery,
  HostSessionPage,
  HostSessionPatch,
  HostSessionRecord,
  HostSessionUpdateResult,
  HostTimelineAppendInput,
  HostTimelinePage,
  HostTimelineReadQuery,
  HostTimelineWriteReceipt,
  HostWorkspaceBinding,
  HostWorkspaceRegistrationApiV1,
  SessionPermissionProfile,
} from '@duya/agent-protocol/session-api';
import { deriveSessionForkSeed } from '@duya/agent-protocol/session-fork';
import type { WorkspaceId } from '@duya/agent-protocol';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import type { SqliteDatabase } from '@duya/data/core-database';
import type { ChatTurnReviewStore } from '@duya/data/chat-turn-review-store';
import type { NewEvent } from '@duya/data/message-log';
import type { CoreSession, SessionPatch } from '@duya/data/session-store';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import { createDatabaseWorkspaceAccess } from './workspace-access.js';
import { createSessionArchiveOperations } from './session-archive.js';


const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_MESSAGE_SEARCH_RESULTS = 300;

export type HostSessionApiErrorCode =
  | 'invalid_page'
  | 'invalid_cursor'
  | 'invalid_workspace_path'
  | 'workspace_not_found'
  | 'session_not_found';

export class HostSessionApiError extends Error {
  constructor(
    readonly code: HostSessionApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostSessionApiError';
  }
}

/** Electron-free mapping between opaque workspace identities and Host paths. */
export interface HostWorkspaceAccess {
  resolveWorkspaceReference?(workingDirectory: string): HostWorkspaceBinding | null;
  registerLocalDirectory?(directory: string): HostWorkspaceBinding | null;
  bindSession?(
    sessionId: string,
    workspaceId: WorkspaceId,
    rootId: string | null,
    relativePath: string,
  ): string | null;
  clearSessionBinding?(sessionId: string): void;
  resolvePath?(
    workspaceId: WorkspaceId,
    rootId?: string | null,
    relativePath?: string,
  ): string | null | Promise<string | null>;
  identifyWorkspace?(
    sessionId: string,
    workingDirectory: string,
  ): HostWorkspaceBinding | null | Promise<HostWorkspaceBinding | null>;
}

/** Create the loopback-only Workspace registration capability. */
export function createHostWorkspaceRegistrationApi(
  workspaces: HostWorkspaceAccess,
): HostWorkspaceRegistrationApiV1 {
  return {
    async registerLocalDirectory(directory) {
      const binding = workspaces.registerLocalDirectory?.(directory);
      if (!binding || binding.state !== 'bound') {
        throw new HostSessionApiError(
          'invalid_workspace_path',
          'Directory must be an absolute, accessible local directory',
        );
      }
      return binding;
    },
  };
}

/**
 * The provider and model a newly created session should start on, for callers
 * that do not pin one.
 */
export interface DefaultSessionModelProvider {
  readonly model: string;
  readonly providerId: string;
  /**
   * Set when the resolved model is not among the provider's served models. The
   * session is still created — a warning is strictly better than refusing, and
   * the turn may well succeed against a provider that serves more than it
   * declares.
   */
  readonly warning?: string;
}

export interface HostSessionApiOptions {
  readonly stores: Pick<CoreDataHostStores, 'sessions' | 'messageLog' | 'workspaces' | 'spawnEdges' | 'locks'>;
  readonly rolloutRoot: string;
  readonly now?: () => number;
  readonly warn?: (message: string, fields: Record<string, unknown>) => void;
  readonly workspaceDatabase?: SqliteDatabase;
  readonly workspaces?: HostWorkspaceAccess;
  readonly chatTurnReviews?: Pick<ChatTurnReviewStore, 'getSessionStats'>;
  readonly permissionSettings?: Pick<MainSettingsStore, 'getString'>;
  /**
   * Resolved when a create call omits `model` or `providerId`.
   *
   * ## Why the Host fills this rather than each client
   *
   * The session row's own defaults are placeholders: `model` is `''` and
   * `provider_id` is the literal `'env'` (`@duya/data/session-store`). That is
   * fine for storage, but it is exactly what a client renders — so a client
   * that creates a session without naming a provider shows the user
   * `env · default` while config.toml selects a real provider and model.
   *
   * Filling it here means Desktop and the CLI record the same thing. Resolving
   * it in one client would leave the other rendering placeholders, which is
   * the fork the single-client contract exists to prevent.
   *
   * Returning `null` (no config, no secrets) leaves the row on its schema
   * defaults rather than inventing a provider.
   */
  readonly defaultModelProvider?: () => DefaultSessionModelProvider | null;
}

interface PageCursor {
  readonly version: 1;
  readonly resource: 'sessions' | 'timeline' | 'projected-timeline' | 'messages';
  readonly owner: string;
  readonly offset: number;
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeOffset(
  cursor: string | undefined,
  resource: PageCursor['resource'],
  owner: string,
): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<PageCursor>;
    if (
      parsed.version !== 1 ||
      parsed.resource !== resource ||
      parsed.owner !== owner ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0
    ) {
      throw new Error('cursor fields do not match');
    }
    return parsed.offset as number;
  } catch {
    throw new HostSessionApiError('invalid_cursor', 'Cursor is invalid or belongs to another request');
  }
}

function pageSize(limit: number | undefined): number {
  const value = limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new HostSessionApiError('invalid_page', `limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return value;
}

function sessionToRecord(
  session: CoreSession,
  workspace: HostWorkspaceBinding,
): HostSessionRecord {
  return {
    id: session.id,
    workspace,
    title: session.title,
    projectName: session.projectName,
    status: session.status,
    model: session.model,
    providerId: session.providerId,
    mode: session.mode,
    permissionMode: session.permissionMode as HostSessionRecord['permissionMode'],
    agentProfileId: session.agentProfileId,
    parentSessionId: session.parentSessionId,
    agentType: session.agentType,
    agentName: session.agentName,
    draft: session.draft,
    extensions: session.extensions as HostSessionRecord['extensions'],
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    recencyAt: session.recencyAt,
    lastTurnStartedAt: session.lastTurnStartedAt,
  };
}

function isVisibleSession(session: CoreSession): boolean {
  return session.status !== 'deleted'
    && session.parentSessionId === null
    && !session.id.startsWith('gw-');
}

function visibleTopLevelSessions(sessions: readonly CoreSession[]): CoreSession[] {
  return sessions.filter(isVisibleSession);
}

export function createHostSessionApi(options: HostSessionApiOptions): HostSessionApiV1 {
  const { sessions, messageLog, spawnEdges } = options.stores;
  const archiveOperations = createSessionArchiveOperations({
    stores: options.stores,
    rolloutRoot: options.rolloutRoot,
    ...(options.now ? { now: options.now } : {}),
    ...(options.warn ? { warn: options.warn } : {}),
  });
  const workspaceAccess = options.workspaces ?? (options.workspaceDatabase
    ? createDatabaseWorkspaceAccess(options.workspaceDatabase, options.stores.workspaces)
    : undefined);

  async function resolveWorkspace(
    session: Pick<CoreSession, 'id' | 'workingDirectory'>,
  ): Promise<HostWorkspaceBinding> {
    if (!session.workingDirectory || !workspaceAccess?.identifyWorkspace) {
      return { state: 'legacy_unbound' };
    }
    return await workspaceAccess.identifyWorkspace(session.id, session.workingDirectory)
      ?? { state: 'legacy_unbound' };
  }

  async function toRecord(session: CoreSession): Promise<HostSessionRecord> {
    return sessionToRecord(session, await resolveWorkspace(session));
  }

  async function requireSession(sessionId: string): Promise<CoreSession> {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new HostSessionApiError('session_not_found', `Session not found: ${sessionId}`);
    }
    return session;
  }

  async function list(query: HostSessionListQuery = {}): Promise<HostSessionPage> {
    const owner = JSON.stringify({
      workspaceId: query.workspaceId ?? null,
      parentSessionId: query.parentSessionId ?? null,
      includeArchived: query.includeArchived ?? false,
      includeDeleted: query.includeDeleted ?? false,
      includeAllSessions: query.includeAllSessions ?? false,
    });
    if (query.cursor !== undefined && query.offset !== undefined) {
      throw new HostSessionApiError('invalid_page', 'cursor and offset cannot be used together');
    }
    const offset = query.cursor !== undefined
      ? decodeOffset(query.cursor, 'sessions', owner)
      : query.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HostSessionApiError('invalid_page', 'offset must be a non-negative integer');
    }
    const limit = pageSize(query.limit);
    const candidates = sessions.list({
      includeArchived: query.includeArchived ?? false,
      includeDeleted: query.includeDeleted ?? false,
    });
    const rowBindings: Array<{ session: CoreSession; workspace: HostWorkspaceBinding }> = [];
    for (const session of candidates) {
      if (query.parentSessionId !== undefined && session.parentSessionId !== query.parentSessionId) continue;
      if (!query.includeAllSessions && query.parentSessionId === undefined && !isVisibleSession(session)) continue;
      const workspace = await resolveWorkspace(session);
      if (query.workspaceId !== undefined && (workspace.state !== 'bound' || workspace.workspaceId !== query.workspaceId)) continue;
      rowBindings.push({ session, workspace });
    }
    const pageRows = rowBindings.slice(offset, offset + limit);
    const page = pageRows.map(({ session, workspace }) => ({
      session: sessionToRecord(session, workspace),
      timelineCount: messageLog.getCount(session.id),
    }));
    const nextOffset = offset + page.length;
    return {
      sessions: page,
      nextCursor: nextOffset < rowBindings.length
        ? encodeCursor({ version: 1, resource: 'sessions', owner, offset: nextOffset })
        : null,
    };
  }

  async function searchSessions(
    query: string,
    options: HostSessionSearchQuery = {},
  ): Promise<HostSessionSearchResult[]> {
    const limit = searchLimit(options.limit ?? 10);
    if (!query || limit === 0) return [];

    const rows: HostSessionSearchResult[] = [];
    const bySessionId = new Map<string, number>();
    for (const session of sessions.search(query, limit)) {
      bySessionId.set(session.id, rows.length);
      rows.push({
        session: sessionToRecord(session, await resolveWorkspace(session)),
        snippet: '',
        messageId: null,
        sequence: null,
      });
    }

    if (options.includeContent !== false && rows.length < limit) {
      const contentHits = messageLog.searchText(query, { limit: limit - rows.length + 5 });
      for (const hit of contentHits) {
        const existingIndex = bySessionId.get(hit.sessionId);
        if (existingIndex !== undefined) {
          const existing = rows[existingIndex]!;
          if (!existing.snippet) {
            rows[existingIndex] = {
              ...existing,
              snippet: hit.snippet,
              messageId: hit.messageId,
              sequence: hit.seq,
            };
          }
          continue;
        }
        if (rows.length >= limit) break;
        const session = sessions.get(hit.sessionId);
        if (!session || session.status === 'deleted') continue;
        bySessionId.set(session.id, rows.length);
        rows.push({
          session: sessionToRecord(session, await resolveWorkspace(session)),
          snippet: hit.snippet,
          messageId: hit.messageId,
          sequence: hit.seq,
        });
      }
    }

    rows.sort((left, right) => right.session.updatedAt - left.session.updatedAt);
    return rows.slice(0, limit);
  }

  async function searchMessages(
    query: string,
    requested: number | HostMessageSearchQuery = 20,
  ): Promise<HostMessageSearchResult[]> {
    const options = typeof requested === 'number' ? { limit: requested } : requested;
    const limit = searchMessageLimit(options.limit ?? 20);
    if (!query || limit === 0) return [];
    if (options.sessionIds && options.sessionIds.length === 0) return [];
    if (options.sessionIds && options.sessionIds.length > 100) {
      throw new HostSessionApiError('invalid_page', 'sessionIds cannot contain more than 100 items');
    }

    const records = new Map<string, HostSessionRecord>();
    const hits: HostMessageSearchResult[] = [];
    for (const hit of messageLog.searchText(query, {
      limit,
      ...(options.sessionIds === undefined ? {} : { sessionIds: [...options.sessionIds] }),
    })) {
      let record = records.get(hit.sessionId);
      if (!record) {
        const session = sessions.get(hit.sessionId);
        if (!session || session.status === 'deleted') continue;
        record = sessionToRecord(session, await resolveWorkspace(session));
        records.set(session.id, record);
      }
      hits.push({
        session: record,
        messageId: hit.messageId,
        sequence: hit.seq,
        snippet: hit.snippet,
      });
    }
    return hits;
  }

  async function getSessionChangeStats(sessionId: string): Promise<HostSessionChangeStats> {
    await requireSession(sessionId);
    return options.chatTurnReviews?.getSessionStats(sessionId) ?? {
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
    };
  }

  async function resolveSessionPermissionProfile(
    input: HostSessionPermissionProfileInput,
  ): Promise<SessionPermissionProfile> {
    const explicit = input.explicit;
    const parentSessionId = input.parentSessionId || null;
    if (parentSessionId && input.trustedOverride && isSessionPermissionProfile(explicit)) {
      return explicit;
    }
    if (parentSessionId) {
      const parent = sessions.get(parentSessionId);
      return isSessionPermissionProfile(parent?.permissionMode) ? parent.permissionMode : 'auto';
    }
    if (isSessionPermissionProfile(explicit)) return explicit;

    try {
      const setting = options.permissionSettings?.getString('permissionMode') ?? null;
      if (setting === null) return 'auto';
      if (setting === 'bypass') return 'full_access';
      if (setting === 'auto') return 'auto';
      return 'default';
    } catch {
      return 'auto';
    }
  }

  async function create(input: HostSessionCreateInput): Promise<HostSessionRecord> {
    let workingDirectory = '';
    if (input.workspaceId !== undefined) {
      workingDirectory = (await workspaceAccess?.resolvePath?.(
        input.workspaceId,
        input.workspaceRootId,
        input.workspaceRelativePath,
      )) ?? '';
      if (!workingDirectory) {
        throw new HostSessionApiError('workspace_not_found', `Workspace not found: ${input.workspaceId}`);
      }
    }
    const id = input.id ?? randomUUID();

    // Fill whichever of model/providerId the caller left unset from the host's
    // own config resolution. Resolved per field rather than as a pair, so
    // `--model` alone still gets the configured provider and vice versa. Only
    // consulted when something is actually missing, so a fully-specified create
    // never touches config.toml.
    const needsFallback = input.model === undefined || input.providerId === undefined;
    const fallback = needsFallback ? options.defaultModelProvider?.() ?? null : null;
    if (fallback?.warning !== undefined) {
      options.warn?.('session created with a model the provider may not serve', {
        model: fallback.model,
        providerId: fallback.providerId,
        warning: fallback.warning,
      });
    }
    const model = input.model ?? fallback?.model;
    const providerId = input.providerId ?? fallback?.providerId;

    const existing = sessions.get(id);
    if (existing) {
      const patch: SessionPatch = {
        ...(input.workspaceId === undefined ? {} : { workingDirectory }),
        ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.agentProfileId !== undefined ? { agentProfileId: input.agentProfileId } : {}),
        ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
        ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
        ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
      };
      sessions.update(id, patch);
      for (const [key, value] of Object.entries(input.extensions ?? {})) {
        sessions.setExtension(id, key, value);
      }
      recordSpawnEdge(input, id);
      const upserted = sessions.get(id);
      if (!upserted) throw new HostSessionApiError('session_not_found', `Session not found: ${id}`);
      return toRecord(upserted);
    }
    const session = sessions.create({
      id,
      workingDirectory,
      status: input.status ?? 'active',
      updatedAt: Date.now(),
      extensions: {
        context_summary: '',
        context_summary_updated_at: 0,
        ...(input.extensions ?? {}),
      },
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(providerId !== undefined ? { providerId } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
      ...(input.agentProfileId !== undefined ? { agentProfileId: input.agentProfileId } : {}),
      ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.draft !== undefined ? { draft: input.draft } : {}),
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    });
    recordSpawnEdge(input, id);
    return toRecord(session);
  }

  function recordSpawnEdge(input: HostSessionCreateInput, childSessionId: string): void {
    if (!input.parentSessionId) return;
    spawnEdges.record({
      parentSessionId: input.parentSessionId,
      childSessionId,
      spawnType: input.spawn?.type ?? 'subagent',
      ...(input.spawn?.reason === undefined ? {} : { spawnReason: input.spawn.reason }),
      ...(input.spawn?.turnId === undefined ? {} : { spawnTurnId: input.spawn.turnId }),
    });
  }

  async function get(
    sessionId: string,
    getOptions: { readonly includeAllSessions?: boolean } = {},
  ): Promise<HostSessionRecord | null> {
    const session = sessions.get(sessionId);
    return session && (getOptions.includeAllSessions || isVisibleSession(session)) ? toRecord(session) : null;
  }

  async function update(
    sessionId: string,
    expectedUpdatedAt: number | undefined,
    patch: HostSessionPatch,
  ): Promise<HostSessionUpdateResult> {
    const current = sessions.get(sessionId);
    if (!current) return { updated: false, reason: 'not_found' };
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      return { updated: false, reason: 'conflict' };
    }
    const dataPatch: SessionPatch = {
      ...(patch.projectName !== undefined ? { projectName: patch.projectName } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
      ...(patch.agentProfileId !== undefined ? { agentProfileId: patch.agentProfileId } : {}),
      ...(patch.parentSessionId !== undefined ? { parentSessionId: patch.parentSessionId } : {}),
      ...(patch.agentType !== undefined ? { agentType: patch.agentType } : {}),
      ...(patch.agentName !== undefined ? { agentName: patch.agentName } : {}),
      ...(patch.draft !== undefined ? { draft: patch.draft } : {}),
    };

    const persist = (): void => {
      let workingDirectory: string | undefined;
      if (patch.workspace?.state === 'bound') {
        workingDirectory = workspaceAccess?.bindSession?.(
          sessionId,
          patch.workspace.workspaceId,
          patch.workspace.rootId,
          patch.workspace.relativePath,
        ) ?? undefined;
        if (!workingDirectory) {
          throw new HostSessionApiError('workspace_not_found', `Workspace not found: ${patch.workspace.workspaceId}`);
        }
      } else if (patch.workspace?.state === 'legacy_unbound') {
        if (!workspaceAccess?.clearSessionBinding) {
          throw new HostSessionApiError('workspace_not_found', 'Workspace binding cannot be cleared by this Host');
        }
        workspaceAccess.clearSessionBinding(sessionId);
        workingDirectory = '';
      }
      sessions.update(sessionId, {
        ...dataPatch,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      });
      for (const [key, value] of Object.entries(patch.extensions ?? {})) {
        sessions.setExtension(sessionId, key, value);
      }
    };

    if (patch.workspace !== undefined) {
      if (!options.workspaceDatabase) {
        throw new HostSessionApiError('workspace_not_found', 'Workspace binding updates require the Host data store');
      }
      options.workspaceDatabase.transaction(persist)();
    } else {
      persist();
    }
    const updated = sessions.get(sessionId);
    if (!updated) return { updated: false, reason: 'not_found' };
    return { updated: true, session: await toRecord(updated) };
  }

  async function deleteSession(
    sessionId: string,
    expectedUpdatedAt?: number,
  ): Promise<HostSessionDeleteResult> {
    const current = sessions.get(sessionId);
    if (!current) return { deleted: false, reason: 'not_found' };
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      return { deleted: false, reason: 'conflict' };
    }
    sessions.update(sessionId, { status: 'deleted' });
    return { deleted: true };
  }

  async function archiveSession(sessionId: string): Promise<HostSessionArchiveResult> {
    return archiveOperations.archive(sessionId);
  }

  async function unarchiveSession(sessionId: string): Promise<boolean> {
    return archiveOperations.unarchive(sessionId);
  }

  async function forkAt(
    sourceSessionId: string,
    input: HostSessionForkInput,
  ): Promise<HostSessionForkResult> {
    const source = sessions.get(sourceSessionId);
    if (!source) return { ok: false, reason: 'source_not_found', seedCount: 0 };
    if (source.status === 'archived') {
      return { ok: false, reason: 'source_archived', seedCount: 0 };
    }

    const seed = deriveSessionForkSeed({
      timeline: messageLog.repairedProject(sourceSessionId),
      throughMessageId: input.throughMessageId,
      newSessionId: input.newSessionId,
    });
    if (!seed.ok) return { ok: false, reason: 'message_not_found', seedCount: 0 };

    // Keep the source's local cwd inside Host storage; only opaque workspace
    // identity is exposed by the API. Rebind the fork when the source already
    // has a granted Workspace identity.
    const inheritedWorkspace = await resolveWorkspace(source);
    sessions.create({
      id: input.newSessionId,
      title: input.title ?? `${source.title} (fork)`,
      workingDirectory: source.workingDirectory,
      projectName: source.projectName,
      model: source.model,
      providerId: source.providerId,
      mode: source.mode,
      permissionMode: source.permissionMode,
      agentProfileId: source.agentProfileId,
      agentType: source.agentType ?? 'main',
      agentName: source.agentName,
      parentSessionId: sourceSessionId,
      status: 'active',
    });
    if (inheritedWorkspace.state === 'bound') {
      workspaceAccess?.bindSession?.(
        input.newSessionId,
        inheritedWorkspace.workspaceId,
        inheritedWorkspace.rootId,
        inheritedWorkspace.relativePath,
      );
    }

    messageLog.appendBatch(seed.entries.map((entry) => ({
      id: entry.id,
      sessionId: input.newSessionId,
      turnId: null,
      payload: entry,
      createdAt: entry.createdAt,
    })));
    recordSpawnEdge({
      parentSessionId: sourceSessionId,
      spawn: {
        type: 'fork',
        reason: `fork at message ${input.throughMessageId}`,
      },
    }, input.newSessionId);

    return {
      ok: true,
      sessionId: input.newSessionId,
      seedCount: seed.entries.length,
    };
  }

  async function reconcileRollouts(): Promise<HostRolloutReconcileResult> {
    return messageLog.reconcileAll();
  }

  async function countTimeline(sessionId: string): Promise<number> {
    return messageLog.getCount(sessionId);
  }

  async function deleteTimeline(sessionId: string): Promise<number> {
    const count = messageLog.getCount(sessionId);
    messageLog.deleteBySession(sessionId);
    return count;
  }

  async function readMessages(
    sessionId: string,
    query: HostMessageReadQuery = {},
  ): Promise<HostMessagePage> {
    await requireSession(sessionId);
    const includeSuperseded = query.includeSuperseded ?? true;
    const sources = query.sources === undefined
      ? undefined
      : [...new Set(query.sources)].sort();
    const owner = JSON.stringify({
      sessionId,
      includeSuperseded,
      ...(sources === undefined ? {} : { sources }),
    });
    const offset = decodeOffset(query.cursor, 'messages', owner);
    const limit = pageSize(query.limit);
    const rows = messageLog.listBySession(sessionId, {
      includeSuperseded,
      ...(sources === undefined ? {} : { source: sources }),
    });
    const items: HostMessagePage['messages'][number][] = [];
    for (const row of rows) {
      try {
        const entry = JSON.parse(row.payload) as DurableTimelineEntry;
        if (entry.type !== 'message' && entry.type !== 'compaction') continue;
        items.push({
          id: row.id,
          sequence: row.seq,
          createdAt: row.createdAt,
          turnId: row.turnId,
          entry,
        });
      } catch {
        // Match the legacy IPC adapter: malformed rollout rows do not become messages.
      }
    }
    const page = items.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      sessionId,
      messages: page,
      nextCursor: nextOffset < items.length
        ? encodeCursor({ version: 1, resource: 'messages', owner, offset: nextOffset })
        : null,
    };
  }

  async function readTimeline(
    sessionId: string,
    query: HostTimelineReadQuery = {},
  ): Promise<HostTimelinePage> {
    await requireSession(sessionId);
    const offset = decodeOffset(query.cursor, 'timeline', sessionId);
    const limit = pageSize(query.limit);
    const rows = messageLog.timeline(sessionId);
    const pageRows = rows.slice(offset, offset + limit);
    const nextOffset = offset + pageRows.length;
    return {
      sessionId,
      entries: pageRows.map(({ entry, seq }) => ({
        id: entry.id,
        sequence: seq,
        createdAt: rolloutLineTimestamp(entry),
        entry,
      })),
      nextCursor: nextOffset < rows.length
        ? encodeCursor({ version: 1, resource: 'timeline', owner: sessionId, offset: nextOffset })
        : null,
    };
  }

  async function readProjectedTimeline(
    sessionId: string,
    query: HostTimelineReadQuery = {},
  ): Promise<HostTimelinePage> {
    const offset = decodeOffset(query.cursor, 'projected-timeline', sessionId);
    const limit = pageSize(query.limit);
    const items: HostTimelinePage['entries'][number][] = [];
    for (const row of messageLog.listBySession(sessionId)) {
      try {
        const entry = JSON.parse(row.payload) as DurableTimelineEntry;
        items.push({
          id: row.id,
          sequence: row.seq,
          createdAt: row.createdAt,
          entry,
        });
      } catch {
        // Match the legacy rewind path: corrupt rollout rows do not enter a rebase.
      }
    }
    const entries = items.slice(offset, offset + limit);
    const nextOffset = offset + entries.length;
    return {
      sessionId,
      entries,
      nextCursor: nextOffset < items.length
        ? encodeCursor({ version: 1, resource: 'projected-timeline', owner: sessionId, offset: nextOffset })
        : null,
    };
  }

  async function appendTimeline(
    sessionId: string,
    input: HostTimelineAppendInput,
  ): Promise<HostTimelineWriteReceipt> {
    await requireSession(sessionId);
    const events: NewEvent[] = input.entries.map((entry) => {
      const turnId = input.turnId !== undefined
        ? input.turnId
        : ('turnId' in entry ? entry.turnId : null);
      return {
        id: entry.id,
        sessionId,
        ...(turnId !== undefined ? { turnId } : {}),
        payload: entry,
        createdAt: rolloutLineTimestamp(entry),
      };
    });
    const before = messageLog.getCount(sessionId);
    messageLog.appendBatch(events);
    const count = messageLog.getCount(sessionId);
    return {
      sessionId,
      acceptedIds: input.entries.map((entry) => entry.id),
      writtenCount: count - before,
      lastSequence: messageLog.getLastSequence(sessionId),
      cursor: encodeCursor({ version: 1, resource: 'timeline', owner: sessionId, offset: count }),
    };
  }

  return {
    resolveSessionPermissionProfile,
    create,
    get,
    list,
    searchSessions,
    searchMessages,
    getSessionChangeStats,
    update,
    delete: deleteSession,
    archive: archiveSession,
    unarchive: unarchiveSession,
    forkAt,
    reconcileRollouts,
    countTimeline,
    deleteTimeline,
    readMessages,
    readProjectedTimeline,
    readTimeline,
    appendTimeline,
  };
}

function isSessionPermissionProfile(value: unknown): value is SessionPermissionProfile {
  return value === 'default' || value === 'auto' || value === 'full_access';
}

function searchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PAGE_SIZE) {
    throw new HostSessionApiError('invalid_page', `limit must be between 0 and ${MAX_PAGE_SIZE}`);
  }
  return value;
}

function searchMessageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MESSAGE_SEARCH_RESULTS) {
    throw new HostSessionApiError('invalid_page', `limit must be between 0 and ${MAX_MESSAGE_SEARCH_RESULTS}`);
  }
  return value;
}
