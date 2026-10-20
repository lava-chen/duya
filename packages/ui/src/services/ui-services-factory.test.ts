import { describe, expect, it, vi } from 'vitest';
import type { AgentRunRecord } from '@duya/agent-protocol';
import type { HostApiBridge } from './host-api.js';
import type { UiPlatformCapabilities, UiStartRunInput } from './ui-services.js';
import { createUiServices } from './ui-services-factory.js';

const CAPABILITIES: UiPlatformCapabilities = {
  localFileAccess: true,
  settings: true,
  extensions: true,
  conductor: true,
  bots: true,
  automation: true,
  workflows: true,
};

function runRow(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    manifest: {} as AgentRunRecord['manifest'],
    manifestHash: 'hash-1',
    inputHash: null,
    status: 'running',
    terminal: null,
    metrics: null,
    origin: null,
    parentRunId: null,
    createdAt: 1_000,
    startedAt: 1_010,
    finishedAt: null,
    ...overrides,
  };
}

/**
 * A bridge whose only interesting method is the one a test names.
 *
 * Everything else refuses, so a test that accidentally reaches an
 * unimplemented operation fails loudly instead of resolving `undefined` and
 * quietly satisfying an assertion.
 */
function createStubBridge(overrides: Partial<HostApiBridge>): HostApiBridge {
  const refuse = (name: string) => async (): Promise<never> => {
    throw new Error(`bridge.${name} was not expected to be called`);
  };
  return {
    listSessions: refuse('listSessions'),
    getSession: refuse('getSession'),
    createSession: refuse('createSession'),
    updateSession: refuse('updateSession'),
    deleteSession: refuse('deleteSession'),
    readMessages: refuse('readMessages'),
    listRuns: refuse('listRuns'),
    startRun: refuse('startRun'),
    cancelRun: refuse('cancelRun'),
    readRunEvents: refuse('readRunEvents'),
    listPendingApprovals: refuse('listPendingApprovals'),
    resolveApproval: refuse('resolveApproval'),
    ...overrides,
  };
}

describe('createUiServices', () => {
  it('projects the Host run row without inventing a field', async () => {
    const listRuns = vi.fn(async () => [runRow()]);
    const services = createUiServices({
      bridge: createStubBridge({ listRuns }),
      platform: 'desktop',
      capabilities: CAPABILITIES,
    });

    const runs = await services.runs.listBySession('session-1');

    expect(runs).toEqual([
      {
        runId: 'run-1',
        sessionId: 'session-1',
        status: 'running',
        createdAt: 1_000,
        startedAt: 1_010,
        finishedAt: null,
      },
    ]);
    // The projection must not smuggle extra fields in: the renderer reads
    // what the Host said, not what the adapter felt like adding.
    expect(Object.keys(runs[0] ?? {}).sort()).toEqual([
      'createdAt',
      'finishedAt',
      'runId',
      'sessionId',
      'startedAt',
      'status',
    ]);
  });

  it('drops a run list that arrives after the selection was abandoned', async () => {
    let release: (rows: AgentRunRecord[]) => void = () => undefined;
    const pending = new Promise<AgentRunRecord[]>((resolve) => {
      release = resolve;
    });
    const listRuns = vi.fn(async () => pending);
    const services = createUiServices({
      bridge: createStubBridge({ listRuns }),
      platform: 'desktop',
      capabilities: CAPABILITIES,
    });

    const controller = new AbortController();
    const inFlight = services.runs.listBySession('session-1', 50, controller.signal);
    // The user switches sessions while the slow history request is still out.
    controller.abort();
    release([runRow()]);

    // The late answer must not be delivered into the new selection.
    expect(await inFlight).toEqual([]);
  });

  it('does not even ask the Host once the selection is already abandoned', async () => {
    const listRuns = vi.fn(async () => [runRow()]);
    const services = createUiServices({
      bridge: createStubBridge({ listRuns }),
      platform: 'desktop',
      capabilities: CAPABILITIES,
    });

    const controller = new AbortController();
    controller.abort();

    expect(await services.runs.listBySession('session-1', 50, controller.signal)).toEqual([]);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('passes the start input through verbatim', async () => {
    // The composer's capabilities travel in the start input. An adapter that
    // rewrote or filtered them would drop the user's attachments, permission
    // mode or agent profile on the way to the Host.
    const startRun = vi.fn(async (_input: UiStartRunInput) => ({
      accepted: true as const,
      stage: 'dispatched' as const,
      runId: 'run-9',
    }));
    const services = createUiServices({
      bridge: createStubBridge({ startRun }),
      platform: 'desktop',
      capabilities: CAPABILITIES,
    });

    const input = {
      sessionId: 'session-1',
      prompt: 'hello',
      model: 'model-x',
      effort: 'high',
      options: { files: [{ id: 'f1' }], permissionModeOverride: 'bypassPermissions' },
    } as never;

    await services.runs.start(input);

    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0]?.[0]).toBe(input);
  });

  it('surfaces the Host refusal instead of swallowing it', async () => {
    const resolveApproval = vi.fn(async () => {
      throw new Error('host said no');
    });
    const services = createUiServices({
      bridge: createStubBridge({ resolveApproval }),
      platform: 'desktop',
      capabilities: CAPABILITIES,
    });

    await expect(
      services.approvals.resolve('req-1', { decision: 'deny' } as never),
    ).rejects.toThrow('host said no');
  });
});
