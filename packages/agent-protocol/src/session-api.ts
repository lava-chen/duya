/**
 * Transport-neutral Session and message-timeline API for Duya Host.
 *
 * Request/response values are JSON-safe DTOs. HostSessionApiV1 is the typed
 * service port implemented by the Host and proxied by HTTP/SSE, WebSocket, or
 * Desktop IPC adapters; clients never receive a database handle or filesystem
 * path.
 */

import type { DurableTimelineEntry } from './rollout-events.js';
import type {
  AgentProfileId,
  JsonObject,
  Millis,
  ProviderId,
  SessionId,
  WorkspaceId,
} from './primitives.js';

export type HostApiVersion = 1;

/** Persisted session permission profile, distinct from the per-run policy mode. */
export type SessionPermissionProfile = 'default' | 'auto' | 'full_access';

/** A workspace reference never exposes the Host's resolved filesystem path. */
export type HostWorkspaceBinding =
  | {
      readonly state: 'bound';
      readonly workspaceId: WorkspaceId;
      readonly rootId: string | null;
      readonly relativePath: string;
    }
  | { readonly state: 'legacy_unbound' };

/** Local-only capability for a user-selected directory; never expose remotely. */
export interface HostWorkspaceRegistrationApiV1 {
  registerLocalDirectory(
    directory: string,
  ): Promise<Extract<HostWorkspaceBinding, { readonly state: 'bound' }>>;
}

/** Local-only import metadata; workingDirectory is never accepted by remote APIs. */
export interface HostLocalSessionImportInput {
  readonly sessionId: SessionId;
  readonly title: string;
  readonly workingDirectory: string;
  readonly projectName: string;
}

export interface HostLocalSessionImportResult {
  readonly sessionId: SessionId;
}

export interface HostLocalSessionRollbackResult {
  readonly deletedSessionIds: readonly SessionId[];
  readonly failedSessionIds: readonly SessionId[];
}

/** Local-only compatibility operations for importing external transcripts. */
export interface HostLocalSessionImportApiV1 {
  createImportedSession(input: HostLocalSessionImportInput): Promise<HostLocalSessionImportResult>;
  rollbackImportedSessions(sessionIds: readonly SessionId[]): Promise<HostLocalSessionRollbackResult>;
}

/** Local Host policy inputs used while creating or importing a session. */
export interface HostSessionPermissionProfileInput {
  readonly explicit?: string | null;
  readonly parentSessionId?: SessionId | null;
  /** Only trusted local worker flows may override a parent's profile. */
  readonly trustedOverride?: boolean;
}

/** Legacy-compatible parsed-document projection; available only on local Host APIs. */
export interface HostLocalParsedDocument {
  readonly id: string;
  readonly message_id: string;
  readonly session_id: SessionId;
  readonly filename: string;
  readonly filePath: string;
  readonly charCount: number;
  readonly extractMethod: string | null;
  readonly text: string;
  readonly imageChunks: string | null;
  readonly created_at: Millis;
}

export interface HostLocalParsedDocumentInput {
  readonly messageId: string;
  readonly sessionId: SessionId;
  readonly filename: string;
  readonly filePath: string;
  readonly charCount: number;
  readonly text: string;
  readonly extractMethod?: string;
  readonly imageChunks?: readonly { readonly base64: string; readonly mediaType: string }[];
}

/** Read-only image payload needed to restore provider CDN images in worker history. */
export interface HostLocalImageAttachment {
  readonly id: string;
  readonly message_id: string;
  readonly session_id: SessionId;
  readonly attachment_type: 'image';
  readonly mime_type: string | null;
  readonly data: string;
  readonly original_url: string | null;
  readonly created_at: Millis;
}

/** Local-only compatibility surface for parsed documents and local file paths. */
export interface HostLocalAttachmentApiV1 {
  storeParsedDocument(input: HostLocalParsedDocumentInput): Promise<{ readonly success: boolean }>;
  getParsedDocumentsForSession(sessionId: SessionId): Promise<readonly HostLocalParsedDocument[]>;
  getParsedDocumentsForMessage(messageId: string): Promise<readonly HostLocalParsedDocument[]>;
  getImageAttachmentsForSession(sessionId: SessionId): Promise<readonly HostLocalImageAttachment[]>;
}

