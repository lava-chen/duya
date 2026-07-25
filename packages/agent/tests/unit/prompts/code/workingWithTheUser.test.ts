/**
 * Tests for the code agent's `# Working with the user` chapter.
 *
 * Asserts the chapter contains the Codex-shaped two-channel model
 * (commentary + final) and the formatting / visualization sub-rules.
 */

import { describe, it, expect } from 'vitest';
import { getWorkingWithTheUserSection } from '../../../../src/prompts/code/sections/workingWithTheUser.js';
import type { PromptContext } from '../../../../src/prompts/types.js';

function makeCtx(): PromptContext {
  return {
    workingDirectory: process.cwd(),
    platform: process.platform,
    shell: 'bash',
    modelId: 'test-model',
    enabledTools: new Set(),
    sessionStartTime: Date.now(),
  } as PromptContext;
}

describe('getWorkingWithTheUserSection (code)', () => {
  it('uses the parent heading # Working with the user', () => {
    const out = getWorkingWithTheUserSection(makeCtx());
    expect(out).toMatch(/^# Working with the user\b/m);
  });

  it('contains all three sub-headings: Multi-channel output, Intermediate commentary, Final answer', () => {
    const out = getWorkingWithTheUserSection(makeCtx());
    expect(out).toMatch(/^## Multi-channel output\b/m);
    expect(out).toMatch(/^## Intermediate commentary\b/m);
    expect(out).toMatch(/^## Final answer\b/m);
  });

  it('defines both commentary and final channels', () => {
    const out = getWorkingWithTheUserSection(makeCtx());
    expect(out).toMatch(/commentary/);
    expect(out).toMatch(/final/);
  });

  it('forbids praise-by-contrast platitudes', () => {
    const out = getWorkingWithTheUserSection(makeCtx());
    expect(out).toMatch(/Never praise your plan by contrasting it/);
  });

  it('contains the Formatting rules and Visualizations sub-sub-headings', () => {
    const out = getWorkingWithTheUserSection(makeCtx());
    expect(out).toMatch(/^### Formatting rules\b/m);
    expect(out).toMatch(/^### Visualizations\b/m);
  });

  it('contains the Writing for the reader sub-sub-heading under Final answer', () => {
    const out = getWorkingWithTheUserSection(makeCtx());
    expect(out).toMatch(/^### Writing for the reader\b/m);
  });

  it('documents clickable file-link format', () => {
    const out = getWorkingWithTheUserSection(makeCtx());
    expect(out).toMatch(/clickable markdown/);
    expect(out).toMatch(/Do not use URIs like file:\/\//);
  });

  it('describes when to use a visualization (and when not to)', () => {
    const out = getWorkingWithTheUserSection(makeCtx());
    expect(out).toMatch(/Use a visualization only when/);
    expect(out).toMatch(/skip visuals for/i);
  });
});