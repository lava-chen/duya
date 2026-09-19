/**
 * Memory section .hbs byte-level parity test — Plan 550 1d-rest.
 *
 * Mirrors the shape used by the dynamic-sections parity suite, but
 * tests memory independently because the legacy TS source reads
 * from disk (`fs.readFileSync`) and the test must inject a fixed
 * summary body via `readSummary` so byte-level comparison stays
 * deterministic. The actual preBuildHook wiring is exercised by
 * `omitAgentsMdPreBuildHook.test.ts` (memory's hook piggybacks on
 * the same compose-pattern).
 *
 * Three cases:
 *   1. summary.md readable — body matches the truncated TS path.
 *   2. summary.md missing — section omitted (null), preBuildHook
 *      returns no extension.
 *   3. summary.md oversized — 12 000-char truncation kicks in.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryPreBuildHook } from '../../../../src/prompts/sections/dynamic/memoryPreBuildHook.js';
import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import { getMemorySection } from '../../../../src/prompts/sections/dynamic/memorySection.js';
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

describe('memory-section hbs byte-level parity (Plan 550 1d-rest)', () => {
  const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });

  // The legacy TS reads from disk; the .hbs path uses the preBuildHook
  // to pre-populate the context. To compare byte-for-byte we run both
  // through the same `readSummary` stub.
  async function checkWithStub(
    stubSummary: string | undefined,
    overrides: Partial<PromptContext> = {},
  ) {
    const memoryHook = createMemoryPreBuildHook({
      resolveMemoryRoot: () => 'C:\\Users\\tester\\.duya\\memory',
      readSummary: () => stubSummary,
    });
    const extension = await memoryHook(ctxWith(overrides));
    const enrichedCtx = extension?.promptContextExtension
      ? { ...ctxWith(overrides), ...extension.promptContextExtension }
      : ctxWith(overrides);
    const ts = getMemorySection(enrichedCtx);
    const hbs = system.renderStaticTemplate('dynamic/memory.hbs', enrichedCtx).trim();
    const hbsNorm = hbs === '' ? null : hbs;
    expect(hbsNorm).toBe(ts);
  }

  it('matches when summary.md is readable and short', async () => {
    await checkWithStub(
      '# Inline memory summary\n\n- Project uses Handlebars templates for prompts (Plan 550).\n- Tool execution routes through DependencyGraphOrchestrator.',
    );
  });

  it('matches when summary.md is missing (section omitted)', async () => {
    // When readSummary returns undefined, the helper short-circuits
    // and the section renders empty → null, matching the legacy
    // `if (skills.length === 0) return null` short-circuit.
    await checkWithStub(undefined);
  });

  it('matches when summary.md is over the 12 000-char truncation limit', async () => {
    const oversized = 'x'.repeat(20_000);
    await checkWithStub(oversized);
  });
});