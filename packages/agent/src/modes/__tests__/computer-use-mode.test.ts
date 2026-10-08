/**
 * computer-use-mode.test.ts — ModeModifier registration / exclusiveWith / hooks.
 *
 * Plan 454 §6.1 acceptance.
 */

import { describe, it, expect } from 'vitest';

import { modeModifierRegistry } from '../index.js';
import { computerUseMode, COMPUTER_USE_MODE_ID } from '../computer-use-mode.js';
import {
  getComputerUseTools,
  recordComputerUseContextTrigger,
  shouldInjectComputerUseContext,
} from '../../tool/OSTool/index.js';
import { COMPUTER_USE_TOOL_NAME } from '../../tool/OSTool/constants.js';
import type { SubagentRunDeps } from '../../tool/SubagentTool/runAgent.js';

// Plan 610 A5: every ModeModifierContext literal needs the sub-agent
// composition deps. computer-use never spawns a sub-agent, so inert stubs.
const stubSubagentDeps: SubagentRunDeps = {
  createSubAgent: () => {
    throw new Error('not used by the computer-use mode suite');
  },
  createToolRegistry: () => {
    throw new Error('not used by the computer-use mode suite');
  },
};

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
    // plan 519 D2: inject is function-form and consults the session's
    // trigger registry. plan 575 follow-up: `computer_cua` (structural
    // channel) is ALWAYS appended after the vision tool.
    const inject = computerUseMode.tools!.inject as (ctx: {
      sessionId: string;
      workingDirectory: string;
      state: Record<string, never>;
    }) => ReturnType<typeof getComputerUseTools>;
    const tools = inject({ sessionId: 'unarmed-session', workingDirectory: '/tmp', state: {} });
    expect(tools.length).toBe(2);
    expect(tools[0].definition.name).toBe(COMPUTER_USE_TOOL_NAME);
    expect(tools[1].definition.name).toBe('computer_cua');
  });

  it('uses overrideFilter so the tool survives profile filtering', () => {
    expect(computerUseMode.tools?.overrideFilter).toBe(true);
  });

  it('prepends a system prompt teaching the SOM workflow', () => {
    const prefix = computerUseMode.prompt?.prefix;
    // plan 551 Phase 3: prefix is a PromptBuilder — the decide section is
    // appended only when a decision backend is configured. Without one
    // (unit-test default) the prompt is the plain vision-loop manual.
    // plan 575 follow-up: the CUA two-tool contract section is always
    // present.
    const text = typeof prefix === 'function' ? prefix({} as never, '') : (prefix ?? '');
    expect(text).toContain('capture(somMode=true)');
    expect(text).toContain('suspected_noop');
    expect(text).toContain('APP_BLOCKED');
    expect(text).toContain('REDACTED_FIELD');
    expect(text).toContain('CUA channel (computer_cua)');
    // plan 578: the app-switching guidance is always present too.
    expect(text).toContain('Switching apps (computer_cua)');
    expect(text).toContain('WITHOUT stealing the user');
    // plan 578 follow-up: not-running apps launch via Bash — the CUA
    // surface has no launch primitive.
    expect(text).toContain('no launch primitive');
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

  it('onExit clears the context-tool trigger for the session (plan 519 D2)', async () => {
    recordComputerUseContextTrigger('mode-exit-session', 'explicit-call');
    expect(shouldInjectComputerUseContext('mode-exit-session')).toBe(true);
    await computerUseMode.hooks!.onExit!({
      sessionId: 'mode-exit-session',
      workingDirectory: '/tmp',
      subagentDeps: stubSubagentDeps,
      state: {},
    });
    expect(shouldInjectComputerUseContext('mode-exit-session')).toBe(false);
  });

  it('has a persist round-trip (empty for Phase 2)', () => {
    const serialized = computerUseMode.persist!.serialize({
      sessionId: 's',
      workingDirectory: '/tmp',
      subagentDeps: stubSubagentDeps,
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
      subagentDeps: stubSubagentDeps,
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
    // plan 575 follow-up: `computer_cua` rides along with the vision tool.
    expect(result.tools.length).toBe(2);
    expect(result.tools[0].definition.name).toBe(COMPUTER_USE_TOOL_NAME);
    expect(result.tools[1].definition.name).toBe('computer_cua');
  });

  it('surfaces computerUseMode flag via toolUseContextPatch', async () => {
    const { applyModes } = await import('../apply-modes.js');
    const ctx = {
      sessionId: 's',
      workingDirectory: '/tmp',
      subagentDeps: stubSubagentDeps,
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