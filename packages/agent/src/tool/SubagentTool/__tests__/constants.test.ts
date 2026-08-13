import { describe, it, expect } from 'vitest';
import { SUBAGENT_TOOL_NAME, LEGACY_SUBAGENT_TOOL_NAME } from '../constants.js';
import { subagentTool } from '../SubagentTool.js';
import { normalizeLegacyToolName } from '../../../permissions/rules.js';

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

  it('input schema exposes Grok task fields auto_wake and resume_from', () => {
    const props = subagentTool.input_schema.properties as Record<string, unknown>;
    expect(props.auto_wake).toBeDefined();
    expect(props.resume_from).toBeDefined();
    expect(props.prompt).toBeDefined();
    expect(props.subagent_type).toBeDefined();
  });
});