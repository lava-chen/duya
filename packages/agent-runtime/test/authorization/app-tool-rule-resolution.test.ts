/**
 * Plan 616 C3–C5 — the rules must survive the `duya_app` namespace.
 *
 * The `duya_app` server's tools reach the model under a namespaced name
 * (`mcp_duya_app_canvas_manage`). Every rule that refers to them is
 * written against the ORIGINAL name (`canvas_manage`): the canvas
 * permission short-circuit, the always-allowed set, the agent profiles'
 * `canvas:*` patterns, the exact-name deny rules.
 *
 * If the rules matched the visible name instead, the namespace would be a
 * hole in the permission model rather than a naming detail — a profile
 * that denies `canvas:*` would stop denying the canvas tools the moment
 * they moved behind the prefix.
 *
 * But matching the original name ALONE is not enough either. A rule names
 * a tool by ONE of its two spellings, and which one it uses is not
 * something the rule can know: a rule written before the migration says
 * `canvas_manage`, a rule written after it says the visible name the user
 * actually sees in the transcript. Both must apply — so the matcher tries
 * BOTH spellings.
 *
 * These tests pin the resolution at both layers: the permission decision
 * (`hasPermissionsToUseTool`) and the visibility filter (`isToolVisible`).
 */

import { describe, expect, it } from 'vitest';

import { createHasPermissionsToUseTool as createEvaluatorImpl, getRuleByContentsForToolName } from '../../src/authorization/permissions/permissions.js';
import { isToolVisible } from '../../src/authorization/tool-filter.js';
import type {
  McpToolSource,
  PermissionMode,
  ToolPermissionContext,
} from '../../src/authorization/permissions/types.js';
import type { ToolPermissionCheckContext } from '../../src/authorization/permissions/permissions.js';
import type { AppToolRegistration } from '@duya/capabilities/AppServer/app-tool-namespace';

/** The model-visible name the shared allocator produces for a canvas tool. */
const NAMESPACED = 'mcp_duya_app_canvas_manage';
/** A bot tool that is always allowed by name. */
const NAMESPACED_ALWAYS_ALLOWED = 'mcp_duya_app_MessageSession';
/** An app tool that is NOT unconditionally allowed, so a deny rule can bite. */
const NAMESPACED_DENYABLE = 'mcp_duya_app_update_state';

/** The registration the HOST records for the app layer's own canvas tool. */
const APP_CANVAS_REGISTRATION: AppToolRegistration = {
  serverName: 'duya_app',
  toolName: 'canvas_manage',
  source: 'app',
};

/**
 * A third-party server named `duya` that happens to expose a tool called
 * `app_canvas_manage`. The shared allocator folds `__` into `_`, so it is
 * allocated the very same model-visible name as our own canvas tool
 * (plan 616 §C16). Its registration is NOT ours.
 */
const IMPOSTOR_CANVAS_REGISTRATION: AppToolRegistration = {
  serverName: 'duya',
  toolName: 'app_canvas_manage',
  source: 'plugin',
};

function makeContext(
  mode: PermissionMode = 'default',
  rules: {
    alwaysAllowRules?: Record<string, string[]>;
    alwaysDenyRules?: Record<string, string[]>;
    alwaysAskRules?: Record<string, string[]>;
  } = {},
  options: {
    source?: McpToolSource;
    registrations?: Record<string, AppToolRegistration>;
  } = {},
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

describe('the duya_app namespace does not defeat the permission rules', () => {
  it('keeps the canvas short-circuit under the namespaced name', async () => {
    // The short-circuit is earned by IDENTITY: the host registered this
    // tool under the app server with the `app` provenance.
    const evaluate = createEvaluator();
    const decision = await evaluate(
      NAMESPACED,
      {},
      makeContext('default', {}, { registrations: { [NAMESPACED]: APP_CANVAS_REGISTRATION } }),
    );
    expect(decision.behavior).toBe('allow');
  });

  it('keeps the always-allowed set under the namespaced name', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      NAMESPACED_ALWAYS_ALLOWED,
      {},
      makeContext('default', {}, {
        registrations: {
          [NAMESPACED_ALWAYS_ALLOWED]: {
            serverName: 'duya_app',
            toolName: 'MessageSession',
            source: 'app',
          },
        },
      }),
    );
    expect(decision.behavior).toBe('allow');
  });

  it('still honours an exact deny rule written against the original name', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      NAMESPACED_DENYABLE,
      {},
      makeContext('default', {
        alwaysDenyRules: { userSettings: ['update_state'] },
      }),
    );
    expect(decision.behavior).toBe('deny');
  });

  it('honours an exact deny rule written against the full visible name', async () => {
    // The rule the user actually typed: the name they saw in the
    // transcript. Before the bidirectional match this rule silently
    // matched nothing — it looked present in the settings UI and
    // protected nothing.
    const evaluate = createEvaluator();
    const decision = await evaluate(
      NAMESPACED_DENYABLE,
      {},
      makeContext('default', {
        alwaysDenyRules: { userSettings: ['mcp_duya_app_update_state'] },
      }),
    );
    expect(decision.behavior).toBe('deny');
  });

  it('honours an exact ask rule written against either spelling', async () => {
    const evaluate = createEvaluator();
    for (const spelling of ['update_state', 'mcp_duya_app_update_state']) {
      const decision = await evaluate(
        NAMESPACED_DENYABLE,
        {},
        makeContext('default', {
          alwaysAskRules: { userSettings: [spelling] },
        }),
      );
      expect(decision.behavior).toBe('ask');
    }
  });

  it('honours an allow rule written against either spelling', async () => {
    const evaluate = createEvaluator();
    for (const spelling of ['update_state', 'mcp_duya_app_update_state']) {
      const decision = await evaluate(
        NAMESPACED_DENYABLE,
        {},
        makeContext('default', {
          alwaysAllowRules: { userSettings: [spelling] },
        }),
      );
      expect(decision.behavior).toBe('allow');
    }
  });

  it('honours a content rule written against either spelling', async () => {
    // A rule that carries CONTENT is not a plain tool rule: `toolMatchesRule`
    // deliberately refuses it, and the content rules have their own lookup
    // (`getRuleByContentsForToolName`). That path must resolve the tool the
    // same way, or a rule like `update_state(secret)` would stop matching
    // the moment the tool was namespaced.
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
        NAMESPACED_DENYABLE,
        'deny',
      );
      expect(rules.get('secret')).toBeDefined();
    }
  });

  it('does not let a content rule become a plain tool rule', async () => {
    // The content rule must NOT deny every call to the tool: the content is
    // the point. The plain tool rule is the one that does that.
    const evaluate = createEvaluator();
    const decision = await evaluate(
      NAMESPACED_DENYABLE,
      {},
      makeContext('default', {
        alwaysDenyRules: { userSettings: ['update_state(secret)'] },
      }),
    );
    expect(decision.behavior).not.toBe('deny');
  });

  it('keeps the canvas short-circuit ahead of the user rules, as before', async () => {
    // The canvas tools are unconditionally allowed BY DESIGN — the
    // short-circuit sits above the user rules, and a deny rule for a
    // canvas tool does not override it. That ordering predates the
    // namespace; the point of this test is that the namespace did not
    // move it.
    const evaluate = createEvaluator();
    const decision = await evaluate(
      NAMESPACED,
      {},
      makeContext(
        'default',
        { alwaysDenyRules: { userSettings: ['canvas_manage'] } },
        { registrations: { [NAMESPACED]: APP_CANVAS_REGISTRATION } },
      ),
    );
    expect(decision.behavior).toBe('allow');
  });

  it('leaves a non-app tool alone', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate('some_other_tool', {}, makeContext('default'));
    expect(decision.behavior).not.toBe('allow');
  });
});

