/**
 * Tests for code agent conditional sections.
 *
 * Verifies that the system section inlines the right capability paragraphs
 * based on which tools are enabled, and that the identity section stays
 * focused on identity (settings-capability sentence now lives in system).
 */

import { describe, it, expect } from 'vitest';
import { getIdentitySection } from '../../../../src/prompts/code/sections/identity.js';
import { getSystemSection } from '../../../../src/prompts/code/sections/system.js';
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

describe('getSystemSection (code)', () => {
  it('omits hooks/permission/compact paragraphs when no capability tools exist', () => {
    const ctx = makeCtx(['file:read']);
    const out = getSystemSection(ctx);
    expect(out).not.toMatch(/hooks.*shell commands/);
    expect(out).not.toMatch(/user-selected permission mode/);
    expect(out).not.toMatch(/automatically compress prior messages/);
    // Settings capability should also be absent when no settings-like tool is enabled.
    expect(out).not.toMatch(/read and manage your own settings/);
  });

  it('includes settings paragraph when a settings tool is enabled', () => {
    const ctx = makeCtx(['settings', 'file:read']);
    const out = getSystemSection(ctx);
    expect(out).toMatch(/read and manage your own settings/);
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

  it('emits multiple capability paragraphs when multiple tools are present', () => {
    const ctx = makeCtx(['settings', 'hooks', 'permission_mode', 'compact_context']);
    const out = getSystemSection(ctx);
    expect(out).toMatch(/read and manage your own settings/);
    expect(out).toMatch(/hooks.*shell commands/);
    expect(out).toMatch(/user-selected permission mode/);
    expect(out).toMatch(/automatically compress prior messages/);
  });
});

describe('getIdentitySection (code)', () => {
  it('omits self-management sentence regardless of settings tool (now in system)', () => {
    const ctx = makeCtx(['file:read', 'search:grep']);
    const out = getIdentitySection(ctx);
    expect(out).not.toMatch(/proactively use these tools/);
    expect(out).not.toMatch(/read and manage your own settings/);
  });

  it('still omits self-management sentence when settings tool is enabled', () => {
    const ctx = makeCtx(['settings']);
    const out = getIdentitySection(ctx);
    expect(out).not.toMatch(/proactively use these tools/);
    expect(out).not.toMatch(/read and manage your own settings/);
  });

  it('always identifies as Duya', () => {
    const ctx = makeCtx([]);
    const out = getIdentitySection(ctx);
    expect(out).toMatch(/You are Duya/);
  });

  it('uses the Codex-shaped opener (workspace + role)', () => {
    const ctx = makeCtx([]);
    const out = getIdentitySection(ctx);
    expect(out).toMatch(/You are Duya, an interactive coding agent/);
    expect(out).toMatch(/share one workspace/);
  });

  it('includes cyber risk instruction and URL guardrail', () => {
    const ctx = makeCtx([]);
    const out = getIdentitySection(ctx);
    expect(out).toMatch(/Cybersecurity/);
    expect(out).toMatch(/must NEVER generate or guess URLs/);
  });
});
