/**
 * workflow-runtime-child.ts — plan 560 D2/D3: the run-anchored executor.
 *
 * Spawned by `WorkflowRuntimeManager` with `DUYA_AGENT_ROLE=workflow-runtime`,
 * running the SAME `agent-process-entry.js` bundle a chat worker runs. That is
 * deliberate: a run needs the full builtin tool registry, the LLM runtime and
 * the browser daemon port, so a lean second entry point would rebuild half the
 * agent. What differs is the WIRING, not the code:
 *
 *   - No `init` handshake, no chat session, no agent instance. The child is a
 *     PURE EXECUTOR (D3): main creates the run row and the definition snapshot
 *     *before* the spawn and owns the events table. Nothing here opens a
 *     database — if a tool ever does, its `db:request` is forwarded to main by
 *     the manager like every other worker's, but this path never issues one.
 *   - Commands arrive on **stdin** (`parseStdin`, the worker's proven channel)
 *     and frames leave on **stdout** (`sendEvent`). One channel per direction,
 *     exactly like `WorkerManager.spawnWorker`. (`launchSavedWorkflow` is the
 *     only executor; the transport split in workflow-runner.ts exists so this
 *     file adds a transport, not a second execution path.)
 *
 * Frames (child → main, plan 560 §5.3):
 *   workflow:ready | workflow:run-event | workflow:permission-request
 *   workflow:publish-artifact | workflow:finished
 *
 * There is no graceful cancel (D7): the manager's SIGTERM→SIGKILL is the hard
 * stop. A `workflow:cancel` command only aborts between journal records, which
 * `launchSavedWorkflow`'s `signal` already supports.
 */

import { randomUUID } from 'node:crypto';

import { FsArtifactStore } from '../modes/workflow/gui-artifacts.js';
import { parseStdin, sendEvent, type WorkerCommand } from './worker-protocol.js';
import {
  launchSavedWorkflow,
  type WorkflowArtifactDescriptor,
  type WorkflowRunnerLlmConfig,
  type WorkflowRunnerTransport,
} from './workflow-runner.js';
import type { ComputerUseRequest } from './gui-backend.js';

/** main → child: the whole run description (plan 560 §5.3). */
export interface WorkflowRuntimeInitCommand {
  type: 'workflow:init';
  runId: string;
  workflowName: string;
  /** Script args; declared frontmatter defaults are applied child-side. */
  params?: Record<string, unknown>;
  /** Project scope root for saved-workflow resolution; also the run cwd. */
  projectDir?: string;
  scope?: 'project' | 'global' | null;
  llm: WorkflowRunnerLlmConfig;
  /** Fallback cwd when the run carries no `projectDir`. */
  workingDirectory: string;
  /**
   * Artifact ROOT (`~/.duya/workflow-artifacts`). `FsArtifactStore` appends
   * `<runId>/` itself, so the per-run directory is `<root>/<runId>/`.
   */
  artifactsRoot: string;
}

/** main → child: resolve one approval asked by `wf.approve`. */
export interface WorkflowRuntimePermissionResolveCommand {
  type: 'workflow:permission-resolve';
  requestId: string;
  decision: 'allow' | 'deny';
}

/** main → child: abort between journal records (the hard stop is SIGTERM). */
export interface WorkflowRuntimeCancelCommand {
  type: 'workflow:cancel';
  runId?: string;
}

// ─── content-type → file extension (artifact bytes land on disk) ───

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/xml': '.xml',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

function extForContentType(contentType: string): string {
  const base = contentType.split(';')[0]?.trim() ?? '';
  return EXT_BY_CONTENT_TYPE[base] ?? '.txt';
}

/** `wf.publish(name, content)` accepts anything JSON-ish; bytes are the UTF-8 length. */
function artifactBytes(content: unknown): { buffer: Buffer; bytes: number } {
  if (Buffer.isBuffer(content)) return { buffer: content, bytes: content.byteLength };
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? null);
  const buffer = Buffer.from(text ?? '', 'utf8');
  return { buffer, bytes: buffer.byteLength };
}

