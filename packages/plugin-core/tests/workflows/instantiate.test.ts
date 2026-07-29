// packages/plugin-core/tests/workflows/instantiate.test.ts
// Plan 311 — Phase 2/4: instantiate variable substitution & edge cases.

import { describe, it, expect } from 'vitest';
import {
  instantiateWorkflow,
  extractVariables,
  getTemplatePrompt,
  WorkflowInstantiateError,
} from '../../src/workflows/instantiate';
import type { WorkflowTemplate } from '../../src/workflows/schema';

function makeTemplate(prompt: string, overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    id: 'test',
    name: 'Test',
    description: 'Test template.',
    prompt,
    requiredCapabilities: [],
    permissionTier: 'read',
    ...overrides,
  };
}

describe('getTemplatePrompt', () => {
  it('returns the prompt when present', () => {
    const t = makeTemplate('Hello world');
    expect(getTemplatePrompt(t)).toBe('Hello world');
  });

  it('joins step prompts when prompt is absent but steps exist', () => {
    const t = makeTemplate('', {
      prompt: undefined,
      steps: [
        { id: 's1', name: 'Step 1', prompt: 'Do step 1' },
        { id: 's2', name: 'Step 2', prompt: 'Do step 2' },
      ],
    });
    expect(getTemplatePrompt(t)).toBe('Do step 1\n\nDo step 2');
  });

  it('throws when neither prompt nor steps are present', () => {
    const t = makeTemplate('', { prompt: undefined });
    expect(() => getTemplatePrompt(t)).toThrow(WorkflowInstantiateError);
  });
});

describe('extractVariables', () => {
  it('extracts a single variable', () => {
    const t = makeTemplate('Review {{topic}}');
    expect(extractVariables(t)).toEqual(['topic']);
  });

  it('extracts multiple variables', () => {
    const t = makeTemplate('Review {{topic}} with {{method}}');
    expect(extractVariables(t).sort()).toEqual(['method', 'topic']);
  });

  it('deduplicates repeated variables', () => {
    const t = makeTemplate('{{topic}} and {{topic}} again');
    expect(extractVariables(t)).toEqual(['topic']);
  });

  it('extracts optional variables (with ? suffix)', () => {
    const t = makeTemplate('Review {{topic}} and {{scope?}}');
    expect(extractVariables(t).sort()).toEqual(['scope', 'topic']);
  });

  it('extracts variables with defaults (with = suffix)', () => {
    const t = makeTemplate('Review {{topic}} with {{limit=10}}');
    expect(extractVariables(t).sort()).toEqual(['limit', 'topic']);
  });

  it('returns empty for a prompt with no variables', () => {
    const t = makeTemplate('Just a plain prompt.');
    expect(extractVariables(t)).toEqual([]);
  });
});

describe('instantiateWorkflow — basic substitution', () => {
  it('substitutes a single variable', () => {
    const t = makeTemplate('Review {{topic}}');
    const result = instantiateWorkflow(t, { variables: { topic: 'machine learning' } });
    expect(result.prompt).toBe('Review machine learning');
  });

  it('substitutes multiple variables', () => {
    const t = makeTemplate('Review {{topic}} with {{method}}');
    const result = instantiateWorkflow(t, {
      variables: { topic: 'ML', method: 'systematic' },
    });
    expect(result.prompt).toBe('Review ML with systematic');
  });

  it('handles a prompt with no variables', () => {
    const t = makeTemplate('Just a plain prompt.');
    const result = instantiateWorkflow(t);
    expect(result.prompt).toBe('Just a plain prompt.');
  });
});

describe('instantiateWorkflow — optional & default variables', () => {
  it('substitutes optional variable when provided', () => {
    const t = makeTemplate('Review {{topic}} scope={{scope?}}');
    const result = instantiateWorkflow(t, {
      variables: { topic: 'ML', scope: 'cs.AI' },
    });
    expect(result.prompt).toBe('Review ML scope=cs.AI');
  });

  it('replaces optional variable with empty string when omitted', () => {
    const t = makeTemplate('Review {{topic}} scope={{scope?}}');
    const result = instantiateWorkflow(t, { variables: { topic: 'ML' } });
    expect(result.prompt).toBe('Review ML scope=');
  });

  it('uses default value when variable is omitted', () => {
    const t = makeTemplate('Limit: {{limit=10}}');
    const result = instantiateWorkflow(t);
    expect(result.prompt).toBe('Limit: 10');
  });

  it('overrides default when variable is provided', () => {
    const t = makeTemplate('Limit: {{limit=10}}');
    const result = instantiateWorkflow(t, { variables: { limit: '50' } });
    expect(result.prompt).toBe('Limit: 50');
  });
});

describe('instantiateWorkflow — missing required variables', () => {
  it('throws WorkflowInstantiateError when a required variable is missing', () => {
    const t = makeTemplate('Review {{topic}}');
    expect(() => instantiateWorkflow(t)).toThrow(WorkflowInstantiateError);
  });

  it('error message lists the missing variable', () => {
    const t = makeTemplate('Review {{topic}}');
    try {
      instantiateWorkflow(t);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowInstantiateError);
      expect((err as WorkflowInstantiateError).missingVariables).toEqual(['topic']);
      expect((err as WorkflowInstantiateError).message).toContain('topic');
    }
  });

  it('lists all missing variables in the error', () => {
    const t = makeTemplate('Review {{topic}} with {{method}}');
    try {
      instantiateWorkflow(t);
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as WorkflowInstantiateError).missingVariables.sort()).toEqual([
        'method',
        'topic',
      ]);
    }
  });
});

describe('instantiateWorkflow — escape rules', () => {
  it('leaves {{ not followed by a valid token as-is', () => {
    const t = makeTemplate('Literal {{ text');
    const result = instantiateWorkflow(t);
    expect(result.prompt).toBe('Literal {{ text');
  });

  it('does not double-expand values containing {{', () => {
    const t = makeTemplate('Output: {{value}}');
    const result = instantiateWorkflow(t, {
      variables: { value: '{{not a variable}}' },
    });
    // The value is inserted as-is — no recursive expansion.
    expect(result.prompt).toBe('Output: {{not a variable}}');
  });
});

describe('instantiateWorkflow — edge cases', () => {
  it('handles multiline prompts with variables', () => {
    const t = makeTemplate('Line 1: {{a}}\nLine 2: {{b}}');
    const result = instantiateWorkflow(t, { variables: { a: 'X', b: 'Y' } });
    expect(result.prompt).toBe('Line 1: X\nLine 2: Y');
  });

  it('handles variables adjacent to text', () => {
    const t = makeTemplate('prefix{{var}}suffix');
    const result = instantiateWorkflow(t, { variables: { var: 'VAL' } });
    expect(result.prompt).toBe('prefixVALsuffix');
  });

  it('handles the same variable appearing multiple times', () => {
    const t = makeTemplate('{{topic}} and {{topic}} again');
    const result = instantiateWorkflow(t, { variables: { topic: 'ML' } });
    expect(result.prompt).toBe('ML and ML again');
  });

  it('ignores extra variables not referenced in the template', () => {
    const t = makeTemplate('Review {{topic}}');
    const result = instantiateWorkflow(t, {
      variables: { topic: 'ML', unused: 'ignored' },
    });
    expect(result.prompt).toBe('Review ML');
  });
});
