import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AgentRunRecord,
  HostRunApiV1,
  HostRunExecutionApiV1,
  RunEventEnvelope,
  StartAgentRunInput,
  StartAgentRunResult,
} from '@duya/agent-protocol';
import type {
  HostSessionApiV1,
  HostSessionCreateInput,
  HostSessionRecord,
} from '@duya/agent-protocol/session-api';
import type { CoreSession } from '@duya/data/session-store';

const SPAWN_METADATA_KEY = 'host.sessionSpawn';
const SESSION_ACTIONS = new Set([
  'session:spawn',
  'session:spawnList',
  'session:spawnGet',
  'session:spawnReply',
  'session:spawnCancel',
  'session:spawnRename',
]);

export interface SessionServiceCaller {
  readonly sessionId: string;
  readonly runId: string;
  readonly epoch: number;
}

export interface HostSessionServiceOptions {
  readonly checkoutService?: import('./workspace/session-checkout-service.js').SessionCheckoutService;
  readonly sessions: Pick<HostSessionApiV1,
    'get' | 'create' | 'list' | 'update' | 'getSessionChangeStats'>;
  readonly runs: Pick<HostRunApiV1, 'getAgentRun' | 'listAgentRunsBySession' | 'readAgentRunEvents'>;
  readonly execution: Pick<HostRunExecutionApiV1, 'cancelAgentRun'> & {
    readonly startAgentRun: (input: StartAgentRunInput, caller: SessionServiceCaller) => Promise<StartAgentRunResult>;
  };
  readonly readLocalSession: (sessionId: string) => Promise<CoreSession | null>;
  readonly validateCaller: (caller: SessionServiceCaller) => void;
}

interface SpawnMetadata {
  readonly runId?: string;
  readonly status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly failureReason?: string;
  readonly operationId?: string;
}

interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly working_directory: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly runId?: string;
  readonly runStatus?: AgentRunRecord['status'];
}

function requireString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readSpawnMetadata(session: HostSessionRecord): SpawnMetadata | null {
  const value = session.extensions[SPAWN_METADATA_KEY];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== 'starting' && status !== 'running' && status !== 'completed'
    && status !== 'failed' && status !== 'cancelled') return null;
  return {
    status,
    ...(typeof record.runId === 'string' ? { runId: record.runId } : {}),
    ...(typeof record.failureReason === 'string' ? { failureReason: record.failureReason } : {}),
    ...(typeof record.operationId === 'string' ? { operationId: record.operationId } : {}),
  };
}