/** Local-only access to settings; values may contain credentials. */
export interface HostLocalSettingsApiV1 {
  getSetting(key: string): Promise<string | null>;
  getSettings(): Promise<Readonly<Record<string, string>>>;
  setSetting(key: string, value: string): Promise<void>;
}

/** Client-safe session identity and display metadata. */
export interface HostSessionRecord {
  readonly id: SessionId;
  readonly workspace: HostWorkspaceBinding;
  readonly title: string;
  readonly projectName: string;
  readonly status: string;
  readonly model: string;
  readonly providerId: ProviderId;
  readonly mode: string;
  /** Persisted session profile, not the Run API's permission policy mode. */
  readonly permissionMode: SessionPermissionProfile;
  readonly agentProfileId: AgentProfileId | null;
  readonly parentSessionId: SessionId | null;
  readonly agentType: string;
  readonly agentName: string;
  readonly draft: string | null;
  readonly extensions: JsonObject;
  readonly createdAt: Millis;
  readonly updatedAt: Millis;
  readonly recencyAt: Millis | null;
  readonly lastTurnStartedAt: Millis | null;
}

/** Workspace selection is an ID; clients do not choose or persist raw paths. */
export interface HostSessionCreateInput {
  /** Preserve a caller-owned identity when importing or upserting a session. */
  readonly id?: SessionId;
  /** Omit only for an imported/recovered legacy session without a workspace. */
  readonly workspaceId?: WorkspaceId;
  /** Select a particular granted root; omitted uses the workspace default root. */
  readonly workspaceRootId?: string | null;
  /** CWD relative to the selected root. Raw filesystem paths never cross the API. */
  readonly workspaceRelativePath?: string;
  readonly title?: string;
  readonly projectName?: string;
  readonly status?: string;
  readonly model?: string;
  readonly providerId?: ProviderId;
  readonly mode?: string;
  readonly permissionMode?: SessionPermissionProfile;
  readonly agentProfileId?: AgentProfileId | null;
  readonly parentSessionId?: SessionId | null;
  /** Optional lineage details for a child session created by a parent run. */
  readonly spawn?: {
    readonly type?: string;
    readonly reason?: string;
    readonly turnId?: string;
  };
  readonly agentType?: string;
  readonly agentName?: string;
  readonly draft?: string | null;
  readonly extensions?: JsonObject;
  readonly createdAt?: Millis;
}

export interface HostSessionPatch {
  readonly title?: string;
  readonly projectName?: string;
  readonly status?: string;
  readonly model?: string;
  readonly providerId?: ProviderId;
  readonly mode?: string;
  readonly permissionMode?: SessionPermissionProfile;
  /** Change the session's workspace using an opaque Host-owned reference. */
  readonly workspace?: HostWorkspaceBinding;
  readonly agentProfileId?: AgentProfileId | null;
  readonly parentSessionId?: SessionId | null;
  readonly agentType?: string;
  readonly agentName?: string;
  readonly draft?: string | null;
  /** Merge these keys into the Host-owned extension object. */
  readonly extensions?: JsonObject;
}

export interface HostSessionListQuery {
  readonly workspaceId?: WorkspaceId;
  readonly workspaceRootId?: string | null;
  readonly workspaceRelativePath?: string;
  /** Filter to direct children of this session. */
  readonly parentSessionId?: SessionId;
  readonly limit?: number;
  /** Opaque, Host-minted pagination cursor. */
  readonly cursor?: string;
  /** Compatibility pagination for clients that already expose limit/offset. */
  readonly offset?: number;
  /** Include archived sessions in addition to active sessions. */
  readonly includeArchived?: boolean;
  /** Include child and internal sessions; defaults to user-facing root sessions. */
  readonly includeAllSessions?: boolean;
  /** Include soft-deleted rows for recovery and administrative views. */
  readonly includeDeleted?: boolean;
}

export interface HostSessionListItem {
  readonly session: HostSessionRecord;
  readonly timelineCount: number;
}

