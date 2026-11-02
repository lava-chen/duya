import { randomUUID } from 'node:crypto';
import type {
  HostRunApiV1,
  HostSessionApiV1,
  SessionControlLease,
  SessionControlLeaseRequest,
  SessionInputActor,
  SessionInputReceipt,
  SessionInputRequest,
} from '@duya/agent-protocol';
import type { HostSessionPage } from '@duya/agent-protocol/session-api';
import type { HostLocalMailboxApiV1, HostMailboxItem } from '@duya/agent-protocol/mailbox';
import type { SessionServiceCaller } from './session-service.js';

const LEASE_EXTENSION_KEY = 'host.sessionControlLease';
const MAX_LEASE_TTL_MS = 10 * 60_000;
const MAX_INPUT_CHARS = 32_000;

export interface HostSessionInputServiceOptions {
  readonly sessions: Pick<HostSessionApiV1, 'get' | 'list' | 'update'>;
  readonly runs: Pick<HostRunApiV1, 'listAgentRunsBySession' | 'readAgentRunEvents'>;
  readonly mailbox: Pick<HostLocalMailboxApiV1, 'enqueue' | 'getByClientMsgId' | 'getItem'>;
  readonly validateCaller: (caller: SessionServiceCaller) => void | Promise<void>;
}

function actorFor(caller: SessionServiceCaller): SessionInputActor {
  // Worker IPC authenticates a live session/run/epoch. The Host therefore
  // records the worker session as the actor; no model-supplied actor is read.
  return { kind: 'bot', id: caller.sessionId };
}

function actorSource(actor: SessionInputActor): string {
  return `session_input:${actor.kind}:${actor.id ?? ''}`;
}

function sessionLineageRoot(
  sessionId: string,
  parentById: ReadonlyMap<string, string | null>,
): string {
  const seen = new Set<string>();
  let current = sessionId;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = parentById.get(current);
    if (!parent) return current;
    current = parent;
  }
  return current;
}

function decodeLease(value: unknown): SessionControlLease | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const holder = row.holder;
  if (typeof holder !== 'object' || holder === null || Array.isArray(holder)) return null;
  const holderRow = holder as Record<string, unknown>;
  if (
    typeof row.sessionId !== 'string' || typeof row.leaseId !== 'string' ||
    (holderRow.kind !== 'user' && holderRow.kind !== 'bot' && holderRow.kind !== 'plugin') ||
    typeof holderRow.id !== 'string' || !Number.isSafeInteger(row.revision) ||
    typeof row.requestId !== 'string' || typeof row.expiresAt !== 'number'
  ) return null;
  return {
    sessionId: row.sessionId,
    leaseId: row.leaseId,
    holder: { kind: holderRow.kind, id: holderRow.id },
    revision: row.revision as number,
    requestId: row.requestId,
    expiresAt: row.expiresAt,
  };
}

function receiptFromMailbox(item: HostMailboxItem, actor: SessionInputActor): SessionInputReceipt {
  const metadata = item.meta.sessionInput;
  const intent = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).intent
    : undefined;
  const stage = item.status === 'cancelled'
    ? 'rejected'
    : item.status === 'applied'
      ? 'consumed'
      : item.status === 'observed'
        ? 'delivered'
        : item.kind === 'queued' || intent === 'enqueue'
          ? 'queued'
          : 'persisted';
  const id = item.clientMsgId ?? item.id;
  return {
    inputId: item.id,
    requestId: id,
    sessionId: item.sessionId,
    actor,
    stage,
    ...(stage === 'rejected' ? { reason: item.cancelReason ?? 'cancelled' } : {}),
    ...((item.injectedRunId ?? item.observedByRunId) === null
      ? {}
      : { runId: item.injectedRunId ?? item.observedByRunId! }),
  };
}

