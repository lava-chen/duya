/**
 * Research module parity tests — Plan 551 Phase 2.
 *
 * Locks each research assembly entry byte-for-byte against the legacy TS
 * section function before the legacy section tree is swept. The
 * research-profile language line is exercised for both the Chinese and
 * fallback branches; toneAndStyle renders without the gateway-only
 * never-analysis param.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import type { PromptContext } from '../../../../src/prompts/types.js';
import { getResearchProfileSection } from '../../../../src/prompts/research/sections/profile.js';
import { getTaskIntentPromptSection } from '../../../../src/prompts/research/sections/taskIntent.js';
import { getEvidencePolicyPromptSection } from '../../../../src/prompts/research/sections/evidencePolicy.js';
import { getMemoryWriteProposalPromptSection } from '../../../../src/prompts/research/sections/memoryWriteProposal.js';
import { getToneAndStylePromptSection } from '../../../../src/prompts/research/sections/toneAndStyle.js';

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

describe('research modules parity vs legacy TS sections', () => {
  const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });
  const rendered = (name: Parameters<HbsPromptSystem['renderModule']>[0], ctx: PromptContext) =>
    system.renderModule(name, ctx).trim();

  it('research-profile language line: chinese and fallback branches', () => {
    const zh = context('chinese');
    const en = context('english');
    expect(rendered('researchProfile', zh)).toBe(getResearchProfileSection(zh).trim());
    expect(rendered('researchProfile', en)).toBe(getResearchProfileSection(en).trim());
  });

  it('static research modules match the legacy functions', () => {
    const ctx = context();
    expect(rendered('taskIntent', ctx)).toBe(getTaskIntentPromptSection().trim());
    expect(rendered('evidencePolicy', ctx)).toBe(getEvidencePolicyPromptSection().trim());
    expect(rendered('memoryWriteProposal', ctx)).toBe(getMemoryWriteProposalPromptSection().trim());
  });

  it('tone-and-style renders without the gateway never-analysis param', () => {
    const ctx = context();
    expect(rendered('toneAndStyle', ctx)).toBe(getToneAndStylePromptSection(ctx).trim());
  });
});
