/**
 * Plan 587 H8.2 — the non-interactive CLI approval property.
 *
 * ## The requirement
 *
 * Plan 587 §H8.2: "CLI 非交互 approval 拒绝/timeout 或使用显式 policy，不能自动
 * allow" — in non-interactive mode an approval must be denied, or governed by an
 * explicit policy. It must NEVER be auto-allowed.
 *
 * ## Why the obvious test is not enough
 *
 * `askWithoutUser.test.ts` covers `resolveAskWithoutUser` as a pure function, and
 * it passes. That is real evidence about the FUNCTION and no evidence at all
 * about the CLI: a function can be correct while every call site that matters
 * never reaches it, and it can be correct while the tool still runs anyway.
 *
 * The property that actually matters is behavioural — *the tool did not
 * execute*. So this file drives the real dispatcher with a CLI-shaped context
 * (no `requestPermission` hook, mode `default`, exactly what
 * `cli/index.ts:612-621` builds) and asserts on the executor spy.
 *
 * ## What "CLI-shaped" means here, and why it is asserted against source
 *
 * The CLI constructs `new duyaAgent({...})` with no `permissionMode` and never
 * passes `requestPermission`, so `DuyaAgent.permissionMode` is `'default'`
 * (`DuyaAgent.ts:851`) and the turn's `ToolUseContext.requestPermission` is
 * `undefined` (`DuyaAgent.ts:1991`). Those two facts are the whole basis for the
 * context built below, so they are pinned against the CLI source: if someone
 * later teaches the CLI to auto-allow, this file fails with a message that says
 * which of the two changed, instead of continuing to assert a context the CLI
 * no longer produces.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createToolInvokeDispatcherFromRegistry } from '../../src/tool/ToolInvokeTool/dispatcherFromRegistry';
import type { ToolInvokeDispatcherDeps } from '../../src/tool/ToolInvokeTool/dispatcherFromRegistry';
import type { ToolCatalogEntry } from '../../src/tool/catalog-types';
import type { ToolRegistry } from '../../src/tool/registry';
import type { ToolUseContext } from '../../src/types';
import type { PermissionMode } from '../../src/permissions/types';

const CLI_SOURCE = resolve(__dirname, '../../src/cli/index.ts');

function readCliSource(): string {
  return readFileSync(CLI_SOURCE, 'utf8');
}

/**
 * The two properties of the CLI that make an unattended approval safe. Both
 * are read out of the source rather than assumed, because a test that hardcodes
 * "the CLI is safe" only proves the test agrees with itself.
 */
function cliPermissionPosture(): {
  constructsWithoutPermissionMode: boolean;
  wiresRequestPermission: boolean;
} {
  const source = readCliSource();
  // Every `new duyaAgent({...})` literal in the CLI.
  const constructions = [...source.matchAll(/new duyaAgent\(\{([\s\S]*?)\}\)/g)].map(
    (m) => m[1] ?? '',
  );
  expect(constructions.length).toBeGreaterThan(0);
  return {
    constructsWithoutPermissionMode: constructions.every(
      (body) => !/permissionMode\s*:/.test(body),
    ),
    wiresRequestPermission: /requestPermission\s*:/.test(source),
  };
}

/**
 * A catalog entry whose executor is a spy, so "the tool ran" is observable
 * rather than inferred from the returned text.
 */
