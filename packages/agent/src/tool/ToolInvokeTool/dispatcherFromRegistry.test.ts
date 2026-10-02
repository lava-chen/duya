// Plan 583 / ISS-11: the deferred `tool_invoke` dispatcher must not turn an
// `ask` decision into a silent execution when there is no user to ask.
import { describe, it, expect, vi } from 'vitest';

import { createToolInvokeDispatcherFromRegistry } from './dispatcherFromRegistry.js';
import type { ToolInvokeDispatcherDeps } from './dispatcherFromRegistry.js';
import type { ToolCatalogEntry } from '../catalog-types.js';
import type { ToolSnapshot } from '../snapshot.js';
import type { PermissionMode } from '../../permissions/types.js';

const TOOL_ID = 'deferred-1';
const TOOL_NAME = 'mcp__thirdparty__do_thing';

function makeEntry(): ToolCatalogEntry {
  return {
    toolId: TOOL_ID,
    internalName: TOOL_NAME,
    definition: {
      name: TOOL_NAME,
      description: 'third-party deferred tool',
      input_schema: { type: 'object', properties: {} },
    },
    executor: { execute: vi.fn(async () => 'executed') },
    exposure: 'deferred',
    discovery: { namespace: 'mcp', conciseHint: '', tags: [] },
    source: { kind: 'mcp', id: 'thirdparty' },
    description: 'third-party deferred tool',
    schemaRevision: 'rev-1',
    inputSchema: { type: 'object', properties: {} },
  };
}

function makeDeps(
  mode: PermissionMode | undefined,
  opts: { requestPermission?: boolean } = {},
): { deps: ToolInvokeDispatcherDeps; execute: ReturnType<typeof vi.fn> } {
  const entry = makeEntry();
  const execute = entry.executor.execute as unknown as ReturnType<typeof vi.fn>;

  const registry = {
    getCatalogEntryById: () => entry,
    getOwner: () => 'mcp',
  };

  const toolUseContext = {
    getAppState: () => ({ toolPermissionContext: { mode } }),
    ...(opts.requestPermission
      ? { requestPermission: vi.fn(async () => 'allow' as const) }
      : {}),
  };

  const snapshot = { getCatalogEntry: (id: string) => (id === TOOL_ID ? entry : undefined) };

  return {
    deps: {
      registry: registry as unknown as ToolInvokeDispatcherDeps['registry'],
      getSnapshot: () => snapshot as unknown as ToolSnapshot,
      checkPermission: async () => ({ behavior: 'ask', message: 'needs approval' }),
      contextProvider: () => toolUseContext as never,
    },
    execute,
  };
}

const REQUEST = { tool_id: TOOL_ID, arguments: {} };

describe('tool_invoke dispatcher: ask with no interactive user', () => {
  it('denies rather than executing when the mode wants the user to be asked', async () => {
    for (const mode of ['default', 'auto', 'acceptEdits', 'plan'] as PermissionMode[]) {
      const { deps, execute } = makeDeps(mode);
      const outcome = await createToolInvokeDispatcherFromRegistry(deps).dispatch(REQUEST);

      expect(outcome.error, mode).toBe(true);
      expect(outcome.errorCode, mode).toBe('TOOL_PERMISSION_UNANSWERED');
      expect(execute, mode).not.toHaveBeenCalled();
    }
  });

  it('denies when the mode is unknown instead of guessing consent', async () => {
    const { deps, execute } = makeDeps(undefined);
    const outcome = await createToolInvokeDispatcherFromRegistry(deps).dispatch(REQUEST);

    expect(outcome.error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes in dontAsk, where the user already answered every prompt', async () => {
    const { deps, execute } = makeDeps('dontAsk');
    const outcome = await createToolInvokeDispatcherFromRegistry(deps).dispatch(REQUEST);

    expect(outcome.error).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('executes in bypassPermissions for the same reason', async () => {
    const { deps, execute } = makeDeps('bypassPermissions');
    await createToolInvokeDispatcherFromRegistry(deps).dispatch(REQUEST);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('still prompts normally when a requestPermission hook is present', async () => {
    const { deps, execute } = makeDeps('default', { requestPermission: true });
    const outcome = await createToolInvokeDispatcherFromRegistry(deps).dispatch(REQUEST);

    expect(outcome.error).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not execute when a wired hook answers deny', async () => {
    const { deps, execute } = makeDeps('default', { requestPermission: true });
    const toolUseContext = deps.contextProvider?.();
    (toolUseContext as { requestPermission: unknown }).requestPermission = async () => 'deny' as const;

    const outcome = await createToolInvokeDispatcherFromRegistry(deps).dispatch(REQUEST);

    expect(outcome.error).toBe(true);
    expect(outcome.errorCode).toBe('TOOL_PERMISSION_DENIED');
    expect(execute).not.toHaveBeenCalled();
  });
});
