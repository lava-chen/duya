import { describe, it, expect } from 'vitest';
import { SUBAGENT_TOOL_NAME, LEGACY_SUBAGENT_TOOL_NAME } from '../constants.js';
import { subagentTool } from '../SubagentTool.js';
import { normalizeLegacyToolName } from '../../../permissions/rules.js';

/**
 * Plan 571: `auto_wake`, `resume_from` and `isolation` used to be declared in
 * `input_schema` but never read in `execute()`. These tests assert both halves
 * of the fix — the property is advertised AND it is actually consumed — so a
 * future schema edit cannot silently re-introduce a dead parameter.
 */
describe('SubagentTool wire name (aligned to Grok `task`)', () => {
  it('canonical wire name is `task`', () => {
    expect(SUBAGENT_TOOL_NAME).toBe('task');
    expect(subagentTool.name).toBe('task');
  });

  it('legacy `Agent` wire name is retained for backward compat', () => {
    expect(LEGACY_SUBAGENT_TOOL_NAME).toBe('Agent');
  });

  it('legacy `Agent` / `Task` permission rules normalize to `task`', () => {
    expect(normalizeLegacyToolName('Agent')).toBe('task');
    expect(normalizeLegacyToolName('Task')).toBe('task');
  });

  it('input schema exposes exactly the implemented parameter surface', () => {
    const props = subagentTool.input_schema.properties as Record<string, unknown>;
    // Every advertised parameter. Adding one here without wiring it into
    // `execute()` is the defect this list exists to prevent.
    expect(Object.keys(props).sort()).toEqual([
      'auto_wake',
      'description',
      'effort',
      'isolation',
      'max_turns',
      'model',
      'name',
      'permission_mode',
      'prompt',
      'resume_from',
      'run_in_background',
      'subagent_type',
      'tools',
    ]);
    expect(subagentTool.input_schema.required).toEqual(['prompt']);
  });

  it('auto_wake and resume_from are declared with the same defaults execute() applies', () => {
    const props = subagentTool.input_schema.properties as Record<string, { default?: unknown }>;
    // `execute()` reads `agentInput.auto_wake !== false` → schema default true.
    expect(props.auto_wake.default).toBe(true);
    expect(props.resume_from).toBeDefined();
    expect(props.isolation).toBeDefined();
  });

  it('declares the new plan 571 parameters with their value vocabularies', () => {
    const props = subagentTool.input_schema.properties as Record<string, Record<string, unknown>>;

    expect(props.max_turns.type).toBe('number');

    expect(props.effort.enum).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);

    expect(props.permission_mode.enum).toEqual(['default', 'auto', 'bypassPermissions']);

    expect(props.tools.type).toBe('object');
    const toolsProps = props.tools.properties as Record<string, { type: string }>;
    expect(toolsProps.allow.type).toBe('array');
    expect(toolsProps.deny.type).toBe('array');
  });
});
