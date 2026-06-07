/**
 * Tests for code agent conditional sections.
 * Verifies that capability guidance is only emitted when the relevant tools
 * are present in `enabledTools`.
 */

import { describe, it, expect } from 'vitest';
import { getIntroSection } from '../../../../src/prompts/code/sections/static/intro.js';
import { getSystemSection } from '../../../../src/prompts/code/sections/static/system.js';
import { getCodeCapabilityGuidance, getCodeCapabilityGuidanceBlock } from '../../../../src/prompts/code/sections/static/codeSystemSection.js';
import type { PromptContext } from '../../../../src/prompts/types.js';

function makeCtx(enabledTools: string[]): PromptContext {
  return {
    workingDirectory: process.cwd(),
    platform: process.platform,
    shell: 'bash',
    modelId: 'test-model',
    enabledTools: new Set(enabledTools),
    sessionStartTime: Date.now(),
  } as PromptContext;
}

describe('getCodeCapabilityGuidance', () => {
  it('emits no paragraphs when no capability tools are present', () => {
    const ctx = makeCtx(['file:read', 'search:grep']);
    expect(getCodeCapabilityGuidance(ctx)).toEqual([]);
    expect(getCodeCapabilityGuidanceBlock(ctx)).toBeNull();
  });

  it('emits settings guidance when a settings-like tool is present', () => {
    const ctx = makeCtx(['settings', 'file:read']);
    const items = getCodeCapabilityGuidance(ctx);
    expect(items.length).toBe(1);
    expect(items[0]).toMatch(/settings/i);
  });

  it('emits hooks guidance when a hooks tool is present', () => {
    const ctx = makeCtx(['hooks_configure']);
    const items = getCodeCapabilityGuidance(ctx);
    expect(items.some(s => s.includes("hooks"))).toBe(true);
  });

  it('emits permission guidance when a permission tool is present', () => {
    const ctx = makeCtx(['permission_mode']);
    const items = getCodeCapabilityGuidance(ctx);
    expect(items.some(s => s.toLowerCase().includes('permission mode'))).toBe(true);
  });

  it('emits compact guidance when a compact tool is present', () => {
    const ctx = makeCtx(['compact_context']);
    const items = getCodeCapabilityGuidance(ctx);
    expect(items.some(s => s.includes('compress prior messages'))).toBe(true);
  });

  it('emits multiple paragraphs when multiple capability tools are present', () => {
    const ctx = makeCtx(['settings', 'hooks', 'permission_mode', 'compact_context']);
    const items = getCodeCapabilityGuidance(ctx);
    expect(items.length).toBe(4);
    const block = getCodeCapabilityGuidanceBlock(ctx);
    expect(block).not.toBeNull();
    expect(block!.split('\n').length).toBe(4);
  });
});

describe('getSystemSection (code)', () => {
  it('omits hooks/permission/compact paragraphs when no capability tools exist', () => {
    const ctx = makeCtx(['file:read']);
    const out = getSystemSection(ctx);
    expect(out).not.toMatch(/hooks.*shell commands/);
    expect(out).not.toMatch(/user-selected permission mode/);
    expect(out).not.toMatch(/automatically compress prior messages/);
  });

  it('includes hooks paragraph when hooks tool is enabled', () => {
    const ctx = makeCtx(['hooks']);
    const out = getSystemSection(ctx);
    expect(out).toMatch(/hooks.*shell commands/);
  });

  it('includes permission paragraph when permission tool is enabled', () => {
    const ctx = makeCtx(['permission_mode']);
    const out = getSystemSection(ctx);
    expect(out).toMatch(/user-selected permission mode/);
  });

  it('includes compact paragraph when compact tool is enabled', () => {
    const ctx = makeCtx(['compact']);
    const out = getSystemSection(ctx);
    expect(out).toMatch(/automatically compress prior messages/);
  });
});

describe('getIntroSection (code)', () => {
  it('omits self-management sentence when no settings tool is enabled', () => {
    const ctx = makeCtx(['file:read', 'search:grep']);
    const out = getIntroSection(ctx);
    expect(out).not.toMatch(/proactively use these tools/);
    expect(out).not.toMatch(/read and manage your own settings/);
  });

  it('includes self-management sentence when a settings tool is enabled', () => {
    const ctx = makeCtx(['settings']);
    const out = getIntroSection(ctx);
    expect(out).toMatch(/proactively use these tools/);
    expect(out).toMatch(/read and manage your own settings/);
  });

  it('always identifies as Duya', () => {
    const ctx = makeCtx([]);
    const out = getIntroSection(ctx);
    expect(out).toMatch(/You are Duya/);
  });
});
