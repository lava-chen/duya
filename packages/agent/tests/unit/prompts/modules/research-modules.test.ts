/**
 * Research module content tests — Plan 551 Phase 2.
 *
 * The legacy research TS sections are swept; these tests lock the module
 * renders' load-bearing content: the language-aware closing line, the
 * intent catalog, the fabrication ban, the memory-write procedure, and
 * the shared tone-and-style without the gateway-only never-analysis
 * paragraph.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import type { PromptContext } from '../../../../src/prompts/types.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function context(language?: string): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set<string>(['Read', 'Edit', 'Bash']),
    sessionStartTime: 0,
    language,
  } as PromptContext;
}

describe('research modules', () => {
  const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });
  const rendered = (name: Parameters<HbsPromptSystem['renderModule']>[0], ctx: PromptContext) =>
    system.renderModule(name, ctx).trim();

  it('research-profile pins Chinese responses for chinese sessions', () => {
    const zh = rendered('researchProfile', context('chinese'));
    expect(zh).toContain('Respond to the user in Chinese unless the user explicitly requests another language.');
    const en = rendered('researchProfile', context('english'));
    expect(en).toContain('Respond in the user preferred language when explicitly provided.');
    expect(en).toContain('research agent specialized in academic reading');
    expect(en).toContain('- source-backed findings');
  });

  it('task-intent lists the supported intent catalog', () => {
    const out = rendered('taskIntent', context());
    expect(out).toContain('Task intent routing policy:');
    expect(out).toContain('- paper_reading');
    expect(out).toContain('- hypothesis_update');
    expect(out).toContain('- general_research_chat');
    expect(out).toContain('Only inject sections relevant to current intent.');
  });

  it('evidence-policy bans fabrication and labels inference', () => {
    const out = rendered('evidencePolicy', context());
    expect(out).toContain('Evidence policy:');
    expect(out).toContain('- say that evidence is insufficient');
    expect(out).toContain('Never fabricate: paper titles, authors, venues, years, DOI, datasets, metrics, experimental results, citations.');
  });

  it('memory-write-proposal keeps the hypothesis auto-update procedure', () => {
    const out = rendered('memoryWriteProposal', context());
    expect(out).toContain('## Memory Write Policy');
    expect(out).toContain('### Hypothesis Auto-Update Rule (CRITICAL)');
    expect(out).toContain('`research_memory:propose`');
    expect(out).toContain('### Frequency');
  });

  it('tone-and-style omits the gateway never-analysis paragraph', () => {
    const out = rendered('toneAndStyle', context());
    expect(out).toContain('# Tone and style');
    expect(out).toContain('If you can say it in one sentence, don\'t use three.');
    expect(out).not.toContain('NEVER include analysis');
  });
});
