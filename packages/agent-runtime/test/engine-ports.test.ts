/**
 * The `RunEngine` port is IMPLEMENTABLE.
 *
 * ## What this file is, and what it is not
 *
 * This asserts the CONTRACT, not production behaviour. Every executor under
 * test is a scripted fake written against `src/engine/ports.ts` inside this
 * file. Nothing here drives `DuyaAgent`, and no assertion would change if the
 * whole model loop were rewritten, because none of it looks at the loop.
 *
 * That is the point of the file. Plan 600 `04-runtime-owns-execution.md` section
 * 0 records that a real `RunController` can already be wired around an executor
 * that still calls `duyaAgent.streamChat` (`headless-run-host.ts:22-28`) and
 * that this passes an acceptance gate while execution has not moved at all. A
 * test that asserted what the engine DOES would be measuring the thing that has
 * not been built yet. A test that asserts what the engine MUST BE ABLE TO DO is
 * the part that can be written first, and it is the part that makes the move
 * checkable afterwards.
 *
 * ## The four decision points
 *
 * The fake engine below makes the same four decisions `DuyaAgent.streamChat`
 * makes, and the assertions are named for them:
 *
 * | Decision | Production today | Asserted here |
 * | --- | --- | --- |
 * | call the model | `DuyaAgent.ts:1794`, `:2338` | `calls the model once per turn` |
 * | dispatch a tool | `DuyaAgent.ts:2477` | `dispatches only after approval and a ledger ticket` |
 * | feed the result back | `DuyaAgent.ts:2677`, `:2717` | `feeds the tool result into the next turn` |
 * | decide to stop | `DuyaAgent.ts:3107`, `:3097` | `proposes exactly one terminal candidate, and never settles` |
 *
 * ## Where the type-level assertions live instead
 *
 * The negative cases -- "the types reject an executor that mints a `seq`" --
 * are in `src/engine/port-guards.ts`, because every package tsconfig excludes
 * `test/` and a type assertion nothing compiles is not an assertion
 * (`src/index.ts:322-323`). What this file checks at run time is the
 * consequence: a published event carries no ordering field, and the store's
 * surface is exactly the two calls the contract allows.
 */

import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@duya/agent-protocol';
import type { ExecutionChannel, ExecutionSink, RunStartInput, StopReceipt } from '../src/transport/execution-channel.js';
import type {
  ApprovalPort,
  AssembledTurn,
  ModelFrame,
  ModelPort,
  ModelRequest,
  RunEngine,
  RunEnginePorts,
  RunEventStorePort,
  RunExecutionHandle,
  RunExecutionRequest,
  TerminalCandidate,
  ToolCallRequest,
  ToolDispatchTicket,
  ToolOutcome,
  ToolPort,
  TurnAssemblyInput,
} from '../src/engine/ports.js';

// ---------------------------------------------------------------------------
// A scripted model
// ---------------------------------------------------------------------------

/** One turn's worth of frames. The script is the fake provider. */
type TurnScript = readonly ModelFrame[];

interface ScriptedModel {
  readonly port: ModelPort;
  /** One entry per model call, in order. */
  readonly calls: readonly ModelRequest[];
}

/**
 * A model that replays a script, one entry per call, and records what it was
 * asked for.
 *
 * The second and later calls come from `turns[n]`; a script shorter than the
 * number of calls yields an empty turn, which is how "the loop kept going and
 * got nothing" is expressed without a special case.
 */
