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
 * These tests pin the resolution at both layers: the permission decision
 * (`hasPermissionsToUseTool`) and the visibility filter (`isToolVisible`).
 */

import { describe, expect, it } from 'vitest';

import { createHasPermissionsToUseTool as createEvaluatorImpl } from '../../src/authorization/permissions/permissions.js';
import { isToolVisible } from '../../src/authorization/tool-filter.js';
import type {
  PermissionMode,
  ToolPermissionContext,
} from '../../src/authorization/permissions/types.js';
import type { ToolPermissionCheckContext } from '../../src/authorization/permissions/permissions.js';

/** The model-visible name the shared allocator produces for a canvas tool. */
const NAMESPACED = 'mcp_duya_app_canvas_manage';
/** A bot tool that is always allowed by name. */
const NAMESPACED_ALWAYS_ALLOWED = 'mcp_duya_app_MessageSession';
/** An app tool that is NOT unconditionally allowed, so a deny rule can bite. */
const NAMESPACED_DENYABLE = 'mcp_duya_app_update_state';

function makeContext(
  mode: PermissionMode = 'default',
  rules: {
    alwaysAllowRules?: Record<string, string[]>;
    alwaysDenyRules?: Record<string, string[]>;
    alwaysAskRules?: Record<string, string[]>;
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
    const evaluate = createEvaluator();
    const decision = await evaluate(NAMESPACED, {}, makeContext('default'));
    expect(decision.behavior).toBe('allow');
  });

  it('keeps the always-allowed set under the namespaced name', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate(NAMESPACED_ALWAYS_ALLOWED, {}, makeContext('default'));
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
      makeContext('default', {
        alwaysDenyRules: { userSettings: ['canvas_manage'] },
      }),
    );
    expect(decision.behavior).toBe('allow');
  });

  it('leaves a non-app tool alone', async () => {
    const evaluate = createEvaluator();
    const decision = await evaluate('some_other_tool', {}, makeContext('default'));
    expect(decision.behavior).not.toBe('allow');
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
