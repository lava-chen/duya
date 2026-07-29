// packages/plugin-core/tests/workflows/schema.test.ts
// Plan 311 — Phase 3/4: permission tier mapping & workflow schema tests.

import { describe, it, expect } from 'vitest';
import {
  PermissionTierSchema,
  PERMISSION_TIER_ORDER,
  tierRank,
  compareTiers,
  mergeTiers,
  bumpPermissionTier,
  tierRequiresConfirmation,
  tierRequiresExplicitConfirmation,
  WorkflowTemplateSchema,
  toWorkflowSummary,
} from '../../src/workflows/schema';

describe('PermissionTierSchema', () => {
  it('accepts all five tiers', () => {
    for (const tier of ['read', 'draft', 'write', 'modify', 'dangerous']) {
      expect(PermissionTierSchema.safeParse(tier).success).toBe(true);
    }
  });

  it('rejects unknown tiers', () => {
    expect(PermissionTierSchema.safeParse('admin').success).toBe(false);
    expect(PermissionTierSchema.safeParse('').success).toBe(false);
    expect(PermissionTierSchema.safeParse(123).success).toBe(false);
  });
});

describe('PERMISSION_TIER_ORDER', () => {
  it('is ordered from least to most dangerous', () => {
    expect(PERMISSION_TIER_ORDER).toEqual([
      'read',
      'draft',
      'write',
      'modify',
      'dangerous',
    ]);
  });
});

describe('tierRank', () => {
  it('returns 0 for undefined / unknown', () => {
    expect(tierRank(undefined)).toBe(0);
    expect(tierRank('')).toBe(0);
    expect(tierRank('unknown')).toBe(0);
  });

  it('returns increasing ranks for each tier', () => {
    expect(tierRank('read')).toBe(0);
    expect(tierRank('draft')).toBe(1);
    expect(tierRank('write')).toBe(2);
    expect(tierRank('modify')).toBe(3);
    expect(tierRank('dangerous')).toBe(4);
  });
});

describe('compareTiers', () => {
  it('returns negative when a is less dangerous', () => {
    expect(compareTiers('read', 'write')).toBeLessThan(0);
  });

  it('returns positive when a is more dangerous', () => {
    expect(compareTiers('dangerous', 'read')).toBeGreaterThan(0);
  });

  it('returns zero when equal', () => {
    expect(compareTiers('write', 'write')).toBe(0);
  });
});

describe('mergeTiers — take the stricter', () => {
  it('returns the higher-ranked tier', () => {
    expect(mergeTiers('read', 'write')).toBe('write');
    expect(mergeTiers('write', 'read')).toBe('write');
    expect(mergeTiers('draft', 'dangerous')).toBe('dangerous');
    expect(mergeTiers('dangerous', 'dangerous')).toBe('dangerous');
  });

  it('treats undefined as the lowest rank', () => {
    expect(mergeTiers(undefined, 'read')).toBe('read');
    expect(mergeTiers(undefined, undefined)).toBe('read');
  });

  it('handles string inputs', () => {
    expect(mergeTiers('read' as string, 'modify' as string)).toBe('modify');
  });
});

describe('bumpPermissionTier — conservative one-step bump', () => {
  it('bumps read → draft', () => {
    expect(bumpPermissionTier('read')).toBe('draft');
  });

  it('bumps draft → write', () => {
    expect(bumpPermissionTier('draft')).toBe('write');
  });

  it('bumps write → modify', () => {
    expect(bumpPermissionTier('write')).toBe('modify');
  });

  it('bumps modify → dangerous', () => {
    expect(bumpPermissionTier('modify')).toBe('dangerous');
  });

  it('stays at dangerous (cannot bump past the top)', () => {
    expect(bumpPermissionTier('dangerous')).toBe('dangerous');
  });

  it('treats undefined as read and bumps to draft', () => {
    expect(bumpPermissionTier(undefined)).toBe('draft');
  });

  it('treats unknown as read and bumps to draft', () => {
    expect(bumpPermissionTier('unknown')).toBe('draft');
  });
});

describe('tierRequiresConfirmation', () => {
  it('returns false for read and draft', () => {
    expect(tierRequiresConfirmation('read')).toBe(false);
    expect(tierRequiresConfirmation('draft')).toBe(false);
  });

  it('returns true for write, modify, dangerous', () => {
    expect(tierRequiresConfirmation('write')).toBe(true);
    expect(tierRequiresConfirmation('modify')).toBe(true);
    expect(tierRequiresConfirmation('dangerous')).toBe(true);
  });

  it('returns false for undefined (treated as read)', () => {
    expect(tierRequiresConfirmation(undefined)).toBe(false);
  });

  it('accounts for the conservative bump — bumped read becomes draft, still no confirmation', () => {
    const bumped = bumpPermissionTier('read');
    expect(tierRequiresConfirmation(bumped)).toBe(false);
  });

  it('accounts for the conservative bump — bumped draft becomes write, requires confirmation', () => {
    const bumped = bumpPermissionTier('draft');
    expect(tierRequiresConfirmation(bumped)).toBe(true);
  });
});