function sameCanonicalDirectory(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function boundWorkspace(session: HostSessionRecord): Extract<HostSessionRecord['workspace'], { state: 'bound' }> | null {
  return session.workspace.state === 'bound' ? session.workspace : null;
}

function runOutput(events: readonly RunEventEnvelope[]): string {
  return events
    .filter((event) => event.payload.type === 'assistant.text_block')
    .map((event) => event.payload.type === 'assistant.text_block' ? event.payload.text : '')
    .join('');
}

async function withChildLaunchLock<T>(
  queues: Map<string, Promise<void>>,
  childSessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(childSessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queues.set(childSessionId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(childSessionId) === current) queues.delete(childSessionId);
  }
}

async function readAllRunEvents(
  runs: HostSessionServiceOptions['runs'],
  runId: string,
): Promise<RunEventEnvelope[]> {
  const all: RunEventEnvelope[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await runs.readAgentRunEvents(runId, { afterSeq, limit: 500 });
    if (page.length === 0) break;
    all.push(...page);
    const nextAfterSeq = page[page.length - 1]?.seq ?? afterSeq;
    if (nextAfterSeq <= afterSeq) break;
    afterSeq = nextAfterSeq;
    if (page.length < 500) break;
  }
  return all;
}

export function createHostSessionService(options: HostSessionServiceOptions) {
  const childLaunchQueues = new Map<string, Promise<void>>();

  function callerIsCurrent(caller: SessionServiceCaller): boolean {
    try {
      options.validateCaller(caller);
      return true;
    } catch {
      return false;
    }
  }

  function requireCurrentCaller(caller: SessionServiceCaller): void {
    if (!callerIsCurrent(caller)) throw new Error('caller_attempt_not_current');
  }

  async function markCreatedChildFailed(sessionId: string, failureReason: string): Promise<boolean> {
    try {
      const update = await options.sessions.update(sessionId, undefined, {
        status: 'error',
        extensions: {
          [SPAWN_METADATA_KEY]: { status: 'failed', failureReason },
        },
      });
      return update.updated;
    } catch {
      return false;
    }
  }

  async function parentFor(caller: SessionServiceCaller): Promise<{
    readonly record: HostSessionRecord;
    readonly local: CoreSession;
    readonly workingDirectory: string;
  } | null> {
    const record = await options.sessions.get(caller.sessionId, { includeAllSessions: true });
    requireCurrentCaller(caller);
    if (!record || !boundWorkspace(record)) return null;
    const local = await options.readLocalSession(caller.sessionId);
    requireCurrentCaller(caller);
    if (!local?.workingDirectory) return null;
    let workingDirectory: string;
    try {
      workingDirectory = await realpath(local.workingDirectory);
    } catch {
      return null;
    }
    requireCurrentCaller(caller);
    return { record, local, workingDirectory };
  }

  async function ownedChild(sessionId: string, caller: SessionServiceCaller): Promise<HostSessionRecord | null> {
    const child = await options.sessions.get(sessionId, { includeAllSessions: true });
    requireCurrentCaller(caller);
    return child?.parentSessionId === caller.sessionId ? child : null;
  }

  async function startRun(
    session: HostSessionRecord,
    workingDirectory: string,
    prompt: string,
    caller: SessionServiceCaller,
    model?: string,
  ): Promise<{ readonly runId: string; readonly operationId: string } | { readonly reason: string }> {
    try {
      options.validateCaller(caller);
    } catch {
      return { reason: 'caller_attempt_not_current' };
    }
    let started: Awaited<ReturnType<HostRunExecutionApiV1['startAgentRun']>>;
    try {
      started = await options.execution.startAgentRun({
        sessionId: session.id,
        prompt,
        workingDirectory,
        model: model ?? session.model,
        providerId: session.providerId,
        origin: 'agent',
      }, caller);
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
    if (!started.accepted) return { reason: `${started.stage}: ${started.reason}` };
    const runId = started.runId as string;
    if (!callerIsCurrent(caller)) {
      try {
        await options.execution.cancelAgentRun(runId, 'caller attempt expired while starting child run');
      } catch {
        // The run identity is not persisted until the current caller is rechecked.
      }
      return { reason: 'caller_attempt_not_current' };
    }
    const identityFailure = 'run_started_but_child_run_identity_was_not_persisted';
    const compensateUntrackedRun = async (): Promise<string> => {
      let cancellationFailed = false;
      try {
        const cancellation = await options.execution.cancelAgentRun(runId, identityFailure);
        cancellationFailed = !cancellation.requested;
      } catch {
        cancellationFailed = true;
      }
      const failureReceiptWritten = await markCreatedChildFailed(session.id, identityFailure);
      return [
        identityFailure,
        ...(cancellationFailed ? ['run_cancel_failed'] : []),
        ...(!failureReceiptWritten ? ['failed_receipt_write_failed'] : []),
      ].join('; ');
    };
    let update: Awaited<ReturnType<HostSessionServiceOptions['sessions']['update']>>;
    try {
      update = await options.sessions.update(session.id, undefined, {
        extensions: {
          [SPAWN_METADATA_KEY]: {
            runId,
            status: 'running',
            operationId: runId,
          },
        },
      });
    } catch {
      return { reason: await compensateUntrackedRun() };
    }
    if (!update.updated) {
      return { reason: await compensateUntrackedRun() };
    }
    return { runId, operationId: runId };
  }

  async function dispatch(
    action: string,
    payload: Record<string, unknown>,
    caller: SessionServiceCaller,
  ): Promise<unknown> {
    if (!SESSION_ACTIONS.has(action)) return { ok: false, reason: 'unsupported_action' };
    try {
      options.validateCaller(caller);
    } catch {
      return { ok: false, reason: 'caller_attempt_not_current' };
    }

    try {
      switch (action) {
        case 'session:spawn': {
          const prompt = requireString(payload, 'prompt');
          const requestedDirectory = requireString(payload, 'workingDirectory');
          const model = requireString(payload, 'model') ?? undefined;
          if (payload.use_worktree !== undefined && typeof payload.use_worktree !== 'boolean') return { ok: false, reason: 'invalid_use_worktree' };
          for (const key of ['source_branch', 'branch_name']) if (payload[key] !== undefined && !requireString(payload, key)) return { ok: false, reason: `invalid_${key}` };
          const isolated = payload.use_worktree === true || (payload.use_worktree === undefined && Boolean(options.checkoutService?.read(caller.sessionId).checkout));
          if (!isolated && (payload.source_branch !== undefined || payload.branch_name !== undefined)) return { ok: false, reason: 'independent_branch_requires_worktree' };
          if (isolated && !options.checkoutService) return { ok: false, reason: 'worktree_isolation_unavailable' };
          if (!prompt || !requestedDirectory || !path.isAbsolute(requestedDirectory)) {
            return { ok: false, reason: 'invalid_spawn_input' };
          }
          const parent = await parentFor(caller);
          if (!parent) return { ok: false, reason: 'parent_session_missing_or_unbound' };
          const requestedCanonical = await realpath(requestedDirectory).catch(() => null);
          requireCurrentCaller(caller);
          if (!requestedCanonical || !sameCanonicalDirectory(parent.workingDirectory, requestedCanonical)) {
            return { ok: false, reason: 'working_directory_must_match_parent' };
          }
          const workspace = boundWorkspace(parent.record);
          if (!workspace) return { ok: false, reason: 'parent_workspace_unbound' };

          let child: HostSessionRecord;
          try {
            requireCurrentCaller(caller);
            const input: HostSessionCreateInput = {
              workspaceId: workspace.workspaceId,
              workspaceRootId: workspace.rootId,
              workspaceRelativePath: workspace.relativePath,
              title: `[Spawn] ${prompt.split('\n')[0]?.slice(0, 60) || 'task'}`,
              status: 'active',
              model: model ?? parent.record.model,
              providerId: parent.record.providerId,
              mode: parent.record.mode,
              permissionMode: parent.record.permissionMode,
              agentProfileId: parent.record.agentProfileId,
              parentSessionId: parent.record.id,
              spawn: { type: 'session', reason: 'session-tool' },
              agentType: 'spawn',
              extensions: { [SPAWN_METADATA_KEY]: { status: 'starting' } },
            };
            child = await options.sessions.create(input);
          } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
          }

          if (!callerIsCurrent(caller)) {
            const failureReason = 'caller_attempt_not_current';
            const failed = await markCreatedChildFailed(child.id, failureReason);
            return {
              ok: false,
              sessionId: child.id,
              parentId: parent.record.id,
              reason: failed ? failureReason : `${failureReason}; child_failure_metadata_write_failed`,
            };
          }

          let childCwd = parent.workingDirectory;
          let checkout: import('@duya/agent-protocol').SessionCheckoutAttachment | null = null;
          if (options.checkoutService) {
            try {
              const prepared = await options.checkoutService.createChildCheckout(child.id, parent.workingDirectory, caller, isolated,
                requireString(payload, 'source_branch') ?? undefined, requireString(payload, 'branch_name') ?? undefined);
              childCwd = prepared.state.cwd;
              checkout = prepared.state.checkout;
              requireCurrentCaller(caller);
            } catch (error) {
              await markCreatedChildFailed(child.id, error instanceof Error ? error.message : String(error));
              return { ok: false, sessionId: child.id, reason: error instanceof Error ? error.message : String(error) };
            }
          }
          const started = await startRun(child, childCwd, prompt, caller, model);
          if ('reason' in started) {
            const failureReason = started.reason;
            const failed = await markCreatedChildFailed(child.id, failureReason);
            return {
              ok: false,
              sessionId: child.id,
              parentId: parent.record.id,
              reason: failed ? failureReason : `${failureReason}; child_failure_metadata_write_failed`,
            };
          }
          return {
            ok: true,
            sessionId: child.id,
            parentId: parent.record.id,
            runId: started.runId,
            operationId: started.operationId,
            completionNotification: 'query',
            workingDirectory: childCwd,
            isolation: isolated ? 'worktree' : 'shared',
            ...(checkout ? { checkout, branchName: requireString(payload, 'branch_name') ?? `duya/session/${child.id.replace(/[^A-Za-z0-9._-]/g, '-')}` } : {}),
          };
        }

        case 'session:spawnList': {
          const sessions: SessionRow[] = [];
          const seenCursors = new Set<string>();
          let cursor: string | undefined;
          for (;;) {
            const page = await options.sessions.list({
              parentSessionId: caller.sessionId,
              includeAllSessions: true,
              ...(cursor === undefined ? {} : { cursor }),
            });
            requireCurrentCaller(caller);
            for (const item of page.sessions) {
              const session = item.session;
              if (session.parentSessionId !== caller.sessionId) continue;
              const local = await options.readLocalSession(session.id);
              requireCurrentCaller(caller);
              const metadata = readSpawnMetadata(session);
              const run = metadata?.runId ? await options.runs.getAgentRun(metadata.runId) : null;
              requireCurrentCaller(caller);
              sessions.push({
                id: session.id,
                title: session.title,
                status: run?.status ?? metadata?.status ?? session.status,
                working_directory: local?.workingDirectory ?? '',
                created_at: Number(session.createdAt),
                updated_at: Number(session.updatedAt),
                ...(metadata?.runId ? { runId: metadata.runId } : {}),
                ...(run ? { runStatus: run.status } : {}),
              });
            }
            const nextCursor = page.nextCursor;
            if (nextCursor === null || seenCursors.has(nextCursor)) break;
            seenCursors.add(nextCursor);
            cursor = nextCursor;
          }
          return { ok: true, sessions };
        }

        case 'session:spawnGet': {
          const sessionId = requireString(payload, 'sessionId');
          if (!sessionId) return { ok: false, reason: 'missing_session_id' };
          const session = await ownedChild(sessionId, caller);
          if (!session) return { ok: false, reason: 'not_found_or_not_owned' };
          const local = await options.readLocalSession(session.id);
          requireCurrentCaller(caller);
          const metadata = readSpawnMetadata(session);
          const run = metadata?.runId ? await options.runs.getAgentRun(metadata.runId) : null;
          requireCurrentCaller(caller);
          if (run && run.sessionId !== session.id) return { ok: false, reason: 'run_session_mismatch' };
          const output = metadata?.runId
            ? runOutput(await readAllRunEvents(options.runs, metadata.runId))
            : '';
          requireCurrentCaller(caller);
          const stats = await options.sessions.getSessionChangeStats(session.id);
          requireCurrentCaller(caller);
          const status = run?.status ?? metadata?.status ?? session.status;
          return {
            ok: true,
            runId: metadata?.runId,
            runStatus: run?.status ?? metadata?.status,
            operationId: metadata?.operationId,
            output,
            session: {
              ...(metadata?.runId ? { runId: metadata.runId } : {}),
              output,
              id: session.id,
              title: session.title,
              status,
              workingDirectory: local?.workingDirectory ?? '',
              parentId: caller.sessionId,
              filesChanged: stats.filesChanged,
              linesAdded: stats.linesAdded,
              linesRemoved: stats.linesRemoved,
              updatedAt: Number(session.updatedAt),
              createdAt: Number(session.createdAt),
            },
          };
        }

        case 'session:spawnReply': {
          const sessionId = requireString(payload, 'sessionId');
          const prompt = requireString(payload, 'prompt');
          const model = requireString(payload, 'model') ?? undefined;
          if (!sessionId || !prompt) return { ok: false, reason: 'missing_required_fields' };
          return withChildLaunchLock(childLaunchQueues, sessionId, async () => {
            requireCurrentCaller(caller);
            const session = await ownedChild(sessionId, caller);
            if (!session) return { ok: false, reason: 'not_found_or_not_owned' };
            const metadata = readSpawnMetadata(session);
            const currentRun = metadata?.runId ? await options.runs.getAgentRun(metadata.runId) : null;
            requireCurrentCaller(caller);
            if (currentRun?.sessionId !== undefined && currentRun.sessionId !== session.id) {
              return { ok: false, reason: 'run_session_mismatch' };
            }
            if (currentRun?.status === 'running') return { ok: false, reason: 'run_in_progress' };
            const parent = await parentFor(caller);
            const local = await options.readLocalSession(session.id);
            requireCurrentCaller(caller);
            if (!parent || !local?.workingDirectory) return { ok: false, reason: 'session_workspace_unavailable' };
            const childCanonical = await realpath(local.workingDirectory).catch(() => null);
            requireCurrentCaller(caller);
            const managedCursor = options.checkoutService && options.checkoutService.read(session.id).revision > 0;
            if (managedCursor) await options.checkoutService!.verifyCursor(session.id);
            if (!childCanonical || (!managedCursor && !sameCanonicalDirectory(parent.workingDirectory, childCanonical))) {
              return { ok: false, reason: 'working_directory_must_match_parent' };
            }
            const started = await startRun(session, childCanonical, prompt, caller, model);
            if ('reason' in started) {
              requireCurrentCaller(caller);
              await options.sessions.update(session.id, undefined, {
                extensions: {
                  [SPAWN_METADATA_KEY]: {
                    ...(metadata?.runId ? { runId: metadata.runId } : {}),
                    status: 'failed',
                    failureReason: started.reason,
                  },
                },
              });
              return { ok: false, sessionId, reason: started.reason };
            }
            return { ok: true, sessionId, runId: started.runId, operationId: started.operationId, completionNotification: 'query' };
          });
        }

        case 'session:spawnCancel': {
          const sessionId = requireString(payload, 'sessionId');
          if (!sessionId) return { ok: false, reason: 'missing_session_id' };
          const session = await ownedChild(sessionId, caller);
          if (!session) return { ok: false, reason: 'not_found_or_not_owned' };
          const metadata = readSpawnMetadata(session);
          const capturedRunId = metadata?.runId;
          if (!capturedRunId) return { ok: false, reason: 'no_tracked_run' };
          const run = await options.runs.getAgentRun(capturedRunId);
          requireCurrentCaller(caller);
          if (!run || run.sessionId !== session.id) return { ok: false, reason: 'run_not_found' };
          if (run.status !== 'running') return { ok: false, reason: 'run_not_running' };
          options.validateCaller(caller);
          const result = await options.execution.cancelAgentRun(capturedRunId, 'parent_requested');
          return result.requested
            ? { ok: true, sessionId, runId: capturedRunId }
            : { ok: false, sessionId, runId: capturedRunId, reason: result.reason };
        }

        case 'session:spawnRename': {
          const sessionId = requireString(payload, 'sessionId');
          const title = requireString(payload, 'title');
          if (!sessionId || !title) return { ok: false, reason: 'missing_required_fields' };
          const session = await ownedChild(sessionId, caller);
          if (!session) return { ok: false, reason: 'not_found_or_not_owned' };
          requireCurrentCaller(caller);
          const updated = await options.sessions.update(sessionId, undefined, { title });
          return updated.updated ? { ok: true, sessionId } : { ok: false, reason: 'not_updated' };
        }

        default:
          return { ok: false, reason: 'unsupported_action' };
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  return { dispatch };
}
