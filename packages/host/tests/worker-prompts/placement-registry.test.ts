/**
 * Plan 624 D1 / v2 G2 — the section registry.
 *
 * Claims pinned here:
 *   - every section declared by any live config is registered;
 *   - no config declares a channel any more (the registry owns it);
 *   - a config cannot move a section to the other delivery channel;
 *   - the bot assembly's section list is the ONLY bot section directory.
 *
 * The channel regression is the reason this file exists: the same section
 * riding the system channel in one profile and the context channel in another
 * silently changes which bytes the provider cache can reuse.
 */
import { describe, expect, it } from 'vitest';

import {
  BOT_ASSEMBLY_SECTION_IDS,
  SECTION_PLACEMENTS,
  resolveSectionPlacement,
  sectionsForConfig,
  unregisteredSections,
} from '@duya/host/worker-prompts/sections/placement-registry';
import { generalConfig } from '@duya/host/worker-prompts/configs/general';
import { codeConfig } from '@duya/host/worker-prompts/configs/code';
import { researchConfig } from '@duya/host/worker-prompts/configs/research';
import { projectConfig } from '@duya/host/worker-prompts/configs/project';
import type { PromptSystemConfig } from '@duya/host/worker-prompts/PromptSystem';

const configs: ReadonlyArray<readonly [string, PromptSystemConfig]> = [
  ['general', generalConfig],
  ['code', codeConfig],
  ['research', researchConfig],
  ['project', projectConfig],
];

function sectionNames(config: PromptSystemConfig): string[] {
  return config.sections.map((section) => section.name ?? section.module ?? 'anonymous');
}

describe('plan 624 — placement registry', () => {
  it('registers every section declared by a live config', () => {
    for (const [name, config] of configs) {
      expect(unregisteredSections(name, sectionNames(config))).toEqual([]);
    }
  });

  it('is the only owner of the delivery channel', () => {
    for (const [name, config] of configs) {
      for (const section of config.sections) {
        expect(section.placement).toBeUndefined();
        expect(() => resolveSectionPlacement(
          section.name ?? section.module ?? 'anonymous',
          section.placement,
          name,
        )).not.toThrow();
        // The registry still hands back the registered channel, so removing
        // the declaration changed no bytes.
        expect(resolveSectionPlacement(
          section.name ?? section.module ?? 'anonymous',
          undefined,
          name,
        )).toBe(SECTION_PLACEMENTS[section.name ?? section.module ?? 'anonymous']?.placement);
      }
    }
  });

  it('covers every config section from the registry directory', () => {
    for (const [name, config] of configs) {
      const registered = new Set(sectionsForConfig(name));
      for (const section of sectionNames(config)) {
        expect(registered.has(section)).toBe(true);
      }
    }
  });

  it('pins the channel for the volatile sections', () => {
    for (const name of ['environment', 'mcp', 'skills', 'memory', 'sessionGuidance', 'vision']) {
      expect(SECTION_PLACEMENTS[name]?.placement).toBe('context');
    }
    for (const name of ['platform', 'scratchpad', 'tools', 'identity']) {
      expect(SECTION_PLACEMENTS[name]?.placement).toBe('system');
    }
  });

  it('throws when a config declares the other channel', () => {
    expect(() => resolveSectionPlacement('environment', 'system', 'rogue')).toThrow(/placement registry/);
    expect(() => resolveSectionPlacement('identity', 'context', 'rogue')).toThrow(/placement registry/);
  });

  it('lets an unregistered section keep its declaration', () => {
    expect(resolveSectionPlacement('brand-new-section', undefined, 'general')).toBe('system');
    expect(resolveSectionPlacement('brand-new-section', 'context', 'general')).toBe('context');
  });
});

describe('plan 624 v2 — the bot section directory', () => {
  it('registers every assembly section and nothing else under "bot"', () => {
    expect(BOT_ASSEMBLY_SECTION_IDS.length).toBeGreaterThan(0);
    expect(sectionsForConfig('bot')).toEqual([...BOT_ASSEMBLY_SECTION_IDS]);
    for (const id of BOT_ASSEMBLY_SECTION_IDS) {
      expect(SECTION_PLACEMENTS[id]?.kind).toBe('bot-assembly');
      expect(SECTION_PLACEMENTS[id]?.placement).toBe('system');
    }
  });

  it('does not register a bot PromptSystem config', async () => {
    const { PromptsRegistry } = await import('@duya/host/worker-prompts/registry');
    expect(PromptsRegistry.has('bot')).toBe(false);
    expect(PromptsRegistry.getRegisteredNames().sort()).toEqual(['code', 'general', 'project', 'research']);
  });
});
