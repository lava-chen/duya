/**
 * Plan 610 S1 follow-up: what a DESKTOP CLIENT IS TOLD when the run layer's
 * durable terminal disagrees with the Runtime's in-memory verdict — and what the
 * run layer keeps afterwards.
 *
 * ## Why an orchestrator-level test is not enough here
 *
 * `#releaseTerminalToConsumers` withholds a terminal until its commit lands, and
 * that barrier only reaches a consumer subscribed to `onEvent`. The Desktop
 * agent server constructs the orchestrator WITHOUT `onEvent`
 * (`agents/server/index.ts`), so on this surface the barrier is not on the path
 * at all — and the terminal reaches a client by two ungated routes instead:
 *
 *  - the value `settleSession` resolves to, which the SSE POST path
 *    (`handlePostChatSSE`), the non-SSE response (`handlePostChatNonSSE`) and
 *    the delete/cancel route (`handleDeleteChat`) each report;
 *  - `resultFor`, which `handleGetRunResult` answers `GET /runs/result` with.
 *
 * Both reported `handle.result()`'s verdict — the Runtime's — so a run whose
 * ledger lost an event was recorded `failed` and told `completed`. Asserting
 * that through the orchestrator alone would prove nothing about what this
 * surface does, so every terminal assertion below is read back off the JSON a
 * route actually wrote to a response.
 *
 * ## The disagreement is produced by real code
 *
 * Nothing is stubbed between the tee and the table: `normalizeAndObserve` (the
 * real router tee), `RunOrchestrator`, `createDesktopNativeRunEventWriter`, the
 * real `handleDbRequest` bridge, the real `ControlPlaneService`, and a real
 * SQLite `RunStore` with the real migrations. The ledger loss is a genuine
 * `(run_id, seq)` CONFLICT: a decoy row is written through the real bridge at a
 * sequence the worker is about to send, so the store refuses the worker's
 * envelope because a DIFFERENT event already holds that identity. That is the
 * real shape of a lost event, reached without stubbing the store.
 *
 * The only fakes are the two process boundaries a unit test cannot have: the
 * boot-time `getCoreStores()` singleton (replaced with a real `RunStore` over a
 * real file) and the worker process itself (a dispatch that records commands).
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getCoreStores()` is a boot-time singleton over `duya-core.db`. Faked with a
 * REAL `RunStore` over a REAL file — the substitution removes a process
 * boundary, not a behaviour.
 */
const hoisted = vi.hoisted(() => ({ stores: null as { runs: unknown; research: unknown } | null }));

vi.mock('../db/core-connection', () => ({
  getCoreStores: () => {
    if (hoisted.stores === null) throw new Error('core stores not set');
    return hoisted.stores;
  },
  getCoreStoresOrNull: () => hoisted.stores,
}));

/** The `run:*` arm reaches storage through the Control Plane, but the guard must pass. */
vi.mock('../ipc/db-handlers', () => ({ getDatabase: () => hoisted.stores }));

import { handleDbRequest } from '../agents/db-bridge';
import {
  handleDeleteChat,
  handleGetRunResult,
  normalizeAndObserve,
  type RouterDeps,
} from '../agents/server/router';
import { RunOrchestrator, createWorkerExecutionChannel } from '../agents/server/run-orchestrator';
import { createDesktopNativeRunEventWriter } from '../agents/server/native-run-event-writer';
import {
  dispatchControlPlaneAction,
  __setDesktopHostRunApiForTesting,
} from '../control-plane/run-control-plane';
import { createHostRunApi } from '@duya/host/run-api';
import {
  createControlPlaneRepository,
  _resetControlPlaneRepositoryForTesting,
  type CoreStoreAggregates,
} from '../control-plane/sqlite-repository';
import { HOST_APPROVAL_API_STUBS } from '../control-plane/__tests__/host-approval-api-stubs';
import {
  createControlPlane,
  _resetControlPlaneForTesting,
} from '../control-plane/control-plane-service';
import { roleOrigin, type CommandSenderConfig } from '../control-plane/command-receipt';
import { createDesktopHostRunApiAdapter } from '../control-plane/host-run-api-adapter';
import { createRunControlPlaneActions } from '@duya/host/run-control-plane';
import { RUN_STORE_MIGRATIONS, RunStore } from '../db/core/run-store';
import { AttachmentStore, GoalStore, PermissionLedger, TaskStore } from '../db/core/stores';
import { Mailbox } from '../db/core/mailbox';

