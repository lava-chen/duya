/**
 * Plan 616 §C9 — `source: 'app'` must not borrow `bundled`'s short-circuit.
 *
 * ## The two gates
 *
 * MCP tools are checked TWICE, by two different pieces of code:
 *
 *   1. the UNIFIED gate — `hasPermissionsToUseTool` — runs the whole
 *      chain (user rules, risk tiers, the catastrophic check, the host
 *      standing switch, the mode bypass, the classifier). It is reached
 *      through `canUseTool`, which the streaming executor calls BEFORE it
 *      executes a tool, and which the deferred `tool_invoke` dispatcher
 *      calls before it dispatches.
 *   2. the SOURCE gate — `decideMcpSource` — answers one question only:
 *      does this tool's PROVENANCE settle the matter? `bundled` and
 *      `settings` are trusted outright; `plugin` / `local` / `unknown`
 *      are never silently approved; `app` has no verdict at all.
 *
 * ## What `app` must NOT do
 *
 * `bundled` short-circuits to `allow` in the unified gate's step 0, which
 * means the catastrophic check, the host standing switch and the risk
 * tiers never run. The app layer cannot borrow that: `duya_app` owns the
 * tools that message users, schedule routines and drive the browser, and
 * moving them behind a namespace is only worth anything if they KEEP
 * their checks. So `app` returns NO verdict from the source gate, and the
 * unified chain decides it exactly as it decided these tools before they
 * were namespaced.
 *
 * ## Which gate actually enforces
 *
 * Measured, not assumed: the unified gate's step 0 only fires when the
 * caller supplies `context.source`, and the host wiring does NOT — so in
 * production the SOURCE GATE IS ENFORCED BY THE MCP EXECUTOR
 * (`tools/mcp-executor.ts`), which receives the provenance per tool from
 * the registry. These tests pin both halves: the unified chain must not
 * short-circuit for `app`, and the executor must still demand approval
 * for a third-party tool whose name collides with one of ours.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createHasPermissionsToUseTool as createEvaluatorImpl,
  decideMcpSource,
} from '../../src/authorization/permissions/permissions.js';
import { buildPermissions } from '../../src/authorization/permission-gate.js';
import { createMCPToolExecutor } from '../../src/tools/mcp-executor.js';
import { ToolRegistry } from '../../src/tools/catalog/registry.js';
import type {
  McpToolSource,
  PermissionMode,
  ToolPermissionContext,
} from '../../src/authorization/permissions/types.js';
import type { ToolPermissionCheckContext } from '../../src/authorization/permissions/permissions.js';
import type { AppToolRegistration } from '@duya/capabilities/AppServer/app-tool-namespace';

/** A canvas tool of ours, under the name the allocator produces. */
const APP_CANVAS = 'mcp_duya_app_canvas_manage';
/** A tool that is NOT unconditionally allowed, so the chain has work to do. */
const APP_UPDATE_STATE = 'mcp_duya_app_update_state';

const APP_REGISTRATION: AppToolRegistration = {
  serverName: 'duya_app',
  toolName: 'canvas_manage',
  source: 'app',
};

function makeContext(
  mode: PermissionMode = 'default',
  options: {
    source?: McpToolSource;
    hostToolPermission?: 'ask' | 'always' | 'never';
    riskTier?: 'read' | 'draft' | 'write' | 'modify' | 'destructive';
    alwaysDenyRules?: Record<string, string[]>;
    alwaysAskRules?: Record<string, string[]>;
    alwaysAllowRules?: Record<string, string[]>;
    registrations?: Record<string, AppToolRegistration>;
  } = {},
): ToolPermissionCheckContext {
  const ctx: ToolPermissionContext = {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: options.alwaysAllowRules ?? {},
    alwaysDenyRules: options.alwaysDenyRules ?? {},
    alwaysAskRules: options.alwaysAskRules ?? {},
    isBypassPermissionsModeAvailable: false,
    ...(options.hostToolPermission === undefined
      ? {}
      : { hostToolPermission: options.hostToolPermission }),
    ...(options.riskTier === undefined
      ? {}
      : { getToolRiskTier: () => options.riskTier }),
  };
  return {
    getAppState: () => ({ toolPermissionContext: ctx }),
    abortController: new AbortController(),
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.registrations === undefined
      ? {}
      : { resolveAppToolRegistration: (name: string) => options.registrations?.[name] }),
  };
}

