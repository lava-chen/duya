/**
 * Plan 600 S1a — the runId-keyed command boundary.
 *
 * ## What these tests are for
 *
 * `run-routing.ts` makes one seam explicit: who resolves a `runId` to an
 * addressable executor, and what happens when it cannot. Before it, three call
 * sites each read a `sessionId` that a caller had to supply, and the runtime's
 * own contract (`RunStartInput.sessionId`) demanded the key from everyone —
 * including `InProcessTransport`, which answered with `''`.
 *
 * The properties worth proving are all about the *resolution*, so each test
 * compares two DIFFERENT sources. A test that compared the router's output to a
 * copy of the router's own input would pass with the resolution deleted.
 *
 * ## The properties
 *
 * 1. A command in by `runId` reaches the host addressed by the session the
 *    table holds — and the `runId` the host sees is the manifest's, not a
 *    restatement of the route.
 * 2. A run with no route is REFUSED and the host is never called. This is the
 *    behaviour the empty-session fabrication cannot produce.
 * 3. A session with a live run cannot be rebound, and neither can a live run.
 * 4. `stop` resolves the same route `start` bound, and reports `unavailable`
 *    without touching the host when there is none — a stop nobody answered is
 *    not a stop that worked.
 * 5. The revision on the wire is the PROTOCOL's own digest over the values the
 *    router resolved, recomputed here through the same exported function.
 * 6. The explicit context reaches the host verbatim, attachment payloads cannot
 *    be expressed, and absence is an empty array rather than a lookup.
 *
 * ## Why no Desktop import
 *
 * This is a `managed: true` module. The production call site is
 * `apps/desktop/src/main/agents/server/run-orchestrator.ts`, and importing it
 * here would add a reverse edge to move no code. The host binding below is the
 * same structural shape `WorkerExecutionBinding` has, so adopting the router is
 * a signature swap rather than a reimplementation.
 */

import { describe, expect, it } from 'vitest';
import type {
  PermissionPolicyMode,
  RunId,
  RunManifest,
  SessionId,
  StopDisposition,
} from '@duya/agent-protocol';
import { runInputRevision } from '@duya/agent-protocol';
import { ExecutionDispatchError } from '../src/transport/execution-channel.js';
import {
  RunCommandRouter,
  RunRouteConflictError,
  RunRouteTable,
  foldRunContext,
  type RunDispatchCommand,
  type RunDispatchTarget,
  type RunStartContext,
} from '../src/transport/run-routing.js';

const RUN_ID = 'run-routing-1' as RunId;
const SESSION_ID = 'session-routing-1' as SessionId;

/** A real manifest, built field by field. It carries NO sessionId. */
function manifestFor(runId: RunId): RunManifest {
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: 'ws-1',
    roots: [],
    cwd: '/repo',
    permissionPolicy: {
      mode: 'default' as PermissionPolicyMode,
      hostSwitch: 'ask',
      defaultTimeoutMs: 300_000,
    },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:workspace-1', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    budget: { maxTurns: 8 },
    deterministic: false,
  };
}

function contextFor(prompt = 'run the script'): RunStartContext {
  return {
    prompt,
    options: { language: 'en' },
    history: [],
    attachments: [],
    workspace: { cwd: '/repo', workspaceId: 'ws-1' },
  };
}

/** What the host actually observed. The only place a dispatched id comes from. */
interface HostObservation {
  readonly targets: RunDispatchTarget[];
  readonly commands: RunDispatchCommand[];
  readonly interrupts: { target: RunDispatchTarget; graceMs: number; reason: string }[];
}

/**
 * The host binding, structurally the same shape as the production
 * `WorkerExecutionBinding`: address a resolved target, and stop one.
 */
interface HostBinding {
  readonly routes: RunRouteTable;
  readonly dispatch: (target: RunDispatchTarget, command: RunDispatchCommand) => boolean;
  readonly interrupt: (
    target: RunDispatchTarget,
    graceMs: number,
    reason: string,
  ) => { accepted: boolean; settled: Promise<StopDisposition> } | null;
}