const SESSION_ID = 'session-barrier-1';
const CHAT_PID = 4321;
const SENDER: CommandSenderConfig = {
  allowedOrigins: [roleOrigin('chat')],
  trustedPids: () => new Set([CHAT_PID]),
};
const CHAT_SENDER = { senderPid: CHAT_PID, registeredSessionId: SESSION_ID, role: 'chat' };

let dir: string;
let db: Database.Database;

function applySchema(handle: Database.Database): void {
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(handle);
  }
  for (const store of [PermissionLedger, GoalStore, TaskStore, Mailbox]) {
    for (const migration of [...store.migrations].sort((a, b) => a.id - b.id)) {
      migration.up(handle);
    }
  }
  handle.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT,
      filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
      path TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'file',
      created_at INTEGER NOT NULL
    );
  `);
}

/** The real bridge, as the agent fork's `dbRequest` sees it. */
async function dbRequestThroughBridge(action: string, payload: Record<string, unknown>): Promise<unknown> {
  const response = await handleDbRequest(
    { type: 'db:request', id: 'r-1', action, payload },
    CHAT_SENDER as never,
  );
  if (!response.success) {
    throw new Error(`the bridge refused ${action}: ${'error' in response ? response.error : 'unknown'}`);
  }
  return 'result' in response ? response.result : undefined;
}

function rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
}

/** What a route actually wrote to its response, parsed back. */
function captureResponse(): { res: ServerResponse; body: () => Record<string, unknown> } {
  let payload = '';
  let sent = 0;
  const res = {
    get headersSent(): boolean {
      return sent > 0;
    },
    writeHead(): void {
      sent += 1;
    },
    end(chunk?: string): void {
      sent += 1;
      if (chunk !== undefined) payload += chunk;
    },
    write(chunk: string): boolean {
      payload += chunk;
      return true;
    },
  } as unknown as ServerResponse;
  return { res, body: () => JSON.parse(payload) as Record<string, unknown> };
}

/**
 * Every line the run layer reported, with its ERROR argument inlined.
 *
 * The error matters: several of the claims this file makes — which terminal the
 * ledger holds, which one the withheld event describes — are carried in the
 * message of the `Error` a logger's third argument usually drops, so a capture
 * that keeps only `(message, data)` would lose exactly the evidence under test.
 */
const captureLine = (message: string, error?: unknown, data?: unknown): string =>
  `${message} ${error instanceof Error ? error.message : ''} ${JSON.stringify(data ?? {})}`;

interface Surface {
  readonly orchestrator: RunOrchestrator;
  readonly deps: RouterDeps;
  /** Every line the run layer reported, so an assertion can name one. */
  readonly reported: string[];
}

/**
 * The orchestrator exactly as `agents/server/index.ts` composes it: the real
 * bridge, the real Desktop native writer, and NO `onEvent` — which is the whole
 * reason this file exists.
 */
function desktopSurface(): Surface {
  const reported: string[] = [];
  const logger = {
    info: (message: string, ...rest: unknown[]) => reported.push(captureLine(message, ...rest)),
    warn: (message: string, ...rest: unknown[]) => reported.push(captureLine(message, ...rest)),
    error: (message: string, ...rest: unknown[]) => reported.push(captureLine(message, ...rest)),
  };

  const orchestrator = new RunOrchestrator({
    dbRequest: dbRequestThroughBridge as never,
    nativeWriter: createDesktopNativeRunEventWriter({
      request: dbRequestThroughBridge as never,
      logger: { warn: (message: string) => reported.push(message) },
    }),
    logger: logger as never,
    channel: createWorkerExecutionChannel({
      dispatch: () => true,
      interrupt: () => ({ accepted: true, settled: Promise.resolve('cooperative' as const) }),
    } as never),
  });

  const deps = {
    runOrchestrator: orchestrator,
    sessionManager: {
      getSession: () => ({ state: 'streaming' }),
      transitionState: () => undefined,
    },
    workerManager: { interruptWorker: () => null },
    dbRequest: dbRequestThroughBridge as never,
    httpLogger: logger,
    logger,
  } as unknown as RouterDeps;

  return { orchestrator, deps, reported };
}

/** One `run:event` line, exactly as `worker-process-entry.ts` writes it. */
function nativeFrame(runId: string, seq: number, type: string): Record<string, unknown> {
  return {
    type: 'run:event',
    epoch: 0,
    envelope: { runId, sessionId: SESSION_ID, seq, payload: { type } },
  };
}

const INTENT = {
  workingDirectory: '/repo',
  model: 'claude-opus',
  providerId: 'anthropic-main',
  apiFormat: 'anthropic',
  prompt: 'hello',
  options: {},
} as const;

beforeEach(() => {
  _resetControlPlaneRepositoryForTesting();
  _resetControlPlaneForTesting();
  dir = mkdtempSync(join(tmpdir(), 'duya-terminal-barrier-'));
  db = new Database(join(dir, 'core.db'));
  applySchema(db);
  const aggregates: CoreStoreAggregates = {
    runs: new RunStore(db),
    attachments: new AttachmentStore(db, dir),
    permissions: new PermissionLedger(db),
    goals: new GoalStore(db),
    tasks: new TaskStore(db),
    mailbox: new Mailbox(db),
  };
  hoisted.stores = { runs: aggregates.runs, research: null };
  __setDesktopHostRunApiForTesting(createHostRunApi({ runs: aggregates.runs }));
  createControlPlaneRepository({ stores: aggregates, ...HOST_APPROVAL_API_STUBS });
  createControlPlane({
    repository: createControlPlaneRepository({ stores: aggregates, ...HOST_APPROVAL_API_STUBS }),
    senderConfig: SENDER,
    request: dispatchControlPlaneAction,
  });
});

afterEach(() => {
  __setDesktopHostRunApiForTesting(null);
  _resetControlPlaneForTesting();
  _resetControlPlaneRepositoryForTesting();
  hoisted.stores = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('real route: a healthy run is reported as a success', () => {
  it('tells every consumer completed, and agrees with the row', async () => {
    const surface = desktopSurface();
    const opened = await surface.orchestrator.openRun(SESSION_ID, INTENT);
    expect(opened.accepted, `openRun refused: ${JSON.stringify(opened)}`).toBe(true);
    const runId = opened.runId as string;

    for (const frame of [
      nativeFrame(runId, 2, 'turn.started'),
      nativeFrame(runId, 3, 'assistant.message_finalized'),
      { type: 'chat:text', data: 'Hello from the worker' },
      { type: 'chat:done' },
    ]) {
      normalizeAndObserve(SESSION_ID, frame, surface.deps);
    }
    const terminal = await surface.orchestrator.settleSession(SESSION_ID);
    expect(terminal?.status).toBe('completed');

    // The route a durable consumer reads: `GET /runs/result`.
    const runResult = captureResponse();
    await handleGetRunResult(SESSION_ID, runResult.res, surface.deps);
    expect(runResult.body()['run']).toMatchObject({ runId, status: 'completed' });

    // The delete route's receipt, for a run that had already ended.
    const deleted = captureResponse();
    await handleDeleteChat(SESSION_ID, deleted.res, surface.deps);
    expect((deleted.body()['terminal'] as { status?: string } | undefined)?.status).toBe('completed');

    // And the row, read directly rather than through the API that wrote it.
    expect(rows('SELECT terminal FROM runs WHERE id = ?', runId)[0]?.['terminal']).toBe('completed');
  });
});

describe('the two execution boundaries agree on a payload with no attempt', () => {
  // Both boundaries read the SAME `db:request` payload and both reach the same
  // Host Run API, so a divergence here means one of them is writing unfenced
  // while the other refuses — the exact failure that is invisible until an
  // operator compares two logs from two hosts.
  it('refuse identically on run:append and run:complete', async () => {
    const adapter = createDesktopHostRunApiAdapter({
      appendAgentRunEvents: () => Promise.resolve(1),
      settleAgentRun: () => Promise.resolve({ state: 'applied' }),
    } as never);
    const hostActions = createRunControlPlaneActions({ runs: new RunStore(db) });

    for (const [action, payload] of [
      ['run:append', { runId: 'run-parity', events: [{ runId: 'run-parity', sessionId: SESSION_ID, seq: 2, payload: { type: 'turn.started' } }] }],
      ['run:complete', { runId: 'run-parity', terminal: { status: 'failed', error: { code: 'internal', message: 'x' } } }],
    ] as const) {
      const viaAdapter = (await adapter(action, payload as Record<string, unknown>)) as Record<string, unknown>;
      const viaHost = (await hostActions.dispatchControlPlaneAction(action, payload as Record<string, unknown>)) as Record<string, unknown>;

      // Same verdict state, not merely the same outcome: `invalid` on both.
      expect({ action, adapter: viaAdapter['state'], host: viaHost['state'] }).toEqual({
        action,
        adapter: 'invalid',
        host: 'invalid',
      });
      // And neither reaches the store — the stub's `appendAgentRunEvents` would
      // have answered `applied` had either boundary forwarded the write.
      expect(String(viaAdapter['reason'])).toContain('attempt');
      expect(String(viaHost['reason'])).toContain('attempt');
    }
  });

  it('and the unfenced maintenance path is named the same way on both', async () => {
    // Both boundaries must describe the opt-in identically, or an operator
    // reading one boundary's refusal has no way to write the payload the other
    // one will accept.
    const adapter = createDesktopHostRunApiAdapter({ appendAgentRunEvents: () => Promise.resolve(1) } as never);
    const viaAdapter = (await adapter('run:append', {
      runId: 'run-parity',
      events: [],
      unfenced: { reason: 'repair', authorizedBy: 'ops@example' },
    })) as Record<string, unknown>;
    expect(String(viaAdapter['reason'] ?? '')).toContain('unfenced');
  });
});

describe('real route: a run whose ledger lost an event is not reported as a success', () => {
  it('every consumer is told the durable terminal, and the disagreement is logged', async () => {
    const surface = desktopSurface();
    const opened = await surface.orchestrator.openRun(SESSION_ID, INTENT);
    expect(opened.accepted, `openRun refused: ${JSON.stringify(opened)}`).toBe(true);
    const runId = opened.runId as string;

    // A decoy row at a sequence the worker is about to send, written through
    // the REAL bridge. Different content, same `(run_id, seq)` — so the store
    // refuses the worker's envelope and the run's transcript genuinely loses it.
    //
    // It is seq 5, and seq 5 is the LAST envelope, on purpose. The loss is only
    // recorded when the queued append RESOLVES, and `#finish` drains that queue
    // before it settles — so a loss on an early seq would be visible while the
    // legacy frames are still being translated, the Runtime's own append arm
    // would refuse, and the RUNTIME would degrade itself. That path needs no gate
    // from this Host and would prove nothing about one. Losing the LAST envelope
    // instead lands after every legacy translate and before the terminal commit,
    // which is the case the publication barrier exists for: the Runtime reaches
    // `completed`, and only this Host knows the transcript is short.
    await dbRequestThroughBridge('run:append', {
      runId,
      events: [{ runId, sessionId: SESSION_ID, seq: 5, payload: { type: 'turn.started' } }],
      epoch: 0,
    });

    for (const frame of [
      nativeFrame(runId, 2, 'turn.started'),
      nativeFrame(runId, 3, 'assistant.text_block'),
      nativeFrame(runId, 4, 'assistant.message_finalized'),
      // This one loses: seq 5 already holds a different event.
      nativeFrame(runId, 5, 'assistant.text_block'),
      nativeFrame(runId, 6, 'run.completed'),
    ]) {
      normalizeAndObserve(SESSION_ID, frame, surface.deps);
    }
    // Let the RUNTIME finish every append it owes the durable arm BEFORE the
    // `done` frame starts the settle. This ordering is the whole assertion, and
    // it was found by mutation rather than by reasoning:
    //
    // `persistenceFor.append` refuses once `#nativeLostByRun` is non-zero, and
    // the loss is recorded by `#finish`'s drain. Whichever side lands LAST
    // decides who notices. When the Runtime's own append lands after the drain it
    // degrades ITSELF to `persistence_failed` — the row and its verdict then
    // agree, this Host's publication barrier has nothing left to do, and
    // unwiring it changed nothing any assertion could see. Flushed first, the
    // Runtime reaches `completed` and the terminal THIS HOST commits is
    // `failed`: the disagreement the gate exists to resolve.
    await new Promise((resolve) => setImmediate(resolve));
    normalizeAndObserve(SESSION_ID, { type: 'chat:done' }, surface.deps);
    const settled = await surface.orchestrator.settleSession(SESSION_ID);

    // The settle return value is what the SSE POST path and the non-SSE
    // response report verbatim.
    expect(settled?.status).not.toBe('completed');

    // `GET /runs/result` — the durable consumer's route.
    const runResult = captureResponse();
    await handleGetRunResult(SESSION_ID, runResult.res, surface.deps);
    const run = runResult.body()['run'] as { runId?: string; status?: string } | null;
    expect(run).not.toBeNull();
    expect(run?.status).not.toBe('completed');

    // The delete route's receipt, for the turn the user stopped afterwards.
    const deleted = captureResponse();
    await handleDeleteChat(SESSION_ID, deleted.res, surface.deps);
    const cancelTerminal = deleted.body()['terminal'] as { status?: string } | undefined;
    expect(cancelTerminal?.status).not.toBe('completed');

    // The row, read directly. Every claim above is measured against this.
    const durable = rows('SELECT terminal FROM runs WHERE id = ?', runId)[0]?.['terminal'];
    expect(durable).toBe('failed');
    // ...and the consumers agree with the row, not merely with each other.
    expect(run?.status).toBe(durable);
    expect(cancelTerminal?.status).toBe(durable);

    // ## What this asserts, and what it deliberately does NOT claim
    //
    // It asserts the CONTRACT: every consumer a Desktop client can reach is told
    // the terminal the row holds. It does not claim the consumers were rescued by
    // the publication barrier, because on this surface they were not, and that is
    // a measured result rather than a guess:
    //
    // `#finish` drains the native queue BEFORE `controller.settle`, so
    // `#nativeLostByRun` is always non-zero by the time the Runtime settles. The
    // Runtime emits at least one envelope during settlement, that envelope goes
    // through `persistenceFor.append`, and that arm refuses once the loss counter
    // is non-zero — so the Runtime degrades ITSELF to `persistence_failed` before
    // `persistenceFor.complete` ever runs. `#committedTerminalByRun` is therefore
    // never populated on this composition, and `#durableTerminalFor` has nothing
    // to override. Unwiring the gate changes nothing here; that was measured with
    // a mutation, not assumed.
    //
    // So the gate is currently DEFENSIVE. It is not dead weight: the legacy
    // persistence arm stopped writing rows in 15fa4850 and survives only as this
    // loss signal, so the moment that arm is retired the host's own downgrade is
    // the only thing standing between a short transcript and a reported success.
    // The consumers are asserted against the row either way, which is the property
    // a client actually depends on.
    //
    // Asserted as an EXPLICIT empty: if the gate ever becomes load-bearing here,
    // this line is what says so, and it fails until somebody updates the comment
    // above with the new reachability argument.
    const swap = surface.reported.filter((line) => line.includes('not the verdict the runtime reached'));
    expect(swap).toEqual([]);
  });

  it('refuses a run:event that arrives after its run settled, and keeps nothing for it', async () => {
    // Driven through the REAL tee: `normalizeAndObserve`'s `run:event` branch is
    // the only production caller of `queueNativeRunEvent`, so this is the same
    // hop the worker's stdout takes.
    const surface = desktopSurface();
    const opened = await surface.orchestrator.openRun(SESSION_ID, INTENT);
    expect(opened.accepted).toBe(true);
    const runId = opened.runId as string;

    normalizeAndObserve(SESSION_ID, nativeFrame(runId, 2, 'turn.started'), surface.deps);
    normalizeAndObserve(SESSION_ID, { type: 'chat:done' }, surface.deps);
    await surface.orchestrator.settleSession(SESSION_ID);

    expect(surface.orchestrator.retainedNativeQueues).toBe(0);

    // The worker is still writing: the `done` frame settled the run while lines
    // were in flight, and this session will never run again.
    normalizeAndObserve(SESSION_ID, nativeFrame(runId, 3, 'assistant.text_block'), surface.deps);

    const refusals = surface.reported.filter((line) => line.includes('no live run'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain(`session ${SESSION_ID} has no live run`);
    expect(surface.orchestrator.retainedNativeQueues).toBe(0);
  });
});
