/**
 * Conductor prompt guard tests.
 *
 * These are intentionally lightweight: the prompt is consumed as
 * a string by the LLM, so we test that key behavioral instructions
 * remain present after edits. Drop a phrase here and the test will
 * force a deliberate decision about whether to remove the behavior.
 */

import { describe, expect, it } from 'vitest';
import { buildConductorPrompt, CONDUCTOR_MAIN_AGENT_PROMPT } from './prompt.js';

const PROMPT = buildConductorPrompt();

describe('Conductor prompt — Pre-Drawing Canvas Check (plan 233)', () => {
  it('contains a "Pre-Drawing Canvas Check" section', () => {
    expect(PROMPT).toContain('Pre-Drawing Canvas Check');
  });

  it('instructs the model to call canvas_manage get_current first', () => {
    expect(PROMPT).toMatch(/Pre-Drawing Canvas Check[\s\S]*canvas_manage with action=get_current/);
  });

  it('instructs the model to inspect the layout via canvas_get_context or canvas_list_elements', () => {
    expect(PROMPT).toMatch(/Pre-Drawing Canvas Check[\s\S]*canvas_get_context[\s\S]*canvas_list_elements/);
  });

  it('names the three-way decision: stay / switch / create', () => {
    const section = PROMPT.split('Pre-Drawing Canvas Check')[1].split('### ')[0];
    expect(section).toMatch(/\*\*Stay on the current canvas\*\*/);
    expect(section).toMatch(/\*\*Switch to a different existing canvas\*\*/);
    expect(section).toMatch(/\*\*Create a new canvas\*\*/);
  });

  it('warns about switchTo=false needing a follow-up switch', () => {
    const section = PROMPT.split('Pre-Drawing Canvas Check')[1].split('### ')[0];
    expect(section).toContain('switchTo=false');
    expect(section).toMatch(/follow up with canvas_manage action=switch/);
  });

  it('names the canvas in the user-facing narration', () => {
    expect(PROMPT).toMatch(/Pre-Drawing Canvas Check[\s\S]*name the new canvas so the user sees/);
  });

  it('frames the check as a precondition of the no-overlap rule', () => {
    expect(PROMPT).toMatch(/precondition of the .no overlap. rule/);
  });
});

describe('Conductor prompt — Multi-Canvas Awareness', () => {
  it('keeps the legacy action verbs (get_current / list / create / switch / rename / delete)', () => {
    const section = PROMPT.split('Multi-Canvas Awareness')[1].split('### ')[0];
    for (const action of ['get_current', 'list', 'create', 'switch', 'rename', 'delete']) {
      expect(section, `Multi-Canvas Awareness should mention action ${action}`).toContain(action);
    }
  });
});

describe('Conductor prompt — deprecation aliases', () => {
  it('keeps CONDUCTOR_MAIN_AGENT_PROMPT as an alias of buildConductorPrompt()', () => {
    // The deprecated alias exists for back-compat with any code path
    // that hasn't migrated to the function form.
    expect(typeof CONDUCTOR_MAIN_AGENT_PROMPT).toBe('string');
    expect(CONDUCTOR_MAIN_AGENT_PROMPT).toContain('Pre-Drawing Canvas Check');
  });
});