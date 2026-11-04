/**
 * Plan 624 D1 — the placement registry.
 *
 * Two claims:
 *   - every section declared by any built-in config is registered, and
 *   - a config cannot move a section to the other delivery channel.
 *
 * The second one is the regression this file exists for: the same section
 * riding the system channel in one profile and the context channel in another
 * silently changes which bytes the provider cache can reuse.
 */

import { describe, expect, it } from 'vitest';

import { SECTION_PLACEMENTS, resolveSectionPlacement } from '@duya/host/worker-prompts/sections/placement-registry';
import { generalConfig } from '@duya/host/worker-prompts/configs/general';
import { codeConfig } from '@duya/host/worker-prompts/configs/code';
import { researchConfig } from '@duya/host/worker-prompts/configs/research';
import { botConfig } from '@duya/host/worker-prompts/configs/bot';
import { projectConfig } from '@duya/host/worker-prompts/configs/project';
import type { PromptSystemConfig } from '@duya/host/worker-prompts/PromptSystem';

const configs: ReadonlyArray<readonly [string, PromptSystemConfig]> = [
  ['general', generalConfig],
  ['code', codeConfig],
  ['research', researchConfig],
  ['bot', botConfig],
  ['project', projectConfig],
];

function sectionNames(config: PromptSystemConfig): string[] {
  return config.sections.map((section) => section.name ?? section.module ?? 'anonymous');
}

describe('plan 624 — placement registry', () => {
  it('registers every section declared by a built-in config', () => {
    const missing = configs
      .flatMap(([name, config]) => sectionNames(config).map((section) => `${name}:${section}`))
      .filter((entry) => {
        const section = entry.slice(entry.indexOf(':') + 1);
        return SECTION_PLACEMENTS[section] === undefined;
      });

    expect(missing).toEqual([]);
  });

  it('agrees with every config declaration, so no config has to change', () => {
    for (const [name, config] of configs) {
      for (const section of config.sections) {
        const sectionName = section.name ?? section.module ?? 'anonymous';
        expect(() => resolveSectionPlacement(sectionName, section.placement, name)).not.toThrow();
      }
    }
  });

  it('pins the channel for the volatile sections', () => {
    for (const name of ['environment', 'mcp', 'skills', 'memory', 'sessionGuidance', 'vision']) {
      expect(SECTION_PLACEMENTS[name]?.placement).toBe('context');
    }
    // These look volatile but are not: the text is fixed for the session.
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