function actorFromMailbox(item: HostMailboxItem, fallback: SessionInputActor): SessionInputActor {
  const metadata = item.meta.sessionInput;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return fallback;
  const actor = (metadata as Record<string, unknown>).actor;
  if (typeof actor !== 'object' || actor === null || Array.isArray(actor)) return fallback;
  const row = actor as Record<string, unknown>;
  if (row.kind !== 'user' && row.kind !== 'bot' && row.kind !== 'plugin' && row.kind !== 'channel' && row.kind !== 'system') {
    return fallback;
  }
  return { kind: row.kind, ...(typeof row.id === 'string' ? { id: row.id } : {}) };
}

function mailboxMatchesRequest(
  item: HostMailboxItem,
  request: SessionInputRequest,
  actor: SessionInputActor,
): boolean {
  const metadata = item.meta.sessionInput;
  const stored = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return item.content === request.content
    && item.source === actorSource(actor)
    && (request.intent === 'enqueue' ? item.kind === 'queued' : item.kind === 'followup' || item.kind === 'background_notification')
    && JSON.stringify(item.attachments ?? []) === JSON.stringify(request.attachments ?? [])
    && stored.intent === request.intent
    && JSON.stringify(stored.contextRefs ?? []) === JSON.stringify(request.contextRefs ?? [])
    // The Host binds omitted run/turn expectations when it accepts a steer.
    // A retry with the original client request must still match that durable
    // binding, so compare only expectations the client explicitly supplied.
    && (request.expectedRunId === undefined || stored.expectedRunId === request.expectedRunId)
    && (request.expectedTurnId === undefined || stored.expectedTurnId === request.expectedTurnId)
    && (request.controlRevision === undefined || stored.controlRevision === request.controlRevision);
}