function host(options: {
  readonly accept?: boolean;
  readonly interrupt?: StopDisposition | null;
} = {}): { binding: HostBinding; seen: HostObservation } {
  const accept = options.accept ?? true;
  const disposition = options.interrupt === undefined ? 'cooperative' : options.interrupt;
  const seen: {
    targets: RunDispatchTarget[];
    commands: RunDispatchCommand[];
    interrupts: HostObservation['interrupts'];
  } = { targets: [], commands: [], interrupts: [] };
  return {
    binding: {
      routes: new RunRouteTable(),
      dispatch: (target, command) => {
        seen.targets.push(target);
        seen.commands.push(command);
        return accept;
      },
      interrupt: (target, graceMs, reason) => {
        seen.interrupts.push({ target, graceMs, reason });
        if (disposition === null) return null;
        return { accepted: true, settled: Promise.resolve(disposition) };
      },
    },
    seen,
  };
}

function routed(): { router: RunCommandRouter; routes: RunRouteTable; seen: HostObservation } {
  const harness = host();
  return { router: new RunCommandRouter(harness.binding), routes: harness.binding.routes, seen: harness.seen };
}

describe('RunRouteTable', () => {
  it('resolves a run to the session it was bound to, from the other direction', () => {
    const routes = new RunRouteTable();
    routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });

    // The two sides are read through different accessors on purpose: if `bind`
    // wrote only one map, a reverse-only lookup would still pass a
    // one-directional test.
    expect(routes.sessionFor(RUN_ID)).toBe(SESSION_ID);
    expect(routes.runFor(SESSION_ID)).toBe(RUN_ID);
    expect(routes.size).toBe(1);
  });

  it('refuses to rebind a live run, so a run cannot straddle two executors', () => {
    const routes = new RunRouteTable();
    routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });

    expect(() => routes.bind({ runId: RUN_ID, sessionId: 'session-other' as SessionId })).toThrow(
      RunRouteConflictError,
    );
    // The original binding must survive the refusal, not be half-overwritten.
    expect(routes.sessionFor(RUN_ID)).toBe(SESSION_ID);
    expect(routes.size).toBe(1);
  });

  it('refuses a second live run on one session, matching the host guard', () => {
    const routes = new RunRouteTable();
    routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });

    expect(() =>
      routes.bind({ runId: 'run-routing-2' as RunId, sessionId: SESSION_ID }),
    ).toThrow(/already has live run/);
    expect(routes.runFor(SESSION_ID)).toBe(RUN_ID);
    expect(routes.size).toBe(1);
  });

  it('reports an unroutable run as unroutable rather than as an empty session', () => {
    const routes = new RunRouteTable();
    // `''` is the value `InProcessTransport` fabricates. It must not be
    // reachable through this table, and a miss must be `null` — not a string
    // that a caller could forward to a worker lookup.
    expect(routes.sessionFor('run-never-bound' as RunId)).toBeNull();
    expect(routes.sessionFor(RUN_ID)).toBeNull();
  });

  it('releases a route idempotently, because settle and crash recovery both call it', () => {
    const routes = new RunRouteTable();
    routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });

    expect(routes.release(RUN_ID)).toBe(true);
    expect(routes.release(RUN_ID)).toBe(false);
    expect(routes.sessionFor(RUN_ID)).toBeNull();
    // The reverse entry must go too, or the session would stay busy forever
    // after its only run ended.
    expect(routes.runFor(SESSION_ID)).toBeNull();
    expect(routes.size).toBe(0);
  });
});

