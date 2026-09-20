/**
 * prompt-ledger.test.ts
 *
 * Plan 556 phase 1 — prompt gating observability:
 *  - the construction-time section ledger logs every section dropped by
 *    the profile, tagged with the mechanism (whitelist / denylist)
 *  - a non-empty enableSections triggers the deprecation warning
 *  - a fully-enabled profile logs nothing
 *  - DUYA_DUMP_PROMPT writes the final assembled prompt to the given
 *    directory, byte-comparable with the built prompt
 */

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptSystem } from '../../../src/prompts/PromptSystem.js';
import type { PromptSystemConfig, PromptContext } from '../../../src/prompts/types.js';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../../src/prompts/types.js';
import { logger } from '../../../src/utils/logger.js';

function makeConfig(name: string): PromptSystemConfig {
  return {
    name,
    sections: [
      { name: 'identity', compute: () => 'IDENTITY-CONTENT', cachePolicy: 'every-call' },
      { name: 'memory', compute: () => 'MEMORY-CONTENT', cachePolicy: 'every-call' },
      { name: 'skills', compute: () => 'SKILLS-CONTENT', cachePolicy: 'every-call' },
    ],
  } as PromptSystemConfig;
}

function context(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set<string>(['Read', 'Skill']),
    sessionStartTime: 0,
    omitAgentsMd: true,
    ...overrides,
  } as PromptContext;
}

describe('PromptSystem section ledger (plan 557 phase 1)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DUYA_DUMP_PROMPT;
  });

  it('logs dropped sections tagged with the whitelist mechanism', () => {
    new PromptSystem(makeConfig('ledger-wl'), { enableSections: ['identity'] });

    const ledgerLine = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("section ledger: 1/3 sections enabled"));
    expect(ledgerLine).toBeDefined();
    expect(ledgerLine).toContain('memory(whitelist)');
    expect(ledgerLine).toContain('skills(whitelist)');
  });

  it('logs dropped sections tagged with the denylist mechanism', () => {
    new PromptSystem(makeConfig('ledger-dl'), { disableSections: ['memory'] });

    const ledgerLine = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("section ledger: 2/3 sections enabled"));
    expect(ledgerLine).toBeDefined();
    expect(ledgerLine).toContain('memory(denylist)');
    expect(ledgerLine).not.toContain('whitelist');
  });

  it('warns when the deprecated enableSections whitelist is used', () => {
    new PromptSystem(makeConfig('ledger-deprecated'), { enableSections: ['identity'] });

    const warnLine = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnLine).toContain('enableSections');
    expect(warnLine).toContain('deprecated');
  });

  it('logs no ledger line when every section is enabled', () => {
    new PromptSystem(makeConfig('ledger-clean'));

    const ledgerLines = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('section ledger:'));
    expect(ledgerLines).toEqual([]);
  });

  it('re-logs the ledger when setProfile changes the filter', () => {
    const system = new PromptSystem(makeConfig('ledger-setprofile'));
    infoSpy.mockClear();
    system.setProfile({ disableSections: ['skills'] });

    const ledgerLine = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('skills(denylist)'));
    expect(ledgerLine).toBeDefined();
  });
});

describe('DUYA_DUMP_PROMPT (plan 557 phase 1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DUYA_DUMP_PROMPT;
  });

  it('writes the final assembled prompt to the given directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-prompt-dump-'));
    process.env.DUYA_DUMP_PROMPT = dir;

    const config = makeConfig('dump-test');
    const system = new PromptSystem(config);
    const prompt = await system.buildSystemPrompt(context());

    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^dump-test-.*\.txt$/);
    const dumped = readFileSync(join(dir, files[0]!), 'utf-8');
    expect(dumped).toBe([...prompt].join('\n\n'));
    expect(dumped).toContain('IDENTITY-CONTENT');
    expect(dumped).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(dumped).toContain('SKILLS-CONTENT');
  });

  it('does not write anything when the env var is unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-prompt-nodump-'));
    const system = new PromptSystem(makeConfig('dump-off'));
    await system.buildSystemPrompt(context());
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('requiresTools central gating (plan 557 phase 3)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeToolGatedConfig(): PromptSystemConfig {
    return {
      name: 'gated',
      sections: [
        {
          name: 'skills',
          compute: () => 'SKILLS-CONTENT',
          cachePolicy: 'every-call',
          requiresTools: ['Skill', 'Read'],
        },
        {
          name: 'recentSessions',
          compute: () => 'RECENT-CONTENT',
          cachePolicy: 'every-call',
          requiresTools: ['SessionSearch'],
        },
      ],
    } as PromptSystemConfig;
  }

  it('keeps the section when a required tool matches case-insensitively', async () => {
    // Dead-leg regression: the real Read tool registers as lowercase
    // `read` while TOOL_NAMES.READ is `Read` — the gate must survive that.
    const system = new PromptSystem(makeToolGatedConfig());
    const prompt = await system.buildSystemPrompt(context({
      enabledTools: new Set<string>(['read']),
    }));
    const text = [...prompt].join('\n\n');
    expect(text).toContain('SKILLS-CONTENT');
  });

  it('skips the section and logs the attribution when tools are missing', async () => {
    const system = new PromptSystem(makeToolGatedConfig());
    const prompt = await system.buildSystemPrompt(context({
      enabledTools: new Set<string>(['Bash']),
    }));
    const text = [...prompt].join('\n\n');
    expect(text).not.toContain('SKILLS-CONTENT');
    expect(text).not.toContain('RECENT-CONTENT');

    const logLine = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logLine).toContain('2 section(s) skipped for missing tools: skills(requires Skill|Read), recentSessions(requires SessionSearch)');
  });

  it('treats an empty enabledTools set as no tools', async () => {
    const system = new PromptSystem(makeToolGatedConfig());
    const prompt = await system.buildSystemPrompt(context({
      enabledTools: new Set<string>(),
    }));
    expect([...prompt].join('\n\n')).not.toContain('SKILLS-CONTENT');
  });
});
