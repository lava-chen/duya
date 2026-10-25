import { describe, expect, it, vi } from 'vitest';
import { RunEngineImpl } from '../../../src/engine/run-engine.js';
import { ToolRegistry } from '../../../src/tools/catalog/registry.js';
import type {
  RuntimeToolDefinition,
  RuntimeToolResult,
  ToolExecutor,
} from '../../../src/tools/catalog/registry.js';
import { StreamingToolExecutor } from '../../../src/tools/execution/StreamingToolExecutor.js';
import type {
  AssembledTurn,
  ModelFrame,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunInputSnapshot,
  ToolCallRequest,
  ToolDrainItem,
  ToolResultRecord,
} from '../../../src/engine/ports.js';
import type { RunId, RunManifest, ToolCallId } from '@duya/agent-protocol';
import type {
  MessageUpdate,
  ToolExecutionMessage,
  ToolExecutionRegistry,
} from '../../../src/tools/execution/contracts.js';
import type { ToolExecutionPorts } from '../../../src/tools/execution/ports.js';
import { ToolExecutionPipeline } from '../../../src/tools/execution/ToolExecutionPipeline.js';

interface ExecutionContext {
  abortController: AbortController;
  workingDirectory: string;
  sessionId: string;
  appState: { approvedInvocations: Record<string, boolean> };
}

type TestExecutor = ToolExecutor<ExecutionContext>;
type TestRegistry = ToolRegistry<RuntimeToolDefinition, RuntimeToolResult, ExecutionContext, TestExecutor>;

const definition = (name: string): RuntimeToolDefinition => ({
  name,
  description: `${name} test tool`,
  input_schema: { type: 'object', properties: {} },
});

function makeContext(): ExecutionContext {
  return {
    abortController: new AbortController(),
    workingDirectory: '/workspace',
    sessionId: 'session-test',
    appState: { approvedInvocations: {} },
  };
}

function makeExecutor(
  registry: TestRegistry,
  context: ExecutionContext,
  options: {
    requestPermission?: ToolExecutionPorts<ExecutionContext>['requestPermission'];
    canUseTool?: (toolName: string, input?: Record<string, unknown>, invocationId?: string) => Promise<boolean>;
  } = {},
): StreamingToolExecutor<ExecutionContext> {
  const ports: ToolExecutionPorts<ExecutionContext> = {
    readSession: (current) => ({
      abortController: current.abortController,
      workingDirectory: current.workingDirectory,
      sessionId: current.sessionId,
    }),
    getAppState: (current) => current.appState,
    isInvocationApproved: (current, invocationId) =>
      current.appState.approvedInvocations[invocationId] === true,
    markInvocationApproved: (current, invocationId) => {
      current.appState.approvedInvocations[invocationId] = true;
    },
    createToolContext: (current, input) => ({ ...current, ...input }),
    ...(options.requestPermission ? { requestPermission: options.requestPermission } : {}),
  };

  return new StreamingToolExecutor(
    registry as unknown as ToolExecutionRegistry,
    options.canUseTool ?? (async () => true),
    context,
    { enableRetry: false, maxExecutionTimeMs: 2_000 },
    ports,
  );
}

async function drain(executor: StreamingToolExecutor<ExecutionContext>): Promise<MessageUpdate<ExecutionContext>[]> {
  const updates: MessageUpdate<ExecutionContext>[] = [];
  for await (const update of executor.getRemainingResults()) updates.push(update);
  return updates;
}

function makeRunManifest(): RunManifest {
  return {
    version: 1,
    runId: 'runtime-tool-execution-test' as RunId,
    projectId: null,
    workspaceId: 'workspace-test',
    roots: ['/workspace'],
    cwd: '/workspace',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 2_000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:test', hash: 'empty' },
    agent: { profileId: null, model: 'test-model', providerId: 'test-provider' },
    budget: {},
    deterministic: false,
    provenance: {
      roots: { source: 'unsupported', synthesised: true },
      cwd: { source: 'unsupported', synthesised: true },
      permissionPolicy: { source: 'unsupported', synthesised: true },
      capabilities: { source: 'unsupported', synthesised: true },
      connectorBindings: { source: 'unsupported', synthesised: true },
      env: { source: 'unsupported', synthesised: true },
      agent: { source: 'unsupported', synthesised: true },
      budget: { source: 'unsupported', synthesised: true },
      workspaceId: { source: 'unsupported', synthesised: true },
      deterministic: { source: 'unsupported', synthesised: true },
    },
  } as RunManifest;
}

function makeRunInput(): RunInputSnapshot {
  return {
    revision: 'input-revision-1',
    prompt: { role: 'user', id: 'prompt-1', content: 'Read the test value, then report it.' },
    history: { kind: 'inline', value: [] },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'catalog-revision-1', locator: 'catalog://test' },
    steering: [],
    options: {},
  };
}

function terminalMessage(
  updates: MessageUpdate<ExecutionContext>[],
  toolCallId: string,
): ToolExecutionMessage | undefined {
  return updates.find((update) => update.message?.tool_call_id === toolCallId)?.message;
}