describe('a name that only looks like an app tool earns no unconditional allow', () => {
  it('refuses the canvas short-circuit to a namespaced name with no registration', async () => {
    // The model-visible name is not a unique key: a third-party server
    // named `duya` exposing `app_canvas_manage` is allocated the very
    // same name. With no registration there is no proof of ownership, so
    // the unconditional allow is refused and the full chain decides.
    const evaluate = createEvaluator();
    const decision = await evaluate(NAMESPACED, {}, makeContext('default'));
    expect(decision.behavior).not.toBe('allow');
  });

  it('refuses the canvas short-circuit to a namespaced name registered to somebody else', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      NAMESPACED,
      {},
      makeContext('default', {}, { registrations: { [NAMESPACED]: IMPOSTOR_CANVAS_REGISTRATION } }),
    );
    expect(decision.behavior).not.toBe('allow');
  });

  it('refuses the always-allowed set to a namespaced name registered to somebody else', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(
      NAMESPACED_ALWAYS_ALLOWED,
      {},
      makeContext('default', {}, {
        registrations: {
          [NAMESPACED_ALWAYS_ALLOWED]: {
            serverName: 'duya',
            toolName: 'app_MessageSession',
            source: 'plugin',
          },
        },
      }),
    );
    expect(decision.behavior).not.toBe('allow');
  });

  it('still allows the ordinary builtin canvas tool, which is not an MCP registration', async () => {
    // The builtin path: the tool's real name IS its name, no allocator
    // was involved, and there is nothing to impersonate.
    const evaluate = createEvaluator();
    const decision = await evaluate('canvas_manage', {}, makeContext('default'));
    expect(decision.behavior).toBe('allow');
  });
});

describe('the duya_app namespace does not defeat the profile patterns', () => {
  it('denies a namespaced canvas tool when the profile denies the original name', () => {
    const visible = isToolVisible(NAMESPACED, 'eager', new Set(), {
      profileDisallowedPatterns: ['canvas_manage'],
    });
    expect(visible).toBe(false);
  });

  it('denies a namespaced canvas tool when the profile denies the canvas family', () => {
    const visible = isToolVisible(NAMESPACED, 'eager', new Set(), {
      profileDisallowedPatterns: ['canvas_*'],
    });
    expect(visible).toBe(false);
  });

  it('allows a namespaced canvas tool when the profile allows the original name', () => {
    const visible = isToolVisible(NAMESPACED, 'eager', new Set(), {
      profileAllowedPatterns: ['canvas_manage'],
    });
    expect(visible).toBe(true);
  });

  it('promotes a deferred namespaced tool named by its original name', () => {
    const visible = isToolVisible(NAMESPACED, 'deferred', new Set(), {
      profileAllowedPatterns: ['canvas_manage'],
    });
    expect(visible).toBe(true);
  });

  it('honours a caller denylist written against the original name', () => {
    const visible = isToolVisible(NAMESPACED, 'eager', new Set(), {
      disabledTools: ['canvas_manage'],
    });
    expect(visible).toBe(false);
  });

  it('leaves a non-app tool alone', () => {
    const visible = isToolVisible('some_other_tool', 'eager', new Set(), {
      profileDisallowedPatterns: ['canvas_manage'],
    });
    expect(visible).toBe(true);
  });
});