export function createHostSessionInputService(options: HostSessionInputServiceOptions) {
  async function requireCurrent(caller: SessionServiceCaller): Promise<void> {
    await options.validateCaller(caller);
  }

  async function canAccessSession(targetSessionId: string, caller: SessionServiceCaller): Promise<boolean> {
    await requireCurrent(caller);
    const [callerSession, targetSession] = await Promise.all([
      options.sessions.get(caller.sessionId, { includeAllSessions: true }),
      options.sessions.get(targetSessionId, { includeAllSessions: true }),
    ]);
    if (!callerSession || !targetSession || targetSession.status === 'deleted') return false;
    if (callerSession.id === targetSession.id) return true;
    if (
      callerSession.workspace.state === 'bound' && targetSession.workspace.state === 'bound' &&
      callerSession.workspace.workspaceId === targetSession.workspace.workspaceId
    ) return true;

    // Legacy sessions may not have Workspace IDs. Permit the existing
    // parent/child session family while keeping unrelated transcripts private.
    const parentById = new Map<string, string | null>([
      [callerSession.id, callerSession.parentSessionId],
      [targetSession.id, targetSession.parentSessionId],
    ]);
    let cursor = callerSession.parentSessionId;
    for (let depth = 0; cursor && depth < 32; depth += 1) {
      if (!parentById.has(cursor)) {
        const parent = await options.sessions.get(cursor, { includeAllSessions: true });
        parentById.set(cursor, parent?.parentSessionId ?? null);
      }
      cursor = parentById.get(cursor) ?? null;
    }
    cursor = targetSession.parentSessionId;
    for (let depth = 0; cursor && depth < 32; depth += 1) {
      if (!parentById.has(cursor)) {
        const parent = await options.sessions.get(cursor, { includeAllSessions: true });
        parentById.set(cursor, parent?.parentSessionId ?? null);
      }
      cursor = parentById.get(cursor) ?? null;
    }
    return sessionLineageRoot(callerSession.id, parentById) === sessionLineageRoot(targetSession.id, parentById);
  }

  async function listAccessibleSessions(request: {
    readonly scope: 'children' | 'workspace';
    readonly includeArchived: boolean;
    readonly cursor?: string;
    readonly limit: number;
  }, caller: SessionServiceCaller): Promise<HostSessionPage> {
    await requireCurrent(caller);
    const callerSession = await options.sessions.get(caller.sessionId, { includeAllSessions: true });
    if (!callerSession || callerSession.status === 'deleted') {
      throw new Error('caller_session_unavailable');
    }
    const limit = Math.max(1, Math.min(50, Math.floor(request.limit)));
    const page = {
      includeAllSessions: true,
      includeArchived: request.includeArchived,
      limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    };
    if (request.scope === 'children') {
      return options.sessions.list({ ...page, parentSessionId: caller.sessionId });
    }
    if (request.scope !== 'workspace') throw new Error('invalid_session_list_scope');
    if (callerSession.workspace.state !== 'bound') {
      throw new Error('session_workspace_unavailable');
    }
    return options.sessions.list({ ...page, workspaceId: callerSession.workspace.workspaceId });
  }

  async function currentTurnId(runId: string): Promise<string | undefined> {
    let afterSeq = 0;
    let latest: string | undefined;
    for (;;) {
      const page = await options.runs.readAgentRunEvents(runId, { afterSeq, limit: 500 });
      for (const event of page) {
        if (event.payload.type === 'turn.started') latest = event.payload.turnId;
      }
      if (page.length < 500) return latest;
      const next = page[page.length - 1]?.seq ?? afterSeq;
      if (next <= afterSeq) return latest;
      afterSeq = next;
    }
  }

  async function currentRun(sessionId: string) {
    const runs = await options.runs.listAgentRunsBySession(sessionId, 20);
    return runs.find((run) => run.status === 'running') ?? null;
  }

  async function controlSnapshot(sessionId: string) {
    const session = await options.sessions.get(sessionId, { includeAllSessions: true });
    const storedLease = decodeLease(session?.extensions[LEASE_EXTENSION_KEY]);
    const activeLease = storedLease && storedLease.expiresAt > Date.now() ? storedLease : null;
    return {
      activeLease,
      revision: storedLease?.revision ?? 0,
    };
  }

  async function rejected(request: SessionInputRequest, actor: SessionInputActor, reason: string): Promise<SessionInputReceipt> {
    return {
      inputId: randomUUID(),
      requestId: request.requestId,
      sessionId: request.sessionId,
      actor,
      stage: 'rejected',
      reason,
    };
  }

  async function submitInput(request: SessionInputRequest, caller: SessionServiceCaller): Promise<SessionInputReceipt> {
    const actor = actorFor(caller);
    await requireCurrent(caller);
    if (!request.requestId.trim() || request.requestId.length > 200) return rejected(request, actor, 'invalid_request_id');
    if (!request.content.trim() || request.content.length > MAX_INPUT_CHARS) return rejected(request, actor, 'invalid_content');
    if (request.intent === 'interrupt') return rejected(request, actor, 'interrupt_intent_unavailable');
    if (request.intent !== 'steer' && request.intent !== 'enqueue') return rejected(request, actor, 'invalid_intent');
    if (!await canAccessSession(request.sessionId, caller)) return rejected(request, actor, 'session_not_accessible');

    const existing = await options.mailbox.getByClientMsgId(request.sessionId, request.requestId);
    if (existing) {
      return mailboxMatchesRequest(existing, request, actor)
        ? receiptFromMailbox(existing, actor)
        : rejected(request, actor, 'request_id_conflict');
    }

    const activeRun = await currentRun(request.sessionId);
    if (request.expectedRunId !== undefined && activeRun?.runId !== request.expectedRunId) {
      return rejected(request, actor, 'expected_run_mismatch');
    }
    if (request.expectedTurnId !== undefined) {
      if (!activeRun) return rejected(request, actor, 'expected_turn_mismatch');
      const turnId = await currentTurnId(activeRun.runId);
      if (turnId !== request.expectedTurnId) return rejected(request, actor, 'expected_turn_mismatch');
    }

    const { activeLease, revision: observedControlRevision } = await controlSnapshot(request.sessionId);
    if (activeLease) {
      if (activeLease.holder.kind !== actor.kind || activeLease.holder.id !== (actor.id ?? '')) {
        return rejected(request, actor, 'control_lease_held_by_another_actor');
      }
      if (request.controlRevision !== activeLease.revision) {
        return rejected(request, actor, 'control_revision_mismatch');
      }
    } else if (request.controlRevision !== undefined) {
      return rejected(request, actor, 'control_lease_not_active');
    }

    // A steer submitted during a Run is for that Run. This Host-side binding
    // closes the gap where a delayed mailbox item could otherwise land in the
    // next Run because the client omitted expectedRunId.
    const expectedRunId = request.expectedRunId ?? (request.intent === 'steer' ? activeRun?.runId : undefined);
    const expectedTurnId = request.expectedTurnId ?? (
      request.intent === 'steer' && activeRun ? await currentTurnId(activeRun.runId) : undefined
    );

    let item: HostMailboxItem;
    try {
      item = await options.mailbox.enqueue({
        id: randomUUID(),
        sessionId: request.sessionId,
        submittedRunId: caller.runId,
        content: request.content,
        kind: request.intent === 'enqueue' ? 'queued' : 'followup',
        ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
        clientMsgId: request.requestId,
        source: actorSource(actor),
        meta: {
          sessionInput: {
            requestId: request.requestId,
            actor,
            intent: request.intent,
            ...(request.contextRefs === undefined ? {} : { contextRefs: request.contextRefs }),
            ...(expectedRunId === undefined ? {} : { expectedRunId }),
            ...(expectedTurnId === undefined ? {} : { expectedTurnId }),
            controlRevision: observedControlRevision,
            controlLeaseId: activeLease?.leaseId ?? null,
          },
        },
      });
    } catch {
      // The mailbox's unique (session_id, client_msg_id) index arbitrates
      // concurrent retries. Re-read its winning row instead of creating a
      // second receipt ledger or surfacing a false transport failure.
      const raced = await options.mailbox.getByClientMsgId(request.sessionId, request.requestId);
      if (!raced) throw new Error('session_input_persist_failed');
      return mailboxMatchesRequest(raced, request, actor)
        ? receiptFromMailbox(raced, actor)
        : rejected(request, actor, 'request_id_conflict');
    }
    const persistedMatches = mailboxMatchesRequest(item, request, actor);
    return persistedMatches
      ? receiptFromMailbox(item, actor)
      : rejected(request, actor, 'request_id_conflict');
  }

  async function readInputReceipt(sessionId: string, requestId: string, caller: SessionServiceCaller): Promise<SessionInputReceipt | null> {
    await requireCurrent(caller);
    if (!await canAccessSession(sessionId, caller)) return null;
    const item = await options.mailbox.getByClientMsgId(sessionId, requestId);
    if (!item || item.source.startsWith('session_input:') === false) return null;
    return receiptFromMailbox(item, actorFromMailbox(item, actorFor(caller)));
  }

  async function validateInputDelivery(input: {
    readonly inputId: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly turnId: string | null;
  }, caller: SessionServiceCaller): Promise<string | null> {
    await requireCurrent(caller);
    if (caller.sessionId !== input.sessionId || caller.runId !== input.runId) return 'caller_attempt_not_target_run';
    const item = await options.mailbox.getItem(input.inputId);
    if (!item || item.sessionId !== input.sessionId || !item.source.startsWith('session_input:')) return 'input_not_found';
    const metadata = item.meta.sessionInput;
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return 'input_metadata_invalid';
    const stored = metadata as Record<string, unknown>;
    if (typeof stored.requestId !== 'string' || (stored.intent !== 'steer' && stored.intent !== 'enqueue')) {
      return 'input_metadata_invalid';
    }
    if (typeof stored.expectedRunId === 'string' && stored.expectedRunId !== input.runId) return 'expected_run_mismatch';
    if (typeof stored.expectedTurnId === 'string' && stored.expectedTurnId !== input.turnId) return 'expected_turn_mismatch';
    if (!Number.isSafeInteger(stored.controlRevision) ||
        !(stored.controlLeaseId === null || typeof stored.controlLeaseId === 'string')) {
      return 'control_snapshot_missing';
    }
    const { activeLease, revision } = await controlSnapshot(input.sessionId);
    const currentLeaseId = activeLease?.leaseId ?? null;
    if (stored.controlRevision !== revision || stored.controlLeaseId !== currentLeaseId) {
      return 'control_lease_changed';
    }
    return null;
  }

  async function readControlLease(sessionId: string, caller: SessionServiceCaller): Promise<SessionControlLease | null> {
    await requireCurrent(caller);
    if (!await canAccessSession(sessionId, caller)) return null;
    const session = await options.sessions.get(sessionId, { includeAllSessions: true });
    const lease = decodeLease(session?.extensions[LEASE_EXTENSION_KEY]);
    return lease && lease.expiresAt > Date.now() ? lease : null;
  }

  async function acquireControlLease(request: SessionControlLeaseRequest, caller: SessionServiceCaller): Promise<SessionControlLease | null> {
    await requireCurrent(caller);
    if (!request.requestId.trim() || request.requestId.length > 200 ||
        !Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1) return null;
    if (!await canAccessSession(request.sessionId, caller)) return null;
    const actor = actorFor(caller);
    const ttlMs = Math.max(1_000, Math.min(MAX_LEASE_TTL_MS, Math.floor(request.ttlMs)));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const session = await options.sessions.get(request.sessionId, { includeAllSessions: true });
      if (!session) return null;
      const previous = decodeLease(session.extensions[LEASE_EXTENSION_KEY]);
      const now = Date.now();
      if (previous?.requestId === request.requestId) {
        return previous.holder.kind === actor.kind && previous.holder.id === (actor.id ?? '')
          ? previous
          : null;
      }
      if (previous && previous.expiresAt > now) {
        if (previous.holder.id !== (actor.id ?? '') || previous.holder.kind !== actor.kind) return null;
        if (request.expectedRevision !== previous.revision) return null;
      } else if (request.expectedRevision !== undefined && request.expectedRevision !== (previous?.revision ?? 0)) {
        return null;
      }
      const lease: SessionControlLease = {
        sessionId: request.sessionId,
        leaseId: randomUUID(),
        holder: { kind: actor.kind as 'bot', id: actor.id ?? caller.sessionId },
        revision: (previous?.revision ?? 0) + 1,
        requestId: request.requestId,
        expiresAt: now + ttlMs,
      };
      const updated = await options.sessions.update(session.id, session.updatedAt, {
        extensions: { [LEASE_EXTENSION_KEY]: { ...lease, holder: { ...lease.holder } } },
      });
      if (updated.updated) return lease;
      if (updated.reason === 'not_found') return null;
    }
    return null;
  }

  async function releaseControlLease(sessionId: string, revision: number, caller: SessionServiceCaller): Promise<boolean> {
    await requireCurrent(caller);
    if (!Number.isSafeInteger(revision) || revision < 1) return false;
    if (!await canAccessSession(sessionId, caller)) return false;
    const actor = actorFor(caller);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const session = await options.sessions.get(sessionId, { includeAllSessions: true });
      if (!session) return false;
      const lease = decodeLease(session.extensions[LEASE_EXTENSION_KEY]);
      if (!lease || lease.revision !== revision || lease.holder.id !== actor.id || lease.holder.kind !== actor.kind) return false;
      const updated = await options.sessions.update(sessionId, session.updatedAt, {
        extensions: { [LEASE_EXTENSION_KEY]: { ...lease, expiresAt: Date.now() } },
      });
      if (updated.updated) return true;
      if (updated.reason === 'not_found') return false;
    }
    return false;
  }

  return {
    canAccessSession,
    listAccessibleSessions,
    submitInput,
    readInputReceipt,
    validateInputDelivery,
    acquireControlLease,
    releaseControlLease,
    readControlLease,
  };
}
