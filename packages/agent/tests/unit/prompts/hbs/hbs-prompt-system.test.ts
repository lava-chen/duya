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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import { PromptSystem } from '../../../../src/prompts/PromptSystem.js';
import { generalConfig } from '../../../../src/prompts/configs/general.js';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../../../src/prompts/types.js';
import type { PromptContext } from '../../../../src/prompts/types.js';
import { getSkillRegistry, resetSkillRegistry } from '../../../../src/skills/registry.js';
import type { PromptSkill } from '../../../../src/skills/types.js';
import { PRESET_AGENT_PROFILES } from '../../../../src/agent-profile/types.js';

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

describe('general profile skills catalog (plan 535)', () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  afterEach(() => {
    resetSkillRegistry();
  });

  function makeSkill(overrides: Partial<PromptSkill> = {}): PromptSkill {
    return {
      type: 'prompt',
      name: 'pdf',
      description: 'Create and inspect PDF documents.',
      source: 'bundled',
      skillRoot: 'E:\\skills\\pdf',
      getPromptForCommand: async () => 'instructions',
      ...overrides,
    };
  }

  it('renders the <available_skills> catalog into the assembled prompt', async () => {
    getSkillRegistry().register(makeSkill());
    const system = new PromptSystem(generalConfig);
    const prompt = await system.buildSystemPrompt(context());

    // End-to-end proof of the runtime('skills') chain: config entry →
    // runtimeSections factory → dynamic/skills-metadata.hbs →
    // getSkillsMetadataSection → the rendered catalog, inside the dynamic
    // half of the final prompt. NOTE: the skill-usage module prose also
    // mentions `<available_skills>` literally, so catalog assertions key on
    // the catalog's own section header / body markers, not the bare tag.
    const text = [...prompt].join('\n\n');
    expect(text).toContain('<available_skills>');
    expect(text).toContain('## Available skills');
    expect(text).toContain('<name>pdf</name>');
    expect(text).toContain('<description>Create and inspect PDF documents.</description>');
    expect(text).toContain('<location>');
    expect(text).toContain('complete, authoritative list of installed skills');
    // The catalog belongs to the volatile (dynamic) half — the first
    // `<available_skills>` hit is the skill-usage prose in the static half,
    // so anchor on the rendered section header instead.
    expect(text.indexOf('## Available skills'))
      .toBeGreaterThan(text.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY));
  });

  it('omits the catalog when the skill registry is empty', async () => {
    const system = new PromptSystem(generalConfig);
    const prompt = await system.buildSystemPrompt(context());
    const text = [...prompt].join('\n\n');
    expect(text).not.toContain('## Available skills');
    expect(text).not.toContain('<name>pdf</name>');
  });

  it('omits the catalog when neither Read nor Skill is enabled', async () => {
    getSkillRegistry().register(makeSkill());
    const system = new PromptSystem(generalConfig);
    const prompt = await system.buildSystemPrompt(context({
      enabledTools: new Set<string>(['Bash']),
    }));
    const text = [...prompt].join('\n\n');
    expect(text).not.toContain('## Available skills');
    expect(text).not.toContain('<name>pdf</name>');
  });

  it('renders the catalog through the real general-purpose preset profile', async () => {
    // Locks the actual desktop General path: PromptSystem binds the profile
    // at construction time, so the preset MUST keep 'skills' enabled or the
    // catalog silently disappears — the regression that made the model
    // answer inventory questions via CLI discovery.
    const preset = PRESET_AGENT_PROFILES.find((p) => p.id === 'general-purpose')!;
    getSkillRegistry().register(makeSkill());
    const system = new PromptSystem(generalConfig, preset.promptProfile);
    const prompt = await system.buildSystemPrompt(context());
    const text = [...prompt].join('\n\n');
    expect(text).toContain('## Available skills');
    expect(text).toContain('<name>pdf</name>');
    expect(text).toContain('complete, authoritative list of installed skills');
  });

  it('general-purpose denylist preserves the post-A-6 section set (plan 557 phase 2)', () => {
    // Golden parity: the denylist must cut exactly the nine sections the old
    // whitelist cut (minus the skills fix) — nothing more, nothing less.
    const preset = PRESET_AGENT_PROFILES.find((p) => p.id === 'general-purpose')!;
    const system = new PromptSystem(generalConfig, preset.promptProfile);
    const names = system.getAllSections(context()).map((s) => s.name);

    const expectedEnabled = [
      'identity', 'system', 'destructiveActions', 'communication',
      'tools', 'tasks', 'skillUsage', 'duyaDesktopContext', 'finalAnswer',
      'language', 'platform', 'environment', 'memory', 'skills',
    ];
    for (const name of expectedEnabled) {
      expect(names).toContain(name);
    }
    for (const cut of [
      'configProtection', 'outputStyle', 'mcp', 'scratchpad',
      'sessionSearch', 'recentSessions', 'sessionGuidance',
      'visionGuidelines', 'visualVerification',
    ]) {
      expect(names).not.toContain(cut);
    }
  });
});
