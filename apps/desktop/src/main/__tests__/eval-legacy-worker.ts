/**
 * eval-legacy-worker.ts — the REAL worker process, over its REAL transport.
 *
 * ## What this drives
 *
 * `packages/agent/src/process/agent-process-entry.ts`, built to
 * `packages/agent/bundle/agent-process-entry.js` by `npm run bundle:agent` and
 * launched with `child_process.fork` over the same four stdio channels the
 * product uses (`pipe`, `pipe`, `pipe`, `ipc`). Nothing in this file imports
 * `DuyaAgent`, `handleChatStart`, or any executor symbol: the executor is
 * reached the only way production reaches it — a JSON command line on stdin,
 * and a JSON event line back on stdout.
 *
 * There is deliberately no way to inject a run event from the outside. The
 * point of E4.1 is that the loop is the worker's, so the harness's only verbs
 * are `init`, `chat:start`, and "observe what came back".
 *
 * ## Why the bundle and not `dist/`
 *
 * `worker-manager.ts:resolveWorkerPath` prefers
 * `packages/agent/bundle/agent-process-entry.js` and says why: the tsc output
 * is ESM whose runtime imports resolve to `@duya/plugin-core`'s
 * `src/index.ts`, which Node cannot load, so
 * `dist/process/agent-process-entry.js` dies with ERR_MODULE_NOT_FOUND before
 * it ever reads a command. Measured, not assumed — see the report. Forking the
 * bundle is therefore both what the product does and the only build that
 * reaches the executor at all.
 *
 * ## The DB boundary is real where it matters, and says so where it does not
 *
 * In production the worker's `db:request` IPC is answered by
 * `apps/desktop/src/main/agents/db-bridge.ts`, which imports Electron
 * (`BrowserWindow`, `getDatabase`, the plugin manager). A vitest process has
 * none of those, so this harness answers the same channel with two clearly
 * separated classes of handler:
 *
 *  - `run:*` — the REAL `dispatchControlPlaneAction` from
 *    `control-plane/run-control-plane.ts`, over a REAL `RunStore` on REAL
 *    SQLite at a temp path. Every run fact this harness reports comes out of
 *    that store.
 *  - chat-session tables (`session:*`, `message:*`, `setting:getJson`,
 *    `plugin:*`, `toolApproval:*`, …) — narrow answers carrying the shapes
 *    `packages/agent/src/ipc/db-client.ts` documents. Every call is recorded
 *    in `dbCalls`, so the report can enumerate the host surface the real
 *    worker actually reached for and nothing is hidden.
 *
 * A run fact is never answered by the second class. That separation is the
 * difference between "the run ledger is proven end to end" and "the chat
 * tables are stood in for", and the report claims only the first.
 *
 * ## Real security boundary
 *
 * The workspace is a fresh temp directory and becomes the run's `cwd` and
 * `roots[0]`; the worker's own root-boundary checks (`tool/allowedRoots`) are
 * what enforce it, and nothing here relaxes them. HOME/USERPROFILE and
 * `--duya-namespace` redirect the worker's config, rollout and attachment
 * roots under the same temp tree, using the product's own isolation mechanism
 * (`boot-config.ts` / `compass.ts`) rather than an invented one.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface WorkerDbCall {
  readonly action: string;
  readonly payload: unknown;
}

export interface WorkerOptions {
  /** Absolute path to the built agent bundle. */
  readonly workerPath: string;
  /** Repo root; the child's cwd, exactly as production sets it. */
  readonly repoRoot: string;
  /** Temporary workspace; becomes the run's cwd and roots[0]. */
  readonly workspace: string;
  /** Isolated SQLite file backing the real RunStore. */
  readonly dbPath: string;
  /** Namespace suffix, so nothing resolves to real user data. */
  readonly namespace: string;
  readonly sessionId: string;
  /** Answers `run:*` through the real Control Plane. */
  readonly controlPlane: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
  /** Extra env for the child. Merged LAST, so a case can only tighten. */
  readonly env?: Record<string, string>;
}

export type WorkerFrame = Record<string, unknown> & { type: string };

export interface LegacyWorker {
  /** Write one JSON command line to the real stdin channel. */
  send(command: unknown): void;
  /** Observe real stdout frames, in order. Multiple subscribers allowed. */
  onFrame(fn: (frame: WorkerFrame) => void): void;
  /** Resolves true on the worker's own `ready` frame. */
  waitForReady(timeoutMs?: number): Promise<boolean>;
  /** Every frame seen so far. */
  readonly frames: readonly WorkerFrame[];
  /** `db:request` actions the real worker issued, in order. */
  readonly dbCalls: readonly WorkerDbCall[];
  /** stdout lines that were not JSON, plus all stderr. Diagnostic only. */
  readonly diagnostics: readonly string[];
  readonly pid: number | undefined;
  stop(): Promise<void>;
}

/** True for the actions the real Control Plane owns. */
export function isRunControlAction(action: string): boolean {
  return action.startsWith('run:');
}