/** Local compatibility projection used by cron-run history. */
export interface HostLocalSessionSummary {
  readonly id: SessionId;
  readonly title: string;
  readonly createdAt: Millis;
  readonly updatedAt: Millis;
  readonly model: string;
  readonly messageCount: number;
}

export interface HostLocalSessionSummaryQuery {
  readonly idPrefix: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** Search options applied by the Host over session metadata and rollout text. */
export interface HostSessionSearchQuery {
  readonly limit?: number;
  /** Search rollout content in addition to session metadata; defaults to true. */
  readonly includeContent?: boolean;
}

/** A session match, optionally carrying the first matching rollout snippet. */
export interface HostSessionSearchResult {
  readonly session: HostSessionRecord;
  readonly snippet: string;
  readonly messageId: string | null;
  readonly sequence: number | null;
}

/** Aggregated diff statistics shown on a session card. */
export interface HostSessionChangeStats {
  readonly filesChanged: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

/** A rollout message match with its Host-resolved session metadata. */
export interface HostMessageSearchResult {
  readonly session: HostSessionRecord;
  readonly messageId: string;
  readonly sequence: number;
  readonly snippet: string;
}

/** Optional bounds for a rollout text search. */
export interface HostMessageSearchQuery {
  readonly limit?: number;
  /** Restrict matching to these Host-owned sessions. */
  readonly sessionIds?: readonly SessionId[];
}

export interface HostSessionPage {
  readonly sessions: readonly HostSessionListItem[];
  readonly nextCursor: string | null;
}

export interface HostTimelineItem {
  readonly id: string;
  readonly sequence: number;
  readonly createdAt: Millis;
  readonly entry: DurableTimelineEntry;
}

export interface HostTimelinePage {
  readonly sessionId: SessionId;
  readonly entries: readonly HostTimelineItem[];
  readonly nextCursor: string | null;
}

export interface HostTimelineReadQuery {
  /** Opaque cursor returned by a previous read. */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface HostMessageItem {
  readonly id: string;
  readonly sequence: number;
  readonly createdAt: Millis;
  readonly turnId: string | null;
  readonly entry: DurableTimelineEntry;
}

export interface HostMessagePage {
  readonly sessionId: SessionId;
  readonly messages: readonly HostMessageItem[];
  readonly nextCursor: string | null;
}

export interface HostMessageReadQuery {
  readonly cursor?: string;
  readonly limit?: number;
  /** Keep the current chat-history view, including rows superseded by rebases. */
  readonly includeSuperseded?: boolean;
  /** Optional message-source projection applied by the Host before paging. */
  readonly sources?: readonly string[];
}

export interface HostTimelineAppendInput {
  /** Entry IDs are stable and make retries idempotent at the data layer. */
  readonly entries: readonly DurableTimelineEntry[];
  /** Optional turn index applied to every entry in this append batch. */
  readonly turnId?: string | null;
}

export interface HostTimelineWriteReceipt {
  readonly sessionId: SessionId;
  readonly acceptedIds: readonly string[];
  /** Indexed entries actually inserted by this batch; duplicate IDs are excluded. */
  readonly writtenCount: number;
  readonly lastSequence: number | null;
  readonly cursor: string | null;
}

export type HostSessionUpdateResult =
  | { readonly updated: true; readonly session: HostSessionRecord }
  | { readonly updated: false; readonly reason: 'not_found' | 'conflict' };

export type HostSessionDeleteResult =
  | { readonly deleted: true }
  | { readonly deleted: false; readonly reason: 'not_found' | 'conflict' };

export type HostSessionArchiveResult =
  | { readonly ok: true; readonly archivedSessionIds: string[] }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'session_busy' | 'io';
      readonly sessionId: SessionId;
      readonly blockedId?: SessionId;
      readonly origin?: string | null;
      readonly failedId?: SessionId;
    };

export interface HostSessionForkInput {
  /** Caller-minted destination identity, used to namespace copied message IDs. */
  readonly newSessionId: SessionId;
  readonly throughMessageId: string;
  readonly title?: string;
}

export type HostSessionForkResult =
  | { readonly ok: true; readonly sessionId: SessionId; readonly seedCount: number }
  | {
      readonly ok: false;
      readonly reason: 'source_not_found' | 'message_not_found' | 'source_archived';
      readonly seedCount: 0;
    };

/** Whole-store rollout index rebuild outcome. Paths are Host-local diagnostics. */
export interface HostRolloutReconcileResult {
  sessionsScanned: number;
  rowsAdded: number;
  missingFiles: string[];
  orphanFiles: string[];
}

/** Client-local file import; this type is served only by the authenticated local API. */
export type HostLocalRolloutImportInput =
  | {
      readonly mode: 'restore';
      readonly sourcePath: string;
      readonly title?: string;
    }
  | {
      readonly mode: 'continue';
      readonly sourcePath: string;
      readonly targetSessionId: SessionId;
    };

export interface HostRolloutImportResult {
  readonly sessionId: SessionId;
  readonly linesImported: number;
  readonly linesSkipped: number;
  readonly remapped: boolean;
}

export interface HostRolloutExportResult {
  readonly absolutePath: string;
  readonly lines: number;
  readonly bytes: number;
}

/**
 * Async service boundary for session metadata and durable message history.
 * A transport adapter must preserve ordering and stable-entry-ID idempotency
 * for append retries.
 */
export interface HostSessionApiV1 {
  resolveSessionPermissionProfile(
    input: HostSessionPermissionProfileInput,
  ): Promise<SessionPermissionProfile>;
  create(input: HostSessionCreateInput): Promise<HostSessionRecord>;
  get(
    sessionId: SessionId,
    options?: { readonly includeAllSessions?: boolean },
  ): Promise<HostSessionRecord | null>;
  list(query?: HostSessionListQuery): Promise<HostSessionPage>;
  /** Search session metadata and, optionally, rollout content. */
  searchSessions(
    query: string,
    options?: HostSessionSearchQuery,
  ): Promise<HostSessionSearchResult[]>;
  /** Search rollout content while retaining one result per matching message. */
  searchMessages(
    query: string,
    options?: number | HostMessageSearchQuery,
  ): Promise<HostMessageSearchResult[]>;
  /** Read the persisted code-change summary for a session. */
  getSessionChangeStats(sessionId: SessionId): Promise<HostSessionChangeStats>;
  update(
    sessionId: SessionId,
    expectedUpdatedAt: Millis | undefined,
    patch: HostSessionPatch,
  ): Promise<HostSessionUpdateResult>;
  /** Soft delete: the Host retains the row for recovery and audit. */
  delete(sessionId: SessionId, expectedUpdatedAt?: Millis): Promise<HostSessionDeleteResult>;
  /** Archive a session and its descendants after checking every runtime lock. */
  archive(sessionId: SessionId): Promise<HostSessionArchiveResult>;
  /** Restore one archived session; descendants are deliberately left archived. */
  unarchive(sessionId: SessionId): Promise<boolean>;
  /** Fork the repaired, projected source history through one message. */
  forkAt(sourceSessionId: SessionId, input: HostSessionForkInput): Promise<HostSessionForkResult>;
  /** Rebuild the message index from Host-owned rollout files. */
  reconcileRollouts(): Promise<HostRolloutReconcileResult>;
  /** Count indexed timeline entries; returns zero for an empty or unknown session. */
  countTimeline(sessionId: SessionId): Promise<number>;
  /** Read the message/compaction projection used by chat history views. */
  readMessages(sessionId: SessionId, query?: HostMessageReadQuery): Promise<HostMessagePage>;
  /** Read the repaired, rebased projection including process events for rewind operations. */
  readProjectedTimeline(sessionId: SessionId, query?: HostTimelineReadQuery): Promise<HostTimelinePage>;
  readTimeline(sessionId: SessionId, query?: HostTimelineReadQuery): Promise<HostTimelinePage>;
  appendTimeline(sessionId: SessionId, input: HostTimelineAppendInput): Promise<HostTimelineWriteReceipt>;
  /** Remove the searchable timeline index for a session while retaining rollout files. */
  deleteTimeline(sessionId: SessionId): Promise<number>;
}
