/**
 * Plan 616 — the app namespace must survive the REGISTRY's spelling too.
 *
 * ## Why there is a second spelling
 *
 * The registry stores MCP tools under their internal key
 * (`mcp__duya_app__update_state`) and shows the model the model-visible
 * name (`mcp_duya_app_update_state`). The permission chain is called with
 * BOTH:
 *
 *   - the streaming executor holds the model-visible name — it is the
 *     name the model typed;
 *   - the deferred `tool_invoke` dispatcher holds the registry's internal
 *     key — it is the name the catalog entry is stored under
 *     (`tools/discovery/dispatcherFromRegistry.ts`).
 *
 * The rules know NEITHER. A user writes `update_state` (the original
 * name) or `mcp_duya_app_update_state` (the name they saw in the
 * transcript); neither is `mcp__duya_app__update_state`.
 *
 * ## What used to break
 *
 * Name resolution only understood the model-visible spelling, so on the
 * deferred path:
 *
 *   - the always-allowed set stopped applying — the tool asked instead
 *     of running, for a tool that is unconditionally allowed;
 *   - a deny rule written against the original name stopped firing — the
 *     rule looked present in the settings UI and protected nothing.
 *
 * Both are silent: the call is not rejected, it is merely decided by a
 * different (weaker) rule.
 *
 * ## What this pins
 *
 * The decision is the same whichever spelling the caller holds. The
 * unconditional allows still require PROOF of ownership (the host
 * registration), so an internal key that merely claims the namespace
 * earns nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  createHasPermissionsToUseTool as createEvaluatorImpl,
  getRuleByContentsForToolName,
} from '../../src/authorization/permissions/permissions.js';
import { buildPermissions } from '../../src/authorization/permission-gate.js';
import { ToolRegistry } from '../../src/tools/catalog/registry.js';
import type {
  PermissionMode,
  ToolPermissionContext,
} from '../../src/authorization/permissions/types.js';
import type { ToolPermissionCheckContext } from '../../src/authorization/permissions/permissions.js';
import type { AppToolRegistration } from '@duya/capabilities/AppServer/app-tool-namespace';

/** The model-visible spelling — the name the model types. */
const VISIBLE = 'mcp_duya_app_update_state';
/** The registry's storage spelling — the name the deferred path holds. */
const INTERNAL = 'mcp__duya_app__update_state';

/** An always-allowed app tool, under both spellings. */
const ALWAYS_VISIBLE = 'mcp_duya_app_MessageSession';
const ALWAYS_INTERNAL = 'mcp__duya_app__MessageSession';

/** The canvas short-circuit's tool, under both spellings. */
const CANVAS_VISIBLE = 'mcp_duya_app_canvas_manage';
const CANVAS_INTERNAL = 'mcp__duya_app__canvas_manage';

const UPDATE_STATE_REGISTRATION: AppToolRegistration = {
  serverName: 'duya_app',
  toolName: 'update_state',
  source: 'app',
};

const SESSION_REGISTRATION: AppToolRegistration = {
  serverName: 'duya_app',
  toolName: 'MessageSession',
  source: 'app',
};

const CANVAS_REGISTRATION: AppToolRegistration = {
  serverName: 'duya_app',
  toolName: 'canvas_manage',
  source: 'app',
};

/**
 * A third-party server named `duya` exposing `app_update_state`. The
 * allocator folds `__` into `_`, so it is allocated the very same
 * model-visible name as our own tool (plan 616 §C16). Its registration
 * is not ours.
 */
const IMPOSTOR_REGISTRATION: AppToolRegistration = {
  serverName: 'duya',
  toolName: 'app_update_state',
  source: 'plugin',
};

