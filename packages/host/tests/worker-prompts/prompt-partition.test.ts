/**
 * Plan 619 Phase 2 — prompt partitioning and the section cache.
 *
 * Two claims are pinned here:
 *   - a section declares its channel (`placement`), and the assembly
 *     splits the two halves apart, and
 *   - a cached ('once') section is actually cached across builds, and
 *     only re-renders when the context it reads has changed.
 */

import { describe, expect, it } from 'vitest';

import { PromptSystem } from '@duya/host/worker-prompts/PromptSystem';
import { PromptsRegistry } from '@duya/host/worker-prompts/PromptsRegistry';
// Side-effect module: it registers the built-in configs.
import '@duya/host/worker-prompts/registry';
import { generalConfig } from '@duya/host/worker-prompts/configs/general';
import { codeConfig } from '@duya/host/worker-prompts/configs/code';
import { researchConfig } from '@duya/host/worker-prompts/configs/research';
import { botConfig } from '@duya/host/worker-prompts/configs/bot';
import type { PromptContext, PromptSystemConfig } from '@duya/host/worker-prompts/types';

function context(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    workingDirectory: 'E:\\repo',
    platform: 'win32',
    shell: 'bash',
    modelId: 'test-model',
    modelName: 'test-model',
    enabledTools: new Set<string>(['Read']),
    sessionStartTime: 0,
    ...overrides,
  } as PromptContext;
}

describe('plan 619 phase 2 — channel partition', () => {
  it('splits the prompt into a stable half and a context half', async () => {
    const system = new PromptSystem(generalConfig);
    const partition = await system.buildSystemPromptPartition(context());

    const stableNames = partition.stable.map((section) => section.name);
    const contextNames = partition.context.map((section) => section.name);

    expect(stableNames).toContain('identity');
    expect(stableNames).toContain('system');
    expect(stableNames).toContain('finalAnswer');
    // The volatile half moved to the context channel. A section that
    // renders empty (the MCP catalog with no servers connected, the memory
    // projection with no memory directory) is simply absent — what
    // matters is that it is not in the stable half.
    expect(contextNames).toEqual(expect.arrayContaining(['environment']));
    for (const name of ['environment', 'mcp', 'memory', 'sessionGuidance', 'vision']) {
      expect(stableNames, `${name} must not stay in the system prompt`).not.toContain(name);
    }
  });

  it('moves the volatile sections of every profile to the context channel', async () => {
    for (const config of [generalConfig, codeConfig, researchConfig, botConfig]) {
      const system = new PromptSystem(config);
      const partition = await system.buildSystemPromptPartition(context());
      const contextNames = partition.context.map((section) => section.name);
      const stableNames = partition.stable.map((section) => section.name);
      for (const name of ['environment', 'mcp', 'skills', 'memory', 'sessionGuidance', 'vision']) {
        const declared = config.sections.some(
          (def) => (def.name ?? def.module) === name,
        );
        if (!declared) continue;
        expect(
          stableNames,
          `${config.name}: ${name} should not stay in the system prompt`,
        ).not.toContain(name);
      }
    }
  });

  it('refuses a context section that declares a cache policy', () => {
    const config: PromptSystemConfig = {
      name: 'misconfigured',
      sections: [
        { name: 'oops', cachePolicy: 'once', placement: 'context', compute: () => 'x' },
      ],
    };
    const system = new PromptSystem(config);
    return expect(system.buildSystemPromptPartition(context())).rejects.toThrow(
      /placement 'context' with cachePolicy 'once'/,
    );
  });
});

describe('plan 619 phase 2 — the section cache', () => {
  it('renders a cached section once and reuses it', async () => {
    let calls = 0;
    const config: PromptSystemConfig = {
      name: 'cached',
      sections: [
        {
          name: 'stable',
          cachePolicy: 'once',
          compute: () => {
            calls += 1;
            return 'STABLE';
          },
        },
      ],
    };
    const system = new PromptSystem(config);
    await system.buildSystemPromptPartition(context());
    await system.buildSystemPromptPartition(context());
    expect(calls).toBe(1);
  });

  it('re-renders a cached section when the tool set changes', async () => {
    let calls = 0;
    const config: PromptSystemConfig = {
      name: 'cached-tools',
      sections: [
        {
          name: 'stable',
          cachePolicy: 'once',
          compute: () => {
            calls += 1;
            return 'STABLE';
          },
        },
      ],
    };
    const system = new PromptSystem(config);
    await system.buildSystemPromptPartition(context({ enabledTools: new Set(['Read']) }));
    await system.buildSystemPromptPartition(context({ enabledTools: new Set(['Read', 'Bash']) }));
    expect(calls).toBe(2);
  });

  it('shares one instance per profile, so the cache survives across builds', () => {
    const first = PromptsRegistry.getOrCreate('general');
    const second = PromptsRegistry.getOrCreate('general');
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('keeps different profiles in different buckets', () => {
    const plain = PromptsRegistry.getOrCreate('general');
    const gated = PromptsRegistry.getOrCreate('general', { disableSections: ['memory'] });
    expect(gated).not.toBe(plain);
  });
});
