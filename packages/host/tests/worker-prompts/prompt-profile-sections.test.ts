/**
 * Plan 619 Phase 1 — prompt section gating.
 *
 *   - (c) `enableSections` and `disableSections` were mutually exclusive:
 *     a non-empty whitelist made the denylist unreachable.
 *   - (d) the sub-agent denylist named sections that no config declares
 *     (`memoryContent`, `widgetGuidelines`, `visionGuidelines`), so it
 *     disabled nothing.
 */

import { describe, expect, it } from 'vitest';

import { isSectionEnabled } from '@duya/host/worker-prompts/modes/index';
import {
  DEFAULT_SUBAGENT_PROFILE,
  SUBAGENT_TYPE_PROFILE_MAP,
} from '@duya/host/worker-prompts/modes/types';
import { generalConfig } from '@duya/host/worker-prompts/configs/general';
import { codeConfig } from '@duya/host/worker-prompts/configs/code';
import { researchConfig } from '@duya/host/worker-prompts/configs/research';
import { botConfig } from '@duya/host/worker-prompts/configs/bot';

const CONFIGS = [generalConfig, codeConfig, researchConfig, botConfig];

/** Every section name any config declares. */
function declaredSectionNames(): Set<string> {
  const names = new Set<string>();
  for (const config of CONFIGS) {
    for (const def of config.sections) {
      names.add(def.name ?? def.module ?? 'anonymous');
    }
  }
  return names;
}

describe('plan 619 phase 1 — section gating', () => {
  it('lets disableSections win over enableSections', () => {
    const profile = { enableSections: ['a', 'b'], disableSections: ['b'] };
    expect(isSectionEnabled(profile, 'a')).toBe(true);
    expect(isSectionEnabled(profile, 'b')).toBe(false);
  });

  it('treats a lone whitelist as a whitelist and a lone denylist as a denylist', () => {
    expect(isSectionEnabled({ enableSections: ['a'] }, 'a')).toBe(true);
    expect(isSectionEnabled({ enableSections: ['a'] }, 'b')).toBe(false);
    expect(isSectionEnabled({ disableSections: ['b'] }, 'a')).toBe(true);
    expect(isSectionEnabled({ disableSections: ['b'] }, 'b')).toBe(false);
  });

  it('enables everything when neither list is given', () => {
    expect(isSectionEnabled({}, 'anything')).toBe(true);
  });

  it('only denies section names some config actually declares', () => {
    const declared = declaredSectionNames();
    const denylists = [
      ...Object.values(SUBAGENT_TYPE_PROFILE_MAP).map((profile) => profile.disableSections ?? []),
      DEFAULT_SUBAGENT_PROFILE.disableSections ?? [],
    ];
    for (const denylist of denylists) {
      for (const name of denylist) {
        expect(
          declared.has(name),
          `denylist names "${name}", which no prompt config declares — a section that does not exist cannot be disabled`,
        ).toBe(true);
      }
    }
  });

  it('keeps the sub-agent denylists meaningful', () => {
    // Explore must actually lose the memory and vision sections; the names
    // used to be stale, so the denylist was a no-op.
    const explore = SUBAGENT_TYPE_PROFILE_MAP.Explore?.disableSections ?? [];
    expect(explore).toContain('memory');
    expect(explore).toContain('vision');
    expect(explore).not.toContain('memoryContent');
    expect(explore).not.toContain('visionGuidelines');
  });
});