function makeEntry(execute: () => Promise<unknown>): ToolCatalogEntry {
  return {
    toolId: 'tool-1',
    internalName: 'mcp__evil__exfiltrate',
    definition: { name: 'exfiltrate' } as ToolCatalogEntry['definition'],
    executor: { execute } as unknown as ToolCatalogEntry['executor'],
    exposure: 'deferred',
    discovery: {} as ToolCatalogEntry['discovery'],
    source: { kind: 'mcp', id: 'server-1' },
    description: 'test tool',
    schemaRevision: 'rev-1',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
}

/** A registry stub exposing only what the dispatcher actually calls. */
function makeRegistry(entry: ToolCatalogEntry): ToolRegistry {
  return {
    getCatalogEntry: () => entry,
    getCatalogEntryById: () => entry,
    getOwner: () => 'mcp',
  } as unknown as ToolRegistry;
}

/** A `ToolUseContext` shaped exactly like the CLI's: nobody to ask. */
function makeCliContext(mode: PermissionMode | undefined): ToolUseContext {
  return {
    requestPermission: undefined,
    getAppState: () => ({ toolPermissionContext: { mode } }),
  } as unknown as ToolUseContext;
}

async function dispatchAskWithoutUser(
  mode: PermissionMode | undefined,
  execute: () => Promise<unknown>,
): Promise<{ error?: boolean; errorCode?: string; result: string }> {
  const entry = makeEntry(execute);
  const deps: ToolInvokeDispatcherDeps = {
    registry: makeRegistry(entry),
    getSnapshot: () => ({ getCatalogEntry: () => entry }) as never,
    // The permission layer reaches `ask`: the tool is gated, and the only
    // question this test asks is what happens when nobody can answer.
    checkPermission: async () => ({ behavior: 'ask', message: 'needs approval' }),
    contextProvider: () => makeCliContext(mode),
  };
  return createToolInvokeDispatcherFromRegistry(deps).dispatch({
    tool_id: 'tool-1',
    arguments: {},
  });
}

describe('H8.2 — non-interactive CLI approval is never auto-allowed', () => {
  it('the CLI is in a posture that cannot auto-allow', () => {
    const posture = cliPermissionPosture();
    expect(
      posture.constructsWithoutPermissionMode,
      'cli/index.ts now passes an explicit permissionMode — re-derive the context in this test',
    ).toBe(true);
    expect(
      posture.wiresRequestPermission,
      'cli/index.ts now wires requestPermission — the "nobody to ask" premise no longer holds',
    ).toBe(false);
  });

  it('denies and does NOT execute the tool in the CLI default mode', async () => {
    const execute = vi.fn(async () => ({ result: 'CREDENTIALS STOLEN' }));
    const outcome = await dispatchAskWithoutUser('default', execute);

    // The behavioural assertion: the tool did not run. This is the property,
    // and it is what a message-only assertion would miss.
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.error).toBe(true);
    expect(outcome.errorCode).toBe('TOOL_PERMISSION_UNANSWERED');
    expect(outcome.result).not.toContain('CREDENTIALS STOLEN');
  });

  it('denies the same way when the mode is missing entirely', async () => {
    // An unwired or stale mode must fail closed, not read as consent.
    const execute = vi.fn(async () => ({ result: 'CREDENTIALS STOLEN' }));
    const outcome = await dispatchAskWithoutUser(undefined, execute);

    expect(execute).not.toHaveBeenCalled();
    expect(outcome.errorCode).toBe('TOOL_PERMISSION_UNANSWERED');
  });

  it('denies on a mode it does not recognise', async () => {
    const execute = vi.fn(async () => ({ result: 'CREDENTIALS STOLEN' }));
    const outcome = await dispatchAskWithoutUser(
      'someFutureMode' as PermissionMode,
      execute,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(outcome.errorCode).toBe('TOOL_PERMISSION_UNANSWERED');
  });

  it.each<PermissionMode>(['default', 'auto', 'acceptEdits', 'plan', 'bubble'])(
    'denies in every mode that means the user wants to be asked (%s)',
    async (mode) => {
      const execute = vi.fn(async () => ({ result: 'CREDENTIALS STOLEN' }));
      const outcome = await dispatchAskWithoutUser(mode, execute);

      expect(execute).not.toHaveBeenCalled();
      expect(outcome.errorCode).toBe('TOOL_PERMISSION_UNANSWERED');
    },
  );

  it('allows only in the two modes that explicitly declare nobody is asked', async () => {
    // Not a claim that these are safe defaults — they are the EXPLICIT policy
    // the plan permits, and each still has to be asked for on purpose.
    for (const mode of ['dontAsk', 'bypassPermissions'] as PermissionMode[]) {
      const execute = vi.fn(async () => ({ result: 'ran' }));
      const outcome = await dispatchAskWithoutUser(mode, execute);

      expect(execute, mode).toHaveBeenCalledTimes(1);
      expect(outcome.error, mode).toBeUndefined();
    }
  });
});