describe('tierRequiresExplicitConfirmation', () => {
  it('returns false for everything except dangerous', () => {
    expect(tierRequiresExplicitConfirmation('read')).toBe(false);
    expect(tierRequiresExplicitConfirmation('draft')).toBe(false);
    expect(tierRequiresExplicitConfirmation('write')).toBe(false);
    expect(tierRequiresExplicitConfirmation('modify')).toBe(false);
  });

  it('returns true only for dangerous', () => {
    expect(tierRequiresExplicitConfirmation('dangerous')).toBe(true);
  });
});

describe('WorkflowTemplateSchema', () => {
  it('accepts a minimal valid template', () => {
    const result = WorkflowTemplateSchema.safeParse({
      id: 'review',
      name: 'Review',
      description: 'A review workflow.',
      prompt: 'Do a review.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('review');
      expect(result.data.requiredCapabilities).toEqual([]);
      expect(result.data.permissionTier).toBe('read');
    }
  });

  it('accepts a full template with all fields', () => {
    const result = WorkflowTemplateSchema.safeParse({
      id: 'review',
      name: 'Literature Review',
      description: 'Survey the literature on a topic.',
      prompt: 'Survey {{topic}}.',
      requiredCapabilities: ['mcp:literature', 'skill:paper-analysis'],
      permissionTier: 'write',
      steps: [{ id: 's1', name: 'Step 1', prompt: 'Do step 1' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiredCapabilities).toEqual([
        'mcp:literature',
        'skill:paper-analysis',
      ]);
      expect(result.data.permissionTier).toBe('write');
      expect(result.data.steps).toHaveLength(1);
    }
  });

  it('rejects a template missing required id', () => {
    const result = WorkflowTemplateSchema.safeParse({
      name: 'No ID',
      description: 'Missing id field.',
      prompt: 'Hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a template missing required name', () => {
    const result = WorkflowTemplateSchema.safeParse({
      id: 'no-name',
      description: 'Missing name.',
      prompt: 'Hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a template missing required description', () => {
    const result = WorkflowTemplateSchema.safeParse({
      id: 'no-desc',
      name: 'No Desc',
      prompt: 'Hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid permissionTier', () => {
    const result = WorkflowTemplateSchema.safeParse({
      id: 'bad-tier',
      name: 'Bad Tier',
      description: 'Invalid tier.',
      prompt: 'Hello',
      permissionTier: 'admin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects requiredCapabilities that is not an array', () => {
    const result = WorkflowTemplateSchema.safeParse({
      id: 'bad-caps',
      name: 'Bad Caps',
      description: 'Not an array.',
      prompt: 'Hello',
      requiredCapabilities: 'mcp:literature',
    });
    expect(result.success).toBe(false);
  });

  it('defaults requiredCapabilities to [] when omitted', () => {
    const result = WorkflowTemplateSchema.safeParse({
      id: 'defaults',
      name: 'Defaults',
      description: 'Test defaults.',
      prompt: 'Hello',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiredCapabilities).toEqual([]);
    }
  });

  it('defaults permissionTier to read when omitted', () => {
    const result = WorkflowTemplateSchema.safeParse({
      id: 'defaults',
      name: 'Defaults',
      description: 'Test defaults.',
      prompt: 'Hello',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissionTier).toBe('read');
    }
  });

  it('accepts templates with steps but no prompt', () => {
    const result = WorkflowTemplateSchema.safeParse({
      id: 'steps-only',
      name: 'Steps Only',
      description: 'Has steps, no prompt.',
      steps: [{ id: 's1', name: 'Step 1', prompt: 'Do step 1' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('toWorkflowSummary', () => {
  it('projects a full template into a summary without prompt', () => {
    const template = {
      id: 'review',
      name: 'Review',
      description: 'A review workflow.',
      prompt: 'Do a review on {{topic}}.',
      requiredCapabilities: ['mcp:literature'],
      permissionTier: 'write' as const,
    };
    const summary = toWorkflowSummary(template);
    expect(summary).toEqual({
      id: 'review',
      name: 'Review',
      description: 'A review workflow.',
      permissionTier: 'write',
    });
    // Summary must not carry the prompt body (Plan 241).
    expect(summary).not.toHaveProperty('prompt');
    expect(summary).not.toHaveProperty('requiredCapabilities');
  });
});