function createEvaluator() {
  return createEvaluatorImpl({
    getConnectorDescriptors: () => [],
    isSessionApproved: () => false,
    renderConnectorApproval: (descriptor) => descriptor.name,
    getPermissionPrescreener: () => null,
    warn: () => {},
  });
}

describe('the source gate gives the app layer no verdict of its own', () => {
  it('returns no decision for the app source', () => {
    // `undefined` is the answer: "this provenance carries no verdict —
    // keep going". It is NOT an allow (that would skip the checks) and
    // NOT an ask (that would prompt for our own tools).
    expect(decideMcpSource('app', 'default', APP_CANVAS)).toBeUndefined();
    expect(decideMcpSource('app', undefined, APP_CANVAS)).toBeUndefined();
  });

  it('returns no decision for the app source even in a bypass mode', () => {
    // The mode short-circuit belongs to the unified chain, which the app
    // source must reach — not to the source gate.
    expect(decideMcpSource('app', 'bypassPermissions', APP_CANVAS)).toBeUndefined();
    expect(decideMcpSource('app', 'dontAsk', APP_CANVAS)).toBeUndefined();
  });

  it('still trusts bundled and settings outright', () => {
    expect(decideMcpSource('bundled', 'default', 'mcp__x__y')?.behavior).toBe('allow');
    expect(decideMcpSource('settings', 'default', 'mcp__x__y')?.behavior).toBe('allow');
  });

  it('still asks for every third-party provenance', () => {
    for (const source of ['plugin', 'local', 'unknown'] as const) {
      expect(decideMcpSource(source, 'default', 'mcp__x__y')?.behavior).toBe('ask');
    }
  });
});

describe('the app source does not skip the unified chain', () => {
  it('still applies the host standing switch', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      APP_UPDATE_STATE,
      {},
      makeContext('default', { source: 'app', hostToolPermission: 'never' }),
    );
    expect(decision.behavior).toBe('deny');
  });

  it('is denied by a user deny rule', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      APP_UPDATE_STATE,
      {},
      makeContext('default', {
        source: 'app',
        alwaysDenyRules: { userSettings: ['mcp_duya_app_update_state'] },
      }),
    );
    expect(decision.behavior).toBe('deny');
  });

  it('is asked for by a user ask rule', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      APP_UPDATE_STATE,
      {},
      makeContext('default', {
        source: 'app',
        alwaysAskRules: { userSettings: ['update_state'] },
      }),
    );
    expect(decision.behavior).toBe('ask');
  });

  it('is still gated by its risk tier', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      APP_UPDATE_STATE,
      {},
      makeContext('default', { source: 'app', riskTier: 'write' }),
    );
    expect(decision.behavior).toBe('ask');
  });

  it('is allowed by a user allow rule', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      APP_UPDATE_STATE,
      {},
      makeContext('default', {
        source: 'app',
        alwaysAllowRules: { userSettings: ['mcp_duya_app_update_state'] },
      }),
    );
    expect(decision.behavior).toBe('allow');
  });

  it('is NOT the bundled short-circuit — the same rules do not apply to bundled', async () => {
    // The contrast that makes the point: `bundled` short-circuits at
    // step 0 and therefore ignores the host switch, the rules and the
    // risk tier. `app` must not behave that way.
    const evaluate = createEvaluator();
    const bundled = await evaluate(
      APP_UPDATE_STATE,
      {},
      makeContext('default', { source: 'bundled', hostToolPermission: 'never' }),
    );
    expect(bundled.behavior).toBe('allow');

    const app = await evaluate(
      APP_UPDATE_STATE,
      {},
      makeContext('default', { source: 'app', hostToolPermission: 'never' }),
    );
    expect(app.behavior).toBe('deny');
  });

  it('keeps the app layer own canvas shortcut, which is an identity decision', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      APP_CANVAS,
      {},
      makeContext('default', { source: 'app', registrations: { [APP_CANVAS]: APP_REGISTRATION } }),
    );
    expect(decision.behavior).toBe('allow');
  });
});