function makeContext(
  mode: PermissionMode = 'default',
  rules: {
    alwaysAllowRules?: Record<string, string[]>;
    alwaysDenyRules?: Record<string, string[]>;
    alwaysAskRules?: Record<string, string[]>;
  } = {},
  registrations?: Record<string, AppToolRegistration>,
): ToolPermissionCheckContext {
  const ctx: ToolPermissionContext = {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: rules.alwaysAllowRules ?? {},
    alwaysDenyRules: rules.alwaysDenyRules ?? {},
    alwaysAskRules: rules.alwaysAskRules ?? {},
    isBypassPermissionsModeAvailable: false,
  };
  return {
    getAppState: () => ({ toolPermissionContext: ctx }),
    abortController: new AbortController(),
    ...(registrations === undefined
      ? {}
      : { resolveAppToolRegistration: (name: string) => registrations[name] }),
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

/** The registration lookup answers for BOTH spellings, as the registry does. */
function registrationsFor(
  visible: string,
  internal: string,
  registration: AppToolRegistration,
): Record<string, AppToolRegistration> {
  return { [visible]: registration, [internal]: registration };
}

describe('the deferred path decides the same as the direct path', () => {
  it('applies the always-allowed set under the internal key', async () => {
    // `MessageSession` is unconditionally allowed. Addressed by the
    // registry's internal key it must still be — otherwise the same tool
    // asks on one path and runs on the other.
    const evaluate = createEvaluator();
    const decision = await evaluate(
      ALWAYS_INTERNAL,
      {},
      makeContext('default', {}, registrationsFor(ALWAYS_VISIBLE, ALWAYS_INTERNAL, SESSION_REGISTRATION)),
    );
    expect(decision.behavior).toBe('allow');
  });

  it('keeps the canvas short-circuit under the internal key', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      CANVAS_INTERNAL,
      {},
      makeContext('default', {}, registrationsFor(CANVAS_VISIBLE, CANVAS_INTERNAL, CANVAS_REGISTRATION)),
    );
    expect(decision.behavior).toBe('allow');
  });

  it('fires a deny rule written against the original name', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      INTERNAL,
      {},
      makeContext(
        'default',
        { alwaysDenyRules: { userSettings: ['update_state'] } },
        registrationsFor(VISIBLE, INTERNAL, UPDATE_STATE_REGISTRATION),
      ),
    );
    expect(decision.behavior).toBe('deny');
  });

  it('fires a deny rule written against the model-visible name', async () => {
    // The rule the user actually typed: the name they saw in the
    // transcript. It must hold on the deferred path too.
    const evaluate = createEvaluator();
    const decision = await evaluate(
      INTERNAL,
      {},
      makeContext(
        'default',
        { alwaysDenyRules: { userSettings: ['mcp_duya_app_update_state'] } },
        registrationsFor(VISIBLE, INTERNAL, UPDATE_STATE_REGISTRATION),
      ),
    );
    expect(decision.behavior).toBe('deny');
  });

  it('fires an ask rule written against either spelling', async () => {
    // The mode is `bypassPermissions` on purpose: it is the only way to
    // tell "the ask rule fired" from "the chain fell through to its
    // final fallback and asked anyway". Without the rule matching, the
    // bypass mode would allow the call outright.
    const evaluate = createEvaluator();
    for (const spelling of ['update_state', 'mcp_duya_app_update_state']) {
      const decision = await evaluate(
        INTERNAL,
        {},
        makeContext(
          'bypassPermissions',
          { alwaysAskRules: { userSettings: [spelling] } },
          registrationsFor(VISIBLE, INTERNAL, UPDATE_STATE_REGISTRATION),
        ),
      );
      expect(decision.behavior).toBe('ask');
    }
  });

  it('fires an allow rule written against either spelling', async () => {
    const evaluate = createEvaluator();
    for (const spelling of ['update_state', 'mcp_duya_app_update_state']) {
      const decision = await evaluate(
        INTERNAL,
        {},
        makeContext(
          'default',
          { alwaysAllowRules: { userSettings: [spelling] } },
          registrationsFor(VISIBLE, INTERNAL, UPDATE_STATE_REGISTRATION),
        ),
      );
      expect(decision.behavior).toBe('allow');
    }
  });

  it('resolves a content rule under the internal key', async () => {
    // A rule that carries CONTENT is not a plain tool rule: it has its
    // own lookup (`getRuleByContentsForToolName`), and that path must
    // resolve the tool the same way or a rule like
    // `update_state(secret)` stops matching the moment the tool is
    // addressed by its internal key.
    for (const spelling of ['update_state(secret)', 'mcp_duya_app_update_state(secret)']) {
      const rules = getRuleByContentsForToolName(
        {
          mode: 'default',
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: { userSettings: [spelling] },
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: false,
        },
        INTERNAL,
        'deny',
      );
      expect(rules.get('secret')).toBeDefined();
    }
  });

  it('does not let a content rule become a plain tool rule', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      INTERNAL,
      {},
      makeContext(
        'default',
        { alwaysDenyRules: { userSettings: ['update_state(secret)'] } },
        registrationsFor(VISIBLE, INTERNAL, UPDATE_STATE_REGISTRATION),
      ),
    );
    expect(decision.behavior).not.toBe('deny');
  });
});

describe('the internal key earns no unconditional allow on its own', () => {
  it('refuses the always-allowed set to an internal key with no registration', async () => {
    // The internal key CLAIMS the app namespace, so with no proof of
    // ownership the full chain decides — exactly as for the visible
    // spelling.
    const evaluate = createEvaluator();
    const decision = await evaluate(ALWAYS_INTERNAL, {}, makeContext('default'));
    expect(decision.behavior).not.toBe('allow');
  });

  it('refuses the always-allowed set to an internal key registered to somebody else', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      ALWAYS_INTERNAL,
      {},
      makeContext(
        'default',
        {},
        registrationsFor(ALWAYS_VISIBLE, ALWAYS_INTERNAL, {
          serverName: 'duya',
          toolName: 'app_MessageSession',
          source: 'plugin',
        }),
      ),
    );
    expect(decision.behavior).not.toBe('allow');
  });

  it('refuses the canvas short-circuit to an internal key registered to somebody else', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      CANVAS_INTERNAL,
      {},
      makeContext('default', {}, registrationsFor(CANVAS_VISIBLE, CANVAS_INTERNAL, IMPOSTOR_REGISTRATION)),
    );
    expect(decision.behavior).not.toBe('allow');
  });
});

describe('the host registry answers for both spellings', () => {
  function buildWith(mcpInfo: { serverName: string; toolName: string; source: 'app' | 'plugin' }) {
    const registry = new ToolRegistry();
    const definition = {
      name: `mcp_${mcpInfo.serverName}_${mcpInfo.toolName}`,
      description: 'app tool',
      input_schema: { type: 'object', properties: {} },
      mcpInfo,
    };
    registry.registerWithKey(
      `mcp__${mcpInfo.serverName}__${mcpInfo.toolName}`,
      definition,
      { execute: async () => ({ id: 'r', name: definition.name, result: 'ok' }) },
      'mcp',
    );
    return buildPermissions(
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
  }

  it('keeps the app layer own canvas tool allowed under the internal key', async () => {
    const built = buildWith({ serverName: 'duya_app', toolName: 'canvas_manage', source: 'app' });
    const decision = await built.canUseTool(CANVAS_INTERNAL, {});
    expect(decision.behavior).toBe('allow');
  });

  it('refuses that allow to a third-party tool under the internal key', async () => {
    const built = buildWith({ serverName: 'duya', toolName: 'app_canvas_manage', source: 'plugin' });
    const decision = await built.canUseTool('mcp__duya__app_canvas_manage', {});
    expect(decision.behavior).not.toBe('allow');
  });
});