export interface WorkflowRuntimeChildOptions {
  /** Injection seam for tests — defaults to the real stdout writer. */
  emit?: (frame: Record<string, unknown>) => void;
  /** Injection seam for tests — defaults to the real stdin command stream. */
  commands?: AsyncIterable<WorkerCommand>;
}

/**
 * Run one run-anchored workflow to a terminal state, then resolve.
 *
 * The caller (`agent-process-entry.main`) exits the process afterwards: we
 * never call `process.exit` here so the entry's cleanup path still runs and a
 * truncated stdout pipe cannot swallow the `finished` frame.
 */
export async function runWorkflowRuntimeChild(
  options: WorkflowRuntimeChildOptions = {},
): Promise<void> {
  const emit = options.emit ?? ((frame: Record<string, unknown>) => sendEvent(frame));

  // Approval round-trips (plan 560 D6): main relays these to the run panel.
  const pendingPermissions = new Map<string, (decision: 'allow' | 'deny') => void>();
  const abort = new AbortController();

  let resolveInit: (init: WorkflowRuntimeInitCommand | null) => void = () => {};
  const initArrived = new Promise<WorkflowRuntimeInitCommand | null>((resolve) => {
    resolveInit = resolve;
  });
  let initConsumed = false;

  /**
   * The command stream stays open for the whole run (permission resolves and
   * the cancel hint arrive on it), so this loop must never `return` on init —
   * it only signals the handshake promise and keeps consuming.
   */
  const consume = (async () => {
    const stream = options.commands ?? parseStdin();
    for await (const msg of stream) {
      const type = (msg as { type?: string }).type;
      if (type === 'workflow:init') {
        if (!initConsumed) {
          initConsumed = true;
          resolveInit(msg as unknown as WorkflowRuntimeInitCommand);
        }
        continue;
      }
      if (type === 'workflow:permission-resolve') {
        const { requestId, decision } = msg as unknown as WorkflowRuntimePermissionResolveCommand;
        if (typeof requestId === 'string') {
          const resolve = pendingPermissions.get(requestId);
          pendingPermissions.delete(requestId);
          resolve?.(decision === 'allow' ? 'allow' : 'deny');
        }
        continue;
      }
      if (type === 'workflow:cancel') {
        abort.abort();
        continue;
      }
    }
    // stdin closed before init: settle the handshake as "nothing to do" so the
    // process does not hang; the manager settles the run from the exit.
    resolveInit(null);
  })();

  const init = await initArrived;
  if (!init) {
    return;
  }

  const store = new FsArtifactStore(init.artifactsRoot);

  // ─── worker→main computer-use RPC (plan 556 Phase 4) ───
  //
  // The manager forwards `computer-use:execute` child-messages to main
  // (workflow-runtime-manager FORWARDED_RPC_TYPES) and the agent server
  // routes the response back over the fork IPC channel
  // (server/index.ts `rpc:<requestId>` → child.send). Requests ride
  // process.send, responses resolve the pending map below.
  const pendingComputerUse = new Map<
    string,
    (res: { success: boolean; data?: unknown; error?: { code: string; message: string } }) => void
  >();

  if (typeof process.on === 'function') {
    process.on('message', (msg: unknown) => {
      const m = msg as
        | {
            type?: string;
            requestId?: string;
            success?: boolean;
            data?: unknown;
            error?: { code: string; message: string };
          }
        | undefined;
      if (m?.type === 'computer-use:execute:response' && typeof m.requestId === 'string') {
        const resolve = pendingComputerUse.get(m.requestId);
        if (resolve) {
          pendingComputerUse.delete(m.requestId);
          resolve({ success: m.success === true, data: m.data, error: m.error });
        }
      }
    });
  }

  const computerUseRequest: ComputerUseRequest = (action, payload, options) =>
    new Promise((resolve) => {
      const requestId = randomUUID();
      const timeout = options?.timeout ?? 30_000;
      const settle = (res: { success: boolean; data?: unknown; error?: { code: string; message: string } }) => {
        if (pendingComputerUse.delete(requestId)) resolve(res);
      };
      const timer = setTimeout(() => {
        settle({
          success: false,
          error: { code: 'TIMEOUT', message: `computer-use IPC request timeout after ${timeout}ms` },
        });
      }, timeout);
      timer.unref?.();
      pendingComputerUse.set(requestId, settle);
      if (typeof process.send !== 'function') {
        clearTimeout(timer);
        settle({
          success: false,
          error: { code: 'NO_IPC', message: 'workflow runtime child has no IPC channel' },
        });
        return;
      }
      process.send({ type: 'computer-use:execute', requestId, action, payload, sessionId: undefined });
    });

  const transport: WorkflowRunnerTransport = {
    // D3: main created the row before spawning this process — nothing to do.
    async createRun() {},

    /**
     * `workflow:ready` is both the handshake and the only place main learns the
     * frozen definition (D3: main stores the snapshot, the child never writes
     * a database). It therefore fires exactly where the runner would have
     * written the snapshot.
     */
    async saveSnapshot(snapshot) {
      emit({
        type: 'workflow:ready',
        runId: init.runId,
        definition: snapshot.definition,
      });
    },

    appendJournal(runId, record) {
      emit({ type: 'workflow:run-event', runId, seq: record.seq, record });
    },

    async finishRun(runId, outcome) {
      // A terminal that arrives before `ready` means the launch itself failed
      // (not-found / missing args / unreadable script). main tells the two
      // apart by whether it already saw a `ready` frame from this child.
      emit({
        type: 'workflow:finished',
        runId,
        status: outcome.status,
        ...(outcome.message !== undefined ? { error: outcome.message } : {}),
        ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
        ...(outcome.artifacts !== undefined ? { artifacts: outcome.artifacts } : {}),
        ...(outcome.spentTokens !== undefined ? { spentTokens: outcome.spentTokens } : {}),
      });
    },

    // No session frames exist on this path (plan 560 D5).
    emit() {},
  };

  await launchSavedWorkflow(
    {
      // A run anchor has no session. Empty is honest: a tool that genuinely
      // needs one fails loudly instead of attaching to an unrelated session.
      sessionId: '',
      emit: () => {},
      requestPermission: async (request) => {
        emit({
          type: 'workflow:permission-request',
          runId: init.runId,
          requestId: request.id,
          toolName: request.toolName,
          toolInput: request.toolInput,
          expiresAt: request.expiresAt,
        });
        return new Promise<'allow' | 'deny'>((resolve) => {
          pendingPermissions.set(request.id, resolve);
          const waitMs = Math.max(0, request.expiresAt - Date.now());
          // Keep the "timeout is deny" semantics the tool pipeline has always
          // had (workflow-runner.ts requestApproval) — never a silent allow.
          const timer = setTimeout(() => {
            if (pendingPermissions.delete(request.id)) resolve('deny');
          }, waitMs);
          timer.unref?.();
        });
      },
      llm: init.llm,
      workingDirectory: init.projectDir ?? init.workingDirectory,
      transport,
      // Plan 556 Phase 4: gui nodes execute through the main-process
      // computer-use dispatcher; captures land next to wf.publish
      // artifacts under the run's artifact directory.
      computerUseRequest,
      guiArtifactStore: store,
      publishArtifact: async (name, content, contentType) => {
        const { buffer, bytes } = artifactBytes(content);
        const relPath = await store.put(init.runId, name, buffer, extForContentType(contentType));
        const descriptor: WorkflowArtifactDescriptor = {
          id: randomUUID(),
          name,
          contentType,
          bytes,
          relPath,
        };
        // Terminal outcomes carry the full list; this live frame is what lets
        // the run card show an artifact the moment it is published.
        emit({ type: 'workflow:publish-artifact', runId: init.runId, ...descriptor });
        return descriptor;
      },
    },
    {
      runId: init.runId,
      workflowName: init.workflowName,
      params: init.params,
      projectDir: init.projectDir,
      // The run-anchored path is the library anchor by definition (D1).
      origin: 'library',
    },
    abort.signal,
  );

  // Let the pending stdout frames reach the pipe before the entry exits —
  // `process.exit` does not flush async stdout writes.
  await new Promise<void>((resolve) => {
    process.stdout.write('', () => resolve());
  });

  // `consume` is a live stdin reader; it is intentionally not awaited. The
  // manager kills this process once the terminal frame is out.
  void consume;
}