describe('the source verdict is enforced by the MCP executor', () => {
  function harness(source: McpToolSource) {
    const requestPermission = vi.fn(async () => 'allow' as const);
    const invoke = vi.fn(async () => ({ id: 'r', name: APP_CANVAS, result: 'ok' }));
    const executor = createMCPToolExecutor<Record<string, unknown>>({
      toolName: APP_CANVAS,
      source,
      invoke,
      ports: {
        getToolUseId: () => 'call-1',
        getPermissionMode: () => 'default',
        getAppState: () => ({}),
        requestPermission: (_ctx, request) => requestPermission(request),
      },
    });
    return { executor, requestPermission, invoke };
  }

  it.each(['plugin', 'local', 'unknown'] as const)(
    'still demands approval for a %s tool whose name collides with ours',
    async (source) => {
      // The name is identical to one of ours — that must not buy the
      // third-party tool the app layer's trust.
      const h = harness(source);
      const result = await h.executor.execute({}, undefined, {});
      expect(h.requestPermission).toHaveBeenCalledTimes(1);
      expect(h.invoke).toHaveBeenCalledTimes(1);
      expect(result.error).toBeUndefined();
    },
  );

  it('denies a third-party tool when the user says no', async () => {
    const requestPermission = vi.fn(async () => 'deny' as const);
    const invoke = vi.fn();
    const executor = createMCPToolExecutor<Record<string, unknown>>({
      toolName: APP_CANVAS,
      source: 'plugin',
      invoke: invoke as never,
      ports: {
        getToolUseId: () => 'call-1',
        getPermissionMode: () => 'default',
        getAppState: () => ({}),
        requestPermission: () => requestPermission(),
      },
    });
    const result = await executor.execute({}, undefined, {});
    expect(invoke).not.toHaveBeenCalled();
    expect(result.error).toBe(true);
  });

  it('adds no second verdict for the app source', async () => {
    // The unified chain has already run by the time the executor is
    // reached, so the source gate must not prompt again.
    const h = harness('app');
    const result = await h.executor.execute({}, undefined, {});
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(result.error).toBeUndefined();
  });
});

describe('the host wires the registry identity into the permission chain', () => {
  function buildWith(definition: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    mcpInfo?: { serverName: string; toolName: string; source: McpToolSource };
  }) {
    const registry = new ToolRegistry();
    registry.registerWithKey(
      `mcp__${definition.mcpInfo?.serverName ?? 'x'}__${definition.mcpInfo?.toolName ?? 'y'}`,
      definition,
      { execute: async () => ({ id: 'r', name: definition.name, result: 'ok' }) },
      'mcp',
    );
    const built = buildPermissions(
      {
        warn: () => {},
        getPermissionMode: () => 'default',
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        additionalWorkingDirectories: new Map(),
        getAbortController: () => new AbortController(),
        llmClient: {} as never,
        model: 'test-model',
        getMessages: () => [],
        hasPermissionsToUseTool: createEvaluator(),
        getModeCoordinator: () => undefined,
      },
      { workingDirectory: null, approval: { alwaysAllowTools: new Set() } },
      registry,
    );
    return built;
  }

  it('lets the app layer own canvas tool keep its unconditional allow', async () => {
    const built = buildWith({
      name: APP_CANVAS,
      description: 'canvas',
      input_schema: { type: 'object', properties: {} },
      mcpInfo: { serverName: 'duya_app', toolName: 'canvas_manage', source: 'app' },
    });
    const decision = await built.canUseTool(APP_CANVAS, {});
    expect(decision.behavior).toBe('allow');
  });

  it('refuses that allow to a third-party tool registered under the same visible name', async () => {
    const built = buildWith({
      name: APP_CANVAS,
      description: 'canvas',
      input_schema: { type: 'object', properties: {} },
      mcpInfo: { serverName: 'duya', toolName: 'app_canvas_manage', source: 'plugin' },
    });
    const decision = await built.canUseTool(APP_CANVAS, {});
    expect(decision.behavior).not.toBe('allow');
  });

  it('does not put a source on the unified chain context', () => {
    // Measured fact, pinned: the host wiring supplies no `source`, so the
    // unified gate's step 0 does not fire in production and the source
    // verdict is enforced by the MCP executor instead. If this ever
    // changes, the executor tests above stop being the whole story and
    // this assertion is the place to notice.
    const built = buildWith({
      name: APP_CANVAS,
      description: 'canvas',
      input_schema: { type: 'object', properties: {} },
      mcpInfo: { serverName: 'duya_app', toolName: 'canvas_manage', source: 'app' },
    });
    expect(built.permissionContext.source).toBeUndefined();
  });
});