describe('RunCommandRouter.start', () => {
  it('addresses the host with the session the table holds and the run id the manifest carries', () => {
    const { router, routes, seen } = routed();
    routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });
    const manifest = manifestFor(RUN_ID);

    const receipt = router.start(manifest, contextFor());

    // Source 1: what the HOST observed. Source 2: the manifest and the binding.
    // Comparing the router's own inputs to its own output would prove nothing.
    expect(seen.targets).toHaveLength(1);
    expect(seen.targets[0]?.runId).toBe(manifest.runId);
    expect(seen.targets[0]?.sessionId).toBe(SESSION_ID);
    expect(receipt.sessionId).toBe(SESSION_ID);
    expect(receipt.runId).toBe(manifest.runId);
  });

  it('resolves a second run on a second session without the first one bleeding in', () => {
    const { router, routes, seen } = routed();
    const secondRun = 'run-routing-2' as RunId;
    const secondSession = 'session-routing-2' as SessionId;
    routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });
    routes.bind({ runId: secondRun, sessionId: secondSession });

    router.start(manifestFor(RUN_ID), contextFor('first'));
    router.start(manifestFor(secondRun), contextFor('second'));

    // Addressed by the manifest's id, so the order of the calls cannot decide
    // which session each run lands on.
    expect(seen.targets.map((target) => [target.runId, target.sessionId])).toEqual([
      [RUN_ID, SESSION_ID],
      [secondRun, secondSession],
    ]);
    expect(seen.commands.map((command) => command.prompt)).toEqual(['first', 'second']);
  });

  it('refuses an unroutable run and never calls the host', () => {
    const { router, seen } = routed();
    // Nothing bound: the run has no executor.
    expect(() => router.start(manifestFor(RUN_ID), contextFor())).toThrow(ExecutionDispatchError);
    expect(seen.targets).toHaveLength(0);
    expect(seen.commands).toHaveLength(0);
  });

  it('refuses a released run, so a settled run cannot be dispatched again', () => {
    const { router, routes, seen } = routed();
    routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });
    routes.release(RUN_ID);

    expect(() => router.start(manifestFor(RUN_ID), contextFor())).toThrow(/no executor route/);
    expect(seen.targets).toHaveLength(0);
  });

  it('reports a host refusal as a refusal, not as a started run', () => {
    const harness = host({ accept: false });
    const router = new RunCommandRouter(harness.binding);
    harness.binding.routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });

    // The host was reached and said no. Reporting a receipt here would be a run
    // row for work that never started.
    expect(() => router.start(manifestFor(RUN_ID), contextFor())).toThrow(/accepted the run/);
    expect(harness.seen.targets).toHaveLength(1);
  });
});

describe('RunCommandRouter.stop', () => {
  it('stops the executor the run actually started on', async () => {
    const { router, routes, seen } = routed();
    routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });
    router.start(manifestFor(RUN_ID), contextFor());

    const receipt = await router.stop(RUN_ID, { graceMs: 500, reason: 'user cancelled' });

    expect(seen.interrupts).toHaveLength(1);
    expect(seen.interrupts[0]?.target.sessionId).toBe(SESSION_ID);
    expect(seen.interrupts[0]?.target.runId).toBe(RUN_ID);
    expect(seen.interrupts[0]?.graceMs).toBe(500);
    expect(receipt.disposition).toBe('cooperative');
    expect(receipt.requested).toBe(true);
  });

  it('reports `unavailable` for a run with no route, and does not call the host', async () => {
    const { router, seen } = routed();
    const receipt = await router.stop(RUN_ID, { graceMs: 500, reason: 'user cancelled' });

    // "We stopped waiting" and "it stopped cleanly" are different claims. A stop
    // for an unroutable run touched nothing, and the host must not be asked to
    // stop a session this run never used.
    expect(receipt.disposition).toBe('unavailable');
    expect(receipt.requested).toBe(false);
    expect(receipt.reason).toBe('user cancelled');
    expect(seen.interrupts).toHaveLength(0);
  });

  it('passes a host-reported escalation through instead of flattening it', async () => {
    const harness = host({ interrupt: 'escalated' });
    const router = new RunCommandRouter(harness.binding);
    harness.binding.routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });

    const receipt = await router.stop(RUN_ID, { graceMs: 10, reason: 'deadline' });

    expect(receipt.disposition).toBe('escalated');
  });

  it('reports `unavailable` when the host has nothing to stop', async () => {
    const harness = host({ interrupt: null });
    const router = new RunCommandRouter(harness.binding);
    harness.binding.routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });

    const receipt = await router.stop(RUN_ID, { graceMs: 10, reason: 'deadline' });

    expect(receipt.disposition).toBe('unavailable');
    expect(harness.seen.interrupts).toHaveLength(1);
  });
});