describe('Runtime streaming tool execution', () => {
  it('runs the actual engine -> pipeline -> executor -> next model turn path', async () => {
    const registry: TestRegistry = new ToolRegistry();
    registry.register(definition('read'), {
      execute: async () => ({ id: 'read-result', name: 'read', result: 'durable-value' }),
    });
    const executionContext = makeContext();
    const executionPorts: ToolExecutionPorts<ExecutionContext> = {
      readSession: (current) => ({
        abortController: current.abortController,
        workingDirectory: current.workingDirectory,
        sessionId: current.sessionId,
      }),
      getAppState: (current) => current.appState,
      isInvocationApproved: (current, invocationId) =>
        current.appState.approvedInvocations[invocationId] === true,
      markInvocationApproved: (current, invocationId) => {
        current.appState.approvedInvocations[invocationId] = true;
      },
      createToolContext: (current, input) => ({ ...current, ...input }),
    };

    const modelRequests: ModelRequest[] = [];
    const toolRecords: ToolResultRecord[] = [];
    const events: unknown[] = [];
    let modelTurn = 0;
    let currentPipeline: ToolExecutionPipeline<ExecutionContext> | undefined;
    const model: ModelPort = {
      async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
        modelRequests.push(request);
        modelTurn += 1;
        if (modelTurn === 1) {
          yield {
            type: 'tool_use',
            call: {
              callId: 'engine-read-call' as ToolCallId,
              name: 'read',
              input: { path: 'facts.txt' },
              sideEffect: 'read_only',
            },
          };
          yield { type: 'turn_stopped', reason: 'end_turn' };
          return;
        }
        yield { type: 'text', text: 'The previous tool result was received.' };
        yield { type: 'turn_stopped', reason: 'end_turn' };
      },
    };

    const toolPort: RunEnginePorts['tools'] = {
      dispatch(call: ToolCallRequest): void {
        if (!currentPipeline) throw new Error('tool dispatched before turn assembly');
        currentPipeline.addTool({
          id: call.callId,
          name: call.name,
          input: call.input,
        });
      },
      async *drain(): AsyncIterable<ToolDrainItem> {
        if (!currentPipeline) throw new Error('tool drain before turn assembly');
        const activePipeline = currentPipeline;
        try {
          for await (const update of activePipeline.getRemainingResults()) {
            const message = update.message;
            if (message?.role !== 'tool' || message.tool_call_id === undefined) continue;
            yield {
              kind: 'tool_result',
              callId: message.tool_call_id as ToolCallId,
              content: typeof message.content === 'string'
                ? message.content
                : message.content.map((block) => block.type === 'text' ? block.text : '').join(''),
              isError: message.status === 'error',
              durationMs: message.duration_ms ?? 0,
            };
          }
        } finally {
          activePipeline.dispose();
          if (currentPipeline === activePipeline) currentPipeline = undefined;
        }
      },
      discard(): void {
        currentPipeline?.discard();
      },
      describe: () => registry.getAllTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
      })),
    };

    const runPorts: RunEnginePorts = {
      model,
      tools: toolPort,
      context: {
        async assemble(): Promise<AssembledTurn> {
          currentPipeline = new ToolExecutionPipeline(
            registry as unknown as ToolExecutionRegistry,
            async () => true,
            executionContext,
            { enableRetry: false, maxExecutionTimeMs: 2_000 },
            executionPorts,
          );
          return {
            systemPrompt: 'test',
            messages: [],
            tools: toolPort.describe(),
            catalogRevision: 'catalog-revision-1',
            revision: 'input-revision-1',
          };
        },
        defer: () => {},
      },
      approval: { authorize: async () => ({ allowed: true, scope: 'once' }) },
      events: {
        publish: (event) => events.push(event),
        proposeTerminal: (candidate) => events.push(candidate),
      },
      turnOutput: {
        recordToolResult: async (record) => { toolRecords.push(record); },
        recordAssistantMessage: async () => {},
        finishTurn: async () => {},
        recordInjectedMessage: async () => {},
      },
      compaction: {
        decide: async () => ({ kind: 'skip', reason: 'not under test' }),
        run: async () => ({ kind: 'declined', reason: 'not under test' }),
        nextCompactionId: () => 'compaction-test',
      },
      interTurn: {
        sweep: async () => ({ decision: { action: 'continue', absorbed: false }, injected: [] }),
      },
      modeExit: { onRunExit: async () => {} },
    };

    const controller = new AbortController();
    const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
    const handle = engine.execute({
      manifest: makeRunManifest(),
      input: makeRunInput(),
      signal: controller.signal,
      ports: runPorts,
    });
    await handle.completed();

    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[0]?.messages.map((message) => message.id)).toEqual(['prompt-1']);
    expect(modelRequests[1]?.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        id: 'fragment:tool_result:engine-read-call',
        content: expect.stringContaining('[completed] read\ndurable-value'),
      }),
    ]);
    expect(toolRecords).toHaveLength(1);
    expect(toolRecords[0]?.outcome).toMatchObject({
      kind: 'tool_result',
      callId: 'engine-read-call',
      content: expect.stringContaining('durable-value'),
      isError: false,
    });
    expect(modelRequests[1]?.messages[0]?.content).toContain('durable-value');
  });

  it('surfaces tool failures as paired tool-result messages', async () => {
    const registry: TestRegistry = new ToolRegistry();
    const context = makeContext();
    registry.register(definition('read'), {
      execute: async () => { throw new Error('disk unavailable'); },
    });

    const executor = makeExecutor(registry, context);
    executor.addTool({ id: 'failed-call', name: 'read', input: {} });
    const updates = await drain(executor);
    executor.dispose();

    expect(terminalMessage(updates, 'failed-call')).toMatchObject({
      role: 'tool',
      status: 'error',
    });
    expect(terminalMessage(updates, 'failed-call')?.content).toContain('disk unavailable');
  });

  it('states success on a completed call, not just the absence of an error', async () => {
    const registry: TestRegistry = new ToolRegistry();
    registry.register(definition('read'), {
      execute: async () => ({ id: 'read-result', name: 'read', result: 'ok' }),
    });

    const executor = makeExecutor(registry, makeContext());
    executor.addTool({ id: 'ok-call', name: 'read', input: {} });
    const updates = await drain(executor);
    executor.dispose();

    // A result with no stated status reaches the drain as `indeterminate`, and
    // the transcript paints `?` on a call that plainly succeeded.
    expect(terminalMessage(updates, 'ok-call')).toMatchObject({
      role: 'tool',
      status: 'success',
    });
  });

  it('binds approval to the stable invocation id and does not execute while approval is paused', async () => {
    const registry: TestRegistry = new ToolRegistry();
    const context = makeContext();
    const requestPermission = vi.fn(async () => 'allow' as const);
    const checkPermissions = vi.fn(() => ({
      allowed: true,
      requiresUserConfirmation: true,
      reason: 'writes a protected file',
    }));
    const execute = vi.fn(async () => ({ id: 'protected-result', name: 'write', result: 'written' }));
    registry.register(definition('write'), Object.assign({ execute }, { checkPermissions }));

    const permissionExecutor = makeExecutor(registry, context, { requestPermission });
    permissionExecutor.addTool({ id: 'approved-call', name: 'write', input: { path: 'secret.txt' } });
    const approvedUpdates = await drain(permissionExecutor);
    permissionExecutor.dispose();

    expect(requestPermission).toHaveBeenCalledWith(context, expect.objectContaining({ id: 'approved-call' }));
    expect(context.appState.approvedInvocations['approved-call']).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(terminalMessage(approvedUpdates, 'approved-call')?.content).toContain('written');
    expect(terminalMessage(approvedUpdates, 'approved-call')?.status).toBe('success');

    const pausedRegistry: TestRegistry = new ToolRegistry();
    const pausedExecute = vi.fn(async () => ({ id: 'should-not-run', name: 'write', result: 'unexpected' }));
    pausedRegistry.register(
      definition('write'),
      Object.assign({ execute: pausedExecute }, { checkPermissions }),
    );
    const pausedContext = makeContext();
    const pausedPermission = vi.fn(async () => 'paused' as const);
    const pausedExecutor = makeExecutor(pausedRegistry, pausedContext, { requestPermission: pausedPermission });
    pausedExecutor.addTool({ id: 'paused-call', name: 'write', input: { path: 'secret.txt' } });
    const pausedUpdates = await drain(pausedExecutor);
    pausedExecutor.dispose();

    expect(pausedPermission).toHaveBeenCalledWith(pausedContext, expect.objectContaining({ id: 'paused-call' }));
    expect(pausedExecute).not.toHaveBeenCalled();
    expect(terminalMessage(pausedUpdates, 'paused-call')?.content).toContain('Waiting for user approval');
  });

  it('emits a terminal cancellation result when the run aborts an active call', async () => {
    const registry: TestRegistry = new ToolRegistry();
    const context = makeContext();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    registry.register(definition('read'), {
      execute: async (_input, _cwd, toolContext) => {
        markStarted();
        return await new Promise<RuntimeToolResult>((_resolve, reject) => {
          const signal = toolContext!.abortController.signal;
          const rejectAbort = () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal.aborted) rejectAbort();
          else signal.addEventListener('abort', rejectAbort, { once: true });
        });
      },
    });

    const executor = makeExecutor(registry, context);
    executor.addTool({ id: 'cancelled-call', name: 'read', input: {} });
    const draining = drain(executor);
    await started;
    context.abortController.abort('user interrupted');
    const updates = await draining;
    executor.dispose();

    expect(terminalMessage(updates, 'cancelled-call')).toMatchObject({ role: 'tool', status: 'error' });
    expect(terminalMessage(updates, 'cancelled-call')?.content).toContain('interrupted by user');
  });
});
