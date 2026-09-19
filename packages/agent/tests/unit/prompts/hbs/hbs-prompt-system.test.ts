/**
 * General profile assembly tests — Plan 550 1b → Plan 551.
 *
 * The Plan 550 monolith template is retired; the general static half is a
 * `staticModules` assembly over the registry. These tests lock the
 * assembled prompt at the config level: every section heading from the
 * original Codex-baseline ordering must appear, the dynamic-boundary
 * token separates the halves, and the module renderer's compile cache
 * amortises across renders.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import { PromptSystem } from '../../../../src/prompts/PromptSystem.js';
import { generalConfig } from '../../../../src/prompts/configs/general.js';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../../../src/prompts/types.js';
import type { PromptContext } from '../../../../src/prompts/types.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function context(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set<string>([
      'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Bash', 'TodoWrite', 'Task', 'AskUserQuestion', 'duya_cli',
    ]),
    sessionStartTime: 0,
    omitAgentsMd: true,
    ...overrides,
  } as PromptContext;
}

describe('general profile assembly (staticModules)', () => {
  it('renders every section heading from the Codex-baseline ordering', async () => {
    const system = new PromptSystem(generalConfig);
    const prompt = await system.buildSystemPrompt(context());
    const text = [...prompt].join('\n\n');

    const expected = [
      '# Identity',
      '## Self-Management',
      '## Multi-Agent Network',
      '# System',
      '# Destructive actions',
      '# Config file protection',
      '# Communication style',
      '## Output efficiency',
      '## Writing',
      '## Technical communication',
      '# Using your tools',
      '# Doing tasks',
      '# Using skills',
      '# Duya Desktop context',
      '# Final answer',
      '### Formatting rules',
      '### Reporting version-control actions',
      '### Visualizations',
    ];
    for (const heading of expected) {
      expect(text).toContain(heading);
    }
  });

  it('emits the cyber-risk instruction block and dynamic boundary', async () => {
    const system = new PromptSystem(generalConfig);
    const prompt = await system.buildSystemPrompt(context());
    const text = [...prompt].join('\n\n');
    expect(text).toContain('Cybersecurity is a critical concern');
    expect(text).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(text.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY))
      .toBeGreaterThan(text.indexOf('# Final answer'));
  });

  it('keeps the desktop context module gated on the desktop surface', async () => {
    const cliOnly = new PromptSystem(generalConfig);
    const prompt = await cliOnly.buildSystemPrompt(context({
      enabledTools: new Set<string>(['Read', 'Bash']),
    }));
    expect([...prompt].join('\n\n')).not.toContain('# Duya Desktop context');
  });

  it('amortises module renders through the compile cache', () => {
    const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });
    system.renderModule('identity', context());
    system.renderModule('identity', context());
    expect(system.cacheMisses()).toBe(1);
    expect(system.cacheHits()).toBe(1);
  });
});
