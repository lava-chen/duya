/**
 * Plan 616 — the `duya_app` tool namespace.
 *
 * ## What this pins
 *
 * The model-visible name of every `duya_app` tool is a PURE prefix
 * concatenation for every app tool name.
 * with no truncation, no hash suffix, and no de-duplication suffix.
 *
 * That reversibility is load-bearing, not incidental. Three separate
 * consumers need to recognize the originating app tool from the model-visible name:
 *
 *   - the desktop renderer, which routes a tool to its dedicated row
 *     (the renderer never sees `mcpInfo` — plan 616 §C7);
 *   - the permission gate, which resolves app tool identities.
 *
 * If the naming ever stopped being invertible, all three would need a
 * registry lookup instead of a pure function — and the renderer could
 * not do it at all.
 *
 * So this test asserts the naming with the REAL production allocator,
 * and asserts the reverse mapping round-trips.
 */

import { describe, it, expect } from 'vitest';
import { computeProviderName, AnthropicToolNamePolicy } from '@duya/plugin-core';

import {
  DUYA_APP_SERVER_NAME,
  DUYA_APP_TOOL_NAMES,
  DUYA_APP_TOOL_PREFIX,
  appToolOriginalName,
  appToolVisibleName,
  resolveAppToolBaseName,
  resolveAppToolBaseNameFromInternalKey,
  isAppToolName,
} from '../../src/AppServer/app-tool-namespace.js';

/** The tool names `duya_app` will carry (plan 616 §3 and §3.1). */
const APP_TOOL_NAMES = DUYA_APP_TOOL_NAMES;

/** Allocate the model-visible name exactly as production does. */
function providerNameFor(toolName: string, used: Set<string>): string {
  return computeProviderName(
    `mcp__${DUYA_APP_SERVER_NAME}__${toolName}`,
    used,
    AnthropicToolNamePolicy,
  );
}

describe('plan 616 — the duya_app tool namespace', () => {
  it('every app tool name is a pure prefix concatenation', () => {
    const used = new Set<string>();
    for (const toolName of APP_TOOL_NAMES) {
      const modelVisible = providerNameFor(toolName, used);
      used.add(modelVisible);

      // No truncation, no hash suffix, no de-duplication suffix.
      expect(modelVisible).toBe(`${DUYA_APP_TOOL_PREFIX}${toolName}`);
    }
  });

  it('the model-visible name maps back to the original tool name', () => {
    const used = new Set<string>();
    for (const toolName of APP_TOOL_NAMES) {
      const modelVisible = providerNameFor(toolName, used);
      used.add(modelVisible);

      expect(resolveAppToolBaseName(modelVisible)).toBe(toolName);
      expect(isAppToolName(modelVisible)).toBe(true);
    }
  });

  it('names from other providers are not app tools', () => {
    // Base tools keep their own names and must not be mistaken for app tools.
    for (const name of ['bash', 'read', 'write', 'edit', 'grep', 'todo', 'task']) {
      expect(resolveAppToolBaseName(name)).toBeUndefined();
      expect(isAppToolName(name)).toBe(false);
    }

    // Another MCP provider's tool must not match either.
    expect(resolveAppToolBaseName('mcp_github_create_issue')).toBeUndefined();
    expect(resolveAppToolBaseName('mcp_duya_app_lit_create_issue')).toBeUndefined();
  });

  it('a bare prefix with no tool name is not an app tool', () => {
    expect(resolveAppToolBaseName(DUYA_APP_TOOL_PREFIX)).toBeUndefined();
    expect(isAppToolName(DUYA_APP_TOOL_PREFIX)).toBe(false);
  });


});

describe('plan 616 — the registry\'s internal key resolves to the same tool', () => {
  it('resolves every app tool from its internal key', () => {
    // The registry stores MCP tools under `mcp__<server>__<tool>` and
    // shows the model the visible name. The permission chain is called
    // with both, so both must resolve to the same original name.
    for (const toolName of APP_TOOL_NAMES) {
      const internalKey = `mcp__${DUYA_APP_SERVER_NAME}__${toolName}`;
      expect(resolveAppToolBaseNameFromInternalKey(internalKey)).toBe(toolName);
      expect(appToolOriginalName(internalKey)).toBe(toolName);
    }
  });

  it('resolves the model-visible name and the internal key alike', () => {
    for (const toolName of APP_TOOL_NAMES) {
      const modelVisible = appToolVisibleName(toolName);
      const internalKey = `mcp__${DUYA_APP_SERVER_NAME}__${toolName}`;
      expect(appToolOriginalName(modelVisible)).toBe(toolName);
      expect(appToolOriginalName(internalKey)).toBe(toolName);
    }
  });

  it('leaves another server\'s internal key alone', () => {
    // A third-party server is not ours, whatever its tool is called.
    expect(resolveAppToolBaseNameFromInternalKey('mcp__github__create_issue')).toBeUndefined();
    expect(appToolOriginalName('mcp__github__create_issue')).toBe('mcp__github__create_issue');
    // Not even when the tool segment is one of ours.
    expect(resolveAppToolBaseNameFromInternalKey('mcp__duya__save_note')).toBeUndefined();
    expect(appToolOriginalName('mcp__duya__save_note')).toBe('mcp__duya__save_note');
  });

  it('leaves an unknown tool of our own server alone', () => {
    // The closed set is what makes the namespace unambiguous: a tool the
    // app server does not serve is not one of ours, however it is spelled.
    expect(resolveAppToolBaseNameFromInternalKey('mcp__duya_app__not_a_tool')).toBeUndefined();
    expect(appToolOriginalName('mcp__duya_app__not_a_tool')).toBe('mcp__duya_app__not_a_tool');
    expect(appToolOriginalName('mcp_duya_app_not_a_tool')).toBe('mcp_duya_app_not_a_tool');
  });
});