export async function startLegacyWorker(options: WorkerOptions): Promise<LegacyWorker> {
  if (!existsSync(options.workerPath)) {
    throw new Error(
      `agent bundle missing at ${options.workerPath} — run \`npm run bundle:agent\`. `
      + 'The tsc dist/ output cannot be forked (ESM reaching plugin-core src), so the bundle '
      + 'is the only build that reaches the executor.',
    );
  }

  // Isolated roots. Everything the worker would otherwise read from the real
  // ~/.duya is redirected under the temp tree.
  const isolatedHome = path.join(path.dirname(options.dbPath), 'home');
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(path.join(isolatedHome, 'logs'), { recursive: true });

  // A real (empty) config.toml in the isolated root. The worker's own config
  // reader runs unmodified; there are simply no MCP servers declared, so
  // nothing external is spawned. This is the "all external network is a
  // fixture" rule enforced by configuration, not by a stub.
  writeFileSync(
    path.join(isolatedHome, 'config.toml'),
    '[mcp_servers]\n',
    'utf8',
  );

  const child: ChildProcess = fork(options.workerPath, [`--duya-namespace=${options.namespace}`], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    cwd: options.repoRoot,
    execPath: process.execPath,
    env: {
      ...process.env,
      // Product-shaped env, from worker-manager.ts createWorkerEnvironment.
      SESSION_ID: options.sessionId,
      DUYA_AGENT_MODE: 'true',
      DUYA_AGENT_SERVER: 'true',
      DUYA_BETTER_SQLITE3_PATH: path.join(options.repoRoot, 'node_modules', 'better-sqlite3'),
      DUYA_WORKER_LOG_DIR: path.join(isolatedHome, 'logs'),
      DUYA_TEST: '1',
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      DUYA_CUSTOM_DB_PATH: options.dbPath,
      ...options.env,
    },
  });

  const frameListeners: Array<(frame: WorkerFrame) => void> = [];
  const frames: WorkerFrame[] = [];
  const dbCalls: WorkerDbCall[] = [];
  const diagnostics: string[] = [];
  let readyPromise: Promise<boolean> | null = null;
  let buffer = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          const frame = JSON.parse(line) as WorkerFrame;
          frames.push(frame);
          for (const fn of frameListeners) fn(frame);
        } catch {
          // The real worker also writes human log lines to stdout. Keeping
          // them is the point: they are evidence the real process ran.
          diagnostics.push(`[stdout] ${line}`);
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostics.push(`[stderr] ${chunk.toString('utf8')}`);
  });
  child.on('error', (error) => {
    diagnostics.push(`[child:error] ${error.message}`);
  });

  child.on('message', (message: unknown) => {
    const msg = message as {
      type?: unknown; id?: unknown; action?: unknown; payload?: unknown;
    };
    if (msg?.type !== 'db:request' || typeof msg.id !== 'string' || typeof msg.action !== 'string') {
      return;
    }
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    dbCalls.push({ action: msg.action, payload });
    const answer = isRunControlAction(msg.action)
      ? options.controlPlane(msg.action, payload)
      : Promise.resolve(answerChatTable(msg.action, payload));
    const reply = (result: unknown, error?: string): void => {
      child.send?.(
        error === undefined
          ? { type: 'db:response', id: msg.id as string, success: true, result }
          : { type: 'db:response', id: msg.id as string, success: false, error },
      );
    };
    void answer.then(
      (result) => reply(result),
      (error: unknown) =>
        reply(null, error instanceof Error ? error.message : String(error)),
    );
  });

  return {
    send: (command) => {
      child.stdin?.write(`${JSON.stringify(command)}\n`);
    },
    onFrame: (fn) => {
      frameListeners.push(fn);
    },
    waitForReady: (timeoutMs = 60_000) => {
      readyPromise ??= new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        frameListeners.push((frame) => {
          if (frame.type === 'ready') {
            clearTimeout(timer);
            resolve(true);
          }
        });
      });
      return readyPromise;
    },
    get frames() { return frames; },
    get dbCalls() { return dbCalls; },
    get diagnostics() { return diagnostics; },
    get pid() { return child.pid; },
    stop: async () => {
      child.removeAllListeners('exit');
      child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

/**
 * Narrow answers for the chat-session tables.
 *
 * These carry the shapes `packages/agent/src/ipc/db-client.ts` documents. An
 * unlisted action resolves to `null` rather than throwing: the worker already
 * treats a failed db read as best-effort, and a hard failure here would abort
 * a turn over a table the RUN does not depend on. The call is still recorded,
 * so "we did not model this" is visible rather than silent.
 */
function answerChatTable(action: string, payload: Record<string, unknown>): unknown {
  switch (action) {
    case 'session:loadMessages':
      return { messages: [], parsedDocuments: [] };
    case 'session:get':
      return { id: String(payload.id ?? ''), title: 'eval session', working_directory: null };
    case 'session:create':
      return { id: String(payload.id ?? '') };
    case 'message:getCount':
      return 0;
    case 'message:getBySession':
      return [];
    case 'setting:getJson':
      return null;
    case 'plugin:registry:list':
      return [];
    case 'plugin:setup:list-all':
      return [];
    case 'toolApproval:listRules':
      return [];
    case 'toolApproval:consumeApproved':
      return null;
    case 'goal:get':
      return null;
    case 'modeState:get':
      return null;
    case 'lock:isLocked':
      return false;
    case 'task:getBySession':
      return [];
    case 'mailbox:claimBatch':
      // The shape `db-bridge.ts` returns: a batch plus the per-item claim
      // token map. Returning `null` here instead is not a smaller answer, it
      // is a crash — the executor dereferences `.rows` on this.
      return { rows: [], claimTokens: {} };
    case 'mailbox:listPending':
      return [];
    case 'message:getByTurn':
      return [];
    default:
      return null;
  }
}

/** Resolve on the first frame matching `predicate`, or null at the timeout. */
export function waitForFrame(
  worker: LegacyWorker,
  predicate: (frame: WorkerFrame) => boolean,
  timeoutMs: number,
): Promise<WorkerFrame | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (frame: WorkerFrame | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(frame);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    worker.onFrame((frame) => {
      if (predicate(frame)) finish(frame);
    });
  });
}
