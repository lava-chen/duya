import type {
  HostPermissionRequestResolveInput,
  RunId,
  SessionId,
} from '@duya/agent-protocol';
import { ApiClient, ApiError, type FetchLike } from './api.js';
import { RunEventStream } from './run-stream.js';
import { delay } from './selection.js';
import type { UiRunRecord, UiServices } from '@/services/ui-services';

export interface WebUiServicesOptions {
  readonly fetchImpl?: FetchLike;
  readonly runLedgerPollIntervalMs?: number;
  readonly reconnectDelayMs?: number;
  readonly stallTimeoutMs?: number;
}

/**
 * Bind the shared renderer to the same-origin BFF and its durable Host APIs.
 *
 * The composition of a bridge into a `UiServices` is NOT written here: it is
 * the shared one in `@duya/ui` (`createUiServices`), so the Web and the
 * Desktop cannot drift on the parts that are hard to see — a run list that
 * filters differently, a cancellation that swallows a refusal, an approval
 * that resolves against a different id space.
 *
 * What IS the Web's own is the transport: the BFF's routes, the CSRF token,
 * and the fact that the BFF's stream is the only way to reach the Host's
 * events.
 */
export function createWebUiServices(options: WebUiServicesOptions = {}): UiServices {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const api = new ApiClient({ fetchImpl });
  return {
    platform: 'web',
    capabilities: {
      localFileAccess: false,
      settings: false,
      extensions: false,
      conductor: false,
      bots: false,
      automation: false,
      workflows: false,
      // The Web transport carries the turn's configuration: the permission
      // mode, the agent profile and the declared modes reach the Host, and the
      // Host adjudicates them the same way it does for the Desktop. So the
      // composer may offer the controls.
      turnConfiguration: true,
    },
    sessions: {
      list: (query) => api.listHostSessions(query),
      get: (sessionId) => api.getHostSession(sessionId),
      create: (input) => api.createHostSession(input),
      update: (sessionId, expectedUpdatedAt, patch) => api.updateHostSession(sessionId, expectedUpdatedAt, patch),
      delete: async (sessionId, expectedUpdatedAt) => {
        if (expectedUpdatedAt === undefined) throw new ApiError(400, 'expected_updated_at_required');
        return await api.deleteHostSession(sessionId, expectedUpdatedAt);
      },
      readMessages: (sessionId, query) => api.readHostMessages(sessionId, query),
    },
    runs: {
      listBySession: (sessionId, limit, signal) => api.listHostRuns(sessionId, limit, { signal }),
      start: (input) => api.startHostRun(input),
      cancel: (runId, reason) => api.cancelHostRun(runId as RunId, reason),
      openSession: (runId, sessionId, signal) => {
        const pollController = new AbortController();
        const listeners = new Set<() => void>();
        let durableStatus: UiRunRecord['status'] | null = null;
        let terminalObserved = false;
        let stopped = false;
        let monitor: Promise<void> | null = null;
        let removeScopeAbort = (): void => undefined;
        let stopStream = (): void => undefined;
        const notify = (): void => {
          for (const listener of listeners) listener();
        };
        const stop = (): void => {
          if (stopped) return;
          stopped = true;
          pollController.abort();
          stopStream();
          removeScopeAbort();
        };
        const stream = new RunEventStream({
          runId,
          sessionId,
          signal,
          fetchImpl,
          reconnectDelayMs: options.reconnectDelayMs,
          stallTimeoutMs: options.stallTimeoutMs,
          streamUrl: (id, afterSeq) => api.eventStreamUrl(id, afterSeq),
          onEnd: () => {
            // A terminal ledger row proves the run ended, but the stream still
            // owns the last durable tail. Close only after a clean EOF observed
            // after that ledger read, including a replay after reconnect.
            if (!terminalObserved) return;
            stop();
          },
        });
        stopStream = () => stream.stop();
        const removeSnapshotListener = stream.subscribe(() => notify());
        const scopeAbort = (): void => stop();
        signal.addEventListener('abort', scopeAbort, { once: true });
        removeScopeAbort = () => {
          signal.removeEventListener('abort', scopeAbort);
          removeSnapshotListener();
        };
        if (signal.aborted) stop();

        const monitorRun = async (): Promise<void> => {
          const intervalMs = options.runLedgerPollIntervalMs ?? 1_000;
          while (!stopped && !pollController.signal.aborted) {
            try {
              const runs = await api.listHostRuns(sessionId, 50, { signal: pollController.signal });
              if (stopped || pollController.signal.aborted) break;
              const record = runs.find((candidate) => candidate.runId === runId);
              if (record !== undefined && record.status !== durableStatus) {
                durableStatus = record.status;
                notify();
              }
              if (record !== undefined && record.status !== 'running') {
                terminalObserved = true;
              }
            } catch (error) {
              if (pollController.signal.aborted || isAbortError(error)) break;
              // A transient ledger read failure must not invent terminal state
              // or stop replay; the next poll can recover it.
            }
            if (stopped || !(await delay(intervalMs, pollController.signal))) break;
          }
        };
        return {
          getSnapshot: () => stream.getSnapshot(),
          getDurableStatus: () => durableStatus,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          start: () => {
            if (stopped) return;
            stream.start();
            monitor ??= monitorRun();
          },
          stop,
          settled: async () => {
            await Promise.all([stream.settled(), monitor ?? Promise.resolve()]);
          },
        };
      },
    },
    approvals: {
      listPending: async (sessionId) => {
        if (sessionId === undefined) throw new ApiError(400, 'approval_session_required');
        return await api.listPendingApprovals(sessionId);
      },
      resolve: async (requestId, input: HostPermissionRequestResolveInput) => {
        const decision = resolveDecision(input);
        return await api.resolveApproval(requestId, decision);
      },
    },
    // The Web CAN register a workspace: the browser names a directory, the
    // Host resolves it against the machine it runs on, and the BFF returns the
    // binding. That is what lets a Web user start a conversation in a folder
    // of their own instead of only reusing a session that already has one.
    registerWorkspace: async (directory) => await api.registerLocalDirectory(directory),
    // The provider roster comes from the Host too: it is the roster the Host
    // adjudicates a turn's model against, so the browser's model picker and
    // the Host agree on what may be picked.
    providers: {
      catalog: async () => await api.getProviderCatalog(),
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function resolveDecision(input: HostPermissionRequestResolveInput): 'allow' | 'always' | 'deny' {
  if (input.status === 'deny') return 'deny';
  if (input.status === 'allow') {
    return input.decision === 'always' || input.decision === 'allow_session' || input.decision === 'allow_for_session'
      ? 'always'
      : 'allow';
  }
  throw new ApiError(400, 'unsupported_permission_resolution');
}