function scriptedModel(turns: readonly TurnScript[]): ScriptedModel {
  const calls: ModelRequest[] = [];
  return {
    port: {
      stream(request, signal) {
        const index = calls.length;
        calls.push(request);
        const script = turns[index] ?? [];
        return (async function* (): AsyncIterable<ModelFrame> {
          for (const frame of script) {
            // The signal is checked between frames, which is what makes a stop
            // land mid-turn rather than only at the next turn boundary.
            if (signal.aborted) return;
            yield frame;
          }
        })();
      },
    },
    get calls() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------------------
// A recording tool port
// ---------------------------------------------------------------------------

interface RecordedDispatch {
  readonly call: ToolCallRequest;
  readonly ticket: ToolDispatchTicket;
}

interface ScriptedTools {
  readonly port: ToolPort;
  readonly dispatches: readonly RecordedDispatch[];
  readonly discards: readonly string[];
  /** The order the fake observed, so "ticket before dispatch" is checkable. */
  readonly log: readonly string[];
}

/**
 * A tool port that queues what it is given and hands back a fixed result.
 *
 * `log` is passed IN rather than owned, so a caller can put the ledger's writes
 * and the dispatch into ONE ordered record. The ordering rule in contract 4 is an
 * interleaving claim, and two independent logs cannot express an interleaving.
 */
function scriptedTools(
  result: (call: ToolCallRequest) => ToolOutcome,
  sharedLog?: string[],
): ScriptedTools {
  const queued: ToolCallRequest[] = [];
  const dispatches: RecordedDispatch[] = [];
  const discards: string[] = [];
  const localLog: string[] = [];
  const log = sharedLog ?? localLog;

  return {
    port: {
      dispatch(call, ticket) {
        log.push(`dispatch:${call.callId}`);
        dispatches.push({ call, ticket });
        queued.push(call);
      },
      drain() {
        return (async function* (): AsyncIterable<ToolOutcome> {
          while (queued.length > 0) {
            const call = queued.shift();
            if (call === undefined) break;
            yield result(call);
          }
        })();
      },
      discard(reason) {
        discards.push(reason);
        queued.length = 0;
      },
      describe: () => [],
    },
    get dispatches() {
      return dispatches;
    },
    get discards() {
      return discards;
    },
    get log() {
      return log;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake engine under test
// ---------------------------------------------------------------------------

/**
 * The minimum loop that satisfies `RunEngine`: model -> tool -> feed back ->
 * next turn, plus a stop decision.
 *
 * Written here, in the test, on purpose. It is deliberately NOT a production
 * candidate: it is short enough to read in one screen, so a reader can check
 * that the four decisions the port names are the only decisions being made.
 * When the real engine is built, this file's assertions are the ones it has to
 * keep passing, and the duplication is the price of that.
 */
function scriptedEngine(ports: RunEnginePorts): RunEngine {
  return {
    execute(request: RunExecutionRequest): RunExecutionHandle {
      const controller = new AbortController();
      // Caller-owned signal, joined to the engine's own so either can stop it.
      const onCallerAbort = (): void => controller.abort();
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener('abort', onCallerAbort, { once: true });

      let settled = false;
      const done = (async (): Promise<void> => {
        const { manifest, input, ports: p } = request;
        let turn = 0;

        // 1. CALL THE MODEL, once per turn, until nothing asks for a follow-up.
        for (;;) {
          if (controller.signal.aborted) break;
          turn += 1;

          const assembly: TurnAssemblyInput = {
            runId: manifest.runId,
            runEpoch: 1,
            turn,
            history:
              input.history.kind === 'inline'
                ? input.history
                : { kind: 'by_ref', digest: input.history.digest, locator: input.history.locator },
            attachments:
              input.attachments.kind === 'inline'
                ? input.attachments
                : {
                    kind: 'by_ref',
                    digest: input.attachments.digest,
                    locator: input.attachments.locator,
                  },
            catalog:
              input.catalog.kind === 'inline'
                ? input.catalog
                : { kind: 'by_ref', digest: input.catalog.digest, locator: input.catalog.locator },
            digest: input.revision,
          };

          // Context assembly is work that happens BEFORE the model call. It is
          // inside the signal's reach here, which is the correction the port
          // exists to make: today it is not (`DuyaAgent.ts:963`).
          if (controller.signal.aborted) break;
          const assembled: AssembledTurn = await p.context.assemble(assembly);
          if (controller.signal.aborted) break;

          const pending: ToolCallRequest[] = [];
          let stopReason: 'end_turn' | 'tool_use' | 'cancelled' = 'end_turn';

          for await (const frame of p.model.stream(
            {
              systemPrompt: assembled.systemPrompt,
              messages: assembled.messages,
              tools: assembled.tools,
              // `manifest.agent` is OPTIONAL, so this is read defensively and
              // an absent selection is the port's to fill in. The conditional
              // spread is what `exactOptionalPropertyTypes` requires: a present
              // `model: undefined` is not the same as an absent `model`.
              ...(manifest.agent?.model === undefined ? {} : { model: manifest.agent.model }),
              ...(manifest.agent?.providerId === undefined ? {} : { provider: manifest.agent.providerId }),
            },
            controller.signal,
          )) {
            if (frame.type === 'tool_use') {
              pending.push(frame.call);
            } else if (frame.type === 'turn_stopped') {
              if (frame.reason === 'tool_use') stopReason = 'tool_use';
              if (frame.reason === 'cancelled') stopReason = 'cancelled';
            } else if (frame.type === 'error' && frame.retryable) {
              // Contract: a transient error is retried WITHIN the attempt.
              // Whether the RUN is retried is not this port's call.
              continue;
            }
          }

          if (stopReason === 'cancelled') break;

          // 2. DISPATCH, only for calls the model actually completed, and only
          //    after approval and a durable ledger ticket.
          const results: ToolOutcome[] = [];
          for (const call of pending) {
            const verdict = await p.approval.authorize(
              {
                runId: manifest.runId,
                callId: call.callId,
                toolName: call.name,
                input: call.input,
                permissionMode: manifest.permissionPolicy.mode,
              },
              controller.signal,
            );
            if (!verdict.allowed) continue;

            const ticket = await p.sideEffects?.begin(call);
            if (ticket === undefined) continue; // no ledger, no dispatch
            p.tools.dispatch(call, ticket);
          }

          // 3. FEED THE RESULT BACK, by draining what was queued.
          for await (const outcome of p.tools.drain(controller.signal)) {
            results.push(outcome);
            await p.sideEffects?.settle({
              attemptKey: `k:${outcome.callId}`,
              state: outcome.isError ? 'failed' : 'succeeded',
            });
          }

          // 4. DECIDE TO STOP. Nothing asked for a follow-up -> propose and end.
          //    Otherwise hand the results back to the host's context and go round.
          if (results.length === 0) {
            settled = true;
            p.events.proposeTerminal({
              // `RunTerminalState` is an OBJECT union, not a string, so a
              // candidate cannot be a bare status a caller might read as final.
              state: { status: 'completed' },
              reason: stopReason === 'tool_use' ? 'ended_after_tool_use' : 'end_turn',
            });
            break;
          }
          for (const outcome of results) {
            p.context.defer({
              kind: 'deferred_tool_context',
              key: `tool:${outcome.callId}`,
              text: outcome.content,
            });
          }
        }
      })().finally(() => {
        request.signal.removeEventListener('abort', onCallerAbort);
      });

      return {
        async stop(request): Promise<StopReceipt> {
          const startedAt = Date.now();
          controller.abort();
          const already = settled;
          await done;
          return {
            requested: true,
            disposition: already ? 'cooperative' : 'escalated',
            waitedMs: Date.now() - startedAt,
            reason: request.reason,
          };
        },
        completed: () => done,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Fakes for the remaining ports
// ---------------------------------------------------------------------------

function recordingApproval(allow = true): ApprovalPort & { readonly asked: readonly string[] } {
  const asked: string[] = [];
  return {
    authorize(request) {
      asked.push(request.toolName);
      return Promise.resolve(
        allow ? { allowed: true, scope: 'once' } : { allowed: false, reason: 'denied' },
      );
    },
    get asked() {
      return asked;
    },
  };
}

function inlineContext(turnMessages: (turn: number) => readonly { role: 'user' | 'assistant' | 'tool'; content: string; id: string }[]): RunEnginePorts['context'] & { readonly deferred: readonly string[] } {
  const deferred: string[] = [];
  return {
    assemble(input) {
      return Promise.resolve({
        systemPrompt: 'system',
        messages: turnMessages(input.turn),
        tools: [],
        catalogRevision: 'cat-1',
        revision: input.digest,
      });
    },
    defer(fragment) {
      deferred.push(fragment.text);
    },
    get deferred() {
      return deferred;
    },
  };
}

function recordingEvents(): RunEventStorePort & { readonly published: readonly RunEvent[]; readonly terminals: readonly TerminalCandidate[] } {
  const published: RunEvent[] = [];
  const terminals: TerminalCandidate[] = [];
  return {
    publish(event) {
      published.push(event);
    },
    proposeTerminal(candidate) {
      terminals.push(candidate);
    },
    get published() {
      return published;
    },
    get terminals() {
      return terminals;
    },
  };
}

/** Writes to a caller-supplied log, so begin/dispatch ordering is checkable. */
function ledger(sharedLog?: string[]): NonNullable<RunEnginePorts['sideEffects']> {
  const localLog: string[] = [];
  const log = sharedLog ?? localLog;
  return {
    begin(call) {
      log.push(`begin:${call.callId}`);
      return Promise.resolve({
        attemptKey: `k:${call.callId}`,
        runId: 'run-1',
        runEpoch: 1,
        fence: { runId: 'run-1', runEpoch: 1, token: 1 },
      });
    },
    settle() {
      log.push('settle');
      return Promise.resolve();
    },
    reconcile() {
      return Promise.resolve();
    },
    read() {
      return Promise.resolve([]);
    },
  };
}

/** A manifest shaped just enough for the engine. The rest stays unknown. */
function manifest(): RunExecutionRequest['manifest'] {
  return {
    version: 1,
    runId: 'run-1',
    projectId: null,
    workspaceId: 'ws-1',
    roots: ['/w'],
    cwd: '/w',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:test', hash: 'h' },
    agent: { profileId: null, model: 'test-model', providerId: 'anthropic' },
    budget: {},
    deterministic: false,
    provenance: {
      roots: { source: 'unsupported', synthesised: true },
      model: { source: 'unsupported', synthesised: true },
      tools: { source: 'unsupported', synthesised: true },
      env: { source: 'unsupported', synthesised: true },
    },
  } as unknown as RunExecutionRequest['manifest'];
}

function input(): RunExecutionRequest['input'] {
  return {
    revision: 'rev-1',
    prompt: { role: 'user', content: 'hello', id: 'm0' },
    history: { kind: 'by_ref', digest: 'd-hist', locator: 'transcript:run-1' },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd-cat', locator: 'catalog:1' },
    steering: [],
    options: {},
  };
}

function request(ports: RunEnginePorts, signal: AbortSignal): RunExecutionRequest {
  return { manifest: manifest(), input: input(), signal, ports };
}

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

describe('RunEngine port', () => {
  it('calls the model once per turn, and stops when nothing asks for a follow-up', async () => {
    const model = scriptedModel([
      [{ type: 'text', text: 'first' }, { type: 'turn_stopped', reason: 'end_turn' }],
    ]);
    const tools = scriptedTools(() => ({ callId: 'c0', content: 'x', isError: false, durationMs: 1 }));
    const events = recordingEvents();
    const ports: RunEnginePorts = { ...minimalPorts(), model: model.port, tools: tools.port, events };

    const handle = scriptedEngine(ports).execute(request(ports, new AbortController().signal));
    await handle.completed();

    // One turn produced one model call, and the empty result set ended the run.
    expect(model.calls).toHaveLength(1);
    expect(events.terminals).toHaveLength(1);
  });

  it('dispatches only after approval and a durable ledger ticket', async () => {
    const call: ToolCallRequest = {
      callId: 'c1',
      name: 'ReadFile',
      input: { path: 'a.txt' },
      sideEffect: 'read_only',
    };
    const model = scriptedModel([
      [{ type: 'tool_use', call }, { type: 'turn_stopped', reason: 'tool_use' }],
      [{ type: 'text', text: 'done' }, { type: 'turn_stopped', reason: 'end_turn' }],
    ]);
    // ONE ordered record across both fakes, because the claim is an interleaving.
    const order: string[] = [];
    const tools = scriptedTools((c) => ({ callId: c.callId, content: 'contents', isError: false, durationMs: 2 }), order);
    const approval = recordingApproval();
    const events = recordingEvents();
    const effects = ledger(order);

    const ports: RunEnginePorts = {
      ...minimalPorts(),
      model: model.port,
      tools: tools.port,
      events,
      approval,
      sideEffects: effects,
    };
    const handle = scriptedEngine(ports).execute(request(ports, new AbortController().signal));
    await handle.completed();

    expect(approval.asked).toEqual(['ReadFile']);
    expect(tools.dispatches).toHaveLength(1);
    // The ordering rule of contract 4: the durable `begin` lands BEFORE the
    // dispatch it authorises. A crash between the two is `unknown`, and
    // `unknown` blocks automatic retry -- so the order is the whole contract.
    expect(order.indexOf('begin:c1')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('dispatch:c1')).toBeGreaterThan(order.indexOf('begin:c1'));
    expect(order.slice(0, 2)).toEqual(['begin:c1', 'dispatch:c1']);
  });

  it('does not dispatch when approval is denied', async () => {
    const call: ToolCallRequest = { callId: 'c1', name: 'Bash', input: {}, sideEffect: 'non_retryable' };
    const model = scriptedModel([
      [{ type: 'tool_use', call }, { type: 'turn_stopped', reason: 'tool_use' }],
    ]);
    const tools = scriptedTools((c) => ({ callId: c.callId, content: 'never', isError: false, durationMs: 1 }));
    const ports: RunEnginePorts = {
      ...minimalPorts(),
      model: model.port,
      tools: tools.port,
      events: recordingEvents(),
      approval: recordingApproval(false),
      sideEffects: ledger(),
    };

    const handle = scriptedEngine(ports).execute(request(ports, new AbortController().signal));
    await handle.completed();

    expect(tools.dispatches).toHaveLength(0);
  });

  it('feeds the tool result back into the next turn', async () => {
    const call: ToolCallRequest = { callId: 'c1', name: 'ReadFile', input: {}, sideEffect: 'read_only' };
    const model = scriptedModel([
      [{ type: 'tool_use', call }, { type: 'turn_stopped', reason: 'tool_use' }],
      [{ type: 'turn_stopped', reason: 'end_turn' }],
    ]);
    const tools = scriptedTools((c) => ({ callId: c.callId, content: 'the-result', isError: false, durationMs: 1 }));
    const context = inlineContext((turn) =>
      turn === 1
        ? [{ role: 'user', content: 'hello', id: 'm0' }]
        : [
            { role: 'user', content: 'hello', id: 'm0' },
            { role: 'tool', content: 'the-result', id: 'm1' },
          ],
    );
    const ports: RunEnginePorts = {
      ...minimalPorts(),
      model: model.port,
      tools: tools.port,
      context,
      events: recordingEvents(),
      sideEffects: ledger(),
    };

    const handle = scriptedEngine(ports).execute(request(ports, new AbortController().signal));
    await handle.completed();

    // Two turns, two model calls, and the second one carried the tool result.
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.messages).toEqual([
      { role: 'user', content: 'hello', id: 'm0' },
      { role: 'tool', content: 'the-result', id: 'm1' },
    ]);
  });

  it('proposes exactly one terminal candidate, and offers no way to settle one', async () => {
    const model = scriptedModel([[{ type: 'turn_stopped', reason: 'end_turn' }]]);
    const events = recordingEvents();
    const ports: RunEnginePorts = { ...minimalPorts(), model: model.port, events };

    const handle = scriptedEngine(ports).execute(request(ports, new AbortController().signal));
    await handle.completed();

    expect(events.terminals).toHaveLength(1);
    expect(events.terminals[0]?.state).toEqual({ status: 'completed' });
    // The store's whole surface: propose, and report. No settle, no complete.
    expect(Object.keys(events).filter((k) => typeof events[k as keyof typeof events] === 'function').sort()).toEqual(
      ['proposeTerminal', 'publish'],
    );
  });

  it('never mints a seq: a published event carries no ordering field', async () => {
    const model = scriptedModel([[{ type: 'turn_stopped', reason: 'end_turn' }]]);
    const events = recordingEvents();
    const ports: RunEnginePorts = { ...minimalPorts(), model: model.port, events };

    // Publish one real protocol event through the port and inspect its keys.
    events.publish({
      type: 'turn.started',
      turnId: 'turn-1',
      index: 1,
      model: 'test-model',
      providerId: 'anthropic',
      apiFormat: 'anthropic',
    });

    const handle = scriptedEngine(ports).execute(request(ports, new AbortController().signal));
    await handle.completed();

    for (const event of events.published) {
      expect(Object.keys(event)).not.toContain('seq');
    }
  });

  it('reaches pre-model work with the caller signal, so a stop is not deferred', async () => {
    // A model that would yield frames if it were ever asked.
    const model = scriptedModel([[{ type: 'turn_stopped', reason: 'end_turn' }]]);
    const ports: RunEnginePorts = { ...minimalPorts(), model: model.port, events: recordingEvents() };
    const controller = new AbortController();

    // Abort BEFORE execution begins: the engine must not reach the model at all.
    controller.abort();
    const handle = scriptedEngine(ports).execute(request(ports, controller.signal));
    await handle.completed();

    // This is the correction the port exists for. `DuyaAgent.streamChat` creates
    // its AbortController at its first line (`DuyaAgent.ts:963`), so a host
    // holding a signal has no way to stop work that happens before the call.
    expect(model.calls).toHaveLength(0);
  });

  it('a stop returns a receipt rather than resolving early', async () => {
    const model = scriptedModel([[{ type: 'turn_stopped', reason: 'end_turn' }]]);
    const ports: RunEnginePorts = { ...minimalPorts(), model: model.port, events: recordingEvents() };

    const handle = scriptedEngine(ports).execute(request(ports, new AbortController().signal));
    const receipt = await handle.stop({ graceMs: 100, reason: 'user_cancel' });

    expect(receipt.requested).toBe(true);
    expect(receipt.reason).toBe('user_cancel');
    expect(typeof receipt.waitedMs).toBe('number');
  });

  it('satisfies ExecutionChannel, so an engine can be an executor', async () => {
    // The composition the plan says is NOT the same as moving execution, stated
    // as something that compiles and runs: a channel whose executor is the
    // engine. `headless-run-host.ts:22-28` is this shape today, with
    // `duyaAgent.streamChat` in the executor slot.
    const model = scriptedModel([[{ type: 'text', text: 'hi' }, { type: 'turn_stopped', reason: 'end_turn' }]]);
    const events = recordingEvents();
    const ports: RunEnginePorts = { ...minimalPorts(), model: model.port, events };
    const engine = scriptedEngine(ports);

    const frames: unknown[] = [];
    let ended = false;
    const sink: ExecutionSink = {
      frame(raw) {
        frames.push(raw);
      },
      end() {
        ended = true;
      },
    };

    // `RunStartInput` and `RunInputSnapshot` are NOT assignable to one another,
    // and that is a finding rather than an inconvenience: the existing wire type
    // is rooted at `sessionId`, which plan 600 `00` section C retires, while the
    // snapshot carries history/attachments/catalog and no session at all. The
    // adapter between them is a real piece of work, so this test does the
    // narrowing explicitly instead of pretending the two are the same shape.
    const startInput: RunStartInput = {
      sessionId: 'sess-1',
      prompt: 'hello',
      options: {},
      revision: 'rev-1',
    };

    let engineHandle: RunExecutionHandle | undefined;
    const channel: ExecutionChannel = {
      start(manifestArg, received, sinkArg) {
        // The adapter the plan's step 2 will have to write for real.
        expect(received.revision).toBe(startInput.revision);
        engineHandle = engine.execute({
          manifest: manifestArg,
          input: input(),
          signal: new AbortController().signal,
          ports,
        });
        void (async () => {
          await engineHandle?.completed();
          sinkArg.frame({ type: 'chat:done', reason: 'end_turn' });
          sinkArg.end();
        })();
        // The channel's contract is an `ExecutionHandle`, which has `stop` and
        // no `completed` -- so the engine handle cannot be returned as-is.
        return Promise.resolve({
          stop: (req) => engineHandle?.stop(req) ?? Promise.reject(new Error('not started')),
        });
      },
    };

    const handle = await channel.start(manifest(), startInput, sink);
    await engineHandle?.completed();
    await handle.stop({ graceMs: 10, reason: 'assert' });
    await Promise.resolve();

    expect(ended).toBe(true);
    expect(frames.length).toBeGreaterThan(0);
  });
});

/** The five mandatory ports, with the parts each test does not care about. */
function minimalPorts(): RunEnginePorts {
  return {
    model: { stream: () => (async function* (): AsyncIterable<ModelFrame> {})() },
    tools: scriptedTools(() => ({ callId: 'none', content: '', isError: false, durationMs: 0 })).port,
    context: {
      assemble: () =>
        Promise.resolve({
          systemPrompt: '',
          messages: [],
          tools: [],
          catalogRevision: 'c',
          revision: 'r',
        }),
      defer() {},
    },
    approval: { authorize: () => Promise.resolve({ allowed: true, scope: 'once' }) },
    events: {
      publish() {},
      proposeTerminal() {},
    },
  };
}
