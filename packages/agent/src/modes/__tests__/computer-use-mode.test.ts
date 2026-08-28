/**
 * computer-use-mode.test.ts — ModeModifier registration / exclusiveWith / hooks.
 *
 * Plan 454 §6.1 acceptance.
 */

import { describe, it, expect } from 'vitest';

import { modeModifierRegistry } from '../index.js';
import { computerUseMode, COMPUTER_USE_MODE_ID } from '../computer-use-mode.js';
import { getComputerUseTools } from '../../tool/OSTool/index.js';
import { COMPUTER_USE_TOOL_NAME } from '../../tool/OSTool/constants.js';

describe('computerUseMode — registration', () => {
  it('is registered with the canonical id', () => {
    expect(modeModifierRegistry.has(COMPUTER_USE_MODE_ID)).toBe(true);
    expect(modeModifierRegistry.get(COMPUTER_USE_MODE_ID)).toBe(computerUseMode);
  });

  it('is a session-level mode', () => {
    expect(computerUseMode.kind).toBe('session');
  });

  it('excludes every other session-level mode', () => {
    expect(computerUseMode.exclusiveWith).toEqual(
      expect.arrayContaining(['plan-task', 'research', 'conductor', 'goal']),
    );
  });

  it('declares the computer_use tool via inject (function form)', () => {
    expect(typeof computerUseMode.tools?.inject).toBe('function');
    const tools = (computerUseMode.tools!.inject as () => ReturnType<typeof getComputerUseTools>)();
    expect(tools.length).toBe(1);
    expect(tools[0].definition.name).toBe(COMPUTER_USE_TOOL_NAME);
  });

  it('uses overrideFilter so the tool survives profile filtering', () => {
    expect(computerUseMode.tools?.overrideFilter).toBe(true);
  });

  it('declares the expected display metadata', () => {
    expect(computerUseMode.display?.label).toBe('Computer Use');
    expect(computerUseMode.display?.icon).toBe('MousePointerClick');
    expect(computerUseMode.display?.description).toMatch(/桌面/);
  });

  it('has an onEnter hook (OSContextBridge enable)', () => {
    expect(typeof computerUseMode.hooks?.onEnter).toBe('function');
  });

  it('has an onExit hook (OSContextBridge disable)', () => {
    expect(typeof computerUseMode.hooks?.onExit).toBe('function');
  });

  it('has a persist round-trip (empty for Phase 2)', () => {
    const serialized = computerUseMode.persist!.serialize({
      sessionId: 's',
      workingDirectory: '/tmp',
      state: {},
    });
    expect(serialized).toEqual({});
    expect(computerUseMode.persist!.deserialize({})).toEqual({});
  });
});

describe('modeModifierRegistry — exclusiveWith arbitration', () => {
  it('drops later mode when it conflicts with earlier', () => {
    const resolved = modeModifierRegistry.resolve(['plan-task', COMPUTER_USE_MODE_ID]);
    const ids = resolved.modes.map((m) => m.id);
    expect(ids).toContain('plan-task');
    expect(ids).not.toContain(COMPUTER_USE_MODE_ID);
  });

  it('keeps earlier computer-use-mode and drops plan-task (earlier wins)', () => {
    const resolved = modeModifierRegistry.resolve([COMPUTER_USE_MODE_ID, 'plan-task']);
    const ids = resolved.modes.map((m) => m.id);
    expect(ids).toContain(COMPUTER_USE_MODE_ID);
    expect(ids).not.toContain('plan-task');
  });

  it('allows computer-use-mode alongside automation (message-level, not exclusive)', () => {
    const resolved = modeModifierRegistry.resolve(['automation', COMPUTER_USE_MODE_ID]);
    const ids = resolved.modes.map((m) => m.id);
    expect(ids).toContain('automation');
    expect(ids).toContain(COMPUTER_USE_MODE_ID);
  });
});

describe('applyModes — computer-use-mode integration', () => {
  it('injects the computer_use tool into the tool set', async () => {
    const { applyModes } = await import('../apply-modes.js');
    const ctx = {
      sessionId: 's',
      workingDirectory: '/tmp',
      state: {},
    };
    const resolved = modeModifierRegistry.resolve([COMPUTER_USE_MODE_ID]);
    const result = await applyModes({
      basePrompt: 'p',
      baseTools: [],
      ctx,
      resolved,
    });
    // overrideFilter: injected tools append to baseTools unconditionally.
    expect(result.tools.length).toBe(1);
    expect(result.tools[0].definition.name).toBe(COMPUTER_USE_TOOL_NAME);
  });

  it('surfaces computerUseMode flag via toolUseContextPatch', async () => {
    const { applyModes } = await import('../apply-modes.js');
    const ctx = {
      sessionId: 's',
      workingDirectory: '/tmp',
      state: {},
    };
    const resolved = modeModifierRegistry.resolve([COMPUTER_USE_MODE_ID]);
    const result = await applyModes({
      basePrompt: 'p',
      baseTools: [],
      ctx,
      resolved,
    });
    expect(result.toolUseContext.computerUseMode).toBe(true);
  });
});