describe('the revision the router puts on the wire', () => {
  it('is the protocol digest over the session the router RESOLVED', () => {
    const { router, routes, seen } = routed();
    routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });
    const context = contextFor('run the script');

    router.start(manifestFor(RUN_ID), context);

    // Recomputed here through the same exported protocol function, from the
    // session the TABLE holds and the options the router FOLDED. If the router
    // hashed a caller-supplied session instead, or hashed the unfolded options,
    // this would not be the same string.
    const expected = runInputRevision({
      sessionId: SESSION_ID,
      prompt: context.prompt,
      options: foldRunContext(context),
    });
    expect(seen.commands[0]?.revision).toBe(expected);
    expect(seen.commands[0]?.revision).not.toBe('');
  });

  it('changes when the resolved session changes, so two sessions never share a revision', () => {
    const harness = host();
    const router = new RunCommandRouter(harness.binding);
    harness.binding.routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });

    router.start(manifestFor(RUN_ID), contextFor('same prompt'));
    const first = harness.seen.commands[0]?.revision;

    harness.binding.routes.release(RUN_ID);
    harness.binding.routes.bind({
      runId: 'run-routing-3' as RunId,
      sessionId: 'session-routing-3' as SessionId,
    });
    router.start(manifestFor('run-routing-3' as RunId), contextFor('same prompt'));
    const second = harness.seen.commands[1]?.revision;

    // Identical prompt and options; the digest still has to separate them,
    // because the session decides which worker carries the turn.
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });
});

describe('the explicit run context', () => {
  it('reaches the host verbatim, with history and workspace stated rather than looked up', () => {
    const { router, routes, seen } = routed();
    routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });
    const context: RunStartContext = {
      prompt: 'summarise this',
      options: { language: 'zh' },
      history: [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'second' },
      ],
      attachments: [{ id: 'file-1', name: 'a.png', type: 'image/png', url: 'file:///a.png' }],
      workspace: { cwd: '/repo/sub', workspaceId: 'ws-9' },
    };

    router.start(manifestFor(RUN_ID), context);

    const folded = foldRunContext(context);
    expect(seen.commands[0]?.prompt).toBe('summarise this');
    // Compared against a value derived from the context the CALLER built, not
    // from the router's own output.
    expect(seen.commands[0]?.options['history']).toEqual(folded['history']);
    expect(seen.commands[0]?.options['workspaceContext']).toEqual({
      cwd: '/repo/sub',
      workspaceId: 'ws-9',
    });
    expect(seen.commands[0]?.options['language']).toBe('zh');
  });

  it('cannot express an attachment payload, so the run layer cannot hold one', () => {
    const options = foldRunContext({
      prompt: 'p',
      options: {},
      history: [],
      attachments: [{ id: 'file-1', name: 'a.png' }],
      workspace: { cwd: '/repo', workspaceId: null },
    });

    const files = options['files'] as readonly Record<string, unknown>[];
    expect(files).toHaveLength(1);
    // `RunAttachmentRef` has no payload field, so there is nowhere for one to
    // come from. The digest therefore sees a reference, which is the contract.
    expect(Object.keys(files[0] ?? {}).sort()).toEqual(['id', 'name']);
    expect(JSON.stringify(options)).not.toContain('base64');
  });

  it('treats an absent history and an empty one as the same stated fact, not a lookup', () => {
    const { router, routes, seen } = routed();
    routes.bind({ runId: RUN_ID, sessionId: SESSION_ID });

    router.start(manifestFor(RUN_ID), contextFor('p'));

    // There is no lookup dependency on the router at all, so an empty history
    // can only mean "none was supplied". The folded shape is what proves it:
    // an empty array, not an absent key and not a filled-in one.
    expect(seen.commands[0]?.options['history']).toEqual([]);
    expect(seen.commands[0]?.options['files']).toEqual([]);
  });
});
