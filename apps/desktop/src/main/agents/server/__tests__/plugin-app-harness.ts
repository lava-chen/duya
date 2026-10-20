import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ChildProcess } from 'node:child_process';

const { RunOrchestrator, createWorkerExecutionChannel } = await import('@duya/host/run-orchestrator');
const { writeRunReceiptOnWire } = await import('@duya/host/run-receipt');
const { RunStore, RUN_STORE_MIGRATIONS } = await import('@duya/data/run-store');
const { WorkerManager: HostWorkerManager } = await import('@duya/host/worker-manager');

/**
 * The real parts of the Plugin App bridge, assembled for a test.
 *
 * Real: the run ledger (`RunOrchestrator` over a real SQLite `RunStore` with
 * the real migrations), the worker supervisor (`WorkerManager` from the host
 * package), and the worker itself — a real forked process that reads commands
 * on stdin and answers on its IPC channel, the same two channels the
 * production worker uses.
 *
 * Not real: the Electron main process and the browser. The boundary under
 * test is the one between the transport and the worker, and both ends of it
 * are here.
 */

/**
 * A worker that answers the two Plugin App commands and stays alive.
 *
 * It is a real process, so "the live worker of this session" is a fact about
 * a real process, and a replaced worker is a process that really died.
 */
export const PLUGIN_APP_WORKER_FIXTURE = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\\n');
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handle(line);
    index = buffer.indexOf('\\n');
  }
});

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'plugin-app:describe-tools') {
    process.send({
      type: 'plugin-app:tools',
      sessionId: msg.sessionId,
      runId: msg.runId,
      epoch: msg.epoch,
      requestId: msg.requestId,
      tools: [{
        toolId: 'mcp:dashboard/read',
        schemaRevision: 'rev-1',
        descriptor: { name: 'read', description: 'Read the dashboard' },
      }],
    });
    return;
  }

  if (msg.type === 'plugin-app:invoke') {
    const answer = {
      type: 'plugin-app:result',
      sessionId: msg.sessionId,
      runId: msg.runId,
      epoch: msg.epoch,
      requestId: msg.requestId,
      result: { ok: true, result: { value: 'answered' } },
    };
    // A slow tool answers late, so a test can hold a request open while the
    // worker underneath it is replaced.
    if (msg.toolId === 'slow') {
      setTimeout(() => process.send(answer), 2000);
      return;
    }
    process.send(answer);
    return;
  }

  // A command the fixture deliberately does not answer, so a test can hold a
  // request open.
  if (msg.type === 'plugin-app:invoke-ignored') {
    return;
  }
}

setInterval(() => {}, 1000);
`;

export interface PluginAppHarness {
  readonly orchestrator: InstanceType<typeof RunOrchestrator>;
  readonly workers: InstanceType<typeof HostWorkerManager>;
  readonly runId: string;
  readonly sessionId: string;
  /** The live attempt epoch of the harness run. */
  readonly epoch: number;
  /** The `db:request` routing table the Agent Server keeps. */
  readonly workerDbRequests: Map<string, ChildProcess>;
  /** Every message the Agent Server sent to the Main process. */
  readonly sent: Record<string, unknown>[];
  close(): void;
}
const tempDirs: string[] = [];

/** A temp directory that the caller is expected to clean up. */
export function trackTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Remove every temp directory this module handed out. */
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
}

function createWorkerManager(workerPath: string): InstanceType<typeof HostWorkerManager> {
  return new HostWorkerManager(
    {
      getState: () => 'STREAMING',
      transitionToStreaming: () => {},
      transitionToCrashed: () => {},
    },
    {
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      resolveWorkerPath: () => workerPath,
      resolveBetterSqlite3Path: () => 'unused-in-this-fixture',
    },
  );
}

export interface OpenHarnessOptions {
  readonly sessionId?: string;
}

/** Open a real run and a real worker for it. */
export async function openPluginAppHarness(options: OpenHarnessOptions = {}): Promise<PluginAppHarness> {
  const sessionId = options.sessionId ?? 's-plugin-app-harness';

  const dbDir = trackTempDir('duya-plugin-app-db-');
  const db = new Database(join(dbDir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  const store = new RunStore(db);

  const dbRequest = async (action: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (action === 'run:create') {
      const outcome = store.createRun(payload as unknown as Parameters<RunStore['createRun']>[0]);
      if (outcome.state === 'created') return writeRunReceiptOnWire({ state: 'created', runId: outcome.runId });
      if (outcome.state === 'reused') return writeRunReceiptOnWire({ state: 'reused', runId: outcome.runId });
      return writeRunReceiptOnWire({ state: 'conflict', runId: outcome.runId, reason: outcome.reason });
    }
    if (action === 'run:append') {
      const { events } = payload as { events: readonly unknown[] };
      const written = store.appendEvents(events as never);
      return writeRunReceiptOnWire({ state: 'applied', runId: String(payload['runId']) }, { written });
    }
    if (action === 'run:complete') {
      const { runId, terminal } = payload as { runId: string; terminal: { status: string } };
      const outcome = store.settleRun(runId, terminal as never);
      return outcome.state === 'applied'
        ? writeRunReceiptOnWire({ state: 'applied', runId })
        : writeRunReceiptOnWire({ state: 'conflict', runId, reason: outcome.state });
    }
    return writeRunReceiptOnWire({ state: 'invalid', runId: '', reason: `unhandled action ${action}` });
  };

  const orchestrator = new RunOrchestrator({
    nativeWriter: {
      currentEpoch: (runId: string) => store.currentEpoch(runId),
      append: (runId: string, envelopes: readonly never[], presented: number) => {
        const written = store.appendEvents(envelopes, presented);
        return written === 0 ? { state: 'duplicate' } : { state: 'written', written };
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    dbRequest: dbRequest as never,
    channel: createWorkerExecutionChannel({
      dispatch: () => true,
      interrupt: () => ({ accepted: true, settled: Promise.resolve('cooperative' as const) }),
    } as never),
  });

  const opened = await orchestrator.openRun(sessionId, {
    prompt: 'plugin app proof',
    options: { sessionId },
    model: 'claude-test',
    providerId: 'anthropic',
    workingDirectory: trackTempDir('duya-plugin-app-ws-'),
  } as never);
  const runId = opened.runId as string;
  const epoch = orchestrator.attemptFor(runId)?.epoch ?? 0;

  const workerDir = trackTempDir('duya-plugin-app-worker-');
  const workerPath = join(workerDir, 'worker-fixture.cjs');
  writeFileSync(workerPath, PLUGIN_APP_WORKER_FIXTURE, 'utf8');

  const workers = createWorkerManager(workerPath);

  // The Agent Server talks to the Main process over its own IPC channel.
  // The test process has none, so the channel is stood in for here and
  // restored when the harness closes.
  const sent: Record<string, unknown>[] = [];
  const previousSend = process.send;
  process.send = ((message: Record<string, unknown>) => {
    sent.push(message);
    return true;
  }) as typeof process.send;

  return {
    orchestrator,
    workers,
    runId,
    sessionId,
    epoch,
    workerDbRequests: new Map<string, ChildProcess>(),
    sent,
    close: () => {
      process.send = previousSend;
      db.close();
    },
  };
}
