/**
 * Memory section .hbs behavior tests — Plan 550 1d-rest → Plan 551.
 *
 * The production path is preBuildHook (reads summary.md, applies the
 * 12 000-char truncation, injects the memory_* slots) → `memory.hbs`
 * render. These tests drive exactly that path with a stubbed summary
 * reader; byte-level parity against the legacy TS function was locked
 * before the sweep.
 *
 * Three cases:
 *   1. summary.md readable — body renders inline with the layout paths.
 *   2. summary.md missing — section omitted (null), hook returns no
 *      extension.
 *   3. summary.md oversized — 12 000-char truncation kicks in.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryPreBuildHook } from '../../../../src/prompts/sections/dynamic/memoryPreBuildHook.js';
import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import type { PromptContext } from '../../../../src/prompts/types.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function ctxWith(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set<string>(['Read', 'Edit', 'Write']),
    sessionStartTime: 0,
    ...overrides,
  } as PromptContext;
}

async function renderWithStub(
  system: HbsPromptSystem,
  stubSummary: string | undefined,
  overrides: Partial<PromptContext> = {},
): Promise<string | null> {
  const memoryHook = createMemoryPreBuildHook({
    resolveMemoryRoot: () => 'C:\\Users\\tester\\.duya\\memory',
    readSummary: () => stubSummary,
  });
  const base = ctxWith(overrides);
  const extension = await memoryHook(base);
  const enrichedCtx = extension?.promptContextExtension
    ? { ...base, ...extension.promptContextExtension }
    : base;
  const out = system.renderStaticTemplate('dynamic/memory.hbs', enrichedCtx).trim();
  return out === '' ? null : out;
}

describe('memory-section hbs behavior (Plan 551)', () => {
  const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });

  it('renders the summary body inline with the layout paths when readable', async () => {
    const out = await renderWithStub(
      system,
      '# Inline memory summary\n\n- Project uses Handlebars templates for prompts (Plan 550).\n- Tool execution routes through DependencyGraphOrchestrator.',
    );
    expect(out).toContain('## Memory');
    expect(out).toContain('========= MEMORY_SUMMARY BEGINS =========');
    expect(out).toContain('# Inline memory summary');
    expect(out).toContain('DependencyGraphOrchestrator');
    expect(out).toContain('summary.md` (already provided below as MEMORY_SUMMARY');
  });

  it('renders the not-yet-generated placeholder when summary.md is missing', async () => {
    // Mirrors the legacy behaviour: a missing file renders the section
    // with the `_(summary.md not yet generated)_` placeholder body.
    const out = await renderWithStub(system, undefined);
    expect(out).toContain('_(summary.md not yet generated)_');
  });

  it('truncates the summary body at the 12 000-char limit', async () => {
    // Truncation lives in the hook's default reader — exercise it via a
    // real temp file instead of a readSummary stub.
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan551-mem-'));
    try {
      fs.writeFileSync(path.join(root, 'summary.md'), 'x'.repeat(20_000));
      const hook = createMemoryPreBuildHook({ resolveMemoryRoot: () => root });
      const base = ctxWith();
      const extension = await hook(base);
      const enrichedCtx = extension?.promptContextExtension
        ? { ...base, ...extension.promptContextExtension }
        : base;
      const out = system.renderStaticTemplate('dynamic/memory.hbs', enrichedCtx).trim();
      expect(out).toContain('... [truncated]');
      // 12k truncated body + the ~3.3k template prose around it.
      expect(out.length).toBeLessThan(16_000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
