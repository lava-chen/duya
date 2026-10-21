import { describe, expect, it, vi } from 'vitest';
import type { ToolUseContext } from '../src/contracts/tool.js';
import {
  EnterPlanModeTool,
  ExitPlanModeTool,
  MODE_CONFIGS,
  SwitchModeTool,
  filterToolsByMode,
  isToolAllowedInMode,
  type AgentMode,
  type ModeToolPort,
} from '../src/mode-tools.js';

function makePort(): ModeToolPort & { state: { mode: AgentMode; seed: 'empty' | 'non_empty' | 'missing' } } {
  const state = { mode: 'general' as AgentMode, seed: 'empty' as const };
  return {
    state,
    getCurrentMode: () => state.mode,
    setAgentMode: (mode) => { state.mode = mode; },
    isReadOnlyMode: () => state.mode !== 'general',
    transitionPlanMode: vi.fn(),
    resolvePlanFilePath: (sessionId) => `/sessions/${sessionId}/plan.md`,
    probeOrCreateEmptyPlanFile: async () => state.seed,
  };
}

describe('mode capabilities', () => {
  it('switches canonical modes, updates caller app state, and returns the current guidance', async () => {
    const port = makePort();
    const setAppState = vi.fn();
    const context = { setAppState } as unknown as ToolUseContext;
    const tool = new SwitchModeTool(port);

    const result = await tool.execute({ mode: 'plan' }, undefined, context);
    expect(JSON.parse(result.result)).toMatchObject({
      previousMode: 'general',
      currentMode: 'plan',
      readOnly: true,
      guidance: expect.stringContaining('READ-ONLY MODE'),
    });
    expect(port.getCurrentMode()).toBe('plan');
    expect(setAppState).toHaveBeenCalledWith(expect.any(Function));

    const invalid = await tool.execute({ mode: 'unknown' });
    expect(invalid.error).toBe(true);
    expect(JSON.parse(invalid.result).error).toContain('Invalid mode');
  });

  it('seeds the session plan file once, preserves read-only re-entry, and releases tracker on exit', async () => {
    const port = makePort();
    const enter = new EnterPlanModeTool(port);
    const context = { toolUseId: 'tool-1', options: { sessionId: 'session-1' } };

    const entered = JSON.parse((await enter.execute({}, undefined, context)).result) as Record<string, unknown>;
    expect(entered).toMatchObject({
      message: expect.stringContaining('Entered plan mode'),
      planMode: true,
      planFile: '/sessions/session-1/plan.md',
      seed: 'empty',
    });
    expect(port.transitionPlanMode).toHaveBeenCalledWith('activate_from_tool');

    const reentered = JSON.parse((await enter.execute({}, undefined, context)).result) as Record<string, unknown>;
    expect(reentered).toMatchObject({ message: 'Already in plan mode', seed: 'empty' });
    expect(port.transitionPlanMode).toHaveBeenCalledTimes(1);

    const exited = JSON.parse((await new ExitPlanModeTool(port).execute()).result) as Record<string, unknown>;
    expect(exited).toMatchObject({ message: 'Exited plan mode. Ready for implementation.', planMode: false });
    expect(port.getCurrentMode()).toBe('general');
    expect(port.transitionPlanMode).toHaveBeenLastCalledWith('exit_approved');
  });

  it('keeps read-only tool filters and prompt suffixes attached to the protocol mode set', () => {
    expect(MODE_CONFIGS.general.readOnly).toBe(false);
    expect(MODE_CONFIGS['code-review'].readOnly).toBe(true);
    expect(isToolAllowedInMode('Write', 'plan')).toBe(false);
    expect(isToolAllowedInMode('Agent', 'verify')).toBe(true);
    expect(filterToolsByMode([{ name: 'Read' }, { name: 'Write' }], 'explore')).toEqual([{ name: 'Read' }]);
  });
});
